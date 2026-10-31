package com.capri.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.Locale;

// Capri's own ear. Raw mic audio, a silent level gate, and Whisper on the Capri
// server. Google's recognizer is never opened, so its start tone never plays.
final class CapriVoice {
	interface Sink {
		void onHeard(String text, String remainder);
		void onError(String code);
	}

	private static final Handler MAIN = new Handler(Looper.getMainLooper());
	private static final int RATE = 16000;
	private static final int FRAME = RATE / 10;       // 100 ms
	private static final double MIN_RMS = 380;
	private static final double MAX_GATE = 3200;
	private static final int ONSET = 2;               // 200 ms of voice opens a take
	private static final int HANGOVER = 9;            // 900 ms of quiet closes it
	private static final int PREROLL = 4;             // 400 ms kept before the first word
	private static final int MAX_SECONDS = 12;
	private static final int ORDER_WAIT_MS = 12000;   // no voice at all: give up

	private static Context app;
	private static Sink sink;
	private static boolean running;
	private static boolean wakeMode;
	private static long gen;
	private static String base = "";
	private static String device = "";
	private static String session = "";

	private CapriVoice() {}

	static boolean available(Context context) {
		try {
			return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
					== PackageManager.PERMISSION_GRANTED;
		} catch (Exception err) { return false; }
	}

	static boolean running() { return running; }

	// wake=true listens until the name is said; wake=false is a single order.
	static void start(Context context, boolean wake, Sink cb) {
		Context ctx = context.getApplicationContext();
		app = ctx;
		readConfig(ctx);
		synchronized (CapriVoice.class) {
			if (running && wakeMode == wake) {
				sink = cb;
				return;
			}
			running = false;
			final long ticket = ++gen;
			MAIN.postDelayed(() -> begin(wake, cb, ticket), 200);
		}
	}

	static void stop() {
		synchronized (CapriVoice.class) {
			running = false;
			gen += 1;
			sink = null;
		}
	}

	static void release() {
		stop();
	}

	private static void begin(boolean wake, Sink cb, long ticket) {
		synchronized (CapriVoice.class) {
			if (running || app == null || ticket != gen) return;
			running = true;
			wakeMode = wake;
			sink = cb;
			final long mine = ++gen;
			Thread t = new Thread(() -> loop(mine), "capri-ear");
			t.start();
		}
	}

	private static boolean alive(long mine) {
		synchronized (CapriVoice.class) {
			return running && mine == gen;
		}
	}

	private static void loop(long mine) {
		if (!available(app)) {
			fail(mine, "unavailable");
			return;
		}
		// Let the tap chime finish before the mic opens.
		if (!wakeMode) sleep(240);
		while (alive(mine)) {
			readConfig(app);
			long started = SystemClock.uptimeMillis();
			AudioRecord r = openRecorder();
			if (r == null) {
				if (!alive(mine)) return;
				fail(mine, "unavailable");
				return;
			}
			byte[] clip;
			try {
				r.startRecording();
				clip = capture(r, mine, started);
			} catch (Exception err) {
				clip = null;
			} finally {
				releaseRecorder(r);
			}
			if (!alive(mine)) return;
			if (clip == null) {
				if (!wakeMode) { fail(mine, "no_speech"); return; }
				continue;
			}
			String text = transcribe(clip);
			if (!alive(mine)) return;
			if (text == null) {
				// No answer from the server: stay silent and try again later.
				if (!wakeMode) { fail(mine, "network"); return; }
				sleep(2500);
				continue;
			}
			text = text.trim();
			if (text.isEmpty()) {
				if (!wakeMode) { fail(mine, "no_speech"); return; }
				continue;
			}
			if (wakeMode) {
				String rest = wakeRemainder(text);
				if (rest == null) continue;
				deliver(mine, text, rest);
				return;
			}
			deliver(mine, text, "");
			return;
		}
	}

	// ── Capture ─────────────────────────────────────────────────────────────
	// One take: wait for a voice through a silent level gate, keep a short
	// pre-roll, then close the take after a beat of quiet.
	private static byte[] capture(AudioRecord r, long mine, long started) {
		short[] buf = new short[FRAME];
		ArrayDeque<short[]> pre = new ArrayDeque<>();
		ByteArrayOutputStream pcm = new ByteArrayOutputStream();
		double floor = 220;
		int voiced = 0;
		int quiet = 0;
		boolean speech = false;
		int maxBytes = RATE * 2 * MAX_SECONDS;
		while (alive(mine)) {
			int n = r.read(buf, 0, buf.length);
			if (n < 0) return null;
			if (n == 0) continue;
			double rms = rms(buf, n);
			double gate = Math.min(MAX_GATE, Math.max(MIN_RMS, floor * 2.4));
			boolean loud = rms > gate;
			if (!speech) {
				floor = floor * 0.97 + rms * 0.03;
				short[] keep = new short[n];
				System.arraycopy(buf, 0, keep, 0, n);
				pre.addLast(keep);
				while (pre.size() > PREROLL + ONSET) pre.removeFirst();
				voiced = loud ? voiced + 1 : 0;
				if (voiced >= ONSET) {
					speech = true;
					for (short[] f : pre) write(pcm, f, f.length);
					pre.clear();
				} else if (!wakeMode && SystemClock.uptimeMillis() - started > ORDER_WAIT_MS) {
					return null;
				}
				continue;
			}
			write(pcm, buf, n);
			quiet = loud ? 0 : quiet + 1;
			if (quiet >= HANGOVER || pcm.size() >= maxBytes) break;
		}
		if (!speech) return null;
		return wav(pcm);
	}

	private static double rms(short[] buf, int n) {
		double sum = 0;
		for (int i = 0; i < n; i += 1) {
			double v = buf[i];
			sum += v * v;
		}
		return Math.sqrt(sum / n);
	}

	private static void write(ByteArrayOutputStream out, short[] buf, int n) {
		for (int i = 0; i < n; i += 1) {
			int v = buf[i];
			out.write(v & 0xff);
			out.write((v >> 8) & 0xff);
		}
	}

	private static byte[] wav(ByteArrayOutputStream pcm) {
		byte[] data = pcm.toByteArray();
		ByteBuffer b = ByteBuffer.allocate(44 + data.length).order(ByteOrder.LITTLE_ENDIAN);
		b.put("RIFF".getBytes());
		b.putInt(36 + data.length);
		b.put("WAVE".getBytes());
		b.put("fmt ".getBytes());
		b.putInt(16);
		b.putShort((short) 1);
		b.putShort((short) 1);
		b.putInt(RATE);
		b.putInt(RATE * 2);
		b.putShort((short) 2);
		b.putShort((short) 16);
		b.put("data".getBytes());
		b.putInt(data.length);
		b.put(data);
		return b.array();
	}

	private static AudioRecord openRecorder() {
		for (int attempt = 0; attempt < 8; attempt += 1) {
			AudioRecord r = null;
			try {
				int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO,
						AudioFormat.ENCODING_PCM_16BIT);
				if (min <= 0) min = RATE;
				r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
						AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
						Math.max(min, RATE * 2));
				if (r.getState() == AudioRecord.STATE_INITIALIZED) return r;
				releaseRecorder(r);
			} catch (Exception err) {
				releaseRecorder(r);
			}
			sleep(120);
			if (!running) return null;
		}
		return null;
	}

	private static void releaseRecorder(AudioRecord r) {
		if (r == null) return;
		try { r.stop(); } catch (Exception err) { /* idle */ }
		try { r.release(); } catch (Exception err) { /* gone */ }
	}

	// ── Server transcription ────────────────────────────────────────────────
	private static String transcribe(byte[] clip) {
		if (base.isEmpty() || clip == null || clip.length < 45) return null;
		HttpURLConnection conn = null;
		try {
			conn = (HttpURLConnection) new URL(base + "/api/stt").openConnection();
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(25000);
			conn.setRequestMethod("POST");
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "audio/wav");
			conn.setRequestProperty("Accept", "application/json");
			conn.setRequestProperty("User-Agent", "Capri-Android");
			conn.setRequestProperty("X-Capri-Prompt",
					"Capri is the assistant's name. The user says Capri.");
			if (!device.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + device);
			if (!session.isEmpty()) conn.setRequestProperty("X-Capri-Profile", session);
			conn.setFixedLengthStreamingMode(clip.length);
			try (OutputStream out = conn.getOutputStream()) {
				out.write(clip);
			}
			int code = conn.getResponseCode();
			InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
			if (in == null) return null;
			ByteArrayOutputStream raw = new ByteArrayOutputStream();
			byte[] chunk = new byte[4096];
			int read;
			while ((read = in.read(chunk)) > 0) raw.write(chunk, 0, read);
			in.close();
			if (code >= 400) return null;
			JSONObject json = new JSONObject(raw.toString("UTF-8"));
			return json.optString("text", "");
		} catch (Exception err) {
			return null;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private static void readConfig(Context ctx) {
		String b = "";
		String d = "";
		String s = "";
		try {
			JSONObject cfg = new JSONObject(EyePrefs.load(ctx));
			b = cfg.optString("base", "").trim();
			d = cfg.optString("token", "").trim();
			s = cfg.optString("session", "").trim();
		} catch (Exception err) { /* no config yet */ }
		while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
		base = b;
		device = d;
		session = s;
	}

	private static void sleep(long ms) {
		long end = SystemClock.uptimeMillis() + ms;
		while (SystemClock.uptimeMillis() < end) {
			long left = end - SystemClock.uptimeMillis();
			if (left <= 0) return;
			try { Thread.sleep(Math.min(120, left)); } catch (InterruptedException err) { return; }
		}
	}

	private static void deliver(long mine, String text, String rest) {
		Sink cb;
		synchronized (CapriVoice.class) {
			if (!running || mine != gen) return;
			running = false;
			gen += 1;
			cb = sink;
			sink = null;
		}
		if (cb != null) cb.onHeard(text, rest);
	}

	private static void fail(long mine, String code) {
		Sink cb;
		synchronized (CapriVoice.class) {
			if (!running || mine != gen) return;
			running = false;
			gen += 1;
			cb = sink;
			sink = null;
		}
		if (cb != null) cb.onError(code);
	}

	// null when the sentence does not contain the name; "" when only the name.
	static String wakeRemainder(String raw) {
		String text = String.valueOf(raw == null ? "" : raw).toLowerCase(Locale.US)
				.replaceAll("[^a-z0-9' ]+", " ")
				.replaceAll("\\s+", " ")
				.trim();
		if (text.isEmpty() || text.contains("capricorn")) return null;
		String[] words = text.split(" ");
		for (int i = 0; i < words.length; i += 1) {
			String word = words[i].replaceAll("^'+|'+$", "");
			boolean hit = WAKE.contains(word);
			int used = 1;
			if (!hit && word.equals("cap") && i + 1 < words.length) {
				String next = words[i + 1].replaceAll("[^a-z]", "");
				if (next.matches("ri|ree|ry|rie")) { hit = true; used = 2; }
			}
			if (!hit) continue;
			StringBuilder rest = new StringBuilder();
			for (int j = i + used; j < words.length; j += 1) {
				if (rest.length() > 0) rest.append(' ');
				rest.append(words[j]);
			}
			return rest.toString().trim();
		}
		// A one-word take that Whisper spelled slightly off ("capre", "carpri")
		// still counts as just the name. Full sentences stay strict so "copy"
		// in normal speech cannot wake her.
		if (words.length == 1 && words[0].length() >= 4 && words[0].length() <= 6
				&& distance(words[0], "capri") <= 1) {
			return "";
		}
		return null;
	}

	private static int distance(String a, String b) {
		int[] prev = new int[b.length() + 1];
		int[] cur = new int[b.length() + 1];
		for (int j = 0; j <= b.length(); j += 1) prev[j] = j;
		for (int i = 1; i <= a.length(); i += 1) {
			cur[0] = i;
			for (int j = 1; j <= b.length(); j += 1) {
				int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
				cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
			}
			int[] swap = prev;
			prev = cur;
			cur = swap;
		}
		return prev[b.length()];
	}

	private static final java.util.Set<String> WAKE = new java.util.HashSet<>(java.util.Arrays.asList(
			"capri", "capry", "capree", "caprie", "caprii", "kapri", "kapry", "kabri", "cabri",
			"caprice", "cappy", "cappi", "capra", "caprio", "capris"));
}

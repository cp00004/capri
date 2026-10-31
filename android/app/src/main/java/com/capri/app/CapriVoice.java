package com.capri.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;
import java.util.Locale;

// Phone-side ear: Google's own recognizer instead of shipping audio to the PC.
// It is a singleton because Android only allows one recognition session, and the
// activity (app open) and the service (app closed) take turns using it.
final class CapriVoice {
	interface Sink {
		void onHeard(String text, String remainder);
		void onError(String code);
	}

	private static final Handler MAIN = new Handler(Looper.getMainLooper());
	private static SpeechRecognizer recognizer;
	private static Context app;
	private static Sink sink;
	private static boolean running;
	private static boolean wakeMode;
	private static boolean finalSeen;
	private static String lastText = "";
	private static long lastStart;

	private CapriVoice() {}

	static boolean available(Context context) {
		try { return SpeechRecognizer.isRecognitionAvailable(context); } catch (Exception err) { return false; }
	}

	static boolean running() {
		return running;
	}

	// wake=true listens until the name is said; wake=false is a single order.
	static void start(Context context, boolean wake, Sink cb) {
		stop();
		if (!available(context)) {
			if (cb != null) cb.onError("unavailable");
			return;
		}
		app = context.getApplicationContext();
		sink = cb;
		wakeMode = wake;
		running = true;
		finalSeen = false;
		lastText = "";
		MAIN.post(CapriVoice::listen);
	}

	static void stop() {
		running = false;
		finalSeen = false;
		final SpeechRecognizer r = recognizer;
		recognizer = null;
		if (r != null) {
			MAIN.post(() -> {
				try { r.stopListening(); } catch (Exception err) { /* already idle */ }
				try { r.cancel(); } catch (Exception err) { /* already idle */ }
				try { r.destroy(); } catch (Exception err) { /* already gone */ }
			});
		}
	}

	private static void listen() {
		if (!running || app == null) return;
		try {
			if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(app);
		} catch (Exception err) {
			running = false;
			if (sink != null) sink.onError("unavailable");
			return;
		}
		recognizer.setRecognitionListener(new RecognitionListener() {
			@Override public void onReadyForSpeech(Bundle params) { lastText = ""; }
			@Override public void onBeginningOfSpeech() {}
			@Override public void onRmsChanged(float rmsdB) {}
			@Override public void onBufferReceived(byte[] buffer) {}
			@Override public void onEndOfSpeech() {}
			@Override public void onPartialResults(Bundle partial) { handle(partial, false); }
			@Override public void onResults(Bundle results) { handle(results, true); }

			@Override
			public void onError(int error) {
				if (!running) return;
				if (!wakeMode && !lastText.isEmpty() && !finalSeen) {
					deliver(lastText, true);
					return;
				}
				// Quiet room, a timeout or a busy recognizer: just listen again.
				long wait = (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) ? 1200 : 350;
				MAIN.postDelayed(() -> {
					if (!running) return;
					if (recognizer == null) listen();
					else {
						try { recognizer.cancel(); } catch (Exception ignored) {}
						listen();
					}
				}, wait);
			}

			@Override public void onEvent(int eventType, Bundle params) {}
		});
		lastStart = System.currentTimeMillis();
		try {
			recognizer.startListening(intent());
		} catch (Exception err) {
			MAIN.postDelayed(() -> { if (running) listen(); }, 600);
		}
	}

	private static Intent intent() {
		Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
		intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
		intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
		intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
		intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, wakeMode ? 900 : 1100);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 800);
		return intent;
	}

	private static void handle(Bundle bundle, boolean isFinal) {
		if (!running || bundle == null) return;
		ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
		if (list == null || list.isEmpty()) return;
		String text = String.valueOf(list.get(0) == null ? "" : list.get(0)).trim();
		if (text.isEmpty()) return;
		lastText = text;
		if (!isFinal) return;
		finalSeen = true;
		deliver(text, false);
	}

	private static void deliver(String text, boolean fromPartial) {
		final String remainder = wakeRemainder(text);
		if (wakeMode) {
			if (remainder == null) {
				// Not the name: keep the ear open.
				MAIN.postDelayed(() -> { if (running) restart(); }, 250);
				return;
			}
			Sink cb = sink;
			stop();
			if (cb != null) cb.onHeard(text, remainder);
			return;
		}
		Sink cb = sink;
		stop();
		if (cb != null) cb.onHeard(text, "");
	}

	private static void restart() {
		if (!running) return;
		try { if (recognizer != null) recognizer.cancel(); } catch (Exception err) { /* idle */ }
		listen();
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
		return null;
	}

	private static final java.util.Set<String> WAKE = new java.util.HashSet<>(java.util.Arrays.asList(
			"capri", "capry", "capree", "caprie", "caprii", "kapri", "kapry", "kabri", "cabri",
			"caprice", "cappy", "cappi", "capra", "caprio", "capris"));
}

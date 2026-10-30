package com.capri.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.Locale;

// The floating eye: a system overlay that follows you out of the app, drags
// anywhere, and cuts in with a line once you have been parked in one app.
public class EyeService extends Service {
	public static final String ACTION_START = "com.capri.app.EYE_START";
	public static final String ACTION_STOP = "com.capri.app.EYE_STOP";
	public static final String ACTION_SHOW = "com.capri.app.EYE_SHOW";
	public static final String ACTION_HIDE = "com.capri.app.EYE_HIDE";
	public static final String ACTION_SAY = "com.capri.app.EYE_SAY";
	public static final String EXTRA_CONFIG = "config";
	public static final String EXTRA_TEXT = "text";

	private static final String CHANNEL_EYE = "capri_eye";
	private static final String CHANNEL_ALERTS = "capri_alerts";
	private static final long DWELL_MS = 45_000L;
	private static final long COOLDOWN_MS = 120_000L;

	private WindowManager windowManager;
	private FrameLayout root;
	private ImageView eye;
	private ImageView ghostNear;
	private ImageView ghostFar;
	private TextView bubble;
	private LinearLayout controls;
	private WindowManager.LayoutParams params;

	private Handler handler;
	private Runnable watcher;
	private Runnable floater;
	private int eyeSize;

	private boolean pinned = false;
	private boolean banter = true;
	private String base = "";
	private String token = "";
	private String session = "";

	private String lastKey = "";
	private long lastKeyAt = 0;
	private long lastSayAt = 0;
	private String saidKey = "";
	private boolean polling = false;

	private MediaRecorder recorder;
	private File takeFile;
	private boolean recording = false;
	private boolean thinking = false;
	private TextToSpeech tts;
	private boolean ttsReady = false;

	public static void start(Context context, String config) {
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_START);
		intent.putExtra(EXTRA_CONFIG, config == null ? "{}" : config);
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
			else context.startService(intent);
		} catch (Exception err) {
			// Android 12+ refuses background service starts; the app will try again when it comes back.
		}
	}

	public static void stop(Context context) {
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_STOP);
		try { context.startService(intent); } catch (Exception err) { /* already gone */ }
	}

	public static void show(Context context, String config) {
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_SHOW);
		intent.putExtra(EXTRA_CONFIG, config == null ? "{}" : config);
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
			else context.startService(intent);
		} catch (Exception err) { /* background start refused */ }
	}

	public static void hide(Context context) {
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_HIDE);
		try { context.startService(intent); } catch (Exception err) { /* nothing running */ }
	}

	public static void say(Context context, String text) {
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_SAY);
		intent.putExtra(EXTRA_TEXT, text == null ? "" : text);
		try { context.startService(intent); } catch (Exception err) { /* nothing floating */ }
	}

	@Override
	public void onCreate() {
		super.onCreate();
		windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
		handler = new Handler(Looper.getMainLooper());
		eyeSize = dp(140);
		createChannels();
		try {
			tts = new TextToSpeech(this, status -> {
				ttsReady = status == TextToSpeech.SUCCESS;
				if (ttsReady) tts.setLanguage(Locale.US);
			});
		} catch (Exception err) { /* voice replies are optional */ }
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		String action = intent == null ? null : intent.getAction();
		if (ACTION_STOP.equals(action)) {
			teardown();
			stopSelf();
			return START_NOT_STICKY;
		}
		if (ACTION_HIDE.equals(action)) {
			teardown();
			stopSelf();
			return START_NOT_STICKY;
		}
		if (ACTION_SAY.equals(action)) {
			showLine(intent.getStringExtra(EXTRA_TEXT));
			return START_STICKY;
		}

		JSONObject cfg = new JSONObject();
		try { cfg = new JSONObject(intent == null ? "{}" : String.valueOf(intent.getStringExtra(EXTRA_CONFIG))); } catch (Exception err) { /* defaults */ }
		if (!cfg.optBoolean("enabled", true)) {
			teardown();
			stopSelf();
			return START_NOT_STICKY;
		}
		banter = cfg.optBoolean("banter", true);
		base = cfg.optString("base", "").trim();
		token = cfg.optString("token", "").trim();
		session = cfg.optString("session", "").trim();

		startForegroundSafe();
		if (root == null && Settings.canDrawOverlays(this)) addOverlay();
		startWatching();
		return START_STICKY;
	}

	private void startForegroundSafe() {
		Notification note = new NotificationCompat.Builder(this, CHANNEL_EYE)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle("Capri")
				.setContentText("Watching your back.")
				.setPriority(NotificationCompat.PRIORITY_MIN)
				.setOngoing(true)
				.build();
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
					type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
				}
				startForeground(7421, note, type);
			} else {
				startForeground(7421, note);
			}
		} catch (Exception err) {
			try { startForeground(7421, note); } catch (Exception again) { /* notification blocked */ }
		}
	}

	private void createChannels() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
		NotificationManager nm = getSystemService(NotificationManager.class);
		if (nm == null) return;
		NotificationChannel eyeCh = new NotificationChannel(CHANNEL_EYE, "Eye Spy", NotificationManager.IMPORTANCE_MIN);
		eyeCh.setShowBadge(false);
		nm.createNotificationChannel(eyeCh);
		NotificationChannel alertCh = new NotificationChannel(CHANNEL_ALERTS, "Capri alerts", NotificationManager.IMPORTANCE_HIGH);
		nm.createNotificationChannel(alertCh);
	}

	@Override
	public void onTaskRemoved(Intent rootIntent) {
		// Swiping the task away should leave the eye on screen, not kill it.
		Intent restart = new Intent(this, EyeService.class);
		restart.setAction(ACTION_START);
		restart.putExtra(EXTRA_CONFIG, currentConfig());
		try {
			PendingIntent keep = PendingIntent.getService(this, 7421, restart, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
			android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
			if (am != null) am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 800, keep);
		} catch (Exception err) { /* best effort */ }
		super.onTaskRemoved(rootIntent);
	}

	private String currentConfig() {
		JSONObject cfg = new JSONObject();
		try {
			cfg.put("enabled", true);
			cfg.put("banter", banter);
			cfg.put("base", base);
			cfg.put("token", token);
			cfg.put("session", session);
		} catch (Exception err) { /* plain fields */ }
		return cfg.toString();
	}

	private int dp(int value) {
		return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
	}

	private void addOverlay() {
		root = new FrameLayout(this);
		int wrap = WindowManager.LayoutParams.WRAP_CONTENT;
		params = new WindowManager.LayoutParams(
				wrap, wrap,
				Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE,
				WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
				PixelFormat.TRANSLUCENT);
		params.gravity = Gravity.TOP | Gravity.START;
		params.x = getResources().getDisplayMetrics().widthPixels - eyeSize - dp(16);
		params.y = Math.round(getResources().getDisplayMetrics().heightPixels * 0.32f);

		LinearLayout column = new LinearLayout(this);
		column.setOrientation(LinearLayout.VERTICAL);
		column.setGravity(Gravity.CENTER_HORIZONTAL);

		controls = new LinearLayout(this);
		controls.setOrientation(LinearLayout.HORIZONTAL);
		controls.setVisibility(View.GONE);
		controls.addView(controlButton("MIC", v -> toggleMic()));
		controls.addView(controlButton("PIN", v -> setPinned(!pinned)));
		controls.addView(controlButton("X", v -> {
			teardown();
			stopSelf();
		}));
		column.addView(controls);

		Bitmap art = loadEye();
		FrameLayout eyeBox = new FrameLayout(this);
		LinearLayout.LayoutParams boxParams = new LinearLayout.LayoutParams(eyeSize, WindowManager.LayoutParams.WRAP_CONTENT);
		// Two faint copies behind the eye: they lag a beat while you drag, which
		// reads as a trail instead of a sticker glued to the glass.
		ghostFar = new ImageView(this);
		ghostFar.setImageBitmap(art);
		ghostFar.setAlpha(0.07f);
		FrameLayout.LayoutParams ghostFarParams = new FrameLayout.LayoutParams(eyeSize, WindowManager.LayoutParams.WRAP_CONTENT);
		eyeBox.addView(ghostFar, ghostFarParams);
		ghostNear = new ImageView(this);
		ghostNear.setImageBitmap(art);
		ghostNear.setAlpha(0.14f);
		FrameLayout.LayoutParams ghostNearParams = new FrameLayout.LayoutParams(eyeSize, WindowManager.LayoutParams.WRAP_CONTENT);
		eyeBox.addView(ghostNear, ghostNearParams);
		eye = new ImageView(this);
		eye.setImageBitmap(art);
		FrameLayout.LayoutParams eyeParams = new FrameLayout.LayoutParams(eyeSize, WindowManager.LayoutParams.WRAP_CONTENT);
		eyeBox.addView(eye, eyeParams);
		column.addView(eyeBox, boxParams);

		bubble = new TextView(this);
		bubble.setTextColor(Color.parseColor("#EAF6FF"));
		bubble.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
		bubble.setTypeface(Typeface.create("sans-serif-condensed", Typeface.NORMAL));
		bubble.setMaxWidth(dp(240));
		bubble.setMaxLines(4);
		bubble.setEllipsize(TextUtils.TruncateAt.END);
		bubble.setPadding(dp(10), dp(8), dp(10), dp(8));
		GradientDrawable card = new GradientDrawable();
		card.setColor(Color.parseColor("#E607000C"));
		card.setStroke(dp(1), Color.parseColor("#8C4DFF9D"));
		card.setCornerRadius(dp(4));
		bubble.setBackground(card);
		bubble.setVisibility(View.GONE);
		bubble.setOnClickListener(v -> openApp());
		LinearLayout.LayoutParams bubbleParams = new LinearLayout.LayoutParams(
				WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT);
		bubbleParams.topMargin = dp(4);
		column.addView(bubble, bubbleParams);

		root.addView(column);
		root.setOnTouchListener(new DragListener());
		root.setClickable(true);

		try {
			windowManager.addView(root, params);
		} catch (Exception err) {
			root = null;
			stopSelf();
			return;
		}

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
			eye.animate().translationY(-dp(4)).setDuration(1800).setStartDelay(400).withEndAction(new Runnable() {
				@Override public void run() { idleFloat(); }
			}).start();
		}
	}

	private void idleFloat() {
		handler.removeCallbacks(floater);
		floater = () -> {
			if (root == null || pinned) return;
			float tilt = (float) (Math.random() * 6 - 3);
			eye.animate().translationY(dp(4)).rotation(tilt).setDuration(1700).setStartDelay(200).withEndAction(new Runnable() {
				@Override public void run() {
					eye.animate().translationY(0).rotation(-tilt).setDuration(1700).withEndAction(new Runnable() {
						@Override public void run() { idleFloat(); }
					}).start();
				}
			}).start();
		};
		handler.postDelayed(floater, 1200);
	}

	// Drag inertia: the eye leans against the motion and settles back, leaving
	// its ghost copies behind for a beat.
	private void smear(float dx, float dy) {
		if (eye == null || pinned) return;
		float ox = Math.max(-18f, Math.min(18f, -dx * 0.5f));
		float oy = Math.max(-14f, Math.min(14f, -dy * 0.5f));
		eye.animate().cancel();
		eye.setTranslationX(ox);
		eye.setTranslationY(oy);
		eye.animate().translationX(0).translationY(0).setDuration(150).start();
		if (ghostNear != null) {
			ghostNear.setTranslationX(ox * 1.7f);
			ghostNear.setTranslationY(oy * 1.7f);
			ghostNear.animate().translationX(0).translationY(0).setDuration(240).start();
		}
		if (ghostFar != null) {
			ghostFar.setTranslationX(ox * 2.4f);
			ghostFar.setTranslationY(oy * 2.4f);
			ghostFar.animate().translationX(0).translationY(0).setDuration(330).start();
		}
		// Cancelling the idle animation kills its chained end-action, so restart it.
		handler.removeCallbacks(floater);
		handler.postDelayed(floater, 380);
	}

	private TextView controlButton(String label, View.OnClickListener onClick) {
		TextView button = new TextView(this);
		button.setText(label);
		button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
		button.setTextColor(Color.parseColor("#4DFF9D"));
		button.setPadding(dp(8), dp(3), dp(8), dp(3));
		button.setOnClickListener(onClick);
		return button;
	}

	private void setPinned(boolean value) {
		pinned = value;
		eye.animate().cancel();
		if (pinned) eye.setTranslationY(0);
		else idleFloat();
	}

	// The eye art came on a white card. Fade the near-white pixels out and crop
	// the empty border so only the eye is left floating.
	private Bitmap loadEye() {
		Bitmap src = BitmapFactory.decodeResource(getResources(), R.drawable.eye_spy);
		if (src == null) return null;
		int targetW = Math.min(640, src.getWidth());
		int targetH = Math.max(1, Math.round(src.getHeight() * (targetW / (float) src.getWidth())));
		Bitmap work = Bitmap.createScaledBitmap(src, targetW, targetH, true);
		if (work != src) src.recycle();
		Bitmap out = work.copy(Bitmap.Config.ARGB_8888, true);
		work.recycle();
		int w = out.getWidth();
		int h = out.getHeight();
		int[] px = new int[w * h];
		out.getPixels(px, 0, w, 0, 0, w, h);

		int x0 = w, y0 = h, x1 = -1, y1 = -1;
		for (int y = 0; y < h; y++) {
			for (int x = 0; x < w; x++) {
				int i = y * w + x;
				int c = px[i];
				int low = Math.min(Color.red(c), Math.min(Color.green(c), Color.blue(c)));
				float t = Math.max(0f, Math.min(1f, (low - 150) / 45f));
				int alpha = Color.alpha(c);
				if (t > 0) {
					alpha = Math.round(alpha * (1f - t));
					px[i] = Color.argb(alpha, Color.red(c), Color.green(c), Color.blue(c));
				}
				if (alpha > 12) {
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
					if (y < y0) y0 = y;
					if (y > y1) y1 = y;
				}
			}
		}
		out.setPixels(px, 0, w, 0, 0, w, h);
		if (x1 < x0 || y1 < y0) return out;
		int pad = 6;
		x0 = Math.max(0, x0 - pad);
		y0 = Math.max(0, y0 - pad);
		x1 = Math.min(w - 1, x1 + pad);
		y1 = Math.min(h - 1, y1 + pad);
		Bitmap cropped = Bitmap.createBitmap(out, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
		out.recycle();
		return cropped;
	}

	// ── voice orders ──────────────────────────────────────────────────────
	private void toggleMic() {
		if (recording) { stopMic(); return; }
		if (thinking) return;
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
				&& checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			showLine("Open Capri and allow the mic first.");
			return;
		}
		if (base.isEmpty()) { showLine("Capri's link is down. Open the app once."); return; }
		try {
			takeFile = new File(getCacheDir(), "capri-eye-" + System.currentTimeMillis() + ".m4a");
			recorder = new MediaRecorder();
			recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
			recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
			recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
			recorder.setAudioSamplingRate(44100);
			recorder.setAudioEncodingBitRate(64000);
			recorder.setOutputFile(takeFile.getAbsolutePath());
			recorder.prepare();
			recorder.start();
			recording = true;
			controls.setVisibility(View.VISIBLE);
			showLine("Listening. Tap MIC when you're done.");
			handler.removeCallbacks(autoStopMic);
			handler.postDelayed(autoStopMic, 12_000);
		} catch (Exception err) {
			recording = false;
			releaseRecorder();
			showLine("The mic would not open.");
		}
	}

	private final Runnable autoStopMic = () -> { if (recording) stopMic(); };

	private void stopMic() {
		if (!recording) return;
		recording = false;
		handler.removeCallbacks(autoStopMic);
		try { recorder.stop(); } catch (Exception err) { /* stopped too early */ }
		releaseRecorder();
		handleTake();
	}

	private void releaseRecorder() {
		if (recorder != null) {
			try { recorder.reset(); } catch (Exception err) { /* nothing recording */ }
			try { recorder.release(); } catch (Exception err) { /* already gone */ }
			recorder = null;
		}
	}

	private void handleTake() {
		final File file = takeFile;
		takeFile = null;
		if (file == null || !file.exists() || file.length() < 2000) {
			showLine("The mic picked up nothing. Try again and talk right away.");
			return;
		}
		thinking = true;
		showLine("Reading that back…");
		new Thread(() -> {
			String text = transcribe(file);
			try { file.delete(); } catch (Exception err) { /* cache cleans itself */ }
			thinking = false;
			if (text == null || text.isEmpty()) {
				handler.post(() -> showLine("I caught noise, not words."));
				return;
			}
			final String heard = stripWake(text);
			if (heard.isEmpty()) {
				handler.post(() -> showLine("Say that again, choom."));
				return;
			}
			handler.post(() -> showLine(heard));
			answer(heard);
		}).start();
	}

	private String transcribe(File file) {
		HttpURLConnection conn = null;
		try {
			byte[] bytes = new byte[(int) file.length()];
			FileInputStream in = new FileInputStream(file);
			int read = in.read(bytes);
			in.close();
			if (read <= 0) return "";
			URL url = new URL(base + "/api/stt");
			conn = (HttpURLConnection) url.openConnection();
			conn.setRequestMethod("POST");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(20000);
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "audio/mp4");
			if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
			if (!session.isEmpty()) conn.setRequestProperty("X-Capri-Profile", session);
			OutputStream out = conn.getOutputStream();
			out.write(bytes);
			out.close();
			if (conn.getResponseCode() != 200) return "";
			BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder();
			String row;
			while ((row = reader.readLine()) != null) sb.append(row);
			reader.close();
			return new JSONObject(sb.toString()).optString("text", "").trim();
		} catch (Exception err) {
			return "";
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	// "Capri, set a timer" typed into the eye works the same as in the app.
	private String stripWake(String raw) {
		String clean = raw == null ? "" : raw.trim();
		String lower = clean.toLowerCase(Locale.US);
		int at = lower.indexOf("capri");
		if (at < 0) at = lower.indexOf("capri,");
		if (at >= 0) clean = clean.substring(at + 5).replaceAll("^[\\s,.:;!?\\-]+", "").trim();
		return clean;
	}

	private void answer(String order) {
		HttpURLConnection conn = null;
		try {
			URL url = new URL(base + "/api/chat?device=mobile");
			conn = (HttpURLConnection) url.openConnection();
			conn.setRequestMethod("POST");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(60000);
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			conn.setRequestProperty("Accept", "text/event-stream");
			if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
			if (!session.isEmpty()) conn.setRequestProperty("X-Capri-Profile", session);
			String payload = "{\"messages\":[{\"role\":\"user\",\"content\":" + JSONObject.quote(order)
					+ "}],\"activity\":{\"tabFocused\":false,\"banter\":true}}";
			OutputStream out = conn.getOutputStream();
			out.write(payload.getBytes(StandardCharsets.UTF_8));
			out.close();
			if (conn.getResponseCode() != 200) {
				handler.post(() -> showLine("Capri's relay refused that. Try again in a moment."));
				return;
			}
			BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
			StringBuilder reply = new StringBuilder();
			String row;
			while ((row = reader.readLine()) != null) {
				if (!row.startsWith("data:")) continue;
				String raw = row.substring(5).trim();
				if (raw.isEmpty()) continue;
				JSONObject evt;
				try { evt = new JSONObject(raw); } catch (Exception err) { continue; }
				String type = evt.optString("type");
				if ("delta".equals(type)) {
					reply.append(evt.optString("text"));
				} else if ("device_call".equals(type) && "set_reminder".equals(evt.optString("name"))) {
					JSONObject args = evt.optJSONObject("args");
					if (args != null) {
						int seconds = args.optInt("seconds", 60);
						String message = args.optString("message", "Time is up.");
						Alerts.schedule(this, seconds, message);
						handler.post(() -> showLine("Timer set: " + message));
					}
				}
			}
			reader.close();
			final String text = reply.toString().replaceAll("\\s+", " ").trim();
			if (text.isEmpty()) return;
			handler.post(() -> {
				showLine(text);
				notifyAlert("Capri", text);
				if (tts != null && ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "capri-eye");
			});
		} catch (Exception err) {
			handler.post(() -> showLine("No link to Capri right now."));
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private void showLine(String text) {
		if (root == null || bubble == null || text == null) return;
		String line = text.replaceAll("\\s+", " ").trim();
		if (line.isEmpty()) return;
		bubble.setText(line);
		bubble.setVisibility(View.VISIBLE);
		handler.removeCallbacks(hideBubble);
		handler.postDelayed(hideBubble, 11_000);
	}

	private final Runnable hideBubble = () -> {
		if (bubble != null) bubble.setVisibility(View.GONE);
	};

	private void startWatching() {
		handler.removeCallbacks(watcher);
		watcher = () -> {
			if (root != null) watchOnce();
			handler.postDelayed(watcher, 15_000);
		};
		handler.postDelayed(watcher, 20_000);
	}

	private void watchOnce() {
		if (!banter || polling || base.isEmpty()) return;
		if (!usageAllowed()) return;
		String pkg = foregroundPackage();
		if (pkg == null || pkg.equals(getPackageName())) { lastKey = ""; return; }
		String key = pkg;
		long now = System.currentTimeMillis();
		if (!key.equals(lastKey)) { lastKey = key; lastKeyAt = now; return; }
		if (now - lastKeyAt < DWELL_MS) return;
		if (key.equals(saidKey)) return;
		if (now - lastSayAt < COOLDOWN_MS) return;
		saidKey = key;
		lastSayAt = now;
		final String label = appLabel(pkg);
		polling = true;
		new Thread(() -> {
			try {
				String line = fetchBanter(label);
				if (line != null && !line.isEmpty()) {
					final String text = line;
					handler.post(() -> {
						showLine(text);
						notifyAlert("Capri", text);
					});
				}
			} finally {
				polling = false;
			}
		}).start();
	}

	private boolean usageAllowed() {
		try {
			android.app.AppOpsManager ops = (android.app.AppOpsManager) getSystemService(APP_OPS_SERVICE);
			int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
					? ops.unsafeCheckOpNoThrow("android:get_usage_stats", android.os.Process.myUid(), getPackageName())
					: ops.checkOpNoThrow("android:get_usage_stats", android.os.Process.myUid(), getPackageName());
			return mode == android.app.AppOpsManager.MODE_ALLOWED;
		} catch (Exception err) {
			return false;
		}
	}

	private String foregroundPackage() {
		try {
			UsageStatsManager usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
			long now = System.currentTimeMillis();
			UsageEvents events = usm.queryEvents(now - 120_000L, now);
			UsageEvents.Event event = new UsageEvents.Event();
			String pkg = null;
			while (events.hasNextEvent()) {
				events.getNextEvent(event);
				if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) pkg = event.getPackageName();
			}
			return pkg;
		} catch (Exception err) {
			return null;
		}
	}

	private String appLabel(String pkg) {
		try {
			android.content.pm.ApplicationInfo info = getPackageManager().getApplicationInfo(pkg, 0);
			String label = String.valueOf(getPackageManager().getApplicationLabel(info));
			if (label.length() > 50) label = label.substring(0, 50);
			return label;
		} catch (Exception err) {
			return pkg;
		}
	}

	private String fetchBanter(String appName) {
		HttpURLConnection conn = null;
		try {
			URL url = new URL(base + "/api/banter");
			conn = (HttpURLConnection) url.openConnection();
			conn.setRequestMethod("POST");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(15000);
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
			if (!session.isEmpty()) conn.setRequestProperty("X-Capri-Profile", session);
			String body = "{\"app\":" + JSONObject.quote(appName) + ",\"title\":\"\"}";
			OutputStream out = conn.getOutputStream();
			out.write(body.getBytes(StandardCharsets.UTF_8));
			out.close();
			if (conn.getResponseCode() != 200) return null;
			BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder();
			String row;
			while ((row = reader.readLine()) != null) sb.append(row);
			reader.close();
			return new JSONObject(sb.toString()).optString("line", "");
		} catch (Exception err) {
			return null;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private void notifyAlert(String title, String body) {
		try {
			NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ALERTS)
					.setSmallIcon(R.mipmap.ic_launcher)
					.setContentTitle(title)
					.setContentText(body)
					.setStyle(new NotificationCompat.BigTextStyle().bigText(body))
					.setAutoCancel(true)
					.setContentIntent(PendingIntent.getActivity(this, 7, openIntent(), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
			NotificationManagerCompat.from(this).notify((int) (System.currentTimeMillis() % 100000), builder.build());
		} catch (Exception err) { /* notifications off */ }
	}

	private Intent openIntent() {
		Intent intent = new Intent(this, MainActivity.class);
		intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
		return intent;
	}

	private void openApp() {
		try {
			startActivity(openIntent());
			teardown();
		} catch (Exception err) { /* focus stolen */ }
	}

	private void teardown() {
		handler.removeCallbacks(watcher);
		handler.removeCallbacks(floater);
		handler.removeCallbacks(hideBubble);
		handler.removeCallbacks(autoStopMic);
		if (recording) {
			recording = false;
			try { recorder.stop(); } catch (Exception err) { /* stopped early */ }
			releaseRecorder();
		}
		if (root != null) {
			try { windowManager.removeView(root); } catch (Exception err) { /* already gone */ }
			root = null;
		}
		bubble = null;
		eye = null;
		ghostNear = null;
		ghostFar = null;
		controls = null;
	}

	@Override
	public void onDestroy() {
		teardown();
		if (tts != null) {
			try { tts.shutdown(); } catch (Exception err) { /* already closed */ }
			tts = null;
		}
		super.onDestroy();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}

	private class DragListener implements View.OnTouchListener {
		private int startX;
		private int startY;
		private float touchX;
		private float touchY;
		private float lastDx;
		private float lastDy;
		private long downAt;

		@Override
		public boolean onTouch(View view, MotionEvent event) {
			switch (event.getActionMasked()) {
				case MotionEvent.ACTION_DOWN:
					startX = params.x;
					startY = params.y;
					touchX = event.getRawX();
					touchY = event.getRawY();
					lastDx = 0;
					lastDy = 0;
					downAt = System.currentTimeMillis();
					return false;
				case MotionEvent.ACTION_MOVE:
					int dx = Math.round(event.getRawX() - touchX);
					int dy = Math.round(event.getRawY() - touchY);
					if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
						params.x = startX + dx;
						params.y = startY + dy;
						try { windowManager.updateViewLayout(root, params); } catch (Exception err) { /* view gone */ }
						smear(event.getRawX() - touchX - lastDx, event.getRawY() - touchY - lastDy);
						lastDx = event.getRawX() - touchX;
						lastDy = event.getRawY() - touchY;
						return true;
					}
					return false;
				case MotionEvent.ACTION_UP:
					if (System.currentTimeMillis() - downAt < 250) {
						controls.setVisibility(controls.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
					}
					return true;
				default:
					return false;
			}
		}
	}
}

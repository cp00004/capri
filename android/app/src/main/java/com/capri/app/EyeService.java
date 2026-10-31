package com.capri.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Screen watching on the phone. There is no floating eye here: she reads what
// you are actually doing - the track, the video, the chat - and answers as a
// notification.
public class EyeService extends Service {
	public static final String ACTION_START = "com.capri.app.EYE_START";
	public static final String ACTION_STOP = "com.capri.app.EYE_STOP";
	public static final String ACTION_SHOW = "com.capri.app.EYE_SHOW";
	public static final String ACTION_HIDE = "com.capri.app.EYE_HIDE";
	public static final String EXTRA_CONFIG = "config";

	private static final String CHANNEL_EYE = "capri_eye";
	private static final String CHANNEL_ALERTS = "capri_alerts";
	private static final long DWELL_MS = 45_000L;
	private static final long COOLDOWN_MS = 120_000L;

	private Handler handler;
	private Runnable watcher;

	private boolean banter = true;
	private String base = "";
	private String token = "";
	private String session = "";
	private String apiKey = "";

	private String lastKey = "";
	private long lastKeyAt = 0;
	private long lastSayAt = 0;
	private String saidKey = "";
	private boolean polling = false;

	private Runnable nnnTick;
	private int nnnTicks = 0;
	private View nnnVeil = null;
	private long nnnVeilUntil = 0;
	private String nnnLastHit = "";
	private long nnnLastHitAt = 0;
	private boolean nnnPulling = false;

	private static boolean running = false;

	// What she calls the app, and what kind of place it is. A browser has no
	// site yet - that comes from whatever page is playing inside it.
	private static final Map<String, String[]> SIGHTS = new HashMap<>();

	static {
		SIGHTS.put("com.google.android.youtube", new String[] { "YouTube", "video" });
		SIGHTS.put("com.google.android.apps.youtube.music", new String[] { "YouTube Music", "music" });
		SIGHTS.put("com.zhiliaoapp.musically", new String[] { "TikTok", "video" });
		SIGHTS.put("com.ss.android.ugc.aweme", new String[] { "TikTok", "video" });
		SIGHTS.put("com.vimeo.android.videoapp", new String[] { "Vimeo", "video" });
		SIGHTS.put("com.netflix.mediaclient", new String[] { "Netflix", "video" });
		SIGHTS.put("com.spotify.music", new String[] { "Spotify", "music" });
		SIGHTS.put("com.soundcloud.android", new String[] { "SoundCloud", "music" });
		SIGHTS.put("deezer.android.app", new String[] { "Deezer", "music" });
		SIGHTS.put("com.apple.android.music", new String[] { "Apple Music", "music" });
		SIGHTS.put("com.google.android.apps.podcasts", new String[] { "Podcasts", "music" });
		SIGHTS.put("com.whatsapp", new String[] { "WhatsApp", "chat" });
		SIGHTS.put("com.whatsapp.w4b", new String[] { "WhatsApp", "chat" });
		SIGHTS.put("org.telegram.messenger", new String[] { "Telegram", "chat" });
		SIGHTS.put("org.telegram.messenger.web", new String[] { "Telegram", "chat" });
		SIGHTS.put("com.discord", new String[] { "Discord", "chat" });
		SIGHTS.put("com.facebook.orca", new String[] { "Messenger", "chat" });
		SIGHTS.put("com.facebook.messaging", new String[] { "Messenger", "chat" });
		SIGHTS.put("com.snapchat.android", new String[] { "Snapchat", "chat" });
		SIGHTS.put("com.google.android.apps.messaging", new String[] { "Messages", "chat" });
		SIGHTS.put("com.instagram.android", new String[] { "Instagram", "social" });
		SIGHTS.put("com.facebook.katana", new String[] { "Facebook", "social" });
		SIGHTS.put("com.reddit.frontpage", new String[] { "Reddit", "social" });
		SIGHTS.put("com.twitter.android", new String[] { "X", "social" });
		SIGHTS.put("com.pinterest", new String[] { "Pinterest", "social" });
		SIGHTS.put("com.google.android.gm", new String[] { "Gmail", "mail" });
		SIGHTS.put("com.termux", new String[] { "Termux", "code" });
		SIGHTS.put("com.android.chrome", new String[] { "", "browser" });
		SIGHTS.put("com.google.android.apps.chrome", new String[] { "", "browser" });
		SIGHTS.put("com.microsoft.emmx", new String[] { "", "browser" });
		SIGHTS.put("org.mozilla.firefox", new String[] { "", "browser" });
		SIGHTS.put("com.brave.browser", new String[] { "", "browser" });
		SIGHTS.put("com.duckduckgo.android", new String[] { "", "browser" });
		SIGHTS.put("com.kiwibrowser.browser", new String[] { "", "browser" });
		SIGHTS.put("com.opera.browser", new String[] { "", "browser" });
		SIGHTS.put("com.sec.android.app.sbrowser", new String[] { "", "browser" });
	}

	public static void stop(Context context) {
		if (!running) return;
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
		if (!running) return;
		Intent intent = new Intent(context, EyeService.class);
		intent.setAction(ACTION_HIDE);
		try { context.startService(intent); } catch (Exception err) { /* nothing running */ }
	}

	@Override
	public void onCreate() {
		super.onCreate();
		running = true;
		handler = new Handler(Looper.getMainLooper());
		createChannels();
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		String action = intent == null ? null : intent.getAction();
		if (ACTION_STOP.equals(action)) {
			stopWatching();
			stopSelf();
			return START_NOT_STICKY;
		}
		if (ACTION_HIDE.equals(action)) {
			// Only the watching pauses. The service and its foreground
			// notification stay, so resuming later is never a background start
			// Android would refuse.
			stopWatching();
			return START_STICKY;
		}

		JSONObject cfg = new JSONObject();
		try { cfg = new JSONObject(intent == null ? "{}" : String.valueOf(intent.getStringExtra(EXTRA_CONFIG))); } catch (Exception err) { /* defaults */ }
		if (!cfg.optBoolean("enabled", true)) {
			// Banter off does not mean the lock off: enforcement keeps its own
			// loop and does not need the server or the watcher.
			if (nnnArmed(this) || nnnNeeded(this)) {
				nnnCheckSchedule(this);
				base = cfg.optString("base", "").trim();
				token = cfg.optString("token", "").trim();
				session = cfg.optString("session", "").trim();
				apiKey = cfg.optString("key", "").trim();
				startForegroundSafe();
				stopWatching();
				startNnn();
				return START_STICKY;
			}
			stopWatching();
			stopNnn();
			stopSelf();
			return START_NOT_STICKY;
		}
		banter = cfg.optBoolean("banter", true);
		base = cfg.optString("base", "").trim();
		token = cfg.optString("token", "").trim();
		session = cfg.optString("session", "").trim();
		apiKey = cfg.optString("key", "").trim();

		startForegroundSafe();
		startWatching();
		if (nnnArmed(this) || nnnNeeded(this)) {
			nnnCheckSchedule(this);
			startNnn();
		}
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
				// Android 14 throws if a declared foreground type lacks its runtime
				// grant, so try the declared type then fall back to the plain form.
				try {
					startForeground(7421, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
					return;
				} catch (Exception err) { /* fall through to the plain form */ }
			}
			startForeground(7421, note);
		} catch (Exception err) {
			// A hidden notification must not take the watcher down with it.
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
		// Swiping the task away should keep her watching, not kill it.
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
			cfg.put("key", apiKey);
		} catch (Exception err) { /* plain fields */ }
		return cfg.toString();
	}

	private void startWatching() {
		handler.removeCallbacks(watcher);
		watcher = () -> {
			watchOnce();
			handler.postDelayed(watcher, 15_000);
		};
		handler.postDelayed(watcher, 20_000);
	}

	private void stopWatching() {
		if (handler != null) handler.removeCallbacks(watcher);
		watcher = null;
	}

	private void watchOnce() {
		if (!banter || polling || base.isEmpty()) return;
		if (!usageAllowed()) return;
		String pkg = foregroundPackage();
		if (pkg == null || pkg.equals(getPackageName())) { lastKey = ""; return; }
		Sight sight = sightFor(pkg);
		String key = sight.key();
		long now = System.currentTimeMillis();
		if (!key.equals(lastKey)) { lastKey = key; lastKeyAt = now; return; }
		if (now - lastKeyAt < DWELL_MS) return;
		if (key.equals(saidKey)) return;
		if (now - lastSayAt < COOLDOWN_MS) return;
		saidKey = key;
		lastSayAt = now;
		final JSONObject payload = sight.json();
		final String where = sight.label;
		polling = true;
		new Thread(() -> {
			try {
				String line = fetchBanter(payload);
				if (line != null && !line.isEmpty()) {
					final String text = line;
					handler.post(() -> notifyAlert("Capri · " + where, text));
				}
			} finally {
				polling = false;
			}
		}).start();
	}

	/* ------------------------------------------------------- no nut november */
	// The same switch the PC obeys: the server holds it, so arming it once seals
	// every device until December 1st. On a phone she cannot kill another app, so
	// the answer is a black screen over the whole display plus a push back to the
	// home screen - the blocked page is gone and nothing under it can be tapped.
	private static final String[] NNN_WORDS = {
		"porn", "pornhub", "onlyfans", "fansly", "chaturbate", "stripchat", "livejasmin", "camsoda",
		"bongacams", "cam4", "mydirtyhobby", "brazzers", "naughty", "nude", "nudes", "nsfw",
		"hentai", "eroge", "erotic", "sex", "xnxx", "xvideos", "xhamster", "redtube", "youporn",
		"spankbang", "tube8", "eporner", "beeg", "fetlife", "kink", "leaked", "adult", "xxx",
		"boobs", "milf", "blowjob", "orgy", "bdsm", "webcam model", "cam show", "camshow",
	};
	private static final Pattern NNN_PATTERN = Pattern.compile(nnAlternation(), Pattern.CASE_INSENSITIVE);

	// Built by hand: String.join needs API 26 and she still runs on 24.
	private static String nnAlternation() {
		StringBuilder sb = new StringBuilder("\\b(?:");
		for (int i = 0; i < NNN_WORDS.length; i++) {
			if (i > 0) sb.append("|");
			sb.append(NNN_WORDS[i]);
		}
		return sb.append(")\\b").toString();
	}
	private static final String NNN_PREFS = "capri_nnn";
	private static final String NNN_CODE = "34872";
	private static final String NNN_REPORT_TO = "cyberwold56789@gmail.com";
	private static final String NNN_REPORT_URL = "https://formsubmit.co/ajax/" + NNN_REPORT_TO;
	private static final long NNN_REPORT_GAP = 30L * 60L * 1000L;
	private static final long NNN_SWEEP_MS = 3000L;
	private static final long NNN_VEIL_MS = 20000L;
	private static final long NNN_GALLERY_MS = 10L * 60L * 1000L;

	private static final class VeilView extends android.widget.FrameLayout {
		VeilView(Context context) {
			super(context);
			setBackgroundColor(0xFF000000);
			setClickable(true);
			setFocusable(true);
			setFocusableInTouchMode(true);
			android.widget.TextView label = new android.widget.TextView(context);
			label.setText("NO NUT NOVEMBER\nthis screen is closed");
			label.setTextColor(0xFFFF4FA3);
			label.setTextSize(14f);
			label.setLetterSpacing(0.28f);
			label.setGravity(Gravity.CENTER);
			addView(label, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
		}

		// Swallow everything: no back, no taps, nothing reaching the app behind.
		@Override
		public boolean dispatchKeyEvent(KeyEvent event) {
			return true;
		}

		@Override
		public boolean onTouchEvent(MotionEvent event) {
			return true;
		}
	}

	// Called from the web page through CapriEyes.noNut, and from the watcher
	// itself when the shared switch says the lock is on.
	public static String noNut(Context context, String payload) {
		JSONObject in = new JSONObject();
		try { in = new JSONObject(payload == null ? "{}" : payload); } catch (Exception err) { /* status */ }
		String action = in.optString("action", "status").toLowerCase(Locale.US);
		SharedPreferences prefs = context.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE);

		if (action.equals("arm") || action.equals("activate")) {
			long now = System.currentTimeMillis();
			long gate = decemberOne(now);
			if (now >= gate) {
				return nnnAck(false, false, "December 1st has come and gone, so there is nothing left to lock.");
			}
			boolean before = now < novemberOne(now);
			prefs.edit().putBoolean("armed", true).putBoolean("auto", false)
					.putLong("releaseAt", gate).putLong("since", now).putLong("dismissed", 0L).apply();
			nnnRequestExtras(context);
			EyeService.show(context, EyePrefs.load(context));
			return nnnAck(true, false, before
					? "Armed. It switches itself on at midnight on November 1st and opens again on " + niceDate(gate) + "."
					: "Armed on this phone until " + niceDate(gate) + ".");
		}
		if (action.equals("release")) {
			prefs.edit().putBoolean("armed", false).apply();
			return nnnAck(false, false, "Lock is off.");
		}
		if (action.equals("cancel")) {
			if (!nnnActive(prefs)) return nnnAck(false, false, "Nothing is locked right now.");
			return nnnAck(true, true, "Then give me the cancellation code. Say it wrong and nothing opens.");
		}
		if (action.equals("code")) {
			if (!nnnActive(prefs)) return nnnAck(false, false, "Nothing is locked right now.");
			String given = in.optString("code", "").replaceAll("\\D", "");
			if (given.length() > 0 && given.equals(NNN_CODE)) {
				// A correct code ends the season for this phone: neither the
				// calendar nor the shared switch may switch it back on later.
				prefs.edit().putBoolean("armed", false).putBoolean("auto", false)
						.putLong("dismissed", decemberOne(System.currentTimeMillis())).apply();
				return nnnAck(false, false, "Code checked out. The lock is gone from this phone and stays gone.");
			}
			return nnnAck(true, true, "Wrong. Still locked.");
		}

		boolean active = nnnActive(prefs);
		String mode = nnnMode();
		int blocked = prefs.getInt("blocked", 0);
		JSONObject out = nnnJson(active, false, active
				? (mode.equals("before")
					? "NNN Mode is armed and starts by itself on November 1st."
					: "Active on this phone until " + niceDate(prefs.getLong("releaseAt", 0L)) + " - " + blocked + " blocked attempt" + (blocked == 1 ? "" : "s") + ".")
				: (mode.equals("after") ? "NNN Mode completed. Normal protection is back." : "No Nut November is not armed."));
		try {
			out.put("mode", mode);
			out.put("blocked", blocked);
			out.put("sites", true);
			out.put("releaseAt", prefs.getLong("releaseAt", 0L));
			out.put("dismissed", prefs.getLong("dismissed", 0L));
		} catch (Exception err) { /* plain fields */ }
		return out.toString();
	}

	private static String nnnAck(boolean active, boolean awaitingCode, String message) {
		JSONObject out = nnnJson(active, awaitingCode, message);
		return out.toString();
	}

	private static JSONObject nnnJson(boolean active, boolean awaitingCode, String message) {
		JSONObject out = new JSONObject();
		try {
			out.put("ok", true);
			out.put("active", active);
			out.put("awaitingCode", awaitingCode);
			out.put("message", message);
		} catch (Exception err) { /* plain fields */ }
		return out;
	}

	// The Google account the loss report signs itself with.
	public static void identify(Context context, String email, String name) {
		context.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE).edit()
				.putString("email", email == null ? "" : email.trim())
				.putString("name", name == null ? "" : name.trim()).apply();
	}

	// The calendar, not a timer: November 1st 00:00 to December 1st 00:00 in
	// the phone's own zone. Checked on every service start and every tick.
	private static long novemberOne(long from) {
		Calendar gate = Calendar.getInstance();
		gate.setTimeInMillis(from);
		gate.set(Calendar.MONTH, Calendar.NOVEMBER);
		gate.set(Calendar.DAY_OF_MONTH, 1);
		gate.set(Calendar.HOUR_OF_DAY, 0);
		gate.set(Calendar.MINUTE, 0);
		gate.set(Calendar.SECOND, 0);
		gate.set(Calendar.MILLISECOND, 0);
		return gate.getTimeInMillis();
	}

	private static String nnnMode() {
		long now = System.currentTimeMillis();
		if (now < novemberOne(now)) return "before";
		return now < decemberOne(now) ? "active" : "after";
	}

	private static boolean nnnActive(SharedPreferences prefs) {
		return prefs.getBoolean("armed", false) && System.currentTimeMillis() < prefs.getLong("releaseAt", 0L);
	}

	// Called by the service loop, the boot receiver and the night alarm.
	public static void nnnCheckSchedule(Context context) {
		SharedPreferences prefs = context.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE);
		long now = System.currentTimeMillis();
		long start = novemberOne(now);
		long end = decemberOne(now);
		boolean armed = prefs.getBoolean("armed", false);
		if (now >= end) {
			if (armed) {
				prefs.edit().putBoolean("armed", false).putBoolean("auto", false).putLong("completed", end).apply();
				Alerts.show(context, "Capri // NO NUT NOVEMBER", "NNN Mode completed. Normal protection is back.");
			} else if (prefs.getLong("completed", 0L) != end && prefs.getLong("since", 0L) > 0L) {
				prefs.edit().putLong("completed", end).apply();
				Alerts.show(context, "Capri // NO NUT NOVEMBER", "NNN Mode completed. Normal protection is back.");
			}
			return;
		}
		if (now < start) return;
		if (!armed && prefs.getLong("dismissed", 0L) != end) {
			prefs.edit().putBoolean("armed", true).putBoolean("auto", true)
					.putLong("releaseAt", end).putLong("since", now).apply();
			Alerts.show(context, "Capri // NO NUT NOVEMBER", "NNN Mode is active until " + niceDate(end) + ".");
		} else if (armed && prefs.getLong("releaseAt", 0L) != end) {
			prefs.edit().putLong("releaseAt", end).apply();
		}
	}

	// Should the service be up right now for the lock's sake? True through the
	// whole season unless the code ended it on this phone.
	public static boolean nnnNeeded(Context context) {
		SharedPreferences prefs = context.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE);
		long now = System.currentTimeMillis();
		return now >= novemberOne(now) && now < decemberOne(now)
				&& prefs.getLong("dismissed", 0L) != decemberOne(now);
	}

	// December 1st, this year if it has not passed yet, otherwise next year.
	private static long decemberOne(long from) {
		Calendar gate = Calendar.getInstance();
		gate.setTimeInMillis(from);
		gate.set(Calendar.MONTH, Calendar.DECEMBER);
		gate.set(Calendar.DAY_OF_MONTH, 1);
		gate.set(Calendar.HOUR_OF_DAY, 0);
		gate.set(Calendar.MINUTE, 0);
		gate.set(Calendar.SECOND, 0);
		gate.set(Calendar.MILLISECOND, 0);
		if (from >= gate.getTimeInMillis()) gate.add(Calendar.YEAR, 1);
		return gate.getTimeInMillis();
	}

	private static String niceDate(long millis) {
		return new java.text.SimpleDateFormat("EEEE d MMMM", Locale.US).format(new java.util.Date(millis));
	}

	static boolean nnnArmed(Context context) {
		return nnnActive(context.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE));
	}

	private static void nnnRequestExtras(Context context) {
		if (context instanceof MainActivity) ((MainActivity) context).askNnnPermissions();
	}

	// One email per half hour at most: a record of the loss, not an inbox flood.
	private static void nnnReport(Context context, String what) {
		final Context app = context.getApplicationContext();
		SharedPreferences prefs = app.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE);
		long now = System.currentTimeMillis();
		if (now - prefs.getLong("reportedAt", 0L) < NNN_REPORT_GAP) return;
		prefs.edit().putLong("reportedAt", now).apply();
		final String email = prefs.getString("email", "");
		final String name = prefs.getString("name", "");
		final String body = "LOST NNN (NO NUT NOVEMBER) LOSER\n\n"
				+ "Google account: " + (email.isEmpty() ? "not signed in" : email) + "\n"
				+ "Name on it: " + (name.isEmpty() ? "(not set)" : name) + "\n"
				+ "Broke the rule on: " + what + "\n"
				+ "Device: " + Build.MANUFACTURER + " " + Build.MODEL + " (Android)\n"
				+ "When: " + new java.text.SimpleDateFormat("EEEE d MMMM HH:mm", Locale.US).format(new java.util.Date(now));
		JSONObject payload = new JSONObject();
		try {
			payload.put("_subject", "LOST NNN (NO NUT NOVEMBER) LOSER");
			payload.put("name", name.isEmpty() ? "unknown" : name);
			payload.put("email", email.isEmpty() ? NNN_REPORT_TO : email);
			payload.put("message", body);
		} catch (Exception err) { return; }
		final String json = payload.toString();
		new Thread(() -> {
			HttpURLConnection conn = null;
			try {
				conn = (HttpURLConnection) new URL(NNN_REPORT_URL).openConnection();
				conn.setRequestMethod("POST");
				conn.setConnectTimeout(10000);
				conn.setReadTimeout(15000);
				conn.setDoOutput(true);
				conn.setRequestProperty("Content-Type", "application/json");
				conn.setRequestProperty("Accept", "application/json");
				OutputStream os = conn.getOutputStream();
				os.write(json.getBytes(StandardCharsets.UTF_8));
				os.close();
				conn.getResponseCode();
			} catch (Exception err) { /* the next hit tries again */ }
			finally { if (conn != null) conn.disconnect(); }
		}).start();
	}

	// The gallery, by name and folder. Android ships no offline "is this adult
	// content" model, so this is the honest heuristic: a filename or album that
	// says what it is. Matches are reported once each.
	private static void nnnScanGallery(Context context) {
		final Context app = context.getApplicationContext();
		SharedPreferences prefs = app.getSharedPreferences(NNN_PREFS, Context.MODE_PRIVATE);
		prefs.edit().putLong("galleryAt", System.currentTimeMillis()).apply();
		java.util.Set<String> seen = new java.util.HashSet<>(prefs.getStringSet("gallerySeen", new java.util.HashSet<String>()));
		boolean added = false;
		for (android.net.Uri base : new android.net.Uri[] {
				MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI }) {
			android.database.Cursor cur = null;
			try {
				String[] cols = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
						? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH }
						: new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.DATA };
				cur = app.getContentResolver().query(base, cols, null, null, MediaStore.MediaColumns.DATE_ADDED + " DESC");
				if (cur == null) continue;
				int idCol = cur.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
				int nameCol = cur.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
				while (cur.moveToNext()) {
					String name = String.valueOf(cur.getString(nameCol));
					String path = cur.getString(2);
					if (!NNN_PATTERN.matcher(name + " " + (path == null ? "" : path)).find()) continue;
					String key = base + "/" + cur.getLong(idCol);
					if (seen.contains(key)) continue;
					seen.add(key);
					added = true;
					Alerts.show(app, "Capri // NO NUT NOVEMBER", "Found an 18+ file in your gallery (" + name + "). Reported as a loss.");
					nnnReport(app, "gallery file: " + name);
					prefs.edit().putInt("blocked", prefs.getInt("blocked", 0) + 1).apply();
				}
			} catch (Exception err) { /* no media grant yet */ }
			finally { if (cur != null) cur.close(); }
		}
		if (!added) return;
		if (seen.size() > 800) {
			java.util.List<String> list = new java.util.ArrayList<>(seen);
			seen = new java.util.HashSet<>(list.subList(list.size() - 400, list.size()));
		}
		prefs.edit().putStringSet("gallerySeen", seen).apply();
	}

	private void startNnn() {
		handler.removeCallbacks(nnnTick);
		nnnTicks = 0;
		nnnTick = new Runnable() {
			@Override
			public void run() {
				nnnTicks += 1;
				// The calendar is read again every minute, not trusted to a timer.
				if (nnnTicks % 20 == 1) nnnCheckSchedule(EyeService.this);
				if (nnnTicks % 40 == 1) nnnPull();
				nnnSweepOnce();
				handler.postDelayed(this, NNN_SWEEP_MS);
			}
		};
		handler.postDelayed(nnnTick, 1500L);
	}

	private void stopNnn() {
		if (handler != null && nnnTick != null) handler.removeCallbacks(nnnTick);
		nnnTick = null;
		nnnVeilHide();
	}

	private void nnnSweepOnce() {
		SharedPreferences prefs = getSharedPreferences(NNN_PREFS, MODE_PRIVATE);
		long now = System.currentTimeMillis();
		if (!nnnActive(prefs) || now < novemberOne(now)) {
			// Armed for the season but the clock has not turned yet: nothing is
			// closed in October, the countdown does the waiting.
			if (prefs.getBoolean("armed", false) && now >= decemberOne(now)) {
				prefs.edit().putBoolean("armed", false).apply();
				nnnCheckSchedule(this);
			}
			nnnVeilHide();
			return;
		}
		// Past the hold, the cover comes off by itself so a blocked detour does
		// not sit on the display forever.
		if (nnnVeil != null && System.currentTimeMillis() >= nnnVeilUntil) nnnVeilHide();
		// The gallery is searched every ten minutes, once the sweeps are flowing.
		if (now - prefs.getLong("galleryAt", 0L) > NNN_GALLERY_MS) nnnScanGallery(this);
		if (!usageAllowed()) return;
		String pkg = foregroundPackage();
		if (pkg == null || pkg.equals(getPackageName())) return;
		if (pkg.contains("launcher") || pkg.startsWith("com.android.systemui")) return;
		String hit = nnnHit(nnnHaystack(pkg));
		if (hit.isEmpty()) return;
		nnnVeilShow(NNN_VEIL_MS);
		nnnGoHome();
		prefs.edit().putInt("blocked", prefs.getInt("blocked", 0) + 1).apply();
		if (!hit.equals(nnnLastHit) || now - nnnLastHitAt > 60_000L) {
			nnnLastHit = hit;
			nnnLastHitAt = now;
			notifyAlert("Capri // NO NUT NOVEMBER",
					"Closed. It stays closed until " + niceDate(prefs.getLong("releaseAt", 0L)) + ".");
			nnnReport(this, appLabel(pkg) + " (" + pkg + ") - matched \"" + hit + "\"");
		}
	}

	// Everything the phone will say about this moment: the app, its package, the
	// screen inside it, the track playing, the last notification.
	private String nnnHaystack(String pkg) {
		StringBuilder sb = new StringBuilder();
		sb.append(appLabel(pkg)).append(' ').append(pkg);
		String hint = activityHint(pkg);
		if (!hint.isEmpty()) sb.append(' ').append(hint);
		String[] media = activeMedia(pkg);
		if (media != null) sb.append(' ').append(media[0]).append(' ').append(media[1]);
		String[] note = noteFor(pkg);
		if (note != null) sb.append(' ').append(note[0]).append(' ').append(note[1]);
		String component = foregroundComponent(pkg);
		if (component != null) sb.append(' ').append(component);
		return sb.toString();
	}

	private String nnnHit(String haystack) {
		Matcher m = NNN_PATTERN.matcher(String.valueOf(haystack));
		return m.find() ? m.group() : "";
	}

	private void nnnVeilShow(long holdMs) {
		nnnVeilUntil = Math.max(nnnVeilUntil, System.currentTimeMillis() + holdMs);
		if (nnnVeil != null) return;
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) return;
		nnnVeilAdd(holdMs, false);
		if (nnnVeil == null) nnnVeilAdd(holdMs, true);
	}

	private void nnnVeilAdd(long holdMs, boolean unfocusable) {
		try {
			WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
			if (wm == null) return;
			VeilView veil = new VeilView(this);
			int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
					? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
					: WindowManager.LayoutParams.TYPE_PHONE;
			int flags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
					| WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
					| WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
					| WindowManager.LayoutParams.FLAG_FULLSCREEN;
			if (unfocusable) flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
			WindowManager.LayoutParams p = new WindowManager.LayoutParams(
					WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
					type, flags, PixelFormat.OPAQUE);
			p.gravity = Gravity.TOP | Gravity.START;
			wm.addView(veil, p);
			nnnVeil = veil;
		} catch (Exception err) {
			// No overlay grant, or the build refuses the window: the home push still works.
		}
	}

	private void nnnVeilHide() {
		nnnVeilUntil = 0;
		if (nnnVeil == null) return;
		try {
			((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(nnnVeil);
		} catch (Exception err) { /* already off */ }
		nnnVeil = null;
	}

	private void nnnGoHome() {
		try {
			Intent home = new Intent(Intent.ACTION_MAIN);
			home.addCategory(Intent.CATEGORY_HOME);
			home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			startActivity(home);
		} catch (Exception err) { /* no launcher to go to */ }
	}

	// The shared switch, read straight from the backend so the phone honours it
	// with the web view shut.
	private void nnnPull() {
		if (nnnPulling || base.isEmpty()) return;
		nnnPulling = true;
		final String url = base + "/api/nnn";
		new Thread(() -> {
			String body = httpGet(url);
			nnnPulling = false;
			if (body == null) return;
			JSONObject state = new JSONObject();
			try { state = new JSONObject(body); } catch (Exception err) { return; }
			if (!state.has("armed")) return;
			boolean armed = state.optBoolean("armed", false);
			long releaseAt = state.optLong("releaseAt", 0L);
			SharedPreferences prefs = getSharedPreferences(NNN_PREFS, MODE_PRIVATE);
			boolean local = prefs.getBoolean("armed", false);
			// A code release is final for this phone's season: the shared switch
			// may turn it on for everyone else, never back on here.
			boolean dismissed = prefs.getLong("dismissed", 0L) == decemberOne(System.currentTimeMillis());
			if (armed && System.currentTimeMillis() < releaseAt && !dismissed) {
				if (!local || prefs.getLong("releaseAt", 0L) != releaseAt) {
					prefs.edit().putBoolean("armed", true).putLong("releaseAt", releaseAt)
							.putLong("since", System.currentTimeMillis()).apply();
				}
			} else if (!armed) {
				// The shared switch switched off. That is an announcement, not an
				// order: the local lock keeps its own state until December 1st.
				nnnCheckSchedule(EyeService.this);
			}
		}).start();
	}

	private String httpGet(String url) {
		HttpURLConnection conn = null;
		try {
			conn = (HttpURLConnection) new URL(url).openConnection();
			conn.setRequestMethod("GET");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(12000);
			if (conn.getResponseCode() != 200) return null;
			BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder();
			String row;
			while ((row = reader.readLine()) != null) sb.append(row);
			reader.close();
			return sb.toString();
		} catch (Exception err) {
			return null;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private static final class Sight {
		String app = "";
		String label = "";
		String site = "";
		String title = "";
		String kind = "app";
		boolean known = true;

		String key() { return (label + "|" + title).toLowerCase(Locale.US); }

		JSONObject json() {
			JSONObject out = new JSONObject();
			try {
				out.put("app", app);
				out.put("label", label);
				out.put("site", site);
				out.put("title", title);
				out.put("kind", kind);
				out.put("known", known);
			} catch (Exception err) { /* plain fields */ }
			return out;
		}
	}

	// Everything knowable about this moment: the app, the kind of place it is,
	// and the actual thing happening in it.
	private Sight sightFor(String pkg) {
		Sight s = new Sight();
		String name = appLabel(pkg);
		s.app = name;
		s.label = name;
		String[] meta = SIGHTS.get(pkg.toLowerCase(Locale.US));
		if (meta != null) {
			s.kind = meta[1];
			s.site = meta[0];
			if (!meta[0].isEmpty()) s.label = meta[0];
		} else {
			s.kind = isGame(pkg) ? "game" : "app";
			s.known = seenBefore(pkg);
		}

		String[] media = activeMedia(pkg);
		String[] note = noteFor(pkg);
		if (media != null) {
			String artist = media[1];
			s.title = artist.isEmpty() || media[0].toLowerCase(Locale.US).contains(artist.toLowerCase(Locale.US))
					? media[0]
					: media[0] + " - " + artist;
			if (s.kind.equals("app") || s.kind.equals("browser")) s.kind = "video";
			if (s.site.isEmpty()) s.site = siteInside(media[0] + " " + (note == null ? "" : note[0] + " " + note[1]));
		} else if (note != null) {
			s.title = note[1].isEmpty() ? note[0] : note[0] + ": " + note[1];
		} else {
			s.title = activityHint(pkg);
		}
		if (s.kind.equals("browser")) s.label = s.site.isEmpty() ? (s.title.isEmpty() ? name : s.title) : s.site;
		if (!s.site.isEmpty()) s.known = true;
		return s;
	}

	// A video playing in a browser still belongs to the service hosting it.
	private String siteInside(String haystack) {
		String low = haystack.toLowerCase(Locale.US);
		if (low.contains("youtube")) return "YouTube";
		if (low.contains("tiktok")) return "TikTok";
		if (low.contains("vimeo")) return "Vimeo";
		return "";
	}

	// The track or video playing right now, read from its media session. That
	// needs notification access, so it quietly falls back to nothing.
	private String[] activeMedia(String pkg) {
		if (!listenerEnabled()) return null;
		try {
			MediaSessionManager msm = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
			if (msm == null) return null;
			List<MediaController> controllers = msm.getActiveSessions(new ComponentName(this, CapriListener.class));
			for (MediaController controller : controllers) {
				if (controller == null || !pkg.equals(controller.getPackageName())) continue;
				PlaybackState state = controller.getPlaybackState();
				if (state == null || state.getState() != PlaybackState.STATE_PLAYING) continue;
				MediaMetadata md = controller.getMetadata();
				if (md == null) continue;
				String title = clean(md.getString(MediaMetadata.METADATA_KEY_TITLE));
				if (title.isEmpty()) continue;
				return new String[] { title, clean(md.getString(MediaMetadata.METADATA_KEY_ARTIST)) };
			}
		} catch (Exception err) { /* no listener access on this build */ }
		return null;
	}

	private String[] noteFor(String pkg) {
		StatusBarNotification sbn = CapriListener.latest(pkg);
		if (sbn == null || sbn.getNotification() == null) return null;
		android.os.Bundle extras = sbn.getNotification().extras;
		if (extras == null) return null;
		String title = clean(String.valueOf(extras.get("android.title")));
		String text = clean(String.valueOf(extras.get("android.text")));
		if (title.isEmpty() && text.isEmpty()) return null;
		return new String[] { title.isEmpty() ? "Notification" : title, text };
	}

	// A class name means nothing to anyone, but "WatchWhileActivity" or
	// "Conversation" says more than the bare app label.
	private String activityHint(String pkg) {
		String component = foregroundComponent(pkg);
		if (component == null || !component.contains(".")) return "";
		String cls = component.substring(component.lastIndexOf('.') + 1).toLowerCase(Locale.US);
		if (cls.contains("watch") || cls.contains("player") || cls.contains("video")) return "watching a video";
		if (cls.contains("conversation") || cls.contains("chat") || cls.contains("thread")) return "in a chat";
		if (cls.contains("feed") || cls.contains("timeline") || cls.contains("home")) return "scrolling the feed";
		if (cls.contains("search")) return "searching";
		if (cls.contains("editor") || cls.contains("terminal") || cls.contains("code")) return "in something technical";
		return "";
	}

	private boolean listenerEnabled() {
		try {
			String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
			return enabled != null && enabled.contains(getPackageName());
		} catch (Exception err) {
			return false;
		}
	}

	private boolean isGame(String pkg) {
		try {
			ApplicationInfo info = getPackageManager().getApplicationInfo(pkg, 0);
			return (info.flags & ApplicationInfo.FLAG_IS_GAME) != 0;
		} catch (Exception err) {
			return false;
		}
	}

	// True from the second sighting on: the first time in an unknown app is news,
	// and she says so.
	private boolean seenBefore(String pkg) {
		SharedPreferences prefs = getSharedPreferences("capri-sighted", MODE_PRIVATE);
		boolean seen = prefs.getBoolean(pkg, false);
		if (!seen) prefs.edit().putBoolean(pkg, true).apply();
		return seen;
	}

	private String clean(String raw) {
		if (raw == null) return "";
		String out = raw.replaceAll("\\s+", " ").trim();
		if (out.equalsIgnoreCase("null") || out.equals("\"\"")) return "";
		return out.length() > 140 ? out.substring(0, 140) : out;
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

	// The usage stream holds the last two minutes of screens. The newest event
	// for this package is the screen they are actually on.
	private String foregroundComponent(String wanted) {
		try {
			UsageStatsManager usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
			long now = System.currentTimeMillis();
			UsageEvents events = usm.queryEvents(now - 120_000L, now);
			UsageEvents.Event event = new UsageEvents.Event();
			String component = null;
			while (events.hasNextEvent()) {
				events.getNextEvent(event);
				if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND
						&& wanted.equals(event.getPackageName())) {
					component = event.getClassName();
				}
			}
			return component;
		} catch (Exception err) {
			return null;
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
			ApplicationInfo info = getPackageManager().getApplicationInfo(pkg, 0);
			String label = String.valueOf(getPackageManager().getApplicationLabel(info));
			return label.length() > 50 ? label.substring(0, 50) : label;
		} catch (Exception err) {
			return pkg;
		}
	}

	private String fetchBanter(JSONObject ctx) {
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
			if (!apiKey.isEmpty()) conn.setRequestProperty("x-capri-key", apiKey);
			OutputStream out = conn.getOutputStream();
			out.write(ctx.toString().getBytes(StandardCharsets.UTF_8));
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

	@Override
	public void onDestroy() {
		running = false;
		stopWatching();
		stopNnn();
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
		else stopForeground(true);
		super.onDestroy();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}
}

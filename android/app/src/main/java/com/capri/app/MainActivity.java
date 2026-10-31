package com.capri.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.AppOpsManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final int CAPRI_PERMISSION_REQUEST = 1723;
	private static final int CAPRI_MEDIA_REQUEST = 1724;
	private final java.util.ArrayDeque<String> grantQueue = new java.util.ArrayDeque<>();
	private boolean grantFlow = false;
	private boolean thenRuntime = false;
	private long lastGrantStep = 0;

	// name -> { package, web fallback }
	private static final Map<String, String[]> APPS = new HashMap<>();

	static {
		APPS.put("youtube", new String[] { "com.google.android.youtube", "https://www.youtube.com" });
		APPS.put("discord", new String[] { "com.discord", "https://discord.com/app" });
		APPS.put("spotify", new String[] { "com.spotify.music", "https://open.spotify.com" });
		APPS.put("instagram", new String[] { "com.instagram.android", "https://www.instagram.com" });
		APPS.put("facebook", new String[] { "com.facebook.katana", "https://www.facebook.com" });
		APPS.put("tiktok", new String[] { "com.zhiliaoapp.musically", "https://www.tiktok.com" });
		APPS.put("twitter", new String[] { "com.twitter.android", "https://x.com" });
		APPS.put("reddit", new String[] { "com.reddit.frontpage", "https://www.reddit.com" });
		APPS.put("twitch", new String[] { "tv.twitch.android.app", "https://www.twitch.tv" });
		APPS.put("netflix", new String[] { "com.netflix.mediaclient", "https://www.netflix.com" });
		APPS.put("whatsapp", new String[] { "com.whatsapp", "https://web.whatsapp.com" });
		APPS.put("telegram", new String[] { "org.telegram.messenger", "https://web.telegram.org" });
		APPS.put("snapchat", new String[] { "com.snapchat.android", "https://web.snapchat.com" });
		APPS.put("gmail", new String[] { "com.google.android.gm", "https://mail.google.com" });
		APPS.put("maps", new String[] { "com.google.android.apps.maps", "https://maps.google.com" });
		APPS.put("chrome", new String[] { "com.android.chrome", "https://www.google.com" });
		APPS.put("photos", new String[] { "com.google.android.apps.photos", "https://photos.google.com" });
		APPS.put("drive", new String[] { "com.google.android.apps.docs", "https://drive.google.com" });
		APPS.put("calendar", new String[] { "com.google.android.calendar", "https://calendar.google.com" });
		APPS.put("play store", new String[] { "com.android.vending", "https://play.google.com/store" });
		APPS.put("clock", new String[] { "com.google.android.deskclock", null });
		APPS.put("calculator", new String[] { "com.google.android.calculator", null });
	}

	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		WebView webView = getBridge() != null ? getBridge().getWebView() : null;
		if (webView != null) {
			webView.addJavascriptInterface(new DeviceBridge(), "CapriDevice");
			webView.addJavascriptInterface(new EyeBridge(), "CapriEyes");
			webView.addJavascriptInterface(new PermBridge(), "CapriPerms");
			// The page needs the mic without a second tap after the OS dialog.
			webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
		}

		requestRuntime(false);
		NnnReceiver.schedule(this);
	}

	// Everything the phone has to hand over before she can actually watch: mic,
	// notifications, notification access (what is playing), usage access, exact
	// alarms and a battery exemption. The page asks here and gets sent to the
	// right screen.
	private class PermBridge {
		@JavascriptInterface
		public String status() {
			return grantStatus().toString();
		}

		@JavascriptInterface
		public String request(String what) {
			final String which = String.valueOf(what == null ? "" : what).trim().toLowerCase(Locale.US);
			runOnUiThread(() -> openGrant(which));
			return grantStatus().toString();
		}

		@JavascriptInterface
		public String startEye() {
			JSONObject cfg = new JSONObject();
			try { cfg = new JSONObject(EyePrefs.load(MainActivity.this)); } catch (Exception err) { /* defaults */ }
			EyeService.show(MainActivity.this, cfg.toString());
			return grantStatus().toString();
		}
	}

	private JSONObject grantStatus() {
		JSONObject out = new JSONObject();
		try {
			boolean mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
			boolean notes = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
					|| NotificationManagerCompat.from(this).areNotificationsEnabled();
			boolean listener = listenerAllowed();
			boolean usage = usageAllowed();
			boolean alarms = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
					|| ((AlarmManager) getSystemService(ALARM_SERVICE)).canScheduleExactAlarms();
			boolean battery = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
					|| ((PowerManager) getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());
			out.put("mic", mic);
			out.put("notifications", notes);
			out.put("listener", listener);
			out.put("usage", usage);
			out.put("alarms", alarms);
			out.put("battery", battery);
			out.put("overlay", overlayAllowed());
			out.put("core", mic && notes && usage);
		} catch (Exception err) {
			// a missing reading is just a missing grant
		}
		return out;
	}

	// Notification access is the one grant she cannot check with a normal
	// permission call - it lives in its own secure setting.
	private boolean listenerAllowed() {
		try {
			String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
			return enabled != null && enabled.contains(getPackageName());
		} catch (Exception err) {
			return false;
		}
	}

	private boolean usageAllowed() {
		try {
			AppOpsManager ops = (AppOpsManager) getSystemService(APP_OPS_SERVICE);
			if (ops == null) return false;
			int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
					? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getPackageName())
					: ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getPackageName());
			return mode == AppOpsManager.MODE_ALLOWED;
		} catch (Exception err) {
			return false;
		}
	}

	// The black lock screen is an overlay window, so it needs the same grant the
	// old floating eye used to.
	private boolean overlayAllowed() {
		try {
			return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this);
		} catch (Exception err) {
			return false;
		}
	}

	private void openGrant(String which) {
		if (which.isEmpty() || which.equals("all")) {
			startGrantFlow();
			return;
		}
		switch (which) {
			case "mic":
			case "notifications":
				requestRuntime(false);
				break;
			case "listener":
			case "usage":
			case "alarms":
			case "battery":
			case "overlay":
				openSettingsPage(which);
				break;
			default:
				openSettingsPage("usage");
		}
	}

	// Full access is not one screen: Android splits these grants across the
	// dialog and four different settings pages. Walk them one at a time,
	// starting the next whenever the user comes back.
	private void startGrantFlow() {
		grantQueue.clear();
		grantQueue.add("listener");
		grantQueue.add("usage");
		grantQueue.add("alarms");
		grantQueue.add("battery");
		grantFlow = true;
		lastGrantStep = 0;
		requestRuntime(true);
	}

	private void nextGrant() {
		if (!grantFlow) return;
		long now = android.os.SystemClock.elapsedRealtime();
		if (now - lastGrantStep < 900) return;
		lastGrantStep = now;
		String next = grantQueue.poll();
		if (next == null) {
			grantFlow = false;
			return;
		}
		openSettingsPage(next);
	}

	private void requestRuntime(boolean thenAll) {
		ArrayList<String> missing = new ArrayList<>();
		if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.RECORD_AUDIO);
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
				&& ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.POST_NOTIFICATIONS);
		}
		if (missing.isEmpty()) {
			if (thenAll) nextGrant();
			return;
		}
		thenRuntime = thenAll;
		ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), CAPRI_PERMISSION_REQUEST);
	}

	@Override
	public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
		super.onRequestPermissionsResult(requestCode, permissions, grantResults);
		if (requestCode == CAPRI_MEDIA_REQUEST) return;
		if (requestCode == CAPRI_PERMISSION_REQUEST && thenRuntime) {
			thenRuntime = false;
			nextGrant();
		}
	}

	private void openSettingsPage(String which) {
		try {
			Intent intent;
			switch (which) {
				case "listener":
					// No public constant for this one on every build, so name the
					// action and let the fallback page catch a miss.
					intent = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
					break;
				case "usage":
					intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
					intent.setData(Uri.parse("package:" + getPackageName()));
					break;
				case "alarms":
					intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
							? new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))
							: new Intent(Settings.ACTION_SETTINGS);
					break;
				case "battery":
					intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
							? new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))
							: new Intent(Settings.ACTION_SETTINGS);
					break;
				case "notifications":
					intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
					intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
					break;
				case "overlay":
					intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
							? new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))
							: new Intent(Settings.ACTION_SETTINGS);
					break;
				default:
					intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
			}
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			startActivity(intent);
		} catch (Exception err) {
			try {
				startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))
						.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
			} catch (Exception again) { /* no settings app */ }
		}
	}

	private class DeviceBridge {
		@JavascriptInterface
		public String open(String target) {
			try {
				return launch(String.valueOf(target == null ? "" : target).trim());
			} catch (Exception err) {
				return "err:" + err.getMessage();
			}
		}

		// APK updates land the same way the PC's do: the app fetches the build,
		// then hands the system installer the package. No browser detour.
		@JavascriptInterface
		public String installUpdate(String url) {
			final String link = String.valueOf(url == null ? "" : url).trim();
			if (!link.startsWith("https://")) return "err:url";
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
				runOnUiThread(() -> {
					try {
						startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
								Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
					} catch (Exception err) { /* no settings page */ }
				});
				Alerts.show(MainActivity.this, "Capri update", "Allow Capri to install apps, then tap update again.");
				return "err:permission";
			}
			Alerts.show(MainActivity.this, "Capri update", "Downloading the new build...");
			new Thread(() -> {
				HttpURLConnection conn = null;
				try {
					conn = (HttpURLConnection) new URL(link).openConnection();
					conn.setConnectTimeout(15000);
					conn.setReadTimeout(60000);
					conn.setInstanceFollowRedirects(true);
					if (conn.getResponseCode() != 200) throw new Exception("status " + conn.getResponseCode());
					File out = new File(getCacheDir(), "capri-update.apk");
					InputStream in = conn.getInputStream();
					FileOutputStream os = new FileOutputStream(out);
					byte[] buf = new byte[65536];
					int n;
					while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
					os.close();
					in.close();
					Uri apk = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", out);
					Intent it = new Intent(Intent.ACTION_VIEW)
							.setDataAndType(apk, "application/vnd.android.package-archive")
							.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
					runOnUiThread(() -> {
						try { startActivity(it); }
						catch (Exception err) { Alerts.show(MainActivity.this, "Capri update", "Could not open the installer."); }
					});
				} catch (Exception err) {
					Alerts.show(MainActivity.this, "Capri update", "Update download failed. Try once from the download panel.");
				} finally {
					if (conn != null) conn.disconnect();
				}
			}).start();
			return "ok";
		}
	}

	// The watcher, plus the bits of the shell the web page cannot reach: system
	// notifications and alarms that outlive the app.
	private class EyeBridge {
		@JavascriptInterface
		public void setConfig(String config) {
			EyePrefs.save(MainActivity.this, config);
		}

		@JavascriptInterface
		public void show() {
			EyeService.show(MainActivity.this, EyePrefs.load(MainActivity.this));
		}

		@JavascriptInterface
		public void start(String config) {
			EyePrefs.save(MainActivity.this, config);
			EyeService.show(MainActivity.this, config);
		}

		@JavascriptInterface
		public void hide() {
			if (EyePrefs.enabled(MainActivity.this)) EyeService.hide(MainActivity.this);
			else EyeService.stop(MainActivity.this);
		}

		@JavascriptInterface
		public void stop() {
			EyeService.stop(MainActivity.this);
		}

		@JavascriptInterface
		public void notify(String title, String body) {
			Alerts.show(MainActivity.this, title, body);
		}

		@JavascriptInterface
		public void scheduleReminder(int seconds, String message) {
			Alerts.schedule(MainActivity.this, seconds, message);
		}

		// The No Nut November switch. Replies with JSON so the page can read her
		// answer the same way it reads the PC shell's.
		@JavascriptInterface
		public String noNut(String payload) {
			return EyeService.noNut(MainActivity.this, payload);
		}

		// The Google account the loss report signs itself with.
		@JavascriptInterface
		public void identify(String email, String name) {
			EyeService.identify(MainActivity.this, email, name);
		}

		@JavascriptInterface
		public void grantMedia() {
			askNnnPermissions();
		}
	}

	// The gallery scan needs media access; on Android 13+ that is two different
	// grants, and the overlay has its own screen. Asked once when the lock arms.
	void askNnnPermissions() {
		runOnUiThread(() -> {
			ArrayList<String> missing = new ArrayList<>();
			if (Build.VERSION.SDK_INT >= 33) {
				if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
					missing.add(Manifest.permission.READ_MEDIA_IMAGES);
				}
				if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
					missing.add(Manifest.permission.READ_MEDIA_VIDEO);
				}
			} else if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
				missing.add(Manifest.permission.READ_EXTERNAL_STORAGE);
			}
			if (!missing.isEmpty()) {
				ActivityCompat.requestPermissions(MainActivity.this, missing.toArray(new String[0]), CAPRI_MEDIA_REQUEST);
			}
		});
	}

	@Override
	protected void onUserLeaveHint() {
		// Fires while we still count as foreground, so the watcher service is
		// allowed to start. Watching is off while you are inside the app.
		super.onUserLeaveHint();
		if (EyePrefs.enabled(this) || EyeService.nnnArmed(this) || EyeService.nnnNeeded(this)) {
			EyeService.show(this, EyePrefs.load(this));
		}
	}

	@Override
	public void onResume() {
		super.onResume();
		if (EyePrefs.enabled(this)) EyeService.hide(this);
		else if (EyeService.nnnArmed(this) || EyeService.nnnNeeded(this)) EyeService.show(this, EyePrefs.load(this));
		else EyeService.stop(this);
		if (grantFlow) new android.os.Handler(getMainLooper()).postDelayed(this::nextGrant, 700);
	}

	private String launch(String raw) {
		if (raw.isEmpty()) return "err:empty";
		String lower = raw.toLowerCase(Locale.US);

		if (lower.startsWith("http://") || lower.startsWith("https://")
				|| lower.startsWith("tel:") || lower.startsWith("sms:") || lower.startsWith("mailto:")
				|| lower.startsWith("geo:")) {
			return openUri(Uri.parse(raw), raw);
		}

		if (lower.startsWith("intent:")) {
			try {
				Intent intent = Intent.parseUri(raw, Intent.URI_INTENT_SCHEME);
				intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
				startActivity(intent);
				return "ok:" + raw;
			} catch (Exception err) {
				return "err:" + err.getMessage();
			}
		}

		String digits = raw.replaceAll("[^0-9+]", "");
		boolean wantsText = lower.contains("text") || lower.contains("sms") || lower.contains("message");
		if ((wantsText || lower.contains("call") || lower.contains("dial") || lower.contains("ring"))
				&& digits.replaceAll("[^0-9]", "").length() >= 3) {
			return openUri(Uri.parse((wantsText ? "sms:" : "tel:") + digits), raw);
		}
		java.util.regex.Matcher mail = java.util.regex.Pattern
				.compile("[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}").matcher(raw);
		if (mail.find()) {
			return openUri(Uri.parse("mailto:" + mail.group()), raw);
		}

		if (lower.equals("settings") || lower.endsWith(" settings")) {
			return openAction(Settings.ACTION_SETTINGS);
		}
		if (lower.contains("camera")) {
			return openAction(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
		}
		if (lower.equals("dialer") || lower.equals("phone") || lower.equals("call")) {
			return openAction(Intent.ACTION_DIAL);
		}

		String[] known = APPS.get(lower);
		if (known == null) {
			for (Map.Entry<String, String[]> entry : APPS.entrySet()) {
				if (lower.contains(entry.getKey())) {
					known = entry.getValue();
					break;
				}
			}
		}
		if (known != null) {
			String launched = tryPackage(known[0]);
			if (launched != null) return launched;
			if (known[1] != null) return openUri(Uri.parse(known[1]), known[1]);
		}

		if (lower.contains(".")) {
			String launched = tryPackage(raw);
			if (launched != null) return launched;
		}

		Intent found = findInstalled(raw);
		if (found != null) {
			found.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			try {
				startActivity(found);
				return "ok:" + raw;
			} catch (ActivityNotFoundException ignored) {
				// keep looking
			}
		}

		return openUri(Uri.parse("https://www.google.com/search?q=" + Uri.encode(raw)), raw);
	}

	private String openAction(String action) {
		Intent intent = new Intent(action);
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		try {
			startActivity(intent);
			return "ok:" + action;
		} catch (ActivityNotFoundException err) {
			return "err:no handler for " + action;
		}
	}

	private String openUri(Uri uri, String label) {
		Intent intent = new Intent(Intent.ACTION_VIEW, uri);
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		try {
			startActivity(intent);
			return "ok:" + label;
		} catch (ActivityNotFoundException err) {
			return "err:no handler for " + label;
		}
	}

	private String tryPackage(String pkg) {
		Intent intent = getPackageManager().getLaunchIntentForPackage(pkg);
		if (intent == null) return null;
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		try {
			startActivity(intent);
			return "ok:" + pkg;
		} catch (ActivityNotFoundException err) {
			return null;
		}
	}

	private Intent findInstalled(String query) {
		Intent main = new Intent(Intent.ACTION_MAIN, null);
		main.addCategory(Intent.CATEGORY_LAUNCHER);
		List<ResolveInfo> apps = getPackageManager().queryIntentActivities(main, 0);
		String needle = query.toLowerCase(Locale.US);
		ResolveInfo best = null;
		int bestScore = 0;
		for (ResolveInfo info : apps) {
			String label = String.valueOf(info.loadLabel(getPackageManager())).toLowerCase(Locale.US);
			String pkg = info.activityInfo.packageName.toLowerCase(Locale.US);
			int score = 0;
			if (label.equals(needle) || pkg.equals(needle)) score = 100;
			else if (label.startsWith(needle) || pkg.startsWith(needle)) score = 80;
			else if (label.contains(needle)) score = 50;
			else if (needle.length() >= 3 && label.length() >= 3 && needle.contains(label)) score = 40;
			if (score > bestScore) {
				bestScore = score;
				best = info;
			}
		}
		if (best == null) return null;
		return getPackageManager().getLaunchIntentForPackage(best.activityInfo.packageName);
	}
}

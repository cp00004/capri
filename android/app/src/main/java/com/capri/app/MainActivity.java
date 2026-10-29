package com.capri.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final int CAPRI_PERMISSION_REQUEST = 1723;

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
		}

		ArrayList<String> missing = new ArrayList<>();
		if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.RECORD_AUDIO);
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
				&& ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.POST_NOTIFICATIONS);
		}
		if (!missing.isEmpty()) {
			ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), CAPRI_PERMISSION_REQUEST);
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

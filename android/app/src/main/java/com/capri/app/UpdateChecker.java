package com.capri.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

// Version feed on Pages. A newer build becomes a heads-up notification whose
// tap downloads the APK and opens the system installer - the app never has to
// be launched.
final class UpdateChecker {
	static final String VERSION_URL = "https://cp00004.github.io/capri/version.json";
	static final String CHANNEL = "capri_updates";
	static final int NOTIFICATION_ID = 4712;
	private static final String PREFS = "capri-updates";

	private UpdateChecker() {}

	static void check(Context context) {
		try {
			String json = fetch(VERSION_URL + "?t=" + System.currentTimeMillis(), 8_000);
			if (json == null) return;
			JSONObject feed = new JSONObject(json);
			String version = feed.optString("version", "").trim();
			String apk = feed.optString("apk", "").trim();
			if (version.isEmpty() || !apk.startsWith("https://")) return;
			if (cmp(version, versionName(context)) <= 0) return;
			SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
			if (version.equals(prefs.getString("notified", ""))) return;
			notifyUpdate(context, version, apk);
			prefs.edit().putString("notified", version).apply();
		} catch (Exception err) {
			/* offline or bad feed: the next alarm tries again */
		}
	}

	static void notifyUpdate(Context context, String version, String apk) {
		ensureChannel(context);
		Intent open = new Intent(context, UpdateInstallActivity.class)
				.putExtra("version", version)
				.putExtra("apk", apk)
				.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
		PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open,
				PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle("Capri " + version + " is ready")
				.setContentText("Tap to download and install the update.")
				.setStyle(new NotificationCompat.BigTextStyle().bigText(
						"Capri " + version + " is ready. Tap to download and install - you do not need to open the app."))
				.setPriority(NotificationCompat.PRIORITY_HIGH)
				.setAutoCancel(false)
				.setOngoing(false)
				.setContentIntent(tap);
		try {
			NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
		} catch (Exception err) {
			/* notifications blocked */
		}
	}

	// Downloads the release APK and hands it to the system installer. Returns
	// false when the build could not be fetched.
	static boolean downloadAndInstall(Context context, String apkUrl, String version) {
		HttpURLConnection conn = null;
		try {
			File out = new File(context.getCacheDir(), "capri-update.apk");
			if (out.exists() && !out.delete()) throw new Exception("stale apk busy");
			conn = (HttpURLConnection) new URL(apkUrl).openConnection();
			conn.setConnectTimeout(20_000);
			conn.setReadTimeout(120_000);
			conn.setInstanceFollowRedirects(true);
			conn.setRequestProperty("User-Agent", "Capri-Android");
			if (conn.getResponseCode() != 200) throw new Exception("status " + conn.getResponseCode());
			try (InputStream in = conn.getInputStream(); FileOutputStream os = new FileOutputStream(out)) {
				byte[] buf = new byte[65_536];
				int n;
				while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
			}
			if (out.length() < 2_000_000) throw new Exception("short download");
			Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", out);
			Intent install = new Intent(Intent.ACTION_VIEW)
					.setDataAndType(uri, "application/vnd.android.package-archive")
					.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
			context.startActivity(install);
			NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
			return true;
		} catch (Exception err) {
			return false;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	static void notifyFailed(Context context, String version) {
		// Let the next alarm try again instead of staying silent for this build.
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("notified").apply();
		ensureChannel(context);
		Intent open = new Intent(context, MainActivity.class)
				.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
		PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID + 1, open,
				PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle("Capri update failed")
				.setContentText("Could not download " + version + ". It will retry automatically.")
				.setPriority(NotificationCompat.PRIORITY_DEFAULT)
				.setAutoCancel(true)
				.setContentIntent(tap);
		try {
			NotificationManagerCompat.from(context).notify(NOTIFICATION_ID + 1, builder.build());
		} catch (Exception err) {
			/* notifications blocked */
		}
	}

	static void ensureChannel(Context context) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
		NotificationManager nm = context.getSystemService(NotificationManager.class);
		if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
		NotificationChannel channel = new NotificationChannel(CHANNEL, "Capri updates", NotificationManager.IMPORTANCE_HIGH);
		channel.setDescription("New Capri builds, ready to install");
		nm.createNotificationChannel(channel);
	}

	static String versionName(Context context) {
		try {
			PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
			return info.versionName == null ? "" : info.versionName;
		} catch (Exception err) {
			return "";
		}
	}

	static int cmp(String a, String b) {
		String[] x = String.valueOf(a).split("\\.");
		String[] y = String.valueOf(b).split("\\.");
		int len = Math.max(x.length, y.length);
		for (int i = 0; i < len; i++) {
			int p = i < x.length ? safeInt(x[i]) : 0;
			int q = i < y.length ? safeInt(y[i]) : 0;
			if (p != q) return p > q ? 1 : -1;
		}
		return 0;
	}

	private static int safeInt(String s) {
		try {
			return Integer.parseInt(s.replaceAll("[^0-9].*$", ""));
		} catch (Exception err) {
			return 0;
		}
	}

	private static String fetch(String link, int timeout) {
		HttpURLConnection conn = null;
		try {
			conn = (HttpURLConnection) new URL(link).openConnection();
			conn.setConnectTimeout(timeout);
			conn.setReadTimeout(timeout);
			conn.setInstanceFollowRedirects(true);
			conn.setRequestProperty("User-Agent", "Capri-Android");
			if (conn.getResponseCode() != 200) return null;
			StringBuilder out = new StringBuilder();
			try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
				String line;
				while ((line = reader.readLine()) != null) out.append(line).append('\n');
			}
			return out.toString();
		} catch (Exception err) {
			return null;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}
}

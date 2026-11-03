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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

// Version feed on Pages. A newer build becomes a heads-up notification whose
// tap downloads the APK, proves the file is the one we published, and opens the
// system installer - the app never has to be launched.
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
			String sha = feed.optString("apkSha256", "").trim();
			long size = feed.optLong("apkSize", 0);
			if (version.isEmpty() || !apk.startsWith("https://")) return;
			if (cmp(version, versionName(context)) <= 0) return;
			SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
			if (version.equals(prefs.getString("notified", ""))) return;
			notifyUpdate(context, version, apk, sha, size);
			prefs.edit().putString("notified", version).apply();
		} catch (Exception err) {
			/* offline or bad feed: the next alarm tries again */
		}
	}

	static void notifyUpdate(Context context, String version, String apk, String sha, long size) {
		ensureChannel(context);
		Intent open = new Intent(context, UpdateInstallActivity.class)
				.putExtra("version", version)
				.putExtra("apk", apk)
				.putExtra("sha", sha == null ? "" : sha)
				.putExtra("size", size)
				.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
		PendingIntent tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open,
				PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle("Capri " + version + " is ready")
				.setContentText("Tap to install the update.")
				.setStyle(new NotificationCompat.BigTextStyle().bigText(
						"Capri " + version + " is ready. Tap once and the app installs it - you do not need to open the app."))
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

	// Downloads the release APK, proves the file is intact and the one we
	// published, then hands it to the system installer. A half-written file is
	// what made Android answer "There was a problem parsing the package", so a
	// failed check deletes the file and retries once before giving up.
	static boolean downloadAndInstall(Context context, String apkUrl, String version, String sha, long size) {
		File out = new File(context.getCacheDir(), "capri-update.apk");
		String hash = sha == null ? "" : sha.trim();
		long want = size;
		if (hash.isEmpty() || want <= 0) {
			String[] meta = feedMeta(apkUrl);
			if (meta != null) {
				if (hash.isEmpty()) hash = meta[0];
				if (want <= 0) {
					try { want = Long.parseLong(meta[1]); } catch (Exception err) { /* size unknown */ }
				}
			}
		}

		for (int attempt = 0; attempt < 2; attempt++) {
			HttpURLConnection conn = null;
			try {
				if (out.exists() && !out.delete()) {
					out = new File(context.getCacheDir(), "capri-update-" + attempt + ".apk");
				}
				String url = attempt == 0
						? apkUrl
						: apkUrl + (apkUrl.contains("?") ? "&" : "?") + "t=" + System.currentTimeMillis();
				conn = (HttpURLConnection) new URL(url).openConnection();
				conn.setConnectTimeout(20_000);
				conn.setReadTimeout(120_000);
				conn.setInstanceFollowRedirects(true);
				conn.setRequestProperty("User-Agent", "Capri-Android");
				if (conn.getResponseCode() != 200) throw new Exception("status " + conn.getResponseCode());
				long declared = 0;
				try { declared = Long.parseLong(String.valueOf(conn.getHeaderField("Content-Length"))); } catch (Exception err) { /* streamed */ }
				long total = 0;
				try (InputStream in = conn.getInputStream(); FileOutputStream os = new FileOutputStream(out)) {
					byte[] buf = new byte[65_536];
					int n;
					while ((n = in.read(buf)) > 0) {
						os.write(buf, 0, n);
						total += n;
					}
				}
				if (declared > 0 && total != declared) throw new Exception("truncated " + total + "/" + declared);
				if (want > 0 && total != want) throw new Exception("wrong size " + total + "/" + want);
				if (out.length() < 2_000_000) throw new Exception("short download");
				if (!hash.isEmpty() && !sha256(out).equalsIgnoreCase(hash)) throw new Exception("checksum mismatch");
				if (!parsesAsCapri(context, out)) throw new Exception("package does not parse");
				openInstaller(context, out);
				NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
				return true;
			} catch (Exception err) {
				if (out.exists()) out.delete();
			} finally {
				if (conn != null) conn.disconnect();
			}
		}
		return false;
	}

	// The SHA-256 and size published next to the download link, or null.
	private static String[] feedMeta(String apkUrl) {
		try {
			String json = fetch(VERSION_URL + "?t=" + System.currentTimeMillis(), 8_000);
			if (json == null) return null;
			JSONObject feed = new JSONObject(json);
			if (!apkUrl.equals(feed.optString("apk", "").trim())) return null;
			return new String[] { feed.optString("apkSha256", "").trim(), String.valueOf(feed.optLong("apkSize", 0)) };
		} catch (Exception err) {
			return null;
		}
	}

	private static String sha256(File file) throws Exception {
		MessageDigest md = MessageDigest.getInstance("SHA-256");
		try (InputStream in = new FileInputStream(file)) {
			byte[] buf = new byte[65_536];
			int n;
			while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
		}
		StringBuilder out = new StringBuilder();
		for (byte b : md.digest()) out.append(String.format("%02x", b));
		return out.toString();
	}

	// Android itself parses the manifest here. A null result means the package
	// is broken, and a versionCode that is not newer can never replace this app.
	private static boolean parsesAsCapri(Context context, File file) {
		try {
			PackageInfo next = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), 0);
			if (next == null) return false;
			if (!context.getPackageName().equals(next.packageName)) return false;
			PackageInfo now = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
			return next.versionCode > now.versionCode;
		} catch (Exception err) {
			return false;
		}
	}

	private static void openInstaller(Context context, File file) {
		Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
		Intent install = new Intent(Intent.ACTION_VIEW)
				.setDataAndType(uri, "application/vnd.android.package-archive")
				.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
		context.startActivity(install);
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

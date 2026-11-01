package com.capri.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// The host half of the block. A public porn-only hosts list (StevenBlack's
// aggregation, 70k+ domains) ships inside the APK, so blocking works offline;
// the same list is fetched again once a week when the phone has a connection so
// new sites arrive without an update.
final class NnnDomains {
	private static final String TAG = "CapriNnn";
	private static final String SOURCE = "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts";
	private static final String CACHE = "porn-domains.txt";
	private static final long REFRESH_MS = 7L * 24 * 60 * 60 * 1000L;
	private static final Pattern HOST = Pattern.compile("[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.[a-z]{2,24}", Pattern.CASE_INSENSITIVE);
	private static final Pattern VALID = Pattern.compile("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,24}$");

	private static volatile Set<String> domains = null;
	private static volatile long loadedAt = 0;

	// Ask-for-these-back sites. A music video called "sexy anime" is the song,
	// not a porn page: these hosts and the apps built on them are never hits,
	// and the downloaded host list is filtered with the same set.
	private static final String[] ALLOWED = {
		"youtube.com", "youtube-nocookie.com", "youtu.be", "yt.be", "ytimg.com", "googlevideo.com",
		"tiktok.com", "tiktokv.com", "tiktokcdn.com", "ttwstatic.com", "byteoversea.com",
		"whatsapp.com", "web.whatsapp.com", "whatsapp.net", "wa.me", "whatsappweb.com",
		"ichigo.tv",
	};

	private static final String[] ALLOWED_PACKAGES = {
		"youtube", "tiktok", "musically", "trill", "whatsapp", "ichigo",
	};

	private NnnDomains() {}

	static boolean ready() {
		return domains != null && !domains.isEmpty();
	}

	static synchronized void ensure(Context context) {
		if (domains != null) return;
		Set<String> set = new HashSet<>(90000);
		File cache = new File(context.getFilesDir(), CACHE);
		if (!read(cache, set) || set.isEmpty()) {
			set.clear();
			try (InputStream in = context.getAssets().open("porn-domains.txt")) {
				read(in, set);
			} catch (Exception err) {
				Log.w(TAG, "bundled domain list missing: " + err.getMessage());
			}
		}
		if (!set.isEmpty()) {
			domains = set;
			loadedAt = System.currentTimeMillis();
			Log.i(TAG, "porn domain list ready: " + set.size());
		}
	}

	// The part of a URL that decides it: "static.pornhub.com" is pornhub.com.
	static boolean isBlockedHost(String host) {
		if (isAllowedHost(host)) return false;
		Set<String> set = domains;
		if (set == null || host == null || host.isEmpty()) return false;
		String h = host.toLowerCase(Locale.US);
		if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
		int guard = 0;
		while (h.indexOf('.') > 0 && guard++ < 8) {
			if (set.contains(h)) return true;
			h = h.substring(h.indexOf('.') + 1);
		}
		return false;
	}

	static boolean isAllowedHost(String host) {
		if (host == null || host.isEmpty()) return false;
		String h = host.toLowerCase(Locale.US);
		if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
		int guard = 0;
		while (h.indexOf('.') > 0 && guard++ < 8) {
			for (String allowed : ALLOWED) if (h.equals(allowed)) return true;
			h = h.substring(h.indexOf('.') + 1);
		}
		return false;
	}

	// The apps themselves: a YouTube player, a TikTok feed or a WhatsApp chat
	// carries words in its own UI that must never close it.
	static boolean isAllowedApp(String pkg) {
		if (pkg == null || pkg.isEmpty()) return false;
		String p = pkg.toLowerCase(Locale.US);
		for (String marker : ALLOWED_PACKAGES) if (p.contains(marker)) return true;
		return false;
	}

	// Whether the screen is one of those sites. The first host in the readable
	// text is the address bar in every browser that exposes one; hosts further
	// down are page content. The tab title ("... - IchigoTV") counts too, for
	// browsers whose address bar never reaches accessibility.
	private static boolean allowedPage(String haystack) {
		if (haystack == null || haystack.isEmpty()) return false;
		String low = haystack.toLowerCase(Locale.US);
		if (low.contains("ichigotv")) return true;
		Matcher m = HOST.matcher(low);
		return m.find() && isAllowedHost(m.group());
	}

	// Words, brands, adult TLDs and the host list in one answer. Non-browser
	// apps pass strict=true so an ordinary chat about anime stays open.
	static String hit(String haystack, boolean strict) {
		if (allowedPage(haystack)) return "";
		String word = strict ? NnnRules.strictHit(haystack) : NnnRules.firstHit(haystack);
		if (!word.isEmpty()) return word;
		if (!ready() || haystack == null) return "";
		Matcher m = HOST.matcher(haystack.toLowerCase(Locale.US));
		while (m.find()) {
			String host = m.group();
			if (isBlockedHost(host)) return host;
		}
		return "";
	}

	static void refreshIfStale(Context context) {
		try {
			SharedPreferences prefs = context.getSharedPreferences("capri_nnn", Context.MODE_PRIVATE);
			long now = System.currentTimeMillis();
			if (now - prefs.getLong("domainAt", 0L) < REFRESH_MS) return;
			Set<String> set = new HashSet<>(90000);
			if (!fetch(set) || set.size() < 1000) return;
			File cache = new File(context.getFilesDir(), CACHE);
			StringBuilder rows = new StringBuilder(set.size() * 24);
			for (String host : set) rows.append(host).append('\n');
			try (OutputStream out = new FileOutputStream(cache)) {
				out.write(rows.toString().getBytes(StandardCharsets.UTF_8));
			}
			domains = set;
			prefs.edit().putLong("domainAt", now).apply();
			Log.i(TAG, "porn domain list refreshed: " + set.size());
		} catch (Exception err) {
			Log.w(TAG, "domain refresh failed: " + err.getMessage());
		}
	}

	private static boolean fetch(Set<String> into) {
		HttpURLConnection conn = null;
		try {
			conn = (HttpURLConnection) new URL(SOURCE).openConnection();
			conn.setConnectTimeout(15000);
			conn.setReadTimeout(45000);
			conn.setInstanceFollowRedirects(true);
			if (conn.getResponseCode() != 200) return false;
			return read(conn.getInputStream(), into) && !into.isEmpty();
		} catch (Exception err) {
			return false;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private static boolean read(File file, Set<String> into) {
		if (!file.isFile()) return false;
		try (InputStream in = new java.io.FileInputStream(file)) {
			return read(in, into);
		} catch (Exception err) {
			return false;
		}
	}

	private static boolean read(InputStream in, Set<String> into) {
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
			String line;
			while ((line = reader.readLine()) != null) {
				if (into.size() >= 400000) break;
				int hash = line.indexOf('#');
				if (hash == 0) continue;
				String row = (hash > 0 ? line.substring(0, hash) : line).trim();
				if (row.isEmpty()) continue;
				String[] parts = row.split("\\s+");
				String host = parts[parts.length - 1].toLowerCase(Locale.US);
				if (!VALID.matcher(host).matches()) continue;
				if (host.equals("localhost") || host.startsWith("localhost.")) continue;
				if (isAllowedHost(host)) continue;
				into.add(host);
			}
			return true;
		} catch (Exception err) {
			return false;
		}
	}

	static long loadedAt() {
		return loadedAt;
	}
}

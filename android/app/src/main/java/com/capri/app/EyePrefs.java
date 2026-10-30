package com.capri.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

// The eye settings live here so the background service and the activity agree
// even when the web view is gone.
final class EyePrefs {
	private static final String FILE = "capri_eye";

	private EyePrefs() {}

	static void save(Context context, String config) {
		SharedPreferences prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
		String raw = config == null ? "{}" : config;
		JSONObject json = new JSONObject();
		try { json = new JSONObject(raw); } catch (Exception err) { /* keep defaults */ }
		prefs.edit()
				.putBoolean("enabled", json.optBoolean("enabled", true))
				.putBoolean("banter", json.optBoolean("banter", true))
				.putString("base", json.optString("base", ""))
				.putString("token", json.optString("token", ""))
				.putString("session", json.optString("session", ""))
				.apply();
	}

	static String load(Context context) {
		SharedPreferences prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
		JSONObject json = new JSONObject();
		try {
			json.put("enabled", prefs.getBoolean("enabled", true));
			json.put("banter", prefs.getBoolean("banter", true));
			json.put("base", prefs.getString("base", ""));
			json.put("token", prefs.getString("token", ""));
			json.put("session", prefs.getString("session", ""));
		} catch (Exception err) { /* plain fields */ }
		return json.toString();
	}

	static boolean enabled(Context context) {
		return context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean("enabled", true);
	}
}

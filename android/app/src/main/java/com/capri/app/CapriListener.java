package com.capri.app;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

// Notification access does two jobs at once: it is the key Android requires
// before it will hand over media sessions, and the feed itself tells her who
// messaged or what just landed while you were parked in an app.
public class CapriListener extends NotificationListenerService {
	private static final long KEEP_MS = 10 * 60_000L;
	private static final int KEEP_APPS = 40;
	private static final Map<String, StatusBarNotification> latest = new HashMap<>();
	private static final Map<String, Long> arrivedAt = new HashMap<>();

	@Override
	public void onNotificationPosted(StatusBarNotification sbn) {
		if (sbn == null || sbn.getNotification() == null) return;
		String pkg = sbn.getPackageName();
		if (pkg == null || pkg.equals(getPackageName())) return;
		synchronized (latest) {
			latest.put(pkg, sbn);
			arrivedAt.put(pkg, System.currentTimeMillis());
			if (latest.size() > KEEP_APPS) dropOldest();
		}
	}

	@Override
	public void onNotificationRemoved(StatusBarNotification sbn) {
		if (sbn == null) return;
		synchronized (latest) {
			StatusBarNotification held = latest.get(sbn.getPackageName());
			if (held != null && held.getKey().equals(sbn.getKey())) {
				latest.remove(sbn.getPackageName());
				arrivedAt.remove(sbn.getPackageName());
			}
		}
	}

	// The newest thing this app put on the shade, or null if it has been quiet.
	public static StatusBarNotification latest(String pkg) {
		if (pkg == null) return null;
		synchronized (latest) {
			Long when = arrivedAt.get(pkg);
			if (when == null) return null;
			if (System.currentTimeMillis() - when > KEEP_MS) {
				latest.remove(pkg);
				arrivedAt.remove(pkg);
				return null;
			}
			return latest.get(pkg);
		}
	}

	private void dropOldest() {
		ArrayList<String> keys = new ArrayList<>(arrivedAt.keySet());
		keys.sort((a, b) -> Long.compare(arrivedAt.get(b), arrivedAt.get(a)));
		for (int i = KEEP_APPS; i < keys.size(); i++) {
			latest.remove(keys.get(i));
			arrivedAt.remove(keys.get(i));
		}
	}
}

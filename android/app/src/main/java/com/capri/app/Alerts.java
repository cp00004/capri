package com.capri.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

// System notifications from the page: instant alerts and timers that survive
// the app being closed.
final class Alerts {
	static final String CHANNEL = "capri_alerts";

	private Alerts() {}

	static void ensureChannel(Context context) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
		NotificationManager nm = context.getSystemService(NotificationManager.class);
		if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
		nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Capri alerts", NotificationManager.IMPORTANCE_HIGH));
	}

	static void show(Context context, String title, String body) {
		String safeTitle = title == null || title.trim().isEmpty() ? "Capri" : title;
		String safeBody = body == null ? "" : body;
		ensureChannel(context);
		Intent open = new Intent(context, MainActivity.class);
		open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
		PendingIntent tap = PendingIntent.getActivity(context, 11, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle(safeTitle)
				.setContentText(safeBody)
				.setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
				.setPriority(NotificationCompat.PRIORITY_HIGH)
				.setAutoCancel(true)
				.setContentIntent(tap);
		try {
			NotificationManagerCompat.from(context).notify((int) (System.currentTimeMillis() % 100000), builder.build());
		} catch (Exception err) {
			// notifications off
		}
	}

	static void schedule(Context context, int seconds, String message) {
		long delay = Math.max(3, Math.min(86_400, seconds)) * 1000L;
		AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
		if (alarms == null) return;
		Intent fire = new Intent(context, ReminderReceiver.class);
		fire.putExtra(ReminderReceiver.EXTRA_MESSAGE, message == null ? "Time is up." : message);
		PendingIntent pending = PendingIntent.getBroadcast(
				context,
				(int) (System.currentTimeMillis() % 100000),
				fire,
				PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		long at = System.currentTimeMillis() + delay;
		try {
			alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
		} catch (SecurityException err) {
			alarms.set(AlarmManager.RTC_WAKEUP, at, pending);
		}
	}
}

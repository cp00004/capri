package com.capri.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

// A quiet six-hour heartbeat: checks the release feed and posts a system
// notification, so an update reaches the phone without opening Capri.
final class UpdateScheduler {
	static final String ACTION_CHECK = "com.capri.app.UPDATE_CHECK";
	private static final long PERIOD = 6 * 60 * 60 * 1000L;
	private static final int REQUEST = 4711;

	private UpdateScheduler() {}

	static PendingIntent pending(Context context) {
		Intent fire = new Intent(context, UpdateReceiver.class).setAction(ACTION_CHECK);
		return PendingIntent.getBroadcast(context, REQUEST, fire,
				PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
	}

	static void schedule(Context context) {
		AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
		if (alarms == null) return;
		long first = System.currentTimeMillis() + 30 * 60 * 1000L;
		try {
			alarms.setInexactRepeating(AlarmManager.RTC_WAKEUP, first, PERIOD, pending(context));
		} catch (Exception err) {
			try {
				alarms.set(AlarmManager.RTC_WAKEUP, first, pending(context));
			} catch (Exception again) {
				/* alarms unavailable */
			}
		}
	}
}

package com.capri.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Calendar;

// The lock outlives the app and the phone: the system wakes this after a boot,
// after a clock or timezone change, and once a night just past midnight. It
// starts the watcher, and the watcher reads the calendar and decides for itself.
public class NnnReceiver extends BroadcastReceiver {
	public static final String ACTION_NNN_NIGHT = "com.capri.app.NNN_NIGHT";

	@Override
	public void onReceive(Context context, Intent intent) {
		boolean night = intent != null && ACTION_NNN_NIGHT.equals(intent.getAction());
		EyeService.show(context, EyePrefs.load(context));
		if (night) EyeService.nnnCheckSchedule(context);
		schedule(context);
	}

	public static void schedule(Context context) {
		try {
			AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
			if (am == null) return;
			Intent intent = new Intent(context, NnnReceiver.class).setAction(ACTION_NNN_NIGHT);
			int flags = PendingIntent.FLAG_UPDATE_CURRENT;
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
			PendingIntent pi = PendingIntent.getBroadcast(context, 7401, intent, flags);
			Calendar next = Calendar.getInstance();
			next.add(Calendar.DAY_OF_MONTH, 1);
			next.set(Calendar.HOUR_OF_DAY, 0);
			next.set(Calendar.MINUTE, 5);
			next.set(Calendar.SECOND, 0);
			next.set(Calendar.MILLISECOND, 0);
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
				am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), pi);
			} else {
				am.set(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), pi);
			}
		} catch (Exception err) { /* the boot path still covers a reboot */ }
	}
}

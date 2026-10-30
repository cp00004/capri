package com.capri.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

// Timers survive the app: an alarm fires here and the phone shows Capri's line.
public class ReminderReceiver extends BroadcastReceiver {
	public static final String CHANNEL = "capri_alerts";
	public static final String EXTRA_MESSAGE = "message";

	@Override
	public void onReceive(Context context, Intent intent) {
		String message = intent == null ? "" : String.valueOf(intent.getStringExtra(EXTRA_MESSAGE));
		if (message == null || message.trim().isEmpty()) message = "Time is up.";
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			NotificationManager nm = context.getSystemService(NotificationManager.class);
			if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
				nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Capri alerts", NotificationManager.IMPORTANCE_HIGH));
			}
		}
		Intent open = new Intent(context, MainActivity.class);
		open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
		PendingIntent tap = PendingIntent.getActivity(context, 9, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
		NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
				.setSmallIcon(R.mipmap.ic_launcher)
				.setContentTitle("Capri")
				.setContentText(message)
				.setStyle(new NotificationCompat.BigTextStyle().bigText(message))
				.setPriority(NotificationCompat.PRIORITY_HIGH)
				.setAutoCancel(true)
				.setContentIntent(tap);
		try {
			NotificationManagerCompat.from(context).notify((int) (System.currentTimeMillis() % 100000), builder.build());
		} catch (Exception err) {
			// notifications blocked by the user
		}
	}
}

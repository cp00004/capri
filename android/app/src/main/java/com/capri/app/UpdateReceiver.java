package com.capri.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Boot, app replacement and the six-hour alarm all land here. The receiver
// exits quickly; the feed check runs on its own thread.
public class UpdateReceiver extends BroadcastReceiver {
	@Override
	public void onReceive(Context context, Intent intent) {
		UpdateScheduler.schedule(context);
		final PendingResult result = goAsync();
		new Thread(() -> {
			try {
				UpdateChecker.check(context);
			} finally {
				result.finish();
			}
		}, "capri-update-check").start();
	}
}

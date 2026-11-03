package com.capri.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

// Invisible tap target behind the update notification: fetches the APK while
// the user stays wherever they are, then opens the system installer.
public class UpdateInstallActivity extends Activity {
	@Override
	protected void onCreate(Bundle saved) {
		super.onCreate(saved);
		Intent intent = getIntent();
		final String apk = intent.getStringExtra("apk");
		final String version = intent.getStringExtra("version") == null ? "" : intent.getStringExtra("version");
		final String sha = intent.getStringExtra("sha") == null ? "" : intent.getStringExtra("sha");
		final long size = intent.getLongExtra("size", 0);
		if (apk == null || !apk.startsWith("https://")) {
			finish();
			return;
		}

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
			try {
				startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
						Uri.parse("package:" + getPackageName()))
						.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
			} catch (Exception err) { /* no settings page */ }
			Toast.makeText(this, "Allow Capri to install apps, then tap the update notification again.", Toast.LENGTH_LONG).show();
			finish();
			return;
		}

		final android.content.Context app = getApplicationContext();
		new Thread(() -> {
			boolean ok = UpdateChecker.downloadAndInstall(app, apk, version, sha, size);
			if (!ok) {
				UpdateChecker.notifyFailed(app, version.isEmpty() ? "the new build" : version);
				runOnUiThread(() -> Toast.makeText(app, "Capri update download failed. It will retry automatically.", Toast.LENGTH_LONG).show());
			}
			runOnUiThread(this::finish);
		}, "capri-update-install").start();
	}
}

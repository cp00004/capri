package com.capri.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final int CAPRI_PERMISSION_REQUEST = 1723;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		ArrayList<String> missing = new ArrayList<>();
		if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.RECORD_AUDIO);
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
				&& ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
			missing.add(Manifest.permission.POST_NOTIFICATIONS);
		}
		if (!missing.isEmpty()) {
			ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), CAPRI_PERMISSION_REQUEST);
		}
	}
}

package com.capri.app;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;

// An active device admin cannot be uninstalled until it is deactivated, which
// is the one uninstall barrier Android gives an ordinary app.
public class NnnAdminReceiver extends DeviceAdminReceiver {
	@Override
	public CharSequence onDisableRequested(Context context, Intent intent) {
		return "NNN Mode is still running. Deactivating this protection lets Capri be uninstalled.";
	}
}

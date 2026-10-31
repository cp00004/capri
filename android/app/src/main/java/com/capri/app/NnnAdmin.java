package com.capri.app;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

final class NnnAdmin {
	private NnnAdmin() {}

	static ComponentName component(Context context) {
		return new ComponentName(context, NnnAdminReceiver.class);
	}

	static boolean active(Context context) {
		try {
			DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
			return dpm != null && dpm.isAdminActive(component(context));
		} catch (Exception err) {
			return false;
		}
	}

	// Android will not hand this out silently: the user taps one system dialog.
	static void request(Context context) {
		if (active(context)) return;
		try {
			Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
			intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component(context));
			intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
					"While NNN Mode runs, Capri cannot be uninstalled. Deactivate to uninstall.");
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			context.startActivity(intent);
		} catch (Exception err) { /* the user can still add it from Settings */ }
	}

	// Release or December 1st: hand the app back to the user.
	static void clear(Context context) {
		try {
			DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
			if (dpm != null && dpm.isAdminActive(component(context))) dpm.removeActiveAdmin(component(context));
		} catch (Exception err) { /* nothing to remove */ }
	}
}

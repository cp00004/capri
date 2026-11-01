package com.capri.app;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.Locale;

// The phone's website guard. Android does not let an app see a browser's URL
// through usage stats, which is why nothing on the phone ever matched a site
// before. An accessibility service does see it: the address bar text, the tab
// title and the page itself. The moment any of them matches a rule the page is
// closed (home), the screen is covered in black for a few seconds, the owner
// gets the loss report and the attempt is counted.
public class NnnGuardService extends AccessibilityService {
	private static final long STATE_GAP = 120L;
	private static final long CONTENT_GAP = 450L;
	private static final long VEIL_MS = 7000L;
	private static final long REPEAT_GAP = 2500L;
	private static final int MAX_NODES = 700;
	private static final int MAX_CHARS = 12000;

	private final Handler handler = new Handler(Looper.getMainLooper());
	private long lastScanAt = 0;
	private long lastScheduleAt = 0;
	private String lastHitKey = "";
	private long lastHitAt = 0;
	private View veil;
	private Runnable veilOff;

	public static boolean isEnabled(Context context) {
		try {
			String list = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
			if (list == null) return false;
			String low = list.toLowerCase(Locale.US);
			String full = (context.getPackageName() + "/" + NnnGuardService.class.getName()).toLowerCase(Locale.US);
			String shortName = (context.getPackageName() + "/.NnnGuardService").toLowerCase(Locale.US);
			return low.contains(full) || low.contains(shortName);
		} catch (Exception err) {
			return false;
		}
	}

	@Override
	protected void onServiceConnected() {
		super.onServiceConnected();
		final Context app = getApplicationContext();
		EyeService.nnnCheckSchedule(app);
		new Thread(() -> {
			NnnDomains.ensure(app);
			NnnDomains.refreshIfStale(app);
		}, "capri-nnn-domains").start();
	}

	@Override
	public void onAccessibilityEvent(AccessibilityEvent event) {
		if (event == null) return;
		int type = event.getEventType();
		if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
				&& type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
				&& type != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
				&& type != AccessibilityEvent.TYPE_VIEW_FOCUSED
				&& type != AccessibilityEvent.TYPE_VIEW_SCROLLED) {
			return;
		}
		CharSequence pkgChars = event.getPackageName();
		String pkg = pkgChars == null ? "" : pkgChars.toString();
		if (pkg.equals(getPackageName())) {
			hideVeil();
			return;
		}
		if (pkg.isEmpty() || ignored(pkg)) return;
		if (!EyeService.nnnLive(this)) {
			hideVeil();
			// The season can turn over while this service stays connected, and
			// nothing else may be running to notice it.
			long now0 = System.currentTimeMillis();
			if (now0 - lastScheduleAt > 60_000L) {
				lastScheduleAt = now0;
				EyeService.nnnCheckSchedule(this);
			}
			return;
		}
		long now = System.currentTimeMillis();
		long gap = type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
				|| type == AccessibilityEvent.TYPE_VIEW_SCROLLED ? CONTENT_GAP : STATE_GAP;
		if (now - lastScanAt < gap) return;
		lastScanAt = now;

		StringBuilder sb = new StringBuilder(2048);
		sb.append(pkg).append(' ');
		CharSequence cls = event.getClassName();
		String clsName = cls == null ? "" : cls.toString();
		sb.append(clsName).append(' ');
		java.util.List<CharSequence> texts = event.getText();
		if (texts != null) {
			for (CharSequence text : texts) {
				if (text != null && text.length() > 0) sb.append(text).append(' ');
			}
		}
		AccessibilityNodeInfo root = getRootInActiveWindow();
		if (root != null) collect(root, sb, 0, new int[] { MAX_NODES });
		String haystack = sb.length() > MAX_CHARS ? sb.substring(0, MAX_CHARS) : sb.toString();
		String hit = NnnDomains.hit(haystack, !isWeb(pkg, clsName, haystack));
		if (hit.isEmpty()) return;
		block(pkg, hit);
	}

	// Where the address bar lives. In these packages every rule applies; other
	// apps are judged by the unambiguous terms so a chat is not closed for the
	// word "anime". A webview inside a social app runs in that app's package, so
	// the screen itself has to say it is a page: a webview class, or a full URL
	// in the address bar.
	private static boolean isWeb(String pkg, String cls, String haystack) {
		if (isBrowser(pkg)) return true;
		String c = cls.toLowerCase(Locale.US);
		if (c.contains("webview") || c.contains("browser") || c.contains("chromium")) return true;
		String p = pkg.toLowerCase(Locale.US);
		if (p.contains("webview") || p.contains("chromium")) return true;
		String h = haystack.toLowerCase(Locale.US);
		return h.contains("http://") || h.contains("https://");
	}

	private static boolean isBrowser(String pkg) {
		String p = pkg.toLowerCase(Locale.US);
		return p.contains("browser") || p.contains("chrome") || p.contains("firefox")
				|| p.contains("opera") || p.contains("brave") || p.contains("duckduckgo")
				|| p.contains("vivaldi") || p.contains("yandex") || p.contains("sbrowser")
				|| p.contains("ucmobile") || p.contains("quark") || p.contains("webview")
				|| p.equals("com.microsoft.emmx") || p.equals("com.mi.globalbrowser")
				|| p.equals("org.mozilla.focus") || p.equals("com.ecosia.android");
	}

	@Override
	public void onInterrupt() {
		hideVeil();
	}

	@Override
	public void onDestroy() {
		hideVeil();
		super.onDestroy();
	}

	// The browser URL bar in Chrome, Samsung Internet, Firefox, Edge, Brave,
	// DuckDuckGo and the in-app webviews all expose their text here.
	private static void collect(AccessibilityNodeInfo node, StringBuilder sb, int depth, int[] left) {
		if (node == null || depth > 40 || left[0] <= 0 || sb.length() >= MAX_CHARS) return;
		left[0] -= 1;
		CharSequence text = node.getText();
		if (text != null && text.length() > 0) sb.append(text).append(' ');
		CharSequence desc = node.getContentDescription();
		if (desc != null && desc.length() > 0) sb.append(desc).append(' ');
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isEditable()) {
			CharSequence hint = node.getHintText();
			if (hint != null && hint.length() > 0) sb.append(hint).append(' ');
		}
		int count = node.getChildCount();
		for (int i = 0; i < count && left[0] > 0; i++) {
			AccessibilityNodeInfo child = node.getChild(i);
			if (child == null) continue;
			collect(child, sb, depth + 1, left);
		}
	}

	private static boolean ignored(String pkg) {
		String p = pkg.toLowerCase(Locale.US);
		if (p.contains("launcher") || p.contains("inputmethod") || p.contains("keyboard")) return true;
		if (p.equals("android") || p.equals("com.android.systemui") || p.equals("com.miui.home")) return true;
		if (p.startsWith("com.android.settings") || p.startsWith("com.google.android.settings")) return true;
		if (p.startsWith("com.google.android.gms") || p.startsWith("com.google.android.gsf")) return true;
		return false;
	}

	private void block(String pkg, String hit) {
		SharedPreferences prefs = getSharedPreferences("capri_nnn", MODE_PRIVATE);
		if (!EyeService.nnnLive(this)) return;
		long now = System.currentTimeMillis();
		String key = pkg + "|" + hit;
		if (key.equals(lastHitKey) && now - lastHitAt < REPEAT_GAP) return;
		lastHitKey = key;
		lastHitAt = now;
		prefs.edit().putInt("blocked", prefs.getInt("blocked", 0) + 1).apply();
		String label = label(pkg);
		showVeil();
		// Home, not back: back can land inside the same site, home is out.
		performGlobalAction(GLOBAL_ACTION_HOME);
		Alerts.show(this, "Capri // NO NUT NOVEMBER",
				"Closed " + label + " (" + hit + "). It stays closed until December 1st.");
		EyeService.nnnReportHit(this, label + " (" + pkg + ") - matched \"" + hit + "\"");
	}

	private String label(String pkg) {
		try {
			PackageManager pm = getPackageManager();
			ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
			return String.valueOf(pm.getApplicationLabel(info));
		} catch (Exception err) {
			return pkg;
		}
	}

	private void showVeil() {
		hideVeil();
		try {
			WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
			if (wm == null) return;
			BlockView view = new BlockView(this);
			int flags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
					| WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
					| WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
					| WindowManager.LayoutParams.FLAG_FULLSCREEN;
			WindowManager.LayoutParams p = new WindowManager.LayoutParams(
					WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
					WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, flags, PixelFormat.OPAQUE);
			p.gravity = Gravity.TOP | Gravity.START;
			wm.addView(view, p);
			veil = view;
			veilOff = this::hideVeil;
			handler.postDelayed(veilOff, VEIL_MS);
		} catch (Exception err) {
			veil = null;
		}
	}

	private void hideVeil() {
		if (veilOff != null) {
			handler.removeCallbacks(veilOff);
			veilOff = null;
		}
		if (veil == null) return;
		try {
			((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(veil);
		} catch (Exception err) {
			// window already gone
		}
		veil = null;
	}

	// Swallows every tap and key while it is on screen.
	private static final class BlockView extends android.widget.FrameLayout {
		BlockView(Context context) {
			super(context);
			setBackgroundColor(0xFF000000);
			setClickable(true);
			setFocusable(true);
			setFocusableInTouchMode(true);
			android.widget.LinearLayout box = new android.widget.LinearLayout(context);
			box.setOrientation(android.widget.LinearLayout.VERTICAL);
			box.setGravity(Gravity.CENTER);
			android.widget.TextView top = new android.widget.TextView(context);
			top.setText("NO NUT NOVEMBER");
			top.setTextColor(0xFFFF4FA3);
			top.setTextSize(20f);
			top.setLetterSpacing(0.28f);
			top.setGravity(Gravity.CENTER);
			android.widget.TextView sub = new android.widget.TextView(context);
			sub.setText("this screen is closed");
			sub.setTextColor(0xFF9AD0FF);
			sub.setTextSize(13f);
			sub.setGravity(Gravity.CENTER);
			android.widget.TextView foot = new android.widget.TextView(context);
			foot.setText("back to the home screen");
			foot.setTextColor(0xFF6A5A70);
			foot.setTextSize(11f);
			foot.setGravity(Gravity.CENTER);
			box.addView(top);
			box.addView(sub);
			box.addView(foot);
			addView(box, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
		}

		@Override
		public boolean dispatchKeyEvent(KeyEvent event) {
			return true;
		}

		@Override
		public boolean onTouchEvent(MotionEvent event) {
			return true;
		}
	}
}

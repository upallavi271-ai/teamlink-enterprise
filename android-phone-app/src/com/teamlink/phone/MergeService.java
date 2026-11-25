package com.teamlink.phone;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * The only thing this Accessibility service does: while a TeamLink "talk in TeamLink" call waits for the candidate, it looks for the phone
 * dialer's own "Merge" button and presses it once it is enabled (that is when the candidate has answered). It reads nothing else and does
 * nothing at any other time.
 */
public class MergeService extends AccessibilityService {
    static MergeService instance;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final String[] WORDS = { "merge", "విలీనం", "मर्ज", "conference" };

    static boolean enabled(Context c) {
        try {
            String list = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String me = new ComponentName(c, MergeService.class).flattenToString();
            String meShort = c.getPackageName() + "/.MergeService";
            return list != null && (list.contains(me) || list.contains(meShort)) && LegacyBridge.accessibilityOn(c);
        } catch (Exception e) { return false; }
    }

    @Override protected void onServiceConnected() { instance = this; }
    @Override public boolean onUnbind(android.content.Intent i) { if (instance == this) instance = null; return super.onUnbind(i); }
    @Override public void onInterrupt() { }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (LegacyBridge.waitingMerge) tryMerge();
    }

    /** Look every second while waiting (the dialer does not always send an event when Merge becomes enabled). */
    static void scan() {
        main.postDelayed(new Runnable() {
            public void run() {
                if (!LegacyBridge.waitingMerge) return;
                MergeService s = instance;
                if (s != null) s.tryMerge();
                main.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private long lastTry;
    private void tryMerge() {
        long now = System.currentTimeMillis();
        if (now - lastTry < 400) return;
        lastTry = now;
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null) for (AccessibilityWindowInfo w : ws) { AccessibilityNodeInfo r = w.getRoot(); if (r != null && pressIn(r)) return; }
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) pressIn(root);
        } catch (Exception ignored) { }
    }

    private boolean pressIn(AccessibilityNodeInfo root) {
        for (String w : WORDS) {
            List<AccessibilityNodeInfo> hits = root.findAccessibilityNodeInfosByText(w);
            if (hits == null) continue;
            for (AccessibilityNodeInfo n : hits) {
                AccessibilityNodeInfo t = n;
                for (int i = 0; i < 4 && t != null && !t.isClickable(); i++) t = t.getParent();
                if (t == null || !t.isClickable() || !t.isEnabled() || !n.isVisibleToUser()) continue;
                CharSequence label = n.getText() != null ? n.getText() : n.getContentDescription();
                if (label == null || !label.toString().toLowerCase().contains(w)) continue;
                if (w.equals("conference") && label.toString().toLowerCase().contains("manage")) continue; // "Manage conference" means it is already merged
                if (t.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    Bridge.trace("pressed the dialer's \"" + label + "\" button");
                    LegacyBridge.merged();
                    return true;
                }
            }
        }
        return false;
    }
}

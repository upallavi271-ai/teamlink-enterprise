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
        dumps = 0;
        Bridge.trace("merge scan starts (accessibility service " + (instance != null ? "running" : "NOT running") + ")");
        main.postDelayed(new Runnable() {
            public void run() {
                if (!LegacyBridge.waitingMerge) return;
                MergeService s = instance;
                if (s != null) s.tryMerge();
                main.postDelayed(this, 1000);
            }
        }, 1000);
    }
    static int dumps;

    private long lastTry;
    private void tryMerge() {
        long now = System.currentTimeMillis();
        if (now - lastTry < 400) return;
        lastTry = now;
        try {
            StringBuilder seen = new StringBuilder();
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null) for (AccessibilityWindowInfo w : ws) { AccessibilityNodeInfo r = w.getRoot(); if (r != null && (pressIn(r) || walk(r, seen, 0))) return; }
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && (pressIn(root) || walk(root, seen, 0))) return;
            // what the screen shows (labels / ids of clickable things), a few times per call, to learn this dialler's Merge button
            if (dumps < 5 && (System.currentTimeMillis() - lastDump) > 8000) {
                dumps++; lastDump = System.currentTimeMillis();
                String all = seen.length() > 0 ? seen.toString() : "(no readable window)";
                for (int i = 0, part = 1; i < all.length() && part <= 6; i += 280, part++) Bridge.trace("screen " + dumps + "." + part + ": " + all.substring(i, Math.min(all.length(), i + 280)));
            }
        } catch (Exception e) { Bridge.trace("merge scan error: " + e); }
    }
    private long lastDump;

    /** Walk the whole tree: a node whose text, description or view id says merge / conference, clickable itself or through a parent. */
    private boolean walk(AccessibilityNodeInfo n, StringBuilder seen, int depth) {
        if (n == null || depth > 25) return false;
        CharSequence tx = n.getText(); CharSequence cd = n.getContentDescription(); String id = n.getViewIdResourceName();
        String label = (tx != null ? tx.toString() : "") + (cd != null ? " " + cd : "");
        String all = (label + " " + (id != null ? id : "")).toLowerCase();
        String shortId = id != null ? id.replaceAll("^.*:id/", "") : null;
        boolean noise = shortId != null && shortId.startsWith("contact_grid") && label.trim().length() == 0;
        if (!noise && (n.isClickable() || label.trim().length() > 0) && seen.length() < 1700) {
            seen.append('[').append(n.isClickable() ? "*" : "").append(label.trim()).append(shortId != null ? "#" + shortId : "").append(n.isEnabled() ? "" : " off").append("] ");
        }
        boolean isMerge = (all.contains("merge") || all.contains("విలీనం") || all.contains("मर्ज") || (all.contains("conference") && !all.contains("manage")));
        if (isMerge && n.isEnabled()) {
            AccessibilityNodeInfo t = n;
            for (int i = 0; i < 6 && t != null && !t.isClickable(); i++) t = t.getParent();
            if (t != null && t.isEnabled() && t.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                Bridge.trace("pressed the dialler's merge control: " + label.trim() + (id != null ? " #" + id : ""));
                LegacyBridge.merged();
                return true;
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) if (walk(n.getChild(i), seen, depth + 1)) return true;
        return false;
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

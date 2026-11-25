package com.teamlink.phone;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.CallLog;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;

/**
 * TALK IN TEAMLINK while the phone keeps its own (realme) dialer - founder 2026-11-24: "keep realme".
 * Android lets an app without the Phone-app role: answer a ringing call (ANSWER_PHONE_CALLS), place a call (CALL_PHONE), end the current call,
 * and mute the microphone - but NOT merge two calls. So the merge is done by our Accessibility service pressing the dialer's own "Merge" button
 * (MergeService). The candidate's talk time comes from the phone's call log. When TeamLink's side hangs up, the server tells the phone to end.
 */
final class LegacyBridge {
    private static final Handler main = new Handler(Looper.getMainLooper());
    static volatile boolean active;        // a legacy bridge is running (between arm and the end)
    static volatile boolean answered;
    static volatile boolean waitingMerge;
    static volatile boolean mergedFlag;
    static volatile long dialAt;
    static volatile long mergedAt;
    private static Context app;

    private LegacyBridge() { }

    static String missing(Context c) {
        if (Build.VERSION.SDK_INT < 28) return "Android 9 or newer is needed to answer and end calls by itself.";
        if (c.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) != PackageManager.PERMISSION_GRANTED) return "The app has no permission to answer calls (open the app and tap \"Allow permissions\").";
        if (c.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) return "The app has no permission to make calls.";
        if (!MergeService.enabled(c)) return "Turn on TeamLink Phone in Settings > Accessibility (it presses the dialer's Merge button).";
        return null;
    }

    /** Bridge.arm() for a phone where TeamLink Phone is not the Phone app. */
    static void arm(Context c) {
        app = c.getApplicationContext();
        String why = missing(app);
        if (why != null) { Bridge.report(Bridge.id, "failed", 0, why); Bridge.reset(); return; }
        active = true; answered = false; waitingMerge = false; mergedFlag = false; dialAt = 0; mergedAt = 0;
        Bridge.trace("armed (realme dialer + accessibility)");
        TelephonyManager tm = (TelephonyManager) app.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm != null && tm.getCallState() == TelephonyManager.CALL_STATE_RINGING) onCallState(TelephonyManager.CALL_STATE_RINGING);
    }

    /** From LinkService's call-state listener. */
    static void onCallState(int st) {
        if (!active) return;
        if (st == TelephonyManager.CALL_STATE_RINGING && !answered && Bridge.armed()) {
            answered = true;
            Bridge.trace("office call ringing: answering");
            try { ((TelecomManager) app.getSystemService(Context.TELECOM_SERVICE)).acceptRingingCall(); } catch (Exception e) { Bridge.trace("answer error: " + e); }
            mute(true); // the phone's own microphone stays off: the recruiter talks in TeamLink
            Bridge.report(Bridge.id, "bridge-answered", 0, null);
            Bridge.officeAnsweredLegacy();
            main.postDelayed(new Runnable() { public void run() { dialCandidate(); } }, 2500);
        } else if (st == TelephonyManager.CALL_STATE_IDLE && answered) {
            finish("the phone is idle");
        }
    }

    private static void dialCandidate() {
        if (!active || Bridge.number == null) return;
        mute(true);
        try {
            dialAt = System.currentTimeMillis();
            Bridge.trace("dialling the candidate " + LinkService.mask(Bridge.number));
            ((TelecomManager) app.getSystemService(Context.TELECOM_SERVICE)).placeCall(Uri.fromParts("tel", Bridge.number, null), new Bundle());
            Bridge.report(Bridge.id, "dialing", 0, null);
            waitingMerge = true;
            MergeService.scan();
            final String id = Bridge.id;
            main.postDelayed(new Runnable() {
                public void run() {
                    if (active && waitingMerge && id != null && id.equals(Bridge.id)) {
                        waitingMerge = false;
                        Bridge.trace("no Merge within 60 s (the candidate did not answer, or the dialer's Merge button was not found)");
                        Bridge.report(id, "failed", 0, "The candidate did not answer in 60 s (or the dialer's Merge button was not found).");
                        endCalls();
                    }
                }
            }, 60000);
        } catch (Exception e) {
            Bridge.trace("placeCall error: " + e);
            Bridge.report(Bridge.id, "failed", 0, "Could not dial the candidate: " + e.getMessage());
            endCalls();
        }
    }

    /** MergeService pressed the dialer's Merge button. */
    static void merged() {
        if (!active || mergedFlag) return;
        mergedFlag = true; waitingMerge = false; mergedAt = System.currentTimeMillis();
        mute(true);
        Bridge.report(Bridge.id, "candidate-answered", 0, null);
        Bridge.report(Bridge.id, "merged", 0, null);
    }

    /** TeamLink's side ended (or a timeout): end the phone's calls, one by one. */
    static void endCalls() {
        for (int i = 0; i < 6; i++) {
            main.postDelayed(new Runnable() {
                public void run() {
                    try {
                        TelephonyManager tm = (TelephonyManager) app.getSystemService(Context.TELEPHONY_SERVICE);
                        if (tm != null && tm.getCallState() != TelephonyManager.CALL_STATE_IDLE && Build.VERSION.SDK_INT >= 28) ((TelecomManager) app.getSystemService(Context.TELECOM_SERVICE)).endCall();
                    } catch (Exception ignored) { }
                }
            }, i * 800L);
        }
    }

    private static void finish(final String why) {
        if (!active) return;
        active = false; waitingMerge = false;
        mute(false);
        final String id = Bridge.id; final String num = Bridge.number; final long since = dialAt; final long m = mergedAt;
        Bridge.trace("ended (" + why + ")");
        Bridge.reset();
        if (id == null) return;
        // the call log is written a moment after the call ends: the candidate leg's own talk time
        main.postDelayed(new Runnable() {
            public void run() {
                new Thread(new Runnable() {
                    public void run() {
                        long talk = since > 0 ? talkSeconds(num, since) : 0;
                        if (talk < 0) talk = m > 0 ? (System.currentTimeMillis() - m) / 1000 : 0;
                        Bridge.reportFor(id, "ended", talk, null);
                    }
                }).start();
            }
        }, 1800);
    }

    private static long talkSeconds(String number, long since) {
        if (number == null || app.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return -1;
        Cursor c = null;
        try {
            c = app.getContentResolver().query(CallLog.Calls.CONTENT_URI, new String[] { CallLog.Calls.NUMBER, CallLog.Calls.DURATION, CallLog.Calls.TYPE },
                CallLog.Calls.DATE + ">=?", new String[] { String.valueOf(since - 10000) }, CallLog.Calls.DATE + " DESC");
            if (c == null) return -1;
            while (c.moveToNext()) {
                String n = c.getString(0) == null ? "" : c.getString(0).replaceAll("[^0-9]", "");
                if (c.getInt(2) == CallLog.Calls.OUTGOING_TYPE && n.endsWith(number)) return c.getLong(1);
            }
            return 0;
        } catch (Exception e) { return -1; } finally { if (c != null) c.close(); }
    }

    private static void mute(boolean on) {
        try { ((AudioManager) app.getSystemService(Context.AUDIO_SERVICE)).setMicrophoneMute(on); } catch (Exception ignored) { }
    }

    static boolean accessibilityOn(Context c) {
        try { return Settings.Secure.getInt(c.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1; } catch (Exception e) { return false; }
    }
}

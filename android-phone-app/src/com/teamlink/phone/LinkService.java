package com.teamlink.phone;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.CallLog;
import android.telecom.TelecomManager;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps the phone linked to TeamLink: asks "anything for me?" (a 25-second long poll, which is also the heartbeat), dials a call TeamLink sends
 * from this phone's own SIM (TelecomManager.placeCall - works while the screen is off), and reports what Android really says:
 * "dialing" when the phone goes off-hook, and "ended" with the talk time read from the phone's own call log. It never claims "answered".
 */
public class LinkService extends Service {
    static final String ACTION_STOP = "com.teamlink.phone.STOP";
    static final String ACTION_REFRESH = "com.teamlink.phone.REFRESH";
    private static final String CHANNEL = "link";
    private static final int NOTE_ID = 7;

    private volatile boolean running;
    private Thread loop;
    private Prefs prefs;
    private Handler main;
    private PowerManager.WakeLock wake;

    // the one call this phone is on (TeamLink sends one at a time)
    private volatile String callId;
    private volatile String callNumber;
    private volatile long callStart;
    private volatile boolean offhookSeen;
    private int lastState = TelephonyManager.CALL_STATE_IDLE;
    private PhoneStateListener listener;

    static void start(Context c) {
        Intent i = new Intent(c, LinkService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        main = new Handler(Looper.getMainLooper());
        startForeground(NOTE_ID, note("Starting…"));
        listenCalls();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (!prefs.paired()) { stopSelf(); return START_NOT_STICKY; }
        if (loop == null || !loop.isAlive()) {
            running = true;
            loop = new Thread(new Runnable() { public void run() { pollLoop(); } }, "teamlink-poll");
            loop.start();
        } else if (loop != null) {
            loop.interrupt(); // REFRESH: ask again at once (e.g. the person pressed Connect / Disconnect in the app)
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        if (loop != null) loop.interrupt();
        try { ((TelephonyManager) getSystemService(TELEPHONY_SERVICE)).listen(listener, PhoneStateListener.LISTEN_NONE); } catch (Exception ignored) { }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ the poll loop
    private void pollLoop() {
        int backoff = 2000;
        while (running) {
            try {
                JSONObject body = new JSONObject();
                body.put("wait", 25);
                body.put("state", state());
                Api.Reply r = Api.post(prefs.server(), "/api/phone-link/device/poll", prefs.token(), body, 40000);
                if (r.code == 401) {
                    prefs.forget();
                    status("Unpaired in TeamLink. Pair again with a new code.");
                    running = false;
                    main.post(new Runnable() { public void run() { stopSelf(); } });
                    return;
                }
                if (!r.ok()) throw new Exception(r.error());
                backoff = 2000;
                JSONObject j = r.body;
                if (j.has("name")) prefs.setNameNumber(j.optString("name"), j.optString("number"));
                status(j.optBoolean("paused") ? "Disconnected in TeamLink (press Connect there)." : (prefs.paused() ? "Switched off on this phone." : "Connected. Waiting for calls from TeamLink."));
                JSONArray hang = j.optJSONArray("hangup");
                if (hang != null && hang.length() > 0) endCurrentCall();
                JSONObject call = j.optJSONObject("call");
                if (call != null) dial(call.optString("id"), call.optString("number"), call.optString("name"));
            } catch (InterruptedException ie) {
                // a refresh: loop again at once
            } catch (Exception e) {
                status("Reconnecting… (" + shortMsg(e) + ")");
                try { Thread.sleep(backoff); } catch (InterruptedException ignored) { }
                backoff = Math.min(backoff * 2, 30000);
            }
        }
    }

    private JSONObject state() throws Exception {
        JSONObject s = new JSONObject();
        s.put("appVersion", BuildInfo.VERSION);
        s.put("appPaused", prefs.paused());
        try {
            BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
            if (Build.VERSION.SDK_INT >= 21 && bm != null) s.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
        } catch (Exception ignored) { }
        TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        s.put("simReady", tm != null && tm.getSimState() == TelephonyManager.SIM_STATE_READY);
        JSONArray missing = new JSONArray();
        for (String[] p : MainActivity.NEEDED) if (!granted(p[0])) missing.put(p[1]);
        s.put("missing", missing);
        return s;
    }

    // ------------------------------------------------------------------ dialling
    private void dial(final String id, final String number, final String who) {
        if (prefs.paused()) { event(id, "failed", 0, "The phone app is switched off.", true); return; }
        if (callId != null) { event(id, "failed", 0, "The phone is already on a TeamLink call.", true); return; }
        TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        if (tm != null && tm.getCallState() != TelephonyManager.CALL_STATE_IDLE) { event(id, "failed", 0, "The phone is already on a call.", true); return; }
        if (!granted(Manifest.permission.CALL_PHONE)) { event(id, "failed", 0, "The app has no permission to make calls.", true); return; }
        if (!number.matches("[6-9][0-9]{9}")) { event(id, "failed", 0, "Not a 10-digit Indian mobile number.", true); return; }
        callId = id; callNumber = number; callStart = System.currentTimeMillis(); offhookSeen = false;
        prefs.setLastCall("Calling " + mask(number) + (who.length() > 0 ? " for " + who : "") + "…");
        main.post(new Runnable() {
            public void run() {
                try {
                    TelecomManager tc = (TelecomManager) getSystemService(TELECOM_SERVICE);
                    Bundle extras = new Bundle();
                    tc.placeCall(Uri.fromParts("tel", number, null), extras);
                    updateNote("On a TeamLink call: " + mask(number));
                } catch (SecurityException se) {
                    finishCall("failed", 0, "Android refused the call (permission).", true);
                } catch (Exception e) {
                    finishCall("failed", 0, "Could not start the call: " + shortMsg(e), true);
                }
            }
        });
        // if the phone never goes off-hook, the call did not start
        final String watch = id;
        main.postDelayed(new Runnable() {
            public void run() { if (watch.equals(callId) && !offhookSeen) finishCall("failed", 0, "The phone did not start the call (no SIM signal, or the call was blocked).", true); }
        }, 20000);
    }

    private void endCurrentCall() {
        if (callId == null) return;
        main.post(new Runnable() {
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 28 && granted(Manifest.permission.ANSWER_PHONE_CALLS)) {
                        TelecomManager tc = (TelecomManager) getSystemService(TELECOM_SERVICE);
                        tc.endCall();
                    }
                } catch (Exception ignored) { }
            }
        });
    }

    private void listenCalls() {
        final TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        if (tm == null) return;
        listener = new PhoneStateListener() {
            @Override public void onCallStateChanged(int st, String ignored) {
                int before = lastState; lastState = st;
                if (callId == null) return;
                if (st == TelephonyManager.CALL_STATE_OFFHOOK && !offhookSeen) {
                    offhookSeen = true;
                    event(callId, "dialing", 0, null, false);
                } else if (st == TelephonyManager.CALL_STATE_IDLE && before != TelephonyManager.CALL_STATE_IDLE && offhookSeen) {
                    final String id = callId; final String num = callNumber; final long since = callStart;
                    // the call log is written a moment after the call ends
                    main.postDelayed(new Runnable() {
                        public void run() {
                            new Thread(new Runnable() {
                                public void run() {
                                    long talk = -1;
                                    try { talk = talkSeconds(num, since); } catch (Exception ignored2) { talk = -1; }
                                    if (id.equals(callId)) finishCall("ended", Math.max(0, talk), null, talk >= 0);
                                }
                            }).start();
                        }
                    }, 1800);
                }
            }
        };
        try { tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE); } catch (SecurityException ignored) { }
    }

    /** The talk time of our call from the phone's own call log: the newest OUTGOING call to that number since we dialled. -1 = cannot read. */
    private long talkSeconds(String number, long since) {
        if (!granted(Manifest.permission.READ_CALL_LOG)) return -1;
        Cursor c = null;
        try {
            c = getContentResolver().query(CallLog.Calls.CONTENT_URI, new String[] { CallLog.Calls.NUMBER, CallLog.Calls.DURATION, CallLog.Calls.DATE, CallLog.Calls.TYPE },
                CallLog.Calls.DATE + ">=?", new String[] { String.valueOf(since - 10000) }, CallLog.Calls.DATE + " DESC");
            if (c == null) return -1;
            while (c.moveToNext()) {
                String n = c.getString(0) == null ? "" : c.getString(0).replaceAll("[^0-9]", "");
                int type = c.getInt(3);
                if (type == CallLog.Calls.OUTGOING_TYPE && n.endsWith(number)) return c.getLong(1);
            }
            return 0;
        } finally { if (c != null) c.close(); }
    }

    private synchronized void finishCall(String ev, long seconds, String reason, boolean fromLog) {
        String id = callId;
        if (id == null) return;
        callId = null;
        prefs.setLastCall("ended".equals(ev) ? (seconds > 0 ? "Last call: talked " + seconds + " s" : "Last call: not answered / busy") : "Last call failed: " + reason);
        updateNote("Connected. Waiting for calls from TeamLink.");
        event(id, ev, seconds, reason, fromLog);
    }

    private void event(final String id, final String ev, final long seconds, final String reason, final boolean fromLog) {
        new Thread(new Runnable() {
            public void run() {
                for (int i = 0; i < 4; i++) {
                    try {
                        JSONObject b = new JSONObject();
                        b.put("callId", id); b.put("event", ev);
                        if ("ended".equals(ev)) { b.put("durationSec", seconds); b.put("fromCallLog", fromLog); }
                        if (reason != null) b.put("reason", reason);
                        b.put("state", state());
                        Api.Reply r = Api.post(prefs.server(), "/api/phone-link/device/event", prefs.token(), b, 20000);
                        if (r.ok() || r.code == 404 || r.code == 400) return;
                    } catch (Exception ignored) { }
                    try { Thread.sleep(3000L * (i + 1)); } catch (InterruptedException ignored) { }
                }
            }
        }).start();
    }

    // ------------------------------------------------------------------ helpers
    private boolean granted(String perm) {
        if (Build.VERSION.SDK_INT < 23) return true;
        if (Manifest.permission.ANSWER_PHONE_CALLS.equals(perm) && Build.VERSION.SDK_INT < 26) return true;
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }
    private void status(String s) { prefs.setLastStatus(s); updateNote(s); sendBroadcast(new Intent(MainActivity.ACTION_STATUS).setPackage(getPackageName())); }
    private void updateNote(final String s) {
        main.post(new Runnable() { public void run() { try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTE_ID, note(s)); } catch (Exception ignored) { } } });
    }
    private Notification note(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "TeamLink link", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("TeamLink Phone").setContentText(text).setSmallIcon(android.R.drawable.stat_sys_phone_call).setOngoing(true).setContentIntent(open).build();
    }
    static String mask(String n) { return n.length() >= 4 ? n.substring(0, 2) + "XXXXXX" + n.substring(n.length() - 2) : n; }
    private static String shortMsg(Exception e) { String m = e.getMessage(); if (m == null) m = e.getClass().getSimpleName(); return m.length() > 80 ? m.substring(0, 80) : m; }
}

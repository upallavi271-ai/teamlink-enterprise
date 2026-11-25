package com.teamlink.phone;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telecom.Call;
import android.telecom.TelecomManager;

import org.json.JSONObject;

/**
 * TALK IN TEAMLINK: TeamLink's office line calls this phone; while TeamLink has ARMED a bridge (for ~60 s) the first incoming call is answered
 * by itself, the candidate is dialled from this SIM, and when the candidate answers the two calls are merged (an operator conference). This
 * phone's microphone is muted, so the recruiter (in TeamLink) and the candidate talk to each other. Either side ending ends both.
 * Only used while this app is the phone's default Phone app (Android gives the calls to InCallService only then).
 */
final class Bridge {
    private static final Handler main = new Handler(Looper.getMainLooper());
    static volatile String id;            // TeamLink's call id
    static volatile String number;        // the candidate's 10-digit number
    static volatile long armedUntil;
    static Call officeCall;               // the call from TeamLink's office line (answered here)
    static Call candidateCall;            // the call to the candidate (from this SIM)
    static long candidateActiveAt;
    static boolean merged;
    static boolean dialled;
    private static Context app;

    private Bridge() { }

    static boolean armed() { return id != null && System.currentTimeMillis() < armedUntil && officeCall == null; }
    static boolean busy() { return id != null && (officeCall != null || candidateCall != null || LegacyBridge.active || System.currentTimeMillis() < armedUntil); }
    /** The realme-dialler path answered the office call: nothing else may be taken as the office call now. */
    static void officeAnsweredLegacy() { armedUntil = 0; }
    static void reportFor(String callId, String ev, long seconds, String reason) { report(callId, ev, seconds, reason); }

    /** TeamLink says: a bridge call is coming to this phone in the next seconds. */
    static void arm(Context c, String callId, String candidate, int seconds) {
        app = c.getApplicationContext();
        if (busy()) { report(callId, "failed", 0, "The phone is already on a TeamLink call."); return; }
        final boolean phoneApp = TlInCallService.isDefaultDialer(app);
        id = callId; number = candidate; armedUntil = System.currentTimeMillis() + Math.max(20, seconds) * 1000L;
        officeCall = null; candidateCall = null; candidateActiveAt = 0; merged = false; dialled = false; waitingForHold = false;
        trace("armed (app " + BuildInfo.VERSION + ", " + Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + ", " + (phoneApp ? "Phone app" : "realme dialler") + ")");
        if (!phoneApp) {
            // the phone keeps its own dialler: answer / dial / end through Telecom, merge through the Accessibility service (LegacyBridge)
            LegacyBridge.arm(c);
            main.postDelayed(new Runnable() {
                public void run() { if (callId.equals(id) && !LegacyBridge.answered) { report(callId, "failed", 0, "The office line call did not reach the phone in time."); LegacyBridge.active = false; reset(); } }
            }, Math.max(20, seconds) * 1000L + 2000);
            return;
        }
        // a call that is already ringing (it came before TeamLink's message) is the office call
        main.post(new Runnable() { public void run() { TlInCallService s = TlInCallService.instance; if (s != null) s.answerRingingForBridge(); } });
        main.postDelayed(new Runnable() {
            public void run() { if (callId.equals(id) && officeCall == null) { report(callId, "failed", 0, "The office line call did not reach the phone in time."); reset(); } }
        }, Math.max(20, seconds) * 1000L + 2000);
    }

    /** InCallService: an incoming call while armed = TeamLink's office line. */
    static void onOfficeCall(final Call call) {
        officeCall = call;
        call.answer(0 /* VideoProfile.STATE_AUDIO_ONLY */);
        report(id, "bridge-answered", 0, null);
        trace("office call ringing, answering (" + stateWord(call.getState()) + ")");
        call.registerCallback(new Call.Callback() {
            @Override public void onStateChanged(Call c, int state) {
                trace("office call: " + stateWord(state) + (state == Call.STATE_DISCONNECTED ? " cause=" + cause(c) : ""));
                if (state == Call.STATE_ACTIVE && !dialled) { dialled = true; holdThenDial(); }
                if (state == Call.STATE_HOLDING && waitingForHold) { waitingForHold = false; muteAndDial(); }
                if (state == Call.STATE_DISCONNECTED) endAll("office");
            }
        });
        if (call.getState() == Call.STATE_ACTIVE && !dialled) { dialled = true; holdThenDial(); }
    }

    private static volatile boolean waitingForHold;
    /** GSM: put the office call on hold first, then dial the candidate (some phones refuse a 2nd call while one is active). */
    private static void holdThenDial() {
        TlInCallService s = TlInCallService.instance;
        if (s != null) s.setMuted(true);
        try {
            if (officeCall.getDetails().can(Call.Details.CAPABILITY_HOLD)) {
                waitingForHold = true;
                trace("holding the office call");
                officeCall.hold();
                main.postDelayed(new Runnable() { public void run() { if (waitingForHold) { waitingForHold = false; trace("hold did not confirm in 3 s, dialling anyway"); muteAndDial(); } } }, 3000);
                return;
            }
            trace("office call cannot be held (no CAPABILITY_HOLD), dialling anyway");
        } catch (Exception e) { trace("hold error: " + e.getMessage()); }
        muteAndDial();
    }

    private static void muteAndDial() {
        TlInCallService s = TlInCallService.instance;
        if (s != null) s.setMuted(true);
        try {
            TelecomManager tc = (TelecomManager) app.getSystemService(Context.TELECOM_SERVICE);
            trace("dialling the candidate " + LinkService.mask(number));
            tc.placeCall(Uri.fromParts("tel", number, null), new Bundle());
        } catch (Exception e) {
            trace("placeCall error: " + e);
            report(id, "failed", 0, "Could not dial the candidate: " + e.getMessage());
            endAll("dial");
        }
    }

    /** InCallService: our outgoing call to the candidate. */
    static void onCandidateCall(final Call call) {
        candidateCall = call;
        report(id, "dialing", 0, null);
        trace("candidate call added: " + stateWord(call.getState()));
        call.registerCallback(new Call.Callback() {
            @Override public void onStateChanged(Call c, int state) {
                trace("candidate call: " + stateWord(state) + (state == Call.STATE_DISCONNECTED ? " cause=" + cause(c) : ""));
                if (state == Call.STATE_ACTIVE && candidateActiveAt == 0) {
                    candidateActiveAt = System.currentTimeMillis();
                    report(id, "candidate-answered", 0, null);
                    merge(0);
                }
                if (state == Call.STATE_DISCONNECTED) endAll("candidate");
            }
        });
    }

    /** Join the two calls. GSM needs one of them on hold; Android holds the office call when the candidate call starts. */
    private static void merge(final int attempt) {
        if (merged || officeCall == null || candidateCall == null) return;
        try {
            if (attempt == 0) candidateCall.conference(officeCall);
            else if (attempt == 1) officeCall.conference(candidateCall);
            else {
                Call parent = candidateCall.getParent() != null ? candidateCall.getParent() : officeCall.getParent();
                if (parent != null) parent.mergeConference(); else candidateCall.mergeConference();
            }
        } catch (Exception e) { trace("merge attempt " + attempt + " error: " + e.getMessage()); }
        trace("merge attempt " + attempt + " sent (office " + stateWord(officeCall.getState()) + ", candidate " + stateWord(candidateCall.getState()) + ", conferenceable " + candidateCall.getConferenceableCalls().size() + ")");
        main.postDelayed(new Runnable() {
            public void run() {
                if (merged) return;
                if (candidateCall != null && (candidateCall.getParent() != null || officeCall.getParent() != null)) { onMerged(); return; }
                if (attempt < 2) merge(attempt + 1);
                else { report(id, "failed", 0, "The SIM did not join the two calls (conference call is not available on this SIM / network)."); endAll("merge"); }
            }
        }, 2500);
    }

    /** InCallService: a conference call appeared, or the merge check saw a parent. */
    static void onMerged() {
        if (merged || id == null) return;
        merged = true;
        TlInCallService s = TlInCallService.instance;
        if (s != null) s.setMuted(true);
        report(id, "merged", 0, null);
    }

    private static synchronized void endAll(String why) {
        if (id == null) return;
        trace("ending both calls (" + why + ")");
        final String callId = id;
        long talk = candidateActiveAt > 0 ? (System.currentTimeMillis() - candidateActiveAt) / 1000 : 0;
        Call a = officeCall, b = candidateCall;
        reset();
        try { if (b != null && b.getState() != Call.STATE_DISCONNECTED) b.disconnect(); } catch (Exception ignored) { }
        try { if (a != null && a.getState() != Call.STATE_DISCONNECTED) a.disconnect(); } catch (Exception ignored) { }
        TlInCallService s = TlInCallService.instance;
        if (s != null) { try { s.setMuted(false); } catch (Exception ignored) { } }
        report(callId, "ended", talk, null);
        new Prefs(app).setLastCall(talk > 0 ? "Last bridge: talked " + talk + " s" : "Last bridge: the candidate did not answer");
    }

    /** TeamLink's side (the recruiter's browser) hung up: end the phone's calls too. */
    static void endFromTeamLink() {
        if (id == null) return;
        trace("TeamLink side ended: ending the phone's calls");
        if (LegacyBridge.active) { LegacyBridge.endCalls(); return; }
        try { if (candidateCall != null) candidateCall.disconnect(); } catch (Exception ignored) { }
        try { if (officeCall != null) officeCall.disconnect(); } catch (Exception ignored) { }
    }

    static String stateWord(int s) {
        switch (s) {
            case Call.STATE_NEW: return "new"; case Call.STATE_DIALING: return "dialing"; case Call.STATE_RINGING: return "ringing";
            case Call.STATE_HOLDING: return "holding"; case Call.STATE_ACTIVE: return "active"; case Call.STATE_DISCONNECTED: return "disconnected";
            case Call.STATE_CONNECTING: return "connecting"; case Call.STATE_DISCONNECTING: return "disconnecting"; case Call.STATE_SELECT_PHONE_ACCOUNT: return "pick-SIM";
            default: return "state" + s;
        }
    }
    static String cause(Call c) {
        try { android.telecom.DisconnectCause d = c.getDetails().getDisconnectCause(); return d == null ? "?" : (d.getCode() + "/" + d.getReason() + "/" + d.getLabel()); } catch (Exception e) { return "?"; }
    }
    /** One line of what the phone saw, sent to TeamLink (kept on the call for diagnosis). Fire and forget. */
    static void trace(final String text) {
        final String callId = id;
        if (callId == null || app == null) return;
        final Prefs prefs = new Prefs(app);
        new Thread(new Runnable() {
            public void run() {
                try {
                    JSONObject b = new JSONObject();
                    b.put("callId", callId); b.put("event", "trace"); b.put("bridge", true); b.put("trace", text);
                    Api.post(prefs.server(), "/api/phone-link/device/event", prefs.token(), b, 15000);
                } catch (Exception ignored) { }
            }
        }).start();
    }

    static void reset() { id = null; number = null; armedUntil = 0; officeCall = null; candidateCall = null; candidateActiveAt = 0; merged = false; dialled = false; }

    static boolean isCandidate(Call call) {
        if (number == null || call == null || call.getDetails() == null || call.getDetails().getHandle() == null) return false;
        String n = call.getDetails().getHandle().getSchemeSpecificPart();
        return n != null && n.replaceAll("[^0-9]", "").endsWith(number);
    }

    static void report(final String callId, final String ev, final long seconds, final String reason) {
        if (callId == null || app == null) return;
        final Prefs prefs = new Prefs(app);
        new Thread(new Runnable() {
            public void run() {
                for (int i = 0; i < 4; i++) {
                    try {
                        JSONObject b = new JSONObject();
                        b.put("callId", callId); b.put("event", ev); b.put("bridge", true);
                        if ("ended".equals(ev)) b.put("durationSec", seconds);
                        if (reason != null) b.put("reason", reason);
                        Api.Reply r = Api.post(prefs.server(), "/api/phone-link/device/event", prefs.token(), b, 20000);
                        if (r.ok() || r.code == 404 || r.code == 400) return;
                    } catch (Exception ignored) { }
                    try { Thread.sleep(2000L * (i + 1)); } catch (InterruptedException ignored) { }
                }
            }
        }).start();
    }

    static boolean supported() { return Build.VERSION.SDK_INT >= 23; }
}

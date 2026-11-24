package com.teamlink.phone;

import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.telecom.Call;
import android.telecom.InCallService;
import android.telecom.TelecomManager;

import java.util.ArrayList;
import java.util.List;

/**
 * While TeamLink Phone is the phone's default Phone app, Android hands every call to this service (and shows no other dialer).
 * Bridge calls are handled silently (Bridge.java); every other call shows our small call screen (InCallActivity), so the phone still works.
 */
public class TlInCallService extends InCallService {
    static TlInCallService instance;
    static final List<Call> calls = new ArrayList<Call>();

    static boolean isDefaultDialer(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                RoleManager rm = (RoleManager) c.getSystemService(Context.ROLE_SERVICE);
                return rm != null && rm.isRoleHeld(RoleManager.ROLE_DIALER);
            }
            if (Build.VERSION.SDK_INT >= 23) {
                TelecomManager tm = (TelecomManager) c.getSystemService(Context.TELECOM_SERVICE);
                return tm != null && c.getPackageName().equals(tm.getDefaultDialerPackage());
            }
        } catch (Exception ignored) { }
        return false;
    }

    @Override public void onCreate() { super.onCreate(); instance = this; }
    @Override public void onDestroy() { if (instance == this) instance = null; super.onDestroy(); }

    @Override public void onCallAdded(Call call) {
        super.onCallAdded(call);
        synchronized (calls) { calls.add(call); }
        boolean conference = call.getDetails() != null && call.getDetails().hasProperty(Call.Details.PROPERTY_CONFERENCE);
        if (conference && Bridge.id != null) { Bridge.onMerged(); return; }
        if (call.getState() == Call.STATE_RINGING && Bridge.armed()) { Bridge.onOfficeCall(call); return; }
        if (Bridge.id != null && Bridge.officeCall != null && Bridge.candidateCall == null && Bridge.isCandidate(call)) { Bridge.onCandidateCall(call); return; }
        if (Bridge.busy() && call.getState() == Call.STATE_RINGING) { call.reject(false, null); return; } // nobody else breaks into a bridge
        showScreen();
        call.registerCallback(new Call.Callback() {
            @Override public void onStateChanged(Call c, int state) { InCallActivity.refreshIfOpen(); }
        });
    }

    @Override public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        synchronized (calls) { calls.remove(call); }
        InCallActivity.refreshIfOpen();
    }

    /** A call rang before TeamLink's "bridge coming" message: it is the office call. */
    void answerRingingForBridge() {
        if (!Bridge.armed()) return;
        synchronized (calls) {
            for (Call c : calls) if (c.getState() == Call.STATE_RINGING) { Bridge.onOfficeCall(c); InCallActivity.closeIfOpen(); return; }
        }
    }

    private void showScreen() {
        try { startActivity(new Intent(this, InCallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
    }
}

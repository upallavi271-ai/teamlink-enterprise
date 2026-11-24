package com.teamlink.phone;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Call;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** The small call screen for calls that are NOT TeamLink bridges (the phone still works as a phone): Answer / Decline / End. */
public class InCallActivity extends Activity {
    private static InCallActivity open;
    private LinearLayout box;

    static void refreshIfOpen() { final InCallActivity a = open; if (a != null) a.runOnUiThread(new Runnable() { public void run() { a.build(); } }); }
    static void closeIfOpen() { final InCallActivity a = open; if (a != null) a.runOnUiThread(new Runnable() { public void run() { a.finish(); } }); }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(40, 80, 40, 80);
        setContentView(box);
    }
    @Override protected void onResume() { super.onResume(); open = this; build(); }
    @Override protected void onPause() { super.onPause(); if (open == this) open = null; }

    private void build() {
        box.removeAllViews();
        List<Call> list;
        synchronized (TlInCallService.calls) { list = new ArrayList<Call>(TlInCallService.calls); }
        boolean any = false;
        for (final Call c : list) {
            if (c.getState() == Call.STATE_DISCONNECTED) continue;
            any = true;
            String who = c.getDetails() != null && c.getDetails().getHandle() != null ? c.getDetails().getHandle().getSchemeSpecificPart() : "Unknown";
            TextView t = new TextView(this);
            t.setText(who + "\n" + word(c.getState()));
            t.setTextSize(22); t.setTextColor(Color.rgb(16, 24, 40)); t.setGravity(Gravity.CENTER);
            box.addView(t);
            if (c.getState() == Call.STATE_RINGING) {
                box.addView(button("Answer", Color.rgb(6, 118, 71), new View.OnClickListener() { public void onClick(View v) { c.answer(0); } }));
                box.addView(button("Decline", Color.rgb(180, 35, 24), new View.OnClickListener() { public void onClick(View v) { c.reject(false, null); } }));
            } else {
                box.addView(button("End call", Color.rgb(180, 35, 24), new View.OnClickListener() { public void onClick(View v) { c.disconnect(); } }));
            }
        }
        if (!any) finish();
    }
    private static String word(int s) {
        switch (s) {
            case Call.STATE_RINGING: return "Incoming call";
            case Call.STATE_DIALING: case Call.STATE_CONNECTING: return "Calling…";
            case Call.STATE_ACTIVE: return "On call";
            case Call.STATE_HOLDING: return "On hold";
            default: return "";
        }
    }
    private Button button(String label, int color, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label); b.setAllCaps(false); b.setTextColor(Color.WHITE); b.setBackgroundColor(color); b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 24;
        b.setLayoutParams(lp);
        return b;
    }
}

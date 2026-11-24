package com.teamlink.phone;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** One screen: pair with TeamLink (address + the Admin's 6-digit code), allow the permissions, see the link status, switch off / unpair. */
public class MainActivity extends Activity {
    static final String ACTION_STATUS = "com.teamlink.phone.STATUS";
    /** The permissions the link needs (TeamLink shows the phone as "Device unavailable" while one is missing). */
    static final String[][] NEEDED = {
        { Manifest.permission.CALL_PHONE, "Make phone calls" },
        { Manifest.permission.READ_PHONE_STATE, "Phone state" },
        { Manifest.permission.READ_CALL_LOG, "Call log (talk time)" },
    };
    private static final int REQ = 11;

    private Prefs prefs;
    private LinearLayout box;
    private TextView status;
    private final Handler h = new Handler();
    private final Runnable tick = new Runnable() { public void run() { showStatus(); h.postDelayed(this, 3000); } };
    private final BroadcastReceiver rx = new BroadcastReceiver() { @Override public void onReceive(Context c, Intent i) { showStatus(); } };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        ScrollView sv = new ScrollView(this);
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = dp(18);
        box.setPadding(p, p, p, p);
        sv.addView(box);
        setContentView(sv);
        build();
    }

    @Override protected void onResume() {
        super.onResume();
        registerReceiver(rx, new IntentFilter(ACTION_STATUS));
        h.post(tick);
        if (prefs.paired()) LinkService.start(this);
        build();
    }

    @Override protected void onPause() {
        super.onPause();
        try { unregisterReceiver(rx); } catch (Exception ignored) { }
        h.removeCallbacks(tick);
    }

    private void build() {
        box.removeAllViews();
        TextView title = text("TeamLink Phone", 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);
        box.addView(text("Lets TeamLink place your recruitment calls from this phone's SIM. You talk on this phone. Calls are not recorded.", 13));
        status = text("", 15);
        status.setPadding(0, dp(14), 0, dp(10));
        box.addView(status);

        List<String> missing = missingPermissions();
        if (!missing.isEmpty()) {
            box.addView(text("Needed: " + join(missing), 13, Color.rgb(180, 35, 24)));
            box.addView(button("Allow permissions", new View.OnClickListener() { public void onClick(View v) { askPermissions(); } }));
        }
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                box.addView(text("Let the app run in the background, or Android may stop the link:", 13));
                box.addView(button("Keep running in background", new View.OnClickListener() { public void onClick(View v) { askBattery(); } }));
            }
        }

        if (!prefs.paired()) {
            box.addView(text("Pair with TeamLink", 17));
            final EditText server = edit(prefs.server(), "TeamLink address", InputType.TYPE_TEXT_VARIATION_URI);
            final EditText code = edit("", "6-digit code from TeamLink (Admin > Browser calling > Android phones)", InputType.TYPE_CLASS_NUMBER);
            box.addView(server);
            box.addView(code);
            box.addView(button("Pair", new View.OnClickListener() { public void onClick(View v) { pair(server.getText().toString(), code.getText().toString()); } }));
        } else {
            box.addView(button(prefs.paused() ? "Switch on (take TeamLink calls)" : "Switch off (stop TeamLink calls)", new View.OnClickListener() {
                public void onClick(View v) { prefs.setPaused(!prefs.paused()); LinkService.start(MainActivity.this); build(); }
            }));
            box.addView(button("Unpair this phone", new View.OnClickListener() { public void onClick(View v) { confirmUnpair(); } }));
        }
        TextView ver = text("Version " + BuildInfo.VERSION, 11, Color.GRAY);
        ver.setPadding(0, dp(18), 0, 0);
        box.addView(ver);
        showStatus();
    }

    private void showStatus() {
        if (status == null) return;
        if (!prefs.paired()) { status.setText("Not paired yet."); return; }
        String s = (prefs.name().length() > 0 ? prefs.name() + " · " : "") + prefs.number() + "\n" + (prefs.paused() ? "Switched off on this phone." : prefs.lastStatus());
        if (prefs.lastCall().length() > 0) s += "\n" + prefs.lastCall();
        status.setText(s);
    }

    private void pair(final String server, final String code) {
        final String c = code.replaceAll("[^0-9]", "");
        if (c.length() != 6) { toast("Type the 6-digit code from TeamLink."); return; }
        status.setText("Pairing…");
        new Thread(new Runnable() {
            public void run() {
                String msg;
                try {
                    JSONObject b = new JSONObject();
                    b.put("code", c);
                    b.put("model", Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")");
                    b.put("appVersion", BuildInfo.VERSION);
                    Api.Reply r = Api.post(server, "/api/phone-link/pair", null, b, 20000);
                    if (r.ok()) {
                        JSONObject d = r.body.getJSONObject("device");
                        prefs.savePairing(Api.clean(server), r.body.getString("token"), d.optString("name"), d.optString("number"));
                        msg = "Paired as " + d.optString("name") + " (" + d.optString("number") + ").";
                    } else msg = r.error();
                } catch (Exception e) { msg = "Could not reach TeamLink: " + e.getMessage(); }
                final String m = msg;
                runOnUiThread(new Runnable() { public void run() { toast(m); if (prefs.paired()) LinkService.start(MainActivity.this); build(); } });
            }
        }).start();
    }

    private void confirmUnpair() {
        new AlertDialog.Builder(this).setTitle("Unpair this phone?").setMessage("TeamLink stops sending calls here. Pairing again needs a new code from the Admin.")
            .setPositiveButton("Unpair", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    final String server = prefs.server(); final String token = prefs.token();
                    new Thread(new Runnable() { public void run() { try { Api.post(server, "/api/phone-link/device/unpair", token, new JSONObject(), 15000); } catch (Exception ignored) { } } }).start();
                    prefs.forget();
                    startService(new Intent(MainActivity.this, LinkService.class).setAction(LinkService.ACTION_STOP));
                    build();
                }
            }).setNegativeButton("Cancel", null).show();
    }

    private List<String> missingPermissions() {
        List<String> out = new ArrayList<String>();
        if (Build.VERSION.SDK_INT < 23) return out;
        for (String[] p : NEEDED) if (checkSelfPermission(p[0]) != PackageManager.PERMISSION_GRANTED) out.add(p[1]);
        return out;
    }
    private void askPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        List<String> ask = new ArrayList<String>();
        for (String[] p : NEEDED) ask.add(p[0]);
        if (Build.VERSION.SDK_INT >= 26) ask.add(Manifest.permission.ANSWER_PHONE_CALLS); // optional: lets "Hang up" in TeamLink end the call here
        requestPermissions(ask.toArray(new String[0]), REQ);
    }
    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) { build(); if (prefs.paired()) LinkService.start(this); }
    private void askBattery() {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) { }
        }
    }

    // ------------------------------------------------------------------ small view helpers
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private TextView text(String s, int sp) { return text(s, sp, Color.rgb(16, 24, 40)); }
    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }
    private EditText edit(String value, String hint, int type) {
        EditText e = new EditText(this);
        e.setText(value); e.setHint(hint); e.setInputType(type | (type == InputType.TYPE_TEXT_VARIATION_URI ? InputType.TYPE_CLASS_TEXT : 0)); e.setSingleLine(true);
        e.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return e;
    }
    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label); b.setAllCaps(false); b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }
    private void toast(String s) { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show(); }
    private static String join(List<String> l) { StringBuilder sb = new StringBuilder(); for (String s : l) { if (sb.length() > 0) sb.append(", "); sb.append(s); } return sb.toString(); }
}

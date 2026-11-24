package com.teamlink.phone;

import android.content.Context;
import android.content.SharedPreferences;

/** What the app keeps on the phone: the TeamLink address, its own device key (never shown), the paired name / number and the on/off switch. */
final class Prefs {
    static final String DEFAULT_SERVER = "https://teamlink.teamlinks.in";
    private final SharedPreferences p;

    Prefs(Context c) { p = c.getSharedPreferences("teamlink_phone", Context.MODE_PRIVATE); }

    String server() { return p.getString("server", DEFAULT_SERVER); }
    String token() { return p.getString("token", ""); }
    boolean paired() { return token().length() == 64; }
    String name() { return p.getString("name", ""); }
    String number() { return p.getString("number", ""); }
    boolean paused() { return p.getBoolean("paused", false); }
    String lastStatus() { return p.getString("lastStatus", ""); }
    String lastCall() { return p.getString("lastCall", ""); }

    void savePairing(String server, String token, String name, String number) {
        p.edit().putString("server", server).putString("token", token).putString("name", name).putString("number", number).putBoolean("paused", false).apply();
    }
    void setNameNumber(String name, String number) { p.edit().putString("name", name).putString("number", number).apply(); }
    void setPaused(boolean v) { p.edit().putBoolean("paused", v).apply(); }
    void setLastStatus(String v) { p.edit().putString("lastStatus", v).apply(); }
    void setLastCall(String v) { p.edit().putString("lastCall", v).apply(); }
    void forget() { p.edit().remove("token").remove("name").remove("number").remove("paused").remove("lastCall").apply(); }
}

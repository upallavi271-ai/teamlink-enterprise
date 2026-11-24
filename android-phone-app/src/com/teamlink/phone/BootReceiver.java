package com.teamlink.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart (or an app update) the link comes back by itself, if the phone is paired. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (new Prefs(c).paired()) {
            try { LinkService.start(c); } catch (Exception ignored) { }
        }
    }
}

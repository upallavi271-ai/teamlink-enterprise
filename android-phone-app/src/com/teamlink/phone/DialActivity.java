package com.teamlink.phone;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.telecom.TelecomManager;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;

/** A plain dial pad, so the phone can still make an ordinary call while TeamLink Phone is its Phone app (Android needs one for that role). */
public class DialActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(40, 60, 40, 40);
        final EditText num = new EditText(this);
        num.setInputType(InputType.TYPE_CLASS_PHONE);
        num.setHint("Number");
        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data != null && "tel".equals(data.getScheme())) num.setText(data.getSchemeSpecificPart());
        box.addView(num);
        Button call = new Button(this);
        call.setText("Call"); call.setAllCaps(false);
        call.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String n = num.getText().toString().replaceAll("[^0-9+*#]", "");
                if (n.length() == 0) return;
                try { ((TelecomManager) getSystemService(TELECOM_SERVICE)).placeCall(Uri.fromParts("tel", n, null), new Bundle()); finish(); } catch (Exception ignored) { }
            }
        });
        box.addView(call);
        setContentView(box);
    }
}

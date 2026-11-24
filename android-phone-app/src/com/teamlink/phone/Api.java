package com.teamlink.phone;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import org.json.JSONObject;

/** The few calls to TeamLink (/api/phone-link/*). HTTPS only. Every call runs on a background thread. */
final class Api {
    static final class Reply {
        final int code; final JSONObject body;
        Reply(int code, JSONObject body) { this.code = code; this.body = body; }
        boolean ok() { return code >= 200 && code < 300; }
        String error() { return body != null ? body.optString("error", "HTTP " + code) : "HTTP " + code; }
    }

    static String clean(String server) {
        String s = server == null ? "" : server.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.startsWith("https://")) s = "https://" + s.replaceFirst("^[a-zA-Z]+://", "");
        return s;
    }

    static Reply post(String server, String path, String token, JSONObject body, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(clean(server) + path).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(timeoutMs);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "TeamLinkPhone/" + BuildInfo.VERSION);
            if (token != null && token.length() > 0) c.setRequestProperty("Authorization", "Bearer " + token);
            byte[] out = (body == null ? "{}" : body.toString()).getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(out);
            os.close();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = "";
            if (in != null) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                in.close();
                text = b.toString("UTF-8");
            }
            JSONObject j = null;
            try { j = text.length() > 0 ? new JSONObject(text) : new JSONObject(); } catch (Exception e) { j = new JSONObject(); }
            return new Reply(code, j);
        } finally {
            c.disconnect();
        }
    }
}

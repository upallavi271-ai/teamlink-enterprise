# Communication: security

* **Who may do what (RBAC).** Configure / connect / switch on: Super Admin and Admin only (`comm.js` `adminOnly`). Sending: the Contact right per kind
  of person (`utils/contactAccess.js`), unchanged. BDE and BDE TL never see candidate numbers: the server sends and answers with masked numbers; the
  Communication log masks numbers for them; they cannot bulk-send. Everyone else sees only the messages they sent; global roles (Super Admin, Admin,
  Manager, Assistant Manager) see all.
* **Secrets are encrypted at rest** (AES-256-GCM, `utils/secrets.js`, key `INTEGRATION_SECRET_KEY`). The Android password / token and the webhook key are
  Integration fields (secret by label), never returned (masked hint only), never logged. The QR session files are encrypted the same way, in a private folder
  outside git (`0600`); without the key the worker refuses to start (never stored unencrypted).
* **Webhooks prove themselves.** Android: HMAC-SHA256 over rawBody + timestamp, 5-minute window (replay protection), or a shared word compared in constant
  time; no key saved = 403. Meta and the SMS gateways keep their existing signature checks.
* **Consent, STOP, DPDP.** Checked at planning (consent withdrawn, STOP, quiet hours, de-dupe, daily caps, company switch) and again inside each adapter
  (STOP) and for QR messages again when they leave the queue. A STOP reply on any provider (WhatsApp cloud, QR, SMS gateway, Android phone) opts the
  person out of that channel.
* **Test-record guard.** On a real server a message to a record named ZZTEST / example.test is never sent (planner and adapter layer). Tests run only on the sandbox
  with mock providers; the test process itself refuses any non-loopback host.
* **Rate limits.** Send routes: 40 a minute per login (`TL_COMM_SEND_LIMIT`); bulk 20; Android test SMS 5. Provider caps: QR 30 / hour, 150 / day (new number 10 / 40);
  Android 60 / hour, 200 / day; plus the existing per-channel message limits.
* **Queue security.** The QR queue rows are only written by the server after the adapter's checks. The browser never supplies a file path: attachments are named
  (`resume`, `offer`) and resolved by the server inside the upload folders.
* **No message bodies in the new records.** Bodies stay only where they already were (CandidateMessage / ConversationMessage). Audit rows say what changed
  (switch, provider, caps, connect, disconnect, kill switch, "I understand"), never a secret.
* **The QR worker is inert by default.** `src/index.js` never imports or starts it. It starts only from an Admin button or `npm run whatsapp-qr-worker`, only when the switch is
  on and "I understand" was ticked, and on the real database only with `TL_ALLOW_REAL_WHATSAPP_QR=1`. The sandbox refuses it unless a fake library is injected.
* **SSRF.** The Android base URL must be http(s) without credentials in the address; only an Admin can set it; the server calls only the send / health / status paths.
* **Known risks.** The QR prototype is unofficial (ban risk, see WHATSAPP.md). The Android phone is a personal SIM (DLT rules, SIM limits, SMS text is not encrypted).

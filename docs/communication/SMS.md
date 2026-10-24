# SMS from the ATS: Android phone and paid gateways

Chosen in **Administration > Integrations > WhatsApp & SMS**: "SMS: which one sends?".

## 1. Android phone with your own SIM (sms.android)

Built for the open-source **SMS Gateway for Android** (capcom6/android-sms-gateway, docs at docs.sms-gate.app): it has a documented REST API
for sending, status, health and webhooks. The adapter is generic: base URL, username / password or Bearer token, send endpoint, JSON body
template for other apps.

### Set up in 6 steps

1. Install **SMS Gateway for Android** on the Android phone that has the SIM.
2. In the app start the **Local server**; note the **Username** and **Password** it shows (or use the **Cloud server** if the phone and the computer are on different networks).
3. Keep the phone on the **same Wi-Fi** as the computer running TeamLink (Local mode). Turn off battery saving for the app.
4. Copy the address the app shows, for example `http://192.168.1.20:8080`.
5. Integrations > WhatsApp & SMS > "SMS through an Android phone": paste the address, username, password; press **Save and connect**.
6. Press **Test**, then type your **own** number and press **Send the test SMS**.

Then press **Set the webhooks on the phone for me** (needs `APP_BASE_URL` = the address the phone can reach this server on, for example
`http://192.168.1.10:4010`) or add the webhook by hand in the app: URL `https://<server>/api/webhooks/sms-android`, events sent, delivered,
failed, received, and the same signing key / word you typed in TeamLink.

### What the adapter does (from the documented API)

| Mode | Base URL | Send | Health |
|---|---|---|---|
| Local | `http://<phone-ip>:8080` | `POST /message` | `GET /health` |
| Cloud | `https://api.sms-gate.app` | `POST /3rdparty/v1/messages` | `GET /3rdparty/v1/health` |

* Auth: HTTP Basic (username + password) or Bearer token.
* Body: `{ "textMessage": { "text": "..." }, "phoneNumbers": ["+91..."], "simNumber": 1, "withDeliveryReport": true }`; reply `{ id, state: "Pending", ... }`.
* Status: webhooks `sms:sent`, `sms:delivered`, `sms:failed`, `sms:cancelled`, `sms:received`, `sms:batch:received`, `system:ping`;
  verified with `X-Signature` = hex HMAC-SHA256(signing key, rawBody + `X-Timestamp`), timestamp within 5 minutes (or `?key=<word>` when the app cannot sign).
  If no webhook arrives, the status endpoint asks the phone (`GET /message/<id>`).
* **Generic mode** (any other app): `Send endpoint`, a JSON body template with `{{to}}` and `{{text}}` (safely escaped) and the name of the id in the reply.
* **SIM selection:** "SIM number (1-3)" is sent as `simNumber` when set.
* **Phone offline:** a network error or timeout says "The phone did not answer ...". The message is not marked sent; TeamLink tries the paid gateway
  (if "try the other one" is on) or the screen offers copy / your own app.
* **Limits that protect the SIM:** 3-6 s between messages, 60 an hour, 200 a day (Admin can change).
* Verified here against a **mock** phone only. The exact paths and webhook shapes come from docs.sms-gate.app (checked 2026-10-13); some
  versions of the app use `/messages` instead of `/message`: change "Send endpoint" if yours does.

### India: read this

* Promotional bulk SMS from a normal SIM can be **blocked by the operator** under the TRAI **DLT** rules, and sending many texts can get the SIM
  restricted.
* Keep the phone for **transactional / personal-style** messages: interview reminders, document requests, "please call me".
* Use the **paid DLT gateway** (MSG91 / Fast2SMS) for bulk and for anything promotional.

## 2. Paid gateways (sms.gateway)

MSG91, Fast2SMS or Twilio, set up in Integrations > Connections > SMS Gateway (already built): sender ID, API key, DLT template ids, delivery-report
link. Steps for India (DLT registration, sender ID, templates) are on Message templates > Channels.

## Which one is used

Default: the paid gateway first, the Android phone as fallback. Switch to "Android phone" first if you want the SIM to send. The Contact dialog
always says "SMS via Android phone" or "SMS via paid gateway" before you send.

## Troubleshooting

| Message | What to do |
|---|---|
| The phone did not answer | Phone off, other Wi-Fi, app server stopped, wrong address. Open the app and check the address |
| The phone app refused the username or password | Re-type them (the app may have changed them) |
| The phone queue is full or busy | Wait; the app has a queue limit |
| Hourly / daily limit reached | Wait, or raise the limit carefully |
| Stays "Queued" | The phone cannot reach the webhook: press Set the webhooks, or check `APP_BASE_URL` |

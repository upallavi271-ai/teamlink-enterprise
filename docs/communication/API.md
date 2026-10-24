# Communication API

All routes need a login (`Authorization: Bearer <jwt>`). "Admin" = Super Admin or Admin. "Staff" = anyone with a Contact right
(Role Catalog: "Contact (Mail / WhatsApp / SMS / Call)"). BDE and BDE TL are Staff but see **masked** numbers; the server sends.

## Sending (existing routes, now provider-aware)

| Route | Notes |
|---|---|
| `POST /api/messaging/send` | One person. Body: `{ audience, id, channel: Email|WhatsApp|SMS, purposeKey?, body?, perChannel?, applicationId?, attachments?: [{type:'resume'}, {type:'offer', applicationId}] }`. Answer: `{ jobId, masked, result: { status, reason, address, provider, via, queued, providerRef, tried, note } }`. Attachments: WhatsApp, candidates, one person, not for masked roles. Rate limit 40 a minute per login (429). |
| `POST /api/conversations/send` | Inbox reply and "best channel" (omniSend). Same limit. |
| `POST /api/messaging/reach/send` | Bulk bar (max 200). 20 a minute per login. |
| `GET /api/messaging/channels` | Per channel `{ configured, via, providerId, providers[] }` |

`status: "sent"` with `queued: true` means accepted by the QR queue or the Android phone, not yet sent. Follow it with `GET /api/comm/status`.

## /api/comm

| Route | Who | Purpose |
|---|---|---|
| `GET /overview` | Staff | `{ channels: { WhatsApp, SMS: { configured, via, provider, providers[], switchOn } }, isAdmin }`. Admin adds `settings`, `bounds`, `cards{provider: {ready, usage, caps}}`, `qr`, `android`, `publicAddressSet` |
| `GET /providers?channel=WhatsApp|SMS` | Staff | For the Contact dialog: `{ configured, via, provider, prototype, warning, templateRule, attachments, switchOn, reason }` |
| `PUT /settings` | Admin | `{ switches:{WhatsApp,SMS}, providers:{WhatsApp:{primary,fallback}, SMS:{...}}, qr:{perHour,perDay,gapMin,gapMax,newNumber,typing,killSwitch}, android:{perHour,perDay,gapMin,gapMax} }` (audited, no secrets) |
| `GET /status?ref=<providerRef>` | sender / global view | `{ message: { status, statusLabel, history[], error, retries, provider, via, attachments } }`; asks the Android phone if no webhook came |
| `GET /log` | Staff (own messages; global roles see all) | Filters `from,to,channel,provider,status,sender,candidate,q,direction,page,size`. `{ total, rows[], counts:{status,provider,channel}, senders[], scope }`. Numbers are masked for masked roles |
| `GET /log.xlsx`, `/log.pdf` | same | Same filters |

### QR prototype (Admin)

`GET /qr/state` (poll; returns `state, label, phone (masked), qrSvg, caps, usage, ack, killSwitch, paused, reason`) ·
`POST /qr/enable {understand:true}` (400 without it; saves the confirmation + audit) · `POST /qr/disable` · `POST /qr/start` (refuses in the sandbox and
on the real DB without `TL_ALLOW_REAL_WHATSAPP_QR=1`) · `POST /qr/stop` · `POST /qr/resume` · `POST /qr/unlink` · `POST /qr/kill {on}` ·
`POST /qr/clear-queue` · `GET /qr/selftest` (an svg QR of a known address, to prove the picture generator with a phone camera).

### Android phone (Admin)

`GET /android/config` (secrets masked) · `PUT /android/config {values}` (password and webhook key encrypted; 400 without `INTEGRATION_SECRET_KEY`) ·
`POST /android/connect` · `POST /android/disconnect` · `POST /android/test` · `POST /android/test-sms {to}` (typed own number, 5 a minute) ·
`POST /android/register-webhooks` (needs `APP_BASE_URL`).

## Webhooks (public, each proves itself)

| Route | Proof |
|---|---|
| `POST /api/webhooks/sms-android` | `X-Signature` HMAC-SHA256(key, rawBody + `X-Timestamp`), timestamp within 5 min; or `?key=<word>` |
| `GET/POST /api/webhooks/whatsapp` | Meta verify token / `X-Hub-Signature-256` |
| `ALL /api/webhooks/sms/:provider`, `/sms-inbound/:provider` | MSG91 / Fast2SMS key, Twilio signature |

## Adapter contract (code)

```js
channels.send(channel, { to, kind, text, vars, templateId, senderId, template, media, meta, providerOnly })
 -> { ok, provider, via, providerRef, status, queued, error, retryable, transient, notConfigured, invalid, capped, offline, attempts[] }
channels/send.js: sendWhatsApp({to, text, template:{name,language,vars}, meta}), sendSms({to, text, templateId, senderId, meta})
channels.status('WhatsApp'|'SMS') -> { ordered[], ready[], configured, provider, via, reason }
```

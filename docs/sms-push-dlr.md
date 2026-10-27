# SMS Push Platform delivery reports (DLR)

How TeamLink learns whether an SMS sent through SMS Push Platform (web.smsgw.in) reached the phone. There are two ways in, and both use the same reader (`backend/src/utils/smsPushDlrReport.js`).

## 1. Push DLR: the provider calls TeamLink

### Callback address

```
https://teamlink.teamlinks.in/api/webhooks/sms/smsgw?key=<Delivery-report webhook secret>
```

- `<Delivery-report webhook secret>` is the text saved in **Administration → Integrations → SMS Gateway → "Delivery-report webhook secret"**.
  - Choose a long random text, 24 or more characters.
  - Paste the same text into the address.
- Both GET and POST work. The body can be query-string, form or JSON. One report per call, or a list of up to 200.
- The local copy (`http://localhost:4010/...`) cannot be reached from the internet. Push DLR works only on the live site.

### Provider-side setup (needs the SMS Push Platform account; not done by TeamLink)

1. Log in to the SMS Push Platform panel with the account that sends TeamLink's SMS.
2. Open the delivery-report / DLR / callback-URL setting. The exact menu name depends on the panel.
3. Paste the callback address above, with your secret in place of `<…>`, and save.
4. If the panel asks which fields to send, choose: `message_id`, `dlrstatus`, `msisdn`, `sender_id`, `submittime`, `delvtime`, `dlrcode`.

**Not verified.** No one has yet seen the provider save this address or send a report to it. It counts as done only when a real report arrives (see "How to test with a real DLR").

### Fields read

| Field | Meaning | Rule in TeamLink |
|---|---|---|
| `message_id` | id from the send answer (`msgid` "<id>,<mobile>", the part before the comma) or the `ackid` | **Required.** 3–80 letters, digits, `. _ : -`. Matched to the SMS record by message id **or** ackid. |
| `dlrstatus` | provider's result word | **Required.** See the status map below. |
| `msisdn` | mobile number | Must be the number the SMS went to (last 10 digits), or the report is **not applied**. |
| `sender_id` | header the SMS left with | Kept on the record. |
| `submittime` | when the provider took it | Kept. Read as `YYYY-MM-DD HH:mm:ss` India time; ISO or epoch also accepted. |
| `delvtime` | when it was delivered or failed | Used as the delivery time. A time more than a day ahead, or before 2020, is not believed. |
| `dlrcode` | operator result code | Kept. Shown with a failure ("SMS undeliv (code 882)"). |

Older spellings that the callback always read still work: `msgid`, `messageid`, `status`, `errordesc`, `errorcode`, `recipient`, `err_code`.

### Status map

| dlrstatus | TeamLink |
|---|---|
| `DELIVRD`, `DELIVERED` | Delivered |
| `UNDELIV`, `UNDELIVERED`, `FAILED`, `EXPIRED`, `REJECTD`, `REJECTED`, `BLOCKED`, `DND` | Failed (reason + code kept) |
| `SUBMITTED`, `ACCEPTD`, `ENROUTE`, `PENDING`, anything else | Not final: nothing changes |

A status never goes backwards: a late "Submitted" does not undo "Delivered". "Failed" always wins.

### Safety

- **Authenticity.** The provider documents no signature for these calls. The only check is the secret `key` in the address, compared in constant time.
  - Without a saved secret, or with a wrong one, the answer is 403 and nothing changes.
  - Keep the secret private, and change it if it ever leaks.
- **Repeats.** The same report twice changes nothing and adds no history line.
- **Input checks.** Every field is checked before anything is looked up. A bad field is ignored and still answered 200, so the provider does not retry the same report forever.
- **Wrong number.** A report whose `msisdn` does not match the SMS is not applied.
- **Rate limit.** At most 600 calls a minute from one address (429 after that).
- **Logs.** One line per change, for example `[dlr] smsgw push: ZZ1…ABC sent -> delivered (ATS)`.
  - Unmatched or invalid reports are logged as warnings.
  - The mobile number is masked (`xxxxxx11`).
  - The key, passwords and full numbers are never logged.

## 2. Pull DLR: TeamLink asks the provider

This is the manual's Pull DLR API: `GET https://web.smsgw.in/dlrresponse/dlrresp.jsp?ackid=<ackid>`.

- It takes only the ackid; no login is sent.
- The reply is XML: `<dlr><dlrinfo><msgid/>…<dlrdesc/>…<delvtime/></dlrinfo></dlr>`.
- It is asked on the same host as the send address.

How it runs (`backend/src/utils/smsPushDlr.js`):
- Every 10 minutes it asks about SMS that are still "Submitted": older than 10 minutes, younger than 3 days, at most 25 per pass.
- Each ackid is asked at most 12 times, with growing gaps between tries.
- Turn it off with `SMS_PUSH_DLR_PULL=off`.
- **Check delivery now** on SMS Push Platform → History asks for one SMS straight away.

It works without any provider-side setup, so it is the fallback when Push DLR cannot be configured.

## Automatic SMS stays off until both are proven

ATS stage texts, campaigns and other automatic SMS go out only after **both** of these:

1. a real **Test SMS** (Integrations → SMS Gateway) was accepted by the provider;
2. at least one delivery report (push or pull) came back and was applied.

Until then they are recorded as "not configured" and never transmitted. Saving new login details (endpoint, username, password, PE ID, Sender ID) clears both proofs.

## How to test with a real DLR

1. **Live site:** save the delivery-report secret, then set the callback address in the provider panel (section 1).
2. Send a **Test SMS** to your own phone from Integrations → SMS Gateway. It should show "Accepted by Provider — Delivery Pending".
3. Wait for the SMS to arrive on the phone.
4. Open SMS Push Platform → History. Within a minute (push) or after 10 minutes / **Check delivery now** (pull), the row should turn **Delivered**.
5. If it stays "Submitted":
   - Push not reaching TeamLink: check the address and secret in the panel. The server log shows `[dlr]` lines when a report arrives.
   - Pull not answering: press **Check delivery now** and read the message it shows.

## Not handled by delivery reports

- **The sending login error** ("username doesnot exist or invalid or username wrongly encoded") is a separate problem in the *send* request. DLR does not fix it.
  - Since 2026-10-27, `httpapi.jsp` is sent as the manual's GET form, with separate `username` and `password` parameters.
  - If the provider still refuses the username, the API username saved in TeamLink is not one the provider accepts. Check the "API username" in the provider panel; it is not the website login and not a mobile number.
- **The Job Portal** (`job-portal-app`) sends no SMS through SMS Push Platform, so it has no SMS records here. SMS about Job Portal applicants are sent by TeamLink as ATS messages, and their reports land on those ATS records.

// ---------------------------------------------------------------------------
// CRM WAVE B - PHONE, WHATSAPP, SMS, CHAT (07.01 07.02 07.03 07.04 07.05 07.08 07.09 07.10 07.11)
//   browser calls   a lead / deal / customer called from the browser on the office SIM lines (browsercall/*: SIP.js -> Asterisk ->
//                   Synway / another line). The same rules as ATS browser calling (mode Off / Test / Live, which roles may use which line,
//                   one call at a time, a line's call limit). The row is kept as BrowserCall.candidateId = "crm:<kind>:<id>"; the call is
//                   recorded and transcribed by browsercall/recording.js; syncCalls() writes the result (answered, talk time, recording,
//                   what was said) on the record's timeline line by itself.
//   transcripts     of those calls; and of a call made from the person's own phone when they upload its recording
//   power dialer    a list of people with a phone (follow-ups due, a segment, picked leads); one after another: call, what came of it, next
//   SMS             from the record through the SMS gateway (needs a DLT-approved template), on the timeline, opt-outs respected
//   inbound routing a call to the company number from a known lead / customer is put through to its owner (Exotel "Connect" dynamic URL or
//                   an Asterisk curl): switch "Incoming calls" + the hook key
//   website chat    the chat bubble on the company website (switch "Website chat"): the visitor writes, the team answers in CRM >
//                   Follow-ups > Inbox; a visitor who gives a phone / email becomes a lead
//   inbox           every email / WhatsApp / SMS / call of every lead, deal and customer in one list, the ones waiting for our reply first
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common');

const { S, B, clip } = C;
const LIVE = "('initiated','calling','ringing','connected')";

// ---- who is on the other end of a record
async function phoneOf(kind, row) {
  if (kind === 'lead') return { phone: row.phone, name: row.contactName || row.company };
  if (kind === 'contact') return { phone: row.phone, name: row.name };
  const accountId = kind === 'account' ? row.id : row.accountId;
  const c = (kind === 'deal' && row.contactId ? await S.getRow('contact', row.contactId) : null)
    || (accountId ? await B.one('SELECT * FROM "CrmContact" WHERE "accountId" = ? AND "phone" IS NOT NULL ORDER BY CASE "role" WHEN \'Decision maker\' THEN 0 ELSE 1 END LIMIT 1', accountId) : null);
  const a = accountId ? await S.getRow('account', accountId) : null;
  return { phone: (c && c.phone) || (a && a.phone) || '', name: (c && c.name) || (a && a.name) || row.title || '' };
}

// ================================================================== 07.01 / 07.02 / 07.03 browser calls on the office lines
const BC = () => require('../../browsercall/schema'); // eslint-disable-line global-require
const CFG = () => require('../../browsercall/config'); // eslint-disable-line global-require
const LINES = () => require('../../browsercall/lines'); // eslint-disable-line global-require
async function callStatus(user) {
  const s = await CFG().load();
  let lines = [];
  let reason = null;
  if (s.mode === 'Off') reason = 'Calling from the browser is switched Off. An Admin switches it to Test or Live in Omni-Channel > AI Voice > Browser calling.';
  else if (!C.canWork(user)) reason = 'Your role can read the CRM but not call from it.';
  else {
    lines = (await LINES().usableBy(user)).map((l) => ({ id: l.id, name: l.name, typeLabel: l.typeLabel, builtIn: !!l.builtIn }));
    if (!lines.length) reason = 'Your role may not use the office phone lines. An Admin adds your role in Browser calling > Who may call.';
  }
  return S.okBody({ canCall: !reason, reason, mode: s.mode, testMode: s.mode === 'Test', recording: !!s.record, lines, wssConfigured: !!CFG().ENV.wssUrl });
}
async function callSession(user) {
  const st = (await callStatus(user)).body;
  if (!st.canCall) return S.fail(403, st.reason);
  if (!CFG().ENV.wssUrl) return S.fail(503, 'The phone system address (BROWSER_CALL_WSS_URL) is not set up yet.');
  const s = await require('../../browsercall/provision').startSession(user.id); // eslint-disable-line global-require
  return S.okBody({ wssUrl: CFG().ENV.wssUrl, domain: CFG().ENV.sipDomain, extension: s.extension, authUser: s.extension, password: s.password, expiresAt: s.expiresAt, iceServers: [{ urls: CFG().ENV.stun }], displayName: clip(user.name, 40) });
}
async function placeCall(user, { kind, id, lineId, to } = {}) {
  const row = await C.editable(user, kind, id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const s = await CFG().load();
  if (s.mode === 'Off') return S.fail(403, 'Calling from the browser is switched Off. An Admin switches it to Test or Live in Omni-Channel > AI Voice > Browser calling.');
  const who = await phoneOf(kind, row);
  const core = require('../../utils/messagingCore'); // eslint-disable-line global-require
  const n = core.normalizeMobile(to || who.phone);
  if (!n.ok) return S.fail(400, (to || who.phone) ? `That number does not look right: ${n.reason}` : 'This record has no phone number.');
  if (n.cc !== '91') return S.fail(400, 'Only Indian numbers can be called on the office lines.');
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  if (await CMP.optedOut('call', n.national).catch(() => false)) return S.fail(409, 'This number is marked "do not call".');
  if (s.mode === 'Test' && !s.testNumbers.includes(n.national)) return S.fail(403, "Test mode: only the Admin's test phone numbers can be called.", { code: 'TEST_MODE' });
  const ln = await LINES().resolveForCall(user, lineId);
  if (!ln.ok) return S.fail(ln.code, ln.reason, { code: 'LINE' });
  const ext = await BC().one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=? AND "active"=1', user.id);
  if (!ext) return S.fail(409, 'Start the phone first (no extension for your login yet).');
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  if (await BC().one(`SELECT "id" FROM "BrowserCall" WHERE "userId"=? AND "direction"='outbound' AND "status" IN ${LIVE} AND "startAt">?`, user.id, hourAgo)) return S.fail(409, 'You already have a call in progress.');
  if (ln.line.maxCalls) {
    const used = await BC().one(`SELECT COUNT(*) AS n FROM "BrowserCall" WHERE "lineId"=? AND "status" IN ${LIVE} AND "startAt">?`, ln.line.id, hourAgo);
    if (used && Number(used.n) >= ln.line.maxCalls) return S.fail(409, `All ${ln.line.maxCalls} calls of the line "${ln.line.name}" are in use. Try again in a moment or pick another line.`, { code: 'LINE_FULL' });
  }
  const callId = crypto.randomUUID(); const tok = crypto.randomBytes(12).toString('hex'); const now = BC().nowIso();
  await BC().run('INSERT INTO "BrowserCall" ("id","token","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus") VALUES (?,?,?,?,?,?,?,?,\'outbound\',?,\'initiated\',?,?,?,?,?,?)',
    callId, tok, `crm:${kind}:${row.id}`, null, user.id, clip(user.name, 80), n.national, ext.extension, s.mode, now, now, now, ln.line.id, ln.line.name, s.record ? 'pending' : 'off');
  const act = await C.systemActivity(C.linksFor(kind, row), { kind: 'call', subject: `Call from the browser to ${who.name || n.national}`, note: `Calling on ${ln.line.name}… (the result is added when the call ends)${s.mode === 'Test' ? ' · test mode' : ''}`, byId: user.id, byName: user.name });
  await B.run('UPDATE "CrmActivity" SET "providerRef" = ?, "deliveryStatus" = \'Calling\' WHERE "id" = ?', `bc:${callId}`, act.id);
  await S.audit(user, 'CRM browser call started', 'CrmActivity', act.id, `ext ${ext.extension} -> ${core.maskMobile(n.national)} on ${ln.line.name}`);
  return S.okBody({ callId, token: tok, number: n.national, candidate: { id: `crm:${kind}:${row.id}`, name: who.name || n.national }, line: { id: ln.line.id, name: ln.line.name, header: ln.line.header }, activityId: act.id });
}
const mmss = (s) => { const n = Math.max(0, Number(s) || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
/** The calls' results on the CRM timeline (each pass: rows still open, or finished but not yet written). */
async function syncCalls() {
  const acts = await B.all('SELECT "id", "providerRef", "deliveryStatus", "leadId", "dealId", "accountId", "contactId" FROM "CrmActivity" WHERE "providerRef" LIKE \'bc:%\' AND COALESCE("deliveryStatus", \'\') IN (\'Calling\', \'Answered\', \'Processing\') LIMIT 200');
  let n = 0;
  for (const a of acts) {
    /* eslint-disable no-await-in-loop */
    const c = await BC().one('SELECT * FROM "BrowserCall" WHERE "id" = ?', a.providerRef.slice(3));
    if (!c) continue; // eslint-disable-line no-continue
    const final = ['completed', 'failed', 'missed', 'cancelled', 'busy'].includes(c.status);
    if (!final) continue; // eslint-disable-line no-continue
    const answered = !!c.answerAt;
    let sm = null; try { sm = c.summary ? JSON.parse(c.summary) : null; } catch { sm = null; }
    const lines = [answered ? `Answered · talk ${mmss(c.talkSec)} · ${c.lineName || 'office line'}` : `Not answered: ${c.hangupReason || c.status}`];
    if (answered) {
      if (c.recordingStatus === 'done') lines.push('Recording kept (play it from the record: Web & engagement > Calls).');
      else if (c.recordingNote) lines.push(c.recordingNote);
      if (c.summaryText) lines.push(`What was said: ${c.summaryText}`);
      else if (sm && sm.discussed) lines.push(`What was said: ${sm.discussed}`);
      else if (c.transcriptSource && !c.transcript) lines.push(c.transcriptSource);
    }
    const doneNow = !answered || !!c.processedAt || c.recordingStatus === 'off';
    const status = !answered ? 'No answer' : (doneNow ? 'Done' : 'Processing');
    await B.run('UPDATE "CrmActivity" SET "note" = ?, "deliveryStatus" = ?, "deliveryDetail" = ? WHERE "id" = ?', lines.join('\n'), status, answered ? `Talk ${mmss(c.talkSec)}` : 'No answer', a.id);
    n += 1;
    /* eslint-enable no-await-in-loop */
  }
  return { updated: n };
}
async function callRowFor(user, callId, { listen = false } = {}) {
  const c = await BC().one('SELECT * FROM "BrowserCall" WHERE "id" = ?', String(callId || '').slice(0, 60));
  const m = c && /^crm:(lead|deal|account|contact):(.+)$/.exec(c.candidateId || '');
  if (!m) return { error: S.fail(404, 'Call not found.') };
  const row = await C.visible(user, m[1], m[2]);
  if (!row) return { error: S.fail(404, 'Call not found.') };
  if (listen && C.role(user) === 'view') return { error: S.fail(403, 'Your role may not play call recordings or read what was said.') };
  return { c, kind: m[1], row };
}
async function callsOf(user, kind, id) {
  const row = await C.visible(user, kind, id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const rows = await BC().all('SELECT * FROM "BrowserCall" WHERE "candidateId" = ? ORDER BY "startAt" DESC LIMIT 50', `crm:${kind}:${row.id}`);
  const listen = C.role(user) !== 'view';
  return S.okBody({ mayListen: listen, calls: rows.map((c) => ({ id: c.id, at: c.startAt, by: c.userName, number: `••••${String(c.toNumber).slice(-4)}`, status: c.status, talkSec: c.talkSec, line: c.lineName, hasRecording: !!c.recordingPath, hasTranscript: !!c.transcript, summary: listen ? (c.summaryText || null) : null, recordingStatus: c.recordingStatus })) });
}
async function transcriptOf(user, callId) {
  const g = await callRowFor(user, callId, { listen: true });
  if (g.error) return g.error;
  await S.audit(user, 'CRM call transcript read', 'BrowserCall', g.c.id, g.c.candidateId);
  return S.okBody({ id: g.c.id, transcript: g.c.transcript || null, source: g.c.transcriptSource || null, summary: g.c.summaryText || null });
}
async function recordingFile(user, callId) {
  const g = await callRowFor(user, callId, { listen: true });
  if (g.error) return g.error;
  const REC = require('../../browsercall/recording'); // eslint-disable-line global-require
  const file = g.c.recordingPath ? REC.resolveStored(g.c.recordingPath) : null;
  if (!file || !fs.existsSync(file)) return S.fail(404, g.c.recordingNote || 'There is no recording of this call.');
  await S.audit(user, 'CRM call recording played', 'BrowserCall', g.c.id, g.c.candidateId);
  return { status: 200, path: file, mime: file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' };
}

// ================================================================== 07.05 a call made from the person's own phone: its recording uploaded
function toWav(src, dst) {
  return new Promise((resolve) => {
    require('child_process').execFile(CFG().ENV.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dst], { timeout: 180000, windowsHide: true }, (e) => resolve(!e && fs.existsSync(dst))); // eslint-disable-line global-require
  });
}
async function transcribeUpload(user, { kind, id, name }, buf) {
  const row = await C.editable(user, kind, id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  if (!Buffer.isBuffer(buf) || buf.length < 100) return S.fail(400, 'Choose the call recording (an audio file).');
  if (buf.length > 20 * 1024 * 1024) return S.fail(400, 'The recording is larger than 20 MB.');
  const REC = require('../../browsercall/recording'); // eslint-disable-line global-require
  const isWav = buf.slice(0, 4).toString('latin1') === 'RIFF';
  let wav = isWav ? buf : null;
  if (!wav) {
    const src = path.join(os.tmpdir(), `tl-crm-up-${crypto.randomBytes(6).toString('hex')}`);
    const dst = `${src}.wav`;
    fs.writeFileSync(src, buf);
    try { if (await toWav(src, dst)) wav = fs.readFileSync(dst); } finally { for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch { /* gone */ } } }
  }
  if (!wav && !C.sandbox()) return S.fail(400, 'This audio could not be read (ffmpeg is needed for MP3 / M4A / AMR recordings). A WAV file always works.');
  const tr = await REC.transcribe(wav || buf, null);
  if (!tr.text) return S.fail(409, tr.reason || 'Speech-to-text is not set up.');
  const sm = REC.codeSummary(REC.mask(tr.text));
  const say = [sm.discussed && `What was said: ${sm.discussed}`, sm.interest && `Interest: ${sm.interest}`, sm.nextStep && `Next step: ${sm.nextStep}`, sm.followUpDate && `Follow-up: ${sm.followUpDate}`].filter(Boolean).join('\n');
  const act = await C.systemActivity(C.linksFor(kind, row), { kind: 'call', subject: `Call recording transcribed${name ? `: ${clip(name, 80)}` : ''}`, note: `${say}\n\n— Transcript (${tr.source || 'speech-to-text'}) —\n${clip(tr.text, 3000)}`, byId: user.id, byName: user.name });
  return S.okBody({ ok: true, activityId: act.id, transcript: tr.text, summary: say, source: tr.source });
}

// ================================================================== 07.04 the power dialer
async function dialTargets(user, { source, segmentId, ids, max = 100 } = {}) {
  const r = C.role(user);
  const own = S.seesAll(r) ? '' : ' AND x."ownerId" = ?';
  const p = S.seesAll(r) ? [] : [user.id];
  if (source === 'followups') {
    const rows = await B.all(`SELECT DISTINCT 'lead' AS "kind", x."id", x."contactName" AS "name", x."company", x."phone" FROM "CrmTask" t JOIN "CrmLead" x ON x."id" = t."leadId" WHERE t."status" = 'Open' AND t."dueDate" <= ? AND t."ownerId" = ? AND x."phone" IS NOT NULL ORDER BY t."dueDate" LIMIT ${max}`, S.istToday(), user.id);
    return rows;
  }
  if (source === 'segment') {
    const MK = require('./marketing'); // eslint-disable-line global-require
    const seg = await MK.segmentRows(user, segmentId);
    if (seg.error) return seg;
    return seg.rows.filter((x) => x.phone).slice(0, max).map((x) => ({ kind: x.kind, id: x.id, name: x.name, company: x.company, phone: x.phone }));
  }
  if (source === 'leads') {
    const list = (Array.isArray(ids) ? ids : []).map((v) => String(v).slice(0, 60)).slice(0, max);
    if (!list.length) return [];
    return B.all(`SELECT 'lead' AS "kind", x."id", x."contactName" AS "name", x."company", x."phone" FROM "CrmLead" x WHERE x."id" IN (${list.map(() => '?').join(',')})${own}`, ...list, ...p);
  }
  // the open leads not touched for a week, hot first
  return B.all(`SELECT 'lead' AS "kind", x."id", x."contactName" AS "name", x."company", x."phone" FROM "CrmLead" x WHERE x."status" IN ('New', 'Contacted', 'Qualified') AND x."phone" IS NOT NULL${own}
    AND NOT EXISTS (SELECT 1 FROM "CrmActivity" a WHERE a."leadId" = x."id" AND a."kind" = 'call' AND a."at" >= ?) ORDER BY CASE x."rating" WHEN 'Hot' THEN 0 WHEN 'Warm' THEN 1 ELSE 2 END, x."updatedAt" LIMIT ${max}`, ...p, new Date(Date.now() - 7 * 86400000).toISOString());
}
async function createDialList(user, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const got = await dialTargets(user, body);
  if (got.error) return got.error;
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  const seen = new Set(); const items = [];
  for (const t of got) {
    const ph = S.phone10(t.phone);
    if (ph.length !== 10 || seen.has(ph)) continue; // eslint-disable-line no-continue
    if (await CMP.optedOut('call', ph).catch(() => false)) continue; // eslint-disable-line no-await-in-loop, no-continue
    seen.add(ph); items.push({ ...t, phone: ph });
  }
  if (!items.length) return S.fail(400, 'Nobody with a phone number in this list.');
  const id = C.newId('dl'); const now = B.nowIso();
  const name = clip(body.name, 120) || `Calls ${S.istToday().split('-').reverse().join('/')}`;
  await B.run('INSERT INTO "CrmDialList" ("id","name","ownerId","ownerName","status","total","done","byId","byName","createdAt","updatedAt") VALUES (?,?,?,?,\'Open\',?,0,?,?,?,?)', id, name, user.id, user.name || null, items.length, user.id, user.name || null, now, now);
  let pos = 0;
  for (const t of items) {
    pos += 1;
    // eslint-disable-next-line no-await-in-loop
    await B.run('INSERT INTO "CrmDialItem" ("id","listId","pos","kind","recordId","name","company","phone","status") VALUES (?,?,?,?,?,?,?,?,\'Waiting\')', C.newId('di'), id, pos, t.kind, t.id, clip(t.name, 200), clip(t.company, 200), t.phone);
  }
  return S.okBody({ ok: true, id, total: items.length });
}
async function dialLists(user) {
  const all = C.isManager(user);
  const rows = await B.all(`SELECT * FROM "CrmDialList" WHERE ${all ? '1=1' : '"ownerId" = ?'} ORDER BY "createdAt" DESC LIMIT 50`, ...(all ? [] : [user.id]));
  return S.okBody({ lists: rows });
}
async function dialList(user, id) {
  const l = await B.one('SELECT * FROM "CrmDialList" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!l || !(l.ownerId === user.id || C.isManager(user))) return S.fail(404, 'This list is not there, or it is not yours.');
  const items = await B.all('SELECT * FROM "CrmDialItem" WHERE "listId" = ? ORDER BY "pos"', l.id);
  return S.okBody({ list: l, items, next: items.find((i) => i.status === 'Waiting') || null });
}
async function dialOutcome(user, itemId, body = {}) {
  const it = await B.one('SELECT i.*, l."ownerId" AS "listOwner" FROM "CrmDialItem" i JOIN "CrmDialList" l ON l."id" = i."listId" WHERE i."id" = ?', String(itemId || '').slice(0, 60));
  if (!it || it.listOwner !== user.id) return S.fail(404, 'This person is not on your list.');
  if (it.status !== 'Waiting') return S.fail(400, 'This person is done already.');
  const skip = body.skip === true;
  if (!skip) {
    const out = await S.addActivity(user, { kind: 'call', [`${it.kind}Id`]: it.recordId, subject: `Call (dialer)${body.outcome ? `: ${clip(body.outcome, 60)}` : ''}`, note: clip(body.note, 2000) || undefined, outcome: clip(body.outcome, 60) || undefined, followUp: body.followUpDate ? { dueDate: body.followUpDate, title: `Follow up: ${it.name || it.company || 'call'}` } : undefined });
    if (out.status !== 200) return out;
  }
  await B.run('UPDATE "CrmDialItem" SET "status" = ?, "outcome" = ?, "note" = ?, "calledAt" = ? WHERE "id" = ?', skip ? 'Skipped' : 'Done', clip(body.outcome, 60), clip(body.note, 500), B.nowIso(), it.id);
  await B.run('UPDATE "CrmDialList" SET "done" = (SELECT COUNT(*) FROM "CrmDialItem" WHERE "listId" = ? AND "status" != \'Waiting\'), "updatedAt" = ? WHERE "id" = ?', it.listId, B.nowIso(), it.listId);
  const next = await B.one('SELECT * FROM "CrmDialItem" WHERE "listId" = ? AND "status" = \'Waiting\' ORDER BY "pos" LIMIT 1', it.listId);
  if (!next) await B.run('UPDATE "CrmDialList" SET "status" = \'Done\' WHERE "id" = ?', it.listId);
  return S.okBody({ ok: true, next });
}

// ================================================================== 07.08 SMS from a record
async function sendSms(user, { kind, id, to, text } = {}) {
  const row = await C.editable(user, kind, id);
  if (!row) return S.fail(404, 'This record is not there, or it is not yours.');
  const body = clip(text, 640);
  if (!body) return S.fail(400, 'Write the SMS first.');
  const who = await phoneOf(kind, row);
  const m = require('../../utils/messagingCore').normalizeMobile(to || who.phone); // eslint-disable-line global-require
  if (!m.ok) return S.fail(400, (to || who.phone) ? `That number does not look right: ${m.reason}` : 'This record has no phone number. Type one in the To box.');
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  if (await CMP.optedOut('sms', m.e164).catch(() => false) || await CMP.optedOut('whatsapp', m.e164).catch(() => false)) return S.fail(409, 'This number asked not to be messaged. TeamLink does not send to it.');
  const res = await require('../../utils/messaging').send('SMS', { to: m.e164, kind: 'bulk', text: body, vars: [body], actorUserId: user.id, meta: { audience: 'crm', personName: who.name, senderUserId: user.id, purpose: 'CRM SMS' } }); // eslint-disable-line global-require
  if (!res.ok) return S.fail(res.notConfigured ? 409 : 502, res.notConfigured ? `SMS is not connected: ${res.error} An Admin connects an SMS gateway with a DLT-approved template in Administration > Integrations > SMS Gateway.` : `The SMS was not sent: ${res.error || 'the gateway refused it.'}`, { notConfigured: !!res.notConfigured });
  const act = await C.systemActivity(C.linksFor(kind, row), { kind: 'note', subject: 'SMS sent', note: `To +${m.e164}\n\n${body}`, byId: user.id, byName: user.name });
  await B.run('UPDATE "CrmActivity" SET "providerRef" = ?, "deliveryStatus" = \'Sent\', "deliveryDetail" = ? WHERE "id" = ?', res.providerRef ? String(res.providerRef).slice(0, 200) : null, res.sandbox ? 'Test server: not really sent' : 'Accepted by the SMS gateway', act.id);
  await S.update({ lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', contact: 'CrmContact' }[kind], row.id, { updatedAt: B.nowIso() }).catch(() => null);
  return S.okBody({ ok: true, to: `+${m.e164}`, sandbox: !!res.sandbox });
}
async function smsReady() {
  const st = await require('../../channels').status('SMS').catch(() => ({ configured: false, reason: 'SMS is not connected.' })); // eslint-disable-line global-require
  return S.okBody({ ready: !!st.configured, reason: st.configured ? '' : (st.reason || 'SMS is not connected.') });
}

// ================================================================== 07.09 incoming calls to the owner
async function routeInbound({ from, to, callSid } = {}) {
  if (!(await B.on('inboundRouting'))) return { action: 'default', reason: 'switched off' };
  const rec = await C.recordByPhone(from);
  if (!rec) return { action: 'default', reason: 'unknown caller' };
  const prisma = require('../../db'); // eslint-disable-line global-require
  const emp = rec.ownerId ? await prisma.employee.findUnique({ where: { userId: rec.ownerId } }).catch(() => null) : null;
  const ph = S.phone10(emp && emp.phone);
  const ref = clip(callSid, 80);
  if (!ref || !(await B.one('SELECT 1 AS x FROM "CrmActivity" WHERE "providerRef" = ?', `in:${ref}`))) {
    const act = await C.systemActivity(rec.links, { kind: 'call', subject: `Incoming call from ${rec.name || from}`, note: ph ? `Put through to ${rec.ownerName || 'the owner'}.` : `${rec.ownerName || 'The owner'} has no phone on their employee profile: the call went to the company line.`, byName: 'Phone system' });
    if (ref) await B.run('UPDATE "CrmActivity" SET "providerRef" = ? WHERE "id" = ?', `in:${ref}`, act.id);
    if (rec.ownerId) await C.notify([rec.ownerId], `${rec.name || from} is calling`, `Incoming call${to ? ` on ${to}` : ''}. Open: /crm/${rec.kind === 'contact' ? 'accounts' : `${rec.kind}s`}?open=${rec.kind}:${rec.id}`, `crm-b-in|${ref || Date.now()}`);
  }
  if (ph.length !== 10) return { action: 'default', reason: 'owner has no phone', record: { kind: rec.kind, id: rec.id } };
  return { action: 'connect', number: `0${ph}`, ownerName: rec.ownerName, record: { kind: rec.kind, id: rec.id } };
}

// ================================================================== 07.10 website chat
async function siteId() {
  const st = await B.settings();
  if (st.siteId) return st.siteId;
  const v = `site_${C.token(12)}`;
  await B.saveSettings({ siteId: v });
  return v;
}
async function chatStart(body = {}, { ip } = {}) {
  const st = await B.settings();
  if (!st.siteId || body.k !== st.siteId) return { status: 401, body: { error: 'This chat is not set up for this site.' } };
  if (!st.chatWidget) return { status: 200, body: { offline: true, message: 'Chat is offline right now. Leave your number or email and we will call you back.' } };
  const msg = clip(body.message, 2000);
  if (!msg) return { status: 400, body: { error: 'Write your message.' } };
  if (clip(body.website_url, 100)) return { status: 200, body: { ok: true } }; // the robot trap
  const now = B.nowIso(); const id = C.newId('chat'); const tok = C.token(18);
  const email = C.validEmail(body.email) ? C.lower(body.email) : null;
  const phone = clip(body.phone, 40);
  let leadId = null;
  if (email || phone) {
    const l = await C.makeLead({ company: clip(body.company, 200) || clip(body.name, 200) || email || phone, name: clip(body.name, 200), phone, email, source: 'Website', notes: `Website chat: ${msg}`, utm: { pageUrl: body.pageUrl, utmSource: body.utm_source, utmCampaign: body.utm_campaign }, visitorId: clip(body.visitorId, 60), byName: 'Website chat' });
    if (l.lead) leadId = l.lead.id;
  }
  const lead = leadId ? await S.getRow('lead', leadId) : null;
  await B.run('INSERT INTO "CrmChat" ("id","token","visitorId","name","email","phone","pageUrl","status","leadId","assigneeId","assigneeName","unread","lastAt","createdAt") VALUES (?,?,?,?,?,?,?,\'Open\',?,?,?,1,?,?)',
    id, C.sha(tok), clip(body.visitorId, 60), clip(body.name, 120), email, phone, clip(body.pageUrl, 500), leadId, lead ? lead.ownerId : null, lead ? lead.ownerName : null, now, now);
  await B.run('INSERT INTO "CrmChatMsg" ("id","chatId","side","body","byName","at") VALUES (?,?,\'visitor\',?,?,?)', C.newId('cm'), id, msg, clip(body.name, 120) || 'Visitor', now);
  const tell = lead && lead.ownerId ? [lead.ownerId] : (await S.ownerOptions()).map((o) => o.id);
  await C.notify(tell, `Website chat${body.name ? ` from ${clip(body.name, 60)}` : ''}`, `${msg.slice(0, 200)}\nOpen: /crm/followups?tab=inbox`, `crm-b-chat|${id}`);
  void ip;
  return { status: 200, body: { ok: true, chatId: id, token: tok, greeting: 'Thank you. Someone from our team will answer here in a moment.' } };
}
async function chatOfToken(id, tok) {
  const c = await B.one('SELECT * FROM "CrmChat" WHERE "id" = ?', String(id || '').slice(0, 60));
  return c && tok && C.sha(tok) === c.token ? c : null;
}
async function chatVisitorSay(id, { token: tok, body } = {}) {
  const c = await chatOfToken(id, tok);
  if (!c) return { status: 404, body: { error: 'This chat has ended.' } };
  const msg = clip(body, 2000);
  if (!msg) return { status: 400, body: { error: 'Write your message.' } };
  const n = await B.one('SELECT COUNT(*) AS "n" FROM "CrmChatMsg" WHERE "chatId" = ? AND "side" = \'visitor\' AND "at" >= ?', c.id, new Date(Date.now() - 60000).toISOString());
  if (Number(n.n) > 15) return { status: 429, body: { error: 'Please wait a moment.' } };
  const now = B.nowIso();
  await B.run('INSERT INTO "CrmChatMsg" ("id","chatId","side","body","byName","at") VALUES (?,?,\'visitor\',?,?,?)', C.newId('cm'), c.id, msg, c.name || 'Visitor', now);
  await B.run('UPDATE "CrmChat" SET "unread" = "unread" + 1, "lastAt" = ?, "status" = \'Open\' WHERE "id" = ?', now, c.id);
  return { status: 200, body: { ok: true } };
}
async function chatVisitorRead(id, { token: tok, since } = {}) {
  const c = await chatOfToken(id, tok);
  if (!c) return { status: 404, body: { error: 'This chat has ended.' } };
  const rows = await B.all('SELECT "side", "body", "byName", "at" FROM "CrmChatMsg" WHERE "chatId" = ? AND "at" > ? ORDER BY "at" LIMIT 100', c.id, String(since || '1970'));
  return { status: 200, body: { messages: rows.map((m) => ({ side: m.side, body: m.body, by: m.side === 'agent' ? (String(m.byName || '').split(' ')[0] || 'TeamLink') : 'You', at: m.at })), closed: c.status === 'Closed' } };
}
const mayChat = (user, c) => S.seesAll(C.role(user)) || !c.assigneeId || c.assigneeId === user.id;
async function chats(user, { status = 'Open' } = {}) {
  const rows = await B.all(`SELECT c.*, (SELECT m."body" FROM "CrmChatMsg" m WHERE m."chatId" = c."id" ORDER BY m."at" DESC LIMIT 1) AS "last" FROM "CrmChat" c WHERE ${['Open', 'Closed'].includes(status) ? 'c."status" = ?' : '1=1'} ORDER BY c."lastAt" DESC LIMIT 100`, ...(['Open', 'Closed'].includes(status) ? [status] : []));
  return S.okBody({ on: await B.on('chatWidget'), chats: rows.filter((c) => mayChat(user, c)).map(({ token: _t, ...c }) => c) });
}
async function chatDetail(user, id) {
  const c = await B.one('SELECT * FROM "CrmChat" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c || !mayChat(user, c)) return S.fail(404, 'This chat is not there, or another person has it.');
  await B.run('UPDATE "CrmChat" SET "unread" = 0 WHERE "id" = ?', c.id);
  const { token: _t, ...chat } = c;
  return S.okBody({ chat, messages: await B.all('SELECT * FROM "CrmChatMsg" WHERE "chatId" = ? ORDER BY "at" LIMIT 500', c.id) });
}
async function chatAct(user, id, body = {}) {
  const no = C.needWork(user); if (no) return no;
  const c = await B.one('SELECT * FROM "CrmChat" WHERE "id" = ?', String(id || '').slice(0, 60));
  if (!c || !mayChat(user, c)) return S.fail(404, 'This chat is not there, or another person has it.');
  const now = B.nowIso();
  if (body.action === 'reply') {
    const msg = clip(body.body, 2000);
    if (!msg) return S.fail(400, 'Write the answer first.');
    await B.run('INSERT INTO "CrmChatMsg" ("id","chatId","side","body","byId","byName","at") VALUES (?,?,\'agent\',?,?,?,?)', C.newId('cm'), c.id, msg, user.id, user.name || null, now);
    await B.run('UPDATE "CrmChat" SET "assigneeId" = COALESCE("assigneeId", ?), "assigneeName" = COALESCE("assigneeName", ?), "lastAt" = ?, "unread" = 0 WHERE "id" = ?', user.id, user.name || null, now, c.id);
    return S.okBody({ ok: true });
  }
  if (body.action === 'lead') {
    if (c.leadId) return S.okBody({ ok: true, leadId: c.leadId });
    const l = await C.makeLead({ company: clip(body.company, 200) || c.name || c.email || c.phone, name: c.name, phone: clip(body.phone, 40) || c.phone, email: clip(body.email, 200) || c.email, source: 'Website', notes: 'From the website chat', utm: { pageUrl: c.pageUrl }, visitorId: c.visitorId, byName: 'Website chat', ownerId: user.id });
    if (l.error) return S.fail(400, l.error);
    await B.run('UPDATE "CrmChat" SET "leadId" = ? WHERE "id" = ?', l.lead.id, c.id);
    return S.okBody({ ok: true, leadId: l.lead.id, duplicate: l.duplicate });
  }
  if (body.action === 'close') {
    await B.run('UPDATE "CrmChat" SET "status" = \'Closed\', "lastAt" = ? WHERE "id" = ?', now, c.id);
    if (c.leadId) {
      const msgs = await B.all('SELECT * FROM "CrmChatMsg" WHERE "chatId" = ? ORDER BY "at" LIMIT 300', c.id);
      const text = msgs.map((m) => `${m.side === 'agent' ? (m.byName || 'Us') : (c.name || 'Visitor')}: ${m.body}`).join('\n');
      await C.systemActivity({ leadId: c.leadId }, { kind: 'note', subject: 'Website chat', note: text, byId: user.id, byName: user.name });
    }
    return S.okBody({ ok: true });
  }
  return S.fail(400, 'Say what to do.');
}
// the bubble on the company website (served as JavaScript by routes/crmBPublic.js)
function widgetJs(base, k) {
  return `(function(){if(window.__tlChat)return;window.__tlChat=1;var B=${JSON.stringify(base)},K=${JSON.stringify(k)},S=localStorage,vid=S.getItem('tl_vid')||('v'+Math.random().toString(36).slice(2)+Date.now().toString(36));S.setItem('tl_vid',vid);
var st=JSON.parse(S.getItem('tl_chat')||'null'),since='',d=document,box,log,inp,timer;
function el(t,css,txt){var e=d.createElement(t);if(css)e.style.cssText=css;if(txt)e.textContent=txt;return e}
function add(side,txt){var m=el('div','margin:6px 0;padding:8px 10px;border-radius:10px;max-width:85%;font-size:14px;line-height:1.4;'+(side==='agent'?'background:#eef2ff;':'background:#2563eb;color:#fff;margin-left:auto;'),txt);log.appendChild(m);log.scrollTop=log.scrollHeight}
function post(p,b){return fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function poll(){if(!st)return;fetch(B+'/api/crm-public/b/w/chat/'+st.id+'?token='+encodeURIComponent(st.t)+'&since='+encodeURIComponent(since)).then(function(r){return r.json()}).then(function(j){(j.messages||[]).forEach(function(m){since=m.at;if(m.side==='agent')add('agent',m.by+': '+m.body)})}).catch(function(){})}
function open(){if(box){box.style.display=box.style.display==='none'?'flex':'none';return}
box=el('div','position:fixed;right:16px;bottom:80px;width:320px;max-width:calc(100vw - 32px);height:420px;background:#fff;border:1px solid #dbe1ea;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.15);display:flex;flex-direction:column;z-index:2147483000;font-family:system-ui,Segoe UI,Roboto,sans-serif');
var h=el('div','padding:12px 14px;background:#2563eb;color:#fff;border-radius:14px 14px 0 0;font-weight:600','Chat with us');box.appendChild(h);
log=el('div','flex:1;overflow:auto;padding:10px');box.appendChild(log);
var f=el('div','padding:8px;border-top:1px solid #eef0f4');var who=el('div','display:'+(st?'none':'flex')+';gap:6px;margin-bottom:6px');
var nm=el('input','flex:1;min-width:0;padding:7px;border:1px solid #cfd6e3;border-radius:7px');nm.placeholder='Name';var ct=el('input','flex:1;min-width:0;padding:7px;border:1px solid #cfd6e3;border-radius:7px');ct.placeholder='Phone or email';who.appendChild(nm);who.appendChild(ct);f.appendChild(who);
inp=el('textarea','width:100%;box-sizing:border-box;padding:8px;border:1px solid #cfd6e3;border-radius:7px;font:inherit;height:52px');inp.placeholder='Type your message';f.appendChild(inp);
var sb=el('button','margin-top:6px;width:100%;padding:9px;background:#2563eb;color:#fff;border:0;border-radius:7px;cursor:pointer','Send');f.appendChild(sb);box.appendChild(f);d.body.appendChild(box);
add('agent','Hello! How can we help you?');
sb.onclick=function(){var t=inp.value.trim();if(!t)return;inp.value='';add('visitor',t);
if(st){post('/api/crm-public/b/w/chat/'+st.id+'/msg',{token:st.t,body:t});return}
var c=ct.value.trim();post('/api/crm-public/b/w/chat/start',{k:K,visitorId:vid,name:nm.value.trim(),email:/@/.test(c)?c:'',phone:/@/.test(c)?'':c,message:t,pageUrl:location.href}).then(function(j){if(j.offline){add('agent',j.message);return}if(j.chatId){st={id:j.chatId,t:j.token};S.setItem('tl_chat',JSON.stringify(st));who.style.display='none';add('agent',j.greeting);timer=setInterval(poll,4000)}else add('agent',j.error||'Please try again.')})};
if(st)timer=setInterval(poll,4000)}
var b=el('button','position:fixed;right:16px;bottom:16px;width:56px;height:56px;border-radius:50%;background:#2563eb;color:#fff;border:0;font-size:24px;cursor:pointer;box-shadow:0 6px 18px rgba(37,99,235,.4);z-index:2147483000','\\u{1F4AC}');b.setAttribute('aria-label','Chat with us');b.onclick=open;
(d.readyState==='loading'?d.addEventListener('DOMContentLoaded',function(){d.body.appendChild(b)}):d.body.appendChild(b))})();`;
}

// ================================================================== 07.11 one inbox across all leads, deals and customers
const CH_OF = (a) => (a.kind === 'note' && /\bSMS\b/.test(a.subject || '') ? 'SMS' : ({ email: 'Email', whatsapp: 'WhatsApp', call: 'Call' }[a.kind] || 'Note'));
const INBOUND = /^(Replied on|Asked us to stop|Incoming call)/;
async function inbox(user, { channel = '', waiting = '', q = '' } = {}) {
  const r = C.role(user);
  const where = ['(a."kind" IN (\'email\', \'whatsapp\', \'call\') OR (a."kind" = \'note\' AND a."subject" LIKE \'%SMS%\'))'];
  const params = [];
  if (!S.seesAll(r)) { where.push('COALESCE(l."ownerId", d."ownerId", ct."ownerId", ac."ownerId") = ?'); params.push(user.id); }
  const text = clip(q, 80);
  if (text) { where.push('(l."company" LIKE ? OR d."title" LIKE ? OR ac."name" LIKE ? OR ct."name" LIKE ? OR a."subject" LIKE ?)'); params.push(...Array(5).fill(`%${text}%`)); }
  const rows = await B.all(`SELECT a."id", a."kind", a."subject", a."note", a."at", a."byName", a."deliveryStatus", a."leadId", a."dealId", a."accountId", a."contactId",
      l."company" AS "leadName", l."ownerName" AS "leadOwner", d."title" AS "dealName", d."ownerName" AS "dealOwner", ac."name" AS "accountName", ac."ownerName" AS "accountOwner", ct."name" AS "contactName"
    FROM "CrmActivity" a LEFT JOIN "CrmLead" l ON l."id" = a."leadId" LEFT JOIN "CrmDeal" d ON d."id" = a."dealId" LEFT JOIN "CrmAccount" ac ON ac."id" = a."accountId" LEFT JOIN "CrmContact" ct ON ct."id" = a."contactId"
    WHERE ${where.join(' AND ')} ORDER BY a."at" DESC LIMIT 2000`, ...params);
  const threads = new Map();
  for (const a of rows) {
    const key = a.leadId ? `lead:${a.leadId}` : a.dealId ? `deal:${a.dealId}` : a.contactId ? `contact:${a.contactId}` : a.accountId ? `account:${a.accountId}` : null;
    if (!key) continue; // eslint-disable-line no-continue
    const ch = CH_OF(a);
    if (!threads.has(key)) {
      const [kind, id] = key.split(':');
      threads.set(key, {
        kind, id, name: a.leadName || a.dealName || a.contactName || a.accountName || '', owner: a.leadOwner || a.dealOwner || a.accountOwner || '',
        lastAt: a.at, lastChannel: ch, lastDirection: INBOUND.test(a.subject || '') ? 'in' : 'out', lastText: clip(String(a.note || a.subject || '').replace(/^To [^\n]+\n\n/, ''), 160), lastSubject: a.subject, channels: new Set(), messages: 0,
      });
    }
    const t = threads.get(key);
    t.channels.add(ch); t.messages += 1;
  }
  let list = [...threads.values()].map((t) => ({ ...t, channels: [...t.channels], waiting: t.lastDirection === 'in' }));
  if (channel) list = list.filter((t) => t.channels.includes(channel));
  if (waiting === '1') list = list.filter((t) => t.waiting);
  list.sort((a, b) => (Number(b.waiting) - Number(a.waiting)) || String(b.lastAt).localeCompare(String(a.lastAt)));
  const chatsOpen = (await chats(user, { status: 'Open' })).body.chats;
  const team = await B.one('SELECT COUNT(*) AS "n" FROM "CrmTeamMail" WHERE "status" = \'Open\'');
  return S.okBody({ threads: list.slice(0, 300), counts: { waiting: list.filter((t) => t.waiting).length, total: list.length, chats: chatsOpen.length, chatUnread: chatsOpen.reduce((s, c) => s + (Number(c.unread) || 0), 0), teamMail: Number(team.n) || 0 } });
}

module.exports = {
  callStatus, callSession, placeCall, syncCalls, callsOf, transcriptOf, recordingFile, transcribeUpload,
  createDialList, dialLists, dialList, dialOutcome,
  sendSms, smsReady, routeInbound,
  siteId, chatStart, chatVisitorSay, chatVisitorRead, chats, chatDetail, chatAct, widgetJs,
  inbox, phoneOf,
};

// ---------------------------------------------------------------------------
// CRM > FOLLOW-UPS AND FIELD WORK, MORE (wave E, 2026-11-24; gaps 05.08, 05.11, 05.12, 14.05).
//
//   REPEATING FOLLOW-UPS  a follow-up may repeat: every day, every working day (Mon-Sat), every week, every 2 weeks, every month or
//                         every 3 months, until a date (or for ever). When one is done (or cancelled with "skip this one") the next one
//                         is made by itself on the next date of the rule (a late one skips ahead to today or later). "Stop repeating"
//                         ends the series; the done ones stay.
//   VIDEO MEETING          a Meeting follow-up gets its own meeting link from Zoom (Server-to-Server OAuth app, Administration >
//                         Integrations > Zoom), Google Meet or Microsoft Teams (the owner's own calendar joined in Follow-ups > Calendar,
//                         else the company calendar account of Administration > Integrations > Calendar Sync - utils/meetingLinks.js).
//                         Nobody is invited by the provider: the link is kept on the follow-up and goes into "Send invite".
//   FIELD VISITS           Check in at a lead / deal / account with the phone's location (and accuracy), check out with what came of it:
//                         one Visit line on the timeline with the time spent and a map link; managers see the day's visits of the team.
//   PHONE CALL             a call from the phone's own dialler comes back with its length measured by the screen (left -> back) and the
//                         outcome; the timeline line carries the minutes.
// ---------------------------------------------------------------------------
const P = require('./plusE');
const S = require('./service');
const DB = require('./schema');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n) => S.clip(v, n);

// ---- 1. repeating follow-ups -------------------------------------------------------------------------------------------------
const RULES = { daily: 'Every day', weekdays: 'Every working day (Mon-Sat)', weekly: 'Every week', fortnightly: 'Every 2 weeks', monthly: 'Every month', quarterly: 'Every 3 months' };
function nextDate(ymd, rule) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (rule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (rule === 'weekdays') { do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0); }
  else if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (rule === 'fortnightly') d.setUTCDate(d.getUTCDate() + 14);
  else if (rule === 'monthly' || rule === 'quarterly') {
    const day = d.getUTCDate(); const step = rule === 'monthly' ? 1 : 3;
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + step);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last)); // the 31st becomes the month's last day
  } else return null;
  return d.toISOString().slice(0, 10);
}
// the first date of the rule after `from` that is today or later
function nextFrom(ymd, rule, today = S.istToday()) {
  let n = nextDate(ymd, rule);
  for (let i = 0; n && n < today && i < 2000; i += 1) n = nextDate(n, rule);
  return n;
}
// what a new follow-up stores about repeating (called from crm/service.js addTaskRow)
function extras(body = {}) {
  const rule = RULES[body.repeat] ? body.repeat : null;
  if (!rule) return {};
  const until = YMD.test(String(body.repeatUntil || '')) ? body.repeatUntil : null;
  return { repeatRule: rule, repeatUntil: until };
}
// the next one of a series, once one is done / skipped (crm/service.js finishTask; cancel below)
async function afterDone(taskId) {
  await P.ensure();
  const row = await DB.one('SELECT * FROM "CrmTask" WHERE "id" = ?', taskId);
  if (!row || !RULES[row.repeatRule]) return null;
  if (await DB.one('SELECT "id" FROM "CrmTask" WHERE "repeatFromId" = ?', row.id)) return null; // made already
  const due = nextFrom(row.dueDate, row.repeatRule);
  if (!due || (row.repeatUntil && due > row.repeatUntil)) return null;
  const now = DB.nowIso();
  const copy = { ...row, id: S.newId('task'), dueDate: due, status: 'Open', doneAt: null, doneNote: null, outcome: null, remindedOn: null, reminderSentAt: null, reminderNote: null, escalatedAt: null, repeatFromId: row.id, meetingUrl: null, meetingProvider: null, meetingRef: null, createdAt: now, updatedAt: now };
  const cols = Object.keys(copy);
  await P.run(`INSERT INTO "CrmTask" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => copy[c]));
  return copy;
}
async function setRepeat(user, id, { repeat, repeatUntil } = {}) {
  await P.ensure();
  const r = S.roleOf(user);
  const row = await S.getRow('CrmTask', String(id || ''));
  if (!S.canEditRow(user, r, row)) return S.fail(404, 'This follow-up is not there, or it is not yours.');
  if (repeat && !RULES[repeat]) return S.fail(400, 'Pick how often it repeats.');
  if (repeatUntil && !YMD.test(String(repeatUntil))) return S.fail(400, 'Pick a proper "until" date.');
  const task = await S.update('CrmTask', row.id, { repeatRule: repeat || null, repeatUntil: repeat ? (repeatUntil || null) : null, updatedAt: DB.nowIso() });
  return S.okBody({ ok: true, task });
}
// "skip this one": the open follow-up is cancelled and the series goes on from the next date
async function skipOne(user, id) {
  await P.ensure();
  const r = S.roleOf(user);
  const row = await S.getRow('CrmTask', String(id || ''));
  if (!S.canEditRow(user, r, row)) return S.fail(404, 'This follow-up is not there, or it is not yours.');
  if (row.status !== 'Open') return S.fail(409, 'Only an open follow-up can be skipped.');
  if (!RULES[row.repeatRule]) return S.fail(409, 'This follow-up does not repeat. Cancel it instead.');
  const now = DB.nowIso();
  await S.update('CrmTask', row.id, { status: 'Done', doneAt: now, doneNote: 'Skipped (repeating follow-up)', outcome: null, updatedAt: now });
  const next = await afterDone(row.id);
  return S.okBody({ ok: true, next });
}

// ---- 2. a video meeting per booking ---------------------------------------------------------------------------------------------
const ZOOM = 'zoom';
const ZF = { account: 'Account ID', clientId: 'Client ID', clientSecret: 'Client secret', user: 'Host email (empty = the app owner)' };
const zoomBase = () => String(process.env.CRM_ZOOM_API || 'https://api.zoom.us/v2').replace(/\/+$/, '');
const zoomOAuth = () => String(process.env.CRM_ZOOM_OAUTH || 'https://zoom.us/oauth/token');
async function zoomConfig() {
  const v = ((await require('../utils/integrationStore').readConfig(ZOOM).catch(() => null)) || {}).values || {}; // eslint-disable-line global-require
  const c = { account: String(v[ZF.account] || '').trim(), clientId: String(v[ZF.clientId] || '').trim(), clientSecret: String(v[ZF.clientSecret] || '').trim(), user: String(v[ZF.user] || '').trim() || 'me' };
  return { ...c, ready: !!(c.account && c.clientId && c.clientSecret) };
}
async function makeZoom({ title, start, minutes }) {
  const z = await zoomConfig();
  if (!z.ready) return { ok: false, needsAccount: true, error: 'Zoom is not connected. An Admin adds the Zoom Server-to-Server OAuth app (Account ID, Client ID, Client secret) in Administration → Integrations → Zoom.' };
  const tok = await fetch(`${zoomOAuth()}?grant_type=account_credentials&account_id=${encodeURIComponent(z.account)}`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${z.clientId}:${z.clientSecret}`).toString('base64')}` } });
  const tj = await tok.json().catch(() => null);
  if (!tok.ok || !tj || !tj.access_token) return { ok: false, error: `Zoom did not let TeamLink sign in (${tok.status}). Check the Zoom app's keys.` };
  const res = await fetch(`${zoomBase()}/users/${encodeURIComponent(z.user)}/meetings`, { method: 'POST', headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: title, type: 2, start_time: start.toISOString(), duration: minutes, timezone: 'Asia/Kolkata', settings: { join_before_host: true, waiting_room: false } }) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !/^https:\/\//.test(String(j.join_url || ''))) return { ok: false, error: `Zoom did not make the meeting (${res.status}${j && j.message ? `: ${String(j.message).slice(0, 120)}` : ''}).` };
  return { ok: true, url: j.join_url, provider: 'Zoom', ref: String(j.id || '') };
}
const startOf = (t) => new Date(Date.parse(`${t.dueDate}T${t.dueTime || '11:00'}:00+05:30`));
async function providers(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const z = await zoomConfig();
  const CAL = require('./calendarSync'); // eslint-disable-line global-require
  const mine = await CAL.linksOf(user.id);
  const company = await require('../utils/meetingLinks').setupReport().catch(() => ({ ready: false })); // eslint-disable-line global-require
  const st = await P.settings();
  return S.okBody({
    default: st.videoProvider || '',
    providers: [
      { id: 'zoom', name: 'Zoom', ready: z.ready, why: z.ready ? 'Zoom app connected' : 'An Admin connects Zoom in Administration → Integrations → Zoom' },
      { id: 'meet', name: 'Google Meet', ready: !!mine.google || (company.ready && company.provider === 'google'), why: mine.google ? `Your Google calendar (${mine.google.email || 'joined'})` : (company.ready && company.provider === 'google' ? 'The company Google calendar' : 'Join your Google calendar in Follow-ups → Calendar') },
      { id: 'teams', name: 'Microsoft Teams', ready: !!mine.microsoft || (company.ready && company.provider === 'microsoft'), why: mine.microsoft ? `Your Microsoft calendar (${mine.microsoft.email || 'joined'})` : (company.ready && company.provider === 'microsoft' ? 'The company Microsoft calendar' : 'Join your Microsoft calendar in Follow-ups → Calendar') },
    ],
  });
}
async function videoMeeting(user, id, { provider } = {}) {
  await P.ensure();
  const r = S.roleOf(user);
  const t = await S.getRow('CrmTask', String(id || ''));
  if (!S.canEditRow(user, r, t)) return S.fail(404, 'This follow-up is not there, or it is not yours.');
  if (t.status !== 'Open') return S.fail(409, 'Only an open follow-up gets a meeting link.');
  if (t.meetingUrl) return S.okBody({ ok: true, url: t.meetingUrl, provider: t.meetingProvider, already: true });
  const st = await P.settings();
  const want = ['zoom', 'meet', 'teams'].includes(provider) ? provider : st.videoProvider;
  if (!want) return S.fail(400, 'Pick Zoom, Google Meet or Microsoft Teams.');
  const rec = t.dealId ? await S.getRow('deal', t.dealId) : t.leadId ? await S.getRow('lead', t.leadId) : t.accountId ? await S.getRow('account', t.accountId) : null;
  const recName = rec ? (rec.title || rec.company || rec.name) : '';
  const title = clip(`${t.title}${recName ? ` · ${recName}` : ''} (TeamLink)`, 190);
  const start = startOf(t); const minutes = st.meetingMinutes;
  let out;
  try {
    if (want === 'zoom') out = await makeZoom({ title, start, minutes });
    else {
      const CAL = require('./calendarSync'); // eslint-disable-line global-require
      out = await CAL.meetingOnMyCalendar(user, want === 'meet' ? 'google' : 'microsoft', { title, start, minutes, description: `TeamLink CRM follow-up: ${t.title}` });
      if (out && out.notJoined) {
        const ML = require('../utils/meetingLinks'); // eslint-disable-line global-require
        const s = await ML.readSettings().catch(() => ({}));
        if (s.provider === (want === 'meet' ? 'google' : 'microsoft')) { const m = await ML.createMeeting({ title, description: `TeamLink CRM follow-up: ${t.title}`, start, minutes }); out = m.ok ? { ok: true, url: m.url, provider: m.provider, ref: m.eventId } : { ok: false, error: m.error || 'The company calendar account is not ready.' }; }
      }
    }
  } catch (e) {
    const blocked = /blocked|fetch failed|ENOTFOUND|ECONNREFUSED|SANDBOX/i.test(`${e.message} ${e.cause ? e.cause.message : ''}`);
    out = { ok: false, error: blocked ? 'Could not reach the meeting service from this server (no internet, or the test server). Nothing was made.' : `No link was made: ${clip(e.message, 160)}` };
  }
  if (!out || !out.ok) return S.fail(out && (out.needsAccount || out.notJoined) ? 409 : 502, (out && out.error) || 'No meeting link was made.', { needsAccount: !!(out && (out.needsAccount || out.notJoined)) });
  const now = DB.nowIso();
  await P.run('UPDATE "CrmTask" SET "meetingUrl" = ?, "meetingProvider" = ?, "meetingRef" = ?, "updatedAt" = ? WHERE "id" = ?', out.url, out.provider, clip(out.ref, 200), now, t.id);
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `${out.provider} meeting made: ${t.title}`, note: `${out.url}\nFor ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''} (${minutes} minutes). Nobody was invited by ${out.provider}: send the invite from the follow-up.`, at: now, leadId: t.leadId || null, dealId: t.dealId || null, accountId: t.accountId || null, byId: user.id, byName: user.name || null, createdAt: now });
  return S.okBody({ ok: true, url: out.url, provider: out.provider });
}

// ---- 3. field visits ------------------------------------------------------------------------------------------------------------------
const coord = (v, max) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= max && v !== '' && v != null ? Math.round(n * 1e6) / 1e6 : null; };
const distanceM = (a, b, c, d) => { if ([a, b, c, d].some((x) => x == null)) return null; const R = 6371000; const r = (x) => (x * Math.PI) / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };
const mapLink = (lat, lng) => (lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : null);
const visitOut = (v) => ({ ...v, minutes: v.outAt ? Math.max(1, Math.round((Date.parse(v.outAt) - Date.parse(v.inAt)) / 60000)) : null, inMap: mapLink(v.inLat, v.inLng), outMap: mapLink(v.outLat, v.outLng), moved: distanceM(v.inLat, v.inLng, v.outLat, v.outLng) });
async function checkIn(user, { kind, id, lat, lng, accuracy } = {}) {
  const rr = await P.editable(user, kind, id);
  if (rr.error) return rr.error;
  if (kind === 'contact') return S.fail(400, 'Check in at the lead, the deal or the company.');
  const open = await P.one('SELECT * FROM "CrmVisit" WHERE "userId" = ? AND "outAt" IS NULL', user.id);
  if (open) return S.fail(409, `You are still checked in at ${open.recordName || 'another visit'}. Check out there first.`, { open: visitOut(open) });
  const la = coord(lat, 90); const ln = coord(lng, 180);
  const st = await P.settings();
  if (st.visitNeedsLocation && (la == null || ln == null)) return S.fail(400, 'Share the phone\'s location to check in (the Admin asks for it on every visit).');
  const now = DB.nowIso();
  const name = rr.row[P.NAME[kind]] || '';
  const v = { id: S.newId('visit'), userId: user.id, userName: user.name || null, recordKind: kind, recordId: rr.row.id, recordName: name, leadId: kind === 'lead' ? rr.row.id : null, dealId: kind === 'deal' ? rr.row.id : null, accountId: kind === 'account' ? rr.row.id : (rr.row.accountId || null), inAt: now, inLat: la, inLng: ln, inAcc: Number(accuracy) > 0 ? Math.round(Number(accuracy)) : null, createdAt: now };
  const act = { id: S.newId('act'), kind: 'meeting', subject: `Field visit: checked in at ${name}`, note: la != null ? `Location: ${mapLink(la, ln)}${v.inAcc ? ` (within ${v.inAcc} m)` : ''}` : 'Location not shared.', at: now, leadId: v.leadId, dealId: v.dealId, accountId: v.accountId, byId: user.id, byName: user.name || null, createdAt: now };
  await S.insert('CrmActivity', act);
  v.activityId = act.id;
  const cols = Object.keys(v);
  await P.run(`INSERT INTO "CrmVisit" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => v[c]));
  await S.update(P.TABLE[kind], rr.row.id, { updatedAt: now });
  return S.okBody({ ok: true, visit: visitOut(v) });
}
async function checkOut(user, id, { lat, lng, accuracy, outcome, note } = {}) {
  const v = await P.one('SELECT * FROM "CrmVisit" WHERE "id" = ?', String(id || ''));
  if (!v || v.userId !== user.id) return S.fail(404, 'This visit is not there, or it is not yours.');
  if (v.outAt) return S.okBody({ ok: true, visit: visitOut(v), already: true });
  const SALES = require('./sales'); // eslint-disable-line global-require
  const oc = SALES.OUTCOMES.includes(outcome) ? outcome : null;
  const now = DB.nowIso();
  const la = coord(lat, 90); const ln = coord(lng, 180);
  const n = clip(note, 2000);
  await P.run('UPDATE "CrmVisit" SET "outAt" = ?, "outLat" = ?, "outLng" = ?, "outAcc" = ?, "outcome" = ?, "note" = ? WHERE "id" = ?', now, la, ln, Number(accuracy) > 0 ? Math.round(Number(accuracy)) : null, oc, n, v.id);
  const done = visitOut({ ...v, outAt: now, outLat: la, outLng: ln, outcome: oc, note: n });
  const lines = [`Visit of ${done.minutes} min (${new Date(Date.parse(v.inAt) + 5.5 * 3600000).toISOString().slice(11, 16)}-${new Date(Date.parse(now) + 5.5 * 3600000).toISOString().slice(11, 16)}).`, oc ? `Outcome: ${oc}` : '', n || '', v.inLat != null ? `Checked in: ${mapLink(v.inLat, v.inLng)}` : 'Check-in location not shared.', la != null ? `Checked out: ${mapLink(la, ln)}${done.moved != null && done.moved > 300 ? ` (${Math.round(done.moved / 100) / 10} km from the check-in)` : ''}` : ''].filter(Boolean);
  await P.run('UPDATE "CrmActivity" SET "subject" = ?, "note" = ?, "durationSec" = ? WHERE "id" = ?', `Field visit at ${v.recordName || 'the customer'}${oc ? `: ${oc}` : ''}`, lines.join('\n'), done.minutes * 60, v.activityId);
  if (v.leadId) await SALES.autoStage(v.leadId, { kind: 'meeting', outcome: oc || 'Meeting held' }).catch(() => null);
  return S.okBody({ ok: true, visit: done });
}
async function visits(user, { from, to, owner, open } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  await P.ensure();
  const where = []; const p = [];
  if (!S.seesAll(r)) { where.push('"userId" = ?'); p.push(user.id); } else if (owner) { where.push('"userId" = ?'); p.push(String(owner)); }
  if (open) where.push('"outAt" IS NULL');
  const f = YMD.test(String(from || '')) ? from : S.istToday(); const t = YMD.test(String(to || '')) ? to : f;
  if (!open) { where.push('"inAt" >= ? AND "inAt" < ?'); p.push(new Date(Date.parse(`${f}T00:00:00+05:30`)).toISOString(), new Date(Date.parse(`${t}T00:00:00+05:30`) + 86400000).toISOString()); }
  const rows = await P.all(`SELECT * FROM "CrmVisit" WHERE ${where.join(' AND ') || '1=1'} ORDER BY "inAt" DESC LIMIT 500`, ...p);
  const out = rows.map(visitOut);
  return S.okBody({ visits: out, from: f, to: t, totals: { visits: out.length, minutes: out.reduce((s, v) => s + (v.minutes || 0), 0), open: out.filter((v) => !v.outAt).length } });
}

// ---- 4. a call from the phone's own dialler, with its length --------------------------------------------------------------------
async function phoneCall(user, { kind, id, outcome, note, durationSec, followUp } = {}) {
  const SALES = require('./sales'); // eslint-disable-line global-require
  const oc = SALES.OUTCOMES.includes(outcome) ? outcome : null;
  const secs = Math.max(0, Math.min(4 * 3600, Math.round(Number(durationSec) || 0)));
  const mins = secs ? Math.max(1, Math.round(secs / 60)) : 0;
  const words = secs ? (secs < 60 ? `${secs} sec` : `${mins} min`) : '';
  const a = await S.addActivity(user, { kind: 'call', [`${kind}Id`]: id, subject: `Call from the phone${oc ? `: ${oc}` : ''}${words ? ` (${words})` : ''}`, note: clip(note, 2000) || undefined, outcome: oc || undefined, followUp: followUp && followUp.dueDate ? followUp : undefined });
  if (a.status !== 200) return a;
  if (secs && a.body.activity) await P.run('UPDATE "CrmActivity" SET "durationSec" = ? WHERE "id" = ?', secs, a.body.activity.id);
  return S.okBody({ ...a.body, durationSec: secs });
}

module.exports = { RULES, nextDate, nextFrom, extras, afterDone, setRepeat, skipOne, providers, videoMeeting, makeZoom, checkIn, checkOut, visits, phoneCall, ZOOM, ZF };

// ---------------------------------------------------------------------------
// AI MARKETING > LEAD GENERATION TO CRM (module 4; 2026-11-14). What the Sales CRM (crm/*) did not have: every NEW lead, from the website form, an ad-lead file or by hand, is SCORED Hot / Warm / Cold with the
// reasons written down, gets an OWNER when nobody has it, and the owner is told. The first reply is NOT built again here: the CRM's Autopilot (crm/autopilot.js) already sends the first mail and SMS the moment a
// lead arrives (when a Sales manager has switched it on), with its own limits (only leads that arrive after it was switched on, quiet hours, opt-outs, 20 sends a minute); this page shows whether it is on and what
// it did for each lead.
//   scoring    rules, no AI guess: a real phone and email, a business email address, a senior person, words that say "we need to hire", a message that is more than a word, the source, a kind of company we
//              serve, a call-back request; test / junk looks and a missing phone and email take points off. Hot from 65, Warm from 40 (a manager can change both). Every score keeps its reasons.
//   rating     the CRM's own Hot / Warm / Cold field is filled ONLY when it is empty: a person's own rating is never overwritten. The score and reasons are kept apart (CrmLead.leadScore / leadWhy) and
//              a note "Scored Hot (78)" with the reasons goes on the lead's timeline.
//   owner      a lead nobody owns goes to the next salesperson in turn (managers only when there is nobody else), or to the person set for Hot leads. A lead that already has an owner keeps it.
//   who        OFF until a Sales manager or an Admin switches it on; then only leads that arrive after that moment are scored by themselves (the sweep runs every minute, never in the test sandbox). A manager can
//              score the leads already in the CRM with a button. Sample records ("Sample ...") and junk / converted leads are left alone.
//   ad leads   a Facebook / Instagram / Google lead-form file (CSV or Excel) is imported through the CRM's own import (duplicates are skipped there), tagged with the ad source, and scored like the rest.
// Nothing here messages anyone. Audit rows carry counts and names of settings, never a phone or an email.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('../crm/schema');
const S = require('../crm/service');
const SETTINGS = require('../crm/settings');
const Cfg = require('./settings');

const KEY = 'omni.mk.leadgen';
const DEFAULTS = { on: false, armedAt: null, hot: 65, warm: 40, assign: true, hotOwnerId: '', notifyHot: true, lastOwnerId: '' };
const DAY = 86400000;
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

async function ensureCols() {
  await DB.ensure();
  for (const [c, t] of [['leadScore', 'INTEGER'], ['leadBand', 'TEXT'], ['leadWhy', 'TEXT'], ['leadScoredAt', 'TEXT'], ['leadAuto', 'INTEGER']]) {
    try { await DB.run(`ALTER TABLE "CrmLead" ADD COLUMN "${c}" ${t}`); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } // eslint-disable-line no-await-in-loop
  }
  try { await DB.run('CREATE INDEX IF NOT EXISTS "CrmLead_scored" ON "CrmLead"("leadScoredAt", "createdAt")'); } catch { /* the index is optional */ }
}
let colsOk = null;
const cols = () => { if (!colsOk) colsOk = ensureCols().catch((e) => { colsOk = null; throw e; }); return colsOk; };

// ---- settings ---------------------------------------------------------------------------------------------------------------------------------------------------
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const v = { ...DEFAULTS, ...parse(row && row.value, {}) };
  const hot = Math.max(10, Math.min(100, Math.floor(Number(v.hot)) || DEFAULTS.hot));
  const warm = Math.max(5, Math.min(hot - 1, Math.floor(Number(v.warm)) || DEFAULTS.warm));
  return { on: v.on === true, armedAt: typeof v.armedAt === 'string' ? v.armedAt : null, hot, warm, assign: v.assign !== false, hotOwnerId: String(v.hotOwnerId || ''), notifyHot: v.notifyHot !== false, lastOwnerId: String(v.lastOwnerId || '') };
}
async function writeSettings(v) {
  const value = JSON.stringify(v);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
const manager = (u) => S.mayAssign(S.roleOf(u));
async function saveSettings(u, b = {}) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list. Ask a Sales manager or an Admin.', status: 403 };
  if (!S.mayAssign(r)) return { error: 'Only a Sales manager or an Admin can change how leads are scored and given out.', status: 403 };
  const cur = await settings();
  const next = { ...cur };
  if (b.hot !== undefined) next.hot = Number(b.hot);
  if (b.warm !== undefined) next.warm = Number(b.warm);
  if (!Number.isFinite(next.hot) || !Number.isFinite(next.warm) || next.warm < 5 || next.hot > 100 || next.warm >= next.hot) return { error: 'Hot must be higher than Warm, for example Hot from 65 and Warm from 40.', status: 400 };
  if (b.assign !== undefined) next.assign = b.assign === true;
  if (b.notifyHot !== undefined) next.notifyHot = b.notifyHot === true;
  if (b.hotOwnerId !== undefined) {
    const id = String(b.hotOwnerId || '');
    if (id && !(await S.ownerOptions()).some((o) => o.id === id)) return { error: 'Pick the salesperson from the list.', status: 400 };
    next.hotOwnerId = id;
  }
  if (b.on !== undefined) { const on = b.on === true; if (on && !cur.on) next.armedAt = DB.nowIso(); next.on = on; }
  await writeSettings(next);
  await S.audit(u, 'CRM lead scoring settings changed', 'AppSetting', KEY, `${next.on ? 'on' : 'off'}; Hot from ${next.hot}, Warm from ${next.warm}; owners given out: ${next.assign ? 'yes' : 'no'}; Hot owner: ${next.hotOwnerId ? 'a chosen person' : 'in turn'}`);
  return { ok: next.on && !cur.on ? 'Switched on. Leads that arrive from now on are scored and given an owner by themselves.' : 'Saved.', settings: await settings() };
}

// ---- the score ----------------------------------------------------------------------------------------------------------------------------------------------------
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|rediffmail|icloud|aol|proton|protonmail|zoho)\./i;
const JUNK = /\b(test|testing|asdf|asdfgh|qwerty|xxx+|dummy|sample|demo account|abcd|lorem|ipsum|na|n\/a|none|nil)\b/i;
const SENIOR = /(founder|owner|proprietor|partner|ceo|cfo|coo|cto|\bmd\b|managing|director|chairman|president|\bvp\b|head|general manager|\bgm\b|hr manager|hr head|talent|recruit|procurement|manager)/i;
const INTENT = /(hire|hiring|recruit|requirement|vacanc|position|staffing|staff|manpower|nurse|doctor|candidate|urgent|immediate|quote|quotation|proposal|pricing|price|fees|call me|call back|callback|contact me|interested|meeting|demo)/gi;
const CALLBACK = /(call me|call back|callback|contact me|phone me|ring me)/i;
const digits = (s) => String(s || '').replace(/\D/g, '');
function phoneState(p) {
  const d = digits(p).slice(-10);
  if (d.length < 10) return digits(p) ? 'short' : 'none';
  if (/^(\d)\1{9}$/.test(d) || d === '1234567890' || d === '0123456789' || /^0/.test(d) || !/^[6-9]/.test(d)) return 'fake';
  return 'ok';
}
const sourceOf = (l) => String(l.utmSource || l.source || '').trim();
// lead = a CrmLead row; ctx = { industries: [lowercase] }. -> { score, band, reasons: [{ pts, why }] }
function score(lead, ctx = {}, th = { hot: DEFAULTS.hot, warm: DEFAULTS.warm }) {
  const reasons = []; let s = 25;
  const add = (pts, why) => { if (!pts) return; s += pts; reasons.push({ pts, why }); };
  const name = `${lead.company || ''} ${lead.contactName || ''}`;
  const text = String(lead.notes || '');
  const ph = phoneState(lead.phone);
  const em = String(lead.email || '').trim().toLowerCase();
  const emOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em);
  if (ph === 'ok') add(15, 'A real mobile number.'); else if (ph === 'fake' || ph === 'short') add(-15, 'The phone number does not look real.');
  if (emOk) { add(8, 'An email address.'); if (!FREE_MAIL.test(em) && !/^(test|abc|xyz|demo|no)@/i.test(em)) add(10, 'A business email address.'); } else if (em) add(-5, 'The email address does not look right.');
  if (ph !== 'ok' && !emOk) add(-30, 'No way to reach them: no phone and no email.');
  if (String(lead.company || '').trim().length >= 3 && !JUNK.test(lead.company)) add(5, 'A company name.');
  if (SENIOR.test(lead.designation || '')) add(15, `A decision maker (${String(lead.designation).trim().slice(0, 40)}).`); else if (String(lead.designation || '').trim()) add(3, 'Their job title is known.');
  const hits = (text.match(INTENT) || []).length;
  if (hits) add(Math.min(20, 8 * hits), 'Their message talks about hiring, a requirement, a price or a meeting.');
  if (text.trim().length >= 40) add(5, 'A real message, not one word.');
  if (CALLBACK.test(text)) add(5, 'They asked for a call.');
  const src = sourceOf(lead).toLowerCase();
  if (/referral|existing client|client/.test(src)) add(15, 'Came by a referral or from an existing client.');
  else if (/website|web form|landing/.test(src)) add(6, 'Filled our website form themselves.');
  else if (/event/.test(src)) add(6, 'Met at an event.');
  else if (/ads?\b|facebook|instagram|meta|google|lead form/.test(src)) add(0, '');
  else if (/other|import|cold/.test(src) || !src) add(-5, 'From a list, not from them asking.');
  const ind = String(lead.industry || '').toLowerCase();
  if (ind && (ctx.industries || []).some((i) => i && (ind.includes(i) || i.includes(ind)))) add(10, `A kind of company we serve (${lead.industry}).`);
  if (String(lead.city || '').trim()) add(3, 'The city is known.');
  if (JUNK.test(name) || /^(test|abc|xyz|asdf)/i.test(String(lead.company || ''))) add(-40, 'Looks like a test or junk entry.');
  s = Math.max(0, Math.min(100, Math.round(s)));
  const band = s >= th.hot ? 'Hot' : s >= th.warm ? 'Warm' : 'Cold';
  return { score: s, band, reasons };
}

// the next owner in turn (the sales team; managers only when there is nobody else), or the person set for Hot leads
async function pickOwner(st, band) {
  const all = await S.ownerOptions();
  if (band === 'Hot' && st.hotOwnerId) { const o = all.find((x) => x.id === st.hotOwnerId); if (o) return o; }
  const reps = all.filter((o) => !o.tl);
  const list = reps.length ? reps : all;
  if (!list.length) return null;
  const i = list.findIndex((o) => o.id === st.lastOwnerId);
  return list[(i + 1) % list.length];
}
const isSample = (l) => /^sample\b/i.test(String(l.company || ''));
// score one lead, give it an owner when it has none, tell the owner. opts: { assignEmpty, notify }
async function scoreOne(row, st, ctx, opts = {}) {
  if (!row || isSample(row) || ['Junk', 'Converted'].includes(row.status)) return { skipped: true };
  const r = score(row, ctx, st);
  const now = DB.nowIso();
  const data = { leadScore: r.score, leadBand: r.band, leadWhy: JSON.stringify(r.reasons), leadScoredAt: now };
  if (!row.rating) { data.rating = r.band; data.leadAuto = 1; }
  let owner = null;
  if (!row.ownerId && st.assign && opts.assignEmpty !== false) { owner = await pickOwner(st, r.band); if (owner) { data.ownerId = owner.id; data.ownerName = owner.name; } }
  await S.update('CrmLead', row.id, { ...data, updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Scored ${r.band} (${r.score})`, note: [...r.reasons.map((x) => `${x.pts > 0 ? '+' : ''}${x.pts} ${x.why}`), owner ? `Owner: ${owner.name} (next in turn).` : ''].filter(Boolean).join('\n').slice(0, 1500), at: now, leadId: row.id, byName: 'Lead scoring', createdAt: now }).catch(() => null);
  if (owner) {
    const cur = await settings();
    await writeSettings({ ...cur, lastOwnerId: owner.id });
    st.lastOwnerId = owner.id; // the next lead in this same pass goes to the next person
    try { await require('../crm/sales').firstFollowUp({ ...row, ownerId: owner.id, ownerName: owner.name }); } catch { /* the first call is a courtesy: never stops scoring */ } // eslint-disable-line global-require
  }
  const to = owner || (row.ownerId ? { id: row.ownerId } : null);
  if (to && st.notifyHot && opts.notify !== false && (owner || r.band === 'Hot')) {
    await prisma.notification.create({ data: { userId: to.id, title: `${owner ? 'New' : 'Scored'} ${r.band} lead: ${row.company}`, message: `Score ${r.score}. Open: /crm/leads?open=lead:${row.id}`, channel: 'In-App', recipient: `crm-score|${row.id}`, status: 'Sent' } }).catch(() => {});
  }
  return { id: row.id, ...r, owner: owner ? owner.name : (row.ownerName || '') };
}
async function ctxNow() { const b = await Cfg.getBrand().catch(() => ({})); return { industries: (b.industries || []).map((x) => String(x).toLowerCase()) }; }

// the sweep: new leads that arrived after switching on and are not scored yet (never the test sandbox: a test calls it)
let sweeping = false;
async function sweep({ limit = 40 } = {}) {
  if (sweeping) return { busy: true };
  sweeping = true;
  try {
    await cols();
    const st = await settings();
    if (!st.on || !st.armedAt) return { off: true };
    const rows = await DB.all('SELECT * FROM "CrmLead" WHERE "leadScoredAt" IS NULL AND "createdAt" >= ? AND "status" NOT IN (\'Junk\', \'Converted\') ORDER BY "createdAt" ASC LIMIT ?', st.armedAt, limit);
    const ctx = await ctxNow(); let n = 0;
    for (const row of rows) { const o = await scoreOne(row, st, ctx); if (o && !o.skipped) n += 1; } // eslint-disable-line no-await-in-loop
    return { scored: n };
  } finally { sweeping = false; }
}
function start() {
  if (require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  setInterval(() => { sweep().catch((e) => console.error('[omni-mk] lead scoring:', e.message)); }, 60 * 1000).unref(); // eslint-disable-line no-console
}

// a manager (or the owner, for their own leads) scores leads already in the CRM; the rating is still filled only when empty
async function scoreNow(u, b = {}) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list.', status: 403 };
  await cols();
  const st = await settings();
  let rows;
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean).slice(0, 500);
  if (ids.length) rows = await DB.all(`SELECT * FROM "CrmLead" WHERE "id" IN (${ids.map(() => '?').join(',')})`, ...ids);
  else if (b.all === true) {
    if (!S.mayAssign(r)) return { error: 'Only a Sales manager or an Admin can score every lead at once.', status: 403 };
    rows = await DB.all('SELECT * FROM "CrmLead" WHERE "status" NOT IN (\'Junk\', \'Converted\') ORDER BY "createdAt" DESC LIMIT 1000');
  } else return { error: 'Pick the leads to score.', status: 400 };
  const ctx = await ctxNow(); let n = 0; let skipped = 0;
  for (const row of rows) {
    if (!S.canEditRow(u, r, row)) { skipped += 1; continue; } // eslint-disable-line no-continue
    const o = await scoreOne(row, st, ctx, { assignEmpty: b.assignEmpty === true, notify: false }); // eslint-disable-line no-await-in-loop
    if (o && !o.skipped) n += 1; else skipped += 1;
  }
  await S.audit(u, 'CRM leads scored', 'CrmLead', 'lead scoring', `${n} scored, ${skipped} left alone${b.assignEmpty === true ? '; owners given where empty' : ''}`);
  return { ok: `${n} lead${n === 1 ? '' : 's'} scored.${skipped ? ` ${skipped} left alone (not yours, sample, junk or converted).` : ''}`, scored: n, skipped };
}

// ---- the page --------------------------------------------------------------------------------------------------------------------------------------------------
const maskPhone = (p) => { const d = digits(p); return d ? `xxxxxx${d.slice(-4)}` : ''; };
const maskMail = (e) => { const m = /^([^@]{1,2})[^@]*(@.+)$/.exec(String(e || '')); return m ? `${m[1]}***${m[2]}` : ''; };
async function autopilotState() {
  try {
    const a = await require('../crm/autopilot').load(); // eslint-disable-line global-require
    const first = (a.steps || []).filter((s) => ['hello-mail', 'hello-sms'].includes(s.id));
    return { on: !!a.on, armedAt: a.armedAt || null, firstReply: first.map((s) => ({ id: s.id, channel: s.channel, on: s.on !== false, afterHours: s.afterHours })) };
  } catch { return { on: false, armedAt: null, firstReply: [] }; }
}
async function overview(u) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list. Ask a Sales manager or an Admin to add you in the CRM settings.', status: 403 };
  await cols();
  const st = await settings();
  const sc = S.scopeSql(u, r);
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const rows = await DB.all(`SELECT * FROM "CrmLead" WHERE ${sc.sql} AND "createdAt" >= ? AND "company" NOT LIKE 'Sample%' ORDER BY "createdAt" DESC LIMIT 200`, ...sc.params, since);
  const ids = rows.map((x) => x.id);
  const steps = ids.length ? await DB.all(`SELECT "recordId", "stepId", "status", "sentAt", "result" FROM "CrmAutoStep" WHERE "recordId" IN (${ids.map(() => '?').join(',')}) AND "stepId" IN ('hello-mail', 'hello-sms')`, ...ids) : [];
  const reply = (id) => {
    const mine = steps.filter((x) => x.recordId === id);
    if (!mine.length) return { state: 'none', words: 'No automatic reply' };
    const sent = mine.filter((x) => x.status === 'sent');
    if (sent.length) return { state: 'sent', words: `Replied by ${sent.map((x) => (x.stepId === 'hello-mail' ? 'email' : 'SMS')).join(' and ')}`, at: sent.map((x) => x.sentAt).filter(Boolean).sort()[0] || null };
    if (mine.some((x) => ['waiting', 'sending'].includes(x.status))) return { state: 'waiting', words: 'Reply is waiting (quiet hours or the next minute)' };
    if (mine.some((x) => x.status === 'failed')) return { state: 'failed', words: 'The reply could not be sent' };
    return { state: 'skipped', words: 'Not replied (stopped or opted out)' };
  };
  const leads = rows.map((l) => ({
    id: l.id, company: l.company, contactName: l.contactName || '', designation: l.designation || '', phone: maskPhone(l.phone), email: maskMail(l.email), source: sourceOf(l) || 'Not said', city: l.city || '', status: l.status, stage: l.stage || '', rating: l.rating || '',
    score: l.leadScore == null ? null : Number(l.leadScore), band: l.leadBand || '', why: parse(l.leadWhy, []), scoredAt: l.leadScoredAt || null, ownerId: l.ownerId || '', ownerName: l.ownerName || '', createdAt: l.createdAt, reply: reply(l.id), canEdit: S.canEditRow(u, r, l),
  }));
  const count = (f) => leads.filter(f).length;
  const bySource = Object.entries(leads.reduce((a, l) => { a[l.source] = (a[l.source] || 0) + 1; return a; }, {})).map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n).slice(0, 8);
  const owners = manager(u) ? await S.ownerOptions() : [];
  return {
    settings: st, canManage: S.mayAssign(r), owners: owners.map((o) => ({ id: o.id, name: o.name, tl: o.tl })), autopilot: await autopilotState(),
    counts: { total: leads.length, hot: count((l) => l.band === 'Hot'), warm: count((l) => l.band === 'Warm'), cold: count((l) => l.band === 'Cold'), notScored: count((l) => !l.band), noOwner: count((l) => !l.ownerId), replied: count((l) => l.reply.state === 'sent') },
    bySource, leads, sources: SOURCES,
  };
}
const SOURCES = ['Facebook Ads', 'Instagram Ads', 'Google Ads', 'LinkedIn Ads', 'Other lead form'];

// an ad-lead file (CSV / Excel) through the CRM's own import, tagged with the ad source. opts: { fileName, source, ownerId, dryRun }
async function importAds(u, buf, opts = {}) {
  const r = S.roleOf(u);
  if (!r) return { error: 'Your login is not on the CRM list.', status: 403 };
  await cols();
  const source = SOURCES.includes(opts.source) ? opts.source : SOURCES[0];
  const t0 = DB.nowIso();
  const out = await require('../crm/extra').importLeads(u, buf, { fileName: opts.fileName, ownerId: opts.ownerId, dryRun: opts.dryRun, source: 'Other' }); // eslint-disable-line global-require
  if (out.status !== 200 || opts.dryRun) return out;
  await DB.run('UPDATE "CrmLead" SET "utmSource" = ? WHERE "createdAt" >= ? AND "createdById" = ? AND ("utmSource" IS NULL OR "utmSource" = \'\')', source, t0, u.id);
  await S.audit(u, 'CRM ad leads imported', 'CrmLead', String(opts.fileName || 'file').slice(0, 80), `${out.body.created || 0} added from ${source}`);
  return { status: 200, body: { ...out.body, source, ok: `${out.body.created || 0} lead${out.body.created === 1 ? '' : 's'} added from ${source}.${out.body.skipped && out.body.skipped.length ? ` ${out.body.skipped.length} skipped.` : ''}${(await settings()).on ? ' They are scored within a minute.' : ' Switch scoring on to have them scored.'}` } };
}

module.exports = { DEFAULTS, SOURCES, settings, saveSettings, score, scoreOne, sweep, start, scoreNow, overview, importAds, phoneState, pickOwner };

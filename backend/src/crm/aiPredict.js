// ---------------------------------------------------------------------------
// CRM > AI THAT LEARNS FROM OUR OWN HISTORY (wave E, 2026-11-24; gaps 09.01, 09.02, 09.07).
//
//   1. LEAD SCORE (learned)  a small logistic-regression model trained on the CRM's own CLOSED leads (Converted = 1, Junk / Lost = 0):
//                            what they had (rating, source, phone / email, replies, demo, meeting, how much contact) and how they ended.
//                            An open lead gets "62% likely to convert" with the 3 things that raise and lower it most.
//   2. DEAL WIN CHANCE       the same over closed deals (Won = 1, Lost = 0); the stage's own % is joined in (log-odds), so a deal in
//                            Negotiation counts more than one in Prospecting even when the history is small.
//   3. AI FORECAST           every open deal x its learned win chance, in the month it is likely to close (its expected close, or the
//                            usual time our deals take), plus the trend of the last months for business not in the pipeline yet.
//
// Plain code, no outside service: nothing leaves the server, it works with no AI key. A model needs at least 12 closed records with 3 of
// each result; until then the screens say how many more are needed and the rule score (crm/ai.js) stays the score. Retrained when it is
// 6 hours old, or when a Sales manager / Admin presses "Learn again". The model is company-wide (weights only, no record is in it);
// every answer about a record goes through the same access check as opening the record.
// ---------------------------------------------------------------------------
const P = require('./plusE');
const S = require('./service');
const DB = require('./schema');
const SETTINGS = require('./settings');

const MIN_SAMPLES = 12;
const MIN_EACH = 3;
const MAX_AGE_MS = 6 * 3600 * 1000;
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const logit = (p) => { const q = Math.max(0.02, Math.min(0.98, p)); return Math.log(q / (1 - q)); };
const l1p = (n) => Math.log1p(Math.max(0, Number(n) || 0));
const WORK = `COALESCE("subject", '') NOT LIKE 'Stage:%' AND COALESCE("subject", '') NOT LIKE 'Follow-up moved:%'`;

// ---- features ------------------------------------------------------------------------------------------------------------------
// each: [key, words when it pushes the chance UP, words when DOWN] - the words describe the record's own value
const LEAD_F = [
  ['hot', (v) => (v ? 'Rated Hot' : 'Not rated Hot')],
  ['warm', (v) => (v ? 'Rated Warm' : 'Not rated Warm')],
  ['cold', (v) => (v ? 'Rated Cold' : 'Not rated Cold')],
  ['phone', (v) => (v ? 'Has a phone number' : 'No phone number')],
  ['email', (v) => (v ? 'Has an email' : 'No email')],
  ['person', (v) => (v ? 'A contact person is named' : 'No contact person named')],
  ['referral', (v) => (v ? 'Came by referral / an existing client' : 'Not a referral')],
  ['website', (v) => (v ? 'Came from the website' : 'Not from the website')],
  ['imported', (v) => (v ? 'Came from an import / campaign list' : 'Not from an import list')],
  ['touches', (v, raw) => `${raw} conversation(s) logged`],
  ['calls', (v, raw) => `${raw} call(s)`],
  ['replied', (v) => (v ? 'They wrote back' : 'They have not written back')],
  ['demo', (v) => (v ? 'Opened / played the demo' : 'Has not opened the demo')],
  ['met', (v) => (v ? 'A meeting was held' : 'No meeting yet')],
  ['value', (v, raw) => (raw ? `Expected value ₹${Math.round(raw).toLocaleString('en-IN')}` : 'No expected value')],
];
const DEAL_F = [
  ['value', (v, raw) => (raw ? `Deal value ₹${Math.round(raw).toLocaleString('en-IN')}` : 'No deal value')],
  ['openings', (v, raw) => `${raw || 0} opening(s)`],
  ['discount', (v) => (v ? 'A discount was given' : 'No discount')],
  ['dm', (v) => (v ? 'A decision maker is in the contacts' : 'No decision maker in the contacts')],
  ['contacts', (v, raw) => `${raw} contact(s) at the company`],
  ['touches', (v, raw) => `${raw} conversation(s) logged`],
  ['met', (v) => (v ? 'A meeting was held' : 'No meeting logged')],
  ['proposal', (v) => (v ? 'A proposal was made' : 'No proposal yet')],
  ['repeat', (v) => (v ? 'The company has won deals with us before' : 'No earlier won deal with this company')],
  ['fromLead', (v) => (v ? 'Came through a lead' : 'Made directly as a deal')],
  ['closeSet', (v) => (v ? 'An expected close date is set' : 'No expected close date')],
];

async function leadStats(where = '1=1', params = []) {
  return DB.all(`SELECT "leadId",
      SUM(CASE WHEN "byId" IS NOT NULL AND ${WORK} THEN 1 ELSE 0 END) AS "touches",
      SUM(CASE WHEN "kind" = 'call' AND "byId" IS NOT NULL THEN 1 ELSE 0 END) AS "calls",
      SUM(CASE WHEN "subject" LIKE 'Replied on %' THEN 1 ELSE 0 END) AS "replies",
      SUM(CASE WHEN "subject" LIKE 'Demo %' OR "subject" LIKE 'Interested after the demo%' THEN 1 ELSE 0 END) AS "demo",
      SUM(CASE WHEN "subject" LIKE 'AI meeting held%' OR ("kind" = 'meeting' AND COALESCE("note", '') LIKE '%Meeting held%') OR COALESCE("note", '') LIKE '%Outcome: Meeting held%' THEN 1 ELSE 0 END) AS "met"
    FROM "CrmActivity" WHERE "leadId" IS NOT NULL AND ${where} GROUP BY "leadId"`, ...params);
}
function leadVector(l, st) {
  const src = String(l.source || '');
  const raw = {
    hot: l.rating === 'Hot' ? 1 : 0, warm: l.rating === 'Warm' ? 1 : 0, cold: l.rating === 'Cold' ? 1 : 0,
    phone: l.phone ? 1 : 0, email: l.email ? 1 : 0, person: l.contactName ? 1 : 0,
    referral: /referral|existing client/i.test(src) ? 1 : 0, website: /website|web form|inbound/i.test(src) ? 1 : 0, imported: /import|campaign|list|database|cold/i.test(src) ? 1 : 0,
    touches: Number(st && st.touches) || 0, calls: Number(st && st.calls) || 0,
    replied: Number(st && st.replies) > 0 ? 1 : 0, demo: Number(st && st.demo) > 0 ? 1 : 0, met: Number(st && st.met) > 0 ? 1 : 0,
    value: Number(l.expectedValue) || 0,
  };
  const x = LEAD_F.map(([k]) => (['touches', 'calls', 'value'].includes(k) ? l1p(raw[k]) : raw[k]));
  return { x, raw };
}
async function dealStats() {
  const acts = await DB.all(`SELECT "dealId",
      SUM(CASE WHEN "byId" IS NOT NULL AND ${WORK} THEN 1 ELSE 0 END) AS "touches",
      SUM(CASE WHEN "kind" = 'meeting' AND "byId" IS NOT NULL THEN 1 ELSE 0 END) AS "met"
    FROM "CrmActivity" WHERE "dealId" IS NOT NULL GROUP BY "dealId"`);
  const props = await DB.all('SELECT "dealId", COUNT(*) AS "n" FROM "CrmProposal" GROUP BY "dealId"').catch(() => []);
  const contacts = await DB.all('SELECT "accountId", COUNT(*) AS "n", SUM(CASE WHEN "role" = \'Decision maker\' THEN 1 ELSE 0 END) AS "dm" FROM "CrmContact" WHERE "accountId" IS NOT NULL GROUP BY "accountId"');
  const won = await DB.all('SELECT "accountId", "id", "wonAt" FROM "CrmDeal" WHERE "stage" = \'Won\' AND "accountId" IS NOT NULL');
  return { acts: new Map(acts.map((a) => [a.dealId, a])), props: new Map(props.map((p) => [p.dealId, Number(p.n) || 0])), contacts: new Map(contacts.map((c) => [c.accountId, c])), won };
}
function dealVector(d, ctx) {
  const a = ctx.acts.get(d.id) || {};
  const c = ctx.contacts.get(d.accountId) || {};
  const raw = {
    value: Number(d.finalValue || d.value) || 0, openings: Number(d.openings) || 0, discount: Number(d.discountPercent) > 0 ? 1 : 0,
    dm: Number(c.dm) > 0 ? 1 : 0, contacts: Number(c.n) || 0, touches: Number(a.touches) || 0, met: Number(a.met) > 0 ? 1 : 0,
    proposal: (ctx.props.get(d.id) || 0) > 0 ? 1 : 0,
    repeat: d.accountId && ctx.won.some((w) => w.accountId === d.accountId && w.id !== d.id && String(w.wonAt || '') < String(d.wonAt || d.lostAt || '9999')) ? 1 : 0,
    fromLead: d.leadId ? 1 : 0, closeSet: d.expectedClose ? 1 : 0,
  };
  const x = DEAL_F.map(([k]) => (['value', 'openings', 'contacts', 'touches'].includes(k) ? l1p(raw[k]) : raw[k]));
  return { x, raw };
}

// ---- the model -----------------------------------------------------------------------------------------------------------------
function fit(X, y, { epochs = 500, lr = 0.3, l2 = 0.05 } = {}) {
  const n = X.length; const k = X[0].length;
  const mean = Array(k).fill(0); const sd = Array(k).fill(0);
  X.forEach((r) => r.forEach((v, j) => { mean[j] += v / n; }));
  X.forEach((r) => r.forEach((v, j) => { sd[j] += ((v - mean[j]) ** 2) / n; }));
  for (let j = 0; j < k; j += 1) sd[j] = Math.sqrt(sd[j]) > 1e-6 ? Math.sqrt(sd[j]) : 0; // 0 = the same in every past record: it has no learned effect
  const Z = X.map((r) => r.map((v, j) => (sd[j] ? (v - mean[j]) / sd[j] : 0)));
  const w = Array(k).fill(0);
  const base = y.reduce((s, v) => s + v, 0) / n;
  let b = logit(base);
  for (let e = 0; e < epochs; e += 1) {
    const gw = Array(k).fill(0); let gb = 0;
    for (let i = 0; i < n; i += 1) {
      const p = sigmoid(b + Z[i].reduce((s, v, j) => s + v * w[j], 0));
      const err = p - y[i];
      gb += err / n;
      for (let j = 0; j < k; j += 1) gw[j] += (err * Z[i][j]) / n;
    }
    for (let j = 0; j < k; j += 1) w[j] -= lr * (gw[j] + l2 * w[j]);
    b -= lr * gb;
  }
  return { w, b, mean, sd, base };
}
const predictZ = (m, x) => { const z = x.map((v, j) => (m.sd[j] ? (v - m.mean[j]) / m.sd[j] : 0)); return { p: sigmoid(m.b + z.reduce((s, v, j) => s + v * m.w[j], 0)), z }; };
// How often it is right on records it did NOT learn from (k-fold), so the screen can say it honestly.
function crossCheck(X, y) {
  const k = Math.min(5, X.length);
  let right = 0;
  for (let f = 0; f < k; f += 1) {
    const tr = []; const ty = []; const te = [];
    X.forEach((x, i) => { if (i % k === f) te.push(i); else { tr.push(x); ty.push(y[i]); } });
    if (!ty.some((v) => v === 1) || !ty.some((v) => v === 0)) { te.forEach((i) => { right += (ty.reduce((s, v) => s + v, 0) / ty.length >= 0.5 ? 1 : 0) === y[i] ? 1 : 0; }); continue; } // eslint-disable-line no-continue
    const m = fit(tr, ty, { epochs: 300 });
    te.forEach((i) => { right += (predictZ(m, X[i]).p >= 0.5 ? 1 : 0) === y[i] ? 1 : 0; });
  }
  return Math.round((right / X.length) * 100);
}

async function trainingSet(kind) {
  if (kind === 'lead') {
    const rows = await DB.all(`SELECT "id", "rating", "source", "phone", "email", "contactName", "expectedValue", "status", "stage" FROM "CrmLead"
      WHERE "status" IN ('Converted', 'Junk') OR "stage" IN ('Won', 'Lost')`);
    const stats = new Map((await leadStats()).map((s) => [s.leadId, s]));
    return { X: rows.map((l) => leadVector(l, stats.get(l.id)).x), y: rows.map((l) => (l.status === 'Converted' || l.stage === 'Won' ? 1 : 0)) };
  }
  const rows = await DB.all('SELECT * FROM "CrmDeal" WHERE "stage" IN (\'Won\', \'Lost\')');
  const ctx = await dealStats();
  return { X: rows.map((d) => dealVector(d, ctx).x), y: rows.map((d) => (d.stage === 'Won' ? 1 : 0)) };
}

async function train(kind) {
  const { X, y } = await trainingSet(kind);
  const pos = y.filter((v) => v === 1).length; const neg = y.length - pos;
  const body = { kind, samples: y.length, won: pos, lost: neg, ready: false };
  if (y.length < MIN_SAMPLES || pos < MIN_EACH || neg < MIN_EACH) {
    body.need = `It learns once there are ${MIN_SAMPLES} closed ${kind}s with at least ${MIN_EACH} ${kind === 'lead' ? 'converted' : 'won'} and ${MIN_EACH} ${kind === 'lead' ? 'junk / lost' : 'lost'}; today there are ${y.length} (${pos} ${kind === 'lead' ? 'converted' : 'won'}, ${neg} ${kind === 'lead' ? 'junk / lost' : 'lost'}).`;
  } else {
    Object.assign(body, fit(X, y), { ready: true, accuracy: crossCheck(X, y) });
  }
  const now = DB.nowIso();
  await P.run('INSERT INTO "CrmModel" ("kind", "json", "samples", "trainedAt") VALUES (?, ?, ?, ?) ON CONFLICT("kind") DO UPDATE SET "json" = excluded."json", "samples" = excluded."samples", "trainedAt" = excluded."trainedAt"', kind, JSON.stringify(body), y.length, now);
  return { ...body, trainedAt: now };
}
async function model(kind, { fresh = false } = {}) {
  const row = await P.one('SELECT * FROM "CrmModel" WHERE "kind" = ?', kind);
  if (!fresh && row && Date.now() - Date.parse(row.trainedAt) < MAX_AGE_MS) { try { return { ...JSON.parse(row.json), trainedAt: row.trainedAt }; } catch { /* retrain */ } }
  return train(kind);
}
const modelOut = (m) => ({ ready: !!m.ready, samples: m.samples, won: m.won, lost: m.lost, accuracy: m.accuracy == null ? null : m.accuracy, trainedAt: m.trainedAt, need: m.need || null });

function reasonsOf(m, F, x, raw) {
  const { z } = predictZ(m, x);
  const parts = F.map(([k, words], j) => ({ key: k, effect: m.w[j] * z[j], why: words(raw[k] ? 1 : 0, raw[k]) })).filter((r) => Math.abs(r.effect) >= 0.08);
  parts.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return {
    up: parts.filter((r) => r.effect > 0).slice(0, 3).map((r) => ({ why: r.why, effect: Math.round(r.effect * 100) / 100 })),
    down: parts.filter((r) => r.effect < 0).slice(0, 3).map((r) => ({ why: r.why, effect: Math.round(r.effect * 100) / 100 })),
  };
}

// ---- a record --------------------------------------------------------------------------------------------------------------------
async function dealChance(m, d, ctx, st) {
  const stageP = (Number(d.probability) || (st.stageProbability || {})[d.stage] || 10) / 100;
  if (!m.ready) return { p: stageP, stageP, modelP: null };
  const { x } = dealVector(d, ctx);
  const modelP = predictZ(m, x).p;
  return { p: sigmoid(logit(modelP) + logit(stageP) - logit(m.base)), stageP, modelP };
}
async function predict(user, kind, id) {
  if (!['lead', 'deal'].includes(kind)) return S.fail(404, 'The learned score is for leads and deals.');
  const r = await P.readable(user, kind, id);
  if (r.error) return r.error;
  const row = r.row;
  const m = await model(kind);
  const out = { kind, model: modelOut(m), probability: null, reasons: { up: [], down: [] }, closed: false };
  if (kind === 'lead') {
    if (['Converted', 'Junk'].includes(row.status) || ['Won', 'Lost'].includes(row.stage)) return S.okBody({ ...out, closed: true, probability: row.status === 'Converted' || row.stage === 'Won' ? 100 : 0 });
    if (!m.ready) return S.okBody(out);
    const st = (await leadStats('"leadId" = ?', [row.id]))[0];
    const { x, raw } = leadVector(row, st);
    out.probability = Math.round(predictZ(m, x).p * 100);
    out.reasons = reasonsOf(m, LEAD_F, x, raw);
    out.label = out.probability >= 60 ? 'Likely to convert' : out.probability >= 30 ? 'May convert' : 'Unlikely to convert';
    return S.okBody(out);
  }
  if (['Won', 'Lost'].includes(row.stage)) return S.okBody({ ...out, closed: true, probability: row.stage === 'Won' ? 100 : 0 });
  const ctx = await dealStats();
  const st = await SETTINGS.load();
  const c = await dealChance(m, row, ctx, st);
  out.probability = Math.round(c.p * 100);
  out.stageProbability = Math.round(c.stageP * 100);
  out.modelProbability = c.modelP == null ? null : Math.round(c.modelP * 100);
  if (m.ready) { const { x, raw } = dealVector(row, ctx); out.reasons = reasonsOf(m, DEAL_F, x, raw); }
  out.label = out.probability >= 60 ? 'Likely to win' : out.probability >= 30 ? 'Could go either way' : 'At risk';
  return S.okBody(out);
}

async function retrain(user) {
  const r = S.roleOf(user);
  if (r !== 'admin' && r !== 'tl') return S.fail(403, 'A Sales manager or an Admin makes the AI learn again.');
  const lead = await train('lead'); const deal = await train('deal');
  S.audit(user, 'CRM AI learned again', 'CrmModel', 'lead,deal', `leads ${lead.samples}, deals ${deal.samples}`);
  return S.okBody({ lead: modelOut(lead), deal: modelOut(deal) });
}
async function status(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  return S.okBody({ lead: modelOut(await model('lead')), deal: modelOut(await model('deal')) });
}

// ---- 3. the AI forecast ----------------------------------------------------------------------------------------------------------
const ym = (iso) => String(iso || '').slice(0, 7);
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
async function forecast(user, { ai } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const sc = S.scopeSql(user, r);
  const today = S.istToday();
  const thisMonth = ym(today);
  const months = [0, 1, 2].map((n) => addMonths(thisMonth, n));
  const st = await SETTINGS.load();
  const m = await model('deal');
  const ctx = await dealStats();
  const open = await DB.all(`SELECT * FROM "CrmDeal" WHERE ${sc.sql} AND "stage" NOT IN ('Won', 'Lost')`, ...sc.params);
  const won = await DB.all(`SELECT "id", "value", "finalValue", "wonAt", "createdAt" FROM "CrmDeal" WHERE ${sc.sql} AND "stage" = 'Won' AND "wonAt" IS NOT NULL`, ...sc.params);
  // how long our won deals took (created -> won), for a deal with no / a past expected close
  const cycle = median(won.map((d) => (Date.parse(d.wonAt) - Date.parse(d.createdAt)) / 86400000).filter((x) => Number.isFinite(x) && x >= 0)) || 30;
  const per = Object.fromEntries(months.map((k) => [k, { month: k, aiPipeline: 0, stageWeighted: 0, deals: 0 }]));
  const top = [];
  for (const d of open) {
    // eslint-disable-next-line no-await-in-loop
    const c = await dealChance(m, d, ctx, st);
    const v = Number(d.finalValue || d.value) || 0;
    let when = d.expectedClose && d.expectedClose >= today ? ym(d.expectedClose) : null;
    if (!when) {
      const age = (Date.now() - Date.parse(d.createdAt)) / 86400000;
      const left = Math.max(7, cycle - (Number.isFinite(age) ? age : 0));
      when = ym(new Date(Date.now() + left * 86400000).toISOString());
    }
    if (per[when]) { per[when].aiPipeline += c.p * v; per[when].stageWeighted += c.stageP * v; per[when].deals += 1; }
    top.push({ id: d.id, title: d.title, value: v, chance: Math.round(c.p * 100), month: when, expected: Math.round(c.p * v) });
  }
  // the last 12 months won, and the trend of the last 6 (least squares), for business that is not in the pipeline yet
  const hist = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, i - 12)).map((k) => ({ month: k, won: 0 }));
  const byM = new Map(hist.map((h) => [h.month, h]));
  let wonThisMonth = 0; let quick = 0; let wonTotal6 = 0;
  const six = addMonths(thisMonth, -6);
  for (const d of won) {
    const v = Number(d.finalValue || d.value) || 0;
    const k = ym(d.wonAt);
    if (k === thisMonth) wonThisMonth += v;
    if (byM.has(k)) byM.get(k).won += v;
    if (k >= six && k < thisMonth) { wonTotal6 += v; if ((Date.parse(d.wonAt) - Date.parse(d.createdAt)) / 86400000 <= 31) quick += v; }
  }
  const last6 = hist.slice(-6).map((h) => h.won);
  const n = last6.length; const xs = last6.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = last6.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (last6[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  const trendAt = (k) => Math.max(0, my + slope * (n - 1 - mx + k + 1));
  const resid = last6.map((v, i) => v - (my + slope * (i - mx)));
  const spread = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, n - 1));
  const newShare = wonTotal6 > 0 ? quick / wonTotal6 : 0.3;
  const dayOfMonth = Number(today.slice(8, 10)); const daysIn = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const out = months.map((k, i) => {
    const p = per[k];
    const extra = trendAt(i) * newShare * (i === 0 ? Math.max(0, (daysIn - dayOfMonth) / daysIn) : 1);
    const forecastV = (i === 0 ? wonThisMonth : 0) + p.aiPipeline + extra;
    return { month: k, wonSoFar: i === 0 ? Math.round(wonThisMonth) : 0, aiPipeline: Math.round(p.aiPipeline), newBusiness: Math.round(extra), forecast: Math.round(forecastV), low: Math.round(Math.max(0, forecastV - spread)), high: Math.round(forecastV + spread), stageWeighted: Math.round((i === 0 ? wonThisMonth : 0) + p.stageWeighted), deals: p.deals };
  });
  top.sort((a, b) => b.expected - a.expected);
  const money = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
  const story = [
    `This month: likely ${money(out[0].forecast)} (between ${money(out[0].low)} and ${money(out[0].high)}): ${money(out[0].wonSoFar)} already won, ${money(out[0].aiPipeline)} from ${out[0].deals} open deal(s) by their learned win chance, ${money(out[0].newBusiness)} from new business at the recent pace.`,
    `${out[1].month}: likely ${money(out[1].forecast)}; ${out[2].month}: likely ${money(out[2].forecast)}.`,
    slope > 0 ? 'Won business has been going up over the last six months.' : slope < 0 ? 'Won business has been going down over the last six months.' : 'Won business has been flat over the last six months.',
    m.ready ? `Win chances are learned from ${m.samples} closed deals (right ${m.accuracy}% of the time on deals it did not learn from), joined with each stage's %.` : `Win chances use each stage's % for now. ${m.need || ''}`,
  ];
  const body = { months: out, history: hist.map((h) => ({ month: h.month, won: Math.round(h.won) })), trend: Math.round(slope), cycleDays: Math.round(cycle), newShare: Math.round(newShare * 100), model: modelOut(m), top: top.slice(0, 6), story, aiText: null, scope: S.seesAll(r) ? 'team' : 'mine' };
  if (ai) {
    try {
      const fa = require('../utils/fastAi'); // eslint-disable-line global-require
      const res = await fa.chat('You are the sales analyst inside TeamLink CRM (a recruitment company in India). Use ONLY the numbers given. In 3-4 short lines say what to expect and the one thing that would change it most. Money in rupees.', [{ role: 'user', content: `${story.join('\n')}\nBiggest open deals: ${top.slice(0, 5).map((t) => `${t.title} ${money(t.value)} at ${t.chance}% (${t.month})`).join('; ') || 'none'}.\nWon per month (oldest first): ${hist.map((h) => Math.round(h.won)).join(', ')}.` }], { maxTokens: 300, purpose: 'CRM AI forecast' });
      body.aiText = String(res.text || '').trim() || null;
      body.aiProvider = res.provider;
    } catch (e) { body.aiError = (e && e.message) || 'The AI is not available right now.'; }
  }
  return S.okBody(body);
}

module.exports = { predict, retrain, status, forecast, train, model, fit, predictZ };

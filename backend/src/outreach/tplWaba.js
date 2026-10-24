// ---------------------------------------------------------------------------
// ONE WHATSAPP TEMPLATE FOR EVERY NUMBER (2026-10-22).
//
// META FACTS THIS FILE FOLLOWS
//   * A message template belongs to a WhatsApp Business Account (WABA), not to a number. All numbers of one WABA share it. A number of ANOTHER WABA can only
//     send a template that exists and is APPROVED in its own WABA (otherwise Meta answers error 132001). The template NAME is the same string everywhere.
//   * So "any number may use the same template" means: the template is sent to Meta once for EVERY distinct WABA of the company's numbers, and each
//     account's own answer is kept. Nothing is ever marked Approved by us: only Meta's own answer is copied (or what an Admin recorded by hand).
//
// WHAT IS KEPT (table WaTemplateWaba, self-provisioned and additive: CREATE TABLE IF NOT EXISTS, only an Admin action creates it, a read never does)
//   one row per (template, WABA): status draft | pending | approved | rejected, Meta's template id, Meta's reason, when sent / checked.
//   OutreachTemplate.waApprovalStatus stays the SUMMARY the old screens use: "approved" when ANY account approved it (so nothing that worked stops working).
//   A template without rows (sent before this change, or approved by hand in Meta Business Manager) behaves exactly as before.
//
// WHAT THIS FILE DOES
//   accounts()          the distinct WABAs of the active numbers (numbers sharing a WABA are ONE account); the old single connection is one account
//   submitAll(user,id)  Admin: send the template to every account once (skips an account that already has it sent / approved, and first asks Meta whether
//                       the template is already there, so a duplicate is never created); never in test mode
//   checkAll(user,id)   ask every account what Meta says now, copy only Meta's answer
//   guard(cfg,name)     the send path's check: may a number of THIS account send this template name? -> null | { reason, state, ... } (no network)
//   chipsOf / decorate  the per-number "Approved / In review / Not sent yet" chips for the screens
// Secrets: tokens stay inside waNumbers.configOf(); no function here returns one (or a WABA id to a non-Admin).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./store');
const A = require('./access');
const T = require('./templates');
const P = require('./tplPolicy');
const Meta = require('./tplMeta');
const { logAudit } = require('../utils/audit');

const q = S.q; const run = S.run;
const DDL = [
  `CREATE TABLE IF NOT EXISTS "WaTemplateWaba" (
    "templateId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "metaId" TEXT,
    "metaStatus" TEXT,
    "reason" TEXT,
    "submittedAt" TEXT,
    "checkedAt" TEXT,
    "updatedAt" TEXT NOT NULL,
    PRIMARY KEY ("templateId", "wabaId")
  )`,
  'CREATE INDEX IF NOT EXISTS "WaTemplateWaba_waba" ON "WaTemplateWaba"("wabaId", "status")',
];
const META_STATUS = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', PENDING_DELETION: 'pending', REJECTED: 'rejected', PAUSED: 'approved', DISABLED: 'rejected' };
const RANK = { approved: 4, pending: 3, rejected: 2, draft: 1 };
const WORDS = { approved: ['live', 'Approved'], pending: ['scheduled', 'In review'], rejected: ['red', 'Rejected'], draft: ['draft', 'Not sent yet'], offline: ['draft', 'Not connected'] };
const FIX_SENTENCE = 'An Admin can fix this: open the template in Manage Templates and press "Send to every number\'s WhatsApp account".';
const nowIso = () => new Date().toISOString();
const keyOf = (wabaId) => crypto.createHash('sha1').update(String(wabaId)).digest('hex').slice(0, 8);
const wa = () => require('../utils/whatsappCloud'); // eslint-disable-line global-require
const WN = () => require('../utils/waNumbers'); // eslint-disable-line global-require

// ---- the table (created only by an Admin action) -----------------------------------------------------------------------------------
let ensured = null; let readyAt = 0; let readyVal = false;
function ensure() {
  if (ensured) return ensured;
  ensured = (async () => { for (const sql of DDL) await run(sql); readyAt = 0; return true; })().catch((e) => { ensured = null; throw e; }); // eslint-disable-line no-await-in-loop
  return ensured;
}
async function ready() {
  const age = Date.now() - readyAt;
  if (readyAt && age < (readyVal ? 60000 : 4000)) return readyVal;
  try { readyVal = (await q("SELECT name FROM sqlite_master WHERE type='table' AND name = 'WaTemplateWaba'")).length === 1; } catch { readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
async function rowsFor(ids) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  list.forEach((i) => out.set(i, []));
  if (!list.length || !(await ready())) return out;
  for (let i = 0; i < list.length; i += 300) {
    const part = list.slice(i, i + 300);
    // eslint-disable-next-line no-await-in-loop
    (await q(`SELECT * FROM "WaTemplateWaba" WHERE "templateId" IN (${part.map(() => '?').join(',')})`, ...part)).forEach((r) => out.get(r.templateId).push(r));
  }
  return out;
}
async function put(templateId, wabaId, p) {
  await ensure();
  const t = nowIso();
  await run(`INSERT INTO "WaTemplateWaba" ("templateId","wabaId","status","metaId","metaStatus","reason","submittedAt","checkedAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT("templateId","wabaId") DO UPDATE SET "status" = excluded."status", "metaId" = COALESCE(excluded."metaId", "WaTemplateWaba"."metaId"), "metaStatus" = COALESCE(excluded."metaStatus", "WaTemplateWaba"."metaStatus"),
      "reason" = excluded."reason", "submittedAt" = COALESCE(excluded."submittedAt", "WaTemplateWaba"."submittedAt"), "checkedAt" = COALESCE(excluded."checkedAt", "WaTemplateWaba"."checkedAt"), "updatedAt" = excluded."updatedAt"`,
  String(templateId), String(wabaId), p.status || 'draft', p.metaId || null, p.metaStatus || null, S.clip(p.reason || '', 400), p.submittedAt || null, p.checkedAt || null, t);
  readyAt = 0;
}

// ---- the status of one template on one account -------------------------------------------------------------------------------------
const bestOf = (list) => list.reduce((b, r) => (!b || (RANK[r.status] || 0) > (RANK[b.status] || 0) ? r : b), null);
// t = { col: the summary column, metaWaba, metaReason }; rows = this template's WaTemplateWaba rows.  -> { status, reason, src: 'row' | 'legacy' | 'manual' | 'none', checkedAt }
function stateFor(t, rows, wabaId) {
  if (rows.length) {
    const b = bestOf(rows.filter((r) => String(r.wabaId) === String(wabaId)));
    return b ? { status: b.status, reason: b.reason || '', src: 'row', checkedAt: b.checkedAt || null } : { status: 'draft', reason: '', src: 'row', checkedAt: null };
  }
  const col = String(t.col || '').toLowerCase();
  if (['approved', 'pending', 'rejected'].includes(col)) {
    if (t.metaWaba) return String(t.metaWaba) === String(wabaId) ? { status: col, reason: t.metaReason || '', src: 'legacy', checkedAt: null } : { status: 'draft', reason: '', src: 'legacy', checkedAt: null };
    return { status: col, reason: '', src: 'manual', checkedAt: null };
  }
  return { status: 'draft', reason: '', src: t.metaWaba ? 'legacy' : 'none', checkedAt: null };
}
const metaOf = (extraRaw) => { const m = (T.parseExtra(extraRaw) || {}).meta || {}; return { metaWaba: m.wabaId ? String(m.wabaId) : '', metaReason: m.reason || '' }; };

// plain words when a number cannot use the template yet
function reasonText(state, tplName, numberLabel) {
  const who = numberLabel ? `the WhatsApp account of "${numberLabel}"` : 'this number\'s WhatsApp account';
  if (state === 'pending') return `"${tplName}" is still being checked by Meta for ${who}. It can be used from this number as soon as Meta approves it (press "Check with Meta" on the template to see). Until then Meta would refuse it (error 132001).`;
  if (state === 'rejected') return `Meta refused "${tplName}" for ${who}. It cannot be sent from this number. ${FIX_SENTENCE}`;
  if (state === 'other') return `This template ("${tplName}") is approved on another WhatsApp account, so it cannot be sent from this number. Pick a number of that account, or send the template to Meta for this account. ${FIX_SENTENCE}`;
  return `"${tplName}" has not been sent to Meta for ${who} yet, so Meta would refuse it (error 132001). ${FIX_SENTENCE}`;
}

// ---- the accounts (distinct WABAs) ---------------------------------------------------------------------------------------------------
// -> { listed, accounts: [{ wabaId, key, numbers: [{ id, label, displayNumber, usable }], cfg|null }], withoutWaba: [numbers] }   (cfg carries the token: backend only)
async function accounts() {
  const W = WN();
  if (await W.hasNumbers()) {
    const by = new Map(); const none = [];
    for (const r of await W.listRows()) { // eslint-disable-line no-restricted-syntax
      if (!r.active) continue; // eslint-disable-line no-continue
      const cfg = await W.configOf(r); // eslint-disable-line no-await-in-loop
      const usable = !!(cfg && cfg.configured);
      const w = cfg && cfg.wabaId ? String(cfg.wabaId) : '';
      const n = { id: r.id, label: r.label, displayNumber: r.displayNumber, usable };
      if (!w) { none.push(n); continue; } // eslint-disable-line no-continue
      let g = by.get(w);
      if (!g) { g = { wabaId: w, key: keyOf(w), numbers: [], cfg: null }; by.set(w, g); }
      g.numbers.push(n);
      if (usable && !g.cfg) g.cfg = cfg;
    }
    return { listed: true, accounts: [...by.values()], withoutWaba: none };
  }
  const cfg = await wa().legacyConfig();
  const n = { id: 'main', label: 'WhatsApp Business', displayNumber: cfg.display || '', usable: !!cfg.configured };
  if (cfg.wabaId) return { listed: false, accounts: [{ wabaId: cfg.wabaId, key: keyOf(cfg.wabaId), numbers: [n], cfg: cfg.configured ? cfg : null }], withoutWaba: [] };
  return { listed: false, accounts: [], withoutWaba: cfg.phoneId ? [n] : [] };
}

// ---- chips for the screens -----------------------------------------------------------------------------------------------------------
const chipOf = (n, st, tplName, usableAccount) => {
  const offline = !usableAccount && st.status === 'draft';
  const code = offline ? 'offline' : st.status;
  const [tone, word] = WORDS[code];
  return {
    numberId: n.id, label: n.label, status: code, word, tone, ok: code === 'approved',
    reason: code === 'approved' ? '' : (offline ? 'This number is not connected, or its WhatsApp Business Account ID is not saved (Administration > Integrations > WhatsApp numbers).' : (st.status === 'rejected' && st.reason ? `${reasonText('rejected', tplName, n.label)} Meta said: ${st.reason}` : reasonText(st.status === 'draft' ? 'none' : st.status, tplName, n.label))),
    checkedAt: st.checkedAt || null,
  };
};
function chipsOf(tpl, rows, acc) {
  const out = [];
  acc.accounts.forEach((g) => {
    const st = stateFor(tpl, rows, g.wabaId);
    g.numbers.forEach((n) => out.push(chipOf(n, st, tpl.name, !!g.cfg || st.status !== 'draft')));
  });
  acc.withoutWaba.forEach((n) => out.push(chipOf(n, { status: 'draft', reason: '', checkedAt: null }, tpl.name, false)));
  return out;
}
const tplInfo = (r) => ({ name: r.name, col: r.waApprovalStatus, ...metaOf(r.extra) });

// the account overview of ONE template (the Meta panel of the template screen)
async function accountsView(user, id) {
  const row = await T.get(user, id);
  if (!row || row.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (row.channel !== 'whatsapp') return { error: 'Only WhatsApp templates are sent to Meta.', status: 400 };
  const acc = await accounts();
  const rows = (await rowsFor([row.id])).get(row.id) || [];
  const chips = chipsOf(tplInfo(row), rows, acc);
  const admin = A.isAdmin(user);
  return {
    canFix: admin, listed: acc.listed,
    accounts: acc.accounts.map((g) => {
      const st = stateFor(tplInfo(row), rows, g.wabaId);
      const code = !g.cfg && st.status === 'draft' ? 'offline' : st.status;
      return { key: g.key, ...(admin ? { wabaId: g.wabaId } : {}), numbers: g.numbers.map((n) => n.label), status: code, word: WORDS[code][1], tone: WORDS[code][0], connected: !!g.cfg, checkedAt: st.checkedAt };
    }),
    chips,
    summary: { numbers: chips.length, approved: chips.filter((c) => c.ok).length, inReview: chips.filter((c) => c.status === 'pending').length, notSent: chips.filter((c) => ['draft', 'offline'].includes(c.status)).length, rejected: chips.filter((c) => c.status === 'rejected').length },
  };
}

// the list: attach chips to every WhatsApp outreach row (hub items: { id, name, wa: {status}, extra }); one query for all rows
async function decorate(items) {
  const mine = (items || []).filter((i) => i.source === 'outreach' && i.id && i.wa);
  if (!mine.length) return items;
  let acc; let rowsMap;
  try { acc = await accounts(); rowsMap = await rowsFor(mine.map((i) => i.id)); } catch { return items; }
  if (!acc.accounts.length && !acc.withoutWaba.length) return items;
  const word = { None: 'draft', Pending: 'pending', Approved: 'approved', Rejected: 'rejected' };
  return items.map((i) => {
    if (!(i.source === 'outreach' && i.id && i.wa)) return i;
    const info = { name: i.name, col: word[i.wa.status] || 'draft', ...metaOf(i.extra) };
    return { ...i, accountChips: chipsOf(info, rowsMap.get(String(i.id)) || [], acc).map((c) => ({ numberId: c.numberId, label: c.label, status: c.status, word: c.word, tone: c.tone })) };
  });
}
// the Communication Console: for every WhatsApp template the status per sender number  ('wan:<id>' like the console's account ids)
async function byNumber(items) {
  const out = new Map();
  try {
    const mine = (items || []).filter((i) => i.id && i.key && String(i.key).startsWith('outreach:'));
    if (!mine.length) return out;
    const acc = await accounts();
    if (!acc.listed) return out; // one single connection: nothing differs between senders
    const rowsMap = await rowsFor(mine.map((i) => i.id));
    const word = { None: 'draft', Pending: 'pending', Approved: 'approved', Rejected: 'rejected' };
    mine.forEach((i) => {
      if (!i.wa) return;
      const info = { name: i.name, col: word[i.wa.status] || 'draft', ...metaOf(i.extra) };
      const m = {};
      chipsOf(info, rowsMap.get(String(i.id)) || [], acc).forEach((c) => { m[`wan:${c.numberId}`] = { ok: c.ok, status: c.status, word: c.word, reason: c.reason }; });
      out.set(i.key, m);
    });
  } catch { /* the console works without it */ }
  return out;
}

// ---- the send path's check (no network) ---------------------------------------------------------------------------------------------
// cfg = the connection of the sending number (carries wabaId + label).  -> null (go ahead) | { code, state, reason, templateId }
async function guard(cfg, name) {
  try {
    if (!name || !cfg || !cfg.wabaId) return null;
    const tpls = await q('SELECT id, name, waApprovalStatus, extra FROM "OutreachTemplate" WHERE "waTemplateName" = ? LIMIT 8', String(name));
    if (!tpls.length) return null;
    const rowsMap = await rowsFor(tpls.map((t) => t.id));
    const w = String(cfg.wabaId);
    const blocks = [];
    for (const t of tpls) {
      const rows = rowsMap.get(t.id) || [];
      const info = tplInfo(t);
      if (rows.length) {
        const st = stateFor(info, rows, w);
        if (st.status === 'approved') return null;
        blocks.push({ templateId: t.id, state: st.status === 'draft' ? 'none' : st.status, rank: RANK[st.status], why: st.reason });
      } else if (info.metaWaba) {
        if (info.metaWaba === w) return null;
        blocks.push({ templateId: t.id, state: 'other', rank: 0, why: '' });
      } else return null; // nothing known about accounts (an Admin recorded the approval by hand, or it was made in Meta Business Manager): as before
    }
    const b = blocks.sort((x, y) => y.rank - x.rank)[0];
    if (!b) return null;
    let reason = reasonText(b.state, name, cfg.label || '');
    if (b.state === 'rejected' && b.why) reason = `${reason} Meta said: ${b.why}`;
    return { code: 'TEMPLATE_OTHER_ACCOUNT', state: b.state, reason, templateId: b.templateId };
  } catch { return null; }
}

// ---- keeping the rows and the summary in step -----------------------------------------------------------------------------------------
const summaryOf = (rows) => { const b = bestOf(rows); return b ? b.status : null; };
async function aggregate(templateId) {
  if (!(await ready())) return null;
  const rows = (await rowsFor([templateId])).get(String(templateId)) || [];
  const s = summaryOf(rows);
  if (!s) return null;
  await run('UPDATE "OutreachTemplate" SET waApprovalStatus = ? WHERE id = ?', s, templateId);
  return s;
}
// the old single "Send to Meta" / "Check with Meta" (one account) writes its answer here too, so both ways always agree. Never throws.
async function mirror(templateId, wabaId, p) {
  try {
    if (!wabaId) return;
    await put(templateId, wabaId, p);
    await aggregate(templateId);
  } catch (e) { console.error('[wa-template-waba] mirror:', e.message); } // eslint-disable-line no-console
}
// the words of a template changed: every account must look again
async function resetFor(templateId) {
  try {
    if (!(await ready())) return;
    await run('UPDATE "WaTemplateWaba" SET "status" = \'draft\', "reason" = \'\', "updatedAt" = ? WHERE "templateId" = ? AND "status" <> \'draft\'', nowIso(), String(templateId));
    readyAt = 0;
  } catch { /* the summary column was already reset */ }
}
// a template sent or approved before this change: its one known account becomes a row (so the other accounts can be asked without losing it)
async function backfill(row) {
  const ex = T.parseExtra(row.extra);
  const col = String(row.waApprovalStatus || '').toLowerCase();
  if (!ex.meta || !ex.meta.wabaId || !['approved', 'pending', 'rejected'].includes(col)) return;
  const have = (await rowsFor([row.id])).get(row.id) || [];
  if (have.some((r) => String(r.wabaId) === String(ex.meta.wabaId))) return;
  await put(row.id, String(ex.meta.wabaId), { status: col, metaId: ex.meta.id || null, metaStatus: ex.meta.status || null, reason: ex.meta.reason || '', submittedAt: ex.meta.submittedAt || null, checkedAt: ex.meta.checkedAt || null });
}

// ---- asking Meta -------------------------------------------------------------------------------------------------------------------------
async function lookup(cfg, name) {
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const res = await core.httpJson(`${cfg.base}/${wa().VERSION}/${encodeURIComponent(cfg.wabaId)}/message_templates?name=${encodeURIComponent(name)}&fields=id,name,status,category,rejected_reason,quality_score`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) return { error: `Meta could not be asked: ${S.clip((res.json && res.json.error && res.json.error.message) || res.networkError || res.text || res.status, 200)}` };
  const hit = res.json && Array.isArray(res.json.data) ? res.json.data.find((d) => d.name === name) : null;
  return { hit: hit || null };
}
const fromHit = (hit) => ({
  status: META_STATUS[String(hit.status || '').toUpperCase()] || 'pending', metaId: hit.id ? String(hit.id) : null, metaStatus: String(hit.status || ''),
  reason: hit.rejected_reason && hit.rejected_reason !== 'NONE' ? String(hit.rejected_reason) : '', checkedAt: nowIso(),
});

// the checks both Admin actions share. -> { row, v, pol, built, acc, targets } | { error, status }
async function prepare(user, id, { forSubmit }) {
  const row = await T.get(user, id);
  if (!row || row.status !== 'active') return { error: 'This template was not found.', status: 404 };
  if (row.channel !== 'whatsapp') return { error: 'Only WhatsApp templates are sent to Meta.', status: 400 };
  if (!T.canEdit(user, row.audience)) return { error: 'You cannot change this template.', status: 403 };
  const v = T.view(row);
  let pol = null; let built = null;
  if (forSubmit) {
    pol = P.check(Meta.policyInput(v));
    if (pol.errors) return { error: `Cannot send yet: ${pol.issues.find((i) => i.severity === 'error').message}`, status: 400, issues: pol.issues };
    built = Meta.buildPayload(v);
    if (built.error) return { error: built.error, status: 400 };
  }
  const acc = await accounts();
  const targets = acc.accounts.filter((g) => g.cfg);
  if (!targets.length) {
    const why = acc.accounts.length ? 'No number of any WhatsApp account is connected right now. Check the numbers in Administration > Integrations > WhatsApp numbers.' : (acc.withoutWaba.length ? 'The WhatsApp Business Account ID (WABA ID) is missing on the numbers, so templates cannot be sent to Meta from here. Add it in Administration > Integrations > WhatsApp numbers.' : Meta.NOT_CONNECTED);
    return { error: why, status: 409, code: acc.accounts.length || acc.withoutWaba.length ? 'no_waba' : 'not_connected' };
  }
  if (targets.some((g) => wa().simulated(g.cfg))) return { error: forSubmit ? 'This is test mode: nothing is sent to Meta.' : 'This is test mode: Meta is not asked.', status: 409, code: 'test_mode' };
  return { row, v, pol, built, acc, targets };
}
const labelsOf = (g) => g.numbers.map((n) => n.label);

// Admin: send the template to Meta once for EVERY distinct account
async function submitAll(user, id) {
  if (!A.isAdmin(user)) return { error: 'Only an Admin can send a template to every number\'s WhatsApp account.', status: 403 };
  const p = await prepare(user, id, { forSubmit: true });
  if (p.error) return p;
  const { row, pol, built, acc, targets } = p;
  const name = built.payload.name;
  await ensure();
  await backfill(row);
  const have = (await rowsFor([row.id])).get(row.id) || [];
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const results = [];
  for (const g of targets) { // eslint-disable-line no-restricted-syntax
    const cur = have.find((r) => String(r.wabaId) === g.wabaId);
    const base = { account: g.key, numbers: labelsOf(g) };
    if (cur && (cur.status === 'approved' || cur.status === 'pending')) { results.push({ ...base, action: 'already', status: cur.status, word: WORDS[cur.status][1] }); continue; } // eslint-disable-line no-continue
    const look = await lookup(g.cfg, name); // eslint-disable-line no-await-in-loop
    if (look.error) { results.push({ ...base, action: 'failed', status: 'draft', word: WORDS.draft[1], error: look.error }); continue; } // eslint-disable-line no-continue
    if (look.hit && fromHit(look.hit).status !== 'rejected') { // Meta already has it in this account (made by hand in Business Manager, or sent earlier): copy its answer
      const f = fromHit(look.hit);
      await put(row.id, g.wabaId, f); // eslint-disable-line no-await-in-loop
      results.push({ ...base, action: 'found', status: f.status, word: WORDS[f.status][1] });
      continue; // eslint-disable-line no-continue
    }
    const res = await core.httpJson(`${g.cfg.base}/${wa().VERSION}/${encodeURIComponent(g.wabaId)}/message_templates`, { method: 'POST', headers: { authorization: `Bearer ${g.cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(built.payload) }); // eslint-disable-line no-await-in-loop
    const submittedAt = nowIso();
    if (!(res.ok && res.json && res.json.id)) {
      const e = (res.json && res.json.error) || {};
      const said = S.clip(res.networkError || e.error_user_msg || e.message || res.text || `HTTP ${res.status}`, 300);
      await put(row.id, g.wabaId, { status: 'draft', reason: `Meta did not accept it: ${said}`, submittedAt }); // eslint-disable-line no-await-in-loop
      results.push({ ...base, action: 'failed', status: 'draft', word: WORDS.draft[1], error: `Meta did not accept it: ${said}` });
      continue; // eslint-disable-line no-continue
    }
    const status = META_STATUS[String(res.json.status || 'PENDING').toUpperCase()] || 'pending';
    await put(row.id, g.wabaId, { status, metaId: String(res.json.id), metaStatus: String(res.json.status || 'PENDING'), reason: '', submittedAt }); // eslint-disable-line no-await-in-loop
    results.push({ ...base, action: 'sent', status, word: WORDS[status][1] });
  }
  await settle(user, row, pol, built.payload.name);
  const sent = results.filter((r) => r.action === 'sent').length;
  await logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp template sent to every WhatsApp account', entity: 'OutreachTemplate', entityId: row.id, toValue: `${name}: ${sent} account${sent === 1 ? '' : 's'} sent, ${results.filter((r) => r.action === 'already' || r.action === 'found').length} already there, ${results.filter((r) => r.action === 'failed').length} failed (of ${targets.length})` });
  return { ok: true, results, ...(await finish(user, row.id, acc)) };
}

// Ask every account what Meta says now. Only Meta's answer is copied.
async function checkAll(user, id) {
  const p = await prepare(user, id, { forSubmit: false });
  if (p.error) return p;
  const { row, acc, targets } = p;
  const name = P.slug(row.waTemplateName || row.name);
  await ensure();
  await backfill(row);
  const have = (await rowsFor([row.id])).get(row.id) || [];
  const results = [];
  for (const g of targets) { // eslint-disable-line no-restricted-syntax
    const base = { account: g.key, numbers: labelsOf(g) };
    const look = await lookup(g.cfg, name); // eslint-disable-line no-await-in-loop
    if (look.error) { results.push({ ...base, action: 'failed', error: look.error }); continue; } // eslint-disable-line no-continue
    if (!look.hit) {
      const cur = have.find((r) => String(r.wabaId) === g.wabaId);
      if (cur && cur.status !== 'draft') await put(row.id, g.wabaId, { status: 'draft', reason: 'Meta does not know a template with this name in this account.', checkedAt: nowIso() }); // eslint-disable-line no-await-in-loop
      results.push({ ...base, action: 'unknown', status: 'draft', word: WORDS.draft[1] });
      continue; // eslint-disable-line no-continue
    }
    const f = fromHit(look.hit);
    await put(row.id, g.wabaId, f); // eslint-disable-line no-await-in-loop
    results.push({ ...base, action: 'checked', status: f.status, word: WORDS[f.status][1] });
  }
  await settle(user, row, null, name);
  return { ok: true, results, ...(await finish(user, row.id, acc)) };
}

// the summary column + the old "Details" record follow the rows
async function settle(user, row, pol, waName) {
  const rows = (await rowsFor([row.id])).get(row.id) || [];
  const b = bestOf(rows);
  if (!b) return;
  const cur = T.parseExtra((await q('SELECT extra FROM "OutreachTemplate" WHERE id = ?', row.id))[0].extra);
  const meta = { ...(cur.meta || {}), id: b.metaId || (cur.meta || {}).id, status: b.metaStatus || (cur.meta || {}).status, reason: b.reason || '', checkedAt: b.checkedAt || (cur.meta || {}).checkedAt, submittedAt: b.submittedAt || (cur.meta || {}).submittedAt, wabaId: b.wabaId };
  const review = { ...(cur.review || {}), source: 'meta', ...(pol ? { submittedAt: b.submittedAt || nowIso(), by: user.name, localVerdict: Meta.verdictWords(pol), issues: pol.issues } : {}) };
  await Meta.writeBack(user, row, { status: b.status, waName: waName || null, extra: { meta, review } });
}
async function finish(user, id, acc) {
  const row = (await q('SELECT * FROM "OutreachTemplate" WHERE id = ?', id))[0];
  const rows = (await rowsFor([id])).get(id) || [];
  return { template: T.view(row), chips: chipsOf(tplInfo(row), rows, acc).map((c) => ({ numberId: c.numberId, label: c.label, status: c.status, word: c.word, tone: c.tone, ok: c.ok, reason: c.reason })) };
}

const bust = () => { readyAt = 0; };
module.exports = { bust, ensure, ready, rowsFor, put, accounts, stateFor, chipsOf, accountsView, decorate, byNumber, guard, reasonText, aggregate, mirror, resetFor, backfill, submitAll, checkAll, DDL, FIX_SENTENCE };

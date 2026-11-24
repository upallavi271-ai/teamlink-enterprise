// ---------------------------------------------------------------------------
// CRM WAVE D - TEAMWORK & SECURITY (2026-11-24)
//   comments / @mentions   a comment on a lead, deal or account; @Name tells that teammate (a bell; an email only when the Admin turns it on)
//   deal room              the same thread on a deal, read live as a team chat, with who is in it
//   approvals inbox        one list of what waits for a Sales manager: deal discounts, quotes; and my own mentions
//   field-level security   per CRM role (Sales manager / Salesperson / Viewer): a field hidden, or read only
//   field history          every changed field of a lead, account, contact or deal: from, to, who, when (+ one Audit Logs line)
//   territories            regions in a tree (states / cities / industries), worked out for accounts and leads; new leads may go to
//                          the territory's salespeople in turn (OFF until the Admin turns it on)
//   sub-teams              sales teams with their own manager: the manager reads the team's records (changes only their own)
//   IP restriction         the CRM opens only from the listed office addresses (OFF until an Admin turns it on; Super Admin always in)
//   ownership transfer     everything of one salesperson to another in one go (someone leaves), and many accounts / contacts at once
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./service');
const SETTINGS = require('./settings');
const P = require('./plusSchema');

const isAdminRole = (r) => r === 'admin';
const managerOnly = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'Only a Sales manager or an Admin can change this.'));
const sid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const KIND_TABLE = { lead: 'CrmLead', deal: 'CrmDeal', account: 'CrmAccount', contact: 'CrmContact' };
const KIND_PATH = { lead: 'leads', deal: 'deals', account: 'accounts', contact: 'accounts' };

// ---- sub-teams (AppSetting crm.plus.teams) --------------------------------------------------------------------------------
function cleanTeams(v = {}) {
  const teams = (Array.isArray(v.teams) ? v.teams : []).map((t) => ({ id: String((t && t.id) || sid('tm')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40), name: String((t && t.name) || '').trim().slice(0, 60), managerId: String((t && t.managerId) || '').slice(0, 60) || null, parentId: (t && t.parentId) ? String(t.parentId).slice(0, 40) : null, memberIds: [...new Set((Array.isArray(t && t.memberIds) ? t.memberIds : []).map((x) => String(x).slice(0, 60)))].slice(0, 100) })).filter((t) => t.name).slice(0, 40);
  const ids = new Set(teams.map((t) => t.id));
  teams.forEach((t) => { if (t.parentId && (!ids.has(t.parentId) || t.parentId === t.id)) t.parentId = null; });
  return { teams };
}
async function teams() { return cleanTeams(await P.getCfg('teams', { teams: [] })); }
// the salespeople whose records a sub-team manager reads (their teams, and the teams under those), never themselves
function managedIds(userId) {
  if (!userId) return [];
  const { teams: list } = cleanTeams(P.cachedCfg('teams', { teams: [] }));
  const mine = list.filter((t) => t.managerId === userId);
  if (!mine.length) return [];
  const out = new Set(); const seen = new Set();
  const walk = (t) => { if (seen.has(t.id)) return; seen.add(t.id); t.memberIds.forEach((m) => out.add(m)); if (t.managerId) out.add(t.managerId); list.filter((c) => c.parentId === t.id).forEach(walk); };
  mine.forEach(walk);
  out.delete(userId);
  return [...out];
}
async function saveTeams(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const next = cleanTeams(body);
  const st = await SETTINGS.load({ fresh: true });
  const onList = new Set(st.salesTeam.map((m) => m.userId));
  for (const t of next.teams) {
    if (t.managerId && !onList.has(t.managerId)) return S.fail(400, `The manager of "${t.name}" is not on the CRM sales team list.`);
    const off = t.memberIds.find((m) => !onList.has(m));
    if (off) return S.fail(400, `A member of "${t.name}" is not on the CRM sales team list.`);
  }
  // no loops in the tree
  for (const t of next.teams) { let p = t.parentId; const seen = new Set([t.id]); while (p) { if (seen.has(p)) return S.fail(400, `"${t.name}" cannot sit under itself.`); seen.add(p); p = (next.teams.find((x) => x.id === p) || {}).parentId; } }
  await P.setCfg('teams', next);
  await S.audit(user, 'CRM sub-teams changed', 'CrmSettings', 'teams', next.teams.map((t) => `${t.name} (${t.memberIds.length})`).join('; '));
  return S.okBody({ ok: true, ...next });
}

// ---- field-level security ---------------------------------------------------------------------------------------------
const FIELDS = {
  lead: { contactName: 'Contact name', designation: 'Designation', phone: 'Phone', email: 'Email', industry: 'Industry', city: 'City', source: 'Source', rating: 'Rating', expectedValue: 'Expected value', notes: 'Notes' },
  account: { industry: 'Industry', city: 'City', website: 'Website', phone: 'Phone', email: 'Email', source: 'Source', gstin: 'GSTIN', address: 'Address', state: 'State', pincode: 'Pincode', tags: 'Tags', notes: 'Notes' },
  contact: { designation: 'Designation', role: 'Role', phone: 'Phone', email: 'Email', notes: 'Notes' },
  deal: { value: 'Deal value', discountPercent: 'Discount %', finalValue: 'Final value', probability: 'Probability', expectedClose: 'Expected close', nextStep: 'Next step', notes: 'Notes' },
};
const FS_ROLES = ['manager', 'rep', 'viewer'];
function cleanFieldSec(v = {}) {
  const rules = {};
  FS_ROLES.forEach((role) => {
    rules[role] = {};
    Object.keys(FIELDS).forEach((kind) => {
      const given = ((v.rules || {})[role] || {})[kind] || {};
      const out = {};
      Object.keys(FIELDS[kind]).forEach((f) => { if (['hide', 'read'].includes(given[f])) out[f] = given[f]; });
      if (Object.keys(out).length) rules[role][kind] = out;
    });
  });
  return { rules };
}
async function fieldSec() { return cleanFieldSec(await P.getCfg('fieldsec', {})); }
async function saveFieldSec(user, body = {}) {
  if (!isAdminRole(S.roleOf(user))) return S.fail(403, 'Only an Admin can change who sees which field.');
  const next = cleanFieldSec(body);
  await P.setCfg('fieldsec', next);
  await S.audit(user, 'CRM field security changed', 'CrmSettings', 'fieldsec', JSON.stringify(next.rules).slice(0, 280));
  return S.okBody({ ok: true, ...next, fields: FIELDS });
}
const fsRoleOf = (r) => (r === 'tl' ? 'manager' : r === 'view' ? 'viewer' : r === 'bde' || r === 'bdeAll' ? 'rep' : null);
function rulesFor(user, kind) {
  const role = fsRoleOf(S.roleOf(user));
  if (!role) return {};
  const { rules } = cleanFieldSec(P.cachedCfg('fieldsec', {}));
  return (rules[role] || {})[kind] || {};
}
const hiddenOf = (user, kind) => Object.entries(rulesFor(user, kind)).filter(([, m]) => m === 'hide').map(([f]) => f);
// a record (or rows) with the hidden fields taken out, for this person
function stripRow(user, kind, row) {
  if (!row || typeof row !== 'object') return row;
  const hid = hiddenOf(user, kind);
  if (!hid.length) return row;
  const out = { ...row };
  hid.forEach((f) => { if (f in out) out[f] = null; });
  out.hiddenFields = hid;
  return out;
}
const PATH_KIND = { leads: 'lead', deals: 'deal', accounts: 'account', contacts: 'contact' };
// the JSON of a CRM answer, with each record's hidden fields taken out (lists, one record and its related records)
function stripBody(user, path, body) {
  if (!body || typeof body !== 'object') return body;
  const anyRules = fsRoleOf(S.roleOf(user));
  if (!anyRules) return body;
  const out = { ...body };
  const first = String(path || '').split('/').filter(Boolean)[0];
  if (Array.isArray(out.rows) && PATH_KIND[first]) out.rows = out.rows.map((x) => stripRow(user, PATH_KIND[first], x));
  ['lead', 'deal', 'account', 'contact'].forEach((k) => { if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = stripRow(user, k, out[k]); });
  [['deals', 'deal'], ['contacts', 'contact'], ['leads', 'lead'], ['accounts', 'account']].forEach(([key, k]) => { if (Array.isArray(out[key])) out[key] = out[key].map((x) => (x && typeof x === 'object' ? stripRow(user, k, x) : x)); });
  return out;
}
function csvHidden(user, kind) { return new Set(hiddenOf(user, { leads: 'lead', deals: 'deal', accounts: 'account', contacts: 'contact' }[kind] || kind)); }

// ---- hooks for crm/service.js edit(): field security on the way in, the field history on the way out --------------------
function beforeEdit(user, kind, row, data) {
  const rules = rulesFor(user, kind);
  for (const [f, mode] of Object.entries(rules)) {
    if (!(f in data)) continue; // eslint-disable-line no-continue
    if (mode === 'hide') { delete data[f]; continue; } // eslint-disable-line no-continue
    const was = row[f] == null ? '' : String(row[f]); const now = data[f] == null ? '' : String(data[f]);
    if (was !== now && !(Number.isFinite(Number(was)) && was !== '' && Number(was) === Number(now))) return { error: `You may read "${FIELDS[kind][f]}" but not change it (CRM settings > Field security).` };
    delete data[f];
  }
  return { ok: true };
}
const TRACK = {
  lead: ['company', 'contactName', 'designation', 'phone', 'email', 'industry', 'city', 'source', 'status', 'rating', 'notes', 'expectedValue', 'ownerName', 'territoryId'],
  account: ['name', 'industry', 'city', 'website', 'phone', 'email', 'source', 'gstin', 'address', 'state', 'pincode', 'tags', 'notes', 'ownerName', 'kind', 'territoryId'],
  contact: ['accountId', 'name', 'designation', 'role', 'phone', 'email', 'notes', 'ownerName'],
  deal: ['title', 'accountId', 'contactId', 'value', 'discountPercent', 'finalValue', 'probability', 'expectedClose', 'nextStep', 'notes', 'ownerName', 'approvalStatus', 'forecastCategory', 'billing', 'termMonths'],
};
const LABEL = { ...FIELDS.lead, ...FIELDS.account, ...FIELDS.contact, ...FIELDS.deal, company: 'Company', name: 'Name', title: 'Deal name', status: 'Status', ownerName: 'Owner', territoryId: 'Territory', kind: 'Type', accountId: 'Account', contactId: 'Contact', approvalStatus: 'Discount approval', forecastCategory: 'Forecast category', billing: 'Billing', termMonths: 'Term (months)' };
async function afterEdit(user, kind, before, after) {
  if (!before || !after || !TRACK[kind]) return [];
  await P.ensure();
  const at = new Date().toISOString();
  const changes = TRACK[kind].filter((f) => String(before[f] == null ? '' : before[f]) !== String(after[f] == null ? '' : after[f]));
  for (const f of changes) {
    // eslint-disable-next-line no-await-in-loop
    await P.run('INSERT INTO "CrmFieldHistory" ("id", "kind", "recordId", "field", "fromValue", "toValue", "byId", "byName", "at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('fh'), kind, after.id, f, before[f] == null ? null : String(before[f]).slice(0, 1000), after[f] == null ? null : String(after[f]).slice(0, 1000), user.id || null, user.name || null, at);
  }
  if (changes.length) await S.audit(user, `CRM ${kind} fields changed`, KIND_TABLE[kind], after.id, changes.map((f) => `${LABEL[f] || f}: ${String(before[f] == null ? '-' : before[f]).slice(0, 40)} -> ${String(after[f] == null ? '-' : after[f]).slice(0, 40)}`).join('; '));
  return changes;
}
async function fieldHistory(user, kind, id) {
  if (!KIND_TABLE[kind]) return S.fail(404, 'Nothing here.');
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  if (!S.canSeeRow(user, r, row)) return S.fail(404, 'This record is not there, or it is not yours.');
  const hid = new Set(hiddenOf(user, kind));
  const rows = (await P.all('SELECT * FROM "CrmFieldHistory" WHERE "kind" = ? AND "recordId" = ? ORDER BY "at" DESC LIMIT 500', kind, row.id))
    .map((x) => (hid.has(x.field) ? { ...x, fromValue: '(hidden)', toValue: '(hidden)' } : x)).map((x) => ({ ...x, label: LABEL[x.field] || x.field }));
  return S.okBody({ history: rows });
}

// ---- territories ---------------------------------------------------------------------------------------------------------
function cleanTerritories(v = {}) {
  const list = (x) => [...new Set((Array.isArray(x) ? x : String(x || '').split(/\n|,/)).map((y) => String(y || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 80);
  const territories = (Array.isArray(v.territories) ? v.territories : []).map((t) => ({ id: String((t && t.id) || sid('ter')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40), name: String((t && t.name) || '').trim().slice(0, 60), parentId: (t && t.parentId) ? String(t.parentId).slice(0, 40) : null, states: list(t && t.states), cities: list(t && t.cities), industries: list(t && t.industries), ownerIds: [...new Set((Array.isArray(t && t.ownerIds) ? t.ownerIds : []).map((x) => String(x).slice(0, 60)))].slice(0, 50) })).filter((t) => t.name).slice(0, 80);
  const ids = new Set(territories.map((t) => t.id));
  territories.forEach((t) => { if (t.parentId && (!ids.has(t.parentId) || t.parentId === t.id)) t.parentId = null; });
  return { territories, autoAssign: v.autoAssign === true };
}
async function territories() { return cleanTerritories(await P.getCfg('territories', {})); }
const depthOf = (list, t) => { let d = 0; let p = t.parentId; const seen = new Set(); while (p && !seen.has(p)) { seen.add(p); d += 1; p = (list.find((x) => x.id === p) || {}).parentId; } return d; };
// the deepest territory whose rules fit the record: each rule that is filled in must fit, a rule on a field the record does not have (a lead
// has no state) is left out, and at least one rule must have been checked (a territory with no rules fits nothing)
function matchTerritory(list, rec) {
  const lc = (s) => String(s || '').trim().toLowerCase();
  const fits = list.filter((t) => {
    let checked = 0;
    for (const [rule, field] of [[t.states, 'state'], [t.cities, 'city'], [t.industries, 'industry']]) {
      if (!rule.length || rec[field] === undefined) continue; // eslint-disable-line no-continue
      checked += 1;
      if (!rule.some((x) => lc(x) === lc(rec[field]))) return false;
    }
    return checked > 0;
  });
  return fits.sort((a, b) => depthOf(list, b) - depthOf(list, a))[0] || null;
}
async function saveTerritories(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const next = cleanTerritories(body);
  for (const t of next.territories) { let p = t.parentId; const seen = new Set([t.id]); while (p) { if (seen.has(p)) return S.fail(400, `"${t.name}" cannot sit under itself.`); seen.add(p); p = (next.territories.find((x) => x.id === p) || {}).parentId; } }
  await P.setCfg('territories', next);
  await S.audit(user, 'CRM territories changed', 'CrmSettings', 'territories', `${next.territories.length} territories; auto assign ${next.autoAssign ? 'on' : 'off'}`);
  return S.okBody({ ok: true, ...next });
}
async function applyTerritories(user, { all } = {}) {
  const no = managerOnly(user); if (no) return no;
  const { territories: list } = await territories();
  await P.ensure();
  let set = 0;
  for (const [kind, table] of [['account', 'CrmAccount'], ['lead', 'CrmLead']]) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await P.all(`SELECT "id", ${kind === 'account' ? '"state", ' : ''}"city", "industry", "territoryId" FROM "${table}" ${all ? '' : 'WHERE "territoryId" IS NULL'}`);
    for (const x of rows) {
      const t = matchTerritory(list, x);
      const id = t ? t.id : (all ? null : x.territoryId);
      // eslint-disable-next-line no-await-in-loop
      if ((id || null) !== (x.territoryId || null)) { await P.run(`UPDATE "${table}" SET "territoryId" = ? WHERE "id" = ?`, id, x.id); set += 1; }
    }
  }
  await S.audit(user, 'CRM territories worked out', 'CrmSettings', 'territories', `${set} records`);
  return S.okBody({ ok: true, set });
}
async function setTerritory(user, kind, id, { territoryId } = {}) {
  if (!['lead', 'account'].includes(kind)) return S.fail(400, 'A territory is set on a lead or an account.');
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  if (!S.canEditRow(user, r, row)) return S.fail(row && S.canSeeRow(user, r, row) ? 403 : 404, 'You cannot change this record.');
  const { territories: list } = await territories();
  if (territoryId && !list.some((t) => t.id === territoryId)) return S.fail(400, 'Pick a territory from the list.');
  const saved = await S.update(KIND_TABLE[kind], row.id, { territoryId: territoryId || null, updatedAt: new Date().toISOString() });
  await afterEdit(user, kind, row, saved);
  return S.okBody({ ok: true, [kind]: saved });
}
async function territoryReport(user) {
  const r = S.roleOf(user);
  const { territories: list, autoAssign } = await territories();
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const acc = await P.all(`SELECT x."territoryId", COUNT(*) AS "n" FROM "CrmAccount" x WHERE ${sc.sql} GROUP BY x."territoryId"`, ...sc.params);
  const leads = await P.all(`SELECT x."territoryId", COUNT(*) AS "n" FROM "CrmLead" x WHERE ${sc.sql} AND x."status" NOT IN ('Converted', 'Junk') GROUP BY x."territoryId"`, ...sc.params);
  const open = await P.all(`SELECT a."territoryId", COALESCE(SUM(x."value"), 0) AS "v", COUNT(*) AS "n" FROM "CrmDeal" x JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${sc.sql} AND x."stage" NOT IN ('Won', 'Lost') GROUP BY a."territoryId"`, ...sc.params);
  const get = (arr, id, k = 'n') => Number((arr.find((x) => (x.territoryId || null) === id) || {})[k]) || 0;
  const people = new Map((await S.ownerOptions()).map((o) => [o.id, o.name]));
  return S.okBody({ autoAssign, territories: list.map((t) => ({ ...t, depth: depthOf(list, t), owners: t.ownerIds.map((id) => ({ id, name: people.get(id) || id })), accounts: get(acc, t.id), leads: get(leads, t.id), openDeals: get(open, t.id), openValue: get(open, t.id, 'v') })), none: { accounts: get(acc, null), leads: get(leads, null), openDeals: get(open, null), openValue: get(open, null, 'v') } });
}
// a new lead / account gets its territory; a new lead a manager left without an owner goes to the territory's salespeople in turn (only when turned on)
async function afterCreateRecord(user, kind, row, body = {}) {
  if (!['lead', 'account'].includes(kind)) return row;
  const cfg = await territories();
  if (!cfg.territories.length) return row;
  const t = matchTerritory(cfg.territories, row);
  if (!t) return row;
  const data = { territoryId: t.id };
  if (kind === 'lead' && cfg.autoAssign && !body.ownerId && S.mayAssign(S.roleOf(user)) && t.ownerIds.length) {
    const opts = new Map((await S.ownerOptions()).map((o) => [o.id, o.name]));
    const people = t.ownerIds.filter((id) => opts.has(id));
    if (people.length) {
      const turn = await P.getCfg('terrTurn', {});
      const n = (Number(turn[t.id]) || 0) % people.length;
      await P.setCfg('terrTurn', { ...turn, [t.id]: n + 1 });
      data.ownerId = people[n]; data.ownerName = opts.get(people[n]);
    }
  }
  const saved = await S.update(KIND_TABLE[kind], row.id, data);
  if (data.ownerId && data.ownerId !== row.ownerId) await S.audit(user, 'CRM lead given by territory', 'CrmLead', row.id, `${t.name}: ${data.ownerName}`);
  return saved;
}

// ---- IP restriction (AppSetting crm.plus.access) -----------------------------------------------------------------------------
const ipOf = (req) => String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '').replace(/^::ffff:/, '');
const v4 = (ip) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip); return m ? m.slice(1).reduce((n, x) => ((n << 8) + Number(x)) >>> 0, 0) : null; }; // eslint-disable-line no-bitwise
function ipMatches(ip, rule) {
  const r = String(rule || '').trim();
  if (!r) return false;
  if (r.includes('/')) {
    const [base, bitsS] = r.split('/'); const bits = Number(bitsS);
    const a = v4(ip); const b = v4(base);
    if (a == null || b == null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; // eslint-disable-line no-bitwise
    return ((a & mask) >>> 0) === ((b & mask) >>> 0); // eslint-disable-line no-bitwise
  }
  return ip === r.replace(/^::ffff:/, '');
}
const validIpRule = (r) => { const s = String(r || '').trim(); if (s.includes('/')) { const [b, n] = s.split('/'); return v4(b) != null && Number(n) >= 0 && Number(n) <= 32; } return v4(s) != null || /^[0-9a-f:]+$/i.test(s); };
function cleanAccess(v = {}) {
  return { ipRestrict: v.ipRestrict === true, allowed: [...new Set((Array.isArray(v.allowed) ? v.allowed : String(v.allowed || '').split(/\n|,/)).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 50) };
}
async function access() { return cleanAccess(await P.getCfg('access', {})); }
async function ipAllowed(req) {
  const cfg = await access();
  if (!cfg.ipRestrict || !cfg.allowed.length) return true;
  if (req.user && req.user.role === 'SUPER_ADMIN') return true; // the founder is never locked out of his own CRM
  const ip = ipOf(req);
  return cfg.allowed.some((rule) => ipMatches(ip, rule));
}
async function saveAccess(user, body = {}, req) {
  if (!isAdminRole(S.roleOf(user))) return S.fail(403, 'Only an Admin can change where the CRM may be opened from.');
  const next = cleanAccess(body);
  const bad = next.allowed.find((x) => !validIpRule(x));
  if (bad) return S.fail(400, `"${bad}" is not an IP address or a range like 203.0.113.0/24.`);
  if (next.ipRestrict && !next.allowed.length) return S.fail(400, 'List at least one office address before turning this on.');
  const ip = ipOf(req);
  if (next.ipRestrict && user.role !== 'SUPER_ADMIN' && !next.allowed.some((rule) => ipMatches(ip, rule))) return S.fail(400, `Your own address (${ip}) is not on the list - you would lock yourself out. Add it first.`);
  await P.setCfg('access', next);
  await S.audit(user, 'CRM IP restriction changed', 'CrmSettings', 'access', `${next.ipRestrict ? 'on' : 'off'}: ${next.allowed.join(', ')}`);
  return S.okBody({ ok: true, ...next, yourIp: ip });
}

// ---- ownership transfer ---------------------------------------------------------------------------------------------------
const TRANSFER = {
  lead: { table: 'CrmLead', open: '"status" NOT IN (\'Converted\', \'Junk\')', label: 'leads' },
  account: { table: 'CrmAccount', open: '1=1', label: 'accounts' },
  contact: { table: 'CrmContact', open: '1=1', label: 'contacts' },
  deal: { table: 'CrmDeal', open: '"stage" NOT IN (\'Won\', \'Lost\')', label: 'deals' },
  task: { table: 'CrmTask', open: '"status" = \'Open\'', label: 'follow-ups' },
  invoice: { table: 'CrmInvoice', open: '"status" NOT IN (\'Paid\', \'Cancelled\')', label: 'invoices' },
  contract: { table: 'CrmContract', open: '"status" IN (\'Draft\', \'Active\')', label: 'contracts' },
};
async function transferPreview(user, { fromId } = {}) {
  const no = managerOnly(user); if (no) return no;
  await P.ensure();
  const id = String(fromId || '').slice(0, 60);
  const out = {};
  for (const [k, t] of Object.entries(TRANSFER)) {
    // eslint-disable-next-line no-await-in-loop
    const all = await P.one(`SELECT COUNT(*) AS "n" FROM "${t.table}" WHERE "ownerId" = ?`, id);
    // eslint-disable-next-line no-await-in-loop
    const open = await P.one(`SELECT COUNT(*) AS "n" FROM "${t.table}" WHERE "ownerId" = ? AND ${t.open}`, id);
    out[k] = { all: Number(all.n) || 0, open: Number(open.n) || 0, label: t.label };
  }
  return S.okBody({ counts: out });
}
async function transfer(user, { fromId, toId, kinds, openOnly = true } = {}) {
  const no = managerOnly(user); if (no) return no;
  const from = String(fromId || '').slice(0, 60); const to = String(toId || '').slice(0, 60);
  if (!from || !to || from === to) return S.fail(400, 'Pick who the records are from and who they go to (two different people).');
  const target = (await S.ownerOptions()).find((o) => o.id === to);
  if (!target) return S.fail(400, 'Pick the new owner from the sales team list.');
  const pick = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(TRANSFER)).filter((k) => TRANSFER[k]);
  await P.ensure();
  const now = new Date().toISOString();
  const moved = {};
  for (const k of pick) {
    const t = TRANSFER[k];
    // eslint-disable-next-line no-await-in-loop
    const n = await P.run(`UPDATE "${t.table}" SET "ownerId" = ?, "ownerName" = ?, "updatedAt" = ? WHERE "ownerId" = ? ${openOnly ? `AND ${t.open}` : ''}`, to, target.name, now, from);
    moved[k] = Number(n) || 0;
  }
  const fromName = ((await prisma.user.findUnique({ where: { id: from }, select: { name: true } }).catch(() => null)) || {}).name || from;
  await S.audit(user, 'CRM records handed over', 'Crm', from, `${fromName} -> ${target.name}: ${Object.entries(moved).map(([k, n]) => `${n} ${TRANSFER[k].label}`).join(', ')}${openOnly ? ' (open ones)' : ' (all)'}`);
  return S.okBody({ ok: true, moved, to: target });
}
async function bulkOwner(user, { kind, ids, ownerId } = {}) {
  if (!['account', 'contact', 'lead', 'deal'].includes(kind)) return S.fail(400, 'Pick what to hand over.');
  if (!S.mayAssign(S.roleOf(user))) return S.fail(403, 'Only a Sales manager or an Admin can give records to another salesperson.');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).slice(0, 60)))].slice(0, 500);
  if (!list.length || !ownerId) return S.fail(400, 'Tick the records and pick the new owner.');
  let changed = 0; const failed = [];
  for (const id of list) {
    const out = await S.edit(user, kind, id, { ownerId }); // eslint-disable-line no-await-in-loop
    if (out.status === 200) changed += 1; else failed.push({ id, reason: out.body.error });
  }
  return S.okBody({ ok: true, changed, failed });
}

// ---- comments, @mentions and the deal room ---------------------------------------------------------------------------------
async function mentionable() {
  const st = await SETTINGS.load();
  const ids = st.salesTeam.map((m) => m.userId);
  const users = await prisma.user.findMany({ where: { OR: [{ id: { in: ids } }, { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, name: true, email: true, role: true, status: true, clientId: true, candidateId: true } }).catch(() => []);
  return users.filter((u) => u.name && !u.clientId && !u.candidateId && !/inactive|disabled|deleted|left|relieved|exit|suspended/i.test(String(u.status || ''))).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
}
async function recordFor(user, kind, id) {
  if (!['lead', 'deal', 'account'].includes(kind)) return { err: S.fail(404, 'Comments are on a lead, deal or account.') };
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  if (!S.canSeeRow(user, r, row)) return { err: S.fail(404, 'This record is not there, or it is not yours.') };
  return { row, r };
}
async function comments(user, kind, id, { after } = {}) {
  const x = await recordFor(user, kind, id);
  if (x.err) return x.err;
  await P.ensure();
  const rows = (await P.all(`SELECT * FROM "CrmComment" WHERE "kind" = ? AND "recordId" = ? ${after ? 'AND "createdAt" > ?' : ''} ORDER BY "createdAt" ASC LIMIT 500`, kind, x.row.id, ...(after ? [String(after).slice(0, 30)] : [])))
    .map((c) => ({ ...c, mentions: P.parse(c.mentionsJson, []), mentionsJson: undefined, mine: c.byId === user.id }));
  const people = await mentionable();
  const inRoom = new Map();
  if (x.row.ownerId) inRoom.set(x.row.ownerId, x.row.ownerName);
  if (kind === 'deal') (await P.all('SELECT "userId", "name" FROM "CrmDealSplit" WHERE "dealId" = ?', x.row.id)).forEach((s) => inRoom.set(s.userId, s.name));
  (await P.all('SELECT DISTINCT "byId", "byName" FROM "CrmComment" WHERE "kind" = ? AND "recordId" = ?', kind, x.row.id)).forEach((c) => { if (c.byId) inRoom.set(c.byId, c.byName); });
  return S.okBody({ comments: rows, people: people.map(({ email, ...p }) => p), participants: [...inRoom].map(([pid, name]) => ({ id: pid, name })), serverTime: new Date().toISOString(), canComment: !!S.roleOf(user) });
}
// may this teammate open the record? (their own CRM role, the record's owner, their sub-team)
async function canUserSee(userId, row) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, clientId: true, candidateId: true } }).catch(() => null);
  if (!u) return false;
  const r = S.roleOf(u);
  return !!r && S.canSeeRow(u, r, row);
}
async function addComment(user, kind, id, { body, mentions } = {}) {
  const x = await recordFor(user, kind, id);
  if (x.err) return x.err;
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) return S.fail(400, 'Write the comment.');
  const people = await mentionable();
  const byId = new Map(people.map((p) => [p.id, p]));
  // a mention counts when the person was picked AND their @Name is still in the text; an @Name typed by hand is found too
  const picked = new Set((Array.isArray(mentions) ? mentions : []).map((m) => String(m).slice(0, 60)).filter((m) => byId.has(m)));
  people.forEach((p) => { if (new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text)) picked.add(p.id); });
  const named = [...picked].filter((m) => text.toLowerCase().includes(`@${byId.get(m).name.toLowerCase()}`) && m !== user.id);
  await P.ensure();
  const now = new Date().toISOString();
  const c = { id: S.newId('cmt'), kind, recordId: x.row.id, body: text, mentionsJson: JSON.stringify(named.map((m) => ({ id: m, name: byId.get(m).name }))), byId: user.id, byName: user.name || null, createdAt: now };
  await S.insert('CrmComment', c);
  const name = x.row.title || x.row.company || x.row.name || 'a record';
  const open = `/crm/${KIND_PATH[kind]}?open=${kind}:${x.row.id}`;
  const told = []; const cannotSee = [];
  const cfg = await collabSettings();
  for (const m of named) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await canUserSee(m, x.row))) { cannotSee.push(byId.get(m).name); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await require('../utils/notify').pushNotification({ userId: m, title: `💬 ${user.name || 'A teammate'} mentioned you on ${name}`, message: text.slice(0, 300), open }).catch(() => null); // eslint-disable-line global-require
    if (cfg.mentionEmail && byId.get(m).email) {
      // eslint-disable-next-line no-await-in-loop, global-require
      await require('../utils/mailer').sendMail({ to: byId.get(m).email, subject: `${user.name || 'A teammate'} mentioned you on ${name} (CRM)`, text: `${text}\n\nOpen it in TeamLink: ${open}` }).catch(() => null);
    }
    told.push(byId.get(m).name);
  }
  return S.okBody({ ok: true, comment: { ...c, mentions: P.parse(c.mentionsJson, []), mine: true }, told, cannotSee });
}
async function deleteComment(user, cid) {
  const c = await P.one('SELECT * FROM "CrmComment" WHERE "id" = ?', String(cid || '').slice(0, 60));
  if (!c) return S.fail(404, 'This comment is not there.');
  if (c.byId !== user.id && !S.mayAssign(S.roleOf(user))) return S.fail(403, 'Only the writer or a Sales manager can delete a comment.');
  await P.run('DELETE FROM "CrmComment" WHERE "id" = ?', c.id);
  return S.okBody({ ok: true });
}
async function collabSettings() { const v = await P.getCfg('collab', {}); return { mentionEmail: v.mentionEmail === true }; }
async function saveCollab(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const next = { mentionEmail: body.mentionEmail === true };
  await P.setCfg('collab', next);
  await S.audit(user, 'CRM mention settings changed', 'CrmSettings', 'collab', JSON.stringify(next));
  return S.okBody({ ok: true, ...next });
}
async function myMentions(user) {
  await P.ensure();
  const rows = await P.all('SELECT * FROM "CrmComment" WHERE "mentionsJson" LIKE ? AND "createdAt" >= ? ORDER BY "createdAt" DESC LIMIT 50', `%"${String(user.id).replace(/[%_"]/g, '')}"%`, new Date(Date.now() - 30 * 86400000).toISOString());
  const out = [];
  for (const c of rows) {
    const row = await S.getRow(c.kind, c.recordId).catch(() => null); // eslint-disable-line no-await-in-loop
    if (row && S.canSeeRow(user, S.roleOf(user), row)) out.push({ id: c.id, kind: c.kind, recordId: c.recordId, record: row.title || row.company || row.name, body: c.body, byName: c.byName, createdAt: c.createdAt });
  }
  return out;
}

// ---- the approvals inbox -------------------------------------------------------------------------------------------------
async function approvals(user) {
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const deals = await P.all(`SELECT x.*, a."name" AS "accountName" FROM "CrmDeal" x LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${sc.sql} AND x."approvalStatus" = 'Pending' ORDER BY x."updatedAt" DESC LIMIT 300`, ...sc.params);
  const quotes = await P.all(`SELECT p.*, x."title" AS "dealTitle", x."ownerName", x."ownerId", a."name" AS "accountName" FROM "CrmProposal" p JOIN "CrmDeal" x ON x."id" = p."dealId" LEFT JOIN "CrmAccount" a ON a."id" = x."accountId" WHERE ${sc.sql} AND p."approvalStatus" = 'Pending' ORDER BY p."createdAt" DESC LIMIT 300`, ...sc.params);
  const items = [
    ...deals.map((d) => ({ type: 'Deal discount', id: d.id, dealId: d.id, title: d.title, code: d.code, accountName: d.accountName, ownerName: d.ownerName, mine: d.ownerId === user.id, detail: d.approvalNote || `${d.discountPercent || 0}% discount on ${Math.round(d.value || 0).toLocaleString('en-IN')} -> ${Math.round(d.finalValue || 0).toLocaleString('en-IN')}`, amount: d.finalValue, since: d.updatedAt })),
    ...quotes.map((q) => { const d = P.parse(q.dataJson, {}); return { type: 'Quote', id: q.id, dealId: q.dealId, title: `${q.number}${q.version ? ` v${q.version}` : ''} · ${q.dealTitle}`, code: q.number, accountName: q.accountName, ownerName: q.ownerName, mine: q.ownerId === user.id || q.createdById === user.id, detail: d.lines ? `${d.lines.length} lines, discount ${d.discountPercent || 0}%, total ${Math.round(d.total || 0).toLocaleString('en-IN')}` : `Fee ${d.feePercent}%`, amount: d.total || null, since: q.createdAt }; }),
  ].sort((a, b) => String(b.since).localeCompare(String(a.since)));
  return S.okBody({ items, canDecide: S.mayAssign(r), mentions: await myMentions(user) });
}

module.exports = {
  teams, saveTeams, managedIds, FIELDS, fieldSec, saveFieldSec, stripBody, stripRow, csvHidden, hiddenOf, rulesFor, beforeEdit, afterEdit, fieldHistory,
  territories, saveTerritories, applyTerritories, setTerritory, territoryReport, matchTerritory, afterCreateRecord, access, saveAccess, ipAllowed, ipMatches, ipOf,
  transferPreview, transfer, bulkOwner, comments, addComment, deleteComment, collabSettings, saveCollab, approvals, myMentions, mentionable,
};

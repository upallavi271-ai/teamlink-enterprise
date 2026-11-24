// ---------------------------------------------------------------------------
// CRM WAVE C - MORE ON EVERY RECORD (Contacts & Accounts):
//   02.02 parent / child companies (an account's "Parent company"; the group with its totals)
//   02.07 tags on leads, contacts and deals too (accounts had them), and a tag filter on every list (crm/listFilters.js plusTerms)
//   02.08 several contacts on one deal, each with a role (decision maker, influencer, billing contact ...)
//   02.09 the org chart of an account (a contact "reports to" another contact)
//   02.11 the account team: people who work an account with its owner - they may OPEN the account (read only), the owner keeps it
//   02.12 files on leads, accounts and contacts (deals keep theirs in crm/money.js; an account also lists its deals' files)
//   02.13 customer health: a 0-100 score with its reasons (quiet for weeks, open / late support tickets, overdue invoices, lost deals, a recent win)
//   02.14 one search box for every CRM record (TeamLink's search box asks /api/crm/plus/search when the login is on the CRM team)
//   02.05 enrichment: fill an account from its own website (title, description, social links, a guessed industry), its GSTIN (state, PAN), and an
//         outside company-data provider once its key is saved (Administration > Integrations > CRM company data)
//   17.04 deals in other currencies: the amount in the deal's currency and the rate of the day are kept; the deal's value stays in rupees, so every
//         report and the invoice keep working in rupees
//   17.05 business units: a lead / account / deal belongs to one unit; a deal's invoice is raised from its unit's name, GSTIN and address
// ---------------------------------------------------------------------------
const P = require('./db');
const S = require('../service');
const DB = require('../schema');

const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : ''; };
const TABLE = { lead: 'CrmLead', account: 'CrmAccount', contact: 'CrmContact', deal: 'CrmDeal' };
const NAME = { lead: 'company', account: 'name', contact: 'name', deal: 'title' };
const DEAL_ROLES = ['Decision maker', 'Influencer', 'Billing contact', 'Technical buyer', 'User', 'Champion', 'Blocker', 'Other'];
const TEAM_ROLES = ['Account manager', 'Sales', 'Pre-sales', 'Support', 'Finance', 'Other'];

// ---- tags -----------------------------------------------------------------------------------------------------
function cleanTags(v) {
  const list = (Array.isArray(v) ? v : String(v == null ? '' : v).split(',')).map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean);
  const seen = new Set();
  return list.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20).join(', ');
}
const tagList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
async function allTags(user, kind) {
  const r = S.roleOf(user);
  const kinds = kind && TABLE[kind] ? [kind] : Object.keys(TABLE);
  const counts = new Map();
  for (const k of kinds) {
    const s = S.scopeSql(user, r, '');
    // eslint-disable-next-line no-await-in-loop
    (await P.all(`SELECT "tags" FROM "${TABLE[k]}" WHERE "tags" IS NOT NULL AND "tags" != '' AND ${s.sql}`, ...s.params)).forEach((x) => tagList(x.tags).forEach((t) => {
      const key = t.toLowerCase(); const c = counts.get(key) || { tag: t, n: 0 }; c.n += 1; counts.set(key, c);
    }));
  }
  return S.okBody({ tags: [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 200) });
}

// ---- the extra columns that ride on a create / edit (crm/plus/fields.js beforeSave) ---------------------------------
async function wouldLoop(table, col, id, parentId) {
  let at = parentId;
  for (let i = 0; at && i < 20; i += 1) {
    if (at === id) return true;
    // eslint-disable-next-line no-await-in-loop
    const row = await P.one(`SELECT "${col}" AS "up" FROM "${table}" WHERE "id" = ?`, at);
    at = row && row.up;
  }
  return false;
}
async function extraColumns(user, kind, body = {}, clean = {}, prev = null, cfg = P.current()) {
  const r = S.roleOf(user);
  const data = {};
  if ('tags' in body && kind !== 'account') data.tags = cleanTags(body.tags) || null;
  if (kind === 'account' && 'tags' in body) data.tags = cleanTags(body.tags) || null;
  if (kind === 'account' && 'parentId' in body) {
    const pid = clip(body.parentId, 60);
    if (!pid) data.parentId = null;
    else {
      const parent = await S.getRow('account', pid);
      if (!S.canSeeRow(user, r, parent)) return { error: 'Pick the parent company from your accounts.' };
      if (prev && (pid === prev.id || await wouldLoop('CrmAccount', 'parentId', prev.id, pid))) return { error: 'A company cannot sit under itself or under one of its own subsidiaries.' };
      data.parentId = pid;
    }
  }
  if (kind === 'contact' && 'reportsToId' in body) {
    const bid = clip(body.reportsToId, 60);
    if (!bid) data.reportsToId = null;
    else {
      const boss = await S.getRow('contact', bid);
      const accountId = clean.accountId !== undefined ? clean.accountId : prev && prev.accountId;
      if (!boss || !S.canSeeRow(user, r, boss) || (accountId && boss.accountId !== accountId)) return { error: '"Reports to" must be a person at the same company.' };
      if (prev && (bid === prev.id || await wouldLoop('CrmContact', 'reportsToId', prev.id, bid))) return { error: 'A person cannot report to themselves or to someone who reports to them.' };
      data.reportsToId = bid;
    }
  }
  if (kind === 'deal' && ('currency' in body || 'amountForeign' in body)) {
    const code = ('currency' in body ? clip(body.currency, 3) : clip(prev && prev.currency, 3)).toUpperCase();
    if (!code || code === 'INR') {
      if ('currency' in body) { data.currency = null; data.fxRate = null; data.amountForeign = null; }
    } else {
      const c = cfg.currencies.find((x) => x.code === code);
      if (!c) return { error: `${code} is not one of the CRM's currencies (CRM settings > Customise > Currencies).` };
      const amount = 'amountForeign' in body ? S.num(body.amountForeign) : (prev && prev.currency === code ? prev.amountForeign : null);
      // the rate of the day is kept with the deal: a later rate change does not move a deal already priced
      const rate = prev && prev.currency === code && prev.fxRate && !(body.refreshRate === true) ? prev.fxRate : c.rate;
      data.currency = code; data.fxRate = rate; data.amountForeign = amount;
      data.value = amount == null ? 0 : Math.round(amount * rate * 100) / 100;
    }
  }
  if (['lead', 'account', 'deal'].includes(kind) && 'unitId' in body) {
    const u = clip(body.unitId, 40);
    if (u && !cfg.units.some((x) => x.id === u)) return { error: 'Pick the business unit from the list.' };
    data.unitId = u || null;
  }
  // a new deal belongs to its account's business unit unless one was picked
  if (kind === 'deal' && !prev && !('unitId' in data) && clean.accountId) {
    const acc = await S.getRow('account', clean.accountId).catch(() => null);
    if (acc && acc.unitId) data.unitId = acc.unitId;
  }
  return { data };
}

// ---- who may read / change a record here -----------------------------------------------------------------------
async function onTeam(user, accountId) {
  if (!user || !accountId) return false;
  return !!(await P.one('SELECT "id" FROM "CrmAccountTeam" WHERE "accountId" = ? AND "userId" = ?', accountId, user.id));
}
async function recordFor(user, kind, id, { edit } = {}) {
  if (!TABLE[kind]) return { error: S.fail(404, 'Not found.') };
  const r = S.roleOf(user);
  const row = await S.getRow(kind, id);
  const see = S.canSeeRow(user, r, row) || (kind === 'account' && row && await onTeam(user, row.id));
  if (!row || !see) return { error: S.fail(404, 'This record is not there, or it is not yours.') };
  if (edit && !S.canEditRow(user, r, row)) return { error: S.fail(403, 'You can read this record but not change it.') };
  return { row, r, canEdit: S.canEditRow(user, r, row) };
}

// ---- files on a lead / account / contact -------------------------------------------------------------------------
const FILE_MAX = 10 * 1024 * 1024;
const FILE_CATS = ['Document', 'Contract', 'Purchase order', 'ID / KYC', 'Picture', 'Other'];
const fileOut = (f) => ({ id: f.id, kind: f.kind, recordId: f.recordId, category: f.category || 'Document', name: f.name, mime: f.mime, size: f.size, byName: f.createdByName || null, createdAt: f.createdAt });
async function files(user, kind, id) {
  const x = await recordFor(user, kind, id);
  if (x.error) return x.error;
  const rows = (await P.all('SELECT * FROM "CrmRecordFile" WHERE "kind" = ? AND "recordId" = ? ORDER BY "createdAt" DESC', kind, x.row.id)).map(fileOut);
  // an account also shows the files kept on its deals (read only here; they are changed on the deal)
  let dealFiles = [];
  if (kind === 'account') dealFiles = (await P.all('SELECT f.*, d."title" AS "dealTitle" FROM "CrmDealFile" f JOIN "CrmDeal" d ON d."id" = f."dealId" WHERE f."accountId" = ? ORDER BY f."createdAt" DESC LIMIT 100', x.row.id)).map((f) => ({ id: f.id, dealId: f.dealId, dealTitle: f.dealTitle, category: f.kind, name: f.name, size: f.size, createdAt: f.createdAt, onDeal: true }));
  return S.okBody({ files: rows, dealFiles, canEdit: x.canEdit, maxBytes: FILE_MAX, categories: FILE_CATS });
}
const EXT_MIME = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const FILE_WORDS = { NO_FILE: 'Choose a file to upload.', TOO_LARGE: 'That file is larger than 10 MB.', BAD_TYPE: 'Only PDF, Word, Excel / CSV and pictures (PNG / JPEG / WebP) can be kept on a record.', CONTENT_MISMATCH: 'That file\'s contents do not match its type.', NOT_MULTIPART: 'Upload the file as a form (multipart/form-data).' };
async function uploadFile(user, kind, id, req) {
  const x = await recordFor(user, kind, id, { edit: true });
  if (x.error) { req.resume(); return x.error; }
  const A = require('../../utils/attachments'); // eslint-disable-line global-require
  let parsed;
  try { parsed = await A.parseMultipart(req, { maxBytes: FILE_MAX }); } catch (e) {
    if (!req.complete && !req.destroyed) { req.resume(); await new Promise((ok) => { req.once('end', ok); req.once('error', ok); setTimeout(ok, 15000); }); }
    return S.fail(e.code === 'TOO_LARGE' ? 413 : 400, FILE_WORDS[e.code] || 'The file could not be read.');
  }
  const file = parsed.file;
  if (file && (!file.contentType || file.contentType === 'application/octet-stream')) {
    const ext = String(file.filename || '').toLowerCase().split('.').pop();
    if (EXT_MIME[ext]) file.contentType = EXT_MIME[ext];
  }
  let saved;
  try { saved = A.store(file, { maxBytes: FILE_MAX, allowWord: true, allowSheet: true }); } catch (e) { return S.fail(e.code === 'TOO_LARGE' ? 413 : 400, FILE_WORDS[e.code] || 'The file could not be kept.'); }
  const category = FILE_CATS.includes(parsed.fields.category) ? parsed.fields.category : 'Document';
  const now = P.nowIso();
  const row = { id: P.newId('rfile'), kind, recordId: x.row.id, category, name: saved.billName, mime: saved.billMime, size: saved.billSize, stored: saved.billFile, createdById: user.id, createdByName: user.name || null, createdAt: now };
  const cols = Object.keys(row);
  await P.run(`INSERT INTO "CrmRecordFile" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
  const link = kind === 'contact' ? { contactId: x.row.id, accountId: x.row.accountId || null } : { [`${kind}Id`]: x.row.id };
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `File added: ${row.name}`, note: `${category} · ${Math.max(1, Math.round(row.size / 1024))} KB`, at: now, ...link, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, 'CRM file uploaded', 'CrmRecordFile', row.id, `${kind} ${x.row[NAME[kind]]}: ${row.name}`);
  return S.okBody({ ok: true, file: fileOut(row) });
}
async function fileFor(user, fileId, { edit } = {}) {
  const f = await P.one('SELECT * FROM "CrmRecordFile" WHERE "id" = ?', clip(fileId, 60));
  if (!f) return { error: S.fail(404, 'This file is not there.') };
  const x = await recordFor(user, f.kind, f.recordId, { edit });
  return x.error ? { error: x.error } : { f, row: x.row };
}
async function fileDownload(user, fileId) {
  const x = await fileFor(user, fileId);
  if (x.error) return x.error;
  const full = require('../../utils/attachments').resolveStored(x.f.stored); // eslint-disable-line global-require
  if (!full) return S.fail(404, 'The file is missing on the server.');
  return { status: 200, path: full, name: x.f.name, mime: x.f.mime };
}
async function deleteFile(user, fileId) {
  const x = await fileFor(user, fileId, { edit: true });
  if (x.error) return x.error;
  await P.run('DELETE FROM "CrmRecordFile" WHERE "id" = ?', x.f.id);
  require('../../utils/attachments').remove(x.f.stored); // eslint-disable-line global-require
  await S.audit(user, 'CRM file deleted', 'CrmRecordFile', x.f.id, x.f.name);
  return S.okBody({ ok: true });
}

// ---- contacts on a deal, with their role ---------------------------------------------------------------------------
async function dealContacts(user, dealId) {
  const x = await recordFor(user, 'deal', dealId);
  if (x.error) return x.error;
  const rows = await P.all('SELECT dc.*, c."name", c."designation", c."phone", c."email", c."accountId" FROM "CrmDealContact" dc JOIN "CrmContact" c ON c."id" = dc."contactId" WHERE dc."dealId" = ? ORDER BY dc."primary" DESC, dc."createdAt"', x.row.id);
  const primary = x.row.contactId ? await S.getRow('contact', x.row.contactId) : null;
  const list = rows.map((d) => ({ id: d.id, contactId: d.contactId, name: d.name, designation: d.designation, phone: d.phone, email: d.email, role: d.role || 'Other', primary: !!d.primary || d.contactId === x.row.contactId }));
  if (primary && !list.some((d) => d.contactId === primary.id)) list.unshift({ id: null, contactId: primary.id, name: primary.name, designation: primary.designation, phone: primary.phone, email: primary.email, role: primary.role || 'Decision maker', primary: true });
  const options = x.row.accountId ? await P.all('SELECT "id", "name", "designation" FROM "CrmContact" WHERE "accountId" = ? ORDER BY "name" COLLATE NOCASE', x.row.accountId) : [];
  return S.okBody({ contacts: list, roles: DEAL_ROLES, options, canEdit: x.canEdit });
}
async function addDealContact(user, dealId, body = {}) {
  const x = await recordFor(user, 'deal', dealId, { edit: true });
  if (x.error) return x.error;
  const c = await S.getRow('contact', clip(body.contactId, 60));
  if (!c || !S.canSeeRow(user, x.r, c)) return S.fail(400, 'Pick one of your contacts.');
  if (x.row.accountId && c.accountId && c.accountId !== x.row.accountId) return S.fail(400, 'Pick a person at this deal\'s company.');
  const role = DEAL_ROLES.includes(body.role) ? body.role : 'Other';
  const now = P.nowIso();
  await P.run('INSERT INTO "CrmDealContact" ("id", "dealId", "contactId", "role", "primary", "createdAt") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT("dealId", "contactId") DO UPDATE SET "role" = excluded."role"', P.newId('dcon'), x.row.id, c.id, role, body.primary ? 1 : 0, now);
  if (body.primary === true) await S.update('CrmDeal', x.row.id, { contactId: c.id, updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `${c.name} added to the deal as ${role}`, note: null, at: now, dealId: x.row.id, accountId: x.row.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  return dealContacts(user, x.row.id);
}
async function removeDealContact(user, dealId, contactId) {
  const x = await recordFor(user, 'deal', dealId, { edit: true });
  if (x.error) return x.error;
  await P.run('DELETE FROM "CrmDealContact" WHERE "dealId" = ? AND "contactId" = ?', x.row.id, clip(contactId, 60));
  if (x.row.contactId === contactId) await S.update('CrmDeal', x.row.id, { contactId: null, updatedAt: P.nowIso() });
  return dealContacts(user, x.row.id);
}

// ---- the account team ---------------------------------------------------------------------------------------------------
async function team(user, accountId) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  const rows = await P.all('SELECT * FROM "CrmAccountTeam" WHERE "accountId" = ? ORDER BY "createdAt"', x.row.id);
  const mayChange = S.mayAssign(x.r) || (x.canEdit && x.row.ownerId === user.id);
  return S.okBody({ owner: { id: x.row.ownerId, name: x.row.ownerName }, members: rows.map((m) => ({ id: m.id, userId: m.userId, name: m.userName, role: m.role || 'Sales' })), roles: TEAM_ROLES, canEdit: mayChange, people: mayChange ? await S.ownerOptions() : [] });
}
async function addTeam(user, accountId, body = {}) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  if (!(S.mayAssign(x.r) || (x.canEdit && x.row.ownerId === user.id))) return S.fail(403, 'The account team is set by the account\'s owner or a Sales manager.');
  const p = (await S.ownerOptions()).find((o) => o.id === clip(body.userId, 60));
  if (!p) return S.fail(400, 'Pick the person from the sales team.');
  if (p.id === x.row.ownerId) return S.fail(400, `${p.name} owns this account already.`);
  const role = TEAM_ROLES.includes(body.role) ? body.role : 'Sales';
  await P.run('INSERT INTO "CrmAccountTeam" ("id", "accountId", "userId", "userName", "role", "createdById", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT("accountId", "userId") DO UPDATE SET "role" = excluded."role"', P.newId('team'), x.row.id, p.id, p.name, role, user.id, P.nowIso());
  await S.audit(user, 'CRM account team changed', 'CrmAccount', x.row.id, `${p.name} added as ${role}`);
  return team(user, x.row.id);
}
async function removeTeam(user, accountId, memberUserId) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  if (!(S.mayAssign(x.r) || (x.canEdit && x.row.ownerId === user.id))) return S.fail(403, 'The account team is set by the account\'s owner or a Sales manager.');
  await P.run('DELETE FROM "CrmAccountTeam" WHERE "accountId" = ? AND "userId" = ?', x.row.id, clip(memberUserId, 60));
  await S.audit(user, 'CRM account team changed', 'CrmAccount', x.row.id, `${clip(memberUserId, 60)} removed`);
  return team(user, x.row.id);
}
// accounts a person is on the team of (for the account list: they appear there, read only)
async function teamAccountIds(userId) {
  return (await P.all('SELECT "accountId" FROM "CrmAccountTeam" WHERE "userId" = ?', userId)).map((x) => x.accountId);
}

// ---- parent / child companies -------------------------------------------------------------------------------------------
async function hierarchy(user, accountId) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  const r = x.r;
  const sum = async (id) => P.one(`SELECT (SELECT COALESCE(SUM("value"), 0) FROM "CrmDeal" WHERE "accountId" = ? AND "stage" NOT IN ('Won', 'Lost')) AS "open",
    (SELECT COALESCE(SUM(COALESCE("finalValue", "value")), 0) FROM "CrmDeal" WHERE "accountId" = ? AND "stage" = 'Won') AS "won",
    (SELECT COUNT(*) FROM "CrmContact" WHERE "accountId" = ?) AS "contacts"`, id, id, id);
  // up to the top of the group
  const chain = [];
  let at = x.row.parentId;
  for (let i = 0; at && i < 10; i += 1) {
    const p = await S.getRow('account', at); // eslint-disable-line no-await-in-loop
    if (!p) break;
    chain.unshift({ id: p.id, name: p.name, code: p.code, city: p.city, canOpen: S.canSeeRow(user, r, p) });
    at = p.parentId;
  }
  const rootId = chain.length ? chain[0].id : x.row.id;
  // down from the top, three levels
  const node = async (id, depth) => {
    const a = await S.getRow('account', id);
    const s = await sum(id);
    const kids = depth < 4 ? await P.all('SELECT "id" FROM "CrmAccount" WHERE "parentId" = ? ORDER BY "name" COLLATE NOCASE LIMIT 50', id) : [];
    const children = [];
    for (const k of kids) children.push(await node(k.id, depth + 1)); // eslint-disable-line no-await-in-loop
    const total = children.reduce((t, c) => ({ open: t.open + c.total.open, won: t.won + c.total.won }), { open: Number(s.open) || 0, won: Number(s.won) || 0 });
    return { id: a.id, name: a.name, code: a.code, city: a.city, kind: a.kind, here: a.id === x.row.id, canOpen: S.canSeeRow(user, r, a), own: { open: Number(s.open) || 0, won: Number(s.won) || 0, contacts: Number(s.contacts) || 0 }, total, children };
  };
  const tree = await node(rootId, 0);
  const options = x.canEdit ? (await S.list(user, 'account', {})).filter((a) => a.id !== x.row.id).map((a) => ({ id: a.id, name: a.name })) : [];
  return S.okBody({ parentId: x.row.parentId || null, chain, tree, canEdit: x.canEdit, options });
}

// ---- the org chart of an account ------------------------------------------------------------------------------------------
async function orgChart(user, accountId) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  const people = await P.all('SELECT "id", "name", "designation", "role", "phone", "email", "reportsToId" FROM "CrmContact" WHERE "accountId" = ? ORDER BY "name" COLLATE NOCASE', x.row.id);
  const ids = new Set(people.map((p) => p.id));
  const byBoss = new Map();
  people.forEach((p) => { const b = p.reportsToId && ids.has(p.reportsToId) ? p.reportsToId : ''; if (!byBoss.has(b)) byBoss.set(b, []); byBoss.get(b).push(p); });
  const build = (p, depth) => ({ ...p, reports: depth < 8 ? (byBoss.get(p.id) || []).map((c) => build(c, depth + 1)) : [] });
  return S.okBody({ roots: (byBoss.get('') || []).map((p) => build(p, 0)), count: people.length, canEdit: x.canEdit });
}

// ---- customer health ----------------------------------------------------------------------------------------------------------
const DAY = 86400000;
async function healthOf(a, now = Date.now()) {
  const signals = [];
  let score = 100;
  // a real conversation: a call, meeting, email or WhatsApp logged by a person (a file added or a note the CRM wrote is not one)
  const last = await P.one(`SELECT MAX("at") AS "at" FROM "CrmActivity" WHERE ("accountId" = ? OR "dealId" IN (SELECT "id" FROM "CrmDeal" WHERE "accountId" = ?)) AND "byId" IS NOT NULL AND "kind" IN ('call', 'meeting', 'email', 'whatsapp')`, a.id, a.id);
  const quiet = last && last.at ? Math.floor((now - Date.parse(last.at)) / DAY) : null;
  if (quiet == null) { score -= 25; signals.push({ bad: true, text: 'Nobody has logged a call, meeting or note with them yet' }); } else if (quiet > 90) { score -= 40; signals.push({ bad: true, text: `Quiet for ${quiet} days` }); } else if (quiet > 60) { score -= 25; signals.push({ bad: true, text: `Quiet for ${quiet} days` }); } else if (quiet > 30) { score -= 12; signals.push({ bad: true, text: `Quiet for ${quiet} days` }); } else signals.push({ bad: false, text: quiet === 0 ? 'Talked to today' : `Last touched ${quiet} day${quiet === 1 ? '' : 's'} ago` });
  const tk = await P.one(`SELECT COUNT(*) AS "open", SUM(CASE WHEN "dueAt" IS NOT NULL AND "dueAt" < ? THEN 1 ELSE 0 END) AS "late", SUM(CASE WHEN "priority" IN ('Urgent', 'High') THEN 1 ELSE 0 END) AS "high" FROM "CrmTicket" WHERE "accountId" = ? AND "status" NOT IN ('Resolved', 'Closed')`, new Date(now).toISOString(), a.id).catch(() => null);
  const openT = Number(tk && tk.open) || 0; const lateT = Number(tk && tk.late) || 0; const highT = Number(tk && tk.high) || 0;
  if (openT) { score -= Math.min(20, openT * 5) + Math.min(15, lateT * 8) + Math.min(10, highT * 5); signals.push({ bad: true, text: `${openT} open support ticket${openT === 1 ? '' : 's'}${lateT ? `, ${lateT} past the promised time` : ''}${highT ? `, ${highT} urgent / high` : ''}` }); }
  const today = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
  const inv = await P.one('SELECT COUNT(*) AS "n", COALESCE(SUM("total" - "paidAmount" - COALESCE("tdsAmount", 0)), 0) AS "due" FROM "CrmInvoice" WHERE "accountId" = ? AND "status" NOT IN (\'Paid\', \'Cancelled\') AND "dueDate" IS NOT NULL AND "dueDate" < ?', a.id, today).catch(() => null);
  const overdue = Number(inv && inv.n) || 0;
  if (overdue) { score -= Math.min(30, overdue * 12); signals.push({ bad: true, text: `${overdue} invoice${overdue === 1 ? '' : 's'} overdue (₹${Math.round(Number(inv.due) || 0).toLocaleString('en-IN')} owed)` }); }
  const since90 = new Date(now - 90 * DAY).toISOString(); const since180 = new Date(now - 180 * DAY).toISOString();
  const deals = await P.one(`SELECT SUM(CASE WHEN "stage" = 'Lost' AND COALESCE("lostAt", "updatedAt") >= ? THEN 1 ELSE 0 END) AS "lost", SUM(CASE WHEN "stage" = 'Won' AND COALESCE("wonAt", "updatedAt") >= ? THEN 1 ELSE 0 END) AS "won", SUM(CASE WHEN "stage" NOT IN ('Won', 'Lost') THEN 1 ELSE 0 END) AS "open" FROM "CrmDeal" WHERE "accountId" = ?`, since90, since180, a.id);
  const lost = Number(deals && deals.lost) || 0; const won = Number(deals && deals.won) || 0; const open = Number(deals && deals.open) || 0;
  if (lost) { score -= Math.min(20, lost * 10); signals.push({ bad: true, text: `${lost} deal${lost === 1 ? '' : 's'} lost in the last 90 days` }); }
  if (won) { score += 10; signals.push({ bad: false, text: `${won} deal${won === 1 ? '' : 's'} won in the last 6 months` }); }
  if (open) { score += 5; signals.push({ bad: false, text: `${open} open deal${open === 1 ? '' : 's'} in the pipeline` }); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 70 ? 'Healthy' : score >= 40 ? 'Watch' : 'At risk';
  return { score, band, signals, quietDays: quiet };
}
async function health(user, accountId) {
  const x = await recordFor(user, 'account', accountId);
  if (x.error) return x.error;
  return S.okBody({ accountId: x.row.id, ...(await healthOf(x.row)) });
}
// every customer (account with a won deal / kind Client) the person sees, worst first
async function healthList(user, { band, all } = {}) {
  const r = S.roleOf(user);
  const s = S.scopeSql(user, r, '');
  const rows = await P.all(`SELECT * FROM "CrmAccount" WHERE ${all === '1' ? '1=1' : '"kind" = \'Client\''} AND ${s.sql} ORDER BY "name" COLLATE NOCASE LIMIT 500`, ...s.params);
  const out = [];
  for (const a of rows) out.push({ id: a.id, name: a.name, code: a.code, city: a.city, ownerName: a.ownerName, kind: a.kind, ...(await healthOf(a)) }); // eslint-disable-line no-await-in-loop
  const list = out.filter((x) => !band || x.band === band).sort((a, b) => a.score - b.score);
  return S.okBody({ rows: list, counts: { Healthy: out.filter((x) => x.band === 'Healthy').length, Watch: out.filter((x) => x.band === 'Watch').length, 'At risk': out.filter((x) => x.band === 'At risk').length } });
}

// ---- one search for every CRM record (TeamLink's search box) ---------------------------------------------------------------
async function search(user, q) {
  const text = clip(q, 80);
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  if (text.length < 2) return S.okBody({ groups: [], total: 0 });
  const like = `%${text}%`;
  const digits = text.replace(/\D/g, '');
  const ph = digits.length >= 6 ? `%${digits.slice(-10)}%` : '__none__';
  const team = r === 'bde' ? await teamAccountIds(user.id) : [];
  const scope = (alias) => { const sc = S.scopeSql(user, r, alias); return sc; };
  const LIMIT = 8;
  const groups = [];
  const add = (id, title, rows, more) => { if (rows.length) groups.push({ id, title, count: rows.length, more, rows }); };
  let sc = scope('');
  const leads = await P.all(`SELECT "id", "company", "contactName", "phone", "email", "city", "status", "code", "ownerName" FROM "CrmLead" WHERE ${sc.sql} AND ("company" LIKE ? OR "contactName" LIKE ? OR "email" LIKE ? OR "code" LIKE ? OR "tags" LIKE ? OR REPLACE(REPLACE("phone", ' ', ''), '-', '') LIKE ?) ORDER BY "updatedAt" DESC LIMIT ${LIMIT + 1}`, ...sc.params, like, like, like, like, like, ph);
  add('crm-leads', 'CRM leads', leads.slice(0, LIMIT).map((l) => ({ id: l.id, type: 'lead', title: l.company, code: l.code, sub: [l.contactName, l.city, l.status, l.ownerName && `owner ${l.ownerName}`].filter(Boolean).join(' · '), to: `/crm/leads?open=lead:${l.id}` })), leads.length > LIMIT);
  sc = scope('');
  const teamSql = team.length ? ` OR "id" IN (${team.map(() => '?').join(',')})` : '';
  const accs = await P.all(`SELECT "id", "name", "city", "kind", "code", "ownerName" FROM "CrmAccount" WHERE (${sc.sql}${teamSql}) AND ("name" LIKE ? OR "code" LIKE ? OR "gstin" LIKE ? OR "email" LIKE ? OR "tags" LIKE ? OR REPLACE(REPLACE("phone", ' ', ''), '-', '') LIKE ?) ORDER BY "name" COLLATE NOCASE LIMIT ${LIMIT + 1}`, ...sc.params, ...team, like, like, like, like, like, ph);
  add('crm-accounts', 'CRM accounts', accs.slice(0, LIMIT).map((a) => ({ id: a.id, type: 'account', title: a.name, code: a.code, sub: [a.kind === 'Client' ? 'Customer' : 'Prospect', a.city, a.ownerName && `owner ${a.ownerName}`].filter(Boolean).join(' · '), to: `/crm/accounts?open=account:${a.id}` })), accs.length > LIMIT);
  sc = scope('c.');
  const cons = await P.all(`SELECT c."id", c."name", c."designation", c."accountId", a."name" AS "accountName" FROM "CrmContact" c LEFT JOIN "CrmAccount" a ON a."id" = c."accountId" WHERE ${sc.sql} AND (c."name" LIKE ? OR c."email" LIKE ? OR c."tags" LIKE ? OR REPLACE(REPLACE(c."phone", ' ', ''), '-', '') LIKE ?) ORDER BY c."name" COLLATE NOCASE LIMIT ${LIMIT + 1}`, ...sc.params, like, like, like, ph);
  add('crm-contacts', 'CRM contacts', cons.slice(0, LIMIT).map((c) => ({ id: c.id, type: 'contact', title: c.name, sub: [c.designation, c.accountName].filter(Boolean).join(' · '), to: c.accountId ? `/crm/accounts?open=account:${c.accountId}` : '/crm/accounts?tab=contacts' })), cons.length > LIMIT);
  sc = scope('d.');
  const deals = await P.all(`SELECT d."id", d."title", d."stage", d."value", d."code", a."name" AS "accountName" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${sc.sql} AND (d."title" LIKE ? OR d."code" LIKE ? OR d."tags" LIKE ? OR a."name" LIKE ?) ORDER BY d."updatedAt" DESC LIMIT ${LIMIT + 1}`, ...sc.params, like, like, like, like);
  add('crm-deals', 'CRM deals', deals.slice(0, LIMIT).map((d) => ({ id: d.id, type: 'deal', title: d.title, code: d.code, sub: [d.accountName, d.stage, `₹${Math.round(d.value || 0).toLocaleString('en-IN')}`].filter(Boolean).join(' · '), to: `/crm/deals?open=deal:${d.id}` })), deals.length > LIMIT);
  return S.okBody({ groups, total: groups.reduce((n, g) => n + g.count, 0) });
}

// ---- enrichment -----------------------------------------------------------------------------------------------------------------
const FREE_MAIL = /^(gmail|yahoo|ymail|hotmail|outlook|live|rediffmail|icloud|aol|protonmail|zoho)\./i;
const INDUSTRY_WORDS = [
  ['IT / Software', /\b(software|saas|it services|cloud|technolog|digital transformation|app development|cyber)/i],
  ['Manufacturing', /\b(manufactur|factory|industrial|machin|engineering|fabricat|plant)/i],
  ['Healthcare', /\b(hospital|health|clinic|pharma|medical|diagnostic)/i],
  ['Education', /\b(school|college|universit|education|academy|edtech|institute)/i],
  ['Retail / E-commerce', /\b(retail|e-?commerce|shop|store|fashion|apparel)/i],
  ['Banking / Finance', /\b(bank|finance|fintech|insurance|nbfc|invest|loan)/i],
  ['Logistics', /\b(logistic|transport|shipping|freight|courier|supply chain)/i],
  ['Real estate / Construction', /\b(real estate|construction|builder|propert|infra)/i],
  ['Hospitality', /\b(hotel|restaurant|hospitality|travel|tourism)/i],
  ['Staffing / HR', /\b(staffing|recruit|manpower|hr services|placement)/i],
];
function domainOf(a) {
  const w = clip(a.website, 300);
  if (w) { try { return new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, ''); } catch { /* not a link */ } }
  const e = clip(a.email, 200).toLowerCase();
  const d = e.includes('@') ? e.split('@')[1] : '';
  return d && !FREE_MAIL.test(d) ? d : '';
}
const STUB_HTML = '<html><head><title>Sample Company Pvt Ltd - Cloud software for manufacturers</title><meta name="description" content="We build cloud software for manufacturing plants across India."><meta property="og:site_name" content="Sample Company"></head><body><a href="https://www.linkedin.com/company/sample-company">LinkedIn</a><a href="https://twitter.com/samplecompany">X</a><a href="https://facebook.com/samplecompany">Facebook</a> Call +91 40 1234 5678</body></html>';
async function siteFacts(domain) {
  let html = '';
  if (process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX) html = process.env.CRM_ENRICH_STUB_HTML || STUB_HTML; // never a real fetch from a test server
  else {
    const { fetchPublic } = require('../../utils/safeFetch'); // eslint-disable-line global-require
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetchPublic(`https://${domain}/`, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM company lookup)', Accept: 'text/html' } });
      html = (await res.text()).slice(0, 600000);
    } finally { clearTimeout(t); }
  }
  const pick = (re) => { const m = re.exec(html); return m ? m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').trim().slice(0, 300) : ''; };
  const title = pick(/<title[^>]*>([^<]{2,300})<\/title>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{2,400})["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{2,400})["']/i);
  const siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,120})["']/i);
  const links = [...html.matchAll(/href=["'](https?:\/\/(?:www\.)?(?:linkedin\.com\/company|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com)\/[^"'\s?#]+)/gi)].map((m) => m[1]);
  const social = {};
  links.forEach((l) => { const k = /linkedin/i.test(l) ? 'linkedin' : /twitter|x\.com/i.test(l) ? 'x' : /facebook/i.test(l) ? 'facebook' : /instagram/i.test(l) ? 'instagram' : 'youtube'; if (!social[k]) social[k] = l; });
  const text = `${title} ${description}`;
  const industry = (INDUSTRY_WORDS.find(([, re]) => re.test(text)) || [])[0] || '';
  const phoneM = /(\+91[\s-]?\d[\d\s-]{8,13}\d)/.exec(html.replace(/<[^>]+>/g, ' '));
  return { title, description, siteName, social, industry, phone: phoneM ? phoneM[1].replace(/\s+/g, ' ').trim() : '' };
}
// an outside company-data provider (Administration > Integrations > CRM company data): a lookup address with {domain}, the key in a header,
// and the JSON fields it answers with. Nothing is asked until the founder saves the key.
async function providerFacts(domain) {
  const cfg = await require('../../utils/integrationStore').readConfig('crm-enrichment').catch(() => null); // eslint-disable-line global-require
  const v = (cfg && cfg.values) || {};
  const url = clip(v['Lookup URL (use {domain})'], 400); const key = clip(v['API key'], 400);
  if (!url || !key) return { configured: false };
  if (process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX) return { configured: true, employees: '51-200', industry: 'IT / Software', linkedin: `https://www.linkedin.com/company/${domain.split('.')[0]}` };
  const { fetchPublic } = require('../../utils/safeFetch'); // eslint-disable-line global-require
  const res = await fetchPublic(url.replace('{domain}', encodeURIComponent(domain)), { headers: { [clip(v['Key header name'], 60) || 'X-API-Key']: key, Accept: 'application/json' } });
  if (!res.ok) return { configured: true, error: `The provider said ${res.status}.` };
  const j = await res.json().catch(() => ({}));
  const o = j.company || j.organization || j.data || j;
  return { configured: true, employees: clip(o.employees || o.employee_count || o.estimated_num_employees || o.size, 40), industry: clip(o.industry || o.category, 80), linkedin: clip(o.linkedin_url || o.linkedin || (o.linkedin && o.linkedin.handle), 300), description: clip(o.description || o.short_description, 400) };
}
async function enrich(user, accountId) {
  const x = await recordFor(user, 'account', accountId, { edit: true });
  if (x.error) return x.error;
  const a = x.row;
  const out = { suggestions: {}, found: {}, sources: [] };
  const M = require('../money'); // eslint-disable-line global-require
  if (a.gstin && M.validGstin(a.gstin)) {
    const g = String(a.gstin).toUpperCase();
    out.found.gstState = M.stateName(g.slice(0, 2)); out.found.pan = g.slice(2, 12);
    if (!a.state && out.found.gstState) out.suggestions.state = out.found.gstState;
    out.sources.push('GSTIN');
  }
  const domain = domainOf(a);
  if (domain) {
    try {
      const f = await siteFacts(domain);
      out.found.site = { domain, ...f };
      if (!a.website) out.suggestions.website = `https://${domain}`;
      if (!a.industry && f.industry) out.suggestions.industry = f.industry;
      if (!a.phone && f.phone) out.suggestions.phone = f.phone;
      if (Object.keys(f.social).length) out.suggestions.social = JSON.stringify(f.social);
      out.sources.push('the company website');
    } catch (e) { out.found.siteError = `The website could not be read (${String(e.message || e).slice(0, 80)}).`; }
    try {
      const pv = await providerFacts(domain);
      out.provider = { configured: !!pv.configured, error: pv.error || null };
      if (pv.configured && !pv.error) {
        if (pv.employees && !a.employees) out.suggestions.employees = pv.employees;
        if (pv.industry && !a.industry && !out.suggestions.industry) out.suggestions.industry = pv.industry;
        if (pv.linkedin) { const soc = { ...P.parse(out.suggestions.social || a.social, {}) }; if (!soc.linkedin) { soc.linkedin = pv.linkedin; out.suggestions.social = JSON.stringify(soc); } }
        out.sources.push('the company-data provider');
      }
    } catch (e) { out.provider = { configured: true, error: String(e.message || e).slice(0, 120) }; }
  } else out.found.siteError = 'No website, and the email is a personal one (Gmail ...), so there is no company website to read. Type the website first.';
  return S.okBody(out);
}
async function applyEnrich(user, accountId, body = {}) {
  const x = await recordFor(user, 'account', accountId, { edit: true });
  if (x.error) return x.error;
  const pick = body.fields || {};
  const data = {};
  ['website', 'industry', 'phone', 'state'].forEach((k) => { if (pick[k]) data[k] = clip(pick[k], 300); });
  if (pick.social) { try { data.social = JSON.stringify(JSON.parse(pick.social)); } catch { /* skipped */ } }
  if (pick.employees) data.employees = clip(pick.employees, 40);
  if (!Object.keys(data).length) return S.fail(400, 'Tick what to fill in.');
  data.enrichedAt = P.nowIso(); data.updatedAt = P.nowIso();
  const saved = await S.update('CrmAccount', x.row.id, data);
  await S.audit(user, 'CRM account filled from outside data', 'CrmAccount', x.row.id, Object.keys(data).filter((k) => !['enrichedAt', 'updatedAt'].includes(k)).join(', '));
  return S.okBody({ ok: true, account: saved });
}

// ---- everything the record's "More" tab shows, in one read -----------------------------------------------------------------------
async function extras(user, kind, id) {
  const x = await recordFor(user, kind, id);
  if (x.error) return x.error;
  const F = require('./fields'); // eslint-disable-line global-require
  const cfg = await P.config();
  const out = { kind, id: x.row.id, canEdit: x.canEdit, tags: tagList(x.row.tags), custom: await F.valuesOf(user, kind, x.row), fields: await F.defs(kind) };
  if (kind === 'deal' && x.row.currency) out.currency = { code: x.row.currency, rate: x.row.fxRate, amount: x.row.amountForeign, inr: x.row.value };
  if (x.row.unitId) out.unit = (cfg.units.find((u) => u.id === x.row.unitId) || { name: '(a removed unit)' }).name;
  if (kind === 'account') {
    out.parent = x.row.parentId ? await P.one('SELECT "id", "name" FROM "CrmAccount" WHERE "id" = ?', x.row.parentId) : null;
    out.children = await P.all('SELECT "id", "name", "city" FROM "CrmAccount" WHERE "parentId" = ? ORDER BY "name" COLLATE NOCASE LIMIT 50', x.row.id);
    out.social = P.parse(x.row.social, {});
    out.employees = x.row.employees || null;
    out.enrichedAt = x.row.enrichedAt || null;
    out.onTeamOnly = !S.canSeeRow(user, x.r, x.row);
  }
  const objs = (await F.objects()).filter((o) => o.linkTo === kind);
  out.objects = [];
  for (const o of objs) {
    // eslint-disable-next-line no-await-in-loop
    const n = await P.one(`SELECT COUNT(*) AS "n" FROM "CrmObjectRecord" WHERE "objectId" = ? AND "${kind}Id" = ?`, o.id, x.row.id);
    out.objects.push({ id: o.id, name: o.name, plural: o.plural, count: Number(n && n.n) || 0 });
  }
  return S.okBody(out);
}

module.exports = {
  cleanTags, tagList, allTags, extraColumns, onTeam, teamAccountIds, recordFor, files, uploadFile, fileDownload, deleteFile, dealContacts, addDealContact, removeDealContact,
  team, addTeam, removeTeam, hierarchy, orgChart, health, healthOf, healthList, search, enrich, applyEnrich, extras, DEAL_ROLES, TEAM_ROLES, domainOf, siteFacts,
};

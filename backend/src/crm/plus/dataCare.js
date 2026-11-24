// ---------------------------------------------------------------------------
// CRM WAVE C - LOOKING AFTER THE DATA (Data & Compliance, and the Leads / Contacts gaps that are about data):
//   16.06 the recycle bin: a deleted lead / account / contact / deal (with what went with it) can be put back; crm/service.js remove() files it here
//   16.05 data retention: the bin is emptied after N days, Junk / Lost leads move to the bin after N days, old activity notes are wiped after N days
//         - OFF until an Admin turns it on; a preview says what would go; runs once a day at 02:00 India time
//   01.04 merge two leads / accounts / contacts into one (pick which value wins, everything on the other moves over, the other goes to the bin),
//         and the duplicates finder (same company name, phone or email)
//   16.07 mass update (owner, a field, a custom field, business unit, tags added / removed) and mass delete (to the bin) of leads, accounts,
//         contacts and deals - each row goes through the normal save, so rights, scope and validation rules all apply
//   02.10 import accounts and contacts from Excel / CSV (dry run first; duplicates skipped; a contact's company found or made)
//   16.03 consent per person and channel (email, SMS, WhatsApp, calls): given / withdrawn, the purpose, where it came from; withdrawn also stops
//         every CRM message on that channel (CrmOptOut, the same list the campaigns and the automatic follow-through read)
//   16.04 data-subject requests: export everything the CRM holds about one email / phone (a JSON file), or erase it (names, phones, emails,
//         notes and custom values wiped; the person stays opted out so they are never contacted again; CRM invoices stay for tax law)
//   16.10 Do-Not-Disturb: a DND list uploaded from the NCPR / the telephony provider, a provider check once its key is saved, and a Call from the
//         CRM to a DND number is refused (crm/contact.js)
//   16.09 the "sensitive" custom fields are encrypted at rest (crm/plus/fields.js) - this file only reports how many are kept that way
// ---------------------------------------------------------------------------
const P = require('./db');
const S = require('../service');

const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : ''; };
const TABLE = { lead: 'CrmLead', account: 'CrmAccount', contact: 'CrmContact', deal: 'CrmDeal' };
const NAME = { lead: 'company', account: 'name', contact: 'name', deal: 'title' };
const WORD = { lead: 'lead', account: 'account', contact: 'contact', deal: 'deal' };
const insertRow = async (table, row) => { const cols = Object.keys(row); await P.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])); };
const mayAdmin = (user) => S.mayAssign(S.roleOf(user));

// ---- the recycle bin --------------------------------------------------------------------------------------------------
// called by crm/service.js remove() just before the record is deleted: what is about to go, so it can be put back
async function toBin(user, kind, row, { why } = {}) {
  if (!TABLE[kind] || !row) return null;
  const extra = {};
  if (kind === 'lead') {
    extra.activities = await P.all('SELECT * FROM "CrmActivity" WHERE "leadId" = ? AND "accountId" IS NULL AND "dealId" IS NULL', row.id);
    extra.tasks = await P.all('SELECT * FROM "CrmTask" WHERE "leadId" = ? AND "accountId" IS NULL AND "dealId" IS NULL', row.id);
    extra.keptActivityIds = (await P.all('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND ("accountId" IS NOT NULL OR "dealId" IS NOT NULL)', row.id)).map((x) => x.id);
    extra.keptTaskIds = (await P.all('SELECT "id" FROM "CrmTask" WHERE "leadId" = ? AND ("accountId" IS NOT NULL OR "dealId" IS NOT NULL)', row.id)).map((x) => x.id);
  }
  if (kind === 'account') extra.contactIds = (await P.all('SELECT "id" FROM "CrmContact" WHERE "accountId" = ?', row.id)).map((x) => x.id);
  if (kind === 'deal') extra.leadIds = (await P.all('SELECT "id" FROM "CrmLead" WHERE "dealId" = ?', row.id)).map((x) => x.id);
  const id = P.newId('bin');
  await insertRow('CrmRecycle', { id, kind, recordId: row.id, name: clip(row[NAME[kind]], 200) || null, rowJson: JSON.stringify(row), extraJson: JSON.stringify(extra), ownerId: row.ownerId || null, deletedById: user ? user.id : null, deletedByName: user ? (user.name || null) : 'Data retention', deletedAt: P.nowIso(), restoredAt: null, why: clip(why, 200) || null });
  return id;
}
const binOut = (b) => ({ id: b.id, kind: b.kind, kindWord: WORD[b.kind], recordId: b.recordId, name: b.name, deletedByName: b.deletedByName, deletedAt: b.deletedAt, why: b.why });
async function bin(user, { kind, q } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const where = ['"restoredAt" IS NULL']; const params = [];
  // a Sales manager / Admin sees the whole bin; a salesperson only what they deleted or owned
  if (!S.mayAssign(r)) { where.push('("deletedById" = ? OR "ownerId" = ?)'); params.push(user.id, user.id); }
  if (TABLE[kind]) { where.push('"kind" = ?'); params.push(kind); }
  if (clip(q, 80)) { where.push('"name" LIKE ?'); params.push(`%${clip(q, 80)}%`); }
  const rows = await P.all(`SELECT * FROM "CrmRecycle" WHERE ${where.join(' AND ')} ORDER BY "deletedAt" DESC LIMIT 500`, ...params);
  const cfg = await P.config();
  return S.okBody({ rows: rows.map(binOut), keepDays: cfg.retention.on ? cfg.retention.binDays : null, canEmpty: S.mayAssign(r) });
}
async function restore(user, binId) {
  const r = S.roleOf(user);
  const b = await P.one('SELECT * FROM "CrmRecycle" WHERE "id" = ? AND "restoredAt" IS NULL', clip(binId, 60));
  if (!b) return S.fail(404, 'This item is not in the recycle bin any more.');
  if (!S.mayAssign(r) && !((b.deletedById === user.id || b.ownerId === user.id) && S.can(user, 'delete'))) return S.fail(403, 'Ask a Sales manager to put this back.');
  const row = P.parse(b.rowJson, null);
  const extra = P.parse(b.extraJson, {});
  if (!row || !row.id) return S.fail(400, 'This item cannot be put back.');
  if (await S.getRow(b.kind, row.id)) return S.fail(409, 'A record with the same id is already back in the CRM.');
  if (b.kind === 'contact' && row.accountId && !(await S.getRow('account', row.accountId))) row.accountId = null;
  if (b.kind === 'deal' && row.accountId && !(await S.getRow('account', row.accountId))) return S.fail(409, 'Put the deal\'s account back first (it is in the recycle bin too, or was removed for good).');
  // the columns the table has today (a column added since the delete is left empty; one dropped is skipped)
  const cols = new Set((await P.all(`PRAGMA table_info("${TABLE[b.kind]}")`)).map((c) => c.name));
  const keep = Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k)));
  keep.updatedAt = P.nowIso();
  await insertRow(TABLE[b.kind], keep);
  if (b.kind === 'lead') {
    for (const a of extra.activities || []) await insertRow('CrmActivity', a).catch(() => null); // eslint-disable-line no-await-in-loop
    for (const t of extra.tasks || []) await insertRow('CrmTask', t).catch(() => null); // eslint-disable-line no-await-in-loop
    for (const id of extra.keptActivityIds || []) await P.run('UPDATE "CrmActivity" SET "leadId" = ? WHERE "id" = ? AND "leadId" IS NULL', row.id, id); // eslint-disable-line no-await-in-loop
    for (const id of extra.keptTaskIds || []) await P.run('UPDATE "CrmTask" SET "leadId" = ? WHERE "id" = ? AND "leadId" IS NULL', row.id, id); // eslint-disable-line no-await-in-loop
  }
  if (b.kind === 'account') for (const id of extra.contactIds || []) await P.run('UPDATE "CrmContact" SET "accountId" = ? WHERE "id" = ? AND "accountId" IS NULL', row.id, id); // eslint-disable-line no-await-in-loop
  if (b.kind === 'deal') for (const id of extra.leadIds || []) await P.run('UPDATE "CrmLead" SET "dealId" = ? WHERE "id" = ? AND "dealId" IS NULL', row.id, id); // eslint-disable-line no-await-in-loop
  await P.run('UPDATE "CrmRecycle" SET "restoredAt" = ? WHERE "id" = ?', P.nowIso(), b.id);
  await S.audit(user, `CRM ${WORD[b.kind]} restored from the recycle bin`, TABLE[b.kind], row.id, b.name);
  return S.okBody({ ok: true, kind: b.kind, id: row.id });
}
async function purgeBinRow(b) {
  // its files go for good with it
  const files = await P.all('SELECT "stored" FROM "CrmRecordFile" WHERE "kind" = ? AND "recordId" = ?', b.kind, b.recordId);
  if (!(await S.getRow(b.kind, b.recordId))) {
    files.forEach((f) => { try { require('../../utils/attachments').remove(f.stored); } catch { /* gone */ } }); // eslint-disable-line global-require
    await P.run('DELETE FROM "CrmRecordFile" WHERE "kind" = ? AND "recordId" = ?', b.kind, b.recordId);
  }
  await P.run('DELETE FROM "CrmRecycle" WHERE "id" = ?', b.id);
}
async function purge(user, binId) {
  if (!mayAdmin(user)) return S.fail(403, 'Only a Sales manager or an Admin can delete for good.');
  const b = await P.one('SELECT * FROM "CrmRecycle" WHERE "id" = ? AND "restoredAt" IS NULL', clip(binId, 60));
  if (!b) return S.fail(404, 'This item is not in the recycle bin.');
  await purgeBinRow(b);
  await S.audit(user, `CRM ${WORD[b.kind]} deleted for good`, 'CrmRecycle', b.recordId, b.name);
  return S.okBody({ ok: true });
}

// ---- data retention ---------------------------------------------------------------------------------------------------------
const DAY = 86400000;
async function retentionPlan(cfg, now = Date.now()) {
  const R = cfg.retention;
  const cut = (d) => new Date(now - d * DAY).toISOString();
  const plan = { bin: [], junk: [], lost: [], activities: 0 };
  if (R.binDays) plan.bin = await P.all('SELECT * FROM "CrmRecycle" WHERE "restoredAt" IS NULL AND "deletedAt" < ? LIMIT 2000', cut(R.binDays));
  if (R.junkLeadDays) plan.junk = await P.all('SELECT * FROM "CrmLead" WHERE "status" = \'Junk\' AND "updatedAt" < ? LIMIT 2000', cut(R.junkLeadDays));
  if (R.lostLeadDays) plan.lost = await P.all('SELECT * FROM "CrmLead" WHERE "stage" = \'Lost\' AND "status" != \'Converted\' AND "updatedAt" < ? LIMIT 2000', cut(R.lostLeadDays));
  if (R.activityDays) { const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmActivity" WHERE "at" < ? AND "note" IS NOT NULL AND "note" != \'(removed by the data retention rule)\'', cut(R.activityDays)); plan.activities = Number(n && n.n) || 0; }
  return plan;
}
async function retentionGet(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Data retention is set by a Sales manager or an Admin.');
  const cfg = await P.config();
  const plan = await retentionPlan(cfg);
  return S.okBody({ retention: cfg.retention, preview: { bin: plan.bin.length, junk: plan.junk.length, lost: plan.lost.length, activities: plan.activities } });
}
async function retentionSave(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Data retention is set by a Sales manager or an Admin.');
  const was = (await P.config({ fresh: true })).retention;
  const next = await P.saveConfig({ retention: { ...was, ...body, lastRunAt: was.lastRunAt, lastResult: was.lastResult } });
  await S.audit(user, 'CRM data retention changed', 'AppSetting', 'crm.plus', `${next.retention.on ? 'ON' : 'off'}: bin ${next.retention.binDays} d, junk ${next.retention.junkLeadDays || '-'} d, lost ${next.retention.lostLeadDays || '-'} d, notes ${next.retention.activityDays || '-'} d`);
  return retentionGet(user);
}
/** One pass. `force` = "Run now" by an Admin (still needs the switch ON). -> what was done. */
async function retentionRun({ user = null, now = Date.now(), force = false } = {}) {
  const cfg = await P.config({ fresh: true });
  if (!cfg.retention.on) return { off: true };
  if (!force && cfg.retention.lastRunAt && now - Date.parse(cfg.retention.lastRunAt) < 20 * 3600000) return { notYet: true };
  const plan = await retentionPlan(cfg, now);
  const sys = { id: user ? user.id : null, name: user ? user.name : 'Data retention' };
  let leads = 0;
  for (const l of [...plan.junk, ...plan.lost]) {
    // eslint-disable-next-line no-await-in-loop
    await toBin(user || null, 'lead', l, { why: `Data retention: ${l.status === 'Junk' ? 'Junk' : 'Lost'} for ${l.status === 'Junk' ? cfg.retention.junkLeadDays : cfg.retention.lostLeadDays}+ days` });
    /* eslint-disable no-await-in-loop */
    await P.run('DELETE FROM "CrmActivity" WHERE "leadId" = ? AND "accountId" IS NULL AND "dealId" IS NULL', l.id);
    await P.run('DELETE FROM "CrmTask" WHERE "leadId" = ? AND "accountId" IS NULL AND "dealId" IS NULL', l.id);
    await P.run('UPDATE "CrmActivity" SET "leadId" = NULL WHERE "leadId" = ?', l.id);
    await P.run('UPDATE "CrmTask" SET "leadId" = NULL WHERE "leadId" = ?', l.id);
    await P.run('DELETE FROM "CrmLead" WHERE "id" = ?', l.id);
    /* eslint-enable no-await-in-loop */
    leads += 1;
  }
  for (const b of plan.bin) await purgeBinRow(b); // eslint-disable-line no-await-in-loop
  let notes = 0;
  if (cfg.retention.activityDays) notes = Number(await P.run('UPDATE "CrmActivity" SET "note" = \'(removed by the data retention rule)\' WHERE "at" < ? AND "note" IS NOT NULL AND "note" != \'(removed by the data retention rule)\'', new Date(now - cfg.retention.activityDays * DAY).toISOString())) || 0;
  const result = { leadsToBin: leads, purged: plan.bin.length, notesWiped: notes, at: new Date(now).toISOString() };
  await P.saveConfig({ retention: { ...cfg.retention, lastRunAt: result.at, lastResult: result } });
  await require('../../utils/audit').logAudit({ userId: sys.id, actorName: sys.name, action: 'CRM data retention ran', entity: 'Crm', entityId: 'retention', toValue: `${leads} leads to the bin, ${plan.bin.length} removed for good, ${notes} old notes wiped` }).catch(() => {}); // eslint-disable-line global-require
  return result;
}
async function retentionRunNow(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Only a Sales manager or an Admin can run data retention.');
  const out = await retentionRun({ user, force: true });
  if (out.off) return S.fail(409, 'Data retention is switched off. Turn it on first.');
  return S.okBody({ ok: true, result: out });
}

// ---- duplicates and merge ------------------------------------------------------------------------------------------------------
async function duplicates(user, kind) {
  if (!['lead', 'account', 'contact'].includes(kind)) return S.fail(400, 'Find duplicates among leads, accounts or contacts.');
  const r = S.roleOf(user);
  const s = S.scopeSql(user, r, '');
  const rows = await P.all(`SELECT * FROM "${TABLE[kind]}" WHERE ${s.sql}${kind === 'lead' ? ' AND "status" != \'Junk\'' : ''} ORDER BY "createdAt" LIMIT 20000`, ...s.params);
  const groups = new Map();
  const put = (key, why, row) => { if (!groups.has(key)) groups.set(key, { why, rows: new Map() }); groups.get(key).rows.set(row.id, row); };
  rows.forEach((x) => {
    const co = kind !== 'contact' ? S.normCo(x[NAME[kind]]) : '';
    if (co && co.length >= 3) put(`co:${co}`, 'Same company name', x);
    if (kind === 'contact' && clip(x.name).length >= 3) put(`nm:${clip(x.name).toLowerCase()}|${x.accountId || ''}`, 'Same name at the same company', x);
    const ph = S.phone10(x.phone); if (ph.length === 10) put(`ph:${ph}`, 'Same phone', x);
    const em = clip(x.email).toLowerCase(); if (em) put(`em:${em}`, 'Same email', x);
  });
  const seen = new Set();
  const out = [];
  groups.forEach((g, key) => {
    if (g.rows.size < 2) return;
    const ids = [...g.rows.keys()].sort().join('|');
    if (seen.has(ids)) return;
    seen.add(ids);
    out.push({ key, why: g.why, rows: [...g.rows.values()].map((x) => ({ id: x.id, name: x[NAME[kind]], code: x.code || null, phone: x.phone, email: x.email, city: x.city || null, status: x.status || x.kind || null, ownerName: x.ownerName, createdAt: x.createdAt })) });
  });
  return S.okBody({ kind, groups: out.slice(0, 300) });
}
const MERGE_FIELDS = {
  lead: ['company', 'contactName', 'designation', 'phone', 'email', 'industry', 'city', 'source', 'rating', 'expectedValue', 'notes'],
  account: ['name', 'industry', 'city', 'website', 'phone', 'email', 'source', 'gstin', 'address', 'state', 'pincode', 'notes'],
  contact: ['name', 'designation', 'role', 'phone', 'email', 'notes'],
};
async function mergePreview(user, kind, keepId, mergeId) {
  if (!MERGE_FIELDS[kind]) return S.fail(400, 'Merge leads, accounts or contacts.');
  const r = S.roleOf(user);
  const keep = await S.getRow(kind, keepId); const other = await S.getRow(kind, mergeId);
  if (!S.canSeeRow(user, r, keep) || !S.canSeeRow(user, r, other)) return S.fail(404, 'One of the two records is not there, or it is not yours.');
  if (keep.id === other.id) return S.fail(400, 'Pick two different records.');
  return S.okBody({ kind, fields: MERGE_FIELDS[kind], keep, other, canMerge: S.canEditRow(user, r, keep) && S.canEditRow(user, r, other) && (S.mayAssign(r) || S.can(user, 'delete')) });
}
async function merge(user, body = {}) {
  const kind = body.kind;
  if (!MERGE_FIELDS[kind]) return S.fail(400, 'Merge leads, accounts or contacts.');
  const r = S.roleOf(user);
  const keep = await S.getRow(kind, clip(body.keepId, 60)); const other = await S.getRow(kind, clip(body.mergeId, 60));
  if (!S.canSeeRow(user, r, keep) || !S.canSeeRow(user, r, other)) return S.fail(404, 'One of the two records is not there, or it is not yours.');
  if (keep.id === other.id) return S.fail(400, 'Pick two different records.');
  if (!S.canEditRow(user, r, keep) || !S.canEditRow(user, r, other)) return S.fail(403, 'You can merge only records you may change.');
  if (!S.mayAssign(r) && !S.can(user, 'delete')) return S.fail(403, 'Merging removes one of the two records. Your CRM rights do not allow deleting - ask a Sales manager.');
  if (kind === 'lead' && keep.status === 'Converted' && other.status === 'Converted') return S.fail(400, 'Both leads are converted already. Merge their accounts instead.');
  const pick = body.pick || {};
  const data = {};
  MERGE_FIELDS[kind].forEach((f) => {
    const kv = keep[f]; const ov = other[f];
    if (pick[f] === 'other' && ov != null && ov !== '') data[f] = ov;
    else if ((kv == null || kv === '') && ov != null && ov !== '') data[f] = ov; // a blank on the kept record is filled from the other
  });
  if (kind !== 'contact' && pick.notes !== 'other' && keep.notes && other.notes && keep.notes !== other.notes) data.notes = `${keep.notes}\n\n— from ${other[NAME[kind]]} —\n${other.notes}`.slice(0, 4000);
  const R = require('./records'); // eslint-disable-line global-require
  const tags = R.cleanTags([...R.tagList(keep.tags), ...R.tagList(other.tags)]);
  if (tags) data.tags = tags;
  const ck = P.parse(keep.customJson, {}); const co = P.parse(other.customJson, {});
  const custom = { ...co, ...ck };
  Object.keys(pick).filter((k) => k.startsWith('cf_') && pick[k] === 'other' && k in co).forEach((k) => { custom[k] = co[k]; });
  if (Object.keys(custom).length) data.customJson = JSON.stringify(custom);
  if (kind === 'lead' && other.status === 'Converted' && keep.status !== 'Converted') Object.assign(data, { status: 'Converted', convertedAt: other.convertedAt, accountId: other.accountId, contactId: other.contactId, dealId: other.dealId });
  if (kind === 'account' && other.kind === 'Client') data.kind = 'Client';
  if (kind === 'account' && !keep.clientId && other.clientId) data.clientId = other.clientId;
  if (kind === 'account' && !keep.parentId && other.parentId && other.parentId !== keep.id) data.parentId = other.parentId;
  const now = P.nowIso();
  data.updatedAt = now;
  // everything on the other record moves to the kept one
  const moves = {
    lead: [['CrmActivity', 'leadId'], ['CrmTask', 'leadId'], ['CrmQuote', 'leadId'], ['CrmAiMeeting', 'leadId'], ['CrmObjectRecord', 'leadId']],
    account: [['CrmContact', 'accountId'], ['CrmDeal', 'accountId'], ['CrmActivity', 'accountId'], ['CrmTask', 'accountId'], ['CrmInvoice', 'accountId'], ['CrmPayment', 'accountId'], ['CrmTicket', 'accountId'], ['CrmProposal', 'accountId'], ['CrmDealFile', 'accountId'], ['CrmLead', 'accountId'], ['CrmObjectRecord', 'accountId']],
    contact: [['CrmDeal', 'contactId'], ['CrmActivity', 'contactId'], ['CrmTicket', 'contactId'], ['CrmLead', 'contactId'], ['CrmObjectRecord', 'contactId'], ['CrmContact', 'reportsToId']],
  }[kind];
  const moved = {};
  for (const [t, col] of moves) {
    // eslint-disable-next-line no-await-in-loop
    const n = await P.run(`UPDATE "${t}" SET "${col}" = ? WHERE "${col}" = ?`, keep.id, other.id).catch(() => 0);
    if (Number(n)) moved[t] = Number(n);
  }
  if (kind === 'account') {
    await P.run('UPDATE "CrmAccount" SET "parentId" = ? WHERE "parentId" = ? AND "id" != ?', keep.id, other.id, keep.id);
    await P.run('INSERT OR IGNORE INTO "CrmAccountTeam" ("id", "accountId", "userId", "userName", "role", "createdById", "createdAt") SELECT "id" || \'m\', ?, "userId", "userName", "role", "createdById", "createdAt" FROM "CrmAccountTeam" WHERE "accountId" = ?', keep.id, other.id);
    await P.run('DELETE FROM "CrmAccountTeam" WHERE "accountId" = ?', other.id);
    await P.run('UPDATE "CrmInvoice" SET "accountName" = ? WHERE "accountId" = ? AND "status" = \'Draft\'', data.name || keep.name, keep.id).catch(() => null);
  }
  if (kind === 'contact') {
    await P.run('INSERT OR IGNORE INTO "CrmDealContact" ("id", "dealId", "contactId", "role", "primary", "createdAt") SELECT "id" || \'m\', "dealId", ?, "role", "primary", "createdAt" FROM "CrmDealContact" WHERE "contactId" = ?', keep.id, other.id);
    await P.run('DELETE FROM "CrmDealContact" WHERE "contactId" = ?', other.id);
    if (!keep.accountId && other.accountId) data.accountId = other.accountId;
  }
  await P.run('UPDATE "CrmRecordFile" SET "recordId" = ? WHERE "kind" = ? AND "recordId" = ?', keep.id, kind, other.id);
  await P.run('UPDATE "CrmConsent" SET "recordId" = ? WHERE "kind" = ? AND "recordId" = ?', keep.id, kind, other.id);
  if (kind === 'lead') await P.run('DELETE FROM "CrmAutoStep" WHERE "recordId" = ?', other.id).catch(() => null);
  const saved = await S.update(TABLE[kind], keep.id, data);
  await toBin(user, kind, other, { why: `Merged into ${keep[NAME[kind]]}${keep.code ? ` (${keep.code})` : ''}` });
  await P.run(`DELETE FROM "${TABLE[kind]}" WHERE "id" = ?`, other.id);
  const link = kind === 'contact' ? { contactId: keep.id, accountId: saved.accountId || null } : { [`${kind}Id`]: keep.id };
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Merged with ${other[NAME[kind]]}${other.code ? ` (${other.code})` : ''}`, note: Object.entries(moved).map(([t, n]) => `${n} ${t.replace(/^Crm/, '').toLowerCase()}`).join(', ') || null, at: now, ...link, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, `CRM ${WORD[kind]}s merged`, TABLE[kind], keep.id, `${other[NAME[kind]]} (${other.id}) -> ${keep[NAME[kind]]}`);
  return S.okBody({ ok: true, [kind]: saved, moved });
}

// ---- mass update / mass delete ------------------------------------------------------------------------------------------------------
const BULK_FIELDS = { lead: ['industry', 'city', 'source', 'rating'], account: ['industry', 'city', 'source', 'state'], contact: ['designation', 'role'], deal: ['expectedClose', 'nextStep'] };
async function bulk(user, body = {}) {
  const kind = body.kind;
  if (!TABLE[kind]) return S.fail(400, 'Pick leads, accounts, contacts or deals.');
  const r = S.roleOf(user);
  if (!S.mayEdit(r)) return S.fail(403, 'Your role can read the CRM but not change it.');
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => clip(x, 60)).filter(Boolean))].slice(0, 1000);
  if (!ids.length) return S.fail(400, 'Tick the records first.');
  const action = body.action;
  let changed = 0; const skipped = [];
  if (action === 'delete') {
    if (!S.mayAssign(r) && !S.can(user, 'delete')) return S.fail(403, 'Your CRM rights do not allow deleting. Ask a Sales manager.');
    for (const id of ids) {
      const out = await S.remove(user, kind, id); // eslint-disable-line no-await-in-loop
      if (out.status === 200) changed += 1; else skipped.push({ id, reason: out.body.error });
    }
    await S.audit(user, `CRM ${WORD[kind]}s deleted together`, TABLE[kind], `${changed} ${WORD[kind]}s`, `${changed} to the recycle bin, ${skipped.length} skipped`);
    return S.okBody({ ok: true, changed, skipped, toBin: true });
  }
  const R = require('./records'); // eslint-disable-line global-require
  const set = body.set || {};
  const patch = {};
  if (action === 'update') {
    BULK_FIELDS[kind].forEach((f) => { if (f in set) patch[f] = set[f]; });
    if (set.ownerId) { if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin can give records to another salesperson.'); patch.ownerId = clip(set.ownerId, 60); }
    if ('unitId' in set && kind !== 'contact') patch.unitId = set.unitId;
    if (set.custom && typeof set.custom === 'object') patch.custom = set.custom;
    if (kind === 'lead' && set.status === 'Junk') patch.status = 'Junk';
    if (!Object.keys(patch).length) return S.fail(400, 'Choose what to change.');
  } else if (action === 'tagAdd' || action === 'tagRemove') {
    if (!R.cleanTags(body.tags)) return S.fail(400, 'Type the tag.');
  } else if (action === 'assignRules') {
    if (kind !== 'lead' || !S.mayAssign(r)) return S.fail(403, 'A Sales manager or an Admin re-runs the assignment rules on leads.');
  } else return S.fail(400, 'Choose what to do.');
  const L = action === 'assignRules' ? require('./leadIn') : null; // eslint-disable-line global-require
  for (const id of ids) {
    /* eslint-disable no-await-in-loop */
    const row = await S.getRow(kind, id);
    if (!S.canEditRow(user, r, row)) { skipped.push({ id, reason: 'not yours' }); continue; } // eslint-disable-line no-continue
    let b = patch;
    if (action === 'tagAdd') b = { tags: R.cleanTags([...R.tagList(row.tags), ...R.tagList(body.tags)]) };
    if (action === 'tagRemove') { const drop = new Set(R.tagList(body.tags).map((x) => x.toLowerCase())); b = { tags: R.tagList(row.tags).filter((t) => !drop.has(t.toLowerCase())).join(', ') }; }
    if (action === 'assignRules') {
      const own = await L.ownerFor(row, { force: true });
      if (!own) { skipped.push({ id, name: row.company, reason: 'no rule matches' }); continue; } // eslint-disable-line no-continue
      b = { ownerId: own.id };
    }
    const out = await S.edit(user, kind, id, b);
    if (out.status === 200) changed += 1; else skipped.push({ id, name: row[NAME[kind]], reason: out.body.error });
    /* eslint-enable no-await-in-loop */
  }
  await S.audit(user, `CRM ${WORD[kind]}s changed together`, TABLE[kind], `${changed} ${WORD[kind]}s`, `${action}: ${JSON.stringify(action === 'update' ? patch : body.tags || '').slice(0, 200)}`);
  return S.okBody({ ok: true, changed, skipped });
}

// ---- import accounts / contacts ----------------------------------------------------------------------------------------------------------
const HEADS = {
  account: { name: ['company', 'companyname', 'account', 'accountname', 'name', 'organisation', 'organization', 'client', 'firm'], industry: ['industry', 'sector'], city: ['city', 'location', 'town'], website: ['website', 'web', 'url', 'site'], phone: ['phone', 'mobile', 'phonenumber', 'contactnumber', 'number'], email: ['email', 'emailid', 'mail'], source: ['source'], gstin: ['gstin', 'gst', 'gstno', 'gstnumber'], state: ['state'], pincode: ['pincode', 'pin', 'zip', 'postcode'], address: ['address', 'addr'], tags: ['tags', 'tag', 'segment'], notes: ['notes', 'remarks', 'comments'], parent: ['parent', 'parentcompany', 'group'] },
  contact: { name: ['name', 'contactname', 'fullname', 'person', 'contact'], designation: ['designation', 'title', 'jobtitle', 'position'], role: ['role', 'roleinthedeal'], phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'number', 'whatsapp'], email: ['email', 'emailid', 'mail'], company: ['company', 'companyname', 'account', 'accountname', 'organisation', 'organization'], tags: ['tags', 'tag'], notes: ['notes', 'remarks', 'comments'] },
};
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
async function importRecords(user, kind, buf, { dryRun, map, fileName, createAccounts } = {}) {
  if (!HEADS[kind]) return S.fail(404, 'Import accounts or contacts here (leads have their own import on Leads).');
  const r = S.roleOf(user);
  if (!S.mayEdit(r) || !S.can(user, 'import')) return S.fail(403, 'Your CRM rights do not allow importing. Ask a Sales manager.');
  if (!buf || !buf.length) return S.fail(400, 'Choose an Excel or CSV file.');
  let rows;
  try {
    const XLSX = require('xlsx'); // eslint-disable-line global-require
    const wb = XLSX.read(buf, { type: 'buffer', raw: false, codepage: 65001 });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  } catch { return S.fail(400, 'This file could not be read. Save it as .xlsx or .csv and try again.'); }
  if (!rows.length) return S.fail(400, 'The first sheet has no rows under the headings.');
  if (rows.length > 3000) return S.fail(400, `The file has ${rows.length} rows; import at most 3000 at a time.`);
  const heads = Object.keys(rows[0]);
  const col = {};
  Object.entries(HEADS[kind]).forEach(([f, names]) => { const h = heads.find((x) => names.includes(normHead(x))); if (h) col[f] = h; });
  // custom fields by their label
  const F = require('./fields'); // eslint-disable-line global-require
  const cdefs = await F.defs(kind);
  const ccol = {};
  cdefs.forEach((d) => { const h = heads.find((x) => normHead(x) === normHead(d.label)); if (h) ccol[d.key] = h; });
  if (map && typeof map === 'object') Object.keys(map).forEach((f) => { const h = String(map[f] || ''); if (f in HEADS[kind]) { if (!h) delete col[f]; else if (heads.includes(h)) col[f] = h; } });
  if (!col.name) return S.fail(400, `No "${kind === 'account' ? 'Company' : 'Name'}" column found. Pick which column it is.`, { headings: heads, columns: col });
  const R = require('./records'); // eslint-disable-line global-require
  // what is already here
  const accounts = await P.all('SELECT "id", "name", "phone", "email", "ownerId" FROM "CrmAccount"');
  const accByCo = new Map(); accounts.forEach((a) => { const c = S.normCo(a.name); if (c && !accByCo.has(c)) accByCo.set(c, a); });
  const seenPh = new Set(); const seenEm = new Set();
  const table = kind === 'account' ? 'CrmAccount' : 'CrmContact';
  (await P.all(`SELECT "phone", "email" FROM "${table}"`)).forEach((x) => { const p = S.phone10(x.phone); if (p.length === 10) seenPh.add(p); const e = clip(x.email).toLowerCase(); if (e) seenEm.add(e); });
  const contactKeys = new Set(kind === 'contact' ? (await P.all('SELECT "name", "accountId" FROM "CrmContact"')).map((c) => `${clip(c.name).toLowerCase()}|${c.accountId || ''}`) : []);
  const ready = []; const skipped = []; const newAccounts = new Map();
  rows.forEach((raw, i) => {
    const body = {};
    Object.entries(col).forEach(([f, h]) => { body[f] = String(raw[h] == null ? '' : raw[h]).trim(); });
    if (!body.name) { if (Object.values(body).some(Boolean)) skipped.push({ row: i + 2, name: '', reason: `No ${kind === 'account' ? 'company' : 'name'}` }); return; }
    if (body.phone) body.phone = body.phone.replace(/\.0$/, '');
    const c = S.cleanFields(kind, body, { partial: false });
    if (c.error) { skipped.push({ row: i + 2, name: body.name, reason: c.error }); return; }
    const p = S.phone10(c.data.phone); const e = clip(c.data.email).toLowerCase();
    if (kind === 'account' && accByCo.has(S.normCo(c.data.name))) { skipped.push({ row: i + 2, name: body.name, reason: `Already in the CRM: ${accByCo.get(S.normCo(c.data.name)).name}` }); return; }
    if ((p.length === 10 && seenPh.has(p)) || (e && seenEm.has(e))) { skipped.push({ row: i + 2, name: body.name, reason: 'Same phone or email already in the CRM (or earlier in this file)' }); return; }
    const custom = {};
    for (const d of cdefs) {
      if (!ccol[d.key] || d.sensitive) continue; // eslint-disable-line no-continue
      const v = F.cleanValue(d, raw[ccol[d.key]]);
      if (v.error) { skipped.push({ row: i + 2, name: body.name, reason: v.error }); return; }
      if (v.value != null) custom[d.key] = v.value;
    }
    const rec = { ...c.data, tags: R.cleanTags(body.tags) || null, customJson: Object.keys(custom).length ? JSON.stringify(custom) : null };
    if (kind === 'account') { if (body.parent) rec._parent = body.parent; accByCo.set(S.normCo(c.data.name), { id: null, name: c.data.name }); }
    if (kind === 'contact') {
      delete rec.accountId;
      const co = S.normCo(body.company);
      const acc = co ? accByCo.get(co) : null;
      if (body.company && !acc && !createAccounts) { skipped.push({ row: i + 2, name: body.name, reason: `Company "${body.company.slice(0, 60)}" is not in the CRM (tick "Add missing companies")` }); return; }
      if (acc && acc.ownerId && !S.seesAll(r) && acc.ownerId !== user.id) { skipped.push({ row: i + 2, name: body.name, reason: `${acc.name} belongs to another salesperson` }); return; }
      rec._company = body.company || '';
      if (body.company && !acc) newAccounts.set(co, body.company);
      const k = `${clip(c.data.name).toLowerCase()}|${acc ? acc.id || co : ''}`;
      if (contactKeys.has(k)) { skipped.push({ row: i + 2, name: body.name, reason: 'This person is already at this company' }); return; }
      contactKeys.add(k);
      if (c.data.role && !S.CONTACT_ROLES.includes(c.data.role)) rec.role = 'Other';
    }
    if (p.length === 10) seenPh.add(p); if (e) seenEm.add(e);
    ready.push(rec);
  });
  if (dryRun) return S.okBody({ ok: true, dryRun: true, rows: rows.length, ready: ready.length, skipped, columns: col, customColumns: ccol, headings: heads, newAccounts: [...newAccounts.values()].slice(0, 50), sample: ready.slice(0, 5).map((x) => ({ ...x, customJson: undefined })) });
  const now = P.nowIso();
  const base = { ownerId: user.id, ownerName: user.name || null, createdById: user.id, createdAt: now, updatedAt: now };
  let created = 0; let accountsMade = 0;
  if (kind === 'account') {
    const codes = await S.nextCodes('account', ready.length);
    const made = new Map();
    for (let i = 0; i < ready.length; i += 1) {
      const { _parent, ...rec } = ready[i];
      // eslint-disable-next-line no-await-in-loop
      const row = await S.insert('CrmAccount', { id: S.newId('account'), ...rec, kind: 'Prospect', code: codes[i] || null, ...base });
      made.set(S.normCo(row.name), row); created += 1;
      if (_parent) ready[i]._row = row;
    }
    // parent companies named in the file: linked once everything is in
    for (const x of ready.filter((y) => y._parent && y._row)) {
      const pa = made.get(S.normCo(x._parent)) || accByCo.get(S.normCo(x._parent));
      if (pa && pa.id && pa.id !== x._row.id) await P.run('UPDATE "CrmAccount" SET "parentId" = ? WHERE "id" = ?', pa.id, x._row.id); // eslint-disable-line no-await-in-loop
    }
  } else {
    for (const rec of ready) {
      const { _company, ...c } = rec;
      let acc = _company ? accByCo.get(S.normCo(_company)) : null;
      if (_company && (!acc || !acc.id)) {
        const [code] = await S.nextCodes('account', 1); // eslint-disable-line no-await-in-loop
        acc = await S.insert('CrmAccount', { id: S.newId('account'), name: _company.slice(0, 300), kind: 'Prospect', code: code || null, ...base }); // eslint-disable-line no-await-in-loop
        accByCo.set(S.normCo(_company), acc); accountsMade += 1;
      }
      await S.insert('CrmContact', { id: S.newId('contact'), ...c, accountId: acc ? acc.id : null, ...base }); // eslint-disable-line no-await-in-loop
      created += 1;
    }
  }
  await S.audit(user, `CRM ${kind}s imported`, table, clip(fileName, 80) || 'file', `${created} added${accountsMade ? ` (+${accountsMade} companies)` : ''}, ${skipped.length} skipped`);
  await require('../analytics').logExport(user, `Import: ${kind}s`, 'import', created).catch(() => {}); // eslint-disable-line global-require
  return S.okBody({ ok: true, created, accountsMade, skipped });
}

// ---- consent per person and channel ---------------------------------------------------------------------------------------------------
const CONSENT_CHANNELS = ['email', 'sms', 'whatsapp', 'call'];
const CH_WORD = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', call: 'Calls' };
const PURPOSES = ['Sales follow-up', 'Marketing / newsletters', 'Product updates', 'Service messages', 'Other'];
const CONSENT_SOURCES = ['Told us on a call', 'Website form', 'Email reply', 'Signed form', 'Event', 'Unsubscribe link', 'Other'];
const valueFor = (channel, rec) => (channel === 'email' ? clip(rec.email).toLowerCase() : S.phone10(rec.phone));
async function personOf(user, kind, id) {
  const R = require('./records'); // eslint-disable-line global-require
  const x = await R.recordFor(user, kind, id);
  if (x.error) return x;
  return { ...x, email: clip(x.row.email).toLowerCase(), phone: S.phone10(x.row.phone), name: x.row.contactName || x.row.name || x.row.company || x.row.title };
}
async function consentOf(email, phone) {
  const out = {};
  for (const ch of CONSENT_CHANNELS) {
    const v = ch === 'email' ? email : phone;
    if (!v || (ch !== 'email' && v.length < 10)) { out[ch] = { channel: ch, word: CH_WORD[ch], value: null, status: 'No address' }; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const hist = await P.all('SELECT * FROM "CrmConsent" WHERE "value" = ? AND "channel" = ? ORDER BY "at" DESC LIMIT 20', v, ch);
    // eslint-disable-next-line no-await-in-loop
    const opt = await P.one('SELECT * FROM "CrmOptOut" WHERE "value" = ? AND "channel" = ?', v, ch);
    const last = hist[0];
    let status = last ? (last.status === 'given' ? 'Given' : 'Withdrawn') : 'Not asked';
    if (opt) status = 'Withdrawn'; // "given" removes the opt-out, so one still there came later (the unsubscribe link, "do not call" ...)
    out[ch] = { channel: ch, word: CH_WORD[ch], value: v, status, purpose: last ? last.purpose : null, source: last ? last.source : (opt ? opt.reason : null), at: last ? last.at : (opt ? opt.createdAt : null), history: [...hist.map((h) => ({ status: h.status, purpose: h.purpose, source: h.source, note: h.note, at: h.at, byName: h.byName })), ...(opt && !hist.some((h) => h.status === 'withdrawn') ? [{ status: 'withdrawn', purpose: null, source: opt.reason || 'Opted out', note: null, at: opt.createdAt, byName: null }] : [])] };
  }
  return out;
}
async function consentGet(user, kind, id) {
  const p = await personOf(user, kind, id);
  if (p.error) return p.error;
  const dnd = p.phone.length === 10 ? await isDnd(p.phone, { local: true }) : null;
  return S.okBody({ name: p.name, email: p.email || null, phone: p.phone || null, channels: await consentOf(p.email, p.phone), dnd, canEdit: p.canEdit, purposes: PURPOSES, sources: CONSENT_SOURCES });
}
async function consentSet(user, kind, id, body = {}) {
  const p = await personOf(user, kind, id);
  if (p.error) return p.error;
  if (!p.canEdit) return S.fail(403, 'You can read this record but not change it.');
  const ch = CONSENT_CHANNELS.includes(body.channel) ? body.channel : null;
  if (!ch) return S.fail(400, 'Pick the channel: email, SMS, WhatsApp or calls.');
  const status = body.status === 'given' ? 'given' : body.status === 'withdrawn' ? 'withdrawn' : null;
  if (!status) return S.fail(400, 'Given or withdrawn?');
  const v = ch === 'email' ? p.email : p.phone;
  if (!v || (ch !== 'email' && v.length < 10)) return S.fail(400, ch === 'email' ? 'This record has no email address.' : 'This record has no 10-digit phone number.');
  const purpose = PURPOSES.includes(body.purpose) ? body.purpose : (status === 'given' ? 'Sales follow-up' : null);
  const source = CONSENT_SOURCES.includes(body.source) ? body.source : 'Other';
  const now = P.nowIso();
  await insertRow('CrmConsent', { id: P.newId('cons'), value: v, channel: ch, status, purpose, source, note: clip(body.note, 300) || null, kind, recordId: p.row.id, byId: user.id, byName: user.name || null, at: now });
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  if (status === 'withdrawn') await CMP.optOut(ch, v, { reason: `Consent withdrawn (${source})`, byId: user.id });
  else await P.run('DELETE FROM "CrmOptOut" WHERE "value" = ? AND "channel" = ?', v, ch); // given again: messages on this channel may go again
  const link = kind === 'contact' ? { contactId: p.row.id, accountId: p.row.accountId || null } : { [`${kind}Id`]: p.row.id };
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Consent ${status} for ${CH_WORD[ch]}`, note: [purpose, source, clip(body.note, 300)].filter(Boolean).join(' · ') || null, at: now, ...link, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, `CRM consent ${status}`, 'CrmConsent', p.row.id, `${CH_WORD[ch]}: ${v}`);
  return consentGet(user, kind, id);
}

// ---- data-subject requests (export / erase one person) ------------------------------------------------------------------------------
function personKey(raw) {
  const s = clip(raw, 200);
  if (/@/.test(s)) return { email: s.toLowerCase(), phone: '' };
  const p = S.phone10(s);
  return p.length === 10 ? { email: '', phone: p } : null;
}
async function findPerson({ email, phone }) {
  const em = (col) => (email ? `LOWER(TRIM(${col})) = ?` : '0');
  const ph = (col) => (phone ? `SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(${col}, ' ', ''), '-', ''), '+', ''), '(', ''), -10) = ?` : '0');
  const args = [...(email ? [email] : []), ...(phone ? [phone] : [])];
  const where = (a, b) => `(${em(a)} OR ${ph(b)})`;
  const leads = await P.all(`SELECT * FROM "CrmLead" WHERE ${where('"email"', '"phone"')}`, ...args);
  const contacts = await P.all(`SELECT * FROM "CrmContact" WHERE ${where('"email"', '"phone"')}`, ...args);
  const accounts = await P.all(`SELECT * FROM "CrmAccount" WHERE ${where('"email"', '"phone"')}`, ...args);
  const leadIds = leads.map((x) => x.id); const contactIds = contacts.map((x) => x.id);
  const inIds = (col, ids) => (ids.length ? `"${col}" IN (${ids.map(() => '?').join(',')})` : '0');
  const activities = await P.all(`SELECT * FROM "CrmActivity" WHERE ${inIds('leadId', leadIds)} OR ${inIds('contactId', contactIds)}`, ...leadIds, ...contactIds);
  const tasks = await P.all(`SELECT * FROM "CrmTask" WHERE ${inIds('leadId', leadIds)}`, ...leadIds);
  const vals = [email, phone].filter(Boolean);
  const consent = vals.length ? await P.all(`SELECT * FROM "CrmConsent" WHERE "value" IN (${vals.map(() => '?').join(',')})`, ...vals) : [];
  const optOuts = vals.length ? await P.all(`SELECT * FROM "CrmOptOut" WHERE "value" IN (${vals.map(() => '?').join(',')})`, ...vals) : [];
  const campaignMessages = await P.all(`SELECT * FROM "CrmCampaignRecipient" WHERE ${email ? 'LOWER("toAddr") = ?' : '0'} OR ${phone ? 'SUBSTR("toAddr", -10) = ?' : '0'} OR ${inIds('recordId', [...leadIds, ...contactIds])}`, ...args, ...leadIds, ...contactIds).catch(() => []);
  const tickets = contactIds.length ? await P.all(`SELECT * FROM "CrmTicket" WHERE ${inIds('contactId', contactIds)}`, ...contactIds).catch(() => []) : [];
  return { leads, contacts, accounts, activities, tasks, consent, optOuts, campaignMessages, tickets };
}
const countsOf = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.length]));
async function dsrList(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Data requests are handled by a Sales manager or an Admin.');
  const rows = await P.all('SELECT * FROM "CrmDataRequest" ORDER BY "createdAt" DESC LIMIT 200');
  return S.okBody({ rows: rows.map((x) => ({ ...x, detail: P.parse(x.detail, null) })) });
}
async function dsrCreate(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Data requests are handled by a Sales manager or an Admin.');
  const key = personKey(body.person);
  if (!key) return S.fail(400, 'Type the person\'s email address or 10-digit mobile number.');
  const type = body.type === 'erase' ? 'erase' : 'export';
  const found = await findPerson(key);
  const now = P.nowIso();
  // DPDP: answer within a reasonable time - the screen shows 30 days from the request
  const row = { id: P.newId('dsr'), type, person: key.email || key.phone, status: 'Open', note: clip(body.note, 400) || null, detail: JSON.stringify({ found: countsOf(found) }), byId: user.id, byName: user.name || null, createdAt: now, doneAt: null, dueBy: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10) };
  await insertRow('CrmDataRequest', row);
  await S.audit(user, `CRM data request (${type}) opened`, 'CrmDataRequest', row.id, row.person);
  return S.okBody({ ok: true, request: { ...row, detail: { found: countsOf(found) } } });
}
async function dsrExport(user, id) {
  if (!mayAdmin(user)) return S.fail(403, 'Data requests are handled by a Sales manager or an Admin.');
  const q = await P.one('SELECT * FROM "CrmDataRequest" WHERE "id" = ?', clip(id, 60));
  if (!q) return S.fail(404, 'This request is not there.');
  const key = personKey(q.person);
  const found = await findPerson(key);
  const F = require('./fields'); // eslint-disable-line global-require
  const decode = async (kind, rows) => { const out = []; for (const x of rows) out.push({ ...x, customJson: undefined, custom: await F.valuesOf(user, kind, x, { forEdit: true }) }); return out; }; // eslint-disable-line no-await-in-loop
  const data = { person: q.person, exportedAt: P.nowIso(), exportedBy: user.name || null, leads: await decode('lead', found.leads), contacts: await decode('contact', found.contacts), accounts: found.accounts.map((a) => ({ id: a.id, name: a.name, phone: a.phone, email: a.email })), activities: found.activities, followUps: found.tasks, consent: found.consent, optOuts: found.optOuts, campaignMessages: found.campaignMessages, supportTickets: found.tickets };
  if (q.type === 'export') await P.run('UPDATE "CrmDataRequest" SET "status" = \'Done\', "doneAt" = ?, "detail" = ? WHERE "id" = ?', P.nowIso(), JSON.stringify({ found: countsOf(found), exported: true }), q.id);
  await S.audit(user, 'CRM personal data exported', 'CrmDataRequest', q.id, q.person);
  return { status: 200, json: JSON.stringify(data, null, 2), name: `crm-data-${q.person.replace(/[^a-z0-9]+/gi, '-')}-${S.istToday()}.json` };
}
async function dsrErase(user, id, { confirm } = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'Data requests are handled by a Sales manager or an Admin.');
  const q = await P.one('SELECT * FROM "CrmDataRequest" WHERE "id" = ?', clip(id, 60));
  if (!q) return S.fail(404, 'This request is not there.');
  if (q.type !== 'erase') return S.fail(400, 'This is an export request.');
  if (q.status === 'Done') return S.fail(400, 'This person was erased already.');
  if (confirm !== true) return S.fail(400, 'Confirm the erase: it cannot be undone.');
  const key = personKey(q.person);
  const f = await findPerson(key);
  const now = P.nowIso();
  const GONE = 'Erased person';
  const CMP = require('../campaigns'); // eslint-disable-line global-require
  // never contacted again: the address stays on the do-not-contact list (that is what the list is for), nothing else of them
  for (const ch of CONSENT_CHANNELS) { const v = ch === 'email' ? key.email : key.phone; if (v) await CMP.optOut(ch, v, { reason: 'Erased on request (data-subject request)', byId: user.id }); } // eslint-disable-line no-await-in-loop
  /* eslint-disable no-await-in-loop */
  for (const l of f.leads) {
    const personAsCompany = S.normCo(l.company) === S.normCo(l.contactName) || !l.contactName;
    await P.run('UPDATE "CrmLead" SET "contactName" = ?, "designation" = NULL, "phone" = NULL, "email" = NULL, "notes" = NULL, "customJson" = NULL, "tags" = NULL, "pageUrl" = NULL, "company" = ?, "updatedAt" = ? WHERE "id" = ?', GONE, personAsCompany ? GONE : l.company, now, l.id);
  }
  for (const c of f.contacts) await P.run('UPDATE "CrmContact" SET "name" = ?, "designation" = NULL, "phone" = NULL, "email" = NULL, "notes" = NULL, "customJson" = NULL, "tags" = NULL, "updatedAt" = ? WHERE "id" = ?', GONE, now, c.id);
  for (const a of f.accounts) await P.run(`UPDATE "CrmAccount" SET ${key.email && clip(a.email).toLowerCase() === key.email ? '"email" = NULL,' : ''} ${key.phone && S.phone10(a.phone) === key.phone ? '"phone" = NULL,' : ''} "updatedAt" = ? WHERE "id" = ?`, now, a.id);
  for (const a of f.activities) await P.run('UPDATE "CrmActivity" SET "note" = \'(erased on request)\' WHERE "id" = ?', a.id);
  for (const m of f.campaignMessages) await P.run('UPDATE "CrmCampaignRecipient" SET "toAddr" = NULL, "name" = ? WHERE "id" = ?', GONE, m.id).catch(() => null);
  for (const fl of [...f.leads.map((x) => ['lead', x.id]), ...f.contacts.map((x) => ['contact', x.id])]) {
    const files = await P.all('SELECT * FROM "CrmRecordFile" WHERE "kind" = ? AND "recordId" = ?', fl[0], fl[1]);
    files.forEach((x) => { try { require('../../utils/attachments').remove(x.stored); } catch { /* gone */ } }); // eslint-disable-line global-require
    await P.run('DELETE FROM "CrmRecordFile" WHERE "kind" = ? AND "recordId" = ?', fl[0], fl[1]);
  }
  await P.run(`DELETE FROM "CrmConsent" WHERE "value" IN (${[key.email, key.phone].filter(Boolean).map(() => '?').join(',')})`, ...[key.email, key.phone].filter(Boolean));
  // and from the recycle bin: a deleted copy of them goes for good
  const binRows = await P.all('SELECT * FROM "CrmRecycle" WHERE "restoredAt" IS NULL AND ("rowJson" LIKE ? OR "rowJson" LIKE ?)', key.email ? `%${key.email}%` : '__none__', key.phone ? `%${key.phone}%` : '__none__');
  for (const b of binRows) await purgeBinRow(b);
  /* eslint-enable no-await-in-loop */
  const done = { leads: f.leads.length, contacts: f.contacts.length, accountsCleared: f.accounts.length, notes: f.activities.length, campaignMessages: f.campaignMessages.length, recycleBin: binRows.length, invoicesKept: 'CRM invoices are kept as they are (tax law)' };
  await P.run('UPDATE "CrmDataRequest" SET "status" = \'Done\', "doneAt" = ?, "detail" = ? WHERE "id" = ?', now, JSON.stringify({ found: countsOf(f), erased: done }), q.id);
  await S.audit(user, 'CRM personal data erased', 'CrmDataRequest', q.id, `${q.person}: ${JSON.stringify(done).slice(0, 250)}`);
  return S.okBody({ ok: true, erased: done });
}

// ---- Do-Not-Disturb ------------------------------------------------------------------------------------------------------------------
async function providerDnd(phone) {
  const cfg = await P.config();
  if (!cfg.dnd.providerOn) return null;
  const ic = await require('../../utils/integrationStore').readConfig('crm-dnd').catch(() => null); // eslint-disable-line global-require
  const v = (ic && ic.values) || {};
  const url = clip(v['Check URL (use {number})'], 400); const key = clip(v['API key'], 400);
  if (!url || !key) return null;
  let dnd = false;
  if (process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX) dnd = /0000$/.test(phone); // the stub: a number ending 0000 is on DND
  else {
    const { fetchPublic } = require('../../utils/safeFetch'); // eslint-disable-line global-require
    const res = await fetchPublic(url.replace('{number}', encodeURIComponent(`91${phone}`)), { headers: { [clip(v['Key header name'], 60) || 'Authorization']: key, Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    const t = JSON.stringify(j).toLowerCase();
    dnd = j.dnd === true || j.is_dnd === true || /"dnd[_ ]?status"\s*:\s*"(yes|true|dnd|registered)"/.test(t) || /"status"\s*:\s*"dnd"/.test(t);
  }
  await P.run('INSERT INTO "CrmDnd" ("value", "source", "category", "addedAt") VALUES (?, ?, ?, ?) ON CONFLICT("value") DO UPDATE SET "source" = excluded."source", "addedAt" = excluded."addedAt"', phone, dnd ? 'provider' : 'provider-clear', null, P.nowIso());
  return dnd;
}
/** Is this number on DND? The local list first (uploaded, or a provider answer kept), then the provider (only when switched on and its key saved). */
async function isDnd(raw, { local = false } = {}) {
  const phone = S.phone10(raw);
  if (phone.length !== 10) return false;
  const row = await P.one('SELECT * FROM "CrmDnd" WHERE "value" = ?', phone);
  if (row) return row.source !== 'provider-clear';
  if (local) return false;
  return !!(await providerDnd(phone).catch(() => null));
}
/** crm/contact.js call(): null, or the refusal. */
async function callBlock(number) {
  const cfg = await P.config();
  if (!cfg.dnd.blockCalls) return null;
  if (await isDnd(number).catch(() => false)) return S.fail(409, 'This number is on the Do-Not-Disturb (DND) registry, so a sales call from TeamLink is not placed. If the person asked you to call, record their consent for calls on the record (Privacy tab) and ask a Sales manager to clear the number from the DND list.', { dnd: true });
  return null;
}
async function dndGet(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const cfg = await P.config();
  const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDnd" WHERE "source" != \'provider-clear\'');
  const ic = await require('../../utils/integrationStore').readConfig('crm-dnd').catch(() => null); // eslint-disable-line global-require
  return S.okBody({ dnd: cfg.dnd, listed: Number(n && n.n) || 0, providerReady: !!(ic && ic.values && ic.values['API key'] && ic.values['Check URL (use {number})']), canEdit: mayAdmin(user) });
}
async function dndSave(user, body = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'DND handling is set by a Sales manager or an Admin.');
  const was = (await P.config({ fresh: true })).dnd;
  await P.saveConfig({ dnd: { ...was, ...(typeof body.blockCalls === 'boolean' ? { blockCalls: body.blockCalls } : {}), ...(typeof body.providerOn === 'boolean' ? { providerOn: body.providerOn } : {}) } });
  await S.audit(user, 'CRM DND settings changed', 'AppSetting', 'crm.plus', JSON.stringify(body).slice(0, 200));
  return dndGet(user);
}
async function dndUpload(user, buf, { replace } = {}) {
  if (!mayAdmin(user)) return S.fail(403, 'The DND list is kept by a Sales manager or an Admin.');
  if (!buf || !buf.length) return S.fail(400, 'Choose the DND file (Excel, CSV or a text file of numbers).');
  let text = '';
  try {
    const XLSX = require('xlsx'); // eslint-disable-line global-require
    const wb = XLSX.read(buf, { type: 'buffer', raw: false });
    text = wb.SheetNames.map((s) => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
  } catch { text = buf.toString('utf8'); }
  const nums = [...new Set((text.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) || []).map((x) => S.phone10(x)).filter((x) => x.length === 10))].slice(0, 200000);
  if (!nums.length) return S.fail(400, 'No 10-digit mobile numbers were found in this file.');
  if (replace === true) await P.run('DELETE FROM "CrmDnd" WHERE "source" = \'upload\'');
  const now = P.nowIso();
  for (let i = 0; i < nums.length; i += 400) {
    const part = nums.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    await P.run(`INSERT INTO "CrmDnd" ("value", "source", "category", "addedAt") VALUES ${part.map(() => '(?, \'upload\', NULL, ?)').join(', ')} ON CONFLICT("value") DO UPDATE SET "source" = 'upload', "addedAt" = excluded."addedAt"`, ...part.flatMap((v) => [v, now]));
  }
  await S.audit(user, 'CRM DND list uploaded', 'CrmDnd', `${nums.length} numbers`, replace ? 'replaced the uploaded list' : 'added');
  return dndGet(user).then((o) => ({ ...o, body: { ...o.body, added: nums.length } }));
}
async function dndCheck(user, phone) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const p = S.phone10(phone);
  if (p.length !== 10) return S.fail(400, 'Type a 10-digit mobile number.');
  const local = await P.one('SELECT * FROM "CrmDnd" WHERE "value" = ?', p);
  const dnd = await isDnd(p);
  return S.okBody({ phone: p, dnd, source: local ? local.source : (dnd ? 'provider' : null) });
}
async function dndClear(user, phone) {
  if (!mayAdmin(user)) return S.fail(403, 'Only a Sales manager or an Admin can clear a number from the DND list.');
  const p = S.phone10(phone);
  await P.run('INSERT INTO "CrmDnd" ("value", "source", "category", "addedAt") VALUES (?, \'provider-clear\', \'cleared by hand\', ?) ON CONFLICT("value") DO UPDATE SET "source" = \'provider-clear\', "category" = \'cleared by hand\', "addedAt" = excluded."addedAt"', p, P.nowIso());
  await S.audit(user, 'CRM DND number cleared', 'CrmDnd', p, 'cleared by hand (the person asked to be called)');
  return S.okBody({ ok: true });
}

// ---- privacy summary (Customise > Data & privacy) -----------------------------------------------------------------------------------------
async function privacySummary(user) {
  if (!mayAdmin(user)) return S.fail(403, 'Only a Sales manager or an Admin.');
  const enc = await P.one('SELECT COUNT(*) AS "n" FROM "CrmFieldDef" WHERE "sensitive" = 1 AND "active" = 1');
  const cons = await P.one('SELECT COUNT(DISTINCT "value" || "channel") AS "n" FROM "CrmConsent"');
  const opts = await P.one('SELECT COUNT(*) AS "n" FROM "CrmOptOut"');
  const open = await P.one('SELECT COUNT(*) AS "n" FROM "CrmDataRequest" WHERE "status" = \'Open\'');
  const binN = await P.one('SELECT COUNT(*) AS "n" FROM "CrmRecycle" WHERE "restoredAt" IS NULL');
  return S.okBody({ encryptedFields: Number(enc && enc.n) || 0, keyConfigured: require('../../utils/secrets').secretsConfigured(), consentRecords: Number(cons && cons.n) || 0, optOuts: Number(opts && opts.n) || 0, openRequests: Number(open && open.n) || 0, inBin: Number(binN && binN.n) || 0 }); // eslint-disable-line global-require
}

module.exports = {
  toBin, bin, restore, purge, retentionGet, retentionSave, retentionRun, retentionRunNow, duplicates, mergePreview, merge, bulk, importRecords,
  consentGet, consentSet, dsrList, dsrCreate, dsrExport, dsrErase, isDnd, callBlock, dndGet, dndSave, dndUpload, dndCheck, dndClear, privacySummary, CONSENT_CHANNELS, MERGE_FIELDS,
};

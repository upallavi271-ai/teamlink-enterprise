// ---------------------------------------------------------------------------
// CRM WAVE C - ADMIN & CUSTOMISATION:
//   17.04 currencies (the rates the deals are priced at) and 17.05 business units - kept in the crm.plus settings row
//   17.06 number format (Indian lakh / crore or international) - the CRM screens' words follow the app's English / Telugu / Hindi switch
//   17.07 a configuration package: download every CRM setting, field, rule, layout, record type and lead rule as one file, and load it into
//         another TeamLink (a test copy) - with a dry run that says what would change
//   17.08 the financial year (which month it starts) for the "This financial year / quarter" reports, and the company holidays (on the calendar)
//   17.09 branding: the logo and colour on CRM invoices and proposals, and a line under the company name
//   17.12 adoption: who opens the CRM, how often, what they change, follow-ups done / late, downloads - per person, with a daily chart
// ---------------------------------------------------------------------------
const P = require('./db');
const S = require('../service');
const SETTINGS = require('../settings');

const clip = (v, n = 300) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : ''; };
const mayAdmin = (user) => S.mayAssign(S.roleOf(user));
const NO = () => S.fail(403, 'Only a Sales manager or an Admin can change how the CRM is set up.');

// ---- currencies, business units, number format, financial year, holidays, branding --------------------------------------
async function prefsGet(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const cfg = await P.config({ fresh: true });
  return S.okBody({ currencies: cfg.currencies, baseCurrency: 'INR', units: cfg.units, unitsOn: cfg.unitsOn, fiscal: cfg.fiscal, branding: { color: cfg.branding.color, tagline: cfg.branding.tagline, logo: cfg.branding.logo ? { name: cfg.branding.logo.name } : null }, locale: cfg.locale, months: P.MONTHS, canEdit: mayAdmin(user) });
}
async function prefsSave(user, body = {}) {
  if (!mayAdmin(user)) return NO();
  const cfg = await P.config({ fresh: true });
  const patch = {};
  if (Array.isArray(body.currencies)) patch.currencies = body.currencies;
  if (Array.isArray(body.units)) {
    const M = require('../money'); // eslint-disable-line global-require
    const bad = body.units.find((u) => u && u.gstin && !M.validGstin(String(u.gstin).trim().toUpperCase()));
    if (bad) return S.fail(400, `The GSTIN of ${clip(bad.name, 60) || 'a unit'} does not look right (15 characters, starting with the state code).`);
    patch.units = body.units;
  }
  if (typeof body.unitsOn === 'boolean') patch.unitsOn = body.unitsOn;
  if (body.fiscal) patch.fiscal = { ...cfg.fiscal, ...body.fiscal };
  if (body.branding) patch.branding = { ...cfg.branding, color: body.branding.color || cfg.branding.color, tagline: body.branding.tagline != null ? body.branding.tagline : cfg.branding.tagline, logo: body.branding.removeLogo ? null : cfg.branding.logo };
  if (body.locale) patch.locale = { ...cfg.locale, ...body.locale };
  if (body.branding && body.branding.removeLogo && cfg.branding.logo) { try { require('../../utils/attachments').remove(cfg.branding.logo.stored); } catch { /* gone */ } } // eslint-disable-line global-require
  await P.saveConfig(patch);
  await S.audit(user, 'CRM preferences changed', 'AppSetting', 'crm.plus', Object.keys(patch).join(', '));
  return prefsGet(user);
}
async function uploadLogo(user, req) {
  if (!mayAdmin(user)) { req.resume(); return NO(); }
  const A = require('../../utils/attachments'); // eslint-disable-line global-require
  let parsed;
  try { parsed = await A.parseMultipart(req, { maxBytes: 1024 * 1024 }); } catch (e) {
    if (!req.complete && !req.destroyed) { req.resume(); await new Promise((ok) => { req.once('end', ok); req.once('error', ok); setTimeout(ok, 15000); }); }
    return S.fail(e.code === 'TOO_LARGE' ? 413 : 400, e.code === 'TOO_LARGE' ? 'The logo must be 1 MB or smaller.' : 'The logo could not be read.');
  }
  const f = parsed.file;
  if (!f || !['image/png', 'image/jpeg'].includes(f.contentType)) return S.fail(400, 'The logo must be a PNG or JPEG picture.');
  let saved;
  try { saved = A.store(f, { maxBytes: 1024 * 1024 }); } catch { return S.fail(400, 'The logo could not be kept.'); }
  const cfg = await P.config({ fresh: true });
  if (cfg.branding.logo) { try { A.remove(cfg.branding.logo.stored); } catch { /* gone */ } }
  await P.saveConfig({ branding: { ...cfg.branding, logo: { stored: saved.billFile, mime: saved.billMime, name: saved.billName } } });
  await S.audit(user, 'CRM logo changed', 'AppSetting', 'crm.plus', saved.billName);
  return prefsGet(user);
}
async function logoFile(user) {
  if (!S.roleOf(user)) return S.fail(403, 'No CRM access.');
  const cfg = await P.config();
  const full = cfg.branding.logo ? require('../../utils/attachments').resolveStored(cfg.branding.logo.stored) : null; // eslint-disable-line global-require
  if (!full) return S.fail(404, 'No logo is set.');
  return { status: 200, path: full, mime: cfg.branding.logo.mime };
}
/** For the PDFs (crm/extra.js): { logoPath, color, tagline } from the last read settings (sync). */
function brandSync() {
  const cfg = P.current();
  let logoPath = null;
  if (cfg.branding.logo) { try { logoPath = require('../../utils/attachments').resolveStored(cfg.branding.logo.stored); } catch { logoPath = null; } } // eslint-disable-line global-require
  return { logoPath, color: cfg.branding.color || '#1b2a4a', tagline: cfg.branding.tagline || '' };
}
/** A business unit's "from" block for a CRM invoice (crm/service.js createInvoiceForDeal), or null. */
function unitFrom(unitId) {
  if (!unitId) return null;
  const cfg = P.current();
  if (!cfg.unitsOn) return null;
  const u = cfg.units.find((x) => x.id === unitId);
  if (!u) return null;
  return Object.fromEntries(Object.entries({ name: u.name, gstin: u.gstin, address: u.address, state: u.state, email: u.email, phone: u.phone, bank: u.bank }).filter(([, v]) => v));
}

// the financial year / quarter (crm/analytics.js and crm/extra.js periodRange): null for any other period
function fiscalRange(period, at, y, m) {
  if (!['fyear', 'fquarter', 'last_fyear'].includes(period)) return null;
  const start = (P.current().fiscal.startMonth || 4) - 1; // 0-based month the year starts
  const k = (m - start + 12) % 12; // months since the year started
  if (period === 'fquarter') { const s = m - (k % 3); return { from: at(y, s), to: at(y, s + 3), prevFrom: at(y, s - 3), prevTo: at(y, s), label: 'This financial quarter', months: [0, 1, 2].map((i) => new Date(Date.UTC(y, s + i, 1)).toISOString().slice(0, 7)) }; }
  const s = m - k - (period === 'last_fyear' ? 12 : 0);
  const fyStart = new Date(Date.UTC(y, s, 1)).getUTCFullYear();
  const label = start === 0 ? `${period === 'last_fyear' ? 'Last' : 'This'} year ${fyStart}` : `${period === 'last_fyear' ? 'Last' : 'This'} financial year ${fyStart}-${String(fyStart + 1).slice(2)}`;
  return { from: at(y, s), to: at(y, s + 12), prevFrom: at(y, s - 12), prevTo: at(y, s), label, months: Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(y, s + i, 1)).toISOString().slice(0, 7)) };
}

// ---- the configuration package (17.07) ---------------------------------------------------------------------------------------------
const SAFE_SETTINGS = ['sources', 'lostReasons', 'stageProbability', 'staleDays', 'proposalValidityDays', 'discountApprovalLimit', 'invoiceTaxPercent', 'invoiceDueDays', 'invoiceSac', 'invoiceNumberFormat', 'overdueInvoiceAlert', 'lostRecheck', 'bookingHours', 'leadStages', 'defaultRemindBefore', 'overdueAlertManagers', 'autoFirstFollowUp'];
async function packageOut(user) {
  if (!mayAdmin(user)) return NO();
  const st = await SETTINGS.load();
  const cfg = await P.config({ fresh: true });
  const pkg = {
    kind: 'teamlink-crm-config', version: 1, madeAt: P.nowIso(), madeBy: user.name || null,
    settings: Object.fromEntries(SAFE_SETTINGS.map((k) => [k, st[k]])),
    plus: { ...cfg, capture: { on: cfg.capture.on, pull: cfg.capture.pull, pullMinutes: cfg.capture.pullMinutes }, branding: { color: cfg.branding.color, tagline: cfg.branding.tagline }, retention: { ...cfg.retention, on: false, lastRunAt: null, lastResult: null } },
    fields: (await P.all('SELECT * FROM "CrmFieldDef"')).map(({ createdById, ...x }) => x), // eslint-disable-line no-unused-vars
    rules: (await P.all('SELECT * FROM "CrmValidationRule"')).map(({ createdById, ...x }) => x), // eslint-disable-line no-unused-vars
    objects: (await P.all('SELECT * FROM "CrmObjectDef"')).map(({ createdById, ...x }) => x), // eslint-disable-line no-unused-vars
    leadRules: (await P.all('SELECT * FROM "CrmAssignRule"')).map(({ lastOwnerId, hits, ...x }) => x), // eslint-disable-line no-unused-vars
  };
  await S.audit(user, 'CRM configuration downloaded', 'AppSetting', 'crm.plus', `${pkg.fields.length} fields, ${pkg.rules.length} rules, ${pkg.objects.length} record types`);
  return { status: 200, json: JSON.stringify(pkg, null, 2), name: `crm-configuration-${S.istToday()}.json` };
}
async function packageIn(user, body = {}) {
  if (!mayAdmin(user)) return NO();
  const pkg = body.package;
  if (!pkg || pkg.kind !== 'teamlink-crm-config') return S.fail(400, 'This is not a CRM configuration file.');
  const plan = { settings: [], fields: { add: 0, change: 0 }, rules: { add: 0, change: 0 }, objects: { add: 0, change: 0 }, leadRules: { add: 0, change: 0 } };
  const st = await SETTINGS.load();
  const nextSettings = {};
  SAFE_SETTINGS.forEach((k) => { if (pkg.settings && k in pkg.settings && JSON.stringify(pkg.settings[k]) !== JSON.stringify(st[k])) { plan.settings.push(k); nextSettings[k] = pkg.settings[k]; } });
  const upsertPlan = async (table, list, keyCols, bucket) => {
    for (const x of Array.isArray(list) ? list : []) {
      const where = keyCols.map((c) => `"${c}" = ?`).join(' AND ');
      const was = await P.one(`SELECT "id" FROM "${table}" WHERE ${where}`, ...keyCols.map((c) => x[c])); // eslint-disable-line no-await-in-loop
      if (was) plan[bucket].change += 1; else plan[bucket].add += 1;
    }
  };
  await upsertPlan('CrmFieldDef', pkg.fields, ['kind', 'key'], 'fields');
  await upsertPlan('CrmValidationRule', pkg.rules, ['id'], 'rules');
  await upsertPlan('CrmObjectDef', pkg.objects, ['key'], 'objects');
  await upsertPlan('CrmAssignRule', pkg.leadRules, ['id'], 'leadRules');
  if (body.dryRun !== false) return S.okBody({ ok: true, dryRun: true, plan, from: { madeAt: pkg.madeAt, madeBy: pkg.madeBy } });
  if (Object.keys(nextSettings).length) await SETTINGS.save(nextSettings);
  if (pkg.plus) { const { capture, ...rest } = pkg.plus; const cfg = await P.config({ fresh: true }); await P.saveConfig({ ...rest, capture: { ...cfg.capture, on: (capture && capture.on) || cfg.capture.on, pull: (capture && capture.pull) || cfg.capture.pull }, branding: { ...cfg.branding, ...(rest.branding || {}), logo: cfg.branding.logo } }); }
  const team = new Set((await S.ownerOptions()).map((o) => o.id));
  const put = async (table, list, keyCols, clean = (x) => x) => {
    const cols = new Set((await P.all(`PRAGMA table_info("${table}")`)).map((c) => c.name));
    for (const raw of Array.isArray(list) ? list : []) {
      const x = Object.fromEntries(Object.entries(clean(raw)).filter(([k]) => cols.has(k)));
      const where = keyCols.map((c) => `"${c}" = ?`).join(' AND ');
      /* eslint-disable no-await-in-loop */
      const was = await P.one(`SELECT "id" FROM "${table}" WHERE ${where}`, ...keyCols.map((c) => x[c]));
      if (was) { const set = Object.keys(x).filter((k) => k !== 'id' && !keyCols.includes(k)); if (set.length) await P.run(`UPDATE "${table}" SET ${set.map((k) => `"${k}" = ?`).join(', ')} WHERE "id" = ?`, ...set.map((k) => x[k]), was.id); } else { const k = Object.keys(x); await P.run(`INSERT INTO "${table}" (${k.map((c) => `"${c}"`).join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, ...k.map((c) => x[c])); }
      /* eslint-enable no-await-in-loop */
    }
  };
  await put('CrmFieldDef', pkg.fields, ['kind', 'key'], (x) => ({ ...x, id: x.id || P.newId('cfd') }));
  await put('CrmValidationRule', pkg.rules, ['id']);
  await put('CrmObjectDef', pkg.objects, ['key'], (x) => ({ ...x, id: x.id || P.newId('obj') }));
  // a lead rule keeps only the people who are on THIS server's sales team
  await put('CrmAssignRule', pkg.leadRules, ['id'], (x) => ({ ...x, ownerIdsJson: JSON.stringify(P.parse(x.ownerIdsJson, []).filter((id) => team.has(id))) }));
  await S.audit(user, 'CRM configuration loaded', 'AppSetting', 'crm.plus', JSON.stringify(plan).slice(0, 300));
  return S.okBody({ ok: true, applied: true, plan });
}

// ---- adoption (17.12) ------------------------------------------------------------------------------------------------------------------
// every CRM request (routes/crm.js): one row a person a day - opens (the CRM's first read, /me), reads, changes
async function track(user, { method, path } = {}) {
  if (!user || !user.id) return;
  const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const now = P.nowIso();
  const open = path === '/me' ? 1 : 0; const change = method && method !== 'GET' ? 1 : 0;
  await P.run(`INSERT INTO "CrmUsage" ("userId", "day", "userName", "opens", "reads", "changes", "firstAt", "lastAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT("userId", "day") DO UPDATE SET "opens" = "opens" + excluded."opens", "reads" = "reads" + excluded."reads", "changes" = "changes" + excluded."changes", "lastAt" = excluded."lastAt", "userName" = COALESCE(excluded."userName", "userName")`, user.id, day, user.name || null, open, change ? 0 : 1, change, now, now);
}
async function adoption(user, { days } = {}) {
  const r = S.roleOf(user);
  if (!S.can(user, 'reports') || !S.seesAll(r)) return S.fail(403, 'The adoption report is for Sales managers and Admins.');
  const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const sinceDay = new Date(Date.now() + 5.5 * 3600000 - (n - 1) * 86400000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - n * 86400000).toISOString();
  const st = await SETTINGS.load();
  const usage = await P.all('SELECT "userId", MAX("userName") AS "name", COUNT(*) AS "days", SUM("opens") AS "opens", SUM("changes") AS "changes", SUM("reads") AS "reads", MAX("lastAt") AS "lastAt" FROM "CrmUsage" WHERE "day" >= ? GROUP BY "userId"', sinceDay);
  const ever = await P.all('SELECT "userId", MAX("lastAt") AS "lastAt" FROM "CrmUsage" GROUP BY "userId"');
  const per = async (sql, ...a) => new Map((await P.all(sql, ...a)).map((x) => [x.id, Number(x.n) || 0]));
  const added = await per(`SELECT "createdById" AS "id", COUNT(*) AS "n" FROM (SELECT "createdById" FROM "CrmLead" WHERE "createdAt" >= ? UNION ALL SELECT "createdById" FROM "CrmAccount" WHERE "createdAt" >= ? UNION ALL SELECT "createdById" FROM "CrmDeal" WHERE "createdAt" >= ? UNION ALL SELECT "createdById" FROM "CrmContact" WHERE "createdAt" >= ?) GROUP BY "createdById"`, since, since, since, since);
  const logged = await per('SELECT "byId" AS "id", COUNT(*) AS "n" FROM "CrmActivity" WHERE "at" >= ? AND "byId" IS NOT NULL AND COALESCE("subject", \'\') NOT LIKE \'Stage:%\' GROUP BY "byId"', since);
  const done = await per('SELECT "ownerId" AS "id", COUNT(*) AS "n" FROM "CrmTask" WHERE "status" = \'Done\' AND "doneAt" >= ? GROUP BY "ownerId"', since);
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const late = await per('SELECT "ownerId" AS "id", COUNT(*) AS "n" FROM "CrmTask" WHERE "status" = \'Open\' AND "dueDate" < ? GROUP BY "ownerId"', today);
  const exports = await per('SELECT "byId" AS "id", COUNT(*) AS "n" FROM "CrmExportLog" WHERE "at" >= ? GROUP BY "byId"', since);
  const people = new Map();
  st.salesTeam.forEach((m) => people.set(m.userId, { userId: m.userId, name: m.name, role: m.role }));
  usage.forEach((u) => { if (!people.has(u.userId)) people.set(u.userId, { userId: u.userId, name: u.name, role: 'admin' }); });
  const everMap = new Map(ever.map((e) => [e.userId, e.lastAt]));
  const uMap = new Map(usage.map((u) => [u.userId, u]));
  const rows = [...people.values()].map((p) => {
    const u = uMap.get(p.userId) || {};
    const daysActive = Number(u.days) || 0;
    const last = everMap.get(p.userId) || null;
    const quietDays = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    const work = (added.get(p.userId) || 0) + (logged.get(p.userId) || 0) + (done.get(p.userId) || 0);
    // a plain 0-100: days used (half), work logged (a third), no late follow-ups (the rest)
    const score = Math.round(Math.min(1, daysActive / Math.min(n, 22)) * 50 + Math.min(1, work / (n * 2)) * 35 + (late.get(p.userId) ? Math.max(0, 15 - late.get(p.userId)) : 15));
    return { ...p, daysActive, opens: Number(u.opens) || 0, changes: Number(u.changes) || 0, recordsAdded: added.get(p.userId) || 0, activitiesLogged: logged.get(p.userId) || 0, followUpsDone: done.get(p.userId) || 0, followUpsLate: late.get(p.userId) || 0, downloads: exports.get(p.userId) || 0, lastSeen: last, quietDays, score: Math.max(0, Math.min(100, score)), notUsing: quietDays == null || quietDays >= 7 };
  }).sort((a, b) => b.score - a.score);
  const daily = await P.all('SELECT "day", COUNT(*) AS "users", SUM("changes") AS "changes" FROM "CrmUsage" WHERE "day" >= ? GROUP BY "day" ORDER BY "day"', sinceDay);
  const team = rows.length;
  const active = rows.filter((x) => x.daysActive > 0).length;
  return S.okBody({ days: n, rows, daily: daily.map((d) => ({ day: d.day, users: Number(d.users) || 0, changes: Number(d.changes) || 0 })), summary: { team, active, activePercent: team ? Math.round((active / team) * 100) : 0, notUsing: rows.filter((x) => x.notUsing).length } });
}

module.exports = { prefsGet, prefsSave, uploadLogo, logoFile, brandSync, unitFrom, fiscalRange, packageOut, packageIn, track, adoption };

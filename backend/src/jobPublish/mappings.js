// ---------------------------------------------------------------------------
// PORTAL MAPPINGS (PortalMapping): the ATS value -> the word / code the portal's own form uses.
//
//   ensureDefaults()     seeds src/jobPublish/defaultMappings.js (idempotent: a row that exists is never overwritten,
//                        so an Admin's edit survives). The migration also seeds them; this covers a database that was
//                        migrated before the seed changed.
//   list(portal?)        the table
//   upsertMany(rows,u)   the Admin edits (PUT /api/job-publish/mappings): origin becomes 'admin'
//   forPortal(portal)    a lookup object for ONE run: map.employmentType('Full Time') ...
//
// A value with no mapping is not an error: the ATS value is sent as it is, the run logs "no mapping", and the DRY RUN
// screenshot shows whether the portal took it.
// ---------------------------------------------------------------------------
const { logAudit } = require('../utils/audit');
const { q, q1, ex, iso, newId } = require('./db');
const D = require('./defaultMappings');
const C = require('./constants');

const FIELDS = ['employmentType', 'workMode', 'experience', 'salary', 'location', 'industry', 'functionalArea'];

async function ensureDefaults() {
  const now = Date.now();
  let added = 0;
  for (const r of D.rows()) {
    // eslint-disable-next-line no-await-in-loop
    const n = await ex(
      'INSERT OR IGNORE INTO "PortalMapping" ("id","portal","field","atsValue","portalValue","portalCode","sortOrder","active","origin","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,1,\'default\',?,?)',
      D.idOf(r), r.portal, r.field, r.atsValue, r.portalValue, r.portalCode, r.sortOrder, now, now,
    );
    added += n || 0;
  }
  return added;
}

const view = (r) => ({
  id: r.id, portal: r.portal, field: r.field, atsValue: r.atsValue, portalValue: r.portalValue, portalCode: r.portalCode || null,
  sortOrder: r.sortOrder, active: !!r.active, origin: r.origin, updatedAt: iso(r.updatedAt),
});

async function list({ portal = null, field = null } = {}) {
  const where = []; const p = [];
  if (portal) { where.push('"portal" = ?'); p.push(portal); }
  if (field) { where.push('"field" = ?'); p.push(field); }
  const rows = await q(`SELECT * FROM "PortalMapping" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY "portal","field","sortOrder","atsValue"`, ...p);
  return rows.map(view);
}

// rows: [{ portal, field, atsValue, portalValue, portalCode?, active?, delete? }]
async function upsertMany(rows, user) {
  if (!Array.isArray(rows) || !rows.length) return { error: 'Send the rows to save.', status: 400 };
  if (rows.length > 500) return { error: 'Send at most 500 rows at a time.', status: 400 };
  const clean = [];
  for (const r of rows) {
    const portal = String(r.portal || '');
    const field = String(r.field || '');
    const atsValue = String(r.atsValue == null ? '' : r.atsValue).trim();
    if (!C.PORTALS[portal] || C.PORTALS[portal].kind === 'internal') return { error: `Unknown portal "${portal}".`, status: 400 };
    if (!FIELDS.includes(field)) return { error: `Unknown field "${field}". Use one of: ${FIELDS.join(', ')}.`, status: 400 };
    if (!atsValue) return { error: 'Every row needs the ATS value.', status: 400 };
    const portalValue = String(r.portalValue == null ? '' : r.portalValue).trim();
    if (!r.delete && !portalValue) return { error: `Row ${field} / ${atsValue}: write what the portal calls it.`, status: 400 };
    clean.push({
      portal, field, atsValue, portalValue: portalValue.slice(0, 200), portalCode: r.portalCode == null || r.portalCode === '' ? null : String(r.portalCode).slice(0, 80),
      active: r.active === undefined ? true : !!r.active, del: !!r.delete,
    });
  }
  const now = Date.now();
  let saved = 0; let removed = 0;
  for (const r of clean) {
    if (r.del) {
      // eslint-disable-next-line no-await-in-loop
      removed += (await ex('DELETE FROM "PortalMapping" WHERE "portal" = ? AND "field" = ? AND "atsValue" = ?', r.portal, r.field, r.atsValue)) || 0;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await ex(
        `INSERT INTO "PortalMapping" ("id","portal","field","atsValue","portalValue","portalCode","sortOrder","active","origin","createdBy","updatedBy","createdAt","updatedAt")
         VALUES (?,?,?,?,?,?,0,?,'admin',?,?,?,?)
         ON CONFLICT("portal","field","atsValue") DO UPDATE SET "portalValue" = excluded."portalValue", "portalCode" = excluded."portalCode", "active" = excluded."active", "origin" = 'admin', "updatedBy" = excluded."updatedBy", "updatedAt" = excluded."updatedAt"`,
        newId('pm'), r.portal, r.field, r.atsValue, r.portalValue, r.portalCode, r.active ? 1 : 0, user ? user.id : null, user ? user.id : null, now, now,
      );
      saved += 1;
    }
  }
  const portals = [...new Set(clean.map((r) => r.portal))].map(C.portalName).join(', ');
  await logAudit({
    userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Portal mapping changed', entity: 'PortalMapping', entityId: clean[0].portal,
    fromValue: portals, toValue: `${saved} saved, ${removed} removed`,
  });
  return { ok: true, saved, removed };
}

const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

// "5-8", "2-6 yrs", "5", "5+ years" -> { min, max }
function parseRange(text) {
  const t = String(text == null ? '' : text);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const one = t.match(/(\d+(?:\.\d+)?)/);
  if (one) return { min: Number(one[1]), max: /\+|above|plus|more/i.test(t) ? null : Number(one[1]) };
  return { min: null, max: null };
}
// "₹14L - ₹20L", "8-12 LPA", "14,00,000 - 20,00,000" -> { min, max } in LAKHS
function parseSalaryLakhs(text) {
  const t = String(text == null ? '' : text);
  const toLakh = (raw, unit) => {
    const n = num(raw);
    if (n == null) return null;
    if (/cr/i.test(unit || '')) return n * 100;
    if (/l|lac|lakh|lpa/i.test(unit || '')) return n;
    if (n >= 100000) return n / 100000;
    return n; // a bare small number is read as lakhs
  };
  const m = t.match(/([\d,.]+)\s*(l(?:pa|akhs?|acs?)?|cr(?:ores?)?)?\s*(?:-|to|–)\s*(?:₹|rs\.?\s*)?([\d,.]+)\s*(l(?:pa|akhs?|acs?)?|cr(?:ores?)?)?/i);
  if (m) return { min: toLakh(m[1], m[2] || m[4]), max: toLakh(m[3], m[4] || m[2]) };
  const one = t.match(/([\d,.]+)\s*(l(?:pa|akhs?|acs?)?|cr(?:ores?)?)?/i);
  if (one && /\d/.test(one[1])) { const v = toLakh(one[1], one[2]); return { min: v, max: v }; }
  return { min: null, max: null };
}

// A lookup for ONE run. `rows` = every active mapping of the portal (loaded once).
async function forPortal(portal) {
  const rows = (await q('SELECT * FROM "PortalMapping" WHERE "portal" = ? AND "active" = 1 ORDER BY "sortOrder"', portal)).map(view);
  const of = (field) => rows.filter((r) => r.field === field);
  const exact = (field, v) => of(field).find((r) => r.atsValue.toLowerCase() === String(v == null ? '' : v).trim().toLowerCase()) || null;
  const out = (row, fallback) => ({ value: row ? row.portalValue : fallback, code: row ? row.portalCode : null, matched: !!row });
  const band = (field, range) => {
    const bands = of(field).map((r) => ({ r, ...parseRange(r.atsValue) })).filter((b) => b.min != null);
    if (!bands.length || range.min == null) return null;
    const mid = (range.min + (range.max == null ? range.min : range.max)) / 2;
    const hit = bands.find((b) => mid >= b.min && (b.max == null || mid < b.max)) || bands.slice().sort((a, b) => Math.abs((a.min + (a.max || a.min)) / 2 - mid) - Math.abs((b.min + (b.max || b.min)) / 2 - mid))[0];
    return hit ? hit.r : null;
  };
  return {
    portal,
    employmentType: (v) => out(exact('employmentType', v), v),
    workMode: (v) => out(exact('workMode', v), v),
    industry: (v) => out(exact('industry', v), v),
    functionalArea: (v) => out(exact('functionalArea', v), v),
    experience: (text) => { const r = parseRange(text); return { ...out(band('experience', r), text), min: r.min, max: r.max }; },
    salary: (text) => { const r = parseSalaryLakhs(text); return { ...out(band('salary', r), text), minLakhs: r.min, maxLakhs: r.max }; },
    location: (text) => {
      const cities = require('../utils/locationMatch').citiesOf(text); // eslint-disable-line global-require
      const first = cities[0];
      const row = first ? exact('location', first.label) : null;
      return { ...out(row, first ? first.label : String(text || '').trim()), city: first ? first.label : null };
    },
  };
}

module.exports = {
  FIELDS, ensureDefaults, list, upsertMany, forPortal, parseRange, parseSalaryLakhs, q1,
};

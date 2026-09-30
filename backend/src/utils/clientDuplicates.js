// ---------------------------------------------------------------------------
// Client duplicate protection (ATS review #2, spec point 8).
//
// "Before creating a client: Possible duplicate found … [View Existing]
// [Create Anyway]. Never auto-merge on similar names only; use GSTIN, PAN,
// legal name, phone/email, address."
//
// This module only FINDS likely existing clients and says why. It never merges,
// never edits and never deletes. The name normalisation is the SAME one the
// merge tool uses (utils/clientDedupe.js) and ClientAlias.aliasKey is stored
// with it, so a spelling that was merged away is recognised when somebody
// types it again.
//
// Strength:
//   exact    — same GSTIN or same PAN (a legal identity; POST/PUT refuse it
//              without an explicit override)
//   strong   — same name / legal name, a merged-away spelling, same phone,
//              same contact email (POST/PUT refuse a same-name / alias match
//              without an override; phone / email only warn)
//   possible — near-typo name, same name apart from a branch/place tail,
//              same company email domain, same address
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  fullKey, baseKey, coreKey, osa, thr, dig,
} = require('./clientDedupe');

const RANK = { exact: 3, strong: 2, possible: 1 };
// The codes a create / identity edit is refused on unless overridden.
const BLOCKING = new Set(['GSTIN', 'PAN', 'PAN_IN_GSTIN', 'NAME', 'LEGAL_NAME', 'ALIAS']);

const up = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const normGstin = (v) => { const g = up(v); return g.length >= 10 ? g : null; };
const normPan = (v) => { const p = up(v); return p.length === 10 ? p : null; };
// Characters 3-12 of a GSTIN are the holder's PAN.
const panOfGstin = (g) => { const n = up(g); return n.length === 15 ? n.slice(2, 12) : null; };
// Placeholder numbers that the source sheets used for "no number".
const DUMMY_PHONE = new Set(['1234567890', '9876543210', '0123456789', '9999999999', '0000000000']);
const phoneKey = (v) => {
  const raw = String(v || '').replace(/\D/g, '');
  if (raw.length < 10) return null;
  const d = dig(v);
  if (!d || DUMMY_PHONE.has(d) || /^(\d)\1{9}$/.test(d)) return null;
  return d;
};
const emailKey = (v) => { const e = String(v || '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; };
const FREE_MAIL = /(^|\.)(gmail|googlemail|yahoo|ymail|rediffmail|rediff|hotmail|outlook|live|icloud|protonmail|aol|zoho)\./;
const domainOf = (e) => { const k = emailKey(e); if (!k) return null; const d = k.split('@')[1]; return FREE_MAIL.test(`.${d}`) ? null : d; };
const addrToks = (c) => new Set(String([c.houseNumber, c.street, c.area].filter(Boolean).join(' ')).toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter((t) => t.length > 2 && !['road', 'street', 'near', 'opp', 'the', 'and', 'main', 'cross', 'floor'].includes(t)));
const pinOf = (c) => { const p = String(c.pincode || '').replace(/\D/g, ''); return p.length === 6 ? p : null; };

const PHONE_FIELDS = [
  ['contactPhone', 'primary contact'], ['contactWhatsApp', 'primary WhatsApp'], ['secondaryContactPhone', 'secondary contact'],
  ['billingContactPhone', 'billing contact'], ['recruitmentContactPhone', 'recruitment contact'], ['landline', 'landline'],
];
const EMAIL_FIELDS = [
  ['contactEmail', 'primary contact'], ['secondaryContactEmail', 'secondary contact'],
  ['billingContactEmail', 'billing contact'], ['recruitmentContactEmail', 'recruitment contact'],
];

const SELECT = {
  id: true, name: true, legalName: true, clientCode: true, location: true, state: true, industry: true,
  gst: true, pan: true, agreementStatus: true, ownerDepartment: true, clientType: true,
  contactName: true, contactPhone: true, contactWhatsApp: true, contactEmail: true, landline: true,
  secondaryContactPhone: true, secondaryContactEmail: true, billingContactPhone: true, billingContactEmail: true,
  recruitmentContactPhone: true, recruitmentContactEmail: true,
  houseNumber: true, street: true, area: true, pincode: true,
};

// Display-only Client ID. The stored clientCode wins; otherwise a code derived
// deterministically from the record id (never stored, never changes).
const displayCode = (c) => (c && (c.clientCode || (c.id ? `CL-${String(c.id).slice(-6).toUpperCase()}` : null))) || null;

// The merge tool's own "typo" rule (computeGroups): same first two letters, an
// edit distance within the length-scaled threshold, on the head name AND on the
// name with the generic words taken out.
function nearTypo(a, b) {
  const ab = baseKey(a); const bb = baseKey(b);
  if (!ab || !bb || ab === bb) return false;
  const t = thr(Math.min(ab.length, bb.length));
  if (!t || ab.slice(0, 2) !== bb.slice(0, 2) || osa(ab, bb) > t) return false;
  const ac = coreKey(a); const bc = coreKey(b);
  if (!ac || !bc) return false;
  if (ac === bc) return true;
  const tc = thr(Math.min(ac.length, bc.length));
  return !!tc && ac.slice(0, 2) === bc.slice(0, 2) && osa(ac, bc) <= tc;
}

/**
 * Find existing clients that look like the one described by `input`.
 * input: { name, legalName, gst, pan, contactPhone, contactEmail, …phones/emails, houseNumber, street, area, pincode }
 * opts.excludeId: the client being edited (never matches itself).
 */
async function findClientDuplicates(input = {}, { excludeId = null, db = prisma, limit = 8 } = {}) {
  const [clients, aliases] = await Promise.all([
    db.client.findMany({ select: SELECT }),
    db.clientAlias.findMany({ select: { clientId: true, alias: true, aliasKey: true } }),
  ]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const hits = new Map(); // clientId -> Map(code -> reason)
  const add = (id, code, strength, label) => {
    if (!id || id === excludeId || !byId.has(id)) return;
    if (!hits.has(id)) hits.set(id, new Map());
    const m = hits.get(id);
    if (!m.has(code) || RANK[m.get(code).strength] < RANK[strength]) m.set(code, { code, strength, label });
  };

  // --- Legal identity -----------------------------------------------------
  const gst = normGstin(input.gst);
  const pan = normPan(input.pan);
  const panFromGst = panOfGstin(input.gst);
  // --- Names ----------------------------------------------------------------
  const names = [['name', input.name], ['legalName', input.legalName]]
    .map(([f, v]) => [f, String(v || '').trim()]).filter(([, v]) => v && fullKey(v).length >= 3);
  // --- Contact -----------------------------------------------------------
  const phones = new Map(); // key -> label of the field it was typed in
  PHONE_FIELDS.forEach(([f]) => { const k = phoneKey(input[f]); if (k && !phones.has(k)) phones.set(k, f); });
  const emails = new Set(EMAIL_FIELDS.map(([f]) => emailKey(input[f])).filter(Boolean));
  const domains = new Set(EMAIL_FIELDS.map(([f]) => domainOf(input[f])).filter(Boolean));
  const pin = pinOf(input);
  const addr = addrToks(input);

  clients.forEach((c) => {
    if (c.id === excludeId) return;
    // GSTIN / PAN
    const cg = normGstin(c.gst);
    if (gst && cg && cg === gst) add(c.id, 'GSTIN', 'exact', `Same GSTIN (${cg})`);
    const cp = normPan(c.pan);
    const cpg = panOfGstin(c.gst);
    if (pan && cp && cp === pan) add(c.id, 'PAN', 'exact', `Same PAN (${cp})`);
    else if (pan && cpg && cpg === pan) add(c.id, 'PAN_IN_GSTIN', 'exact', `PAN ${pan} is inside this client's GSTIN`);
    else if (panFromGst && cp && cp === panFromGst) add(c.id, 'PAN_IN_GSTIN', 'exact', `The GSTIN entered carries this client's PAN (${cp})`);
    else if (panFromGst && cpg && cpg === panFromGst && !(gst && cg === gst)) {
      add(c.id, 'PAN_IN_GSTIN', 'exact', `Same PAN inside the GSTIN (another state registration of ${cpg})`);
    }

    // Names — exact normalised key, then branch tail, then near-typo.
    names.forEach(([field, v]) => {
      const k = fullKey(v);
      [['name', c.name], ['legalName', c.legalName]].forEach(([cf, cv]) => {
        if (!cv) return;
        const ck = fullKey(cv);
        const label = cf === 'legalName' ? 'legal name' : 'name';
        if (ck && ck === k) {
          add(c.id, cf === 'legalName' || field === 'legalName' ? 'LEGAL_NAME' : 'NAME', 'strong',
            `Same ${label} ("${cv}")`);
        } else if (baseKey(v).length >= 4 && baseKey(v) === baseKey(cv)) {
          add(c.id, 'NAME_BRANCH', 'possible', `Same ${label} apart from the branch / place ("${cv}")`);
        } else if (nearTypo(v, cv)) {
          add(c.id, 'NAME_TYPO', 'possible', `Similar ${label} — possible spelling variant of "${cv}"`);
        }
      });
    });

    // Phones / emails / domain / address.
    PHONE_FIELDS.forEach(([f, lbl]) => {
      const k = phoneKey(c[f]);
      if (k && phones.has(k)) add(c.id, 'PHONE', 'strong', `Same phone ${k} (their ${lbl})`);
    });
    EMAIL_FIELDS.forEach(([f, lbl]) => {
      const k = emailKey(c[f]);
      if (k && emails.has(k)) add(c.id, 'EMAIL', 'strong', `Same email ${k} (their ${lbl})`);
      const d = domainOf(c[f]);
      if (d && domains.has(d) && !(k && emails.has(k))) add(c.id, 'DOMAIN', 'possible', `Same company email domain (@${d})`);
    });
    if (pin && pinOf(c) === pin && addr.size) {
      const ct = addrToks(c);
      const shared = [...addr].filter((t) => ct.has(t));
      if (shared.length >= Math.min(2, addr.size)) add(c.id, 'ADDRESS', 'possible', `Same address (PIN ${pin})`);
    }
  });

  // Merged-away spellings: ClientAlias.aliasKey is fullKey() of the old name.
  names.forEach(([, v]) => {
    const k = fullKey(v);
    aliases.forEach((a) => {
      if (a.aliasKey === k) {
        add(a.clientId, 'ALIAS', 'strong', `Same name as merged spelling "${a.alias}"`);
      } else if (nearTypo(v, a.alias)) {
        add(a.clientId, 'ALIAS_TYPO', 'possible', `Similar to merged spelling "${a.alias}"`);
      }
    });
  });

  const matches = [...hits.entries()].map(([id, m]) => {
    const c = byId.get(id);
    const reasons = [...m.values()].sort((a, b) => RANK[b.strength] - RANK[a.strength]);
    const strength = reasons[0].strength;
    return {
      id: c.id,
      name: c.name,
      displayCode: displayCode(c),
      legalName: c.legalName,
      location: [c.location, c.state].filter(Boolean).join(', ') || null,
      industry: c.industry,
      gst: c.gst,
      pan: c.pan,
      contactName: c.contactName,
      contactPhone: c.contactPhone,
      contactEmail: c.contactEmail,
      agreementStatus: c.agreementStatus,
      ownerDepartment: c.ownerDepartment,
      strength,
      blocking: reasons.some((r) => BLOCKING.has(r.code)),
      reasons,
      score: reasons.reduce((s, r) => s + RANK[r.strength], 0),
    };
  }).sort((a, b) => RANK[b.strength] - RANK[a.strength] || b.score - a.score || a.name.localeCompare(b.name));

  return {
    matches: matches.slice(0, limit),
    total: matches.length,
    blocking: matches.some((x) => x.blocking),
  };
}

// One line for the audit trail: "Orbit Pvt Ltd (CL-ABC123): Same GSTIN; Same phone".
function describeMatches(matches, max = 3) {
  return (matches || []).slice(0, max)
    .map((m) => `${m.name} (${m.displayCode}): ${m.reasons.map((r) => r.label).join('; ')}`)
    .join(' | ');
}

module.exports = {
  findClientDuplicates, describeMatches, displayCode, normGstin, normPan, BLOCKING,
};

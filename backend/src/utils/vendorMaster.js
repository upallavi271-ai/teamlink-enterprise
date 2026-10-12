// ---------------------------------------------------------------------------
// THE VENDOR MASTER — one record, one set of rules (2026-10-09).
//
// Admin → Vendor logins → Vendors and Office & Accounts → Add Vendor both call
// createVendor() / updateVendor() here, so a vendor added in either place is
// the same OfficeVendor row with the same checks.
//
//   * DUPLICATES. Blocking (HTTP 409, names the existing record): same GSTIN
//     (any letter case / spaces), same PAN, same email (trimmed, lower-case),
//     same name (case-insensitive, extra spaces ignored). A WEAKER signal —
//     the same phone number, or the same name apart from "Pvt Ltd / LLP …" —
//     is only a warning: the caller repeats the save with confirmDuplicate:true.
//   * SOFT DELETE ONLY. A vendor is switched off (isActive=false + who / when /
//     why), never removed. A switched-off vendor cannot get new bills and its
//     logins are signed out (routes/vendorLogins.js does that for the master
//     switch; setVendorActive() here does the same).
//   * SNAPSHOT. A bill keeps the vendor's name / GSTIN / PAN / address AS THEY
//     WERE when it was booked (vendorSnapshot()); editing the master later does
//     not rewrite old bills.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  checkGstin, isPan, clean: cleanId,
} = require('./gstin');

const TEXT = {
  companyName: ['Company name', 160],
  contactPerson: ['Contact person', 120],
  phone: ['Phone', 30],
  email: ['Email', 160],
  address: ['Address', 500],
  category: ['Category', 60],
  paymentTerms: ['Payment terms', 200],
  notes: ['Notes', 1000],
};
const EDITABLE = ['name', 'gstin', 'pan', ...Object.keys(TEXT)];

const squash = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (v) => squash(v).toLowerCase();
// "Sri Sai Traders Pvt. Ltd." and "Sri Sai Traders" are the same company for a warning.
const coreKey = (v) => squash(v).toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|corporation|corp|the)\b\.?/g, ' ').replace(/[^a-z0-9]/g, '');
const gstinKeyOf = (v) => { const g = cleanId(v || ''); return g || null; };
const panKeyOf = (v) => { const p = cleanId(v || ''); return p || null; };
const emailKeyOf = (v) => { const e = String(v ?? '').trim().toLowerCase(); return e || null; };
const phoneKeyOf = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length < 7) return null;
  return d.slice(-10); // +91 98480 12345 and 9848012345 are the same number
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ');

// Reads + checks a request body. `partial` (an edit) only checks the fields sent.
// Returns { data } (clean values + the key columns) or { status, error, field }.
function readVendor(body, { partial = false } = {}) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  const data = {};
  if (!partial || has('name')) {
    const name = squash(strip(b.name));
    if (!name) return { status: 400, error: 'Vendor name is required', field: 'name' };
    if (name.length > 120) return { status: 400, error: 'Keep the vendor name under 120 characters', field: 'name' };
    data.name = name;
  }
  for (const [k, [label, max]] of Object.entries(TEXT)) {
    if (partial && !has(k)) continue; // eslint-disable-line no-continue
    const v = squash(strip(b[k]));
    if (v.length > max) return { status: 400, error: `${label} must be ${max} characters or fewer`, field: k };
    data[k] = v || null;
  }
  if (data.email && !EMAIL_RE.test(data.email)) return { status: 400, error: 'Enter a valid email address', field: 'email' };
  if (data.phone) {
    const digits = data.phone.replace(/\D/g, '');
    if (!(/^[+()\d\s-]+$/.test(data.phone) && digits.length >= 6 && digits.length <= 15)) {
      return { status: 400, error: 'Enter a valid phone number (6 to 15 digits)', field: 'phone' };
    }
  }
  if (!partial || has('gstin')) {
    const g = cleanId(b.gstin || '');
    if (g) {
      const c = checkGstin(g);
      if (!c.ok) return { status: 400, error: `GST / Tax ID: ${c.error}`, field: 'gstin' };
    }
    data.gstin = g || null;
  }
  if (!partial || has('pan')) {
    const p = cleanId(b.pan || '');
    if (p && !isPan(p)) return { status: 400, error: 'PAN must be 10 characters like ABCDE1234F', field: 'pan' };
    data.pan = p || null;
  }
  // A GSTIN carries its holder's PAN in characters 3-12: when both are given they must agree.
  if (data.gstin && data.pan && data.gstin.slice(2, 12) !== data.pan) {
    return { status: 400, error: 'The PAN does not match the GSTIN (a GSTIN contains its holder\'s PAN)', field: 'pan' };
  }
  if (has('gstin') || !partial) data.gstinKey = gstinKeyOf(data.gstin);
  if (has('pan') || !partial) data.panKey = panKeyOf(data.pan);
  if (has('email') || !partial) data.emailKey = emailKeyOf(data.email);
  if (has('phone') || !partial) data.phoneKey = phoneKeyOf(data.phone);
  return { data };
}

const SELECT = { id: true, vendorCode: true, name: true, gstin: true, pan: true, email: true, phone: true, isActive: true };
const brief = (v) => ({ id: v.id, vendorCode: v.vendorCode || null, name: v.name, isActive: v.isActive !== false });
const labelOf = (v) => `"${v.name}"${v.vendorCode ? ` (${v.vendorCode})` : ''}${v.isActive === false ? ' — switched off' : ''}`;

// Looks for an existing vendor that clashes with `data` (as returned by
// readVendor; for an edit pass the merged final values). `excludeId` skips the
// vendor being edited. { blocks:[...], warnings:[...] } — each entry names the
// existing record.
async function findDuplicates(data, { excludeId = null } = {}) {
  const blocks = [];
  const warnings = [];
  const notSelf = excludeId ? { NOT: { id: excludeId } } : {};
  const one = async (field, keyCol, key, code, text) => {
    if (!key) return;
    const hit = await prisma.officeVendor.findFirst({ where: { [keyCol]: key, ...notSelf }, select: SELECT });
    if (hit) blocks.push({ code, field, vendor: brief(hit), error: text(hit) });
  };
  await one('gstin', 'gstinKey', data.gstinKey || gstinKeyOf(data.gstin), 'GSTIN', (h) => `The GSTIN ${data.gstin} is already used by vendor ${labelOf(h)}. Open that vendor instead.`);
  await one('pan', 'panKey', data.panKey || panKeyOf(data.pan), 'PAN', (h) => `The PAN ${data.pan} is already used by vendor ${labelOf(h)}. Open that vendor instead.`);
  await one('email', 'emailKey', data.emailKey || emailKeyOf(data.email), 'EMAIL', (h) => `The email ${data.email} is already used by vendor ${labelOf(h)}. Open that vendor instead.`);
  if (data.name) {
    const all = await prisma.officeVendor.findMany({ where: notSelf, select: SELECT });
    const nk = nameKey(data.name);
    const ck = coreKey(data.name);
    const same = all.find((v) => nameKey(v.name) === nk);
    if (same) {
      blocks.push({
        code: 'NAME', field: 'name', vendor: brief(same),
        error: `A vendor named "${same.name}" already exists${same.vendorCode ? ` (${same.vendorCode})` : ''} — pick it from the Vendor list`,
      });
    } else if (ck.length >= 4) {
      const like = all.find((v) => coreKey(v.name) === ck);
      if (like) warnings.push({ code: 'NAME_SIMILAR', field: 'name', vendor: brief(like), error: `Looks like the same company as ${labelOf(like)} (same name apart from Pvt / Ltd / LLP).` });
    }
  }
  const pk = data.phoneKey || phoneKeyOf(data.phone);
  if (pk) {
    const hit = await prisma.officeVendor.findFirst({ where: { phoneKey: pk, ...notSelf }, select: SELECT });
    if (hit && !blocks.some((x) => x.vendor.id === hit.id)) {
      warnings.push({ code: 'PHONE', field: 'phone', vendor: brief(hit), error: `The phone number ${data.phone} is already on vendor ${labelOf(hit)}.` });
    }
  }
  return { blocks, warnings };
}

// The 409 body for a duplicate result, or null when there is nothing to say.
function duplicateResponse(dups, confirm) {
  if (dups.blocks.length) {
    const first = dups.blocks[0];
    return { status: 409, body: { error: first.error, field: first.field, code: 'DUPLICATE_VENDOR', blocking: true, duplicates: dups.blocks, vendor: first.vendor } };
  }
  if (dups.warnings.length && !confirm) {
    const first = dups.warnings[0];
    return {
      status: 409,
      body: {
        error: `${first.error} Is this a different vendor?`, field: first.field, code: 'POSSIBLE_DUPLICATE_VENDOR', blocking: false, warning: true, duplicates: dups.warnings, vendor: first.vendor,
      },
    };
  }
  return null;
}

// Sequential VEN-0001 code (gaps are fine; never reused).
async function nextVendorCode() {
  const rows = await prisma.officeVendor.findMany({ where: { vendorCode: { not: null } }, select: { vendorCode: true } });
  const max = rows.reduce((m, r) => { const x = /^VEN-(\d+)$/.exec(r.vendorCode || ''); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `VEN-${String(max + 1).padStart(4, '0')}`;
}

const uniqueField = (err) => {
  const t = String(err && err.meta && err.meta.target);
  if (/gstinKey/.test(t)) return ['gstin', 'That GSTIN is already used by another vendor.'];
  if (/panKey/.test(t)) return ['pan', 'That PAN is already used by another vendor.'];
  if (/emailKey/.test(t)) return ['email', 'That email is already used by another vendor.'];
  if (/name/.test(t)) return ['name', 'A vendor with that name already exists — pick it from the Vendor list'];
  return [null, 'That vendor already exists.'];
};

// Create. `actor` = { id, name } of the staff user, `source` = Office | Admin | Migration.
// Returns { row } or { status, body } (ready for res.status(status).json(body)).
async function createVendor(body, { actor, source = 'Office', confirm = false } = {}) {
  const r = readVendor(body, { partial: false });
  if (r.error) return { status: r.status, body: { error: r.error, field: r.field } };
  const dup = duplicateResponse(await findDuplicates(r.data), confirm || (body && body.confirmDuplicate === true));
  if (dup) return dup;
  for (let i = 0; i < 4; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.officeVendor.create({
        data: { ...r.data, vendorCode: await nextVendorCode(), source, createdById: actor && actor.id ? actor.id : null },
      });
      return { row };
    } catch (e) {
      if (!(e && e.code === 'P2002')) throw e;
      if (/vendorCode/.test(String(e.meta && e.meta.target))) continue; // eslint-disable-line no-continue
      const [field, msg] = uniqueField(e);
      return { status: 409, body: { error: msg, field, code: 'DUPLICATE_VENDOR', blocking: true } };
    }
  }
  return { status: 503, body: { error: 'Could not number the vendor. Please try again.' } };
}

const SHOWN = {
  name: 'Vendor name', companyName: 'Company name', contactPerson: 'Contact person', email: 'Email', phone: 'Phone', address: 'Address',
  gstin: 'GSTIN', pan: 'PAN', category: 'Category', paymentTerms: 'Payment terms', notes: 'Notes',
};

// Edit. Returns { row, changes:[{field,label,from,to}] } or { status, body }.
async function updateVendor(id, body, { actor, confirm = false } = {}) {
  const cur = await prisma.officeVendor.findUnique({ where: { id: String(id) } });
  if (!cur) return { status: 404, body: { error: 'Vendor not found.' } };
  const r = readVendor(body, { partial: true });
  if (r.error) return { status: r.status, body: { error: r.error, field: r.field } };
  const merged = { ...cur, ...r.data };
  // PAN vs GSTIN agreement is checked on the final values.
  if (merged.gstin && merged.pan && merged.gstin.slice(2, 12) !== merged.pan) {
    return { status: 400, body: { error: 'The PAN does not match the GSTIN (a GSTIN contains its holder\'s PAN)', field: 'pan' } };
  }
  const data = {};
  const changes = [];
  for (const k of EDITABLE) {
    if (r.data[k] === undefined) continue; // eslint-disable-line no-continue
    if (String(r.data[k] ?? '') !== String(cur[k] ?? '')) { data[k] = r.data[k]; changes.push({ field: k, label: SHOWN[k] || k, from: cur[k] ?? '', to: r.data[k] ?? '' }); }
  }
  for (const k of ['gstinKey', 'panKey', 'emailKey', 'phoneKey']) if (r.data[k] !== undefined && r.data[k] !== cur[k]) data[k] = r.data[k];
  if (!changes.length) return { row: cur, changes: [], unchanged: true };
  const dup = duplicateResponse(await findDuplicates({ ...merged }, { excludeId: cur.id }), confirm || (body && body.confirmDuplicate === true));
  if (dup) return dup;
  try {
    const row = await prisma.officeVendor.update({ where: { id: cur.id }, data: { ...data, updatedById: actor && actor.id ? actor.id : null } });
    return { row, changes };
  } catch (e) {
    if (e && e.code === 'P2002') { const [field, msg] = uniqueField(e); return { status: 409, body: { error: msg, field, code: 'DUPLICATE_VENDOR', blocking: true } }; }
    throw e;
  }
}

// Switch a vendor off / on (soft delete). Switching off signs every login of
// that vendor out at once. Returns the updated row.
async function setVendorActive(id, on, { actor, reason = null } = {}) {
  const cur = await prisma.officeVendor.findUnique({ where: { id: String(id) } });
  if (!cur) return null;
  if ((cur.isActive !== false) === on) return cur;
  const row = await prisma.officeVendor.update({
    where: { id: cur.id },
    data: on
      ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: null, updatedById: actor && actor.id ? actor.id : null }
      : { isActive: false, deactivatedAt: new Date(), deactivatedById: actor && actor.id ? actor.id : null, deactivationReason: reason ? String(reason).slice(0, 300) : null, updatedById: actor && actor.id ? actor.id : null },
  });
  if (!on) await require('./vendorAuth').revokeVendorSessions(cur.id, 'vendor switched off');
  return row;
}

// What a bill stores about its vendor when it is booked.
function vendorSnapshot(v) {
  if (!v) return {};
  return {
    vendorId: v.id,
    vendor: v.name,
    vendorGstin: v.gstin || null,
    vendorPan: v.pan || null,
    vendorAddress: v.address || null,
  };
}

// Finds the master vendor a bill's free-text vendor name belongs to: exact
// (case-insensitive) match on an ACTIVE master row. Never fuzzy — a "maybe"
// is for a person to decide (see scripts/vendor-master-migrate.js).
async function vendorByName(name) {
  const k = nameKey(name);
  if (!k) return null;
  const all = await prisma.officeVendor.findMany({ where: { isActive: true } });
  return all.find((v) => nameKey(v.name) === k) || null;
}

// Fills vendorId + the snapshot on an expense `data` object that is about to be
// written. `vendorId` explicitly sent wins; otherwise an exact name match.
// A GSTIN typed on the bill itself is kept (the bill's own GSTIN is the truth).
async function attachVendor(data, { vendorId = null } = {}) {
  let v = null;
  if (vendorId) v = await prisma.officeVendor.findUnique({ where: { id: String(vendorId) } });
  else if (data.vendor) v = await vendorByName(data.vendor);
  if (!v) return data;
  const snap = vendorSnapshot(v);
  data.vendorId = snap.vendorId;
  data.vendor = snap.vendor;
  if (!data.vendorGstin) data.vendorGstin = snap.vendorGstin;
  data.vendorPan = snap.vendorPan;
  data.vendorAddress = snap.vendorAddress;
  return data;
}

module.exports = {
  EDITABLE, TEXT, SHOWN, squash, nameKey, coreKey, gstinKeyOf, panKeyOf, emailKeyOf, phoneKeyOf,
  readVendor, findDuplicates, duplicateResponse, nextVendorCode, createVendor, updateVendor, setVendorActive,
  vendorSnapshot, vendorByName, attachVendor, brief,
};

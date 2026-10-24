// CONTACT LISTS: import (CSV / Excel), check, save, consent, soft delete + undo, retention.
const XLSX = require('xlsx');
const prisma = require('../db');
const core = require('../utils/messagingCore');
const delivery = require('../utils/messageDelivery');
const { logAudit } = require('../utils/audit');
const S = require('./store');
const A = require('./access');

const MAX_ROWS = 5000;
const UNDO_MS = 7 * 86400000;
const FIELDS = ['name', 'phone', 'email', 'company', 'city', 'skills', 'experience', 'tag', 'consent'];
const FIELD_WORDS = { name: 'Name', phone: 'Phone / WhatsApp', email: 'Email', company: 'Company', city: 'City', skills: 'Skills', experience: 'Experience', tag: 'Tag', consent: 'Permission (yes/no)' };
const ALIASES = {
  name: ['name', 'full name', 'fullname', 'contact name', 'candidate name', 'person', 'first name', 'firstname', 'employee name', 'naam'],
  phone: ['phone', 'mobile', 'mobile number', 'mobile no', 'whatsapp', 'whatsapp number', 'whatsapp no', 'phone number', 'phone no', 'contact number', 'contact no', 'cell', 'cell phone', 'mob', 'number', 'ph no', 'tel', 'telephone', 'mobile phone'],
  email: ['email', 'e-mail', 'email id', 'email address', 'mail', 'mail id'],
  company: ['company', 'organisation', 'organization', 'org', 'employer', 'current company', 'company name', 'hospital', 'firm'],
  city: ['city', 'location', 'place', 'town', 'current location', 'district'],
  skills: ['skills', 'skill', 'key skills', 'keyskills', 'skill set', 'specialisation', 'specialization', 'designation', 'role'],
  experience: ['experience', 'exp', 'years', 'total experience', 'yrs', 'experience years'],
  tag: ['tag', 'group', 'category', 'list', 'label', 'segment'],
  consent: ['consent', 'permission', 'opted in', 'optin', 'opt in', 'whatsapp consent', 'allowed'],
};
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function readFile(buf) {
  if (!buf || !buf.length) return { error: 'The file is empty.' };
  if (buf.slice(0, 5).toString('latin1').startsWith('%PDF')) return { error: 'That is a PDF. Upload a CSV or Excel (.xlsx / .xls) file. You can download the template.' };
  const zip = buf.slice(0, 2).toString('latin1') === 'PK';
  const ole = buf.slice(0, 4).toString('hex') === 'd0cf11e0';
  let wb;
  try {
    wb = zip || ole ? XLSX.read(buf, { type: 'buffer', cellDates: false }) : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true });
  } catch { return { error: 'That file could not be read. Save it as .xlsx or .csv and try again.' }; }
  const sheetName = (wb.SheetNames || []).find((n) => !/^(instructions|readme|guide)$/i.test(n)) || (wb.SheetNames || [])[0];
  if (!sheetName) return { error: 'The file has no sheet.' };
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: false });
  if (grid.length < 2) return { error: 'The file has no rows below the heading row.' };
  const headers = grid[0].map((h) => String(h == null ? '' : h).trim());
  const rows = grid.slice(1).map((r, k) => ({ line: k + 2, cells: headers.map((_, c) => (r[c] == null ? '' : (typeof r[c] === 'number' ? String(r[c]) : String(r[c]).trim()))) }));
  return { headers, rows, sheet: sheetName };
}

function autoMap(headers) {
  const map = {};
  const used = new Set();
  FIELDS.forEach((f) => {
    let idx = headers.findIndex((h, i) => !used.has(i) && ALIASES[f].includes(norm(h)));
    if (idx < 0) idx = headers.findIndex((h, i) => !used.has(i) && ALIASES[f].some((a) => a.length > 3 && norm(h).includes(a)));
    if (idx >= 0) { map[f] = idx; used.add(idx); }
  });
  return map;
}

// "98765 43210 / 98765 43211" -> the first number
function phoneOf(raw) {
  const first = String(raw == null ? '' : raw).split(/[/,;\n]| or /i).map((s) => s.trim()).filter(Boolean)[0] || '';
  const n = core.normalizeMobile(first.replace(/^(ph|tel|phone|mob|mobile|cell|whatsapp|wa)\.?\s*(no\.?|number)?\s*[:.-]?\s*/i, '').replace(/\.0+$/, ''));
  return n.ok ? { ok: true, e164: n.e164 } : { ok: false, blank: !first, reason: n.reason };
}

async function candidateIndex() {
  const rows = await prisma.candidate.findMany({ where: { phone: { not: null } }, select: { id: true, name: true, phone: true } });
  const m = new Map();
  rows.forEach((c) => { const d = String(c.phone).replace(/\D/g, '').slice(-10); if (d.length === 10 && !m.has(d)) m.set(d, { id: c.id, name: c.name }); });
  return m;
}
async function otherListPhones(exceptId) {
  const out = new Map();
  for (const k of await S.keys('bc.list.')) {
    const id = k.slice('bc.list.'.length);
    if (id === exceptId) continue; // eslint-disable-line no-continue
    const meta = await S.get(k); // eslint-disable-line no-await-in-loop
    if (!meta || meta.deletedAt) continue; // eslint-disable-line no-continue
    (await S.get(`bc.contacts.${id}`, [])).forEach((c) => { if (c.phone && !out.has(c.phone)) out.set(c.phone, meta.name); }); // eslint-disable-line no-await-in-loop
  }
  return out;
}
async function stopSet() {
  const rows = await prisma.appSetting.findMany({ where: { OR: [{ key: { startsWith: delivery.OPTOUT_PREFIX } }, { key: { startsWith: 'bc.dnc.' } }] }, select: { key: true } });
  const s = new Set();
  rows.forEach((r) => {
    if (r.key.startsWith('bc.dnc.')) s.add(r.key.slice(7));
    else if (r.key.startsWith(`${delivery.OPTOUT_PREFIX}WhatsApp.`)) s.add(r.key.slice(`${delivery.OPTOUT_PREFIX}WhatsApp.`.length));
  });
  return s;
}
async function isStopped(e164) {
  if (await delivery.optedOut('WhatsApp', e164)) return true;
  return !!(await S.get(`bc.dnc.${e164}`));
}

const STATUS_WORDS = {
  valid: 'Valid', candidate: 'Already a candidate', other_list: 'Already in another list', invalid: 'Invalid number', no_phone: 'No phone number',
  dup_in_file: 'Duplicate in file', stop: 'On the STOP list', no_consent: 'No permission',
};
const SENDABLE = new Set(['valid', 'candidate', 'other_list']);
const NO = /^(no|n|false|0|not allowed|declined|withdrawn|opted out|optout|dnc)$/i;

// rows: from readFile; map: field -> column index. -> { contacts, totals }
async function classify(rows, map, { exceptListId } = {}) {
  const cand = await candidateIndex();
  const others = await otherListPhones(exceptListId);
  const stops = await stopSet();
  const seen = new Set();
  const get = (r, f) => (map[f] === undefined || map[f] === null || map[f] === '' ? '' : String(r.cells[map[f]] || '').trim());
  const totals = { total: rows.length, valid: 0, candidate: 0, other_list: 0, invalid: 0, no_phone: 0, dup_in_file: 0, stop: 0, no_consent: 0 };
  const contacts = [];
  for (const r of rows) {
    const rawPhone = get(r, 'phone');
    const c = {
      i: r.line, name: get(r, 'name').slice(0, 120), phone: null, email: get(r, 'email').slice(0, 160), company: get(r, 'company').slice(0, 120), city: get(r, 'city').slice(0, 80),
      skills: get(r, 'skills').slice(0, 200), experience: get(r, 'experience').slice(0, 30), tag: get(r, 'tag').slice(0, 60), rawPhone: rawPhone.slice(0, 40), status: 'valid', why: '', cand: null, otherList: null,
    };
    const p = phoneOf(rawPhone);
    if (!p.ok) { c.status = p.blank ? 'no_phone' : 'invalid'; c.why = p.blank ? 'There is no phone number in this row.' : p.reason; } else {
      c.phone = p.e164;
      if (seen.has(p.e164)) { c.status = 'dup_in_file'; c.why = 'This number is already in an earlier row of the file.'; } else {
        seen.add(p.e164);
        const consent = get(r, 'consent');
        if (stops.has(p.e164)) { c.status = 'stop'; c.why = 'This person asked us to stop (STOP list).'; } else if (consent && NO.test(consent)) { c.status = 'no_consent'; c.why = 'The file says this person did not give permission.'; } else {
          const cd = cand.get(p.e164.slice(-10));
          if (cd) { c.status = 'candidate'; c.cand = cd; c.why = `Already a candidate: ${cd.name}.`; } else if (others.has(p.e164)) { c.status = 'other_list'; c.otherList = others.get(p.e164); c.why = `Also in the list "${others.get(p.e164)}".`; }
        }
      }
    }
    totals[c.status] += 1;
    contacts.push(c);
  }
  return { contacts, totals };
}

const sendableCount = (t) => t.valid + t.candidate + t.other_list;

// ---- storage -------------------------------------------------------------------
async function saveList(user, { name, source, ownerId, ownerName, contacts, totals, filename }) {
  const id = S.newId('cl');
  const meta = {
    id, name: String(name).trim().slice(0, 100), source: String(source || '').trim().slice(0, 140), ownerId: ownerId || user.id, ownerName: ownerName || user.name,
    createdAt: new Date().toISOString(), createdById: user.id, createdByName: user.name, filename: String(filename || '').slice(0, 120),
    totals, consent: null, deletedAt: null, retentionDays: 0,
  };
  await S.put(`bc.contacts.${id}`, contacts);
  await S.put(`bc.list.${id}`, meta, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Contact list imported', entity: 'ContactList', entityId: id, toValue: `${meta.name} · ${totals.total} rows · ${sendableCount(totals)} can be messaged · source "${meta.source}"`.slice(0, 480) });
  return meta;
}
async function sweep() {
  const now = Date.now();
  for (const k of await S.keys('bc.list.')) {
    const meta = await S.get(k); // eslint-disable-line no-await-in-loop
    if (!meta) continue; // eslint-disable-line no-continue
    if (meta.deletedAt && now - Date.parse(meta.deletedAt) > UNDO_MS) {
      await S.del(`bc.contacts.${meta.id}`); await S.del(k); // eslint-disable-line no-await-in-loop
      await logAudit({ userId: null, actorName: 'TeamLink', action: 'Contact list removed for good (7 days after delete)', entity: 'ContactList', entityId: meta.id, toValue: meta.name }); // eslint-disable-line no-await-in-loop
    } else if (meta.retentionDays > 0 && !meta.purgedAt && now - Date.parse(meta.createdAt) > meta.retentionDays * 86400000) {
      await S.put(`bc.contacts.${meta.id}`, []); await S.put(k, { ...meta, purgedAt: new Date().toISOString() }); // eslint-disable-line no-await-in-loop
      await logAudit({ userId: null, actorName: 'TeamLink', action: 'Contact list contacts removed (retention time passed)', entity: 'ContactList', entityId: meta.id, toValue: `${meta.name} · kept for ${meta.retentionDays} days` }); // eslint-disable-line no-await-in-loop
    }
  }
}
async function listAll(user, { includeDeleted = false } = {}) {
  await sweep().catch(() => {});
  const out = [];
  for (const k of await S.keys('bc.list.')) {
    const m = await S.get(k); // eslint-disable-line no-await-in-loop
    if (!m) continue; // eslint-disable-line no-continue
    if (m.deletedAt && !includeDeleted) continue; // eslint-disable-line no-continue
    if (!A.seesAll(user) && m.ownerId !== user.id && m.createdById !== user.id) continue; // eslint-disable-line no-continue
    out.push(m);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function getList(user, id) {
  if (!/^cl[a-z0-9]{6,30}$/.test(String(id))) return null;
  const m = await S.get(`bc.list.${id}`);
  if (!m) return null;
  if (!A.seesAll(user) && m.ownerId !== user.id && m.createdById !== user.id) return null;
  return m;
}
function viewContact(c, user) {
  const full = !A.masked(user);
  return {
    i: c.i, name: c.name, phone: full ? (c.phone ? `+${c.phone}` : c.rawPhone) : core.maskMobile(c.phone || c.rawPhone), email: full ? c.email : (c.email ? core.maskEmail(c.email) : ''),
    company: c.company, city: c.city, skills: c.skills, tag: c.tag, status: c.status, statusWords: STATUS_WORDS[c.status], why: c.why, cand: c.cand || null,
  };
}
async function recordConsent(user, id, { basis }) {
  const b = String(basis || '').trim();
  if (b.length < 5) return { error: 'Write in a few words why these people may be contacted (for example: "They are existing business contacts of the company").', status: 400 };
  const meta = await getList(user, id);
  if (!meta) return { error: 'This list was not found.', status: 404 };
  meta.consent = { at: new Date().toISOString(), byId: user.id, byName: user.name, basis: b.slice(0, 400) };
  await S.put(`bc.list.${id}`, meta, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Contact list: permission confirmed', entity: 'ContactList', entityId: id, reason: b.slice(0, 400), toValue: `${meta.name} (list ${id})` });
  return { list: meta };
}
async function softDelete(user, id) {
  const meta = await getList(user, id);
  if (!meta) return { error: 'This list was not found.', status: 404 };
  meta.deletedAt = new Date().toISOString();
  await S.put(`bc.list.${id}`, meta, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Contact list deleted (can be brought back for 7 days)', entity: 'ContactList', entityId: id, toValue: meta.name });
  return { ok: true, list: meta };
}
async function undelete(user, id) {
  const meta = await getList(user, id);
  if (!meta || !meta.deletedAt) return { error: 'This list is not deleted.', status: 404 };
  if (Date.now() - Date.parse(meta.deletedAt) > UNDO_MS) return { error: 'It was deleted more than 7 days ago.', status: 409 };
  meta.deletedAt = null;
  await S.put(`bc.list.${id}`, meta, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Contact list brought back', entity: 'ContactList', entityId: id, toValue: meta.name });
  return { ok: true, list: meta };
}

module.exports = { MAX_ROWS, FIELDS, FIELD_WORDS, STATUS_WORDS, SENDABLE, readFile, autoMap, phoneOf, classify, sendableCount, stopSet, saveList, listAll, getList, viewContact, recordConsent, softDelete, undelete, sweep, isStopped };

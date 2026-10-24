// ---------------------------------------------------------------------------
// NO EMPLOYEE NAMES IN THE ASSETS VENDOR PORTAL (2026-10-19, founder decision).
//
// About 150 HRMS assets carry an employee's name inside their asset code ("Edu 01-Sneha-L", "Medical-Vasavi-L", "Edu 08- Police supriya-M"),
// and a name can also sit in the type, the seat or a typed note. A vendor must never see it. ONE masker, used by EVERY vendor asset response
// (lists, details, repairs, history, invoices, orders), every export and every import report:
//
//   code(asset)      the vendor-facing asset ID.  "Edu 01-Sneha-L" -> "Edu 01-L": the seat / department prefix and the type letter stay, the
//                    name segment goes. A code with no name in it ("AST-0001") is unchanged. When nothing safe is left the ID becomes
//                    "AST-<last 6 letters of the internal id>". Two assets that would end up with the SAME vendor-facing ID both get
//                    " #<last 4 of the internal id>" added, so the ID is unique. It is worked out from the asset alone (plus whether another
//                    asset shares the masked text), so it stays the same from one request to the next.
//   text(s, assetId) any free text (name, type, seat, serial note, problem, remarks): the assigned employee's name parts (first / last name,
//                    3 letters or more) and the employee code are replaced by nothing; e-mail addresses and phone numbers are hidden too.
//
// The company's REAL asset code is never changed (HRMS and Accounts keep it). The vendor's calls always use the INTERNAL asset id (never the
// label), so a masked asset can still be opened, edited and repaired.
// The employee tables are read here ONLY to know which words to remove; nothing about the person is ever returned.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SAFE_WORDS = new Set(['laptop', 'charger', 'mouse', 'head', 'set', 'headset', 'monitor', 'mobile', 'phone', 'office', 'store', 'stock', 'seat', 'team', 'lead', 'manager', 'assistant', 'medical', 'manufacturing',
  'education', 'internal', 'dell', 'lenovo', 'apple', 'macbook', 'thinkpad', 'jabra', 'plantronics', 'airtel', 'samsung', 'redmi', 'oneplus', 'vivo', 'oppo', 'realme', 'tag', 'serial', 'asset', 'keyboard', 'logitech']);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const partsOf = (name) => String(name || '').split(/[\s.,_-]+/).map((w) => w.trim()).filter((w) => w.length >= 3);

let cache = { at: 0, data: null };
const TTL = 20000;
async function context(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;
  const [assets, emps] = await Promise.all([
    prisma.asset.findMany({ select: { id: true, assetCode: true, assignedTo: { select: { name: true, employeeCode: true } } } }),
    prisma.employee.findMany({ select: { name: true } }),
  ]);
  const global = new Set();
  emps.forEach((e) => partsOf(e.name).forEach((p) => { const l = p.toLowerCase(); if (l.length >= 4 && !SAFE_WORDS.has(l) && !/^\d+$/.test(l)) global.add(l); }));
  const holder = new Map();
  assets.forEach((a) => { if (a.assignedTo) holder.set(a.id, { parts: partsOf(a.assignedTo.name), code: a.assignedTo.employeeCode || null }); });
  const base = new Map();
  assets.forEach((a) => base.set(a.id, baseCode(a, holder.get(a.id), global)));
  const count = new Map();
  base.forEach((b) => count.set(b.toLowerCase(), (count.get(b.toLowerCase()) || 0) + 1));
  const final = new Map();
  const byCode = new Map();
  assets.forEach((a) => {
    const b = base.get(a.id);
    const code = count.get(b.toLowerCase()) > 1 ? `${b} #${a.id.slice(-4).toUpperCase()}` : b;
    final.set(a.id, code);
    byCode.set(a.assetCode, code);
  });
  cache = { at: Date.now(), data: { holder, global, final, byCode } };
  return cache.data;
}
const reset = () => { cache = { at: 0, data: null }; };

const fallback = (id) => `AST-${String(id).slice(-6).toUpperCase()}`;
// The text with the holder's name parts and long personal tokens removed.
function strip(text, h) {
  let t = String(text == null ? '' : text);
  if (h) {
    h.parts.forEach((p) => { t = t.replace(new RegExp(`(^|[^A-Za-z])${esc(p)}(?![A-Za-z])`, 'ig'), '$1'); });
    if (h.code) t = t.split(h.code).join('');
  }
  return t;
}
function baseCode(a, h, global) {
  const raw = String(a.assetCode || '').trim();
  if (!raw) return fallback(a.id);
  let segs = raw.split(/-(?![^(]*\))/).map((s) => s.trim()); // a hyphen inside brackets "(MED-1)" is not a split point
  // "<seat>-<name>-<type letter>": every middle segment that is not just a number is a name. (A code like AST-0001 has no middle.)
  if (segs.length >= 3 && /^[A-Za-z]{1,2}$/.test(segs[segs.length - 1])) {
    const last = segs[segs.length - 1];
    const head = segs[0];
    const mid = segs.slice(1, -1).filter((s) => /^\d{1,3}$/.test(s));
    segs = [head, ...mid, last];
  }
  let code = segs.join('-');
  code = strip(code, h);
  // any word of 4+ letters that is some employee's name (and not a plain asset word) goes too
  code = code.replace(/[A-Za-z]{4,}/g, (tok) => (global.has(tok.toLowerCase()) ? '' : tok));
  code = code.replace(/(^|[\s(])[A-Za-z]\.(?=[\s()-]|$)/g, '$1'); // a leftover initial ("K.")
  code = code.replace(/\s{2,}/g, ' ').replace(/-{2,}/g, '-').replace(/^[\s-]+|[\s-]+$/g, '').replace(/\s+-/g, '-').replace(/-\s+/g, '-');
  if (!code || /^[A-Za-z]{1,2}$/.test(code)) return fallback(a.id);
  return code;
}

// A masker bound to the current employee data. Usage: const M = await Mask.load(); M.code(asset) / M.codeOfId(id) / M.codeOfCode('Edu 01-Sneha-L') / M.text(str, assetId)
async function load(force = false) {
  const c = await context(force);
  const textFor = (s, assetId) => {
    if (s == null) return s;
    let t = strip(s, c.holder.get(assetId));
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '').replace(/\+?\d[\d\s-]{8,}\d/g, '');
    return t.replace(/\s{2,}/g, ' ').replace(/^[\s·|,-]+|[\s·|,-]+$/g, '').trim();
  };
  return {
    code: (a) => (a && a.id && c.final.get(a.id)) || (a && a.id ? fallback(a.id) : null),
    codeOfId: (id) => c.final.get(id) || (id ? fallback(id) : null),
    // by the company's real code (an invoice that kept the code it was sent with)
    codeOfCode: (code) => (code == null ? null : (c.byCode.get(code) || (c.global ? stripCodeOnly(code, c.global) : code))),
    text: textFor,
    // a plain string that may hold the real code of an asset: swap the real code for the vendor-facing one
    scrub: (s, assetId) => textFor(s, assetId),
  };
}
// An unknown code (asset deleted since): the same generic clean-up, with no holder.
function stripCodeOnly(code, global) { return baseCode({ id: 'unknown000000', assetCode: code }, null, global); }

module.exports = { load, reset, context, partsOf, baseCode, fallback };

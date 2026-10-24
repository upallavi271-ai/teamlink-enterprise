// ---------------------------------------------------------------------------
// AGREEMENT DRIVE LINKS - attach many clients' signed agreements in one go (user, 2026-10-12:
// "BDE ki, bulk lo agreement Drive links upload cheskuney option undali").
//
// The signed agreements already live as files in Google Drive. A BDE pastes (or uploads) a list
//   Client name or Client ID | Drive link | Agreement date | End date | Note | (Mark as signed copy)
// and the app (1) CHECKS every line, then (2) saves the good ones.
//
// STORAGE (no migration): each link is one ClientDocument row of kind AGREEMENT_LINK (the existing
// client documents table: fileStored = 'link:<https url>', fileName = 'Google Drive', expiryDate = the
// agreement end date) plus a small JSON row in AppSetting 'agrlink.<docId>' for the extras (agreement
// date, note, "signed copy on file", who replaced / removed it and when). Replacing a link keeps the old
// one as history (superseded); removing (Admin only) is soft - the row stays in history.
//
// IT DOES NOT TOUCH THE E-SIGN AGREEMENT: status, numbering, signatures and stamps are never changed
// here. "Mark as signed copy on file" is a plain flag on the link, only for an Admin / Super Admin / BDE TL.
//
// The link is NEVER fetched or opened by the server: it is validated by its text only and stored.
// This file must not import http / https / fetch / any mailer (a test greps it).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { can } = require('./permissions');
const scope = require('./scope');
const CL = require('./clientLifecycle');
const { displayCode } = require('./clientDuplicates');

const KIND = 'AGREEMENT_LINK';
const KIND_LABEL = 'Agreement (Drive link)';
const DOC_NAME = 'Signed agreement (Drive link)';
const PREFIX = 'agrlink.';
const MAX_LINES = 500;
const STORED_PREFIX = 'link:';

// ---- the link ---------------------------------------------------------------------------------------
// host -> { label, test(url) }. Google Drive / Docs are the point of this feature; OneDrive and Dropbox
// are the same idea, cheap to allow, and easy to remove (delete the lines).
const ID = '[A-Za-z0-9_-]{10,}';
const GOOGLE_DRIVE_PATHS = [
  new RegExp(`^/file/(?:u/\\d+/)?d/${ID}(?:/|$)`),
  new RegExp(`^/drive/(?:u/\\d+/|mobile/)?folders/${ID}(?:/|$)`),
  new RegExp(`^/(?:u/\\d+/)?folders/${ID}(?:/|$)`),
];
const GOOGLE_DOCS_PATHS = [
  new RegExp(`^/(?:document|spreadsheets|presentation)/(?:u/\\d+/)?d/${ID}(?:/|$)`),
  new RegExp(`^/file/(?:u/\\d+/)?d/${ID}(?:/|$)`),
];
const idQuery = (u) => new RegExp(`^${ID}$`).test(u.searchParams.get('id') || '');
const HOSTS = {
  'drive.google.com': {
    label: 'Google Drive',
    ok: (u) => GOOGLE_DRIVE_PATHS.some((re) => re.test(u.pathname)) || (['/open', '/uc', '/folderview'].includes(u.pathname) && idQuery(u)),
  },
  'docs.google.com': { label: 'Google Docs', ok: (u) => GOOGLE_DOCS_PATHS.some((re) => re.test(u.pathname)) },
  '1drv.ms': { label: 'OneDrive', ok: (u) => u.pathname.length > 3 },
  'onedrive.live.com': { label: 'OneDrive', ok: (u) => u.pathname.length > 1 && u.search.length > 3 },
  'www.dropbox.com': { label: 'Dropbox', ok: (u) => /^\/(?:s|scl|sh)\/[^/]+/.test(u.pathname) },
  'dropbox.com': { label: 'Dropbox', ok: (u) => /^\/(?:s|scl|sh)\/[^/]+/.test(u.pathname) },
};
const hostRule = (host) => {
  if (HOSTS[host]) return HOSTS[host];
  if (/^[a-z0-9-]+\.sharepoint\.com$/.test(host)) return { label: 'SharePoint', ok: (u) => u.pathname.length > 3 };
  return null;
};
const HOST_NAMES = ['drive.google.com', 'docs.google.com', '1drv.ms', 'onedrive.live.com', 'dropbox.com', '*.sharepoint.com'];

// Text-only check. Never connects to anything.
function validateLink(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  const bad = (text) => ({ ok: false, text });
  if (!s) return bad('The link is empty. Paste the Google Drive link of the signed agreement.');
  if (s.length > 1000) return bad('This link is too long to be a Drive link.');
  if (/[\s<>"'`\\]/.test(s)) return bad('The link has spaces or odd characters. Copy it again from Google Drive (Share, then Copy link).');
  if (/^\s*(javascript|data|vbscript|file|blob)\s*:/i.test(s)) return bad('This is not a web link. Paste the https:// Google Drive link.');
  let u;
  try { u = new URL(s); } catch { return bad('This does not look like a web link. It should start with https://drive.google.com/…'); }
  if (u.protocol === 'http:') return bad('This link starts with http:// (not safe). Use the https:// link from Google Drive.');
  if (u.protocol !== 'https:') return bad('This is not a web link. Paste the https:// Google Drive link.');
  if (u.username || u.password) return bad('The link has a user name or password inside it. Copy the plain link from Google Drive.');
  if (u.port && u.port !== '443') return bad('This link points to an unusual address. Paste the normal Google Drive link.');
  const host = u.hostname.toLowerCase();
  const rule = hostRule(host);
  if (!rule) return bad(`Only Google Drive / Google Docs links are accepted (also OneDrive and Dropbox). This one is from ${host}.`);
  if (!rule.ok(u)) return bad('This is a Drive address but not a file or folder link. In Google Drive open the file, press Share, then Copy link.');
  return { ok: true, href: u.href, host, label: rule.label };
}
const hostOf = (href) => { try { return new URL(href).hostname.toLowerCase(); } catch { return null; } };

// ---- dates / flags ------------------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function ymdOk(y, m, d) {
  if (y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// '' -> {ok, value:null}; 2026-03-31 | 31-03-2026 | 31/03/26 | 31 Mar 2026 | an Excel date number
function parseDate(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return { ok: true, value: null };
  let m;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    const out = ymdOk(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    return out ? { ok: true, value: out } : { ok: false };
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) { const out = ymdOk(+m[1], +m[2], +m[3]); return out ? { ok: true, value: out } : { ok: false }; }
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const out = ymdOk(y, +m[2], +m[1]); // day first (India)
    return out ? { ok: true, value: out } : { ok: false };
  }
  if ((m = /^(\d{1,2})[\s/-]+([A-Za-z]{3,9})[\s,/-]+(\d{2}|\d{4})$/.exec(s))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const out = mi >= 0 ? ymdOk(y, mi + 1, +m[1]) : null;
    return out ? { ok: true, value: out } : { ok: false };
  }
  return { ok: false };
}
const yes = (v) => /^(y|yes|true|1|x|tick|ticked|✓|✔)$/i.test(String(v === undefined || v === null ? '' : v).trim());

// ---- names --------------------------------------------------------------------------------------------
const NOISE = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'corp', 'corporation', 'company', 'the']);
const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function normName(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !NOISE.has(t)).join(' ');
}
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function similarity(a, b) {
  if (!a || !b) return 0;
  let score = 1 - lev(a, b) / Math.max(a.length, b.length);
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) score = Math.max(score, 0.85);
  const ta = new Set(a.split(' ')); const tb = new Set(b.split(' '));
  const common = [...ta].filter((t) => tb.has(t)).length;
  const jac = common / (ta.size + tb.size - common);
  if (ta.size >= 2 && tb.size >= 2) score = Math.max(score, jac * 0.95);
  return score;
}
const CLOSE_MIN = 0.75;

// ---- who may do what ---------------------------------------------------------------------------------
// Adding: SA / Admin, the BDE team lead and a desk BDE, AND the Role Catalog ticks 'Client Detail: edit'
// + 'Upload documents' (Client Documents: create). Manager, AM, STL, TL, Recruiter, Accounts, client
// portal and candidate never add. Marking "signed copy on file": SA / Admin / BDE TL only.
async function rightsOf(user) {
  const s = scope.atsScopeOf(user);
  const isAdmin = !!s.global;
  const tl = scope.isBdeTl(user);
  const bde = CL.isDeskBde(user);
  const roleOk = isAdmin || tl || bde;
  let canAdd = false;
  let why = "Only the client's BDE, the BDE team lead and Admins can add these links.";
  if (roleOk) {
    const [edit, docs] = await Promise.all([
      can(user, 'ats', 'clients', 'Client Detail', 'edit'),
      can(user, 'ats', 'clients', 'Client Documents', 'create'),
    ]);
    // 2026-10-16: the whole BDE team (desk BDE, BDE TL) adds, marks and removes links for the clients in their own scope
    // whatever a saved Role Catalog row says; the ticks still apply to an Admin login as before.
    canAdd = !!(edit && docs) || tl || bde;
    if (!canAdd) why = "Your role is not ticked for 'Upload documents'. Ask an Admin to tick it in Role Catalog.";
  }
  return {
    canAdd, why: canAdd ? null : why, isAdmin, tl, bde,
    canMarkSigned: canAdd && (isAdmin || tl || bde),
    canRemove: isAdmin || canAdd,
    viewMode: viewMode(user),
    limit: MAX_LINES,
    hosts: HOST_NAMES,
  };
}
// Who READS the links: Admin / SA, the BDE team lead, Manager / Assistant Manager (read only), Accounts
// (read only) - all 'all' (the route already holds them to their clients) - and the owner BDE ('own').
// Never a plain TL / STL / Recruiter, a client login or a candidate.
function viewMode(user) {
  const s = scope.atsScopeOf(user);
  if (user && (user.role === 'CLIENT' || s.atsRole === 'CLIENT' || user.role === 'CANDIDATE' || s.atsRole === 'CANDIDATE')) return null;
  if (s.global || scope.isBdeTl(user)) return 'all';
  if (CL.isDeskBde(user)) return 'own';
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)) return 'all';
  if ([user.role, s.atsRole, s.accountsRole].filter(Boolean).includes('ACCOUNTANT')) return 'all';
  return null;
}
const canSeeFor = (mode, user, client) => mode === 'all' || (mode === 'own' && CL.ownsClient(user, client));

// ---- the clients one login can attach to -------------------------------------------------------------
const CLIENT_FIELDS = { id: true, name: true, legalName: true, clientCode: true, agreementId: true, bdeOwner: true, ownerDepartment: true, status: true };
async function buildIndex(user) {
  const rows = await prisma.client.findMany({
    where: { AND: [scope.clientWhere(user), { NOT: { clientType: 'Internal' } }] },
    select: CLIENT_FIELDS,
  });
  return indexFromRows(rows, (c) => CL.ownsClient(user, c));
}
// Also used by scripts/agreement-links-dryrun.js (no login: every client counts as reachable).
function indexFromRows(rows, isOwn) {
  const idx = { all: [], byKey: new Map(), byName: new Map() };
  rows.forEach((c) => {
    const e = { ...c, code: displayCode(c), own: isOwn(c), norm: normName(c.name) };
    idx.all.push(e);
    [flat(c.id), flat(c.clientCode), flat(e.code), flat(c.agreementId)].filter(Boolean).forEach((k) => { if (!idx.byKey.has(k)) idx.byKey.set(k, e); });
    [normName(c.name), normName(c.legalName)].filter(Boolean).forEach((k) => {
      const list = idx.byName.get(k) || [];
      if (!list.includes(e)) list.push(e);
      idx.byName.set(k, list);
    });
  });
  idx.byId = new Map(idx.all.map((e) => [e.id, e]));
  return idx;
}
const brief = (e) => ({ id: e.id, name: e.name, code: e.code, bdeOwner: e.bdeOwner || null, department: e.ownerDepartment || null });

// ref (a Client ID, an agreement number or a name) -> { kind, client, suggestions, text }
function resolveRef(ref, idx) {
  const raw = String(ref || '').trim();
  if (!raw) return { kind: 'notfound', text: 'No client name or ID on this line.' };
  const key = flat(raw);
  const byKey = key ? idx.byKey.get(key) : null;
  if (byKey) return byKey.own ? { kind: 'ok', client: byKey, by: 'id' } : { kind: 'notyours', client: byKey };
  const list = idx.byName.get(normName(raw)) || [];
  if (list.length) {
    const mine = list.filter((e) => e.own);
    if (mine.length === 1) return { kind: 'ok', client: mine[0], by: 'name' };
    if (mine.length > 1) return { kind: 'close', suggestions: mine.slice(0, 5).map(brief), text: `${mine.length} of your clients have this name. Pick the right one.` };
    return { kind: 'notyours', client: list[0] };
  }
  const n = normName(raw);
  if (n.length >= 3) {
    const scored = idx.all.map((e) => ({ e, s: similarity(n, e.norm) })).filter((x) => x.s >= CLOSE_MIN).sort((a, b) => b.s - a.s);
    const mine = scored.filter((x) => x.e.own).slice(0, 3);
    if (mine.length) return { kind: 'close', suggestions: mine.map((x) => brief(x.e)), text: `Did you mean ${mine[0].e.name}?` };
    const theirs = scored.find((x) => x.s >= 0.85);
    if (theirs) return { kind: 'notyours', client: theirs.e };
  }
  return { kind: 'notfound' };
}

// ---- links of clients (current / history) -------------------------------------------------------------
const metaKey = (docId) => `${PREFIX}${docId}`;
const parseMeta = (row) => { try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const chunk = (arr, n = 400) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function docsWithMeta(where) {
  const docs = await prisma.clientDocument.findMany({ where: { ...where, kind: KIND }, orderBy: { createdAt: 'desc' } });
  const metas = new Map();
  for (const part of chunk(docs.map((d) => metaKey(d.id)))) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.appSetting.findMany({ where: { key: { in: part } } })).forEach((r) => metas.set(r.key, parseMeta(r)));
  }
  return docs.map((d) => ({ doc: d, meta: metas.get(metaKey(d.id)) || {} }));
}
const isActive = (x) => !x.meta.supersededAt && !x.meta.removedAt;
const hrefOf = (d) => (String(d.fileStored || '').startsWith(STORED_PREFIX) ? String(d.fileStored).slice(STORED_PREFIX.length) : null);
const isLinkDoc = (d) => d && d.kind === KIND;

function shapeLink(x, { withUrl = true } = {}) {
  const { doc: d, meta: m } = x;
  const href = hrefOf(d);
  return {
    id: d.id, url: withUrl ? href : undefined, host: hostOf(href), label: d.fileName || 'Google Drive',
    agreementDate: m.agreementDate || null, endDate: d.expiryDate || null, note: m.note || null,
    addedAt: d.createdAt, addedByName: d.uploadedByName || null, via: m.via || null,
    signedCopy: !!m.signedCopy, signedCopyByName: m.signedCopyByName || null, signedCopyAt: m.signedCopyAt || null,
    state: m.removedAt ? 'Removed' : (m.supersededAt ? 'Replaced' : 'Current'),
    endedAt: m.removedAt || m.supersededAt || null, endedByName: m.removedByName || m.supersededByName || null,
  };
}

// ---- parsing a paste / a sheet -------------------------------------------------------------------------
function splitDelimited(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"' && !cur.trim()) q = true;
    else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
const URLISH = /^(?:https?:|javascript:|data:|vbscript:|file:|ftp:)/i;
const looksLikeLink = (s) => URLISH.test(String(s || '').trim()) || /^(?:www\.|drive\.google|docs\.google)/i.test(String(s || '').trim());
function cellsOf(line) {
  const delim = ['\t', '|', ',', ';'].find((d) => line.includes(d));
  if (delim) {
    const cells = splitDelimited(line, delim);
    if (delim === '\t' || cells.some((c) => looksLikeLink(c))) return cells;
  }
  // no delimiter (or the link is glued to the name): "Client name   https://..."
  const m = /^(.*?)\s*((?:https?:|javascript:|data:|vbscript:|file:)\S*|(?:www\.|drive\.google|docs\.google)\S*)\s*(.*)$/i.exec(line);
  if (m) return [m[1].trim(), m[2], ...(m[3] ? m[3].split(/\s{2,}|\s+(?=\d)/).map((x) => x.trim()) : [])];
  return delim ? splitDelimited(line, delim) : [line.trim()];
}
function headerMap(cells) {
  const names = cells.map((c) => flat(c));
  if (!names.length || cells.some((c) => /^https?:/i.test(c))) return null;
  const find = (re, not) => names.findIndex((n) => re.test(n) && !(not && not.test(n)));
  const link = find(/link|url|drive/);
  const ref = find(/client|company|name|^id|code/, /link|url|drive|note|date/);
  if (link < 0 || ref < 0 || link === ref) return null;
  return {
    ref, link,
    agreementDate: find(/date|signed|start/, /end|expiry|expire|valid|till|mark|copy|link/),
    endDate: find(/end|expiry|expire|valid|till/),
    note: find(/note|remark|comment/),
    markSigned: find(/mark|signedcopy|copyonfile|^signed$/),
  };
}
// Text -> lines. A line number is the line in the paste (the header counts) so "line 7" matches the box.
function parseText(text) {
  const src = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const lines = []; let map = null; let headerSeen = false;
  src.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let cells = cellsOf(line);
    if (!headerSeen) {
      headerSeen = true;
      const hm = headerMap(cells);
      if (hm) { map = hm; return; }
    }
    if (!map && cells.length >= 2 && looksLikeLink(cells[0]) && !looksLikeLink(cells[1])) cells = [cells[1], cells[0], ...cells.slice(2)];
    const at = (k, pos) => (map ? (map[k] >= 0 ? cells[map[k]] : '') : cells[pos]) || '';
    let note = at('note', 4);
    if (!map && cells.length > 5 && !yes(cells[5])) note = cells.slice(4).join(', ');
    lines.push({
      row: i + 1, ref: at('ref', 0), link: at('link', 1), agreementDate: at('agreementDate', 2), endDate: at('endDate', 3),
      note, markSigned: yes(at('markSigned', 5)),
    });
  });
  return lines;
}

// An uploaded .xlsx / .xls / .csv -> the same text as a paste (tab separated, row for row, so "line 7" is
// row 7 of the sheet). Throws { userMessage }.
function fileToText(buf) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const head = buf.slice(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) throw Object.assign(new Error('pdf'), { userMessage: 'That is a PDF. Upload the Excel or CSV file (use Download template).' });
  const zip = head.startsWith('PK');
  const ole = buf.slice(0, 4).toString('hex') === 'd0cf11e0';
  if (!zip && !ole) {
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    return { text, lines: text.split(/\r?\n/).filter((l) => l.trim()).length };
  }
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: false }); } catch { throw Object.assign(new Error('bad'), { userMessage: 'That file could not be read. Save it as .xlsx or .csv and try again.' }); }
  const name = (wb.SheetNames || []).find((n) => !/^how to fill|instructions|readme/i.test(n)) || (wb.SheetNames || [])[0];
  const ws = name ? wb.Sheets[name] : null;
  if (!ws || !ws['!ref']) throw Object.assign(new Error('empty'), { userMessage: 'The sheet is empty.' });
  const range = XLSX.utils.decode_range(ws['!ref']);
  const lastRow = Math.min(range.e.r, 3000);
  const cellText = (c) => {
    if (!c) return '';
    if (c.l && c.l.Target && !/^https?:/i.test(String(c.v || ''))) return String(c.l.Target); // a hyperlink with a label like "View"
    if (c.t === 'n') return String(c.v);
    return String(c.w !== undefined ? c.w : (c.v !== undefined ? c.v : ''));
  };
  const out = [];
  for (let r = range.s.r; r <= lastRow; r += 1) {
    const cells = [];
    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 9); c += 1) cells.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]).replace(/[\t\r\n]+/g, ' ').trim());
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    out.push(cells.join('\t'));
  }
  return { text: out.join('\n'), lines: out.filter((l) => l.trim()).length, sheet: name };
}

// ---- checking -----------------------------------------------------------------------------------------
const PRIORITY = ['badlink', 'baddate', 'notfound', 'notyours', 'duplicate', 'close', 'exists', 'ok'];
const CHIP = {
  ok: ['green', 'Matched client'], exists: ['orange', 'Already has a link'], close: ['orange', 'Did you mean…?'],
  duplicate: ['orange', 'Duplicate line'], notfound: ['red', 'Not found'], notyours: ['red', 'Not yours'],
  badlink: ['red', 'Bad link'], baddate: ['red', 'Bad date'],
};
const clip = (s, n) => String(s === undefined || s === null ? '' : s).trim().slice(0, n);

async function evaluate(user, rawLines, rights, idxIn) {
  const idx = idxIn || await buildIndex(user);
  const out = rawLines.map((l, n) => {
    const input = {
      row: Number(l.row) || n + 1, ref: clip(l.ref, 300), link: clip(l.link, 1100), agreementDate: clip(l.agreementDate, 40), endDate: clip(l.endDate, 40),
      note: clip(l.note, 300), markSigned: l.markSigned === true || yes(l.markSigned),
      clientId: l.clientId ? String(l.clientId) : null, onExisting: l.onExisting === 'replace' ? 'replace' : 'keep',
    };
    const issues = [];
    const add = (code, text) => issues.push({ code, text });
    let client = null; let suggestions = [];
    if (input.clientId) {
      // a client the user confirmed ("Did you mean ...?" or a pick): must be in THIS user's reach
      const e = idx.byId.get(input.clientId);
      if (!e) add('notfound', 'That client is not in your area.');
      else if (!e.own) { add('notyours', `${e.name} is not yours.${e.bdeOwner ? ` It is looked after by ${e.bdeOwner}.` : ''}`); client = e; } else client = e;
    } else {
      const r = resolveRef(input.ref, idx);
      if (r.kind === 'ok') client = r.client;
      else if (r.kind === 'close') { suggestions = r.suggestions; add('close', r.text); } else if (r.kind === 'notyours') {
        client = r.client;
        add('notyours', `${r.client.name} is not yours.${r.client.bdeOwner ? ` It is looked after by ${r.client.bdeOwner}.` : ' Ask your BDE team lead.'}`);
      } else add('notfound', r.text || 'No client with this name or ID in your area. Check the spelling, or use the Client ID.');
    }
    const lk = validateLink(input.link);
    if (!lk.ok) add('badlink', lk.text);
    const d1 = parseDate(input.agreementDate); const d2 = parseDate(input.endDate);
    if (!d1.ok) add('baddate', 'The agreement date does not look right. Write it like 31-03-2026.');
    if (!d2.ok) add('baddate', 'The end date does not look right. Write it like 31-03-2026.');
    if (d1.ok && d2.ok && d1.value && d2.value && d2.value < d1.value) add('baddate', 'The end date is before the agreement date.');
    const warnings = [];
    if (input.markSigned && !rights.canMarkSigned) warnings.push("'Mark as signed copy' is for an Admin or the BDE team lead. It was ignored.");
    return {
      row: input.row, input, issues, warnings, client: client ? brief(client) : null, _client: client, suggestions,
      link: lk.ok ? { href: lk.href, host: lk.host, label: lk.label } : null,
      agreementDate: d1.ok ? d1.value : null, endDate: d2.ok ? d2.value : null,
    };
  });
  // the same client twice (or the very same line twice): the first stays, later ones are marked
  const seen = new Map(); const seenRaw = new Map();
  out.forEach((r) => {
    if (r.issues.length) {
      if (!r._client && r.input.ref) {
        const k = `${flat(r.input.ref)}|${r.input.link}`;
        if (seenRaw.has(k)) r.issues.push({ code: 'duplicate', text: `The same line is already on line ${seenRaw.get(k)}.` }); else seenRaw.set(k, r.row);
      }
      return;
    }
    if (seen.has(r._client.id)) r.issues.push({ code: 'duplicate', text: `${r._client.name} is already on line ${seen.get(r._client.id)}. Only the first line is used.` });
    else seen.set(r._client.id, r.row);
  });
  // clients that already have a link
  const ids = [...new Set(out.filter((r) => r._client && !r.issues.length).map((r) => r._client.id))];
  const current = new Map();
  for (const part of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    (await docsWithMeta({ clientId: { in: part } })).filter(isActive).forEach((x) => { if (!current.has(x.doc.clientId)) current.set(x.doc.clientId, x); });
  }
  out.forEach((r) => {
    if (!r.issues.length && current.has(r._client.id)) {
      const x = current.get(r._client.id);
      r.existing = { docId: x.doc.id, host: hostOf(hrefOf(x.doc)), label: x.doc.fileName || 'Google Drive', addedAt: x.doc.createdAt, addedByName: x.doc.uploadedByName || null };
      r.issues.push({ code: 'exists', text: 'This client already has an agreement link. Choose Replace (the old one is kept in history) or Keep.' });
    }
    const status = PRIORITY.find((p) => r.issues.some((i) => i.code === p)) || 'ok';
    r.status = status; r.tone = CHIP[status][0]; r.chip = CHIP[status][1];
    r.message = (r.issues.find((i) => i.code === status) || {}).text || (r._client ? `Will be added to ${r._client.name}.` : '');
    r.extra = r.issues.filter((i) => i.code !== status).map((i) => i.text);
    r.ready = status === 'ok' || status === 'exists';
    r.will = status === 'ok' ? 'add' : (status === 'exists' ? (r.input.onExisting === 'replace' ? 'replace' : 'keep') : null);
  });
  return out;
}

const publicResult = (r) => {
  const { _client, ...rest } = r; // eslint-disable-line no-unused-vars
  return rest;
};
async function check(user, rawLines) {
  const rights = await rightsOf(user);
  const rows = await evaluate(user, rawLines, rights);
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows: rows.map(publicResult),
    summary: {
      total: rows.length, ready: rows.filter((r) => r.ready && r.will !== 'keep').length, matched: count('ok'), exists: count('exists'), close: count('close'),
      notfound: count('notfound'), notyours: count('notyours'), duplicate: count('duplicate'), badlink: count('badlink'), baddate: count('baddate'),
    },
  };
}

// ---- saving -------------------------------------------------------------------------------------------
async function addOne(user, r, { runId, via, rights }) {
  const clientId = r._client.id;
  const now = new Date().toISOString();
  let oldHost = null;
  if (r.existing) {
    const old = await prisma.appSetting.findUnique({ where: { key: metaKey(r.existing.docId) } });
    const oldDoc = await prisma.clientDocument.findUnique({ where: { id: r.existing.docId } });
    oldHost = oldDoc ? hostOf(hrefOf(oldDoc)) : null;
    const next = { ...(old ? parseMeta(old) : {}), supersededAt: now, supersededByName: user.name || null, supersededById: user.id };
    await prisma.appSetting.upsert({
      where: { key: metaKey(r.existing.docId) }, create: { key: metaKey(r.existing.docId), value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
      update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
    });
  }
  const doc = await prisma.clientDocument.create({
    data: {
      clientId, kind: KIND, name: DOC_NAME, fileStored: `${STORED_PREFIX}${r.link.href}`, fileName: r.link.label, fileMime: 'text/uri-list', fileSize: null,
      expiryDate: r.endDate || null, pending: false, uploadedById: user.id, uploadedByName: user.name || null,
    },
  });
  const meta = {
    agreementDate: r.agreementDate || null, note: r.input.note || null, via, runId: runId || null,
    signedCopy: !!(r.input.markSigned && rights.canMarkSigned),
    ...(r.input.markSigned && rights.canMarkSigned ? { signedCopyByName: user.name || null, signedCopyAt: now } : {}),
    ...(r.existing ? { replaces: r.existing.docId } : {}),
  };
  await prisma.appSetting.create({ data: { key: metaKey(doc.id), value: JSON.stringify(meta), updatedById: user.id, updatedByName: user.name || null } });
  if (r.existing) {
    const prev = await prisma.appSetting.findUnique({ where: { key: metaKey(r.existing.docId) } });
    await prisma.appSetting.update({ where: { key: metaKey(r.existing.docId) }, data: { value: JSON.stringify({ ...parseMeta(prev), replacedBy: doc.id }) } });
  }
  await logAudit({
    userId: user.id, actorName: user.name || null, action: r.existing ? 'Agreement Drive link replaced' : 'Agreement Drive link added', entity: 'Client', entityId: clientId,
    fieldLabel: 'Agreement Drive link', fromValue: oldHost, toValue: r.link.host, reason: (runId ? `Bulk run ${runId}` : 'From the client page') + (meta.signedCopy ? ' · marked as signed copy on file' : ''),
  });
  return doc;
}

async function bumpRun(user, runId, delta, fresh) {
  const where = { entity: 'AgreementLinkRun', entityId: runId, userId: user.id };
  const row = await prisma.auditLog.findFirst({ where });
  let t = { lines: 0, added: 0, replaced: 0, skipped: 0 };
  if (row) { try { t = { ...t, ...JSON.parse(row.fromValue || '{}') }; } catch { /* new */ } }
  const total = {
    lines: t.lines + delta.lines, added: t.added + delta.added, replaced: t.replaced + delta.replaced, skipped: t.skipped + delta.skipped,
  };
  const text = `Added ${total.added}, replaced ${total.replaced}, skipped ${total.skipped} of ${total.lines} lines`;
  if (row) await prisma.auditLog.update({ where: { id: row.id }, data: { fromValue: JSON.stringify(total), toValue: text } });
  else if (fresh !== false) {
    await logAudit({ userId: user.id, actorName: user.name || null, action: 'Agreement Drive links bulk run', entity: 'AgreementLinkRun', entityId: runId, fromValue: JSON.stringify(total), toValue: text, reason: 'Bulk Drive links for client agreements' });
  }
  return total;
}
async function runTotal(user, runId) {
  const row = await prisma.auditLog.findFirst({ where: { entity: 'AgreementLinkRun', entityId: runId, userId: user.id } });
  if (!row) return 0;
  try { return Number(JSON.parse(row.fromValue || '{}').lines) || 0; } catch { return 0; }
}

async function apply(user, rawLines, { runId, via = 'bulk' } = {}) {
  const rights = await rightsOf(user);
  const rows = await evaluate(user, rawLines, rights);
  const results = [];
  const delta = { lines: rows.length, added: 0, replaced: 0, skipped: 0 };
  for (const r of rows) {
    const base = { row: r.row, client: r._client ? r._client.name : (r.input.ref || ''), clientId: r._client ? r._client.id : null, host: r.link ? r.link.host : null };
    if (!r.ready) { results.push({ ...base, outcome: 'Skipped', reason: r.message || r.chip }); delta.skipped += 1; continue; }
    if (r.will === 'keep') { results.push({ ...base, outcome: 'Skipped', reason: 'Kept the link the client already has.' }); delta.skipped += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      await addOne(user, r, { runId: via === 'bulk' ? runId : null, via, rights });
      if (r.will === 'replace') { delta.replaced += 1; results.push({ ...base, outcome: 'Replaced', reason: 'The old link is kept in history.' }); } else { delta.added += 1; results.push({ ...base, outcome: 'Added', reason: '' }); }
    } catch (err) {
      delta.skipped += 1; results.push({ ...base, outcome: 'Skipped', reason: 'Could not be saved. Please try this line again.' });
      // eslint-disable-next-line no-console
      console.error('[agreement links] line', r.row, err && err.message);
    }
  }
  if (runId) await bumpRun(user, runId, delta);
  return { results, summary: { added: delta.added, replaced: delta.replaced, skipped: delta.skipped, lines: rows.length } };
}

// ---- one client ---------------------------------------------------------------------------------------
async function forClient(user, client) {
  const rights = await rightsOf(user);
  const canSee = canSeeFor(rights.viewMode, user, client);
  const owns = CL.ownsClient(user, client);
  const base = {
    canSee, canAdd: rights.canAdd && owns, canMarkSigned: rights.canMarkSigned && owns, canRemove: rights.canRemove, why: rights.canAdd && !owns ? 'This client is not yours.' : rights.why,
  };
  if (!canSee) return { ...base, current: null, history: [] };
  const xs = await docsWithMeta({ clientId: client.id });
  const act = xs.filter(isActive);
  return { ...base, current: act[0] ? shapeLink(act[0]) : null, history: xs.filter((x) => !isActive(x)).map((x) => shapeLink(x)) };
}
// the client ids that have a CURRENT link, for the Agreements list chip
async function summaryFor(user) {
  const rights = await rightsOf(user);
  if (!rights.viewMode) return { canSee: false, rows: [] };
  const xs = (await docsWithMeta({ client: scope.clientWhere(user) })).filter(isActive);
  const seen = new Set(); const rows = [];
  const own = new Set(scope.atsScopeOf(user).bdeOwnClientIds || []);
  xs.forEach((x) => {
    if (seen.has(x.doc.clientId)) return;
    if (rights.viewMode === 'own' && !own.has(x.doc.clientId)) return;
    seen.add(x.doc.clientId);
    rows.push({ clientId: x.doc.clientId, host: hostOf(hrefOf(x.doc)), label: x.doc.fileName || 'Google Drive', addedAt: x.doc.createdAt, addedByName: x.doc.uploadedByName || null, signedCopy: !!x.meta.signedCopy });
  });
  return { canSee: true, rows };
}

// Admin / SA: take a link away. Soft: the row stays as history ("Removed").
async function removeLink(user, client, docId, reason) {
  const doc = await prisma.clientDocument.findFirst({ where: { id: docId, clientId: client.id, kind: KIND } });
  if (!doc) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: metaKey(doc.id) } });
  // Taking away a link that is already removed changes nothing: the first removal (who, when, why) and its one audit row stay as they were.
  if (row && parseMeta(row).removedAt) return doc;
  const next = { ...(row ? parseMeta(row) : {}), removedAt: new Date().toISOString(), removedByName: user.name || null, removedById: user.id, removedReason: clip(reason, 300) || null };
  await prisma.appSetting.upsert({
    where: { key: metaKey(doc.id) }, create: { key: metaKey(doc.id), value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
    update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
  });
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Agreement Drive link removed', entity: 'Client', entityId: client.id, fieldLabel: 'Agreement Drive link', fromValue: hostOf(hrefOf(doc)), reason: clip(reason, 300) || null });
  return doc;
}
async function setSignedCopy(user, client, docId, value) {
  const doc = await prisma.clientDocument.findFirst({ where: { id: docId, clientId: client.id, kind: KIND } });
  if (!doc) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: metaKey(doc.id) } });
  const m = row ? parseMeta(row) : {};
  if (m.removedAt || m.supersededAt) return false;
  const next = value ? { ...m, signedCopy: true, signedCopyByName: user.name || null, signedCopyAt: new Date().toISOString() } : { ...m, signedCopy: false, signedCopyByName: null, signedCopyAt: null };
  await prisma.appSetting.upsert({
    where: { key: metaKey(doc.id) }, create: { key: metaKey(doc.id), value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
    update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null },
  });
  await logAudit({ userId: user.id, actorName: user.name || null, action: value ? 'Agreement Drive link marked as signed copy' : 'Agreement Drive link signed-copy mark removed', entity: 'Client', entityId: client.id, fieldLabel: 'Agreement Drive link', toValue: hostOf(hrefOf(doc)) });
  return doc;
}

module.exports = {
  KIND, KIND_LABEL, MAX_LINES, PREFIX, HOST_NAMES, validateLink, parseDate, parseText, normName, similarity, resolveRef, buildIndex,
  rightsOf, viewMode, canSeeFor, evaluate, indexFromRows, fileToText, CLIENT_FIELDS, CHIP, check, apply, runTotal, forClient, summaryFor, removeLink, setSignedCopy,
  docsWithMeta, isActive, isLinkDoc, shapeLink, metaKey, parseMeta, hrefOf, hostOf, flat,
};

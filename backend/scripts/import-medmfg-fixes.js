/* eslint-disable no-console, no-await-in-loop, no-continue */
// ---------------------------------------------------------------------------
// MEDICAL / MANUFACTURING FIXES — stage 2 of the Sep-2026 file audit.
//
//   node scripts/import-medmfg-fixes.js                    dry run (default)
//   node scripts/import-medmfg-fixes.js --commit           write
//   options   --steps=1,2,4      run only these steps
//             --out=<file.json>  also write the full report (every list)
//             --dir=<folder>     where the source .xlsx files are
//                                (default C:/Users/user/Downloads/)
//
// Approved by the user, and nothing else:
//
//   1  AGREEMENTS. Signed responses ("All Signed Agreements") -> the matched
//      client's agreement becomes ACTIVE with its fee %, agreement date and
//      replacement period. Duplicate responses: the latest wins. A charge that
//      is not one clean % of CTC (flat amount, "one month salary", tiered)
//      stays as text in commercialNotes. Unmatched / weak names are LISTED,
//      never created. Then the Medical "Client Follow Up Sheet" and the
//      "Manufacture Client Follow Up" sheet: activate + terms + status +
//      contacts, never overwriting a field the signed sheet set.
//      VOXTBV INDIA is created only because both sheets call it Manufacturing.
//   2  CLOSE the requirements the "Stopped" tabs mark stopped and the DB still
//      has open. Candidates / history untouched.
//   3  IMPORT "Medical Interview sheet update" (Jan–Feb 2025). "Jan-24" dates
//      among 2025 rows are Jan 2025. A person who already exists as ONE
//      phoneless BDE-medical candidate of the same name gets this phone
//      instead of a duplicate. One stage event + one completed follow-up per
//      row, tagged 'Imported — Medical interview sheet Jan-2025'. Recruiters /
//      TLs not mapped for certain stay as text with no user link.
//   4  RE-TITLE the Medical requirements whose title is a seat code ("BDE
//      MED", "MED 1", "Med 3", "Dilip" …) from the designation on the rows
//      that created them; where a properly titled requirement for the same
//      client + designation + specialisation exists, MERGE into it and close
//      the emptied one.
//   5  APPLY the Manufacturing Schedule Sheet's unheaded status column (P) to
//      the applications it describes. Stage event for every change.
//   6  MERGE the Medical candidates that exist twice — once with a phone, once
//      without — when the normalised full names match exactly, both sides have
//      Medical applications, there is exactly one record on each side and no
//      conflicting email. Keep the phone record; move applications,
//      follow-ups, stage events, notes, documents, messages; fill blanks;
//      delete the empty duplicate; one audit row per merge.
//
// RUN ORDER is 1, 2, 4, 3, 5, 6: the re-titling (4) runs before the interview
// sheet import (3) so the new applications land on the corrected requirements,
// and the duplicate merge (6) runs last so it sees the phones step 3 added.
//
// The whole database is read once into memory; every step updates that model
// in the dry run too, so the dry-run counts are the counts --commit writes.
// Writes go straight through Prisma (no routes), so no notification fires.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.chdir(path.join(__dirname, '..'));
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { nkey, tidyName, mapStatus, preferred } = require('../src/utils/importNormalise');
const { normalizeAgreementStatus } = require('../src/utils/atsVocab');

const ARGS = process.argv.slice(2);
const COMMIT = ARGS.includes('--commit');
const argVal = (k) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const STEPS = new Set((argVal('steps') || '1,2,3,4,5,6').split(',').map(Number));
const OUT = argVal('out');
const DIR = argVal('dir') || 'C:/Users/user/Downloads/';
const FILES = {
  agreements: 'All Signed Agreements (Responses) (3).xlsx',
  bdeMed: 'BDE MED Worksheet (1).xlsx',
  mfgFollowUp: 'Manufacture Client Follow Up   (2).xlsx',
  medReqs: 'Medical team requirements sheet (2) (1).xlsx',
  mfgReqs: 'ManuFacture Requirements  Sheet (1) (1).xlsx',
  medInterview: 'Medical Interview sheet update (1).xlsx',
};
const TAG = 'Imported — Med/Mfg fixes Sep-2026';
const F3_TAG = 'Imported — Medical interview sheet Jan-2025';
const F3_SOURCE = 'Medical interview sheet Jan-2025';
const ACTIVE = normalizeAgreementStatus('ACTIVE');

// ============================================================================
// helpers
// ============================================================================
const t = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const lc = (v) => t(v).toLowerCase();
const compact = (s) => lc(s).replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const mask = (p) => (p ? `xxxxxx${String(p).slice(-4)}` : '');
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const titleCase = (s) => t(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const years = (v) => { const m = lc(v).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const pk = (c, r) => `${c}|${r}`;
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

function phonesAll(v) {
  const s = String(v || '');
  const out = [];
  s.split(/[/,;\n]|\s{2,}/).forEach((p) => { const d = p.replace(/\D/g, ''); if (d.length >= 10 && d.length <= 13) out.push(d.slice(-10)); });
  const whole = s.replace(/\D/g, '');
  if (!out.length && whole.length >= 20) { for (let i = 0; i + 10 <= whole.length; i += 10) out.push(whole.slice(i, i + 10)); }
  if (!out.length && whole.length >= 10) out.push(whole.slice(-10));
  return [...new Set(out)];
}
const hasPhone = (c) => phonesAll(c.phone).length > 0;
const hasEmail = (c) => /@/.test(String(c.email || ''));

// A person's name for "is this the same person": lower case, a leading
// Dr/Mr/Mrs/Ms dropped, letters only.
const personKey = (s) => lc(s).replace(/^(dr|mr|mrs|ms|miss)\b\.?\s*/, '').replace(/[^a-z]/g, '');
const nameWords = (s) => lc(s).replace(/^(dr|mr|mrs|ms|miss)\b\.?\s*/, '').split(/[^a-z]+/).filter((w) => w.length >= 3);

// ---- dates ------------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function ymd(y, mo, d) {
  let year = Number(y); if (year < 100) year += 2000;
  const month = Number(mo); const day = Number(d);
  if (year < 2015 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}
function serialIso(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 36000 || v > 55000) return null;
  const d = XLSX.SSF.parse_date_code(v);
  return d ? ymd(d.y, d.m, d.d) : null;
}
function textIso(v, { mdy = false } = {}) {
  const s = lc(v); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return ymd(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2})\s*[-/.]+\s*([a-z]{3,})\s*[-/.,]*\s*(\d{2,4})/); if (m && MONTHS[m[2].slice(0, 3)]) return ymd(m[3], MONTHS[m[2].slice(0, 3)], m[1]);
  m = s.match(/^(\d{1,2})\s*[-/.]+\s*(\d{1,2})\s*[-/.]+\s*(\d{2,4})$/); if (m) return mdy ? ymd(m[3], m[1], m[2]) : ymd(m[3], m[2], m[1]);
  return null;
}
const dateOf = (raw, txt, opts) => serialIso(raw) || textIso(txt, opts);
const at = (iso, hh = '09') => new Date(`${iso}T${hh}:00:00Z`);

// ---- workbooks --------------------------------------------------------------
const wbCache = new Map();
function wb(file) { if (!wbCache.has(file)) wbCache.set(file, XLSX.readFile(DIR + file, { cellDates: false })); return wbCache.get(file); }
function grid(file, sheet, { raw = false, merges = false } = {}) {
  const ws = wb(file).Sheets[sheet];
  if (!ws) throw new Error(`${file}: no sheet "${sheet}"`);
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw, blankrows: true });
  if (merges) {
    (ws['!merges'] || []).forEach((m) => {
      const v = g[m.s.r] && g[m.s.r][m.s.c];
      for (let r = m.s.r; r <= m.e.r; r += 1) for (let c = m.s.c; c <= m.e.c; c += 1) if (g[r] && (g[r][c] === '' || g[r][c] == null)) g[r][c] = v;
    });
  }
  return g;
}
const headIx = (head) => (...names) => { for (const n of names) { const i = head.findIndex((h) => compact(h) === compact(n)); if (i >= 0) return i; } return -1; };

// ---- client names (the audit's matcher, unchanged) --------------------------
const SPELLING = [[/\bv\s*a?\s*care\b/g, 'vcare'], [/\bclinin?c\b/g, 'clinic'], [/\bhydrabad\b|\bhyd\b/g, 'hyderabad'], [/\bkukatpallu\b/g, 'kukatpally'], [/\bcollage\b/g, 'college'], [/\bbanglore\b/g, 'bangalore'], [/\bsrikalahsthi\b|\bsrikalshathi\b/g, 'srikalahasthi'], [/\bbanjarhills\b|\bbanjara hills\b/g, 'banjarahills'], [/\bmanglore\b/g, 'mangalore'], [/\bvijawada\b/g, 'vijayawada'], [/\bbelagum\b/g, 'belgaum'], [/\bkarantaka\b/g, 'karnataka'], [/\btelengana\b/g, 'telangana'], [/\banatara\b/g, 'antara'], [/\bassociated\b/g, 'assisted'], [/\bservice\b/g, 'services'], [/\bhospitals\b/g, 'hospital']];
const DROP = /\b(pvt|private|ltd|limited|llp|the|and|health|care|hospitals?|clinic|mbbs|india|telangana|hyderabad|full ?time|part ?time|time|full|part|co|company|inc|corp)\b/g;
function normName(s) { let x = lc(s).replace(/[^a-z0-9 ]+/g, ' '); SPELLING.forEach(([re, to]) => { x = x.replace(re, to); }); return x.replace(DROP, ' ').replace(/\s+/g, ' ').trim(); }
const tokens = (s) => new Set(normName(s).split(' ').filter(Boolean));
function jaccard(A, B) { const inter = [...A].filter((w) => B.has(w)).length; return inter / (new Set([...A, ...B]).size || 1); }
function lev(a, b) {
  if (a === b) return 0; const m = a.length; const n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) { const cur = [i]; for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
// Spelling-tolerant word equality ("Laprascopic" = "Laparoscopic"), used only
// to SUGGEST candidates and for the interview sheet's misspelt hospitals.
const wordEq = (x, y) => x === y || (Math.min(x.length, y.length) >= 5 && lev(x, y) <= (Math.max(x.length, y.length) >= 9 ? 2 : 1));
function looseScore(a, b) {
  const A = [...tokens(a)]; const Bt = [...tokens(b)]; if (!A.length || !Bt.length) return 0;
  const used = new Set(); let hit = 0;
  A.forEach((w) => { const j = Bt.findIndex((v, i) => !used.has(i) && wordEq(w, v)); if (j >= 0) { used.add(j); hit += 1; } });
  // a record carrying every word of the name (its branch included) beats one
  // that merely shares most of them — the same bonus the audit matcher gives
  return hit / (A.length + Bt.length - hit) + (hit === A.length ? 0.2 : 0);
}

// ---- stages -----------------------------------------------------------------
const STAGE_ACTION = {
  JOINED: 'Joined', REJECTED: 'Rejected', HOLD: 'Put on hold', SELECTED: 'Selected', OFFER: 'Offer',
  OFFER_ACCEPTED: 'Offer accepted', INTERVIEW_COMPLETED: 'Interview completed', INTERVIEW_SCHEDULED: 'Interview scheduled',
  CLIENT_SHORTLISTED: 'Client shortlisted', SHARED_WITH_CLIENT: 'Shared with client', RECRUITER_REVIEW: 'Recruiter review', NEW: 'Added',
};
// "More advanced" when two applications become one (steps 3, 4, 6): further
// along the pipeline wins; a rejection is further than any open stage but
// never beats a selection, an offer or a joining.
const ADV = { NEW: 0, RECRUITER_REVIEW: 1, SHARED_WITH_CLIENT: 2, CLIENT_SHORTLISTED: 3, INTERVIEW_SCHEDULED: 4, INTERVIEW_COMPLETED: 5, HOLD: 5, REJECTED: 6, SELECTED: 7, OFFER: 8, OFFER_ACCEPTED: 9, JOINED: 10 };
const adv = (s) => (ADV[s] === undefined ? 0 : ADV[s]);
// Step 5 uses the audit's rank, in which a rejection outranks everything.
const AUDIT_RANK = { NEW: 0, RECRUITER_REVIEW: 1, SHARED_WITH_CLIENT: 2, CLIENT_SHORTLISTED: 3, INTERVIEW_SCHEDULED: 4, INTERVIEW_COMPLETED: 5, HOLD: 5, SELECTED: 6, OFFER: 7, OFFER_ACCEPTED: 8, JOINED: 9, REJECTED: 10 };

// The Reject dialog's own lists (utils/importSpec.js REJECTION_REASONS_BY_SIDE).
const CANDIDATE_SIDE = [
  [/did ?n.?t join|not join|wont join|won.?t join|not joining/, 'Did Not Join'],
  [/dropp/, 'Offer Declined'],
  [/not ok with (the )?package|less salary|expect|need \d|not accept|salary/, 'Salary Expectation'],
  [/location|far|relocat|accomodation|accommodation|shift from|non local/, 'Location / Relocation'],
  [/got (a job )?in other|another|other hospital|other offer/, 'Accepted Another Offer'],
  [/not interested|not wil+ing|rejected by candidate|bond/, 'Not Interested'],
  [/not attended|did not attend|no show/, 'Did Not Attend Interview'],
  [/not answer|not respond|not reachable|switch(ed)? off/, 'Not Reachable'],
];
const CLIENT_SIDE = [
  [/communication/, 'Communication'],
  [/fresher|experience|not upto|clinical|basic computer|dnb/, 'Insufficient Experience'],
  [/not shortlisted|profile (is )?rejected|not having/, 'Not Shortlisted'],
];
const classify = (text, table, fallback) => (table.find(([re]) => re.test(text)) || [null, fallback])[1];

// ============================================================================
// state — everything read once
// ============================================================================
const S = {};
const report = { mode: COMMIT ? 'COMMIT' : 'DRY RUN', steps: {} };

async function load() {
  const [clients, reqs, cands, apps, emps, positions, invs, users] = await Promise.all([
    prisma.client.findMany(),
    prisma.requirement.findMany({ select: { id: true, clientId: true, title: true, department: true, reqCode: true, status: true, specialisation: true, positionCode: true, description: true, createdAt: true } }),
    prisma.candidate.findMany(),
    prisma.application.findMany(),
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, employmentStatus: true, department: true, user: { select: { id: true, status: true } } } }),
    prisma.position.findMany({ select: { id: true, code: true } }),
    prisma.invoice.findMany({ select: { id: true, requirementId: true, candidateId: true } }),
    prisma.user.findMany({ where: { candidateId: { not: null } }, select: { candidateId: true } }),
  ]);
  Object.assign(S, { clients, reqs, cands, apps, emps, positions });
  S.clientById = new Map(clients.map((c) => [c.id, c]));
  S.reqById = new Map(reqs.map((r) => [r.id, r]));
  S.reqsByClient = new Map(); reqs.forEach((r) => push(S.reqsByClient, r.clientId, r));
  S.candById = new Map(cands.map((c) => [c.id, c]));
  S.byPhone = new Map(); cands.forEach((c) => phonesAll(c.phone).forEach((p) => push(S.byPhone, p, c)));
  S.byRef = new Map(); cands.forEach((c) => { if (c.externalRef) push(S.byRef, c.externalRef, c); });
  S.appById = new Map(); S.appByPair = new Map(); S.appsByCand = new Map(); S.appsByReq = new Map();
  apps.forEach(idxAdd);
  S.posByCode = new Map(positions.map((p) => [p.code, p]));
  S.invReq = new Set(invs.map((i) => i.requirementId).filter(Boolean));
  S.invCand = new Set(invs.map((i) => i.candidateId).filter(Boolean));
  S.userCand = new Set(users.map((u) => u.candidateId));
  buildClientIndex();
  let seq = 0; reqs.forEach((r) => { const m = /^REQ-(\d+)$/.exec(r.reqCode || ''); if (m) seq = Math.max(seq, Number(m[1])); });
  S.reqSeq = seq;
  S.dryId = 0;
}
function idxAdd(a) {
  S.appById.set(a.id, a); S.appByPair.set(pk(a.candidateId, a.requirementId), a);
  push(S.appsByCand, a.candidateId, a); push(S.appsByReq, a.requirementId, a);
}
function idxDel(a) {
  S.appById.delete(a.id);
  if (S.appByPair.get(pk(a.candidateId, a.requirementId)) === a) S.appByPair.delete(pk(a.candidateId, a.requirementId));
  const rm = (m, k) => { const l = m.get(k); if (l) { const i = l.indexOf(a); if (i >= 0) l.splice(i, 1); } };
  rm(S.appsByCand, a.candidateId); rm(S.appsByReq, a.requirementId);
}
function buildClientIndex() {
  S.cCompact = new Map(); S.cNorm = new Map();
  S.clients.forEach((c) => [c.name, c.legalName].filter(Boolean).forEach((n) => {
    const k = compact(n); if (k && !S.cCompact.has(k)) S.cCompact.set(k, c);
    const k2 = normName(n); if (k2 && !S.cNorm.has(k2)) S.cNorm.set(k2, c);
  }));
  S.clientTok = S.clients.map((c) => ({ c, tok: tokens(c.name) }));
}
function matchClient(name, deptPref) {
  const n = t(name); if (!n) return { how: 'blank' };
  let c = S.cCompact.get(compact(n)); if (c) return { how: 'exact', c };
  c = S.cNorm.get(normName(n)); if (c && normName(n)) return { how: 'norm', c };
  const mine = tokens(n); const first = [...mine][0]; let best = null; let bs = 0;
  S.clientTok.forEach(({ c: x, tok }) => { if ([...tok][0] !== first) return; const sc = jaccard(mine, tok) + ([...mine].every((w) => tok.has(w)) ? 0.2 : 0) + (deptPref && x.ownerDepartment === deptPref ? 0.01 : 0); if (sc > bs) { bs = sc; best = x; } });
  if (best && bs >= 0.75) return { how: 'fuzzy', c: best, score: bs };
  const base = n.split(/[,(\n]/)[0]; const cb = S.cNorm.get(normName(base));
  if (cb && normName(base)) return { how: 'fuzzy', c: cb, score: 0.7 };
  if (best && bs >= 0.5) return { how: 'weak', c: best, score: bs };
  return { how: 'new' };
}
// Top-N DB clients for a name the matcher could not place — for the user.
function suggestClients(name, n = 3) {
  const mine = tokens(name);
  return S.clients.map((c) => ({ c, s: Math.max(jaccard(mine, tokens(c.name)), looseScore(name, c.name)) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n)
    .map((x) => `${x.c.name} [${x.c.ownerDepartment || '-'}] ${x.s.toFixed(2)}`);
}

// ---- writes -----------------------------------------------------------------
const tx = (fn) => (COMMIT ? prisma.$transaction(fn, { timeout: 120000, maxWait: 30000 }) : fn(null));
const newId = () => { S.dryId += 1; return `dry-${S.dryId}`; };
const APP_SKIP = new Set(['id', 'candidateId', 'requirementId', 'stage', 'createdAt', 'updatedAt']);
const CAND_SKIP = new Set(['id', 'createdAt', 'name', 'phone', 'source']);
function blanksFrom(keeper, donor, skip) {
  const fill = {};
  Object.keys(donor).forEach((k) => { if (!skip.has(k) && blank(keeper[k]) && !blank(donor[k])) fill[k] = donor[k]; });
  return fill;
}

// Put application `a` on (toCand, toReq). If that pair already has an
// application the two become one: the more advanced stage is kept, the other's
// follow-ups, stage events, interview records, notes and messages move onto it,
// its blank fields are filled, and the emptied one is deleted.
async function moveApplication(txc, a, toCand, toReq) {
  const other = S.appByPair.get(pk(toCand, toReq));
  const toReqObj = S.reqById.get(toReq);
  if (other && other.id !== a.id) {
    const keeper = adv(a.stage) > adv(other.stage) ? a : other;
    const loser = keeper === a ? other : a;
    const fill = blanksFrom(keeper, loser, APP_SKIP);
    if (loser.createdAt && keeper.createdAt && loser.createdAt < keeper.createdAt) fill.createdAt = loser.createdAt;
    const keeperReqChanged = keeper.requirementId !== toReq;
    if (txc) {
      await txc.applicationFollowUp.updateMany({ where: { applicationId: loser.id }, data: { applicationId: keeper.id, candidateId: toCand, requirementId: toReq } });
      await txc.applicationStageEvent.updateMany({ where: { applicationId: loser.id }, data: { applicationId: keeper.id, candidateId: toCand, requirementId: toReq, requirementTitle: toReqObj.title } });
      await txc.interviewEvent.updateMany({ where: { applicationId: loser.id }, data: { applicationId: keeper.id } });
      const kinds = (await txc.interviewFeedback.findMany({ where: { applicationId: keeper.id }, select: { kind: true } })).map((x) => x.kind);
      await txc.interviewFeedback.updateMany({ where: { applicationId: loser.id, kind: { notIn: kinds } }, data: { applicationId: keeper.id } });
      await txc.candidateMessage.updateMany({ where: { applicationId: loser.id }, data: { applicationId: keeper.id } });
      await txc.candidateNote.updateMany({ where: { applicationId: loser.id }, data: { applicationId: keeper.id } });
      await txc.application.delete({ where: { id: loser.id } });
      await txc.application.update({ where: { id: keeper.id }, data: { ...fill, candidateId: toCand, requirementId: toReq } });
      await txc.applicationFollowUp.updateMany({ where: { applicationId: keeper.id }, data: { candidateId: toCand, requirementId: toReq } });
      await txc.applicationStageEvent.updateMany({ where: { applicationId: keeper.id }, data: keeperReqChanged ? { candidateId: toCand, requirementId: toReq, requirementTitle: toReqObj.title } : { candidateId: toCand } });
    }
    idxDel(loser); idxDel(keeper);
    Object.assign(keeper, fill, { candidateId: toCand, requirementId: toReq });
    idxAdd(keeper);
    return { clash: true, keeper, loser };
  }
  const reqChanged = a.requirementId !== toReq;
  if (txc) {
    await txc.application.update({ where: { id: a.id }, data: { candidateId: toCand, requirementId: toReq } });
    await txc.applicationFollowUp.updateMany({ where: { applicationId: a.id }, data: { candidateId: toCand, requirementId: toReq } });
    await txc.applicationStageEvent.updateMany({ where: { applicationId: a.id }, data: reqChanged ? { candidateId: toCand, requirementId: toReq, requirementTitle: toReqObj.title } : { candidateId: toCand } });
  }
  idxDel(a); a.candidateId = toCand; a.requirementId = toReq; idxAdd(a);
  return { clash: false, keeper: a };
}

// ============================================================================
// STEP 1 — agreements + client follow-up sheet terms
// ============================================================================
// The fee as a % of annual CTC — only when the text states exactly one rate.
// GST's 18% is not a fee; a month-salary basis is not a % of annual CTC.
function feeOf(raw, text) {
  if (typeof raw === 'number') {
    if (!(raw > 0 && raw < 1)) return { flat: true };
    const v = Math.round(raw * 10000) / 100;
    return v > 15 ? { odd: v } : { fee: v };
  }
  const s = lc(text); if (!s) return {};
  if (/no agreement|not found|vasu sir/.test(s)) return {};
  const noGst = s.replace(/(\+|and)?\s*(gst)?\s*18\s*"?\s*%?\s*(gst)/g, ' ').replace(/gst\s*[-(]?\s*18\s*%/g, ' gst ');
  const pcts = [...noGst.matchAll(/(\d+(?:\.\s?\d+)?)\s*%/g)].map((m) => Number(m[1].replace(/\s/g, '')));
  const bare = noGst.match(/^\s*(\d{1,2}(?:\.\d+)?)\s*(\+|$|\(|without)/);
  if (bare) pcts.unshift(Number(bare[1]));
  let distinct = [...new Set(pcts.filter((x) => x > 0))];
  if (distinct.length > 1 && distinct.includes(18)) distinct = distinct.filter((x) => x !== 18); // "8.33+18%" — the 18 is GST
  if (/month(ly)?\s*(salary|ctc|fixed)|month of the candi|days of candidate/.test(s)) return { text: true, tiered: distinct.length > 1 };
  if (!distinct.length) return { flat: true };
  if (distinct.length > 1) return { tiered: true };
  if (distinct[0] > 15) return { odd: distinct[0] };
  return { fee: distinct[0] };
}
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, '1': 1 };
function replacementOf(text) {
  const s = lc(text); if (!s || /no agreement/.test(s) || s === '.') return null;
  if (/^no\b|no replacement/.test(s)) return 'No replacement';
  const found = [...s.matchAll(/(\d+|one|two|three|four|five|six)\s*-?\s*(months?|years?|days)/g)];
  const vals = [...new Set(found.map((m) => `${NUMW[m[1]] || Number(m[1])} ${m[2].startsWith('day') ? 'Days' : m[2].startsWith('year') ? 'Year' : 'Month'}`))];
  if (vals.length === 1) { const [n, u] = vals[0].split(' '); return u === 'Days' ? `${n} Days` : `${n} ${u}${Number(n) > 1 ? 's' : ''}`; }
  return null;
}
function replacementInCharges(text) {
  const s = lc(text);
  const m = s.match(/(\d+|one|two|three|four|six)\s*-?\s*(months?|days)\s*(of\s*)?(candidate\s*|candiadtes\s*)?(free\s*)?replac/) || s.match(/(\d+|one|two|three|four|six)\s*-?\s*(months?|days)\s*replacement/);
  if (!m) return null;
  const n = NUMW[m[1]] || Number(m[1]);
  return m[2].startsWith('day') ? `${n} Days` : `${n} Month${n > 1 ? 's' : ''}`;
}
const clientStatusOf = (s) => { const k = lc(s); if (/running/.test(k)) return 'Active'; if (/stop/.test(k)) return 'Inactive'; if (/hold/.test(k)) return 'Suspended'; if (/no requirement/.test(k)) return 'Inactive'; return null; };
// Replace the line starting with `prefix` in place (append when absent), so a
// re-run leaves the notes exactly as they are.
function setNoteLine(notes, prefix, line) {
  const lines = String(notes || '').split('\n').filter(Boolean);
  const i = lines.findIndex((x) => x.startsWith(prefix));
  if (i >= 0) lines[i] = line; else lines.push(line);
  return lines.filter((x, j) => j === i || i < 0 || !x.startsWith(prefix)).join('\n');
}

async function step1() {
  const R = { signedRows: 0, signedRowsMatched: 0, clientsActivated: 0, byDept: {}, feeSet: 0, feeKeptAsText: [], startSet: 0, guaranteeSet: 0, dateFixes: [], duplicates: [], latestNotSigned: [], unmatched: [], weak: [], created: [], cfu: { medical: {}, manufacturing: {} }, statusMap: { Running: 'Active', Stopped: 'Inactive', 'On Hold': 'Suspended', 'No Requirement': 'Inactive' }, samples: [] };
  report.steps['1_agreements'] = R;
  const planned = new Map(); // clientId -> { data, setBySigned:Set, name, from }

  // ---- VOXTBV: create only if BOTH the signed response and the Mfg follow-up
  // sheet call it Manufacturing.
  const agrRaw = grid(FILES.agreements, 'Form Responses 1', { raw: true });
  const agrTxt = grid(FILES.agreements, 'Form Responses 1');
  const mfgTxt = grid(FILES.mfgFollowUp, 'Manufacture Client Follow Up ');
  const voxAgr = agrTxt.findIndex((r) => /voxtbv/i.test(r[1]));
  const voxMfg = mfgTxt.findIndex((r) => /voxtbv/i.test(r[0]));
  if (voxAgr > 0 && voxMfg > 0 && /manufactur/i.test(agrTxt[voxAgr][16]) && !matchClient(agrTxt[voxAgr][1], 'Manufacturing').c) {
    const name = t(agrTxt[voxAgr][1]);
    const data = { name, ownerDepartment: 'Manufacturing', industry: 'Manufacturing', location: t(agrTxt[voxAgr][2]) || null, status: 'Active', clientType: 'Direct' };
    const made = COMMIT ? await prisma.client.create({ data }) : { id: newId(), ...data, agreementStatus: 'DRAFT', agreementFeePercent: 8.33 };
    S.clients.push(made); S.clientById.set(made.id, made); buildClientIndex();
    R.created.push(`${name} (Manufacturing; in the signed responses as Manufacturing and on the Manufacture Client Follow Up sheet)`);
  }

  // ---- signed responses
  const rows = [];
  for (let r = 1; r < agrTxt.length; r += 1) {
    const x = agrTxt[r]; const raw = agrRaw[r];
    if (!x.some((c) => t(c))) continue;
    const industry = t(x[16]);
    const o = { line: r + 1, tsNum: typeof raw[0] === 'number' ? raw[0] : 0, ts: serialIso(raw[0]), client: t(x[1]), loc: t(x[2]), charges: t(x[3]), chargesRaw: raw[3], repl: t(x[4]), dept: /medical/i.test(industry) ? 'Medical' : industry, signedLink: /^https?:/.test(t(x[18])), remarks: t(x[21]) };
    o.agr = dateOf(raw[6], x[6], { mdy: true }) || textIso(x[6]);
    if (o.agr && o.ts && o.agr > o.ts) {
      const [y, m, d] = o.agr.split('-').map(Number);
      const sw = d <= 12 ? ymd(y, d, m) : null;
      if (sw && sw <= o.ts) { R.dateFixes.push(`line ${o.line} ${o.client}: agreement date ${o.agr} is after the response (${o.ts}); day/month swapped -> ${sw}`); o.agr = sw; }
      else R.dateFixes.push(`line ${o.line} ${o.client}: agreement date ${o.agr} is after the response (${o.ts}); kept`);
    }
    o.noAgr = /no agreement/i.test(o.charges) || /no agreement/i.test(o.remarks) || /no agreement/i.test(o.repl);
    o.signed = o.signedLink && !o.noAgr;
    rows.push(o);
  }
  const rowsByClient = new Map();
  rows.forEach((o) => {
    if (!o.client) return;
    const m = matchClient(o.client + (o.loc && !lc(o.client).includes(lc(o.loc).split(/[ ,]/)[0]) ? `, ${o.loc}` : ''), o.dept);
    let mm = m; if (!m.c || m.how === 'weak') { const m2 = matchClient(o.client, o.dept); if (m2.c && m2.how !== 'weak') mm = m2; }
    o.match = mm;
    if (mm.c && mm.how !== 'weak') push(rowsByClient, mm.c.id, o);
  });
  R.blankClientLines = rows.filter((o) => !o.client).map((o) => o.line);
  rows.filter((o) => o.signed && o.client).forEach((o) => {
    R.signedRows += 1;
    if (!o.match.c) R.unmatched.push({ sheetName: o.client, dept: o.dept, location: o.loc, line: o.line, best: suggestClients(o.client) });
    else if (o.match.how === 'weak') R.weak.push({ sheetName: o.client, dept: o.dept, line: o.line, weakMatch: `${o.match.c.name} (${o.match.score.toFixed(2)})`, best: suggestClients(o.client) });
    else R.signedRowsMatched += 1;
  });
  rows.filter((o) => !o.signed && o.client && (!o.match.c || o.match.how === 'weak')).forEach((o) => {
    const entry = { sheetName: o.client, dept: o.dept, location: o.loc, line: o.line, noAgreement: true, best: suggestClients(o.client) };
    if (o.match.c) R.weak.push({ ...entry, weakMatch: `${o.match.c.name} (${o.match.score.toFixed(2)})` }); else R.unmatched.push(entry);
  });

  for (const [clientId, list] of rowsByClient) {
    const signed = list.filter((o) => o.signed);
    if (!signed.length) continue;
    const latestAny = [...list].sort((a, b) => b.tsNum - a.tsNum || b.line - a.line)[0];
    const o = [...signed].sort((a, b) => b.tsNum - a.tsNum || b.line - a.line)[0];
    const c = S.clientById.get(clientId);
    if (list.length > 1) R.duplicates.push(`${c.name}: lines ${list.map((x) => x.line).join(', ')} -> line ${o.line} (${o.ts}) used`);
    if (latestAny !== o) R.latestNotSigned.push(`${c.name}: latest response line ${latestAny.line} says "${latestAny.charges}"; the latest SIGNED one (line ${o.line}) was applied`);
    const data = { agreementStatus: ACTIVE };
    const setBy = new Set(['agreementStatus']);
    if (o.agr) { data.agreementStart = o.agr; data.agreementSignedAt = at(o.agr, '00'); data.agreementActivatedAt = at(o.agr, '00'); ['agreementStart', 'agreementSignedAt', 'agreementActivatedAt'].forEach((k) => setBy.add(k)); }
    const f = feeOf(o.chargesRaw, o.charges);
    if (f.fee != null) { data.agreementFeePercent = f.fee; setBy.add('agreementFeePercent'); } else R.feeKeptAsText.push(`${c.name}: "${o.charges}"${f.tiered ? ' (several rates)' : f.odd ? ` (${f.odd}% — likely GST, not a fee)` : ''}`);
    const g = replacementOf(o.repl);
    if (g) { data.guaranteePeriod = g; setBy.add('guaranteePeriod'); } else if (t(o.repl) && t(o.repl) !== '.') { data.guaranteePeriod = t(o.repl).slice(0, 80); setBy.add('guaranteePeriod'); }
    const chargeText = typeof o.chargesRaw === 'number' && o.chargesRaw < 1 ? `${Math.round(o.chargesRaw * 10000) / 100}%` : o.charges;
    data.commercialNotes = setNoteLine(c.commercialNotes, 'Signed agreement:', `Signed agreement: charges ${chargeText || '-'}; replacement ${t(o.repl) || '-'}; agreement date ${o.agr || '-'} (All Signed Agreements form, response ${o.ts || '-'})`);
    planned.set(clientId, { data, setBy, c, line: o.line });
    bump(R.byDept, c.ownerDepartment || '(none)');
  }

  // ---- client follow-up sheets: fill what the signed sheet did not set
  const cfu = (file, sheet, spec, out) => {
    const gt = grid(file, sheet); const gr = grid(file, sheet, { raw: true });
    Object.assign(out, { rows: 0, matched: 0, unmatched: [], activated: 0, feeSet: 0, startSet: 0, statusSet: 0, contactsFilled: 0, secondaryContact: 0, guaranteeSet: 0, keptBySigned: 0, noDate: [], vasuConfirmation: [] });
    for (let r = 1; r < gt.length; r += 1) {
      const x = gt[r]; const raw = gr[r]; if (!t(x[0])) continue;
      out.rows += 1;
      const m = matchClient(x[0], spec.dept);
      if (!m.c || m.how === 'weak') { out.unmatched.push(t(x[0])); continue; }
      out.matched += 1;
      const c = m.c;
      const p = planned.get(c.id) || { data: {}, setBy: new Set(), c };
      const set = (k, v) => { if (v == null || v === '') return false; if (p.setBy.has(k)) { out.keptBySigned += 1; return false; } p.data[k] = v; return true; };
      const charges = t(x[spec.charges]);
      if (/vasu sir/i.test(charges) || /vasu sir/i.test(t(x[spec.agr]))) out.vasuConfirmation.push(c.name);
      if (/no agreement|not found/i.test(charges)) out.notActivated = [...(out.notActivated || []), `${c.name}: charges "${charges}"`];
      else if (set('agreementStatus', ACTIVE)) out.activated += 1;
      const f = feeOf(raw[spec.charges], charges); if (f.fee != null && set('agreementFeePercent', f.fee)) out.feeSet += 1;
      const d = dateOf(raw[spec.agr], x[spec.agr]);
      if (d) { if (set('agreementStart', d)) { out.startSet += 1; set('agreementSignedAt', at(d, '00')); set('agreementActivatedAt', at(d, '00')); } } else out.noDate.push(`${c.name}: "${t(x[spec.agr]).slice(0, 40)}"`);
      const g = replacementInCharges(charges); if (g && set('guaranteePeriod', g)) out.guaranteeSet += 1;
      // the LAST row for a client decides (unchanged values are dropped at write time)
      const st = clientStatusOf(x[spec.status]); if (st) { if (st !== c.status) out.statusSet += 1; p.data.status = st; }
      // contacts — blanks only; a different person already on file goes to secondary
      const person = t(x[spec.person]); const phone = phonesAll(x[spec.phone])[0] || null;
      const mail = (t(x[spec.mail]).split(/[\s,;]+/).find((w) => w.includes('@')) || null);
      const desig = t(x[spec.desig]) || null;
      const cur = { ...c, ...p.data };
      if (person || phone || mail) {
        const samePerson = !blank(cur.contactName) && person && nkey(cur.contactName) === nkey(person);
        if (blank(cur.contactName) || samePerson) {
          let n = 0;
          [['contactName', person], ['contactPhone', phone], ['contactEmail', mail], ['contactDesignation', desig]].forEach(([k, v]) => { if (v && blank(cur[k])) { p.data[k] = v; n += 1; } });
          if (n) out.contactsFilled += 1;
        } else if (blank(cur.secondaryContactName) && person) {
          [['secondaryContactName', person], ['secondaryContactPhone', phone], ['secondaryContactEmail', mail], ['secondaryContactDesignation', desig]].forEach(([k, v]) => { if (v) p.data[k] = v; });
          out.secondaryContact += 1;
        }
      }
      if (charges && !/(^|\n)Charges:/.test(cur.commercialNotes || '')) p.data.commercialNotes = setNoteLine(cur.commercialNotes, 'Charges:', `Charges: ${charges}`);
      planned.set(c.id, p);
    }
  };
  cfu(FILES.bdeMed, 'Client Follow Up Sheet', { dept: 'Medical', charges: 3, agr: 4, person: 6, phone: 7, desig: 8, mail: 9, status: 11 }, R.cfu.medical);
  cfu(FILES.mfgFollowUp, 'Manufacture Client Follow Up ', { dept: 'Manufacturing', charges: 2, agr: 3, person: 5, phone: 6, desig: 7, mail: 8, status: 10 }, R.cfu.manufacturing);

  // ---- write
  for (const [id, p] of planned) {
    const c = S.clientById.get(id);
    const data = {};
    Object.entries(p.data).forEach(([k, v]) => {
      const cur = c[k];
      const same = v instanceof Date ? (cur instanceof Date && cur.getTime() === v.getTime()) : cur === v;
      if (!same) data[k] = v;
    });
    if (!Object.keys(data).length) continue;
    if (data.agreementStatus && c.agreementStatus !== ACTIVE) R.clientsActivated += 1;
    if (data.agreementFeePercent != null) R.feeSet += 1;
    if (data.agreementStart) R.startSet += 1;
    if (data.guaranteePeriod) R.guaranteeSet += 1;
    if (R.samples.length < 4) R.samples.push({ client: c.name, set: Object.keys(data) });
    if (COMMIT) {
      await prisma.client.update({ where: { id }, data });
      await prisma.auditLog.create({ data: { action: 'Agreement / terms applied from sheets', entity: 'Client', entityId: id, fromValue: c.agreementStatus, toValue: JSON.stringify(Object.keys(data)).slice(0, 500), actorName: TAG } });
    }
    Object.assign(c, data);
  }
  R.clientsTouched = planned.size;
  R.activeNow = S.clients.filter((c) => c.agreementStatus === ACTIVE).length;
  R.unmatchedCount = R.unmatched.filter((u) => !u.noAgreement).length;
  R.unmatchedNoAgreementCount = R.unmatched.filter((u) => u.noAgreement).length;
  R.weakCount = R.weak.length;
  R.signedSheetClients = [...planned.values()].filter((p) => p.line).length;
}

// ============================================================================
// STEP 2 — close the requirements the "Stopped" tabs mark stopped
// ============================================================================
const MED_ROLES = [['Nurse', 'Nurse'], ['Consultant/Doctor', 'Consultant / Doctor'], ['SR', 'Senior Resident'], ['Assistant', 'Assistant Professor'], ['Associate', 'Associate Professor'], ['Professor', 'Professor']];
function medSheetReqs(sheet) {
  const gRaw = grid(FILES.medReqs, sheet); const g = grid(FILES.medReqs, sheet, { merges: true });
  const head = g[0].map(t); const ix = headIx(head);
  const cClient = ix('Client Name') >= 0 ? ix('Client Name') : 0; const cSpec = ix('Specialization'); const cRem = ix('Remarks');
  const out = [];
  for (let r = 1; r < g.length; r += 1) {
    const row = g[r]; const raw = gRaw[r]; if (!raw.some((c) => t(c))) continue;
    const client = t(row[cClient]); if (!client) continue;
    const spec = t(row[cSpec]); const remark = cRem >= 0 ? t(row[cRem]) : '';
    let made = 0;
    MED_ROLES.forEach(([h, title]) => { const c = ix(h); if (c < 0 || !t(raw[c])) return; made += 1; out.push({ line: r + 1, client, title: spec ? `${title} — ${spec}` : title, remark }); });
    if (!made) out.push({ line: r + 1, client, title: spec || 'Medical Requirement', remark });
  }
  return out;
}
function mfgSheetReqs(sheet) {
  const g = grid(FILES.mfgReqs, sheet, { merges: true }); const head = g[0].map(t); const ix = headIx(head);
  const cClient = ix('Company Name') >= 0 ? ix('Company Name') : 0; const cDes = ix('Designation'); const cSpec = ix('Specialization', 'Specalization'); const cRem = ix('Remarks');
  const out = [];
  for (let r = 1; r < g.length; r += 1) {
    const row = g[r]; if (!row.some((c) => t(c))) continue;
    const client = t(row[cClient]); if (!client) continue;
    out.push({ line: r + 1, client, title: t(row[cDes]) || t(row[cSpec]) || 'Manufacturing Requirement', remark: t(row[cRem]) });
  }
  return out;
}
// EVERY requirement at the client with that title: batch 3 created a second
// (OPEN) copy of several stopped requirements, beside the original.
function findReqs(q, dept) {
  const m = matchClient(q.client, dept); if (!m.c) return [];
  return (S.reqsByClient.get(m.c.id) || []).filter((r) => r.department === dept && compact(r.title) === compact(q.title));
}
async function step2() {
  const R = { medical: { stoppedRows: 0, matched: 0, alreadyClosed: 0, toClose: 0, skippedOpenRemark: [], skippedAlsoRunning: [] }, manufacturing: { stoppedRows: 0, matched: 0, alreadyClosed: 0, toClose: 0, skippedOpenRemark: [], skippedAlsoRunning: [] }, closed: 0, list: [] };
  report.steps['2_close_stopped'] = R;
  const target = new Map();
  const run = (dept, stopped, running, out) => {
    const runningIds = new Set(running.flatMap((q) => findReqs(q, dept)).map((r) => r.id));
    const seen = new Set();
    stopped.forEach((q) => {
      out.stoppedRows += 1;
      const hits = findReqs(q, dept); if (!hits.length) return;
      out.matched += 1;
      hits.forEach((hit) => {
        if (seen.has(hit.id)) return; seen.add(hit.id);
        if (hits.length > 1) out.duplicateCopies = (out.duplicateCopies || 0) + 1;
        if (hit.status === 'CLOSED') { out.alreadyClosed += 1; return; }
        if (/requirement is open/i.test(q.remark)) { out.skippedOpenRemark.push(`${hit.reqCode} ${q.client} | ${q.title} (remark "${q.remark}")`); return; }
        if (runningIds.has(hit.id)) { out.skippedAlsoRunning.push(`${hit.reqCode} ${q.client} | ${q.title}`); return; }
        // Only the requirement-sheet record itself (MED-0xxx / MFG-0xxx). The
        // copies the candidate-sheet imports made (one per candidate branch,
        // codes 1000+) are listed for the user, not closed.
        const n = Number((/-(\d+)$/.exec(hit.reqCode || '') || [])[1]);
        if (!(n < 1000)) { (out.copiesLeftOpen = out.copiesLeftOpen || []).push(`${hit.reqCode} ${S.clientById.get(hit.clientId).name.slice(0, 45)} | ${hit.title} (${(S.appsByReq.get(hit.id) || []).length} applications)`); return; }
        if (!target.has(hit.id)) { target.set(hit.id, { hit, dept, q }); out.toClose += 1; }
      });
    });
    out.skippedOpenRemark = [...new Set(out.skippedOpenRemark)]; out.skippedAlsoRunning = [...new Set(out.skippedAlsoRunning)];
  };
  run('Medical', medSheetReqs('Stopped'), medSheetReqs('Running'), R.medical);
  run('Manufacturing', mfgSheetReqs('Stopped'), mfgSheetReqs('Running '), R.manufacturing);
  for (const { hit, dept, q } of target.values()) {
    R.list.push(`${dept} ${hit.reqCode} ${hit.status} -> CLOSED: ${S.clientById.get(hit.clientId).name} | ${hit.title} (${(S.appsByReq.get(hit.id) || []).length} applications)${q.remark ? ` (remark: ${q.remark.slice(0, 60)})` : ''}`);
    if (COMMIT) {
      await prisma.requirement.update({ where: { id: hit.id }, data: { status: 'CLOSED' } });
      await prisma.auditLog.create({ data: { action: 'Requirement closed (Stopped tab)', entity: 'Requirement', entityId: hit.id, fromValue: hit.status, toValue: 'CLOSED', actorName: TAG } });
    }
    hit.status = 'CLOSED'; R.closed += 1;
  }
}

// ============================================================================
// STEP 4 — seat-code requirement titles
// ============================================================================
function bdeRef(name, edu, spec, exp, loc, client) {
  const cl = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const sp = cl(spec).length > 60 ? '' : cl(spec);
  const parts = [tidyName(cl(name)), cl(edu), sp, cl(exp), cl(loc), cl(client)].map((x) => nkey(x)).join('|');
  return `R${crypto.createHash('sha1').update(parts).digest('hex').slice(0, 14)}`;
}
// The BDE MED worksheet's Schedule + Interview rows, as batch 3 read them.
function bdeMedRows() {
  if (S.bdeRows) return S.bdeRows;
  const out = [];
  [['Schedule Sheet', 'Specialization'], ['Interview Sheet', 'Specialization']].forEach(([sheet]) => {
    const gt = grid(FILES.bdeMed, sheet); const gr = grid(FILES.bdeMed, sheet, { raw: true });
    const ix = headIx(gt[0].map(t));
    const C = { date: ix('Date'), pos: ix('Position'), name: ix('Name'), qual: ix('Qualification'), spec: ix('Specialization'), des: ix('Designation'), exp: ix('Experience'), loc: ix('Current Location'), client: ix('Client Name') };
    for (let r = 1; r < gt.length; r += 1) {
      const x = gt[r]; const raw = gr[r]; const name = t(x[C.name]); const client = t(x[C.client]);
      if (!name || !client) continue;
      const spec = t(x[C.spec]);
      out.push({ sheet, line: r + 1, pos: t(x[C.pos]), name, client, spec: spec.length > 60 ? '' : spec, des: t(x[C.des]), date: dateOf(raw[C.date], x[C.date]), ref: bdeRef(raw[C.name], raw[C.qual], raw[C.spec], raw[C.exp], raw[C.loc], client) });
    }
  });
  S.bdeRows = out;
  return out;
}
function bdeDatesByRef() {
  const m = new Map(); bdeMedRows().forEach((x) => { if (x.date) push(m, x.ref, x.date); });
  return m;
}
async function step4() {
  const R = { seatTitled: 0, retitled: 0, merged: 0, appsMoved: 0, appClashes: 0, closedDuplicates: 0, mixedDesignations: [], unresolved: [], ambiguousTargets: [], skippedInvoice: [], byTitle: {}, samples: [] };
  report.steps['4_retitle'] = R;
  const rows = bdeMedRows();
  const posKeys = new Set(rows.map((r) => nkey(r.pos)).filter(Boolean));
  const isSeat = (title) => /^(bde\s*med|med\s*-?\s*\d)/i.test(t(title)) || posKeys.has(nkey(title));
  const byKey = new Map(); rows.forEach((r) => push(byKey, `${nkey(r.client)}|${nkey(r.pos)}|${nkey(r.spec)}`, r));
  const byRef = new Map(); rows.forEach((r) => push(byRef, r.ref, r));
  const seat = S.reqs.filter((r) => r.department === 'Medical' && isSeat(r.title));
  R.seatTitled = seat.length;
  seat.forEach((r) => bump(R.byTitle, r.title));
  const mergedAway = new Set();

  for (const q of seat) {
    const client = S.clientById.get(q.clientId);
    // rows that created it: same client + position + specialisation, else the
    // rows behind its candidates' references
    let src = byKey.get(`${nkey(client.name)}|${nkey(q.title)}|${nkey(q.specialisation)}`) || [];
    if (!src.length) {
      (S.appsByReq.get(q.id) || []).forEach((a) => { const c = S.candById.get(a.candidateId); (c && c.externalRef ? byRef.get(c.externalRef) || [] : []).filter((x) => nkey(x.pos) === nkey(q.title)).forEach((x) => src.push(x)); });
    }
    const counts = new Map();
    src.forEach((x) => { const k = nkey(x.des); if (!k) return; const e = counts.get(k) || { n: 0, name: '' }; e.n += 1; e.name = preferred(e.name, x.des); counts.set(k, e); });
    const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
    let title = ranked.length ? ranked[0].name : '';
    if (!title && t(q.specialisation)) title = t(q.specialisation);
    if (!title) { R.unresolved.push(`${q.reqCode} "${q.title}" @ ${client.name} (spec "${q.specialisation || ''}", ${src.length} source rows, ${(S.appsByReq.get(q.id) || []).length} apps)`); continue; }
    if (ranked.length > 1) R.mixedDesignations.push(`${q.reqCode} @ ${client.name}: ${ranked.map((x) => `${x.name} x${x.n}`).join(', ')} -> "${title}"`);
    title = title.slice(0, 200);
    // a properly titled requirement for the same client + designation (+ spec)?
    const spec = nkey(q.specialisation);
    const targets = (S.reqsByClient.get(q.clientId) || []).filter((x) => x.id !== q.id && !mergedAway.has(x.id) && x.department === 'Medical' && !isSeat(x.title)
      && ((nkey(x.title) === nkey(title) && nkey(x.specialisation) === spec) || (spec && nkey(x.title) === nkey(title) + spec)));
    let T = null;
    if (targets.length === 1) [T] = targets;
    else if (targets.length > 1) {
      const sorted = [...targets].sort((a, b) => (b.status !== 'CLOSED') - (a.status !== 'CLOSED') || (S.appsByReq.get(b.id) || []).length - (S.appsByReq.get(a.id) || []).length);
      [T] = sorted;
      R.ambiguousTargets.push(`${q.reqCode} -> ${targets.map((x) => x.reqCode).join('/')} (${T.reqCode} chosen)`);
    }
    if (T && S.invReq.has(q.id)) { R.skippedInvoice.push(`${q.reqCode} has invoices — retitled, not merged into ${T.reqCode}`); T = null; }
    const oldTitle = q.title;
    const apps = [...(S.appsByReq.get(q.id) || [])];
    await tx(async (txc) => {
      if (txc) await txc.requirement.update({ where: { id: q.id }, data: { title, ...(T ? { status: 'CLOSED', description: `${q.description ? `${q.description}\n` : ''}Merged into ${T.reqCode} (was titled "${oldTitle}").` } : {}) } });
      q.title = title;
      if (T) {
        for (const a of apps) { const res = await moveApplication(txc, a, a.candidateId, T.id); R.appsMoved += 1; if (res.clash) R.appClashes += 1; }
        if (txc) await txc.auditLog.create({ data: { action: 'Requirement merged (seat-code title)', entity: 'Requirement', entityId: T.id, fromValue: `${q.reqCode} "${oldTitle}"`, toValue: `${T.reqCode} "${T.title}" (${apps.length} applications moved)`, actorName: TAG } });
        q.status = 'CLOSED';
      } else if (txc) {
        await txc.applicationStageEvent.updateMany({ where: { requirementId: q.id, requirementTitle: oldTitle }, data: { requirementTitle: title } });
      }
    });
    if (T) { R.merged += 1; R.closedDuplicates += 1; mergedAway.add(q.id); } else R.retitled += 1;
    if (R.samples.length < 8) R.samples.push(`${q.reqCode} "${oldTitle}" @ ${client.name.slice(0, 40)} -> "${title}"${T ? ` MERGED into ${T.reqCode}` : ''}`);
    if (T) (R.mergeList = R.mergeList || []).push(`${q.reqCode} "${oldTitle}" -> ${T.reqCode} "${T.title}" @ ${client.name.slice(0, 50)} (${apps.length} applications)`);
  }
  R.remainingSeatTitles = S.reqs.filter((r) => r.department === 'Medical' && isSeat(r.title)).length;
}

// ============================================================================
// STEP 3 — Medical Interview sheet update (Jan–Feb 2025)
// ============================================================================
const F3_TEXT_ONLY = new Set(['mrekha', 'sakhila', 'nanusha']); // named by the user as not certain
function f3Person(name) {
  const n = t(name); if (!n) return { kind: 'blank' };
  if (/waiting|expect|client|vacancy|month|interview|closed|local/i.test(n)) return { kind: 'note', text: n };
  const key = lc(n).replace(/[^a-z]/g, '');
  if (F3_TEXT_ONLY.has(key)) return { kind: 'text', text: n };
  // Certain = exactly one employee carries the name word AND the sheet's
  // initial is the first letter of that employee's other name part.
  const parts = lc(n).split(/[^a-z]+/).filter(Boolean);
  const word = parts.filter((w) => w.length > 2); const initials = parts.filter((w) => w.length === 1);
  if (word.length !== 1) return { kind: 'text', text: n };
  const hits = S.emps.filter((e) => lc(e.name).split(/[^a-z]+/).includes(word[0]));
  const ok = hits.filter((e) => { const others = lc(e.name).split(/[^a-z]+/).filter((w) => w && w !== word[0]); return initials.every((i) => others.some((w) => w[0] === i)); });
  if (hits.length === 1 && ok.length === 1) return { kind: 'emp', e: ok[0], text: n };
  return { kind: 'text', text: n, candidates: hits.map((e) => `${e.employeeCode} ${e.name}`) };
}
const activeLogin = (e) => (e && e.user && e.user.status === 'Active' && !['Relieved', 'Exited', 'Exit Process'].includes(e.employmentStatus) ? e.user.id : null);
function f3Stage(r) {
  const s2 = lc(r.s2); const all = [r.s1, r.s2, r.recNote, r.remarks].map(lc).join(' | ');
  if (/interview (is )?(done|completed)/.test(s2)) return { stage: 'INTERVIEW_COMPLETED' };
  if (/schedul/.test(s2)) return { stage: 'INTERVIEW_SCHEDULED' };
  if (/not interested/.test(s2)) return { stage: 'REJECTED', side: 'Candidate', category: classify(all, CANDIDATE_SIDE, 'Not Interested'), detail: t(r.s2) };
  if (/high expect/.test(s2)) return { stage: 'REJECTED', side: 'Candidate', category: 'Salary Expectation', detail: t(r.s2) };
  if (/not eligible/.test(s2)) return { stage: 'REJECTED', side: 'Internal', category: 'Not Eligible', detail: t(r.s2) };
  if (/no requirement|vacancy closed/.test(s2)) return { stage: 'REJECTED', side: 'Client', category: 'Position Closed', detail: t(r.s2) };
  if (/reject|rejetced/.test(s2)) return { stage: 'REJECTED', side: 'Client', category: classify(all, CLIENT_SIDE, 'Not Selected'), detail: t([r.s2, r.s1].filter(Boolean).join(' — ')) };
  if (/waiting|hold/.test(s2)) return { stage: 'HOLD', category: 'Awaiting Client Feedback', detail: t(r.s2) };
  return { stage: 'SHARED_WITH_CLIENT' };
}
// "hospiatl", "Hopsital", "LopamudraHospital" -> " hospital "
const fixHosp = (s) => lc(s).replace(/hosp[a-z]*/g, ' hospital ').replace(/\s+/g, ' ').trim();
function f3Client(cell) {
  const name = t(String(cell).split(/\n|\s\d{1,2}-\d{1,2}-\d{2,4}/)[0]);
  if (!name) return { c: null, name, blank: true };
  const m = matchClient(name, 'Medical');
  if (m.c && m.how !== 'weak') return { c: m.c, how: m.how, name };
  const fixed = fixHosp(name);
  const m2 = matchClient(fixed, 'Medical');
  if (m2.c && m2.how !== 'weak') return { c: m2.c, how: `${m2.how} after spelling fix`, name };
  // spelling-tolerant pass (full name, then the part before , ( or -); ties go
  // to the record whose name IS the base name, then to the busier record
  const pool = S.clients.filter((c) => !c.ownerDepartment || c.ownerDepartment === 'Medical');
  const base = fixed.split(/[,(-]/)[0];
  let best = null; let bs = 0; let bExact = false; let bReq = -1;
  pool.forEach((c) => {
    const cn = fixHosp(c.name); const cb = cn.split(/[,(-]/)[0];
    const a = [...tokens(fixed)][0]; const b = [...tokens(cn)][0];
    if (!a || !b || !wordEq(a, b)) return;
    let s = Math.max(looseScore(fixed, cn), looseScore(base, cb));
    if (compact(normName(fixed)) === compact(normName(cn)) || compact(normName(base)) === compact(normName(cb))) s = Math.max(s, 1);
    const exact = normName(base) === normName(cn);
    const nreq = (S.reqsByClient.get(c.id) || []).length;
    if (s > bs + 1e-9 || (Math.abs(s - bs) < 1e-9 && ((exact && !bExact) || (exact === bExact && nreq > bReq)))) { best = c; bs = s; bExact = exact; bReq = nreq; }
  });
  if (best && bs >= 0.6) return { c: best, how: `spelling (${bs.toFixed(2)})`, name };
  // one distinctive word before the place ("Maxcare hospital- AP", "Agur
  // Hospital, Jedcherla"): the client(s) whose name starts with that word
  const words = [...tokens(base)];
  if (words.length === 1 && words[0].length >= 4) {
    const fam = pool.filter((c) => [...tokens(fixHosp(c.name))][0] === words[0])
      .sort((x, y) => (S.reqsByClient.get(y.id) || []).length - (S.reqsByClient.get(x.id) || []).length);
    if (fam.length) return { c: fam[0], how: `first word "${words[0]}" (${fam.length} record${fam.length > 1 ? 's' : ''})`, name };
  }
  if (m.c && m.how === 'weak' && m.score >= 0.5) return { c: m.c, how: `weak (${m.score.toFixed(2)})`, name };
  return { c: null, name };
}
async function step3() {
  const R = { rows: 0, dateFixedJan24: 0, clients: { matched: 0, created: [] }, clientMatches: [], requirements: { reused: 0, created: 0 }, candidates: { byPhone: 0, phoneAddedToBde: 0, created: 0, createdNoPhone: 0, filled: 0 }, nameMatchNotUsed: [], nameMatchNotUsedWhy: {}, noClientRows: [], applications: { created: 0, existing: 0 }, stages: {}, rejectedBySide: {}, people: {}, unmappedPeople: [], events: 0, followUps: 0, samples: [] };
  report.steps['3_interview_sheet'] = R;
  const gt = grid(FILES.medInterview, 'Sheet1'); const gr = grid(FILES.medInterview, 'Sheet1', { raw: true });
  const ix = headIx(gt[0].map((h) => String(h)));
  const C = { date: ix('Date'), pos: ix('Position'), tl: ix('TL Name'), rec: ix('Recruiter Name'), client: ix('Client Name'), name: ix('Candidate Name'), phone: ix('Contact'), qual: ix('Qualification'), spec: ix('Specialization'), des: ix('Designation'), exp: ix('Experience'), cur: ix('Current CTC'), ect: ix('Expecting CTC'), loc: ix('Current Location'), pref: ix('Preferred Location'), notice: ix('Notice period'), s1: ix('Status -1'), s2: ix('Status 2'), remarks: ix('Remarks') };
  const rows = [];
  for (let r = 1; r < gt.length; r += 1) {
    const x = gt[r]; const raw = gr[r]; if (!x.some((c) => t(c))) continue;
    let date = dateOf(raw[C.date], x[C.date]);
    if (date && date.startsWith('2024-01')) { date = `2025${date.slice(4)}`; R.dateFixedJan24 += 1; }
    const recP = f3Person(x[C.rec]);
    rows.push({ line: r + 1, date, seat: (() => { const m = lc(x[C.pos]).match(/med\W*0?(\d+)/); return m ? `MED-${m[1]}` : null; })(), pos: t(x[C.pos]), tl: t(x[C.tl]), rec: t(x[C.rec]), recP, recNote: recP.kind === 'note' ? recP.text : '', clientCell: t(x[C.client]), name: t(x[C.name]), phones: phonesAll(x[C.phone]), qual: t(x[C.qual]), spec: t(x[C.spec]), des: t(x[C.des]), exp: t(x[C.exp]), cur: t(x[C.cur]), ect: t(x[C.ect]), loc: t(x[C.loc]), pref: t(x[C.pref]), notice: t(x[C.notice]), s1: t(x[C.s1]), s2: t(x[C.s2]), remarks: t(x[C.remarks]) });
  }
  R.rows = rows.length;
  R.undatedRows = rows.filter((r) => !r.date).map((r) => r.line);

  // phoneless Medical candidates by name (for "add the phone instead of a duplicate")
  const medCand = (c) => (S.appsByCand.get(c.id) || []).some((a) => (S.reqById.get(a.requirementId) || {}).department === 'Medical');
  const phonelessByName = new Map();
  S.cands.forEach((c) => { if (!hasPhone(c) && !hasEmail(c) && c.source === 'BDE medical desk' && medCand(c)) push(phonelessByName, personKey(c.name), c); });

  const bdeDates = bdeDatesByRef();
  const clientCache = new Map();
  const reqFor = new Map();
  const appsTouched = new Set();
  for (const r of rows) {
    // ---- client
    if (!clientCache.has(r.clientCell)) {
      const m = f3Client(r.clientCell);
      if (m.blank) { /* no client on the row */ } else if (!m.c) {
        const data = { name: m.name, ownerDepartment: 'Medical', location: t(m.name.split(',').slice(1).join(',')) || null, status: 'Active' };
        const made = COMMIT ? await prisma.client.create({ data }) : { id: newId(), ...data, agreementStatus: 'DRAFT' };
        S.clients.push(made); S.clientById.set(made.id, made); buildClientIndex();
        R.clients.created.push(m.name); m.c = made; m.how = 'created';
      } else { R.clients.matched += 1; if (!['exact', 'norm'].includes(m.how)) R.clientMatches.push(`${m.name}  ->  ${m.c.name}  [${m.how}]`); }
      if (m.c && /\n|\s\d{1,2}-\d{1,2}-\d{2,4}/.test(r.clientCell)) R.clientCellsWithExtraText = (R.clientCellsWithExtraText || 0) + 1;
      clientCache.set(r.clientCell, m);
    }
    const client = clientCache.get(r.clientCell).c;
    if (!client) R.noClientRows.push(`line ${r.line} "${r.name}" (${r.des || r.spec || '-'}, ${r.date}): Client Name is blank — candidate recorded, no application (client unknown)`);
    // ---- requirement (client + designation + specialisation)
    const dz = r.des || r.spec || 'Doctor';
    const title = nkey(r.des) && nkey(r.spec) && nkey(r.des) !== nkey(r.spec) ? `${titleCase(r.des)} — ${titleCase(r.spec)}` : titleCase(dz);
    const rk = client ? `${client.id}|${nkey(title)}` : null;
    if (client && !reqFor.has(rk)) {
      const list = (S.reqsByClient.get(client.id) || []).filter((q) => q.department === 'Medical');
      const hit = list.find((q) => nkey(q.title) === nkey(title))
        || list.find((q) => nkey(q.title) === nkey(r.des || r.spec) && nkey(q.specialisation) === nkey(r.spec))
        || (() => { const l = list.filter((q) => nkey(q.title) === nkey(r.des || r.spec)); return l.length === 1 ? l[0] : null; })();
      if (hit) { reqFor.set(rk, hit); R.requirements.reused += 1; } else {
        S.reqSeq += 1;
        const data = { title, clientId: client.id, department: 'Medical', specialisation: r.spec || null, status: 'CLOSED', priority: 'Medium', openings: 1, reqCode: `REQ-${String(S.reqSeq).padStart(4, '0')}`, description: `${title}. ${F3_SOURCE}.`, location: t(client.name.split(',').slice(1).join(',')) || null, tl: r.tl || null, positionCode: r.seat, createdAt: at(r.date || '2025-01-01') };
        const made = COMMIT ? await prisma.requirement.create({ data }) : { id: newId(), ...data };
        S.reqs.push(made); S.reqById.set(made.id, made); push(S.reqsByClient, client.id, made);
        reqFor.set(rk, made); R.requirements.created += 1;
      }
    }
    const req = reqFor.get(rk);
    // ---- candidate
    const fill = { education: r.qual || null, specialization: r.spec || null, currentDesignation: r.des || null, experienceYears: years(r.exp), currentSalary: r.cur || null, expectedSalary: r.ect || null, location: r.loc || null, preferredLocation: r.pref || null, noticePeriod: r.notice || null };
    let cand = null; let how = '';
    const byPh = r.phones.map((p) => S.byPhone.get(p)).find((l) => l && l.length);
    if (byPh) { [cand] = byPh; how = 'phone'; } else {
      const same = phonelessByName.get(personKey(r.name)) || [];
      const single = nameWords(r.name).length < 2;
      // A one-word name ("Kavya") is only the same person when the worksheet
      // also has them at this client or within 3 days of this row.
      const corroborated = (c) => (client && (S.appsByCand.get(c.id) || []).some((a) => (S.reqById.get(a.requirementId) || {}).clientId === client.id))
        || (r.date && (bdeDates.get(c.externalRef) || []).some((d) => Math.abs(Date.parse(d) - Date.parse(r.date)) <= 3 * 86400000));
      if (same.length === 1 && r.phones.length && (!single || corroborated(same[0]))) { [cand] = same; how = 'name'; } else if (same.length) {
        const why = !r.phones.length ? 'the row has no phone' : same.length > 1 ? `${same.length} phoneless records share the name` : 'one-word name, not at this client and not within 3 days of a worksheet row';
        R.nameMatchNotUsed.push(`line ${r.line} "${r.name}": ${why}; new record created`);
        bump(R.nameMatchNotUsedWhy, why.replace(/^\d+ /, 'several '));
      }
      if (!cand) {
        const ref = r.phones.length ? null : `M${crypto.createHash('sha1').update([r.name, r.clientCell, r.date].map(nkey).join('|')).digest('hex').slice(0, 14)}`;
        const existing = ref ? (S.byRef.get(ref) || [])[0] : null;
        if (existing) { cand = existing; how = 'ref'; }
      }
    }
    await tx(async (txc) => {
      if (cand) {
        const data = {};
        Object.entries(fill).forEach(([k, v]) => { if (v != null && v !== '' && blank(cand[k])) data[k] = v; });
        if (how === 'name') { data.phone = r.phones[0]; R.candidates.phoneAddedToBde += 1; }
        else if (how === 'phone') R.candidates.byPhone += 1;
        if (Object.keys(data).length) {
          if (txc) await txc.candidate.update({ where: { id: cand.id }, data });
          Object.assign(cand, data); if (data.phone) push(S.byPhone, data.phone, cand);
          if (how !== 'name') R.candidates.filled += 1;
        }
      } else {
        const ref = r.phones.length ? null : `M${crypto.createHash('sha1').update([r.name, r.clientCell, r.date].map(nkey).join('|')).digest('hex').slice(0, 14)}`;
        const data = { name: r.name, phone: r.phones[0] || null, externalRef: ref, ...fill, source: F3_SOURCE, firstSource: F3_SOURCE };
        cand = txc ? await txc.candidate.create({ data }) : { id: newId(), ...data };
        S.cands.push(cand); S.candById.set(cand.id, cand);
        if (cand.phone) push(S.byPhone, cand.phone, cand);
        if (ref) push(S.byRef, ref, cand);
        R.candidates.created += 1; if (!r.phones.length) R.candidates.createdNoPhone += 1;
      }
      if (!req) return;
      // ---- application
      const s = f3Stage(r);
      bump(R.stages, s.stage); if (s.side) bump(R.rejectedBySide, s.side);
      let app = S.appByPair.get(pk(cand.id, req.id));
      const when = at(r.date || '2025-01-01');
      let fromStage = null;
      if (app) {
        fromStage = app.stage;
        R.applications.existing += 1;
        if (adv(s.stage) > adv(app.stage)) {
          const data = { stage: s.stage, ...(s.stage === 'INTERVIEW_COMPLETED' ? { interviewStatus: 'COMPLETED' } : s.stage === 'INTERVIEW_SCHEDULED' ? { interviewStatus: 'SCHEDULED' } : {}) };
          if (txc) await txc.application.update({ where: { id: app.id }, data });
          Object.assign(app, data);
        }
      } else {
        const data = { candidateId: cand.id, requirementId: req.id, stage: s.stage, source: F3_SOURCE, firstSource: F3_SOURCE, interviewStatus: s.stage === 'INTERVIEW_COMPLETED' ? 'COMPLETED' : s.stage === 'INTERVIEW_SCHEDULED' ? 'SCHEDULED' : null, createdAt: when };
        app = txc ? await txc.application.create({ data }) : { id: newId(), ...data };
        idxAdd(app); R.applications.created += 1;
      }
      // ---- one stage event + one completed follow-up per row (replaced on a re-run)
      if (!appsTouched.has(app.id)) {
        appsTouched.add(app.id);
        if (txc) {
          await txc.applicationStageEvent.deleteMany({ where: { applicationId: app.id, actorName: F3_TAG } });
          await txc.applicationFollowUp.deleteMany({ where: { applicationId: app.id, createdByName: F3_TAG } });
        }
      }
      const rec = r.recP.kind === 'emp' ? r.recP.e : null;
      const tlP = f3Person(r.tl); const tl = tlP.kind === 'emp' ? tlP.e : null;
      const pos = r.seat ? S.posByCode.get(r.seat) : null;
      if (txc) {
        await txc.applicationStageEvent.create({ data: {
          applicationId: app.id, candidateId: cand.id, fromStage, toStage: s.stage, action: STAGE_ACTION[s.stage] || s.stage,
          comment: [r.s1, r.remarks].filter(Boolean).join(' — ') || null, actorName: F3_TAG, actorRole: rec ? 'Recruiter' : null,
          actorSide: s.stage === 'REJECTED' ? s.side : 'Internal', reasonCategory: s.category || null, reasonDetail: s.detail || null,
          actorPositionId: pos ? pos.id : null, actorPositionCode: r.seat, requirementId: req.id, requirementTitle: req.title,
          clientId: client.id, clientName: client.name, createdAt: when,
        } });
        const notes = [r.s1 && `Status 1: ${r.s1}`, r.s2 && `Status 2: ${r.s2}`, r.recNote && `Note (recruiter column): ${r.recNote}`, r.remarks && `Remarks: ${r.remarks}`, `Position: ${r.pos || '-'}`, `Client as written: ${r.clientCell}`].filter(Boolean).join('\n');
        await txc.applicationFollowUp.create({ data: {
          applicationId: app.id, candidateId: cand.id, requirementId: req.id,
          ownerUserId: activeLogin(rec), ownerName: rec ? rec.name : (r.recP.kind === 'text' ? r.recP.text : null), ownerRole: 'Recruiter',
          tlUserId: activeLogin(tl), tlName: tl ? tl.name : (r.tl || null),
          ownerPositionId: pos ? pos.id : null, ownerPositionCode: r.seat,
          lastContactedAt: when, contactMode: 'Call', purpose: 'Medical interview sheet', notes, outcome: STAGE_ACTION[s.stage] || s.stage,
          completedAt: at(r.date || '2025-01-01', '18'), completedNote: F3_SOURCE, createdByName: F3_TAG, createdAt: when,
        } });
      }
      R.events += 1; R.followUps += 1;
      if (R.samples.length < 5) R.samples.push({ line: r.line, date: r.date, client: client.name.slice(0, 40), requirement: req.title, candidate: `${r.name} (${how || 'new'}${cand.phone ? `, ${mask(phonesAll(cand.phone)[0])}` : ''})`, stage: s.stage });
    });
    [['TL', r.tl, f3Person(r.tl)], ['Recruiter', r.rec, r.recP]].forEach(([role, raw, p]) => {
      if (!raw || p.kind === 'note') return;
      const k = `${role}: ${raw}`;
      if (!R.people[k]) R.people[k] = { rows: 0, mappedTo: p.kind === 'emp' ? `${p.e.employeeCode} ${p.e.name}` : 'text only (no user link)', candidates: p.candidates };
      R.people[k].rows += 1;
    });
  }
  R.unmappedPeople = Object.entries(R.people).filter(([, v]) => !/^TL\d/.test(v.mappedTo)).map(([k, v]) => `${k} (${v.rows} rows)${v.candidates && v.candidates.length ? ` — possible: ${v.candidates.join(' | ')}` : ''}`);
  if (COMMIT) await prisma.auditLog.create({ data: { action: 'Medical interview sheet Jan-2025 imported', entity: 'Import', entityId: FILES.medInterview, toValue: JSON.stringify({ rows: R.rows, candidates: R.candidates, applications: R.applications }).slice(0, 900), actorName: F3_TAG } });
}

// ============================================================================
// STEP 5 — Manufacturing Schedule Sheet, column P
// ============================================================================
function colP(text) {
  const s = lc(text);
  if (!s) return null;
  if (/waiting for (the )?candidate/.test(s)) return { stage: 'HOLD', category: 'Awaiting Candidate Update', detail: t(text) };
  if (/waiting for (the )?client/.test(s)) return { stage: 'HOLD', category: 'Awaiting Client Feedback', detail: t(text) };
  if (/no vacancy|client closed|stop sharing/.test(s)) return { stage: 'REJECTED', side: 'Client', category: /stop sharing/.test(s) ? 'Other' : 'Position Closed', detail: t(text) };
  if (/no requirement/.test(s)) return { stage: 'REJECTED', side: 'Client', category: 'Position Closed', detail: t(text) };
  const m = mapStatus(text);
  if (!m) return null;
  return { stage: m.stage, detail: t(text) };
}
async function step5() {
  const R = { rows: 0, candidateFound: 0, applicationFound: 0, noApplication: [], unmapped: {}, sameStage: 0, changed: 0, notAhead: {}, joinedKept: [], rejectedOverSelected: [], transitions: {}, events: 0, samples: [] };
  report.steps['5_mfg_status'] = R;
  const gt = grid(FILES.mfgFollowUp, 'Schedule Sheet'); const gr = grid(FILES.mfgFollowUp, 'Schedule Sheet', { raw: true });
  const byApp = new Map();
  for (let r = 1; r < gt.length; r += 1) {
    const x = gt[r]; const raw = gr[r]; if (!t(x[1])) continue;
    R.rows += 1;
    const ref = bdeRef(raw[1], raw[3], raw[4], raw[6], raw[9], t(x[12]));
    const cand = (S.byRef.get(ref) || [])[0];
    if (!cand) continue;
    R.candidateFound += 1;
    const m = matchClient(x[12], 'Manufacturing');
    const apps = (S.appsByCand.get(cand.id) || []).filter((a) => m.c && (S.reqById.get(a.requirementId) || {}).clientId === m.c.id);
    const want = nkey(t(x[2]) || t(x[5]) || 'Manufacturing Requirement');
    const app = apps.length === 1 ? apps[0] : apps.find((a) => nkey(S.reqById.get(a.requirementId).title) === want);
    if (!app) { R.noApplication.push(`line ${r + 1} ${t(x[1])} @ ${t(x[12])} (${apps.length} applications at that client)`); continue; }
    R.applicationFound += 1;
    const date = dateOf(raw[0], x[0]);
    const prev = byApp.get(app.id);
    if (!prev || (date || '') >= (prev.date || '')) byApp.set(app.id, { app, line: r + 1, date, p: t(x[15]), s1: t(x[14]), name: t(x[1]), client: t(x[12]) });
  }
  R.applications = byApp.size;
  for (const { app, line, date, p, s1, name, client } of byApp.values()) {
    const s = colP(p);
    if (!s) { bump(R.unmapped, p || '(blank)'); continue; }
    if (s.stage === app.stage) { R.sameStage += 1; continue; }
    if (app.stage === 'JOINED') { R.joinedKept.push(`line ${line} ${name} @ ${client}: sheet "${p}", DB JOINED — kept`); continue; }
    if (!(AUDIT_RANK[s.stage] > (AUDIT_RANK[app.stage] || 0))) { bump(R.notAhead, `${s.stage} (sheet) vs ${app.stage} (DB)`); continue; }
    if (s.stage === 'REJECTED' && !s.side) {
      const txt = lc(`${p} | ${s1}`);
      const cand = CANDIDATE_SIDE.find(([re]) => re.test(txt));
      if (cand) { s.side = 'Candidate'; s.category = cand[1]; } else { s.side = 'Client'; s.category = classify(txt, CLIENT_SIDE, 'Not Selected'); }
      s.detail = t([p, s1].filter(Boolean).join(' — ')).slice(0, 500);
    }
    if (s.stage === 'REJECTED' && ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(app.stage)) R.rejectedOverSelected.push(`line ${line} ${name} @ ${client}: DB ${app.stage} -> REJECTED (sheet "${p}")`);
    bump(R.transitions, `${app.stage} -> ${s.stage}`);
    const req = S.reqById.get(app.requirementId); const cl = S.clientById.get(req.clientId);
    const from = app.stage;
    await tx(async (txc) => {
      if (!txc) return;
      await txc.application.update({ where: { id: app.id }, data: { stage: s.stage, ...(s.stage === 'INTERVIEW_COMPLETED' ? { interviewStatus: 'COMPLETED' } : {}) } });
      await txc.applicationStageEvent.create({ data: {
        applicationId: app.id, candidateId: app.candidateId, fromStage: from, toStage: s.stage, action: STAGE_ACTION[s.stage] || s.stage,
        comment: `Manufacture Client Follow Up, Schedule Sheet line ${line}, status column P: "${p}"`, actorName: TAG,
        actorSide: s.stage === 'REJECTED' ? s.side : 'Internal', reasonCategory: s.category || null, reasonDetail: s.detail || null,
        requirementId: req.id, requirementTitle: req.title, clientId: cl.id, clientName: cl.name, createdAt: date ? at(date, '12') : new Date(),
      } });
    });
    app.stage = s.stage; R.changed += 1; R.events += 1;
    if (R.samples.length < 5) R.samples.push(`line ${line}: ${from} -> ${s.stage} ("${p}")`);
  }
}

// ============================================================================
// STEP 6 — Medical duplicates: same person with and without a phone
// ============================================================================
async function step6() {
  const R = { pairsFound: 0, merged: 0, appsMoved: 0, appClashes: 0, ambiguousWhy: {}, oneVsSeveralAllSameClient: 0, ambiguous: [], skipped: [], bySource: {}, samples: [] };
  report.steps['6_merge_duplicates'] = R;
  const bdeDates = bdeDatesByRef();
  const medApps = (c) => (S.appsByCand.get(c.id) || []).filter((a) => (S.reqById.get(a.requirementId) || {}).department === 'Medical');
  const withPh = new Map(); const without = new Map();
  S.cands.forEach((c) => {
    if (!medApps(c).length) return;
    const k = personKey(c.name); if (!k) return;
    if (hasPhone(c)) push(withPh, k, c); else push(without, k, c);
  });
  for (const [k, B] of without) {
    const A = withPh.get(k); if (!A) continue;
    R.pairsFound += 1;
    const label = `"${B[0].name}"`;
    const clientsOf = (c) => new Set(medApps(c).map((x) => S.reqById.get(x.requirementId).clientId));
    if (A.length !== 1 || B.length !== 1) {
      const why = `${A.length === 1 ? 'one' : 'several'} with phone, ${B.length === 1 ? 'one' : 'several'} without`;
      bump(R.ambiguousWhy, why);
      if (A.length === 1 && B.length > 1) { const ca = clientsOf(A[0]); if (B.every((b) => [...clientsOf(b)].some((x) => ca.has(x)))) R.oneVsSeveralAllSameClient += 1; }
      R.ambiguous.push(`${label}: ${A.length} with phone, ${B.length} without`); continue;
    }
    const a = A[0]; const b = B[0];
    if (hasEmail(b) && lc(b.email) !== lc(a.email)) { bump(R.ambiguousWhy, 'different email'); R.ambiguous.push(`${label}: the phoneless record has a different email`); continue; }
    if (nameWords(a.name).length < 2) {
      // one-word name: only with a client in common, or a worksheet row within 3 days of one of the other's applications
      const ca = clientsOf(a);
      const sameClient = [...clientsOf(b)].some((x) => ca.has(x));
      const bDates = (bdeDates.get(b.externalRef) || []).map((d) => Date.parse(d));
      const near = medApps(a).some((x) => bDates.some((d) => Math.abs(d - new Date(x.createdAt).getTime()) <= 3 * 86400000));
      if (!sameClient && !near) { bump(R.ambiguousWhy, 'one-word name, no client in common, no dates within 3 days'); R.ambiguous.push(`${label}: one-word name, no client in common and no dates within 3 days`); continue; }
    }
    if (S.userCand.has(b.id)) { R.skipped.push(`${label}: the phoneless record is linked to a login`); continue; }
    if (S.invCand.has(b.id)) { R.skipped.push(`${label}: the phoneless record has invoices`); continue; }
    const fill = blanksFrom(a, b, CAND_SKIP);
    const moved = [...(S.appsByCand.get(b.id) || [])];
    await tx(async (txc) => {
      for (const app of moved) { const res = await moveApplication(txc, app, a.id, app.requirementId); R.appsMoved += 1; if (res.clash) R.appClashes += 1; }
      if (txc) {
        await txc.applicationFollowUp.updateMany({ where: { candidateId: b.id }, data: { candidateId: a.id } });
        await txc.applicationStageEvent.updateMany({ where: { candidateId: b.id }, data: { candidateId: a.id } });
        await txc.candidateNote.updateMany({ where: { candidateId: b.id }, data: { candidateId: a.id } });
        await txc.candidateDocument.updateMany({ where: { candidateId: b.id }, data: { candidateId: a.id } });
        await txc.candidateMessage.updateMany({ where: { candidateId: b.id }, data: { candidateId: a.id } });
        if (Object.keys(fill).length) await txc.candidate.update({ where: { id: a.id }, data: fill });
        await txc.candidate.delete({ where: { id: b.id } });
        await txc.auditLog.create({ data: { action: 'Duplicate candidate merged', entity: 'Candidate', entityId: a.id, fromValue: `${b.id} "${b.name}" (${b.source || '-'}, no phone)`, toValue: `kept ${a.id} "${a.name}" (${a.source || '-'}); ${moved.length} application(s) moved; filled: ${Object.keys(fill).join(', ') || 'nothing'}`, actorName: TAG } });
      }
    });
    Object.assign(a, fill);
    S.candById.delete(b.id); b.deleted = true;
    R.merged += 1; bump(R.bySource, `${a.source || '-'} <- ${b.source || '-'}`);
    if (R.samples.length < 5) R.samples.push(`${a.name} (${a.source}) <- ${b.name} (${b.source}), ${moved.length} app(s)`);
  }
  S.cands = S.cands.filter((c) => !c.deleted);
}

// ============================================================================
(async () => {
  const t0 = Date.now();
  await load();
  report.loaded = { clients: S.clients.length, requirements: S.reqs.length, candidates: S.cands.length, applications: S.apps.length };
  if (STEPS.has(1)) await step1();
  if (STEPS.has(2)) await step2();
  if (STEPS.has(4)) await step4();
  if (STEPS.has(3)) await step3();
  if (STEPS.has(5)) await step5();
  if (STEPS.has(6)) await step6();
  if (COMMIT) await prisma.auditLog.create({ data: { action: 'Med/Mfg fixes applied', entity: 'Import', entityId: 'import-medmfg-fixes.js', toValue: JSON.stringify(Object.keys(report.steps)), actorName: TAG } });
  report.seconds = Math.round((Date.now() - t0) / 1000);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  // console: counts + samples, long lists trimmed
  const trim = (v) => (Array.isArray(v) ? (v.length > 12 ? [...v.slice(0, 12), `… ${v.length - 12} more (see --out)`] : v) : (v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v));
  console.log(JSON.stringify(trim(report), null, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });

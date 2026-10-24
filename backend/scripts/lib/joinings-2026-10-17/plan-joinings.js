/* eslint-disable no-continue */
// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - PHASE B: PLAN EVERY ROW OF THE THREE JOININGS WORKBOOKS.
//
// For each source row, in date order: find the candidate (by phone + same person, else by the same full name), find the college /
// hospital / company client, find (or make) the job, find the application there and bring it to what the sheet says (never backwards),
// and attach the history: one stage event when something changed, ONE completed follow-up carrying EVERY cell of the row, the recruiter /
// TL / seat, and a candidate note for the second phone number. Nothing is sent, nothing is invoiced, nothing is deleted.
// ---------------------------------------------------------------------------
const P = require('./parse');
const ST = require('./status');
const N = require('./names');
const { RULES, deptOf } = require('./client-rules');
const { invoiceKey } = require('./state');
const { newId } = require('./ledger');

const { oneLine, lc, t, nkey } = P;
const IMPORTER = 'Imported — Joinings sheets 2026-10-17';
const TODAY = '2026-10-17';
const at = (iso, hh = '09') => new Date(`${iso}T${hh}:00:00Z`);
const titleCase = (s) => oneLine(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

const SOURCE_BY_SHEET = {
  MED: 'Medical joinings sheet', 'EDU-DOCS': 'Education joinings (documents pending)', 'EDU-MISS': 'Education missing joinings sheet', 'EDU-J22': 'Education joinings Jun-Dec 2022',
  'EDU-REPORT': 'Education reporting profiles', 'EDU-2023': 'Education joinings 2023', 'EDU-2024': 'Education joinings 2024', 'EDU-2025': 'Education joinings 2025',
  'EDU-BIO24': 'Education bio-metric joinings 2024', 'EDU-2026': 'Education joinings 2026', MFG: 'Manufacturing joinings sheet',
};
const STAGE_ACTION = {
  JOINED: 'Joined', REJECTED: 'Rejected', HOLD: 'Put on hold', SELECTED: 'Selected', OFFER_ACCEPTED: 'Offer accepted',
  INTERVIEW_COMPLETED: 'Interview completed', INTERVIEW_SCHEDULED: 'Interview scheduled',
};
const ADV = { NEW: 0, RECRUITER_REVIEW: 1, SHARED_WITH_CLIENT: 2, CLIENT_SHORTLISTED: 3, INTERVIEW_SCHEDULED: 4, INTERVIEW_COMPLETED: 5, HOLD: 5, SELECTED: 7, OFFER: 8, OFFER_ACCEPTED: 9, JOINED: 10, HIRED: 10, REJECTED: 6 };
const adv = (s) => (ADV[s] === undefined ? 0 : ADV[s]);
const OFFERISH = new Set(['SELECTED', 'OFFER', 'OFFER_ACCEPTED']);
const LEFT_STATUSES = new Set(['Dropped', 'Replacement Due', 'Replaced', 'Left after Guarantee']);
// Should the sheet's stage be applied over the app's? apply | same | behind | conflict
function decide(cur, target, dnj) {
  if (cur === target) return 'same';
  if (target === 'JOINED') return 'apply';
  if (cur === 'JOINED' || cur === 'HIRED') return 'conflict';
  if (target === 'REJECTED') return (OFFERISH.has(cur) && !dnj) ? 'conflict' : 'apply';
  if (cur === 'REJECTED') return 'conflict';
  return adv(target) > adv(cur) ? 'apply' : 'behind';
}

const isInvoiceNo = (s) => /^\d{3,5}$/.test(oneLine(s)) || /^[A-Z]{1,4}\d*-\d+(-\d+)?$/i.test(oneLine(s));
const phoneOf = (f) => f.phones[0] || null;

// recruiter text that is really a follow-up note (Medical sheet, older rows)
const looksLikeNote = (s) => s.length > 24 || /\b20\d\d\b/.test(s) || /\b(called|through|mbl|whatsapp|received)\b/i.test(s);

function planJoinings({ S, L, parsed, importedBy = IMPORTER }) {
  const personOf = N.makePersonMatcher(S.emps);
  const R = {
    rows: [], decisions: [], conflicts: [], info: [], clientMap: new Map(), people: new Map(), counters: {}, anomalies: [], dropInterpretation: [],
    newClients: [], newRequirements: 0, leftApps: new Map(), invoiceLinks: [], sharedInvoices: [], statusWords: {}, phoneShared: [], possibleDup: [],
  };
  const newClientCache = new Map();
  const reqCache = new Map();
  const sigSeen = new Map();

  // ----- clients ---------------------------------------------------------------------------
  const normIndex = new Map(); // nkey(name | alias) -> [client]
  const addNorm = (k, c) => { if (!k) return; if (!normIndex.has(k)) normIndex.set(k, []); if (!normIndex.get(k).includes(c)) normIndex.get(k).push(c); };
  S.clients.forEach((c) => { addNorm(nkey(c.name), c); addNorm(nkey(c.legalName), c); });
  S.aliases.forEach((a) => { const c = S.clientById.get(a.clientId); if (c) { addNorm(nkey(a.alias), c); } });
  function newClient(name, dept, rawText) {
    if (newClientCache.has(name)) return newClientCache.get(name);
    const id = L.create('client', {
      name, ownerDepartment: dept, industry: dept === 'Medical' ? 'Healthcare' : dept, status: 'Active', clientType: 'Direct',
      internalNotes: `Created by the joinings import 2026-10-17 from the sheet text "${rawText}". No agreement was found for this client.`,
    });
    const c = { id, name, ownerDepartment: dept, location: null, agreementStatus: 'DRAFT', createdAt: new Date() };
    S.clients.push(c); S.clientById.set(id, c); addNorm(nkey(name), c);
    newClientCache.set(name, c);
    R.newClients.push({ id, name, dept, from: rawText });
    return c;
  }
  function resolveClient(row) {
    const f = row.f;
    const raw = oneLine(f.clientRaw);
    if (!raw) return { none: 'the sheet gives no client / college' };
    const dept = deptOf(row.sheetCfg.dept, f.deptRaw);
    const text = lc(raw).replace(/[‘’`]/g, "'");
    const rule = RULES.find(([d, re]) => d === dept && re.test(text));
    if (rule) {
      const name = rule[2];
      if (name.startsWith('NEW:')) return { client: newClient(name.slice(4), dept, raw), how: 'new client (no client of that name in the app)', isNew: true };
      const id = S.ruleIds.get(name);
      const c = id ? S.clientById.get(id) : null;
      if (!c) return { none: `rule says "${name}" but no client has that name` };
      return { client: c, how: 'by rule' };
    }
    const hits = normIndex.get(nkey(raw)) || [];
    const uniq = [...new Set(hits)];
    if (uniq.length === 1) return { client: uniq[0], how: 'exact name / old name / alias' };
    if (uniq.length > 1) {
      const best = [...uniq].sort((a, b) => (S.reqsByClient.get(b.id) || []).length - (S.reqsByClient.get(a.id) || []).length)[0];
      return { client: best, how: 'exact name (several clients carry it; the one with most jobs)' };
    }
    return { none: `no client matches "${raw}"` };
  }

  // ----- requirements ----------------------------------------------------------------------
  function ensureReq(client, row, when) {
    const f = row.f;
    const dept = client.ownerDepartment || row.sheetCfg.dept;
    let title; let spec = null;
    if (dept === 'Medical') { title = (titleCase(f.desig || f.spec || 'Doctor')) + (f.desig && f.spec ? ` — ${titleCase(f.spec)}` : ''); spec = f.spec || null; }
    else if (dept === 'Education') { const b = oneLine(f.spec); title = b ? `Faculty — ${b.length <= 12 ? b.toUpperCase() : titleCase(b)}` : 'Faculty'; spec = b || null; }
    else { title = titleCase(f.desig || f.spec || f.qual || 'Position'); spec = f.spec || null; }
    const key = `${client.id}|${lc(title)}`;
    if (reqCache.has(key)) return reqCache.get(key);
    const list = S.reqsByClient.get(client.id) || [];
    let hit = list.find((q) => lc(q.title) === lc(title));
    if (!hit && dept === 'Education') {
      const b = lc(f.spec);
      hit = (b ? list.find((q) => lc(q.title).includes(b) && /faculty|regular|professor/.test(lc(q.title))) : null) || (b ? list.find((q) => lc(q.title).includes(b)) : list.find((q) => lc(q.title) === 'faculty'));
    }
    if (hit) { reqCache.set(key, hit); return hit; }
    S.reqSeq += 1;
    const rec = personOf(f.recruiterRaw); const tl = personOf(f.tlRaw);
    const rEmp = rec.status.startsWith('unique') ? rec.hits[0] : null; const tEmp = tl.status.startsWith('unique') ? tl.hits[0] : null;
    const data = {
      title, clientId: client.id, department: dept, specialisation: spec, status: 'CLOSED', priority: 'Medium', openings: 1,
      reqCode: `REQ-${String(S.reqSeq).padStart(4, '0')}`, description: `${title}. Created by the joinings import 2026-10-17 (${SOURCE_BY_SHEET[row.sheetCode]}).`,
      tl: tEmp ? tEmp.name : (oneLine(f.tlRaw) || null), tlId: S.activeLogin(tEmp), recruiterId: S.activeLogin(rEmp), positionCode: f.seat || null, createdAt: at(when || TODAY),
    };
    const id = L.create('requirement', data);
    const made = { id, clientId: client.id, title, department: dept, specialisation: spec, reqCode: data.reqCode, status: 'CLOSED', createdAt: data.createdAt, positionCode: data.positionCode };
    S.reqs.push(made); S.reqById.set(id, made);
    if (!S.reqsByClient.has(client.id)) S.reqsByClient.set(client.id, []);
    S.reqsByClient.get(client.id).push(made);
    reqCache.set(key, made); R.newRequirements += 1;
    return made;
  }

  // ----- candidates ------------------------------------------------------------------------
  function appsAtClient(cand, client) {
    return (S.appsByCand.get(cand.id) || []).filter((a) => { const q = S.reqById.get(a.requirementId); return q && q.clientId === client.id; });
  }
  function findCandidate(row, client) {
    const f = row.f;
    const byPhone = [...new Set(f.phones.flatMap((p) => S.candsByPhone.get(p) || []))];
    const same = byPhone.filter((c) => N.samePerson(c.name, f.name));
    if (same.length) {
      // several records of one person: prefer the one with an application at this client, then the oldest
      const pick = [...same].sort((a, b) => appsAtClient(b, client).length - appsAtClient(a, client).length || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      return { cand: pick, how: 'phone', many: same.length > 1 };
    }
    if (byPhone.length) R.phoneShared.push(`${row.id} ${f.name}: phone ${f.phones.join('/')} belongs to "${byPhone.map((c) => c.name).join('", "')}" (a different person) - kept as a separate candidate`);
    const names = (S.candsByNameKey.get(P.letters(f.name)) || []).filter((c) => N.sameFullName(c.name, f.name));
    if (names.length) {
      const withApp = names.filter((c) => appsAtClient(c, client).length);
      const phoneless = names.filter((c) => !P.phonesIn(c.phone).list.length);
      if (withApp.length === 1 && (!P.phonesIn(withApp[0].phone).list.length || !f.phones.length)) return { cand: withApp[0], how: 'full name + already applied at this client', fillPhone: !!f.phones.length };
      if (!f.phones.length && withApp.length === 1) return { cand: withApp[0], how: 'full name + already applied at this client' };
      if (phoneless.length === 1 && f.phones.length) {
        const pc = phoneless[0];
        const deptApps = (S.appsByCand.get(pc.id) || []).some((a) => { const q = S.reqById.get(a.requirementId); return q && q.department === (client.ownerDepartment || row.sheetCfg.dept); });
        if (deptApps && names.length === 1) return { cand: pc, how: 'full name; the record has no phone and has applications in this department', fillPhone: true };
      }
      R.possibleDup.push(`${row.id} ${f.name}: also named like ${names.slice(0, 3).map((c) => `${c.name} (${c.id})`).join(', ')} - not merged (different or no phone); created as its own record`);
    }
    return { cand: null };
  }

  // ----- people ----------------------------------------------------------------------------
  function who(raw, role) {
    const k = oneLine(raw);
    if (!k) return { name: null, userId: null, emp: null };
    const m = personOf(k);
    const key = `${role}: ${k}`;
    const emp = m.status.startsWith('unique') ? m.hits[0] : null;
    if (!R.people.has(key)) R.people.set(key, { role, written: k, status: m.status, mappedTo: emp ? `${emp.employeeCode} ${emp.name}` : (m.hits.length ? `ambiguous: ${m.hits.slice(0, 4).map((e) => e.name).join(' / ')}` : 'no employee found'), rows: 0 });
    R.people.get(key).rows += 1;
    return { name: emp ? emp.name : k, userId: S.activeLogin(emp), emp };
  }

  // ----- notes -----------------------------------------------------------------------------
  function dump(row) {
    const hdr = parsed.headers[row.sheetCode] || {};
    const lines = Object.entries(row.cells).map(([L2, c]) => {
      const label = hdr[L2] || `Column ${L2} (no heading)`;
      const v = c.t === 'n' && P.serialIso && /d|m|y/i.test(String(c.z || '')) && !/^0|General/.test(String(c.z || '')) ? `${c.w}` : t(c.v);
      return `${label}: ${v}`;
    });
    return lines.join('\n');
  }

  const ordered = [...parsed.rows].sort((a, b) => {
    const da = a.f.joinIso || a.f.ivIso || a.f.schedIso || '9999'; const db = b.f.joinIso || b.f.ivIso || b.f.schedIso || '9999';
    return da.localeCompare(db) || a.sheetCode.localeCompare(b.sheetCode) || a.row - b.row;
  });

  for (const row of ordered) {
    const f = row.f;
    const res = { id: row.id, sheet: row.sheetLabel, sheetCode: row.sheetCode, row: row.row, name: f.nameRaw ? oneLine(f.nameRaw) : '', phone: f.phones.join(' / ') || f.phoneRaw || '', action: null, detail: '', candidateId: '', applicationId: '', clientId: '', interpretation: '' };
    R.rows.push(res);
    row.anomalies.forEach((a) => { R.anomalies.push({ id: row.id, sheet: row.sheetLabel, row: row.row, name: res.name, ...a }); });
    const decide1 = (why, cat) => { res.action = 'NEEDS_DECISION'; res.detail = why; R.decisions.push({ id: row.id, sheet: row.sheetLabel, row: row.row, name: res.name, category: cat, why }); };

    // already done by an earlier run
    const marker = `${row.sheetCode}:${row.row}`;
    if (S.doneMarkers.has(marker)) {
      const fu = S.doneMarkerFollowUp.get(marker);
      res.action = 'ALREADY_IMPORTED'; res.detail = 'imported by an earlier run (nothing changed)'; res.candidateId = fu ? fu.candidateId : ''; res.applicationId = fu ? fu.applicationId : '';
      continue;
    }
    if (!f.name) { res.action = 'SKIPPED'; res.detail = 'no candidate name on the row (only other cells: ' + Object.entries(row.cells).map(([k2, c]) => `${(parsed.headers[row.sheetCode] || {})[k2] || k2}=${t(c.w || c.v)}`).join('; ').slice(0, 140) + ')'; R.counters.skippedBlank = (R.counters.skippedBlank || 0) + 1; continue; }
    // an exact repeat of another row
    const sig = JSON.stringify([nkey(f.name), f.phones.join(','), nkey(f.clientRaw), f.joinRaw, f.ivRaw, f.schedRaw, f.sal.raw, nkey(f.statusRaw), nkey(f.remarkRaw), nkey(f.followRaw), nkey(f.respRaw), nkey(f.feedbackRaw), nkey(f.recruiterRaw), nkey(f.tlRaw), nkey(f.invoiceRaw), nkey(f.qual), nkey(f.spec), nkey(f.desig), Object.values(row.extras).map(nkey).join('|')]);
    if (sigSeen.has(sig)) { res.action = 'SKIPPED_DUPLICATE'; res.detail = `identical to ${sigSeen.get(sig)} (every cell the same) - already taken from that row`; continue; }
    sigSeen.set(sig, row.id);

    // ---- what the row says -------------------------------------------------------------
    let dropRec = null;
    let tgt; // { stage, joined, dnj, left, side, category, detail, note, documents, text }
    const kind = row.kind;
    if (kind === 'J' || kind === 'F') {
      const s = kind === 'F' ? { joined: true, statusText: f.statusRaw || f.respRaw, note: 'Joined' } : ST.joiningsStatus(f, row, row.sheetCode);
      if (s.unknown) { decide1(s.why, 'status word'); continue; }
      tgt = s.joined ? { stage: 'JOINED', joined: true, left: s.left || null, note: s.note, text: s.statusText } : { stage: 'REJECTED', joined: false, dnj: true, side: 'Candidate', category: 'Did Not Join', note: s.note, text: s.statusText };
      tgt.possibleLeaver = s.possibleLeaver; tgt.evidence = s.evidence;
      if (/drop/i.test(s.note || '')) { dropRec = { id: row.id, sheet: row.sheetLabel, row: row.row, name: res.name, written: s.statusText, treatedAs: s.joined ? 'joined, then left' : 'did not join', because: s.evidence || '' }; R.dropInterpretation.push(dropRec); }
    } else if (kind === 'M') {
      const s = ST.medicalStatus(f, row);
      if (s.unknown) { decide1(s.why, 'status word'); continue; }
      tgt = s.joined ? { stage: 'JOINED', joined: true, left: s.left || null, note: s.note, text: s.statusText } : { stage: 'REJECTED', joined: false, dnj: true, side: 'Candidate', category: 'Did Not Join', note: s.note, text: s.statusText };
      tgt.evidence = s.evidence;
      if (/drop/i.test(s.note || '')) { dropRec = { id: row.id, sheet: row.sheetLabel, row: row.row, name: res.name, written: s.statusText, treatedAs: s.joined ? 'joined, then left' : 'did not join', because: s.evidence || '' }; R.dropInterpretation.push(dropRec); }
    } else if (kind === 'D') {
      const s = ST.docsStatus(f, row);
      tgt = { stage: s.stage, joined: s.stage === 'JOINED', dnj: !!s.dnj, side: s.side, category: s.category, documents: s.documents, note: s.text, text: f.statusRaw || s.text, why: s.why };
      R.dropInterpretation.push({ id: row.id, sheet: row.sheetLabel, row: row.row, name: res.name, written: f.statusRaw || '(no status)', treatedAs: `${s.stage}${s.documents ? ' (documents pending)' : ''}`, because: s.why });
    } else { // P
      const s = ST.pipelineStatus(f);
      if (s.unknown) { decide1(s.why, 'status word'); continue; }
      tgt = { stage: s.stage, joined: s.stage === 'JOINED', dnj: !!s.dnj, side: s.side, category: s.category, note: s.note || s.text, text: s.text };
      bump(R.statusWords, `${s.text} (${s.from}) -> ${s.stage}`);
    }

    // ---- client ------------------------------------------------------------------------
    const rc = resolveClient(row);
    if (rc.none) { decide1(rc.why || rc.none, 'client'); continue; }
    const client = rc.client;
    res.clientId = client.id;
    const ckey = `${row.sheetCfg.dept}|${oneLine(f.clientRaw)}`;
    if (!R.clientMap.has(ckey)) R.clientMap.set(ckey, { written: oneLine(f.clientRaw), dept: deptOf(row.sheetCfg.dept, f.deptRaw), clientId: client.id, client: client.name, how: rc.how, rows: 0 });
    R.clientMap.get(ckey).rows += 1;

    // ---- candidate ---------------------------------------------------------------------
    const fc = findCandidate(row, client);
    let cand = fc.cand; let createdCand = false;
    const when = f.joinIso || f.ivIso || f.schedIso || TODAY;
    const education = f.qual || null; const spec = f.spec || null;
    const fill = {
      education, specialization: spec, experienceYears: f.years, currentDesignation: f.desig || null, currentSalary: f.curCtc || null, expectedSalary: f.expCtc || null,
      location: f.loc || null, noticePeriod: f.notice || null,
    };
    if (!cand) {
      const phoneless = !f.phones.length;
      const data = {
        name: f.name, phone: phoneOf(f), source: SOURCE_BY_SHEET[row.sheetCode], firstSource: SOURCE_BY_SHEET[row.sheetCode],
        ...Object.fromEntries(Object.entries(fill).filter(([, v]) => v !== null && v !== undefined && v !== '')),
        createdAt: at(when),
      };
      if (phoneless) data.externalRef = `JNG-${row.sheetCode}-${row.row}`;
      const id = L.create('candidate', data);
      cand = { id, name: f.name, phone: data.phone || null, email: null, source: data.source, education: data.education || null, specialization: data.specialization || null, experienceYears: data.experienceYears ?? null, currentSalary: data.currentSalary || null, expectedSalary: data.expectedSalary || null, location: data.location || null, noticePeriod: data.noticePeriod || null, currentDesignation: data.currentDesignation || null, createdAt: data.createdAt };
      S.cands.push(cand); S.candById.set(id, cand);
      f.phones.forEach((p) => { if (!S.candsByPhone.has(p)) S.candsByPhone.set(p, []); S.candsByPhone.get(p).push(cand); });
      const nk = P.letters(f.name); if (nk) { if (!S.candsByNameKey.has(nk)) S.candsByNameKey.set(nk, []); S.candsByNameKey.get(nk).push(cand); }
      createdCand = true;
    } else {
      const blanks = {};
      Object.entries(fill).forEach(([k2, v]) => { if (v !== null && v !== undefined && v !== '' && (cand[k2] === null || cand[k2] === undefined || cand[k2] === '')) blanks[k2] = v; });
      if (fc.fillPhone && !P.phonesIn(cand.phone).list.length && f.phones.length) blanks.phone = f.phones[0];
      if (Object.keys(blanks).length) { L.update('candidate', cand.id, blanks, cand); Object.assign(cand, blanks); if (blanks.phone) { if (!S.candsByPhone.has(blanks.phone)) S.candsByPhone.set(blanks.phone, []); S.candsByPhone.get(blanks.phone).push(cand); } }
    }
    res.candidateId = cand.id;
    // the app keeps ONE phone per candidate: every other number the sheet gives for this person goes to a candidate note
    {
      const have = new Set(P.phonesIn(cand.phone).list);
      const extra = f.phones.filter((x) => !have.has(x));
      if (extra.length) L.create('candidateNote', { candidateId: cand.id, body: `Phone number(s) from the ${row.sheetLabel} (row ${row.row}) that are not the number on this record (${cand.phone || 'none'}): ${extra.join(' / ')} (the sheet cell reads "${oneLine(f.phoneRaw)}").`, authorName: importedBy, authorRole: 'Import' });
    }

    // ---- job + application -------------------------------------------------------------
    let app = appsAtClient(cand, client);
    app = app.find((a) => a.stage === 'JOINED') || [...app].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    let createdApp = false;
    if (tgt.dnj && tgt.evidence === 'no proof of joining' && app && ['JOINED', 'HIRED'].includes(app.stage)) {
      // the app itself says this person joined: "Drop" then means joined, then left
      tgt = { stage: 'JOINED', joined: true, left: { on: null, text: tgt.text }, note: 'Drop - the application is already Joined in the app, so this is read as: joined, then left (date not written)', text: tgt.text, evidence: 'the application is already Joined in the app' };
      if (dropRec) { dropRec.treatedAs = 'joined, then left'; dropRec.because = 'the application is already Joined in the app'; }
    }
    const req = app ? S.reqById.get(app.requirementId) : ensureReq(client, row, when);
    const ivOk = f.ivIso && (!f.joinIso || f.ivIso <= f.joinIso) && f.ivIso <= TODAY ? f.ivIso : null;
    const stage0 = tgt.stage;
    const salaryYear = f.sal.monthly ? f.sal.monthly * 12 : null;
    const offerNote = f.sal.raw ? `Salary as in the ${row.sheetLabel}: ${f.sal.raw}${f.sal.monthly && f.sal.quality !== 'exact' ? ` (taken as Rs ${f.sal.monthly.toLocaleString('en-IN')} a month)` : (f.sal.monthly ? ` (Rs ${f.sal.monthly.toLocaleString('en-IN')} a month)` : ' (not a clear number)')}` : null;
    const mode = /^on/i.test(f.mode) ? 'Online' : (/^off/i.test(f.mode) ? 'In Person' : null);
    const fields = {
      interviewAt: ivOk ? at(ivOk, '10') : null, interviewStatus: ivOk && ivOk <= TODAY ? 'COMPLETED' : null, interviewMode: mode,
      offeredCtc: salaryYear, offerNotes: offerNote, documentsStatus: tgt.documents || null,
      joiningDate: (tgt.stage === 'JOINED' || ['OFFER_ACCEPTED', 'SELECTED'].includes(tgt.stage)) && f.joinIso ? f.joinIso : null,
    };
    let event = null; let stageDecision = 'new';
    if (!app) {
      const data = {
        candidateId: cand.id, requirementId: req.id, stage: stage0, source: SOURCE_BY_SHEET[row.sheetCode], firstSource: SOURCE_BY_SHEET[row.sheetCode], createdAt: at(when),
        ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== '')),
      };
      if (tgt.stage === 'JOINED') { data.joiningStatus = tgt.left || tgt.dnj ? 'Dropped' : 'Joined'; if (f.joinIso) data.joinedAt = at(f.joinIso); data.offerStatus = 'Offer Accepted'; }
      else if (tgt.stage === 'REJECTED') { data.joiningStatus = tgt.dnj ? 'Dropped' : null; if (tgt.dnj) data.offerStatus = 'Offer Declined'; }
      else if (['OFFER_ACCEPTED', 'SELECTED'].includes(tgt.stage) && f.joinIso) data.joiningStatus = 'Joining Scheduled';
      if (data.joiningStatus === null) delete data.joiningStatus;
      const id = L.create('application', data);
      app = { id, candidateId: cand.id, requirementId: req.id, stage: stage0, interviewAt: data.interviewAt || null, interviewStatus: data.interviewStatus || null, interviewMode: data.interviewMode || null, interviewFeedback: null, offeredCtc: data.offeredCtc ?? null, offerNotes: data.offerNotes || null, offerStatus: data.offerStatus || null, joiningDate: data.joiningDate || null, joiningStatus: data.joiningStatus || null, joinedAt: data.joinedAt || null, documentsStatus: data.documentsStatus || null, billingStatus: null, source: data.source, firstSource: data.firstSource, createdAt: data.createdAt };
      S.apps.push(app); S.appById.set(id, app); S.appByPair.set(`${cand.id}|${req.id}`, app);
      if (!S.appsByCand.has(cand.id)) S.appsByCand.set(cand.id, []);
      S.appsByCand.get(cand.id).push(app);
      createdApp = true;
      event = { from: null, to: stage0, action: STAGE_ACTION[stage0] || stage0 };
    } else {
      stageDecision = decide(app.stage, stage0, tgt.dnj);
      const set = {};
      Object.entries(fields).forEach(([k2, v]) => { if (v !== null && v !== '' && (app[k2] === null || app[k2] === undefined || app[k2] === '')) set[k2] = v; });
      if (stageDecision === 'apply') {
        set.stage = stage0;
        event = { from: app.stage, to: stage0, action: STAGE_ACTION[stage0] || stage0 };
        if (stage0 === 'JOINED') { if (!app.joinedAt && f.joinIso) set.joinedAt = at(f.joinIso); if (!app.offerStatus) set.offerStatus = 'Offer Accepted'; }
        if (stage0 === 'REJECTED' && tgt.dnj && !app.offerStatus) set.offerStatus = 'Offer Declined';
      } else if (stageDecision === 'conflict') {
        R.conflicts.push({ id: row.id, name: res.name, client: client.name, db: app.stage, sheet: stage0, text: tgt.text || '', why: 'the application is already further on / final in the app - left as it is' });
      }
      // joining status words
      const curJs = app.joiningStatus;
      const finalStage = set.stage || app.stage;
      if (finalStage === 'JOINED' && stageDecision !== 'conflict') {
        const want = (tgt.left || tgt.dnj) ? 'Dropped' : 'Joined';
        if (!curJs || ['Not Scheduled', 'Joining Scheduled'].includes(curJs) || (want === 'Dropped' && !LEFT_STATUSES.has(curJs))) { if (curJs !== want && !(want === 'Joined' && LEFT_STATUSES.has(curJs))) set.joiningStatus = want; }
      } else if (finalStage === 'REJECTED' && tgt.dnj && !curJs) set.joiningStatus = 'Dropped';
      else if (!curJs && ['OFFER_ACCEPTED', 'SELECTED'].includes(finalStage) && f.joinIso) set.joiningStatus = 'Joining Scheduled';
      if (tgt.stage === 'JOINED' && f.joinIso && app.joiningDate && app.joiningDate !== f.joinIso) {
        const old = app.joiningDate;
        const days = Math.abs(Math.round((Date.parse(`${f.joinIso}T00:00:00Z`) - Date.parse(`${old}T00:00:00Z`)) / 86400000));
        const implausible = !/^\d{4}-\d{2}-\d{2}$/.test(old) || Number.isNaN(Date.parse(`${old}T00:00:00Z`)) || old < '2018-01-01' || old > TODAY;
        const sameMD = old.slice(5) === f.joinIso.slice(5) && old.slice(0, 4) !== f.joinIso.slice(0, 4);
        const swapped = old.slice(0, 4) === f.joinIso.slice(0, 4) && old.slice(5, 7) === f.joinIso.slice(8, 10) && old.slice(8, 10) === f.joinIso.slice(5, 7);
        if (implausible || sameMD || swapped) {
          set.joiningDate = f.joinIso;
          const oldAt = app.joinedAt ? new Date(new Date(app.joinedAt).getTime() + 330 * 60000).toISOString().slice(0, 10) : null;
          if (!app.joinedAt || oldAt === old || implausible) set.joinedAt = at(f.joinIso);
          R.info.push(`${row.id} ${res.name}: joining date CORRECTED from ${old} to ${f.joinIso} (the app's date ${implausible ? 'is not a possible date' : `was ${days} days away (same day and month in another year, or day and month swapped)`}); the old value is in the undo file`);
          R.dateFixes = (R.dateFixes || 0) + 1;
        } else R.info.push(`${row.id} ${res.name}: the sheet says joined on ${f.joinIso}; the application has ${old} (${days} days apart) - the application's date was kept`);
      }
      if (Object.keys(set).length) { L.update('application', app.id, set, app); Object.assign(app, set); }
    }
    res.applicationId = app.id;

    // ---- history -----------------------------------------------------------------------
    const rec = who(f.recruiterRaw && !looksLikeNote(f.recruiterRaw) ? f.recruiterRaw : '', 'recruiter');
    const tl = who(f.tlRaw, 'tl');
    const seat = f.seat || null;
    const pos = seat ? S.posByCode.get(seat) : null;
    const clientName = client.name;
    if (event) {
      L.create('applicationStageEvent', {
        applicationId: app.id, candidateId: cand.id, fromStage: event.from, toStage: event.to, action: event.action,
        comment: `${tgt.note || ''}${tgt.text && !/^joined/i.test(tgt.note || '') ? ` [sheet: ${tgt.text}]` : ''}`.trim().slice(0, 1900) || null,
        actorName: importedBy, actorRole: 'Recruiter', actorSide: tgt.stage === 'REJECTED' ? (tgt.side === 'Client' ? 'Client' : 'Candidate') : 'Internal',
        reasonCategory: tgt.stage === 'REJECTED' ? (tgt.category || null) : null, reasonDetail: tgt.stage === 'REJECTED' ? (tgt.note || null) : null,
        actorPositionId: pos ? pos.id : null, actorPositionCode: seat, requirementId: req.id, requirementTitle: req.title, clientId: client.id, clientName,
        createdAt: at(when),
      });
    }
    if (tgt.left && stage0 === 'JOINED' && (createdApp || stageDecision === 'apply' || stageDecision === 'same')) {
      L.create('applicationStageEvent', {
        applicationId: app.id, candidateId: cand.id, fromStage: 'JOINED', toStage: 'JOINED', action: 'Left the job (from the joinings sheet)',
        comment: `Left${tgt.left.on ? ` on ${tgt.left.on}` : (tgt.left.month ? ` in ${tgt.left.month}` : ' (date not written)')}: sheet says "${tgt.left.text || tgt.text || ''}"`.slice(0, 1900),
        actorName: importedBy, actorRole: 'Recruiter', actorSide: 'Internal', requirementId: req.id, requirementTitle: req.title, clientId: client.id, clientName, createdAt: at(tgt.left.on || when, '18'),
      });
    }
    if (tgt.left && (app.stage === 'JOINED')) {
      const prev = R.leftApps.get(app.id);
      if (!prev || (!prev.left.on && tgt.left.on)) R.leftApps.set(app.id, { appId: app.id, candidateId: cand.id, candidateName: cand.name, requirementId: req.id, jobTitle: req.title, jobCode: req.reqCode || null, clientId: client.id, clientName: client.name, department: req.department || null, joinedOn: app.joiningDate || f.joinIso || null, designation: f.desig || req.title || null, offeredCtc: salaryYear, recruiterUserId: rec.userId, recruiterName: rec.name, tlUserId: tl.userId, tlName: tl.name, seat, left: tgt.left, marker, sheet: row.sheetLabel, rowNo: row.row });
    }
    // the follow-up: the carrier of recruiter / TL / seat and of EVERY cell of the row
    const interp = [
      `Read as: ${tgt.note || tgt.text || ''}`.trim(),
      f.joinIso ? `Joined / joining date read as ${f.joinIso}` : (f.joinRaw ? `Joining date "${f.joinRaw.replace(/\n/g, ' / ')}" could not be turned into a day` : null),
      f.ivIso ? `Interview date read as ${f.ivIso}${f.ivRepaired ? ` (${f.ivRepaired})` : ''}${ivOk ? '' : ' - NOT used on the application (it is after the joining date)'}` : (f.ivRaw ? `Interview date "${f.ivRaw.replace(/\n/g, ' / ')}" could not be turned into a day` : null),
      f.sal.raw ? `Salary read as ${f.sal.monthly ? `Rs ${f.sal.monthly.toLocaleString('en-IN')} a month` : 'no clear number'} (written "${f.sal.raw}")` : null,
      f.invoiceRaw ? (isInvoiceNo(f.invoiceRaw) ? `Invoice no ${oneLine(f.invoiceRaw)}` : `Column "Invoice No" holds "${oneLine(f.invoiceRaw)}" (not an invoice number)`) : null,
      rec.name && oneLine(f.recruiterRaw) !== rec.name ? `Recruiter "${oneLine(f.recruiterRaw)}" = ${rec.name}` : null,
      tl.name && oneLine(f.tlRaw) !== tl.name ? `TL "${oneLine(f.tlRaw)}" = ${tl.name}` : null,
      seat ? `Seat ${seat} (written "${f.seatRaw || f.roleRaw}")` : null,
      f.name !== oneLine(f.nameRaw) ? `Name written "${oneLine(f.nameRaw)}"` : null,
      tgt.possibleLeaver ? 'NOTE: the notes may say the person is no longer working although the status says continue - please check' : null,
      row.anomalies.length ? `Sheet anomalies: ${row.anomalies.map((a) => a.text).join('; ')}` : null,
    ].filter(Boolean).join('\n');
    const notes = `[JNG ${marker}]\nImported from: ${row.file} - sheet "${row.sheet.trim()}" - row ${row.row}\n----- every cell of the row -----\n${dump(row)}\n----- how it was read -----\n${interp}`;
    const fu = L.create('applicationFollowUp', {
      applicationId: app.id, candidateId: cand.id, requirementId: req.id,
      ownerUserId: rec.userId, ownerName: rec.name, ownerRole: rec.name ? 'Recruiter' : null, tlUserId: tl.userId, tlName: tl.name,
      ownerPositionId: pos ? pos.id : null, ownerPositionCode: seat,
      lastContactedAt: at(when), contactMode: 'Call', purpose: `${SOURCE_BY_SHEET[row.sheetCode]} (history)`, notes,
      outcome: tgt.note ? tgt.note.slice(0, 160) : null, completedAt: at(when, '18'), completedNote: `${row.file} - ${row.sheet.trim()}`, createdByName: importedBy, createdAt: at(when),
    });
    S.doneMarkers.add(marker); S.doneMarkerFollowUp.set(marker, { id: fu, applicationId: app.id, candidateId: cand.id, notes });

    // ---- invoice (only LINK to one that exists) ----------------------------------------
    if (f.invoiceRaw && isInvoiceNo(f.invoiceRaw)) {
      const list = S.invByNo.get(invoiceKey(f.invoiceRaw)) || [];
      let inv = list.find((i) => i.candidateId === cand.id) || (list.length === 1 ? list[0] : null);
      if (list.length > 1 && !inv) { R.sharedInvoices.push(`${row.id} ${res.name}: invoice ${f.invoiceRaw} matches ${list.length} invoices - not linked`); inv = null; }
      if (inv) {
        if (inv.candidateId && inv.candidateId !== cand.id) R.sharedInvoices.push(`${row.id} ${res.name}: invoice ${f.invoiceRaw} is on the invoice of another candidate (one invoice for several joinings) - not changed`);
        else {
          const set = {};
          if (!inv.candidateId) set.candidateId = cand.id;
          if (!inv.requirementId) set.requirementId = req.id;
          if (Object.keys(set).length) { L.update('invoice', inv.id, set, inv); Object.assign(inv, set); R.invoiceLinks.push(`${row.id} ${res.name}: invoice ${f.invoiceRaw} linked (${Object.keys(set).join(', ')})`); }
          else R.invoiceLinks.push(`${row.id} ${res.name}: invoice ${f.invoiceRaw} was already linked to this candidate`);
          if (!app.billingStatus && tgt.stage === 'JOINED') { L.update('application', app.id, { billingStatus: 'Invoiced' }, app); app.billingStatus = 'Invoiced'; }
        }
      }
    }

    res.action = (createdCand || createdApp) ? 'CREATED' : 'ENRICHED';
    res.detail = `${createdCand ? 'new candidate' : `candidate found by ${fc.how}`}; ${createdApp ? 'new application' : `existing application (${stageDecision === 'apply' ? 'moved to ' + stage0 : stageDecision === 'same' ? 'already ' + stage0 : stageDecision === 'conflict' ? 'kept ' + app.stage + ', sheet says ' + stage0 : 'kept ' + app.stage + ' (sheet is behind)'})`} at ${client.name}${tgt.left ? '; left the job' : ''}${tgt.dnj ? '; did not join' : ''}`;
    res.interpretation = tgt.note || '';
    R.counters[`stage_${stage0}`] = (R.counters[`stage_${stage0}`] || 0) + 1;
  }
  return R;
}

// resolve the rule client names to ids ONCE, before any rename changes a name
function prepareClientRules(S, packRenames = []) {
  S.ruleIds = new Map();
  const wasCalled = new Map(); // old name -> client id (a client already renamed by an earlier run is still found by its old name)
  packRenames.forEach((r) => { if (r.current && S.clientById.has(r.clientId)) wasCalled.set(r.current, r.clientId); });
  const byName = new Map();
  S.clients.forEach((c) => { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push(c); });
  const problems = [];
  for (const [, , name] of RULES) {
    if (name.startsWith('NEW:') || S.ruleIds.has(name)) continue;
    const l = byName.get(name) || [];
    if (l.length === 1) S.ruleIds.set(name, l[0].id);
    else if (!l.length && wasCalled.has(name)) S.ruleIds.set(name, wasCalled.get(name));
    else problems.push(l.length ? `${l.length} clients are called "${name}"` : `no client is called "${name}"`);
  }
  return problems;
}

module.exports = { planJoinings, prepareClientRules, IMPORTER, SOURCE_BY_SHEET };

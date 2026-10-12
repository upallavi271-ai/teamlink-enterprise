// ---------------------------------------------------------------------------
// recon-pulsehrm-analyze.js - READ-ONLY reconciliation of the four PulseHRM exports
// against TeamLink (as dumped by recon-pulsehrm-dump.js). Writes the workbook, a JSON
// of headline numbers and returns nothing else. No database is opened here.
//
//   node scripts/recon-pulsehrm-analyze.js --files <folder> --asis <dump_asis.json> [--whatif <dump_whatif.json>]
//        [--plan <plan_dry.json>] --xlsx <out.xlsx> --json <stats.json>
//
// The "what-if" dump is a COPY of the database on which recon-pulsehrm-apply.js --apply was run,
// so the workbook can also show what TeamLink would say AFTER the corrections.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const L = require('./recon-pulsehrm-lib');
const leaveText = require('../src/utils/leaveText'); // pure functions, no database

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FILES = val('--files'); const ASIS = val('--asis'); const WHATIF = val('--whatif'); const PLAN = val('--plan');
const XLSX = val('--xlsx'); const JSONOUT = val('--json');
const FROM = '2026-09-27'; const TO = '2026-10-09';

const findFile = (test) => fs.readdirSync(FILES).map((n) => path.join(FILES, n)).find((f) => test(path.basename(f).toLowerCase()));

(async () => {
  const f1 = L.readF1(findFile((n) => n.endsWith('.csv') && n.includes('first')));
  const f4 = L.readF4(findFile((n) => n.endsWith('.csv') && n.includes('bio')));
  const f3 = L.readF3(findFile((n) => n.endsWith('.csv') && n.includes('summary')));
  const f2 = await L.readLeaveXlsx(findFile((n) => n.endsWith('.xlsx') && n.includes('leave')));
  const A = JSON.parse(fs.readFileSync(ASIS, 'utf8'));
  const W = WHATIF ? JSON.parse(fs.readFileSync(WHATIF, 'utf8')) : null;
  const plan = PLAN ? JSON.parse(fs.readFileSync(PLAN, 'utf8')) : null;
  const U = (s) => String(s || '').trim().toUpperCase();
  const stats = { meta: { window: `${FROM}..${TO}`, snapshotTakenAt: A.meta.takenAt, engineToday: A.meta.today, graceTime: A.cfg.graceTime, weeklyOffDays: A.cfg.weeklyOffDays, halfDayHours: A.cfg.halfDayHours } };

  const empByCode = new Map(A.employees.map((e) => [U(e.employeeCode), e]));
  const empById = new Map(A.employees.map((e) => [e.id, e]));
  const codeOf = (id) => (empById.get(id) || {}).employeeCode;

  // =====================================================================
  // (A) EMPLOYEE MATCH
  // =====================================================================
  const people = new Map(); // code -> { files:Set, names:{}, dept, desig }
  const touch = (code, file, name, dept, desig) => {
    const c = U(code); if (!c) return;
    if (!people.has(c)) people.set(c, { code: c, files: new Set(), names: {}, dept: '', desig: '' });
    const p = people.get(c); p.files.add(file); if (name) p.names[file] = name;
    if (file === 'Summary' || !p.dept) { if (dept) p.dept = dept; if (desig) p.desig = desig; }
  };
  f3.forEach((r) => touch(r.code, 'Summary', r.name, r.dept, r.desig));
  f1.forEach((r) => touch(r.code, 'Report', r.name, r.dept, r.desig));
  f4.forEach((r) => touch(r.code, 'Logs', r.name, r.dept, r.desig));
  f2.forEach((r) => touch(r.code, 'Leave', r.name, r.dept, ''));
  const DEPT_EQ = (a, b) => { const n = (s) => L.normName(s).replace(/^human resource$/, 'hr'); return n(a) === n(b); };
  const DESIG_EQ = (a, b) => { const n = (s) => L.normName(s).replace(/^(team ?lead|tl)$/, 'tl'); return n(a) === n(b); };
  const tokSet = (s) => [...new Set(L.normName(s).split(' ').filter(Boolean))].sort().join(' ');
  const rank = { Exact: 0, 'Same after cleanup': 1, Compatible: 2, Different: 3 };

  const empRows = []; const sameNameOtherId = []; const dupes = [];
  for (const p of people.values()) {
    const e = empByCode.get(p.code);
    const row = {
      code: p.code, inFiles: [...p.files].sort().join('+'), inReport: p.files.has('Report'), inLogs: p.files.has('Logs'), inSummary: p.files.has('Summary'), inLeave: p.files.has('Leave'),
      fileName: p.names.Summary || p.names.Report || p.names.Logs || p.names.Leave || '', tlName: e ? e.name : '', tlStatus: e ? e.employmentStatus : '',
      fileDept: p.dept, tlDept: e ? (e.department || '') : '', fileDesig: p.desig, tlDesig: e ? (e.designation || '') : '',
    };
    if (!e) {
      row.status = 'ID not in TeamLink'; row.nameCompare = '';
      // same name under a different ID?
      const hits = A.employees.filter((x) => tokSet(x.name) && tokSet(x.name) === tokSet(row.fileName));
      if (hits.length) { row.status = 'ID not in TeamLink - same name under another ID'; hits.forEach((h) => sameNameOtherId.push({ fileCode: p.code, fileName: row.fileName, tlCode: h.employeeCode, tlName: h.name, tlStatus: h.employmentStatus })); }
    } else {
      let worst = 'Exact';
      Object.entries(p.names).forEach(([f, n]) => { const c = L.compareNames(n, e.name); if (rank[c] > rank[worst]) worst = c; });
      row.nameCompare = worst;
      row.status = worst === 'Different' ? 'ID matches, NAME DIFFERS' : worst === 'Compatible' ? 'ID + name match (order / initials differ)' : 'ID + name match';
      // is the same name also under another TeamLink ID?
      A.employees.filter((x) => x.id !== e.id && tokSet(x.name) === tokSet(e.name) && tokSet(x.name)).forEach((h) => dupes.push({ code: p.code, name: e.name, otherCode: h.employeeCode, otherName: h.name, otherStatus: h.employmentStatus, thisStatus: e.employmentStatus }));
      // names differing between the files themselves
      const ns = Object.entries(p.names);
      const filesDisagree = ns.some(([, n]) => L.compareNames(n, ns[0][1]) === 'Different');
      if (filesDisagree) row.status += ' (files disagree with each other)';
      row.deptDiff = !DEPT_EQ(row.fileDept, row.tlDept); row.desigDiff = !DESIG_EQ(row.fileDesig, row.tlDesig);
      const inactive = ['Relieved', 'Exited'].includes(e.employmentStatus);
      row.note = inactive ? `TeamLink says ${e.employmentStatus}, but PulseHRM still lists the person${row.inReport ? ' and has punches' : ' (no punches)'}` : '';
      if (e.employmentStatus === 'Relieved' && row.inReport) row.status += ' - RELIEVED in TeamLink but punching in PulseHRM';
    }
    empRows.push(row);
  }
  // duplicates inside the files
  const fileDup = [];
  const cnt = (arr, k) => arr.reduce((m, x) => { const key = k(x); m[key] = (m[key] || 0) + 1; return m; }, {});
  Object.entries(cnt(f3, (r) => U(r.code))).filter(([, n]) => n > 1).forEach(([c, n]) => fileDup.push(`Summary: ${c} appears ${n} times`));
  Object.entries(cnt(f1, (r) => `${U(r.code)} ${r.date}`)).filter(([, n]) => n > 1).forEach(([c, n]) => fileDup.push(`Report: ${c} appears ${n} times`));
  Object.entries(cnt(f4, (r) => `${U(r.code)} ${r.date}`)).filter(([, n]) => n > 1).forEach(([c, n]) => fileDup.push(`Logs: ${c} appears ${n} times`));
  const byTok = {}; people.forEach((p) => { const t = tokSet(p.names.Summary || p.names.Report || ''); if (t) (byTok[t] = byTok[t] || []).push(p.code); });
  Object.entries(byTok).filter(([, c]) => c.length > 1).forEach(([t, c]) => fileDup.push(`Same person under two IDs inside the files: ${c.join(' / ')}`));
  // Employees in TeamLink but in no file
  const activeSt = (s) => !['Relieved', 'Exited'].includes(s);
  const notInFile = A.employees.filter((e) => !people.has(U(e.employeeCode)) && activeSt(e.employmentStatus))
    .map((e) => ({ code: e.employeeCode, name: e.name, status: e.employmentStatus, dept: e.department, desig: e.designation, doj: e.dateOfJoining, tlPunchesInWindow: A.punches.filter((p) => p.employeeId === e.id && p.date >= FROM && p.date <= TO).length }));
  const notInTL = empRows.filter((r) => r.status.startsWith('ID not in TeamLink'));
  const matchedAll = empRows.filter((r) => r.tlName);
  const idNameMatch = matchedAll.filter((r) => /^ID \+ name match/.test(r.status)).length;
  const nameDiffers = matchedAll.filter((r) => /NAME DIFFERS/.test(r.status));
  const deptDiffs = matchedAll.filter((r) => r.deptDiff); const desigDiffs = matchedAll.filter((r) => r.desigDiff);
  const bothDiff = matchedAll.filter((r) => r.deptDiff || r.desigDiff);
  stats.A = {
    distinctIdsInFiles: people.size, matchedById: matchedAll.length, idAndNameMatch: idNameMatch,
    idAndNameMatchExactOrCleanup: matchedAll.filter((r) => ['Exact', 'Same after cleanup'].includes(r.nameCompare)).length,
    idAndNameMatchInitialsOrder: matchedAll.filter((r) => r.nameCompare === 'Compatible').length,
    nameDiffers: nameDiffers.length, idInFileNotInTeamLink: notInTL.map((r) => `${r.code} ${r.fileName}`),
    teamlinkActiveNotInAnyFile: notInFile.length, sameNameOtherId: sameNameOtherId.length, tlDuplicateNames: dupes.length,
    deptDiffers: deptDiffs.length, desigDiffers: desigDiffs.length, deptOrDesigDiffers: bothDiff.length, fileDuplicates: fileDup,
    tlExitedOrRelievedButInPulse: matchedAll.filter((r) => ['Relieved', 'Exited'].includes(r.tlStatus)).map((r) => `${r.code} ${r.tlName} (${r.tlStatus})`),
  };

  // =====================================================================
  // (B) PUNCHES
  // =====================================================================
  const secOfP = (p) => p.clockTime || (p.time ? `${p.time}:00` : null);
  const key = (id, d) => `${id}|${d}`;
  const tlPunchMap = (D) => { const m = new Map(); D.punches.forEach((p) => { const k = key(p.employeeId, p.date); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }); return m; };
  const tlHistMap = (D) => new Map(D.history.map((h) => [key(h.employeeId, h.date), h]));
  const pA = tlPunchMap(A); const hA = tlHistMap(A);
  const pW = W ? tlPunchMap(W) : null; const hW = W ? tlHistMap(W) : null;
  const classify = (D_p, D_h, empId, date, t) => {
    const ps = (D_p.get(key(empId, date)) || []).map(secOfP);
    if (ps.includes(t)) return 'In TeamLink punch table';
    const h = D_h.get(key(empId, date));
    if (h && h.punchTimes && h.punchTimes.split('|').includes(t)) return 'Only in imported log (AttendanceHistory.punchTimes)';
    return 'Missing in TeamLink';
  };
  const punchRows = []; const punchTot = { file: 0, inTable: 0, onlyLog: 0, missing: 0, noEmployee: 0, wInTable: 0, wOnlyLog: 0, wMissing: 0 };
  const byDate = {};
  for (const r of f4) {
    const e = empByCode.get(U(r.code));
    byDate[r.date] = byDate[r.date] || { days: 0, punches: 0, inTable: 0, onlyLog: 0, missing: 0 }; byDate[r.date].days += 1;
    for (const t of [...new Set(r.times)]) {
      punchTot.file += 1; byDate[r.date].punches += 1;
      if (!e) { punchTot.noEmployee += 1; byDate[r.date].missing += 1; punchRows.push({ code: r.code, name: r.name, date: r.date, time: t, side: 'In file, not in TeamLink', where: 'Employee ID not in TeamLink', after: '' }); continue; }
      const c = classify(pA, hA, e.id, r.date, t);
      if (c === 'In TeamLink punch table') { punchTot.inTable += 1; byDate[r.date].inTable += 1; } else if (c.startsWith('Only')) { punchTot.onlyLog += 1; byDate[r.date].onlyLog += 1; } else { punchTot.missing += 1; byDate[r.date].missing += 1; }
      let after = '';
      if (W) { after = classify(pW, hW, e.id, r.date, t); if (after === 'In TeamLink punch table') punchTot.wInTable += 1; else if (after.startsWith('Only')) punchTot.wOnlyLog += 1; else punchTot.wMissing += 1; }
      if (c !== 'In TeamLink punch table') punchRows.push({ code: r.code, name: r.name, date: r.date, time: t, side: 'In file, not in TeamLink punch table', where: c, after });
    }
  }
  // punches in TeamLink (window) that are not in the file
  const fileTimes = new Map(); f4.forEach((r) => { const e = empByCode.get(U(r.code)); if (e) fileTimes.set(key(e.id, r.date), new Set(r.times)); });
  const f1Times = new Map(); f1.forEach((r) => { const e = empByCode.get(U(r.code)); if (e) f1Times.set(key(e.id, r.date), new Set([r.firstIn, r.lastOut].filter(Boolean))); });
  let tlNotInFile = 0;
  A.punches.filter((p) => p.date >= FROM && p.date <= TO).forEach((p) => {
    const t = secOfP(p); const k = key(p.employeeId, p.date);
    const inF = (fileTimes.get(k) && fileTimes.get(k).has(t)) || (f1Times.get(k) && f1Times.get(k).has(t));
    if (!inF) { tlNotInFile += 1; punchRows.push({ code: codeOf(p.employeeId), name: (empById.get(p.employeeId) || {}).name, date: p.date, time: t, side: 'In TeamLink, not in file', where: `${p.method} / ${p.direction}`, after: '' }); }
  });
  // report (first/last) vs logs consistency
  const f4ByKey = new Map(f4.map((r) => [`${U(r.code)}|${r.date}`, r]));
  const f1NotInLog = [];
  f1.forEach((r) => { const l = f4ByKey.get(`${U(r.code)}|${r.date}`); if (!l) { f1NotInLog.push(`${r.code} ${r.date}: report row has no log row`); return; } [r.firstIn, r.lastOut].filter(Boolean).forEach((t) => { if (!l.times.includes(t)) f1NotInLog.push(`${r.code} ${r.date}: report time ${t} is not among the log punches`); }); });
  const f4NotInF1 = f4.filter((r) => !f1.some((x) => U(x.code) === U(r.code) && x.date === r.date)).map((r) => `${r.code} ${r.date}`);
  stats.B = { ...punchTot, tlPunchesInWindowNotInFile: tlNotInFile, byDate, reportVsLogProblems: f1NotInLog.length, reportVsLogProblemList: f1NotInLog, logDaysWithoutReportRow: f4NotInF1.length,
    logDaysWithoutReportRowDates: [...new Set(f4NotInF1.map((x) => x.split(' ')[1]))] };

  // ---- day level ------------------------------------------------------
  const dayMap = (D) => { const m = new Map(); D.dayRows.forEach((r) => m.set(key(r.employeeId, r.date), r)); return m; };
  const dA = dayMap(A); const dW = W ? dayMap(W) : null;
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const pulseCat = (r) => { if (!r || !r.lastOut) return 'Not counted (no check-out)'; const w = L.secs(r.lastOut) - L.secs(r.firstIn); if (w >= 9 * 3600) return 'Present (>= 9:00 worked)'; if (w >= 4 * 3600) return 'Half-day (4:00-9:00 worked)'; return 'Not counted (< 4:00 worked)'; };
  const fam = (r) => { if (!r) return 'No row'; if (!r.counted) return r.status; if (r.present >= 1) return 'Full day'; if (r.present === 0.5) return 'Half day'; if (r.leave > 0) return 'Leave'; if (r.pending > 0) return 'Leave pending'; if (r.status === 'No device data') return 'No device data'; if (r.status === 'Absent') return 'Absent'; return r.status; };
  const f1By = new Map(f1.map((r) => [`${U(r.code)}|${r.date}`, r]));
  const dayKeys = new Set();
  f1.forEach((r) => dayKeys.add(`${U(r.code)}|${r.date}`)); f4.forEach((r) => dayKeys.add(`${U(r.code)}|${r.date}`));
  A.dayRows.filter((r) => r.date >= '2026-09-28' && r.date <= TO && (r.checkIn || r.checkOut || r.punches)).forEach((r) => dayKeys.add(`${U(codeOf(r.employeeId))}|${r.date}`));
  const dayDiffs = []; const dayTot = { days: 0, inFile: 0, tlNowMissingDay: 0, firstInDiff: 0, lastOutDiff: 0, hoursDiff: 0, noOutFileVsTl: 0, statusFamilyDiff: 0, anyDiff: 0, wFirstInDiff: 0, wLastOutDiff: 0, wHoursDiff: 0, wNoOut: 0, wStatusDiff: 0, wAnyDiff: 0, fileHalfTlFull: 0, wFileHalfTlFull: 0, timeDiffDaysNow: 0, timeDiffDaysAfter: 0 };
  const cmpDay = (r, l, fileIn, fileOut, fileWorkedSec, tl) => {
    const out = { firstIn: null, lastOut: null, hours: null, noOut: false };
    if (!tl || (!tl.checkIn && !tl.checkOut)) { out.missing = true; return out; }
    const fi = fileIn ? Math.floor(L.secs(fileIn) / 60) : null; const ti = toMin(tl.checkIn);
    if (fi != null && ti != null) out.firstIn = ti - fi; else if ((fi == null) !== (ti == null)) out.firstIn = 'presence';
    const fo = fileOut ? Math.floor(L.secs(fileOut) / 60) : null; const to_ = toMin(tl.checkOut);
    if (fo != null && to_ != null) out.lastOut = to_ - fo; else if ((fo == null) !== (to_ == null)) { out.lastOut = 'presence'; out.noOut = true; }
    if (fileWorkedSec != null && tl.hours != null) out.hours = Math.round((tl.hours * 3600 - fileWorkedSec) / 60); else if (fileWorkedSec != null && tl.hours == null && fileWorkedSec > 0) out.hours = 'presence';
    return out;
  };
  const bad = (v) => v === 'presence' || (typeof v === 'number' && Math.abs(v) > 1);
  for (const k of [...dayKeys].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]) || a.localeCompare(b))) {
    const [code, date] = k.split('|');
    const e = empByCode.get(code); const r = f1By.get(k); const l = f4ByKey.get(k);
    const logTimes = l ? [...l.times].sort() : [];
    const fileIn = r ? r.firstIn : (logTimes[0] || null); // for log-only days the log's first time is the nearest thing to a check-in
    const fileOut = r ? r.lastOut : null;
    const worked = r && r.worked ? L.secs(r.worked) : null;
    const tlNow = e ? dA.get(key(e.id, date)) : null; const tlAft = e && dW ? dW.get(key(e.id, date)) : null;
    dayTot.days += 1; if (r) dayTot.inFile += 1;
    const cn = cmpDay(r, l, fileIn, fileOut, r ? worked : null, tlNow);
    const ca = tlAft ? cmpDay(r, l, fileIn, fileOut, r ? worked : null, tlAft) : null;
    const pc = r ? pulseCat(r) : (l ? 'Log only (no report row)' : '');
    const row = {
      code, name: (e && e.name) || (r && r.name) || (l && l.name) || '', date, dow: L.DOW[L.dow(date)],
      fileIn: r ? r.firstIn : '', fileOut: r ? (r.lastOut || '(blank)') : '', fileWorked: r ? (r.worked && r.worked !== '00:00:00' ? r.worked : (r.lastOut ? r.worked : '(blank)')) : '', logFirst: logTimes[0] || '', logLast: logTimes[logTimes.length - 1] || '', logCount: logTimes.length, pulseDay: pc,
      nowStatus: tlNow ? tlNow.status : (e ? 'no row' : 'not in TeamLink'), nowIn: tlNow ? tlNow.checkIn || '' : '', nowOut: tlNow ? tlNow.checkOut || '' : '', nowHours: tlNow && tlNow.hours != null ? tlNow.hours : '',
      aftStatus: tlAft ? tlAft.status : '', aftIn: tlAft ? tlAft.checkIn || '' : '', aftOut: tlAft ? tlAft.checkOut || '' : '', aftHours: tlAft && tlAft.hours != null ? tlAft.hours : '',
    };
    const flags = []; const aflags = [];
    if (cn.missing) { flags.push('TeamLink has no check-in/out for this day'); dayTot.tlNowMissingDay += 1; }
    else { if (bad(cn.firstIn)) { flags.push(`first-in differs (${cn.firstIn} min)`); dayTot.firstInDiff += 1; } if (bad(cn.lastOut)) { flags.push(`last-out differs (${cn.lastOut === 'presence' ? 'one side blank' : `${cn.lastOut} min`})`); dayTot.lastOutDiff += 1; if (cn.noOut) dayTot.noOutFileVsTl += 1; } if (bad(cn.hours)) { flags.push(`hours differ (${cn.hours === 'presence' ? 'one side blank' : `${cn.hours} min`})`); dayTot.hoursDiff += 1; } }
    if (ca) { if (ca.missing) aflags.push('still no data'); else { if (bad(ca.firstIn)) { aflags.push(`first-in (${ca.firstIn})`); dayTot.wFirstInDiff += 1; } if (bad(ca.lastOut)) { aflags.push(`last-out (${ca.lastOut})`); dayTot.wLastOutDiff += 1; if (ca.noOut) dayTot.wNoOut += 1; } if (bad(ca.hours)) { aflags.push(`hours (${ca.hours})`); dayTot.wHoursDiff += 1; } } }
    // blank check-out vs ours
    if (r && !r.lastOut) { row.blankOutNote = tlNow && tlNow.checkOut ? `File: check-in, NO check-out; TeamLink now has check-out ${tlNow.checkOut}` : 'File: check-in, NO check-out; TeamLink has none either / no day'; }
    // status family
    const pf = r ? (pc.startsWith('Present') ? 'Full day' : pc.startsWith('Half') ? 'Half day' : 'Not counted') : '';
    const nf = fam(tlNow); const af = tlAft ? fam(tlAft) : '';
    row.nowFamily = nf; row.aftFamily = af;
    if (r) {
      const same = (x) => (pf === 'Not counted' ? !['Full day', 'Half day', 'Leave'].includes(x) || false : x === pf);
      if (!same(nf) && !(cn.missing && nf === 'No device data')) { /* status differs now */ }
      row.statusNowDiff = !same(nf); row.statusAftDiff = tlAft ? !same(af) : '';
      if (row.statusNowDiff) dayTot.statusFamilyDiff += 1; if (tlAft && row.statusAftDiff) dayTot.wStatusDiff += 1;
      if (pf === 'Half day' && nf === 'Full day') dayTot.fileHalfTlFull += 1; if (pf === 'Half day' && af === 'Full day') dayTot.wFileHalfTlFull += 1;
    }
    if (r && flags.some((x) => !/no check-in/.test(x))) dayTot.timeDiffDaysNow += 1; if (r && aflags.some((x) => !/still no data/.test(x))) dayTot.timeDiffDaysAfter += 1;
    row.flagsNow = flags.join('; '); row.flagsAfter = aflags.join('; ');
    if (flags.length || row.statusNowDiff) dayTot.anyDiff += 1; if (aflags.length || row.statusAftDiff) dayTot.wAnyDiff += 1;
    if (flags.length || row.statusNowDiff || aflags.length || row.statusAftDiff || row.blankOutNote) dayDiffs.push(row);
  }
  // Day-level counts that matter in plain words
  const fileDaysWithPunchesNow = [...dayKeys].filter((k) => { const e = empByCode.get(k.split('|')[0]); const t = e && dA.get(key(e.id, k.split('|')[1])); return t && (t.checkIn || t.checkOut) && f1By.has(k); }).length;
  stats.B.day = { ...dayTot, reportDays: f1.length, reportDaysAlreadyInTeamLinkWithPunches: fileDaysWithPunchesNow };
  stats.B.noCheckOutInFile = f1.filter((r) => !r.lastOut).length;
  stats.B.doublePunchDaysInFile = f1.filter((r) => r.lastOut && L.secs(r.lastOut) - L.secs(r.firstIn) < 60).length;

  // =====================================================================
  // (C) SUMMARY (file 3) vs engine
  // =====================================================================
  const summaryOf = (D, dm, empId) => {
    let hoursDays = 0; const o = { present: 0, half: 0, weekOffs: 0, holidays: 0, leaves: 0, absent: 0, pendingLeave: 0, noData: 0, missingOut: 0, notOnRolls: 0, hoursSec: 0 };
    L.eachDay(FROM, TO).forEach((d) => {
      const r = dm.get(key(empId, d)); if (!r) return;
      if (['Not Joined', 'Left'].includes(r.status)) { o.notOnRolls += 1; return; }
      if (r.status === 'Holiday') o.holidays += 1; else if (r.status === 'Weekly Off') o.weekOffs += 1;
      if (r.status === 'No device data') o.noData += 1;
      if (r.status === 'Missing Check-Out' || r.status === 'Missing Check-In') o.missingOut += 1;
      if (!r.counted) { return; }
      if (r.present >= 1) o.present += 1; else if (r.present === 0.5) o.half += 1;
      o.leaves += (r.leave || 0) + (r.unpaidLeave || 0); o.absent += r.absent || 0; o.pendingLeave += r.pending || 0;
      if (r.hours != null) { o.hoursSec += r.hours * 3600; hoursDays += 1; }
    });
    o.leaves = Math.round(o.leaves * 100) / 100; o.hoursDays = hoursDays;
    o.payable = o.present + 0.5 * o.half + o.weekOffs + o.holidays + o.leaves;
    return o;
  };
  const sumRows = []; const sumTot = { rows: 0, anyDiffNow: 0, anyDiffAfter: 0, cols: { half: 0, present: 0, weekOffs: 0, holidays: 0, leaves: 0, payable: 0, hours: 0 }, colsAfter: { half: 0, present: 0, weekOffs: 0, holidays: 0, leaves: 0, payable: 0, hours: 0 } };
  const COLS = [['half', 'half'], ['present', 'present'], ['weekOffs', 'weekOffs'], ['holidays', 'holidays'], ['leaves', 'leaves'], ['payable', 'payable']];
  const hmsOf = (sec) => L.hms(sec);
  for (const r of f3) {
    const e = empByCode.get(U(r.code));
    const row = { code: r.code, name: r.name, tlName: e ? e.name : '', tlStatus: e ? e.employmentStatus : 'not in TeamLink', pHalf: r.half, pPresent: r.present, pWO: r.weekOffs, pPH: r.holidays, pLeaves: r.leaves, pPayable: r.payable, pHours: r.totalHours || '' };
    sumTot.rows += 1;
    if (e) {
      const n = summaryOf(A, dA, e.id); const a = W ? summaryOf(W, dW, e.id) : null;
      Object.assign(row, { nHalf: n.half, nPresent: n.present, nWO: n.weekOffs, nPH: n.holidays, nLeaves: n.leaves, nPayable: n.payable, nHours: hmsOf(n.hoursSec), nAbsent: n.absent, nNoData: n.noData, nNotOnRolls: n.notOnRolls });
      const diffs = []; const adiffs = [];
      COLS.forEach(([c, k]) => { const pv = r[k === 'weekOffs' ? 'weekOffs' : k === 'holidays' ? 'holidays' : k === 'payable' ? 'payable' : k]; const pc = { half: r.half, present: r.present, weekOffs: r.weekOffs, holidays: r.holidays, leaves: r.leaves, payable: r.payable }[c]; if (Math.abs((n[c] || 0) - (pc || 0)) > 0.01) { diffs.push(c); sumTot.cols[c] += 1; } if (a && Math.abs((a[c] || 0) - (pc || 0)) > 0.01) { adiffs.push(c); sumTot.colsAfter[c] += 1; } });
      const ph = r.totalHours ? L.secs(r.totalHours) : 0;
      const tolN = 60 + 20 * (n.hoursDays || 0); const tolA = a ? 60 + 20 * (a.hoursDays || 0) : 0;
      if (Math.abs(n.hoursSec - ph) > tolN) { diffs.push('hours'); sumTot.cols.hours += 1; } if (a && Math.abs(a.hoursSec - ph) > tolA) { adiffs.push('hours'); sumTot.colsAfter.hours += 1; }
      Object.assign(row, { dNow: diffs.join(', ') });
      if (a) Object.assign(row, { aHalf: a.half, aPresent: a.present, aWO: a.weekOffs, aPH: a.holidays, aLeaves: a.leaves, aPayable: a.payable, aHours: hmsOf(a.hoursSec), aAbsent: a.absent, aPending: a.pendingLeave, aNotOnRolls: a.notOnRolls, dAfter: adiffs.join(', ') });
      if (diffs.length) sumTot.anyDiffNow += 1; if (adiffs.length) sumTot.anyDiffAfter += 1;
      // plain reasons
      const why = [];
      if (diffs.length && !f1.some((x) => U(x.code) === U(r.code)) && (r.present || 0) === 0 && (n.present || 0) === 0 && (n.weekOffs !== r.weekOffs || n.holidays !== r.holidays)) why.push(n.notOnRolls ? `TeamLink counts ${n.notOnRolls} day(s) as not on the rolls (${e.employmentStatus}); PulseHRM still pays week offs + holiday` : 'week off / holiday not counted for this person in TeamLink');
      if (a && adiffs.includes('present')) why.push('PulseHRM counts a day as Present only after 9:00 hours worked; TeamLink clock rule counts a late-in day (in before 1:30 PM, out after 5 PM) as a full day');
      if (a && adiffs.includes('leaves')) why.push('leave counted differently (pending leave, half-day marker or holiday inside the leave)');
      if (r.code === 'TL102') why.push('PulseHRM shows only 1 week off and 0 holiday for TL102 (looks like a different joining date in PulseHRM)');
      row.why = why.join('; ');
    } else row.dNow = 'Employee not in TeamLink';
    sumRows.push(row);
  }
  // TeamLink employees on the rolls with no f3 row
  const notInSummary = A.employees.filter((x) => !people.has(U(x.employeeCode)) && activeSt(x.employmentStatus)).map((x) => x.employeeCode);
  stats.C = { employees: sumTot.rows, employeesWithAnyColumnDifferenceNow: sumTot.anyDiffNow, employeesWithAnyColumnDifferenceAfterImport: sumTot.anyDiffAfter, byColumnNow: sumTot.cols, byColumnAfterImport: sumTot.colsAfter, notInSummaryButActive: notInSummary };

  // PulseHRM's own rule, reproduced from the report file
  {
    const apprLeave = f2.filter((r) => r.status === 'Approved');
    const mism = []; let okRule = 0; let okFormula = 0; let okHours = 0;
    for (const r of f3) {
      let p = 0; let h = 0; let sec = 0;
      f1.filter((x) => U(x.code) === U(r.code)).forEach((x) => { const covered = apprLeave.some((l) => U(l.code) === U(r.code) && l.from <= x.date && l.to >= x.date); if (x.worked && x.lastOut) sec += L.secs(x.worked); if (covered || !x.lastOut) return; const w = L.secs(x.lastOut) - L.secs(x.firstIn); if (w >= 9 * 3600) p += 1; else if (w >= 4 * 3600) h += 1; });
      if (p === (r.present || 0) && h === (r.half || 0)) okRule += 1; else mism.push(`${r.code} (file ${r.present}/${r.half}, rule ${p}/${h})`);
      if (Math.abs((r.present || 0) + 0.5 * (r.half || 0) + (r.weekOffs || 0) + (r.holidays || 0) + (r.leaves || 0) - (r.payable || 0)) < 0.01) okFormula += 1;
      if (!r.totalHours || Math.abs(sec - L.secs(r.totalHours)) <= 1) okHours += 1;
    }
    stats.C.pulseRule = { rule: 'Present = worked >= 9:00:00 (last out - first in); Half-day = 4:00 to under 9:00; under 4:00 or no check-out = not counted; days covered by approved leave = leave', employeesReproduced: okRule, of: f3.length, notReproduced: mism, payableFormulaHolds: okFormula, totalHoursEqualsSumOfReport: okHours };
  }
  // calendar
  const hol = new Map(A.holidays.filter((h) => h.date >= FROM && h.date <= TO).map((h) => [h.date, h]));
  const calendar = L.eachDay(FROM, TO).map((d) => ({ date: d, dow: L.DOW[L.dow(d)], tlHoliday: hol.has(d) ? `${hol.get(d).name} (${hol.get(d).type})` : '', tlWeeklyOff: String(A.cfg.weeklyOffDays).split(',').map(Number).includes(L.dow(d)) ? 'Week off' : '', pulseExpects: (L.dow(d) === 0 ? 'Week off' : '') || (d === '2026-10-02' ? 'Public holiday (their summary shows 1)' : ''), same: ((hol.has(d) ? 'H' : '') + (String(A.cfg.weeklyOffDays).split(',').map(Number).includes(L.dow(d)) ? 'W' : '')) === ((d === '2026-10-02' ? 'H' : '') + (L.dow(d) === 0 ? 'W' : '')) ? 'Yes' : 'NO' }));
  stats.C.calendarDifferences = calendar.filter((c) => c.same === 'NO').length;
  // rule evidence: days where PulseHRM = half-day but TeamLink (after) = full day
  stats.C.pulseHalfTlFullDaysAfterImport = dayTot.wFileHalfTlFull;

  // =====================================================================
  // (D) LEAVE
  // =====================================================================
  const pLeaves = (D) => D.leaves.map((l) => ({ ...l, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10), half: leaveText.halfOf(l) }));
  const lA = pLeaves(A); const lW = W ? pLeaves(W) : null;
  const holSet = new Set(A.holidays.map((h) => h.date));
  const daysBoth = (r) => {
    const all = L.eachDay(r.from, r.to); const sundays = all.filter((d) => L.dow(d) === 0); const hols = all.filter((d) => holSet.has(d));
    const half = /first|second/i.test(r.halfDay || '') || (r.days === 0.5 && r.from === r.to);
    const rule = half ? 0.5 : all.filter((d) => L.dow(d) !== 0 && !holSet.has(d)).length;
    return { calendar: all.length, sundays: sundays.length, holidays: hols.length, rule };
  };
  const leaveRows = []; const leaveTot = { fileRows: f2.length, same: 0, missing: 0, differs: 0, byStatus: {}, tlNotInFile: 0, daysFileMissing: 0 };
  const balOf = (D, id, type) => D.balances.find((b) => b.employeeId === id && b.type === type);
  for (const r of f2) {
    const e = empByCode.get(U(r.code)); const db = daysBoth(r);
    const row = { fileRow: r.row, code: r.code, name: r.name, tlName: e ? e.name : '(not in TeamLink)', nameCheck: e ? L.compareNames(r.name, e.name) : '', type: r.type, from: r.from, to: r.to, half: r.halfDay || '', fileDays: r.days, calDays: db.calendar, sundays: db.sundays, holidays: db.holidays, ruleDays: db.rule, status: r.status, applied: r.applied, approver: r.approver || '', approvedDate: r.approvedDate || '', reason: r.reason || '', halfFlagBlankButHalfDuration: (r.days === 0.5 && !r.halfDay) ? 'YES' : '' };
    const mine = e ? lA.filter((l) => l.employeeId === e.id) : [];
    const exact = mine.filter((l) => l.type === r.type && l.from === r.from && l.to === r.to);
    const sameKeyStatus = exact.find((l) => l.status === r.status);
    const overlap = mine.filter((l) => l.from <= r.to && l.to >= r.from && !exact.includes(l));
    const diffs = [];
    if (!e) { row.result = 'Employee ID not in TeamLink'; leaveTot.missing += 1; } else if (sameKeyStatus) {
      row.tlId = sameKeyStatus.id; row.tlStatus = sameKeyStatus.status; row.tlDays = sameKeyStatus.days; row.tlHalf = sameKeyStatus.half || '';
      if (Number(sameKeyStatus.days) !== Number(r.days)) diffs.push(`days ${sameKeyStatus.days} vs ${r.days}`);
      if ((sameKeyStatus.half ? 'half' : '') !== ((r.halfDay || (r.days === 0.5 && r.from === r.to)) ? 'half' : '')) diffs.push('half-day flag');
      row.result = diffs.length ? `Differs: ${diffs.join('; ')}` : 'Same'; if (diffs.length) leaveTot.differs += 1; else leaveTot.same += 1;
    } else if (exact.length) {
      row.tlId = exact[0].id; row.tlStatus = exact.map((x) => x.status).join('/'); row.tlDays = exact[0].days; row.result = `Differs: status (TeamLink ${row.tlStatus}, file ${r.status})`; leaveTot.differs += 1;
    } else if (overlap.length) {
      row.tlId = overlap[0].id; row.tlStatus = overlap.map((x) => `${x.type} ${x.from}->${x.to} ${x.status} ${x.days}d`).join(' | ');
      row.result = `Differs: TeamLink has other leave on these dates (${row.tlStatus})`; leaveTot.differs += 1;
    } else { row.result = 'MISSING in TeamLink'; leaveTot.missing += 1; leaveTot.daysFileMissing += r.days || 0; }
    leaveTot.byStatus[`${r.status}: ${row.result.split(':')[0].split(' ')[0]}`] = (leaveTot.byStatus[`${r.status}: ${row.result.split(':')[0].split(' ')[0]}`] || 0) + 1;
    // days both ways
    row.daysDiff = Number(r.days) !== db.rule ? `file ${r.days} vs TeamLink rule ${db.rule}` : '';
    // after import: engine charge
    if (W && e) {
      const m = lW.find((l) => l.employeeId === e.id && l.type === r.type && l.from === r.from && l.to === r.to && l.status === r.status);
      if (m) { const eng = W.dayRows.filter((d) => d.leaveId === m.id); row.engineLeaveAfter = Math.round(eng.reduce((n, d) => n + (d.leave || 0) + (d.unpaidLeave || 0), 0) * 100) / 100; row.enginePendingAfter = Math.round(W.dayRows.filter((d) => d.employeeId === e.id && d.date >= r.from && d.date <= r.to).reduce((n, d) => n + (r.status === 'Pending' ? (d.pending || 0) : 0), 0) * 100) / 100; }
    }
    // balance
    if (e) { const b = balOf(A, e.id, r.type); if (b) { row.balTotal = b.total; row.balTaken = b.taken; row.balRemaining = b.total - b.taken; row.balAfterIfDrawn = r.status === 'Approved' ? b.total - b.taken - (Number(r.days) || 0) : ''; row.balUpdated = b.updatedAt ? b.updatedAt.slice(0, 10) : ''; } }
    leaveRows.push(row);
  }
  // TeamLink leave overlapping the window with no file row
  const tlNotInFileLeave = lA.filter((l) => l.from <= TO && l.to >= FROM && !f2.some((r) => { const e = empByCode.get(U(r.code)); return e && e.id === l.employeeId && r.type === l.type && r.from === l.from && r.to === l.to; }))
    .map((l) => ({ code: codeOf(l.employeeId), name: (empById.get(l.employeeId) || {}).name, type: l.type, from: l.from, to: l.to, days: l.days, status: l.status, decidedBy: l.decidedBy || '', createdAt: (l.createdAt || '').slice(0, 10), note: f2.some((r) => U(r.code) === U(codeOf(l.employeeId))) ? 'person has other rows in the file' : 'person has no leave rows in the file' }));
  leaveTot.tlNotInFile = tlNotInFileLeave.length;
  const oldestFileFrom = f2.map((r) => r.from).sort()[0];
  stats.D = { ...leaveTot, fileLeaveFrom: oldestFileFrom, fileLeaveToMax: f2.map((r) => r.to).sort().pop(), fileHalfBlankButHalfDuration: leaveRows.filter((r) => r.halfFlagBlankButHalfDuration).length, fileRowsDaysDifferFromTeamLinkRule: leaveRows.filter((r) => r.daysDiff).length, byStatusInFile: f2.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}), approvedDaysMissing: leaveRows.filter((r) => r.result === 'MISSING in TeamLink' && r.status === 'Approved').reduce((n, r) => n + r.fileDays, 0), balancesLastUpdated: [...new Set(A.balances.map((b) => (b.updatedAt || '').slice(0, 10)))].sort().slice(-3) };

  // =====================================================================
  // WORKBOOK
  // =====================================================================
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); wb.creator = 'TeamLink PulseHRM reconciliation'; wb.created = new Date();
  const sheet = (name, cols, rows, opts = {}) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: opts.headerRow || 1 }] });
    ws.columns = cols.map((c) => ({ header: c[0], key: c[1], width: c[2] || 14 }));
    rows.forEach((r) => ws.addRow(r));
    const h = ws.getRow(1); h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E9C' } }; h.alignment = { vertical: 'middle', wrapText: true };
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return ws;
  };
  const shade = (ws, test, argb) => ws.eachRow((row, i) => { if (i > 1 && test(row)) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }); });

  // Summary
  const S = [];
  const add = (check, total, ok, bad_, note = '') => S.push({ check, total, ok, bad: bad_, note });
  add('Employees: IDs in the 4 files (distinct)', stats.A.distinctIdsInFiles, stats.A.idAndNameMatch, stats.A.distinctIdsInFiles - stats.A.idAndNameMatch, 'ok = ID found in TeamLink AND name matches');
  add('  - ID in TeamLink, name matches exactly / after clean-up (spaces, case, dots)', stats.A.matchedById, stats.A.idAndNameMatchExactOrCleanup, '', '');
  add('  - ID in TeamLink, name matches only by order / initials', stats.A.matchedById, stats.A.idAndNameMatchInitialsOrder, '', '');
  add('  - ID in TeamLink but NAME DIFFERS', stats.A.matchedById, '', stats.A.nameDiffers, '');
  add('  - ID in file but NOT in TeamLink', stats.A.distinctIdsInFiles, '', stats.A.idInFileNotInTeamLink.length, stats.A.idInFileNotInTeamLink.join('; '));
  add('  - Active TeamLink employees with NO row in any file', A.employees.filter((x) => activeSt(x.employmentStatus)).length, '', stats.A.teamlinkActiveNotInAnyFile, notInFile.map((x) => `${x.code} ${x.name}`).join('; '));
  add('  - Same name under two IDs (file vs TeamLink)', '', '', stats.A.sameNameOtherId + stats.A.tlDuplicateNames, 'see Employee match');
  add('  - Department differs (file vs TeamLink), matched people', stats.A.matchedById, stats.A.matchedById - stats.A.deptDiffers, stats.A.deptDiffers, 'known: PulseHRM departments are HR/Recruitment; TeamLink uses Education/Medical/...');
  add('  - Designation differs, matched people', stats.A.matchedById, stats.A.matchedById - stats.A.desigDiffers, stats.A.desigDiffers, '');
  add('Punches: raw punches in the bio-metric log file (employee-day-second)', punchTot.file, punchTot.inTable, punchTot.file - punchTot.inTable, `of the missing: ${punchTot.onlyLog} are kept only in the imported log text (AttendanceHistory), ${punchTot.missing + punchTot.noEmployee} are nowhere in TeamLink`);
  add('  - After the prepared import (what-if copy): punch table / log text / nowhere', punchTot.file, W ? punchTot.wInTable : '', W ? punchTot.wOnlyLog + punchTot.wMissing : '', W ? `${punchTot.wInTable} in punch table, ${punchTot.wOnlyLog} in log text (by design only first-in/last-out become punches), ${punchTot.wMissing} nowhere (3 employees not in TeamLink)` : '');
  add('  - TeamLink punches in the window that are not in the files', '', '', tlNotInFile, '');
  add('Days: employee-days in report/log files or TeamLink', dayTot.days, '', dayTot.anyDiff, `report days ${f1.length}; TeamLink has NO check-in/out for ${dayTot.tlNowMissingDay} of them`);
  add('  - first-in differs by more than 1 min (TeamLink now)', dayTot.inFile, '', dayTot.firstInDiff, '');
  add('  - last-out differs by more than 1 min / one side blank (TeamLink now)', dayTot.inFile, '', dayTot.lastOutDiff, '');
  add('  - hours worked differ by more than 1 min (TeamLink now)', dayTot.inFile, '', dayTot.hoursDiff, '');
  add('  - same three checks AFTER the prepared import', dayTot.inFile, W ? dayTot.inFile - dayTot.timeDiffDaysAfter : '', W ? dayTot.timeDiffDaysAfter : '', 'report days still differing in first-in / last-out / hours after import (the check-out of a few-seconds double scan is dropped by the engine)');
  add('  - day status family (Full/Half/Not counted) differs, TeamLink now', dayTot.inFile, '', dayTot.statusFamilyDiff, '');
  add('  - day status family differs AFTER import (PulseHRM Half-day vs TeamLink Full day = clock rule)', dayTot.inFile, '', W ? dayTot.wStatusDiff : '', `of which PulseHRM half-day but TeamLink full day: ${dayTot.wFileHalfTlFull}`);
  add('Summary file: employees (rows)', sumTot.rows, sumTot.rows - sumTot.anyDiffNow, sumTot.anyDiffNow, 'rows with any of Present/Half/WeekOff/Holiday/Leaves/Payable/Hours different, TeamLink now');
  add('  - same, AFTER the prepared import', sumTot.rows, W ? sumTot.rows - sumTot.anyDiffAfter : '', W ? sumTot.anyDiffAfter : '', '');
  Object.entries(sumTot.cols).forEach(([c, n]) => add(`  - column ${c}: rows different (now -> after import)`, sumTot.rows, '', `${n} -> ${W ? sumTot.colsAfter[c] : ''}`, ''));
  add('Calendar: dates where TeamLink week-off / holiday differs from PulseHRM', calendar.length, calendar.length - stats.C.calendarDifferences, stats.C.calendarDifferences, 'TeamLink: Sunday off only + Gandhi Jayanti 2 Oct = same as PulseHRM');
  add('Leave: file rows', f2.length, leaveTot.same, leaveTot.missing + leaveTot.differs, `missing in TeamLink ${leaveTot.missing}, exists but differs ${leaveTot.differs}, same ${leaveTot.same}`);
  add('  - TeamLink leave rows in the window that the file does not have', '', '', leaveTot.tlNotInFile, '');
  add('  - rows with Duration 0.5 but Half Day blank', '', '', stats.D.fileHalfBlankButHalfDuration, 'PulseHRM counts them as a FULL leave day in its summary');
  const ws0 = sheet('Summary', [['Check', 'check', 70], ['Total', 'total', 10], ['OK / matches', 'ok', 14], ['Differences', 'bad', 16], ['Note', 'note', 90]], S);
  ws0.insertRow(1, [`TeamLink vs PulseHRM, ${FROM} to ${TO}. TeamLink snapshot ${A.meta.takenAt}; engine read as of ${A.meta.today}; late after ${A.cfg.graceTime}; week off day numbers ${A.cfg.weeklyOffDays}.`]);
  ws0.getRow(2).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws0.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E9C' } };
  ws0.views = [{ state: 'frozen', ySplit: 2 }]; ws0.autoFilter = undefined;

  sheet('Employee match', [['ID', 'code', 9], ['Status', 'status', 46], ['In files', 'inFiles', 22], ['Name in file', 'fileName', 30], ['Name in TeamLink', 'tlName', 30], ['Name compare', 'nameCompare', 16], ['TeamLink status', 'tlStatus', 14], ['Dept in file', 'fileDept', 18], ['Dept in TeamLink', 'tlDept', 18], ['Dept differs', 'deptDiff', 10], ['Designation in file', 'fileDesig', 16], ['Designation in TeamLink', 'tlDesig', 18], ['Desig differs', 'desigDiff', 10], ['Note', 'note', 60]], empRows.sort((a, b) => a.code.localeCompare(b.code)).map((r) => ({ ...r, deptDiff: r.deptDiff ? 'YES' : '', desigDiff: r.desigDiff ? 'YES' : '' })));
  const wsEm = wb.getWorksheet('Employee match'); shade(wsEm, (row) => /NAME DIFFERS|not in TeamLink|RELIEVED/i.test(String(row.getCell(2).value)), 'FFFDE9D9');
  sheet('Same name other ID', [['ID in file', 'fileCode', 10], ['Name in file', 'fileName', 30], ['ID in TeamLink', 'tlCode', 12], ['Name in TeamLink', 'tlName', 30], ['TeamLink status', 'tlStatus', 14]], sameNameOtherId);
  sheet('Duplicates', [['What', 'what', 100]], [...fileDup.map((x) => ({ what: `FILE: ${x}` })), ...dupes.map((d) => ({ what: `TEAMLINK: ${d.code} ${d.name} (${d.thisStatus}) and ${d.otherCode} ${d.otherName} (${d.otherStatus}) are the same name` }))]);
  sheet('Dept-Desig diffs', [['ID', 'code', 9], ['Name', 'tlName', 28], ['TeamLink status', 'tlStatus', 14], ['Dept file', 'fileDept', 20], ['Dept TeamLink', 'tlDept', 20], ['Desig file', 'fileDesig', 18], ['Desig TeamLink', 'tlDesig', 18]], bothDiff.sort((a, b) => (activeSt(a.tlStatus) === activeSt(b.tlStatus) ? 0 : activeSt(a.tlStatus) ? -1 : 1) || a.code.localeCompare(b.code)));
  sheet('Not in file', [['ID', 'code', 10], ['Name', 'name', 30], ['TeamLink status', 'status', 14], ['Dept', 'dept', 16], ['Designation', 'desig', 16], ['Joined', 'doj', 12], ['TeamLink punches in window', 'tlPunchesInWindow', 14]], notInFile);
  sheet('Not in TeamLink', [['ID', 'code', 10], ['Name in file', 'fileName', 30], ['Status', 'status', 46], ['In files', 'inFiles', 24], ['Dept in file', 'fileDept', 18], ['Designation', 'fileDesig', 18]], notInTL);
  sheet('Punch diffs', [['ID', 'code', 9], ['Name', 'name', 28], ['Date', 'date', 12], ['Time (IST)', 'time', 11], ['Side', 'side', 36], ['Where it is in TeamLink now', 'where', 48], ['After prepared import (copy)', 'after', 48]], punchRows);
  sheet('Day diffs', [['ID', 'code', 9], ['Name', 'name', 26], ['Date', 'date', 12], ['Day', 'dow', 6], ['File first-in', 'fileIn', 11], ['File last-out', 'fileOut', 11], ['File time worked', 'fileWorked', 11], ['Log first punch', 'logFirst', 11], ['Log last punch', 'logLast', 11], ['Log punches', 'logCount', 8], ['PulseHRM day (9h/4h rule)', 'pulseDay', 26], ['TeamLink now: status', 'nowStatus', 20], ['in', 'nowIn', 7], ['out', 'nowOut', 7], ['hours', 'nowHours', 7], ['What differs now', 'flagsNow', 46], ['TeamLink after import: status', 'aftStatus', 22], ['in', 'aftIn', 7], ['out', 'aftOut', 7], ['hours', 'aftHours', 7], ['What differs after', 'flagsAfter', 30], ['Status now differs from PulseHRM', 'statusNowDiff', 10], ['Status after differs', 'statusAftDiff', 10], ['Blank check-out note', 'blankOutNote', 60]], dayDiffs.map((r) => ({ ...r, statusNowDiff: r.statusNowDiff === true ? 'YES' : '', statusAftDiff: r.statusAftDiff === true ? 'YES' : '' })));
  sheet('Summary diffs', [['ID', 'code', 9], ['Name (file)', 'name', 26], ['TeamLink status', 'tlStatus', 12], ['PH half', 'pHalf', 7], ['PH present', 'pPresent', 8], ['PH week off', 'pWO', 8], ['PH holiday', 'pPH', 8], ['PH leaves', 'pLeaves', 8], ['PH payable', 'pPayable', 8], ['PH hours', 'pHours', 10], ['TL now half', 'nHalf', 8], ['TL now present', 'nPresent', 8], ['TL now week off', 'nWO', 8], ['TL now holiday', 'nPH', 8], ['TL now leaves', 'nLeaves', 8], ['TL now payable', 'nPayable', 8], ['TL now hours', 'nHours', 10], ['TL now absent', 'nAbsent', 8], ['TL now no-data days', 'nNoData', 8], ['TL now not-on-rolls days', 'nNotOnRolls', 8], ['Columns differ now', 'dNow', 26], ['TL after half', 'aHalf', 8], ['TL after present', 'aPresent', 8], ['TL after week off', 'aWO', 8], ['TL after holiday', 'aPH', 8], ['TL after leaves', 'aLeaves', 8], ['TL after payable', 'aPayable', 8], ['TL after hours', 'aHours', 10], ['TL after absent', 'aAbsent', 8], ['TL after pending-leave days', 'aPending', 8], ['TL after not-on-rolls', 'aNotOnRolls', 8], ['Columns differ after', 'dAfter', 26], ['Why (plain words)', 'why', 80]], sumRows);
  sheet('Calendar', [['Date', 'date', 12], ['Day', 'dow', 6], ['TeamLink holiday', 'tlHoliday', 32], ['TeamLink week off', 'tlWeeklyOff', 14], ['PulseHRM implies', 'pulseExpects', 38], ['Same?', 'same', 8]], calendar);
  sheet('Leave diffs', [['File row', 'fileRow', 7], ['ID', 'code', 8], ['Name (file)', 'name', 24], ['TeamLink name', 'tlName', 24], ['Name check', 'nameCheck', 14], ['Type', 'type', 14], ['From', 'from', 11], ['To', 'to', 11], ['Half day', 'half', 11], ['Duration (file)', 'fileDays', 9], ['Calendar days', 'calDays', 9], ['Sundays', 'sundays', 8], ['Holidays', 'holidays', 8], ['TeamLink rule days (Sunday+holiday off, half=0.5)', 'ruleDays', 12], ['Days differ', 'daysDiff', 26], ['Status (file)', 'status', 11], ['Applied', 'applied', 11], ['Approver', 'approver', 24], ['Approved date', 'approvedDate', 11], ['RESULT vs TeamLink', 'result', 60], ['TeamLink leave id', 'tlId', 12], ['TeamLink status', 'tlStatus', 30], ['TeamLink days', 'tlDays', 8], ['Half blank but 0.5', 'halfFlagBlankButHalfDuration', 9], ['Engine leave days after import', 'engineLeaveAfter', 10], ['Balance total', 'balTotal', 8], ['Balance taken', 'balTaken', 8], ['Balance left', 'balRemaining', 8], ['Left if Approved days drawn', 'balAfterIfDrawn', 10], ['Balance last updated', 'balUpdated', 12], ['Reason', 'reason', 30]], leaveRows);
  sheet('Leave in TeamLink not in file', [['ID', 'code', 8], ['Name', 'name', 26], ['Type', 'type', 14], ['From', 'from', 11], ['To', 'to', 11], ['Days', 'days', 6], ['Status', 'status', 11], ['Decided by', 'decidedBy', 22], ['Applied', 'createdAt', 11], ['Note', 'note', 40]], tlNotInFileLeave);
  if (plan) {
    const pr = [];
    (plan.days.items || []).forEach((i) => pr.push({ part: 'Day', code: i.employeeRef, who: i.employee ? i.employee.name : i.sourceName, date: i.date, action: i.action, detail: `${i.firstCheckIn || '-'} / ${i.lastCheckOut || '-'}; log punches ${(i.punchTimes || '').split('|').filter(Boolean).length}; add In ${i.addIn ? 'yes' : 'no'}, Out ${i.addOut ? 'yes' : 'no'}`, result: i.result + (i.note ? ` | ${i.note}` : '') }));
    (plan.summary.items || []).forEach((i) => pr.push({ part: 'Summary', code: i.employeeRef, who: i.employee ? i.employee.name : i.sourceName, date: `${i.periodFrom}..${i.periodTo}`, action: i.action, detail: `present ${i.present} half ${i.halfDay} WO ${i.weekOffs} PH ${i.publicHolidays} leaves ${i.leaves} payable ${i.payableDays}`, result: '' }));
    (plan.leave.items || []).forEach((i) => pr.push({ part: 'Leave', code: i.row.code, who: i.row.name, date: `${i.row.from}..${i.row.to}`, action: i.action, detail: `${i.row.type} ${i.row.days}d ${i.row.status}${i.row.halfDay ? ` (${i.row.halfDay})` : ''}`, result: (i.notes || []).join(' | ') }));
    sheet('Fix plan (dry-run)', [['Part', 'part', 9], ['ID', 'code', 9], ['Who', 'who', 28], ['Date', 'date', 24], ['Planned action', 'action', 22], ['Detail', 'detail', 60], ['Result / note', 'result', 90]], pr);
    stats.plan = { days: Object.fromEntries(Object.entries(plan.days.items.reduce((m, x) => { m[x.action] = (m[x.action] || 0) + 1; return m; }, {}))), summary: plan.summary.items.reduce((m, x) => { m[x.action] = (m[x.action] || 0) + 1; return m; }, {}), leave: plan.leave.items.reduce((m, x) => { m[x.action] = (m[x.action] || 0) + 1; return m; }, {}) };
  }
  await wb.xlsx.writeFile(XLSX);
  fs.writeFileSync(JSONOUT, JSON.stringify({ stats, nameDiffers: nameDiffers.map((r) => [r.code, r.fileName, r.tlName]), sameNameOtherId, dupes, notInFile, notInTL: notInTL.map((r) => [r.code, r.fileName, r.status]), deptDeskTop: bothDiff.slice(0, 20).map((r) => [r.code, r.tlName, r.tlStatus, r.fileDept, r.tlDept, r.fileDesig, r.tlDesig]), calendar, leaveRows, tlNotInFileLeave, sumRows }, null, 1));
  console.log(JSON.stringify(stats, null, 1));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

/* eslint-disable no-console */
// Recruiter-wise & designation-wise recruitment status report from the local ATS database (read only).
// node recruiter-report.js <out.xlsx>
const path = require('path');

const BACK = path.resolve(__dirname, '..', '..');
process.chdir(BACK);
const ExcelJS = require(path.join(BACK, 'node_modules/exceljs'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const OUT = process.argv[2];
const TODAY = new Date();
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const days = (d) => (d ? Math.max(0, Math.floor((TODAY - new Date(d)) / 86400000)) : '');

const RANK = { NEW: 0, AI_INTERVIEW_REQUIRED: 0, AI_INTERVIEW_SCHEDULED: 0, AI_INTERVIEW_COMPLETED: 0, RECRUITER_REVIEW: 1, RECRUITER_APPROVED: 1, TL_REVIEW: 1, WITH_BDE: 2, BDE_APPROVED: 2, SHARED_WITH_CLIENT: 3, CLIENT_REVIEW: 3, CLIENT_SHORTLISTED: 4, INTERVIEW_SCHEDULED: 5, INTERVIEW_COMPLETED: 6, SELECTED: 7, OFFER: 8, OFFER_ACCEPTED: 9, JOINED: 10, HIRED: 10 };
const LABEL = { NEW: 'New', RECRUITER_REVIEW: 'Recruiter check', RECRUITER_APPROVED: 'Recruiter approved', TL_REVIEW: 'TL check', WITH_BDE: 'With BDE', BDE_APPROVED: 'BDE approved', SHARED_WITH_CLIENT: 'Sent to client', CLIENT_REVIEW: 'Client reviewing', CLIENT_SHORTLISTED: 'Client shortlisted', INTERVIEW_SCHEDULED: 'Interview scheduled', INTERVIEW_COMPLETED: 'Interview done - feedback awaited', SELECTED: 'Selected', OFFER: 'Offer made', OFFER_ACCEPTED: 'Offer accepted', JOINED: 'Joined', HIRED: 'Joined', REJECTED: 'Rejected', HOLD: 'On hold' };
const NEXT = { NEW: 'Recruiter to check the profile', RECRUITER_REVIEW: 'Recruiter to check the profile', TL_REVIEW: 'TL to check', WITH_BDE: 'BDE to send to client', SHARED_WITH_CLIENT: 'Get client feedback / fix interview', CLIENT_REVIEW: 'Get client feedback', CLIENT_SHORTLISTED: 'Fix the interview / demo', INTERVIEW_SCHEDULED: 'Make sure the candidate attends', INTERVIEW_COMPLETED: 'Get interview feedback', SELECTED: 'Close the offer', OFFER: 'Get offer acceptance', OFFER_ACCEPTED: 'Confirm joining date', HOLD: 'Follow up the hold' };
const FINAL = new Set(['JOINED', 'HIRED', 'REJECTED']);
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(' ').filter(Boolean);
const nameMatch = (name, people) => {
  const t = toks(name); if (!t.some((x) => x.length > 1)) return null;
  const hits = people.filter((u) => { const ut = toks(u.name); return t.every((x) => (x.length === 1 ? ut.some((y) => y[0] === x) : ut.includes(x))); });
  return hits.length === 1 ? hits[0] : null;
};

(async () => {
  const prisma = new PrismaClient();
  const users = await prisma.user.findMany({ where: { atsRole: { in: ['RECRUITER', 'TL', 'BDE', 'STL'] } }, select: { id: true, name: true, atsRole: true, atsDepartment: true, employee: { select: { employeeCode: true, designation: true, department: true, tl: true, dateOfJoining: true, employmentStatus: true, id: true } } } });
  const userById = new Map(users.map((u) => [u.id, u]));
  const recruiters = users.filter((u) => u.atsRole === 'RECRUITER');
  const emps = await prisma.employee.findMany({ select: { id: true, name: true, designation: true, department: true, employmentStatus: true, employeeCode: true } });
  const seats = await prisma.positionAssignment.findMany({ where: { toDate: null }, include: { position: { select: { code: true } } } });
  const seatOfEmp = new Map(seats.map((s) => [s.employeeId, s.position.code]));
  const reqs = await prisma.requirement.findMany({ select: { id: true, reqCode: true, title: true, status: true, department: true, tl: true, openings: true, clientId: true, client: { select: { name: true, bdeOwner: true } }, recruiterId: true, recruiterIds: true } });
  const clients = await prisma.client.findMany({ select: { id: true, name: true, ownerDepartment: true, bdeOwner: true, agreementStatus: true, status: true } });
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const apps = await prisma.application.findMany({ select: { id: true, stage: true, candidateId: true, requirementId: true, ownerRecruiterId: true, interviewAt: true, joiningDate: true, joinedAt: true, offeredCtc: true, offerDate: true, createdAt: true, updatedAt: true, candidate: { select: { name: true } } } });
  const fus = await prisma.applicationFollowUp.findMany({ select: { applicationId: true, ownerName: true, ownerUserId: true, tlName: true, tlUserId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  const fuOf = new Map(); fus.forEach((f) => { if (!fuOf.has(f.applicationId)) fuOf.set(f.applicationId, f); });
  const evs = await prisma.applicationStageEvent.findMany({ select: { applicationId: true, toStage: true, createdAt: true } });
  const maxRank = new Map(); const stageSince = new Map();
  evs.forEach((e) => { const r = RANK[e.toStage]; if (r !== undefined) maxRank.set(e.applicationId, Math.max(maxRank.get(e.applicationId) || 0, r)); });
  const appStage = new Map(apps.map((a) => [a.id, a.stage]));
  evs.forEach((e) => { if (e.toStage === appStage.get(e.applicationId)) { const p = stageSince.get(e.applicationId); if (!p || e.createdAt > p) stageSince.set(e.applicationId, e.createdAt); } });

  // ---- who each application is credited to ----
  const credit = (a) => {
    const f = fuOf.get(a.id);
    const when = (f && f.createdAt) || a.createdAt;
    if (a.ownerRecruiterId && userById.has(a.ownerRecruiterId)) return { key: `u:${a.ownerRecruiterId}`, user: userById.get(a.ownerRecruiterId), recorded: f && f.ownerName, when };
    const recorded = f && f.ownerName ? f.ownerName.trim() : '';
    if (!recorded) return { key: 'none', recorded: '', when };
    const u = nameMatch(recorded, recruiters);
    if (u && u.employee && u.employee.dateOfJoining && new Date(when) >= new Date(u.employee.dateOfJoining)) return { key: `u:${u.id}`, user: u, recorded, when };
    return { key: `n:${recorded.toLowerCase().replace(/\s+/g, ' ')}`, recorded, when };
  };
  const tlOf = (a) => { const f = fuOf.get(a.id); if (f && f.tlUserId && userById.has(f.tlUserId)) return userById.get(f.tlUserId).name; if (f && f.tlName) return f.tlName.trim(); const r = reqById.get(a.requirementId); return (r && r.tl) || ''; };

  const people = new Map();
  const blank = () => ({ apps: [], reqs: new Set(), openReqs: new Set(), cands: new Set(), tls: {} });
  users.forEach((u) => { people.set(`u:${u.id}`, { ...blank(), user: u, display: u.name }); });
  const rows = apps.map((a) => {
    const c = credit(a); const r = reqById.get(a.requirementId) || {};
    if (!people.has(c.key)) people.set(c.key, { ...blank(), display: c.key === 'none' ? '(no recruiter recorded)' : c.recorded });
    const p = people.get(c.key);
    const reached = Math.max(maxRank.get(a.id) || 0, RANK[a.stage] || 0);
    const row = { a, r, c, p, reached, tl: tlOf(a), since: stageSince.get(a.id) || a.updatedAt };
    p.apps.push(row); p.reqs.add(a.requirementId); if (r.status === 'OPEN') p.openReqs.add(a.requirementId); p.cands.add(a.candidateId);
    if (row.tl) p.tls[row.tl] = (p.tls[row.tl] || 0) + 1;
    return row;
  });
  const statsOf = (list) => {
    const s = { cands: new Set(list.map((x) => x.a.candidateId)).size, apps: list.length, reqs: new Set(list.map((x) => x.a.requirementId)).size, open: new Set(list.filter((x) => x.r.status === 'OPEN').map((x) => x.a.requirementId)).size, active: 0, sent: 0, ivs: 0, ivd: 0, sel: 0, acc: 0, joined: 0, rej: 0, hold: 0 };
    list.forEach((x) => {
      const st = x.a.stage; const rk = x.reached;
      if (!FINAL.has(st)) s.active += 1;
      if (rk >= 3) s.sent += 1; if (rk >= 5) s.ivs += 1; if (rk >= 6) s.ivd += 1; if (rk >= 7) s.sel += 1; if (rk >= 9) s.acc += 1;
      if (st === 'JOINED' || st === 'HIRED') s.joined += 1; if (st === 'REJECTED') s.rej += 1; if (st === 'HOLD') s.hold += 1;
    });
    s.joinPct = s.apps ? Math.round((s.joined / s.apps) * 1000) / 10 : 0;
    s.selPct = s.ivs ? Math.round((s.sel / s.ivs) * 1000) / 10 : 0;
    return s;
  };
  const infoOf = (p) => {
    if (p.user) {
      const e = p.user.employee || {};
      return { link: 'Current login', designation: e.designation || p.user.atsRole, department: e.department || p.user.atsDepartment || '', tl: e.tl || '', seat: seatOfEmp.get(e.id) || '', status: e.employmentStatus || 'Active', code: e.employeeCode || '' };
    }
    if (p.display === '(no recruiter recorded)') return { link: '-', designation: '-', department: '', tl: '', seat: '', status: '-', code: '' };
    const e = nameMatch(p.display, emps);
    const tl = Object.entries(p.tls).sort((a, b) => b[1] - a[1])[0];
    return e ? { link: 'Name as recorded = HRMS employee', designation: e.designation || '', department: e.department || '', tl: tl ? tl[0] : '', seat: '', status: e.employmentStatus, code: e.employeeCode }
      : { link: 'Name as recorded (not found in HRMS)', designation: 'Not in HRMS', department: '', tl: tl ? tl[0] : '', seat: '', status: 'Unknown', code: '' };
  };
  const deptOf = (p) => { const d = {}; p.apps.forEach((x) => { if (x.r.department) d[x.r.department] = (d[x.r.department] || 0) + 1; }); return Object.keys(d).sort((a, b) => d[b] - d[a]).join(' / '); };

  // ---- workbook ----
  const wb = new ExcelJS.Workbook(); wb.creator = 'TeamLink (local ATS)'; wb.created = TODAY;
  const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  const addTable = (ws, headers, data, widths) => {
    const hr = ws.addRow(headers); hr.font = { bold: true, color: { argb: 'FFFFFFFF' } }; hr.fill = HEAD; hr.alignment = { vertical: 'middle', wrapText: true }; hr.height = 32;
    const start = hr.number;
    data.forEach((d) => ws.addRow(d));
    ws.columns.forEach((c, i) => { c.width = (widths && widths[i]) || 14; });
    ws.autoFilter = { from: { row: start, column: 1 }, to: { row: start + data.length, column: headers.length } };
    ws.views = [{ state: 'frozen', ySplit: start, xSplit: 1 }];
  };
  const title = (ws, t, sub) => { ws.addRow([t]).font = { bold: true, size: 14 }; if (sub) ws.addRow([sub]).font = { italic: true, color: { argb: 'FF555555' } }; ws.addRow([]); };
  const STAT_HEAD = ['Candidates', 'Applications', 'Requirements worked', 'Open requirements', 'Active now', 'Sent to client', 'Interviews scheduled', 'Interviews done', 'Selected', 'Offer accepted', 'Joined', 'Rejected', 'On hold', 'Joined % of applications', 'Selected % of interviewed'];
  const statCells = (s) => [s.cands, s.apps, s.reqs, s.open, s.active, s.sent, s.ivs, s.ivd, s.sel, s.acc, s.joined, s.rej, s.hold, s.joinPct, s.selPct];
  const all = statsOf(rows);
  const period = `All data in the local ATS as of ${ymd(TODAY)} (history from the joinings sheets 2022-2026 and the Education interview tracker Jul-Oct 2026)`;

  // 1. Summary
  {
    const ws = wb.addWorksheet('1. Summary');
    title(ws, 'Recruiter-Wise Recruitment Status & Performance Report', period);
    const reqOpen = reqs.filter((r) => r.status === 'OPEN');
    [['Clients', (await prisma.client.count())], ['Requirements (total)', reqs.length], ['Requirements open', reqOpen.length], ['Open requirements with a recruiter assigned', reqOpen.filter((r) => r.recruiterId || r.recruiterIds).length],
      ['Candidates (people)', all.cands], ['Applications', all.apps], ['In process now (not joined / rejected)', all.active], ['Interviews scheduled (reached)', all.ivs], ['Interviews done (reached)', all.ivd],
      ['Selected (reached)', all.sel], ['Offer accepted (reached)', all.acc], ['Joined', all.joined], ['Rejected', all.rej]].forEach((r) => { const x = ws.addRow(r); x.getCell(1).font = { bold: true }; });
    ws.addRow([]); ws.addRow(['By department']).font = { bold: true, size: 12 };
    const byDept = {}; rows.forEach((x) => { const d = x.r.department || '(none)'; (byDept[d] = byDept[d] || []).push(x); });
    addTable(ws, ['Department', ...STAT_HEAD], Object.entries(byDept).map(([d, l]) => [d, ...statCells(statsOf(l))]), [24]);
    ws.views = [];
    ws.getColumn(1).width = 44;
  }
  // 2. Recruiter-wise
  // BDEs look after clients, not candidates: they get their own sheets (2b / 2c), not a row of zeros here
  const pRows = [...people.values()].filter((p) => (p.apps.length || p.user) && !(p.user && p.user.atsRole === 'BDE'));
  {
    const ws = wb.addWorksheet('2. Recruiter-wise');
    title(ws, 'Recruiter-wise performance', 'One row per person. "Reached" counts include everyone who went past that step (a joined candidate also counts as sent, interviewed and selected).');
    const data = pRows.map((p) => { const i = infoOf(p); return [p.display, i.code, i.designation, i.department || deptOf(p), i.tl, i.seat, i.status, i.link, ...statCells(statsOf(p.apps))]; })
      .sort((a, b) => (a[7] === 'Current login' ? 0 : 1) - (b[7] === 'Current login' ? 0 : 1) || b[8] - a[8]);
    addTable(ws, ['Recruiter', 'Employee ID', 'Designation', 'Department', 'TL', 'Seat', 'Employment status', 'How credited', ...STAT_HEAD], data, [30, 11, 14, 16, 24, 9, 14, 30]);
  }
  // 2b. BDE-wise (clients) + 2c. Client-wise: a BDE is measured on the clients they look after (Client.bdeOwner)
  {
    const month = ymd(TODAY).slice(0, 7);
    const reqsOf = new Map(); reqs.forEach((r) => { (reqsOf.get(r.clientId) || reqsOf.set(r.clientId, []).get(r.clientId)).push(r); });
    const appsOf = new Map(); rows.forEach((x) => { const c = x.r.clientId; if (c) (appsOf.get(c) || appsOf.set(c, []).get(c)).push(x); });
    const jdOf = (x) => x.a.joiningDate || ymd(x.a.joinedAt) || ymd(x.since);
    const clientStats = (c) => {
      const rq = reqsOf.get(c.id) || []; const ap = appsOf.get(c.id) || []; const s = statsOf(ap);
      const open = rq.filter((r) => r.status === 'OPEN');
      const joins = ap.filter((x) => ['JOINED', 'HIRED'].includes(x.a.stage)).map(jdOf).filter(Boolean).sort();
      return { c, signed: c.agreementStatus === 'ACTIVE', reqs: rq.length, open: open.length, positions: open.reduce((a, r) => a + (r.openings || 0), 0), s, lastJoin: joins[joins.length - 1] || '', joinedMonth: ap.filter((x) => ['JOINED', 'HIRED'].includes(x.a.stage) && String(jdOf(x)).startsWith(month)).length };
    };
    const cs = clients.map(clientStats);
    const bdeUsers = users.filter((u) => u.atsRole === 'BDE');
    const groups = new Map(bdeUsers.map((u) => [u.name, []]));
    cs.forEach((x) => { const k = x.c.bdeOwner || '(no BDE assigned)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    const ws = wb.addWorksheet('2b. BDE-wise (clients)');
    title(ws, 'BDE-wise client performance', `A BDE is measured on the clients they look after (Client manager / BDE on each client). Joined this month = ${month}.`);
    const data = [...groups].map(([name, list]) => {
      const u = bdeUsers.find((b) => b.name === name); const e = (u && u.employee) || {};
      const depts = [...new Set(list.map((x) => x.c.ownerDepartment).filter(Boolean))].join(' / ');
      const allApps = list.flatMap((x) => appsOf.get(x.c.id) || []); const s = statsOf(allApps);
      const running = list.filter((x) => x.open > 0).length;
      return [name, e.employeeCode || '', depts, e.employmentStatus || (u ? 'Active' : '-'), list.length, list.filter((x) => x.signed).length, list.filter((x) => !x.signed).length,
        running, list.length - running, list.reduce((a, x) => a + x.reqs, 0), list.reduce((a, x) => a + x.open, 0), list.reduce((a, x) => a + x.positions, 0),
        s.cands, s.apps, s.active, s.sent, s.ivs, s.sel, s.acc, s.joined, list.reduce((a, x) => a + x.joinedMonth, 0), s.rej, s.joinPct,
        list.length ? Math.round((running / list.length) * 1000) / 10 : 0];
    });
    addTable(ws, ['BDE (client manager)', 'Employee ID', 'Department', 'Employment status', 'Clients', 'Agreement signed', 'Agreement not signed', 'Running clients (open requirement)', 'Clients with no open requirement', 'Requirements (total)', 'Open requirements', 'Open positions', 'Candidates at their clients', 'Applications', 'Active now', 'Sent to client', 'Interviews', 'Selected', 'Offer accepted', 'Joined', `Joined in ${month}`, 'Rejected', 'Joined % of applications', 'Running % of clients'], data, [26, 11, 16, 14]);

    const wc = wb.addWorksheet('2c. Client-wise');
    title(wc, 'Client-wise status', 'Every client with its BDE, agreement, requirements and candidate progress. Running = has at least one open requirement.');
    const cd = cs.sort((a, b) => b.open - a.open || b.s.joined - a.s.joined).map((x) => [x.c.name, x.c.ownerDepartment || '', x.c.bdeOwner || '', x.signed ? 'Signed (Active)' : 'Not signed', x.open > 0 ? 'Running' : 'No open requirement',
      x.reqs, x.open, x.positions, x.s.cands, x.s.active, x.s.sent, x.s.ivs, x.s.sel, x.s.acc, x.s.joined, x.joinedMonth, x.s.rej, x.lastJoin]);
    addTable(wc, ['Client', 'Department', 'BDE', 'Agreement', 'Status', 'Requirements', 'Open requirements', 'Open positions', 'Candidates', 'Active now', 'Sent to client', 'Interviews', 'Selected', 'Offer accepted', 'Joined', `Joined in ${month}`, 'Rejected', 'Last joining date'], cd, [42, 13, 18, 15, 18]);
  }
  // 3. Designation-wise
  {
    const ws = wb.addWorksheet('3. Designation-wise');
    title(ws, 'Designation-wise and TL-wise', 'TL rows = all applications whose recorded TL is that person (their whole team). Designation rows = the recruiter-wise rows added up by designation.');
    ws.addRow(['By designation']).font = { bold: true, size: 12 };
    const byDes = {}; pRows.forEach((p) => { const i = infoOf(p); const k = i.link === 'Current login' ? `${i.designation} (current team)` : i.designation === 'Not in HRMS' || i.designation === '-' ? 'Not in HRMS / not recorded' : `${i.designation} (${i.status === 'Active' || i.status === 'Notice Period' ? 'current' : 'former'})`; (byDes[k] = byDes[k] || []).push(...p.apps); });
    addTable(ws, ['Designation', ...STAT_HEAD], Object.entries(byDes).map(([k, l]) => [k, ...statCells(statsOf(l))]), [34]);
    ws.addRow([]); ws.addRow(['By TL (team totals)']).font = { bold: true, size: 12 };
    const byTl = {}; rows.forEach((x) => { const k = x.tl || '(no TL recorded)'; (byTl[k] = byTl[k] || []).push(x); });
    const tlUsers = users.filter((u) => u.atsRole === 'TL').map((u) => u.name);
    const tlRows = Object.entries(byTl).map(([k, l]) => [k, tlUsers.includes(k) ? 'Current TL' : 'As recorded', ...statCells(statsOf(l))]).sort((a, b) => (a[1] === 'Current TL' ? 0 : 1) - (b[1] === 'Current TL' ? 0 : 1) || b[2] - a[2]);
    tlRows.forEach((r) => ws.addRow(r));
    ws.addRow([]); ws.addRow(['Current TL teams (members today)']).font = { bold: true, size: 12 };
    users.filter((u) => u.atsRole === 'TL').forEach((t) => {
      const members = users.filter((u) => u.atsRole === 'RECRUITER' && u.employee && u.employee.tl === t.name);
      ws.addRow([`${t.name} (${(t.employee && t.employee.department) || t.atsDepartment})`, `${members.length} recruiters`, members.map((m) => `${m.name}${seatOfEmp.get(m.employee.id) ? ` [${seatOfEmp.get(m.employee.id)}]` : ''}`).join(', ')]);
    });
    ws.addRow([`BDEs: ${users.filter((u) => u.atsRole === 'BDE').map((u) => u.name).join(', ')}`]);
    ws.getColumn(1).width = 40; ws.getColumn(2).width = 14; ws.getColumn(3).width = 14;
  }
  const cand = (x) => (x.a.candidate && x.a.candidate.name) || '';
  const recName = (x) => (x.c.user ? x.c.user.name : x.c.recorded || '');
  const base = (x) => [cand(x), (x.r.client && x.r.client.name) || '', x.r.department || '', `${x.r.reqCode || ''} ${x.r.title || ''}`.trim(), recName(x), x.tl];
  const BASE_H = ['Candidate', 'Client', 'Department', 'Requirement', 'Recruiter', 'TL'];
  // 4. Active pipeline
  {
    const ws = wb.addWorksheet('4. Active pipeline');
    title(ws, 'Active pipeline - everyone still in process', 'Not joined and not rejected. "Days in step" = days since the person reached the current step.');
    const data = rows.filter((x) => !FINAL.has(x.a.stage)).sort((a, b) => (RANK[b.a.stage] || 0) - (RANK[a.a.stage] || 0)).map((x) => [...base(x), LABEL[x.a.stage] || x.a.stage, ymd(x.since), days(x.since), ymd(x.a.interviewAt), NEXT[x.a.stage] || '']);
    addTable(ws, [...BASE_H, 'Current step', 'In this step since', 'Days in step', 'Interview date', 'Next step'], data, [26, 32, 12, 26, 22, 20, 24, 14, 10, 12, 30]);
  }
  // 5. Interviews
  {
    const ws = wb.addWorksheet('5. Interviews');
    title(ws, 'Interview status', 'Scheduled, done and waiting for feedback, shortlisted for a demo / next round, on hold.');
    const st = new Set(['CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD']);
    const data = rows.filter((x) => st.has(x.a.stage)).sort((a, b) => String(b.a.interviewAt || b.since).localeCompare(String(a.a.interviewAt || a.since))).map((x) => [...base(x), LABEL[x.a.stage], ymd(x.a.interviewAt), x.a.stage === 'INTERVIEW_COMPLETED' ? days(x.since) : '']);
    addTable(ws, [...BASE_H, 'Status', 'Interview date', 'Days waiting for feedback'], data, [26, 32, 12, 26, 22, 20, 30, 14, 14]);
  }
  // 6. Selections & offers
  {
    const ws = wb.addWorksheet('6. Selections & offers');
    title(ws, 'Selected / offer stage - not joined yet', 'Confirm the joining date and offer for each of these.');
    const data = rows.filter((x) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(x.a.stage)).sort((a, b) => String(b.since).localeCompare(String(a.since))).map((x) => [...base(x), LABEL[x.a.stage], ymd(x.since), days(x.since), x.a.offerDate || '', x.a.offeredCtc || '', x.a.joiningDate || '']);
    addTable(ws, [...BASE_H, 'Status', 'Since', 'Days', 'Offer date', 'Offered CTC', 'Expected joining date'], data, [26, 32, 12, 26, 22, 20, 16, 12, 8, 12, 12, 14]);
  }
  // 7. Confirmed joinings
  {
    const ws = wb.addWorksheet('7. Confirmed joinings');
    title(ws, 'Confirmed joinings', 'Everyone at the Joined step, newest first.');
    const jd = (x) => x.a.joiningDate || ymd(x.a.joinedAt) || ymd(x.since);
    const data = rows.filter((x) => ['JOINED', 'HIRED'].includes(x.a.stage)).sort((a, b) => String(jd(b)).localeCompare(String(jd(a)))).map((x) => [...base(x), jd(x), String(jd(x)).slice(0, 7), x.a.offeredCtc || '']);
    addTable(ws, [...BASE_H, 'Joining date', 'Month', 'CTC'], data, [26, 32, 12, 26, 22, 20, 13, 10, 12]);
    ws.addRow([]); ws.addRow(['Joinings by month']).font = { bold: true };
    const bym = {}; data.forEach((d) => { const m = d[7] || '(no date)'; bym[m] = (bym[m] || 0) + 1; });
    Object.keys(bym).sort().reverse().slice(0, 24).forEach((m) => ws.addRow([m, bym[m]]));
  }
  // 8. Observations
  {
    const ws = wb.addWorksheet('8. Observations');
    title(ws, 'Observations and actions', 'Worked out from the data; add your own comments.');
    const reqOpen = reqs.filter((r) => r.status === 'OPEN');
    const curStats = recruiters.map((u) => ({ u, s: statsOf((people.get(`u:${u.id}`) || blank()).apps) }));
    const idle = curStats.filter((x) => x.s.active === 0).map((x) => x.u.name);
    const fb = rows.filter((x) => x.a.stage === 'INTERVIEW_COMPLETED' && days(x.since) > 7).length;
    const offers = rows.filter((x) => x.a.stage === 'OFFER_ACCEPTED' && days(x.since) > 30).length;
    const sel = rows.filter((x) => x.a.stage === 'SELECTED').length;
    const noRec = rows.filter((x) => x.c.key === 'none').length;
    const credited = rows.filter((x) => x.c.user).length;
    [
      `${reqOpen.filter((r) => !(r.recruiterId || r.recruiterIds)).length} of ${reqOpen.length} open requirements have NO recruiter assigned - assign them so work and numbers land on the right person.`,
      `Only ${credited} of ${rows.length} applications are credited to a current recruiter login; the rest are history credited to the name written in the sheets (many of them former staff).`,
      `Current recruiters with nothing in process right now: ${idle.length ? idle.join(', ') : 'none'}.`,
      `${fb} interviews are done but waiting for feedback for more than 7 days - chase the colleges / clients.`,
      `${sel} candidates are Selected and ${offers} have "offer accepted" for more than 30 days without a joining date - confirm joining or close them.`,
      `${noRec} applications have no recruiter written at all.`,
      'Interview dates for most history rows are not recorded, so "interviews" counts are based on the step a candidate reached.',
    ].forEach((t) => { const r = ws.addRow([`• ${t}`]); r.alignment = { wrapText: true }; });
    ws.getColumn(1).width = 140;
  }
  // 9. How counted
  {
    const ws = wb.addWorksheet('9. How this was counted');
    [
      'Source: the local TeamLink ATS database (read only).',
      'Credit: an application counts for the recruiter whose login it is linked to; otherwise for the recruiter NAME written in the source sheet. A written name is counted for a current recruiter only when it clearly matches them and the activity is after their joining date.',
      '"Reached" columns (sent, interviews, selected, offer accepted) count everyone who got to that step or beyond, including those who later joined.',
      'Active now = not Joined and not Rejected. Joined % = joined / applications. Selected % = selected / interviews scheduled.',
      'Employment status / designation for names that are not current logins come from HRMS when the name clearly matches one employee; otherwise "Not in HRMS".',
      'Candidate phone numbers and e-mails are left out of this report on purpose.',
    ].forEach((t) => { const r = ws.addRow([t]); r.alignment = { wrapText: true }; });
    ws.getColumn(1).width = 140;
  }
  await wb.xlsx.writeFile(OUT);
  console.log(JSON.stringify({ out: OUT, people: pRows.length, apps: rows.length, joined: all.joined, active: all.active, creditedToCurrent: rows.filter((x) => x.c.user).length }));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

/* eslint-disable no-console */
// PLAN ONLY (writes nothing to the database): the Education interview tracker -> the app's own ATS import files.
//   one CANDIDATE per person (phone last 10 digits, else e-mail) - only people not already on file
//   one APPLICATION per person + college (the latest row of that pair decides the step); none when the person already has an
//   application at that college (e.g. from the joinings import)
//   each college's requirement: its "Faculty requirement" if it has one, else one to create
// node edu-tracker-plan.js <tracker.xlsx> <colleges.json> <outDir>
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..', '..');
process.chdir(BACK);
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const [FILE, COLLEGES, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

const flat = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const one = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const email = (v) => { const e = flat(v).toLowerCase().replace(/\s+/g, ''); return /^[^@]+@[^@]+\.[a-z]{2,}$/.test(e) ? e : ''; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function ymd(v) {
  if (typeof v === 'number' && v > 40000 && v < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return d.toISOString().slice(0, 10); }
  const s = flat(v).toLowerCase();
  let m = /^(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{2,4})/.exec(s);
  if (m && MON[m[2]]) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${String(MON[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return '';
}
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');
function money(v) {
  if (typeof v === 'number') { if (v === 0) return '0'; return v >= 1000 ? `${Math.round(v)} per month` : `${v} LPA`; }
  const s = flat(v).toLowerCase();
  if (!s) return '';
  if (/^(nil|nill|no|na|n\/a|-|fresher|0)$/.test(s)) return '0';
  // a range ("35000 to 40000", "35-40k", "5.5 - 6LPA"): the app takes one amount - the LOWER one (the row's own words stay in the notes)
  const rg = /^(\d+(?:\.\d+)?)\s*(k|lpa)?\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(k|lpa)?$/.exec(s.replace(/\s+/g, ' '));
  if (rg) {
    const unit = rg[2] || rg[4] || '';
    const lo = Number(rg[1]); const hi = Number(rg[3]);
    if (lo <= hi) return unit === 'k' ? `${Math.round(lo * 1000)} per month` : unit === 'lpa' || lo < 100 ? `${lo} LPA` : `${Math.round(lo)} per month`;
  }
  let m = /^(\d+(?:\.\d+)?)\s*k\b/.exec(s); if (m) return `${Math.round(Number(m[1]) * 1000)} per month`;
  m = /^(\d+(?:\.\d+)?)\s*(lpa|lakhs?|l)\b/.exec(s); if (m) return `${m[1]} LPA`;
  m = /^(\d+(?:\.\d+)?)\s*(lpm)\b/.exec(s); if (m) return `${Math.round(Number(m[1]) * 100000)} per month`;
  m = /^(\d{4,7})$/.exec(s.replace(/[,\s]/g, '')); if (m) return `${m[1]} per month`;
  return flat(v);
}
function years(v) {
  const s = flat(v).toLowerCase();
  if (!s) return '';
  if (/fresher/.test(s)) return 0;
  let m = /(\d+(?:\.\d+)?)\s*(years?|yrs?|y)\b/.exec(s); const y = m ? Number(m[1]) : 0;
  m = /(\d+)\s*months?/.exec(s); const mo = m ? Number(m[1]) : 0;
  if (!y && !mo) { m = /^(\d+(?:\.\d+)?)$/.exec(s); return m ? Number(m[1]) : ''; }
  return Math.round((y + mo / 12) * 10) / 10;
}
// Interview Status -> pipeline step (+ who rejected)
function stepOf(statusRaw, hasDate) {
  const s = flat(statusRaw).toLowerCase().replace(/penidng|pendng/g, 'pending').replace(/rejecetd|rejectd/g, 'rejected').replace(/deom/g, 'demo')
    .replace(/feedack/g, 'feedback').replace(/selecetd|selcetd/g, 'selected').replace(/waitng/g, 'waiting');
  if (/^joined/.test(s)) return { stage: 'JOINED' };
  if (/^already selected in/.test(s)) return { stage: 'REJECTED', by: 'Candidate', why: `Took another offer (${flat(statusRaw)})` };
  if (/selected for (offline )?demo|selected for 2nd round/.test(s)) return { stage: 'CLIENT_SHORTLISTED' };
  if (/will join|^selected( with| for)? ?\d*k?$|^selected \d+k$|^selected with|^selected for \d/.test(s)) return { stage: 'SELECTED' };
  if (/waiting for feedback|^completed|^attended/.test(s)) return { stage: 'INTERVIEW_COMPLETED' };
  if (/^not interested/.test(s)) return { stage: 'REJECTED', by: 'Candidate', why: 'Not interested' };
  if (/^not shortlist/.test(s)) return { stage: 'REJECTED', by: 'Client', why: 'Not shortlisted by the college' };
  if (/^on hold/.test(s)) return { stage: 'HOLD' };
  if (/^schedule|^reschedule/.test(s)) return { stage: 'INTERVIEW_SCHEDULED' };
  if (/^rejected/.test(s)) return { stage: 'REJECTED', by: 'Client', why: 'Rejected after the interview' };
  if (/not eligible/.test(s)) return { stage: 'REJECTED', by: 'TeamLink', why: 'Not eligible for the position' };
  if (/won'?t attend/.test(s)) return { stage: 'REJECTED', by: 'Candidate', why: 'Did not attend the interview' };
  if (/won'?t join/.test(s)) return { stage: 'REJECTED', by: 'Candidate', why: 'Did not join' };
  if (/^pending/.test(s) || !s) return { stage: hasDate ? 'INTERVIEW_SCHEDULED' : 'SHARED_WITH_CLIENT' };
  return { stage: 'SHARED_WITH_CLIENT', unknown: flat(statusRaw) };
}
const ACTIVE = new Set(['SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED']);
// spellings matched by hand (typos of a client already on file); anything else stays unmatched and is listed
const MANUAL = {
  'alamuri ratnamala': 'ARMIET', 'alamuri ratnamala institute': 'ARMIET', alamuri: 'ARMIET',
  'sri venkateswra': 'Sri Venkateswara College of Engineering', 'sri venkataswera': 'Sri Venkateswara College of Engineering',
  'g.pullaiha': 'G.Pullaiah College Of Engineering and Technology', pullaiha: 'G.Pullaiah College Of Engineering and Technology',
  'amritha sai': 'Amrita Sai Institute of Science and Technology Paritala', 'swarna bharathi': 'Swarna Bharathi Institute of Science and Technology',
  'rama chandra': 'Ramachandra College of Engineering Eluru', 'sri vasavai': 'Sri Vasavi Engineering College',
  'sai spurthi': 'Sai Spurthi Institute Of Technology', 'sai spoorthi': 'Sai Spurthi Institute Of Technology', geethanjli: 'Geethanjali College of Engineering & Technology',
  'c r reddy': 'Sir C.R. Reddy College of Engineering, Eluru', 'talla padmavthi': 'Talla Padmavathi College of Engineering (Autonomous)', 'r k college': 'RK College Of Engineering',
  annamachraya: 'Sri Annamacharya Institute of Technology and Sciences', 'prathap narendra reddy': 'Prathap Narender Reddy College of Pharmacy',
  'prathap narendra reddy pharma': 'Prathap Narender Reddy College of Pharmacy', 'daripally anantha ramulu': 'Daripally Anantha Ramulu College of Engineering and Technology',
  viganan: "Vignan's Institute of Management and Technology for Women", 'cmr ece': 'CMR Engineering College', 'cme ece': 'CMR Engineering College',
};

(async () => {
  const prisma = new PrismaClient();
  const colleges = JSON.parse(fs.readFileSync(COLLEGES, 'utf8'));
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const clientByLower = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
  const manualClient = (k) => { const n = MANUAL[k]; if (!n) return null; return n === 'ARMIET' ? clients.find((c) => c.name.startsWith('ARMIET')) : clientByLower.get(n.toLowerCase()); };

  const raw = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets.Sheet1, { header: 1, defval: '' });
  const rows = [];
  raw.slice(1).forEach((x, i) => {
    if (!x.some((v) => flat(v))) return;
    const college = flat(x[17]);
    let client = colleges[college] ? { id: colleges[college].id, name: colleges[college].name } : null;
    if (!client && college) { const c = manualClient(college.toLowerCase()); if (c) client = { id: c.id, name: c.name }; }
    const iv = ymd(x[19]); const day = ymd(x[0]);
    rows.push({
      line: i + 2, day, name: flat(x[1]).replace(/^[.\s]+/, ''), phone: phone10(x[2]), phoneRaw: flat(x[2]), email: email(x[3]), qual: flat(x[4]), branch: flat(x[5]),
      exp: years(x[9]), expRaw: flat(x[9]), cur: money(x[10]), exp$: money(x[11]), loc: flat(x[12]), pref: flat(x[13]), notice: flat(x[14]),
      college, client, mode: flat(x[18]), interview: iv, status: flat(x[20]), notes: one(x[21]), type: flat(x[22]), recruiter: flat(x[23]), tl: flat(x[24]),
      extra: [flat(x[25]), flat(x[26])].filter(Boolean).join(' | '), step: stepOf(x[20], !!iv),
    });
  });

  // ---- people ----
  const keyOf = (r) => (r.phone ? `t:${r.phone}` : r.email ? `m:${r.email}` : `x:${r.name.toLowerCase()}|${r.line}`);
  // a row with only an e-mail joins the person who has that e-mail with a phone
  const phoneOfEmail = new Map(); rows.forEach((r) => { if (r.phone && r.email && !phoneOfEmail.has(r.email)) phoneOfEmail.set(r.email, r.phone); });
  rows.forEach((r) => { if (!r.phone && r.email && phoneOfEmail.has(r.email)) r.phone = phoneOfEmail.get(r.email); r.key = keyOf(r); });
  const order = (a, b) => (a.day || '').localeCompare(b.day || '') || a.line - b.line;
  const people = new Map();
  rows.forEach((r) => { if (!people.has(r.key)) people.set(r.key, []); people.get(r.key).push(r); });

  // on file already?
  const cands = await prisma.candidate.findMany({ select: { id: true, phone: true, email: true, name: true } });
  const onFile = new Map();
  cands.forEach((c) => { const p = phone10(c.phone); if (p) onFile.set(`t:${p}`, c); const e = email(c.email); if (e) onFile.set(`m:${e}`, c); });
  const apps = await prisma.application.findMany({ select: { candidateId: true, requirement: { select: { clientId: true } } } });
  const hasAppAt = new Set(apps.map((a) => `${a.candidateId}|${a.requirement && a.requirement.clientId}`));

  const newPeople = []; const existingPeople = []; const noContact = [];
  for (const [key, list] of people) {
    list.sort(order);
    const latest = list[list.length - 1];
    const pick = (f) => { for (let i = list.length - 1; i >= 0; i -= 1) { if (list[i][f] !== '' && list[i][f] != null) return list[i][f]; } return ''; };
    const p = { key, rows: list, name: pick('name'), phone: pick('phone'), email: pick('email'), qual: pick('qual'), branch: pick('branch'), exp: pick('exp'), cur: pick('cur'), exp$: pick('exp$'), loc: pick('loc'), pref: pick('pref'), notice: pick('notice'), latest };
    if (key.startsWith('x:')) { noContact.push(p); continue; }
    const hit = (p.phone && onFile.get(`t:${p.phone}`)) || (p.email && onFile.get(`m:${p.email}`));
    if (hit) { p.existing = hit; existingPeople.push(p); } else newPeople.push(p);
  }

  // ---- applications: person + college, the latest row decides ----
  const plannedApps = []; const skippedApps = []; const noCollege = [];
  for (const p of [...newPeople, ...existingPeople]) {
    const byClient = new Map();
    p.rows.forEach((r) => { if (!r.client) { noCollege.push(r); return; } if (!byClient.has(r.client.id)) byClient.set(r.client.id, []); byClient.get(r.client.id).push(r); });
    for (const [clientId, list] of byClient) {
      list.sort(order);
      const r = list[list.length - 1];
      if (p.existing && hasAppAt.has(`${p.existing.id}|${clientId}`)) { skippedApps.push({ p, r, why: 'already has an application at this college' }); continue; }
      plannedApps.push({ p, r, clientId, client: r.client.name, rows: list });
    }
  }

  // ---- requirement per college ----
  const reqs = await prisma.requirement.findMany({ where: { title: 'Faculty requirement', department: 'Educational' }, select: { id: true, reqCode: true, clientId: true, status: true } });
  const reqOf = new Map(); reqs.sort((a, b) => (a.status === 'OPEN' ? -1 : 1) - (b.status === 'OPEN' ? -1 : 1)).forEach((q) => { if (!reqOf.has(q.clientId)) reqOf.set(q.clientId, q); });
  const toCreate = new Map();
  plannedApps.forEach((a) => {
    if (reqOf.has(a.clientId)) { a.reqCode = reqOf.get(a.clientId).reqCode; return; }
    if (!toCreate.has(a.clientId)) toCreate.set(a.clientId, { clientId: a.clientId, client: a.client, active: false, n: 0 });
    const t = toCreate.get(a.clientId); t.n += 1; if (ACTIVE.has(a.r.step.stage)) t.active = true;
  });

  // ---- the two import files, in the app's own template columns ----
  const candRows = newPeople.map((p) => ({
    'Full Name *': p.name, Email: p.email, Phone: p.phone, 'Current Location': p.loc, 'Preferred Location': p.pref,
    'Total Experience (years)': p.exp, 'Current Salary': p.cur || (p.exp === 0 ? '0' : ''), 'Expected Salary': p.exp$, 'Notice Period': p.notice,
    Education: p.qual, Specialisation: p.branch,
  }));
  const appRows = plannedApps.map((a) => ({
    'Candidate Email or Phone *': a.p.phone || a.p.email, 'Requirement Code *': a.reqCode || `NEW:${a.clientId}`, 'Stage *': a.r.step.stage,
    'Stage Date': dmy(a.r.interview || a.r.day), 'Rejection Reason': a.r.step.why || '', 'Rejected By': a.r.step.by || '',
  }));
  const write = (rowsOut, sheet, file) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsOut), sheet); XLSX.writeFile(wb, path.join(OUT, file)); };
  write(candRows, 'Candidates', 'candidates-import.xlsx');
  write(appRows, 'Applications', 'applications-import.xlsx');
  fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({
    toCreate: [...toCreate.values()],
    apps: plannedApps.map((a) => ({ key: a.p.key, phone: a.p.phone, email: a.p.email, clientId: a.clientId, client: a.client, stage: a.r.step.stage, reqCode: a.reqCode || null, recruiter: a.r.recruiter, tl: a.r.tl, line: a.r.line, lines: a.rows.map((x) => x.line), interview: a.r.interview, day: a.r.day, mode: a.r.mode, type: a.r.type, status: a.r.status, notes: a.rows.map((x) => `${x.day || ''} ${x.college} - ${x.status}${x.notes ? `\n${x.notes}` : ''}${x.extra ? `\n${x.extra}` : ''}`).join('\n\n').slice(0, 3800) })),
  }, null, 1));

  // ---- report ----
  const st = {}; plannedApps.forEach((a) => { st[a.r.step.stage] = (st[a.r.step.stage] || 0) + 1; });
  const unknown = {}; rows.forEach((r) => { if (r.step.unknown) unknown[r.step.unknown] = (unknown[r.step.unknown] || 0) + 1; });
  console.log(`ROWS ${rows.length} -> PEOPLE ${people.size} (with phone/e-mail ${people.size - noContact.length}, with neither ${noContact.length})`);
  console.log(`  already on file (same phone / e-mail): ${existingPeople.length}   |   NEW candidates: ${newPeople.length}`);
  console.log(`  new candidates with no Expected Salary (the app requires it): ${candRows.filter((c) => !c['Expected Salary']).length}, no Current Salary: ${candRows.filter((c) => !c['Current Salary']).length}`);
  console.log(`APPLICATIONS (person + college): ${plannedApps.length}  ${JSON.stringify(st)}`);
  console.log(`  not added - person already has an application at that college: ${skippedApps.length}`);
  console.log(`  rows with no matched college (person kept, no application): ${noCollege.length}  [${[...new Set(noCollege.map((r) => r.college || '(blank)'))].join(', ')}]`);
  console.log(`  repeated rows folded into their person + college (latest kept): ${rows.length - noCollege.length - plannedApps.length - skippedApps.length - noContact.length}`);
  console.log(`REQUIREMENTS: use existing "Faculty requirement" for ${new Set(plannedApps.filter((a) => a.reqCode).map((a) => a.clientId)).size} colleges; create for ${toCreate.size}: ${[...toCreate.values()].map((t) => `${t.client.slice(0, 30)} (${t.n}, ${t.active ? 'OPEN' : 'CLOSED'})`).join('; ')}`);
  if (Object.keys(unknown).length) console.log('status words not recognised (treated as profile shared):', JSON.stringify(unknown));
  if (noContact.length) console.log('people with no phone and no e-mail (NOT imported):', noContact.map((p) => `${p.name} (row ${p.rows[0].line})`).join(', '));
  await prisma.$disconnect();
})();

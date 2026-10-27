/* eslint-disable no-console, no-await-in-loop */
// ADD-SHEET-CLIENTS: the first part of this file is the shared reading / matching code of import-agreement-clients.js
// (kept identical so both match sheet names the same way); this script's own work starts at "ADD THE 28 SHEET-ONLY COMPANIES".
// ---------------------------------------------------------------------------
// LOCAL ONLY (2026-10-27): every client of the signed-agreements zip into the LOCAL demo database, named exactly as printed on the
// agreement, with its signed files behind "View agreement"; requirements from the Medical / Manufacturing / Education sheets
// (Running = OPEN, Stopped = CLOSED) so "running" can be tallied. Demo data is left as it is. Nothing goes to the live site.
//
//   node import-agreement-clients.js --zip <extracted dir> --med <xlsx> --mfg <xlsx> --edu <xlsx>            DRY RUN
//   ... --apply                                                                                              writes (backup first)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..', '..');
const LIB = path.join(BACK, 'scripts/lib/joinings-2026-10-17');
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const ZIP = val('--zip');
const DB = path.join(BACK, 'prisma', 'dev.db');
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.chdir(BACK);

const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const { planFiles } = require(path.join(LIB, 'agreements.js'));
const { Ledger, newId } = require(path.join(LIB, 'ledger.js'));
const { sp } = require(path.join(LIB, 'names.js'));
const pack = require(path.join(LIB, 'agreements-pack.json'));

const prisma = new PrismaClient();
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SOURCE = 'Signed agreements zip + requirement sheets (local import 2026-10-27)';

// ---- 1. the agreement clients: printed name + department ----------------------------------------------------------------
const MFG = /Aadinath|AEZIS|Aglowmed|Assam Carbon|AUROCHEM|Ayukalp|CALYX|Fortune Biotech|ICHOR|IJM Concrete|JINDAL|Kartikeya|Mahamaya|MANAKSIA|Manisha Constructions|Mobismart|Modular Container|NILE LI|NILE LIMITED|NS Epoxy|Nucon|SARU SILVER|Sensa Core|Visista|Voxtbv|Western Airducts/i;
const EDU = /Engineering|Pharmacy|Technology|Institute|University|School|College|Institutions|CHINMAYA|Arka educational|NTR Memorial|Business Management|Management Studies|Acharya/i;
const MED = /hospital|medical|clinic|health ?care|healthcare|diagnostic|ayurved|maternity|eye foundation|medcare|medicare|ADDRESSHEALTH|Antara Assisted|Cardiac Centre|Ajara Health|Dhanalaxmisrinivasan|Mother and Child|IVF|Kolors|Muthya|5C Network/i;
const deptOf = (name) => {
  if (MFG.test(name)) return 'Manufacturing';
  if (EDU.test(name) && !/Medical|Ayurved/i.test(name)) return 'Educational';
  if (MED.test(name)) return 'Medical';
  return null;
};
const INDUSTRY = { Medical: 'Healthcare', Manufacturing: 'Manufacturing', Educational: 'Education' };

const ren = new Map(pack.renames.map((r) => [r.clientId, r]));
const ncByKey = new Map(pack.newClients.map((n) => [n.key, n]));
const ag = new Map(); // pack clientId -> { id, name, dept, files[] }
for (const f of pack.files) {
  if (!ag.has(f.clientId)) {
    let name; let nc = null;
    if (String(f.clientId).startsWith('NEW:')) { nc = ncByKey.get(f.clientId.slice(4)); name = nc.name; }
    else { const r = ren.get(f.clientId); name = r ? (r.status === 'UNDECIDABLE' ? r.current : r.official) : f.clientNow; }
    ag.set(f.clientId, { packId: f.clientId, name: sp(name), nc, files: [] });
  }
  ag.get(f.clientId).files.push(f);
}
const ymd = (s) => (s ? String(s).slice(0, 10) : null);
for (const c of ag.values()) {
  c.dept = deptOf(c.name);
  const printed = c.files.filter((f) => f.kind === 'Signed agreement' && f.isoDate).map((f) => f.isoDate).sort();
  const uploaded = c.files.map((f) => ymd(f.uploaded)).filter(Boolean).sort();
  c.date = printed.length ? printed[printed.length - 1] : (uploaded.length ? uploaded[uploaded.length - 1] : null);
  c.dateFrom = printed.length ? 'date printed on the agreement' : 'day the file was uploaded to the form';
}
const clients = [...ag.values()];

// ---- 2. the sheets -> requirements of these clients ---------------------------------------------------------------------
const one = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const flat = (v) => one(v).replace(/\s+/g, ' ').trim();
const STOP = new Set('the and of pvt private ltd limited hospital hospitals medical college sciences institute speciality specialty super multi care health research center centre india dist co corporate office engineering technology'.split(' '));
const toks = (s) => new Set(String(s || '').toLowerCase().replace(/\(office timings.*?\)/, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 1 && !STOP.has(t)));
const score = (a, b) => { const A = toks(a); const B = toks(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach((t) => B.has(t) && (i += 1)); return (i / Math.min(A.size, B.size)) * (i / Math.max(A.size, B.size)) ** 0.3; };
const allNames = (c) => [c.name, ...c.files.map((f) => f.clientNow).filter(Boolean), ...c.files.map((f) => f.printedName).filter(Boolean)];
// Decided by hand after reading both sides (a sheet name that starts with the key -> that client, or null = no agreement in the zip).
const OVERRIDE = [
  ['Vcare Health Clinic', "Praba's Vcare Health Clinic (P) Ltd"],
  ['Sree Keshava Hospital', 'Sri Keshav Emergency and multispeciality hospital'],
  ['Arupadai college', 'Aarupadai veedu medical College and hospital'],
  ['Gitam Ram', 'GitaRam Hospital Private Limited'],
  ['Metrocure Hospital', 'Metro Cure Hospital'],
  ['Mobiesmart Card', 'Mobismart Card Technology'],
  ['Fortune Bio Tech', 'Fortune Biotech Ltd'],
  ['T.R.R College of Technology', 'T.R.R College OF TECHNOLOGY BTECH/DIPLOMA / TRR GROUP OF INSTITUTIONS'],
  ['Ravindra College of Engineering And Womens', 'Ravindra College of Engineering for Women'],
  ["Vignan's Institute", null],
  ['Trr Medical College', null], ['CMR Institute of Medical Sciences', null], ['Apollo University', null], ['Continental Hospital', null],
  ['Nova Institute', null], ['Jogo Health', null], ['Abhyudaya', null], ['Kl', null], ['Father Colombo', null],
  ['Hare Krishna', null], ['Greentech', null], ['Capart', null],
];
const byName = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
function matchClient(sheetName) {
  const o = OVERRIDE.find(([k]) => sheetName.toLowerCase() === k.toLowerCase() || sheetName.toLowerCase().startsWith(k.toLowerCase()));
  if (o) return o[1] ? { c: byName.get(o[1].toLowerCase()), s: 1, how: 'decided by hand' } : { c: null, s: 0, how: 'no agreement in the zip' };
  const best = clients.map((c) => ({ c, s: Math.max(...allNames(c).map((n) => score(sheetName, n))) })).sort((a, b) => b.s - a.s)[0];
  return best.s >= 0.6 ? { ...best, how: `name match ${best.s.toFixed(2)}` } : { c: null, s: best.s, how: `no match (best ${best.s.toFixed(2)}: ${best.c.name})` };
}
const count = (v) => { if (typeof v === 'number') return Math.max(1, Math.min(500, Math.round(v))); const m = one(v).match(/^\D{0,20}(\d{1,3})(?!\d)/); return m ? Math.max(1, Number(m[1])) : 1; };
const rowsOf = (file, tab) => { const ws = XLSX.readFile(file).Sheets[tab]; if (!ws) throw new Error(`tab "${tab}" not found in ${file}`); return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }); };

const reqs = []; // { sheet, tab, row, client, sheetName, dept, status, title, spec, openings, description, education }
const sheetNames = []; // { sheet, tab, name, match }
const seenSheet = new Map();
const note = (sheet, tab, name) => { const k = `${sheet}|${tab}|${name}`; if (!seenSheet.has(k)) { const m = matchClient(name); seenSheet.set(k, m); sheetNames.push({ sheet, tab, name, ...m }); } return seenSheet.get(k); };

// Medical: one requirement per role with a count (the repo's replace-medical-requirements.js rule)
const ROLES = [['Nurse', 'Nurse'], ['Consultant/Doctor', 'Consultant / Doctor'], ['SR', 'Senior Resident'], ['Assistant', 'Assistant Professor'], ['Associate', 'Associate Professor'], ['Professor', 'Professor']];
for (const [tab, status] of [['Running', 'OPEN'], ['Stopped', 'CLOSED']]) {
  const rows = rowsOf(val('--med'), tab);
  const head = rows[0].map((h) => flat(h).toLowerCase());
  const col = (n) => head.indexOf(n.toLowerCase());
  const c = { qual: col('Qualification'), spec: col('Specialization'), pack: col('Package'), rem: col('Remarks'), bed: col('Bed Capacity') };
  let client = '';
  rows.slice(1).forEach((r, i) => {
    if (flat(r[0])) client = flat(r[0]);
    if (!client) return;
    const roles = ROLES.map(([h, label]) => ({ label, i: col(h) })).filter((x) => x.i >= 0 && one(r[x.i])).map((x) => ({ ...x, n: count(r[x.i]) }));
    if (!roles.length) return;
    const m = note('Medical', tab, client);
    if (!m.c) return;
    const spec = c.spec >= 0 ? one(r[c.spec]).split('\n').map((x) => x.trim()).filter(Boolean)[0] || '' : '';
    const qual = c.qual >= 0 ? flat(r[c.qual]).slice(0, 120) : '';
    const description = [qual && `Qualification: ${qual}`, c.pack >= 0 && one(r[c.pack]) && `Package:\n${one(r[c.pack])}`, c.rem >= 0 && one(r[c.rem]) && `Remarks:\n${one(r[c.rem])}`, c.bed >= 0 && flat(r[c.bed]) && `Bed capacity: ${flat(r[c.bed])}`, `From the Medical team requirements sheet (tab ${tab}, row ${i + 2}).`].filter(Boolean).join('\n\n').slice(0, 4000);
    roles.forEach(({ label, n }) => reqs.push({ sheet: 'Medical', tab, row: i + 2, client: m.c, sheetName: client, dept: 'Medical', status, title: `${label}${spec ? ` — ${spec.slice(0, 120)}` : ''}`, spec: spec.slice(0, 120) || null, openings: n, description, education: qual || null }));
  });
}
// Manufacturing: one requirement per row (Designation), Running = OPEN, Stopped = CLOSED
for (const [tab, status] of [['Running ', 'OPEN'], ['Stopped', 'CLOSED']]) {
  const rows = rowsOf(val('--mfg'), tab);
  let client = '';
  rows.slice(1).forEach((r, i) => {
    if (flat(r[0])) client = flat(r[0]);
    if (!client || !r.slice(1).some((x) => one(x))) return;
    const m = note('Manufacturing', tab.trim(), client);
    if (!m.c) return;
    const designation = flat(r[4]); const spec = flat(r[3]);
    const description = [flat(r[1]) && !/^https?:/i.test(flat(r[1])) && `Location: ${flat(r[1])}`, flat(r[2]) && `Qualification: ${flat(r[2])}`, one(r[6]) && `Package and full details:\n${one(r[6])}`, one(r[7]) && `Remarks:\n${one(r[7])}`, `From the Manufacturing requirements sheet (tab ${tab.trim()}, row ${i + 2}).`].filter(Boolean).join('\n\n').slice(0, 4000);
    reqs.push({ sheet: 'Manufacturing', tab: tab.trim(), row: i + 2, client: m.c, sheetName: client, dept: 'Manufacturing', status, title: (designation || spec || 'Requirement').slice(0, 150), spec: spec.slice(0, 120) || null, openings: count(r[5]), description, education: flat(r[2]).slice(0, 120) || null });
  });
}
// Education: one requirement per college row, Remarks column Running = OPEN, Stop Requirement = CLOSED (No Requirement / On Hold: none)
{
  const rows = rowsOf(val('--edu'), 'Sheet1');
  rows.slice(1).forEach((r, i) => {
    const name = flat(r[0]); const flag = flat(r[13]).toLowerCase();
    if (!name) return;
    const status = flag === 'running' ? 'OPEN' : flag.startsWith('stop') ? 'CLOSED' : null;
    const m = note('Education', 'Sheet1', name);
    if (!status || !m.c) return;
    const pos = one(r[6]);
    const description = [pos && `Requirements / positions:\n${pos}`, one(r[5]) && `Requirements:\n${one(r[5])}`, flat(r[3]) && `Location: ${flat(r[3])}`, `From the Edu - 2 requirement sheet (row ${i + 2}, remark "${flat(r[13])}").`].filter(Boolean).join('\n\n').slice(0, 4000);
    reqs.push({ sheet: 'Education', tab: 'Sheet1', row: i + 2, client: m.c, sheetName: name, dept: 'Educational', status, title: 'Faculty requirement', spec: null, openings: 1, description, education: null });
  });
}

// =====================================================================================================================
// ADD THE 28 SHEET-ONLY COMPANIES (2026-10-27, user: "add the 28 sheet-only companies as clients without an agreement, with their
// sheet requirements (Running open, Stopped closed)"). Named exactly as written on the sheet; agreement left as DRAFT (Unsigned).
// Also: a Running / Stopped Medical row with NO number in any role column (the first import skipped those) becomes one requirement
// with 1 opening - for the new companies and for an agreement client that has such a row (Vcare).
//   node add-sheet-clients.js --med .. --mfg .. --edu ..            DRY RUN
//   ... --apply                                                      backup (VACUUM INTO) first, one transaction
// =====================================================================================================================
const NEW28 = {
  Medical: ['Trr Medical College, Hyderabad', 'CMR Institute of Medical Sciences', 'Continental Hospital,Jagdalpur', 'Apollo University, Chittor',
    'Nova Institute of Medical Sciences and Research Center', 'Jogo Health(Mumbai)', 'Abhyudaya HR Business Solutions', 'Father Colombo institute of medical sciences-Warangal Location.'],
  Manufacturing: ['Hare Krishna Movement Charitable Foundation', 'Greentech Engineering Systems Pvt Ltd', 'Capart Industries Pvt. Ltd'],
  Educational: ['Malla reddy university', 'Malla Reddy Institute of Technology & science (MRITS)', "Vignan's Institute of Management and Technology for Women",
    'Aurora College-Chikadapally', 'MLRIT(Marry Laxman Reddy Institute of Technology and Science)', 'Guru Nanak', 'Institute of Aeronautical Engineering(IARE)',
    'Shri Vishnu Engineering College for Women (SVECW)', 'Arjun college', 'Avanthi Institute Of Engineering & Technology', 'Vageswari', 'Aurora College - Uppal',
    'SVS GROUP OF INSTITUTIONS', 'Bapatla Engineering College', 'Hiray College', 'Ellanki college', 'Daripally Anantha Ramulu College of Engineering and Technology'],
};
const newByKey = new Map();
Object.entries(NEW28).forEach(([dept, names]) => names.forEach((n) => newByKey.set(flat(n).toLowerCase(), { name: flat(n), dept })));
if (newByKey.size !== 28) throw new Error(`expected 28 names, got ${newByKey.size}`);
const DEGREE = /^\s*(b\.?\s?pharm|m\.?\s?pharm|md|ms|mds|dm|dnb|bsc|gnm|any )/i;

(async () => {
  try {
    const dbClients = await prisma.client.findMany({ select: { id: true, name: true } });
    const dbByName = new Map(dbClients.map((c) => [c.name.toLowerCase(), c]));
    const clash = [...newByKey.values()].filter((n) => dbByName.has(n.name.toLowerCase()));
    if (clash.length) { console.error(`REFUSED: already in the database: ${clash.map((c) => c.name).join(', ')}`); process.exit(2); }
    const resolve = (sheetName) => {
      const nw = newByKey.get(flat(sheetName).toLowerCase());
      if (nw) return { kind: 'new', key: nw.name };
      const m = matchClient(sheetName);
      if (m.c && dbByName.has(m.c.name.toLowerCase())) return { kind: 'old', client: dbByName.get(m.c.name.toLowerCase()) };
      return null;
    };
    const add = []; // { owner, dept, status, title, spec, openings, description, education, from }
    // Medical: per role with a count; a row with no count -> one requirement (new clients: every row; agreement clients: only those rows)
    for (const [tab, status] of [['Running', 'OPEN'], ['Stopped', 'CLOSED']]) {
      const rows = rowsOf(val('--med'), tab);
      const head = rows[0].map((h) => flat(h).toLowerCase());
      const col = (n) => head.indexOf(n.toLowerCase());
      const c = { qual: col('Qualification'), spec: col('Specialization'), pack: col('Package'), rem: col('Remarks'), bed: col('Bed Capacity') };
      let client = '';
      rows.slice(1).forEach((r, i) => {
        if (flat(r[0])) client = flat(r[0]);
        if (!client || !r.slice(1).some((x) => one(x))) return;
        const owner = resolve(client); if (!owner) return;
        const roles = ROLES.map(([h, label]) => ({ label, i: col(h) })).filter((x) => x.i >= 0 && one(r[x.i])).map((x) => ({ ...x, n: count(r[x.i]) }));
        if (owner.kind === 'old' && roles.length) return; // already imported the first time
        const spec = c.spec >= 0 ? one(r[c.spec]).split('\n').map((x) => x.trim()).filter(Boolean)[0] || '' : '';
        const qual = c.qual >= 0 ? flat(r[c.qual]).slice(0, 120) : '';
        const description = [qual && `Qualification: ${qual}`, c.pack >= 0 && one(r[c.pack]) && `Package:\n${one(r[c.pack])}`, c.rem >= 0 && one(r[c.rem]) && `Remarks:\n${one(r[c.rem])}`, c.bed >= 0 && flat(r[c.bed]) && `Bed capacity: ${flat(r[c.bed])}`, `From the Medical team requirements sheet (tab ${tab}, row ${i + 2}).`].filter(Boolean).join('\n\n').slice(0, 4000);
        const from = `Medical/${tab} r${i + 2}`;
        if (roles.length) roles.forEach(({ label, n }) => add.push({ owner, dept: 'Medical', status, title: `${label}${spec ? ` — ${spec.slice(0, 120)}` : ''}`, spec: spec.slice(0, 120) || null, openings: n, description, education: qual || null, from }));
        else if (status === 'OPEN') { // a Stopped row with no count is a follow-up note ("client said no requirements"), not a job
          const t = (spec && !DEGREE.test(spec) ? spec : (qual && !DEGREE.test(qual) ? qual : spec || qual || 'Requirement')).slice(0, 150);
          const n = (/\s-\s*(\d{1,3})\s*$/.exec(t) || [])[1];
          add.push({ owner, dept: 'Medical', status, title: t, spec: spec.slice(0, 120) || null, openings: n ? Number(n) : 1, description, education: qual || null, from: `${from} (no count column on the sheet - ${n ? `${n} from the title` : '1'} opening)` });
        }
      });
    }
    // Manufacturing (Running / Stopped tabs) and Education (Remarks column) - the new companies only
    for (const [tab, status] of [['Running ', 'OPEN'], ['Stopped', 'CLOSED']]) {
      let client = '';
      rowsOf(val('--mfg'), tab).slice(1).forEach((r, i) => {
        if (flat(r[0])) client = flat(r[0]);
        if (!client || !r.slice(1).some((x) => one(x))) return;
        const owner = resolve(client); if (!owner || owner.kind !== 'new') return;
        const designation = flat(r[4]); const spec = flat(r[3]);
        const description = [flat(r[1]) && !/^https?:/i.test(flat(r[1])) && `Location: ${flat(r[1])}`, flat(r[2]) && `Qualification: ${flat(r[2])}`, one(r[6]) && `Package and full details:\n${one(r[6])}`, one(r[7]) && `Remarks:\n${one(r[7])}`, `From the Manufacturing requirements sheet (tab ${tab.trim()}, row ${i + 2}).`].filter(Boolean).join('\n\n').slice(0, 4000);
        add.push({ owner, dept: 'Manufacturing', status, title: (designation || spec || 'Requirement').slice(0, 150), spec: spec.slice(0, 120) || null, openings: count(r[5]), description, education: flat(r[2]).slice(0, 120) || null, from: `Manufacturing/${tab.trim()} r${i + 2}` });
      });
    }
    rowsOf(val('--edu'), 'Sheet1').slice(1).forEach((r, i) => {
      const name = flat(r[0]); const flag = flat(r[13]).toLowerCase();
      if (!name) return;
      const status = flag === 'running' ? 'OPEN' : flag.startsWith('stop') ? 'CLOSED' : null;
      const owner = resolve(name); if (!status || !owner || owner.kind !== 'new') return;
      const pos = one(r[6]);
      const description = [pos && `Requirements / positions:\n${pos}`, one(r[5]) && `Requirements:\n${one(r[5])}`, flat(r[3]) && `Location: ${flat(r[3])}`, `From the Edu - 2 requirement sheet (row ${i + 2}, remark "${flat(r[13])}").`].filter(Boolean).join('\n\n').slice(0, 4000);
      add.push({ owner, dept: 'Educational', status, title: 'Faculty requirement', spec: null, openings: 1, description, education: null, from: `Education r${i + 2}` });
    });

    // ---- the same job written twice on a sheet (word for word, only the row number differs) is ONE requirement ----
    const body = (d) => String(d || '').replace(/\n*From the [^\n]*\.\s*$/, '').trim();
    const jobKey = (clientKey, x) => [clientKey, x.title, x.status, x.openings, body(x.description)].join('|');
    const seenJob = new Set(); const dupAdd = []; const kept = []; // the first row is kept, later repeats are dropped
    add.forEach((a) => { const key = jobKey(a.owner.kind === 'new' ? `new:${a.owner.key}` : a.owner.client.id, a); if (seenJob.has(key)) dupAdd.push(a); else { seenJob.add(key); kept.push(a); } });
    add.length = 0; add.push(...kept);
    // repeats the FIRST import already created for the agreement clients (no candidate on them, so nothing hangs on them)
    const firstRun = await prisma.requirement.findMany({ where: { client: { internalNotes: { contains: 'local import 2026-10-27' } } }, orderBy: { reqCode: 'asc' }, select: { id: true, reqCode: true, clientId: true, title: true, status: true, openings: true, description: true, client: { select: { name: true } }, _count: { select: { applications: true } } } });
    const seenOld = new Set(); const dupOld = [];
    firstRun.forEach((r) => { const key = jobKey(r.clientId, r); if (seenOld.has(key) && !r._count.applications) dupOld.push(r); else seenOld.add(key); });

    // ---- report ----
    console.log(`REPEATED SHEET ROWS NOT ADDED TWICE: ${dupAdd.length}`);
    console.log(`REPEATS FROM THE FIRST IMPORT TO REMOVE: ${dupOld.length}`);
    dupOld.forEach((r) => console.log(`  ${r.reqCode} ${r.client.name.slice(0, 40).padEnd(40)} ${r.status.padEnd(6)} "${r.title.slice(0, 50)}"`));
    console.log(`\nNEW CLIENTS: ${newByKey.size} (agreement: Draft / Unsigned)`);
    for (const [d, names] of Object.entries(NEW28)) {
      console.log(`  ${d}:`);
      names.forEach((n) => { const r = add.filter((a) => a.owner.kind === 'new' && a.owner.key === flat(n)); console.log(`    ${flat(n).slice(0, 70).padEnd(70)} reqs: ${r.filter((x) => x.status === 'OPEN').length} open, ${r.filter((x) => x.status === 'CLOSED').length} closed`); });
    }
    const forOld = add.filter((a) => a.owner.kind === 'old');
    console.log(`\nEXTRA REQUIREMENTS FOR AGREEMENT CLIENTS (rows with no count, skipped the first time): ${forOld.length}`);
    forOld.forEach((a) => console.log(`  ${a.owner.client.name.slice(0, 45).padEnd(45)} ${a.status.padEnd(6)} "${a.title.slice(0, 50)}"  [${a.from}]`));
    console.log(`\nREQUIREMENTS TO ADD: ${add.length} (${add.filter((a) => a.status === 'OPEN').length} open, ${add.filter((a) => a.status === 'CLOSED').length} closed)`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const dir = path.join(os.homedir(), '.teamlink-backups', `add-sheet-clients-${STAMP}`);
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const codes = (await prisma.requirement.findMany({ where: { reqCode: { not: null } }, select: { reqCode: true } })).map((r) => r.reqCode);
    let k = codes.reduce((mx, c) => { const m = /^REQ-(\d+)$/.exec(c); return m ? Math.max(mx, Number(m[1])) : mx; }, 0);
    const undo = { at: new Date().toISOString(), backup: bak, clients: [], requirements: [], removedRepeats: dupOld.map((r) => r.reqCode) };
    await prisma.$transaction(async (tx) => {
      if (dupOld.length) await tx.requirement.deleteMany({ where: { id: { in: dupOld.map((r) => r.id) } } });
      const made = new Map();
      for (const [dept, names] of Object.entries(NEW28)) {
        for (const n of names) {
          const c = await tx.client.create({ data: { name: flat(n), legalName: flat(n), ownerDepartment: dept, industry: INDUSTRY[dept], status: 'Active', clientType: 'Direct', internalNotes: 'Added from the requirement sheets (local import 2026-10-27, sheet-only: no signed agreement in the zip). Name as written on the sheet.' } });
          made.set(flat(n), c); undo.clients.push(c.id);
        }
      }
      for (const a of add) {
        k += 1;
        const clientId = a.owner.kind === 'new' ? made.get(a.owner.key).id : a.owner.client.id;
        const r = await tx.requirement.create({ data: { title: a.title, clientId, department: a.dept, specialisation: a.spec, status: a.status, openings: a.openings, description: a.description, ...(a.education ? { education: a.education } : {}), reqCode: `REQ-${String(k).padStart(4, '0')}`, hiringType: 'Client Placement', priority: 'Medium' } });
        undo.requirements.push(r.id);
      }
      await tx.auditLog.create({ data: { action: `Local import: ${undo.clients.length} sheet-only clients (no agreement) + ${undo.requirements.length} requirements from the sheets`, entity: 'Import', entityId: STAMP, actorName: 'Requirement sheets (local import 2026-10-27)' } });
    }, { timeout: 120000 });
    fs.writeFileSync(path.join(dir, 'undo.json'), JSON.stringify(undo, null, 1));
    console.log(`\nDONE. ${undo.clients.length} clients, ${undo.requirements.length} requirements.\nBackup of the database before: ${bak}\nUndo list: ${path.join(dir, 'undo.json')}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 2000)); process.exit(1); });

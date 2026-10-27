/* eslint-disable no-console, no-await-in-loop */
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

(async () => {
  try {
    // ---- 3. plan: clients, then the files through the importer the repo already uses ----------------------------------------
    const L = new Ledger();
    const existing = await prisma.client.findMany({ select: { id: true, name: true } });
    const clash = clients.filter((c) => existing.some((e) => sp(e.name).toLowerCase() === c.name.toLowerCase() || e.id === c.packId));
    if (clash.length) { console.error(`REFUSED: ${clash.length} of these clients are already in the database (run twice?): ${clash.slice(0, 5).map((c) => c.name).join(', ')}`); process.exit(2); }
    const S = { clients: [], clientById: new Map(), signedSettings: [], signedDocs: [], aliases: [] };
    for (const c of clients) {
      const nc = c.nc;
      const at = c.date ? new Date(`${c.date}T00:00:00.000Z`) : null;
      const data = {
        name: c.name, legalName: c.name, ownerDepartment: c.dept, industry: INDUSTRY[c.dept] || null, status: 'Active', clientType: 'Direct',
        location: (nc && nc.location) || null, contactName: (nc && nc.contactName) || null, contactPhone: (nc && nc.contactPhone) || null,
        contactEmail: (nc && nc.contactEmail) || null, contactDesignation: (nc && nc.contactDesignation) || null, commercialNotes: (nc && nc.formCharges) || null,
        agreementStatus: 'ACTIVE', agreementStart: c.date, agreementSignedAt: at, agreementActivatedAt: at,
        internalNotes: `Added from the signed agreements zip (local import 2026-10-27). Name as printed on the agreement. Agreement date: ${c.date ? `${c.dateFrom}` : 'not known'}.`,
      };
      const id = c.nc ? newId('ac') : c.packId; // same id as the other PC where there is one
      L.create('client', data, id);
      c.id = id;
      const row = { id, ...data };
      S.clients.push(row); S.clientById.set(id, row);
    }
    const uploadsDir = process.env.UPLOAD_DIR || path.join(os.homedir(), '.teamlink-uploads');
    const files = planFiles({ S, L, pack, zipDir: ZIP, uploadsDir, importedBy: 'Imported', readFiles: true });
    if (files.createdClients.length) throw new Error(`planFiles made ${files.createdClients.length} client(s) itself - the NEW: names did not line up`);

    // requirements
    const codes = (await prisma.requirement.findMany({ where: { reqCode: { not: null } }, select: { reqCode: true } })).map((r) => r.reqCode);
    let k = codes.reduce((mx, c) => { const m = /^REQ-(\d+)$/.exec(c); return m ? Math.max(mx, Number(m[1])) : mx; }, 0);
    for (const q of reqs) {
      k += 1;
      L.create('requirement', {
        title: q.title, clientId: q.client.id, department: q.dept, specialisation: q.spec, status: q.status, openings: q.openings, description: q.description,
        ...(q.education ? { education: q.education } : {}), reqCode: `REQ-${String(k).padStart(4, '0')}`, hiringType: 'Client Placement', priority: 'Medium',
      });
    }
    L.create('auditLog', { action: `Local import: ${clients.length} clients from the signed agreements zip, ${files.attached.length} agreement files, ${reqs.length} requirements from the sheets`, entity: 'Import', entityId: STAMP, actorName: SOURCE });

    // ---- 4. tally --------------------------------------------------------------------------------------------------------
    const open = new Set(reqs.filter((q) => q.status === 'OPEN').map((q) => q.client.id));
    const by = {};
    clients.forEach((c) => { const d = c.dept || '(no department)'; by[d] = by[d] || { total: 0, running: 0 }; by[d].total += 1; if (open.has(c.id)) by[d].running += 1; });
    console.log(`\nCLIENTS FROM THE AGREEMENTS: ${clients.length}`);
    Object.entries(by).forEach(([d, v]) => console.log(`  ${d.padEnd(16)} total ${String(v.total).padStart(3)}   running (open requirement) ${v.running}`));
    console.log(`\nFILES: ${files.attached.length} attached, ${files.duplicates.length} identical copies skipped, ${files.unmatched.length} not linked, ${files.problems.length} problem(s)`);
    files.problems.forEach((p) => console.log(`  ! ${p}`));
    console.log(`REQUIREMENTS: ${reqs.length} (${reqs.filter((q) => q.status === 'OPEN').length} open, ${reqs.filter((q) => q.status === 'CLOSED').length} closed)`);
    console.log('  by sheet:', JSON.stringify(reqs.reduce((a, q) => ((a[`${q.sheet}/${q.status}`] = (a[`${q.sheet}/${q.status}`] || 0) + 1), a), {})));
    const noAg = sheetNames.filter((s) => !s.c);
    console.log(`\nSHEET NAMES WITH NO CLIENT IN THE ZIP (${noAg.length}):`);
    noAg.forEach((s) => console.log(`  ${s.sheet}/${s.tab}: ${s.name.slice(0, 80)}  [${s.how}]`));
    console.log('\nSHEET NAME -> CLIENT (fuzzy matches, to check):');
    sheetNames.filter((s) => s.c && s.how.startsWith('name match') && s.s < 0.95).forEach((s) => console.log(`  ${s.sheet}/${s.tab}: ${s.name.slice(0, 60).padEnd(60)} -> ${s.c.name}  (${s.how})`));
    console.log('\nRUNNING CLIENTS:');
    ['Medical', 'Manufacturing', 'Educational', null].forEach((d) => console.log(`  ${d}: ${clients.filter((c) => c.dept === d && open.has(c.id)).map((c) => c.name).join(' | ')}`));
    const rep = path.join(os.homedir(), '.teamlink-backups', `agreement-clients-${STAMP}`);
    fs.mkdirSync(rep, { recursive: true });
    fs.writeFileSync(path.join(rep, 'plan.json'), JSON.stringify({ clients: clients.map(({ files: f, nc, ...c }) => ({ ...c, files: f.length })), sheetNames: sheetNames.map(({ c, ...s }) => ({ ...s, client: c ? c.name : null })), fileRows: files.fileRows }, null, 1));
    console.log(`\nPlan written to ${rep}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    // ---- 5. write: backup, files, one transaction --------------------------------------------------------------------------
    const bak = path.join(rep, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    fs.mkdirSync(uploadsDir, { recursive: true });
    const copied = [];
    try {
      for (const op of files.fileOps) { fs.copyFileSync(op.src, op.dst); copied.push(op.dst); }
      await prisma.$transaction(async (tx) => {
        for (const r of L.orderedCreates()) await tx[r.model].create({ data: r.data });
      }, { timeout: 300000, maxWait: 60000 });
    } catch (e) {
      copied.forEach((f) => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
      throw e;
    }
    fs.writeFileSync(path.join(rep, 'undo.json'), JSON.stringify({ at: new Date().toISOString(), backup: bak, created: L.orderedCreates().map((r) => ({ model: r.model, id: r.id })), files: copied }, null, 1));
    console.log(`\nDONE. ${L.counts().created.client} clients, ${files.fileOps.length} files, ${reqs.length} requirements written.\nBackup of the database before: ${bak}\nUndo list: ${path.join(rep, 'undo.json')}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 2000)); process.exit(1); });

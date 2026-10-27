/* eslint-disable no-console, no-await-in-loop */
// Edu - 1 Requirement Sheet -> local ATS. One "Faculty requirement" per college, the way the Edu - 2 sheet was imported:
//   Running -> OPEN (nothing new when the college already has an open one)      Stopped / "told to stop" -> CLOSED (nothing new when one exists)
//   No Requirement / On Hold / No Agreement / blank -> no requirement            sheet vs app disagree -> NOT changed, listed
// Two colleges that are not clients yet are added (no agreement). Client fields are not overwritten.
//   node edu1-import.js <sheet.xlsx> <colleges.json> [--bde "<BDE name>"] [--apply]
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACK = path.resolve(__dirname, '..', '..');
process.chdir(BACK);
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const [FILE, COLLEGES] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
const BDE = (() => { const i = process.argv.indexOf('--bde'); return i > 0 ? process.argv[i + 1] : null; })(); // client manager for the new clients (optional)
const flat = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const one = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const MANUAL = { // sheet name (start) -> exact client name; null = a new client with the sheet's own name
  'CMR College of Engineering & Technology(CMRCET)': 'CMR College of Engineering & Technology (CMRCET)',
  'J.B institute of Engineering and Technology(JBIET)': 'J.B. Institute of Engineering and Technology (JBIET)',
  'Malla Reddy Engineering College & Management Science(MREM)': 'Malla Reddy Engineering College & Management Sciences',
  'AAR Mahaveer': 'Mahaveer', 'Mallareddy College of Engineering & Technology(MRCET)': 'MRCET',
  'Alamuri Ratnamala Institute of Engineering & Technology': 'ARMIET', 'Audisakara University': 'Audisankara University',
  'Shri Sai College of Engineering and Technology': 'Shri Sai College of Engineering & Technology',
  'BVRITW(Womens)': null, 'Narsimha Reddy Engineering College (NRCM)': null,
};
function openingsOf(pos) {
  const s = flat(pos);
  if (!s || /\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(s)) return 1;
  const n = (s.match(/\b\d{1,3}\b/g) || []).map(Number).filter((x) => x > 0 && x < 200);
  return n.length ? n.reduce((a, b) => a + b, 0) : 1;
}
const statusOf = (s) => { const x = flat(s).toLowerCase(); if (x === 'running') return 'RUNNING'; if (/^stopped|told to stop/.test(x)) return 'STOPPED'; if (/no requirement/.test(x)) return 'NONE'; if (/on hold/.test(x)) return 'HOLD'; if (/no agreement/.test(x)) return 'NOAGR'; return 'BLANK'; };

(async () => {
  const prisma = new PrismaClient();
  const auto = JSON.parse(fs.readFileSync(COLLEGES, 'utf8'));
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const byLower = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
  const raw = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets.Sheet1, { header: 1, defval: '' });
  const H = raw[0].map(flat);
  const colleges = []; let cur = null;
  raw.slice(1).forEach((x, i) => {
    if (!x.some((v) => flat(v))) return;
    if (flat(x[0])) { cur = { name: flat(x[0]), line: i + 2, rows: [] }; colleges.push(cur); }
    if (cur) cur.rows.push({ line: i + 2, x });
  });
  const plan = [];
  for (const c of colleges) {
    const mk = Object.keys(MANUAL).find((k) => c.name.startsWith(k));
    let client = null; let isNew = false;
    if (mk !== undefined) { const n = MANUAL[mk]; if (n === null) isNew = true; else client = n === 'ARMIET' ? clients.find((k) => k.name.startsWith('ARMIET')) : byLower.get(n.toLowerCase()); }
    else if (auto[c.name]) client = { id: auto[c.name].id, name: auto[c.name].name };
    const status = statusOf(c.rows.map((r) => r.x[15]).find((v) => flat(v)) || '');
    const pick = (i) => c.rows.map((r) => one(r.x[i])).filter(Boolean).join('\n');
    const description = [
      ['Requirements', pick(6)], ['Positions', pick(7)], ['Remarks', [pick(4), pick(15)].filter(Boolean).join('\n')], ['Agreement', pick(9)],
      ['Contact person', pick(1)], ['Contact number', pick(2)], ['Mail id', pick(8)], ['Location', pick(3)],
      ['Status history', [pick(10), pick(11), pick(12)].filter(Boolean).join('\n')],
    ].filter(([, v]) => v).map(([k, v]) => `${k}:\n${v}`).join('\n\n').concat(`\n\nFrom the Edu - 1 Requirement Sheet (rows ${c.rows.map((r) => r.line).join(', ')}).`).slice(0, 6000);
    plan.push({ ...c, client, isNew, status, description, openings: openingsOf(pick(7)), sheetStatus: flat(c.rows.map((r) => r.x[15]).find((v) => flat(v)) || '') });
  }
  const missing = plan.filter((p) => !p.client && !p.isNew);
  if (missing.length) { console.log('NOT MATCHED (stop):', missing.map((p) => p.name)); process.exit(2); }
  // decide per college
  const faculty = await prisma.requirement.findMany({ where: { title: 'Faculty requirement', department: 'Educational' }, select: { id: true, reqCode: true, clientId: true, status: true } });
  const fOf = (id) => faculty.filter((q) => q.clientId === id);
  const seenClient = new Map();
  plan.forEach((p) => {
    const ex = p.client ? fOf(p.client.id) : [];
    const open = ex.find((q) => q.status === 'OPEN'); const closed = ex.find((q) => q.status !== 'OPEN');
    if (p.client && seenClient.has(p.client.id)) { p.action = 'same client twice in the sheet - first row used'; return; }
    if (p.client) seenClient.set(p.client.id, p);
    if (p.status === 'RUNNING') p.action = open ? `already open (${open.reqCode})` : closed ? `CONFLICT: sheet says Running, the app has it closed (${closed.reqCode})` : 'create OPEN';
    else if (p.status === 'STOPPED') p.action = open ? `CONFLICT: sheet says ${p.sheetStatus}, the app has it open (${open.reqCode})` : closed ? `already closed (${closed.reqCode})` : 'create CLOSED';
    else p.action = open ? `NOTE: sheet says "${p.sheetStatus || 'blank'}", the app has an open one (${open.reqCode}) - left open` : `no requirement (${p.sheetStatus || 'blank'})`;
  });
  const grp = {}; plan.forEach((p) => { const k = p.action.replace(/\(.*\)/, '').replace(/"[^"]*"/, '"…"').trim(); grp[k] = (grp[k] || 0) + 1; });
  console.log(`COLLEGES ${plan.length} | new clients ${plan.filter((p) => p.isNew).length}: ${plan.filter((p) => p.isNew).map((p) => p.name).join(', ')}`);
  console.log(JSON.stringify(grp, null, 1));
  plan.filter((p) => /^create|CONFLICT|NOTE|twice/.test(p.action)).forEach((p) => console.log(`  ${(p.client ? p.client.name : p.name).slice(0, 48).padEnd(48)} ${p.action}${/^create/.test(p.action) ? ` - openings ${p.openings}` : ''}`));
  if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); await prisma.$disconnect(); return; }

  const dir = path.join(os.homedir(), '.teamlink-backups', `edu1-sheet-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(dir, 'before.db').split(path.sep).join('/')}'`);
  const codes = (await prisma.requirement.findMany({ where: { reqCode: { not: null } }, select: { reqCode: true } })).map((r) => r.reqCode);
  let k = codes.reduce((m, c) => { const x = /^REQ-(\d+)$/.exec(c); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  const undo = { clients: [], requirements: [] };
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      if (p.isNew) {
        const c = await tx.client.create({ data: { name: p.name, legalName: p.name, ownerDepartment: 'Educational', industry: 'Education', status: 'Active', clientType: 'Direct', bdeOwner: BDE, internalNotes: 'Added from the Edu - 1 Requirement Sheet (local import 2026-10-27). No signed agreement on file. Name as written on the sheet.' } });
        p.client = { id: c.id, name: c.name }; undo.clients.push(c.id);
      }
      if (!/^create/.test(p.action)) continue;
      k += 1;
      const r = await tx.requirement.create({ data: { title: 'Faculty requirement', clientId: p.client.id, department: 'Educational', status: /OPEN/.test(p.action) ? 'OPEN' : 'CLOSED', openings: p.openings, reqCode: `REQ-${String(k).padStart(4, '0')}`, hiringType: 'Client Placement', priority: 'Medium', description: p.description } });
      undo.requirements.push(r.id);
    }
    await tx.auditLog.create({ data: { action: `Local import: Edu - 1 Requirement Sheet - ${undo.requirements.length} requirements, ${undo.clients.length} new clients`, entity: 'Import', actorName: 'Local import 2026-10-27' } });
  });
  fs.writeFileSync(path.join(dir, 'undo.json'), JSON.stringify(undo, null, 1));
  console.log(`\nDONE: ${undo.requirements.length} requirements, ${undo.clients.length} clients. Backup: ${path.join(dir, 'before.db')}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

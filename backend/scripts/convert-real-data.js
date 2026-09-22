// ---------------------------------------------------------------------------
// CONVERTS THE COMPANY'S OWN REQUIREMENT SHEETS into the import template.
//
//   node scripts/convert-real-data.js <out.xlsx> <medical.xlsx> <manufacturing.xlsx>
//
// The two source workbooks are real working documents, not a data format: the
// same requirement appears on a "Running" tab and a "Stopped" tab, the status
// lives in a free-text Remarks column, a medical row carries SIX vacancy
// columns that are six different jobs, and one file's client name has no
// header at all. None of that is a mistake — it is what a sheet people
// actually use looks like.
//
// So this does not import them directly. It converts them into the template,
// which then goes through the SAME validated importer as anything else. Two
// reasons that matters: the mapping is reviewable here in one file rather than
// buried in an import, and the user can open the converted workbook and check
// it before a single row is written.
//
// FOUR JUDGEMENTS THIS MAKES, ALL REPORTED AT THE END
//
//   1. STATUS COMES FROM THE REMARKS TEXT where the text says something —
//      "The requirement is open" / "Stopped" / "The requirement is closed" —
//      and from the tab it was found on otherwise. Where the same requirement
//      appears on two tabs, a RECORDED CLOSURE beats a tab's default of open,
//      because a written remark is evidence and a default is a guess.
//
//   2. A MEDICAL ROW IS EXPLODED. Nurse / Consultant / SR / Assistant /
//      Associate / Professor are vacancy COUNTS against one specialisation,
//      so a row with 1 under Assistant and 1 under Professor is two
//      requirements, not one with two openings.
//
//   3. SKILLS ARE LEFT BLANK unless the sheet really recorded them. The
//      qualification and the specialisation ARE the hiring criteria in this
//      data and they are carried across as themselves; inventing a skills
//      list to fill the column would put fabricated criteria into candidate
//      matching.
//
//   4. A SPECIALISATION THAT IS ACTUALLY A NOTE is not made into one.
//      "22-1-25 On Hold from vas" is a follow-up comment that ended up in the
//      Specialization column; it is moved into the description and the
//      specialisation is left empty rather than creating a specialisation by
//      that name.
//
// NOT CONVERTED, and listed at the end so it is not mistaken for imported:
// the medical file's "Client Follow Up Process Sheet", which is prose notes
// rather than rows.
// ---------------------------------------------------------------------------

const fs = require('fs');
const ExcelJS = require('exceljs');
const { buildTemplate } = require('../src/utils/importTemplate');

const [, , OUT, MED_FILE, MAN_FILE] = process.argv;
if (!OUT || !MED_FILE || !MAN_FILE) {
  console.error('usage: node scripts/convert-real-data.js <out.xlsx> <medical.xlsx> <manufacturing.xlsx>');
  process.exit(1);
}

// --- reading a cell the way a spreadsheet actually stores things -----------
const txt = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return String(v.text !== undefined ? v.text : (v.result !== undefined ? v.result : ''));
  }
  return String(v);
};
// Collapse the newlines and double spaces that come from wrapped cells.
const clean = (v) => txt(v).replace(/\s+/g, ' ').trim();
const cell = (ws, r, n) => (n ? clean(ws.getRow(r).getCell(n).value) : '');

// Header name -> column number, so a tab that is missing a column (the medical
// "Sheet" tab has no Qualification) simply yields nothing for it instead of
// reading the neighbouring column's values.
function headerIndex(ws) {
  const ix = {};
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, n) => {
    const t = clean(c.value);
    if (t) ix[t] = n;
  });
  return ix;
}
// Tolerate the trailing spaces and spelling in the real headers
// ("Remarks ", "Specalization", "Discription").
function col(ix, ...names) {
  for (const n of names) {
    if (ix[n]) return ix[n];
    const hit = Object.keys(ix).find((k) => k.toLowerCase().replace(/\s+/g, '') === n.toLowerCase().replace(/\s+/g, ''));
    if (hit) return ix[hit];
  }
  return 0;
}

// --- a vacancy count, which is not always a number ------------------------
// One cell in the manufacturing file holds a DATE where a vacancy count
// belongs ("2025-05-10"), because somebody typed 5/10 and Excel helped. A
// number that is not a plausible headcount is treated as unknown rather than
// imported as 45000 openings.
function openings(raw) {
  const s = clean(raw);
  if (!s) return { value: null };
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { value: null, note: s };
  if (n > 500) return { value: null, note: s };
  return { value: Math.round(n) };
}

// --- what the Remarks text says about status ------------------------------
const OPEN = 'OPEN';
const CLOSED = 'CLOSED';
function statusFromRemarks(remarks) {
  const s = clean(remarks).toLowerCase();
  if (!s) return null;
  if (/\bis open\b|requirement is open/.test(s)) return OPEN;
  if (/stop|closed|done by us|no requirement|recruit(?:e|ur)ed internal|internal employee/.test(s)) return CLOSED;
  return null;
}

// A Specialization cell that is really a follow-up note. Dates like "22-1-25"
// and "5-5-25" are the giveaway, as is any text long enough to be a sentence.
function looksLikeNote(s) {
  if (!s) return false;
  if (s.length > 60) return true;
  if (/\d{1,2}-\d{1,2}-\d{2,4}/.test(s)) return true;
  if (/\b(on hold|no requirement|client said|whatsapp|through call)\b/i.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------
const clients = new Map();       // cleaned name -> { name, industry, department }
const specialisations = new Map(); // `${dept}|${name}` -> { department, name }
const requirements = [];         // template rows
const seen = new Map();          // dedup key -> index into requirements
const stats = { sources: [], notes: [], exploded: 0, noteSpecialisations: 0, badOpenings: 0, statusConflicts: 0, dedupedKept: 0 };

const norm = (s) => clean(s).toLowerCase();

function addClient(name, department, industry) {
  const key = norm(name);
  if (!key) return null;
  if (!clients.has(key)) clients.set(key, { name: clean(name), industry, department });
  return clients.get(key).name;
}

function addSpecialisation(department, name) {
  if (!name) return '';
  const key = `${department}|${norm(name)}`;
  if (!specialisations.has(key)) specialisations.set(key, { department, name });
  return specialisations.get(key).name;
}

// Add a requirement, merging when the same job shows up on a second tab.
function addRequirement(row) {
  const key = [row.department, norm(row.client), norm(row.title), norm(row.specialisation), norm(row.education)].join('|');
  const at = seen.get(key);
  if (at === undefined) {
    seen.set(key, requirements.length);
    requirements.push(row);
    return;
  }
  const existing = requirements[at];
  // WHICH SIGHTING'S STATUS WINS.
  //
  //   1. Two sightings that BOTH say something, and disagree — the "Running"
  //      tab wins. That is the sheet the team keeps current; a row left
  //      behind on "Stopped" is how a reopened requirement looks. Counted, so
  //      the conflicts can be eyeballed rather than taken on trust.
  //   2. Exactly one sighting says something — that one wins, because a
  //      written remark is evidence and a tab's default is a guess.
  //   3. Neither says anything — whichever tab was read first keeps its
  //      default, and the tabs are read Stopped-first on purpose: a job
  //      sitting on the Stopped tab with no remark is more likely closed than
  //      the master list is to be up to date.
  const bothExplicit = row.explicitStatus && existing.explicitStatus;
  if (bothExplicit && row.explicitStatus !== existing.explicitStatus) {
    stats.statusConflicts += 1;
    const fromRunning = /Running/i.test(row.source) ? row : (/Running/i.test(existing.source) ? existing : null);
    if (fromRunning) {
      existing.status = fromRunning.explicitStatus;
      existing.explicitStatus = fromRunning.explicitStatus;
      existing.statusNote = `Listed as ${row.explicitStatus === fromRunning.explicitStatus ? existing.explicitStatus : row.explicitStatus} on one tab and ${fromRunning.explicitStatus} on the Running tab — taken as ${fromRunning.explicitStatus}.`;
    } else {
      existing.status = CLOSED;
      existing.explicitStatus = CLOSED;
      existing.statusNote = 'Two tabs disagree on whether this is open; taken as closed. Please confirm.';
    }
  } else if (row.explicitStatus && !existing.explicitStatus) {
    existing.status = row.explicitStatus;
    existing.explicitStatus = row.explicitStatus;
  }
  // Keep whichever sighting recorded more, field by field.
  ['location', 'education', 'description', 'specialisation'].forEach((f) => {
    if (!existing[f] && row[f]) existing[f] = row[f];
    else if (row[f] && row[f].length > (existing[f] || '').length) existing[f] = row[f];
  });
  if (existing.openings == null && row.openings != null) existing.openings = row.openings;
  stats.dedupedKept += 1;
}

// --- MEDICAL --------------------------------------------------------------
// The six staffing columns, and what each one is actually hiring for.
const MED_ROLES = [
  ['Nurse', 'Nurse'],
  ['Consultant/Doctor', 'Consultant / Doctor'],
  ['SR', 'Senior Resident'],
  ['Assistant', 'Assistant Professor'],
  ['Associate', 'Associate Professor'],
  ['Professor', 'Professor'],
];

function readMedicalSheet(ws, defaultStatus, label) {
  const ix = headerIndex(ws);
  const cClient = col(ix, 'Client Name') || 1; // the "Running" tab's first column has no header
  const cBeds = col(ix, 'Bed Capacity');
  const cQual = col(ix, 'Qualification');
  const cSpec = col(ix, 'Specialization', 'Specalization');
  const cPack = col(ix, 'Package');
  const cRem = col(ix, 'Remarks');
  let rows = 0;

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const clientName = cell(ws, r, cClient);
    if (!clientName) continue;
    const client = addClient(clientName, 'Medical', 'Healthcare');
    const rawSpec = cell(ws, r, cSpec);
    const remarks = cell(ws, r, cRem);
    const explicit = statusFromRemarks(remarks);
    const beds = cell(ws, r, cBeds);
    const qual = cell(ws, r, cQual);
    const pack = cell(ws, r, cPack);

    // A note that landed in the Specialization column stays a note.
    let spec = '';
    const extraNotes = [];
    if (looksLikeNote(rawSpec)) {
      if (rawSpec) { extraNotes.push(`Specialization column note: ${rawSpec}`); stats.noteSpecialisations += 1; }
    } else if (rawSpec) {
      spec = addSpecialisation('Medical', rawSpec);
    }

    const description = [
      beds ? `Bed capacity: ${beds}` : '',
      pack ? `Package / experience: ${pack}` : '',
      remarks ? `Remarks: ${remarks}` : '',
      ...extraNotes,
    ].filter(Boolean).join('\n');

    // ONE ROW, UP TO SIX JOBS.
    let made = 0;
    MED_ROLES.forEach(([header, title]) => {
      const c = col(ix, header);
      if (!c) return;
      const got = openings(ws.getRow(r).getCell(c).value);
      const raw = cell(ws, r, c);
      if (!raw) return;
      if (got.value == null) { stats.badOpenings += 1; }
      made += 1;
      addRequirement({
        department: 'Medical',
        client,
        title: spec ? `${title} — ${spec}` : title,
        role: title,
        specialisation: spec,
        openings: got.value,
        education: qual,
        location: '',
        description,
        status: explicit || defaultStatus,
        explicitStatus: explicit,
        source: label,
      });
    });

    // A row with a specialisation but no count against any role is still a
    // real requirement — dropping it would lose the opening entirely.
    if (!made) {
      addRequirement({
        department: 'Medical',
        client,
        title: spec || 'Medical Requirement',
        role: '',
        specialisation: spec,
        openings: null,
        education: qual,
        location: '',
        description,
        status: explicit || defaultStatus,
        explicitStatus: explicit,
        source: label,
      });
    } else {
      stats.exploded += made > 1 ? 1 : 0;
    }
    rows += 1;
  }
  stats.sources.push({ file: 'Medical', sheet: ws.name, rows, defaultStatus });
}

// --- MANUFACTURING -------------------------------------------------------
function readManufacturingSheet(ws, defaultStatus, label) {
  const ix = headerIndex(ws);
  const cClient = col(ix, 'Company Name') || 1;
  const cLoc = col(ix, 'Location');
  const cQual = col(ix, 'Qualifications', 'Qualification');
  const cSpec = col(ix, 'Specialization', 'Specalization');
  const cDesig = col(ix, 'Designation');
  const cVac = col(ix, 'Vacancies', 'No vaccancy');
  const cDesc = col(ix, 'Package and full details', 'Discription', 'Description');
  const cRem = col(ix, 'Remarks');
  let rows = 0;

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const clientName = cell(ws, r, cClient);
    if (!clientName) continue;
    const client = addClient(clientName, 'Manufacturing', 'Manufacturing');
    const rawSpec = cell(ws, r, cSpec);
    const remarks = cell(ws, r, cRem);
    const explicit = statusFromRemarks(remarks);
    const desig = cell(ws, r, cDesig);
    const got = openings(ws.getRow(r).getCell(cVac).value);
    if (cell(ws, r, cVac) && got.value == null) stats.badOpenings += 1;

    let spec = '';
    const extraNotes = [];
    if (looksLikeNote(rawSpec)) {
      if (rawSpec) { extraNotes.push(`Specialization column note: ${rawSpec}`); stats.noteSpecialisations += 1; }
    } else if (rawSpec) {
      spec = addSpecialisation('Manufacturing', rawSpec);
    }

    const description = [
      cell(ws, r, cDesc) ? cell(ws, r, cDesc) : '',
      remarks ? `Remarks: ${remarks}` : '',
      got.note ? `Vacancy column read "${got.note}", which is not a headcount — please confirm.` : '',
      ...extraNotes,
    ].filter(Boolean).join('\n');

    // A row with no designation still has a specialisation or a
    // qualification; titling it from those keeps the opening rather than
    // discarding it for want of one cell.
    const title = desig || spec || 'Manufacturing Requirement';

    addRequirement({
      department: 'Manufacturing',
      client,
      title,
      role: desig,
      specialisation: spec,
      openings: got.value,
      education: cell(ws, r, cQual),
      location: cell(ws, r, cLoc).startsWith('http') ? '' : cell(ws, r, cLoc),
      description: cell(ws, r, cLoc).startsWith('http') ? `${description}\nLocation link: ${cell(ws, r, cLoc)}` : description,
      status: explicit || defaultStatus,
      explicitStatus: explicit,
      source: label,
    });
    rows += 1;
  }
  stats.sources.push({ file: 'Manufacturing', sheet: ws.name, rows, defaultStatus });
}

// --- the two Just Dial tabs, which are their own shape -------------------
function readJustDial(wsRoles, wsCities) {
  const client = addClient('Just Dial', 'Manufacturing', 'Business Services');
  if (wsRoles) {
    const ix = headerIndex(wsRoles);
    const cD = col(ix, 'Designation');
    const cW = col(ix, 'Work');
    const cQ = col(ix, 'Qualification / Experience', 'Qualification/Experience');
    const cC = col(ix, 'CTC');
    const cL = col(ix, 'Location');
    let rows = 0;
    for (let r = 2; r <= wsRoles.rowCount; r += 1) {
      const title = cell(wsRoles, r, cD);
      if (!title) continue;
      addRequirement({
        department: 'Manufacturing',
        client,
        title,
        role: title,
        specialisation: '',
        openings: null,
        education: cell(wsRoles, r, cQ),
        location: cell(wsRoles, r, cL),
        description: [cell(wsRoles, r, cW) ? `Work: ${cell(wsRoles, r, cW)}` : '', cell(wsRoles, r, cC) ? `CTC: ${cell(wsRoles, r, cC)}` : ''].filter(Boolean).join('\n'),
        status: OPEN,
        explicitStatus: null,
        source: 'just dial',
      });
      rows += 1;
    }
    stats.sources.push({ file: 'Manufacturing', sheet: 'just dial', rows, defaultStatus: OPEN });
  }
  if (wsCities) {
    const ix = headerIndex(wsCities);
    const cCity = col(ix, 'City');
    const cVac = col(ix, 'No. Of Vacancies');
    const cReq = col(ix, 'Requirements');
    let rows = 0;
    for (let r = 2; r <= wsCities.rowCount; r += 1) {
      const city = cell(wsCities, r, cCity);
      if (!city) continue;
      const got = openings(wsCities.getRow(r).getCell(cVac).value);
      addRequirement({
        department: 'Manufacturing',
        client,
        title: `Certified Internet Consultant — ${city}`,
        role: 'Certified Internet Consultant',
        specialisation: '',
        openings: got.value,
        education: '',
        location: city,
        description: cell(wsCities, r, cReq),
        status: OPEN,
        explicitStatus: null,
        source: 'Just dial CIC list',
      });
      rows += 1;
    }
    stats.sources.push({ file: 'Manufacturing', sheet: 'Just dial CIC list', rows, defaultStatus: OPEN });
  }
}

// ---------------------------------------------------------------------------
(async () => {
  const med = new ExcelJS.Workbook();
  await med.xlsx.readFile(MED_FILE);
  const man = new ExcelJS.Workbook();
  await man.xlsx.readFile(MAN_FILE);

  // ORDER MATTERS ONLY FOR WHICH TAB IS SEEN FIRST — the merge rule above is
  // what decides status, not the order.
  if (med.getWorksheet('Stopped')) readMedicalSheet(med.getWorksheet('Stopped'), CLOSED, 'Medical/Stopped');
  if (med.getWorksheet('Sheet')) readMedicalSheet(med.getWorksheet('Sheet'), OPEN, 'Medical/Sheet');
  if (med.getWorksheet('Running')) readMedicalSheet(med.getWorksheet('Running'), OPEN, 'Medical/Running');
  if (med.getWorksheet('Client Follow Up Process Sheet')) {
    stats.notes.push('Medical / "Client Follow Up Process Sheet" is prose notes, not rows — NOT imported.');
  }

  const manStopped = man.worksheets.find((w) => clean(w.name).toLowerCase() === 'stopped');
  const manRunning = man.worksheets.find((w) => clean(w.name).toLowerCase() === 'running');
  const manAll = man.worksheets.find((w) => clean(w.name).toLowerCase().startsWith('manufacturing all'));
  if (manStopped) readManufacturingSheet(manStopped, CLOSED, 'Manufacturing/Stopped');
  if (manAll) readManufacturingSheet(manAll, OPEN, 'Manufacturing/All');
  if (manRunning) readManufacturingSheet(manRunning, OPEN, 'Manufacturing/Running');
  readJustDial(
    man.worksheets.find((w) => clean(w.name).toLowerCase() === 'just dial'),
    man.worksheets.find((w) => clean(w.name).toLowerCase() === 'just dial cic list'),
  );

  // --- write the template ------------------------------------------------
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await buildTemplate()));

  const put = (sheetName, rows) => {
    const ws = wb.getWorksheet(sheetName);
    const ix = {};
    ws.getRow(1).eachCell((c, n) => { ix[clean(c.value)] = n; });
    rows.forEach((row, i) => {
      Object.entries(row).forEach(([header, value]) => {
        if (value === null || value === undefined || value === '') return;
        const at = ix[header];
        if (!at) throw new Error(`template sheet ${sheetName} has no column "${header}"`);
        ws.getRow(i + 2).getCell(at).value = value;
      });
    });
    return rows.length;
  };

  // Departments, with one team each so a TL can be scoped later.
  const departments = [...new Set([...clients.values()].map((c) => c.department))];
  put('Departments', departments.map((d) => ({ Department: d, Team: `${d} Team-A` })));
  put('Specialisations', [...specialisations.values()].map((s) => ({ Department: s.department, Specialisation: s.name })));
  put('Clients', [...clients.values()].map((c) => ({
    'Client Name': c.name,
    Industry: c.industry,
    Status: 'Active',
    'Owning Department': c.department,
    'Client Type': 'Direct',
  })));

  // Requirement codes, numbered per department so they read sensibly.
  const counters = {};
  const prefix = { Medical: 'MED', Manufacturing: 'MFG' };
  put('Requirements', requirements.map((r) => {
    const p = prefix[r.department] || 'REQ';
    counters[p] = (counters[p] || 0) + 1;
    return {
      'Requirement Code': `${p}-${String(counters[p]).padStart(4, '0')}`,
      'Job Title': r.title.slice(0, 200),
      'Client Name': r.client,
      Department: r.department,
      Specialisation: r.specialisation,
      Status: r.status,
      Openings: r.openings,
      Education: r.education,
      Location: r.location,
      'Job Description': [r.description, r.statusNote ? `Status note: ${r.statusNote}` : ''].filter(Boolean).join('\n'),
      'Hiring Type': 'Client Placement',
    };
  }));

  fs.writeFileSync(OUT, Buffer.from(await wb.xlsx.writeBuffer()));

  // --- the report --------------------------------------------------------
  console.log(`Wrote ${OUT}\n`);
  console.log('READ FROM:');
  stats.sources.forEach((s) => console.log(`  ${s.file.padEnd(14)} ${s.sheet.padEnd(32)} ${String(s.rows).padStart(4)} rows   (tab default: ${s.defaultStatus})`));
  const open = requirements.filter((r) => r.status === OPEN).length;
  console.log('\nPRODUCED:');
  console.log(`  ${departments.length} departments        ${departments.join(', ')}`);
  console.log(`  ${specialisations.size} specialisations`);
  console.log(`  ${clients.size} clients`);
  console.log(`  ${requirements.length} requirements       ${open} OPEN / ${requirements.length - open} CLOSED`);
  const byDept = {};
  requirements.forEach((r) => { byDept[r.department] = (byDept[r.department] || 0) + 1; });
  Object.entries(byDept).forEach(([d, n]) => console.log(`      ${d}: ${n}`));
  console.log('\nJUDGEMENTS MADE:');
  console.log(`  ${stats.dedupedKept} duplicate sightings merged (same client + job + specialisation on more than one tab)`);
  console.log(`  ${stats.statusConflicts} jobs appeared on two tabs with CONFLICTING status — the Running tab was taken as current, and the reason is written into that job description`);
  console.log(`  ${stats.exploded} medical rows carried more than one role and became several requirements`);
  console.log(`  ${stats.noteSpecialisations} Specialization cells were follow-up notes — moved into the description, specialisation left blank`);
  console.log(`  ${stats.badOpenings} vacancy cells were not a headcount — left blank and flagged in the description`);
  console.log('  skills left blank throughout: the sheets record qualification and specialisation, not skills');
  stats.notes.forEach((n) => console.log(`  ${n}`));
})().catch((e) => { console.error(e); process.exit(1); });

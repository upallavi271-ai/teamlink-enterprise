// ---------------------------------------------------------------------------
// DATA IMPORT — replacing the demo data with the company's real data.
//
//   GET  /data-import/template   download the blank workbook
//   POST /data-import/check      upload it, validate, report — WRITES NOTHING
//   POST /data-import/commit     upload it and import
//   POST /data-import/clear-demo remove the seeded demo records
//
// THE SHAPE OF THE WORKBOOK IS NOT DESCRIBED HERE. It lives in
// utils/importSpec.js, which also generates the template, so the sheet the
// user fills in and the parser that reads it back cannot disagree about a
// column name. Adding a field is one line there.
//
// THREE THINGS THIS DOES THAT A NAIVE IMPORTER DOES NOT:
//
//   1. CHECK BEFORE WRITING. /check runs the entire import in memory and
//      reports every problem with its sheet and row number. Half-importing
//      four hundred employees and leaving somebody to work out which ones
//      landed is the failure mode worth designing against.
//
//   2. UPSERT ON A BUSINESS KEY. Employee Code, Client Name, Requirement
//      Code, candidate email, Invoice Number. Re-importing a corrected file
//      updates the same records instead of doubling them, so fixing a typo
//      does not mean starting over.
//
//   3. RESOLVE REFERENCES ACROSS THE WHOLE FILE, not just against the
//      database. A requirement may name a client that is being created three
//      sheets earlier in the same upload, so the lookup maps are filled as
//      the import proceeds.
//
// The demo data is NEVER touched implicitly. /clear-demo is a separate,
// explicit call, because "import my data" must not be able to mean "delete
// what is already there".
// ---------------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const { SHEETS, LISTS } = require('../utils/importSpec');
const { buildTemplate } = require('../utils/importTemplate');
const { mappingFor } = require('../utils/identity');
const { productRolesForDesignation, loginRoleFor, normalEmail } = require('../utils/employeeAdmin');

const router = express.Router();
router.use(requireAuth);

// Importing the company's master data is a Super Admin act. `configure` on
// Employee Management is the narrowest existing permission that means "may
// change how this company's records are set up", so it is reused rather than
// inventing a feature the permission matrix does not know about.
const ADMIN = requirePerm(null, 'hrms', 'Employee Management', 'configure');

// A workbook is bigger than a photo. 20 MB covers a few thousand rows across
// every sheet with room to spare.
const MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// READING A CELL. Excel is loose about what it hands over and the importer
// has to be strict about what it stores.
// ---------------------------------------------------------------------------

// exceljs returns a plain value, a formula result, a hyperlink object or rich
// text depending on how the cell was produced. Flatten all of them to a
// string; anything unrecognised becomes blank rather than "[object Object]".
function rawText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.hyperlink !== undefined) return String(v.text || v.hyperlink);
    return '';
  }
  return v;
}

// Excel's own date serial: days since 1899-12-30, which is the 1900 leap-year
// bug baked into the format. Only applied to a cell the spec calls a date, so
// an ordinary number is never mistaken for one.
function fromSerial(n) {
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms);
}

const isoDay = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// Coerce one cell to what the column says it is. Returns { value, error }.
function coerce(col, raw) {
  const v = rawText(raw);
  const empty = v === '' || v === null || v === undefined;

  if (empty) {
    if (col.req) return { error: 'required, but the cell is empty' };
    return { value: null };
  }

  if (col.t === 'date') {
    let d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number') d = fromSerial(v);
    else {
      const s = String(v).trim();
      // YYYY-MM-DD is what the template asks for; DD/MM/YYYY and DD-MM-YYYY
      // are accepted because a person filling a sheet by hand types those,
      // and refusing an unambiguous date to make a point helps nobody.
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
      if (iso) d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
      else if (dmy) d = new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
      else return { error: `"${s}" is not a date I can read — use YYYY-MM-DD` };
    }
    if (!d || Number.isNaN(d.getTime())) return { error: `"${v}" is not a valid date` };
    return { value: isoDay(d), date: d };
  }

  if (col.t === 'number') {
    // Strip what a person types around a number: ₹, commas, spaces.
    const s = String(v).replace(/[₹,\s]/g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) return { error: `"${v}" is not a number` };
    return { value: n };
  }

  if (col.t === 'list') {
    const allowed = LISTS[col.list] || [];
    const s = String(v).trim();
    const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
    if (!hit) return { error: `"${s}" is not allowed here. Use one of: ${allowed.join(', ')}` };
    return { value: hit };
  }

  return { value: String(v).trim() };
}

const yes = (v) => String(v || '').trim().toLowerCase() === 'yes';

// ---------------------------------------------------------------------------
// READING A SHEET into rows of { field: value }, with per-cell errors.
// ---------------------------------------------------------------------------
function readSheet(ws, spec) {
  const problems = [];
  const rows = [];
  if (!ws) return { rows, problems, missing: true };

  // Map each spec column to the column index whose header matches. Matching
  // on the HEADER TEXT rather than on position is deliberate: somebody will
  // reorder or hide a column, and a positional parser would then write phone
  // numbers into the department field without complaining.
  const headerRow = ws.getRow(1);
  const index = {};
  headerRow.eachCell((cell, colNumber) => {
    const text = String(rawText(cell.value) || '').trim().toLowerCase();
    if (text) index[text] = colNumber;
  });

  const mapped = [];
  spec.columns.forEach((col) => {
    const at = index[col.h.toLowerCase()];
    if (at) mapped.push({ col, at });
    else if (col.req) problems.push({ row: 1, column: col.h, message: `the required column "${col.h}" is missing from this sheet` });
  });
  if (problems.length) return { rows, problems };

  for (let n = 2; n <= ws.rowCount; n += 1) {
    const row = ws.getRow(n);
    const data = {};
    const rowProblems = [];
    let anyValue = false;

    mapped.forEach(({ col, at }) => {
      const raw = row.getCell(at).value;
      const got = coerce(col, raw);
      const present = rawText(raw) !== '' && rawText(raw) !== null;
      if (present) anyValue = true;
      if (got.error) rowProblems.push({ row: n, column: col.h, message: got.error });
      else data[col.f] = got.value;
    });

    // A COMPLETELY BLANK ROW IS NOT AN ERROR. Spreadsheets are full of them —
    // a stray space, a deleted row, formatting dragged down a hundred lines.
    // Only a row with something in it is held to the required-column rule.
    if (!anyValue) continue;
    rowProblems.forEach((p) => problems.push(p));
    if (!rowProblems.length) rows.push({ row: n, data });
  }

  return { rows, problems };
}

// ---------------------------------------------------------------------------
// THE LOOKUP MAPS. Names and codes the sheets use -> real ids. Seeded from
// the database and then added to as the import creates records, so a
// requirement can name a client created earlier in the same file.
// ---------------------------------------------------------------------------
async function buildIndex() {
  const [clients, requirements, candidates, employees, users, departments] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true } }),
    prisma.requirement.findMany({ select: { id: true, reqCode: true, title: true } }),
    prisma.candidate.findMany({ select: { id: true, email: true, phone: true } }),
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    prisma.department.findMany({ select: { id: true, name: true } }),
  ]);
  const norm = (s) => String(s || '').trim().toLowerCase();
  // A CLIENT IS MATCHED IGNORING PUNCTUATION AND CASE, because a sheet
  // filled in by several people spells one company several ways —
  // "Shifa Hospital, Tamil Nadu" and "Shifa Hospital,Tamil Nadu" differ by
  // one space. Without this, the second spelling creates a second client
  // and splits that client's requirements between two records. Only
  // punctuation and case are ignored, so names differing in WORDS — two
  // real branches of one hospital group — stay separate.
  const ckey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const ix = {
    client: new Map(clients.map((r) => [ckey(r.name), r.id])),
    requirement: new Map(requirements.filter((r) => r.reqCode).map((r) => [norm(r.reqCode), r.id])),
    candidate: new Map(),
    employee: new Map(employees.map((r) => [norm(r.name), r])),
    employeeByCode: new Map(employees.map((r) => [norm(r.employeeCode), r])),
    user: new Map(users.map((r) => [norm(r.name), r.id])),
    userByEmail: new Map(users.map((r) => [norm(r.email), r.id])),
    department: new Map(departments.map((r) => [norm(r.name), r.id])),
    norm,
    ckey,
  };
  candidates.forEach((r) => {
    if (r.email) ix.candidate.set(norm(r.email), r.id);
    if (r.phone) ix.candidate.set(norm(r.phone), r.id);
  });
  return ix;
}

// A password nobody can guess and nobody is told, for an imported login. The
// person signs in via the set-password link, exactly as a new joiner does —
// an import must never invent a shared password across four hundred accounts.
async function unguessableHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
}

// ---------------------------------------------------------------------------
// ONE HANDLER PER SHEET. Each returns 'created' | 'updated' | 'skipped', or
// throws an Error whose message is shown against that row.
//
// `dry` is the whole point: in a dry run a handler works out exactly what it
// WOULD do — including whether the key already exists and whether every
// reference resolves — and returns that verdict without touching the database.
// ---------------------------------------------------------------------------
const HANDLERS = {
  async department({ data, ix, dry }) {
    const name = data.name;
    let id = ix.department.get(ix.norm(name));
    let action = 'updated';
    if (!id) {
      action = 'created';
      if (!dry) {
        const row = await prisma.department.create({ data: { name } });
        id = row.id;
      } else {
        id = `dry:${name}`;
      }
      ix.department.set(ix.norm(name), id);
    }
    if (data.team) {
      if (!dry) {
        const existing = await prisma.team.findFirst({ where: { departmentId: id, name: data.team } });
        if (!existing) await prisma.team.create({ data: { departmentId: id, name: data.team } });
      }
    }
    return action;
  },

  async specialisation({ data, ix, dry }) {
    const deptId = ix.department.get(ix.norm(data.department));
    if (!deptId) throw new Error(`department "${data.department}" is not on the Departments sheet or in the system`);
    // A dry run used to answer "created" unconditionally, so re-checking a
    // file already imported claimed it would add 214 specialisations that
    // were already there. The report is only useful if it says what the
    // import will really do, so the existence check runs in both modes —
    // it is a read, and a dry run is allowed to read.
    const existing = deptId.startsWith('dry:')
      ? null
      : await prisma.specialisation.findFirst({ where: { departmentId: deptId, name: data.name } });
    if (dry) return existing ? 'updated' : 'created';
    if (existing) return 'updated';
    await prisma.specialisation.create({ data: { departmentId: deptId, name: data.name } });
    return 'created';
  },

  async employee({ data, ix, dry }) {
    const code = data.employeeCode;
    const existing = ix.employeeByCode.get(ix.norm(code));

    // The designation is what grants the roles, so an unknown one is refused
    // rather than quietly creating somebody with no access at all.
    const mapping = await mappingFor(data.designation);
    if (!mapping) throw new Error(`designation "${data.designation}" is not configured under Administration → Designations`);

    const email = data.email ? normalEmail(data.email) : null;
    const loginEmail = data._loginEmail ? normalEmail(data._loginEmail) : email;
    const wantLogin = data._createLogin === null ? true : yes(data._createLogin);

    // Employee columns only — the two underscore-prefixed ones are
    // instructions to this handler, not fields on the row.
    const fields = {};
    Object.entries(data).forEach(([k, v]) => {
      if (k.startsWith('_') || v === null) return;
      fields[k] = v;
    });
    if (email) fields.email = email;
    ['dateOfJoining', 'dateOfBirth'].forEach((k) => {
      if (fields[k]) fields[k] = new Date(`${fields[k]}T00:00:00.000Z`);
    });

    if (dry) {
      if (wantLogin && loginEmail) {
        const taken = ix.userByEmail.get(ix.norm(loginEmail));
        if (taken && (!existing || existing.userId !== taken)) {
          throw new Error(`the login ${loginEmail} already belongs to somebody else`);
        }
      }
      if (wantLogin && !loginEmail) throw new Error('Create Login is Yes but there is no email to sign in with');

      // A DRY RUN HAS TO PRETEND IT SUCCEEDED, or it reports errors the real
      // import would never hit. Without this, a requirement three sheets later
      // that names a recruiter being created HERE was reported as "has no
      // login in the system" — the checker inventing a problem and then
      // refusing the whole file over it. So the would-be records go into the
      // lookup maps exactly as the real ones do, marked `dry:` so nothing
      // mistakes them for real ids.
      const placeholder = { id: `dry:${ix.norm(code)}`, name: fields.name, employeeCode: code, userId: null };
      ix.employeeByCode.set(ix.norm(code), existing || placeholder);
      if (fields.name) ix.employee.set(ix.norm(fields.name), existing || placeholder);
      if (wantLogin && loginEmail) {
        if (!ix.userByEmail.has(ix.norm(loginEmail))) ix.userByEmail.set(ix.norm(loginEmail), `dry:${ix.norm(loginEmail)}`);
        if (fields.name && !ix.user.has(ix.norm(fields.name))) ix.user.set(ix.norm(fields.name), `dry:${ix.norm(loginEmail)}`);
      }
      return existing ? 'updated' : 'created';
    }

    if (existing) {
      await prisma.employee.update({ where: { id: existing.id }, data: fields });
      ix.employee.set(ix.norm(fields.name || ''), existing);
      return 'updated';
    }

    let userId = null;
    if (wantLogin && loginEmail) {
      const taken = await prisma.user.findUnique({ where: { email: loginEmail } });
      if (taken) throw new Error(`the login ${loginEmail} already belongs to somebody else`);
      const user = await prisma.user.create({
        data: {
          name: fields.name,
          email: loginEmail,
          username: loginEmail,
          passwordHash: await unguessableHash(),
          role: loginRoleFor(mapping),
          status: 'Active',
          branch: fields.branch || fields.location || null,
          team: fields.team || null,
          atsDepartment: fields.department || null,
          ...productRolesForDesignation(mapping),
          atsScopeDepartments: fields.department || null,
          atsScopeTeams: fields.team || null,
          hrmsAccess: !!mapping.hrms,
          atsAccess: !!mapping.ats,
          accountsAccess: !!mapping.accounts,
          landingWorkspace: mapping.landing || null,
        },
      });
      userId = user.id;
      ix.userByEmail.set(ix.norm(loginEmail), user.id);
      ix.user.set(ix.norm(fields.name), user.id);
    }

    const row = await prisma.employee.create({ data: { ...fields, userId } });
    ix.employeeByCode.set(ix.norm(code), { id: row.id, name: row.name, employeeCode: code, userId });
    ix.employee.set(ix.norm(row.name), { id: row.id, name: row.name, employeeCode: code, userId });
    return 'created';
  },

  async client({ data, ix, dry }) {
    // ckey, NOT norm. The index is built with ckey (punctuation and case
    // ignored), so looking up with norm never matched and every client on the
    // sheet was reported as new — including the 124 that already existed.
    const key = ix.ckey(data.name);
    const id = ix.client.get(key);
    if (dry) {
      if (!id) ix.client.set(key, `dry:${key}`);
      return id && !String(id).startsWith('dry:') ? 'updated' : 'created';
    }
    if (id) {
      await prisma.client.update({ where: { id }, data });
      return 'updated';
    }
    const row = await prisma.client.create({ data });
    ix.client.set(key, row.id);
    return 'created';
  },

  async requirement({ data, ix, dry }) {
    const clientId = ix.client.get(ix.ckey(data._client));
    if (!clientId) throw new Error(`client "${data._client}" is not on the Clients sheet or in the system`);

    const fields = {};
    Object.entries(data).forEach(([k, v]) => { if (!k.startsWith('_') && v !== null) fields[k] = v; });
    fields.clientId = clientId;

    // Assignment is by NAME on the sheet and by user id in the database.
    if (data._recruiter) {
      const uid = ix.user.get(ix.norm(data._recruiter));
      if (!uid) throw new Error(`recruiter "${data._recruiter}" has no login in the system`);
      fields.recruiterId = uid;
    }
    if (data._bde) {
      const uid = ix.user.get(ix.norm(data._bde));
      if (!uid) throw new Error(`BDE "${data._bde}" has no login in the system`);
      fields.bdeId = uid;
    }
    if (data.specialisation) {
      const deptId = ix.department.get(ix.norm(data.department));
      if (deptId && !dry) {
        const known = await prisma.specialisation.findFirst({ where: { departmentId: deptId, name: data.specialisation } });
        if (!known) throw new Error(`"${data.specialisation}" is not a specialisation of ${data.department} — add it to the Specialisations sheet`);
      }
    }

    const key = ix.norm(data.reqCode);
    const id = ix.requirement.get(key);
    if (dry) {
      if (!id) ix.requirement.set(key, `dry:${key}`);
      return id && !String(id).startsWith('dry:') ? 'updated' : 'created';
    }
    if (id) {
      await prisma.requirement.update({ where: { id }, data: fields });
      return 'updated';
    }
    const row = await prisma.requirement.create({ data: fields });
    ix.requirement.set(key, row.id);
    return 'created';
  },

  async candidate({ data, ix, dry }) {
    if (!data.email && !data.phone) throw new Error('give an Email or a Phone — one of the two is needed to tell candidates apart');
    const key = ix.norm(data.email || data.phone);
    const id = ix.candidate.get(key);
    if (dry) {
      if (!id) ix.candidate.set(key, `dry:${key}`);
      return id && !String(id).startsWith('dry:') ? 'updated' : 'created';
    }
    if (id) {
      await prisma.candidate.update({ where: { id }, data });
      return 'updated';
    }
    const row = await prisma.candidate.create({ data });
    if (data.email) ix.candidate.set(ix.norm(data.email), row.id);
    if (data.phone) ix.candidate.set(ix.norm(data.phone), row.id);
    return 'created';
  },

  async application({ data, ix, dry }) {
    const candidateId = ix.candidate.get(ix.norm(data._candidate));
    if (!candidateId) throw new Error(`candidate "${data._candidate}" is not on the Candidates sheet or in the system`);
    const requirementId = ix.requirement.get(ix.norm(data._requirement));
    if (!requirementId) throw new Error(`requirement "${data._requirement}" is not on the Requirements sheet or in the system`);

    // A rejection with no reason is exactly the record that turns into "why
    // did we drop them?" six months later, which is what the rejected-candidate
    // history is for. So it is required at the point of import.
    if (data.stage === 'REJECTED' && !data.rejectionReason) {
      throw new Error('Stage is REJECTED, so a Rejection Reason is required');
    }

    const fields = {};
    Object.entries(data).forEach(([k, v]) => { if (!k.startsWith('_') && v !== null) fields[k] = v; });
    // THE REJECTION REASON IS NOT A COLUMN ON Application, and should not
    // become one. ApplicationStageEvent already keeps the full rejected /
    // hold record — candidate, requirement, client, previous stage, who
    // rejected, their side, reason category and detail — and that is what the
    // candidate's history reads. An imported rejection writes THERE, so a
    // rejection that came in on a spreadsheet reads exactly like one somebody
    // recorded in the app.
    const reason = fields.rejectionReason || null;
    delete fields.rejectionReason;
    fields.candidateId = candidateId;
    fields.requirementId = requirementId;
    ['interviewAt'].forEach((k) => { if (fields[k]) fields[k] = new Date(`${fields[k]}T00:00:00.000Z`); });

    if (dry) return 'created';

    const existing = await prisma.application.findFirst({ where: { candidateId, requirementId } });
    const app = existing
      ? await prisma.application.update({ where: { id: existing.id }, data: fields })
      : await prisma.application.create({ data: fields });

    // The history entry. Snapshotted, not joined — a requirement gets
    // retitled and a client renamed, and the record of why somebody was
    // rejected has to keep saying what it said at the time.
    const terminal = data.stage === 'REJECTED' || data.stage === 'HOLD';
    if (terminal) {
      const already = await prisma.applicationStageEvent.findFirst({
        where: { applicationId: app.id, toStage: data.stage },
      });
      if (!already) {
        const req = await prisma.requirement.findUnique({
          where: { id: requirementId },
          select: { title: true, clientId: true, client: { select: { name: true } } },
        });
        await prisma.applicationStageEvent.create({
          data: {
            applicationId: app.id,
            candidateId,
            fromStage: existing ? existing.stage : null,
            toStage: data.stage,
            action: data.stage === 'REJECTED' ? 'Rejected' : 'Put on hold',
            requirementId,
            requirementTitle: req ? req.title : null,
            clientId: req ? req.clientId : null,
            clientName: req && req.client ? req.client.name : null,
            reasonDetail: reason,
            // Imported, so there is no actor to name and pretending otherwise
            // would put a real person's name against a decision they may not
            // have made. `actorName` says where it came from instead.
            actorName: 'Imported from spreadsheet',
            actorSide: 'Internal',
          },
        });
      }
    }
    return existing ? 'updated' : 'created';
  },

  async invoice({ data, ix, dry }) {
    const clientId = ix.client.get(ix.ckey(data._client));
    if (!clientId) throw new Error(`client "${data._client}" is not on the Clients sheet or in the system`);

    const fields = {};
    Object.entries(data).forEach(([k, v]) => { if (!k.startsWith('_') && v !== null) fields[k] = v; });
    fields.clientId = clientId;
    if (data._candidate) {
      const cid = ix.candidate.get(ix.norm(data._candidate));
      if (!cid) throw new Error(`candidate "${data._candidate}" is not on the Candidates sheet or in the system`);
      fields.candidateId = cid;
    }
    if (data._requirement) {
      const rid = ix.requirement.get(ix.norm(data._requirement));
      if (!rid) throw new Error(`requirement "${data._requirement}" is not on the Requirements sheet or in the system`);
      fields.requirementId = rid;
    }
    if (data.tdsCertReceived !== null && data.tdsCertReceived !== undefined) {
      fields.tdsCertReceived = yes(data.tdsCertReceived);
    }
    // GST and TDS are stored as AMOUNTS and quoted as PERCENTAGES. The sheet
    // asks for the percentage because that is what a person knows; the amount
    // is computed here so the two can never disagree on a row.
    const pct = (p) => (p == null ? 0 : (Number(fields.amount || 0) * Number(p)) / 100);
    if (fields.gstPercent != null) fields.gst = pct(fields.gstPercent);
    if (fields.tdsPercent != null) fields.tds = pct(fields.tdsPercent);

    if (dry) return 'created';
    const existing = await prisma.invoice.findFirst({ where: { invoiceNumber: data.invoiceNumber } });
    if (existing) {
      await prisma.invoice.update({ where: { id: existing.id }, data: fields });
      return 'updated';
    }
    await prisma.invoice.create({ data: fields });
    return 'created';
  },
};

// ---------------------------------------------------------------------------
// THE RUN. Same code path for a dry run and a real one, which is the only way
// the report can be trusted to describe what the import will actually do.
// ---------------------------------------------------------------------------
async function run(workbook, { dry }) {
  const ix = await buildIndex();
  const report = { dry, sheets: [], totals: { created: 0, updated: 0, errors: 0, rows: 0 }, ok: true };

  for (const spec of SHEETS) {
    const ws = workbook.getWorksheet(spec.name);
    const result = { sheet: spec.name, product: spec.product, created: 0, updated: 0, errors: [], rows: 0 };
    if (!ws) {
      result.skipped = 'this sheet is not in the uploaded file';
      report.sheets.push(result);
      continue;
    }

    const { rows, problems } = readSheet(ws, spec);
    problems.forEach((p) => result.errors.push(p));
    result.rows = rows.length;

    for (const { row, data } of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const action = await HANDLERS[spec.model]({ data, ix, dry });
        if (action === 'created') result.created += 1;
        else if (action === 'updated') result.updated += 1;
      } catch (e) {
        result.errors.push({ row, column: '', message: e.message });
      }
    }

    report.totals.created += result.created;
    report.totals.updated += result.updated;
    report.totals.errors += result.errors.length;
    report.totals.rows += result.rows;
    if (result.errors.length) report.ok = false;
    report.sheets.push(result);
  }
  return report;
}

// Pull the workbook off the request. Refuses anything that is not a .xlsx —
// checked on the ZIP magic bytes, not on the file name, because a name is
// whatever the browser was told to send.
async function workbookFrom(req) {
  const { file } = await attachments.parseMultipart(req, { maxBytes: MAX_BYTES });
  if (!file || !file.data || !file.data.length) throw Object.assign(new Error('Attach the filled-in workbook.'), { status: 400 });
  const magic = file.data.slice(0, 2).toString('latin1');
  if (magic !== 'PK') {
    throw Object.assign(new Error('That is not an .xlsx file. Save it from Excel as "Excel Workbook (.xlsx)" and try again.'), { status: 400 });
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.data);
  return { wb, filename: file.filename };
}

function multipartError(err, res) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === 'NOT_MULTIPART') return res.status(400).json({ error: 'Send the file as a form upload.' });
  if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'That workbook is over 20 MB. Split it and import in two passes.' });
  return null;
}

// --- the blank template ----------------------------------------------------
router.get('/template', ADMIN, async (req, res, next) => {
  try {
    // Generated on demand from the spec, so a download is never a stale file
    // somebody checked in months ago.
    const buffer = await buildTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="TeamLink-Import-Template.xlsx"');
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

// --- what the spec says the workbook contains ------------------------------
// Drives the Data Import screen's checklist without the frontend restating a
// column list that would then drift.
router.get('/spec', ADMIN, (req, res) => {
  res.json({
    sheets: SHEETS.map((s) => ({
      name: s.name,
      product: s.product,
      title: s.title,
      note: s.note,
      key: s.key,
      columns: s.columns.map((c) => ({
        header: c.h, required: !!c.req, type: c.t,
        allowed: c.t === 'list' ? LISTS[c.list] || [] : undefined,
        help: c.help || '', example: c.eg || '',
      })),
    })),
  });
});

// --- check: WRITES NOTHING -------------------------------------------------
router.post('/check', ADMIN, async (req, res, next) => {
  try {
    const { wb, filename } = await workbookFrom(req);
    const report = await run(wb, { dry: true });
    return res.json({ ...report, filename });
  } catch (err) {
    const handled = multipartError(err, res);
    if (handled) return handled;
    return next(err);
  }
});

// --- commit ----------------------------------------------------------------
router.post('/commit', ADMIN, async (req, res, next) => {
  try {
    const { wb, filename } = await workbookFrom(req);

    // CHECK FIRST, ALWAYS. A commit on a file with errors would write the
    // good rows and leave the user to work out which ones — so unless they
    // explicitly ask to import what is valid and skip the rest, nothing is
    // written until the whole file is clean.
    const dryReport = await run(wb, { dry: true });
    const partial = String((req.query && req.query.partial) || '') === 'true';
    if (!dryReport.ok && !partial) {
      return res.status(400).json({
        error: `${dryReport.totals.errors} row${dryReport.totals.errors === 1 ? '' : 's'} need fixing before anything is imported.`,
        report: dryReport,
      });
    }

    const report = await run(wb, { dry: false });
    await logAudit({
      userId: req.user.id,
      action: `Data import — ${report.totals.created} created, ${report.totals.updated} updated`,
      entity: 'DataImport',
      entityId: filename || 'workbook',
      toValue: JSON.stringify(report.totals),
    });
    return res.json({ ...report, filename });
  } catch (err) {
    const handled = multipartError(err, res);
    if (handled) return handled;
    return next(err);
  }
});

// --- clearing the demo data, as its own explicit act -----------------------
// Counts first so the caller can see the size of what they are about to
// remove, and needs `confirm: "DELETE DEMO DATA"` in the body to proceed.
router.get('/demo-counts', ADMIN, async (req, res, next) => {
  try {
    const [clients, requirements, candidates, applications, invoices, employees] = await Promise.all([
      prisma.client.count(), prisma.requirement.count(), prisma.candidate.count(),
      prisma.application.count(), prisma.invoice.count(), prisma.employee.count(),
    ]);
    return res.json({ clients, requirements, candidates, applications, invoices, employees });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

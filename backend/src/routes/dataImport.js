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
// AND TWO RULES EVERY HANDLER KEEPS:
//
//   * A BLANK CELL NEVER OVERWRITES. A blank GST % must not replace a
//     client's 18% with nothing; a blank means "I have no value for this",
//     never "clear it".
//   * NOTHING IS SENT. No email, SMS, WhatsApp or one-time code leaves this
//     file. A login created here gets an unguessable password and nobody is
//     told it; a joining imported here raises no invoice.
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
const {
  SHEETS, LISTS, REJECTION_REASONS_BY_SIDE, HR_POLICY_SETTINGS, IMPORTED_ELSEWHERE, REFERENCE_SHEETS,
} = require('../utils/importSpec');
const { buildTemplate } = require('../utils/importTemplate');
const { mappingFor } = require('../utils/identity');
const {
  productRolesForDesignation, loginRoleFor, normalEmail, EMAIL_RE,
} = require('../utils/employeeAdmin');
const {
  ROUND, receiptProblem, invoiceAfterReceipt, deriveInvoiceStatus,
} = require('../utils/accounts');
const { normalizeRecommendation } = require('../utils/atsVocab');
const { hiringTypeOf, INTERNAL_HIRE } = require('../utils/joining');

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

// Who an imported record says did it, where a record has such a field.
const IMPORTED_BY = 'Imported from spreadsheet';

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
    if (v.result !== undefined) return v.result instanceof Date ? v.result : String(v.result);
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

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

// A clock time, HH:MM 24-hour. Excel stores a time as a fraction of a day
// (0.375 = 09:00) and exceljs hands a time-formatted cell over as a Date on
// 1899-12-30, so all three shapes are read. Returns null when it is not one.
function toHHMM(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}`;
  if (typeof v === 'number') {
    if (!(v >= 0 && v < 1)) return null;
    const mins = Math.round(v * 1440);
    return `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`;
  }
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(String(v).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

// Coerce one cell to what the column says it is. Returns { value, error }.
function coerce(col, raw) {
  const v = rawText(raw);
  const empty = v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim());

  if (empty) {
    if (col.req) return { error: 'required, but the cell is empty' };
    return { value: null };
  }

  if (col.t === 'any') return { value: v };

  if (col.t === 'date') {
    let d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number') d = fromSerial(v);
    else {
      const s = String(v).trim();
      // YYYY-MM-DD and DD-MM-YYYY (what the workbook asks for) are both read,
      // with / or - between the parts, because a person filling a sheet by
      // hand types either, and refusing an unambiguous date helps nobody.
      const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
      const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
      if (iso) d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
      else if (dmy) d = new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
      else return { error: `"${s}" is not a date I can read — use DD-MM-YYYY` };
      // 31-02-2026 rolls over to March in JavaScript; refuse it instead.
      const [y, mo, da] = iso ? [+iso[1], +iso[2], +iso[3]] : [+dmy[3], +dmy[2], +dmy[1]];
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
        return { error: `"${s}" is not a real date` };
      }
    }
    if (!d || Number.isNaN(d.getTime())) return { error: `"${v}" is not a valid date` };
    return { value: isoDay(d), date: d };
  }

  if (col.t === 'time') {
    const t = toHHMM(v);
    if (!t) return { error: `"${v instanceof Date ? v.toISOString() : v}" is not a time I can read — use HH:MM, 24-hour (e.g. 09:30)` };
    return { value: t };
  }

  if (col.t === 'number') {
    // Strip what a person types around a number: ₹, commas, spaces, a % sign.
    const s = String(v).replace(/[₹,%\s]/g, '');
    const n = Number(s);
    if (!s || !Number.isFinite(n)) return { error: `"${v}" is not a number` };
    return { value: n };
  }

  if (col.t === 'list') {
    const allowed = LISTS[col.list] || [];
    let s = String(v).trim();
    // The template's ATS Role dropdown also offered HR and EMPLOYEE, which are
    // HRMS roles, not ATS roles — someone who picked them means "no ATS role".
    if (col.list === 'atsRole' && ['hr', 'employee'].includes(s.toLowerCase())) s = 'NONE';
    const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
    if (!hit) return { error: `"${s}" is not allowed here. Use one of: ${allowed.join(', ')}` };
    return { value: hit };
  }

  return { value: String(v instanceof Date ? isoDay(v) : v).trim() };
}

const yes = (v) => ['yes', 'y', 'true'].includes(String(v || '').trim().toLowerCase());
const isDry = (id) => String(id || '').startsWith('dry:');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// The columns of a row that ARE model fields: no underscore-prefixed
// instruction columns, and no blanks — a blank never overwrites.
function pick(data) {
  const out = {};
  Object.entries(data).forEach(([k, v]) => {
    if (k.startsWith('_') || v === null || v === undefined) return;
    out[k] = v;
  });
  return out;
}

// ---------------------------------------------------------------------------
// READING A SHEET into rows of { field: value }, with per-cell errors.
// ---------------------------------------------------------------------------
function headerIndex(ws) {
  const index = {};
  ws.getRow(1).eachCell((cell, colNumber) => {
    const text = String(rawText(cell.value) || '').trim().toLowerCase();
    if (text) index[text] = colNumber;
  });
  return index;
}

function readSheet(ws, spec) {
  const problems = [];
  const rows = [];
  if (!ws) return { rows, problems, missing: true };

  // Map each spec column to the column index whose header matches. Matching
  // on the HEADER TEXT rather than on position is deliberate: somebody will
  // reorder or hide a column, and a positional parser would then write phone
  // numbers into the department field without complaining.
  const index = headerIndex(ws);

  const mapped = [];
  spec.columns.forEach((col) => {
    const at = index[col.h.toLowerCase()];
    if (at) mapped.push({ col, at });
    else if (col.req) problems.push({ row: 1, column: col.h, message: `the required column "${col.h}" is missing from this sheet` });
  });
  if (problems.length) return { rows, problems };

  // The import templates (TeamLink_Import_Templates.xlsx) lead with an
  // "Example?" column; a row marked EXAMPLE there is a sample, never data.
  const exampleAt = index['example?'] || index.example;

  for (let n = 2; n <= ws.rowCount; n += 1) {
    const row = ws.getRow(n);
    if (exampleAt && /^\s*example/i.test(String(rawText(row.getCell(exampleAt).value) || ''))) continue;
    const data = {};
    const rowProblems = [];
    let anyValue = false;

    mapped.forEach(({ col, at }) => {
      const raw = row.getCell(at).value;
      const got = coerce(col, raw);
      const text = rawText(raw);
      const present = text !== '' && text !== null && !(typeof text === 'string' && !text.trim());
      // A label column (the HR Policy "Setting") names the row; on its own it
      // does not make the row one with data in it.
      if (present && !col.label) anyValue = true;
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

// How many rows of data a sheet this route does NOT import carries, so the
// report can say "12 rows waiting — import them from Accounts → Import".
function countDataRows(ws) {
  const index = headerIndex(ws);
  const exampleAt = index['example?'] || index.example;
  let n = 0;
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    if (exampleAt && /^\s*example/i.test(String(rawText(row.getCell(exampleAt).value) || ''))) continue;
    let any = false;
    row.eachCell((cell, colNumber) => {
      if (colNumber === exampleAt) return;
      const t = rawText(cell.value);
      if (t !== '' && t !== null && !(typeof t === 'string' && !t.trim())) any = true;
    });
    if (any) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// THE LOOKUP MAPS. Names and codes the sheets use -> real ids. Seeded from
// the database and then added to as the import creates records, so a
// requirement can name a client created earlier in the same file.
// ---------------------------------------------------------------------------
async function buildIndex() {
  const [
    clients, requirements, candidates, employees, users, departments,
    positions, leaveTypes, shifts, holidays, invoices, bankAccounts, bankRules,
  ] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, clientCode: true } }),
    prisma.requirement.findMany({ select: { id: true, reqCode: true, title: true } }),
    prisma.candidate.findMany({ select: { id: true, email: true, phone: true, externalRef: true } }),
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.position.findMany({ select: { id: true, code: true } }),
    prisma.leaveType.findMany({ select: { id: true, code: true, name: true } }),
    prisma.shiftPattern.findMany({ select: { id: true, name: true } }),
    prisma.holiday.findMany({ select: { id: true, name: true, date: true } }),
    prisma.invoice.findMany({
      select: {
        id: true, invoiceNumber: true, clientId: true, candidateId: true, requirementId: true, amount: true,
        gst: true, tds: true, receivedAmount: true, status: true, paidDate: true, dueDate: true,
        offeredCtc: true, joiningDate: true,
      },
    }),
    prisma.bankAccount.findMany({ select: { id: true, bank: true, name: true, accNo: true } }),
    prisma.bankRule.findMany({ select: { id: true, match: true, vendor: true } }),
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
  const emailOf = new Map(users.map((u) => [u.id, u.email]));
  const ix = {
    client: new Map(clients.map((r) => [ckey(r.name), r.id])),
    clientCode: new Map(clients.filter((r) => r.clientCode).map((r) => [norm(r.clientCode), ckey(r.name)])),
    requirement: new Map(requirements.filter((r) => r.reqCode).map((r) => [norm(r.reqCode), r.id])),
    candidate: new Map(),
    employee: new Map(employees.map((r) => [norm(r.name), r])),
    employeeByCode: new Map(employees.map((r) => [norm(r.employeeCode), r])),
    user: new Map(users.map((r) => [norm(r.name), r.id])),
    userByEmail: new Map(users.map((r) => [norm(r.email), r.id])),
    // Which employee a login email already belongs to — so two rows cannot
    // hand one sign-in to two people.
    loginOwner: new Map(employees.filter((e) => e.userId && emailOf.get(e.userId))
      .map((e) => [norm(emailOf.get(e.userId)), norm(e.employeeCode)])),
    department: new Map(departments.map((r) => [norm(r.name), r.id])),
    position: new Map(positions.map((r) => [norm(r.code), { id: r.id, code: r.code }])),
    leaveType: new Map(leaveTypes.map((r) => [norm(r.code), { id: r.id, name: r.name }])),
    leaveTypeName: new Map(leaveTypes.map((r) => [ckey(r.name), r.name])),
    shift: new Map(shifts.map((r) => [ckey(r.name), r.id])),
    holiday: new Map(holidays.map((r) => [`${r.date}|${ckey(r.name)}`, r.id])),
    invoice: new Map(invoices.filter((r) => r.invoiceNumber).map((r) => [norm(r.invoiceNumber), { ...r }])),
    bankAccounts: bankAccounts.map((r) => ({ ...r })),
    bankRules: bankRules.map((r) => ({ ...r })),
    asset: new Set(),
    appKeys: new Set(),
    pendingManagers: [],
    dryPayments: new Map(),
    companyRows: 0,
    norm,
    ckey,
  };
  candidates.forEach((r) => {
    if (r.email) ix.candidate.set(norm(r.email), r.id);
    if (r.phone) ix.candidate.set(norm(r.phone), r.id);
    if (r.externalRef) ix.candidate.set(norm(`ref:${r.externalRef}`), r.id);
    indexCandidateContact(ix, r, r.id); // normalised phone (last 10) / email — one Candidate Master
  });
  // CLIENT ALIASES. A client merged away on Clients > Duplicate clients keeps
  // its old names as aliases of the surviving client, so a sheet that still
  // uses an old spelling reaches the survivor instead of recreating the copy.
  // The exact old name (punctuation/case ignored) joins ix.client itself, so
  // every consumer of the index sees it; any other spelling of it (Pvt/Ltd,
  // brackets, "(India)") is caught by clientByAlias on the raw name.
  const { fullKey: clientAliasKey } = require('../utils/clientDedupe');
  const aliasRows = await prisma.clientAlias.findMany({ select: { clientId: true, alias: true, aliasKey: true } });
  const aliasByKey = new Map(aliasRows.map((a) => [a.aliasKey, a.clientId]));
  ix.clientAliasKeys = new Set();
  aliasRows.forEach((a) => {
    const k = ckey(a.alias);
    if (k && !ix.client.has(k)) { ix.client.set(k, a.clientId); ix.clientAliasKeys.add(k); }
  });
  ix.clientByAlias = (name) => aliasByKey.get(clientAliasKey(name)) || null;
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
// A dry run may READ; it never writes.
//
// Each handler gets { data, ix, dry, row, actor, note, notStored }:
//   note(msg)            an informational line against this row
//   notStored(col, why)  a value the app has nowhere to keep, reported
// ---------------------------------------------------------------------------
// FIND A CANDIDATE BY WHATEVER THE SHEET USED TO NAME THEM.
//
// The Candidates sheet keys on email, or phone, or — where the source has
// neither — an External Ref. The Applications and Invoices sheets point BACK
// at a candidate with the same value, so a lookup has to try the plain key
// and the reference form. Trying only the plain key failed 10,218
// applications whose candidates had been imported perfectly well moments
// earlier.
function findCandidate(ix, value) {
  const v = ix.norm(value);
  if (!v) return null;
  return ix.candidate.get(v) || ix.candidate.get(ix.norm(`ref:${value}`))
    || contactMatch(ix, { email: value, phone: value }) || null;
}

// ONE CANDIDATE MASTER (ATS review #2 §12, utils/candidateDedupe.js): a row is
// the same person when its phone's last ten digits or its normalised email
// match someone already on file — "+91 98765 43210" is "9876543210". Added
// alongside the exact keys above; it only ever finds MORE existing people.
const { phoneKeys: dupPhoneKeys, emailKey: dupEmailKey } = require('../utils/candidateDedupe');
function indexCandidateContact(ix, r, id) {
  const e = dupEmailKey(r.email);
  if (e && !ix.candidate.has(`mail:${e}`)) ix.candidate.set(`mail:${e}`, id);
  dupPhoneKeys(r.phone).forEach((k) => { if (!ix.candidate.has(`tel:${k}`)) ix.candidate.set(`tel:${k}`, id); });
}
function contactMatch(ix, data) {
  const e = dupEmailKey(data.email);
  if (e && ix.candidate.get(`mail:${e}`)) return ix.candidate.get(`mail:${e}`);
  const hit = dupPhoneKeys(data.phone).map((k) => ix.candidate.get(`tel:${k}`)).find(Boolean);
  return hit || null;
}

function employeeByCode(ix, code) {
  const e = ix.employeeByCode.get(ix.norm(code));
  if (!e) throw new Error(`employee code "${code}" is not on the Employees sheet or in the system`);
  return e;
}

// The application a later sheet (Interviews, Joinings) talks about. In a dry
// run it may be one the Applications sheet is about to create.
async function findApplication(ix, data) {
  const candidateId = findCandidate(ix, data._candidate);
  if (!candidateId) throw new Error(`candidate "${data._candidate}" is not on the Candidates sheet or in the system`);
  const requirementId = ix.requirement.get(ix.norm(data._requirement));
  if (!requirementId) throw new Error(`requirement "${data._requirement}" is not on the Requirements sheet or in the system`);
  const key = `${candidateId}|${requirementId}`;
  let app = null;
  if (!isDry(candidateId) && !isDry(requirementId)) {
    app = await prisma.application.findFirst({
      where: { candidateId, requirementId },
      include: { requirement: { select: { id: true, clientId: true, hiringType: true, internal: true } } },
    });
  }
  if (!app && !ix.appKeys.has(key)) {
    throw new Error(`${data._candidate} has no application on ${data._requirement} — add that pair to the Applications sheet first`);
  }
  return { app, candidateId, requirementId };
}

const HANDLERS = {
  // --- Company: the one company record ------------------------------------
  async company({ data, ix, dry }) {
    ix.companyRows += 1;
    if (ix.companyRows > 1) {
      throw new Error('the Company sheet takes ONE row — the company every invoice prints. Remove the extra rows.');
    }
    const fields = pick(data);
    if (data._policies) fields.policies = JSON.stringify(csv(data._policies));
    if (fields.email) fields.email = normalEmail(fields.email);
    const existing = await prisma.company.findFirst({ select: { id: true } });
    if (dry) return existing ? 'updated' : 'created';
    if (existing) {
      await prisma.company.update({ where: { id: existing.id }, data: fields });
      return 'updated';
    }
    await prisma.company.create({ data: fields });
    return 'created';
  },

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

  async employee({ data, ix, dry, row }) {
    const code = data.employeeCode;
    const existing = ix.employeeByCode.get(ix.norm(code));

    // The designation is what grants the roles, so an unknown one is refused
    // rather than quietly creating somebody with no access at all.
    const mapping = await mappingFor(data.designation);
    if (!mapping) throw new Error(`designation "${data.designation}" is not configured under Administration → Designations`);

    const email = data.email ? normalEmail(data.email) : null;
    const loginEmail = data._loginEmail ? normalEmail(data._loginEmail) : email;
    const wantLogin = data._createLogin === null ? true : yes(data._createLogin);

    // The reporting manager is resolved when the whole sheet has been read,
    // because a manager may be further DOWN the sheet than their reports.
    if (data._reportingManager) {
      if (ix.norm(data._reportingManager) === ix.norm(code)) {
        throw new Error('Reporting Manager Code is this employee\'s own code');
      }
      ix.pendingManagers.push({ row, code, managerCode: data._reportingManager });
    }

    // LAST WORKING DAY is not a column on Employee. It is the last working
    // day of the employee's RESIGNATION record — what the exit checklist and
    // the notice countdown read — so that is where it goes. Only meaningful
    // for somebody who is leaving or has left.
    let exit = null;
    if (data._lastWorkingDay) {
      let status = data.employmentStatus;
      if (!status && existing && !isDry(existing.id)) {
        const cur = await prisma.employee.findUnique({ where: { id: existing.id }, select: { employmentStatus: true } });
        status = cur && cur.employmentStatus;
      }
      if (['Notice Period', 'Exit Process'].includes(status)) exit = { status: 'Notice Period', offboarding: 'Serving Notice' };
      else if (['Relieved', 'Exited'].includes(status)) exit = { status: 'Relieved', offboarding: 'Cleared' };
      else throw new Error(`Last Working Day is only for Notice Period, Exit Process, Relieved or Exited — this employee is ${status || 'Active'}`);
    }

    // Employee columns only — the underscore-prefixed ones are instructions
    // to this handler, not fields on the row.
    const fields = pick(data);
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
      const newLogin = !existing && wantLogin && loginEmail ? `dry:${ix.norm(loginEmail)}` : null;
      const placeholder = { id: `dry:${ix.norm(code)}`, name: fields.name, employeeCode: code, userId: newLogin };
      ix.employeeByCode.set(ix.norm(code), existing || placeholder);
      if (fields.name) ix.employee.set(ix.norm(fields.name), existing || placeholder);
      if (newLogin) {
        if (!ix.userByEmail.has(ix.norm(loginEmail))) ix.userByEmail.set(ix.norm(loginEmail), newLogin);
        ix.loginOwner.set(ix.norm(loginEmail), ix.norm(code));
        if (fields.name && !ix.user.has(ix.norm(fields.name))) ix.user.set(ix.norm(fields.name), newLogin);
      }
      return existing ? 'updated' : 'created';
    }

    let employeeId;
    let action;
    if (existing) {
      await prisma.employee.update({ where: { id: existing.id }, data: fields });
      ix.employee.set(ix.norm(fields.name || ''), existing);
      employeeId = existing.id;
      action = 'updated';
    } else {
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
        ix.loginOwner.set(ix.norm(loginEmail), ix.norm(code));
        ix.user.set(ix.norm(fields.name), user.id);
      }

      const created = await prisma.employee.create({ data: { ...fields, userId } });
      const entry = { id: created.id, name: created.name, employeeCode: code, userId };
      ix.employeeByCode.set(ix.norm(code), entry);
      ix.employee.set(ix.norm(created.name), entry);
      employeeId = created.id;
      action = 'created';
    }

    if (exit) {
      const record = await prisma.employeeRecord.findFirst({
        where: { employeeId, type: 'RESIGNATION', status: { not: 'Withdrawn' } },
        orderBy: { createdAt: 'desc' },
      });
      if (record) {
        await prisma.employeeRecord.update({
          where: { id: record.id },
          data: {
            date: data._lastWorkingDay,
            ...(exit.status === 'Relieved' && record.status !== 'Relieved' ? { status: 'Relieved' } : {}),
          },
        });
      } else {
        // Written directly, NOT through the resignation route: that one
        // starts the approval chain and, on Relieved, raises a Full & Final
        // request. An imported exit is history being recorded, not a
        // resignation being submitted, so neither is started here.
        await prisma.employeeRecord.create({
          data: {
            type: 'RESIGNATION',
            employeeId,
            title: 'Resignation',
            detail: `${IMPORTED_BY} — last working day recorded by data import`,
            date: data._lastWorkingDay,
            status: exit.status,
          },
        });
      }
      await prisma.employee.update({ where: { id: employeeId }, data: { offboardingStatus: exit.offboarding } });
    }
    return action;
  },

  // --- Positions: the seats -------------------------------------------------
  async position({ data, ix, dry }) {
    if (!ix.department.get(ix.norm(data.department))) {
      throw new Error(`department "${data.department}" is not on the Departments sheet or in the system`);
    }
    const fields = pick(data);
    if (data._active !== null) fields.active = yes(data._active);
    const holder = data._holder ? employeeByCode(ix, data._holder) : null;
    const fromDate = data._holderFrom || new Date().toISOString().slice(0, 10);

    const key = ix.norm(data.code);
    const known = ix.position.get(key);
    const exists = known && !isDry(known.id);

    // One seat, one occupant: a new holder moves the old one out on the day
    // they move in — the same rule as Positions → Assign. Refused only when
    // it would end somebody's tenure before it began.
    let current = null;
    if (exists && holder && !isDry(holder.id)) {
      current = await prisma.positionAssignment.findFirst({ where: { positionId: known.id, toDate: null } });
      if (current && current.employeeId !== holder.id && current.fromDate > fromDate) {
        throw new Error(`the seat's current holder has had it since ${current.fromDate}; Holder From Date cannot be earlier than that`);
      }
    }

    if (dry) {
      if (!known) ix.position.set(key, { id: `dry:${key}`, code: data.code });
      return exists ? 'updated' : 'created';
    }

    let positionId;
    if (exists) {
      await prisma.position.update({ where: { id: known.id }, data: fields });
      positionId = known.id;
    } else {
      const created = await prisma.position.create({ data: fields });
      positionId = created.id;
      ix.position.set(key, { id: created.id, code: created.code });
    }

    if (holder && !(current && current.employeeId === holder.id)) {
      const open = current || await prisma.positionAssignment.findFirst({ where: { positionId, toDate: null } });
      if (!open || open.employeeId !== holder.id) {
        if (open) {
          await prisma.positionAssignment.update({
            where: { id: open.id },
            data: { toDate: fromDate, note: open.note || `Handed over to ${holder.name || data._holder}` },
          });
        }
        await prisma.positionAssignment.create({
          data: { positionId, employeeId: holder.id, fromDate, note: IMPORTED_BY },
        });
      }
    }
    return exists ? 'updated' : 'created';
  },

  // --- Users & Logins -------------------------------------------------------
  async login({ data, ix, dry, actor, note }) {
    const email = normalEmail(data.email);
    if (!EMAIL_RE.test(email)) throw new Error(`"${data.email}" is not an email address`);
    const code = ix.norm(data._employee);
    const emp = employeeByCode(ix, data._employee);

    if (data.atsScopeDepartments) {
      const unknown = csv(data.atsScopeDepartments).filter((d) => !ix.department.has(ix.norm(d)));
      if (unknown.length) throw new Error(`ATS Departments: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not on the Departments sheet or in the system`);
    }

    // What the row asks for. Blank leaves the login as it is. A role named
    // with its Access column blank turns the product on — naming somebody a
    // Recruiter in ATS means they use ATS.
    const patch = {};
    if (data.status) patch.status = data.status;
    [['hrms', '_hrmsAccess', 'hrmsRole'], ['ats', '_atsAccess', 'atsRole'], ['accounts', '_accountsAccess', 'accountsRole']]
      .forEach(([product, accessKey, roleKey]) => {
        if (data[roleKey]) patch[roleKey] = data[roleKey];
        if (data[accessKey] !== null && data[accessKey] !== undefined) patch[`${product}Access`] = yes(data[accessKey]);
        else if (data[roleKey] && data[roleKey] !== 'NONE') patch[`${product}Access`] = true;
      });
    if (data.atsScopeDepartments) patch.atsScopeDepartments = csv(data.atsScopeDepartments).join(',');
    if (data.atsScopeTeams) patch.atsScopeTeams = csv(data.atsScopeTeams).join(',');
    if (data.landingWorkspace) patch.landingWorkspace = data.landingWorkspace;

    const byEmail = ix.userByEmail.get(ix.norm(email));
    const owner = ix.loginOwner.get(ix.norm(email));
    if (owner && owner !== code) {
      throw new Error(`${email} is already the login of employee ${owner.toUpperCase()}`);
    }
    let targetId = null;
    if (emp.userId) {
      if (byEmail !== emp.userId) {
        throw new Error(`employee ${data._employee} already signs in with a different email. A login's email is changed on Administration → Users, not by import`);
      }
      targetId = emp.userId;
    } else if (byEmail) {
      if (!isDry(byEmail)) {
        const linked = await prisma.employee.findUnique({ where: { userId: byEmail }, select: { employeeCode: true } });
        if (linked) throw new Error(`${email} is already the login of employee ${linked.employeeCode}`);
      }
      targetId = byEmail;
    }

    // Your own login is not changed by a spreadsheet: one wrong cell would
    // lock the person running the import out of the app mid-import.
    if (targetId && actor && targetId === actor.id) {
      note('this is your own login — left unchanged. Change your own access on Administration → Users.');
      return 'skipped';
    }
    const action = targetId ? 'updated' : 'created';

    if (dry) {
      if (!targetId) {
        const placeholder = `dry:${ix.norm(email)}`;
        ix.userByEmail.set(ix.norm(email), placeholder);
        targetId = placeholder;
      }
      emp.userId = targetId;
      ix.loginOwner.set(ix.norm(email), code);
      return action;
    }

    if (action === 'created') {
      const e = await prisma.employee.findUnique({ where: { id: emp.id } });
      const mapping = await mappingFor(e.designation);
      const derived = mapping ? productRolesForDesignation(mapping) : { hrmsRole: 'EMPLOYEE', atsRole: 'NONE', accountsRole: 'NONE' };
      const roles = {
        hrmsRole: patch.hrmsRole || derived.hrmsRole,
        atsRole: patch.atsRole || derived.atsRole,
        accountsRole: patch.accountsRole || derived.accountsRole,
      };
      const access = {
        hrmsAccess: patch.hrmsAccess !== undefined ? patch.hrmsAccess : (mapping ? !!mapping.hrms : true),
        atsAccess: patch.atsAccess !== undefined ? patch.atsAccess : !!(mapping && mapping.ats),
        accountsAccess: patch.accountsAccess !== undefined ? patch.accountsAccess : !!(mapping && mapping.accounts),
      };
      // The login's primary role, derived exactly as Add Employee derives it
      // — from the roles it actually holds, never a compound name.
      const role = loginRoleFor({
        atsRole: roles.atsRole !== 'NONE' ? roles.atsRole : null,
        hrmsRole: roles.hrmsRole,
        ats: access.atsAccess && roles.atsRole !== 'NONE',
        accounts: access.accountsAccess && roles.accountsRole !== 'NONE',
      });
      const user = await prisma.user.create({
        data: {
          name: e.name,
          email,
          username: email,
          // No password is chosen, shown or sent. The person gets in through
          // the set-password link issued from Administration → Users.
          passwordHash: await unguessableHash(),
          role,
          status: patch.status || 'Active',
          branch: e.branch || e.location || null,
          team: e.team || null,
          atsDepartment: e.department || null,
          ...roles,
          ...access,
          atsScopeDepartments: patch.atsScopeDepartments || e.department || null,
          atsScopeTeams: patch.atsScopeTeams || e.team || null,
          landingWorkspace: patch.landingWorkspace || (mapping && mapping.landing) || null,
        },
      });
      await prisma.employee.update({ where: { id: e.id }, data: { userId: user.id } });
      emp.userId = user.id;
      ix.userByEmail.set(ix.norm(email), user.id);
      ix.user.set(ix.norm(e.name), user.id);
    } else {
      if (Object.keys(patch).length) await prisma.user.update({ where: { id: targetId }, data: patch });
      if (!emp.userId) {
        await prisma.employee.update({ where: { id: emp.id }, data: { userId: targetId } });
        emp.userId = targetId;
      }
    }
    ix.loginOwner.set(ix.norm(email), code);
    return action;
  },

  // --- Shifts / Holidays / Leave ---------------------------------------------
  async shift({ data, ix, dry }) {
    const key = ix.ckey(data.name);
    const id = ix.shift.get(key);
    const exists = id && !isDry(id);
    const fields = pick(data);
    if (data._active !== null) fields.active = yes(data._active);
    if (dry) {
      if (!id) ix.shift.set(key, `dry:${key}`);
      return exists ? 'updated' : 'created';
    }
    if (exists) {
      await prisma.shiftPattern.update({ where: { id }, data: fields });
      return 'updated';
    }
    const created = await prisma.shiftPattern.create({ data: fields });
    ix.shift.set(key, created.id);
    return 'created';
  },

  async holiday({ data, ix, dry }) {
    const key = `${data.date}|${ix.ckey(data.name)}`;
    const id = ix.holiday.get(key);
    const exists = id && !isDry(id);
    const fields = pick(data);
    if (dry) {
      if (!id) ix.holiday.set(key, `dry:${key}`);
      return exists ? 'updated' : 'created';
    }
    if (exists) {
      await prisma.holiday.update({ where: { id }, data: fields });
      return 'updated';
    }
    const created = await prisma.holiday.create({ data: fields });
    ix.holiday.set(key, created.id);
    return 'created';
  },

  async leaveType({ data, ix, dry, note }) {
    if (!Number.isInteger(data.cap) || data.cap < 0) throw new Error('Days Allowed must be a whole number of days');
    const key = ix.norm(data.code);
    const known = ix.leaveType.get(key);
    const exists = known && !isDry(known.id);
    const sameName = ix.leaveTypeName.get(ix.ckey(data.name));
    if (sameName && (!known || ix.ckey(known.name) !== ix.ckey(data.name))) {
      throw new Error(`another leave type is already called "${sameName}"`);
    }
    if (exists && known.name !== data.name) {
      note(`renamed from "${known.name}" — leave balances already held under the old name keep it`);
    }
    const fields = { code: data.code, name: data.name, cap: data.cap, unit: data.unit };
    if (data._carries !== null) fields.carries = yes(data._carries);
    if (data._active !== null) fields.active = yes(data._active);
    if (known) ix.leaveTypeName.delete(ix.ckey(known.name));
    ix.leaveTypeName.set(ix.ckey(data.name), data.name);
    if (dry) {
      ix.leaveType.set(key, { id: known ? known.id : `dry:${key}`, name: data.name });
      return exists ? 'updated' : 'created';
    }
    if (exists) {
      await prisma.leaveType.update({ where: { id: known.id }, data: fields });
      ix.leaveType.set(key, { id: known.id, name: data.name });
      return 'updated';
    }
    const created = await prisma.leaveType.create({ data: fields });
    ix.leaveType.set(key, { id: created.id, name: created.name });
    return 'created';
  },

  async leaveBalance({ data, ix, dry, note }) {
    const emp = employeeByCode(ix, data._employee);
    // By Leave Name, as the sheet asks; a leave CODE is accepted too.
    const type = ix.leaveTypeName.get(ix.ckey(data._type))
      || (ix.leaveType.get(ix.norm(data._type)) || {}).name;
    if (!type) throw new Error(`leave type "${data._type}" is not on the Leave Types sheet or in the system`);
    if (data.total < 0 || (data.taken !== null && data.taken < 0)) throw new Error('days cannot be negative');
    if (data.taken !== null && data.taken > data.total) note(`Taken Days (${data.taken}) is more than Entitled Days (${data.total}) — the balance will show negative`);
    const existing = isDry(emp.id) ? null
      : await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: emp.id, type } } });
    if (dry) return existing ? 'updated' : 'created';
    if (existing) {
      await prisma.leaveBalance.update({
        where: { id: existing.id },
        data: { total: data.total, ...(data.taken !== null ? { taken: data.taken } : {}) },
      });
      return 'updated';
    }
    await prisma.leaveBalance.create({ data: { employeeId: emp.id, type, total: data.total, taken: data.taken || 0 } });
    return 'created';
  },

  // --- Assets ---------------------------------------------------------------
  async asset({ data, ix, dry, actor }) {
    const key = ix.norm(data.assetCode);
    if (ix.asset.has(key)) throw new Error(`asset code ${data.assetCode} appears twice on this sheet`);
    ix.asset.add(key);
    const holder = data._assignedTo ? employeeByCode(ix, data._assignedTo) : null;
    const existing = await prisma.asset.findUnique({ where: { assetCode: data.assetCode } });

    const fields = pick(data);
    let status = data.status;
    if (holder && !status) status = 'Assigned';
    if (status === 'Available' && holder) throw new Error('an Available asset cannot also be Assigned To somebody — make it Assigned, or clear Assigned To Code');
    if (status === 'Assigned' && !holder && !(existing && existing.assignedToId)) {
      throw new Error('Status is Assigned — give the Assigned To Code');
    }
    if (status) fields.status = status;
    if (holder) fields.assignedToId = holder.id;
    else if (status === 'Available') fields.assignedToId = null;

    if (dry) return existing ? 'updated' : 'created';

    const history = (() => { try { return JSON.parse((existing && existing.history) || '[]'); } catch { return []; } })();
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const by = (actor && actor.name) || IMPORTED_BY;
    if (!existing) history.unshift({ at: stamp, by, text: IMPORTED_BY });
    if (holder && (!existing || existing.assignedToId !== holder.id)) {
      history.unshift({ at: stamp, by, text: `Assigned to ${holder.name || data._assignedTo} (data import)` });
    }
    fields.history = JSON.stringify(history);
    if (existing) {
      await prisma.asset.update({ where: { id: existing.id }, data: fields });
      return 'updated';
    }
    await prisma.asset.create({ data: fields });
    return 'created';
  },

  // --- Clients ----------------------------------------------------------------
  async client({ data, ix, dry }) {
    // ckey, NOT norm. The index is built with ckey (punctuation and case
    // ignored), so looking up with norm never matched and every client on the
    // sheet was reported as new — including the 124 that already existed.
    const key = ix.ckey(data.name);
    const aliasId = ix.client.has(key)
      ? (ix.clientAliasKeys.has(key) ? ix.client.get(key) : null)
      : ix.clientByAlias(data.name);
    const id = aliasId || ix.client.get(key);
    const exists = id && !isDry(id);

    // BLANKS NEVER OVERWRITE. Passing the row straight through used to write
    // null over a client's GST % whenever the cell was empty — and on a NEW
    // client, over the schema's own 18% default, so its invoices came out at
    // 0% GST.
    const fields = pick(data);
    // A merged-away name updates the surviving client but never renames it back.
    if (aliasId) delete fields.name;

    if (fields.clientCode) {
      const codeKey = ix.norm(fields.clientCode);
      const holder = ix.clientCode.get(codeKey);
      if (holder && holder !== key && !(aliasId && ix.client.get(holder) === aliasId)) throw new Error(`Client Code ${fields.clientCode} already belongs to another client`);
      ix.clientCode.set(codeKey, key);
    }

    if (dry) {
      if (!id) ix.client.set(key, `dry:${key}`);
      return exists ? 'updated' : 'created';
    }
    if (fields.agreementStatus === 'ACTIVE') {
      const cur = exists ? await prisma.client.findUnique({ where: { id }, select: { agreementActivatedAt: true } }) : null;
      if (!cur || !cur.agreementActivatedAt) fields.agreementActivatedAt = new Date();
    }
    if (exists) {
      await prisma.client.update({ where: { id }, data: fields });
      return 'updated';
    }
    const created = await prisma.client.create({ data: fields });
    ix.client.set(key, created.id);
    return 'created';
  },

  async requirement({ data, ix, dry }) {
    const clientId = ix.client.get(ix.ckey(data._client)) || ix.clientByAlias(data._client);
    if (!clientId) throw new Error(`client "${data._client}" is not on the Clients sheet or in the system`);

    const fields = pick(data);
    fields.clientId = clientId;

    // ASSIGNMENT IS BY NAME ON THE SHEET AND BY USER ID IN THE DATABASE, and
    // those two do not always meet. `recruiterId` is a foreign key to a
    // LOGIN, but a person imported from a spreadsheet may be an employee
    // record with no login yet — that is the normal state of somebody whose
    // name appears in four years of trackers and who has never been given an
    // account.
    //
    // REFUSING THE ROW WAS WRONG. It failed 1,459 requirements, and because
    // their codes then never registered, every application pointing at them
    // failed too — 12,619 of them. One missing login took out the whole file.
    //
    // So: link the login when there is one, and when there is not, keep the
    // NAME against the requirement instead of losing it. Creating a login to
    // satisfy a foreign key would be worse — an account nobody asked for,
    // with an address nobody can receive mail at.
    const unlinked = [];
    if (data._recruiter) {
      const uid = ix.user.get(ix.norm(data._recruiter));
      if (uid && !isDry(uid)) fields.recruiterId = uid;
      else if (uid) fields.recruiterId = undefined; // a dry run's placeholder
      else unlinked.push(`Recruiter: ${data._recruiter} (no login yet)`);
    }
    if (data._bde) {
      const uid = ix.user.get(ix.norm(data._bde));
      if (uid && !isDry(uid)) fields.bdeId = uid;
      else if (uid) fields.bdeId = undefined;
      else {
        // accountManager is free text and means exactly this — who owns the
        // account — so an unlinked BDE has a proper home.
        if (!fields.accountManager) fields.accountManager = data._bde;
        unlinked.push(`BDE: ${data._bde} (no login yet)`);
      }
    }
    // More recruiters on the same job: user ids, comma separated, in the
    // column scope.js already filters on.
    if (data._moreRecruiters) {
      const ids = [];
      csv(data._moreRecruiters).forEach((name) => {
        const uid = ix.user.get(ix.norm(name));
        if (uid && !isDry(uid)) ids.push(uid);
        else if (!uid) unlinked.push(`Additional recruiter: ${name} (no login yet)`);
      });
      if (ids.length) fields.recruiterIds = [...new Set(ids)].join(',');
    }
    if (data._seat) {
      const seat = ix.position.get(ix.norm(data._seat));
      if (!seat) throw new Error(`seat "${data._seat}" is not on the Positions sheet or in the system`);
      if (!isDry(seat.id)) fields.positionId = seat.id;
      fields.positionCode = seat.code;
    }
    if (unlinked.length) {
      const note = `Named on the source sheet but not linked to a login — ${unlinked.join('; ')}. Give them a login on Administration → Users and re-import to link the assignment.`;
      fields.jobDescription = fields.jobDescription ? `${fields.jobDescription}\n${note}` : note;
    }
    if (data.specialisation) {
      const deptId = ix.department.get(ix.norm(data.department));
      if (deptId && !dry) {
        // MATCHED IGNORING CASE AND PUNCTUATION, like a client name. An
        // exact match failed 156 requirements whose specialisation was
        // spelled "EEE" here and "E.E.E" on the specialisations sheet —
        // the same specialisation, and every application pointing at those
        // requirements failed with them.
        const all = await prisma.specialisation.findMany({ where: { departmentId: deptId }, select: { name: true } });
        const want = ix.ckey(data.specialisation);
        const known = all.find((s) => ix.ckey(s.name) === want);
        if (!known) throw new Error(`"${data.specialisation}" is not a specialisation of ${data.department} — add it to the Specialisations sheet`);
        // Store the registered spelling, so the requirement and the
        // specialisation list always read the same on screen.
        fields.specialisation = known.name;
      }
    }

    const key = ix.norm(data.reqCode);
    const id = ix.requirement.get(key);
    if (dry) {
      if (!id) ix.requirement.set(key, `dry:${key}`);
      return id && !isDry(id) ? 'updated' : 'created';
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
    // EMAIL, THEN PHONE, THEN EXTERNAL REF — the three ways a source can
    // say which person a row is about. The third exists because several
    // real sheets carry no contact column at all, and refusing those rows
    // discarded 12,033 interview records.
    if (!data.email && !data.phone && !data.externalRef) {
      throw new Error('give an Email, a Phone or an External Ref — one of the three is needed to tell candidates apart');
    }
    const fields = pick(data); // a blank never overwrites
    const key = ix.norm(data.email || data.phone || `ref:${data.externalRef}`);
    const id = ix.candidate.get(key) || contactMatch(ix, data);
    if (dry) {
      if (!id) { ix.candidate.set(key, `dry:${key}`); indexCandidateContact(ix, data, `dry:${key}`); }
      return id && !isDry(id) ? 'updated' : 'created';
    }
    if (id) {
      await prisma.candidate.update({ where: { id }, data: fields });
      return 'updated';
    }
    const row = await prisma.candidate.create({ data: fields });
    if (data.email) ix.candidate.set(ix.norm(data.email), row.id);
    if (data.phone) ix.candidate.set(ix.norm(data.phone), row.id);
    if (data.externalRef) ix.candidate.set(ix.norm(`ref:${data.externalRef}`), row.id);
    indexCandidateContact(ix, data, row.id);
    return 'created';
  },

  async application({ data, ix, dry, note }) {
    const candidateId = findCandidate(ix, data._candidate);
    if (!candidateId) throw new Error(`candidate "${data._candidate}" is not on the Candidates sheet or in the system`);
    const requirementId = ix.requirement.get(ix.norm(data._requirement));
    if (!requirementId) throw new Error(`requirement "${data._requirement}" is not on the Requirements sheet or in the system`);

    // A REJECTION SAYS WHY AND WHOSE DECISION IT WAS — the same two things the
    // Reject dialog asks (routes/applications.js applyStageMove). Side is
    // Client / Internal ("TeamLink") / Candidate; the reason is a category
    // for that side, a detailed reason, or both.
    const side = data._rejectedBy === 'TeamLink' ? 'Internal' : data._rejectedBy;
    let category = data._rejectionCategory || null;
    if (data.stage === 'REJECTED') {
      if (!side) throw new Error('Stage is REJECTED, so Rejected By is required (Client, TeamLink or Candidate)');
      if (!category && !data.rejectionReason) {
        throw new Error('Stage is REJECTED, so give a Rejection Category or a Rejection Reason');
      }
      if (category) {
        const allowed = REJECTION_REASONS_BY_SIDE[side] || [];
        const hit = allowed.find((a) => a.toLowerCase() === category.toLowerCase());
        if (!hit) throw new Error(`"${category}" is not a ${data._rejectedBy} rejection category. Use one of: ${allowed.join(', ')}`);
        category = hit;
      }
    } else if (data.stage !== 'HOLD' && (side || category || data.rejectionReason)) {
      note(`Rejected By / Rejection Category / Rejection Reason ignored — the stage is ${data.stage}, not REJECTED or HOLD`);
    }

    const fields = pick(data);
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
    // STAGE DATE is when they reached this stage. The pipeline's due dates and
    // ageing count from the application's last movement (updatedAt), so that
    // is what it sets.
    const stageDate = data._stageDate ? new Date(`${data._stageDate}T00:00:00.000Z`) : null;
    if (stageDate) fields.updatedAt = stageDate;

    const key = `${candidateId}|${requirementId}`;
    const existing = isDry(candidateId) || isDry(requirementId) ? null
      : await prisma.application.findFirst({ where: { candidateId, requirementId } });
    if (dry) {
      const seen = ix.appKeys.has(key);
      ix.appKeys.add(key);
      return existing || seen ? 'updated' : 'created';
    }
    ix.appKeys.add(key);

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
        orderBy: { createdAt: 'desc' },
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
            reasonCategory: category,
            reasonDetail: reason,
            // Imported, so there is no actor to name and pretending otherwise
            // would put a real person's name against a decision they may not
            // have made. `actorName` says where it came from instead; the
            // SIDE is the sheet's own answer.
            actorName: IMPORTED_BY,
            actorSide: side || 'Internal',
            ...(stageDate ? { createdAt: stageDate } : {}),
          },
        });
      } else if (already.actorName === IMPORTED_BY) {
        // A re-import corrects an imported record; blanks leave it alone.
        const fix = {};
        if (side) fix.actorSide = side;
        if (category) fix.reasonCategory = category;
        if (reason) fix.reasonDetail = reason;
        if (stageDate) fix.createdAt = stageDate;
        if (Object.keys(fix).length) await prisma.applicationStageEvent.update({ where: { id: already.id }, data: fix });
      }
    }
    return existing ? 'updated' : 'created';
  },

  // --- Interviews -----------------------------------------------------------
  async interview({ data, ix, dry, note }) {
    const { app } = await findApplication(ix, data);
    const round = data.interviewRound === null ? 1 : data.interviewRound;
    if (!Number.isInteger(round) || round < 1) throw new Error('Interview Round must be 1, 2, 3 …');

    const scores = {};
    [['_technical', 'technical', 'Technical'], ['_communication', 'communication', 'Communication'],
      ['_experience', 'experience', 'Experience'], ['_roleFit', 'roleFit', 'Role Fit']].forEach(([k, f, label]) => {
      if (data[k] === null) return;
      if (!Number.isInteger(data[k]) || data[k] < 1 || data[k] > 5) throw new Error(`${label} must be a score from 1 to 5`);
      scores[f] = data[k];
    });
    const kind = data._feedbackBy;
    if (!kind && (Object.keys(scores).length || data._comments)) {
      throw new Error('scores or comments were given — say whose feedback it is in Feedback By (Internal or Client)');
    }
    const recommendation = kind ? normalizeRecommendation(data.interviewResult) : null;
    if (kind && !recommendation) throw new Error('Feedback By is filled — give the Interview Result the feedback came to');

    if (dry || !app) {
      const current = app && (app.interviewRound || 1) === round && (app.interviewAt || app.interviewStatus);
      return current ? 'updated' : 'created';
    }

    // THE CALENDAR SHOWS ONE INTERVIEW PER APPLICATION — its latest round.
    // A row for an EARLIER round than the one already recorded is kept in the
    // interview history, not written over the later one.
    const latest = !app.interviewAt || round >= (app.interviewRound || 1);
    const slot = `${data._date}${data._time ? ` ${data._time}` : ''}`;
    let action = app.interviewAt && (app.interviewRound || 1) === round ? 'updated' : 'created';
    if (latest) {
      const fields = pick(data);
      fields.interviewRound = round;
      // With a time, local clock time; a date alone is kept as that date.
      fields.interviewAt = data._time ? new Date(`${data._date}T${data._time}:00`) : new Date(`${data._date}T00:00:00.000Z`);
      if (data._comments) fields.interviewFeedback = data._comments;
      fields.interviewCode = app.interviewCode || `INT-${app.id.slice(-6).toUpperCase()}`;
      if (!fields.interviewType && !app.interviewType) {
        fields.interviewType = app.requirement && app.requirement.internal ? 'Internal Panel' : 'Client Interview';
      }
      if (!app.interviewCreatedBy) fields.interviewCreatedBy = IMPORTED_BY;
      // Interview detail is not a stage movement: the pipeline's ageing
      // clock (updatedAt) is left where the Applications sheet put it.
      fields.updatedAt = app.updatedAt;
      await prisma.application.update({ where: { id: app.id }, data: fields });
    } else {
      note(`round ${round} is earlier than round ${app.interviewRound} already on this application — kept in the interview history only`);
    }

    const status = data.interviewStatus || 'SCHEDULED';
    const reasonText = `Round ${round} — ${IMPORTED_BY}`;
    const seen = await prisma.interviewEvent.findFirst({
      where: { applicationId: app.id, status, toSlot: slot, reason: reasonText },
    });
    if (!seen) {
      await prisma.interviewEvent.create({
        data: { applicationId: app.id, status, toSlot: slot, reason: reasonText, by: IMPORTED_BY },
      });
    } else if (!latest) {
      action = 'updated';
    }

    if (kind) {
      const prior = await prisma.interviewFeedback.findUnique({ where: { applicationId_kind: { applicationId: app.id, kind } } });
      const body = {
        ...scores,
        recommendation,
        ...(data._comments ? { overall: data._comments } : {}),
      };
      if (prior) {
        await prisma.interviewFeedback.update({ where: { id: prior.id }, data: body });
      } else {
        await prisma.interviewFeedback.create({
          data: {
            applicationId: app.id,
            kind,
            overall: data._comments || '',
            submittedBy: IMPORTED_BY,
            clientId: kind === 'Client' && app.requirement ? app.requirement.clientId : null,
            ...body,
          },
        });
      }
    }
    return action;
  },

  // --- Invoices -------------------------------------------------------------
  async invoice({ data, ix, dry, note }) {
    const clientId = ix.client.get(ix.ckey(data._client)) || ix.clientByAlias(data._client);
    if (!clientId) throw new Error(`client "${data._client}" is not on the Clients sheet or in the system`);

    const fields = pick(data);
    fields.clientId = clientId;
    if (data._candidate) {
      const cid = findCandidate(ix, data._candidate);
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

    const key = ix.norm(data.invoiceNumber);
    const known = ix.invoice.get(key);
    const exists = known && !isDry(known.id);

    // RECEIPTS ALREADY RECORDED ARE A FLOOR. Re-importing a sheet whose
    // Received Amount still says 0 must not un-receive money the Payments
    // sheet (or Record Payment) has since put against this invoice.
    if (exists) {
      const paid = await prisma.invoicePayment.aggregate({ where: { invoiceId: known.id }, _sum: { amount: true } });
      const itemised = ROUND(paid._sum.amount || 0);
      const received = fields.receivedAmount != null ? fields.receivedAmount : Number(known.receivedAmount || 0);
      if (itemised > received + 0.005) {
        fields.receivedAmount = itemised;
        if (fields.status !== 'Cancelled' && known.status !== 'Cancelled') {
          fields.status = deriveInvoiceStatus({ ...known, ...fields });
        }
        note(`Received Amount kept at ₹${itemised.toLocaleString('en-IN')} — the receipts already recorded against this invoice`);
      }
    }
    if (dry) {
      // Registered with its figures, so the Joinings and Payments sheets can
      // be checked against the invoice as it WILL be.
      ix.invoice.set(key, { ...(known || { id: `dry:${key}`, receivedAmount: 0, gst: 0, tds: 0, status: 'Pending' }), ...fields });
      return exists ? 'updated' : 'created';
    }
    const saved = exists
      ? await prisma.invoice.update({ where: { id: known.id }, data: fields })
      : await prisma.invoice.create({ data: fields });
    ix.invoice.set(key, { ...saved });
    return exists ? 'updated' : 'created';
  },

  // --- Joinings: records what happened — never raises an invoice ------------
  async joining({ data, ix, dry, note }) {
    const { app, candidateId, requirementId } = await findApplication(ix, data);
    const requirement = app ? app.requirement
      : (!isDry(requirementId) ? await prisma.requirement.findUnique({
        where: { id: requirementId }, select: { id: true, clientId: true, hiringType: true, internal: true },
      }) : null);

    const storedType = hiringTypeOf(app || {}, requirement);
    const hiringType = data.hiringType || storedType;
    // Once an offer is out the downstream (invoice vs HRMS employee) is
    // committed, so the hiring type is frozen — Offers → Hiring Type's rule.
    if (app && data.hiringType && data.hiringType !== storedType
      && ['OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) {
      throw new Error(`Hiring Type is fixed once an offer has been released — this application is ${storedType}`);
    }
    const internal = hiringType === INTERNAL_HIRE;

    const fields = pick(data);
    fields.hiringType = hiringType;
    const joiningDate = data.joiningDate || (app && app.joiningDate) || null;
    if (data.joiningStatus === 'Joined') {
      if (!joiningDate) throw new Error('Joining Status is Joined — give the Joining Date');
      if (!app || !app.joinedAt) fields.joinedAt = new Date(`${joiningDate}T00:00:00.000Z`);
    }
    if (data.offerStatus === 'Offer Accepted' && !(app && app.offerAcceptedAt)) {
      fields.offerAcceptedAt = data.offerDate ? new Date(`${data.offerDate}T00:00:00.000Z`) : new Date();
    }

    // THE INVOICE IS LINKED, NEVER RAISED. onApplicationJoined() is not called:
    // it would raise the placement invoice, and the invoice for a joining
    // that already happened is on the Invoices sheet (or already in the app).
    let invoice = null;
    if (data._invoice) {
      invoice = ix.invoice.get(ix.norm(data._invoice));
      if (!invoice) throw new Error(`invoice "${data._invoice}" is not on the Invoices sheet or in the system`);
      if (internal) throw new Error('a TeamLink internal hire is never invoiced — clear Invoice Number or change Hiring Type');
      if (requirement && invoice.clientId && !isDry(invoice.clientId) && invoice.clientId !== requirement.clientId) {
        throw new Error(`invoice ${data._invoice} is for a different client than requirement ${data._requirement}`);
      }
      if (invoice.candidateId && invoice.candidateId !== candidateId) throw new Error(`invoice ${data._invoice} is for a different candidate`);
      if (invoice.requirementId && invoice.requirementId !== requirementId) throw new Error(`invoice ${data._invoice} is for a different requirement`);
      fields.billingStatus = 'Invoiced';
    } else if (internal) {
      fields.billingStatus = 'Not Applicable';
    } else if (!(app && app.billingStatus === 'Invoiced')) {
      const raised = !isDry(candidateId) && !isDry(requirementId)
        ? await prisma.invoice.findFirst({ where: { candidateId, requirementId }, select: { invoiceNumber: true } })
        : null;
      fields.billingStatus = raised ? 'Invoiced' : 'Billing Pending';
      if (raised) note(`linked to invoice ${raised.invoiceNumber || '(unnumbered)'}, already raised for this candidate and requirement`);
    }
    if (data.joiningStatus === 'Joined' && app && !['JOINED', 'HIRED'].includes(app.stage)) {
      note(`Joining Status is Joined but the pipeline stage is ${app.stage} — set Stage to JOINED on the Applications sheet if they joined`);
    }

    if (dry || !app) return app && (app.joiningStatus || app.offerStatus) ? 'updated' : 'created';

    const action = app.joiningStatus || app.offerStatus ? 'updated' : 'created';
    // Joining detail is not a stage movement either — ageing stays put.
    fields.updatedAt = app.updatedAt;
    await prisma.application.update({ where: { id: app.id }, data: fields });
    if (invoice && !isDry(invoice.id)) {
      const link = {};
      if (!invoice.candidateId) link.candidateId = candidateId;
      if (!invoice.requirementId) link.requirementId = requirementId;
      if (invoice.offeredCtc == null && data.offeredCtc != null) link.offeredCtc = data.offeredCtc;
      if (!invoice.joiningDate && joiningDate) link.joiningDate = joiningDate;
      if (Object.keys(link).length) {
        await prisma.invoice.update({ where: { id: invoice.id }, data: link });
        Object.assign(invoice, link);
      }
    }
    return action;
  },

  // --- Payments: each receipt settles the invoice as Record Payment does ----
  async payment({ data, ix, dry, actor }) {
    const key = ix.norm(data._invoice);
    const inv = ix.invoice.get(key);
    if (!inv) throw new Error(`invoice "${data._invoice}" is not on the Invoices sheet or in the system`);
    const amount = ROUND(data.amount);
    if (!(amount > 0)) throw new Error('Amount Received must be more than zero');
    const reference = data.reference || null;

    const recorded = isDry(inv.id) ? [] : await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
    const payments = recorded.concat(ix.dryPayments.get(key) || []);
    const dup = payments.find((p) => p.date === data.date && Math.abs(Number(p.amount) - amount) < 0.005
      && String(p.reference || '') === String(reference || ''));
    if (dup) {
      if (!dry && dup.id) {
        const fix = {};
        if (data.method) fix.method = data.method;
        if (data.notes) fix.notes = data.notes;
        if (Object.keys(fix).length) await prisma.invoicePayment.update({ where: { id: dup.id }, data: fix });
      }
      return 'updated';
    }

    // ITEMISED, NEVER COUNTED TWICE. The Invoices sheet may already say how
    // much came in (Received Amount); a receipt listed here that is already
    // inside that figure only itemises it. Only the part the invoice does not
    // yet account for moves it — and that part goes through the same rules as
    // Record Payment (utils/accounts.js receiptProblem / invoiceAfterReceipt).
    const itemised = ROUND(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
    const increment = ROUND(Math.max(0, itemised + amount - Number(inv.receivedAmount || 0)));
    if (increment > 0) {
      const problem = receiptProblem(inv, increment);
      if (problem) throw new Error(problem);
    } else if (inv.status === 'Cancelled') {
      throw new Error('This invoice is cancelled');
    }
    const after = increment > 0 ? invoiceAfterReceipt(inv, increment, data.date) : null;

    if (dry) {
      ix.dryPayments.set(key, (ix.dryPayments.get(key) || []).concat([{ date: data.date, amount, reference }]));
      if (after) Object.assign(inv, after);
      return 'created';
    }
    await prisma.invoicePayment.create({
      data: {
        invoiceId: inv.id,
        date: data.date,
        amount,
        method: data.method || 'Bank Transfer',
        reference,
        notes: data.notes || null,
        recordedBy: (actor && (actor.name || actor.email)) || IMPORTED_BY,
      },
    });
    if (after) {
      await prisma.invoice.update({ where: { id: inv.id }, data: after });
      Object.assign(inv, after);
    }
    return 'created';
  },

  // --- Bank accounts ------------------------------------------------------------
  async bankAccount({ data, ix, dry, note }) {
    const digits = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    let found = null;
    if (data.accNo) {
      found = ix.bankAccounts.find((a) => a.accNo && digits(a.accNo) === digits(data.accNo));
      if (!found) {
        // THE ACCOUNT THE APP SEEDED FOR ITSELF — a bank name and no number —
        // is completed rather than left beside a duplicate of itself.
        const bare = ix.bankAccounts.filter((a) => !a.accNo && ix.ckey(a.bank) === ix.ckey(data.bank));
        if (bare.length === 1) {
          [found] = bare;
          note(`completes the existing "${found.bank}" account, which had no account number yet`);
        }
      }
    } else {
      const same = ix.bankAccounts.filter((a) => ix.ckey(a.bank) === ix.ckey(data.bank)
        && (!data.name || ix.ckey(a.name) === ix.ckey(data.name)));
      if (same.length > 1) throw new Error(`there are ${same.length} ${data.bank} accounts — give the Account Number to say which one`);
      [found] = same;
    }
    const fields = pick(data);
    if (data._active !== null) fields.active = yes(data._active);
    const exists = found && !isDry(found.id);
    if (dry) {
      if (found) Object.assign(found, { accNo: data.accNo || found.accNo, name: data.name || found.name });
      else ix.bankAccounts.push({ id: 'dry:bank', bank: data.bank, name: data.name || null, accNo: data.accNo || null });
      return exists ? 'updated' : 'created';
    }
    if (exists) {
      await prisma.bankAccount.update({ where: { id: found.id }, data: fields });
      Object.assign(found, fields);
      return 'updated';
    }
    const created = await prisma.bankAccount.create({ data: fields });
    ix.bankAccounts.push({ id: created.id, bank: created.bank, name: created.name, accNo: created.accNo });
    return 'created';
  },

  // --- Vendors: kept as a Bank & Reconciliation rule --------------------------
  async vendor({ data, ix, dry, note }) {
    const key = ix.ckey(data.name);
    const found = ix.bankRules.find((r) => ix.ckey(r.vendor) === key || ix.ckey(r.match) === key);
    if (!data.category && !found) {
      note('no Default Category — the app has no vendor list, so there is nothing it can keep for this vendor yet');
      return 'skipped';
    }
    const fields = { vendor: data.name };
    if (data.category) fields.category = data.category;
    if (data.gstRate !== null) fields.gstRate = data.gstRate;
    const exists = found && !isDry(found.id);
    if (dry) {
      if (!found) ix.bankRules.push({ id: `dry:${key}`, match: data.name, vendor: data.name });
      return exists ? 'updated' : 'created';
    }
    if (exists) {
      await prisma.bankRule.update({ where: { id: found.id }, data: fields });
      return 'updated';
    }
    const created = await prisma.bankRule.create({
      data: { match: data.name, kind: 'expense', ...fields },
    });
    ix.bankRules.push({ id: created.id, match: created.match, vendor: created.vendor });
    return 'created';
  },

  // --- HR Policy: key/value onto HrConfig -------------------------------------
  async hrPolicy({ data, ix, dry, notStored }) {
    const def = HR_POLICY_SETTINGS.find((s) => ix.ckey(s.label) === ix.ckey(data.setting));
    if (!def) throw new Error(`"${data.setting}" is not a setting this sheet knows — keep the Setting column exactly as it came`);
    if (data.value === null || data.value === undefined) return 'skipped';
    if (!def.field) {
      notStored(def.label, def.why);
      return 'skipped';
    }
    const raw = data.value;
    let value;
    const num = Number(String(raw instanceof Date ? '' : raw).replace(/[%\s]/g, ''));
    switch (def.kind) {
      case 'time':
        value = toHHMM(raw);
        if (!value) throw new Error(`"${raw}" is not a time — use HH:MM, 24-hour (e.g. 09:30)`);
        break;
      case 'int':
        if (!Number.isInteger(num) || num < 0) throw new Error(`"${raw}" is not a whole number`);
        value = num;
        break;
      case 'pct':
        if (!Number.isInteger(num) || num < 0 || num > 100) throw new Error(`"${raw}" is not a percentage from 0 to 100`);
        value = num;
        break;
      case 'float':
        if (!Number.isFinite(num) || num <= 0 || num > 24) throw new Error(`"${raw}" is not a number of hours`);
        value = num;
        break;
      case 'bool': {
        const s = String(raw).trim().toLowerCase();
        if (!['yes', 'no', 'true', 'false', 'y', 'n'].includes(s)) throw new Error(`"${raw}" — answer Yes or No`);
        value = ['yes', 'true', 'y'].includes(s);
        break;
      }
      default:
        value = String(raw).trim();
    }
    if (dry) return 'updated';
    let cfg = await prisma.hrConfig.findFirst();
    if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
    await prisma.hrConfig.update({ where: { id: cfg.id }, data: { [def.field]: value } });
    return 'updated';
  },
};

// Work that can only be done once a whole sheet has been read. Returns the
// problems it found, each against its row.
const FINISH = {
  // A reporting manager may be further down the Employees sheet than the
  // people who report to them.
  async employee({ ix, dry }) {
    const errors = [];
    for (const p of ix.pendingManagers) {
      const mgr = ix.employeeByCode.get(ix.norm(p.managerCode));
      if (!mgr) {
        errors.push({ row: p.row, column: 'Reporting Manager Code', message: `"${p.managerCode}" is not an Employee Code on the Employees sheet or in the system` });
        continue;
      }
      const me = ix.employeeByCode.get(ix.norm(p.code));
      if (dry || !me || isDry(me.id) || isDry(mgr.id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await prisma.employee.update({ where: { id: me.id }, data: { reportingManagerId: mgr.id } });
    }
    ix.pendingManagers = [];
    return errors;
  },
};

// ---------------------------------------------------------------------------
// THE RUN. Same code path for a dry run and a real one, which is the only way
// the report can be trusted to describe what the import will actually do.
// ---------------------------------------------------------------------------
async function run(workbook, { dry, actor = null }) {
  const ix = await buildIndex();
  const report = {
    dry, sheets: [], totals: { created: 0, updated: 0, skipped: 0, errors: 0, rows: 0 }, ok: true, referenceSheets: [],
  };

  for (const spec of SHEETS) {
    const ws = workbook.getWorksheet(spec.name);
    const result = {
      sheet: spec.name, product: spec.product, created: 0, updated: 0, skippedRows: 0, errors: [], rows: 0, notes: [], notStored: [],
    };
    if (!ws) {
      result.skipped = 'this sheet is not in the uploaded file';
      report.sheets.push(result);
      continue;
    }

    const { rows, problems } = readSheet(ws, spec);
    problems.forEach((p) => result.errors.push(p));
    result.rows = rows.length;

    // Values the app has nowhere to keep — counted per column, never dropped
    // without a word.
    const notStoredMap = new Map();
    const notStored = (column, why) => {
      const cur = notStoredMap.get(column) || { column, rows: 0, why };
      cur.rows += 1;
      notStoredMap.set(column, cur);
    };
    const unstorable = spec.columns.filter((col) => col.store === false);

    for (const { row, data } of rows) {
      unstorable.forEach((col) => { if (data[col.f] !== null && data[col.f] !== undefined) notStored(col.h, col.why); });
      const note = (message) => result.notes.push({ row, message });
      try {
        // eslint-disable-next-line no-await-in-loop
        const action = await HANDLERS[spec.model]({
          data, ix, dry, row, actor, note, notStored,
        });
        if (action === 'created') result.created += 1;
        else if (action === 'updated') result.updated += 1;
        else result.skippedRows += 1;
      } catch (e) {
        result.errors.push({ row, column: '', message: e.message });
      }
    }
    if (FINISH[spec.model]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        (await FINISH[spec.model]({ ix, dry })).forEach((p) => result.errors.push(p));
      } catch (e) {
        result.errors.push({ row: 0, column: '', message: e.message });
      }
    }
    result.notStored = [...notStoredMap.values()];

    report.totals.created += result.created;
    report.totals.updated += result.updated;
    report.totals.skipped += result.skippedRows;
    report.totals.errors += result.errors.length;
    report.totals.rows += result.rows;
    if (result.errors.length) report.ok = false;
    report.sheets.push(result);
  }

  // THE REST OF THE WORKBOOK. A sheet this route does not import is named in
  // the report with where it goes, never silently passed over.
  const known = new Set(SHEETS.map((s) => s.name));
  workbook.eachSheet((ws) => {
    if (known.has(ws.name)) return;
    if (IMPORTED_ELSEWHERE[ws.name]) {
      report.sheets.push({
        sheet: ws.name, product: 'Accounts', importedElsewhere: IMPORTED_ELSEWHERE[ws.name], rowsWaiting: countDataRows(ws),
      });
    } else if (REFERENCE_SHEETS.includes(ws.name)) {
      report.referenceSheets.push(ws.name);
    } else {
      report.sheets.push({ sheet: ws.name, skipped: 'not a sheet Data Import reads — nothing was taken from it', rowsWaiting: countDataRows(ws) });
    }
  });
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
      columns: s.columns.filter((c) => !c.legacy).map((c) => ({
        header: c.h, required: !!c.req, type: c.t,
        allowed: c.t === 'list' ? LISTS[c.list] || [] : undefined,
        help: c.help || '', example: c.eg || '',
        stored: c.store !== false, notStoredWhy: c.store === false ? c.why : undefined,
      })),
    })),
    importedElsewhere: IMPORTED_ELSEWHERE,
  });
});

// --- check: WRITES NOTHING -------------------------------------------------
router.post('/check', ADMIN, async (req, res, next) => {
  try {
    const { wb, filename } = await workbookFrom(req);
    const report = await run(wb, { dry: true, actor: req.user });
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
    const dryReport = await run(wb, { dry: true, actor: req.user });
    const partial = String((req.query && req.query.partial) || '') === 'true';
    if (!dryReport.ok && !partial) {
      return res.status(400).json({
        error: `${dryReport.totals.errors} row${dryReport.totals.errors === 1 ? '' : 's'} need fixing before anything is imported.`,
        report: dryReport,
      });
    }

    const report = await run(wb, { dry: false, actor: req.user });
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

// The row reader, the lookup maps and the per-sheet handlers, for the ATS
// screens' one-sheet imports (routes/atsIo.js) — the same code, not a copy.
module.exports.internals = {
  readSheet, buildIndex, HANDLERS, rawText, isDry, findCandidate, IMPORTED_BY,
};

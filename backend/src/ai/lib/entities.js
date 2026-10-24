// ---------------------------------------------------------------------------
// THE ENTITY RESOLVER — "Rahul", "the Java Developer job", "Acme", "INV 1822"
// -> the one real record the user means, or a question when several fit.
//
// READ-ONLY. Every lookup is narrowed by the SAME where-fragments the screens
// use (utils/scope.js: applicationWhere, candidateWhere, clientWhere,
// requirementWhere, invoiceWhere, employeeWhere), so the agent can only be
// pointed at a record the user could open themselves. Nothing here writes.
//
//   find<Kind>(user, text, opts) -> { rows: [...], full: bool }
//       rows are best-first, each with a plain `label`; `full` = every word the
//       user typed was found in the best rows (a partial match is never
//       auto-picked: the caller asks).
//   pick(result, choiceId)       -> { one } | { many } | { none }
// ---------------------------------------------------------------------------

const prisma = require('../../db');
const scope = require('../../utils/scope');
const { withoutSystemAccounts } = require('../../utils/systemAccounts');
const { stageLabel } = require('../../utils/atsVocab');
const clientSearch = require('../../utils/clientSearch');
// Client ids whose OLD name (ClientAlias) contains any typed word: the assistant also finds "VCare" for "Prabs VCare Health Clinic".
async function aliasIdsOf(ws) { return [...new Set((await Promise.all(ws.map((w) => clientSearch.aliasClientIds(w)))).flat())]; }

const SKIP_WORDS = new Set(['the', 'and', 'for', 'job', 'jobs', 'client', 'candidate', 'requirement', 'opening', 'employee', 'invoice', 'pvt', 'ltd', 'limited', 'private', 'inc', 'llp']);

function words(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !SKIP_WORDS.has(w)))].slice(0, 6);
}

// Which row is the best fit for the words typed? Exact > starts with > all words > some words.
function rankRows(rows, textOf, ws, typed) {
  const t = String(typed || '').trim().toLowerCase();
  const scored = rows.map((row) => {
    const hay = String(textOf(row) || '').toLowerCase();
    const hits = ws.filter((w) => hay.includes(w)).length;
    let score = hits * 10;
    if (t && hay === t) score += 100;
    else if (t && hay.startsWith(t)) score += 40;
    else if (t && hay.includes(t)) score += 25;
    return { row, score, hits };
  }).filter((x) => x.hits > 0);
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].hits : 0;
  return { rows: scored.map((x) => x.row), full: best === ws.length && ws.length > 0, bestHits: best, scored };
}

// WHAT THE ASKING LOGIN MAY SEE OF A CANDIDATE (security review 2026-10-09): the same switch
// as the REST routes (clientRedact.privacyFlagsFor - Role Catalog 'Candidate Contact & Salary',
// always off for the BDE team). The picker rows and labels the AI shows must not carry
// e-mail / phone, and not location / employer for the BDE team.
function candidateCut(user, c) {
  // eslint-disable-next-line global-require
  const flags = require('../../utils/clientRedact').privacyFlagsFor(user);
  if (!flags || !c) return c;
  const out = { ...c };
  if (flags.contact) ['email', 'phone', 'candidateEmail', 'candidatePhone'].forEach((k) => { delete out[k]; });
  if (flags.bde) ['location', 'currentCompany'].forEach((k) => { delete out[k]; });
  return out;
}

const OPEN_STAGE = (s) => !['JOINED', 'HIRED', 'REJECTED'].includes(s);

// --- Candidates and their applications --------------------------------------
async function findApplications(user, text, { extra = '' } = {}) {
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false };
  const where = {
    AND: [
      scope.applicationWhere(user),
      { OR: ws.map((w) => ({ candidate: { name: { contains: w } } })) },
    ],
  };
  const found = await prisma.application.findMany({
    where,
    include: {
      candidate: { select: { id: true, name: true, email: true, phone: true } },
      requirement: { select: { id: true, title: true, reqCode: true, internal: true, client: { select: { name: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 80,
  });
  const r = rankRows(found, (a) => (a.candidate ? a.candidate.name : ''), ws, text);
  let rows = r.rows;
  // The user may also have named the job or the client: narrow by that when it helps.
  const ew = words(extra);
  if (ew.length && rows.length > 1) {
    const narrowed = rows.filter((a) => ew.some((w) => `${a.requirement ? a.requirement.title : ''} ${a.requirement && a.requirement.client ? a.requirement.client.name : ''} ${a.requirement ? a.requirement.reqCode || '' : ''}`.toLowerCase().includes(w)));
    if (narrowed.length) rows = narrowed;
  }
  // The strongest name matches first, open applications before closed ones.
  const topHits = r.bestHits;
  rows = rows.filter((a) => ws.filter((w) => String(a.candidate.name).toLowerCase().includes(w)).length === topHits);
  rows.sort((a, b) => Number(OPEN_STAGE(b.stage)) - Number(OPEN_STAGE(a.stage)));
  const shaped = rows.slice(0, 12).map((a) => ({
    id: a.id,
    candidateId: a.candidateId,
    requirementId: a.requirementId,
    candidate: a.candidate.name,
    candidateEmail: a.candidate.email,
    candidatePhone: a.candidate.phone,
    requirement: a.requirement ? a.requirement.title : null,
    reqCode: a.requirement ? a.requirement.reqCode : null,
    client: a.requirement && a.requirement.internal ? 'TeamLink (internal)' : (a.requirement && a.requirement.client ? a.requirement.client.name : null),
    stage: a.stage,
    stageLabel: stageLabel(a.stage),
    interviewAt: a.interviewAt,
    interviewStatus: a.interviewStatus,
    open: OPEN_STAGE(a.stage),
  })).map((a) => ({ ...a, label: `${a.candidate} - ${a.requirement || 'no requirement'}${a.client ? ` (${a.client})` : ''}, now at ${a.stageLabel}` }))
    .map((a) => candidateCut(user, a));
  return { rows: shaped, full: r.full };
}

async function applicationById(user, id) {
  if (!id) return null;
  const a = await prisma.application.findFirst({
    where: { AND: [scope.applicationWhere(user), { id: String(id) }] },
    include: {
      candidate: { select: { id: true, name: true, email: true, phone: true } },
      requirement: { select: { id: true, title: true, reqCode: true, internal: true, client: { select: { name: true } } } },
    },
  });
  if (!a) return null;
  const r = {
    id: a.id,
    candidateId: a.candidateId,
    requirementId: a.requirementId,
    candidate: a.candidate.name,
    candidateEmail: a.candidate.email,
    candidatePhone: a.candidate.phone,
    requirement: a.requirement ? a.requirement.title : null,
    reqCode: a.requirement ? a.requirement.reqCode : null,
    client: a.requirement && a.requirement.internal ? 'TeamLink (internal)' : (a.requirement && a.requirement.client ? a.requirement.client.name : null),
    stage: a.stage,
    stageLabel: stageLabel(a.stage),
    interviewAt: a.interviewAt,
    interviewStatus: a.interviewStatus,
    open: OPEN_STAGE(a.stage),
  };
  return candidateCut(user, { ...r, label: `${r.candidate} - ${r.requirement || 'no requirement'}${r.client ? ` (${r.client})` : ''}, now at ${r.stageLabel}` });
}

async function findCandidates(user, text) {
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false };
  const found = await prisma.candidate.findMany({
    where: { AND: [scope.candidateWhere(user), { OR: ws.map((w) => ({ name: { contains: w } })) }] },
    select: {
      id: true, name: true, email: true, phone: true, location: true, skills: true, currentCompany: true, currentDesignation: true, noticePeriod: true, doNotContact: true,
    },
    take: 60,
  });
  const r = rankRows(found, (c) => c.name, ws, text);
  const top = r.rows.filter((c) => ws.filter((w) => c.name.toLowerCase().includes(w)).length === r.bestHits).slice(0, 10);
  return {
    // The label is built AFTER the cut, so a hidden phone / e-mail is not in it either.
    rows: top.map((c) => candidateCut(user, c)).map((c) => ({ ...c, label: `${c.name}${c.phone ? ` - ${c.phone}` : ''}${c.email ? ` - ${c.email}` : ''}` })),
    full: r.full,
  };
}

async function candidateById(user, id) {
  if (!id) return null;
  const c = await prisma.candidate.findFirst({
    where: { AND: [scope.candidateWhere(user), { id: String(id) }] },
    select: {
      id: true, name: true, email: true, phone: true, location: true, skills: true, currentCompany: true, currentDesignation: true, noticePeriod: true, doNotContact: true,
    },
  });
  if (!c) return null;
  const v = candidateCut(user, c);
  return { ...v, label: `${v.name}${v.phone ? ` - ${v.phone}` : ''}` };
}

// --- Clients -----------------------------------------------------------------
// purpose 'pick' = the client picker of the Add-requirement form (a TL may
// raise work for any client of their department); 'edit' = the Clients list.
async function findClients(user, text, { purpose = 'edit' } = {}) {
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false };
  const base = purpose === 'pick' ? scope.clientPickerWhere(user) : scope.clientWhere(user);
  const oldIds = await aliasIdsOf(ws);
  const found = await prisma.client.findMany({
    where: { AND: [base, { OR: [...ws.flatMap((w) => [{ name: { contains: w } }, { clientCode: { contains: w } }]), ...(oldIds.length ? [{ id: { in: oldIds } }] : [])] }] },
    select: {
      id: true, name: true, clientCode: true, ownerDepartment: true, status: true, location: true, industry: true, contactName: true, contactPhone: true, contactEmail: true, clientType: true,
    },
    take: 60,
  });
  const oldOf = await clientSearch.aliasMap();
  const hayOf = (c) => `${c.name} ${c.clientCode || ''} ${(oldOf.get(c.id) || []).join(' ')}`; // old names match; the label below shows the official name only
  const r = rankRows(found, hayOf, ws, text);
  const top = r.rows.filter((c) => ws.filter((w) => hayOf(c).toLowerCase().includes(w)).length === r.bestHits).slice(0, 10);
  return {
    rows: top.map((c) => ({ ...c, label: `${c.name}${c.location ? `, ${c.location}` : ''}${c.ownerDepartment ? ` (${c.ownerDepartment})` : ''}` })),
    full: r.full,
  };
}

async function clientById(user, id, { purpose = 'edit' } = {}) {
  if (!id) return null;
  const base = purpose === 'pick' ? scope.clientPickerWhere(user) : scope.clientWhere(user);
  const c = await prisma.client.findFirst({
    where: { AND: [base, { id: String(id) }] },
    select: {
      id: true, name: true, clientCode: true, ownerDepartment: true, status: true, location: true, industry: true, contactName: true, contactPhone: true, contactEmail: true, clientType: true,
    },
  });
  return c ? { ...c, label: `${c.name}${c.location ? `, ${c.location}` : ''}` } : null;
}

// --- Requirements ---------------------------------------------------------------
async function findRequirements(user, text, { code = null } = {}) {
  const ws = words(text);
  const where = [scope.requirementWhere(user)];
  if (code) where.push({ reqCode: { equals: String(code) } });
  else if (ws.length) {
    const oldIds = await aliasIdsOf(ws);
    where.push({ OR: [...ws.flatMap((w) => [{ title: { contains: w } }, { reqCode: { contains: w } }, { client: { name: { contains: w } } }]), ...(oldIds.length ? [{ clientId: { in: oldIds } }] : [])] });
  } else return { rows: [], full: false };
  const found = await prisma.requirement.findMany({
    where: { AND: where },
    select: {
      id: true, title: true, reqCode: true, status: true, department: true, location: true, openings: true, recruiterId: true, internal: true, priority: true, clientId: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
  });
  const oldOf = await clientSearch.aliasMap();
  const hayOf = (q) => `${q.title} ${q.reqCode || ''} ${q.client ? q.client.name : ''} ${(oldOf.get(q.clientId) || []).join(' ')}`; // old client names match; labels show the official name
  const live = ['OPEN', 'RECRUITER_ASSIGNED', 'ASSIGNED', 'ACTIVE', 'APPROVED'];
  const r = code ? { rows: found, full: found.length > 0, bestHits: 1 } : rankRows(found, hayOf, ws, text);
  let rows = r.rows;
  if (!code) rows = rows.filter((q) => ws.filter((w) => hayOf(q).toLowerCase().includes(w)).length === r.bestHits);
  rows.sort((a, b) => Number(live.includes(b.status)) - Number(live.includes(a.status)));
  return {
    rows: rows.slice(0, 10).map((q) => ({
      id: q.id,
      title: q.title,
      reqCode: q.reqCode,
      status: q.status,
      department: q.department,
      location: q.location,
      openings: q.openings,
      recruiterId: q.recruiterId,
      priority: q.priority,
      client: q.internal ? 'TeamLink (internal)' : (q.client ? q.client.name : null),
      label: `${q.title}${q.client && !q.internal ? ` at ${q.client.name}` : ''}${q.reqCode ? ` [${q.reqCode}]` : ''}`,
    })),
    full: r.full,
  };
}

async function requirementById(user, id) {
  if (!id) return null;
  const q = await prisma.requirement.findFirst({
    where: { AND: [scope.requirementWhere(user), { id: String(id) }] },
    select: {
      id: true, title: true, reqCode: true, status: true, department: true, location: true, openings: true, recruiterId: true, internal: true, priority: true, closingDate: true,
      client: { select: { name: true } },
    },
  });
  if (!q) return null;
  return {
    id: q.id,
    title: q.title,
    reqCode: q.reqCode,
    status: q.status,
    department: q.department,
    location: q.location,
    openings: q.openings,
    recruiterId: q.recruiterId,
    priority: q.priority,
    closingDate: q.closingDate,
    client: q.internal ? 'TeamLink (internal)' : (q.client ? q.client.name : null),
    label: `${q.title}${q.client && !q.internal ? ` at ${q.client.name}` : ''}${q.reqCode ? ` [${q.reqCode}]` : ''}`,
  };
}

// --- Employees ---------------------------------------------------------------------
const EMP_SELECT = {
  id: true, name: true, employeeCode: true, department: true, designation: true, team: true, email: true, phone: true, employmentStatus: true, userId: true, location: true,
};
async function findEmployees(user, text) {
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false };
  const found = await prisma.employee.findMany({
    where: withoutSystemAccounts({ AND: [scope.employeeWhere(user), { OR: ws.flatMap((w) => [{ name: { contains: w } }, { employeeCode: { contains: w } }]) }] }),
    select: EMP_SELECT,
    take: 60,
  });
  const r = rankRows(found, (e) => `${e.name} ${e.employeeCode || ''}`, ws, text);
  const top = r.rows.filter((e) => ws.filter((w) => `${e.name} ${e.employeeCode || ''}`.toLowerCase().includes(w)).length === r.bestHits);
  // people who have left come last
  top.sort((a, b) => Number(a.employmentStatus === 'Relieved') - Number(b.employmentStatus === 'Relieved'));
  return {
    rows: top.slice(0, 10).map((e) => ({ ...e, label: `${e.name}${e.employeeCode ? ` (${e.employeeCode})` : ''}${e.department ? `, ${e.department}` : ''}${e.employmentStatus && e.employmentStatus !== 'Active' ? ` - ${e.employmentStatus}` : ''}` })),
    full: r.full,
  };
}

async function employeeById(user, id) {
  if (!id) return null;
  const e = await prisma.employee.findFirst({
    where: withoutSystemAccounts({ AND: [scope.employeeWhere(user), { id: String(id) }] }),
    select: EMP_SELECT,
  });
  return e ? { ...e, label: `${e.name}${e.employeeCode ? ` (${e.employeeCode})` : ''}${e.department ? `, ${e.department}` : ''}` } : null;
}

// The signed-in person's own employee row (no scope needed: it is themselves).
async function ownEmployee(user) {
  if (!user || !user.id) return null;
  return prisma.employee.findUnique({ where: { userId: user.id }, select: EMP_SELECT });
}

// --- Invoices --------------------------------------------------------------------------
async function findInvoices(user, { number = null, text = '' } = {}) {
  const where = [scope.invoiceWhere(user)];
  const ws = words(text);
  if (number) where.push({ invoiceNumber: { contains: String(number) } });
  else if (ws.length) {
    const oldIds = await aliasIdsOf(ws);
    where.push({ client: { OR: [...ws.map((w) => ({ name: { contains: w } })), ...(oldIds.length ? [{ id: { in: oldIds } }] : [])] } });
  }
  else return { rows: [], full: false };
  const found = await prisma.invoice.findMany({
    where: { AND: where },
    select: {
      id: true, invoiceNumber: true, amount: true, gst: true, tds: true, status: true, receivedAmount: true, invoiceDate: true, dueDate: true, gstPercent: true, tdsPercent: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  const exact = number ? found.filter((i) => String(i.invoiceNumber).replace(/^INV-?/i, '') === String(number).replace(/^INV-?/i, '')) : [];
  const rows = (exact.length ? exact : found).slice(0, 10).map((i) => {
    const total = Math.round((Number(i.amount) + Number(i.gst || 0) - Number(i.tds || 0)) * 100) / 100;
    const outstanding = Math.max(0, Math.round((total - Number(i.receivedAmount || 0)) * 100) / 100);
    return {
      id: i.id,
      number: i.invoiceNumber,
      client: i.client ? i.client.name : null,
      amount: i.amount,
      gst: i.gst,
      tds: i.tds,
      gstPercent: i.gstPercent,
      tdsPercent: i.tdsPercent,
      total,
      received: i.receivedAmount || 0,
      outstanding,
      status: i.status,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      label: `Invoice ${i.invoiceNumber || '(no number)'} - ${i.client ? i.client.name : 'no client'} - Rs ${total.toLocaleString('en-IN')} (${i.status})`,
    };
  });
  return { rows, full: rows.length > 0 };
}

async function invoiceById(user, id) {
  if (!id) return null;
  const r = await findInvoicesById(user, id);
  return r;
}
async function findInvoicesById(user, id) {
  const i = await prisma.invoice.findFirst({
    where: { AND: [scope.invoiceWhere(user), { id: String(id) }] },
    select: {
      id: true, invoiceNumber: true, amount: true, gst: true, tds: true, status: true, receivedAmount: true, invoiceDate: true, dueDate: true, gstPercent: true, tdsPercent: true,
      client: { select: { name: true } },
    },
  });
  if (!i) return null;
  const total = Math.round((Number(i.amount) + Number(i.gst || 0) - Number(i.tds || 0)) * 100) / 100;
  const outstanding = Math.max(0, Math.round((total - Number(i.receivedAmount || 0)) * 100) / 100);
  return {
    id: i.id,
    number: i.invoiceNumber,
    client: i.client ? i.client.name : null,
    amount: i.amount,
    gst: i.gst,
    tds: i.tds,
    gstPercent: i.gstPercent,
    tdsPercent: i.tdsPercent,
    total,
    received: i.receivedAmount || 0,
    outstanding,
    status: i.status,
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    label: `Invoice ${i.invoiceNumber || '(no number)'} - ${i.client ? i.client.name : 'no client'} - Rs ${total.toLocaleString('en-IN')} (${i.status})`,
  };
}

// --- Assets (through the asset screen's own list, so its scope applies) ------------------
async function findAssets(reader, { code = null, text = '' } = {}) {
  const r = await reader.get('/asset-inventory');
  if (!r.ok || !Array.isArray(r.data)) return { rows: [], full: false, denied: r.status === 403 };
  const ws = words(text);
  let rows = r.data;
  if (code) rows = rows.filter((a) => String(a.assetCode).toUpperCase() === String(code).toUpperCase());
  else if (ws.length) {
    const ranked = rankRows(rows, (a) => `${a.name} ${a.assetCode} ${a.category} ${a.assignedTo ? a.assignedTo.name : ''}`, ws, text);
    rows = ranked.rows.filter((a) => ws.filter((w) => `${a.name} ${a.assetCode} ${a.category} ${a.assignedTo ? a.assignedTo.name : ''}`.toLowerCase().includes(w)).length === ranked.bestHits);
  } else return { rows: [], full: false };
  return {
    rows: rows.slice(0, 12).map((a) => ({
      id: a.id,
      code: a.assetCode,
      name: a.name,
      category: a.category,
      status: a.status,
      holder: a.assignedTo ? a.assignedTo.name : null,
      holderId: a.assignedTo ? a.assignedTo.id : null,
      label: `${a.name} [${a.assetCode}] - ${a.status}${a.assignedTo ? ` (with ${a.assignedTo.name})` : ''}`,
    })),
    full: rows.length > 0,
  };
}

// --- People you can give work to (the assign screen's own list) -----------------------------
async function findRecruiters(reader, text) {
  const r = await reader.get('/requirements/assignable-people');
  if (!r.ok || !Array.isArray(r.data)) return { rows: [], full: false, denied: r.status === 403 };
  const pool = r.data.filter((p) => p.atsRole === 'RECRUITER');
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false, pool };
  const ranked = rankRows(pool, (p) => p.name, ws, text);
  const top = ranked.rows.filter((p) => ws.filter((w) => String(p.name).toLowerCase().includes(w)).length === ranked.bestHits);
  return { rows: top.slice(0, 10).map((p) => ({ id: p.id, name: p.name, label: p.name, workload: p.workload })), full: ranked.full, pool };
}

// --- Recruiter logins by name (the pool the assign screen then confirms) -------------------
async function findRecruiterUsers(text) {
  const ws = words(text);
  if (!ws.length) return { rows: [], full: false };
  const found = await prisma.user.findMany({
    where: { status: 'Active', atsRole: 'RECRUITER', OR: ws.map((w) => ({ name: { contains: w } })) },
    select: { id: true, name: true, atsDepartment: true },
    take: 30,
  });
  const r = rankRows(found, (u) => u.name, ws, text);
  const top = r.rows.filter((u) => ws.filter((w) => u.name.toLowerCase().includes(w)).length === r.bestHits);
  return { rows: top.slice(0, 8).map((u) => ({ ...u, label: u.name })), full: r.full };
}

// --- Pipeline counts (applications per step, inside the user's scope) --------------------------
async function pipelineCounts(user) {
  const groups = await prisma.application.groupBy({ by: ['stage'], where: scope.applicationWhere(user), _count: { _all: true } });
  const rows = groups.map((g) => ({ stage: g.stage, label: stageLabel(g.stage), count: g._count._all })).sort((x, y) => y.count - x.count);
  const total = rows.reduce((n, r) => n + r.count, 0);
  return { rows, total, open: rows.filter((r) => OPEN_STAGE(r.stage) && r.stage !== 'HOLD').reduce((n, r) => n + r.count, 0) };
}

// --- Choosing between the rows that came back ----------------------------------------------
function decide(result, choiceId = null) {
  const rows = (result && result.rows) || [];
  if (choiceId) {
    const hit = rows.find((r) => r.id === choiceId);
    return hit ? { one: hit } : { none: true };
  }
  if (!rows.length) return { none: true };
  if (rows.length === 1 && result.full) return { one: rows[0] };
  if (rows.length === 1 && !result.full) return { many: rows, partial: true };
  return { many: rows };
}

module.exports = {
  words, findApplications, applicationById, findCandidates, candidateById, findClients, clientById, findRequirements, requirementById,
  findEmployees, employeeById, ownEmployee, findInvoices, invoiceById, findAssets, findRecruiters, findRecruiterUsers, pipelineCounts, decide, rankRows,
};

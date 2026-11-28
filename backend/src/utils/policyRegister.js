// ---------------------------------------------------------------------------
// POLICY REGISTER: VERSIONS, REVIEW PLAN AND WHO HAS ACCEPTED WHICH VERSION (founder 2026-11-25, from the HR audit questionnaire:
// Q43 how often policies are reviewed, Q46 / Q379 acknowledgement with date and version, Q48 previous versions, Q53 revision history,
// Q378 which policies are mandatory, Q473 who has not accepted a mandatory policy).
//
// ADDITIVE. Three new tables (PolicyVersion, PolicyRegister, PolicyAckVersion). The existing policy records (PolicyDocument), the Documents
// screen, its approval chain and the old Acknowledgment rows are not touched.
//
//   version      HR records a revision of a policy: what changed, from when, and whether everybody has to accept it again. Version 1 is the
//                original issue and is made when the first revision is recorded.
//   review plan  "reviewed every N months": the last and the next review date; "Mark as reviewed" moves them. HR is reminded (once the
//                reminders are switched on) 30 days before, on the day, and weekly while overdue.
//   who accepted the OLD Acknowledgment rows say only "accepted, on this date"; the version is worked out from the date (the version in
//                force that day). A newer version that needs re-acceptance is accepted through PolicyAckVersion (an employee presses
//                "I have read it" on the Document expiry & policies page), so the old rows are never edited.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { NOT_SYSTEM_EMPLOYEE } = require('./systemAccounts');
const { EXITED, list: audienceList } = require('./audience');
const D = require('./docRegister');

const { dayOfDate, istToday, isDay, toDate, daysBetween, pretty, cleanLine, cleanText } = D;

function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
const histOf = (r) => { try { const h = JSON.parse((r && r.history) || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } };
const addHist = (r, by, action, extra = {}) => JSON.stringify([...histOf(r), { at: new Date().toISOString(), by: by ? by.name : 'System', action, ...extra }].slice(-60));

// --- loading and working out who stands where --------------------------------------------------------------------------------------
async function loadAll() {
  const [policies, emps, acks, versions, avs, regs] = await Promise.all([
    prisma.policyDocument.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.employee.findMany({ where: { AND: [{ employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE] }, select: { id: true, employeeCode: true, name: true, department: true, designation: true, userId: true }, orderBy: { name: 'asc' } }),
    prisma.acknowledgment.findMany({ select: { documentId: true, employeeId: true, acknowledgedAt: true } }),
    prisma.policyVersion.findMany({ orderBy: { versionNo: 'asc' } }),
    prisma.policyAckVersion.findMany(),
    prisma.policyRegister.findMany(),
  ]);
  const group = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
  return { policies, emps, acksBy: group(acks, 'documentId'), versionsBy: group(versions, 'policyId'), avsBy: group(avs, 'policyId'), regBy: new Map(regs.map((r) => [r.policyId, r])) };
}

const inAudience = (p, e) => {
  const ids = audienceList(p.employeeIds);
  if (ids.length) return ids.includes(e.id);
  const depts = audienceList(p.departments);
  if (depts.length) return depts.includes(e.department);
  return true;
};

/** Everything about one policy: its versions, and where each person in its audience stands. */
function work(p, ctx) {
  const versions = ctx.versionsBy.get(p.id) || [];
  const currentNo = versions.length ? versions[versions.length - 1].versionNo : 1;
  const reackFrom = versions.filter((v) => v.requireReack).reduce((m, v) => Math.max(m, v.versionNo), 1);
  const versionAt = (when) => {
    let n = 1;
    versions.forEach((v) => { if (v.recordedAt.getTime() <= when.getTime()) n = Math.max(n, v.versionNo); });
    return n;
  };
  const acks = new Map((ctx.acksBy.get(p.id) || []).map((a) => [a.employeeId, a]));
  const extra = new Map();
  (ctx.avsBy.get(p.id) || []).forEach((a) => { const cur = extra.get(a.employeeId); if (!cur || a.versionNo > cur.versionNo) extra.set(a.employeeId, a); });
  const people = ctx.emps.filter((e) => inAudience(p, e)).map((e) => {
    const base = acks.get(e.id);
    const more = extra.get(e.id);
    const baseVer = base ? versionAt(base.acknowledgedAt) : 0;
    const got = Math.max(baseVer, more ? more.versionNo : 0);
    const when = [base && base.acknowledgedAt, more && more.acknowledgedAt].filter(Boolean).sort((a, b) => b - a)[0] || null;
    const state = got === 0 ? 'Not acknowledged' : got >= reackFrom ? 'Current' : 'Needs re-acknowledgement';
    return { employeeId: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation, userId: e.userId, state, versionRead: got || null, acknowledgedOn: when ? when.toISOString() : null };
  });
  const count = (s) => people.filter((x) => x.state === s).length;
  return { versions, currentNo, reackFrom, people, current: count('Current'), needsReack: count('Needs re-acknowledgement'), notAcknowledged: count('Not acknowledged') };
}

function reviewOf(reg, today) {
  if (!reg || !reg.reviewEveryMonths) return { everyMonths: null, ownerName: (reg && reg.ownerName) || null, lastReviewedOn: dayOfDate(reg && reg.lastReviewedOn), nextReviewOn: null, daysToReview: null, state: 'No plan' };
  const next = dayOfDate(reg.nextReviewOn);
  const left = next ? daysBetween(today, next) : null;
  return {
    everyMonths: reg.reviewEveryMonths, ownerName: reg.ownerName || null, lastReviewedOn: dayOfDate(reg.lastReviewedOn), nextReviewOn: next, daysToReview: left,
    state: left === null ? 'No plan' : left < 0 ? 'Overdue' : left <= 30 ? 'Due soon' : 'On track',
  };
}

const live = (p) => p.published && (p.approvalStatus || 'Approved') === 'Approved';
const row = (p, w, reg, today) => ({
  id: p.id, title: p.title, category: p.category || null, mandatory: !!p.mandatory, published: !!p.published, approvalStatus: p.approvalStatus || 'Approved', target: p.target || null,
  uploadedDate: p.uploadedDate, currentVersion: w.currentNo, versionCount: w.versions.length || 1,
  review: reviewOf(reg, today), audience: w.people.length, current: w.current, needsReack: w.needsReack, notAcknowledged: w.notAcknowledged,
});

const BUCKETS = {
  all: () => true,
  mandatory: (r) => r.mandatory,
  reviewDue: (r) => ['Overdue', 'Due soon'].includes(r.review.state),
  reack: (r) => r.needsReack > 0,
  pending: (r) => r.mandatory && r.notAcknowledged > 0,
  noPlan: (r) => r.review.state === 'No plan',
};

/** -> { counts, rows } */
async function listPolicies({ bucket = 'all', q = '' } = {}) {
  const ctx = await loadAll();
  const today = istToday();
  const rows = ctx.policies.map((p) => row(p, work(p, ctx), ctx.regBy.get(p.id), today));
  const counts = Object.fromEntries(Object.entries(BUCKETS).map(([k, fn]) => [k, rows.filter(fn).length]));
  const needle = cleanLine(q, 80).toLowerCase();
  const out = rows.filter(BUCKETS[bucket] || BUCKETS.all).filter((r) => !needle || r.title.toLowerCase().includes(needle));
  return { bucket: BUCKETS[bucket] ? bucket : 'all', counts, rows: out };
}

/** One policy with its versions, review plan, history and the status of every person it was sent to. */
async function detail(policyId) {
  const ctx = await loadAll();
  const p = ctx.policies.find((x) => x.id === String(policyId));
  if (!p) return { error: 'There is no such policy.', status: 404 };
  const w = work(p, ctx);
  const reg = ctx.regBy.get(p.id);
  const today = istToday();
  const versions = w.versions.length ? w.versions : [];
  return {
    policy: row(p, w, reg, today),
    versions: versions.map((v) => ({ versionNo: v.versionNo, summary: v.summary, effectiveOn: dayOfDate(v.effectiveOn), requireReack: v.requireReack, recordedBy: v.recordedByName, recordedAt: v.recordedAt.toISOString() })).reverse(),
    original: { uploadedDate: p.uploadedDate, uploadedBy: p.uploadedBy || null },
    history: histOf(reg).slice().reverse(),
    people: w.people.map(({ userId, ...rest }) => rest),
  };
}

/** body: { summary, effectiveOn?, requireReack? } -> { detail } | { error, status } */
async function recordVersion(user, policyId, body) {
  const p = await prisma.policyDocument.findUnique({ where: { id: String(policyId) } });
  if (!p) return { error: 'There is no such policy.', status: 404 };
  const b = body || {};
  const summary = cleanText(b.summary, 800);
  if (summary.length < 3) return { error: 'Write what changed in this version.', status: 400 };
  const effective = b.effectiveOn ? String(b.effectiveOn).slice(0, 10) : istToday();
  if (!isDay(effective)) return { error: 'The date is not valid.', status: 400 };
  const requireReack = b.requireReack === true || b.requireReack === 'true';
  const have = await prisma.policyVersion.findMany({ where: { policyId: p.id }, orderBy: { versionNo: 'asc' } });
  if (!have.length) {
    const base = isDay(String(p.uploadedDate || '').slice(0, 10)) ? String(p.uploadedDate).slice(0, 10) : dayOfDate(p.createdAt);
    await prisma.policyVersion.create({ data: { policyId: p.id, versionNo: 1, summary: 'Original issue', effectiveOn: toDate(base), requireReack: false, recordedByName: p.uploadedBy || null, recordedAt: p.createdAt } });
  }
  const next = (have.length ? have[have.length - 1].versionNo : 1) + 1;
  await prisma.policyVersion.create({ data: { policyId: p.id, versionNo: next, summary, effectiveOn: toDate(effective), requireReack, recordedByName: user ? user.name : null } });
  const reg = await prisma.policyRegister.findUnique({ where: { policyId: p.id } });
  const history = addHist(reg, user, `Version ${next} recorded`, { note: summary.slice(0, 200) });
  await prisma.policyRegister.upsert({ where: { policyId: p.id }, create: { policyId: p.id, history }, update: { history } });
  await logAudit({ userId: user ? user.id : null, action: `Policy version ${next} recorded`, entity: 'PolicyDocument', entityId: p.id, toValue: `${p.title}: ${summary.slice(0, 160)}${requireReack ? ' (everybody must accept it again)' : ''}` });
  let told = 0;
  if (requireReack && live(p) && (await D.getSettings()).enabled) {
    try {
      const ctx = await loadAll();
      const w = work(p, ctx);
      const ids = w.people.filter((x) => x.state === 'Needs re-acknowledgement' && x.userId).map((x) => x.userId);
      await require('./notify').notifyUsers(ids, { // eslint-disable-line global-require
        title: `📘 Policy updated: ${p.title} (version ${next})`,
        message: `${p.title} has a new version. Please read it and accept it again.`, exceptUserId: user ? user.id : undefined, open: '/employee-services?tab=documents',
      });
      told = ids.length;
    } catch { /* the version is saved either way */ }
  }
  return { ...(await detail(p.id)), told };
}

/** body: { reviewEveryMonths (1-60, or empty to remove the plan), ownerName? } */
async function setReview(user, policyId, body) {
  const p = await prisma.policyDocument.findUnique({ where: { id: String(policyId) } });
  if (!p) return { error: 'There is no such policy.', status: 404 };
  const b = body || {};
  const reg = await prisma.policyRegister.findUnique({ where: { policyId: p.id } });
  const empty = b.reviewEveryMonths === null || b.reviewEveryMonths === '' || b.reviewEveryMonths === undefined;
  const months = empty ? null : Number(b.reviewEveryMonths);
  if (!empty && (!Number.isInteger(months) || months < 1 || months > 60)) return { error: 'Reviewed every N months: a whole number from 1 to 60.', status: 400 };
  const owner = b.ownerName !== undefined ? (cleanLine(b.ownerName, 80) || null) : (reg ? reg.ownerName : null);
  const base = reg && reg.lastReviewedOn ? dayOfDate(reg.lastReviewedOn) : (isDay(String(p.uploadedDate || '').slice(0, 10)) ? String(p.uploadedDate).slice(0, 10) : dayOfDate(p.createdAt));
  const data = { reviewEveryMonths: months, ownerName: owner, nextReviewOn: months ? toDate(addMonths(base, months)) : null, remindState: null, history: addHist(reg, user, months ? `Review plan set: every ${months} month${months === 1 ? '' : 's'}` : 'Review plan removed') };
  await prisma.policyRegister.upsert({ where: { policyId: p.id }, create: { policyId: p.id, ...data }, update: data });
  await logAudit({ userId: user ? user.id : null, action: 'Policy review plan saved', entity: 'PolicyDocument', entityId: p.id, toValue: `${p.title}: ${months ? `every ${months} months` : 'no plan'}` });
  return detail(p.id);
}

/** HR looked at the policy today. body: { note? } */
async function markReviewed(user, policyId, body) {
  const p = await prisma.policyDocument.findUnique({ where: { id: String(policyId) } });
  if (!p) return { error: 'There is no such policy.', status: 404 };
  const reg = await prisma.policyRegister.findUnique({ where: { policyId: p.id } });
  const today = istToday();
  const note = cleanText((body || {}).note, 400);
  const months = reg ? reg.reviewEveryMonths : null;
  const data = { lastReviewedOn: toDate(today), nextReviewOn: months ? toDate(addMonths(today, months)) : null, remindState: null, history: addHist(reg, user, 'Reviewed', { note: note || undefined }) };
  await prisma.policyRegister.upsert({ where: { policyId: p.id }, create: { policyId: p.id, ...data }, update: data });
  await logAudit({ userId: user ? user.id : null, action: 'Policy marked as reviewed', entity: 'PolicyDocument', entityId: p.id, toValue: `${p.title}${months ? `, next review ${addMonths(today, months)}` : ''}` });
  return detail(p.id);
}

// --- the employee's own side ---------------------------------------------------------------------------------------------------------
/** Policies a newer version of which this employee has to accept again. */
async function myPending(user) {
  const own = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!own) return { rows: [] };
  const ctx = await loadAll();
  const rows = [];
  ctx.policies.filter(live).forEach((p) => {
    const w = work(p, ctx);
    const me = w.people.find((x) => x.employeeId === own.id);
    if (!me || me.state !== 'Needs re-acknowledgement') return;
    const v = w.versions.find((x) => x.versionNo === w.reackFrom);
    rows.push({ policyId: p.id, title: p.title, currentVersion: w.currentNo, readVersion: me.versionRead, summary: v ? v.summary : '', effectiveOn: v ? dayOfDate(v.effectiveOn) : null });
  });
  return { rows };
}
/** The employee accepts the current version. */
async function reack(user, policyId) {
  const own = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!own) return { error: 'No employee record is linked to this login.', status: 404 };
  const ctx = await loadAll();
  const p = ctx.policies.find((x) => x.id === String(policyId));
  if (!p || !live(p)) return { error: 'This policy is not published.', status: 404 };
  const w = work(p, ctx);
  const me = w.people.find((x) => x.employeeId === own.id);
  if (!me) return { error: 'This policy was not sent to you.', status: 403 };
  if (me.state !== 'Needs re-acknowledgement') return { error: me.state === 'Current' ? 'You have already accepted the current version.' : 'Accept it first on the Documents page.', status: 409 };
  await prisma.policyAckVersion.upsert({
    where: { policyId_employeeId_versionNo: { policyId: p.id, employeeId: own.id, versionNo: w.currentNo } },
    update: {}, create: { policyId: p.id, employeeId: own.id, versionNo: w.currentNo },
  });
  await logAudit({ userId: user.id, action: 'Policy version accepted', entity: 'PolicyDocument', entityId: p.id, toValue: `${p.title}, version ${w.currentNo}` });
  return { ok: true, version: w.currentNo };
}

// --- review reminders -------------------------------------------------------------------------------------------------------------------
function reviewMilestone(left) {
  if (left < 0) return { kind: 'overdue', mark: `o${Math.floor(-left / 7)}` };
  if (left === 0) return { kind: 'today', mark: 'r0' };
  if (left <= 30) return { kind: 'soon', mark: 'r30' };
  return null;
}
/** HR is told a policy review is coming or late. -> { told } */
async function remindReviews({ now = Date.now(), notify, hrUserIds } = {}) {
  const today = istToday(now);
  const send = notify || require('./notify').notifyUsers; // eslint-disable-line global-require
  const regs = await prisma.policyRegister.findMany({ where: { nextReviewOn: { not: null }, reviewEveryMonths: { not: null } } });
  if (!regs.length) return { told: [] };
  const policies = await prisma.policyDocument.findMany({ where: { id: { in: regs.map((r) => r.policyId) } }, select: { id: true, title: true } });
  const nameOf = new Map(policies.map((p) => [p.id, p.title]));
  const hr = hrUserIds ? await hrUserIds() : await D.hrUserIds();
  const told = [];
  for (const r of regs) {
    const title = nameOf.get(r.policyId);
    if (!title || !hr.length) continue; // eslint-disable-line no-continue
    const next = dayOfDate(r.nextReviewOn);
    const left = daysBetween(today, next);
    const m = reviewMilestone(left);
    if (!m) continue; // eslint-disable-line no-continue
    let marks = {};
    try { marks = r.remindState ? JSON.parse(r.remindState) : {}; } catch { marks = {}; }
    if (marks[m.mark]) continue; // eslint-disable-line no-continue
    const head = m.kind === 'overdue' ? `⏰ Policy review overdue: ${title}` : m.kind === 'today' ? `📘 Policy review due today: ${title}` : `📘 Policy review due in ${left} day${left === 1 ? '' : 's'}: ${title}`;
    const msg = `${title} is to be reviewed every ${r.reviewEveryMonths} month${r.reviewEveryMonths === 1 ? '' : 's'}${r.ownerName ? ` (owner ${r.ownerName})` : ''}. ${m.kind === 'overdue' ? `The review was due on ${pretty(next)}.` : `The next review is on ${pretty(next)}.`} Open the policy and press "Mark as reviewed" when it is done.`;
    await send(hr, { title: head, message: msg, open: '/employee-services?tab=documents&section=policies' }).catch(() => null); // eslint-disable-line no-await-in-loop
    marks[m.mark] = today;
    await prisma.policyRegister.update({ where: { id: r.id }, data: { remindState: JSON.stringify(marks) } }); // eslint-disable-line no-await-in-loop
    told.push({ policyId: r.policyId, kind: m.kind });
  }
  return { told };
}

/** Overview numbers for the top of the page. */
async function overview() {
  const ctx = await loadAll();
  const today = istToday();
  const rows = ctx.policies.map((p) => row(p, work(p, ctx), ctx.regBy.get(p.id), today));
  return {
    policies: rows.length,
    reviewDue: rows.filter(BUCKETS.reviewDue).length,
    needsReack: rows.reduce((n, r) => n + r.needsReack, 0),
    mandatoryPending: rows.filter(BUCKETS.pending).reduce((n, r) => n + r.notAcknowledged, 0),
  };
}

module.exports = { listPolicies, detail, recordVersion, setReview, markReviewed, myPending, reack, remindReviews, overview, work, loadAll, addMonths };

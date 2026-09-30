// ---------------------------------------------------------------------------
// PERFORMANCE REVIEWS (PerformanceReview) — import of review HISTORY
// (utils/moduleIo.js contract). The screen's export is the existing
// /api/insights/performance/export (everyone in scope / ?employeeId= one
// employee), and this sample uses the SAME column names, so an exported file
// re-imports as is (Name / Department / Band / Recommendation / Recorded On
// are read-only there).
//
// An import records history only: it NEVER raises the recommendation's
// approval chain (routes/performance.js POST does), and nobody is notified.
// So an imported review carries its outcome — Approved (default) or
// Rejected — and a review still Pending on its chain is not touched by an
// import (decide it on the screen). Band and Recommendation are computed from
// the score exactly as POST /api/performance computes them.
// Match: employee + period -> UPDATED (score / approval / notes; blanks never
// overwrite); otherwise created.
// Rights: Performance & Development create + approve (recording an outcome
// is an approval decision).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const io = require('../utils/moduleIo');

const APPROVALS = ['Approved', 'Rejected'];
const bandOf = (s) => (s >= 75 ? 'High' : s >= 50 ? 'Medium' : 'Low');
const recOf = (s) => (s >= 60 ? 'Recommended' : 'Not Recommended');

const spec = {
  key: 'performance',
  label: 'Performance reviews',
  module: 'Performance Reports',
  what: 'performance reviews',
  feature: 'Performance & Development',
  importActions: ['create', 'approve'],
  sheet: 'Performance reviews',
  entity: 'PerformanceReview',
  exportVia: '/insights/performance/export',
  columns: [
    { key: 'employeeCode', label: 'Employee ID', required: true, example: 'TL101', note: 'Employee ID (or email) of an employee in your scope.' },
    { key: 'employeeName', label: 'Name', readOnly: true, example: 'Asha Rao' },
    { key: 'department', label: 'Department', readOnly: true, example: 'Medical' },
    { key: 'period', label: 'Period', required: true, example: '2026-H1', note: 'The review period as you name it (e.g. 2026-H1, 2026-Q2). Same employee + period updates.' },
    { key: 'score', label: 'Score', type: 'number', required: true, example: 82, note: 'Whole number 0–100. Band and Recommendation are computed from it.' },
    { key: 'band', label: 'Band', readOnly: true, example: '' },
    { key: 'recommendation', label: 'Recommendation', readOnly: true, example: '' },
    { key: 'approval', label: 'Approval', list: 'Approval', example: 'Approved', note: 'Approved or Rejected. Blank on a new row = Approved.' },
    { key: 'notes', label: 'Notes', example: 'Strong quarter on closures' },
    { key: 'recordedOn', label: 'Recorded On', readOnly: true, example: '' },
  ],
  instructions: [
    'An import records review history only — no approval chain is started and nobody is notified.',
    'A row with the same Employee ID and Period as an existing review updates it; blank cells never overwrite. A review still Pending on its approval chain is not changed by an import.',
    'A file exported from Performance Reports can be re-imported as is: its extra read-only columns are ignored.',
  ],
  lists: async () => ({ Approval: APPROVALS }),

  async exportRows(ctx, { employeeIds }) {
    const reviews = await prisma.performanceReview.findMany({
      where: { employeeId: { in: employeeIds } }, include: { employee: true }, orderBy: { createdAt: 'desc' },
    });
    return reviews.map((r) => ({
      employeeCode: r.employee.employeeCode, employeeName: r.employee.name, department: r.employee.department || '', period: r.period,
      score: r.score, band: r.band, recommendation: r.recommendation, approval: r.approvalStatus, notes: r.notes || '',
      recordedOn: r.createdAt.toISOString().slice(0, 10),
    }));
  },

  async validate(rows, ctx) {
    const resolved = rows.map((r) => ctx.employees.resolve(r.employeeCode));
    const empIds = [...new Set(resolved.filter((h) => h.employee).map((h) => h.employee.id))];
    const existing = empIds.length ? await prisma.performanceReview.findMany({ where: { employeeId: { in: empIds } }, orderBy: { createdAt: 'desc' } }) : [];
    const byKey = new Map();
    existing.forEach((x) => { const k = `${x.employeeId}|${io.str(x.period).toLowerCase()}`; if (!byKey.has(k)) byKey.set(k, x); });
    const seen = new Map();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(spec, r);
      const hit = resolved[i];
      if (hit.error && io.str(r.employeeCode)) errors.push({ field: 'Employee ID', message: hit.error });
      const e = hit.employee;
      const period = io.str(r.period).slice(0, 40);
      const n = io.parseNumber(r.score);
      let score = null;
      if (n.error || (n.value !== undefined && (!Number.isInteger(n.value) || n.value < 0 || n.value > 100))) {
        errors.push({ field: 'Score', message: `"${r.score}" is not a whole number from 0 to 100.` });
      } else if (!n.empty) score = n.value;
      const approvalRaw = io.str(r.approval);
      const approval = approvalRaw ? io.pick([...APPROVALS, 'Pending'], approvalRaw) : null;
      if (approvalRaw && !approval) errors.push({ field: 'Approval', message: `"${approvalRaw}" is not one of ${APPROVALS.join(', ')}.` });
      const label = e ? `${e.name} (${e.employeeCode}) · ${period}` : io.str(r.employeeCode);
      const k = e && period ? `${e.id}|${period.toLowerCase()}` : null;
      if (k && !errors.length) {
        if (seen.has(k)) errors.push({ field: 'Period', message: `Same employee and period as row ${seen.get(k)}.` });
        else seen.set(k, r.line);
      }
      const match = k ? byKey.get(k) : null;
      // "Pending" is only ever the chain's word: allowed on a row that leaves
      // a Pending review exactly as it is (a re-imported export), never set.
      if (approval === 'Pending' && !(match && match.approvalStatus === 'Pending')) {
        errors.push({ field: 'Approval', message: 'An imported review is history — Approved or Rejected. Pending is set only by the approval chain.' });
      }
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const notes = io.str(r.notes) || null;
      if (!match) {
        return {
          line: r.line, label, errors: [], action: 'create',
          changes: [
            { field: 'Period', from: '', to: period }, { field: 'Score', from: '', to: score },
            { field: 'Band', from: '', to: bandOf(score) }, { field: 'Approval', from: '', to: approval || 'Approved' },
          ],
          data: {
            employee: e, period, score, notes, approvalStatus: approval || 'Approved',
          },
        };
      }
      const set = {};
      const changes = [];
      const cmp = (field, key, cur, next) => {
        if (next === null || next === undefined) return;
        if (String(cur ?? '') !== String(next)) { set[key] = next; changes.push({ field, from: cur ?? '', to: next }); }
      };
      cmp('Score', 'score', match.score, score);
      cmp('Approval', 'approvalStatus', match.approvalStatus, approval);
      cmp('Notes', 'notes', match.notes, notes);
      if (changes.length && match.approvalStatus === 'Pending') {
        return {
          line: r.line, label, action: 'error',
          errors: [{ field: 'Approval', message: 'This review is waiting on its approval chain — decide it on the Performance Reports screen; an import does not change it.' }],
        };
      }
      if (set.score !== undefined) {
        const b = bandOf(set.score); const rc = recOf(set.score);
        if (b !== match.band) { set.band = b; changes.push({ field: 'Band', from: match.band, to: b }); }
        if (rc !== match.recommendation) { set.recommendation = rc; changes.push({ field: 'Recommendation', from: match.recommendation, to: rc }); }
      }
      return {
        line: r.line, label, errors: [], action: changes.length ? 'update' : 'nochange', changes, data: { employee: e, record: match, set },
      };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    let updated = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        if (v.action === 'create') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            const rev = await tx.performanceReview.create({
              data: {
                employeeId: x.employee.id, period: x.period, score: x.score, band: bandOf(x.score), recommendation: recOf(x.score),
                notes: x.notes, approvalStatus: x.approvalStatus, raisedById: ctx.user.id,
              },
            });
            await tx.auditLog.create({
              data: {
                userId: ctx.user.id, actorName: actor, action: 'Performance review imported', entity: 'PerformanceReview', entityId: rev.id,
                toValue: `${x.period} · ${x.score} · ${x.approvalStatus}`, reason: `${x.employee.employeeCode} ${x.employee.name}`,
              },
            });
          });
          created += 1;
        } else if (v.action === 'update') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.$transaction(async (tx) => {
            await tx.performanceReview.update({ where: { id: x.record.id }, data: x.set });
            await tx.auditLog.createMany({
              data: v.changes.map((c) => ({
                userId: ctx.user.id, actorName: actor, action: 'Performance review updated by import', entity: 'PerformanceReview', entityId: x.record.id,
                field: c.field, fieldLabel: c.field, fromValue: String(c.from ?? ''), toValue: String(c.to ?? ''),
              })),
            });
          });
          updated += 1;
        }
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated, skipped: 0, failed };
  },
};

module.exports = spec;

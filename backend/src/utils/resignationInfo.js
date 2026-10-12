// ---------------------------------------------------------------------------
// WHEN AND WHY SOMEBODY RESIGNED, in one place (HRMS spec 2026-10-09, point 8):
// "the resignation date AND TIME with reasons must show in our application" -
// on the Resignation list, the employee profile, the exit process and the
// HRMS dashboard drill. Every one of them asks here, so they cannot differ.
//
// A person's CURRENT resignation = the newest resignation record that is not
// Withdrawn / Rejected (else simply the newest one).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : '');
const t12 = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};
const isoDay = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : '');

// "18-SEP-2026, 10:30 AM" | "18-SEP-2026" | "" (nothing recorded).
function whenWords(date, time) {
  const d = dmy(date);
  if (!d) return '';
  const t = t12(time);
  return t ? `${d}, ${t}` : d;
}

function shape(rec, d) {
  const lwd = isoDay(rec.date) || isoDay(d && (d.approvedLastWorkingDate || d.requestedLastWorkingDate));
  const reason = d ? (d.reason === 'Other' && d.reasonOther ? `Other: ${d.reasonOther}` : (d.reason || '')) : '';
  const date = isoDay(d && d.resignationDate);
  const time = (d && d.resignationTime) || '';
  return {
    recordId: rec.id,
    status: rec.status,
    resignationDate: date,
    resignationTime: time,
    resignedOn: whenWords(date, time),
    reason: reason || (rec.title && !/\(history\)$/.test(rec.title) ? rec.title : ''),
    lastWorkingDate: lwd,
    noticeDays: d && d.noticePeriodDays != null ? d.noticePeriodDays : null,
    source: d ? (/^Imported/i.test(d.submittedByName || '') ? 'Imported' : 'TeamLink') : '',
  };
}

// { [employeeId]: summary } for many people at once (one pair of queries).
async function summariesFor(employeeIds) {
  const ids = [...new Set(employeeIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const recs = await prisma.employeeRecord.findMany({ where: { type: 'RESIGNATION', employeeId: { in: ids } }, orderBy: { createdAt: 'desc' } });
  if (!recs.length) return new Map();
  const details = await prisma.resignationDetail.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
  const detailOf = new Map(details.map((d) => [d.recordId, d]));
  const out = new Map();
  const live = (r) => !['Withdrawn', 'Rejected'].includes(r.status);
  ids.forEach((id) => {
    const mine = recs.filter((r) => r.employeeId === id);
    if (!mine.length) return;
    const pick = mine.find(live) || mine[0];
    out.set(id, shape(pick, detailOf.get(pick.id)));
  });
  return out;
}

async function summaryFor(employeeId) {
  return (await summariesFor([employeeId])).get(employeeId) || null;
}

module.exports = { summariesFor, summaryFor, whenWords, t12, dmy };

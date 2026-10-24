// ---------------------------------------------------------------------------
// ABSENT WITHOUT APPLYING LEAVE (user, 2026-10-12): "when a person does not
// apply leave and is absent, that employee gets 2 LOPs, calculated based on
// their monthly CTC." A pure function over the day rows of utils/attendanceDays.js.
//
// A day is "absent without leave" when ALL of these hold:
//   * a working day that counts (not a week off, holiday, before joining, after leaving, in the future)
//   * nothing at all from the person: no check-in, no check-out
//   * status Absent (marked or no record) or Missing Check-In with no record at all
//   * NO leave applied for it: not Approved, not waiting (Pending), not Rejected
//     (a rejected request was still an application - that day stays a normal 1 LOP)
//   * no attendance correction waiting / approved for it
//   * the company's device/import HAS data for that date (a date nobody has any
//     record for is "No device data", never a penalty)
// Late coming / missing check-out / early logout are NOT absent: they have a punch.
// A HALF day (one half worked, other half missing, no leave of any kind) is
// charged the rule's half-day figure (default 1 LOP, today's 0.5).
//
// LOP arithmetic: the day is already 1 LOP in the old rule (Absent, or a missing
// day when "unmarked days are unpaid"); the penalty ADDS the difference, so a
// full absent day totals `days` (2) and a half day totals `halfDayDays` (1).
// ---------------------------------------------------------------------------
const dayKey = (id, d) => `${id}|${d}`;

function isFullCandidate(r) {
  if (!r || r.counted === false) return false;
  if (r.checkIn || r.checkOut) return false;
  if (!(r.status === 'Absent' || (r.status === 'Missing Check-In' && r.noRecord))) return false;
  return true;
}
const hasLeaveTrace = (r) => !!(r.leaveId || r.pendingLeaveId || (Number(r.pending) || 0) > 0 || (Number(r.leave) || 0) > 0 || r.leaveRejected);
const hasCorrection = (r) => r.regularization === 'Pending' || r.regularization === 'Approved' || !!r.regularizationId;

// 'full' | 'half' | null for ONE day row. ctx: { withData:Set|null, rejected:boolean }
function classify(r, ctx = {}) {
  if (!r || r.counted === false) return null;
  if (ctx.rejected || hasLeaveTrace(r) || hasCorrection(r)) return null;
  if (ctx.withData && !ctx.withData.has(r.date)) return null;
  if (isFullCandidate(r)) return 'full';
  if (r.status === 'Half Day') return 'half';
  return null;
}
const TAG_TEXT = 'Absent: no leave applied: 2 LOP';
const tagText = (rule, kind) => (kind === 'half'
  ? `Half day with no leave: ${rule.halfDayDays} LOP`
  : `Absent: no leave applied: ${rule.days} LOP`);

// rows: day rows for ONE employee in the pay period.
// opts: { rule:{active,days,halfDayDays}, withData:Set(dates)|null, rejected:Set(dates)|null, unmarkedUnpaid:boolean }
function detect(rows, opts = {}) {
  const rule = opts.rule || { active: false, days: 1, halfDayDays: 0.5 };
  const withData = opts.withData || null;
  const rejected = opts.rejected || new Set();
  const out = { active: !!rule.active, days: 0, dates: [], halfDays: 0, halfDates: [], extraLop: 0, lop: 0, perDay: rule.days, perHalf: rule.halfDayDays };
  if (!rule.active) return out;
  (rows || []).forEach((r) => {
    const kind = classify(r, { withData, rejected: !!(r && rejected.has(r.date)) });
    if (kind === 'full') {
      const base = r.status === 'Missing Check-In' ? (opts.unmarkedUnpaid === false ? 0 : 1) : (Number(r.absent) || 1);
      out.days += 1; out.dates.push(r.date);
      out.extraLop += Math.max(0, rule.days - base);
      out.lop += rule.days;
      return;
    }
    if (kind === 'half') {
      const base = Number(r.absent) || 0.5;
      out.halfDays += 1; out.halfDates.push(r.date);
      out.extraLop += Math.max(0, rule.halfDayDays - base);
      out.lop += rule.halfDayDays;
    }
  });
  out.extraLop = Math.round(out.extraLop * 100) / 100;
  out.lop = Math.round(out.lop * 100) / 100;
  return out;
}

// "Absent without leave: 2 day(s) x 2 = 4 LOP days" (plain words for the payslip).
function lineText(a) {
  if (!a || (!a.days && !a.halfDays)) return '';
  const bits = [];
  if (a.days) bits.push(`${a.days} day${a.days === 1 ? '' : 's'} × ${a.perDay} = ${Math.round(a.days * a.perDay * 100) / 100} LOP days`);
  if (a.halfDays) bits.push(`${a.halfDays} half day${a.halfDays === 1 ? '' : 's'} with no leave × ${a.perHalf} = ${Math.round(a.halfDays * a.perHalf * 100) / 100} LOP days`);
  return `Absent without leave: ${bits.join('; ')}`;
}

module.exports = { detect, classify, tagText, TAG_TEXT, lineText, dayKey, isFullCandidate };

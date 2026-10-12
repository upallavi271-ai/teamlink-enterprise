// ---------------------------------------------------------------------------
// LEAVE vs ATTENDANCE, RECONCILED (user, 2026-10-09: "the attendance KPIs and the
// leave KPIs are not matching the leaves: how to count?").
//
// The Leave overview counts leave REQUESTS; the attendance tiles count PEOPLE by
// what happened that day. For one date this puts every APPROVED request that
// overlaps it in exactly ONE place, so nothing is lost and nothing is counted twice:
//
//   full-day leave, person on leave              -> On leave tile
//   half-day leave (other half worked, or not)   -> Half day tile
//   leave on a week off / holiday                -> Week off / Holiday tile
//   leave but they came to work all day          -> Present tile
//   leave of someone no longer on the rolls      -> not on the rolls that day
//   anything else (e.g. not checked in yet)      -> other
//
// A person with two overlapping requests counts as two REQUESTS and one PERSON.
// Pure function: the dashboard and the proof script both call it.
// ---------------------------------------------------------------------------
const D = require('./attendanceDays');
const { halfOf } = require('./leaveText');

const WHERE = {
  onLeave: 'On leave', halfDay: 'Half day', offDay: 'Week off / Holiday', present: 'Present',
  other: 'other tiles', notOnRolls: 'not on the rolls that day',
};

// requests: approved LeaveRequest rows overlapping the date ({ id, employeeId, fromDate, toDate, days, reason }).
// dayOf(employeeId) -> that person's engine day row for the date, or undefined when they are not on the rolls.
function reconcile(requests, dayOf) {
  const landed = Object.fromEntries(Object.keys(WHERE).map((k) => [k, { requests: 0, full: 0, half: 0, people: new Set() }]));
  const perPerson = new Map();
  requests.forEach((l) => {
    const kind = halfOf(l) ? 'half' : 'full';
    const day = dayOf(l.employeeId);
    const b = day ? D.bucketOf(day) : 'notOnRolls';
    const key = landed[b] ? b : 'other';
    landed[key].requests += 1; landed[key][kind] += 1; landed[key].people.add(l.employeeId);
    perPerson.set(l.employeeId, (perPerson.get(l.employeeId) || 0) + 1);
  });
  const out = {
    requests: requests.length,
    people: perPerson.size,
    // people with more than one approved request on the day (they are 2 requests but 1 person)
    peopleWithMore: [...perPerson.values()].filter((n) => n > 1).length,
    byKind: { full: requests.filter((l) => !halfOf(l)).length, half: requests.filter((l) => !!halfOf(l)).length },
    landed: {},
  };
  Object.entries(landed).forEach(([k, v]) => { out.landed[k] = { requests: v.requests, full: v.full, half: v.half, people: v.people.size }; });
  out.landedTotal = Object.values(out.landed).reduce((n, v) => n + v.requests, 0);
  return out;
}

module.exports = { reconcile, WHERE };

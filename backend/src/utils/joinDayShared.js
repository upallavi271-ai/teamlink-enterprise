// ---------------------------------------------------------------------------
// THE JOINING DATE OF ONE APPLICATION - one rule for every list (user, 2026-10-17: "when did they join - the date").
//
// Same order as the ATS reports' own join day (utils/reportsPlus.js joinDayOf) and the Joining & Drop record:
//   1. the joining date typed on the application (a real date between 2015 and 2100),
//   2. else the joined-at time (as an India day),
//   3. else the day the application moved into Joined (the stage history).
// null = not recorded. A list shows that as "Not recorded" - never blank, never today's date.
// ---------------------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istDay = (d) => { const t = d ? new Date(d).getTime() : NaN; return Number.isNaN(t) ? null : new Date(t + 330 * 60000).toISOString().slice(0, 10); };
const typedDay = (s) => { const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(s || '')); return m && +m[1] >= 2015 && +m[1] <= 2100 ? String(s).slice(0, 10) : null; };
// app: { joiningDate, joinedAt }; movedIntoJoinedAt: the time of the move into Joined (optional)
function joinDay(app, movedIntoJoinedAt) {
  return typedDay(app && app.joiningDate) || istDay(app && app.joinedAt) || istDay(movedIntoJoinedAt) || null;
}
const dmy = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'Not recorded');
module.exports = { joinDay, dmy, istDay, typedDay };

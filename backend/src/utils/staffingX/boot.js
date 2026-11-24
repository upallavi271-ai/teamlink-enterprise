// ---------------------------------------------------------------------------
// The contract-staffing timers (utils/staffingX/*). Each one does nothing until its Admin switch is ON; none runs in the sandbox.
//   every 30 min   VMS: new jobs read + submission statuses read back (vms.sync)
//   every hour     Monday 10:00-11:00 India time: one bell per missing timesheet of last week (timesheets.reminders)
// ---------------------------------------------------------------------------
const S = require('./store');

let timer = null;
function start() {
  if (timer || S.isSandbox()) return;
  require('./vms').start(); // eslint-disable-line global-require
  timer = setInterval(async () => {
    try {
      if (!(await S.setting('timesheets.reminders'))) return;
      const ist = new Date(Date.now() + 330 * 60000);
      if (ist.getUTCDay() !== 1 || ist.getUTCHours() !== 10) return;
      await require('./timesheets').sendReminders({ id: null, name: 'Timesheet reminders', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }); // eslint-disable-line global-require
    } catch (e) { console.error('[stfx] reminders:', e.message); }
  }, 60 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = { start };

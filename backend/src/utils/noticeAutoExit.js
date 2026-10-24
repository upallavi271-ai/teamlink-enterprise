// ---------------------------------------------------------------------------
// THE NOTICE PERIOD, DAY BY DAY, AND THE AUTOMATIC EXIT (founder, 2026-10-23):
//   "when somebody is put on notice, count from the resignation date: show the day (of the 45), and when the dates are complete the person
//    goes into Exit by itself."
//
//   progressOf({ from, last, today })   PURE. from = the resignation date (notice starts), last = the last working day.
//                                       -> { from, last, total, day, left, state: 'serving' | 'last-day' | 'over', pct }
//                                       day = days served since the resignation date (0 on that day); left = days still to serve.
//   progressFor(employeeIds)            Map(employeeId -> progress) from each person's current exit record (utils/exitDate.js liveRecords).
//                                       No last working day on the record: resignation date + the notice days (policy, default 45).
//   autoExitDue()                       everybody on Notice Period whose last working day is BEHIND us (the day after it ends) becomes Relieved,
//                                       through the same finalize() the HR desk's "Finish exit" uses (exit record closed, settlement request made,
//                                       seat ended by the seat middleware, audit row). A person whose exit is still waiting for approval is NOT
//                                       relieved: the HR desk and the Super Admin are told once instead.
//   startSweep()                        runs it 40 s after boot and then every 30 minutes (idempotent). NOTICE_AUTO_EXIT=0 switches it off.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const exitDate = require('./exitDate');
const sandbox = require('./sandbox');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SERVING = ['Notice Period', 'Accepted'];
const ON_NOTICE = ['Notice Period', 'Exit Process'];
const SYSTEM = { id: null, name: 'TeamLink (automatic)', email: null };
const today = () => require('./positions').today(); // eslint-disable-line global-require
const isoDay = (v) => (v && ISO.test(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null);
const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
const diffDays = (a, b) => Math.round((ms(b) - ms(a)) / 86400000); // b - a
const addDays = (iso, n) => new Date(ms(iso) + n * 86400000).toISOString().slice(0, 10);

function progressOf({ from, last, today: t = today() }) {
  const a = isoDay(from); const b = isoDay(last);
  if (!a || !b) return null;
  const total = Math.max(0, diffDays(a, b));
  const served = diffDays(a, t);
  const day = Math.min(Math.max(0, served), total);
  const left = Math.max(0, diffDays(t, b));
  const state = t > b ? 'over' : t === b ? 'last-day' : 'serving';
  return { from: a, last: b, total, day, left, state, pct: total ? Math.min(100, Math.round((day / total) * 100)) : 100 };
}

async function noticeDaysPolicy() {
  try { const c = await prisma.hrConfig.findFirst(); return c && c.noticePeriodDays > 0 ? c.noticePeriodDays : 45; } catch { return 45; }
}

async function progressFor(ids, t = today()) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return out;
  const lives = await exitDate.liveRecords(list);
  const policy = await noticeDaysPolicy();
  for (const [id, live] of lives) {
    const d = live.detail || {};
    const from = isoDay(d.resignationDate);
    if (!from) continue; // eslint-disable-line no-continue
    const days = d.noticePeriodDays != null && d.noticePeriodDays > 0 ? d.noticePeriodDays : policy;
    const last = exitDate.dateOf(live.record, live.detail) || addDays(from, days);
    const p = progressOf({ from, last, today: t });
    if (p) out.set(id, { ...p, status: live.record.status });
  }
  return out;
}

// ---- the automatic exit -------------------------------------------------------------------------------------------------------------------
const TEST_RE = /zztest|example\.test/i;
async function autoExitSettingOn() {
  if (process.env.NOTICE_AUTO_EXIT === '0') return false;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'exit.settings' } });
    const v = row ? JSON.parse(row.value || '{}') : {};
    return v.autoRelieve !== false;
  } catch { return true; }
}

// -> { relieved: [{ id, name, lwd }], waiting: [{ id, name, lwd, status }], skipped: n }
async function autoExitDue({ t = today(), dry = false } = {}) {
  const exitFlow = require('./exitFlow'); // eslint-disable-line global-require
  const out = { relieved: [], waiting: [], skipped: 0, off: false };
  if (!(await autoExitSettingOn())) { out.off = true; return out; }
  const emps = await prisma.employee.findMany({ where: { employmentStatus: { in: ON_NOTICE } } });
  const lives = await exitDate.liveRecords(emps.map((e) => e.id));
  const policy = await noticeDaysPolicy();
  for (const e of emps) {
    const live = lives.get(e.id);
    if (!live || live.record.status === 'Relieved') { out.skipped += 1; continue; } // eslint-disable-line no-continue
    if (TEST_RE.test(`${e.name} ${e.email || ''}`) && !sandbox.isSandbox()) { out.skipped += 1; continue; } // eslint-disable-line no-continue
    const d = live.detail || {};
    const from = isoDay(d.resignationDate);
    const lwd = exitDate.dateOf(live.record, live.detail) || (from ? addDays(from, d.noticePeriodDays > 0 ? d.noticePeriodDays : policy) : null);
    if (!lwd || lwd >= t) continue; // eslint-disable-line no-continue
    if (!SERVING.includes(live.record.status)) {
      out.waiting.push({ id: e.id, name: e.name, lwd, status: live.record.status });
      if (!dry) {
        try {
          const sas = await exitFlow.superAdmins({ allowTest: TEST_RE.test(e.name) });
          await exitFlow.tell({
            userIds: sas.map((s) => s.id), email: false, key: `${live.record.id}:notice-ended-unapproved`,
            title: `Notice ended, exit not approved: ${e.name}`,
            message: `${e.name}'s last working day (${exitDate.dmy(lwd)}) is over, but the exit is "${live.record.status}", so it was not finished automatically. Approve it or finish the exit.`,
            link: exitFlow.exitLink(live.record.id),
          });
        } catch { /* a missed bell never stops the sweep */ }
      }
      continue; // eslint-disable-line no-continue
    }
    if (dry) { out.relieved.push({ id: e.id, name: e.name, lwd }); continue; } // eslint-disable-line no-continue
    try {
      const verdict = await exitFlow.canFinalizeExit(e.id, { today: t });
      if (!verdict.ok) { out.skipped += 1; continue; } // eslint-disable-line no-continue
      await exitFlow.finalize({ record: live.record, employee: e, user: SYSTEM, status: 'Relieved', note: `Notice period completed (last working day ${exitDate.dmy(lwd)}): relieved automatically` });
      out.relieved.push({ id: e.id, name: e.name, lwd });
      try {
        const sas = await exitFlow.superAdmins({ allowTest: TEST_RE.test(e.name) });
        await exitFlow.tell({
          userIds: sas.map((s) => s.id), email: false, key: `${live.record.id}:auto-relieved`,
          title: `Notice completed: ${e.name} is now Relieved`,
          message: `${e.name} served the notice period (last working day ${exitDate.dmy(lwd)}) and was moved to Exit (Relieved) automatically. The full & final settlement request is open.`,
          link: exitFlow.exitLink(live.record.id),
        });
      } catch { /* the bell is a courtesy */ }
    } catch (err) {
      console.error('[noticeAutoExit] could not relieve', e.name, err && err.message); // eslint-disable-line no-console
      out.skipped += 1;
    }
  }
  return out;
}

let timer = null;
function startSweep() {
  if (timer || process.env.NOTICE_AUTO_EXIT === '0') return;
  const run = () => autoExitDue().catch((e) => console.error('[noticeAutoExit] sweep failed:', e && e.message)); // eslint-disable-line no-console
  setTimeout(run, 40 * 1000).unref();
  timer = setInterval(run, 30 * 60 * 1000);
  timer.unref();
}

module.exports = { progressOf, progressFor, autoExitDue, startSweep, noticeDaysPolicy, diffDays, addDays };

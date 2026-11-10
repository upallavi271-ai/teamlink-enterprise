// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING -> TASKS VS WORK (founder 2026-11-10: "hrms application lo, time sheet lo, task assign cheskuntaru kadah, aa task
// ki, ikkada vallu work chesthunna dhaaniki match avuthundha ledha, entha percent match avuthundhi ani kuda raavali").
//
// For one person and one day: the HRMS tasks open for them that day (Timesheet > Tasks) and what they wrote in the Timesheet
// Checklist (from - to, description), set beside what was really open on the PC (the app, the website and the window title).
//
//   own words   a window whose title or app shares a word with the task ("invoices", "Smart Vision", "vendor portal")
//   related     a window in the kind of app the task needs: profiles / sourcing -> TeamLink ATS, Naukri, LinkedIn;
//               invoices -> TeamLink Accounts, Excel; code -> GitHub, Claude, the code editor ...
//   match %     the active time on windows that match ANY of the day's tasks (own words or related), out of the active time.
//               A Checklist entry is matched the same way, inside its own from - to time only.
//
// It reads the words, not the work: a good match says the person was in the right places for the task, nothing more.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const M = require('./monitoring');

const IST = 330 * 60000;
const STOP = new Set(('the and for with all any our this that from into onto over task tasks update updates updated daily work works working done '
  + 'make made check checking ensure required require provide whenever assigned only have has are you your yours their them they will shall '
  + 'need needs must should can could also each every more most many much some such than then there these those what when where which who '
  + 'why how not but per via etc new old get got give given take taken keep kept use used using day days today week month time times date '
  + 'team teams name names list lists details detail item items please kindly sir madam hrms timesheet status target targets complete '
  + 'completed completion priority high medium low start started end ended follow-up multiple three two one valid immediate').split(/\s+/));

// The kind of app a task needs: words in the task -> words of the windows that do that work.
const HINTS = [
  [/profil|sourc|candidat|resume|recruit|requirement|follow|interview|shortlist|share|screen|naukri|joining/, ['candidates', 'pipeline', 'ats', 'requirements', 'naukri', 'linkedin', 'indeed', 'shine', 'apna', 'interview', 'whatsapp', 'job portal']],
  [/invoic|account|statement|payment|ledger|bank|gst|vendor|bill|receivab|journal/, ['accounts', 'invoice', 'invoices', 'excel', 'tally', 'bank', 'vendor', 'statement', 'payments', 'receivables']],
  [/agreement|client|contract|terms|proposal|quotation/, ['clients', 'agreements', 'agreement', 'word', 'pdf', 'acrobat', 'crm']],
  [/promot|campaign|marketing|social|green start|omni|bulk|broadcast/, ['omni', 'green start', 'campaigns', 'canva', 'facebook', 'instagram', 'linkedin', 'whatsapp']],
  [/code|develop|bug|fix|feature|deploy|server|monitor|dashboard|portal|api|database|module|website|software|testing|tester|automation|claude|github/, ['code', 'github', 'claude', 'powershell', 'chatgpt', 'localhost', 'terminal', 'command window', 'visual studio']],
  [/asset|equipment|printer|inventory|laptop|sim/, ['assets', 'asset', 'excel', 'inventory']],
  [/attendance|payroll|leave|salary|employee|onboard|offboard|appraisal|policy/, ['hrms', 'attendance', 'payroll', 'leave', 'employees', 'excel']],
  [/mail|email/, ['gmail', 'outlook', 'mail', 'webmail']],
  [/excel|sheet|report|data|mis/, ['excel', 'sheets', 'reports', 'google sheets']],
];

const stem = (w) => w.replace(/(ings|ing|ies|es|ed|s)$/, (m) => (w.length - m.length >= 4 ? '' : m));
const words = (text) => [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem))];
const hintsOf = (text) => { const t = String(text || '').toLowerCase(); return [...new Set(HINTS.filter(([re]) => re.test(t)).flatMap(([, h]) => h))]; };

// how one window piece stands to one task: 'own' (shares a word), 'related' (the right kind of app), or null
function relation(task, pieceWords, pieceText) {
  if (task.words.some((w) => pieceWords.has(w))) return 'own';
  // whole words only ("ats" is not inside "whatsapp"); the hints are plain words and spaces
  const padded = ` ${pieceText.replace(/[^a-z0-9]+/g, ' ')} `;
  if (task.hints.some((h) => padded.includes(` ${h} `))) return 'related';
  return null;
}
const hmOf = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(11, 16);
const atIst = (day, hm) => new Date(`${day}T${hm}:00+05:30`).getTime();
const hrs = (sec) => Math.round((sec / 3600) * 100) / 100;
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : null);

async function checklistRows(userIds, a, b) {
  if (!userIds.length) return [];
  const list = userIds.map(() => '?').join(',');
  return prisma.$queryRawUnsafe(`SELECT userId, date, fromTime, toTime, status, description FROM TimesheetChecklist WHERE date >= ? AND date <= ? AND userId IN (${list}) ORDER BY date, fromTime`, a, b, ...userIds).catch(() => []);
}

async function taskMatch(from, to, access = null) {
  const today = M.todayIst();
  const b = M.validDay(to) && to < today ? to : today;
  let a = M.validDay(from) ? from : b;
  if (a > b) a = b;
  if (M.addDays(a, 30) < b) a = M.addDays(b, -30);
  const within = access && access.ids ? { employeeId: { in: access.ids } } : {};
  const [logs, catOf, cfg, idx] = await Promise.all([
    prisma.activityLog.findMany({ where: { day: { gte: a, lte: b }, isIdle: false, isBreak: false, ...within }, select: { employeeId: true, appName: true, windowTitle: true, startTime: true, endTime: true, durationSeconds: true, day: true } }),
    M.categoryIndex(), M.settings(), M.overrideIndex(),
  ]);
  const empIds = [...new Set(logs.map((l) => l.employeeId))];
  const emps = await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, employeeCode: true, department: true, userId: true } });
  const userIds = emps.map((e) => e.userId).filter(Boolean);
  const [tasks, checks] = await Promise.all([
    userIds.length ? prisma.task.findMany({
      where: { assigneeId: { in: userIds }, status: { notIn: ['Cancelled', 'On Hold'] }, OR: [{ startDate: null }, { startDate: { lte: b } }] },
      select: { id: true, name: true, subTaskName: true, description: true, status: true, startDate: true, endDate: true, completedAt: true, assigneeId: true, priority: true },
    }) : [],
    checklistRows(userIds, a, b),
  ]);
  const rows = [];
  emps.forEach((e) => {
    if (M.effective(cfg, idx, e).excluded) return;
    const mine = logs.filter((l) => l.employeeId === e.id);
    [...new Set(mine.map((l) => l.day))].sort().reverse().forEach((day) => {
      const dayStart = atIst(day, '00:00');
      const open = tasks.filter((t) => t.assigneeId === e.userId && (!t.startDate || t.startDate <= day)
        && (!t.completedAt || new Date(t.completedAt).getTime() >= dayStart)
        && (!t.endDate || t.endDate >= day || !['Completed', 'Done'].includes(t.status)))
        .map((t) => { const text = [t.name, t.subTaskName, t.description].filter(Boolean).join(' '); return { ...t, words: words(text), hints: hintsOf(text), own: 0, related: 0, items: new Map() }; });
      const notes = checks.filter((c) => c.userId === e.userId && c.date === day)
        .map((c) => ({ ...c, words: words(c.description), hints: hintsOf(c.description), from: atIst(day, c.fromTime), to: atIst(day, c.toTime), active: 0, own: 0, related: 0, items: new Map() }));
      let active = 0; let matched = 0; let ownSec = 0;
      const other = new Map();
      mine.filter((l) => l.day === day).forEach((l) => {
        const c = catOf(l.appName, l.windowTitle, e.department || '');
        const shown = M.cleanTitle(l.appName, l.windowTitle);
        const item = `${c.label}${shown && shown.toLowerCase() !== String(c.label).toLowerCase() ? ` · ${shown.replace(/\s*[-–|·]\s*(Google Chrome|Microsoft Edge|Mozilla Firefox|TeamLink\.Enterprise)\s*$/i, '')}` : ''}`.slice(0, 140);
        const text = `${l.appName} ${c.label} ${shown || ''}`.toLowerCase();
        const pw = new Set(words(text));
        const sec = l.durationSeconds;
        active += sec;
        let best = null;
        open.forEach((t) => {
          const r = relation(t, pw, text);
          if (!r) return;
          t[r] += sec; t.items.set(item, (t.items.get(item) || 0) + sec);
          if (r === 'own' || !best) best = r;
        });
        const st = new Date(l.startTime).getTime(); const en = new Date(l.endTime).getTime();
        notes.forEach((n) => {
          const inside = Math.max(0, Math.min(en, n.to) - Math.max(st, n.from)) / 1000;
          if (!inside) return;
          n.active += inside;
          const r = relation(n, pw, text);
          if (r) { n[r] += inside; n.items.set(item, (n.items.get(item) || 0) + inside); }
        });
        if (best) { matched += sec; if (best === 'own') ownSec += sec; } else other.set(item, (other.get(item) || 0) + sec);
      });
      const top = (m, n = 4) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([item, sec]) => ({ item, seconds: Math.round(sec) }));
      rows.push({
        key: `${e.id}|${day}`, employeeId: e.id, day, name: e.name, code: e.employeeCode || null, department: e.department || null,
        activeHours: hrs(active), matchedHours: hrs(matched), matchPct: open.length ? pctOf(matched, active) : null, ownPct: open.length ? pctOf(ownSec, active) : null,
        tasks: open.map((t) => ({
          id: t.id, name: t.name, subTaskName: t.subTaskName || null, status: t.status, priority: t.priority, startDate: t.startDate, endDate: t.endDate,
          ownHours: hrs(t.own), relatedHours: hrs(t.related), sharePct: pctOf(t.own + t.related, active), keywords: t.words.slice(0, 8), items: top(t.items),
        })).sort((x, y) => (y.sharePct || 0) - (x.sharePct || 0)),
        checklist: notes.map((n) => ({
          from: n.fromTime, to: n.toTime, status: n.status, description: n.description, activeHours: hrs(n.active),
          matchPct: n.active ? pctOf(n.own + n.related, n.active) : null, slotPct: pctOf(n.active, Math.max(0, (n.to - n.from) / 1000)), items: top(n.items, 3),
        })),
        other: top(other, 5),
      });
    });
  });
  rows.sort((p, q) => q.day.localeCompare(p.day) || String(p.name).localeCompare(String(q.name)));
  return { from: a, to: b, rows };
}

module.exports = { taskMatch, words, hintsOf, relation };

// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING (2026-11-04) - how office PCs are used in work hours (routes/monitoring.js, the tables at the end of
// prisma/schema.prisma). A small desktop agent the employee installs (backend/agent/TeamLinkMonitor.ps1) sends what app is in front,
// its window title and whether the PC is idle; HR / Admin see the totals, every employee sees their own.
//
// PRIVACY - the rules this file keeps:
//   * only the app name, the window title, active / idle time and the day's first / last activity are stored - never
//     keystrokes, passwords, the clipboard, screenshots or chat content. Chat apps (WhatsApp, Telegram ...) keep their name
//     only, never the title (it can name a person or show a message); a title that mentions a password is dropped. Mail is the
//     same (a title can show the subject): a mail app keeps its name only, a mail website only the service's name (Gmail).
//   * nothing is stored before the employee accepts the current policy (monitoring_consents, policy_version). A new policy
//     text is a new version: everyone accepts it again before anything more is recorded.
//   * only work hours are kept (monitoring_settings work_start .. work_end, India time); the rest is thrown away on arrival.
//   * activity older than retention_days (default 90) is deleted every few hours (startSweep).
//   * HR / Admin (Super Admin, Admin, HR) see everyone; a team lead, STL or manager their own team; anybody else only themselves.
//     Clients, candidates and vendors have no monitoring at all. Who looked at whose data is in the audit log.
//   * the employee can pause it for a break, or clock out for the day, from the icon; nothing is recorded while paused.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const IST = 330 * 60000;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CATEGORIES = ['productive', 'neutral', 'unproductive'];
const ONLINE_MS = 3 * 60000; // a PC that sent a heartbeat in the last 3 minutes is online (the agent sends one every minute)
// What each person is doing in the front app RIGHT NOW - "typing" / "reading" - from the 2-second /live tick (agent 3.2). Live-only and
// ephemeral, so it is kept in memory (no column): employeeId -> { doing, at }.
const liveDoing = new Map();
const MAX_RECORD_MS = 60 * 60000; // one record covers at most an hour
const MAX_BATCH = 500;
const BROWSERS = ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'iexplore', 'vivaldi', 'safari'];
const CHAT = /whatsapp|telegram|signal|messenger|discord|wechat|viber|skype|snapchat|instagram/i;
const CHAT_NAMES = { whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', messenger: 'Messenger', discord: 'Discord', wechat: 'WeChat', viber: 'Viber', skype: 'Skype', snapchat: 'Snapchat', instagram: 'Instagram' };
const SECRET = /password|passcode|\bpin\b|otp|cvv|net ?banking/i;
const MAIL_APP = /^(outlook|olk|hxoutlook|hxmail|thunderbird|mailbird|foxmail|mailclient)$/i;
const MAIL_SITE = /\b(gmail|outlook|yahoo ?mail|zoho ?mail|rediff ?mail|proton ?mail)\b/i;
// A VIDEO MEETING in front counts as active work even with no keyboard or mouse (founder 2026-11-12: "teams & google meets attend
// avuthunnaru bde vallu ahh time lo kuda, break, idle ilaa vasthundhi" - BDEs in Teams / Meet calls were being marked idle / break).
// A segment the agent marked idle, while Teams, Google Meet, Zoom or Webex was the window in front, is turned back to active here -
// so the totals, the day timeline and the per-day numbers all count meeting time as work.
const MEETING_APP = /^(ms-?teams|teams|teams-for-linux|zoom|zoommtg|zoomlauncher|webex|webexmta|gotomeeting|bluejeans|skype)$/i;
const MEETING_TITLE = /(google meet|meet\.google|zoom meeting|microsoft teams|teams meeting|\bwebex\b|whereby|gotomeeting|bluejeans|^meet\s*[-–—]\s|[a-z]{3}-[a-z]{4}-[a-z]{3})/i;
function isMeeting(app, title) {
  const a = String(app || '').replace(/\.exe$/i, '').trim();
  if (MEETING_APP.test(a)) return true;
  return BROWSERS.includes(a.toLowerCase()) && MEETING_TITLE.test(String(title || ''));
}
const unmeet = (logs) => (logs || []).map((l) => ((l.isIdle && !l.isBreak && (isMeeting(l.appName, l.windowTitle) || isVici(l.appName, l.windowTitle))) ? { ...l, isIdle: false } : l));
// VICIDIAL, the call dialer (founder 2026-11-13: "vici dial & gmeet ... vici use chesthunnattu raavali"): a browser page whose
// title carries "ViciDial" is shown by its own name - in the Live Dashboard, the day timeline and the app/website history - not
// as a plain "chrome" or an unnamed website. A caller sits on it without touching the keyboard, so it counts as active, like a meeting.
// ViciDial's agent interface titles its browser tab "Agent web client" (and "Campaign Login" / "Agent Login" for its sign-in), not
// "ViciDial" (founder 2026-11-13, screenshot: it was showing as "Agent web client"). Match those, plus any title that does say vicidial.
const VICIDIAL = /vici\s*dial|agent web client|campaign login|agent login|vicibox/i;
const isVici = (app, title) => BROWSERS.includes(String(app || '').replace(/\.exe$/i, '').trim().toLowerCase()) && VICIDIAL.test(String(title || ''));
const MAIL_NAMES = { gmail: 'Gmail', outlook: 'Outlook', yahoomail: 'Yahoo Mail', zohomail: 'Zoho Mail', rediffmail: 'Rediffmail', protonmail: 'Proton Mail' };

const WHO_OLD = 'Who can see it: HR and Admin, and you yourself (HRMS -> Employee Monitoring -> My activity).';
const WHO_NEW = 'Who can see it: HR and Admin, your team lead or manager (their own team only), and you yourself (HRMS -> Employee Monitoring -> My activity). Every look at your activity by someone else is written in an audit log.';
const PAUSE_LINE = 'You can pause it for a break, or clock out for the day, from the TeamLink icon next to the clock. Nothing is recorded while it is paused.';
// agent 2.5 (founder 2026-11-11): key and click COUNTS, and the name of a key only when that one key is pressed over and over
// the 2.5 words (kept to recognise a notice still in use)
const INPUT_LINE_25 = 'How much the keyboard and mouse are used: only counts per minute (key presses, clicks, mouse movement). The name of a key or button is kept only when that one key or button is pressed again and again for a long time (for example a key held down, or an auto-clicker). Which keys make up your typing is never recorded.';
// agent 2.6 (founder 2026-11-11: "evaru ey buttons enni times press chesthunnaro teliyali")
// the 2.6 words (kept to recognise a notice still in use)
const INPUT_LINE_26 = 'How much the keyboard and mouse are used: how many times each kind of key and mouse button is pressed in a day (for example Space, Enter, Backspace, left click). All letter keys are counted together as one number, and all number keys as one number, so what you type can never be rebuilt. When one single key or button is pressed again and again for a long time (a key held down, an auto-clicker), its name and the time are kept.';
// agent 2.7 (founder 2026-11-12): the same counts, by app / website and hour
const INPUT_LINE = 'How much the keyboard and mouse are used: how many times each kind of key and mouse button is pressed (for example Space, Enter, Backspace, left click), in which app or website, and in which hour. All letter keys are counted together as one number, and all number keys as one number - single letters are never counted apart - so what you type can never be rebuilt. When one single key or button is pressed again and again for a long time (a key held down, an auto-clicker), its name and the time are kept.';
const POLICY_LINES = [
  'TeamLink records how this office PC is used during work hours, so that HR can see working time and idle time.',
  '',
  'What is recorded: the name of the app in front (for example Chrome or Excel), its window title, when the PC is in use or idle, and the first and last activity of the day.',
  INPUT_LINE,
  'What is never recorded: what you type, passwords, the clipboard, screenshots, files, or the content of chats and mails. Chat apps are recorded by their name only.',
  'Only work hours are recorded. Records are deleted after the number of days HR has set (90 days unless changed).',
  WHO_NEW,
  PAUSE_LINE,
  'Nothing is recorded until you accept this notice. You can ask HR about it at any time.',
];
const DEFAULT_POLICY = POLICY_LINES.join('\n');
// the notice as first shipped: still the words in use -> replaced by the new one, as a new version everybody accepts again
const FIRST_POLICY = POLICY_LINES.filter((l) => l !== PAUSE_LINE && l !== INPUT_LINE).map((l) => (l === WHO_NEW ? WHO_OLD : l)).join('\n');
// the notice before agent 2.5 (no key / click counts): still in use -> the new words, a new version everybody accepts again
const BEFORE_INPUT_POLICY = POLICY_LINES.filter((l) => l !== INPUT_LINE).join('\n');
// the 2.5 notice (minutes only): still in use -> the 2.6 words, a new version
const INPUT_25_POLICY = POLICY_LINES.map((l) => (l === INPUT_LINE ? INPUT_LINE_25 : l)).join('\n');
// the 2.6 notice (daily counts only): still in use -> the 2.7 words, a new version
const INPUT_26_POLICY = POLICY_LINES.map((l) => (l === INPUT_LINE ? INPUT_LINE_26 : l)).join('\n');

// --- time ------------------------------------------------------------------------------------------------------
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istTime = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const todayIst = () => istDay(Date.now());
const atIst = (day, hm) => new Date(`${day}T${hm}:00+05:30`);
const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const hmOf = (ms) => new Date(new Date(ms).getTime() + IST).toISOString().slice(11, 16);
// A NIGHT SHIFT: work ends after midnight (22:00 to 06:00). It all belongs to the day it started on.
const isNight = (c) => c.workStart > c.workEnd;
const shiftDay = (ms, c) => (isNight(c) && hmOf(ms) < c.workEnd ? addDays(istDay(ms), -1) : istDay(ms));
const atShift = (day, hm, c) => atIst(isNight(c) && hm < c.workStart ? addDays(day, 1) : day, hm);

// --- who may see -------------------------------------------------------------------------------------------------
// HR / Admin: Super Admin, Admin and HR (by role or HRMS role) - the HR desk of the permission matrix (SET.HR_DESK).
function isMonitorAdmin(user) {
  return !!user && require('./exitDate').isHrDesk(user); // eslint-disable-line global-require
}

// What this login may see: { admin, lead, ids } - ids = the employees (null = everyone).
const LEAD_ROLES = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'];
const isSuper = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].some((r) => r === u.role || r === String(u.hrmsRole || '').toUpperCase());
const csvOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
// IT ADMIN (the plan's role table): PCs and agents only, never anybody's activity. Chosen in Settings.
const isItIn = (s, u) => !!u && !!u.employeeId && csvOf(s.itAdminIds).includes(u.employeeId);
const isIt = async (u) => isItIn(await settings(), u);
// HR sees PCs; Super Admin, Admin and IT Admin act on them
const canManageDevices = async (u) => isSuper(u) || isIt(u);
async function accessOf(user) {
  if (isMonitorAdmin(user)) return { admin: true, lead: false, ids: null };
  const S = require('./scope'); // eslint-disable-line global-require
  if (LEAD_ROLES.includes(S.scopeOf(user).hrmsRole)) {
    const rows = await prisma.employee.findMany({ where: S.employeeWhere(user), select: { id: true } });
    return { admin: false, lead: true, ids: [...new Set([...rows.map((r) => r.id), user.employeeId].filter(Boolean))] };
  }
  return { admin: false, lead: false, ids: user && user.employeeId ? [user.employeeId] : [] };
}

// --- settings ----------------------------------------------------------------------------------------------------
async function settings() {
  let row = await prisma.monitoringSetting.findUnique({ where: { id: 'default' } });
  if (!row) row = await prisma.monitoringSetting.create({ data: { id: 'default', policyText: DEFAULT_POLICY } }).catch(() => null);
  if (row && (row.policyText === FIRST_POLICY || row.policyText === BEFORE_INPUT_POLICY || row.policyText === INPUT_25_POLICY || row.policyText === INPUT_26_POLICY)) row = await prisma.monitoringSetting.update({ where: { id: 'default' }, data: { policyText: DEFAULT_POLICY, policyVersion: (row.policyVersion || 1) + 1 } }).catch(() => row);
  const s = row || { workStart: '09:30', workEnd: '18:30', breakStart: '12:30', breakEnd: '13:15', idleThresholdMinutes: 5, retentionDays: 90, screenshotsEnabled: false, policyVersion: 1, policyText: DEFAULT_POLICY, trackTitles: true, autoUpdate: true };
  return { ...s, policyText: s.policyText || DEFAULT_POLICY, screenshotsEnabled: false };
}
async function saveSettings(user, body = {}) {
  const cur = await settings();
  const data = {};
  if (body.workStart !== undefined) { if (!HM.test(String(body.workStart))) return { status: 400, error: 'Write the start of work like 09:30.' }; data.workStart = String(body.workStart); }
  if (body.workEnd !== undefined) { if (!HM.test(String(body.workEnd))) return { status: 400, error: 'Write the end of work like 18:30.' }; data.workEnd = String(body.workEnd); }
  if ((data.workStart || cur.workStart) >= (data.workEnd || cur.workEnd)) return { status: 400, error: 'Work must end after it starts.' };
  if (body.breakStart !== undefined || body.breakEnd !== undefined) {
    const bs = String(body.breakStart || ''); const be = String(body.breakEnd || '');
    if ((bs || be) && !(HM.test(bs) && HM.test(be) && bs < be)) return { status: 400, error: 'Write the lunch break like 12:30 to 13:15, or leave both empty for no break.' };
    data.breakStart = bs; data.breakEnd = be;
  }
  if (body.idleThresholdMinutes !== undefined) {
    const n = Math.round(Number(body.idleThresholdMinutes));
    if (!(n >= 1 && n <= 60)) return { status: 400, error: 'Idle after: 1 to 60 minutes.' };
    data.idleThresholdMinutes = n;
  }
  if (body.retentionDays !== undefined) {
    const n = Math.round(Number(body.retentionDays));
    if (!(n >= 7 && n <= 730)) return { status: 400, error: 'Keep records for 7 to 730 days.' };
    data.retentionDays = n;
  }
  if (body.alertsEnabled !== undefined) data.alertsEnabled = body.alertsEnabled === true;
  if (body.alertEmail !== undefined) data.alertEmail = body.alertEmail === true;
  if (body.trackTitles !== undefined) data.trackTitles = body.trackTitles === true;
  if (body.unauthorizedApps !== undefined) data.unauthorizedApps = csvOf(body.unauthorizedApps).map((x) => x.toLowerCase().slice(0, 60)).slice(0, 100).join(', ') || null;
  if (body.reportEnabled !== undefined) data.reportEnabled = body.reportEnabled === true;
  if (body.reportFrequency !== undefined) data.reportFrequency = body.reportFrequency === 'weekly' ? 'weekly' : 'daily';
  if (body.reportEmails !== undefined) {
    const list = csvOf(String(body.reportEmails).replace(/[;\s]+/g, ','));
    if (list.some((m) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m))) return { status: 400, error: 'Write the mail addresses separated by commas.' };
    data.reportEmails = list.slice(0, 20).join(', ') || null;
  }
  if ((body.reportEnabled === true) && !(data.reportEmails !== undefined ? data.reportEmails : cur.reportEmails)) return { status: 400, error: 'Write at least one mail address for the report.' };
  // the agent's own settings: Super Admin, Admin, IT Admin (HR has the policy settings)
  if (['autoUpdate', 'deviceApproval'].some((k) => body[k] !== undefined && body[k] !== cur[k]) || (body.itAdminIds !== undefined && body.itAdminIds !== (cur.itAdminIds || ''))) {
    if (!(await canManageDevices(user))) return { status: 403, error: 'Agent settings are for the Super Admin, Admin or IT Admin.' };
    if (body.autoUpdate !== undefined) data.autoUpdate = body.autoUpdate === true;
    if (body.deviceApproval !== undefined) data.deviceApproval = body.deviceApproval === true;
    if (body.itAdminIds !== undefined) {
      if (!isSuper(user)) return { status: 403, error: 'Only the Super Admin or Admin chooses the IT Admins.' };
      data.itAdminIds = csvOf(body.itAdminIds).join(',') || null;
    }
  }
  const limits = [['longIdleMinutes', 5, 240, 'Long idle: 5 to 240 minutes.'], ['offlineMinutes', 5, 240, 'No signal: 5 to 240 minutes.'], ['lowActivityHours', 1, 12, 'Low activity: 1 to 12 hours.']];
  for (const [k, lo, hi, msg] of limits) {
    if (body[k] !== undefined) {
      const n = Math.round(Number(body[k]));
      if (!(n >= lo && n <= hi)) return { status: 400, error: msg };
      data[k] = n;
    }
  }
  if (body.policyText !== undefined) {
    const t = String(body.policyText || '').trim().slice(0, 6000);
    if (t.length < 40) return { status: 400, error: 'Write the consent notice employees will accept (at least a few sentences).' };
    // a changed notice is a new version: everybody accepts it again before more is recorded
    if (t !== cur.policyText) { data.policyText = t; data.policyVersion = (cur.policyVersion || 1) + 1; }
  }
  data.updatedBy = user ? user.name || null : null;
  await prisma.monitoringSetting.upsert({ where: { id: 'default' }, create: { id: 'default', policyText: DEFAULT_POLICY, ...data }, update: data });
  await require('./audit').logAudit({ userId: user && user.id, action: 'Employee monitoring settings changed', entity: 'MonitoringSetting', entityId: 'default', toValue: JSON.stringify(data).slice(0, 400) }).catch(() => {}); // eslint-disable-line global-require
  return { status: 200, settings: await settings(), newVersion: !!data.policyVersion };
}

// --- different rules for a department or an employee -------------------------------------------------------------------
async function overrideIndex() {
  const rows = await prisma.monitoringOverride.findMany().catch(() => []);
  return new Map(rows.map((r) => [`${r.scope}|${r.target}`, r]));
}
// The rules for one person: their own, then their department's, then the company's.
function effective(s, index, emp) {
  const own = (emp && index.get(`employee|${emp.id}`)) || {};
  const dept = (emp && emp.department && index.get(`department|${emp.department}`)) || {};
  const pick = (k) => { if (own[k] !== null && own[k] !== undefined) return own[k]; if (dept[k] !== null && dept[k] !== undefined) return dept[k]; return s[k]; };
  return {
    workStart: pick('workStart'), workEnd: pick('workEnd'), breakStart: pick('breakStart') || '', breakEnd: pick('breakEnd') || '', idleThresholdMinutes: pick('idleThresholdMinutes'),
    trackTitles: s.trackTitles !== false && pick('trackTitles') !== false, excluded: pick('excluded') === true,
  };
}
async function saveOverride(user, body = {}) {
  const scope = body.scope === 'employee' ? 'employee' : 'department';
  const target = String(body.target || '').trim().slice(0, 120);
  if (!target) return { status: 400, error: scope === 'employee' ? 'Pick the employee.' : 'Pick the department.' };
  const time = (k) => { const v = String(body[k] || '').trim(); return v || null; };
  const data = { workStart: time('workStart'), workEnd: time('workEnd'), breakStart: time('breakStart'), breakEnd: time('breakEnd') };
  if (!!data.workStart !== !!data.workEnd) return { status: 400, error: 'Give both the start and the end of work, or neither.' };
  if (!!data.breakStart !== !!data.breakEnd) return { status: 400, error: 'Give both the start and the end of the break, or neither.' };
  if (Object.values(data).some((v) => v && !HM.test(v))) return { status: 400, error: 'Write times like 09:30.' };
  if (data.workStart && data.workStart === data.workEnd) return { status: 400, error: 'Work cannot start and end at the same time.' };
  const idle = body.idleThresholdMinutes === '' || body.idleThresholdMinutes === null || body.idleThresholdMinutes === undefined ? null : Math.round(Number(body.idleThresholdMinutes));
  if (idle !== null && !(idle >= 1 && idle <= 60)) return { status: 400, error: 'Idle after: 1 to 60 minutes.' };
  data.idleThresholdMinutes = idle;
  data.trackTitles = body.trackTitles === false ? false : null;
  data.excluded = body.excluded === true ? true : null;
  data.updatedBy = user ? user.name || null : null;
  if (Object.entries(data).every(([k, v]) => k === 'updatedBy' || v === null)) return { status: 400, error: 'Change at least one rule.' };
  const row = await prisma.monitoringOverride.upsert({ where: { scope_target: { scope, target } }, create: { scope, target, ...data }, update: data });
  await require('./audit').logAudit({ userId: user && user.id, actorName: user && user.name, action: 'Employee monitoring rule changed', entity: 'MonitoringSetting', entityId: row.id, toValue: `${scope}: ${target}${data.excluded ? ' · not monitored' : ''}`.slice(0, 300) }).catch(() => {}); // eslint-disable-line global-require
  return { status: 200, row };
}
async function listOverrides() {
  const rows = await prisma.monitoringOverride.findMany({ orderBy: [{ scope: 'asc' }, { target: 'asc' }] });
  const ids = rows.filter((r) => r.scope === 'employee').map((r) => r.target);
  const emps = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true } }) : [];
  const byId = new Map(emps.map((e) => [e.id, e]));
  return rows.map((r) => ({ ...r, label: r.scope === 'employee' ? ((byId.get(r.target) || {}).name || 'Employee') : r.target }));
}
async function removeOverride(user, id) {
  const row = await prisma.monitoringOverride.delete({ where: { id } }).catch(() => null);
  if (row) await require('./audit').logAudit({ userId: user && user.id, actorName: user && user.name, action: 'Employee monitoring rule removed', entity: 'MonitoringSetting', entityId: id, toValue: `${row.scope}: ${row.target}`.slice(0, 300) }).catch(() => {}); // eslint-disable-line global-require
}

// --- the agent itself: the version on the server, and what a PC should run ------------------------------------------------
const AGENT_FILE = require('path').join(__dirname, '..', '..', 'agent', 'TeamLinkMonitor.ps1');
let agentCache = null;
function latestAgent() {
  if (agentCache) return agentCache;
  const bytes = require('fs').readFileSync(AGENT_FILE); // eslint-disable-line global-require
  const version = (/\$AgentVersion = '([\d.]+)'/.exec(bytes.toString('utf8')) || [])[1] || null;
  agentCache = { version, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  return agentCache;
}
const older = (a, b) => {
  const x = String(a || '0').split('.').map(Number); const y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
};
const needsUpdate = (version) => !!version && older(version, latestAgent().version);

// --- consent -----------------------------------------------------------------------------------------------------
async function hasConsent(employeeId, version) {
  return !!(await prisma.monitoringConsent.findFirst({ where: { employeeId, policyVersion: version }, select: { id: true } }));
}
async function recordConsent(employeeId, version, ip, via) {
  if (await hasConsent(employeeId, version)) return;
  await prisma.monitoringConsent.create({ data: { employeeId, policyVersion: version, ipAddress: ip ? String(ip).slice(0, 64) : null, via } });
}

// --- devices & tokens -------------------------------------------------------------------------------------------------
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function deviceOf(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Device ') ? h.slice(7).trim() : '';
  if (tok.length < 32) return null;
  const d = await prisma.monitoringDevice.findUnique({ where: { tokenHash: hashToken(tok) }, include: { employee: { select: { id: true, name: true, employmentStatus: true, department: true } } } });
  if (!d || !d.isActive) return null;
  if (['Exited', 'Relieved', 'Terminated'].includes(d.employee && d.employee.employmentStatus)) return null;
  return d;
}
async function registerDevice({ employeeId, deviceName, os }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = await prisma.monitoringDevice.create({
    data: { employeeId, approved: !(await settings()).deviceApproval, deviceName: String(deviceName || 'Office PC').trim().slice(0, 80) || 'Office PC', os: os ? String(os).trim().slice(0, 80) : null, tokenHash: hashToken(token), lastSeenAt: new Date() },
  });
  return { token, device };
}

// --- one-time set-up codes (founder 2026-11-05: "naa emp login isthey, theeskovatledhu, developer dhi isthey theeskovatledhu") ----
// HR / Admin, or the employee, gets a code in TeamLink and types it into the agent instead of a password: nobody hands a password to
// a set-up, and a service login can set up a PC for an employee. One use, 30 minutes, kept only as a hash (AppSetting). The notice
// is still shown and accepted at the PC, by the employee.
const CODE_PREFIX = 'monitoring.code.';
const CODE_MS = 30 * 60000;
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 / O or 1 / I / L: read off a screen
const codeKey = (c) => CODE_PREFIX + hashToken(String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
async function newSetupCode(employeeId, user) {
  const raw = [...crypto.randomBytes(8)].map((x) => CODE_ABC[x % CODE_ABC.length]).join('');
  const until = new Date(Date.now() + CODE_MS).toISOString();
  // codes past their time go, and this employee's older code with them
  const old = await prisma.appSetting.findMany({ where: { key: { startsWith: CODE_PREFIX } } });
  const drop = old.filter((r) => { try { const v = JSON.parse(r.value); return v.until < new Date().toISOString() || v.employeeId === employeeId; } catch { return true; } }).map((r) => r.key);
  if (drop.length) await prisma.appSetting.deleteMany({ where: { key: { in: drop } } });
  await prisma.appSetting.create({ data: { key: codeKey(raw), value: JSON.stringify({ employeeId, until, by: user ? user.name || null : null }), updatedById: user ? user.id : null, updatedByName: user ? user.name || null : null } });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, until };
}
async function readSetupCode(code) {
  const row = await prisma.appSetting.findUnique({ where: { key: codeKey(code) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    return v.until > new Date().toISOString() ? v : null;
  } catch { return null; }
}
const endSetupCode = (code) => prisma.appSetting.deleteMany({ where: { key: codeKey(code) } });

// --- one batch from the agent -------------------------------------------------------------------------------------------
const cleanApp = (s) => String(s || '').trim().replace(/\.exe$/i, '').replace(/[^\w .+-]/g, '').slice(0, 80);
function cleanTitle(app, title) {
  const t = String(title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (!t) return null;
  if (CHAT.test(app)) return null; // chat apps: the name only, never who or what
  const chat = CHAT.exec(t);
  if (chat) return BROWSERS.includes(String(app).toLowerCase()) ? CHAT_NAMES[chat[0].toLowerCase()] || null : null; // the same in a browser: which service, nothing more
  if (SECRET.test(t)) return null;
  if (MAIL_APP.test(app)) return null;
  if (BROWSERS.includes(String(app).toLowerCase())) { const m = MAIL_SITE.exec(t); if (m) return MAIL_NAMES[m[1].toLowerCase().replace(/\s/g, '')]; } // the service, so the website's rule still applies
  return t;
}
// -> { saved, skipped, reasons }
async function ingest(device, records) {
  const s = await settings();
  if (!(await hasConsent(device.employeeId, s.policyVersion))) return { status: 412, error: 'The employee has not accepted the current monitoring notice yet.', consentRequired: true, policyVersion: s.policyVersion, policyText: s.policyText };
  if (!Array.isArray(records)) return { status: 400, error: 'Send records as a list.' };
  if (records.length > MAX_BATCH) return { status: 400, error: `At most ${MAX_BATCH} records at a time.` };
  const cfg = effective(s, await overrideIndex(), device.employee || { id: device.employeeId });
  // not monitored, or the PC is still waiting for approval: nothing is kept
  if (cfg.excluded || device.approved === false) return { status: 200, saved: 0, skipped: records.length };
  const now = Date.now();
  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const app = cleanApp(r && r.appName);
    const st = new Date(r && r.start).getTime();
    const en = new Date(r && r.end).getTime();
    if (!app || !Number.isFinite(st) || !Number.isFinite(en) || en <= st || en - st > MAX_RECORD_MS || en > now + 5 * 60000 || st < now - 7 * 86400000) { skipped += 1; continue; } // eslint-disable-line no-continue
    // work hours only (India time), cut to the day of the record (a night shift belongs to the day it started on)
    const day = shiftDay(st, cfg);
    const ws = atShift(day, cfg.workStart, cfg).getTime();
    const we = atShift(day, cfg.workEnd, cfg).getTime();
    const a = Math.max(st, ws);
    const b = Math.min(en, we);
    if (b - a < 1000) { skipped += 1; continue; } // eslint-disable-line no-continue
    // THE LUNCH BREAK (founder 2026-11-05: "break 12:30 - 1:15 consider cheyyu"): the part inside it is Break - not idle, and no app or title kept
    const bs = HM.test(cfg.breakStart) && HM.test(cfg.breakEnd) && atShift(day, cfg.breakStart, cfg) < atShift(day, cfg.breakEnd, cfg) ? atShift(day, cfg.breakStart, cfg).getTime() : null;
    const be = bs ? atShift(day, cfg.breakEnd, cfg).getTime() : null;
    const parts = bs && a < be && b > bs
      ? [[a, bs, false], [Math.max(a, bs), Math.min(b, be), true], [be, b, false]]
      : [[a, b, false]];
    parts.filter(([x, y]) => y - x >= 1000).forEach(([x, y, lunch]) => rows.push({
      deviceId: device.id, employeeId: device.employeeId, appName: lunch ? 'Break' : app, windowTitle: lunch || !cfg.trackTitles ? null : cleanTitle(app, r.windowTitle),
      startTime: new Date(x), endTime: new Date(y), durationSeconds: Math.round((y - x) / 1000),
      isIdle: !lunch && r.isBreak !== true && (r.isIdle === true || r.idle === true), isBreak: lunch || r.isBreak === true, day,
    }));
  }
  // A batch can come twice (the answer was lost on a bad line, or the PC restarted right after sending): the same piece counts once.
  const fresh = [];
  if (rows.length) {
    const times = rows.map((x) => x.startTime.getTime());
    const have = await prisma.activityLog.findMany({ where: { deviceId: device.id, startTime: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } }, select: { startTime: true, appName: true } });
    const seen = new Set(have.map((x) => `${new Date(x.startTime).getTime()}|${x.appName}`));
    rows.forEach((x) => {
      const k = `${x.startTime.getTime()}|${x.appName}`;
      if (seen.has(k)) { skipped += 1; return; }
      seen.add(k); fresh.push(x);
    });
  }
  for (let i = 0; i < fresh.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.activityLog.createMany({ data: fresh.slice(i, i + 200) });
  }
  await prisma.monitoringDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return { status: 200, saved: fresh.length, skipped };
}

// What is on screen now, for the Live Dashboard: the same cleaning as a record, so no chat, mail or password title, and none at all
// for someone on app names only.
async function liveTitle(device, body) {
  if (!body.title) return null;
  // A meeting or the ViciDial dialer keeps its title even while idle, so Live can show it and count it as active, not idle
  // (founder 2026-11-13). Every other window still keeps nothing while idle.
  const working = isMeeting(cleanApp(body.currentApp), body.title) || isVici(cleanApp(body.currentApp), body.title);
  if (body.idle === true && !working) return null;
  const cfg = effective(await settings(), await overrideIndex(), device.employee || { id: device.employeeId });
  return cfg.trackTitles && !cfg.excluded ? cleanTitle(cleanApp(body.currentApp), body.title) : null;
}
// The moment the app or tab changes (founder 2026-11-05: "within sec lo updation jaragali"). The live picture only: records are unchanged.
async function liveUpdate(device, body = {}) {
  liveDoing.set(device.employeeId, { doing: body.idle ? '' : String(body.doing || '').slice(0, 12), at: Date.now() });
  await prisma.monitoringDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(), currentApp: body.currentApp ? cleanApp(body.currentApp) || null : null, currentIdle: body.idle === true, currentTitle: await liveTitle(device, body) },
  });
}
// A heartbeat: what the PC is doing now, for the Live Dashboard.
async function heartbeat(device, body = {}) {
  // sleep: the laptop is closing (agent 2.3 says so just before it sleeps); locked: the session is locked
  const paused = ['break', 'clockout', 'stopped', 'sleep', 'locked'].includes(body.paused) ? body.paused : null;
  await prisma.monitoringDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(), currentApp: body.currentApp ? cleanApp(body.currentApp) || null : null, currentIdle: body.idle === true, pausedState: paused, currentTitle: paused ? null : await liveTitle(device, body),
      ...(body.agentVersion ? { agentVersion: String(body.agentVersion).slice(0, 20) } : {}),
    },
  });
}

// --- categories (a department's own rule wins over the rule for everyone) --------------------------------------------------
async function categoryIndex() {
  const rows = await prisma.appCategory.findMany();
  const apps = new Map(); const sites = [];
  rows.forEach((c) => {
    if (c.kind === 'site') sites.push(c); else apps.set(`${c.department || ''}|${c.appName.toLowerCase()}`, c);
  });
  return (app, title, department = '') => {
    const a = String(app || '').toLowerCase();
    if (BROWSERS.includes(a) && title) {
      const t = String(title).toLowerCase();
      const hits = sites.filter((x) => t.includes(x.appName.toLowerCase()) && (!x.department || x.department === department));
      const site = hits.find((x) => x.department) || hits[0];
      if (site) return { key: site.appName, label: site.appName, kind: 'site', category: site.category };
    }
    const c = apps.get(`${department || ''}|${a}`) || apps.get(`|${a}`);
    return { key: a, label: app, kind: 'app', category: c ? c.category : null };
  };
}

// --- the numbers ----------------------------------------------------------------------------------------------------------
// One person's work day (founder 2026-11-10: "9 to 6, 45 mins break, 8 hours lo entha sepu active, idle, break - 4 hours active out of 8"):
// the whole day from start to end of work, the work time in it, and how much of the day has passed.
// The work time is the day without the lunch break and a short personal break (founder 2026-11-10: "lunch break 45 min, 15 min
// normal personal break, so out of 9, 8 working hrs"): 9 am - 6 pm is 9 h - 45 min - 15 min = 8 h.
const PERSONAL_BREAK_SECONDS = 15 * 60;
function workDayOf(day, c, now = Date.now()) {
  if (!HM.test(String(c.workStart || '')) || !HM.test(String(c.workEnd || ''))) return { daySeconds: 0, workSeconds: 0, elapsedSeconds: 0, personalSeconds: 0 };
  const ws = atShift(day, c.workStart, c).getTime();
  const we = atShift(day, c.workEnd, c).getTime();
  const daySec = Math.max(0, Math.round((we - ws) / 1000));
  let lunch = 0; let lunchFrom = null; let lunchTo = null;
  if (HM.test(String(c.breakStart || '')) && HM.test(String(c.breakEnd || ''))) {
    const bs = Math.max(ws, atShift(day, c.breakStart, c).getTime());
    const be = Math.min(we, atShift(day, c.breakEnd, c).getTime());
    if (be > bs) { lunch = Math.round((be - bs) / 1000); lunchFrom = bs; lunchTo = be; }
  }
  const elapsed = Math.max(0, Math.round((Math.min(Math.max(now, ws), we) - ws) / 1000));
  const personal = Math.min(PERSONAL_BREAK_SECONDS, Math.max(0, daySec - lunch));
  return { daySeconds: daySec, workSeconds: Math.max(0, daySec - lunch - personal), elapsedSeconds: elapsed, personalSeconds: personal, ws, we, lunchFrom, lunchTo };
}
// NOT ON PC ONLY WHEN IT REALLY WAS NOT (founder 2026-11-10: "nenu asalu laptop close cheyyaledhu, not on pc ani endhuku vasthundhi"):
// the agent keeps one piece open while the same window stays in front (up to 30 minutes) and sends every 2 minutes, so the newest
// minutes of a PC that is on have simply not arrived yet. While the PC is online now, the time since its last piece counts as what
// it is doing now (active / idle / break). And the lunch window with nothing recorded is the lunch break, not "not on the PC".
function gapFill(logs, wd, status, live, now = Date.now()) {
  const out = { active: 0, idle: 0, brk: 0, lunch: 0 };
  if (!wd || !wd.ws) return out;
  const end = Math.min(live ? now : wd.we, wd.we);
  const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  let lunchGap = 0;
  if (wd.lunchFrom && end > wd.lunchFrom) {
    const lt = Math.min(wd.lunchTo, end);
    const covered = (logs || []).reduce((n, l) => n + overlap(new Date(l.startTime).getTime(), new Date(l.endTime).getTime(), wd.lunchFrom, lt), 0);
    lunchGap = Math.max(0, (lt - wd.lunchFrom) - covered);
    out.lunch += Math.round(lunchGap / 1000); // the lunch window with nothing recorded is Lunch, kept apart from Break (founder 2026-11-13)
  }
  if (live && ['Online', 'Idle', 'On break'].includes(status)) {
    const lastEnd = (logs || []).reduce((m, l) => Math.max(m, new Date(l.endTime).getTime()), 0);
    const from = Math.max(lastEnd || wd.ws, wd.ws);
    if (end > from && lastEnd) {
      const pending = (end - from) - (wd.lunchFrom ? overlap(from, end, wd.lunchFrom, wd.lunchTo) : 0); // the lunch part is counted above
      const sec = Math.max(0, Math.round(pending / 1000));
      if (status === 'Online') out.active += sec; else if (status === 'Idle') out.idle += sec; else out.brk += sec;
    }
  }
  return out;
}
const hrs = (sec) => Math.round((sec / 3600) * 100) / 100;
// THE 15-MINUTE PERSONAL BREAK COMES OUT OF IDLE (founder 2026-11-11: "lunch break 45 min, adhi kaakunda 15 min break vuntadhi. idle lo vunnappudu
// 15 min break consider cheskovali, aa 15 min tharvatha kuda idle vuntey appudu idle"): each day, the first 15 minutes of idle are Break; only the
// idle after them is Idle. (The work day of 8 h already leaves these 15 minutes out - workDayOf.)
function totalsOf(logs, catOf, department = '') {
  let active = 0; let idle = 0; let breaks = 0; let lunch = 0; let productive = 0; let unproductive = 0; let first = null; let last = null;
  const idleByDay = new Map();
  logs.forEach((l) => {
    // LUNCH AND BREAK ARE KEPT APART (founder 2026-11-13: "lunch time & break separate cheyyu, andharu confuse avuthunnaru"):
    // the fixed lunch window is stored as the app 'Break' (ingest), everything else that is a break - the Pause icon and the
    // 15-minute personal break out of idle - is Break.
    if (l.isBreak) { if (l.appName === 'Break') lunch += l.durationSeconds; else breaks += l.durationSeconds; }
    else if (l.isIdle) { idle += l.durationSeconds; idleByDay.set(l.day || '', (idleByDay.get(l.day || '') || 0) + l.durationSeconds); }
    else {
      active += l.durationSeconds;
      const c = catOf(l.appName, l.windowTitle, department).category;
      if (c === 'productive') productive += l.durationSeconds;
      if (c === 'unproductive') unproductive += l.durationSeconds;
    }
    if (!first || l.startTime < first) first = l.startTime;
    if (!last || l.endTime > last) last = l.endTime;
  });
  let personal = 0;
  idleByDay.forEach((sec) => { personal += Math.min(PERSONAL_BREAK_SECONDS, sec); });
  idle -= personal; breaks += personal;
  return {
    personalBreakSeconds: personal,
    activeSeconds: active, idleSeconds: idle, breakSeconds: breaks, lunchSeconds: lunch, productiveSeconds: productive, unproductiveSeconds: unproductive,
    activeHours: hrs(active), idleHours: hrs(idle), breakHours: hrs(breaks), lunchHours: hrs(lunch), productivity: active ? Math.round((productive / active) * 100) : null, first, last,
  };
}
async function employeesById(ids) {
  const rows = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true, department: true, team: true, designation: true } }) : [];
  return new Map(rows.map((e) => [e.id, e]));
}
const LOG_SELECT = { employeeId: true, appName: true, windowTitle: true, startTime: true, endTime: true, durationSeconds: true, isIdle: true, isBreak: true, day: true };
const within = (access) => (access && access.ids ? { employeeId: { in: access.ids } } : {});

// What a PC is doing now, from its last heartbeat (a heartbeat comes every minute).
function liveStatus(dev, onLeave, now) {
  const fresh = dev && dev.lastSeenAt && now - new Date(dev.lastSeenAt).getTime() < ONLINE_MS;
  if (fresh) {
    if (dev.pausedState === 'break') return 'On break';
    if (dev.pausedState === 'clockout') return 'Clocked out';
    if (dev.pausedState === 'stopped') return 'Stopped';
    if (dev.pausedState === 'sleep') return 'Laptop closed';
    if (dev.pausedState === 'locked') return 'Idle';
    // In a video call or on the ViciDial dialer the person is working even with no mouse / keyboard, so Live says Online, not Idle
    // (founder 2026-11-13: "gmeet lo vuntey active lo vundali", "vici use chesthunnappudu active"). The totals already do this via unmeet.
    if (dev.currentIdle) return (isMeeting(dev.currentApp, dev.currentTitle) || isVici(dev.currentApp, dev.currentTitle)) ? 'Online' : 'Idle';
    return 'Online';
  }
  if (onLeave) return 'On leave';
  // the person closed the agent (Stop recording and close) or clocked out: that stays on the board until the PC reports again,
  // instead of turning into a plain Offline after 3 minutes (founder 2026-11-09: two people working, both shown Offline)
  if (dev && dev.pausedState === 'stopped') return 'Stopped';
  if (dev && dev.pausedState === 'clockout' && dev.lastSeenAt && istDay(dev.lastSeenAt) === istDay(now)) return 'Clocked out';
  // LAPTOP CLOSED, NOT OFFLINE (founder 2026-11-10: "laptop shutdown cheyyakunda close chesi vellipotharu - offline ani vasthundhi,
  // alaa vundakudadhu"): the agent said it was going to sleep, or its last word was a locked screen (Windows locks on closing the lid)
  if (dev && ['sleep', 'locked'].includes(dev.pausedState)) return 'Laptop closed';
  // an agent older than 2.1 does not come back after sleep by itself, and so never takes the update that fixes it: one restart does
  if (dev && dev.agentVersion && older(dev.agentVersion, '2.1')) return 'Old agent';
  return 'Offline';
}

// Only what changes by the second, for the Live Dashboard's fast refresh: no activity records, so it stays light.
async function liveRows(access = null) {
  const cfg = await settings();
  const today = todayIst();
  const now = Date.now();
  const nowHm = hmOf(now);
  const [devices, leaves, rules] = await Promise.all([
    prisma.monitoringDevice.findMany({ where: { isActive: true, ...within(access) }, select: { employeeId: true, lastSeenAt: true, currentApp: true, currentTitle: true, currentIdle: true, pausedState: true, agentVersion: true, employee: { select: { id: true, department: true } } } }),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: { lte: today }, toDate: { gte: today }, ...within(access) }, select: { employeeId: true } }),
    overrideIndex(),
  ]);
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  const latest = new Map();
  devices.forEach((x) => { const cur = latest.get(x.employeeId); if (!cur || new Date(x.lastSeenAt || 0) > new Date(cur.lastSeenAt || 0)) latest.set(x.employeeId, x); });
  const rows = [];
  latest.forEach((dev, id) => {
    const mine = effective(cfg, rules, dev.employee);
    if (mine.excluded) return;
    let status = liveStatus(dev, onLeave.has(id), now);
    if (mine.breakStart && mine.breakStart <= nowHm && nowHm < mine.breakEnd && ['Online', 'Idle'].includes(status)) status = 'On break';
    const using = ['Online', 'Idle'].includes(status);
    const ld = liveDoing.get(id);
    const doing = status === 'Online' && ld && (now - ld.at) < ONLINE_MS ? (ld.doing || null) : null;
    rows.push({ employeeId: id, status, currentApp: using ? dev.currentApp || null : null, currentTitle: using && status === 'Online' ? dev.currentTitle || null : null, doing, lastHeartbeat: dev.lastSeenAt, online: using });
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { rows, cards: { online: count('Online'), idle: count('Idle'), offline: count('Offline') + count('Stopped') + count('Old agent'), closed: count('Laptop closed'), onBreak: count('On break') + count('Clocked out'), onLeave: count('On leave') } };
}

// The Live Dashboard / Overview of one day: every employee this login may see who has a registered PC.
async function overview(day, access = null) {
  const d = validDay(day) ? day : todayIst();
  const live = d === todayIst();
  const cfg = await settings();
  const nowHm = hmOf(Date.now());
  const [devices, logs, catOf, leaves, rules] = await Promise.all([
    prisma.monitoringDevice.findMany({ where: { isActive: true, ...within(access) }, select: { employeeId: true, lastSeenAt: true, currentApp: true, currentTitle: true, currentIdle: true, pausedState: true, agentVersion: true } }),
    prisma.activityLog.findMany({ where: { day: d, ...within(access) }, select: LOG_SELECT }).then(unmeet),
    categoryIndex(),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: { lte: d }, toDate: { gte: d }, ...within(access) }, select: { employeeId: true } }),
    overrideIndex(),
  ]);
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  const seen = [...new Set([...devices.map((x) => x.employeeId), ...logs.map((l) => l.employeeId)])];
  const emps = await employeesById(seen);
  const rulesOf = (id) => effective(cfg, rules, emps.get(id) || { id });
  const ids = seen.filter((id) => !rulesOf(id).excluded); // somebody not monitored is not on the board
  const byEmp = new Map(ids.map((id) => [id, []]));
  logs.forEach((l) => { if (byEmp.has(l.employeeId)) byEmp.get(l.employeeId).push(l); });
  const latest = new Map();
  devices.forEach((x) => { const cur = latest.get(x.employeeId); if (!cur || new Date(x.lastSeenAt || 0) > new Date(cur.lastSeenAt || 0)) latest.set(x.employeeId, x); });
  const now = Date.now();
  const MI = require('./monitoringInput'); // eslint-disable-line global-require
  const repeatsOf = await MI.stretches(ids, d).catch(() => new Map());
  const countsOfDay = await MI.countsOf(ids, d).catch(() => new Map());
  const rows = ids.map((id) => {
    const e = emps.get(id) || { id, name: 'Employee', department: null };
    const t = totalsOf(byEmp.get(id), catOf, e.department || '');
    const dev = latest.get(id) || null;
    let status = live ? liveStatus(dev, onLeave.has(id), now) : (onLeave.has(id) ? 'On leave' : null);
    const mine = rulesOf(id);
    if (live && mine.breakStart && mine.breakStart <= nowHm && nowHm < mine.breakEnd && ['Online', 'Idle'].includes(status)) status = 'On break'; // the lunch break
    const wd = workDayOf(d, mine, now);
    const fill = status === 'On leave' ? { active: 0, idle: 0, brk: 0, lunch: 0 } : gapFill(byEmp.get(id), wd, status, live, now);
    t.activeSeconds += fill.active; t.idleSeconds += fill.idle; t.breakSeconds += fill.brk; t.lunchSeconds += fill.lunch;
    t.activeHours = hrs(t.activeSeconds); t.idleHours = hrs(t.idleSeconds); t.breakHours = hrs(t.breakSeconds); t.lunchHours = hrs(t.lunchSeconds);
    const away = status === 'On leave' ? 0 : Math.max(0, wd.elapsedSeconds - t.activeSeconds - t.idleSeconds - t.breakSeconds - t.lunchSeconds);
    return {
      workStart: mine.workStart, workEnd: mine.workEnd, lunchStart: mine.breakStart || null, lunchEnd: mine.breakEnd || null,
      dayHours: hrs(wd.daySeconds), workHours: hrs(wd.workSeconds), personalBreakMinutes: Math.round(wd.personalSeconds / 60), elapsedHours: hrs(wd.elapsedSeconds), awayHours: hrs(away),
      employeeId: id, name: e.name, code: e.employeeCode || null, department: e.department || null, team: e.team || null,
      firstSeen: t.first, lastSeen: t.last, activeHours: t.activeHours, idleHours: t.idleHours, breakHours: t.breakHours, lunchHours: t.lunchHours, productivity: t.productivity,
      status, currentApp: live && dev && ['Online', 'Idle'].includes(status) ? dev.currentApp || null : null, currentTitle: live && dev && status === 'Online' ? dev.currentTitle || null : null,
      lastHeartbeat: dev ? dev.lastSeenAt : null, online: status === 'Online' || status === 'Idle',
      repeat: MI.summaryOf(repeatsOf.get(id)), // the same key / button over and over today, 10+ minutes at a time
      keys: countsOfDay.get(id) ? countsOfDay.get(id).keyTotal : null, clicks: countsOfDay.get(id) ? countsOfDay.get(id).clickTotal : null, // agent 2.6
      topKeys: countsOfDay.get(id) ? countsOfDay.get(id).keys.slice(0, 3).map((k) => `${k.name} ${k.count}`).join(' · ') : null,
    };
  }).sort((a, b) => b.activeHours - a.activeHours || String(a.name).localeCompare(String(b.name)));
  const withData = rows.filter((r) => r.activeHours || r.idleHours);
  const avg = (k) => (withData.length ? Math.round((withData.reduce((n, r) => n + r[k], 0) / withData.length) * 100) / 100 : 0);
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    day: d, live,
    cards: {
      tracked: new Set(devices.map((x) => x.employeeId).filter((id) => ids.includes(id))).size, online: count('Online'), idle: count('Idle'), offline: count('Offline') + count('Stopped') + count('Old agent'), closed: count('Laptop closed'), onLeave: count('On leave'),
      onBreak: count('On break') + count('Clocked out'), avgActiveHours: avg('activeHours'), avgIdleHours: avg('idleHours'),
    },
    // the work day of everybody on the board together (founder 2026-11-10: "mottham annitiki")
    total: (() => {
      const sum = (k) => Math.round(rows.reduce((n, r) => n + (Number(r[k]) || 0), 0) * 100) / 100;
      return { people: rows.length, activeHours: sum('activeHours'), idleHours: sum('idleHours'), breakHours: sum('breakHours'), lunchHours: sum('lunchHours'), awayHours: sum('awayHours'), workHours: sum('workHours'), dayHours: sum('dayHours'), elapsedHours: sum('elapsedHours') };
    })(),
    rows,
    departments: [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(),
    teams: [...new Set(rows.map((r) => r.team).filter(Boolean))].sort(),
  };
}

// A window title as one piece of work: "joinings [Protected View] - Excel" and "joinings - Excel" are the same file, "Recruiter Handover - Google Chrome" is the page.
const NO_TITLE = 'Not shown (the app does not say)';
const SITTING_GAP_MS = 2 * 60000; // back in the same app within 2 minutes: the same sitting
const APP_SUFFIX = /\s*[-–—|]\s*(Google Chrome|Microsoft​? Edge|Microsoft Edge|Mozilla Firefox|Brave|Opera|Excel|Word|PowerPoint|Outlook|File Explorer|Visual Studio Code|Notepad|Paint|Adobe Acrobat[^-]*)\s*$/i;
function itemOf(title, appLabel) {
  if (!title) return NO_TITLE;
  let t = String(title);
  for (let i = 0; i < 2; i += 1) t = t.replace(APP_SUFFIX, '');
  t = t.replace(/\s*[\u00b7|-]\s*TeamLink\.Enterprise$/i, '');
  t = t.replace(/\s*\[(Protected View|Read-Only|Compatibility Mode|Group|Shared)\]/gi, '').replace(/\s*-\s*Personal\s*-\s*Microsoft.*$/i, '').replace(/\s*-\s*Profile \d+$/i, '').trim();
  return t || String(appLabel || '') || NO_TITLE;
}
// WORK DONE IN EVERY APP AND WEBSITE (founder 2026-11-10: "remaining anni apps lo, anni website lo kuda ee format lo raavali"):
// the same Area / What was done / How many / First - last as TeamLink's own history, read from the window titles -
// which file, page, folder or chat was in front. Nothing typed is known, only what was open.
const OFFICE = { excel: ['Excel files', 'Worked on'], winword: ['Word documents', 'Worked on'], powerpnt: ['PowerPoint files', 'Worked on'], acrord32: ['PDF files', 'Read'], acrobat: ['PDF files', 'Read'], notepad: ['Text files', 'Worked on'], 'notepad++': ['Text files', 'Worked on'], mspaint: ['Pictures', 'Edited'], photos: ['Pictures', 'Looked at'], code: ['Code', 'Edited'] };
const TERMINALS = ['powershell', 'pwsh', 'cmd', 'windowsterminal', 'wt', 'conhost'];
const SITE_WORD = /^(YouTube|Gmail|LinkedIn|GitHub|Claude|ChatGPT|Google (Docs|Sheets|Slides|Drive|Search|Meet|Forms)|Naukri|Indeed|Facebook|Instagram|X|Twitter|Outlook|Zoom|Teams|Microsoft Teams|Canva|Notion|Wikipedia|Stack Overflow|WhatsApp|Vici\s?Dial)$/i;
function doneOf(appName, appLabel, kind, item) {
  const a = String(appName || '').toLowerCase();
  const raw = String(appLabel || appName || 'App');
  const label = raw.charAt(0).toUpperCase() + raw.slice(1);
  if (/snip|screenclip|screensketch/.test(a)) return { area: 'Screenshots', action: 'Took a screenshot' };
  if (/^(searchhost|searchapp|searchui)$/.test(a)) return { area: 'Windows search', action: 'Searched the PC' };
  const NONE = 'Used it (the window does not say for what)';
  if (!item || item === NO_TITLE) return { area: label, action: NONE };
  if (Object.values(CHAT_NAMES).includes(item)) return { area: 'Chat', action: `${item} (what was written is never recorded)` };
  if (Object.values(MAIL_NAMES).includes(item)) return { area: 'Mail', action: `${item} (mail content is never recorded)` };
  if (OFFICE[a]) return { area: OFFICE[a][0], action: `${OFFICE[a][1]} ${item}` };
  if (a === 'explorer') return { area: 'Folders', action: `Opened ${item}` };
  if (TERMINALS.includes(a)) return { area: 'Command window', action: item };
  if (item.toLowerCase() === label.toLowerCase() || item.toLowerCase() === a) return { area: label, action: NONE };
  if (BROWSERS.includes(a) || kind === 'site') {
    if (VICIDIAL.test(item)) return { area: 'ViciDial', action: 'On the dialer' };
    if (/^[\w.-]+\/[\w.-]+$/.test(item)) return { area: 'GitHub', action: `Repository ${item}` };
    const m = /^(.*\S)\s+[-\u2013\u2014|\u00b7:]\s+([^-\u2013\u2014|\u00b7]{2,32})$/.exec(item);
    if (m && (SITE_WORD.test(m[2].trim()) || kind !== 'site')) return { area: m[2].trim(), action: m[1].trim() };
    return { area: kind === 'site' ? label : 'Websites', action: item };
  }
  return { area: label, action: item };
}
function workDone(appName, appLabel, kind, items) {
  const map = new Map();
  items.forEach((x) => {
    const d = doneOf(appName, appLabel, kind, x.item);
    const k = `${d.area}|${d.action}`;
    const y = map.get(k) || { area: d.area, action: d.action, seconds: 0, count: 0, first: x.first, last: x.last, times: [] };
    y.seconds += x.seconds; y.count += x.pieces; y.times.push(...(x.times || []));
    if (x.first < y.first) y.first = x.first;
    if (x.last > y.last) y.last = x.last;
    map.set(k, y);
  });
  // WHEN, IN DETAIL (founder 2026-11-11: "what was done inka clear ga, in detail ga vundali"): every stretch it was open, from - to
  return [...map.values()].sort((p, q) => q.seconds - p.seconds).map((y) => ({
    ...y, first: new Date(y.first), last: new Date(y.last),
    times: y.times.sort((p, q) => p.start - q.start).slice(0, 60).map((t) => ({ start: new Date(t.start), end: new Date(t.end), seconds: Math.round(t.seconds) })),
  }));
}
// The saves a person made in TeamLink in a period, from the audit history: one line per kind of work, with how many and when.
const ENTITY_WORD = { Application: 'Candidate pipeline', Candidate: 'Candidates', Requirement: 'Requirements', Client: 'Clients', Task: 'Tasks', FollowUp: 'Follow-ups', Interview: 'Interviews', Employee: 'Employees', LeaveRequest: 'Leave', User: 'Sign-in', AttendancePunch: 'Attendance' };
async function teamlinkWorkOf(employeeId, a, b) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
  if (!emp || !emp.userId) return { lines: [], total: 0 };
  const rows = await prisma.auditLog.findMany({
    where: { userId: emp.userId, createdAt: { gte: atIst(a, '00:00'), lt: atIst(addDays(b, 1), '00:00') } },
    orderBy: { createdAt: 'asc' }, take: 5000, select: { entity: true, action: true, createdAt: true, entityId: true, fromValue: true, toValue: true, fieldLabel: true },
  });
  // WHAT EXACTLY (founder 2026-11-11: "what was done inka clear ga, in detail ga vundali"): the task's name, the candidate and the job,
  // the requirement, the client, the employee - and the change itself (Screening -> Sent to client), for every save
  const ids = (ent) => [...new Set(rows.filter((r) => r.entity === ent && r.entityId).map((r) => r.entityId))];
  const pick = (p) => p.catch(() => []);
  const [tasks, apps, cands, reqs, clients, emps] = await Promise.all([
    pick(prisma.task.findMany({ where: { id: { in: ids('Task') } }, select: { id: true, name: true } })),
    pick(prisma.application.findMany({ where: { id: { in: ids('Application') } }, select: { id: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } } })),
    pick(prisma.candidate.findMany({ where: { id: { in: ids('Candidate') } }, select: { id: true, name: true } })),
    pick(prisma.requirement.findMany({ where: { id: { in: ids('Requirement') } }, select: { id: true, title: true } })),
    pick(prisma.client.findMany({ where: { id: { in: ids('Client') } }, select: { id: true, name: true } })),
    pick(prisma.employee.findMany({ where: { id: { in: ids('Employee') } }, select: { id: true, name: true } })),
  ]);
  const NAME = new Map([
    ...tasks.map((x) => [`Task|${x.id}`, x.name]),
    ...apps.map((x) => [`Application|${x.id}`, [x.candidate && x.candidate.name, x.requirement && x.requirement.title].filter(Boolean).join(' · ')]),
    ...cands.map((x) => [`Candidate|${x.id}`, x.name]), ...reqs.map((x) => [`Requirement|${x.id}`, x.title]),
    ...clients.map((x) => [`Client|${x.id}`, x.name]), ...emps.map((x) => [`Employee|${x.id}`, x.name]),
  ]);
  const STAGE = require('./atsVocab').STAGE_LABELS || {}; // eslint-disable-line global-require
  const word = (v) => { const t = String(v == null ? '' : v).trim(); return STAGE[t] || t; };
  const map = new Map();
  rows.forEach((r) => {
    const full = String(r.action || '').trim();
    const action = full.replace(/\s*\(.*$/, '').trim().slice(0, 120) || 'Saved';
    const k = `${r.entity}|${action}`;
    const x = map.get(k) || { area: ENTITY_WORD[r.entity] || String(r.entity || 'Other').replace(/([a-z])([A-Z])/g, '$1 $2'), action, count: 0, first: r.createdAt, last: r.createdAt, items: [] };
    x.count += 1; x.last = r.createdAt;
    if (x.items.length < 100) {
      const from = word(r.fromValue); const to = word(r.toValue);
      // eslint-disable-next-line no-nested-ternary
      const change = from && to ? `${from} → ${to}` : to ? `${r.fieldLabel ? `${r.fieldLabel}: ` : ''}${to}` : '';
      const note = full.length > action.length ? full.slice(action.length).replace(/^\s*\(|\)\s*$/g, '').trim() : '';
      x.items.push({ at: r.createdAt, what: (NAME.get(`${r.entity}|${r.entityId}`) || '').slice(0, 140), change: change.slice(0, 200), note: note.slice(0, 160) });
    }
    map.set(k, x);
  });
  return { total: rows.length, lines: [...map.values()].sort((x, y) => y.count - x.count) };
}
// One employee over a few days: the day's timeline (one day), the top apps, the usage table, the totals.
// Every website looked at in a browser, out of its already-cleaned window title, so each one becomes its own row instead of all
// being lumped under "chrome" (founder 2026-11-12: "use chetshunna anni tabs ikkada display avvali ... wtsp tho sahaa"). Chat and
// mail keep their service name only. A tab only open in the background and never looked at cannot be known - the PC sees the tab in
// front, nothing else - and that is said on screen.
const BROWSER_SUFFIX = /\s[-\u2013\u2014|]\s(Google Chrome|Microsoft.*Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Internet Explorer|Safari)\s*$/i;
// A private / incognito window is still tracked (founder 2026-11-13): the OS gives us the window title either way - incognito only
// hides the browser's own history - so we strip the Incognito / InPrivate / Private Browsing marker to show the REAL site, and flag it.
const INCOGNITO = /(incognito|inprivate|private[ -]?browsing)/i;
const INCOG_STRIP = /[([{|-]\s*(incognito|inprivate|private[ -]?browsing)\s*[)\]}]?/ig;
function deriveSite(app, shown) {
  if (!shown || !BROWSERS.includes(String(app).toLowerCase())) return null;
  if (VICIDIAL.test(shown)) return INCOGNITO.test(shown) ? 'ViciDial (incognito)' : 'ViciDial';
  const incog = INCOGNITO.test(shown);
  const t = String(shown).replace(INCOG_STRIP, ' ').replace(BROWSER_SUFFIX, '').trim();
  if (!t) return incog ? 'Incognito page' : null;
  const segs = t.split(/\s[-\u2013\u2014|]\s/).map((x) => x.trim()).filter(Boolean);
  const site = (segs[segs.length - 1] || '').replace(/^[\s–—|-]+/, '').trim().slice(0, 60);
  if (!site) return incog ? 'Incognito page' : null;
  return incog ? `${site} (incognito)` : site;
}
// The misuse list for a viewer (founder 2026-11-12): every continuous single-button stretch the viewer may see, with the person's
// name and a remark. HR / Admin see everyone; a team lead sees their team. The agent warns the employee on their own screen as it happens.
async function misuseList(from, to, access = null, min = 2) {
  const MI = require('./monitoringInput'); // eslint-disable-line global-require
  const allowed = access && access.ids ? access.ids : null;
  const events = await MI.misuse(allowed, from, to, { min }).catch(() => []);
  if (!events.length) return { from, to, min, events: [], people: 0 };
  const ids = [...new Set(events.map((e) => e.employeeId))];
  const [emps, logs, catOf] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true, department: true } }),
    prisma.activityLog.findMany({ where: { employeeId: { in: ids }, day: { gte: from, lte: to }, isIdle: false, isBreak: false }, select: { employeeId: true, appName: true, windowTitle: true, startTime: true, endTime: true } }),
    categoryIndex(),
  ]);
  const by = new Map(emps.map((e) => [e.id, e]));
  const segsByEmp = new Map();
  logs.forEach((l) => { if (!segsByEmp.has(l.employeeId)) segsByEmp.set(l.employeeId, []); segsByEmp.get(l.employeeId).push(l); });
  // which app / website was in front while the same button was pressed over and over - the one that overlapped the stretch most
  // (founder 2026-11-12: "ey platform lo vundi chesthunnaro kuda telyalai ga, ey app or website ani"). Taken from the activity
  // already recorded, so it shows even for rows from before this change. A browser tab shows the website only; chat / mail, the service.
  const placeOf = (employeeId, fromISO, toISO, dept) => {
    const a = Date.parse(fromISO); const b = Date.parse(toISO);
    const segs = segsByEmp.get(employeeId) || [];
    const over = new Map();
    segs.forEach((l) => {
      const s = new Date(l.startTime).getTime(); const e = new Date(l.endTime).getTime();
      const ov = Math.min(b, e) - Math.max(a, s);
      if (ov <= 0) return;
      let c = catOf(l.appName, l.windowTitle, dept);
      if (c.kind !== 'site') { const w = deriveSite(l.appName, cleanTitle(l.appName, l.windowTitle)); if (w) c = { label: w, kind: 'site' }; }
      const cur = over.get(c.label) || { seconds: 0, kind: c.kind };
      cur.seconds += ov; over.set(c.label, cur);
    });
    let best = null;
    over.forEach((v, label) => { if (!best || v.seconds > best.seconds) best = { place: label, placeKind: v.kind }; });
    return best || { place: '', placeKind: '' };
  };
  const withName = events.map((e) => {
    const emp = by.get(e.employeeId) || {};
    const p = placeOf(e.employeeId, e.from, e.to, emp.department || '');
    return { ...e, name: emp.name || 'Employee', code: emp.employeeCode || '', department: emp.department || '', place: p.place, placeKind: p.placeKind };
  });
  return { from, to, min, events: withName, people: ids.length };
}
async function employeeDetail(employeeId, from, to) {
  const t = todayIst();
  let a = validDay(from) ? from : t;
  let b = validDay(to) ? to : a;
  if (b < a) [a, b] = [b, a];
  if (addDays(a, 92) < b) a = addDays(b, -92);
  const [emp, logs, catOf] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, employeeCode: true, department: true, designation: true } }),
    prisma.activityLog.findMany({ where: { employeeId, day: { gte: a, lte: b } }, orderBy: { startTime: 'asc' }, select: LOG_SELECT }).then(unmeet),
    categoryIndex(),
  ]);
  if (!emp) return null;
  const dept = emp.department || '';
  const totals = totalsOf(logs, catOf, dept);
  const usage = new Map();
  logs.filter((l) => !l.isIdle && !l.isBreak).forEach((l) => {
    // the same cleaning on the way out: records kept before a rule changed never show more than it allows
    const shown = cleanTitle(l.appName, l.windowTitle);
    let c = catOf(l.appName, l.windowTitle, dept);
    // a browser tab that did not already match a website rule: make the site from its title, so every site shows (never "chrome" only)
    if (c.kind !== 'site') { const w = deriveSite(l.appName, shown); if (w) c = { key: `web:${w.toLowerCase()}`, label: w, kind: 'site', category: c.category }; }
    // ViciDial's tabs ("Agent web client", "Campaign Login") all roll up under one ViciDial, whatever a rule named them (founder 2026-11-13)
    if (isVici(l.appName, l.windowTitle) || isVici(l.appName, shown)) c = { key: 'web:vicidial', label: 'ViciDial', kind: 'site', category: c.category };
    const u = usage.get(c.key) || { key: c.key, name: c.label, kind: c.kind, category: c.category, seconds: 0, titles: new Map(), items: new Map(), sittings: [] };
    u.seconds += l.durationSeconds;
    if (shown) u.titles.set(shown, (u.titles.get(shown) || 0) + l.durationSeconds);
    // WHAT IT WAS USED FOR (founder 2026-11-10: "claude meedha click chesthe, claude lo em use chesaro clear ga kanipinchali - complete work cover avvali"):
    // every page, file or chat the window showed, with its time, and the sittings in order
    const item = itemOf(shown, c.label);
    const st = new Date(l.startTime).getTime(); const en = new Date(l.endTime).getTime();
    if (!u.appName) u.appName = l.appName;
    const it = u.items.get(item) || { item, seconds: 0, first: st, last: en, pieces: 0, times: [] };
    it.seconds += l.durationSeconds; it.first = Math.min(it.first, st); it.last = Math.max(it.last, en); it.pieces += 1;
    const lastT = it.times[it.times.length - 1];
    if (lastT && st - lastT.end <= SITTING_GAP_MS) { lastT.end = Math.max(lastT.end, en); lastT.seconds += l.durationSeconds; } else it.times.push({ start: st, end: en, seconds: l.durationSeconds });
    u.items.set(item, it);
    const prev = u.sittings[u.sittings.length - 1];
    if (prev && st - prev.end <= SITTING_GAP_MS) { prev.end = Math.max(prev.end, en); prev.seconds += l.durationSeconds; prev.items.set(item, (prev.items.get(item) || 0) + l.durationSeconds); } else u.sittings.push({ start: st, end: en, seconds: l.durationSeconds, items: new Map([[item, l.durationSeconds]]) });
    usage.set(c.key, u);
  });
  const apps = [...usage.values()].sort((x, y) => y.seconds - x.seconds).map((u) => ({
    key: u.key, name: u.name, kind: u.kind, category: u.category, seconds: u.seconds, hours: hrs(u.seconds),
    topTitles: [...u.titles.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([title, sec]) => ({ title, minutes: Math.round(sec / 60) })),
    done: workDone(u.appName, u.name, u.kind, [...u.items.values()]),
    items: [...u.items.values()].sort((x, y) => y.seconds - x.seconds).map((x) => ({ item: x.item, seconds: x.seconds, first: new Date(x.first), last: new Date(x.last), opened: x.pieces })),
    // the app's own name only (e.g. the Claude desktop app always says "Claude"): only the time is known
    titlesKnown: [...u.items.keys()].some((k) => k !== NO_TITLE && k.toLowerCase() !== String(u.name).toLowerCase()),
    sittings: u.sittings.slice(-300).map((x) => ({ start: new Date(x.start), end: new Date(x.end), seconds: x.seconds, items: [...x.items.entries()].sort((p, q) => q[1] - p[1]).map(([item, sec]) => ({ item, seconds: sec })) })),
  }));
  const days = [...new Set(logs.map((l) => l.day))].sort();
  const perDay = days.map((d) => ({ day: d, ...totalsOf(logs.filter((l) => l.day === d), catOf, dept) }));
  // WHAT THEY DID IN TEAMLINK ITSELF (founder 2026-11-10: "topics kuda display avvali"): TeamLink's own history of this login's
  // saves - "Candidate: Application stage changed x 12" - so the TeamLink website shows the work, not only "TeamLink.Enterprise"
  const tl = apps.find((x) => /teamlink/i.test(`${x.key} ${x.name}`));
  if (tl) tl.teamlinkWork = await teamlinkWorkOf(emp.id, a, b).catch(() => null);
  const s = await settings();
  // the same key / button over and over (agent 2.5, utils/monitoringInput.js)
  const repeats = ((await require('./monitoringInput').stretches([emp.id], a, b).catch(() => new Map())).get(emp.id)) || []; // eslint-disable-line global-require
  // how many times each key / button (agent 2.6): letter keys and number keys as one count each
  const keyCounts = ((await require('./monitoringInput').countsOf([emp.id], a, b).catch(() => new Map())).get(emp.id)) || null; // eslint-disable-line global-require
  // active typing / mouse time and typing intensity (agent 2.8)
  const activity = ((await require('./monitoringInput').activityOf([emp.id], a, b).catch(() => new Map())).get(emp.id)) || null; // eslint-disable-line global-require
  return {
    employee: emp, from: a, to: b, totals, apps, top10: apps.slice(0, 10), perDay, repeats, keyCounts, activity,
    // the timeline of one day: one bar, active / idle / break
    timeline: a === b ? (() => {
      let left = PERSONAL_BREAK_SECONDS * 1000; // the personal break: the first 15 minutes of idle (drawn as break, like the totals)
      const out = [];
      logs.forEach((l) => {
        const st = new Date(l.startTime).getTime(); const en = new Date(l.endTime).getTime();
        if (l.isIdle && !l.isBreak && left > 0) {
          const cut = Math.min(en, st + left); left -= cut - st;
          out.push({ start: new Date(st), end: new Date(cut), idle: false, break: true, app: 'Personal break' });
          if (cut < en) out.push({ start: new Date(cut), end: new Date(en), idle: true, break: false, app: l.appName, title: l.windowTitle ? cleanTitle(l.appName, l.windowTitle) : null });
        } else out.push({ start: l.startTime, end: l.endTime, idle: l.isIdle, break: l.isBreak, app: l.appName, title: l.isBreak || !l.windowTitle ? null : cleanTitle(l.appName, l.windowTitle) });
        // the window title too (founder 2026-11-11: a click on the day bar shows what was open then, in detail)
      });
      return out;
    })() : null,
    workStart: s.workStart, workEnd: s.workEnd,
  };
}

function rangeOf(from, to, days) {
  const t = todayIst();
  let a = validDay(from) ? from : addDays(t, -6);
  let b = validDay(to) ? to : t;
  if (b < a) [a, b] = [b, a];
  if (addDays(a, days) < b) a = addDays(b, -days);
  return [a, b];
}
// The reports. view: employee (one row per person), daily (one row per person per day, with login and logout), team (per department).
async function reportRows(from, to, department, access = null, view = 'employee') {
  const [a, b] = rangeOf(from, to, 366);
  const L = require('./monitoringLinks'); // eslint-disable-line global-require
  if (view === 'payroll') return L.payrollRows(a, b, department, access);
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const logs = unmeet(await prisma.activityLog.findMany({ where: { day: { gte: a, lte: b }, ...within(access) }, select: LOG_SELECT }));
  const catOf = await categoryIndex();
  const ids = [...new Set(logs.map((l) => l.employeeId))];
  const emps = await employeesById(ids);
  const deptOf = (id) => (emps.get(id) || {}).department || '';
  const kept = logs.filter((l) => !department || deptOf(l.employeeId) === department);
  const group = (keyOf) => { const m = new Map(); kept.forEach((l) => { const k = keyOf(l); if (!m.has(k)) m.set(k, []); m.get(k).push(l); }); return m; };
  const base = (list, dept) => {
    const x = totalsOf(list, catOf, dept);
    return {
      days: new Set(list.map((l) => l.day)).size, login: x.first, logout: x.last, activeHours: x.activeHours, idleHours: x.idleHours, breakHours: x.breakHours, lunchHours: x.lunchHours,
      productiveHours: hrs(x.productiveSeconds), unproductiveHours: hrs(x.unproductiveSeconds), productivity: x.productivity,
    };
  };
  let rows;
  if (view === 'team') {
    rows = [...group((l) => deptOf(l.employeeId) || 'No department').entries()].map(([name, list]) => {
      // each person is scored by their own department's rules
      const parts = [...new Set(list.map((l) => l.employeeId))].map((id) => base(list.filter((l) => l.employeeId === id), deptOf(id)));
      const sum = (k) => Math.round(parts.reduce((n, p) => n + p[k], 0) * 100) / 100;
      const active = sum('activeHours'); const productive = sum('productiveHours');
      return {
        key: name, name, employees: parts.length, activeHours: active, idleHours: sum('idleHours'), breakHours: sum('breakHours'), lunchHours: sum('lunchHours'),
        productiveHours: productive, unproductiveHours: sum('unproductiveHours'), productivity: active ? Math.round((productive / active) * 100) : null,
      };
    }).sort((p, q) => String(p.name).localeCompare(String(q.name)));
  } else if (view === 'daily') {
    rows = [...group((l) => `${l.employeeId}|${l.day}`).entries()].map(([k, list]) => {
      const [id, day] = k.split('|');
      const e = emps.get(id) || {};
      return { key: k, employeeId: id, day, dayType: WD.isWorking(day) ? null : 'Holiday / week off', name: e.name || 'Employee', code: e.employeeCode || null, department: e.department || null, ...base(list, e.department || '') };
    }).sort((p, q) => q.day.localeCompare(p.day) || String(p.name).localeCompare(String(q.name)));
  } else {
    rows = [...group((l) => l.employeeId).entries()].map(([id, list]) => {
      const e = emps.get(id) || {};
      return { key: id, employeeId: id, name: e.name || 'Employee', code: e.employeeCode || null, department: e.department || null, ...base(list, e.department || '') };
    }).sort((p, q) => String(p.name).localeCompare(String(q.name)));
  }
  return { from: a, to: b, view, rows, departments: [...new Set([...emps.values()].map((e) => e.department).filter(Boolean))].sort() };
}

// App & website usage over a period: top apps, top websites, the split, per department.
async function usage(from, to, department, access = null) {
  const [a, b] = rangeOf(from, to, 366);
  const logs = await prisma.activityLog.findMany({ where: { day: { gte: a, lte: b }, isIdle: false, isBreak: false, ...within(access) }, select: LOG_SELECT });
  const catOf = await categoryIndex();
  const emps = await employeesById([...new Set(logs.map((l) => l.employeeId))]);
  const deptOf = (id) => (emps.get(id) || {}).department || '';
  const apps = new Map(); const split = { productive: 0, neutral: 0, unproductive: 0, unset: 0 }; const teams = new Map();
  logs.filter((l) => !department || deptOf(l.employeeId) === department).forEach((l) => {
    const dept = deptOf(l.employeeId);
    const c = catOf(l.appName, l.windowTitle, dept);
    const u = apps.get(c.key) || { key: c.key, name: c.label, kind: c.kind, category: c.category, seconds: 0, people: new Set() };
    u.seconds += l.durationSeconds; u.people.add(l.employeeId);
    apps.set(c.key, u);
    const cat = c.category || 'unset';
    split[cat] += l.durationSeconds;
    const t = teams.get(dept || 'No department') || { name: dept || 'No department', productive: 0, neutral: 0, unproductive: 0, unset: 0 };
    t[cat] += l.durationSeconds;
    teams.set(t.name, t);
  });
  const list = [...apps.values()].sort((x, y) => y.seconds - x.seconds).map((u) => ({ key: u.key, name: u.name, kind: u.kind, category: u.category, hours: hrs(u.seconds), minutes: Math.round(u.seconds / 60), people: u.people.size }));
  const inHours = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? hrs(v) : v]));
  return {
    from: a, to: b, topApps: list.filter((x) => x.kind === 'app').slice(0, 20), topSites: list.filter((x) => x.kind === 'site').slice(0, 20),
    split: inHours(split), byDepartment: [...teams.values()].map(inHours).sort((p, q) => String(p.name).localeCompare(String(q.name))),
    departments: [...new Set([...emps.values()].map((e) => e.department).filter(Boolean))].sort(),
  };
}

// Apps seen in the last 30 days that have no rule yet (to mark them).
async function uncategorised() {
  const since = addDays(todayIst(), -30);
  const logs = await prisma.activityLog.groupBy({ by: ['appName'], where: { day: { gte: since }, isIdle: false, isBreak: false }, _sum: { durationSeconds: true } });
  const known = new Set((await prisma.appCategory.findMany({ where: { kind: 'app', department: '' }, select: { appName: true } })).map((c) => c.appName.toLowerCase()));
  return logs.filter((g) => !known.has(String(g.appName).toLowerCase()) && g.appName !== 'Break')
    .map((g) => ({ appName: g.appName, hours: hrs(g._sum.durationSeconds || 0) }))
    .sort((x, y) => y.hours - x.hours).slice(0, 100);
}

// The audit log of this module: who looked at whose data, what was exported, settings, PCs.
const AUDIT_ENTITIES = ['Monitoring', 'MonitoringDevice', 'MonitoringSetting', 'ActivityLog'];
// ---------------------------------------------------------------------------
// DATA SECURITY - WHO TOOK CANDIDATE / CLIENT DATA OUT (founder 2026-11-12: "candidate-data-theft detection", the 360-review pick).
// Every export already writes an audit row (utils/exportKit.js: "<what> exported (XLSX)", entity, "N row(s) · scope: ... · range").
// Here those rows for the crown-jewel data - candidates, clients, requirements, applications - are gathered, the row count read out,
// and a one-shot BULK PULL (BIG_EXPORT rows or more at once, e.g. a recruiter taking the database before leaving) is flagged. Only
// counts and scope are shown, never the data itself.
const DATA_ENTITIES = ['Candidate', 'Client', 'Application', 'Requirement'];
const BIG_EXPORT = 200;
async function dataSecurity(from, to) {
  const [a, b] = rangeOf(from, to, 184);
  const rows = await prisma.auditLog.findMany({
    where: { action: { contains: 'exported' }, entity: { in: DATA_ENTITIES }, createdAt: { gte: atIst(a, '00:00'), lte: new Date(atIst(b, '23:59').getTime() + 60000) } },
    orderBy: { createdAt: 'desc' }, take: 3000,
    select: { id: true, createdAt: true, action: true, entity: true, toValue: true, actorName: true, userId: true, user: { select: { name: true } } },
  });
  const events = rows.map((r) => {
    const who = r.actorName || (r.user && r.user.name) || 'TeamLink';
    const m = /([\d,]+)\s*row/.exec(r.toValue || '');
    const n = m ? Number(m[1].replace(/,/g, '')) : null;
    const fmt = (/(XLSX|CSV|PDF)/i.exec(r.action) || [])[1] || '';
    const sc = (/scope:\s*([^\u00b7]+)/i.exec(r.toValue || '') || [])[1];
    const kind = r.action.replace(/\s*exported.*$/i, '').trim();
    return { id: r.id, at: r.createdAt, who, userId: r.userId || null, entity: r.entity, kind, format: String(fmt).toUpperCase(), rows: n, scope: sc ? sc.trim() : '', bulk: n != null && n >= BIG_EXPORT };
  });
  const byP = new Map();
  events.forEach((e) => { const k = e.userId || e.who; const o = byP.get(k) || { who: e.who, exports: 0, rows: 0, bulk: 0 }; o.exports += 1; o.rows += e.rows || 0; if (e.bulk) o.bulk += 1; byP.set(k, o); });
  const byPerson = [...byP.values()].sort((x, y) => y.rows - x.rows || y.exports - x.exports);
  const totals = { exports: events.length, rows: events.reduce((s, e) => s + (e.rows || 0), 0), people: byP.size, bulk: events.filter((e) => e.bulk).length };
  return { from: a, to: b, big: BIG_EXPORT, events, byPerson, totals };
}
async function auditRows(from, to) {
  const [a, b] = rangeOf(from, to, 366);
  const rows = await prisma.auditLog.findMany({
    where: { entity: { in: AUDIT_ENTITIES }, createdAt: { gte: atIst(a, '00:00'), lte: new Date(atIst(b, '23:59').getTime() + 60000) } },
    orderBy: { createdAt: 'desc' }, take: 1000,
    select: { id: true, createdAt: true, action: true, toValue: true, actorName: true, user: { select: { name: true } } },
  });
  return { from: a, to: b, rows: rows.map((r) => ({ id: r.id, at: r.createdAt, who: r.actorName || (r.user && r.user.name) || 'TeamLink', action: r.action, detail: r.toValue || null })) };
}

// ATTENDANCE: the first and last PC activity of each day (shown as "PC activity"; it never changes the marked attendance).
async function pcActivity(employeeIds, from, to) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await prisma.activityLog.groupBy({
    by: ['employeeId', 'day'],
    where: { employeeId: { in: employeeIds }, day: { gte: from, lte: to } },
    _min: { startTime: true }, _max: { endTime: true },
  }).catch(() => []);
  rows.forEach((r) => out.set(`${r.employeeId}|${r.day}`, { first: r._min.startTime, last: r._max.endTime }));
  return out;
}

// --- the download: one file that runs on a double-click ---------------------------------------------------------------------
// Windows opens a .ps1 in Notepad on a double-click (founder 2026-11-05: "download chesaka, ilaa vachindhi"). So the download is a
// .cmd holding the agent: it writes the agent to %APPDATA%\TeamLinkMonitor and runs it. It installs nothing else, and the notice
// and sign-in still come first. payload: the agent's text (tests pass a small script).
function agentSetupFile(payload) {
  const text = payload === undefined
    ? require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'agent', 'TeamLinkMonitor.ps1'), 'utf8') // eslint-disable-line global-require
    : payload;
  return [
    '@echo off',
    'title TeamLink Monitor',
    'setlocal',
    'set "TLDIR=%APPDATA%\\TeamLinkMonitor"',
    'if not exist "%TLDIR%" mkdir "%TLDIR%"',
    'set "TLSELF=%~f0"',
    'echo Starting TeamLink Monitor...',
    // the marker is built in two parts here, so the only whole one in this file is the line above the agent
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:TLSELF); $m=\':\'+\'::TEAMLINK-AGENT\'; $i=$t.IndexOf($m); [IO.File]::WriteAllText((Join-Path $env:TLDIR \'TeamLinkMonitor.ps1\'), $t.Substring($i+$m.Length).TrimStart())"',
    'if not "%errorlevel%"=="0" goto failed',
    // on its own, as Windows starts it: under Windows Terminal an agent left in this window cannot hide it, and closing it stopped the agent
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath powershell -WindowStyle Hidden -ArgumentList (\'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \'+[char]34+$env:TLDIR+\'\\TeamLinkMonitor.ps1\'+[char]34)"',
    'if not "%errorlevel%"=="0" goto failed',
    'exit /b 0',
    ':failed',
    'echo.',
    'echo TeamLink Monitor could not start. Please show this window to HR or IT.',
    'pause',
    'exit /b 1',
    ':::TEAMLINK-AGENT',
    String(text).replace(/\r\n/g, '\n'),
  ].join('\n').replace(/\n/g, '\r\n');
}

// The .exe: a small program (agent/setup/TeamLinkSetup.cs, built on Windows, kept in the repository) with the agent appended.
function agentInstaller() {
  const fs = require('fs'); // eslint-disable-line global-require
  const stub = fs.readFileSync(require('path').join(__dirname, '..', '..', 'agent', 'TeamLinkMonitorSetup-stub.exe')); // eslint-disable-line global-require
  return Buffer.concat([stub, Buffer.from('::TEAMLINK-PAYLOAD::', 'ascii'), latestAgent().bytes]);
}

// --- retention ------------------------------------------------------------------------------------------------------------------
async function purge() {
  const s = await settings();
  const cutoff = addDays(todayIst(), -s.retentionDays);
  const r = await prisma.activityLog.deleteMany({ where: { day: { lt: cutoff } } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'monitoring.attdismiss.' }, updatedAt: { lt: new Date(`${cutoff}T00:00:00Z`) } } }).catch(() => {});
  await prisma.monitoringAlert.deleteMany({ where: { day: { lt: cutoff } } });
  await require('./monitoringInput').cleanup(s.retentionDays).catch(() => {}); // eslint-disable-line global-require
  return r.count;
}
let TIMER = null;
function startSweep() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  const tick = () => purge().then((n) => { if (n) console.log(`[monitoring] ${n} old activity record(s) deleted`); }).catch((e) => console.error('[monitoring]', e.message)); // eslint-disable-line no-console
  setTimeout(tick, 5 * 60000).unref?.();
  TIMER = setInterval(tick, 6 * 3600000);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  liveUpdate, liveRows, liveStatus, workDayOf, gapFill, istTime, hmOf, addDays, validDay, shiftDay, atShift, overrideIndex, effective, saveOverride, listOverrides, removeOverride, latestAgent, needsUpdate, isSuper, isIt, isItIn, canManageDevices, totalsOf, newSetupCode, readSetupCode, endSetupCode, agentSetupFile, agentInstaller, CATEGORIES, DEFAULT_POLICY, AUDIT_ENTITIES, isMonitorAdmin, accessOf, heartbeat, usage, auditRows, dataSecurity, settings, saveSettings, hasConsent, recordConsent, hashToken, deviceOf, registerDevice, misuseList,
  ingest, categoryIndex, overview, employeeDetail, reportRows, uncategorised, pcActivity, purge, startSweep, todayIst, istDay, cleanTitle,
};

// ---------------------------------------------------------------------------
// SCHEDULED REMINDERS TO THE CANDIDATE: an OFFLINE / ONLINE / PHONE INTERVIEW and a JOINING
// (founder 2026-11-20: "when a candidate has an offline interview or a joining 2 days later, make the system automatically send them
// SCHEDULED messages. At what time the message goes, how many times it goes: the respective TL and recruiter look at that. And once it is
// scheduled, along with the candidate, it must also DISPLAY in the TL's and the recruiter's logins.")
//
//   A PLAN = rows of the raw table "ScheduledReminder" (created on first use, no migration), one per message, per application and event
//   (kind interview | joining). The plan is made when an interview is booked / a joining date is set (utils/scheduledReminders.sync is
//   called by those routes), MOVES when the interview / joining moves, is CANCELLED when it is cancelled, done, or the person is rejected
//   or drops. It is idempotent: the same slot saved twice makes no second row (key: application + kind + event time + step + channel).
//
//   DEFAULT STEPS (Admin edits, per department; the recruiter / TL edit them per event, 0 to 5 messages):
//     interview   2 days before 10:00 . 1 day before 17:00 . 2 hours before        (a booking the same day also sends the details at once)
//     joining     2 days before 10:00 . 1 day before 17:00 . the morning of the joining 08:00
//   Nothing goes before the EARLIEST hour (07:00) or after the LATEST hour (20:00) India time. A step that is already behind us is
//   dropped and the rest are kept.
//
//   SENDING: run() (every 5 minutes on the real server only) sends the due `planned` rows through utils/messaging.send with the CRM's
//   WhatsApp rule (free text only inside the 24-hour window, else the company's general template with the message as its blank),
//   credits + the Omni ledger, STOP / do-not-contact / test people respected, 3 tries with back-off, one message per candidate per event
//   time. A row whose interview / joining is cancelled, done, moved, or whose person is rejected / dropped / opted out is `skipped` with the
//   reason. Delivery ticks come back through utils/messageDelivery (applyDeliveryStatus).
//   THE ONE SWITCH: AppSetting "reminders-settings".enabled, OFF until the founder turns it on. While OFF the plan is still made and shown
//   ("will not be sent: reminders are switched off") and the in-app bells to the recruiter and TL about the plan always go; NOTHING is sent.
//
//   WHO SEES IT: the recruiter, the team lead (TL / STL), Manager and Admin see the messages; the BDE team sees only the COUNT (never the
//   text); a recruiter edits only their own candidates' plans (application scope).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');

const SETTINGS_KEY = 'reminders-settings';
const TEMPLATES_KEY = 'reminders-templates';
const KINDS = ['interview', 'joining'];
const CHANNELS = ['WhatsApp', 'SMS', 'Email'];
const LANGS = ['en', 'te'];
const LANG_NAME = { en: 'English', te: 'Telugu' };
const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_STEPS = 5;
const MAX_TRIES = 3;
const BACKOFF_MIN = [5, 30]; // after try 1, after try 2
const STALE_MS = 3 * HOUR; // a step more than this late (the server was off / the switch was off) is not sent any more
const LIVE_INTERVIEW = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
const JOINING_STAGES_OK = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const isTestPerson = (s) => /zztest|example\.test/i.test(String(s || ''));
const sandboxOn = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require

// ------------------------------------------------------------------ settings
const DEFAULT_STEPS = {
  interview: [{ days: 2, at: '10:00' }, { days: 1, at: '17:00' }, { hours: 2 }],
  joining: [{ days: 2, at: '10:00' }, { days: 1, at: '17:00' }, { days: 0, at: '08:00' }],
};
const DEFAULTS = {
  enabled: false,
  channels: { WhatsApp: true, SMS: true, Email: true },
  earliestHour: 7,
  latestHour: 20,
  nameClient: false, // the candidate never learns the client's name unless an Admin switches this on (rule of utils/interviewMessageDefaults.js)
  schedule: { interview: DEFAULT_STEPS.interview, joining: DEFAULT_STEPS.joining, departments: {} },
  carry: {
    interview: 'ID proof, updated resume',
    joining: 'ID proof, education and experience certificates, passport size photos, bank account details',
  },
  joiningReportingTime: '09:30',
};

const validHm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const txtML = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);

// one step: { days, at } (that many days before, at HH:MM India time) or { hours } (that many hours before the event)
function cleanStep(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.hours !== undefined && s.hours !== null && s.hours !== '') {
    const h = intIn(s.hours, 1, 48, null);
    return h ? { hours: h } : null;
  }
  const d = intIn(s.days, 0, 30, null);
  if (d === null) return null;
  return { days: d, at: validHm(s.at) ? s.at : '10:00' };
}
function cleanSteps(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const out = [];
  list.forEach((s) => { const c = cleanStep(s); if (c && !out.some((o) => stepKeyOf(o) === stepKeyOf(c))) out.push(c); });
  return out.slice(0, MAX_STEPS);
}
function stepKeyOf(s) { return s.hours ? `H${s.hours}` : `D${s.days}@${s.at}`; }
function stepOfKey(key) {
  let m = /^H(\d+)$/.exec(String(key || ''));
  if (m) return { hours: Number(m[1]) };
  m = /^D(\d+)@(\d\d:\d\d)$/.exec(String(key || ''));
  return m ? { days: Number(m[1]), at: m[2] } : null;
}

function cleanSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const ch = v.channels && typeof v.channels === 'object' ? v.channels : {};
  const sc = v.schedule && typeof v.schedule === 'object' ? v.schedule : {};
  const departments = {};
  Object.entries(sc.departments && typeof sc.departments === 'object' ? sc.departments : {}).slice(0, 60).forEach(([name, o]) => {
    const dep = txt(name, 80);
    if (!dep || !o || typeof o !== 'object') return;
    const e = {};
    KINDS.forEach((k) => { if (Array.isArray(o[k])) e[k] = cleanSteps(o[k], DEFAULT_STEPS[k]); });
    if (Object.keys(e).length) departments[dep] = e;
  });
  const carry = v.carry && typeof v.carry === 'object' ? v.carry : {};
  let earliest = intIn(v.earliestHour, 0, 23, DEFAULTS.earliestHour);
  let latest = intIn(v.latestHour, 1, 24, DEFAULTS.latestHour);
  if (latest <= earliest) { earliest = DEFAULTS.earliestHour; latest = DEFAULTS.latestHour; }
  return {
    enabled: v.enabled === true,
    channels: Object.fromEntries(CHANNELS.map((c) => [c, ch[c] === undefined ? true : ch[c] === true])),
    earliestHour: earliest,
    latestHour: latest,
    nameClient: v.nameClient === true,
    schedule: {
      interview: cleanSteps(sc.interview, DEFAULTS.schedule.interview),
      joining: cleanSteps(sc.joining, DEFAULTS.schedule.joining),
      departments,
    },
    carry: { interview: txt(carry.interview, 300) || DEFAULTS.carry.interview, joining: txt(carry.joining, 300) || DEFAULTS.carry.joining },
    joiningReportingTime: validHm(v.joiningReportingTime) ? v.joiningReportingTime : DEFAULTS.joiningReportingTime,
  };
}
async function readJson(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  let v = null;
  try { v = row ? JSON.parse(row.value) : null; } catch { v = null; }
  return { v, row };
}
async function loadSettings() {
  const { v, row } = await readJson(SETTINGS_KEY);
  return { ...cleanSettings(v), updatedByName: row ? row.updatedByName : null, updatedAt: row ? row.updatedAt : null };
}
async function saveSettings(patch, user) {
  const cur = await loadSettings();
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    ...cur,
    ...(p.enabled !== undefined ? { enabled: p.enabled === true } : {}),
    ...(p.channels ? { channels: { ...cur.channels, ...p.channels } } : {}),
    ...(p.earliestHour !== undefined ? { earliestHour: p.earliestHour } : {}),
    ...(p.latestHour !== undefined ? { latestHour: p.latestHour } : {}),
    ...(p.nameClient !== undefined ? { nameClient: p.nameClient === true } : {}),
    ...(p.carry ? { carry: { ...cur.carry, ...p.carry } } : {}),
    ...(p.joiningReportingTime !== undefined ? { joiningReportingTime: p.joiningReportingTime } : {}),
    schedule: {
      interview: p.schedule && p.schedule.interview ? p.schedule.interview : cur.schedule.interview,
      joining: p.schedule && p.schedule.joining ? p.schedule.joining : cur.schedule.joining,
      departments: p.schedule && p.schedule.departments ? p.schedule.departments : cur.schedule.departments,
    },
  };
  if (p.earliestHour !== undefined && !(Number(p.earliestHour) >= 0 && Number(p.earliestHour) <= 23)) return { error: 'Earliest hour: write an hour from 0 to 23.' };
  if (p.latestHour !== undefined && !(Number(p.latestHour) >= 1 && Number(p.latestHour) <= 24)) return { error: 'Latest hour: write an hour from 1 to 24.' };
  if (Number(merged.latestHour) <= Number(merged.earliestHour)) return { error: 'The latest hour must be after the earliest hour.' };
  if (p.schedule) {
    for (const k of KINDS) {
      const list = [p.schedule[k], ...Object.values(p.schedule.departments || {}).map((d) => d && d[k])].filter(Array.isArray);
      if (list.some((l) => l.length > MAX_STEPS)) return { error: `Use at most ${MAX_STEPS} messages for a ${k}.` };
    }
  }
  const next = cleanSettings(merged);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: JSON.stringify(next), ...who }, update: { value: JSON.stringify(next), ...who } });
  return { settings: await loadSettings(), before: cur };
}
function stepsFor(settings, kind, department) {
  const dep = department && settings.schedule.departments[department];
  return (dep && dep[kind]) || settings.schedule[kind] || DEFAULT_STEPS[kind];
}

// ------------------------------------------------------------------ templates (English + Telugu, Admin can edit)
const TOKENS = [
  ['first_name', 'Candidate first name'], ['role', 'Role (requirement title)'], ['company', 'Company (the client, or "our client")'],
  ['lead', 'The opening line (reminder in 2 days, tomorrow, in 2 hours ...)'], ['date', 'Date'], ['time', 'Time'],
  ['venue', 'Venue name'], ['address', 'Full address'], ['map', 'Map link'], ['contact', 'Contact person and phone'],
  ['carry', 'What to carry / documents to bring'], ['link', 'Meeting link (online)'], ['hr_contact', 'HR contact (joining)'],
];
const STOP_EN = 'Reply STOP to stop these messages.';
const STOP_TE = 'ఈ సందేశాలు ఆపడానికి STOP అని రిప్లై ఇవ్వండి.';
const TEMPLATE_KEYS = [
  ['interview_offline', 'Interview at a venue (offline)'], ['interview_online', 'Online interview'], ['interview_phone', 'Phone interview'], ['joining', 'Joining'],
];
const DEFAULT_TEMPLATES = {
  interview_offline: {
    en: `Hi {{first_name}}, {{lead}}\nRole: {{role}} at {{company}}\nWhen: {{date}}, {{time}}\nVenue: {{venue}}\nAddress: {{address}}\nMap: {{map}}\nContact: {{contact}}\nPlease carry: {{carry}}\n${STOP_EN} - TeamLink`,
    te: `నమస్కారం {{first_name}} గారు, {{lead}}\nపోస్ట్: {{role}} ({{company}})\nతేదీ, సమయం: {{date}}, {{time}}\nవేదిక: {{venue}}\nచిరునామా: {{address}}\nమ్యాప్: {{map}}\nసంప్రదించండి: {{contact}}\nతీసుకురావాల్సినవి: {{carry}}\n${STOP_TE} - TeamLink`,
  },
  interview_online: {
    en: `Hi {{first_name}}, {{lead}}\nRole: {{role}} at {{company}}\nWhen: {{date}}, {{time}}\nJoin here: {{link}}\nContact: {{contact}}\nPlease keep ready: {{carry}}\n${STOP_EN} - TeamLink`,
    te: `నమస్కారం {{first_name}} గారు, {{lead}}\nపోస్ట్: {{role}} ({{company}})\nతేదీ, సమయం: {{date}}, {{time}}\nమీటింగ్ లింక్: {{link}}\nసంప్రదించండి: {{contact}}\nసిద్ధంగా ఉంచుకోండి: {{carry}}\n${STOP_TE} - TeamLink`,
  },
  interview_phone: {
    en: `Hi {{first_name}}, {{lead}}\nRole: {{role}} at {{company}}\nWhen: {{date}}, {{time}}\nThis interview is on the phone: please keep your phone with you and free.\nContact: {{contact}}\n${STOP_EN} - TeamLink`,
    te: `నమస్కారం {{first_name}} గారు, {{lead}}\nపోస్ట్: {{role}} ({{company}})\nతేదీ, సమయం: {{date}}, {{time}}\nఈ ఇంటర్వ్యూ ఫోన్ ద్వారా జరుగుతుంది: దయచేసి మీ ఫోన్ అందుబాటులో ఉంచండి.\nసంప్రదించండి: {{contact}}\n${STOP_TE} - TeamLink`,
  },
  joining: {
    en: `Hi {{first_name}}, {{lead}}\nRole: {{role}} at {{company}}\nReporting: {{date}}, {{time}}\nPlace: {{venue}}\nAddress: {{address}}\nMap: {{map}}\nContact: {{contact}}\nHR: {{hr_contact}}\nDocuments to bring: {{carry}}\n${STOP_EN} - TeamLink`,
    te: `నమస్కారం {{first_name}} గారు, {{lead}}\nపోస్ట్: {{role}} ({{company}})\nరిపోర్టింగ్: {{date}}, {{time}}\nచోటు: {{venue}}\nచిరునామా: {{address}}\nమ్యాప్: {{map}}\nసంప్రదించండి: {{contact}}\nHR: {{hr_contact}}\nతీసుకురావాల్సిన పత్రాలు: {{carry}}\n${STOP_TE} - TeamLink`,
  },
};
async function loadTemplates() {
  const { v } = await readJson(TEMPLATES_KEY);
  const saved = v && typeof v === 'object' ? v : {};
  const out = {};
  TEMPLATE_KEYS.forEach(([k]) => {
    out[k] = {};
    LANGS.forEach((l) => {
      const s = saved[k] && typeof saved[k][l] === 'string' ? txtML(saved[k][l], 2000) : '';
      out[k][l] = { text: s || DEFAULT_TEMPLATES[k][l], edited: !!s && s !== DEFAULT_TEMPLATES[k][l], default: DEFAULT_TEMPLATES[k][l] };
    });
  });
  return out;
}
async function saveTemplates(patch, user) {
  const { v } = await readJson(TEMPLATES_KEY);
  const next = v && typeof v === 'object' ? { ...v } : {};
  const known = new Set(TOKENS.map((t) => t[0]));
  for (const [k, langs] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (!TEMPLATE_KEYS.some((t) => t[0] === k) || !langs || typeof langs !== 'object') continue; // eslint-disable-line no-continue
    next[k] = { ...(next[k] || {}) };
    for (const l of LANGS) {
      if (langs[l] === undefined) continue; // eslint-disable-line no-continue
      const t = txtML(langs[l], 2000);
      if (!t) { delete next[k][l]; continue; } // eslint-disable-line no-continue
      const bad = [...t.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()).filter((n) => !known.has(n));
      if (bad.length) return { error: `${LANG_NAME[l]} ${k}: these placeholders are not known: ${[...new Set(bad)].map((b) => `{{${b}}}`).join(', ')}.` };
      if (!t.includes('{{first_name}}')) return { error: `${LANG_NAME[l]} message: keep {{first_name}} so the candidate is greeted by name.` };
      next[k][l] = t;
    }
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: TEMPLATES_KEY }, create: { key: TEMPLATES_KEY, value: JSON.stringify(next), ...who }, update: { value: JSON.stringify(next), ...who } });
  return { templates: await loadTemplates() };
}

// ------------------------------------------------------------------ tables
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ScheduledReminder" (
        "id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "candidateId" TEXT, "kind" TEXT NOT NULL, "eventAt" TEXT NOT NULL, "sendAt" TEXT NOT NULL,
        "channel" TEXT NOT NULL, "templateKey" TEXT, "language" TEXT NOT NULL DEFAULT 'en', "status" TEXT NOT NULL DEFAULT 'planned', "reason" TEXT,
        "stepKey" TEXT NOT NULL, "createdById" TEXT, "createdBy" TEXT, "editedById" TEXT, "editedBy" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
        "sentAt" TEXT, "providerRef" TEXT, "deliveryStatus" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TEXT, "notifyIds" TEXT,
        "message" TEXT, "history" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ScheduledReminder_due" ON "ScheduledReminder" ("status","sendAt")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ScheduledReminder_app" ON "ScheduledReminder" ("applicationId","kind")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ScheduledReminder_ref" ON "ScheduledReminder" ("providerRef")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ReminderEventInfo" (
        "applicationId" TEXT NOT NULL, "kind" TEXT NOT NULL, "venueName" TEXT, "address" TEXT, "mapLink" TEXT, "contactName" TEXT, "contactPhone" TEXT,
        "reportingTime" TEXT, "hrContact" TEXT, "carry" TEXT, "planSaved" INTEGER NOT NULL DEFAULT 0, "updatedAt" TEXT, "updatedByName" TEXT,
        PRIMARY KEY ("applicationId","kind"))`);
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const x = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);
const nowIso = () => new Date().toISOString();
const newId = () => `rem_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

// ------------------------------------------------------------------ India time
const IST = 330 * MIN;
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istMinutes = (d) => { const t = new Date(new Date(d).getTime() + IST); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
const atIst = (day, hm) => new Date(`${day}T${hm}:00+05:30`);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const hmOf = (d) => { const t = new Date(new Date(d).getTime() + IST); return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dateWords(d) {
  const t = new Date(new Date(d).getTime() + IST);
  return `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}
function timeWords(d) {
  const t = new Date(new Date(d).getTime() + IST);
  const h = t.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const stamp = (d) => `${dateWords(d)} ${timeWords(d)}`;

// ------------------------------------------------------------------ the plan (pure)
// steps: [{ days, at } | { hours }]. -> [{ stepKey, sendAt: Date }] (dropped steps are not returned; `dropped` lists them with the reason)
function computePlan({ eventAt, steps, now = new Date(), earliestHour = 7, latestHour = 20, details = true }) {
  const ev = new Date(eventAt);
  const t = now.getTime();
  const lo = earliestHour * 60;
  const hi = latestHour * 60;
  const evDay = istDay(ev);
  const out = [];
  const dropped = [];
  const clampDay = (day, minutes) => { const m = Math.min(hi, Math.max(lo, minutes)); return atIst(day, `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); };
  (steps || []).forEach((s) => {
    const key = stepKeyOf(s);
    let sendAt;
    if (s.hours) {
      const raw = new Date(ev.getTime() - s.hours * HOUR);
      sendAt = clampDay(istDay(raw), istMinutes(raw));
    } else {
      const [h, m] = s.at.split(':').map(Number);
      sendAt = clampDay(addDays(evDay, -s.days), h * 60 + m);
    }
    if (sendAt.getTime() <= t + MIN) { dropped.push({ stepKey: key, why: 'already behind us' }); return; }
    if (sendAt.getTime() >= ev.getTime() - 10 * MIN) { dropped.push({ stepKey: key, why: 'too close to the event' }); return; }
    if (!out.some((o) => o.sendAt.getTime() === sendAt.getTime())) out.push({ stepKey: key, sendAt });
    else dropped.push({ stepKey: key, why: 'same time as another message' });
  });
  // the details at once: a booking made on the day itself (or so late that the first step is far away) tells the candidate the details now
  if (details && ev.getTime() > t + 30 * MIN) {
    const first = out.length ? Math.min(...out.map((o) => o.sendAt.getTime())) : null;
    const far = ev.getTime() - t <= 36 * HOUR && (first === null || first - t > 12 * HOUR) && (steps || []).length > 0;
    if (evDay === istDay(now) || far) {
      const nowMin = istMinutes(now);
      let at = null;
      if (nowMin >= lo && nowMin < hi) at = new Date(t);
      else if (nowMin < lo) at = clampDay(istDay(now), lo);
      if (at && at.getTime() < ev.getTime() - 10 * MIN) out.push({ stepKey: 'NOW', sendAt: at });
      else dropped.push({ stepKey: 'NOW', why: 'outside the sending hours' });
    }
  }
  out.sort((a, b) => a.sendAt - b.sendAt);
  return { plan: out, dropped };
}

// "2 days before" and so on, from the real times (works for edited times too)
function labelFor(stepKey, sendAt, eventAt) {
  if (stepKey === 'NOW') return 'At once: the details';
  const s = new Date(sendAt);
  const e = new Date(eventAt);
  const dd = Math.round((Date.parse(`${istDay(e)}T00:00:00Z`) - Date.parse(`${istDay(s)}T00:00:00Z`)) / DAY);
  if (dd >= 1) return `${dd} day${dd === 1 ? '' : 's'} before`;
  const h = Math.round((e - s) / HOUR);
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} before`;
  return `${Math.max(1, Math.round((e - s) / MIN))} minutes before`;
}
const QUICK = [
  { id: 'D2', label: '2 days before', stepKey: 'D2@10:00' }, { id: 'D1', label: '1 day before', stepKey: 'D1@17:00' },
  { id: 'H2', label: '2 hours before', stepKey: 'H2' },
];

// ------------------------------------------------------------------ the message
function leadFor({ kind, language, sendAt, eventAt, stepKey }) {
  const te = language === 'te';
  const e = new Date(eventAt);
  const s = new Date(sendAt);
  const dd = Math.round((Date.parse(`${istDay(e)}T00:00:00Z`) - Date.parse(`${istDay(s)}T00:00:00Z`)) / DAY);
  const hours = Math.max(1, Math.round((e - s) / HOUR));
  const word = kind === 'joining' ? 'joining' : 'interview';
  if (stepKey === 'NOW') return word === 'joining' ? (te ? 'మీ జాయినింగ్ వివరాలు ఇవి.' : 'Your joining details.') : (te ? 'మీ ఇంటర్వ్యూ వివరాలు ఇవి.' : 'Your interview details.');
  if (dd >= 2) return word === 'joining' ? (te ? `మీరు ${dd} రోజుల్లో జాయిన్ అవ్వాలి.` : `Reminder: you join in ${dd} days.`) : (te ? `మీ ఇంటర్వ్యూ ${dd} రోజుల్లో ఉంది.` : `Reminder: your interview is in ${dd} days.`);
  if (dd === 1) return word === 'joining' ? (te ? 'రేపు మీరు జాయిన్ అవ్వాలి.' : 'Reminder: you join tomorrow.') : (te ? 'రేపు మీ ఇంటర్వ్యూ ఉంది.' : 'Reminder: your interview is tomorrow.');
  if (word === 'joining') return te ? 'ఈ రోజు మీరు జాయిన్ అవ్వాలి.' : 'Reminder: you join today.';
  return te ? `ఈ రోజు సుమారు ${hours} గంటల్లో మీ ఇంటర్వ్యూ ఉంది.` : `Reminder: your interview is today, in about ${hours} hour${hours === 1 ? '' : 's'}.`;
}
function modeOf(app) {
  const m = String((app && app.interviewMode) || '').toLowerCase();
  if (m.includes('person') || m.includes('offline')) return 'offline';
  if (m.includes('tele') || m.includes('phone')) return 'phone';
  return 'online';
}
const templateKeyOf = (kind, mode) => (kind === 'joining' ? 'joining' : `interview_${mode}`);

function render(body, tokens) {
  const lines = String(body || '').split('\n').map((line) => {
    const names = [...line.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
    const filled = line.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, n) => (tokens[n.toLowerCase()] == null ? '' : String(tokens[n.toLowerCase()])));
    // a line made only of blanks ("Venue: ") is dropped
    if (names.length && names.every((n) => !String(tokens[n] == null ? '' : tokens[n]).trim())) return null;
    return filled.replace(/\s+$/, '');
  }).filter((l) => l !== null);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function carryText(app, kind, info, settings) {
  const own = txt(info && info.carry, 300);
  if (own) return own;
  const base = settings.carry[kind] || '';
  let extra = [];
  try {
    const OB = require('./atsOfferBgv'); // eslint-disable-line global-require
    const r = app.requirement || {};
    const ex = await OB.requirementExtras(r).catch(() => null);
    if (ex && ex.template) {
      const step = kind === 'joining' ? 'Joining' : 'Interview';
      extra = ex.template.items.filter((it) => it.step === step && /certificate|registration|licen[cs]e|copies|record|proof|card/i.test(it.label) && !/council|expiry|date|checked|done|willing|agreed/i.test(it.label)).map((it) => it.label.replace(/\s*\(.*\)\s*$/, ''));
    }
  } catch { extra = []; }
  return [base, ...extra].filter(Boolean).join(', ').slice(0, 400);
}

const APP_INCLUDE = { candidate: true, requirement: { include: { client: true, recruiter: true } } };
async function loadApp(applicationId) {
  return prisma.application.findUnique({ where: { id: String(applicationId) }, include: APP_INCLUDE });
}
async function infoOf(applicationId, kind) {
  await ensure();
  const [r] = await q('SELECT * FROM "ReminderEventInfo" WHERE "applicationId" = ? AND "kind" = ?', String(applicationId), kind);
  return r || null;
}
const cleanInfo = (d) => {
  const b = d && typeof d === 'object' ? d : {};
  const hm = String(b.reportingTime || '').trim();
  return {
    venueName: txt(b.venueName, 160), address: txt(b.address, 400), mapLink: txt(b.mapLink, 400).replace(/\s/g, ''), contactName: txt(b.contactName, 100),
    contactPhone: txt(b.contactPhone, 40), reportingTime: validHm(hm) ? hm : '', hrContact: txt(b.hrContact, 160), carry: txt(b.carry, 300),
  };
};
async function saveInfo(applicationId, kind, d, user, { markPlan = false } = {}) {
  await ensure();
  const c = cleanInfo(d);
  const cur = await infoOf(applicationId, kind);
  const keep = (k) => (d && d[k] !== undefined ? c[k] : (cur ? cur[k] || '' : ''));
  const v = Object.fromEntries(['venueName', 'address', 'mapLink', 'contactName', 'contactPhone', 'reportingTime', 'hrContact', 'carry'].map((k) => [k, keep(k)]));
  await x(`INSERT INTO "ReminderEventInfo" ("applicationId","kind","venueName","address","mapLink","contactName","contactPhone","reportingTime","hrContact","carry","planSaved","updatedAt","updatedByName")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("applicationId","kind") DO UPDATE SET "venueName"=excluded."venueName","address"=excluded."address","mapLink"=excluded."mapLink",
    "contactName"=excluded."contactName","contactPhone"=excluded."contactPhone","reportingTime"=excluded."reportingTime","hrContact"=excluded."hrContact","carry"=excluded."carry",
    "planSaved"=MAX("ReminderEventInfo"."planSaved", excluded."planSaved"),"updatedAt"=excluded."updatedAt","updatedByName"=excluded."updatedByName"`,
  String(applicationId), kind, v.venueName, v.address, v.mapLink, v.contactName, v.contactPhone, v.reportingTime, v.hrContact, v.carry, markPlan ? 1 : 0, nowIso(), (user && user.name) || null);
  return infoOf(applicationId, kind);
}

// The words for one message. `spec` = { kind, mode, language, sendAt, eventAt, stepKey }; `info` = the saved venue / contact details (or the booking window's draft).
async function buildMessage(app, spec, info, settings, templates) {
  const cand = app.candidate || {};
  const r = app.requirement || {};
  const kind = spec.kind;
  const mode = spec.mode || modeOf(app);
  const language = LANGS.includes(spec.language) ? spec.language : 'en';
  const tpls = templates || await loadTemplates();
  const body = tpls[templateKeyOf(kind, mode)][language].text;
  const company = r.internal ? 'TeamLink' : (settings.nameClient && r.client && r.client.name ? r.client.name : 'our client');
  const inf = info || {};
  const address = inf.address || (kind === 'interview' && mode === 'offline' ? app.interviewLocation : '') || (kind === 'joining' ? (r.location || (r.client && r.client.location)) : '') || '';
  const contact = [inf.contactName, inf.contactPhone].filter(Boolean).join(' - ') || (kind === 'interview' ? '' : '');
  const tokens = {
    first_name: txt(cand.name, 80).split(' ')[0] || 'there',
    role: txt(r.title, 120),
    company,
    lead: leadFor({ kind, language, sendAt: spec.sendAt, eventAt: spec.eventAt, stepKey: spec.stepKey }),
    date: dateWords(spec.eventAt),
    time: timeWords(spec.eventAt),
    venue: inf.venueName || '',
    address,
    map: inf.mapLink || '',
    contact,
    carry: mode === 'phone' && kind === 'interview' ? '' : await carryText(app, kind, inf, settings),
    link: kind === 'interview' && mode === 'online' ? (app.interviewMeetingLink || '') : '',
    hr_contact: inf.hrContact || '',
  };
  const text = render(body, tokens);
  const subject = kind === 'joining'
    ? `Joining reminder: ${tokens.role} on ${tokens.date}`
    : `Interview ${spec.stepKey === 'NOW' ? 'details' : 'reminder'}: ${tokens.role} on ${tokens.date}, ${tokens.time}`;
  const missing = [];
  if (kind === 'interview' && mode === 'offline') { if (!tokens.venue) missing.push('venue name'); if (!tokens.address) missing.push('address'); if (!tokens.contact) missing.push('contact person'); }
  if (kind === 'interview' && mode === 'online' && !tokens.link) missing.push('meeting link');
  if (kind === 'joining') { if (!tokens.address && !tokens.venue) missing.push('reporting place'); if (!tokens.contact) missing.push('contact person'); }
  return { text, subject, missing, templateKey: templateKeyOf(kind, mode), language };
}

// ------------------------------------------------------------------ the candidate: language and channels
async function languageOf(candidate) {
  try {
    const rows = await q('SELECT "language" FROM "AiCallPref" WHERE "candidateId" = ?', candidate.id);
    const l = rows[0] && String(rows[0].language || '').toLowerCase();
    if (l === 'telugu') return 'te';
    if (l === 'english') return 'en';
  } catch { /* the table is made by the calling module: not there = no saved choice */ }
  let known = String((candidate && candidate.languagesKnown) || '').toLowerCase();
  if (!known && candidate && candidate.id) {
    try { const r = await q('SELECT "languagesKnown" FROM "Candidate" WHERE "id" = ?', candidate.id); known = String((r[0] && r[0].languagesKnown) || '').toLowerCase(); } catch { known = ''; }
  }
  if (known.includes('telugu') && !known.includes('english')) return 'te';
  return 'en';
}
async function smsProven() {
  try {
    const gw = require('./smsGateway'); // eslint-disable-line global-require
    const cfg = await gw.smsConfig();
    if (!cfg.configured) return { ok: false, why: cfg.reason || 'SMS is not connected.' };
    if (sandboxOn() || cfg.provider !== 'SMSGW') return { ok: true };
    const accepted = await gw.pushLastAccepted();
    const dlr = accepted ? await require('./smsPushDlrReport').dlrSeen() : null; // eslint-disable-line global-require
    return accepted && dlr ? { ok: true } : { ok: false, why: 'SMS is not verified on the gateway yet (SMS Gateway settings: send one Test SMS).' };
  } catch (e) { return { ok: false, why: 'SMS is not ready.' }; }
}
// which ways reach THIS candidate: [{ channel, allowed, ready, hasContact, offered, reason }] (never the number itself)
async function channelsFor(candidate, settings) {
  const st = await require('./messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const phoneOk = !!(candidate && candidate.phone && core.normalizeMobile(candidate.phone).ok);
  const mailOk = !!(candidate && candidate.email && core.validEmail(candidate.email));
  const sms = await smsProven();
  return CHANNELS.map((c) => {
    const allowed = settings.channels[c] !== false;
    let ready = !!(st[c] && st[c].configured);
    let why = ready ? '' : ((st[c] && st[c].reason) || 'Not connected');
    if (c === 'SMS' && ready && !sms.ok) { ready = false; why = sms.why; }
    const hasContact = c === 'Email' ? mailOk : phoneOk;
    const reason = !allowed ? 'Switched off by an Admin' : !ready ? `Not ready: ${why}` : !hasContact ? `No ${c === 'Email' ? 'email address' : 'mobile number'} on this candidate` : '';
    return { channel: c, allowed, ready, hasContact, offered: allowed && ready && hasContact, reason };
  });
}
function defaultChannel(chs) {
  const o = chs.find((c) => c.offered);
  if (o) return o.channel;
  const a = chs.find((c) => c.allowed && c.hasContact);
  return a ? a.channel : (chs.find((c) => c.allowed) || { channel: 'WhatsApp' }).channel;
}

// ------------------------------------------------------------------ the event (what the application says now)
function eventOf(app, kind, settings, info) {
  if (!app) return { live: false, reason: 'The application is gone.' };
  if (app.stage === 'REJECTED') return { live: false, reason: 'The candidate was rejected.' };
  if (kind === 'interview') {
    if (!app.interviewAt) return { live: false, reason: 'No interview is booked.' };
    if (!LIVE_INTERVIEW.includes(app.interviewStatus)) {
      const why = { CANCELLED: 'The interview was cancelled.', NO_SHOW: 'The candidate did not attend.', STARTED: 'The interview has started.' }[app.interviewStatus] || 'The interview is done.';
      return { live: false, reason: why };
    }
    if (DECIDED.includes(app.stage)) return { live: false, reason: 'The interview is done: the candidate moved on.' };
    return { live: true, eventAt: new Date(app.interviewAt) };
  }
  // joining
  if (['JOINED', 'HIRED'].includes(app.stage) || app.joiningStatus === 'Joined') return { live: false, reason: 'The candidate has already joined.' };
  if (app.joiningStatus === 'Dropped' || app.rollStatus === 'Dropped') return { live: false, reason: 'The candidate dropped (did not join).' };
  if (app.joiningStatus !== 'Joining Scheduled' || !app.joiningDate) return { live: false, reason: 'The joining date is not set.' };
  const day = String(app.joiningDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { live: false, reason: 'The joining date is not valid.' };
  const hm = validHm(info && info.reportingTime) ? info.reportingTime : (settings ? settings.joiningReportingTime : DEFAULTS.joiningReportingTime);
  return { live: true, eventAt: atIst(day, hm) };
}

// ------------------------------------------------------------------ rows
const SHOW_STATUS = ['planned', 'sending', 'sent', 'delivered', 'failed', 'skipped'];
function shapeRow(r) {
  let history = [];
  try { history = JSON.parse(r.history || '[]'); } catch { history = []; }
  return {
    id: r.id, applicationId: r.applicationId, candidateId: r.candidateId, kind: r.kind, eventAt: r.eventAt, sendAt: r.sendAt, channel: r.channel, templateKey: r.templateKey,
    language: r.language, status: r.status === 'sending' ? 'planned' : r.status, reason: r.reason, stepKey: r.stepKey, label: labelFor(r.stepKey, r.sendAt, r.eventAt),
    createdBy: r.createdBy, editedBy: r.editedBy, createdAt: r.createdAt, updatedAt: r.updatedAt, sentAt: r.sentAt, providerRef: r.providerRef, deliveryStatus: r.deliveryStatus,
    attempts: Number(r.attempts) || 0, nextAttemptAt: r.nextAttemptAt, history,
  };
}
function addHistory(r, who, text) {
  let h = [];
  try { h = JSON.parse(r.history || '[]'); } catch { h = []; }
  h.push({ at: nowIso(), by: who || 'System', text: txt(text, 300) });
  return JSON.stringify(h.slice(-40));
}
async function rowsOf(applicationId, kind = null, { all = false } = {}) {
  await ensure();
  const rows = await q(`SELECT * FROM "ScheduledReminder" WHERE "applicationId" = ? ${kind ? 'AND "kind" = ?' : ''} ${all ? '' : 'AND "status" <> \'cancelled\''} ORDER BY "sendAt"`, ...(kind ? [String(applicationId), kind] : [String(applicationId)]));
  return rows;
}
const actorName = (a) => (a && a.name) || 'System';

// who gets the bells: the application's recruiter and the team lead of its requirement
async function notifyIdsOf(app) {
  const r = app.requirement || {};
  const own = require('./applicationOwner').ownerRecruiter(app); // eslint-disable-line global-require
  const ids = [own && own.id, r.recruiterId, r.tlId].filter(Boolean);
  const stl = r.stlId || null;
  if (stl) ids.push(stl);
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] }, status: 'Active' }, select: { id: true } }) : [];
  return users.map((u) => u.id);
}
async function bell(userIds, { title, message, key, open }) {
  const { pushNotification } = require('./notify'); // eslint-disable-line global-require
  let n = 0;
  for (const uid of [...new Set(userIds.filter(Boolean))]) {
    // once per person per key (an idempotent re-save never rings twice)
    // eslint-disable-next-line no-await-in-loop
    if (key && await prisma.notification.findFirst({ where: { userId: uid, recipient: key }, select: { id: true } })) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const row = await pushNotification({ userId: uid, title, message, open });
    if (row && key) await prisma.notification.update({ where: { id: row.id }, data: { recipient: key, channel: 'In-App', status: 'Sent' } }).catch(() => {}); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return n;
}

function planSentence(app, kind, eventAt, rows, mode, info, settings) {
  const name = (app.candidate && app.candidate.name) || 'the candidate';
  const sends = rows.filter((r) => ['planned', 'sending'].includes(r.status)).sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  const times = sends.map((r) => stamp(r.sendAt).replace(/^\w+ /, '').replace(/ (\d+:\d\d) (AM|PM)$/, (m, t, ap) => ` ${to24(t, ap)}`));
  let what;
  if (kind === 'joining') what = `joining ${stamp(eventAt)}${info && (info.venueName || info.address) ? ` at ${info.venueName || info.address}` : ''}`;
  else what = `interview ${stamp(eventAt)} ${mode === 'offline' ? 'offline' : mode}${mode === 'offline' && info && (info.venueName || info.address) ? ` at ${info.venueName || info.address}` : ''}`;
  const off = settings && !settings.enabled ? ' (they will not be sent yet: reminders are switched off)' : '';
  return `Reminders scheduled for ${name} - ${what}: ${sends.length} message${sends.length === 1 ? '' : 's'}${times.length ? `: ${times.join(', ')}` : ''}${off}`;
}
function to24(t, ap) {
  let [h, m] = t.split(':').map(Number);
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
const openPathOf = (app) => (app.candidateId ? `/candidates/${app.candidateId}?app=${app.id}` : undefined);

async function bellPlan(app, kind, rows, { word, actor, eventAt, mode, info, settings }) {
  const ids = await notifyIdsOf(app);
  const live = rows.filter((r) => ['planned', 'sending'].includes(r.status));
  const sig = crypto.createHash('sha1').update(`${word}|${eventAt}|${live.map((r) => `${r.stepKey}${r.channel}${r.sendAt}`).sort().join(',')}`).digest('hex').slice(0, 12);
  const name = (app.candidate && app.candidate.name) || 'Candidate';
  const sentence = planSentence(app, kind, eventAt, rows, mode, info, settings);
  const title = word === 'cancelled' ? `Reminders cancelled: ${name}` : word === 'moved' ? `Reminders moved: ${name}` : `Reminders scheduled: ${name}`;
  const message = word === 'cancelled' ? `The scheduled messages to ${name} (${kind}) were cancelled. ${actor && actor.name ? `By ${actor.name}.` : ''}`.trim()
    : sentence.replace(/^Reminders scheduled for/, word === 'moved' ? 'Reminders moved for' : 'Reminders scheduled for');
  return bell(ids, { title, message, key: `reminders|plan|${app.id}|${kind}|${word}|${sig}`, open: openPathOf(app) });
}

// ------------------------------------------------------------------ making / moving / cancelling the plan
async function insertRow({ app, kind, eventAt, stepKey, sendAt, channel, language, templateKey, actor, notifyIds, note }) {
  const id = newId();
  const t = nowIso();
  const h = JSON.stringify([{ at: t, by: actorName(actor), text: note || 'Planned' }]);
  await x(`INSERT INTO "ScheduledReminder" ("id","applicationId","candidateId","kind","eventAt","sendAt","channel","templateKey","language","status","stepKey","createdById","createdBy","createdAt","updatedAt","notifyIds","history")
    VALUES (?,?,?,?,?,?,?,?,?,'planned',?,?,?,?,?,?,?)`,
  id, app.id, app.candidateId, kind, new Date(eventAt).toISOString(), new Date(sendAt).toISOString(), channel, templateKey, language, stepKey, actor ? actor.id : null, actorName(actor), t, t, notifyIds.join(','), h);
  return id;
}

// Saves a plan for one event. `steps` = [{ stepKey?, sendAt (ISO), channel?, language? }]. Idempotent: the same step + channel at the same event time is the same row.
// Planned rows of this event that are not in `steps` are cancelled. Never touches a row already sent.
async function applyPlan({ app, kind, eventAt, steps, details, actor, source = 'saved', quiet = false }) {
  await ensure();
  const settings = await loadSettings();
  const mode = kind === 'interview' ? modeOf(app) : 'joining';
  const info = details !== undefined ? await saveInfo(app.id, kind, details, actor, { markPlan: true }) : await saveInfo(app.id, kind, {}, actor, { markPlan: true });
  const chs = await channelsFor(app.candidate, settings);
  const lang = await languageOf(app.candidate || {});
  const ev = new Date(eventAt).toISOString();
  const existing = await rowsOf(app.id, kind);
  const notifyIds = await notifyIdsOf(app);
  const wanted = [];
  let created = 0;
  let changed = 0;
  for (const s of (steps || []).slice(0, MAX_STEPS + 1)) {
    const sendAt = new Date(s.sendAt);
    if (Number.isNaN(sendAt.getTime())) continue; // eslint-disable-line no-continue
    const channel = CHANNELS.includes(s.channel) ? s.channel : defaultChannel(chs);
    const language = LANGS.includes(s.language) ? s.language : lang;
    const stepKey = s.stepKey && (s.stepKey === 'NOW' || stepOfKey(s.stepKey) || /^X\d+$/.test(s.stepKey)) ? s.stepKey : `X${sendAt.getTime()}`;
    const sameSlot = (r) => r.eventAt === ev && r.stepKey === stepKey && r.channel === channel;
    const row = existing.find(sameSlot);
    if (row) {
      wanted.push(row.id);
      if (row.status === 'planned' && (row.sendAt !== sendAt.toISOString() || row.language !== language)) {
        // eslint-disable-next-line no-await-in-loop
        await x('UPDATE "ScheduledReminder" SET "sendAt" = ?, "language" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ?, "notifyIds" = ? WHERE "id" = ?',
          sendAt.toISOString(), language, actor ? actor.id : null, actorName(actor), nowIso(), addHistory(row, actorName(actor), `Changed to ${stamp(sendAt)}`), notifyIds.join(','), row.id);
        changed += 1;
      }
    } else {
      // eslint-disable-next-line no-await-in-loop
      const id = await insertRow({ app, kind, eventAt: ev, stepKey, sendAt, channel, language, templateKey: templateKeyOf(kind, modeOf(app)), actor, notifyIds, note: source === 'default' ? 'Planned from the default schedule' : 'Planned' });
      wanted.push(id);
      created += 1;
    }
  }
  // saving a plan: the planned steps of this event that were taken out
  for (const r of existing) {
    if (r.eventAt === ev && r.status === 'planned' && !wanted.includes(r.id)) {
      // eslint-disable-next-line no-await-in-loop
      await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
        'Taken out when the plan was saved', actor ? actor.id : null, actorName(actor), nowIso(), addHistory(r, actorName(actor), 'Taken out of the plan'), r.id);
      changed += 1;
    }
  }
  const rows = await rowsOf(app.id, kind);
  if (!quiet && (created || changed || !rows.length)) {
    await logAudit({ userId: actor && actor.id, actorName: actorName(actor), action: `Reminders ${created ? 'planned' : 'changed'} (${kind})`, entity: 'Application', entityId: app.id, toValue: `${rows.filter((r) => r.eventAt === ev && r.status === 'planned').length} message(s) for ${stamp(ev)}` }).catch(() => {});
  }
  const live = rows.filter((r) => r.eventAt === ev);
  if (!quiet && (created || changed)) await bellPlan(app, kind, live, { word: 'scheduled', actor, eventAt: ev, mode, info, settings });
  return { created, changed, rows: live.map(shapeRow), mode };
}

// the default plan of an event (the Admin's schedule, per department)
async function defaultSteps(app, kind, eventAt, settings, now = new Date()) {
  const dep = app.requirement && app.requirement.department;
  const def = stepsFor(settings, kind, dep);
  const { plan, dropped } = computePlan({ eventAt, steps: def, now, earliestHour: settings.earliestHour, latestHour: settings.latestHour });
  return { steps: plan.map((p) => ({ stepKey: p.stepKey, sendAt: p.sendAt.toISOString() })), dropped, def };
}

// the interview / joining moved, was cancelled, or was done: bring the plan in line. Safe to call at any time (idempotent).
// opts: { actor, event: 'booked'|'rescheduled'|'cancelled'|'changed'|'stage', kind (only this kind), steps, details, now }
async function sync(applicationId, opts = {}) {
  await ensure();
  const out = { kinds: {} };
  try {
    const app = await loadApp(applicationId);
    if (!app) return out;
    const settings = await loadSettings();
    const now = opts.now || new Date();
    const actor = opts.actor || null;
    for (const kind of KINDS) {
      if (opts.kind && opts.kind !== kind) continue; // eslint-disable-line no-continue
      // the venue / contact / reporting time that came with the booking are saved first (a joining's reporting time is part of its event time)
      // eslint-disable-next-line no-await-in-loop
      if (opts.kind === kind && opts.details !== undefined) await saveInfo(app.id, kind, opts.details, actor);
      // eslint-disable-next-line no-await-in-loop
      const info = await infoOf(app.id, kind);
      const ev = eventOf(app, kind, settings, info);
      // eslint-disable-next-line no-await-in-loop
      const rows = await rowsOf(app.id, kind);
      const planned = rows.filter((r) => r.status === 'planned');
      if (!ev.live) {
        if (planned.length) {
          for (const r of planned) {
            // eslint-disable-next-line no-await-in-loop
            await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
              ev.reason, actor ? actor.id : null, actorName(actor), nowIso(), addHistory(r, actorName(actor), `Cancelled: ${ev.reason}`), r.id);
          }
          // eslint-disable-next-line no-await-in-loop
          await logAudit({ userId: actor && actor.id, actorName: actorName(actor), action: `Reminders cancelled (${kind})`, entity: 'Application', entityId: app.id, toValue: `${planned.length} message(s): ${ev.reason}`.slice(0, 300) }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await bellPlan(app, kind, rows.map((r) => ({ ...r, status: 'cancelled' })), { word: 'cancelled', actor, eventAt: planned[0].eventAt, mode: modeOf(app), info, settings });
        }
        await x('UPDATE "ReminderEventInfo" SET "planSaved" = 0 WHERE "applicationId" = ? AND "kind" = ?', app.id, kind).catch(() => {}); // eslint-disable-line no-await-in-loop
        out.kinds[kind] = { live: false, cancelled: planned.length };
        continue; // eslint-disable-line no-continue
      }
      const evIso = ev.eventAt.toISOString();
      // the event time changed: the unsent steps move with it
      const stale = planned.filter((r) => r.eventAt !== evIso);
      let moved = 0;
      let dropped = 0;
      for (const r of stale) {
        const spec = stepOfKey(r.stepKey);
        let sendAt = null;
        if (spec) {
          const p = computePlan({ eventAt: ev.eventAt, steps: [spec], now, earliestHour: settings.earliestHour, latestHour: settings.latestHour, details: false });
          sendAt = p.plan[0] ? p.plan[0].sendAt : null;
        } else if (/^X\d+$/.test(r.stepKey)) {
          const shifted = new Date(Date.parse(r.sendAt) + (ev.eventAt.getTime() - Date.parse(r.eventAt)));
          sendAt = shifted.getTime() > now.getTime() + MIN && shifted.getTime() < ev.eventAt.getTime() - 10 * MIN ? shifted : null;
        }
        const clash = sendAt && rows.some((o) => o.id !== r.id && o.eventAt === evIso && o.stepKey === r.stepKey && o.channel === r.channel && o.status !== 'cancelled');
        if (sendAt && !clash) {
          // eslint-disable-next-line no-await-in-loop
          await x('UPDATE "ScheduledReminder" SET "eventAt" = ?, "sendAt" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
            evIso, sendAt.toISOString(), actor ? actor.id : null, actorName(actor), nowIso(), addHistory(r, actorName(actor), `Moved with the ${kind}: now ${stamp(sendAt)} (was ${stamp(r.sendAt)})`), r.id);
          moved += 1;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
            `The ${kind} moved and this step no longer fits before it`, actor ? actor.id : null, actorName(actor), nowIso(), addHistory(r, actorName(actor), `Cancelled: the ${kind} moved and this step no longer fits`), r.id);
          dropped += 1;
        }
      }
      let result = null;
      const wantExplicit = opts.kind === kind && Array.isArray(opts.steps);
      if (wantExplicit) {
        // eslint-disable-next-line no-await-in-loop
        result = await applyPlan({ app, kind, eventAt: ev.eventAt, steps: opts.steps, details: opts.details, actor, source: 'saved' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const fresh = await rowsOf(app.id, kind);
        const hasForEvent = fresh.some((r) => r.eventAt === evIso);
        // eslint-disable-next-line no-await-in-loop
        const saved = (await infoOf(app.id, kind));
        const decided = saved && Number(saved.planSaved) === 1;
        const wantsDefault = !hasForEvent && !decided && ['booked', 'changed', 'rescheduled', 'stage'].includes(opts.event || 'changed');
        if (wantsDefault) {
          // eslint-disable-next-line no-await-in-loop
          const d = await defaultSteps(app, kind, ev.eventAt, settings, now);
          // eslint-disable-next-line no-await-in-loop
          result = await applyPlan({ app, kind, eventAt: ev.eventAt, steps: d.steps, actor, source: 'default' });
        } else if (moved || dropped) {
          // a same-day move may now call for the details at once
          if (!fresh.some((r) => r.eventAt === evIso && r.stepKey === 'NOW' && r.status !== 'cancelled') && evIso && istDay(ev.eventAt) === istDay(now)) {
            // eslint-disable-next-line no-await-in-loop
            const p = computePlan({ eventAt: ev.eventAt, steps: [{ days: 99, at: '10:00' }], now, earliestHour: settings.earliestHour, latestHour: settings.latestHour });
            const nowStep = p.plan.find((s) => s.stepKey === 'NOW');
            if (nowStep) {
              // eslint-disable-next-line no-await-in-loop
              const chs = await channelsFor(app.candidate, settings);
              // eslint-disable-next-line no-await-in-loop
              await insertRow({ app, kind, eventAt: evIso, stepKey: 'NOW', sendAt: nowStep.sendAt, channel: defaultChannel(chs), language: await languageOf(app.candidate || {}), templateKey: templateKeyOf(kind, modeOf(app)), actor, notifyIds: await notifyIdsOf(app), note: 'Details at once: the time was moved to today' }); // eslint-disable-line no-await-in-loop
            }
          }
          // eslint-disable-next-line no-await-in-loop
          const after = await rowsOf(app.id, kind);
          // eslint-disable-next-line no-await-in-loop
          await logAudit({ userId: actor && actor.id, actorName: actorName(actor), action: `Reminders moved (${kind})`, entity: 'Application', entityId: app.id, toValue: `${moved} moved, ${dropped} cancelled; now ${stamp(evIso)}` }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await bellPlan(app, kind, after.filter((r) => r.eventAt === evIso), { word: 'moved', actor, eventAt: evIso, mode: modeOf(app), info: await infoOf(app.id, kind), settings }); // eslint-disable-line no-await-in-loop
        }
      }
      out.kinds[kind] = { live: true, eventAt: evIso, moved, dropped, created: result ? result.created : 0 };
    }
  } catch (err) {
    console.error('[scheduledReminders] sync:', err.message); // eslint-disable-line no-console
    out.error = err.message;
  }
  return out;
}

// ------------------------------------------------------------------ who may see / edit
const isAdminLogin = (u) => !!u && (['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole));
function bdeSide(user) {
  try { const f = require('./clientRedact').privacyFlagsFor(user); return !!(f && f.bde); } catch { return false; } // eslint-disable-line global-require
}
// the application, if this login may see it at all (the same scope as every ATS list)
async function scopedApp(user, applicationId) {
  const { applicationWhere } = require('./scope'); // eslint-disable-line global-require
  return prisma.application.findFirst({ where: { id: String(applicationId), ...applicationWhere(user) }, include: APP_INCLUDE });
}
// -> { view, text, edit, why }
async function accessOf(user, app, kind) {
  const P = require('./permissions'); // eslint-disable-line global-require
  if (!user || P.isExternalLogin(user)) return { view: false, text: false, edit: false, why: 'Not available to this login.' };
  const admin = isAdminLogin(user);
  const bde = !admin && bdeSide(user);
  const role = P.stageRoleOf(user);
  let edit = admin;
  if (!edit && !bde && ['TL', 'STL', 'RECRUITER'].includes(role)) edit = true; // the application scope already limited a recruiter to their own seat
  if (!edit) {
    const feature = kind === 'joining' ? ['Joining', 'edit'] : ['Schedule Interview', 'edit'];
    const create = kind === 'joining' ? ['Joining', 'edit'] : ['Schedule Interview', 'create'];
    edit = (await P.can(user, 'ats', 'interviews', ...feature).catch(() => false)) || (await P.can(user, 'ats', 'interviews', ...create).catch(() => false));
    if (role === 'MANAGER' && !admin) edit = false; // the Manager reads everything, view + approve only
  }
  return { view: true, text: !bde, edit, bde, why: edit ? '' : 'You can see these messages but not change them. Ask the recruiter or the team lead.' };
}

// ------------------------------------------------------------------ reading
async function panel(user, applicationId) {
  await ensure();
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  const settings = await loadSettings();
  const kinds = {};
  const tpls = await loadTemplates();
  for (const kind of KINDS) {
    // eslint-disable-next-line no-await-in-loop
    const acc = await accessOf(user, app, kind);
    // eslint-disable-next-line no-await-in-loop
    const rows = await rowsOf(app.id, kind);
    // eslint-disable-next-line no-await-in-loop
    const info = await infoOf(app.id, kind);
    const ev = eventOf(app, kind, settings, info);
    const current = ev.live ? rows.filter((r) => r.eventAt === ev.eventAt.toISOString()) : rows.slice(-6);
    const counts = { total: current.length, planned: 0, sent: 0, failed: 0, skipped: 0, delivered: 0 };
    current.forEach((r) => { const s = r.status === 'sending' ? 'planned' : r.status; if (s in counts) counts[s] += 1; });
    const shaped = [];
    for (const r of current) {
      const base = shapeRow(r);
      let text = null;
      if (acc.text) {
        // eslint-disable-next-line no-await-in-loop
        const m = await buildMessage(app, { kind, mode: modeOf(app), language: r.language, sendAt: r.sendAt, eventAt: r.eventAt, stepKey: r.stepKey }, info, settings, tpls);
        text = r.message && ['sent', 'delivered'].includes(r.status) ? r.message : m.text;
      }
      shaped.push({ ...base, text, history: acc.text ? base.history : [], reason: acc.text ? base.reason : (base.status === 'failed' ? 'Not sent' : base.reason) });
    }
    kinds[kind] = {
      live: ev.live, eventAt: ev.live ? ev.eventAt.toISOString() : null, endedBecause: ev.live ? null : ev.reason, mode: kind === 'interview' ? modeOf(app) : 'joining',
      counts, canEdit: acc.edit, canSeeText: acc.text, countOnly: !acc.text, why: acc.why,
      rows: acc.text ? shaped : [],
      info: acc.text && info ? { venueName: info.venueName || '', address: info.address || '', mapLink: info.mapLink || '', contactName: info.contactName || '', contactPhone: info.contactPhone || '', reportingTime: info.reportingTime || '', hrContact: info.hrContact || '', carry: info.carry || '' } : null,
    };
  }
  return {
    status: 200,
    applicationId: app.id,
    candidate: { id: app.candidateId, name: app.candidate && app.candidate.name },
    switchOn: settings.enabled,
    switchNote: settings.enabled ? '' : 'These messages will not be sent: reminders are switched off (an Admin turns them on).',
    kinds,
  };
}

async function listForCandidate(user, candidateId) {
  const apps = await prisma.application.findMany({ where: { candidateId: String(candidateId) }, select: { id: true } });
  const out = [];
  for (const a of apps) {
    // eslint-disable-next-line no-await-in-loop
    const p = await panel(user, a.id);
    if (p.status === 200 && KINDS.some((k) => p.kinds[k].counts.total || p.kinds[k].live)) out.push(p);
  }
  return out;
}

// the suggestion shown in the booking / joining window before anything is saved
async function suggest(user, { applicationId, kind, eventAt, mode, details, now = new Date() }) {
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  if (!KINDS.includes(kind)) return { status: 400, error: 'Say interview or joining.' };
  const ev = new Date(eventAt);
  if (Number.isNaN(ev.getTime())) return { status: 400, error: 'Give the date and time first.' };
  const settings = await loadSettings();
  const acc = await accessOf(user, app, kind);
  const tpls = await loadTemplates();
  const chs = await channelsFor(app.candidate, settings);
  const lang = await languageOf(app.candidate || {});
  const d = await defaultSteps({ ...app, requirement: app.requirement }, kind, ev, settings, now);
  const virtual = kind === 'interview' ? { ...app, interviewMode: mode || app.interviewMode, interviewLocation: (details && details.address) || app.interviewLocation } : app;
  const info = cleanInfo(details);
  const steps = [];
  for (const s of d.steps) {
    const language = lang;
    // eslint-disable-next-line no-await-in-loop
    const m = await buildMessage(virtual, { kind, mode: kind === 'interview' ? (mode ? modeOf({ interviewMode: mode }) : modeOf(app)) : 'joining', language, sendAt: s.sendAt, eventAt: ev, stepKey: s.stepKey }, info, settings, tpls);
    steps.push({
      stepKey: s.stepKey, sendAt: s.sendAt, label: labelFor(s.stepKey, s.sendAt, ev), channel: defaultChannel(chs), language, checked: true,
      text: acc.text ? m.text : null, missing: m.missing,
    });
  }
  return {
    status: 200, kind, eventAt: ev.toISOString(), steps, dropped: d.dropped, channels: chs.map((c) => ({ channel: c.channel, offered: c.offered, reason: c.reason })),
    language: lang, languages: LANGS.map((l) => ({ id: l, name: LANG_NAME[l] })), quick: QUICK, switchOn: settings.enabled, canEdit: acc.edit, canSeeText: acc.text,
    earliestHour: settings.earliestHour, latestHour: settings.latestHour, max: MAX_STEPS,
    note: settings.enabled ? '' : 'Reminders are switched off for now: the plan is saved and shown, but nothing is sent until an Admin turns them on.',
  };
}
async function previewOne(user, { applicationId, kind, eventAt, mode, details, sendAt, language, stepKey }) {
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  const acc = await accessOf(user, app, kind);
  if (!acc.text) return { status: 200, text: null, note: 'The message text is shown to the recruiter and the team lead.' };
  const settings = await loadSettings();
  const virtual = kind === 'interview' ? { ...app, interviewMode: mode || app.interviewMode, interviewLocation: (details && details.address) || app.interviewLocation } : app;
  const m = await buildMessage(virtual, { kind, mode: kind === 'interview' ? modeOf({ interviewMode: mode || app.interviewMode }) : 'joining', language, sendAt: sendAt || new Date(), eventAt, stepKey: stepKey || 'X' }, cleanInfo(details), settings);
  return { status: 200, text: m.text, subject: m.subject, missing: m.missing };
}

// ------------------------------------------------------------------ editing one message / the plan
async function loadRowFor(user, id) {
  await ensure();
  const [r] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', String(id));
  if (!r) return { status: 404, error: 'That message is not there.' };
  const app = await scopedApp(user, r.applicationId);
  if (!app) return { status: 404, error: 'That message is not there.' };
  const acc = await accessOf(user, app, r.kind);
  if (!acc.edit) return { status: 403, error: acc.why || 'You may not change these messages.' };
  return { r, app, acc };
}
async function patchRow(user, id, body) {
  const got = await loadRowFor(user, id);
  if (got.error) return got;
  const { r, app } = got;
  const b = body || {};
  const settings = await loadSettings();
  const who = actorName(user);
  if (!['planned', 'skipped'].includes(r.status)) return { status: 409, error: r.status === 'cancelled' ? 'This message is cancelled.' : 'This message has already been handled and cannot be changed. Add a new one instead.' };
  const ev = new Date(r.eventAt);
  const sets = [];
  const args = [];
  const notes = [];
  if (b.skip === true) {
    const reason = txt(b.reason, 200);
    if (!reason) return { status: 400, error: 'Say in a few words why this message is skipped.' };
    if (r.status === 'skipped') return { status: 409, error: 'Already skipped.' };
    sets.push('"status" = \'skipped\'', '"reason" = ?'); args.push(`Skipped by ${who}: ${reason}`); notes.push(`Skipped: ${reason}`);
  } else if (b.unskip === true) {
    if (r.status !== 'skipped') return { status: 409, error: 'This message is not skipped.' };
    if (Date.parse(r.sendAt) <= Date.now()) return { status: 409, error: 'Its time has passed: set a new time first.' };
    sets.push('"status" = \'planned\'', '"reason" = NULL'); notes.push('Back in the plan');
  }
  if (b.sendAt !== undefined) {
    const t = new Date(b.sendAt);
    if (Number.isNaN(t.getTime())) return { status: 400, error: 'That date and time is not valid.' };
    if (t.getTime() <= Date.now() + MIN) return { status: 400, error: 'Pick a time in the future (or press Send now).' };
    if (t.getTime() >= ev.getTime()) return { status: 400, error: `The message must go before the ${r.kind === 'joining' ? 'joining' : 'interview'}.` };
    const m = istMinutes(t);
    if (m < settings.earliestHour * 60 || m > settings.latestHour * 60) return { status: 400, error: `Messages go between ${String(settings.earliestHour).padStart(2, '0')}:00 and ${String(settings.latestHour).padStart(2, '0')}:00 India time.` };
    sets.push('"sendAt" = ?'); args.push(t.toISOString()); notes.push(`Time changed to ${stamp(t)} (was ${stamp(r.sendAt)})`);
    if (r.status === 'skipped' && b.skip !== true) { sets.push('"status" = \'planned\'', '"reason" = NULL'); }
  }
  if (b.channel !== undefined) {
    if (!CHANNELS.includes(b.channel)) return { status: 400, error: 'Pick WhatsApp, SMS or Email.' };
    const chs = await channelsFor(app.candidate, settings);
    const c = chs.find((o) => o.channel === b.channel);
    if (!c.offered) return { status: 409, error: `${b.channel} cannot be used: ${c.reason || 'not available'}.` };
    sets.push('"channel" = ?'); args.push(b.channel); notes.push(`Channel changed to ${b.channel}`);
  }
  if (b.language !== undefined) {
    if (!LANGS.includes(b.language)) return { status: 400, error: 'Pick English or Telugu.' };
    sets.push('"language" = ?'); args.push(b.language); notes.push(`Language changed to ${LANG_NAME[b.language]}`);
  }
  if (!sets.length) return { status: 400, error: 'Nothing to change.' };
  await x(`UPDATE "ScheduledReminder" SET ${sets.join(', ')}, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?`, ...args, user.id, who, nowIso(), addHistory(r, who, notes.join('; ')), r.id);
  await logAudit({ userId: user.id, actorName: who, action: `Scheduled message changed (${r.kind})`, entity: 'Application', entityId: app.id, reason: txt(b.reason, 200) || undefined, toValue: notes.join('; ').slice(0, 300) }).catch(() => {});
  const [fresh] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  return { status: 200, row: shapeRow(fresh) };
}
async function addRow(user, applicationId, body) {
  await ensure();
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  const b = body || {};
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) return { status: 400, error: 'Say interview or joining.' };
  const acc = await accessOf(user, app, kind);
  if (!acc.edit) return { status: 403, error: acc.why };
  const settings = await loadSettings();
  const info = await infoOf(app.id, kind);
  const ev = eventOf(app, kind, settings, info);
  if (!ev.live) return { status: 409, error: ev.reason };
  const t = new Date(b.sendAt);
  if (Number.isNaN(t.getTime())) return { status: 400, error: 'Pick the date and time for the new message.' };
  if (t.getTime() <= Date.now() + MIN) return { status: 400, error: 'Pick a time in the future (or press Send now on an existing one).' };
  if (t.getTime() >= ev.eventAt.getTime() - 10 * MIN) return { status: 400, error: `The message must go before the ${kind === 'joining' ? 'joining' : 'interview'}.` };
  const m = istMinutes(t);
  if (m < settings.earliestHour * 60 || m > settings.latestHour * 60) return { status: 400, error: `Messages go between ${String(settings.earliestHour).padStart(2, '0')}:00 and ${String(settings.latestHour).padStart(2, '0')}:00 India time.` };
  const rows = await rowsOf(app.id, kind);
  const cur = rows.filter((r) => r.eventAt === ev.eventAt.toISOString() && ['planned', 'sending', 'sent', 'delivered'].includes(r.status));
  if (cur.length >= MAX_STEPS + 1) return { status: 409, error: `At most ${MAX_STEPS} messages for one ${kind}.` };
  const chs = await channelsFor(app.candidate, settings);
  const channel = CHANNELS.includes(b.channel) ? b.channel : defaultChannel(chs);
  if (b.channel && !chs.find((c) => c.channel === channel).offered) return { status: 409, error: `${channel} cannot be used: ${chs.find((c) => c.channel === channel).reason}.` };
  const language = LANGS.includes(b.language) ? b.language : await languageOf(app.candidate || {});
  const stepKey = `X${t.getTime()}`;
  if (rows.some((r) => r.eventAt === ev.eventAt.toISOString() && r.stepKey === stepKey && r.channel === channel && r.status !== 'cancelled')) return { status: 409, error: 'There is already a message at that time.' };
  const id = await insertRow({ app, kind, eventAt: ev.eventAt, stepKey, sendAt: t, channel, language, templateKey: templateKeyOf(kind, modeOf(app)), actor: user, notifyIds: await notifyIdsOf(app), note: 'Added by hand' });
  await x('UPDATE "ReminderEventInfo" SET "planSaved" = 1 WHERE "applicationId" = ? AND "kind" = ?', app.id, kind).catch(() => {});
  await logAudit({ userId: user.id, actorName: actorName(user), action: `Scheduled message added (${kind})`, entity: 'Application', entityId: app.id, toValue: `${stamp(t)} by ${channel}` }).catch(() => {});
  const [fresh] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', id);
  return { status: 201, row: shapeRow(fresh) };
}
async function cancelAll(user, applicationId, body) {
  await ensure();
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  const kind = KINDS.includes(body && body.kind) ? body.kind : null;
  if (!kind) return { status: 400, error: 'Say interview or joining.' };
  const acc = await accessOf(user, app, kind);
  if (!acc.edit) return { status: 403, error: acc.why };
  const reason = txt(body.reason, 200);
  if (!reason) return { status: 400, error: 'Say in a few words why all the messages are cancelled.' };
  const rows = (await rowsOf(app.id, kind)).filter((r) => r.status === 'planned');
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
      `Cancelled by ${actorName(user)}: ${reason}`, user.id, actorName(user), nowIso(), addHistory(r, actorName(user), `Cancelled: ${reason}`), r.id);
  }
  await x('UPDATE "ReminderEventInfo" SET "planSaved" = 1 WHERE "applicationId" = ? AND "kind" = ?', app.id, kind).catch(() => {});
  await logAudit({ userId: user.id, actorName: actorName(user), action: `Scheduled messages cancelled (${kind})`, entity: 'Application', entityId: app.id, reason, toValue: `${rows.length} message(s)` }).catch(() => {});
  if (rows.length) await bellPlan(app, kind, rows.map((r) => ({ ...r, status: 'cancelled' })), { word: 'cancelled', actor: user, eventAt: rows[0].eventAt, mode: modeOf(app), info: await infoOf(app.id, kind), settings: await loadSettings() });
  return { status: 200, cancelled: rows.length };
}
async function saveDetails(user, applicationId, kind, details) {
  await ensure();
  const app = await scopedApp(user, applicationId);
  if (!app) return { status: 404, error: 'Application not found.' };
  if (!KINDS.includes(kind)) return { status: 400, error: 'Say interview or joining.' };
  const acc = await accessOf(user, app, kind);
  if (!acc.edit) return { status: 403, error: acc.why };
  const before = await infoOf(app.id, kind);
  await saveInfo(app.id, kind, details, user);
  await logAudit({ userId: user.id, actorName: actorName(user), action: `Reminder details changed (${kind})`, entity: 'Application', entityId: app.id, fromValue: before ? JSON.stringify({ v: before.venueName, a: before.address }).slice(0, 200) : '', toValue: JSON.stringify(cleanInfo(details)).slice(0, 300) }).catch(() => {});
  // a joining's reporting time is part of its event time: the unsent steps follow it
  await sync(app.id, { actor: user, event: 'changed', kind });
  return { status: 200, info: await infoOf(app.id, kind) };
}

// ------------------------------------------------------------------ sending
function creditActor(row) { return row.createdById || null; }
async function whatsappSend(row, to, text) {
  const core = require('./messagingCore'); // eslint-disable-line global-require
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const m = core.normalizeMobile(to);
  if (!m.ok) return { ok: false, invalid: true, error: `The mobile number does not look right: ${m.reason}` };
  if (await delivery.optedOut('WhatsApp', m.e164)) return { ok: false, optout: true, error: 'They replied STOP on WhatsApp, so nothing more is sent to them there.' };
  // THE CRM's RULE: plain words only inside the 24-hour window, else the company's general template with the message as its blank
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  const open = await WN.windowOpenSystem(m.e164).catch(() => false);
  if (!open) {
    const wa = require('./whatsappCloud'); // eslint-disable-line global-require
    const cfg = await wa.whatsappConfig().catch(() => null);
    if (cfg && cfg.configured !== false && !wa.simulated(cfg) && !(cfg.templates && cfg.templates.bulk)) {
      return { ok: false, needsTemplate: true, error: 'WhatsApp will not deliver this: the candidate has not written to us in the last 24 hours, and no approved WhatsApp template is set for general messages (Administration > Integrations > WhatsApp > Template name - bulk / general).' };
    }
  }
  return require('./messaging').send('WhatsApp', { // eslint-disable-line global-require
    to: m.e164, text, kind: open ? 'session' : 'bulk', ...(open ? {} : { vars: [text] }), automatic: true, actorUserId: creditActor(row) || undefined,
    meta: { audience: 'candidates', personId: row.candidateId, senderUserId: creditActor(row) || undefined, purpose: 'Interview and joining reminder', template: row.templateKey, module: 'ATS' },
  });
}
async function deliver(row, app, settings, tpls) {
  const cand = app.candidate || {};
  const info = await infoOf(app.id, row.kind);
  const m = await buildMessage(app, { kind: row.kind, mode: modeOf(app), language: row.language, sendAt: row.sendAt, eventAt: row.eventAt, stepKey: row.stepKey }, info, settings, tpls);
  const messaging = require('./messaging'); // eslint-disable-line global-require
  let res;
  if (row.channel === 'WhatsApp') res = await whatsappSend(row, cand.phone, m.text);
  else if (row.channel === 'SMS') {
    const proven = await smsProven();
    if (!proven.ok) res = { ok: false, notConfigured: true, error: proven.why };
    else {
      const to = require('./messagingCore').normalizeMobile(cand.phone); // eslint-disable-line global-require
      if (!to.ok) res = { ok: false, invalid: true, error: `The mobile number does not look right: ${to.reason}` };
      else if (await require('./messageDelivery').optedOut('SMS', to.e164)) res = { ok: false, optout: true, error: 'They replied STOP to our SMS, so nothing more is sent to them there.' }; // eslint-disable-line global-require
      else res = await messaging.send('SMS', { to: to.e164, kind: 'bulk', text: m.text, vars: [m.text], actorUserId: creditActor(row) || undefined, meta: { audience: 'candidates', personId: row.candidateId, senderUserId: creditActor(row) || undefined, purpose: 'Interview and joining reminder', template: row.templateKey, module: 'ATS' } });
    }
  } else {
    res = await messaging.send('Email', {
      to: String(cand.email || '').trim(), subject: m.subject, text: m.text, fromName: 'TeamLink', actorUserId: creditActor(row) || undefined,
      meta: { audience: 'candidates', personId: row.candidateId, senderUserId: creditActor(row) || undefined, purpose: 'Interview and joining reminder', template: row.templateKey, module: 'ATS' },
    });
  }
  return { res, message: m };
}
const WHY = (res) => String((res && res.error) || 'The provider did not accept the message.').replace(/\s+/g, ' ').slice(0, 300);

// the candidate's own Communications line, so it shows on Candidate 360 and takes the delivery ticks of utils/messageDelivery
async function logToCandidate(row, app, m, res) {
  try {
    const cand = app.candidate || {};
    await prisma.candidateMessage.create({
      data: {
        candidateId: row.candidateId, applicationId: row.applicationId, channel: row.channel, template: `REMINDER_${row.kind.toUpperCase()}`, templateLabel: `${row.kind === 'joining' ? 'Joining' : 'Interview'} reminder (${labelFor(row.stepKey, row.sendAt, row.eventAt)})`,
        trigger: 'Scheduled reminder', recipient: row.channel === 'Email' ? (cand.email || '') : (cand.phone || ''), subject: row.channel === 'Email' ? m.subject : null, body: m.text,
        status: 'SENT', statusDetail: `Accepted by the provider${res && res.response ? ` - ${String(res.response).slice(0, 200)}` : ''}`, providerRef: res.providerRef || null, sentAt: new Date(), attempts: 1,
        senderUserId: row.createdById || null, senderName: row.createdBy || 'TeamLink',
      },
    });
  } catch { /* the log line is a courtesy */ }
}

async function setStatus(id, status, reason, extra = {}) {
  const [r] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', id);
  if (!r) return;
  const sets = ['"status" = ?', '"reason" = ?', '"updatedAt" = ?', '"history" = ?'];
  const args = [status, reason || null, nowIso(), addHistory(r, 'System', `${status}${reason ? `: ${reason}` : ''}`)];
  Object.entries(extra).forEach(([k, v]) => { sets.push(`"${k}" = ?`); args.push(v); });
  await x(`UPDATE "ScheduledReminder" SET ${sets.join(', ')} WHERE "id" = ?`, ...args, id);
}
async function failBell(row, app, reason) {
  const ids = String(row.notifyIds || '').split(',').filter(Boolean);
  const name = (app.candidate && app.candidate.name) || 'Candidate';
  await bell(ids, {
    title: `Reminder NOT sent: ${name}`,
    message: `The ${row.kind} reminder (${labelFor(row.stepKey, row.sendAt, row.eventAt)}, by ${row.channel}) to ${name} was not sent: ${reason}`,
    key: `reminders|fail|${row.id}`, open: openPathOf(app),
  });
}

// One pass. opts: { now, force (send even when the switch is off: tests only through run, never from a route), onlyIds }
async function run(opts = {}) {
  await ensure();
  const now = opts.now || new Date();
  const t = now.getTime();
  const settings = await loadSettings();
  const summary = { at: now.toISOString(), enabled: settings.enabled, considered: 0, sent: 0, failed: 0, skipped: 0, retried: 0, deferred: 0, cancelled: 0, items: [] };
  // a pass that died half way: 'sending' for over 10 minutes was never confirmed, it is not sent a second time
  await x('UPDATE "ScheduledReminder" SET "status" = \'failed\', "reason" = ?, "updatedAt" = ? WHERE "status" = \'sending\' AND "updatedAt" < ?',
    'The server stopped while this was sending. It was not sent again by itself: press Send now to try again.', nowIso(), new Date(Date.now() - 10 * MIN).toISOString()).catch(() => {});
  if (!settings.enabled && opts.force !== true) return { ...summary, off: true };
  const tpls = await loadTemplates();
  const planned = await q('SELECT * FROM "ScheduledReminder" WHERE "status" = \'planned\' ORDER BY "sendAt" LIMIT 1000');
  if (!planned.length) return summary;
  const appIds = [...new Set(planned.map((r) => r.applicationId))];
  const apps = new Map();
  for (let i = 0; i < appIds.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.application.findMany({ where: { id: { in: appIds.slice(i, i + 200) } }, include: APP_INCLUDE })).forEach((a) => apps.set(a.id, a));
  }
  const infos = new Map();
  const sentFor = new Map(); // app -> rows sent this pass (for the digest)
  for (const r of planned) {
    if (opts.onlyIds && !opts.onlyIds.includes(r.applicationId)) continue; // eslint-disable-line no-continue
    const app = apps.get(r.applicationId);
    const infoKey = `${r.applicationId}|${r.kind}`;
    // eslint-disable-next-line no-await-in-loop
    if (!infos.has(infoKey)) infos.set(infoKey, await infoOf(r.applicationId, r.kind));
    const ev = eventOf(app, r.kind, settings, infos.get(infoKey));
    // 1. the event itself: cancelled, done, moved, rejected, dropped, passed -> skipped now (even before its time)
    let skip = null;
    if (!ev.live) skip = ev.reason;
    else if (ev.eventAt.toISOString() !== r.eventAt) skip = `The ${r.kind} moved to another time.`;
    else if (ev.eventAt.getTime() <= t) skip = `The ${r.kind} time has passed.`;
    if (skip) {
      // eslint-disable-next-line no-await-in-loop
      await setStatus(r.id, 'skipped', skip);
      summary.skipped += 1; summary.items.push({ id: r.id, status: 'skipped', reason: skip });
      continue; // eslint-disable-line no-continue
    }
    const due = Date.parse(r.sendAt) <= t && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= t);
    if (!due) continue; // eslint-disable-line no-continue
    summary.considered += 1;
    // 2. too late (the switch was off or the server was down)
    if (t - Date.parse(r.sendAt) > STALE_MS && !r.attempts) {
      // eslint-disable-next-line no-await-in-loop
      await setStatus(r.id, 'skipped', 'Too late to send: its time passed more than 3 hours ago.');
      summary.skipped += 1; summary.items.push({ id: r.id, status: 'skipped', reason: 'late' });
      continue; // eslint-disable-line no-continue
    }
    // 3. only between the earliest and the latest hour
    const mm = istMinutes(now);
    if (mm < settings.earliestHour * 60 || mm > settings.latestHour * 60 + 5) { summary.deferred += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const out = await sendRow(r, app, settings, tpls, { now });
    summary[out.kind] = (summary[out.kind] || 0) + 1;
    summary.items.push({ id: r.id, status: out.status, reason: out.reason || null });
    if (out.sent) { const l = sentFor.get(r.applicationId) || []; l.push(r.id); sentFor.set(r.applicationId, l); }
  }
  if (sentFor.size) await digestBells(now).catch((e) => console.error('[scheduledReminders] digest:', e.message)); // eslint-disable-line no-console
  return summary;
}

// claims one planned row and sends it. -> { kind: 'sent'|'failed'|'skipped'|'retried', status, reason, sent }
async function sendRow(r, app, settings, tpls, { now = new Date(), manual = false } = {}) {
  const claimed = await x('UPDATE "ScheduledReminder" SET "status" = \'sending\', "updatedAt" = ? WHERE "id" = ? AND "status" = \'planned\'', nowIso(), r.id);
  if (!claimed) return { kind: 'skipped', status: 'skipped', reason: 'already being handled' };
  const cand = app.candidate || {};
  const skip = async (why) => { await setStatus(r.id, 'skipped', why); return { kind: 'skipped', status: 'skipped', reason: why }; };
  if (!cand.id) return skip('The candidate is not there any more.');
  if (!sandboxOn() && (isTestPerson(cand.name) || isTestPerson(cand.email))) return skip('A test person: never messaged on the real server.');
  if (cand.doNotContact || cand.consentStatus === 'WITHDRAWN') return skip('The candidate asked not to be contacted.');
  if (!settings.channels[r.channel]) return skip(`${r.channel} reminders are switched off by an Admin.`);
  // one message per candidate per event time: a twin plan (the same person, the same event, the same step and way) that already went
  const twin = await q('SELECT "id" FROM "ScheduledReminder" WHERE "candidateId" = ? AND "eventAt" = ? AND "channel" = ? AND "stepKey" = ? AND "id" <> ? AND "status" IN (\'sent\',\'delivered\') LIMIT 1', r.candidateId, r.eventAt, r.channel, r.stepKey, r.id);
  if (twin.length) return skip('The same message for this candidate and this time already went (another plan covers it).');
  // the way must still reach them
  if (r.channel === 'Email' ? !cand.email : !cand.phone) { await setStatus(r.id, 'failed', `No ${r.channel === 'Email' ? 'email address' : 'mobile number'} on this candidate.`); await failBell(r, app, `No ${r.channel === 'Email' ? 'email address' : 'mobile number'} on this candidate.`); return { kind: 'failed', status: 'failed', reason: 'no contact' }; }
  let out;
  try { out = await deliver(r, app, settings, tpls); } catch (e) { out = { res: { ok: false, transient: true, error: `Internal error: ${e.message}` }, message: null }; }
  const { res, message } = out;
  const attempts = (Number(r.attempts) || 0) + 1;
  if (res && res.ok) {
    await setStatus(r.id, 'sent', null, { sentAt: now.toISOString(), providerRef: res.providerRef || null, deliveryStatus: 'Sent', attempts, message: message ? message.text : null, nextAttemptAt: null });
    if (message) await logToCandidate(r, app, message, res);
    return { kind: 'sent', status: 'sent', sent: true };
  }
  if (res && res.optout) return skip(WHY(res));
  const transient = !!(res && res.transient) && attempts < MAX_TRIES;
  if (transient) {
    const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
    const [cur] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
    await x('UPDATE "ScheduledReminder" SET "status" = \'planned\', "attempts" = ?, "nextAttemptAt" = ?, "reason" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
      attempts, new Date(now.getTime() + wait * MIN).toISOString(), `Try ${attempts} of ${MAX_TRIES} failed: ${WHY(res)}`, nowIso(), addHistory(cur, 'System', `Try ${attempts} of ${MAX_TRIES} failed: ${WHY(res)}. Next try in ${wait} minutes`), r.id);
    return { kind: 'retried', status: 'planned', reason: WHY(res) };
  }
  const reason = `${WHY(res)}${attempts > 1 ? ` (after ${attempts} tries)` : ''}`;
  await setStatus(r.id, 'failed', reason, { attempts, nextAttemptAt: null });
  await failBell({ ...r, attempts }, app, reason);
  return { kind: 'failed', status: 'failed', reason };
}

// ONE digest line per person per day, kept up to date (not a bell per message)
async function digestBells(now = new Date()) {
  const day = istDay(now);
  const from = atIst(day, '00:00').toISOString();
  const to = new Date(atIst(day, '00:00').getTime() + DAY).toISOString();
  const rows = await q('SELECT * FROM "ScheduledReminder" WHERE "status" IN (\'sent\',\'delivered\') AND "sentAt" >= ? AND "sentAt" < ? ORDER BY "sentAt"', from, to);
  if (!rows.length) return 0;
  const by = new Map();
  rows.forEach((r) => String(r.notifyIds || '').split(',').filter(Boolean).forEach((u) => { const l = by.get(u) || []; l.push(r); by.set(u, l); }));
  const appIds = [...new Set(rows.map((r) => r.applicationId))];
  const apps = new Map((await prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, candidate: { select: { name: true } } } })).map((a) => [a.id, a]));
  let n = 0;
  for (const [uid, list] of by) {
    const key = `reminders|digest|${uid}|${day}`;
    const lines = list.map((r) => `${timeWords(r.sentAt)} ${(apps.get(r.applicationId) && apps.get(r.applicationId).candidate && apps.get(r.applicationId).candidate.name) || 'Candidate'} - ${r.kind} (${r.channel})`);
    const title = `Reminders sent today: ${list.length}`;
    const message = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n+${lines.length - 12} more` : '');
    // eslint-disable-next-line no-await-in-loop
    const had = await prisma.notification.findFirst({ where: { userId: uid, recipient: key } });
    if (had) {
      // eslint-disable-next-line no-await-in-loop
      if (had.message !== message) await prisma.notification.update({ where: { id: had.id }, data: { title, message } });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: uid, title, message: `${message}\nOpen: /ats/dashboard`, channel: 'In-App', recipient: key, status: 'Sent' } });
      n += 1;
    }
  }
  return n;
}

// a person pressed "Send now"
async function sendNow(user, id) {
  const got = await loadRowFor(user, id);
  if (got.error) return got;
  const { r, app } = got;
  const settings = await loadSettings();
  if (!settings.enabled) return { status: 409, error: 'Reminders are switched off. An Admin turns them on first (Administration > Interview reminders).' };
  if (!['planned', 'skipped'].includes(r.status) && r.status !== 'failed') return { status: 409, error: r.status === 'cancelled' ? 'This message is cancelled.' : 'This message has already gone.' };
  const info = await infoOf(app.id, r.kind);
  const ev = eventOf(app, r.kind, settings, info);
  if (!ev.live) return { status: 409, error: ev.reason };
  if (ev.eventAt.toISOString() !== r.eventAt) return { status: 409, error: `The ${r.kind} moved to another time: this message is out of date.` };
  if (r.status !== 'planned') await x('UPDATE "ScheduledReminder" SET "status" = \'planned\', "attempts" = 0, "nextAttemptAt" = NULL WHERE "id" = ?', r.id);
  const [fresh] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  const out = await sendRow(fresh, app, settings, await loadTemplates(), { manual: true });
  await logAudit({ userId: user.id, actorName: actorName(user), action: `Scheduled message sent now (${r.kind})`, entity: 'Application', entityId: app.id, toValue: `${out.status}${out.reason ? `: ${out.reason}` : ''}`.slice(0, 300) }).catch(() => {});
  if (out.sent) await digestBells(new Date()).catch(() => {});
  const [after] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  await x('UPDATE "ScheduledReminder" SET "editedById" = ?, "editedBy" = ?, "history" = ? WHERE "id" = ?', user.id, actorName(user), addHistory(after, actorName(user), 'Send now pressed'), r.id);
  const [last] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', r.id);
  return { status: out.status === 'sent' ? 200 : 200, ok: out.status === 'sent', outcome: out.status, reason: out.reason || null, row: shapeRow(last) };
}

// the Admin's "Send me a test reminder": the preview goes to the Admin's own phone / email, nothing to a candidate
async function sendTest(user, { kind = 'interview', mode = 'offline', channel = 'WhatsApp', language = 'en' } = {}) {
  const own = await require('./messageChannels').ownContact(user); // eslint-disable-line global-require
  if (!CHANNELS.includes(channel)) return { status: 400, error: 'Pick WhatsApp, SMS or Email.' };
  const to = channel === 'Email' ? own.email : own.phone;
  if (!to) return { status: 409, error: `Your own ${channel === 'Email' ? 'email address' : 'phone number'} is not on your employee record, so there is nowhere to send the test. Add it on your profile first.` };
  const settings = await loadSettings();
  const eventAt = new Date(Date.now() + 2 * DAY);
  const sample = {
    candidate: { id: 'sample', name: `${(own.name || 'Sample').split(' ')[0]} (test)` },
    requirement: { title: 'Sample role', internal: false, client: { name: 'Sample Company' }, location: 'Sample address' },
    interviewMode: mode === 'offline' ? 'In Person' : mode === 'phone' ? 'Telephonic' : 'Online', interviewMeetingLink: 'https://meet.google.com/sample-test-link', interviewLocation: '',
  };
  const info = { venueName: 'Sample Hospital', address: '12 Sample Road, Hyderabad 500001', mapLink: 'https://maps.example.com/sample', contactName: 'Sample Contact', contactPhone: '9000000000', hrContact: 'HR Sample 9000000001', carry: '' };
  const m = await buildMessage(sample, { kind, mode: kind === 'joining' ? 'joining' : mode, language, sendAt: new Date(), eventAt, stepKey: 'D2@10:00' }, info, settings);
  const body = `[TEST - this is how the reminder looks]\n${m.text}`;
  let res;
  if (channel === 'WhatsApp') res = await whatsappSend({ candidateId: null, templateKey: m.templateKey, createdById: user.id }, to, body);
  else if (channel === 'SMS') res = await require('./messaging').send('SMS', { to, kind: 'bulk', text: body, vars: [body], actorUserId: user.id, meta: { audience: 'employees', purpose: 'Reminder test' } }); // eslint-disable-line global-require
  else res = await require('./messaging').send('Email', { to, subject: `[TEST] ${m.subject}`, text: body, fromName: 'TeamLink', actorUserId: user.id, meta: { audience: 'employees', purpose: 'Reminder test' } }); // eslint-disable-line global-require
  const sandbox = !!res.sandbox || /sandbox/i.test(String(res.providerRef || res.response || ''));
  await logAudit({ userId: user.id, actorName: user.name, action: 'Reminder test sent to own contact', entity: 'AppSetting', entityId: SETTINGS_KEY, toValue: `${channel}: ${res.ok ? 'sent' : WHY(res)}`.slice(0, 200) }).catch(() => {});
  return {
    status: res.ok ? 200 : 502, ok: !!res.ok, sandbox, text: m.text, to: channel === 'Email' ? String(to).replace(/^(.).*(@.*)$/, '$1•••$2') : `•••${String(to).replace(/\D/g, '').slice(-4)}`,
    message: res.ok ? (sandbox ? 'Test server: accepted, nothing was really sent.' : `Sent to your own ${channel === 'Email' ? 'email' : 'phone'}. Please check it arrived.`) : `Did not go: ${WHY(res)}`,
  };
}

// ------------------------------------------------------------------ delivery ticks (utils/messageDelivery.js)
const RANK = { Sent: 1, Delivered: 2, Read: 3 };
async function applyDeliveryStatus(providerRef, status, error, at) {
  try {
    await ensure();
    const word = { SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed' }[String(status || '').toUpperCase()];
    if (!word || !providerRef) return 0;
    const rows = await q('SELECT * FROM "ScheduledReminder" WHERE "providerRef" = ?', String(providerRef));
    let n = 0;
    for (const r of rows) {
      if (word !== 'Failed' && (RANK[r.deliveryStatus] || 0) >= RANK[word]) continue; // eslint-disable-line no-continue
      const st = word === 'Failed' ? 'failed' : (word === 'Sent' ? r.status : 'delivered');
      const reason = word === 'Failed' ? `Not delivered: ${txt(error, 250) || 'the provider reported it as not delivered'}` : r.reason;
      // eslint-disable-next-line no-await-in-loop
      await x('UPDATE "ScheduledReminder" SET "deliveryStatus" = ?, "status" = ?, "reason" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?', word, st, reason, nowIso(), addHistory(r, 'Provider', `${word} ${stamp(at || new Date())}`), r.id);
      if (word === 'Failed') {
        // eslint-disable-next-line no-await-in-loop
        const app = await loadApp(r.applicationId);
        // eslint-disable-next-line no-await-in-loop
        if (app) await failBell(r, app, reason);
      }
      n += 1;
    }
    return n;
  } catch { return 0; }
}

// ------------------------------------------------------------------ the dashboard card ("Reminders going out")
async function upcoming(user, { now = new Date() } = {}) {
  await ensure();
  const P = require('./permissions'); // eslint-disable-line global-require
  if (!user || P.isExternalLogin(user)) return { status: 403, error: 'Not available to this login.' };
  const admin = isAdminLogin(user);
  const bde = !admin && bdeSide(user);
  const today = istDay(now);
  const from = atIst(today, '00:00').toISOString();
  const to = new Date(atIst(today, '00:00').getTime() + 2 * DAY).toISOString();
  const rows = await q('SELECT * FROM "ScheduledReminder" WHERE "sendAt" >= ? AND "sendAt" < ? AND "status" <> \'cancelled\' ORDER BY "sendAt"', from, to);
  const appIds = [...new Set(rows.map((r) => r.applicationId))];
  const { applicationWhere } = require('./scope'); // eslint-disable-line global-require
  const ok = new Map();
  for (let i = 0; i < appIds.length; i += 300) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.application.findMany({ where: { AND: [applicationWhere(user), { id: { in: appIds.slice(i, i + 300) } }] }, select: { id: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } } })).forEach((a) => ok.set(a.id, a));
  }
  const mine = rows.filter((r) => ok.has(r.applicationId));
  const tomorrow = addDays(today, 1);
  const bucket = (r) => (istDay(r.sendAt) === today ? 'today' : istDay(r.sendAt) === tomorrow ? 'tomorrow' : null);
  const count = (day) => {
    const l = mine.filter((r) => bucket(r) === day);
    return { total: l.length, failed: l.filter((r) => r.status === 'failed').length, sent: l.filter((r) => ['sent', 'delivered'].includes(r.status)).length, planned: l.filter((r) => ['planned', 'sending'].includes(r.status)).length };
  };
  const settings = await loadSettings();
  const out = { status: 200, today: count('today'), tomorrow: count('tomorrow'), switchOn: settings.enabled, countOnly: bde, scope: admin || (P.stageRoleOf(user) === 'MANAGER') ? 'all' : (['TL', 'STL'].includes(P.stageRoleOf(user)) ? 'team' : 'own') };
  if (!bde) {
    out.rows = mine.slice(0, 300).map((r) => {
      const a = ok.get(r.applicationId);
      return {
        id: r.id, applicationId: r.applicationId, candidate: a.candidate && a.candidate.name, role: a.requirement && a.requirement.title, kind: r.kind, eventAt: r.eventAt, sendAt: r.sendAt, day: bucket(r),
        channel: r.channel, status: r.status === 'sending' ? 'planned' : r.status, reason: r.reason, label: labelFor(r.stepKey, r.sendAt, r.eventAt), deliveryStatus: r.deliveryStatus,
      };
    });
  }
  return out;
}

// the interview calendar's detail window: the reminders of one interview (same rules as the panel)
async function forInterview(user, applicationId) {
  const p = await panel(user, applicationId);
  if (p.status !== 200) return p;
  return { status: 200, interview: p.kinds.interview, switchOn: p.switchOn, switchNote: p.switchNote };
}

// "will the old candidate reminders (1 day / 1 hour / every hour mails) double up?": when the new plan covers an interview, they stand down
async function coversInterview(applicationId, slotIso) {
  try {
    const s = await loadSettings();
    if (!s.enabled) return false;
    await ensure();
    const rows = await q('SELECT 1 FROM "ScheduledReminder" WHERE "applicationId" = ? AND "kind" = \'interview\' AND "eventAt" = ? AND "status" IN (\'planned\',\'sending\',\'sent\',\'delivered\') LIMIT 1', String(applicationId), String(slotIso));
    return rows.length > 0;
  } catch { return false; }
}

// what a booking / joining reply tells the screen (times, ways, status: never the words)
async function summaryOf(applicationId, kind) {
  await ensure();
  const settings = await loadSettings();
  const app = await prisma.application.findUnique({ where: { id: String(applicationId) }, select: { id: true, interviewAt: true, joiningDate: true, joiningStatus: true, interviewStatus: true, stage: true, rollStatus: true } });
  const ev = eventOf(app, kind, settings, await infoOf(applicationId, kind));
  const rows = ev.live ? (await rowsOf(applicationId, kind)).filter((r) => r.eventAt === ev.eventAt.toISOString()) : [];
  return { count: rows.length, switchOn: settings.enabled, rows: rows.map((r) => ({ id: r.id, sendAt: r.sendAt, channel: r.channel, label: labelFor(r.stepKey, r.sendAt, r.eventAt), status: r.status === 'sending' ? 'planned' : r.status })) };
}

// ------------------------------------------------------------------ keeping the plan in line with the routes
// Mounted once on /api/ats (index.js): after a booking / reschedule / cancel / did-not-attend / decision / feedback, and after a joining date is set,
// joined, dropped or left, the plan of that application is brought in line BEFORE the answer goes back (so the screen already shows it).
// A booking or joining date that carries its own `reminders` plan is saved by its route; this only fills in the default plan for callers that sent none.
const ROUTE_EVENTS = [
  [/^\/interviews\/([^/]+)\/book$/, 'booked'], [/^\/interviews\/([^/]+)\/(reschedule|no-show)$/, 'rescheduled'], [/^\/interviews\/([^/]+)\/(cancel|decision|feedback|client-feedback)$/, 'cancelled'],
  [/^\/joining\/([^/]+)\/schedule$/, 'booked'], [/^\/joining\/([^/]+)\/(joined|not-joined|left|replaced|call)$/, 'cancelled'], [/^\/applications\/([^/]+)\/roll-status$/, 'stage'],
];
function autoSyncMiddleware(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return next();
  const hit = ROUTE_EVENTS.map(([re, ev]) => [re.exec(req.path), ev]).find(([m]) => !!m);
  if (!hit) return next();
  const [m, event] = hit;
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 300 || res.__remSynced) return orig(body);
    res.__remSynced = true;
    return sync(decodeURIComponent(m[1]), { actor: req.user, event: event === 'cancelled' ? 'changed' : event }).catch(() => null).then(() => orig(body));
  };
  return next();
}

let TIMER = null;
function startSweep() {
  if (sandboxOn() || TIMER) return;
  const ms = Number(process.env.REMINDER_SWEEP_MS || 5 * MIN);
  if (!ms) return;
  const tick = () => run().then((r) => { if (r.sent || r.failed) console.log(`[scheduled-reminders] ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped`); }).catch((e) => console.error('[scheduled-reminders]', e.message)); // eslint-disable-line no-console
  setTimeout(tick, 120000).unref?.();
  TIMER = setInterval(tick, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  SETTINGS_KEY, TEMPLATES_KEY, KINDS, CHANNELS, LANGS, TOKENS, TEMPLATE_KEYS, DEFAULTS, DEFAULT_STEPS, MAX_STEPS, MAX_TRIES, QUICK,
  loadSettings, saveSettings, loadTemplates, saveTemplates, computePlan, labelFor, buildMessage, channelsFor, languageOf, modeOf, eventOf,
  sync, panel, listForCandidate, suggest, previewOne, patchRow, addRow, cancelAll, saveDetails, sendNow, sendTest, run, digestBells, applyDeliveryStatus, upcoming, forInterview,
  coversInterview, startSweep, autoSyncMiddleware, summaryOf, rowsOf, infoOf, saveInfo, ensure, accessOf, cleanInfo, stepKeyOf, istDay,
};

// ---------------------------------------------------------------------------
// UPTIME ALERT (spec section 21 "If the server stops, send an alert").
//
// A server cannot report its own death, so the check runs OUTSIDE the API:
// scripts/healthcheck.js, started every 5 minutes by Windows Task Scheduler
// (install steps: Administration → System, and the top of that script). It
// asks GET /api/health; after 2 failed checks in a row (about 10 minutes) it
// raises ONE alert for that outage, and one "back up" note when it answers
// again. It writes straight to the database file, which works while the API
// is down.
//
// The alert is OFF until a Super Admin switches it on (Administration →
// System). When on, it goes:
//   * in-app — a Notification for every active Super Admin, seen on the bell
//     as soon as the app answers again, and
//   * by email — to the address of the Super Admin who switched it on (their
//     OWN login email), never to anyone else.
// When off, outages are still recorded in the state file and shown on the
// System page; nothing is sent.
//
// The setting lives in the existing Integration table as an internal row (the
// pattern utils/portalSettings.js and utils/attendanceAlerts.js use) — no
// schema change, no credentials stored.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const prisma = require('../db');

const STORE_ID = 'system-uptime-alert';
const DEFAULTS = { enabled: false, email: null, failuresBeforeAlert: 2, setBy: null, setAt: null };

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const isSandbox = () => truthy(process.env.TEST_MODE) || truthy(process.env.TEAMLINK_SANDBOX);

function stateDir() {
  const home = os.homedir() || os.tmpdir();
  return path.resolve(process.env.SYSTEM_STATE_DIR
    || (isSandbox() ? path.join(home, '.teamlink-sandbox', 'system') : path.join(home, '.teamlink-data', 'system')));
}
function stateFile() { return path.join(stateDir(), 'uptime.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile());
}

function parse(row) { try { return row && row.values ? JSON.parse(row.values) : {}; } catch { return {}; } }

async function uptimeSettings() {
  const row = await prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
  const v = { ...DEFAULTS, ...parse(row) };
  const n = Number(v.failuresBeforeAlert);
  return {
    enabled: v.enabled === true,
    email: v.email || null,
    failuresBeforeAlert: Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULTS.failuresBeforeAlert,
    setBy: v.setBy || null,
    setAt: v.setAt || null,
  };
}

const RESERVED = /(\.(test|example|invalid|localhost)$)|(^|\.)example\.(com|net|org)$/i;

// Only a Super Admin calls this (routes/system.js); the email is THEIR OWN.
async function saveUptimeSettings({ enabled }, user) {
  const cur = await uptimeSettings();
  const next = { ...cur, enabled: enabled === true, setBy: user ? user.name || user.email : null, setAt: new Date().toISOString() };
  if (next.enabled) {
    const email = String((user && user.email) || '').trim().toLowerCase();
    next.email = email && !RESERVED.test(email.split('@').pop() || '') ? email : null;
  }
  await prisma.integration.upsert({
    where: { id: STORE_ID },
    create: { id: STORE_ID, enabled: next.enabled, state: 'Internal', values: JSON.stringify(next) },
    update: { enabled: next.enabled, values: JSON.stringify(next) },
  });
  return next;
}

async function superAdmins() {
  const rows = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', status: 'Active' },
    select: { id: true, name: true, email: true },
  });
  // Test logins never get alerts (agent-rules: exclude ZZTEST / example.test).
  return rows.filter((u) => !/zztest|example\.test/i.test(`${u.name} ${u.email}`));
}

// Called by scripts/healthcheck.js. kind: 'down' | 'up'.
async function sendUptimeAlert(kind, { since, upAt, url, detail }) {
  const settings = await uptimeSettings();
  if (!settings.enabled) return { sent: false, why: 'Uptime alert is switched off (Administration → System).' };
  const when = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const title = kind === 'down' ? 'TeamLink server is not answering' : 'TeamLink server is back';
  const text = kind === 'down'
    ? `The TeamLink server has not answered since ${when(since)}. Check that the computer running it is on and the server window is open. (${url}${detail ? ` — ${detail}` : ''})`
    : `The TeamLink server is answering again since ${when(upAt)}. It was down from ${when(since)}.`;
  const out = { sent: true, inApp: 0, email: null };
  for (const u of await superAdmins()) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: u.id, title, message: text, channel: 'In-App', recipient: u.name || null, status: 'Delivered' } });
    out.inApp += 1;
  }
  if (settings.email) {
    // eslint-disable-next-line global-require
    const { sendMail } = require('./mailer');
    const r = await sendMail({ to: settings.email, subject: `TeamLink — ${title}`, text, useEmployeeFrom: false });
    out.email = r.ok ? 'Sent' : (r.notConfigured ? 'Not sent — email is not set up in Integrations' : `Failed — ${String(r.error || '').slice(0, 150)}`);
    await prisma.notification.create({ data: { userId: null, title, message: text, channel: 'Email', recipient: settings.email, status: out.email, read: true } });
  }
  return out;
}

module.exports = { STORE_ID, stateDir, stateFile, readState, writeState, uptimeSettings, saveUptimeSettings, sendUptimeAlert };

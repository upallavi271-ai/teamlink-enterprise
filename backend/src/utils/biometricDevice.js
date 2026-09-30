// ---------------------------------------------------------------------------
// BIOMETRIC DEVICE — eSSL / ZKTeco ADMS ("iClock") push protocol.
//
// The device is the client: it calls http://<server>:<port>/iclock/... on its
// own schedule. There is nothing for TeamLink to dial out to, so the only
// honest connection status is "when did the device last call us" — every
// request from a registered serial stamps BiometricDevice.lastSeenAt, and the
// Integrations screen reads Connected / Offline from that (deviceState below).
//
// Punches (ATTLOG lines) are kept exactly as received in BiometricPunchLog.
// A line whose PIN is mapped to an employee (Employee.biometricPin) also
// becomes an AttendancePunch with method "Biometric" and marks the day, the
// same way an HR-entered punch does in routes/attendance.js. An unmapped PIN
// waits in the log and is applied when HR maps it (applyPin).
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { isLate, daySplit, directionFromState } = require('./attendanceMath');

// The device heartbeats every `Delay` seconds (we hand it 30 in the options
// below). Three minutes of silence is a missed heartbeat several times over.
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;
const DEVICE_DELAY_SECONDS = 30;

const DEFAULT_DEVICE = {
  vendor: 'eSSL X2008 (ADMS/iClock)',
  serialNumber: 'NFZ8250204996',
  endpoint: 'http://72.61.233.104:8080/iclock',
  status: 'Active',
};

const DEVICE_STATUSES = ['Active', 'Inactive'];

function portOf(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

// "eSSL X2008 (ADMS/iClock)" -> { model: 'eSSL X2008', protocol: 'ADMS/iClock' }
function splitVendor(vendor) {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(vendor || '').trim());
  return m ? { model: m[1], protocol: m[2] } : { model: String(vendor || '').trim(), protocol: 'ADMS/iClock' };
}

// Connected only while heartbeats are arriving. Never guessed.
function deviceState(device, now = Date.now()) {
  if (!device) return { state: 'Not Configured', connected: false };
  if (device.status !== 'Active') return { state: 'Inactive', connected: false };
  if (!device.lastSeenAt) return { state: 'Waiting for device', connected: false };
  const age = now - new Date(device.lastSeenAt).getTime();
  if (age <= HEARTBEAT_FRESH_MS) return { state: 'Connected', connected: true, ageMs: age };
  return { state: 'Offline', connected: false, ageMs: age };
}

function parseInfo(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

async function findDevice(serial) {
  if (!serial) return null;
  return prisma.biometricDevice.findUnique({ where: { serialNumber: String(serial).trim() } });
}

// Devices that called /iclock with a serial nobody registered — shown on the
// screen so a typo in the serial is obvious. In memory only; resets on restart.
const unknownDevices = new Map();
function noteUnknown(serial, ip, path) {
  if (!serial) return;
  unknownDevices.set(String(serial).slice(0, 64), { serial: String(serial).slice(0, 64), ip, path, at: new Date() });
  if (unknownDevices.size > 20) unknownDevices.delete(unknownDevices.keys().next().value);
}
function listUnknown() { return [...unknownDevices.values()]; }

async function touch(device, { ip, request, info }) {
  const data = { lastSeenAt: new Date(), lastSeenIp: ip ? String(ip).slice(0, 64) : null, lastRequest: request };
  if (info) data.deviceInfo = JSON.stringify(info);
  return prisma.biometricDevice.update({ where: { id: device.id }, data });
}

// getrequest?INFO=Ver 8.0.4.2-20230330,12,34,1560,192.168.1.201,10,7,12,12,111
// Order per the ADMS spec: firmware, users, fingerprints, attendance records,
// device IP, FP algorithm, face algorithm, faces needed, faces, flags.
function parseInfoParam(raw) {
  if (!raw) return null;
  const p = String(raw).split(',');
  const info = {
    firmware: p[0] || null,
    users: p[1] != null ? Number(p[1]) : null,
    fingerprints: p[2] != null ? Number(p[2]) : null,
    records: p[3] != null ? Number(p[3]) : null,
    deviceIp: p[4] || null,
    faces: p[8] != null ? Number(p[8]) : null,
  };
  Object.keys(info).forEach((k) => { if (Number.isNaN(info[k])) info[k] = null; });
  return info;
}

// The reply to the device's first call (GET /iclock/cdata?SN=..&options=all).
function optionsReply(device) {
  return [
    `GET OPTION FROM: ${device.serialNumber}`,
    `ATTLOGStamp=${device.attlogStamp || '0'}`,
    `Stamp=${device.attlogStamp || '0'}`,
    'OPERLOGStamp=9999',
    'OpStamp=9999',
    'ATTPHOTOStamp=None',
    'ErrorDelay=30',
    `Delay=${DEVICE_DELAY_SECONDS}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser',
    'Realtime=1',
    'Encrypt=None',
  ].join('\n');
}

// Marks the day from ALL of that day's punches with the shared rule
// (attendanceMath.daySplit): first check-in, last check-out, or the latest
// punch when check-out was never pressed. Recomputed on every punch, so a
// batch that arrives out of order still ends up right.
async function markDay(employeeId, date, cfg) {
  const punches = await prisma.attendancePunch.findMany({ where: { employeeId, date } });
  const day = daySplit(punches);
  const checkIn = day.checkIn ? day.checkIn.time : null;
  const checkOut = day.checkOut ? day.checkOut.time : null;
  const existing = await prisma.attendance.findUnique({ where: { employeeId_date: { employeeId, date } } });
  if (!existing) {
    await prisma.attendance.create({
      data: { employeeId, date, status: checkIn && isLate(checkIn, cfg.graceTime) ? 'Late' : 'Present', checkIn, checkOut },
    });
  } else if (existing.checkIn !== checkIn || existing.checkOut !== checkOut) {
    await prisma.attendance.update({ where: { id: existing.id }, data: { checkIn, checkOut } });
  }
}

async function hrConfig() {
  let config = await prisma.hrConfig.findFirst();
  if (!config) config = await prisma.hrConfig.create({ data: {} });
  return config;
}

// One log line -> AttendancePunch. The direction is the state key the person
// pressed on the device (1 / 2 / 5 are check-out states, anything else is a
// check-in). A check-out exists only when the person pressed check-out.
async function applyLog(log, employeeId, device, cfg) {
  const [date, clock] = log.punchAt.split(' ');
  const time = (clock || '').slice(0, 5);
  const punch = await prisma.attendancePunch.create({
    data: {
      employeeId, date, time, direction: directionFromState(log.statusCode), method: 'Biometric',
      location: device ? `${splitVendor(device.vendor).model} · ${device.serialNumber}` : null,
      source: 'Biometric device', verificationStatus: 'Device',
      deviceState: log.statusCode, deviceVerify: log.verifyCode, clockTime: (clock || '').slice(0, 8) || null,
    },
  });
  await markDay(employeeId, date, cfg);
  await prisma.biometricPunchLog.update({ where: { id: log.id }, data: { employeeId, attendancePunchId: punch.id } });
  return punch;
}

// POST /iclock/cdata?table=ATTLOG — lines of
//   PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode \t ...
async function ingestAttlog(device, body) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cfg = await hrConfig();
  const pinCache = new Map();
  let stored = 0; let duplicate = 0; let applied = 0; let unmapped = 0; let invalid = 0;
  let latest = device.lastPunchAt || null;
  for (const line of lines) {
    const f = line.split('\t');
    const pin = String(f[0] || '').trim();
    const punchAt = String(f[1] || '').trim();
    if (!pin || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(punchAt)) { invalid += 1; continue; }
    const at = punchAt.length === 16 ? `${punchAt}:00` : punchAt;
    const key = { deviceSerial: device.serialNumber, pin, punchAt: at };
    // eslint-disable-next-line no-await-in-loop
    const seen = await prisma.biometricPunchLog.findUnique({ where: { deviceSerial_pin_punchAt: key } });
    if (seen) { duplicate += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const log = await prisma.biometricPunchLog.create({
      data: { ...key, statusCode: f[2] != null ? String(f[2]).trim() : null, verifyCode: f[3] != null ? String(f[3]).trim() : null, raw: line.slice(0, 500) },
    });
    stored += 1;
    if (!latest || at > latest) latest = at;
    if (!pinCache.has(pin)) {
      // eslint-disable-next-line no-await-in-loop
      const emp = await prisma.employee.findFirst({ where: { biometricPin: pin }, select: { id: true } });
      pinCache.set(pin, emp ? emp.id : null);
    }
    const employeeId = pinCache.get(pin);
    if (employeeId) {
      // eslint-disable-next-line no-await-in-loop
      await applyLog(log, employeeId, device, cfg);
      applied += 1;
    } else unmapped += 1;
  }
  await prisma.biometricDevice.update({
    where: { id: device.id },
    data: { punchesReceived: { increment: stored }, lastPunchAt: latest },
  });
  return { lines: lines.length, stored, duplicate, applied, unmapped, invalid };
}

// POST /iclock/cdata?table=OPERLOG — keeps the USER lines (PIN + name) so HR
// can see who a PIN is when mapping it. Everything else is acknowledged.
async function ingestOperlog(device, body) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let users = 0;
  for (const line of lines) {
    // OPERLOG sends "USER PIN=.."; a USERINFO upload sends "PIN=.." alone.
    if (!/^(USER\s|PIN=)/i.test(line)) continue;
    const fields = {};
    line.replace(/^USER\s+/i, '').split('\t').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) fields[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    if (!fields.PIN) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.biometricDeviceUser.upsert({
      where: { deviceSerial_pin: { deviceSerial: device.serialNumber, pin: fields.PIN } },
      create: { deviceSerial: device.serialNumber, pin: fields.PIN, name: fields.Name || null },
      update: { name: fields.Name || null },
    });
    users += 1;
  }
  return { lines: lines.length, users };
}

// ---- Commands to the device ------------------------------------------------
// ADMS has no way to call the device: a command waits here and goes out as the
// reply to its next heartbeat (GET /iclock/getrequest) as "C:<id>:<command>".
// The device answers on POST /iclock/devicecmd with "ID=<id>&Return=<code>".
// In memory: a restart drops anything not yet sent, which is harmless.
const pendingCommands = new Map(); // serial -> [{ id, cmd, queuedAt }]
const lastCommand = new Map(); // serial -> { id, cmd, queuedAt, sentAt, returnedAt, returnCode }
let commandSeq = Math.floor(Date.now() / 1000) % 100000;

function queueCommand(serial, cmd) {
  const list = pendingCommands.get(serial) || [];
  const queued = list.find((c) => c.cmd === cmd);
  if (queued) return queued;
  commandSeq += 1;
  const entry = { id: commandSeq, cmd, queuedAt: new Date() };
  list.push(entry);
  pendingCommands.set(serial, list);
  lastCommand.set(serial, { ...entry, sentAt: null, returnedAt: null, returnCode: null });
  return entry;
}

// The full user list (PIN + name), so every enrolled person can be linked,
// not only the ones who have punched since the device was switched over.
function queueUserQuery(serial) { return queueCommand(serial, 'DATA QUERY USERINFO'); }

// Asked once per server start when TeamLink has no names for the device yet.
const userQueryChecked = new Set();
async function queueUserQueryIfEmpty(serial) {
  if (userQueryChecked.has(serial)) return;
  userQueryChecked.add(serial);
  const known = await prisma.biometricDeviceUser.count({ where: { deviceSerial: serial } });
  if (!known) queueUserQuery(serial);
}

function takeCommands(serial) {
  const list = pendingCommands.get(serial) || [];
  if (!list.length) return null;
  pendingCommands.delete(serial);
  const last = lastCommand.get(serial);
  if (last && list.some((c) => c.id === last.id)) last.sentAt = new Date();
  return list.map((c) => `C:${c.id}:${c.cmd}`).join('\n');
}

// "ID=12&Return=0&CMD=DATA", one line per command that ran.
function noteCommandReply(serial, body) {
  const last = lastCommand.get(serial);
  if (!last) return;
  String(body || '').split(/\r?\n/).forEach((line) => {
    const q = new URLSearchParams(line.trim());
    if (Number(q.get('ID')) === last.id) { last.returnedAt = new Date(); last.returnCode = q.get('Return'); }
  });
}

function commandStatus(serial) {
  const last = lastCommand.get(serial);
  if (!last) return null;
  return { ...last, pending: (pendingCommands.get(serial) || []).some((c) => c.id === last.id) };
}

// HR mapped a PIN to an employee: every waiting log line for it is applied.
async function applyPin(pin, employeeId) {
  const logs = await prisma.biometricPunchLog.findMany({ where: { pin, employeeId: null }, orderBy: { punchAt: 'asc' } });
  if (!logs.length) return 0;
  const cfg = await hrConfig();
  const devices = new Map();
  for (const log of logs) {
    if (!devices.has(log.deviceSerial)) {
      // eslint-disable-next-line no-await-in-loop
      devices.set(log.deviceSerial, await findDevice(log.deviceSerial));
    }
    // eslint-disable-next-line no-await-in-loop
    await applyLog(log, employeeId, devices.get(log.deviceSerial), cfg);
  }
  return logs.length;
}

module.exports = {
  DEFAULT_DEVICE, DEVICE_STATUSES, HEARTBEAT_FRESH_MS,
  portOf, splitVendor, deviceState, parseInfo, parseInfoParam, findDevice, touch,
  noteUnknown, listUnknown, optionsReply, ingestAttlog, ingestOperlog, applyPin,
  queueUserQuery, queueUserQueryIfEmpty, takeCommands, noteCommandReply, commandStatus,
};

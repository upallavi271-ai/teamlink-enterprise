// ---------------------------------------------------------------------------
// PHONE LINES for manual calling (founder 2026-11-23: "call through ViciDial, Synway, Dinstar and by IP address").
//
// A line is where a manual call leaves our Asterisk:
//   built-in "Office Synway (SIM)"  = the hand-written endpoint teamlink-gw (deploy/ai-voice). NEVER written here.
//   every other line                = a row in "BrowserCallLine"; this file renders it into two generated Asterisk files:
//       /etc/asterisk/pjsip_tl_lines.conf        endpoint tl-line-<shortId> (+ aor, auth, identify)
//       /etc/asterisk/extensions_tl_lines.conf   [tl-line-route]: one extension per line (l<shortId>) + "default" (teamlink-gw)
//
// Two ways a line connects:
//   register  the device (Synway / Dinstar / ViciDial) registers to US on UDP 5160 (transport-gw) with a username + a generated password.
//             The password is shown to the Admin ONCE (create / "New password") and is otherwise only ever stored encrypted.
//   ip        WE send calls to its IP address (aor contact sip:<host>:<port>), optional username/password if the far end asks,
//             optional "accept calls from this IP only" (type=identify).
//
// The SERVER decides the line of a browser call: POST /browser-calling/calls checks the line (exists, switched on, the caller's role may use it,
// not full) and hands back the X-TL-Line header value; [browser-out] only uses a value that exists in [tl-line-route], else "default".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const S = require('./schema');
const CFG = require('./config');
const { encryptSecret, decryptSecret } = require('../utils/secrets');

const { ENV } = CFG;

const TYPES = {
  synway: {
    label: 'Synway SIM gateway',
    help: 'A Synway SIM gateway (like the office one). Easiest: the gateway registers to us. In the gateway web page open VoIP > SIP Settings and type the server, port, username and password shown after you save; transport UDP. If the gateway has a fixed public address and the office router forwards its SIP port to it, you can instead choose "We send calls to its IP address".',
  },
  dinstar: {
    label: 'Dinstar SIM gateway',
    help: 'A Dinstar SIM gateway (UC2000 / DWG). Way 1, it registers to us: in the Dinstar web page open SIP > SIP Server (or "SIP Trunk" on newer models), set Register = Yes, server 72.61.233.104, port 5160, and the username and password shown after you save. Way 2, by IP: forward a port on the office router to the Dinstar\'s SIP port (usually 5060), set the Dinstar to accept calls from 72.61.233.104 without registering, and choose "We send calls to its IP address" here with the office public IP and that port. If the Dinstar uses port groups, put the group prefix in "Prefix".',
  },
  vicidial: {
    label: 'ViciDial server',
    help: 'A ViciDial server is just another SIP phone system to us. In ViciDial open Admin > Carriers > Add A New Carrier. By IP (simplest): Registration String empty, Account Entry: [teamlink] type=friend, host=72.61.233.104, port=5060, disallow=all, allow=alaw, allow=ulaw, dtmfmode=rfc2833, insecure=port,invite, context=default (the context where ViciDial\'s own outbound dial plan lives), and choose "We send calls to its IP address" here with the ViciDial server\'s IP, port 5060, "accept calls from this IP only" ticked. To register instead: Registration String register => <username>:<password>@72.61.233.104:5160/<username> with the values shown after you save. If ViciDial expects a dial prefix for that carrier (for example 9), put it in "Prefix".',
  },
  ip: {
    label: 'Other SIP by IP address',
    help: 'Any SIP trunk, IP-PBX or gateway that can be reached by its IP address. Ask the provider to allow our address 72.61.233.104 (IP authentication), or type the username and password they gave you. Tick "accept calls from this IP only" so calls that come back from it are recognised.',
  },
};
const CONNECTS = { register: 'The device registers to us', ip: 'We send calls to its IP address' };
const FORMATS = { 10: '10 digits (9876543210)', 0: '0 + 10 digits (09876543210)', 91: '91 + 10 digits (919876543210)', e164: '+91 + 10 digits (+919876543210)' };
const ALL_KINDS = ['admin', 'tl', 'recruiter', 'hr', 'bdetl', 'bde'];

const DEFAULT_LINE = Object.freeze({
  id: 'default', shortId: null, name: 'Office Synway (SIM)', type: 'synway', typeLabel: TYPES.synway.label, connect: 'register', connectLabel: CONNECTS.register,
  host: null, port: null, transport: 'udp', username: 'teamlink-gw', hasPassword: true, acceptFromIpOnly: true, dialFormat: '10', prefix: '', callerId: '',
  maxCalls: null, kinds: [], sameAsBrowserCalling: true, active: true, endpoint: 'teamlink-gw', header: 'default', builtIn: true,
  note: 'Built in. Managed by its own hand-written config on the phone system; TeamLink never rewrites it.',
});

const endpointOf = (r) => `tl-line-${r.shortId}`;
const headerOf = (r) => `l${r.shortId}`;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const oneLine = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); // eslint-disable-line no-control-regex
const safeWords = (v) => oneLine(v).replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/[()]/g, '').slice(0, 60); // for comments / NoOp in the generated files
const newPassword = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const b = crypto.randomBytes(20); return Array.from(b, (x) => A[x % A.length]).join(''); };
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const USER = /^[A-Za-z0-9._@+-]{1,64}$/;
const PASS = /^[A-Za-z0-9!$%^&*()_+=.,:~@{}<>?/|-]{1,64}$/; // nothing that breaks a pjsip.conf line (; # [ ] quotes, spaces, backslash)

function kindsOf(r, browserKinds) {
  const own = String(r.kinds || '').split(',').map((x) => x.trim()).filter((x) => ALL_KINDS.includes(x));
  return own.length ? own : browserKinds;
}

/** What the browser may see of a line. Never the password. */
function shape(r) {
  return {
    id: r.id, shortId: r.shortId, name: r.name, type: r.type, typeLabel: (TYPES[r.type] || TYPES.ip).label, connect: r.connect, connectLabel: CONNECTS[r.connect],
    host: r.host || null, port: r.port || null, transport: r.transport || 'udp', username: r.connect === 'register' ? endpointOf(r) : (r.username || null),
    hasPassword: !!r.secretEnc, acceptFromIpOnly: !!r.acceptFromIpOnly, dialFormat: r.dialFormat, prefix: r.prefix || '', callerId: r.callerId || '',
    maxCalls: r.maxCalls, kinds: String(r.kinds || '').split(',').filter(Boolean), sameAsBrowserCalling: !String(r.kinds || '').trim(), active: !!r.active,
    endpoint: endpointOf(r), header: headerOf(r), builtIn: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** Check an Admin's form. `old` = the row being edited (its connect way cannot change: the device was set up for it). */
function validate(b, old) {
  const out = {};
  const name = oneLine(b.name !== undefined ? b.name : old && old.name).slice(0, 60);
  if (!name) return { error: 'Give the line a name (for example "Dinstar office 2").' };
  if (/^office synway/i.test(name)) return { error: 'That name belongs to the built-in office line. Pick another name.' };
  out.name = name;
  const type = String(b.type !== undefined ? b.type : (old && old.type) || '').toLowerCase();
  if (!TYPES[type]) return { error: 'Pick the kind of line: Synway SIM gateway, Dinstar SIM gateway, ViciDial server or Other SIP by IP address.' };
  out.type = type;
  const connect = old ? old.connect : String(b.connect || '').toLowerCase();
  if (!CONNECTS[connect]) return { error: 'Say how it connects: the device registers to us, or we send calls to its IP address.' };
  out.connect = connect;
  const host = oneLine(b.host !== undefined ? b.host : old && old.host).toLowerCase();
  const accept = b.acceptFromIpOnly !== undefined ? !!b.acceptFromIpOnly : !!(old && old.acceptFromIpOnly);
  if (connect === 'ip') {
    if (!host) return { error: 'Type the IP address (or host name) to send calls to.' };
    if (!IPV4.test(host) && !HOST.test(host)) return { error: 'That IP address / host name does not look right.' };
    const port = b.port === undefined || b.port === '' || b.port === null ? ((old && old.port) || 5060) : Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The port must be a number from 1 to 65535 (usually 5060).' };
    const transport = String(b.transport !== undefined ? b.transport : (old && old.transport) || 'udp').toLowerCase();
    if (!['udp', 'tcp'].includes(transport)) return { error: 'Transport must be UDP or TCP.' };
    const username = oneLine(b.username !== undefined ? b.username : old && old.username);
    if (username && !USER.test(username)) return { error: 'The username may use letters, digits and . _ @ + - only (up to 64).' };
    Object.assign(out, { host, port, transport, username: username || null });
    if (b.password !== undefined && b.password !== null && b.password !== '') {
      if (!PASS.test(String(b.password))) return { error: 'The password may not contain spaces, quotes, ; # [ ] or a backslash (up to 64 characters).' };
      out.password = String(b.password);
    }
    if (b.clearPassword) out.password = '';
  } else {
    // a registering device: the address is optional, only used to refuse registrations from anywhere else
    if (host && !IPV4.test(host)) return { error: 'For a device that registers to us, the address (optional) must be its public IP address, like 183.82.4.247.' };
    if (accept && !host) return { error: '"Accept calls from this IP only" needs the device\'s public IP address.' };
    Object.assign(out, { host: host || null, port: null, transport: 'udp', username: null });
  }
  out.acceptFromIpOnly = accept ? 1 : 0;
  const fmt = String(b.dialFormat !== undefined ? b.dialFormat : (old && old.dialFormat) || '10');
  if (!FORMATS[fmt]) return { error: 'Pick how the number is dialled: 10 digits, 0 + 10, 91 + 10 or +91 + 10.' };
  out.dialFormat = fmt;
  const prefix = oneLine(b.prefix !== undefined ? b.prefix : (old && old.prefix) || '');
  if (!/^[0-9*#]{0,8}$/.test(prefix)) return { error: 'The prefix may only be digits, * or # (up to 8), for example a ViciDial or Dinstar port-group prefix.' };
  out.prefix = prefix;
  const callerId = oneLine(b.callerId !== undefined ? b.callerId : (old && old.callerId) || '').replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{0,15}$/.test(callerId)) return { error: 'The caller ID must be a phone number (digits, an optional + in front).' };
  out.callerId = callerId;
  const max = b.maxCalls === undefined || b.maxCalls === '' ? ((old && old.maxCalls) || 4) : Number(b.maxCalls);
  if (!Number.isInteger(max) || max < 1 || max > 64) return { error: 'Max calls at once must be from 1 to 64 (usually the number of SIM slots).' };
  out.maxCalls = max;
  if (b.kinds !== undefined) {
    const list = (Array.isArray(b.kinds) ? b.kinds : String(b.kinds || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    const bad = list.find((k) => !ALL_KINDS.includes(k));
    if (bad) return { error: `Unknown role "${clip(bad, 20)}".` };
    out.kinds = [...new Set(list)].join(',');
  } else out.kinds = (old && old.kinds) || '';
  return { data: out };
}

async function rows() { return S.all('SELECT * FROM "BrowserCallLine" ORDER BY "createdAt"'); }
async function byId(id) { return S.one('SELECT * FROM "BrowserCallLine" WHERE "id"=?', clip(id, 60)); }

/** The values to type into a device that registers to us (shown once). */
const setupFor = (r, password) => ({ server: ENV.publicIp, port: ENV.registerPort, transport: 'UDP', username: endpointOf(r), password });

async function create(user, b) {
  const v = validate(b || {});
  if (v.error) return { status: 400, error: v.error };
  const d = v.data;
  let shortId;
  for (let i = 0; i < 10; i += 1) {
    shortId = crypto.randomBytes(3).toString('hex');
    if (!await S.one('SELECT "id" FROM "BrowserCallLine" WHERE "shortId"=?', shortId)) break; // eslint-disable-line no-await-in-loop
  }
  const password = d.connect === 'register' ? newPassword() : (d.password || '');
  let secretEnc = '';
  try { secretEnc = password ? encryptSecret(password) : ''; } catch (e) { return { status: 500, error: e.message }; }
  const id = crypto.randomUUID(); const now = S.nowIso();
  await S.run('INSERT INTO "BrowserCallLine" ("id","shortId","name","type","connect","host","port","transport","username","secretEnc","acceptFromIpOnly","dialFormat","prefix","callerId","maxCalls","kinds","active","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
    id, shortId, d.name, d.type, d.connect, d.host, d.port, d.transport, d.username, secretEnc || null, d.acceptFromIpOnly, d.dialFormat, d.prefix || null, d.callerId || null, d.maxCalls, d.kinds || null, user.id, now, now);
  const r = await byId(id);
  return { line: shape(r), setup: d.connect === 'register' ? setupFor(r, password) : null };
}

async function update(user, id, b) {
  const old = await byId(id);
  if (!old) return { status: 404, error: 'Line not found.' };
  const v = validate(b || {}, old);
  if (v.error) return { status: 400, error: v.error };
  const d = v.data;
  let secretEnc = old.secretEnc;
  if (d.connect === 'ip' && d.password !== undefined) {
    try { secretEnc = d.password ? encryptSecret(d.password) : null; } catch (e) { return { status: 500, error: e.message }; }
  }
  const active = b.active === undefined ? old.active : (b.active ? 1 : 0);
  await S.run('UPDATE "BrowserCallLine" SET "name"=?,"type"=?,"host"=?,"port"=?,"transport"=?,"username"=?,"secretEnc"=?,"acceptFromIpOnly"=?,"dialFormat"=?,"prefix"=?,"callerId"=?,"maxCalls"=?,"kinds"=?,"active"=?,"updatedAt"=? WHERE "id"=?',
    d.name, d.type, d.host, d.port, d.transport, d.username, secretEnc, d.acceptFromIpOnly, d.dialFormat, d.prefix || null, d.callerId || null, d.maxCalls, d.kinds || null, active, S.nowIso(), old.id);
  return { line: shape(await byId(old.id)), before: shape(old) };
}

/** A registering device's password is lost: make a new one (shown once). The device must be given it again. */
async function rotatePassword(id) {
  const r = await byId(id);
  if (!r) return { status: 404, error: 'Line not found.' };
  if (r.connect !== 'register') return { status: 400, error: 'Only a device that registers to us has a password from TeamLink. For an IP line, edit the line and type the far end\'s password.' };
  const password = newPassword();
  let enc;
  try { enc = encryptSecret(password); } catch (e) { return { status: 500, error: e.message }; }
  await S.run('UPDATE "BrowserCallLine" SET "secretEnc"=?, "updatedAt"=? WHERE "id"=?', enc, S.nowIso(), r.id);
  return { line: shape(r), setup: setupFor(r, password) };
}

// ---------------------------------------------------------------------------- who may use which line
const kindOf = (u) => require('../outreach/access').kind(u); // eslint-disable-line global-require

/** The lines this login may call on (the built-in one first). */
async function usableBy(user) {
  const s = await CFG.load();
  const k = kindOf(user);
  const admin = k === 'admin';
  const out = [];
  if (admin || s.kinds.includes(k)) out.push(DEFAULT_LINE);
  for (const r of await rows()) if (r.active && (admin || kindsOf(r, s.kinds).includes(k))) out.push(shape(r));
  return out;
}

/** The server decides a call's line. '' / 'default' = the built-in office Synway. Answers { ok, line } or { ok:false, code, reason }. */
async function resolveForCall(user, lineId) {
  const id = clip(lineId, 60);
  const s = await CFG.load();
  const k = kindOf(user);
  const admin = k === 'admin';
  if (!id || id === 'default') {
    if (!admin && !s.kinds.includes(k)) return { ok: false, code: 403, reason: 'Your role may not call on the office line.' };
    return { ok: true, line: DEFAULT_LINE };
  }
  const r = await byId(id);
  if (!r) return { ok: false, code: 404, reason: 'That phone line does not exist.' };
  if (!r.active) return { ok: false, code: 409, reason: `The line "${r.name}" is switched off. Pick another line.` };
  if (!admin && !kindsOf(r, s.kinds).includes(k)) return { ok: false, code: 403, reason: `Your role may not call on the line "${r.name}".` };
  return { ok: true, line: shape(r), row: r };
}

// ---------------------------------------------------------------------------- the generated Asterisk files
const FMT = { 10: '${ARG1}', 0: '0${ARG1}', 91: '91${ARG1}', e164: '+91${ARG1}' }; // eslint-disable-line no-template-curly-in-string

function renderPjsip(list) {
  const out = [
    '; GENERATED by TeamLink backend/src/browsercall/lines.js - do not edit by hand (phone lines for manual calling).',
    '; Included from pjsip.conf. The built-in office Synway (teamlink-gw) is NOT in this file: it keeps its own hand-written config.',
  ];
  for (const r of list) {
    if (!r.active) continue;
    const ep = endpointOf(r);
    const secret = r.secretEnc ? decryptSecret(r.secretEnc) : '';
    const label = `${safeWords(r.name)} (${(TYPES[r.type] || TYPES.ip).label})`;
    if (r.connect === 'register') {
      if (!secret) { out.push('', `; Line "${label}" skipped: its password cannot be read (INTEGRATION_SECRET_KEY changed?). Make a new password in TeamLink.`); continue; }
      out.push('', `; Line "${label}" - the device registers to us (UDP ${ENV.registerPort})`,
        `[${ep}-auth]`, 'type=auth', 'auth_type=userpass', `username=${ep}`, `password=${secret}`,
        '', `[${ep}]`, 'type=aor', 'max_contacts=1', 'remove_existing=yes', 'qualify_frequency=30',
        '', `[${ep}]`, 'type=endpoint', 'transport=transport-gw', 'context=from-provider', 'disallow=all', 'allow=alaw,ulaw',
        `auth=${ep}-auth`, `aors=${ep}`, 'identify_by=username,auth_username', 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes');
      if (r.acceptFromIpOnly && r.host) out.push('deny=0.0.0.0/0.0.0.0', `permit=${r.host}/255.255.255.255`);
    } else {
      const tcp = r.transport === 'tcp';
      const auth = !!(r.username && secret);
      out.push('', `; Line "${label}" - we send calls to ${r.host}:${r.port} (${tcp ? 'TCP' : 'UDP'})`);
      if (auth) out.push(`[${ep}-auth]`, 'type=auth', 'auth_type=userpass', `username=${r.username}`, `password=${secret}`, '');
      out.push(`[${ep}]`, 'type=aor', `contact=sip:${r.host}:${r.port}${tcp ? ';transport=tcp' : ''}`, 'qualify_frequency=30',
        '', `[${ep}]`, 'type=endpoint', `transport=${tcp ? 'transport-tcp' : 'transport-udp'}`, 'context=from-provider', 'disallow=all', 'allow=alaw,ulaw', `aors=${ep}`);
      if (auth) out.push(`outbound_auth=${ep}-auth`);
      if (r.username) out.push(`from_user=${r.username}`);
      out.push('direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes');
      if (r.acceptFromIpOnly) out.push('', `[${ep}-ip]`, 'type=identify', `endpoint=${ep}`, `match=${r.host}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// SILENT RECORDING (founder 2026-11-23: "the call must be recorded; the candidate must NOT hear any 'this call is being recorded' message"):
// MixMonitor with option b only (audio is saved only while the two sides are bridged = after the answer; both sides mixed into one file),
// no B() beep, no announcement played to anyone. The file is named by the call token (hex): <recDir>/<token>.wav. Only when the Admin
// switch "Record calls" is on; switching it off rewrites this file without the line.
const recLine = (recDir, tokenVar) => ` same => n,MixMonitor(${recDir}/\${FILTER(a-z0-9,\${${tokenVar}})}.wav,b)`;

function renderDialplan(list, opts = {}) {
  const record = !!opts.record;
  const recDir = String(opts.recDir || ENV.recDir).replace(/[^A-Za-z0-9/._-]/g, '');
  const out = [
    '; GENERATED by TeamLink backend/src/browsercall/lines.js - do not edit by hand (phone lines for manual calling).',
    '; Included from extensions.conf. [browser-out] sends a browser call here: Gosub(tl-line-route,<line>,1(<10-digit number>)).',
    `; Recording: ${record ? `ON, silent (MixMonitor option b, no beep, no announcement) into ${recDir}` : 'OFF (switched off by an Admin)'}.`,
    '[tl-line-route]',
    `exten => default,1,NoOp(TeamLink line: ${DEFAULT_LINE.name.replace(/[()]/g, '')})`,
  ];
  if (record) out.push(recLine(recDir, 'TLTOKEN'));
  out.push(' same => n,Dial(PJSIP/${ARG1}@teamlink-gw,45)', // eslint-disable-line no-template-curly-in-string
    ' same => n,Return()');
  for (const r of list) {
    if (!r.active) continue;
    if (r.connect === 'register' && !(r.secretEnc && decryptSecret(r.secretEnc))) continue; // not in pjsip either
    const h = headerOf(r);
    out.push('', `exten => ${h},1,NoOp(TeamLink line: ${safeWords(r.name)})`,
      ` same => n,Set(GROUP(tllines)=${h})`,
      ` same => n,GotoIf($[\${GROUP_COUNT(${h}@tllines)} > ${r.maxCalls}]?full)`);
    if (r.callerId) out.push(` same => n,Set(CALLERID(num)=${r.callerId})`);
    if (record) out.push(recLine(recDir, 'TLTOKEN'));
    out.push(` same => n,Dial(PJSIP/${r.prefix || ''}${FMT[r.dialFormat] || FMT[10]}@${endpointOf(r)},45)`,
      ' same => n,Return()',
      ` same => n(full),NoOp(All ${r.maxCalls} calls of this line are in use)`,
      ' same => n,Hangup(34)');
  }
  // CLICK-TO-CALL on a phone line (Call window, utils/callLines.js): Dial(...,U(tl-c2c-answer^<token>)) runs this on the candidate's leg the
  // moment they answer: it tells TeamLink (AMI UserEvent) and, when recording is on, starts the same silent MixMonitor.
  out.push('', '[tl-c2c-answer]', 'exten => s,1,UserEvent(TLCall,Token: ${ARG1},Answered: 1)'); // eslint-disable-line no-template-curly-in-string
  if (record) out.push(recLine(recDir, 'ARG1'));
  out.push(' same => n,Return()');
  return `${out.join('\n')}\n`;
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (e, so) => (e ? reject(e) : resolve(so))));
const isPbx = () => fs.existsSync(path.dirname(ENV.linesPjsipFile)) && fs.existsSync(path.dirname(ENV.linesDialplanFile));
let lastWrite = null;

/** Write both files atomically and reload Asterisk. On a machine that is not the phone system (no /etc/asterisk) nothing is written. */
async function writeConfig() {
  const list = await rows();
  if (!isPbx()) {
    lastWrite = { pbx: false, written: false, reloaded: false, at: S.nowIso(), note: 'This server is not the phone system (no /etc/asterisk here): the lines are saved in TeamLink, but Asterisk was not changed.' };
    return lastWrite;
  }
  const put = async (file, text) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o640 });
    await run('chgrp', ['asterisk', tmp]).catch(() => {}); // Asterisk runs as "asterisk": it must be able to read the file
    fs.renameSync(tmp, file);
  };
  try {
    await put(ENV.linesPjsipFile, renderPjsip(list));
    const s = await CFG.load();
    await put(ENV.linesDialplanFile, renderDialplan(list, { record: s.record }));
  } catch (e) {
    lastWrite = { pbx: true, written: false, reloaded: false, at: S.nowIso(), error: `Could not write the phone system files: ${clip(e.message, 160)}` };
    return lastWrite;
  }
  try { const now = new Date(); fs.utimesSync(ENV.mainConf, now, now); } catch { /* Asterisk skips a reload when pjsip.conf looks unchanged */ }
  try {
    await run(ENV.reloadCmd, ['-rx', 'module reload res_pjsip.so']);
    await run(ENV.reloadCmd, ['-rx', 'dialplan reload']);
    lastWrite = { pbx: true, written: true, reloaded: true, at: S.nowIso() };
  } catch (e) {
    lastWrite = { pbx: true, written: true, reloaded: false, at: S.nowIso(), error: `The files are written, but Asterisk did not reload: ${clip(e.message, 160)}` };
  }
  return lastWrite;
}

// ---------------------------------------------------------------------------- live state (Asterisk contacts)
// The state of every contact: AMI PJSIPShowContacts (needs a manager user with the "system" right), else `asterisk -rx "pjsip show contacts"`
// (the backend runs as root on the phone system, like the reload). Keyed by endpoint / AOR name.
function parseContactsCli(text) {
  const m = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const x = line.match(/^\s*Contact:\s+([^/\s]+)\/(\S+)\s+\S+\s+(Avail|Unavail|Unknown|NonQual|Created|Removed)\s+([\d.]+|nan)?/);
    if (!x) continue;
    const st = { Avail: 'Reachable', Unavail: 'Unreachable', NonQual: 'NonQualified' }[x[3]] || 'Unknown';
    m[x[1]] = { status: st, rttMs: x[4] && x[4] !== 'nan' ? Math.round(Number(x[4])) : null, uri: x[2] };
  }
  return m;
}
function contactsFromAmiEvents(events) {
  const m = {};
  for (const e of events) {
    if (e.Event !== 'ContactList') continue;
    const aor = String(e.Aor || e.ObjectName || '').split(';')[0] || e.Endpoint;
    const st = /^reach/i.test(e.Status || '') ? 'Reachable' : /^unreach/i.test(e.Status || '') ? 'Unreachable' : /nonqual/i.test(e.Status || '') ? 'NonQualified' : 'Unknown';
    const us = Number(e.RoundtripUsec);
    m[aor] = { status: st, rttMs: Number.isFinite(us) && us > 0 ? Math.round(us / 1000) : null, uri: e.Uri || null };
  }
  return m;
}
async function contactsViaAmi() {
  const sip = require('../calling/voice/sipCall'); // eslint-disable-line global-require
  const { Ami } = require('../calling/voice/ami'); // eslint-disable-line global-require
  const logins = [];
  if (ENV.amiUser && ENV.amiSecret) logins.push({ host: ENV.amiHost, port: ENV.amiPort, user: ENV.amiUser, secret: ENV.amiSecret });
  const c = sip.config().ami;
  if (c.user && c.secret && !logins.some((l) => l.user === c.user)) logins.push(c);
  for (const l of logins) {
    const a = new Ami({ ...l, events: 'off' });
    try {
      await a.connect(); // eslint-disable-line no-await-in-loop
      const id = `tl-contacts-${Date.now()}`; const got = [];
      // eslint-disable-next-line no-await-in-loop
      const done = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 6000);
        a.on('event', (e) => { if (e.ActionID !== id) return; if (e.Event === 'ContactListComplete') { clearTimeout(t); resolve(true); } else got.push(e); });
        a.action({ Action: 'PJSIPShowContacts', ActionID: id }).then((r) => { if (r.Response !== 'Success') { clearTimeout(t); resolve(false); } }).catch(() => { clearTimeout(t); resolve(false); });
      });
      a.close();
      if (done) return { via: 'ami', contacts: contactsFromAmiEvents(got) };
    } catch { try { a.close(); } catch { /* gone */ } }
  }
  return null;
}
async function contactsViaCli() {
  try { return { via: 'cli', contacts: parseContactsCli(await run(ENV.reloadCmd, ['-rx', 'pjsip show contacts'])) }; } catch { return null; }
}
function stateOf(line, contacts) {
  const c = contacts[line.endpoint];
  if (line.connect === 'register') {
    if (!c) return { state: 'Not registered', ok: false, rttMs: null, detail: 'The device has not registered to us (check its server, port, username and password).' };
    if (c.status === 'Unreachable') return { state: 'Unreachable', ok: false, rttMs: null, detail: 'Registered, but it stopped answering.' };
    return { state: 'Registered', ok: true, rttMs: c.rttMs, detail: c.uri };
  }
  if (!c) return { state: 'Not loaded', ok: false, rttMs: null, detail: 'Asterisk does not know this line yet (files not installed or not reloaded).' };
  if (c.status === 'Reachable') return { state: 'Reachable', ok: true, rttMs: c.rttMs, detail: c.uri };
  if (c.status === 'Unreachable') return { state: 'Unreachable', ok: false, rttMs: null, detail: 'It does not answer from that IP address and port.' };
  return { state: 'Checking', ok: false, rttMs: null, detail: 'Asterisk has not heard back yet (it asks every 30 seconds).' };
}
async function statusAll(list) {
  const sandbox = require('../utils/sandbox'); // eslint-disable-line global-require
  if (sandbox.isSandbox() && !['127.0.0.1', 'localhost', '::1'].includes(String(ENV.amiHost))) return { reachable: false, reason: 'Test copy: the phone system is not contacted.', lines: {} };
  const got = (await contactsViaAmi()) || (isPbx() ? await contactsViaCli() : null);
  if (!got) return { reachable: false, reason: isPbx() ? 'Could not read the line states from Asterisk (manager login or "asterisk -rx").' : 'This server is not the phone system, so the live state of the lines cannot be read here.', lines: {} };
  const lines = {};
  for (const l of list) lines[l.id] = stateOf(l, got.contacts);
  return { reachable: true, via: got.via, lines };
}

module.exports = {
  TYPES, CONNECTS, FORMATS, ALL_KINDS, DEFAULT_LINE,
  endpointOf, headerOf, shape, validate, rows, byId, create, update, rotatePassword,
  usableBy, resolveForCall, kindsOf, renderPjsip, renderDialplan, writeConfig, isPbx, lastWrite: () => lastWrite,
  parseContactsCli, contactsFromAmiEvents, stateOf, statusAll,
};

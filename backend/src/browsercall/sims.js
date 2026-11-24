// ---------------------------------------------------------------------------
// ONE SIM NUMBER PER RECRUITER (founder 2026-11-25: "assign one number to a particular recruiter, so their calls go out from that number and
// when the candidate calls back, the call comes to that recruiter").
//
// The office Synway SMG4016 has 16 GSM ports and registers to our Asterisk as ONE SIP account (teamlink-gw). An Admin lists the ports in use
// (port 1-16, the SIM's number, operator, on/off) and gives each to at most one person (a person has at most one port).
//
// OUT  Synway picks a GSM port by an "IP -> GSM" routing rule on a dial PREFIX (set on the gateway). Each port has a prefix (default "<2-digit
//      port>#", e.g. "01#"). While the Admin switch "Port prefix routing" is ON, a browser call of a person with a port on the office Synway line
//      goes out as Dial(PJSIP/<prefix><number>@teamlink-gw): the SERVER picks it (POST /browser-calling/calls hands back the X-TL-Line value
//      p<NN>, and the generated [tl-line-route] extension p<NN> only dials that port for the person's own extension - CHANNEL(endpoint) - anyone
//      else falls back to "default"). Switch OFF (the default) = exactly today's behaviour.
// IN   The gateway puts the receiving port's SIM number (or a tag like "port01") in the called number. [from-provider] sends every call to
//      [tl-from-gateway] (generated here, /etc/asterisk/extensions_tl_sims.conf): a port with a person on it rings that person's browser
//      extension for 30 s, recorded silently like an outbound call; not registered / no answer / declined = a MISSED call (bell notice,
//      a row in the candidate's call history, optionally a "Call back" follow-up). Unknown numbers and ports with nobody: hang up as before,
//      unless an Admin picked a person to ring instead ("fallback").
// The AI phone calls are not touched: they are originated by Asterisk (Stasis) and never pass through [from-provider].
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const S = require('./schema');
const CFG = require('./config');

const { ENV } = CFG;
const PORT_MAX = 16;
const SIM_KINDS = ['admin', 'tl', 'recruiter', 'hr']; // BDE, BDE TL and Manager (view only) never get a SIM
const OPERATORS = ['Jio', 'Airtel', 'Vi', 'BSNL', 'Other'];
const MATCH = { number: 'SIM number', tag: 'Port tag' };
const pad2 = (n) => String(n).padStart(2, '0');
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const oneLine = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); // eslint-disable-line no-control-regex
const safeWords = (v) => oneLine(v).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60);
const kindOf = (u) => require('../outreach/access').kind(u); // eslint-disable-line global-require
const core = () => require('../utils/messagingCore'); // eslint-disable-line global-require
const mask = (n) => (n ? `${String(n).slice(0, 2)}XXXXXX${String(n).slice(-2)}` : 'an unknown number');
const headerOfPort = (port) => `p${pad2(port)}`;
const simsFile = () => process.env.BROWSER_CALL_SIMS_DIALPLAN_FILE || path.join(path.dirname(ENV.linesDialplanFile), 'extensions_tl_sims.conf');

// ---------------------------------------------------------------------------- settings (BrowserCallSetting keys)
const SET_DEFAULTS = { 'sim.prefixRouting': '0', 'sim.fallbackUserId': '', 'sim.missedTask': '0' };
async function settings() {
  const rows = await S.all('SELECT "key","value" FROM "BrowserCallSetting" WHERE "key" LIKE \'sim.%\'');
  const m = { ...SET_DEFAULTS };
  rows.forEach((r) => { m[r.key] = r.value; });
  return { prefixRouting: m['sim.prefixRouting'] === '1', fallbackUserId: m['sim.fallbackUserId'] || null, missedTask: m['sim.missedTask'] === '1' };
}
async function saveSettings(patch) {
  const put = (k, v) => S.run('INSERT INTO "BrowserCallSetting" ("key","value","updatedAt") VALUES (?,?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value","updatedAt"=excluded."updatedAt"', k, String(v), S.nowIso());
  if (patch.prefixRouting !== undefined) await put('sim.prefixRouting', patch.prefixRouting ? '1' : '0');
  if (patch.missedTask !== undefined) await put('sim.missedTask', patch.missedTask ? '1' : '0');
  if (patch.fallbackUserId !== undefined) {
    const id = clip(patch.fallbackUserId || '', 60);
    if (id) { const u = await mayHold(id); if (u.error) return { error: u.error }; }
    await put('sim.fallbackUserId', id);
  }
  return { settings: await settings() };
}

// ---------------------------------------------------------------------------- the ports
async function rows() { return S.all('SELECT * FROM "BrowserCallSim" ORDER BY "port"'); }
async function byId(id) { return S.one('SELECT * FROM "BrowserCallSim" WHERE "id"=?', clip(id, 60)); }
async function ofUser(userId) { return userId ? S.one('SELECT * FROM "BrowserCallSim" WHERE "userId"=?', clip(userId, 60)) : null; }

/** The person may hold a SIM: an active ATS login of a kind that calls candidates (never BDE / BDE TL / Manager). */
async function mayHold(userId) {
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  let u = null;
  try { u = await resolveIdentity(userId); } catch { u = null; }
  if (!u || (u.status && u.status !== 'Active')) return { error: 'That person was not found (or is not active).' };
  const k = kindOf(u);
  if (!SIM_KINDS.includes(k)) return { error: `${u.name || 'This person'} cannot get a SIM: BDEs, BDE team leads and Managers (view only) never call candidates from TeamLink.` };
  if (!(u.products || {}).ats && !u.atsAccess) return { error: `${u.name || 'This person'} has no recruitment (ATS) login.` };
  return { user: u, kind: k };
}

function validate(b, old) {
  const out = {};
  const port = b.port !== undefined ? Number(b.port) : (old && old.port);
  if (!Number.isInteger(port) || port < 1 || port > PORT_MAX) return { error: `The port must be a number from 1 to ${PORT_MAX} (the GSM port of the Synway).` };
  out.port = port;
  const rawNum = b.simNumber !== undefined ? b.simNumber : (old && old.simNumber);
  const n = core().normalizeMobile(rawNum);
  if (!n.ok || n.cc !== '91') return { error: 'Type the SIM\'s 10-digit Indian mobile number (like 9876543210).' };
  out.simNumber = n.national;
  const op = oneLine(b.operator !== undefined ? b.operator : (old && old.operator) || '').slice(0, 30);
  if (op && !/^[A-Za-z0-9 .&-]{1,30}$/.test(op)) return { error: 'The operator may use letters, digits, spaces and . & - only.' };
  out.operator = op || null;
  const prefix = oneLine(b.dialPrefix !== undefined && b.dialPrefix !== null && b.dialPrefix !== '' ? b.dialPrefix : ((old && old.port === port && old.dialPrefix) || `${pad2(port)}#`));
  if (!/^[0-9*#]{1,8}$/.test(prefix)) return { error: 'The dial prefix may only be digits, * or # (1 to 8), for example 01#.' };
  out.dialPrefix = prefix;
  const matchBy = String(b.matchBy !== undefined ? b.matchBy : (old && old.matchBy) || 'number');
  if (!MATCH[matchBy]) return { error: 'Say how an incoming call is matched: by the SIM number or by a port tag.' };
  out.matchBy = matchBy;
  const tag = oneLine(b.tag !== undefined && b.tag !== null && b.tag !== '' ? b.tag : ((old && old.port === port && old.tag) || `port${pad2(port)}`)).toLowerCase();
  if (!/^[a-z][a-z0-9]{0,19}$/.test(tag) || tag === 's') return { error: 'The port tag must start with a letter and use only a-z and 0-9 (up to 20), for example port01.' };
  out.tag = tag;
  out.active = b.active === undefined ? (old ? old.active : 1) : (b.active ? 1 : 0);
  out.note = oneLine(b.note !== undefined ? b.note : (old && old.note) || '').slice(0, 120) || null;
  return { data: out };
}

async function clash(d, id) {
  const other = (sql, v) => S.one(`SELECT "id","port" FROM "BrowserCallSim" WHERE ${sql} AND "id"<>?`, v, id || '');
  if (await other('"port"=?', d.port)) return `Port ${d.port} is already in the list. Edit that row instead.`;
  const sn = await other('"simNumber"=?', d.simNumber);
  if (sn) return `That SIM number is already on port ${sn.port}.`;
  const tg = await other('"tag"=?', d.tag);
  if (tg) return `The tag "${d.tag}" is already used by port ${tg.port}.`;
  return null;
}

async function create(user, b) {
  const v = validate(b || {});
  if (v.error) return { status: 400, error: v.error };
  const c = await clash(v.data);
  if (c) return { status: 409, error: c };
  const id = crypto.randomUUID(); const now = S.nowIso(); const d = v.data;
  await S.run('INSERT INTO "BrowserCallSim" ("id","port","simNumber","operator","active","userId","dialPrefix","matchBy","tag","note","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?)',
    id, d.port, d.simNumber, d.operator, d.active, d.dialPrefix, d.matchBy, d.tag, d.note, user.id, now, now);
  if (b && b.userId) { const a = await assign(id, b.userId); if (a.error) return { status: a.status || 400, error: a.error, created: await byId(id) }; }
  return { sim: await byId(id) };
}

async function update(user, id, b) {
  const old = await byId(id);
  if (!old) return { status: 404, error: 'That SIM port is not in the list.' };
  const v = validate(b || {}, old);
  if (v.error) return { status: 400, error: v.error };
  const c = await clash(v.data, old.id);
  if (c) return { status: 409, error: c };
  const d = v.data;
  await S.run('UPDATE "BrowserCallSim" SET "port"=?,"simNumber"=?,"operator"=?,"active"=?,"dialPrefix"=?,"matchBy"=?,"tag"=?,"note"=?,"updatedAt"=? WHERE "id"=?',
    d.port, d.simNumber, d.operator, d.active, d.dialPrefix, d.matchBy, d.tag, d.note, S.nowIso(), old.id);
  if (b && b.userId !== undefined) { const a = await assign(old.id, b.userId); if (a.error) return { status: a.status || 400, error: a.error }; }
  return { sim: await byId(old.id), before: old };
}

/** Give a port to a person (or take it back with an empty userId). One port per person, one person per port. */
async function assign(id, userId) {
  const r = await byId(id);
  if (!r) return { status: 404, error: 'That SIM port is not in the list.' };
  const uid = clip(userId || '', 60);
  if (!uid) { await S.run('UPDATE "BrowserCallSim" SET "userId"=NULL,"updatedAt"=? WHERE "id"=?', S.nowIso(), r.id); return { sim: await byId(r.id), user: null }; }
  const m = await mayHold(uid);
  if (m.error) return { status: 400, error: m.error };
  const has = await ofUser(uid);
  if (has && has.id !== r.id) return { status: 409, error: `${m.user.name} already has port ${has.port}. Take that one back first (a person has one SIM).` };
  await require('./provision').extensionFor(uid); // eslint-disable-line global-require -- the browser extension the port rings (made now, registered when they open TeamLink)
  await S.run('UPDATE "BrowserCallSim" SET "userId"=?,"updatedAt"=? WHERE "id"=?', uid, S.nowIso(), r.id);
  return { sim: await byId(r.id), user: m.user };
}

async function remove(id) {
  const r = await byId(id);
  if (!r) return { status: 404, error: 'That SIM port is not in the list.' };
  await S.run('DELETE FROM "BrowserCallSim" WHERE "id"=?', r.id);
  return { sim: r };
}

async function extensionsByUser() {
  const m = new Map();
  (await S.all('SELECT "userId","extension" FROM "BrowserCallExtension" WHERE "active"=1')).forEach((x) => m.set(x.userId, x.extension));
  return m;
}
async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const prisma = require('../db'); // eslint-disable-line global-require
  const us = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } });
  return new Map(us.map((u) => [u.id, u]));
}

/** What the Admin screen shows of a port. */
function shape(r, ext, names) {
  const u = r.userId ? names.get(r.userId) : null;
  return {
    id: r.id, port: r.port, portLabel: pad2(r.port), simNumber: r.simNumber, operator: r.operator || '', active: !!r.active, note: r.note || '',
    userId: r.userId || null, userName: u ? u.name : (r.userId ? '(unknown person)' : null), extension: r.userId ? (ext.get(r.userId) || null) : null,
    dialPrefix: r.dialPrefix, matchBy: r.matchBy, matchLabel: MATCH[r.matchBy] || r.matchBy, tag: r.tag, header: headerOfPort(r.port),
    calledMatches: r.matchBy === 'tag' ? [r.tag] : calledVariants(r.simNumber),
  };
}
async function adminView() {
  const list = await rows();
  const ext = await extensionsByUser();
  const st = await settings();
  const names = await namesOf([...list.map((r) => r.userId), st.fallbackUserId]);
  return {
    sims: list.map((r) => shape(r, ext, names)), settings: { ...st, fallbackName: st.fallbackUserId ? ((names.get(st.fallbackUserId) || {}).name || null) : null, fallbackExtension: st.fallbackUserId ? (ext.get(st.fallbackUserId) || null) : null },
    portMax: PORT_MAX, operators: OPERATORS, matchKinds: Object.entries(MATCH).map(([id, label]) => ({ id, label })), simKinds: SIM_KINDS, file: simsFile(),
  };
}

// ---------------------------------------------------------------------------- OUT: the server picks the recruiter's port
/** The person's own SIM (for the call bar "Your calling number"), or null. */
async function mineFor(user) {
  const r = await ofUser(user && user.id);
  if (!r || !r.active) return null;
  const st = await settings();
  return { port: r.port, portLabel: pad2(r.port), number: r.simNumber, operator: r.operator || '', routing: st.prefixRouting };
}
/** The route of a call on the built-in office Synway: the person's port while prefix routing is ON, else "default" (today). */
async function routeFor(user, line) {
  if (!line || line.id !== 'default') return { line, sim: null };
  const r = await ofUser(user && user.id);
  if (!r || !r.active) return { line, sim: null };
  const st = await settings();
  if (!st.prefixRouting) return { line, sim: { port: r.port, number: r.simNumber, routed: false } };
  return { line: { ...line, header: headerOfPort(r.port), name: `${line.name} · port ${pad2(r.port)}` }, sim: { port: r.port, number: r.simNumber, prefix: r.dialPrefix, routed: true } };
}

// ---------------------------------------------------------------------------- IN: by the called number
function calledVariants(n) { return n ? [n, `0${n}`, `91${n}`, `+91${n}`] : []; }
/** The port a call to `called` belongs to, exactly as the generated [tl-from-gateway] decides (active ports only). */
async function matchCalled(called) {
  const c = String(called || '').trim().toLowerCase();
  if (!c) return null;
  for (const r of await rows()) {
    if (!r.active) continue;
    if (r.matchBy === 'tag' ? c === r.tag : calledVariants(r.simNumber).includes(c)) return r;
  }
  return null;
}
/** Who rings for a call to `called`: { port, userId, extension } or { fallback } or { nobody }. */
async function routeInbound(called) {
  const r = await matchCalled(called);
  const ext = await extensionsByUser();
  if (r && r.userId && ext.get(r.userId)) return { matched: true, port: r.port, userId: r.userId, extension: ext.get(r.userId), header: headerOfPort(r.port) };
  const st = await settings();
  if (st.fallbackUserId && ext.get(st.fallbackUserId)) return { matched: !!r, port: r ? r.port : null, fallback: true, userId: st.fallbackUserId, extension: ext.get(st.fallbackUserId) };
  return { matched: !!r, port: r ? r.port : null, nobody: true };
}

// ---------------------------------------------------------------------------- the generated dialplan
const recLine = (recDir, tokenVar) => ` same => n,MixMonitor(${recDir}/\${FILTER(a-z0-9,\${${tokenVar}})}.wav,b)`;

/** Extra extensions for [tl-line-route] (extensions_tl_lines.conf): one p<NN> per port with a person, only while prefix routing is ON. */
function renderRouteExtensions(list, ext, opts = {}) {
  if (!opts.prefixRouting) return [];
  const record = !!opts.record;
  const recDir = String(opts.recDir || ENV.recDir).replace(/[^A-Za-z0-9/._-]/g, '');
  const out = [];
  for (const r of list) {
    if (!r.active || !r.userId || !ext.get(r.userId)) continue;
    const h = headerOfPort(r.port);
    out.push('', `exten => ${h},1,NoOp(TeamLink SIM port ${pad2(r.port)}: out on its own SIM)`,
      ` same => n,GotoIf($["\${CHANNEL(endpoint)}"!="${ext.get(r.userId)}"]?default,1)`);
    if (record) out.push(recLine(recDir, 'TLTOKEN'));
    out.push(` same => n,Dial(PJSIP/${r.dialPrefix}\${ARG1}@teamlink-gw,45)`, ' same => n,Return()');
  }
  return out;
}

/** The whole extensions_tl_sims.conf: [tl-from-gateway] (by the called number) + [tl-sim-ring]. */
function renderInbound(list, ext, opts = {}) {
  const record = !!opts.record;
  const recDir = String(opts.recDir || ENV.recDir).replace(/[^A-Za-z0-9/._-]/g, '');
  const names = opts.names || new Map();
  const fallbackExt = opts.fallbackUserId ? ext.get(opts.fallbackUserId) : null;
  const live = list.filter((r) => r.active && r.userId && ext.get(r.userId));
  const out = [
    '; GENERATED by TeamLink backend/src/browsercall/sims.js - do not edit by hand (one SIM number per recruiter).',
    '; Included from extensions.conf. [from-provider] sends every call that comes in from the gateway here: Goto(tl-from-gateway,${EXTEN},1).',
    '; The Synway puts the receiving port\'s SIM number (or its tag, like port01) in the called number. A port with a person on it rings that',
    '; person\'s browser extension for 30 s. Not registered, no answer or declined = a missed call for that person. Anything else hangs up as before.',
    `; Recording: ${record ? `ON, silent (MixMonitor option b, no beep, no announcement) into ${recDir}` : 'OFF (switched off by an Admin)'}.`,
    `; Unknown numbers and ports with nobody on them: ${fallbackExt ? `ring extension ${fallbackExt} (the Admin's fallback)` : 'hang up (as before)'}.`,
    '[tl-from-gateway]',
  ];
  for (const r of live) {
    const keys = r.matchBy === 'tag' ? [r.tag] : calledVariants(r.simNumber);
    keys.forEach((k) => out.push(`exten => ${k},1,Goto(tl-sim-ring,${headerOfPort(r.port)},1)`));
  }
  out.push('exten => _X.,1,Goto(tl-sim-ring,other,1)', 'exten => _+X.,1,Goto(tl-sim-ring,other,1)', 'exten => _[a-z].,1,Goto(tl-sim-ring,other,1)', 'exten => s,1,Goto(tl-sim-ring,other,1)',
    '', '[tl-sim-ring]');
  for (const r of live) {
    const u = names.get(r.userId);
    out.push(`exten => ${headerOfPort(r.port)},1,NoOp(TeamLink SIM port ${pad2(r.port)}${u && u.name ? ` - ${safeWords(u.name)}` : ''})`,
      ` same => n,Set(TLPORT=${pad2(r.port)})`, ` same => n,Set(TLEXT=${ext.get(r.userId)})`, ' same => n,Goto(ring,1)');
  }
  if (fallbackExt) out.push('exten => other,1,NoOp(TeamLink: unknown number or a port with nobody on it - the Admin\'s fallback)', ' same => n,Set(TLPORT=00)', ` same => n,Set(TLEXT=${fallbackExt})`, ' same => n,Goto(ring,1)');
  else out.push('exten => other,1,NoOp(TeamLink: unknown number or a port with nobody on it - hang up as before)', ' same => n,Hangup()');
  out.push('exten => ring,1,GotoIf($["${CHANNEL(endpoint)}"!="teamlink-gw"]?nobody,1)',
    ' same => n,Set(TLTOKEN=in${FILTER(0-9,${UNIQUEID})})',
    ' same => n,UserEvent(TLInbound,Token: ${TLTOKEN},Port: ${TLPORT},Ext: ${TLEXT})',
    ' same => n,Set(CALLERID(name)=TeamLink)',
    ' same => n,Set(CALLERID(num)=${TLTOKEN})');
  if (record) out.push(recLine(recDir, 'TLTOKEN'));
  out.push(' same => n,Dial(PJSIP/${TLEXT},30)',
    ' same => n,UserEvent(TLInbound,Token: ${TLTOKEN},Missed: 1,DialStatus: ${DIALSTATUS})',
    ' same => n,Hangup()',
    'exten => nobody,1,NoOp(TeamLink: not from the office Synway - hang up as before)',
    ' same => n,Hangup()');
  return `${out.join('\n')}\n`;
}

/** Everything the two generated files need from the SIM list (lines.writeConfig calls this). */
async function renderAll(opts = {}) {
  // a port whose person may no longer hold a SIM (left, or became a BDE / Manager) is treated as having nobody on it
  const list = await Promise.all((await rows()).map(async (r) => (r.userId && (await mayHold(r.userId)).error ? { ...r, userId: null } : r)));
  const ext = await extensionsByUser();
  const st = await settings();
  const names = await namesOf(list.map((r) => r.userId));
  return {
    routeLines: renderRouteExtensions(list, ext, { ...opts, prefixRouting: st.prefixRouting }),
    inbound: renderInbound(list, ext, { ...opts, names, fallbackUserId: st.fallbackUserId }),
  };
}

// ---------------------------------------------------------------------------- incoming calls (from AMI, events.js)
const NOT_ANSWERED = {
  CHANUNAVAIL: 'TeamLink was not open on the recruiter\'s computer',
  NOANSWER: 'not answered in 30 seconds',
  BUSY: 'declined by the recruiter',
  CANCEL: 'the candidate hung up before it was answered',
  CONGESTION: 'the phone system could not reach the browser',
};
const missedReason = (dialStatus) => `Missed - called back the recruiter's number${NOT_ANSWERED[dialStatus] ? ` (${NOT_ANSWERED[dialStatus]})` : ''}`;

/** The candidate behind a caller's number, as THIS person may see them (scope), newest first; with the current requirement. */
async function candidateForCaller(user, number) {
  if (!user || !number) return null;
  const prisma = require('../db'); // eslint-disable-line global-require
  const scope = require('../utils/scope'); // eslint-disable-line global-require
  const D = require('../utils/candidateDedupe'); // eslint-disable-line global-require
  const keys = D.phoneKeys(number);
  if (!keys.length) return null;
  const list = await prisma.candidate.findMany({ where: { ...scope.candidateWhere(user), OR: keys.map((k) => ({ phone: { contains: k } })) }, select: { id: true, name: true, phone: true }, orderBy: { createdAt: 'desc' }, take: 20 });
  const hit = list.find((c) => D.phoneKeys(c.phone).some((k) => keys.includes(k)));
  if (!hit) return null;
  const app = await prisma.application.findFirst({ where: { candidateId: hit.id, ...scope.applicationWhere(user) }, orderBy: { updatedAt: 'desc' }, select: { id: true, requirementId: true, requirement: { select: { title: true, reqCode: true, client: { select: { name: true } } } } } }).catch(() => null);
  return { id: hit.id, name: hit.name, applicationId: app ? app.id : null, requirementId: app ? app.requirementId : null, requirement: app && app.requirement ? `${app.requirement.title}${app.requirement.client ? ` · ${app.requirement.client.name}` : ''}` : null };
}

/** UserEvent TLInbound (the first one): write the row of an incoming call. Answers the row id, or null (not ours / unknown port). */
async function onInboundStart(e) {
  const token = String(e.Token || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
  if (!/^in\d{6,}$/.test(token)) return null;
  const old = await S.one('SELECT "id" FROM "BrowserCall" WHERE "token"=?', token);
  if (old) return old.id;
  const portNo = Number(e.Port);
  const extension = String(e.Ext || '').replace(/\D/g, '').slice(0, 10);
  let userId = null; let port = null;
  if (portNo >= 1) { port = await S.one('SELECT * FROM "BrowserCallSim" WHERE "port"=?', portNo); userId = port && port.userId; }
  else { userId = (await settings()).fallbackUserId; }
  if (!userId) return null;
  const ext = await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', userId);
  if (!ext || ext.extension !== extension) return null; // the dialplan rang an extension that is not this person's: not trusted
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  let user = null; try { user = await resolveIdentity(userId); } catch { user = null; }
  if (!user || !SIM_KINDS.includes(kindOf(user))) return null;
  const n = core().normalizeMobile(e.CallerIDNum);
  const number = n.ok ? n.national || String(e.CallerIDNum).replace(/\D/g, '').slice(-10) : '';
  const cand = n.ok ? await candidateForCaller(user, number).catch(() => null) : null;
  const s = await CFG.load();
  const id = crypto.randomUUID(); const now = S.nowIso();
  const lineName = port ? `Office Synway (SIM) · port ${pad2(port.port)}` : 'Office Synway (SIM) · fallback';
  await S.run('INSERT INTO "BrowserCall" ("id","token","asteriskUniqueId","asteriskLinkedId","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus") VALUES (?,?,?,?,?,?,?,?,?,?,\'inbound\',?,\'ringing\',?,?,?,\'default\',?,?)',
    id, token, e.Uniqueid || null, e.Linkedid || e.Uniqueid || null, cand ? cand.id : 'unknown', cand ? cand.applicationId : null, userId, clip(user.name, 80), number || 'unknown', extension, s.mode, now, now, now, lineName, s.record ? 'pending' : 'off');
  return id;
}

/** An incoming call ended without an answer: the bell, the history row's words, and (Admin switch) a "Call back" follow-up. Never throws. */
async function onMissed(row) {
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    let cand = null;
    if (row.candidateId && row.candidateId !== 'unknown') cand = await prisma.candidate.findUnique({ where: { id: row.candidateId }, select: { id: true, name: true } }).catch(() => null);
    const who = cand ? cand.name : mask(row.toNumber !== 'unknown' ? row.toNumber : '');
    const { pushNotification } = require('../utils/notify'); // eslint-disable-line global-require
    await pushNotification({ userId: row.userId, title: 'Missed call', message: `Missed call from ${who} on your SIM (${row.lineName || 'office SIM'}).${cand ? ' Call them back from their profile.' : ''}`, open: cand ? `/candidates/${cand.id}` : '/' });
    const st = await settings();
    if (st.missedTask && cand && row.applicationId) {
      const app = await prisma.application.findUnique({ where: { id: row.applicationId }, select: { id: true, candidateId: true, requirementId: true } });
      const open = app && await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, purpose: 'Missed call', completedAt: null } });
      if (app && !open) {
        const ist = new Date(Date.now() + 330 * 60000).toISOString();
        await prisma.applicationFollowUp.create({ data: {
          applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ownerUserId: row.userId, ownerName: row.userName, ownerRole: 'Recruiter',
          nextAction: 'Call back', purpose: 'Missed call', dueDate: ist.slice(0, 10), dueTime: ist.slice(11, 16), notes: `Missed call from ${cand.name} (${row.lineName || 'office SIM'}).`,
          autoCreated: true, createdById: null, createdByName: 'System',
        } });
      }
    }
  } catch (e) { console.error('[browser-call] missed call:', clip(e.message, 160)); }
}

module.exports = {
  PORT_MAX, SIM_KINDS, OPERATORS, MATCH, pad2, mask, headerOfPort, simsFile,
  settings, saveSettings, rows, byId, ofUser, mayHold, validate, create, update, assign, remove, adminView, shape,
  mineFor, routeFor, calledVariants, matchCalled, routeInbound, renderRouteExtensions, renderInbound, renderAll,
  candidateForCaller, onInboundStart, onMissed, missedReason, NOT_ANSWERED,
};

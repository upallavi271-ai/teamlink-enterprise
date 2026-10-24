// ---------------------------------------------------------------------------
// EXOTEL CLIENT - the ONLY code that speaks HTTP to Exotel for AI calling.
//
//   testConnection(cfg)   READ-ONLY. Lists one call of the account and (optionally) the account's numbers. Places NO call.
//   startCall(cfg, ...)   POST Calls/connect: dials the candidate and connects the answered call to the Voicebot Flow.
//   hangup(cfg, sid)      ends a call that is still ringing.
//
// INJECTABLE: setHttp(fn) replaces the transport (tests use a local FAKE Exotel server or a stub). Nothing here ever reads
// or writes the database. Every URL path / field name comes from ./exotelConfig.js.
//
// SAFETY: in the test sandbox (TEST_MODE) this refuses any address that is not on this computer, so a test can never reach
// the real Exotel. Credentials go only in the HTTP Basic header, never in the URL, a log line or an error text.
// ---------------------------------------------------------------------------
const core = require('../utils/messagingCore');
const sandbox = require('../utils/sandbox');
const X = require('./exotelConfig');

let HTTP = null;
function setHttp(fn) { HTTP = typeof fn === 'function' ? fn : null; }
const send = (url, opts) => (HTTP || core.httpJson)(url, opts);

const basic = (s) => `Basic ${Buffer.from(`${s.key}:${s.token}`).toString('base64')}`;

// The credentials must never leak through an error text.
function clean(text, s) {
  let t = core.tidy(text);
  [s && s.key, s && s.token, s && s.hook].filter((x) => x && x.length >= 4).forEach((secret) => { t = t.split(secret).join('•••'); });
  return t;
}

// The address of the Exotel API for these settings (the region's host; a loopback override only outside production).
function baseOf(s) {
  return core.providerBase(`https://${s.host}`, {});
}

function guardSandbox(base) {
  if (sandbox.isSandbox() && !core.loopback(base)) {
    return { ok: false, blocked: true, error: 'TEST MODE: this computer is a test copy and refuses to contact the real Exotel.' };
  }
  return null;
}

function wordsFor(res, s) {
  const j = res.json || {};
  const said = (j.RestException && (j.RestException.Message || j.RestException.Status)) || j.message || res.networkError || res.text || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) return 'Exotel did not accept the API key / token (or the region is wrong: Mumbai and Singapore accounts use different addresses).';
  if (res.status === 404) return 'Exotel answered "not found". Check the Account SID and the region.';
  if (res.status === 429) return 'Exotel says too many calls at once. It will be tried again later.';
  if (res.status === 0) return `Could not reach Exotel (${clean(said, s)}).`;
  return `Exotel${res.status ? ` HTTP ${res.status}` : ''}: ${clean(typeof said === 'string' ? said : JSON.stringify(said), s)}`;
}

// --- the read-only connection test ----------------------------------------------------------------------------------
async function testConnection(s) {
  const checks = [];
  if (!s.sid || !s.key || !s.token) {
    return { ok: false, message: 'Account SID, API key and API token are needed before Exotel can be checked.', checks: [{ name: 'Account details', ok: false, note: 'missing' }] };
  }
  const base = baseOf(s);
  const blocked = guardSandbox(base);
  if (blocked) return { ok: false, message: blocked.error, checks: [{ name: 'Test copy', ok: false, note: blocked.error }] };
  const headers = { authorization: basic(s), accept: 'application/json' };
  const res = await send(`${base}${X.fillPath(X.PATHS.accountCheck, { sid: s.sid })}`, { headers, timeoutMs: 15000 });
  if (!(res.ok && (res.json || /^\s*[<{]/.test(res.text || '')))) {
    checks.push({ name: 'Exotel account', ok: false, note: wordsFor(res, s) });
    return { ok: false, message: wordsFor(res, s), checks };
  }
  checks.push({ name: 'Exotel account', ok: true, note: `Reached Exotel (${s.region === 'singapore' ? 'Singapore' : 'Mumbai'} account). No call was placed.` });

  // Optional: is the caller ID one of the account's numbers? A failure to read the list is a NOTE, not an error.
  try {
    const r2 = await send(`${base}${X.fillPath(X.PATHS.numbers, { sid: s.sid })}`, { headers, timeoutMs: 15000 });
    if (r2.ok && r2.json) {
      const flat = JSON.stringify(r2.json).replace(/\D/g, ' ');
      const tail = String(s.callerId).replace(/\D/g, '').slice(-10);
      if (tail && flat.includes(tail)) checks.push({ name: 'Caller ID', ok: true, note: 'The caller ID is one of the numbers on the Exotel account.' });
      else checks.push({ name: 'Caller ID', ok: false, warn: true, note: 'The caller ID was not found among the numbers Exotel listed. Check it with Exotel (it must be the approved ExoPhone).' });
    } else {
      checks.push({ name: 'Caller ID', ok: true, warn: true, note: 'Exotel did not list the account numbers through the API, so the caller ID could not be confirmed here.' });
    }
  } catch {
    checks.push({ name: 'Caller ID', ok: true, warn: true, note: 'The number list could not be read; the caller ID is not confirmed.' });
  }
  checks.push({
    name: 'Voicebot',
    ok: true,
    warn: true,
    note: s.appId || s.flowUrl
      ? 'The Voicebot Flow App ID is saved. Exotel cannot confirm Voicebot access through the API; the first test call (Test mode, your own number) proves it.'
      : 'No Voicebot Flow App ID is saved yet.',
  });
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    message: failed.length ? failed[0].note : `Exotel accepted the account details${checks.some((c) => c.warn) ? ' (see the notes)' : ''}. No call was placed.`,
    checks,
  };
}

// --- start a call -------------------------------------------------------------------------------------------------------
// opts: { to (digits with country code), statusCallback (full https address), custom (<=128 chars), record (bool), timeLimit (sec) }
async function startCall(s, opts) {
  const base = baseOf(s);
  const blocked = guardSandbox(base);
  if (blocked) return { ok: false, transient: false, error: blocked.error };
  const flow = s.flowUrl || X.fillPath(X.PATHS.flowUrl, { sid: s.sid, appId: s.appId });
  const R = X.REQ;
  const form = new URLSearchParams();
  form.set(R.to, `+${opts.to}`);
  form.set(R.callerId, s.callerId);
  form.set(R.url, flow);
  form.set(R.callType, R.callTypeValue);
  form.set(R.timeLimit, String(opts.timeLimit || 900));
  form.set(R.timeOut, '40');
  form.set(R.record, opts.record ? 'true' : 'false');
  if (opts.custom) form.set(R.custom, String(opts.custom).slice(0, 128));
  if (opts.statusCallback) {
    form.set(R.statusCallback, opts.statusCallback);
    form.append(R.statusEvents, R.statusEventsValue);
    form.set(R.statusContentType, R.statusContentTypeValue);
  }
  const res = await send(`${base}${X.fillPath(X.PATHS.connect, { sid: s.sid })}`, {
    method: 'POST',
    headers: { authorization: basic(s), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    timeoutMs: 20000,
  });
  const call = res.json && res.json[X.RES.root];
  if (res.ok && call && call[X.RES.sid]) return { ok: true, callSid: String(call[X.RES.sid]), status: X.normalStatus(call[X.RES.status]) || 'queued' };
  return {
    ok: false,
    transient: core.isTransientHttp(res.status),
    status: res.status,
    error: wordsFor(res, s),
  };
}

async function hangup(s, callSid) {
  const base = baseOf(s);
  const blocked = guardSandbox(base);
  if (blocked) return { ok: false, error: blocked.error };
  const res = await send(`${base}${X.fillPath(X.PATHS.hangup, { sid: s.sid, callSid })}`, {
    method: 'POST',
    headers: { authorization: basic(s), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ Status: 'canceled' }).toString(),
    timeoutMs: 15000,
  });
  return res.ok ? { ok: true } : { ok: false, error: wordsFor(res, s) };
}

module.exports = { setHttp, testConnection, startCall, hangup, baseOf, clean };

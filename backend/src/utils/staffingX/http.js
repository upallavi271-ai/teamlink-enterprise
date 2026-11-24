// ---------------------------------------------------------------------------
// The one door to the outside for the VMS connector and the accounting push (utils/staffingX/*).
//   Live:     utils/safeFetch.js fetchPublic (public addresses only, every redirect checked), 15 s per call.
//   Sandbox:  ONLY the built-in stub of this same server (/api/public/stfx-stub, routes/staffingXPortal.js) is reached; any other
//             address is refused here, before the sandbox's own fetch backstop would refuse it anyway.
// ---------------------------------------------------------------------------
const S = require('./store');

const STUB = '/api/public/stfx-stub';
const stubBase = () => `http://localhost:${process.env.PORT || 4000}${STUB}`;
function isStub(url) {
  try { const u = new URL(url); return ['localhost', '127.0.0.1'].includes(u.hostname) && String(u.port) === String(process.env.PORT || 4000) && u.pathname.startsWith(STUB); } catch { return false; }
}

async function send(url, { method = 'GET', headers = {}, body = undefined, form = null } = {}) {
  const init = { method, headers: { 'user-agent': 'TeamLink-Staffing/1', accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) };
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; } else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] = init.headers['content-type'] || 'application/json'; }
  let res;
  if (S.isSandbox()) {
    if (!isStub(url)) throw Object.assign(new Error('The test sandbox reaches only the built-in stub, never a real address.'), { code: 'SANDBOX' });
    res = await fetch(url, init);
  } else {
    res = await require('../safeFetch').fetchPublic(url, init); // eslint-disable-line global-require
  }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 4000) };
}

module.exports = { send, stubBase, isStub, STUB };

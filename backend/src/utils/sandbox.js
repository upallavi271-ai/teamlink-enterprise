// ---------------------------------------------------------------------------
// TEST SANDBOX MODE.
//
// Tests (API scripts, browser checks) must never write into the real dev
// database or reach a real person. `npm run sandbox` (scripts/sandbox.js)
// starts a SECOND copy of this API on port 4011 against prisma/sandbox.db, a
// fresh VACUUM INTO copy of dev.db, with TEST_MODE=1. In that mode:
//
//   * no background worker or timer is started at boot (index.js),
//   * every outbound channel is hard-disabled:
//       - nodemailer transports are replaced by a fake that never opens a
//         socket and answers "250 sent (sandbox)",
//       - SMS / WhatsApp adapters report a fake send without any HTTP call,
//       - the Job Portal bridge never contacts the portal,
//       - AI calls (Anthropic / Ollama) are refused unless TEST_ALLOW_AI=1,
//       - and, as a backstop, fetch() and http(s).request() refuse any host
//         other than this process's own loopback port.
//
// TEST_MODE=1 or TEAMLINK_SANDBOX=1 switches it on. With neither set nothing
// in this file runs and the server behaves exactly as before.
// ---------------------------------------------------------------------------
const path = require('path');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());

function isSandbox() {
  return truthy(process.env.TEST_MODE) || truthy(process.env.TEAMLINK_SANDBOX);
}

// AI is refused in the sandbox unless the test explicitly opts in.
function allowAi() {
  return isSandbox() && truthy(process.env.TEST_ALLOW_AI);
}

function aiRefusal() {
  return 'AI is disabled in the TEST SANDBOX (outbound calls are off). Set TEST_ALLOW_AI=1 to allow it.';
}

// --- Fake mail transport -----------------------------------------------------
function fakeMailTransport() {
  return {
    sandbox: true,
    async verify() { return true; },
    async sendMail(msg = {}) {
      const to = [].concat(msg.to || []).map((a) => (typeof a === 'string' ? a : (a && a.address) || '')).filter(Boolean);
      console.log(`[sandbox] mail NOT sent (SMTP not contacted) to=${to.join(',') || '-'} subject=${JSON.stringify(String(msg.subject || '').slice(0, 80))}`);
      return {
        accepted: to,
        rejected: [],
        messageId: `<sandbox-${Date.now().toString(36)}@teamlink.sandbox>`,
        response: '250 sent (sandbox) — SMTP not contacted',
        envelope: msg.envelope,
        sandbox: true,
      };
    },
    close() {},
  };
}

// --- Network backstop ----------------------------------------------------------
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function hostAllowed(host, port) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  // Our own API (agent actions, ATS I/O and payroll sync call back into this process).
  if (LOOPBACK.has(h) && String(port) === String(process.env.PORT || '')) return true;
  if (allowAi()) {
    if (h === 'api.anthropic.com') return true;
    try {
      const o = new URL(process.env.OLLAMA_BASE_URL || 'http://localhost:11434');
      if (h === o.hostname.toLowerCase() && String(port) === String(o.port || (o.protocol === 'https:' ? 443 : 80))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function blockedError(what) {
  console.warn(`[sandbox] BLOCKED outbound ${what}`);
  return Object.assign(new Error(`SANDBOX: outbound network disabled (${what})`), { code: 'ESANDBOX' });
}

function requestTarget(args, defPort) {
  const [a0, a1] = args;
  let host = 'localhost';
  let port = defPort;
  let socketPath = null;
  if (typeof a0 === 'string' || a0 instanceof URL) {
    const u = new URL(String(a0));
    host = u.hostname;
    port = u.port || (u.protocol === 'https:' ? 443 : 80);
    if (a1 && typeof a1 === 'object' && typeof a1 !== 'function') {
      if (a1.hostname || a1.host) host = a1.hostname || a1.host;
      if (a1.port) port = a1.port;
    }
  } else if (a0 && typeof a0 === 'object') {
    host = a0.hostname || a0.host || 'localhost';
    port = a0.port || defPort;
    socketPath = a0.socketPath || null;
  }
  return { host, port, socketPath };
}

let installed = false;
function installGuards() {
  if (installed || !isSandbox()) return;
  installed = true;

  // nodemailer: every transport, wherever it is created, is the fake one.
  try {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    nodemailer.createTransport = () => fakeMailTransport();
  } catch { /* nodemailer not installed — nothing to guard */ }

  // fetch (undici): Anthropic SDK, job portal, SMS / WhatsApp, Ollama status.
  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch;
    globalThis.fetch = function sandboxFetch(input, init) {
      let u = null;
      try {
        u = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || String(input)));
      } catch { u = null; }
      if (u && !['http:', 'https:'].includes(u.protocol)) return realFetch.call(this, input, init);
      if (!u || !hostAllowed(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80))) {
        const err = new TypeError('fetch failed');
        err.cause = blockedError(`fetch ${u ? u.origin : String(input).slice(0, 80)}`);
        return Promise.reject(err);
      }
      return realFetch.call(this, input, init);
    };
  }

  // node:http / node:https: Ollama chat and anything else using them directly.
  // eslint-disable-next-line global-require
  [[require('http'), 80], [require('https'), 443]].forEach(([mod, defPort]) => {
    ['request', 'get'].forEach((fn) => {
      const real = mod[fn];
      mod[fn] = function sandboxRequest(...args) {
        const t = requestTarget(args, defPort);
        if (!t.socketPath && !hostAllowed(t.host, t.port)) throw blockedError(`${fn} ${t.host}:${t.port}`);
        return real.apply(this, args);
      };
    });
  });
}

// Refuse to run the sandbox against the real database or the real port.
function assertSafe() {
  if (!isSandbox()) return;
  const url = String(process.env.DATABASE_URL || '');
  const file = path.basename(url.replace(/^file:/, '').replace(/[?#].*$/, '').replace(/["']/g, ''));
  if (!url || /^dev\.db$/i.test(file)) {
    console.error(`[sandbox] REFUSING TO START: TEST_MODE is on but DATABASE_URL is ${url || '(unset)'} — the sandbox must use its own copy (prisma/sandbox.db). Start it with "npm run sandbox".`);
    process.exit(1);
  }
  if (String(process.env.PORT || '') === '4010') {
    console.error('[sandbox] REFUSING TO START: TEST_MODE is on but PORT is 4010 (the real dev server). Use PORT=4011.');
    process.exit(1);
  }
}

function banner(port) {
  const line = '='.repeat(72);
  console.log([
    line,
    `  SANDBOX — copy DB, outbound disabled   (TEST_MODE, port ${port})`,
    `  database: ${process.env.DATABASE_URL}`,
    '  workers/timers: NOT started   mail/SMS/WhatsApp/job portal: never contacted',
    `  AI: ${allowAi() ? 'ALLOWED (TEST_ALLOW_AI=1)' : 'refused (set TEST_ALLOW_AI=1 to allow)'}`,
    line,
  ].join('\n'));
}

module.exports = {
  isSandbox, allowAi, aiRefusal, fakeMailTransport, installGuards, assertSafe, banner, hostAllowed,
};

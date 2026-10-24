#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - TESTS (2026-10-22). SANDBOX ONLY. NO REAL CALL, NO REAL EXOTEL, NO REAL NUMBER.
//
//   (helpers; run  node scripts/ai-calling-test.js)
//
// What it does, by itself:
//   * makes a VACUUM INTO copy of prisma/dev.db (read only on dev.db) as prisma/zz-aicall-test.db
//   * starts ONE temporary TeamLink API on a free port (4060-4099, never 4010 / 4045) with TEST_MODE=1 on that copy
//   * starts a LOCAL FAKE Exotel server (HTTP, 127.0.0.1) that records every request and can post signed status callbacks
//   * runs the tests below, removes every ZZTEST row, stops the server and deletes the copy
// Mocks exist only here. The real Exotel is never contacted: the sandbox refuses any address that is not this computer.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const COPY = path.join(BACK, 'prisma', 'zz-aicall-test.db');
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-aicall-'));
const RUN = Date.now().toString(36);

let pass = 0; let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1; else { fail += 1; failures.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_KEY = 'zz-key-SECRETKEY-AAA111';
const FAKE_TOKEN = 'zz-token-SECRETTOKEN-BBB222';
const FAKE_HOOK = 'zz-hook-SECRETHOOK-CCC333';
const SECRETS = [FAKE_KEY, FAKE_TOKEN, FAKE_HOOK];
const ph = (n) => `90000123${String(n).padStart(2, '0')}`; // fake numbers: only ever sent to the local fake server

async function freePort() {
  for (let p = 4060; p <= 4099; p += 1) {
    if (p === 4045) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const busy = await new Promise((res) => { const s = net.connect({ port: p, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
    if (!busy) return p;
  }
  throw new Error('no free test port');
}

// ------------------------------------------------------------------ the fake Exotel
function startFake() {
  const state = { requests: [], connects: [], mode: 'ok', sidN: 0, rejectAuth: false, numbers: ['+919000099999'] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const okAuth = auth === `Basic ${Buffer.from(`${FAKE_KEY}:${FAKE_TOKEN}`).toString('base64')}`;
      const entry = { method: req.method, url: req.url, auth: okAuth, form: Object.fromEntries(new URLSearchParams(body)), at: Date.now() };
      state.requests.push(entry);
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!okAuth || state.rejectAuth) return json(401, { RestException: { Status: 401, Message: 'Authentication failed' } });
      if (req.method === 'GET' && /\/Calls\.json/.test(req.url)) return json(200, { Calls: [] });
      if (req.method === 'GET' && /IncomingPhoneNumbers/.test(req.url)) return json(200, { incoming_phone_numbers: state.numbers.map((n) => ({ phone_number: n })) });
      if (req.method === 'POST' && /\/Calls\/connect\.json/.test(req.url)) {
        state.connects.push(entry);
        if (state.mode === 'down') return json(503, { RestException: { Status: 503, Message: 'Service unavailable' } });
        if (state.mode === 'badrequest') return json(400, { RestException: { Status: 400, Message: 'Invalid caller id' } });
        state.sidN += 1;
        entry.sid = `FAKESID-${RUN}-${state.sidN}`;
        return json(200, { Call: { Sid: entry.sid, Status: 'queued' } });
      }
      return json(404, { error: 'unknown' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port })));
}

module.exports = { check, sleep, FAKE_KEY, FAKE_TOKEN, FAKE_HOOK, SECRETS, ph, freePort, startFake, BACK, DEV_DB, COPY, FILES, RUN, results: () => ({ pass, fail, failures }) };

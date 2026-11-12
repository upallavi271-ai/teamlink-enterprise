// ---------------------------------------------------------------------------
// KAVYA CLIENT - the door to the Kavya (Priya package) calling server on the SAME machine.
//
// Kavya is the Telugu / Hindi / English AI caller installed next to the old AI Calling (/opt/ai-agent on the VPS). It has its own small JSON
// API on 127.0.0.1:8090 (header X-API-Key, key in a root-only file). This file only talks to that API; nothing here dials.
//   KAVYA_API_URL        default http://127.0.0.1:8090
//   KAVYA_API_KEY        the key itself, or
//   KAVYA_API_KEY_FILE   default /opt/ai-agent/api_key.txt
// The key never leaves this server and is never returned by any route.
// ---------------------------------------------------------------------------
const fs = require('fs');

const base = () => String(process.env.KAVYA_API_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
function apiKey() {
  if (process.env.KAVYA_API_KEY) return String(process.env.KAVYA_API_KEY).trim();
  try { return fs.readFileSync(process.env.KAVYA_API_KEY_FILE || '/opt/ai-agent/api_key.txt', 'utf8').trim(); } catch { return ''; }
}
const configured = () => !!apiKey();

// one request; never throws: { ok, status, data, error }
async function request(method, path, body, timeoutMs = 15000) {
  const key = apiKey();
  if (!key) return { ok: false, status: 0, error: 'Kavya is not connected on this server (no API key file).' };
  try {
    const res = await fetch(base() + path, {
      method,
      headers: { 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, data, error: (data && data.error) || `Kavya answered ${res.status}` };
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: `Kavya is not reachable (${err.name === 'TimeoutError' ? 'timed out' : err.message}).` };
  }
}

const health = () => request('GET', '/api/v1/health', null, 5000);
const createJob = (job) => request('POST', '/api/v1/jobs', job, 30000);
const startJob = (id) => request('POST', `/api/v1/jobs/${Number(id)}/start`);
const pauseJob = (id) => request('POST', `/api/v1/jobs/${Number(id)}/pause`);
const jobStatus = (id) => request('GET', `/api/v1/jobs/${Number(id)}`);
const jobResults = (id) => request('GET', `/api/v1/jobs/${Number(id)}/results`);

module.exports = { configured, request, health, createJob, startJob, pauseJob, jobStatus, jobResults };

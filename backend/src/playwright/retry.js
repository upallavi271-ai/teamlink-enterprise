// ---------------------------------------------------------------------------
// RETRY, BACKOFF AND HUMAN-LIKE PACING (no browser needed: pure helpers).
//
//   backoffMs(attempt)     exponential backoff with jitter for the QUEUE (the whole run is tried again later)
//   withRetry(fn, opts)    a small in-run retry for one flaky step (a click, a navigation). Never used around Submit.
//   humanPause(min, max)   a random 1-3 s wait between actions. This is ordinary pacing, not evasion: no stealth
//                          plugin, no fingerprint change, no proxy.
// ---------------------------------------------------------------------------
const { DEFAULTS } = require('../jobPublish/constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// attempt = how many tries have been made (1 after the first failure).
// 30 s, 60 s, 120 s ... up to 30 min, plus or minus 25 %.
function backoffMs(attempt, o = {}) {
  const base = o.base || Number(process.env.TL_POSTING_BACKOFF_BASE_MS) || DEFAULTS.backoffBaseMs;
  const factor = o.factor || DEFAULTS.backoffFactor;
  const max = o.max || DEFAULTS.backoffMaxMs;
  const jitter = o.jitter == null ? DEFAULTS.backoffJitter : o.jitter;
  const raw = Math.min(max, base * (factor ** Math.max(0, attempt - 1)));
  const rnd = o.random ? o.random() : Math.random();
  return Math.max(1000, Math.round(raw * (1 + (rnd * 2 - 1) * jitter)));
}

async function humanPause(minMs = 1000, maxMs = 3000, o = {}) {
  if (process.env.TL_PORTAL_NO_PACING === '1' || o.fast) return 0; // tests against the local mock portal
  const ms = Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs));
  await sleep(ms);
  return ms;
}

// Try `fn` up to `tries` times. `isRetryable(err)` decides; the last error is thrown.
async function withRetry(fn, { tries = 2, delayMs = 800, isRetryable = () => true, onRetry } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i >= tries || !isRetryable(err)) break;
      if (onRetry) onRetry(err, i);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

// A failure that is the network's or the site's slowness (worth another run later).
function looksTransient(err) {
  const t = `${err && err.name} ${err && err.message}`;
  return /timeout|timed out|net::ERR_(CONNECTION|NAME|INTERNET|TIMED|NETWORK|EMPTY)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|Navigation failed|Target closed.*(?!by)/i.test(t);
}

module.exports = { backoffMs, humanPause, withRetry, looksTransient, sleep };

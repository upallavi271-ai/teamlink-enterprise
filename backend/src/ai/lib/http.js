// ---------------------------------------------------------------------------
// The ONLY way the AI layer reaches this app's data and actions: the caller's
// own Authorization header replayed against this app's own API, exactly as if
// they had clicked the button. The route's validation, permission checks,
// scope rules, approval chains, notifications and audit rows are therefore the
// ones a human gets. There is no second implementation of any of them here
// and NO direct database write anywhere under src/ai (scripts/test-ai-agent.js
// greps for it).
//
//   makeReader(auth)  -> { get }              GET only — what validators and
//                                             the assistant (Ask mode) receive
//   makeApi(auth)     -> { get, post, put, patch, delete }
//                                             only the executor receives this
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 60000;

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 4000}/api`;
}

async function request(auth, method, path, body, opts = {}) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json', authorization: auth, 'x-tl-via': 'ai-agent', ...(opts.idempotencyKey ? { 'idempotency-key': String(opts.idempotencyKey) } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body || {});
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, init);
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'The app did not answer in time. Nothing was confirmed.' }, networkError: true };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// A few POST routes only LOOK (they never save anything): the message preview.
// Validators may use these; they cannot reach any other POST.
const READ_ONLY_POSTS = ['/messaging/preview'];

function makeReader(auth) {
  return {
    get: (path) => request(auth, 'GET', path),
    probe: (path, body) => {
      if (!READ_ONLY_POSTS.includes(path)) throw new Error(`"${path}" is not a read-only probe`);
      return request(auth, 'POST', path, body);
    },
  };
}

function makeApi(auth) {
  return {
    get: (path) => request(auth, 'GET', path),
    post: (path, body, opts) => request(auth, 'POST', path, body, opts),
    put: (path, body, opts) => request(auth, 'PUT', path, body, opts),
    patch: (path, body, opts) => request(auth, 'PATCH', path, body, opts),
    delete: (path, body, opts) => request(auth, 'DELETE', path, body, opts),
  };
}

// The route's own refusal, in its own words.
function problemOf(r, fallback = 'The app refused this.') {
  if (!r) return fallback;
  const d = r.data || {};
  return String(d.error || d.message || (r.status ? `${fallback} (${r.status})` : fallback)).slice(0, 400);
}

module.exports = { makeReader, makeApi, problemOf, request };

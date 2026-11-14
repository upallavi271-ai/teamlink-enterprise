/*
 * THE PORTAL'S BULK "Start AI Calls" BUTTON, RUN BY KAVYA (2026-11-14).
 *
 * The page POSTs /api/ai-calling/campaign. The portal's own dialer is switched off (OUTBOUND_CALLS_ENABLED is not true), so that
 * route only said "queued" and nothing rang. This host route answers it first: it reads who is signed in (the portal's own
 * session cookie), the job and the ticked candidates, and hands them to TeamLink through the portal door
 * (POST /api/ai-calling/portal/kavya-campaign: bridge secret + the recruiter's e-mail), where Kavya places the calls under TeamLink's
 * rules (roles, scope, consent, DND, Off / Test / Live, test numbers). The answer keeps the shape the page reads:
 *   { campaign: { id, jobId, queued, skipped }, queued: [...], skipped: [{ candidateId, reason }] }
 * If TeamLink cannot take it the recruiter gets the real reason - the old dialer is never used as a fallback.
 */
const COOKIE = () => process.env.SESSION_COOKIE || 'tl_session';
const cookieOf = (header, name) => {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); } }
  }
  return '';
};
const ROLES = ['recruiter', 'bde', 'admin'];

/**
 * deps: { resolveSession(token), withUser, api (TeamLink base url), secret, fetchFn? }
 * Returns { status, body }.
 */
const why = (list) => {
  const n = {};
  (list || []).forEach((x) => { n[x.reason] = (n[x.reason] || 0) + 1; });
  return Object.entries(n).slice(0, 3).map(([k, v]) => `${v} - ${k}`).join('; ');
};

export async function placeCampaign(req, deps) {
  const b = req.body || {};
  const jobId = String(b.jobId || '').trim();
  const ids = [...new Set((Array.isArray(b.candidateIds) ? b.candidateIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!jobId || !ids.length || ids.length > 500) return { status: 422, body: { error: 'Choose a job and tick between 1 and 500 candidates.', code: 'VALIDATION_FAILED' } };
  const token = cookieOf(req.headers && req.headers.cookie, COOKIE());
  const session = token ? await deps.resolveSession(token) : null;
  if (!session) return { status: 401, body: { error: 'Please sign in again.', code: 'UNAUTHORIZED' } };
  if (!ROLES.includes(session.role)) return { status: 403, body: { error: 'Your role may not place AI calls.', code: 'FORBIDDEN' } };
  if (!deps.secret) return { status: 503, body: { error: 'The link to TeamLink is not set up on this server (bridge secret missing).', code: 'NOT_CONNECTED' } };

  const { email, rows } = await deps.withUser({ userId: '', role: 'admin', profileId: null }, async (c) => ({
    email: ((await c.query('select email from users where id = $1', [session.userId])).rows[0] || {}).email,
    rows: (await c.query('select id, name, phone, email, do_not_contact from candidates where id = any($1)', [ids])).rows,
  }));
  if (!email) return { status: 403, body: { error: 'Your portal login has no e-mail, so TeamLink cannot tell who you are.', code: 'FORBIDDEN' } };

  const skipped = [];
  const send = [];
  for (const id of ids) {
    const c = rows.find((r) => r.id === id);
    if (!c) skipped.push({ candidateId: id, reason: 'not visible to you' });
    else if (c.do_not_contact) skipped.push({ candidateId: id, reason: 'do not contact' });
    else if (!c.phone) skipped.push({ candidateId: id, reason: 'no phone number' });
    else send.push({ id: c.id, name: c.name, phone: c.phone, email: c.email });
  }
  const mk = (campaign, queued, more) => ({ campaign: { ...campaign, jobId, queued: queued.length, skipped: skipped.length + (more || []).length }, queued, skipped: [...skipped, ...(more || [])] });
  if (!send.length) return { status: 422, body: { ...mk({ id: null }, []), error: `Nobody on the list can be called. ${why(skipped)}` } };

  const doFetch = deps.fetchFn || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  let res; let out = {};
  try {
    res = await doFetch(`${String(deps.api).replace(/\/+$/, '')}/api/ai-calling/portal/kavya-campaign`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-job-portal-secret': deps.secret, 'x-portal-user-email': email },
      body: JSON.stringify({ jobId, candidates: send }),
    });
    out = await res.json().catch(() => ({}));
  } catch (err) {
    return { status: 502, body: { error: `TeamLink did not answer (${err.name === 'AbortError' ? 'timed out' : err.message}). No calls were placed.`, code: 'TEAMLINK_DOWN' } };
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    return { status: res.status === 401 || res.status === 403 ? 403 : (res.status >= 500 ? 502 : 422), body: { ...mk({ id: null }, [], out.skipped), error: `${out.error || `TeamLink refused (${res.status}). No calls were placed.`} ${why([...skipped, ...(out.skipped || [])])}`.trim(), code: out.code || 'REFUSED' } };
  }
  const queued = Array.isArray(out.queued) ? out.queued : [];
  const theirs = Array.isArray(out.skipped) ? out.skipped : [];
  return { status: 201, body: { ...mk({ id: out.campaign && out.campaign.id }, queued, theirs), engine: 'kavya', note: out.note || undefined } };
}

export { cookieOf };

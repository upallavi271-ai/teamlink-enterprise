/*
 * SEND TO ATS FOR A REQUIREMENT THAT IS NOT PUBLISHED ON THE PORTAL (2026-11-28: "send to ats click chesaka kuda ATS candidates lo kanipinchadam ledhu").
 *
 * The Send to ATS box offers every open TeamLink requirement, including those that are not published on the portal. On the portal such a requirement is
 * only a hidden CLOSED "import stub" (job description "[tl-status:OPEN]"), so the portal refused ("That job is not open") and nobody reached the ATS.
 * For exactly those jobs this answers the portal's POST /api/ats/send-to-pipeline by handing the ticked candidates to TeamLink
 * (POST /api/public/job-portal/send-to-ats, bridge secret + the recruiter's e-mail), which adds them to the requirement's pipeline.
 * A published job, a requirement that is CLOSED in TeamLink, and everything else go to the portal's own route unchanged. The portal's own session,
 * CSRF and role checks (deps.guard) run first; the candidates are read as the signed-in person, so nobody sends a candidate they cannot see.
 */
const STUB = /^\[tl-status:([A-Z_]+)\]/;
const run = (mw, req, res) => new Promise((resolve, reject) => { mw(req, res, (err) => (err ? reject(err) : resolve())); });

export function sendToAtsForStubs(deps) {
  return async function mw(req, res, next) {
    try {
      const b = req.body || {};
      const jobId = String(b.jobId || '');
      const ids = [...new Set((Array.isArray(b.candidateIds) ? b.candidateIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
      if (!jobId.startsWith('tl_') || !ids.length || ids.length > 100) return next();
      const SYSTEM = { userId: '', role: 'admin', profileId: null };
      const job = await deps.withUser(SYSTEM, async (c) => (await c.query('select id, title, status, description from jobs where id = $1', [jobId])).rows[0]);
      const m = job && STUB.exec(String(job.description || ''));
      if (!job || job.status === 'open' || !m || m[1] === 'CLOSED') return next();
      for (const step of deps.guard) await run(step, req, res); // eslint-disable-line no-await-in-loop
      const session = req.session;
      const { rows, email } = await deps.withUser(session, async (c) => ({
        rows: (await c.query('select id, name, email, phone, location, title, current_company, exp_years, skills, education, notice_period, resume_file from candidates where id = any($1)', [ids])).rows,
        email: null,
      })).then(async (out) => ({
        rows: out.rows,
        email: await deps.withUser(SYSTEM, async (c) => ((await c.query('select email from users where id = $1', [session.userId])).rows[0] || {}).email),
      }));
      if (!deps.secret || !email) return res.status(503).json({ error: { code: 'NOT_CONNECTED', message: 'The link to the ATS is not set up for your login.' } });
      const refused = ids.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ candidateId: id, outcome: 'refused', reason: 'not found, or not in your pool' }));
      let out = { results: [] };
      if (rows.length) {
        const r = await (deps.fetchImpl || fetch)(`${String(deps.api).replace(/\/+$/, '')}/api/public/job-portal/send-to-ats`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-job-portal-secret': deps.secret, 'x-portal-user-email': email },
          body: JSON.stringify({
            requirementId: jobId.slice(3),
            candidates: rows.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, location: c.location, title: c.title, currentCompany: c.current_company, expYears: c.exp_years, skills: c.skills, education: c.education, noticePeriod: c.notice_period, resumeFile: c.resume_file })),
          }),
          signal: AbortSignal.timeout(60000),
        });
        out = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status === 401 ? 503 : r.status).json({ error: { code: 'ATS_REFUSED', message: out.error || 'The ATS did not accept the candidates.' } });
      }
      const results = [...(out.results || []), ...refused];
      const count = (k) => results.filter((x) => x.outcome === k).length;
      return res.json({ job: { id: job.id, title: job.title }, added: count('added'), moved: 0, already: count('already'), refused: count('refused'), notified: 0, results });
    } catch (err) {
      return next(err);
    }
  };
}

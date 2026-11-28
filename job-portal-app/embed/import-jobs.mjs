/*
 * THE JOB ROLES OF THE IMPORT WIZARDS, ALL DEPARTMENTS VISIBLE (2026-11-21: "import chestunteyy only medical valladheyy kanipistunnaayi, education,
 * manufacturing requirements kanipistaledhu").
 *
 * GET /api/candidates/import/jobs answers every TeamLink job role (migration 0168), but the wizard shows only the FIRST 80 of them until something is
 * typed, and the list came in the order of the jobs' ids - the oldest requirements first, which are mostly Medical. So Education and Manufacturing
 * were in the list but far below the 80th row. This middleware (in front of that route, the portal's own answer is kept) changes only the ORDER and
 * the LABEL of what the wizard receives:
 *   - the department is put in front of the title, "[Education] Lecturer - Client (REQ-12)", so a recruiter sees which desk a role belongs to and can
 *     type "education" or "manufacturing" to find them;
 *   - the roles are dealt out department by department (open ones first inside each), so the first 80 rows hold every department;
 *   - the department is also sent as a field of its own.
 * Nothing is removed and no job id changes.
 */
export function reshapeImportJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const label = (j) => {
    const d = String(j.department || '').trim();
    const t = String(j.title || j.id || '');
    return d && !t.toLowerCase().startsWith(`[${d.toLowerCase()}]`) ? `[${d}] ${t}` : t;
  };
  const decorated = list.map((j) => ({ ...j, title: label(j), department: j.department || '' }));
  const by = new Map();
  for (const j of decorated) {
    const k = j.department || '~';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(j);
  }
  for (const rows of by.values()) rows.sort((a, b) => (b.status === 'open') - (a.status === 'open')); // stable: the portal's own order stays inside
  const keys = [...by.keys()].sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b));
  const out = [];
  for (let i = 0; out.length < decorated.length; i += 1) {
    for (const k of keys) { const row = by.get(k)[i]; if (row) out.push(row); }
  }
  return out;
}

/** Express middleware for GET /api/candidates/import/jobs. */
export function importJobsMiddleware() {
  return function mw(_req, res, next) {
    const orig = res.json.bind(res);
    res.json = (body) => {
      try {
        if (body && Array.isArray(body.jobs)) return orig({ ...body, jobs: reshapeImportJobs(body.jobs) });
      } catch { /* the portal's own answer goes */ }
      return orig(body);
    };
    next();
  };
}

/*
 * EACH DEPARTMENT SEES ITS OWN ROLES, ALL OF THEM (2026-11-21: "education vallaki education total requirements, non IT department vallaki medical + non IT medical
 * both, medical vallaki entire medical"): the list the import wizard offers is the caller's department - every requirement of it, open AND closed -
 * and not the first 80 of everybody's. Admin sees every department. Unknown / no department: the portal's own answer is left as it is.
 *   Education      -> Education
 *   Manufacturing  -> Manufacturing + Medical + Non IT Medical
 *   Medical        -> Medical + Non IT Medical   (the entire medical desk)
 *   Non IT         -> Medical + Non IT Medical   (both medical and non-IT roles)
 *   anything else  -> its own department
 * Departments are compared on their first four letters, like the desks already are (Education / Educational, Manufacture / Manufacturing).
 */
export const deptKey = (d) => String(d || '').replace(/[^A-Za-z]/g, '').toLowerCase().slice(0, 4);
const GROUPS = { noni: ['noni', 'medi'], medi: ['medi', 'noni'], manu: ['manu', 'medi', 'noni'] };
export const allowedKeys = (dept) => { const k = deptKey(dept); return k ? (GROUPS[k] || [k]) : []; };

/** deps: { resolveSession(token), withUser, cookieOf, cookieName } - answers the list itself for a department-scoped caller, else calls next(). */
export function importJobsForDepartment(deps) {
  return async function mw(req, res, next) {
    try {
      const token = deps.cookieOf(req.headers && req.headers.cookie, deps.cookieName);
      const session = token ? await deps.resolveSession(token) : null;
      if (!session || session.role === 'admin') return next(); // not signed in: the portal says so; admin: everything (the portal's list, all departments)
      const SYSTEM = { userId: '', role: 'admin', profileId: null };
      const dept = session.profileId ? await deps.withUser(SYSTEM, async (c) => ((await c.query('select department from recruiters where id = $1', [session.profileId])).rows[0] || {}).department) : null;
      const keys = allowedKeys(dept);
      if (!keys.length) return next();
      const q = String((req.query || {}).q || '').trim().toLowerCase().slice(0, 80);
      const rows = await deps.withUser(SYSTEM, async (c) => (await c.query(
        `select id, title, location, status, department, description from jobs where id like 'tl\\_%' order by (status = 'open') desc, published_at desc nulls last, id limit 5000`)).rows);
      // an import stub is always a hidden CLOSED portal job; the requirement's real state travels in its description ([tl-status:OPEN]) so the wizard says open / closed truthfully
      rows.forEach((j) => {
        const m = /^\[tl-status:([A-Z_]+)\]/.exec(String(j.description || ''));
        if (m) j.status = m[1] === 'CLOSED' ? 'closed' : 'open';
        delete j.description;
      });
      const mine = rows.filter((j) => keys.includes(deptKey(j.department)) && (!q || String(j.title || '').toLowerCase().includes(q)));
      return res.json({ jobs: reshapeImportJobs(mine) });
    } catch { return next(); }
  };
}

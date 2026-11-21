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

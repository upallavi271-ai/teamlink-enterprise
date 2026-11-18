/*
 * WHO IMPORTED WHAT (2026-11-20).
 *   importSummary(withUser, SYSTEM)  one row per recruiter: how many imported candidates are theirs, how many files / rows they brought in, by which way
 *                                    (spreadsheet, resumes, job-board mail, other), and when they last imported. For the admin page in TeamLink.
 *   tagImportedBy(...)               adds "by <recruiter>" to the Source detail line of an imported candidate in the Talent Pool / Find Candidates list,
 *                                    so a recruiter sees who brought each person in. The portal's rows and rules are not changed.
 */
export async function importSummary(withUser, SYSTEM) {
  const rows = await withUser(SYSTEM, async (c) => (await c.query(
    `select r.id, r.name, r.department,
            (select count(*)::int from candidates x where x.owner_recruiter_id = r.id and candidate_is_imported(x.id)) as candidates,
            (select count(*)::int from candidate_imports i where i.recruiter_id = r.id) as files,
            (select coalesce(sum(i.total_rows),0)::int from candidate_imports i where i.recruiter_id = r.id) as rows_read,
            (select coalesce(sum(i.created_count),0)::int from candidate_imports i where i.recruiter_id = r.id) as created,
            (select coalesce(sum(i.merged_count),0)::int from candidate_imports i where i.recruiter_id = r.id) as merged,
            (select coalesce(sum(i.skipped_count),0)::int from candidate_imports i where i.recruiter_id = r.id) as skipped,
            (select max(i.created_at) from candidate_imports i where i.recruiter_id = r.id) as last_import,
            (select coalesce(jsonb_object_agg(s.src, s.n), '{}'::jsonb) from (
               select coalesce(x.source, 'Unknown') as src, count(*)::int as n from candidates x
                where x.owner_recruiter_id = r.id and candidate_is_imported(x.id) group by 1) s) as by_source
       from recruiters r order by 4 desc, r.name`)).rows);
  const loose = await withUser(SYSTEM, async (c) => (await c.query(
    `select count(*)::int as n from candidates x where x.owner_recruiter_id is null and candidate_is_imported(x.id)`)).rows[0]);
  return {
    recruiters: rows.map((r) => ({
      id: r.id, name: r.name, department: r.department || '', candidates: r.candidates, files: r.files, rowsRead: r.rows_read, created: r.created,
      merged: r.merged, skipped: r.skipped, lastImport: r.last_import, bySource: r.by_source || {},
    })),
    withoutOwner: loose ? loose.n : 0,
  };
}

/** Express middleware for GET /api/candidates: the same answer, with "by <recruiter>" added to imported candidates' source detail. */
export function tagImportedBy(withUser, SYSTEM) {
  return function mw(req, res, next) {
    const orig = res.json.bind(res);
    res.json = (body) => {
      const list = body && Array.isArray(body.candidates) ? body.candidates : null;
      if (!list || !list.length) return orig(body);
      const ids = list.map((c) => c && c.id).filter(Boolean).slice(0, 500);
      withUser(SYSTEM, async (c) => (await c.query(
        `select x.id, r.name from candidates x join recruiters r on r.id = x.owner_recruiter_id
          where x.id = any($1) and candidate_is_imported(x.id)`, [ids])).rows)
        .then((rows) => {
          const by = new Map(rows.map((r) => [r.id, r.name]));
          list.forEach((c) => {
            const n = c && by.get(c.id);
            if (n) { c.importedBy = n; c.sourceDetails = `${c.sourceDetails ? `${c.sourceDetails} · ` : ''}by ${n}`; }
          });
          return orig(body);
        })
        .catch(() => orig(body));
      return res;
    };
    next();
  };
}

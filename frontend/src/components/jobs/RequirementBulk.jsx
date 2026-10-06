import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { PRIORITY_CHOICES, priorityLabel } from './reqFormat.jsx';
import { TlOptions, RecruiterOptions } from './assignPeople.jsx';
import './jobops.css';

// ---------------------------------------------------------------------------
// BULK ACTIONS on selected jobs (ATS review #2 §21; change list 2026-10-03 §5
// "Needs a recruiter" / "Needs a TL"), also used by the quick drawer's
// "Assign recruiter" with a single row:
//   assign-recruiter   Assign recruiter    Requirement Detail / assign
//   assign-tl          Assign TL           Requirement Detail / assign
//   priority           Change priority     Requirement Detail / approve
//
// FILTER RULE: the people offered are only those of the selected jobs'
// department (GET /requirements/assignable-people?forJobs=…). When the jobs
// span several departments, pick one department first — the jobs and the
// people narrow together. The server checks every row again (scope, chain,
// same department) and reports each one.
// USER RULE 2026-10-05 (&kind=… on the same call): Assign team lead offers
// EVERY department's TLs (grouped, the jobs' department first); Assign
// recruiter offers the TL's own team (Admin: by team), least busy first. No
// department-at-a-time step for these — the server still checks every row.
//
// After it is done: "Assigned Ravi to 25 jobs" and an Undo button (24 hours,
// POST /requirements/bulk/undo).
//
// items: [{ id, reqCode, title }]
// ---------------------------------------------------------------------------
const BATCH = 100;
const TITLES = {
  'assign-recruiter': 'Assign recruiter',
  'assign-tl': 'Assign team lead',
  priority: 'Change priority',
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function RequirementBulk({ kind, items, onClose, onDone }) {
  const assign = kind !== 'priority';
  const role = kind === 'assign-tl' ? 'TL' : 'RECRUITER';
  const lower = kind === 'assign-tl' ? 'team lead' : 'recruiter';
  const [bench, setBench] = useState(null); // { departments, jobs, people }
  const [dept, setDept] = useState('');
  const [userId, setUserId] = useState('');
  const [priority, setPriority] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { rows, undoId, targetName }
  const [undone, setUndone] = useState('');

  useEffect(() => {
    if (!assign) return;
    api.get('/requirements/assignable-people', { params: { forJobs: items.map((x) => x.id).join(','), kind } })
      .then((r) => {
        const d = r.data || {};
        setBench({
          departments: d.departments || [],
          jobs: d.jobs || [],
          people: (d.people || []).filter((p) => (p.atsRole || p.role) === role),
          groups: Array.isArray(d.groups) ? d.groups : null,
          // 2026-10-05: any department's TL; the TL's own team's recruiters.
          anyDept: !!d.anyDepartment,
        });
        const named = (d.departments || []).filter((x) => x.name);
        if (named.length >= 1) setDept(named[0].name);
      })
      .catch(() => { setBench({ departments: [], jobs: [], people: [] }); setError('Could not load the people you can assign.'); });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const deptOf = useMemo(() => new Map(((bench && bench.jobs) || []).map((j) => [j.id, j.department || ''])), [bench]);
  const depts = ((bench && bench.departments) || []);
  const anyDept = !!(bench && bench.anyDept);
  // One department at a time only on the old (same-department) bench.
  const many = depts.length > 1 && !anyDept;
  // The jobs this run touches: the chosen department's (or all, with one / no department).
  const jobs = assign && bench && many ? items.filter((x) => (deptOf.get(x.id) || '') === dept) : items;
  const people = assign && bench
    ? bench.people.filter((p) => anyDept || !dept || (p.departments || [p.atsDepartment]).includes(dept))
    : [];
  const ready = assign ? !!userId && jobs.length > 0 : !!priority;
  const one = items.length === 1;

  async function run() {
    setError('');
    setBusy(true);
    const all = [];
    let undoId = null;
    let targetName = null;
    try {
      for (let i = 0; i < jobs.length; i += BATCH) {
        const ids = jobs.slice(i, i + BATCH).map((x) => x.id);
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post('/requirements/bulk', assign ? { action: kind, ids, userId, undoId } : { action: kind, ids, priority });
        all.push(...(res.data.results || []));
        undoId = res.data.undoId || undoId;
        targetName = res.data.targetName || targetName;
      }
      setResult({ rows: all, undoId, targetName });
      if (all.some((x) => x.ok) && onDone) onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
      if (all.length) setResult({ rows: all, undoId, targetName });
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true); setError('');
    try {
      const res = await api.post('/requirements/bulk/undo', { undoId: result.undoId });
      setUndone(res.data.message || 'Undone.');
      if (onDone) onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Undo did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const okRows = result.rows.filter((x) => x.ok);
    const bad = result.rows.filter((x) => !x.ok);
    const headline = assign
      ? (okRows.length ? `Assigned ${result.targetName || 'them'} to ${plural(okRows.length, 'job', 'jobs')}.` : 'Nothing was changed.')
      : (okRows.length ? `Priority changed on ${plural(okRows.length, 'job', 'jobs')}.` : 'Nothing was changed.');
    return (
      <Modal
        title={TITLES[kind]}
        onClose={onClose}
        footer={(
          <>
            {assign && result.undoId && okRows.length > 0 && !undone && (
              <button type="button" className="btn" disabled={busy} onClick={undo}>{busy ? 'Undoing…' : 'Undo'}</button>
            )}
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </>
        )}
      >
        <div className="jobops">
          <div className="jobops-done" role="status">{undone || headline}</div>
          {!undone && assign && okRows.length > 0 && <div className="small-muted">You can undo this for 24 hours.</div>}
          {bad.length > 0 && (
            <details className="jobops-left" open={bad.length <= 5}>
              <summary>{`${plural(bad.length, 'job was', 'jobs were')} not changed — see why`}</summary>
              <div className="reqbulk-results">
                {bad.map((x) => (
                  <div key={x.id} className="reqbulk-row">
                    <span><b>{x.reqCode || x.id.slice(0, 8)}</b>{x.title ? ` · ${x.title}` : ''}</span>
                    <span className={`status ${x.skipped ? 'pending' : 'rejected'}`}>{x.error}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`${TITLES[kind]} — ${one ? (items[0].reqCode || items[0].title) : plural(items.length, 'job', 'jobs')}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={run}>
            {busy ? 'Working…' : `${TITLES[kind]}${!one && jobs.length ? ` to ${plural(jobs.length, 'job', 'jobs')}` : ''}`}
          </button>
        </>
      )}
    >
      <div className="jobops">
        {!assign ? (
          <label className="field">
            <span>Priority *</span>
            <Combo value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">Choose…</option>
              {PRIORITY_CHOICES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Combo>
          </label>
        ) : (
          <>
            {many && (
              <>
                <p className="jobops-lead">These jobs are in different departments. Do one department at a time.</p>
                <div className="jobops-depts" role="group" aria-label="Department">
                  {depts.map((d) => (
                    <button
                      key={d.name || 'none'}
                      type="button"
                      className={`jobops-dept${dept === (d.name || '') ? ' is-on' : ''}`}
                      onClick={() => { setDept(d.name || ''); setUserId(''); }}
                    >
                      {`${d.name || 'No department'} · ${d.count}`}
                    </button>
                  ))}
                </div>
              </>
            )}
            <label className="field">
              <span>
                {anyDept
                  ? `${kind === 'assign-tl' ? 'Team lead — any department' : 'Recruiter — least busy first'} *`
                  : `${kind === 'assign-tl' ? 'Team lead' : 'Recruiter'}${dept ? ` in ${dept}` : ''} *`}
              </span>
              <Combo value={userId} onChange={(e) => setUserId(e.target.value)} disabled={bench === null}>
                <option value="">
                  {bench === null ? 'Loading…' : people.length ? 'Choose…' : `No ${lower} here yet. Ask Admin to add one.`}
                </option>
                {anyDept && kind === 'assign-tl' && TlOptions({ tls: people, first: dept })}
                {anyDept && kind !== 'assign-tl' && RecruiterOptions({ groups: bench.groups || [] })}
                {!anyDept && people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.name}${p.seat ? ` · ${p.seat.code || p.seat}` : ''} · ${p.openJobs ? plural(p.openJobs, 'open job', 'open jobs') : 'no open jobs'}`}
                  </option>
                ))}
              </Combo>
            </label>
            {anyDept && kind !== 'assign-tl' && (() => {
              const top = people.find((p) => p.leastBusy);
              return top ? <div className="jobops-ok">{`Least busy: ${top.name}`}</div> : null;
            })()}
            {bench && !bench.jobs.length && (
              <div className="error-text">These jobs are outside your area, so you cannot assign them.</div>
            )}
            {bench && bench.jobs.length > 0 && !people.length && (
              <div className="small-muted">{`Ask an Admin to add a ${lower} for ${dept || 'this department'} in Administration → Users.`}</div>
            )}
            <div className="small-muted" style={{ margin: '6px 0' }}>
              {`The new ${lower} gets a message in the app. You can undo this for 24 hours.`}
            </div>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}

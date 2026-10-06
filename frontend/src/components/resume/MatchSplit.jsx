// ---------------------------------------------------------------------------
// FIT — the 3-number match (resume_ / fit_), both directions. Backend:
// routes/candidateResumes.js (one scorer: utils/matching.js computeMatch,
// wrapped by utils/resumeMatch.js threeNumbers).
//
//   Overall %  ·  Resume % (skills + experience + education from the resume,
//   else the profile)  ·  Location % (same city 100 / preferred 90 / nearby)
//   + one line in words: "Missing: Physiology, 3 years more experience".
//
// Eligible = Overall >= the job's minimum (default 50, changeable per job)
// AND no mandatory skill missing AND location fits. Minimum-Fit filter + sort
// on both lists. Scoped by the server: only people / jobs this login may see.
//
// Exports
//   RequirementMatchesPanel({ requirementId, onAdd, onData })  job -> people
//   EligibleRequirementsPanel({ candidateId, onAdd, onData })  person -> jobs
//   CandidateFitPanel({ candidateId, onAdd })                  the same, as a
//                                                              card for a "Fit" tab
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Help } from '../ui/Guide.jsx';
import './ResumePanel.css';

const tone = (n) => (n >= 70 ? 'hi' : n >= 50 ? 'mid' : 'lo');
function Pct({ n, sub, title }) {
  return (
    <span className={`msp-pct ${tone(n)}`} title={title}>
      {`${n}%`}
      {sub && <span className="msp-src">{sub}</span>}
    </span>
  );
}

function Tools({
  opts, setOpts, info, withAi = false,
}) {
  return (
    <div className="msp-tools">
      <label>
        Show Fit from
        <input type="number" min="0" max="100" value={opts.minMatch} onChange={(e) => setOpts({ ...opts, minMatch: e.target.value })} />
        %
      </label>
      <label>
        Sort by
        <select value={opts.sort} onChange={(e) => setOpts({ ...opts, sort: e.target.value })}>
          <option value="overall">Overall</option>
          <option value="resume">Resume</option>
          <option value="location">Location</option>
          {withAi && <option value="ai">AI score</option>}
          {withAi && <option value="name">Name (A–Z)</option>}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={opts.eligibleOnly} onChange={(e) => setOpts({ ...opts, eligibleOnly: e.target.checked })} />
        Eligible only
      </label>
      {info && <span className="small-muted msp-info">{info}</span>}
    </div>
  );
}

function useMatchList(path, opts, reloadKey, onData, limit = 50) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setError('');
      api.get(path, { params: { minMatch: opts.minMatch === '' ? 0 : opts.minMatch, sort: opts.sort, eligibleOnly: opts.eligibleOnly ? 1 : 0, limit } })
        .then((res) => { if (live) { setData(res.data); if (onData) onData(res.data); } })
        .catch((err) => { if (live) { setData(null); setError(err.response?.data?.error || 'The Fit list could not be loaded. Please try again.'); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [path, opts.minMatch, opts.sort, opts.eligibleOnly, reloadKey, limit]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error };
}

const eligibleChip = (m) => (m.eligible
  ? <span className="status active msp-chip">Eligible</span>
  : <span className="status hold msp-chip" title={(m.notEligibleBecause || []).join(' · ')}>Not eligible</span>);

// The one line in words under the name.
const Reason = ({ m }) => (m && m.reason ? <span className={`msp-reason${m.eligible ? ' ok' : ''}`}>{m.reason}</span> : null);

const countWord = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// A column heading that sorts the list when clicked (the Sort box does the same on a phone).
function SortTh({
  k, label, opts, setOpts,
}) {
  const on = opts.sort === k;
  return (
    <th aria-sort={on ? 'descending' : 'none'}>
      <button type="button" className={`msp-sort${on ? ' on' : ''}`} onClick={() => setOpts({ ...opts, sort: k })} title={`Sort by ${label}`}>
        {label}
        {on ? ' ▼' : ''}
      </button>
    </th>
  );
}

// The job's own minimum Fit % — shown to everyone, changeable by whoever may
// edit the job.
function MinFit({ requirementId, data, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  if (!data) return null;
  async function save(v) {
    setErr(''); setMsg('');
    try {
      const res = await api.put(`/candidate-resumes/requirement/${requirementId}/min-fit`, { minFit: v });
      setMsg(res.data.message || 'Saved.');
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save. Please try again.');
    }
  }
  return (
    <div className="msp-min">
      <span>
        {'Eligible means: Fit '}
        <b>{`${data.threshold}% or more`}</b>
        {data.minFitIsDefault ? ' (the usual minimum)' : ' (set for this job)'}
        , no must-have skill missing, location fits.
        {' '}<Help text="Fit % = how well the resume matches this job (skills, experience, location). People below the lowest Fit % are not shown as eligible." />
      </span>
      {data.canSetMinFit && !editing && (
        <button type="button" className="btn btn-sm" onClick={() => { setVal(String(data.threshold)); setEditing(true); setMsg(''); }}>Change minimum</button>
      )}
      {editing && (
        <span className="msp-min-edit">
          <input type="number" min="0" max="100" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Minimum Fit %" />
          %
          <button type="button" className="btn btn-sm btn-primary" onClick={() => save(val === '' ? null : Number(val))}>Save</button>
          {!data.minFitIsDefault && <button type="button" className="btn btn-sm" onClick={() => save(null)}>Use the usual minimum</button>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      )}
      {msg && <span className="msp-saved">{`✓ ${msg}`}</span>}
      {err && <span className="msp-err">{err}</span>}
    </div>
  );
}

// Job page — "Matching people".
export function RequirementMatchesPanel({
  requirementId, onAdd, onData, embedded = false, limit = 50, onOpenAll = null,
}) {
  const [opts, setOpts] = useState({ minMatch: 50, sort: 'overall', eligibleOnly: false });
  const [reload, setReload] = useState(0);
  const { data, error } = useMatchList(`/candidate-resumes/requirement/${requirementId}/matches`, opts, reload, onData, limit);
  const [busyId, setBusyId] = useState('');
  const [added, setAdded] = useState('');
  async function add(c) {
    setBusyId(c.id);
    setAdded('');
    try { await onAdd(c.id); setAdded(`✓ ${c.name} added to this job.`); setReload((n) => n + 1); } catch (e) { setAdded(`✗ ${(e && e.response && e.response.data && e.response.data.error) || (e && e.message) || 'Could not add. Please try again.'}`); } finally { setBusyId(''); }
  }
  return (
    // embedded: inside another card with its own title (rejections/RequirementMatchTabs.jsx).
    <div className={embedded ? 'msp' : 'card section msp'} id={embedded ? undefined : 'matching'}>
      {!embedded && <h3 style={{ fontSize: 14, margin: 0 }}>Good fit for this job</h3>}
      <div className="small-muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
        Fit = Overall · Resume (skills, experience, education read from the resume) · Location. AI score is the person&apos;s AI interview score, shown beside the Fit (not part of it). A recruiter checks every person before sending to the client.
      </div>
      <MinFit requirementId={requirementId} data={data} onSaved={() => setReload((n) => n + 1)} />
      <Tools
        opts={opts}
        setOpts={setOpts}
        withAi
        info={data ? `${countWord(data.eligible, 'person eligible', 'people eligible')} · showing ${data.shown} of ${data.total}${data.fitVersion ? ` · Fit ${data.fitVersion}` : ''}${data.semantic && data.semantic.on ? ' · matching by meaning' : ''}` : ''}
      />
      {added && <div className={`notice ${added.startsWith('✗') ? 'red' : 'rsm-ok'}`} style={{ margin: '0 0 8px' }}>{added}</div>}
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap msp-wrap">
        <table className="msp-table">
          <thead>
            <tr>
              <SortTh k="name" label="Candidate" opts={opts} setOpts={setOpts} />
              <SortTh k="overall" label="Overall" opts={opts} setOpts={setOpts} />
              <SortTh k="resume" label="Resume" opts={opts} setOpts={setOpts} />
              <SortTh k="location" label="Location" opts={opts} setOpts={setOpts} />
              <SortTh k="ai" label="AI score" opts={opts} setOpts={setOpts} />
              <th>Missing</th>
              <th>Add</th>
            </tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>Working out the Fit…</td></tr>}
            {data && data.rows.map((c) => (
              <tr key={c.id}>
                <td className="msp-main">
                  <Link to={`/candidates/${c.id}`}>{c.name}</Link>
                  {eligibleChip(c.match)}
                  <span className="msp-src">{[c.location, c.experienceYears != null ? `${c.experienceYears} yrs` : null, c.hasResume ? null : 'no resume yet'].filter(Boolean).join(' · ')}</span>
                  <Reason m={c.match} />
                </td>
                <td data-k="Overall"><Pct n={c.match.overall} /></td>
                <td data-k="Resume"><Pct n={c.match.resumePct} sub={c.match.resumeSource === 'resume' ? 'from resume' : 'from profile'} /></td>
                <td data-k="Location"><Pct n={c.match.locationPct} title={c.match.locationReason} /></td>
                <td data-k="AI score">{c.aiScore != null ? <span className={`msp-pct ${tone(c.aiScore)}`}>{`${c.aiScore}%`}</span> : <span className="cell-muted">—</span>}</td>
                <td data-k="Missing">
                  {c.match.missingMandatory.length
                    ? c.match.missingMandatory.slice(0, 4).map((s) => <span className="skillpill miss" key={s}>{s}</span>)
                    : <span className="status active">None missing</span>}
                </td>
                <td data-k="">
                  {data.canAdd && !c.blocked
                    ? <button type="button" className="btn btn-sm btn-primary" disabled={busyId === c.id} onClick={() => add(c)}>{busyId === c.id ? 'Adding…' : 'Add'}</button>
                    : <span className="cell-muted">{c.blocked ? 'Do not use' : '—'}</span>}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>{`No one new fits this job at ${data.minMatch}% or more${opts.eligibleOnly ? ' and is eligible' : ''}. Try a lower number.`}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {onOpenAll && data && data.total > data.shown && (
        <button type="button" className="btn btn-sm msp-all" onClick={onOpenAll}>{`See all ${data.total} matching people →`}</button>
      )}
    </div>
  );
}

// Candidate profile — "Eligible jobs".
export function EligibleRequirementsPanel({ candidateId, onAdd, onData }) {
  const [opts, setOpts] = useState({ minMatch: 50, sort: 'overall', eligibleOnly: false });
  const [reload, setReload] = useState(0);
  const { data, error } = useMatchList(`/candidate-resumes/${candidateId}/eligible-requirements`, opts, reload, onData);
  const [busyId, setBusyId] = useState('');
  const [added, setAdded] = useState('');
  async function add(r) {
    setBusyId(r.id);
    setAdded('');
    try { await onAdd(r.id); setAdded(`✓ Added to ${r.title}.`); setReload((n) => n + 1); } catch (e) { setAdded(`✗ ${(e && e.response && e.response.data && e.response.data.error) || (e && e.message) || 'Could not add. Please try again.'}`); } finally { setBusyId(''); }
  }
  if (error && /internal|not available|outside/i.test(error)) return null;
  return (
    <div className="msp">
      <Tools
        opts={opts}
        setOpts={setOpts}
        info={data ? `${countWord(data.eligible, 'job eligible', 'jobs eligible')} · showing ${data.shown} of ${data.total}${data.hasResume ? '' : ' · no resume yet, so Resume % uses the profile'}${data.fitVersion ? ` · Fit ${data.fitVersion}` : ''}` : ''}
      />
      {added && <div className={`notice ${added.startsWith('✗') ? 'red' : 'rsm-ok'}`} style={{ margin: '0 0 8px' }}>{added}</div>}
      {error && <div className="notice red">{error}</div>}
      <div className="tbl-wrap msp-wrap">
        <table className="msp-table">
          <thead><tr><th>Job</th><th>Overall</th><th>Resume</th><th>Location</th><th>Add</th></tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>Working out the Fit…</td></tr>}
            {data && data.rows.map((r) => (
              <tr key={r.id}>
                <td className="msp-main">
                  <Link to={`/requirements/${r.id}`}>{r.title}</Link>
                  {eligibleChip(r.match)}
                  <span className="msp-src">{[r.client, r.location].filter(Boolean).join(' · ')}</span>
                  <Reason m={r.match} />
                  {r.alreadyRejected && <span className="msp-flag">{`Rejected for this job${r.alreadyRejected.reason ? `: ${r.alreadyRejected.reason}` : ''}`}</span>}
                  {r.clientRejected && <span className="msp-flag warn">{r.clientRejected.warning || `${r.clientRejected.clientName} rejected this person before`}</span>}
                </td>
                <td data-k="Overall"><Pct n={r.match.overall} /></td>
                <td data-k="Resume"><Pct n={r.match.resumePct} sub={r.match.resumeSource === 'resume' ? 'from resume' : 'from profile'} /></td>
                <td data-k="Location"><Pct n={r.match.locationPct} title={r.match.locationReason} /></td>
                <td data-k="">
                  {data.canAdd && !r.blocked
                    ? <button type="button" className="btn btn-sm btn-primary" disabled={busyId === r.id} onClick={() => add(r)}>{busyId === r.id ? 'Adding…' : 'Add'}</button>
                    : <span className="cell-muted">—</span>}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>{`No open job in your area fits at ${data.minMatch}% or more${opts.eligibleOnly ? ' and is eligible' : ''}.`}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A ready "Fit" tab body for the candidate window / page.
export function CandidateFitPanel({ candidateId, onAdd }) {
  return (
    <div className="rsm-card msp-card">
      <h3 style={{ fontSize: 14, margin: '0 0 2px' }}>Eligible jobs</h3>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Fit = Overall · Resume (skills, experience, education from the resume) · Location.
      </div>
      <EligibleRequirementsPanel candidateId={candidateId} onAdd={onAdd} />
    </div>
  );
}

// Profile Overview — "Also a good fit for": the best 3 jobs this person is
// ELIGIBLE for (same rule as the Fit tab), with the reason in words.
export function AlsoGoodFitCard({ candidateId, onSeeTab, onAdd }) {
  const [data, setData] = useState(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api.get(`/candidate-resumes/${candidateId}/eligible-requirements`, { params: { eligibleOnly: 1, minMatch: 0, limit: 3 } })
      .then((res) => { if (live) setData(res.data); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [candidateId, n]);
  if (!data) return null;
  async function add(r) {
    setBusy(r.id); setSaid('');
    try { await onAdd(r.id); setSaid(`✓ Added to ${r.title}.`); setN((x) => x + 1); } catch (e) { setSaid(`✗ ${(e && e.response && e.response.data && e.response.data.error) || (e && e.message) || 'Could not add. Please try again.'}`); } finally { setBusy(''); }
  }
  return (
    <div className="c360t-card msp-also">
      <div className="c360t-label">Also a good fit for</div>
      {said && <div className={`notice ${said.startsWith('✗') ? 'red' : 'rsm-ok'}`} style={{ margin: '0 0 6px' }}>{said}</div>}
      {data.rows.length === 0 && <div className="small-muted">No other open job fits this person right now.</div>}
      {data.rows.map((r) => (
        <div key={r.id} className="rsm-hrow">
          <span className="rsm-grow">
            <Link to={`/requirements/${r.id}`}>{r.title}</Link>
            {[r.client, r.location].filter(Boolean).length > 0 && <span className="small-muted">{` · ${[r.client, r.location].filter(Boolean).join(' · ')}`}</span>}
            <span className="msp-reason ok">{r.match.reason}</span>
          </span>
          <span className={`msp-pct ${tone(r.match.overall)}`}>{`Fit ${r.match.overall}%`}</span>
          {onAdd && data.canAdd && !r.blocked && (
            <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => add(r)}>{busy === r.id ? 'Adding…' : 'Add'}</button>
          )}
        </div>
      ))}
      {onSeeTab && data.eligible > data.rows.length && (
        <button type="button" className="link-btn" onClick={() => onSeeTab('fit')}>{`See all ${data.eligible} on the Fit tab →`}</button>
      )}
    </div>
  );
}

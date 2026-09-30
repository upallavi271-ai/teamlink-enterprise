import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import { nf, fmtShort } from './reqFormat.jsx';
import './reach.css';

// ---------------------------------------------------------------------------
// The requirement's REACH — two panels of the Requirement 360:
//
//   PostedOnPanel            user notes #7 — where the requirement is posted,
//                            per source (GET /requirements/:id/postings):
//                            Posted / Pending / Failed + reason / Not
//                            configured / Feed ready …, with Retry.
//   LocationCandidatesPanel  user notes #6 — "Eligible candidates in
//                            <location>: N", how many are a strong match, the
//                            top 20 (scoped to what this login may see) and
//                            Add to requirement where the role may.
//
// Both load lazily and only draw what the API sends; the API enforces scope
// and permission, the buttons only mirror it.
// ---------------------------------------------------------------------------

const TONE = {
  Posted: 'green', Pending: 'amber', Failed: 'red', 'Not configured': 'grey', 'Feed ready': 'blue',
  'Not posted': 'grey', 'Taken down': 'grey', 'Not applicable': 'grey',
};
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');

export function PostedOnPanel({ requirementId, compact = false, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  function load() {
    setError('');
    return api.get(`/requirements/${requirementId}/postings`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Posting status could not be loaded.'));
  }
  useEffect(() => { setData(null); load(); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A just-saved requirement is pushed in the background: look again shortly
  // while anything still reads Pending.
  useEffect(() => {
    if (!data || !data.channels.some((c) => c.status === 'Pending')) return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function retry() {
    setBusy(true); setNote(''); setError('');
    try {
      const r = await api.post(`/requirements/${requirementId}/postings/retry`);
      setData(r.data);
      setNote(r.data.result && r.data.result.ok === false
        ? `Retried — the TeamLink Job Portal still refused: ${r.data.result.error}`
        : 'Posted again on every source.');
      if (onChanged) onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'Retry was refused.');
    } finally {
      setBusy(false);
    }
  }
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); setNote(done); } catch { setNote(text); }
  }

  if (error && !data) return <div className="card section rq-reach"><h3>Posted on</h3><div className="small-muted">{error}</div></div>;
  if (!data) return <div className="card section rq-reach"><h3>Posted on</h3><div className="small-muted">Loading…</div></div>;
  const s = data.summary || {};
  const anyRetry = data.canRetry && data.live && data.channels.some((c) => ['Failed', 'Pending', 'Not posted'].includes(c.status));
  const rows = compact ? data.channels.filter((c) => c.kind !== 'board') : data.channels;
  const boards = data.channels.filter((c) => c.kind === 'board');

  return (
    <div className="card section rq-reach">
      <div className="rq-reach-head">
        <h3>Posted on</h3>
        <span className="small-muted">
          {`${s.posted || 0} posted${s.feedReady ? ` · ${s.feedReady} feed ready` : ''}${s.failed ? ` · ${s.failed} failed` : ''}${s.pending ? ` · ${s.pending} pending` : ''}`}
        </span>
      </div>
      {rows.map((c) => (
        <div className="rq-reach-row" key={c.id}>
          <b>{c.name}</b>
          <StatusChip status={c.status} tone={TONE[c.status]} />
          <span className="small-muted rq-reach-detail">
            {c.detail}
            {c.link && (
              <>
                {' '}
                <a href={/^https?:/i.test(c.link) ? c.link : `${origin()}${c.link.startsWith('/') ? '' : '/'}${c.link}`} target="_blank" rel="noreferrer">open ↗</a>
              </>
            )}
          </span>
        </div>
      ))}
      {compact && boards.length > 0 && (
        <div className="rq-reach-row">
          <b>Job boards</b>
          <span className="small-muted rq-reach-detail">
            {boards.map((b) => `${b.name}: ${b.status}`).join(' · ')}
          </span>
        </div>
      )}
      {!compact && !data.internal && data.live && data.published && (
        <div className="rq-reach-feeds small-muted">
          Job-board feeds (boards pull these — nothing is pushed):{' '}
          <button type="button" className="link-btn" onClick={() => copy(`${origin()}${data.feeds.xml}`, 'XML feed URL copied — register it in the board’s employer account.')}>XML (Indeed / Naukri / Shine)</button>
          {' · '}
          <button type="button" className="link-btn" onClick={() => copy(`${origin()}${data.feeds.jsonld}`, 'JSON-LD feed URL copied (schema.org JobPosting).')}>JSON-LD (Google for Jobs)</button>
          {' · '}
          <Link to="/admin/integrations?tab=jobportal">Integrations →</Link>
        </div>
      )}
      {(note || error) && <div className={`small-muted rq-reach-note${error ? ' is-error' : ''}`}>{error || note}</div>}
      {anyRetry && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={retry}>{busy ? 'Posting…' : 'Retry posting'}</button>
      )}
      {data.publishedAt && <div className="small-muted rq-reach-foot">{`Published ${fmtShort(data.publishedAt)}`}</div>}
    </div>
  );
}

// "Eligible candidates in Hyderabad: 1,240 · 212 strong" — with the list.
export function LocationCandidatesPanel({ requirementId, onAdded, summaryOnly = false, onOpenList }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [added, setAdded] = useState([]);

  useEffect(() => {
    setData(null); setError(''); setAdded([]);
    api.get(`/requirements/${requirementId}/location-candidates`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.status === 403 ? '' : (e.response?.data?.error || 'Could not count candidates in this location.')));
  }, [requirementId]);

  async function add(c) {
    setBusy(c.id); setError('');
    try {
      await api.post('/applications', { candidateId: c.id, requirementId });
      setAdded((a) => [...a, c.id]);
      if (onAdded) onAdded();
    } catch (e) {
      setError(e.response?.data?.error || 'Could not add this candidate.');
    } finally {
      setBusy('');
    }
  }

  if (!data && !error) return summaryOnly ? null : <div className="card section rq-reach"><div className="small-muted">Counting candidates in this location…</div></div>;
  if (!data) return error ? <div className="card section rq-reach"><div className="small-muted">{error}</div></div> : null;
  const place = data.cities.length ? data.cities.join(' / ') : (data.location || 'this location');

  if (!data.cities.length) {
    return (
      <div className="card section rq-reach">
        <h3>Eligible candidates by location</h3>
        <div className="small-muted">
          {data.location ? `“${data.location}” is not a city the matcher recognises.` : 'No location on this requirement yet — add one in Edit Requirement to see who is nearby.'}
        </div>
      </div>
    );
  }

  const headline = (
    <>
      <b>{`Eligible candidates in ${place}: ${nf(data.total)}`}</b>
      <span className="small-muted">
        {` · ${nf(data.strong)} strong match (≥${data.threshold}% on skills, experience and the rest)`}
        {data.alreadyLinked ? ` · ${nf(data.alreadyLinked)} already on this requirement` : ''}
      </span>
    </>
  );

  if (summaryOnly) {
    return (
      <div className="card section rq-reach">
        <h3>Candidates in this location</h3>
        <div>{headline}</div>
        {data.byCity.length > 1 && <div className="small-muted">{data.byCity.map((b) => `${b.city}: ${nf(b.count)}`).join(' · ')}</div>}
        {onOpenList && <button type="button" className="btn btn-sm" onClick={onOpenList}>See the top 20 →</button>}
      </div>
    );
  }

  const rows = data.rows.filter((c) => !added.includes(c.id));
  return (
    <div className="card section rq-reach" id="location-candidates">
      <div className="rq-reach-head"><div>{headline}</div></div>
      {data.byCity.length > 1 && <div className="small-muted">{data.byCity.map((b) => `${b.city}: ${nf(b.count)}`).join(' · ')}</div>}
      <div className="small-muted" style={{ margin: '4px 0 8px' }}>
        Current or preferred location in {place} (Hyderabad includes Secunderabad and its localities). Only candidates you may see are counted.
        {added.length > 0 && ` ${added.length} added to this requirement.`}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Candidate</th><th>Location</th><th>Experience</th><th>Matching skills</th><th>Match</th>{data.canAdd && <th />}</tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/candidates/${c.id}`}>{c.name}</Link></td>
                <td className="cell-muted">
                  {c.location || '—'}
                  {c.preferredLocation && c.preferredLocation !== c.location && <div className="small-muted">{`prefers ${c.preferredLocation}`}</div>}
                </td>
                <td className="cell-muted">{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</td>
                <td className="cell-muted">{(c.matchedSkills || []).join(', ') || '—'}</td>
                <td><StatusChip tone={c.match >= data.threshold ? 'green' : c.match >= 50 ? 'amber' : 'grey'}>{`${c.match}%`}</StatusChip></td>
                {data.canAdd && (
                  <td>
                    <button type="button" className="btn btn-sm" disabled={busy === c.id} onClick={() => add(c)}>
                      {busy === c.id ? 'Adding…' : 'Add to requirement'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={data.canAdd ? 6 : 5} className="small-muted" style={{ padding: 12 }}>No candidate in {place} who is not already on this requirement.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data.total > rows.length && <div className="small-muted">{`Top ${rows.length} by match of ${nf(data.total)}.`}</div>}
    </div>
  );
}

// The quick drawer's one-glance version: "Posted on 2 · 4 feed ready" and
// "Eligible in Hyderabad: 1,240 · 212 strong". Both calls are refused quietly
// for a login that may not see them (a client, no Matching permission).
export function DrawerReach({ requirementId }) {
  const [post, setPost] = useState(null);
  const [loc, setLoc] = useState(null);
  useEffect(() => {
    let live = true;
    setPost(null); setLoc(null);
    api.get(`/requirements/${requirementId}/postings`).then((r) => { if (live) setPost(r.data); }).catch(() => { if (live) setPost(false); });
    api.get(`/requirements/${requirementId}/location-candidates`).then((r) => { if (live) setLoc(r.data); }).catch(() => { if (live) setLoc(false); });
    return () => { live = false; };
  }, [requirementId]);
  if (post === false && loc === false) return null;
  const s = post && post.summary;
  return (
    <div className="req360-sec rq-reach">
      <h4>Posted on · location</h4>
      {post === null && <div className="small-muted">Loading…</div>}
      {post && (
        <div className="reqdrw-kv">
          <span>Posted on</span>
          <span>
            {post.channels.filter((c) => c.status === 'Posted').map((c) => c.name).join(', ') || 'Nowhere yet'}
            {s.feedReady ? <span className="small-muted">{` · ${s.feedReady} job board(s) feed ready`}</span> : null}
            {s.failed ? <> {' '}<StatusChip tone="red">{`${s.failed} failed`}</StatusChip></> : null}
            {s.pending ? <> {' '}<StatusChip tone="amber">{`${s.pending} pending`}</StatusChip></> : null}
          </span>
        </div>
      )}
      {loc && loc.cities && loc.cities.length > 0 && (
        <div className="reqdrw-kv">
          <span>{`Eligible in ${loc.cities.join(' / ')}`}</span>
          <span>
            {nf(loc.total)}
            <span className="small-muted">{` · ${nf(loc.strong)} strong (≥${loc.threshold}%)`}</span>
          </span>
        </div>
      )}
    </div>
  );
}

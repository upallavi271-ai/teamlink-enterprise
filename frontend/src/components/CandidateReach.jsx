import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusChip from './ui/StatusChip.jsx';
import { stageLabel, protoDate } from '../atsVocab';
import './jobs/reach.css';

// ---------------------------------------------------------------------------
// Candidate 360 — the candidate's REACH:
//
//   ApplicationsList            user notes #5 — EVERY application this login
//                               may see (rejected, closed and joined
//                               included), latest first: requirement code +
//                               title, client (name only), department,
//                               recruiter, current stage, applied, last
//                               update, next action. A row opens that
//                               application's context. Applications in other
//                               teams are COUNTED ("+2 in other teams"),
//                               never described — the API sends only the
//                               number (routes/candidates.js).
//   LocationRequirementsPanel   user notes #6 — "Open requirements in
//                               <candidate's city>: N" with code, title,
//                               client, openings, match, and Add to
//                               requirement where the role may.
// ---------------------------------------------------------------------------

const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const clientOf = (a) => (a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—');
const byLatest = (x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''));
const lastUpdate = (a) => {
  const d = [a.stageSince, a.updatedAt].filter(Boolean).map((v) => new Date(v).getTime());
  return d.length ? new Date(Math.max(...d)) : null;
};
const nextOf = (a) => {
  if (CLOSED.includes(a.stage)) return a.stage === 'REJECTED' ? 'Closed — rejected' : 'Closed — joined';
  return (a.followUp && !a.followUp.completedAt && a.followUp.nextAction) || a.nextAction || '—';
};

export function ApplicationsList({ c, selectedId, onSelect, compact = false, limit = 0 }) {
  const [all, setAll] = useState(false);
  const apps = [...(c.applications || [])].sort(byLatest);
  const other = Number(c.otherTeamApplications || 0);
  const shown = limit && !all ? apps.slice(0, limit) : apps;
  const summary = [
    `${apps.length} application${apps.length === 1 ? '' : 's'}`,
    `${new Set(apps.map((a) => (a.requirement?.internal ? 'internal' : a.requirement?.clientId))).size} client(s)`,
    `${apps.filter((a) => !CLOSED.includes(a.stage)).length} active`,
    `${apps.filter((a) => a.stage === 'REJECTED').length} rejected`,
    `${apps.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length} joined`,
  ].join(' · ');

  if (!apps.length && !other) return <div className="small-muted">No application yet.</div>;

  return (
    <div className="rq-reach">
      <div className="small-muted" style={{ marginBottom: 6 }}>
        {summary}
        {other > 0 && <b style={{ color: 'var(--ink)' }}>{` · +${other} in other teams`}</b>}
        {onSelect && apps.length > 1 && ' · click a row to open that application'}
      </div>
      <div className="tbl-wrap">
        <table className="rq-reach-apps">
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Client</th>
              {!compact && <th>Department</th>}
              {!compact && <th>Recruiter</th>}
              <th>Stage</th>
              <th>Applied</th>
              {!compact && <th>Last update</th>}
              {!compact && <th>Next action</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr
                key={a.id}
                className={`${onSelect ? 'rq-click' : ''}${a.id === selectedId ? ' is-selected' : ''}`}
                onClick={onSelect ? () => onSelect(a.id) : undefined}
                title={onSelect ? 'Open this application' : undefined}
              >
                <td>
                  <Link to={`/requirements/${a.requirementId}`} onClick={(e) => e.stopPropagation()}>
                    {a.requirement?.reqCode ? `${a.requirement.reqCode} · ` : ''}{a.requirement?.title || '—'}
                  </Link>
                  {compact && <div className="small-muted">{[a.requirement?.department, nextOf(a)].filter(Boolean).join(' · ')}</div>}
                </td>
                <td className="cell-muted">{clientOf(a)}</td>
                {!compact && <td className="cell-muted">{a.requirement?.department || '—'}</td>}
                {!compact && <td className="cell-muted">{a.followUp?.ownerName || a.requirement?.recruiter?.name || '—'}</td>}
                <td>
                  <StatusChip status={a.stageGroupLabel || stageLabel(a.stage)} />
                  {!compact && a.stageDetailLabel && a.stageDetailLabel !== a.stageGroupLabel && <div className="small-muted">{a.stageDetailLabel}</div>}
                </td>
                <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{protoDate(a.createdAt)}</td>
                {!compact && <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{lastUpdate(a) ? protoDate(lastUpdate(a)) : '—'}</td>}
                {!compact && <td className="cell-muted">{nextOf(a)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit > 0 && apps.length > limit && (
        <button type="button" className="link-btn rq-reach-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${apps.length}`}
        </button>
      )}
      {other > 0 && (
        <div className="small-muted rq-reach-more">
          {`${other} more application(s) belong to other teams — they are counted here but not shown, because they are outside your access.`}
        </div>
      )}
    </div>
  );
}

export function LocationRequirementsPanel({ candidateId, compact = false, onApplied }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setData(null); setError(''); setDone([]); setShowAll(false);
    api.get(`/candidates/${candidateId}/location-requirements`)
      .then((r) => setData(r.data))
      .catch((e) => { if (e.response?.status !== 403) setError(e.response?.data?.error || 'Could not load open requirements nearby.'); setData(false); });
  }, [candidateId]);

  async function add(r) {
    if (busy) return; // one application per click
    setBusy(r.id); setError('');
    try {
      await api.post('/applications', { candidateId, requirementId: r.id });
      setDone((d) => [...d, r.id]);
      if (onApplied) onApplied();
    } catch (e) {
      if (e.alreadyApplied) { setDone((d) => [...d, r.id]); if (onApplied) onApplied(); } // the box says where
      else setError(e.response?.data?.error || 'Could not add to this requirement.');
    } finally {
      setBusy('');
    }
  }

  if (data === false && !error) return null;
  if (!data) {
    return (
      <div className={compact ? 'cdw-card rq-reach' : 'card section rq-reach'}>
        <div className={compact ? 'cdw-label' : ''}>{compact ? 'Open requirements nearby' : <h3>Open requirements nearby</h3>}</div>
        <div className="small-muted">{error || 'Loading…'}</div>
      </div>
    );
  }
  const place = data.cities.length ? data.cities.join(' / ') : null;
  const sorted = [...data.rows].sort((x, y) => (y.match || 0) - (x.match || 0));
  const rows = showAll ? sorted : sorted.slice(0, 5);
  const title = 'Requirements that fit this person';

  return (
    <div className={compact ? 'cdw-card rq-reach' : 'card section rq-reach'} id="location-requirements">
      {compact ? <div className="cdw-label">{title}</div> : <h3>{title}</h3>}
      {!place && (
        <div className="small-muted">
          {data.location || data.preferredLocation
            ? `“${[data.location, data.preferredLocation].filter(Boolean).join(' / ')}” is not a city the matcher recognises.`
            : 'No current or preferred location on file — add one to see open requirements nearby.'}
        </div>
      )}
      {place && (
        <div className="small-muted" style={{ marginBottom: 6 }}>
          {`Open requirements in ${place}: ${data.total}. ${data.strong} fit 60% or more, ${data.notApplied ?? data.total} not added yet.`}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      {place && rows.length > 0 && (
        <div className="c360-jobs">
          {rows.map((r) => {
            const applied = r.applied || done.includes(r.id);
            const where = [r.client, r.location, r.openings != null ? `${r.openings} opening${r.openings === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
            return (
              <div key={r.id} className="c360-job">
                <div className="c360-job-main">
                  <Link className="c360-job-title" to={`/requirements/${r.id}`}>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</Link>
                  {where && <div className="small-muted">{where}</div>}
                </div>
                <StatusChip tone={r.match >= 60 ? 'green' : r.match >= 50 ? 'amber' : 'grey'}>{`${r.match}% fit`}</StatusChip>
                {applied && <span className="c360-job-added">Added ✓</span>}
                {!applied && data.canAdd && (
                  <button type="button" className="btn btn-sm" disabled={busy === r.id} title="Add this person to this requirement" onClick={() => add(r)}>
                    {busy === r.id ? 'Adding…' : 'Add'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {place && sorted.length > 5 && (
        <button type="button" className="link-btn c360-showall" onClick={() => setShowAll((x) => !x)}>
          {showAll ? 'Show top 5' : `Show all ${sorted.length}`}
        </button>
      )}
      {place && !rows.length && <div className="small-muted">{`No open requirement in ${place} within your access.`}</div>}
    </div>
  );
}

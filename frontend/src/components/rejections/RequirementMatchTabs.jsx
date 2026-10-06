// ---------------------------------------------------------------------------
// JOB PAGE → "Matching candidates" as three tabs (spec 2026-10-03 §A2):
//
//   [Matching N]  [Previously rejected, but a good fit N]  [Rejected on this job N]
//
// Matching is the resume/fit agent's panel (components/resume/MatchSplit.jsx),
// used as it is; the two new tabs read GET /api/rejections/requirement/:id/tabs,
// which scores with the SAME scorer (utils/resumeMatch.js threeNumbers).
//
// Re-consider rules:
//   * green "Reason may not apply here" when the old reason likely does not
//     fit this job (position closed, this job pays more)
//   * red warning + confirm when THIS client rejected them before
//   * "Do not use" people are shown in red with no button
//   * the new application starts with the note "Re-considered, earlier
//     rejected by X (Reason)" — written by the server (POST /applications)
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { RequirementMatchesPanel } from '../resume/MatchSplit.jsx';
import { shortDate } from './rejectionUi.jsx';
import './Rejections.css';

const tone = (n) => (n >= 70 ? 'hi' : n >= 50 ? 'mid' : 'lo');
const FIT_CHOICES = [[50, '50% or more'], [30, '30% or more'], [0, 'Any fit']];

export default function RequirementMatchTabs({
  requirementId, title, clientName, onAdd, onChanged,
}) {
  const [tab, setTab] = useState('matching');
  const [matchN, setMatchN] = useState(null);
  const [minMatch, setMinMatch] = useState(50);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [confirmFor, setConfirmFor] = useState(''); // candidate id awaiting the red confirm
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState('');

  const load = useCallback(() => {
    api.get(`/rejections/requirement/${requirementId}/tabs`, { params: { minMatch, limit: 50 } })
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => { setData(null); setError(err.response?.data?.error || 'Could not load these lists. Please try again.'); });
  }, [requirementId, minMatch]);
  useEffect(() => { load(); }, [load]);

  async function reconsider(row, confirmSameClient = false) {
    if (row.sameClient && !confirmSameClient) { setConfirmFor(row.id); return; }
    setBusy(row.id);
    setError('');
    setSaid('');
    try {
      await api.post('/applications', {
        candidateId: row.id, requirementId, reconsider: true, ...(confirmSameClient ? { confirmSameClient: true } : {}),
      });
      setConfirmFor('');
      setSaid(`${row.name} added to this job. The note says why they were rejected before.`);
      load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.response?.data?.error || `Could not add ${row.name}. Please try again.`);
    } finally {
      setBusy('');
    }
  }

  const prev = data ? data.previouslyRejected : null;
  const here = data ? data.rejectedHere : null;
  const TABS = [
    ['matching', 'Good fit', matchN],
    ['previous', 'Rejected before, good fit', prev ? prev.total : null],
    ['here', 'Rejected on this job', here ? here.total : null],
  ];

  return (
    <div className="card section rjx-matchcard">
      <h3 style={{ fontSize: 14, margin: 0 }}>{`Good fit for ${title || 'this job'}${clientName ? ` (${clientName})` : ''}`}</h3>
      <div className="rjx-tabs" role="tablist">
        {TABS.map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`rjx-tab${tab === id ? ' is-on' : ''}`} onClick={() => setTab(id)}>
            {label}
            {/* Never a bare zero. */}
            {n != null && n > 0 && <b>{n}</b>}
          </button>
        ))}
      </div>

      {/* Matching stays mounted so its count is known on the other tabs. */}
      <div className="rjx-embed" hidden={tab !== 'matching'}>
        <RequirementMatchesPanel requirementId={requirementId} onAdd={onAdd} embedded onData={(d) => setMatchN(d && d.total != null ? d.total : null)} />
      </div>

      {tab !== 'matching' && error && <div className="notice red">{error}</div>}
      {tab !== 'matching' && said && <div className="rjx-ok" role="status" style={{ marginBottom: 8 }}>{said}</div>}

      {tab === 'previous' && (
        <>
          <div className="small-muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
            People rejected on another job who fit this one. Check why before you add them again.
          </div>
          <div className="rjx-row" style={{ marginBottom: 8 }}>
            <label className="small-muted">
              {'Fit % '}
              <select value={minMatch} onChange={(e) => setMinMatch(Number(e.target.value))}>
                {FIT_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {prev && prev.total > prev.shown && <span className="small-muted">{`Showing the best ${prev.shown} of ${prev.total}`}</span>}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Fit %</th><th>Rejected before for</th><th>Rejected by</th><th>Reason</th><th>Date</th><th>Action</th></tr></thead>
              <tbody>
                {!data && !error && <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
                {prev && prev.rows.map((c) => {
                  const last = c.rejections[0] || null;
                  return [
                    <tr key={c.id} className={c.blocked ? 'rjx-blocked' : undefined}>
                      <td>
                        <Link to={`/candidates/${c.id}`}>{c.name}</Link>
                        {c.rejectedTimes > 1 && <span className="rjx-badge">{`Rejected ${c.rejectedTimes}×`}</span>}
                        <span className="msp-src">{[c.location, c.experienceYears != null ? `${c.experienceYears} yrs` : null].filter(Boolean).join(' · ')}</span>
                        {c.blocked && <span className="rjx-flag is-red"><b>Do not use</b> — blocked from every job.</span>}
                        {!c.blocked && c.doNotUse === 'pending' && <span className="rjx-flag is-orange">"Do not use" asked — waiting for the team lead.</span>}
                        {c.sameClient && <span className="rjx-flag is-red">{c.sameClient}</span>}
                        {c.mayNotApply && <span className="rjx-ok">{`Reason may not apply here: ${c.mayNotApply}`}</span>}
                      </td>
                      <td>
                        <span className={`msp-pct ${tone(c.match.overall)}`}>{`${c.match.overall}%`}</span>
                        <span className="msp-src">{`Resume ${c.match.resumePct}% · Location ${c.match.locationPct}%`}</span>
                      </td>
                      <td>
                        {last
                          ? <>{last.requirementTitle || 'Job'}{last.clientName ? ` (${last.clientName})` : ''}</>
                          : <span className="small-muted">A job on another team</span>}
                        {c.hiddenCount > 0 && last && <span className="msp-src">{`+${c.hiddenCount} on other teams' jobs`}</span>}
                      </td>
                      <td>{last ? (last.byLabel || last.sideLabel) : '—'}</td>
                      <td>{last ? (last.reason || 'Not recorded') : '—'}</td>
                      <td className="cpl-nowrap">{last ? shortDate(last.at) : '—'}</td>
                      <td>
                        {c.blocked && <span className="rjx-bad">Blocked</span>}
                        {!c.blocked && data.canAdd && (
                          <button type="button" className={`btn btn-sm ${c.sameClient ? 'btn-danger' : 'btn-primary'}`} disabled={busy === c.id} onClick={() => reconsider(c)}>Add again</button>
                        )}
                        {!c.blocked && !data.canAdd && <span className="cell-muted">—</span>}
                      </td>
                    </tr>,
                    confirmFor === c.id && (
                      <tr key={`${c.id}-confirm`}>
                        <td colSpan="7">
                          <div className="rjx-warn">
                            <b>{c.sameClient}.</b>
                            {' Add them to this job again anyway?'}
                            <div className="rjx-row">
                              <button type="button" className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => reconsider(c, true)}>Yes, add again</button>
                              <button type="button" className="btn btn-sm" onClick={() => setConfirmFor('')}>Cancel</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
                {prev && prev.rows.length === 0 && (
                  <tr><td colSpan="7" className="small-muted" style={{ padding: 16 }}>No one rejected on another job fits this one right now.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'here' && (
        <>
          <div className="small-muted" style={{ fontSize: 12, margin: '0 0 6px' }}>Everyone rejected on this job, and why. Use it to see what keeps going wrong.</div>
          {here && here.total > 0 && (
            <div className="rjx-why">
              {here.byReason.slice(0, 5).map((x) => <span key={x.label}>{`${x.label}: ${x.count}`}</span>)}
              {here.bySide.map((x) => <span key={`s-${x.label}`}>{`${x.label}: ${x.count}`}</span>)}
            </div>
          )}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Candidate</th><th>Rejected by</th><th>Reason</th><th>Note</th><th>Date</th></tr></thead>
              <tbody>
                {!data && !error && <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
                {here && here.rows.map((x) => (
                  <tr key={x.applicationId}>
                    <td>
                      <Link to={`/candidates/${x.candidateId}`}>{x.name}</Link>
                      {x.kind === 'do_not_use' && <span className="rjx-badge">Do not use</span>}
                    </td>
                    <td>{x.byLabel || x.sideLabel}</td>
                    <td>{x.reason || 'Not recorded'}</td>
                    <td className="small-muted" style={{ maxWidth: 280 }}>
                      {x.detail || '—'}
                      {x.clientSaid && <div className="rjx-said">{`Client said: "${x.clientSaid}"`}</div>}
                    </td>
                    <td className="cpl-nowrap">{shortDate(x.at)}</td>
                  </tr>
                ))}
                {here && here.rows.length === 0 && (
                  <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>No one has been rejected on this job.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {here && here.total > here.rows.length && <div className="small-muted">{`Showing the latest ${here.rows.length} of ${here.total}.`}</div>}
        </>
      )}
    </div>
  );
}

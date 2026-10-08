import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Icon } from '../atskit/AtsKit.jsx';
import { JobStatusChip } from '../jobs/reqStatus.jsx';
import { PriorityChip, slaInfo, ageText, fmtShort, nf } from '../jobs/reqFormat.jsx';
import { waitingText } from '../jobs/reqActions.js';
import { ClientPausedBadge } from '../clients/ClientLifecycle.jsx';
import './crq4.css';

// ---------------------------------------------------------------------------
// "Selected Requirement" — the right-hand panel beside the list (reference
// layout). It shows the row the person clicked, from the LIST ROW the page
// already holds (no new fields), plus the latest events from the existing
// GET /requirements/:id/activity (the same call the quick drawer makes).
//
//   onAction(key)  the row's main action (the same pickRowAction the table uses)
//   onQuickView()  opens the existing quick drawer (every other row action)
// ---------------------------------------------------------------------------
export default function SelectedRequirement({
  row: r, onAction, onQuickView, role,
}) {
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    if (!r) return undefined;
    let live = true;
    setActivity(null);
    api.get(`/requirements/${r.id}/activity`, { params: { limit: 10 } })
      .then((res) => { if (live) setActivity((Array.isArray(res.data) ? res.data : []).slice(0, 4)); })
      .catch(() => { if (live) setActivity([]); });
    return () => { live = false; };
  }, [r && r.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!r) {
    return <div className="ak-empty">Click a requirement in the list to see it here.</div>;
  }
  const sla = slaInfo(r.sla);
  const act = r.primaryAction || { key: 'open', label: 'View' };
  const wait = waitingText(r);
  const kv = (k, v) => (
    <div className="crq4-sel-kv"><span>{k}</span><span>{v === null || v === undefined || v === '' ? '—' : v}</span></div>
  );
  return (
    <div className="crq4-sel">
      <div className="crq4-sel-top">
        <span className="crq4-sel-id"><span>Req ID</span><b>{r.reqCode || r.id.slice(0, 8)}</b></span>
        <JobStatusChip job={r} />
      </div>
      <div className="crq4-sel-title" title={r.title}>{r.title || '—'}</div>

      <div className="crq4-sel-line">
        <span className="crq4-sel-ic"><Icon name="building" size={15} /></span>
        <span className="crq4-sel-main">
          {r.internal ? <span>TeamLink (internal)</span>
            : r.clientLink && r.clientId ? <Link to={`/clients/${r.clientId}`}>{r.client?.name || '—'}</Link>
              : <span>{r.client?.name || '—'}</span>}
          <ClientPausedBadge lifecycle={r.client?.lifecycle} />
          {r.location && <span className="crq4-sel-sub">{r.location}</span>}
        </span>
      </div>
      <div className="crq4-sel-line">
        <span className="crq4-sel-ic"><Icon name="team" size={15} /></span>
        <span className="crq4-sel-main">{[r.department, r.section].filter(Boolean).join(' · ') || '—'}</span>
      </div>

      <div className="crq4-sel-kvs">
        {kv('Openings', `${nf(r.openings || 1)}${r.filled ? ` · ${nf(r.filled)} filled` : ''}`)}
        {kv('Team Lead', r.tlName)}
        {kv('Recruiter', r.workedBy ? `${r.workedBy}${r.coRecruiterNames?.length ? ` +${r.coRecruiterNames.length}` : ''}` : null)}
        {r.bde?.name && kv('Client manager', r.bde.name)}
        {kv('Priority', r.priority ? <PriorityChip value={r.priority} /> : null)}
        {kv('SLA', sla ? <span className={`crq4-sla ${sla.cls}`} title={sla.title}>{sla.text}</span> : (r.ageDays !== undefined && r.ageDays !== null ? ageText(r.ageDays) : null))}
      </div>

      {role !== 'accounts' && (
        <div className="crq4-sel-next">
          <span className="crq4-sel-nextic"><Icon name="bolt" size={15} /></span>
          <div className="crq4-sel-nextbody">
            <span className="crq4-sel-nexthead">Next step</span>
            <b>{act.label}</b>
            {wait && <span className="crq4-sel-sub">{wait}</span>}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onAction(act.key)}>{act.label}</button>
          </div>
        </div>
      )}

      <div className="crq4-sel-btns">
        <button type="button" className="btn btn-sm" onClick={onQuickView}>Quick view</button>
        <Link className="btn btn-sm" to={`/requirements/${r.id}`}>Open job</Link>
      </div>

      <div className="crq4-sel-trail">
        <span className="crq4-sel-nexthead">Audit trail</span>
        {activity === null ? <div className="crq4-sel-sub">Loading…</div>
          : activity.length === 0 ? <div className="crq4-sel-sub">No activity yet</div> : (
            <ul>
              {activity.map((a) => (
                <li key={a.id}>
                  <span className="when">{fmtShort(a.createdAt)}</span>
                  <span className="what">
                    {a.action}
                    {a.candidateName ? ` — ${a.candidateName}` : ''}
                    {a.by ? <span className="by">{` by ${a.by}`}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

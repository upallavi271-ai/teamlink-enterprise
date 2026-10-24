import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Icon } from '../atskit/AtsKit.jsx';
import { JobStatusChip } from '../jobs/reqStatus.jsx';
import { PriorityChip, slaInfo, ageText, fmtShort, nf } from '../jobs/reqFormat.jsx';
import { waitingText } from '../jobs/reqActions.js';
import { ClientPausedBadge } from '../clients/ClientLifecycle.jsx';
import { DeptTag, PersonName, rowPrimary, nextStepSentence } from './JobsListBits.jsx';
import './crq4.css';

// ---------------------------------------------------------------------------
// "Selected job" — the panel for the row the person clicked (beside the list
// on a big screen, sliding over it on a smaller one). It shows the LIST ROW
// the page already holds (no new fields), plus the latest events from the
// existing GET /requirements/:id/activity.
//
//   onAction(key)  the row's main action (the same pickRowAction the table uses)
//   onQuickView()  opens the existing quick drawer (every other row action)
//   actions        the row's other actions (menuFor(row)): shown as plain
//                  buttons — Edit, Pause / Resume, Change team lead ... — no menu.
//
// Layout: label / value rows on a fixed grid (never clipped, long names wrap),
// ONE sentence + ONE button in the Next step box, then the other buttons.
// ---------------------------------------------------------------------------
const SECONDARY = {
  edit: 'Edit requirement',
  hold: 'Pause requirement',
  reopen: null, // label comes from the action itself (Resume / Reopen)
  'assign-tl': 'Change team lead',
  'assign-recruiter': 'Change recruiter',
};

export default function SelectedRequirement({
  row: r, onAction, onQuickView, role, actions = [],
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
  const primary = rowPrimary(r, role);
  const wait = role === 'accounts' ? '' : waitingText(r);
  const live = r.live !== false;
  const kv = (k, v) => (
    <div className="crq4-sel-kv"><span>{k}</span><span>{v === null || v === undefined || v === '' ? '—' : v}</span></div>
  );
  // The other buttons: what this login may do on the row, minus the main one.
  const others = actions
    .filter((a) => SECONDARY[a.key] !== undefined && a.key !== primary.key)
    .map((a) => ({ key: a.key, label: SECONDARY[a.key] || a.label }));
  const ageLine = r.ageDays !== undefined && r.ageDays !== null ? `${ageText(r.ageDays)}` : null;
  return (
    <div className="crq4-sel">
      <div className="crq4-sel-top">
        <span className="crq4-sel-id"><span>Requirement ID</span><b>{r.reqCode || r.id.slice(0, 8)}</b></span>
        {r.internal && <span className="rr-type internal">Internal</span>}
        <span className="crq4-sel-status"><JobStatusChip job={r} /></span>
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
      {(r.department || r.section) && (
        <div className="crq4-sel-line">
          <span className="crq4-sel-ic"><Icon name="team" size={15} /></span>
          <span className="crq4-sel-main crq4-sel-dept">
            {r.department && <DeptTag name={r.department} />}
            {r.section && <span className="crq4-sel-sub">{r.section}</span>}
          </span>
        </div>
      )}

      <div className="crq4-sel-kvs">
        {kv('Openings', `${nf(r.openings || 1)}${r.filled ? ` · ${nf(r.filled)} filled` : ''}`)}
        {kv('Team lead', <PersonName name={r.tlName} extra={r.extraTlNames?.length || 0} tone="red" live={live} />)}
        {kv('Recruiter', <PersonName name={r.workedBy} extra={r.coRecruiterNames?.length || 0} tone="amber" live={live} />)}
        {r.bde?.name && kv('Client manager', r.bde.name)}
        {kv('Priority', r.priority ? <PriorityChip value={r.priority} /> : null)}
        {kv('Age / SLA', sla
          ? <span className={`crq4-sla ${sla.cls}`} title={sla.title}>{[ageLine, sla.text].filter(Boolean).join(' · ')}</span>
          : ageLine)}
      </div>

      {role !== 'accounts' && (
        <div className="crq4-sel-next">
          <span className="crq4-sel-nextic"><Icon name="bolt" size={15} /></span>
          <div className="crq4-sel-nextbody">
            <span className="crq4-sel-nexthead">Next step</span>
            <p className="crq4-sel-sentence">{nextStepSentence(r, primary, wait)}</p>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onAction(primary.key)}>{primary.label}</button>
          </div>
        </div>
      )}

      <div className="crq4-sel-btns">
        {primary.key !== 'open' && <Link className="btn btn-sm" to={`/requirements/${r.id}`}>Open requirement</Link>}
        {others.map((a) => (
          <button key={a.key} type="button" className="btn btn-sm" onClick={() => onAction(a.key)}>{a.label}</button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onQuickView}>Quick view</button>
      </div>

      <div className="crq4-sel-trail">
        <span className="crq4-sel-nexthead">History (audit trail)</span>
        {activity === null ? <div className="crq4-sel-sub">Loading…</div>
          : activity.length === 0 ? <div className="crq4-sel-sub">Nothing yet</div> : (
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

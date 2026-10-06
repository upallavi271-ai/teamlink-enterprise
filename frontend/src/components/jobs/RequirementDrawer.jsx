import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import { requirementStatusLabel } from '../../atsVocab';
import StatusChip from '../ui/StatusChip.jsx';
import {
  PriorityChip, PipelineSteps, slaInfo, lastActivityText, fmtWhen, fmtShort, nf, reqStatusTone,
} from './reqFormat.jsx';

// ---------------------------------------------------------------------------
// REQUIREMENT 360 — QUICK DRAWER (ATS review #3 §4; review #2 §7). Opens from
// a row of the Requirements list without leaving it:
//
//   Requirement · Client (name only outside the client desk — the API sends
//   nothing more) · Position · Department · Location · Openings
//   Assigned Team — TL, Recruiter(s) with seat ("MED-5 · Medical Team")
//   Candidates pipeline New → Recruiter Review → TL Review → Client Review
//     → Interview → Selected → Joined (counts, each opens Candidates there)
//   Agreement · Job Portal (published? applications, link) · Activity
//
// The row gives the header at once; GET /requirements/:id/summary adds the
// team with seats, the agreement and the portal line, and /:id/activity the
// latest events. The pipeline counts are the SAME pipelineCounts() the row
// and the detail page carry (routes/requirements.js). Buttons follow the
// server's per-row flags (row.mayAssign / row.mayEdit); the API enforces them.
// Simplified 2026-10-03: four parts — Job, Team, People in process, Recent
// activity. `actions` (optional) = the row's other actions as plain buttons
// ({ key, label, danger }), picked through onPick(key).
// ---------------------------------------------------------------------------
export default function RequirementDrawer({ row: r, onClose, onAssign, actions, onPick }) {
  const navigate = useNavigate();
  const [sum, setSum] = useState(null);
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!r) return undefined;
    let live = true;
    setSum(null); setActivity(null);
    api.get(`/requirements/${r.id}/summary`).then((res) => { if (live) setSum(res.data); }).catch(() => { if (live) setSum({}); });
    api.get(`/requirements/${r.id}/activity`, { params: { limit: 10 } })
      .then((res) => { if (live) setActivity((res.data || []).slice(0, 6)); })
      .catch(() => { if (live) setActivity([]); });
    return () => { live = false; };
  }, [r && r.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  const sla = slaInfo(r.sla);
  const kv = (k, v) => <div className="reqdrw-kv"><span>{k}</span><span>{v || '—'}</span></div>;
  const pipeline = (sum && sum.pipeline) || r.pipeline;
  const team = sum && sum.team;
  const person = (p, role) => (
    <div className="req360-person" key={`${role}-${p.id || p.name}`}>
      <span>
        <span className="small-muted">{`${role} · `}</span>
        {p.name || '—'}
      </span>
      {p.seat && <span className="seat">{p.seat}</span>}
    </div>
  );
  return (
    <div className="reqdrw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="reqdrw reqdrw-big" role="dialog" aria-label={`Job ${r.reqCode || r.title}`}>
        <div className="reqdrw-head">
          <div style={{ minWidth: 0 }}>
            <div className="reqdrw-code">{r.reqCode || r.id.slice(0, 8)}</div>
            <div className="reqdrw-title">{r.title}</div>
            <div className="reqdrw-sub">
              <StatusChip status={requirementStatusLabel(r.status)} tone={reqStatusTone(r.status)} />
              <PriorityChip value={r.priority} />
              {r.agreementPending && <StatusChip tone="amber">Waiting for agreement</StatusChip>}
            </div>
          </div>
          <button type="button" className="reqdrw-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="reqdrw-body">
          {/* Open job + every other action of the row, as plain buttons. */}
          <div className="reqdrw-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/requirements/${r.id}`)}>Open job</button>
            {/* Everyday actions first; Pause / Close / Delete / Export sit in a
                quieter second row (user, 2026-10-03: "neat ga"). */}
            {actions ? actions.filter((a) => !a.danger && !/export|pause/i.test(a.label)).map((a) => (
              <button key={a.key} type="button" className="btn" onClick={() => onPick(a.key)}>{a.label}</button>
            )) : (
              <>
                {r.mayAssign && <button type="button" className="btn" onClick={() => onAssign(r)}>Assign recruiter</button>}
                {r.mayEdit && <button type="button" className="btn" onClick={() => navigate(`/requirements/${r.id}?action=edit`)}>Edit</button>}
              </>
            )}
          </div>
          {actions && actions.some((a) => a.danger || /export|pause/i.test(a.label)) && (
            <div className="reqdrw-actions2">
              {actions.filter((a) => a.danger || /export|pause/i.test(a.label)).map((a) => (
                <button key={a.key} type="button" className={`btn btn-sm btn-ghost${a.danger ? ' reqdrw-danger' : ''}`} onClick={() => onPick(a.key)}>{a.label}</button>
              ))}
            </div>
          )}

          <div className="reqdrw-grid">
          <div className="reqdrw-col">
          <div className="req360-sec">
            <h4>Job</h4>
            {kv('Type', r.internal ? 'Internal' : 'Client')}
            {!r.internal && kv('Client', (sum ? sum.clientLink : r.clientLink) && r.clientId
              ? <Link to={`/clients/${r.clientId}`}>{r.client?.name}</Link>
              : r.client?.name)}
            {kv('Department', [r.department, r.section].filter(Boolean).join(' · '))}
            {kv('Location', r.location)}
            {kv('Openings', `${nf(r.openings || 1)}${r.filled ? ` · ${nf(r.filled)} filled` : ''}${r.remaining !== undefined ? ` · ${nf(r.remaining)} left` : ''}`)}
            {kv('Days open', r.ageDays === null || r.ageDays === undefined ? null : nf(r.ageDays))}
            {sla && kv('Late?', <StatusChip tone={{ overdue: 'red', pending: 'amber', active: 'blue' }[sla.cls]} title={sla.title}>{sla.text}</StatusChip>)}
          </div>

          <div className="req360-sec">
            <h4>Team</h4>
            {team ? (
              <>
                {team.tl ? person(team.tl, 'Team lead') : kv('Team lead', null)}
                {team.recruiters.length ? team.recruiters.map((p) => person(p, p.primary ? 'Recruiter' : 'Co-recruiter')) : kv('Recruiter', r.workedBy ? `${r.workedBy}${r.workedByPosition ? ` · ${r.workedByPosition}` : ''}` : null)}
                {team.bde && kv('Client manager (BDE)', team.bde.name)}
              </>
            ) : <div className="small-muted">{sum ? '—' : 'Loading…'}</div>}
          </div>

          </div>
          <div className="reqdrw-col">
          <h4 className="reqdrw-h">People in process</h4>
          <PipelineSteps requirementId={r.id} pipeline={pipeline} compact />

          {/* Agreement, posting and people nearby are on the job page (Open job). */}
          <div className="req360-sec">
            <h4>Recent activity</h4>
            {kv('Last activity', r.lastActivity ? <span title={`${fmtWhen(r.lastActivity.at)}${r.lastActivity.what ? ` — ${r.lastActivity.what}` : ''}`}>{lastActivityText(r.lastActivity)}</span> : 'No activity yet')}
            {activity && activity.length > 0 && (
              <ul className="req360-feed">
                {activity.map((a) => (
                  <li key={a.id}>
                    <span className="when">{fmtShort(a.createdAt)}</span>
                    {a.by ? <b>{`${a.by} `}</b> : null}
                    {a.action}
                    {a.candidateName ? ` — ${a.candidateName}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

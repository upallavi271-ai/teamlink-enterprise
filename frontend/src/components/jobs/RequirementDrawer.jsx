import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import { requirementStatusLabel } from '../../atsVocab';
import StatusChip from '../ui/StatusChip.jsx';
import { useJobPortalUrl, jobPortalJobUrl } from '../../pages/JobPortalRedirect.jsx';
import {
  PriorityChip, PipelineSteps, candidatesLink, ageText, slaInfo, lastActivityText, fmtWhen, fmtShort, nf, reqStatusTone,
} from './reqFormat.jsx';
import { DrawerReach } from './RequirementReach.jsx';

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
// ---------------------------------------------------------------------------
export default function RequirementDrawer({ row: r, onClose, onAssign }) {
  const navigate = useNavigate();
  const portalUrl = useJobPortalUrl();
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
  const ag = (sum && sum.agreement) || null;
  const portal = (sum && sum.portal) || null;
  const person = (p, role) => (
    <div className="req360-person" key={`${role}-${p.id || p.name}`}>
      <span>
        <span className="small-muted">{`${role} · `}</span>
        {p.name || '—'}
      </span>
      <span className="seat">{p.seat || 'no seat'}</span>
    </div>
  );
  return (
    <div className="reqdrw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="reqdrw" role="dialog" aria-label={`Requirement ${r.reqCode || r.title}`}>
        <div className="reqdrw-head">
          <div style={{ minWidth: 0 }}>
            <div className="reqdrw-code">{r.reqCode || r.id.slice(0, 8)}</div>
            <div className="reqdrw-title">{r.title}</div>
            <div className="reqdrw-sub">
              <StatusChip status={requirementStatusLabel(r.status)} tone={reqStatusTone(r.status)} />
              <PriorityChip value={r.priority} />
              {r.agreementPending && <StatusChip status="Agreement Pending" />}
            </div>
          </div>
          <button type="button" className="reqdrw-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="reqdrw-body">
          <div className="req360-sec">
            <h4>Requirement</h4>
            {kv('Type', r.internal ? 'INTERNAL · Organization: TeamLink' : 'CLIENT')}
            {!r.internal && kv('Client', (sum ? sum.clientLink : r.clientLink) && r.clientId
              ? <Link to={`/clients/${r.clientId}`}>{r.client?.name}</Link>
              : r.client?.name)}
            {kv('Position', r.title)}
            {kv('Department', [r.department, r.section].filter(Boolean).join(' · '))}
            {kv('Location', r.location)}
            {kv('Openings', `${nf(r.openings || 1)}${r.filled ? ` · ${nf(r.filled)} filled` : ''}${r.remaining !== undefined ? ` · ${nf(r.remaining)} remaining` : ''}`)}
          </div>

          <div className="req360-sec">
            <h4>Assigned Team</h4>
            {team ? (
              <>
                {team.tl ? person(team.tl, 'TL') : kv('TL', null)}
                {team.recruiters.length ? team.recruiters.map((p) => person(p, p.primary ? 'Recruiter' : 'Co-recruiter')) : kv('Recruiter', r.workedBy ? `${r.workedBy}${r.workedByPosition ? ` · ${r.workedByPosition}` : ''}` : null)}
                {team.bde && kv('BDE', team.bde.name)}
              </>
            ) : <div className="small-muted">{sum ? '—' : 'Loading…'}</div>}
          </div>

          <h4 className="small-muted" style={{ fontSize: 12, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '.03em' }}>Candidates pipeline</h4>
          <PipelineSteps requirementId={r.id} pipeline={pipeline} compact />

          {/* Role spec §7 — Fee / Agreement terms only for BDE, Accounts, Admin
              and Management; a TL / Recruiter is told only whether the gate
              holds the requirement (the server sends nothing more). */}
          <div className="req360-sec">
            <h4>{ag && ag.label ? 'Agreement' : 'Agreement gate'}</h4>
            {!ag ? <div className="small-muted">Loading…</div> : ag.internal ? <div className="small-muted">Internal hiring — no client agreement.</div> : (
              <>
                {ag.label && kv('Status', <StatusChip status={ag.label} tone={ag.active ? 'green' : 'amber'} />)}
                {kv('Requirement', ag.held ? 'Held at Agreement Check' : ag.active ? 'May go live' : 'Cannot go live until Active')}
                {sum && sum.commercial && kv('Fee %', sum.commercial.feePercent != null ? `${sum.commercial.feePercent}%` : null)}
                {sum && sum.commercial && kv('Guarantee', sum.commercial.guaranteeDays ? (/^\d+$/.test(String(sum.commercial.guaranteeDays).trim()) ? `${sum.commercial.guaranteeDays} days` : sum.commercial.guaranteeDays) : null)}
                {sum && sum.commercial && kv('Payment terms', sum.commercial.paymentTerms)}
                {ag.canOpen && r.clientId && <Link to={`/clients/${r.clientId}?tab=agreements`} style={{ fontSize: 12 }}>Open the client&apos;s agreement →</Link>}
              </>
            )}
          </div>

          <div className="req360-sec">
            <h4>Job Portal</h4>
            {!portal ? <div className="small-muted">Loading…</div> : (
              <>
                {kv('Published', portal.published
                  ? <StatusChip tone="green">{`Published${portal.publishedAt ? ` · ${fmtShort(portal.publishedAt)}` : ''}`}</StatusChip>
                  : <StatusChip tone="grey">Not published</StatusChip>)}
                {kv('Applications', portal.applications
                  ? <Link to={candidatesLink(r.id)}>{nf(portal.applications)}</Link>
                  : '0')}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, marginTop: 2 }}>
                  {portal.published && <a href={jobPortalJobUrl(portalUrl, r.id)} target="_blank" rel="noreferrer">View on Job Portal ↗</a>}
                  {portal.workspace && <Link to="/candidates?view=job-portal">Job Portal Candidates →</Link>}
                </div>
              </>
            )}
          </div>

          {/* User notes #7 / #6 — where it is posted, who is nearby. */}
          <DrawerReach requirementId={r.id} />

          <div className="req360-sec">
            <h4>Activity</h4>
            {kv('Aging', ageText(r.ageDays))}
            {kv('SLA', sla ? <StatusChip tone={{ overdue: 'red', pending: 'amber', active: 'green' }[sla.cls]} title={sla.title}>{sla.text}</StatusChip> : null)}
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

          <div className="reqdrw-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/requirements/${r.id}`)}>Open Requirement 360</button>
            {r.mayAssign && <button type="button" className="btn" onClick={() => onAssign(r)}>Assign Recruiter</button>}
            {r.mayEdit && <button type="button" className="btn" onClick={() => navigate(`/requirements/${r.id}?action=edit`)}>Edit</button>}
          </div>
        </div>
      </aside>
    </div>
  );
}

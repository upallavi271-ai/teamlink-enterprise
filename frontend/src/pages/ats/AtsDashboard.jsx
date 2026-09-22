import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { workRoleLabel } from '../../permissions';
import DoThisNow from '../../components/DoThisNow.jsx';

// ---------------------------------------------------------------------------
// The ATS home.
//
// Not a KPI wall — the working shape the product is built around:
//
//   login -> only my work -> pending action -> one action -> next stage
//
//   1. My Pending Actions — one compact row per queue waiting on this person,
//      each row a link into that exact list.
//   2. The action queue   — one row per item, and EVERY row carries the single
//      next action that advances it, plus when it is due.
//   3. My Work            — flat rows with counts, chosen by the viewer's ATS
//      role (recruiter / TL / BDE / STL / client / admin).
//
// All of it comes from GET /api/dashboard/ats, which is scoped by
// backend/src/utils/scope.js — a recruiter's own work, a TL's team, a BDE's
// clients, a client's own company. The page never filters for itself.
// ---------------------------------------------------------------------------

const STAGE_BADGE = {
  NEW: 'new', AI_INTERVIEW_REQUIRED: 'new', AI_INTERVIEW_SCHEDULED: 'interview',
  AI_INTERVIEW_COMPLETED: 'interview', RECRUITER_REVIEW: 'review', RECRUITER_APPROVED: 'approved',
  WITH_BDE: 'review', BDE_APPROVED: 'approved', SHARED_WITH_CLIENT: 'review', CLIENT_REVIEW: 'review',
  CLIENT_SHORTLISTED: 'shortlist', INTERVIEW_SCHEDULED: 'interview', INTERVIEW_COMPLETED: 'interview',
  SELECTED: 'selected', OFFER: 'offer', OFFER_ACCEPTED: 'offer', JOINED: 'joined', HIRED: 'joined',
  REJECTED: 'rejected', HOLD: 'hold',
};

function Due({ row }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!row.due) return <span className="cell-muted">—</span>;
  if (row.overdue) return <span className="status overdue">Overdue</span>;
  if (row.due === today) return <span className="status pending">Today</span>;
  return <span className="cell-muted">{row.due}</span>;
}

// One compact row: label on the left, count on the right, whole row clickable.
function CountRow({ label, value, to, sub }) {
  const navigate = useNavigate();
  return (
    <div className="assign-row" data-goto="1" onClick={() => navigate(to)}>
      <span>
        {label}
        {sub && <span className="small-muted" style={{ marginLeft: 8 }}>{sub}</span>}
      </span>
      <span className={'row-count' + (value ? '' : ' row-zero')}>{value}</span>
    </div>
  );
}

function scopeLine(data, user) {
  if (!data) return '';
  if (data.scope.client) return `${data.scope.client} — your company only`;
  if (data.scope.global) return 'All departments';
  const d = (data.scope.departments || []).join(', ');
  return d ? `${d} — your scope` : workRoleLabel(user);
}

export default function AtsDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard/ats')
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your dashboard'));
  }, []);

  if (error) return <div className="notice red">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;

  const name = String(user?.name || '').replace(/\(.*\)/, '').trim();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>ATS Dashboard</h1>
          <div className="page-sub">
            {name ? `${name} · ` : ''}{workRoleLabel(user)} · {scopeLine(data, user)}
          </div>
        </div>
      </div>

      {/* §27 — before everything else, and it draws nothing when there is
          nothing late. */}
      <DoThisNow />

      {/* 1. My Pending Actions ------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>My Pending Actions</h3>
          <span className="pending-count">{data.pendingTotal}</span>
        </div>
        {data.pendingActions.length === 0 && (
          <div className="empty-mini">No queues are assigned to your role.</div>
        )}
        {data.pendingActions.map((p) => (
          <CountRow key={p.id} label={p.label} value={p.count} to={p.to} sub={p.count ? p.action : null} />
        ))}
      </div>

      {/* 2. The action queue — every row carries its next action ---------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>What needs an action</h3>
          <span className="small-muted">{data.queue.length} item{data.queue.length === 1 ? '' : 's'}</span>
        </div>
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Candidate</th><th>Requirement</th><th>Current Stage</th><th>Next Action</th><th>Due</th>
              </tr>
            </thead>
            <tbody>
              {data.queue.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(r.to)}>
                  <td>{r.candidate}</td>
                  <td>
                    {r.requirement}
                    {r.client && <div className="small-muted">{r.client}</div>}
                  </td>
                  <td><span className={`status ${STAGE_BADGE[r.stage] || 'new'}`}>{r.stageLabel}</span></td>
                  <td><span className="link-btn">{r.nextAction} →</span></td>
                  <td><Due row={r} /></td>
                </tr>
              ))}
              {data.queue.length === 0 && (
                <tr>
                  <td colSpan="5" className="small-muted" style={{ padding: 18 }}>
                    Nothing is waiting on you — every item in your scope has moved on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. My Work — flat rows, chosen by the viewer's ATS role ---------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>{data.myWorkTitle}</h3>
          <span className="small-muted">{workRoleLabel(user)}</span>
        </div>
        {data.myWork.map((w) => <CountRow key={w.label} label={w.label} value={w.value} to={w.to} />)}
      </div>
    </div>
  );
}

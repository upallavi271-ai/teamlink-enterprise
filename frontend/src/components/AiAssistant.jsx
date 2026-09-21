import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import { groupsForUser, flattenGroups } from '../nav';

// ---------------------------------------------------------------------------
// The floating assistant (bottom right).
//
// It is role-aware in the only way that is honest here: every suggestion it
// offers is computed from what the signed-in user can actually see and do.
//
//   * "Do next" comes from GET /api/dashboard/ats — the same scoped, permission
//     -guarded queue the dashboard renders, so a recruiter is offered their own
//     candidates and a client only their own company's decisions.
//   * "Your queues" is that endpoint's pending-action breakdown.
//   * "Go to" is drawn from the permission-filtered nav tree (../nav.js), so it
//     can never suggest a screen the API would refuse.
//
// It does NOT talk to a language model. There is no LLM configured in this
// app and inventing an integration would be worse than not having one, so the
// panel says so rather than pretending to answer free text.
// ---------------------------------------------------------------------------

function DueChip({ row }) {
  if (!row.due) return <span className="small-muted">—</span>;
  const today = new Date().toISOString().slice(0, 10);
  if (row.overdue) return <span className="status overdue">Overdue</span>;
  if (row.due === today) return <span className="status pending">Today</span>;
  return <span className="small-muted">{row.due}</span>;
}

export default function AiAssistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  const hasAts = !!(user && user.products && user.products.ats && user.atsRole);

  // Refreshed when the panel opens and whenever the user moves to another
  // screen, so the counts never go stale behind an action they just took.
  useEffect(() => {
    if (!open || !hasAts) return;
    api.get('/dashboard/ats')
      .then((res) => { setData(res.data); setFailed(false); })
      .catch(() => setFailed(true));
  }, [open, hasAts, pathname]);

  // Where this user is allowed to go, straight out of the nav tree.
  const destinations = useMemo(() => {
    const leaves = flattenGroups(groupsForUser(user)).filter((l) => l.section === 'ats');
    return leaves.slice(0, 6);
  }, [user]);

  const go = (to) => { setOpen(false); navigate(to); };

  const pending = (data && data.pendingActions) || [];
  const waiting = pending.filter((p) => p.count > 0);
  const nextUp = ((data && data.queue) || []).slice(0, 3);

  return (
    <>
      <button
        className={'ai-fab' + (open ? ' ai-fab-open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="AI Assistant"
      >
        <span className="ai-fab-mark">AI</span>
        <span className="ai-fab-label">Assistant</span>
        {hasAts && data && data.pendingTotal > 0 && <span className="ai-fab-dot">{data.pendingTotal}</span>}
      </button>

      {open && (
        <aside className="ai-panel" role="dialog" aria-label="AI Assistant">
          <div className="ai-head">
            <div>
              <div className="ai-title">AI Assistant</div>
              <div className="small-muted">{workRoleLabel(user)}{data && data.scope && data.scope.client ? ` · ${data.scope.client}` : ''}</div>
            </div>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="ai-body">
            {!hasAts && (
              <div className="small-muted" style={{ marginBottom: 10 }}>
                Your login has no ATS working role, so there is no recruitment queue to summarise.
              </div>
            )}
            {hasAts && failed && (
              <div className="small-muted" style={{ marginBottom: 10 }}>
                Could not load your queue just now.
              </div>
            )}
            {hasAts && !data && !failed && <div className="small-muted">Reading your queue…</div>}

            {hasAts && data && (
              <>
                <div className="ai-sec">Do next</div>
                {nextUp.length === 0 && (
                  <div className="small-muted" style={{ marginBottom: 10 }}>
                    Nothing is waiting on you right now.
                  </div>
                )}
                {nextUp.map((r) => (
                  <button className="ai-sug" key={r.id} onClick={() => go(r.to)}>
                    <span className="ai-sug-main">{r.nextAction} — {r.candidate}</span>
                    <span className="ai-sug-sub">{r.requirement} · {r.stageLabel} · <DueChip row={r} /></span>
                  </button>
                ))}

                <div className="ai-sec">Your queues</div>
                {waiting.length === 0 && (
                  <div className="small-muted" style={{ marginBottom: 10 }}>All queues clear.</div>
                )}
                {waiting.map((p) => (
                  <button className="ai-sug" key={p.id} onClick={() => go(p.to)}>
                    <span className="ai-sug-main">{p.label}<span className="n">{p.count}</span></span>
                    <span className="ai-sug-sub">{p.action}</span>
                  </button>
                ))}
              </>
            )}

            <div className="ai-sec">Go to</div>
            {destinations.map((d) => (
              <button className="ai-sug ai-sug-slim" key={d.to} onClick={() => go(d.to)}>
                <span className="ai-sug-main">{d.parent ? `${d.parent.label} · ${d.label}` : d.label}</span>
              </button>
            ))}
            {destinations.length === 0 && (
              <div className="small-muted">No ATS screens are enabled for your role.</div>
            )}
          </div>

          <div className="ai-foot small-muted">
            Suggestions are computed from your live queues and your permissions — nothing here is a guess.
            Free-text questions would need an external language model, which this app is not connected to.
          </div>
        </aside>
      )}
    </>
  );
}

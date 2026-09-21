import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import { groupsForUser, flattenGroups } from '../nav';

// ---------------------------------------------------------------------------
// The assistant panel (docked to the right; a bottom sheet on a phone).
//
// TWO HALVES, AND THEY ARE DIFFERENT THINGS.
//
//   "Do next" — computed, not generated. Every suggestion comes from
//   GET /api/dashboard/ats, the same scoped, permission-guarded queue the
//   dashboard renders, and "Go to" is drawn from the permission-filtered nav
//   tree (../nav.js). This half works with no model configured and is not a
//   guess. It is unchanged from before the agent existed.
//
//   "Ask" — a real language model, when Administration → Integrations holds an
//   Anthropic API key. The browser never sees that key: it POSTs the question
//   to /api/ai/ask and the server calls the model. The agent answers only from
//   this app's data, and every lookup it makes runs through the SAME
//   permission engine and scope helpers a route uses, so it cannot show this
//   user anything the API would refuse them.
//
// With no key, /api/ai/status says so and the Ask tab reports it plainly
// instead of pretending — exactly as the whole panel used to.
//
// PLACEMENT: the panel docks beside the page rather than over it. Opening it
// puts `ai-docked` on <body>, which reserves the width in the content column
// (see styles.css), so no control is ever hidden underneath. Below 1024px it
// becomes a bottom sheet with a backdrop, because there is no width to spare.
// ---------------------------------------------------------------------------

function DueChip({ row }) {
  if (!row.due) return <span className="small-muted">—</span>;
  const today = new Date().toISOString().slice(0, 10);
  if (row.overdue) return <span className="status overdue">Overdue</span>;
  if (row.due === today) return <span className="status pending">Today</span>;
  return <span className="small-muted">{row.due}</span>;
}

// Offered only where the login could actually answer them, so a candidate is
// never shown a question about invoices.
const SUGGESTIONS = [
  { text: 'What is waiting on me right now?', needs: 'ats' },
  { text: 'Which of my requirements has the fewest candidates?', needs: 'ats' },
  { text: 'Draft a job description for my newest open role.', needs: 'ats' },
  { text: 'How much leave do I have left?', needs: 'hrms' },
  { text: 'What tasks are overdue on my plate?', needs: 'hrms' },
  { text: 'How much is outstanding, and how much of it is overdue?', needs: 'accounts' },
];

// ---------------------------------------------------------------------------
// A proposed action. NOTHING HAS HAPPENED YET when this renders: the agent
// prepared a change, the server is holding a single-use token for it, and the
// change happens only when this button is pressed — at which point the server
// re-checks the permission and the scope before writing anything.
// ---------------------------------------------------------------------------
function ActionCard({ card, onConfirm, onDismiss }) {
  const entries = Object.entries(card.details || {}).filter(([, v]) => v !== null && v !== '');
  return (
    <div className={`ai-action${card.state ? ` ai-action-${card.state}` : ''}`}>
      <div className="ai-action-head">
        {card.state === 'done' ? 'Done' : card.state === 'failed' ? 'Not done' : 'Confirm this change'}
      </div>
      <div className="ai-action-summary">{card.summary}</div>
      {entries.length > 0 && (
        <dl className="ai-action-details">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt>{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.error && <div className="ai-action-error">{card.error}</div>}
      {!card.state && (
        <div className="ai-action-buttons">
          <button className="btn btn-primary btn-sm" type="button" onClick={() => onConfirm(card)} disabled={card.busy}>
            {card.busy ? 'Working…' : 'Confirm'}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onDismiss(card)} disabled={card.busy}>
            Discard
          </button>
        </div>
      )}
      {!card.state && (
        <div className="ai-action-note small-muted">
          Nothing has changed yet. Your permissions are checked again when you confirm.
        </div>
      )}
    </div>
  );
}

export default function AiAssistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('do');
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  // --- the model half ---
  const [ai, setAi] = useState(null); // { configured, reason, model }
  const [turns, setTurns] = useState([]); // [{ role, content, tools?, error? }]
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const streamEnd = useRef(null);

  const hasAts = !!(user && user.products && user.products.ats && user.atsRole);

  // The starter questions this login could actually get an answer to.
  const suggestions = useMemo(() => {
    const products = (user && user.products) || {};
    return SUGGESTIONS.filter((s) => (s.needs === 'ats' ? hasAts : !!products[s.needs]));
  }, [user, hasAts]);

  // Refreshed when the panel opens and whenever the user moves to another
  // screen, so the counts never go stale behind an action they just took.
  useEffect(() => {
    if (!open || !hasAts) return;
    api.get('/dashboard/ats')
      .then((res) => { setData(res.data); setFailed(false); })
      .catch(() => setFailed(true));
  }, [open, hasAts, pathname]);

  // Is a model configured? Asked once per open, never cached across logins.
  useEffect(() => {
    if (!open) return;
    api.get('/ai/status')
      .then((res) => setAi(res.data))
      .catch(() => setAi({ configured: false, reason: 'The assistant endpoint could not be reached.' }));
  }, [open]);

  // Reserve the dock's width in the page rather than covering it.
  useEffect(() => {
    document.body.classList.toggle('ai-docked', open);
    return () => document.body.classList.remove('ai-docked');
  }, [open]);

  useEffect(() => {
    if (streamEnd.current) streamEnd.current.scrollIntoView({ block: 'end' });
  }, [turns, busy]);

  // Where this user is allowed to go, straight out of the nav tree.
  const destinations = useMemo(() => {
    const leaves = flattenGroups(groupsForUser(user));
    // ATS first, because that is where the work is — but a login with no ATS
    // (an accountant, an employee) gets its own screens rather than nothing.
    const ats = leaves.filter((l) => l.section === 'ats');
    return (ats.length ? ats : leaves).slice(0, 6);
  }, [user]);

  const go = (to) => { setOpen(false); navigate(to); };

  const pending = (data && data.pendingActions) || [];
  const waiting = pending.filter((p) => p.count > 0);
  const nextUp = ((data && data.queue) || []).slice(0, 3);

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    setQuestion('');
    // Only the plain text turns travel back up; the server caps and trims them
    // again on its side, so this is a convenience, not the limit.
    const history = turns
      .filter((t) => !t.error && t.content)
      .map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: 'user', content: q }]);
    setBusy(true);
    try {
      const res = await api.post('/ai/ask', { question: q, history });
      if (res.data.configured === false) {
        setAi({ configured: false, reason: res.data.reason });
        setTurns((t) => [...t, { role: 'assistant', error: true, content: res.data.reason }]);
      } else {
        setTurns((t) => [...t, {
          role: 'assistant',
          content: res.data.answer,
          tools: res.data.toolsUsed || [],
          truncated: res.data.truncated,
          // Proposals, not changes. Each one renders as a confirm card and is
          // dead until the user presses Confirm.
          actions: (res.data.pendingActions || []).map((a) => ({ ...a })),
        }]);
      }
    } catch (err) {
      setTurns((t) => [...t, {
        role: 'assistant',
        error: true,
        content: err.response?.data?.error || 'The assistant could not answer just now.',
      }]);
    } finally { setBusy(false); }
  }

  // Rewrites one action card in place, wherever it sits in the transcript.
  function patchAction(token, patch) {
    setTurns((list) => list.map((t) => (t.actions
      ? { ...t, actions: t.actions.map((a) => (a.token === token ? { ...a, ...patch } : a)) }
      : t)));
  }

  // THE ONLY THING THAT PERFORMS A CHANGE. The token is single-use; the server
  // re-checks this user's permission and scope before it writes, and records
  // the confirmation in the audit log.
  async function confirmAction(card) {
    patchAction(card.token, { busy: true, error: null });
    try {
      const res = await api.post('/ai/act', { token: card.token });
      patchAction(card.token, { busy: false, state: 'done', summary: res.data.summary || card.summary });
    } catch (err) {
      patchAction(card.token, {
        busy: false,
        state: 'failed',
        error: err.response?.data?.error || 'That change could not be made.',
      });
    }
  }

  function dismissAction(card) {
    patchAction(card.token, { state: 'failed', error: 'Discarded — nothing was changed.' });
  }

  return (
    <>
      {!open && (
        <button
          className="ai-fab"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          title="AI Assistant"
        >
          <span className="ai-fab-mark">AI</span>
          <span className="ai-fab-label">Assistant</span>
          {hasAts && data && data.pendingTotal > 0 && <span className="ai-fab-dot">{data.pendingTotal}</span>}
        </button>
      )}

      {open && <div className="ai-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      {open && (
        <aside className="ai-panel" role="dialog" aria-label="AI Assistant">
          <div className="ai-head">
            <div>
              <div className="ai-title">AI Assistant</div>
              <div className="small-muted">{workRoleLabel(user)}{data && data.scope && data.scope.client ? ` · ${data.scope.client}` : ''}</div>
            </div>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="ai-tabs">
            <button className={`ai-tab${tab === 'do' ? ' active' : ''}`} onClick={() => setTab('do')}>
              Do next{hasAts && data && data.pendingTotal > 0 ? ` (${data.pendingTotal})` : ''}
            </button>
            <button className={`ai-tab${tab === 'ask' ? ' active' : ''}`} onClick={() => setTab('ask')}>
              Ask
              {ai && !ai.configured && <span className="ai-tab-off" title="No model configured">off</span>}
            </button>
          </div>

          {tab === 'do' && (
            <>
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
                  <div className="small-muted">No screens are enabled for your role.</div>
                )}
              </div>

              <div className="ai-foot small-muted">
                Suggestions are computed from your live queues and your permissions — nothing here is a guess.
              </div>
            </>
          )}

          {tab === 'ask' && (
            <>
              <div className="ai-body">
                {!ai && <div className="small-muted">Checking whether a model is configured…</div>}

                {ai && !ai.configured && (
                  <div className="ai-note">
                    <b>No language model is configured.</b>
                    <div className="small-muted" style={{ marginTop: 4 }}>{ai.reason}</div>
                    <div className="small-muted" style={{ marginTop: 6 }}>
                      An administrator adds an Anthropic API key in Administration → Integrations → AI Assistant.
                      The key stays on the server. Everything else in this panel keeps working without one.
                    </div>
                  </div>
                )}

                {ai && ai.configured && turns.length === 0 && (
                  <>
                    <div className="ai-note">
                      Ask about your requirements, candidates and queues, your own leave, attendance, payslips
                      and tasks, and — if your login has them — invoices and receivables. Answers come from this
                      app&rsquo;s data, read with <em>your</em> permissions: the assistant cannot see anything the
                      screens would refuse you.
                      {ai.actionsEnabled && ai.actions && ai.actions.length > 0
                        ? ' It can also propose a change, which you confirm before anything happens.'
                        : ' It cannot change anything.'}
                    </div>
                    <div className="ai-sec">Try</div>
                    {suggestions.map((s) => (
                      <button className="ai-sug ai-sug-slim" key={s.text} onClick={() => ask(s.text)}>
                        <span className="ai-sug-main">{s.text}</span>
                      </button>
                    ))}
                  </>
                )}

                {turns.map((t, i) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    className={`ai-turn ai-turn-${t.role}${t.error ? ' ai-turn-error' : ''}`}
                  >
                    {t.content}
                    {t.truncated && <div className="small-muted">(answer cut off at the token limit)</div>}
                    {t.role === 'assistant' && t.actions && t.actions.map((a) => (
                      <ActionCard key={a.token} card={a} onConfirm={confirmAction} onDismiss={dismissAction} />
                    ))}
                    {t.role === 'assistant' && t.tools && t.tools.length > 0 && (
                      <div className="ai-turn-tools small-muted">
                        {t.tools.map((x) => `${x.name}${x.denied ? ' (refused)' : ''}${x.proposed ? ' (proposed)' : ''}`).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
                {busy && <div className="ai-turn ai-turn-assistant small-muted">Looking it up…</div>}
                <div ref={streamEnd} />
              </div>

              {ai && ai.configured && (
                <form
                  className="ai-ask"
                  onSubmit={(e) => { e.preventDefault(); ask(question); }}
                >
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask about your requirements, candidates or queue"
                    disabled={busy}
                    maxLength={2000}
                  />
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !question.trim()}>
                    {busy ? '…' : 'Ask'}
                  </button>
                </form>
              )}

              <div className="ai-foot small-muted">
                {ai && ai.configured
                  ? (
                    <>
                      Answered by {ai.model} from this app&rsquo;s own data, through your permissions.
                      {ai.actionsEnabled && ai.actions && ai.actions.length > 0
                        ? <> It can propose a change, but nothing happens until you press Confirm.</>
                        : <> Read-only — it cannot move a stage or send a message.</>}
                    </>
                  )
                  : <>Free-text questions need a language model, which this app is not connected to yet.</>}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

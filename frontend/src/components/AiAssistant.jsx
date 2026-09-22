import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel, canRaiseRequirement } from '../permissions';
import { groupsForUser, flattenGroups } from '../nav';

// ---------------------------------------------------------------------------
// ONE floating AI button (bottom right), ONE panel, TWO modes inside it (§17).
//
//   AI ASSISTANT — conversational. "What are my pending actions?", "Show
//   today's interviews", "Explain this candidate", "Show overdue follow-ups",
//   "How many requirements are open?" It answers; it never changes anything.
//   Underneath the conversation sits the rule-based half that needs no model
//   at all: "Do next" and "Your queues" come from GET /api/dashboard/ats —
//   the same scoped, permission-guarded queue the ATS dashboard renders — and
//   "Go to" is drawn from the permission-filtered nav tree (../nav.js).
//
//   AI AGENT — action-oriented. Draft a requirement, prepare a shortlist,
//   schedule an interview, generate a follow-up reminder, prepare a report,
//   find overdue approvals.
//
// NOTHING THE AGENT DOES HAPPENS WITHOUT A CONFIRM. The server's write tools
// PROPOSE: each proposal comes back as a one-line question — "Do you want me
// to schedule this interview?" — with Confirm and Cancel, holding a single-use
// token. Only pressing Confirm calls POST /api/ai/act, which re-runs this
// user's permission and scope checks before it writes anything. Cancel throws
// the token away. The panel cannot perform a change by any other path.
//
// NOT CONFIGURED IS AN HONEST STATE, NOT AN ERROR. With no Anthropic key the
// Assistant still shows "Do next", the queues and "Go to" — all computed — and
// the Agent says plainly that it needs a key, listing what it would be able to
// do, rather than pretending or hiding.
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

// --- AI ASSISTANT: the questions (§17) -------------------------------------
// Offered only where the login could actually get an answer, so a candidate is
// never shown a question about invoices. `needs` is the product; `where` is an
// optional test against the screen the user is standing on.
const QUESTIONS = [
  { text: 'What are my pending actions?' },
  { text: "Show today's interviews", needs: 'ats' },
  { text: 'Explain this candidate', needs: 'ats', where: (p) => /^\/candidates\/[^/]+/.test(p) },
  { text: 'Show overdue follow-ups', needs: 'ats' },
  { text: 'How many requirements are open?', needs: 'ats' },
  { text: 'How much leave do I have left?', needs: 'hrms' },
  { text: 'How much is outstanding, and how much of it is overdue?', needs: 'accounts' },
];

// --- AI AGENT: the things it can be asked to do (§17) ----------------------
//
// `writes` names the server-side write tool the job ends in, or null when the
// job only prepares something for the user (a draft, a shortlist, a report).
// The three write tools are the ones utils/aiAgentActions.js defines — this
// list does not invent a capability the server does not have, which is why
// "Draft a requirement" says in its own words that creating it stays the
// user's click.
const AGENT_JOBS = [
  {
    id: 'draft-requirement',
    label: 'Draft a new requirement',
    sub: 'Writes the role, skills and JD wording — you create it',
    needs: 'ats',
    writes: null,
    allowed: (user) => canRaiseRequirement(user),
    prompt: 'Draft a new requirement for me. Ask me for the client, the job title, '
      + 'the number of positions, the location and the budget if you need them, then write the '
      + 'role summary, the must-have skills and a short job description I can paste in.',
  },
  {
    id: 'shortlist',
    label: 'Prepare a candidate shortlist',
    sub: 'Strongest candidates on one of my open requirements, with reasons',
    needs: 'ats',
    writes: null,
    prompt: 'Prepare a shortlist for my most urgent open requirement: the strongest candidates '
      + 'already in the pipeline, in order, with one line each on why they are on the list.',
  },
  {
    id: 'schedule-interview',
    label: 'Schedule an interview',
    sub: 'Proposes the slot — nothing is booked until you confirm',
    needs: 'ats',
    writes: 'schedule_interview',
    prompt: 'Schedule an interview. Ask me which candidate and what date and time if you need '
      + 'them, then propose it for my confirmation.',
  },
  {
    id: 'follow-up',
    label: 'Generate a follow-up reminder',
    sub: 'Proposes a task on the candidate that has waited longest',
    needs: 'ats',
    writes: 'create_task',
    prompt: 'Generate a follow-up reminder for whichever candidate has been waiting on me '
      + 'longest: say who it is and why, then propose the reminder for my confirmation.',
  },
  {
    id: 'report',
    label: 'Prepare a report',
    sub: 'A short written summary of where things stand',
    writes: null,
    prompt: 'Prepare a short report on where my work stands this month — what is open, what '
      + 'moved, what is stuck and what needs a decision. Keep it to a few lines per section.',
  },
  {
    id: 'overdue-approvals',
    label: 'Find overdue approvals',
    sub: 'What is past its SLA in my scope, oldest first',
    needs: 'ats',
    writes: null,
    prompt: 'Find the approvals and decisions in my scope that are past their SLA, oldest '
      + 'first, and tell me who each one is waiting on.',
  },
];

// ---------------------------------------------------------------------------
// A PROPOSED action. NOTHING HAS HAPPENED YET when this renders: the agent
// prepared a change, the server is holding a single-use token for it, and the
// change happens only when Confirm is pressed — at which point the server
// re-checks this user's permission and scope before writing anything. Cancel
// drops the token and the proposal dies with it.
// ---------------------------------------------------------------------------

// "Schedule an interview for Sharath Kamath at 2026-09-24 10:00 (UTC)."
//   -> "Do you want me to schedule an interview for Sharath Kamath at …?"
function askingFor(summary) {
  const s = String(summary || '').trim().replace(/[.\s]+$/, '');
  if (!s) return 'Do you want me to make this change?';
  return `Do you want me to ${s.charAt(0).toLowerCase()}${s.slice(1)}?`;
}

function ActionCard({ card, onConfirm, onCancel }) {
  const entries = Object.entries(card.details || {}).filter(([, v]) => v !== null && v !== '');
  const settled = !!card.state;
  return (
    <div className={`ai-action${card.state ? ` ai-action-${card.state}` : ''}`}>
      <div className="ai-action-head">
        {card.state === 'done' ? 'Done' : card.state === 'failed' ? 'Not done' : 'Needs your confirmation'}
      </div>
      <div className="ai-action-summary">
        {settled ? card.summary : askingFor(card.summary)}
      </div>
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
      {!settled && (
        <>
          <div className="ai-action-buttons">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onConfirm(card)} disabled={card.busy}>
              {card.busy ? 'Working…' : 'Confirm'}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => onCancel(card)} disabled={card.busy}>
              Cancel
            </button>
          </div>
          <div className="ai-action-note small-muted">
            Nothing has changed yet. Your permissions are checked again when you confirm.
          </div>
        </>
      )}
    </div>
  );
}

// One conversation — the Assistant's or the Agent's. They are deliberately
// separate transcripts: a question and an instruction are different things and
// reading back through a mix of the two is how a user loses track of what has
// been proposed.
function Transcript({ turns, busy, onConfirm, onCancel, endRef }) {
  return (
    <>
      {turns.map((t, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={`ai-turn ai-turn-${t.role}${t.error ? ' ai-turn-error' : ''}`}
        >
          {t.content}
          {t.truncated && <div className="small-muted">(answer cut off at the token limit)</div>}
          {t.role === 'assistant' && t.actions && t.actions.map((a) => (
            <ActionCard key={a.token} card={a} onConfirm={onConfirm} onCancel={onCancel} />
          ))}
          {t.role === 'assistant' && t.tools && t.tools.length > 0 && (
            <div className="ai-turn-tools small-muted">
              {t.tools.map((x) => `${x.name}${x.denied ? ' (refused)' : ''}${x.proposed ? ' (proposed)' : ''}`).join(', ')}
            </div>
          )}
        </div>
      ))}
      {busy && <div className="ai-turn ai-turn-assistant small-muted">Working on it…</div>}
      <div ref={endRef} />
    </>
  );
}

export default function AiAssistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // 'assistant' — ask about the work. 'agent' — ask for the work to be done.
  const [mode, setMode] = useState('assistant');
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  // --- the model half --------------------------------------------------
  const [ai, setAi] = useState(null); // { configured, reason, model, actionsEnabled, actions }
  const [threads, setThreads] = useState({ assistant: [], agent: [] });
  const [drafts, setDrafts] = useState({ assistant: '', agent: '' });
  const [busy, setBusy] = useState(false);
  const streamEnd = useRef(null);

  const hasAts = !!(user && user.products && user.products.ats && user.atsRole);
  const turns = threads[mode];

  const questions = useMemo(() => {
    const products = (user && user.products) || {};
    return QUESTIONS.filter((q) => (!q.needs || (q.needs === 'ats' ? hasAts : !!products[q.needs])))
      .filter((q) => !q.where || q.where(pathname));
  }, [user, hasAts, pathname]);

  // What this login could actually ask the agent for. A job that ends in a
  // write is offered only when the server says THIS user holds that write
  // tool — /api/ai/status answers that per user, not per licence.
  const jobs = useMemo(() => {
    const products = (user && user.products) || {};
    const held = (ai && ai.actions) || [];
    return AGENT_JOBS
      .filter((j) => (!j.needs || (j.needs === 'ats' ? hasAts : !!products[j.needs])))
      .filter((j) => !j.allowed || j.allowed(user))
      // Before /ai/status has answered — or with no model at all — the list is
      // shown in full and disabled, so the user can see what they are missing.
      .filter((j) => !j.writes || !ai || !ai.configured || !ai.actionsEnabled || held.includes(j.writes));
  }, [user, hasAts, ai]);

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
  }, [threads, busy, mode]);

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
  const actionsOn = !!(ai && ai.configured && ai.actionsEnabled && (ai.actions || []).length > 0);

  function addTurn(which, turn) {
    setThreads((t) => ({ ...t, [which]: [...t[which], turn] }));
  }

  async function send(which, text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    setDrafts((d) => ({ ...d, [which]: '' }));
    // Only the plain text turns travel back up; the server caps and trims them
    // again on its side, so this is a convenience, not the limit.
    const history = threads[which]
      .filter((t) => !t.error && t.content)
      .map((t) => ({ role: t.role, content: t.content }));
    addTurn(which, { role: 'user', content: q });
    setBusy(true);
    try {
      const res = await api.post('/ai/ask', { question: q, history });
      if (res.data.configured === false) {
        setAi({ configured: false, reason: res.data.reason });
        addTurn(which, { role: 'assistant', error: true, content: res.data.reason });
      } else {
        addTurn(which, {
          role: 'assistant',
          content: res.data.answer,
          tools: res.data.toolsUsed || [],
          truncated: res.data.truncated,
          // Proposals, not changes. Each one renders as a confirm card and is
          // dead until the user presses Confirm.
          actions: (res.data.pendingActions || []).map((a) => ({ ...a })),
        });
      }
    } catch (err) {
      addTurn(which, {
        role: 'assistant',
        error: true,
        content: err.response?.data?.error || 'The assistant could not answer just now.',
      });
    } finally { setBusy(false); }
  }

  // Rewrites one action card in place, wherever it sits in either transcript.
  function patchAction(token, patch) {
    setThreads((all) => {
      const fix = (list) => list.map((t) => (t.actions
        ? { ...t, actions: t.actions.map((a) => (a.token === token ? { ...a, ...patch } : a)) }
        : t));
      return { assistant: fix(all.assistant), agent: fix(all.agent) };
    });
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

  function cancelAction(card) {
    patchAction(card.token, { state: 'failed', error: 'Cancelled — nothing was changed.' });
  }

  const modeNote = mode === 'assistant'
    ? 'Ask about your work. The Assistant answers from this app’s data, read with your permissions — it never changes anything.'
    : 'Ask for something to be done. The Agent prepares the change and asks you to confirm it before anything happens.';

  return (
    <>
      {/* ONE floating button. It opens ONE panel; the two modes live inside. */}
      {!open && (
        <button
          className="ai-fab"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label="AI Assistant and Agent"
          title="AI Assistant and Agent"
        >
          <span className="ai-fab-mark">AI</span>
          {hasAts && data && data.pendingTotal > 0 && <span className="ai-fab-dot">{data.pendingTotal}</span>}
        </button>
      )}

      {open && <div className="ai-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      {open && (
        <aside className="ai-panel" role="dialog" aria-label="AI Assistant and Agent">
          <div className="ai-head">
            <div>
              <div className="ai-title">AI</div>
              <div className="small-muted">
                {workRoleLabel(user)}{data && data.scope && data.scope.client ? ` · ${data.scope.client}` : ''}
              </div>
            </div>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {/* The two modes, named, in one panel. */}
          <div className="ai-modes" role="tablist" aria-label="Mode">
            <button
              role="tab"
              aria-selected={mode === 'assistant'}
              className={`ai-mode${mode === 'assistant' ? ' active' : ''}`}
              onClick={() => setMode('assistant')}
            >
              AI Assistant
              {hasAts && data && data.pendingTotal > 0 ? <span className="n">{data.pendingTotal}</span> : null}
            </button>
            <button
              role="tab"
              aria-selected={mode === 'agent'}
              className={`ai-mode${mode === 'agent' ? ' active' : ''}`}
              onClick={() => setMode('agent')}
            >
              AI Agent
              {ai && !ai.configured && <span className="ai-tab-off" title="No model configured">off</span>}
            </button>
          </div>
          <div className="ai-mode-note small-muted">{modeNote}</div>

          {/* ------------------------------ AI ASSISTANT ----------------- */}
          {mode === 'assistant' && (
            <>
              <div className="ai-body">
                {turns.length > 0 && (
                  <Transcript
                    turns={turns}
                    busy={busy}
                    onConfirm={confirmAction}
                    onCancel={cancelAction}
                    endRef={streamEnd}
                  />
                )}

                {turns.length === 0 && ai && ai.configured && questions.length > 0 && (
                  <>
                    <div className="ai-sec">Ask</div>
                    {questions.map((q) => (
                      <button className="ai-sug ai-sug-slim" key={q.text} onClick={() => send('assistant', q.text)}>
                        <span className="ai-sug-main">{q.text}</span>
                      </button>
                    ))}
                  </>
                )}

                {turns.length === 0 && ai && !ai.configured && (
                  <div className="ai-note">
                    <b>No language model is configured, so free-text questions are off.</b>
                    <div className="small-muted" style={{ marginTop: 4 }}>{ai.reason}</div>
                    <div className="small-muted" style={{ marginTop: 6 }}>
                      Everything below is computed from your live queues and your permissions and keeps
                      working without a key.
                    </div>
                  </div>
                )}

                {turns.length === 0 && (
                  <>
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
                  </>
                )}
              </div>

              {ai && ai.configured && (
                <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); send('assistant', drafts.assistant); }}>
                  <input
                    value={drafts.assistant}
                    onChange={(e) => setDrafts((d) => ({ ...d, assistant: e.target.value }))}
                    placeholder="Ask about your requirements, candidates or queue"
                    disabled={busy}
                    maxLength={2000}
                  />
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !drafts.assistant.trim()}>
                    {busy ? '…' : 'Ask'}
                  </button>
                </form>
              )}

              <div className="ai-foot small-muted">
                {turns.length > 0 && (
                  <button
                    className="link-btn ai-foot-restart"
                    type="button"
                    onClick={() => setThreads((t) => ({ ...t, assistant: [] }))}
                  >
                    Start again
                  </button>
                )}
                {ai && ai.configured
                  ? <>Answered by {ai.model} from this app’s own data, through your permissions. The Assistant reads; it does not change anything.</>
                  : <>Suggestions are computed from your live queues and your permissions — nothing here is a guess.</>}
              </div>
            </>
          )}

          {/* ------------------------------ AI AGENT --------------------- */}
          {mode === 'agent' && (
            <>
              <div className="ai-body">
                {!ai && <div className="small-muted">Checking whether a model is configured…</div>}

                {ai && !ai.configured && (
                  <div className="ai-note">
                    <b>The Agent needs a language model, which this app is not connected to yet.</b>
                    <div className="small-muted" style={{ marginTop: 4 }}>{ai.reason}</div>
                    <div className="small-muted" style={{ marginTop: 6 }}>
                      An administrator adds an Anthropic API key in Administration → Integrations → AI
                      Assistant. The key stays on the server. The Assistant tab keeps working without one.
                    </div>
                  </div>
                )}

                {ai && ai.configured && !actionsOn && (
                  <div className="ai-note">
                    <b>The Agent can prepare work, but it cannot change anything.</b>
                    <div className="small-muted" style={{ marginTop: 4 }}>
                      Acting is switched off for this app in Administration → Integrations → AI Assistant.
                      Drafts, shortlists and reports still work; scheduling and reminders do not.
                    </div>
                  </div>
                )}

                {turns.length > 0 && (
                  <Transcript
                    turns={turns}
                    busy={busy}
                    onConfirm={confirmAction}
                    onCancel={cancelAction}
                    endRef={streamEnd}
                  />
                )}

                {turns.length === 0 && (
                  <>
                    <div className="ai-sec">Ask the agent to</div>
                    {jobs.map((j) => (
                      <button
                        className="ai-sug"
                        key={j.id}
                        disabled={!ai || !ai.configured || (!!j.writes && !actionsOn)}
                        onClick={() => send('agent', j.prompt)}
                      >
                        <span className="ai-sug-main">
                          {j.label}
                          {j.writes && <span className="ai-asks">asks first</span>}
                        </span>
                        <span className="ai-sug-sub">{j.sub}</span>
                      </button>
                    ))}
                    {jobs.length === 0 && (
                      <div className="small-muted">Your role has nothing for the agent to do.</div>
                    )}
                  </>
                )}
              </div>

              {ai && ai.configured && (
                <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); send('agent', drafts.agent); }}>
                  <input
                    value={drafts.agent}
                    onChange={(e) => setDrafts((d) => ({ ...d, agent: e.target.value }))}
                    placeholder="Tell the agent what to do"
                    disabled={busy}
                    maxLength={2000}
                  />
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !drafts.agent.trim()}>
                    {busy ? '…' : 'Run'}
                  </button>
                </form>
              )}

              <div className="ai-foot small-muted">
                {turns.length > 0 && (
                  <button
                    className="link-btn ai-foot-restart"
                    type="button"
                    onClick={() => setThreads((t) => ({ ...t, agent: [] }))}
                  >
                    Start again
                  </button>
                )}
                Every change is shown to you first — “Do you want me to…?” — and happens only when you
                press Confirm. Your permissions are checked again at that moment.
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

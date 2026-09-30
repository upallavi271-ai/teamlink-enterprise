import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import { groupsForUser, flattenGroups } from '../nav';
import {
  useVoiceInput, MicButton, VoiceBar, speak, stopSpeaking, canSpeak, readPref, writePref, VOICE_LANGS,
} from './AiVoice.jsx';
import './AiFab.css';
import './AiVoice.css';

// ---------------------------------------------------------------------------
// ONE floating AI button (bottom right), ONE panel, TWO tabs.
//
//   ASSISTANT — answers questions only; it never changes data. POST
//   /api/assistant/ask. The server builds every fact from the signed-in
//   session; this panel sends the question, a short plain-text history and
//   the page path (which only decides which facts go first). Underneath sits
//   the rule-based half that needs no model at all: "Do next" and "Your
//   queues" from GET /api/dashboard/ats, and "Go to" from the permission-
//   filtered nav tree.
//
//   AGENT — proposes a real HRMS or ATS action (apply leave, approve a
//   request, move a candidate, schedule an interview …). POST /api/agent/plan
//   returns either a question (clarify) or a proposal; a proposal renders as a
//   card, and NOTHING HAPPENS UNTIL CONFIRM, which calls /api/agent/execute.
//   The server re-checks everything there and replays the app's own route
//   with the user's own token, so the agent can only do what the user could
//   already do by hand.
//
// Both transcripts live in component state only — a page reload clears them.
//
// WHO SEES WHAT (Role Catalog → AI Assistant & Agent, GET /api/assistant/
// access): no "Ask" grant → no button and no top-bar dot at all; "Voice" →
// the 🎤 mic (components/AiVoice.jsx); "Agent" → the Agent tab; the
// suggested prompts come from the server, filtered to what this login can
// actually get an answer to. The server enforces all of it again (403).
//
// CLARIFY: an unclear question comes back as ONE short question plus 2–3
// quick replies (`options`), rendered as chips that send themselves.
//
// PLACEMENT: opening the panel puts `ai-docked` on <body>, which reserves its
// width in the content column (styles.css), so nothing is hidden under it.
// ---------------------------------------------------------------------------

// --- The model's status, shared by the top-bar dot and the panel ----------
let statusCache = null;
const statusListeners = new Set();

function publishStatus(value) {
  statusCache = value;
  statusListeners.forEach((fn) => fn(value));
}

function refreshStatus() {
  return api.get('/agent/status')
    .then((res) => { publishStatus(res.data); return res.data; })
    .catch(() => {
      const down = { available: false, modelPulled: false, reason: 'The AI service could not be reached.' };
      publishStatus(down);
      return down;
    });
}

function useAiStatus() {
  const [status, setStatus] = useState(statusCache);
  useEffect(() => {
    statusListeners.add(setStatus);
    return () => { statusListeners.delete(setStatus); };
  }, []);
  return status;
}

// --- What this login may do with the AI (shared by the dot and the panel) ---
let accessCache = null; // { userId, value }
let accessPromise = null;
const accessListeners = new Set();

function loadAccess(userId) {
  if (!userId) return Promise.resolve(null);
  if (accessCache && accessCache.userId === userId) return Promise.resolve(accessCache.value);
  if (accessPromise && accessPromise.userId === userId) return accessPromise.promise;
  const promise = api.get('/assistant/access')
    .then((res) => res.data)
    .catch(() => ({
      ask: false, voice: false, agent: false, data: {}, prompts: [], failed: true,
    }))
    .then((value) => {
      accessCache = { userId, value };
      accessPromise = null;
      accessListeners.forEach((fn) => fn(accessCache));
      return value;
    });
  accessPromise = { userId, promise };
  return promise;
}

function useAiAccess(user) {
  const userId = user && user.id;
  const [cache, setCache] = useState(accessCache);
  useEffect(() => {
    accessListeners.add(setCache);
    loadAccess(userId);
    return () => { accessListeners.delete(setCache); };
  }, [userId]);
  return cache && cache.userId === userId ? cache.value : null;
}

function statusColour(s) {
  if (!s) return 'var(--ink-faint)';
  if (s.available && s.modelPulled) return 'var(--green)';
  if (s.available) return 'var(--amber)';
  return 'var(--ink-faint)';
}

function statusText(s) {
  if (!s) return 'Checking the AI…';
  if (s.available && s.modelPulled) return `AI online — ${s.model}${s.provider === 'claude' ? ' (Claude)' : ' (local)'}`;
  return s.reason || 'AI is offline';
}

function Dot({ status, size = 8 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: statusColour(status), flex: 'none',
      }}
    />
  );
}

// The always-on "AI" dot for the top bar (components/Shell.jsx). Polls once a
// minute; the server caches the answer, so many tabs cost nothing. Clicking
// it opens the panel.
export function AiStatusDot() {
  const { user } = useAuth();
  const access = useAiAccess(user);
  const allowed = !!(access && access.ask);
  const status = useAiStatus();
  useEffect(() => {
    if (!allowed) return undefined;
    refreshStatus();
    const t = setInterval(refreshStatus, 60000);
    return () => clearInterval(t);
  }, [allowed]);
  // No "Ask" grant in Role Catalog → no AI anywhere in the chrome.
  if (!allowed) return null;
  return (
    <button
      type="button"
      className="rolechip"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer' }}
      title={statusText(status)}
      aria-label={statusText(status)}
      onClick={() => window.dispatchEvent(new Event('tl-ai-open'))}
    >
      <Dot status={status} />
      AI
    </button>
  );
}

// --- Assistant: suggested prompts -------------------------------------------
// They come from GET /api/assistant/access (utils/aiAccess.js
// suggestedPrompts): only prompts this login can actually get an answer to,
// per its AI grant and its normal permissions. Review #3 §25 — the ATS ones
// read "Find candidates", "Summarize requirement" …; those that need a
// subject (`prefill`) go into the box for the user to complete.

function areaOf(pathname) {
  if (/^\/(hrms|attendance|leave|payroll|performance|employee-services|my-profile|employees)/.test(pathname)) return 'hrms';
  if (/^\/(ats|requirements|clients|candidates|client-portal)/.test(pathname)) return 'ats';
  if (/^\/(accounts|invoices|bank|office)/.test(pathname)) return 'accounts';
  return 'home';
}

function DueChip({ row }) {
  if (!row.due) return <span className="small-muted">—</span>;
  const today = new Date().toISOString().slice(0, 10);
  if (row.overdue) return <span className="status overdue">Overdue</span>;
  if (row.due === today) return <span className="status pending">Today</span>;
  return <span className="small-muted">{row.due}</span>;
}

// --- One proposal card -----------------------------------------------------
// state: undefined (awaiting Confirm) | 'running' | 'done' | 'failed' | 'cancelled'
function ProposalCard({ card, onConfirm, onCancel }) {
  const entries = Object.entries(card.details || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const settled = card.state === 'done' || card.state === 'failed' || card.state === 'cancelled';
  const running = card.state === 'running';
  const head = {
    done: 'Done', failed: 'Failed', cancelled: 'Cancelled', running: 'Working…',
  }[card.state] || 'Needs your confirmation';
  return (
    <div className={`ai-action${card.state === 'done' ? ' ai-action-done' : ''}${card.state === 'failed' || card.state === 'cancelled' ? ' ai-action-failed' : ''}`}>
      <div className="ai-action-head">{head}</div>
      <div className="ai-action-summary">{card.summary}</div>
      {entries.length > 0 && (
        <dl className="ai-action-details">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.state === 'done' && card.message && <div className="small-muted" style={{ marginTop: 6 }}>{card.message}</div>}
      {card.autoExecuted && (card.state === 'done' || card.state === 'failed') && (
        <div className="small-muted" style={{ marginTop: 6 }}>Carried out without a confirm step — your role has that grant in Role Catalog. Recorded in the audit log as “via AI Agent”.</div>
      )}
      {card.state === 'failed' && <div className="ai-action-error">{card.message}</div>}
      {card.state === 'cancelled' && <div className="small-muted" style={{ marginTop: 6 }}>You cancelled this — nothing was changed.</div>}
      {!settled && (
        <>
          <div className="ai-action-buttons">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onConfirm(card)} disabled={running}>
              {running ? 'Working…' : 'Confirm'}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => onCancel(card)} disabled={running}>
              Cancel
            </button>
          </div>
          <div className="ai-action-note small-muted">
            Nothing has changed yet. Your permissions are checked again when you confirm.
          </div>
          {card.heard && card.heard.low && (
            <div className="ai-action-note ai-heard-low">
              Spoken request, heard with low confidence — check the details above match what you said before confirming.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// How a card is written back into the history /agent/plan reads, so the
// model knows what already happened and does not propose it twice.
function cardAsText(card) {
  const head = `[Proposed ${card.action}: ${card.summary}]`;
  if (card.state === 'done') return `${head} Confirmed — ${card.message || 'done'}.`;
  if (card.state === 'failed') return `${head} Confirmed but it failed — ${card.message || 'error'}.`;
  if (card.state === 'cancelled') return `${head} User cancelled this, did not happen.`;
  return `${head} Awaiting user confirmation.`;
}

// Turns → [{role, content}] strictly alternating user/assistant. A question
// whose answer was an error is dropped with its error, so two user turns never
// sit next to each other.
function historyOf(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.role !== 'user') continue;
    const reply = turns[i + 1];
    if (!reply || reply.role !== 'assistant' || reply.error) continue;
    const text = reply.card ? cardAsText(reply.card) : reply.content;
    if (!text) continue;
    out.push({ role: 'user', content: t.content }, { role: 'assistant', content: text });
  }
  return out;
}

function Heard({ heard }) {
  if (!heard) return null;
  const pct = heard.confidence != null ? ` · ${Math.round(heard.confidence * 100)}% sure` : '';
  const lang = (VOICE_LANGS.find((l) => l.code === heard.lang) || {}).label || heard.lang;
  return (
    <span className={`ai-heard${heard.low ? ' ai-heard-low' : ''}`}>
      🎤 Spoken ({lang}{pct}){heard.low ? ' — may be mis-heard' : ''}
    </span>
  );
}

function Transcript({
  turns, busy, onConfirm, onCancel, endRef, local, onPick,
}) {
  const [copied, setCopied] = useState(null);
  function copy(i, text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  }
  return (
    <>
      {turns.map((t, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={`ai-turn ai-turn-${t.role}${t.error ? ' ai-turn-error' : ''}`}
        >
          {t.card
            ? <ProposalCard card={t.card} onConfirm={onConfirm} onCancel={onCancel} />
            : t.content}
          {t.role === 'user' && <Heard heard={t.heard} />}
          {t.role === 'assistant' && Array.isArray(t.options) && t.options.length > 0 && (
            <div className="ai-clarify" role="group" aria-label="Did you mean">
              {t.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className="ai-clarify-chip"
                  disabled={busy || i !== turns.length - 1}
                  onClick={() => onPick && onPick(o)}
                  data-testid="ai-clarify-chip"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          {t.role === 'assistant' && !t.card && !t.error && t.content && (
            <div className="ai-turn-tools small-muted" style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="link-btn" onClick={() => copy(i, t.content)}>
                {copied === i ? 'Copied' : 'Copy'}
              </button>
              {canSpeak && (
                <button type="button" className="link-btn" onClick={() => speak(t.content, t.lang)}>Read aloud</button>
              )}
            </div>
          )}
        </div>
      ))}
      {busy && (
        <div className="ai-turn ai-turn-assistant small-muted">
          {local
            ? 'Thinking… the local model reads slowly on this computer — the first answer can take a few minutes; follow-ups are quicker.'
            : 'Thinking…'}
        </div>
      )}
      <div ref={endRef} />
    </>
  );
}

export default function AiAssistant() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('assistant');
  const status = useAiStatus();
  const online = !!(status && status.available && status.modelPulled);

  const [threads, setThreads] = useState({ assistant: [], agent: [] });
  const [drafts, setDrafts] = useState({ assistant: '', agent: '' });
  const [busy, setBusy] = useState({ assistant: false, agent: false });
  const streamEnd = useRef(null);
  const access = useAiAccess(user);
  const mayAgent = !!(access && access.agent);
  const mayVoice = !!(access && access.voice);
  // Voice: language, read-aloud, and the 1.5 s auto-send with Undo.
  const [voiceLang, setVoiceLang] = useState(() => {
    const v = readPref('tl_ai_voice_lang', 'en-IN');
    return VOICE_LANGS.some((l) => l.code === v) ? v : 'en-IN';
  });
  const [tts, setTts] = useState(() => readPref('tl_ai_tts', '0') === '1');
  const [pendingVoice, setPendingVoice] = useState(null); // { which, text, voice }
  const pendingTimer = useRef(null);
  const listenFor = useRef('assistant');
  // The last voice transcript per tab — sent with the message only if the
  // text was not edited afterwards.
  const heardRef = useRef({ assistant: null, agent: null });

  // Rule-based ATS half (no model).
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  // Agent quick actions — UI hints only; the server decides for real.
  const [agentCtx, setAgentCtx] = useState(null);

  const hasAts = !!(user && user.products && user.products.ats && user.atsRole && user.atsRole !== 'NONE');
  const turns = threads[mode];

  // The top-bar dot opens the panel.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('tl-ai-open', onOpen);
    return () => window.removeEventListener('tl-ai-open', onOpen);
  }, []);

  useEffect(() => { if (open) refreshStatus(); }, [open]);

  // The FAB steps aside while a modal / drawer is open (AiFab.css does it with
  // :has(); this is the fallback for a browser without it).
  useEffect(() => {
    let hasSupport = false;
    try { hasSupport = window.CSS && CSS.supports('selector(:has(*))'); } catch { hasSupport = false; }
    if (hasSupport || typeof MutationObserver === 'undefined') return undefined;
    const check = () => document.body.classList.toggle('tl-modal-open',
      !!document.querySelector('.overlay.show, [aria-modal="true"], .oe-drw, .reqdrw'));
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    check();
    return () => { mo.disconnect(); document.body.classList.remove('tl-modal-open'); };
  }, []);

  useEffect(() => {
    if (!open || !hasAts) return;
    api.get('/dashboard/ats')
      .then((res) => { setData(res.data); setFailed(false); })
      .catch(() => setFailed(true));
  }, [open, hasAts, pathname]);

  useEffect(() => {
    if (!open || !mayAgent) return;
    api.get('/agent/context').then((res) => setAgentCtx(res.data)).catch(() => setAgentCtx(null));
  }, [open, mayAgent]);

  // A role without the Agent grant never sits on the Agent tab.
  useEffect(() => { if (access && !mayAgent && mode === 'agent') setMode('assistant'); }, [access, mayAgent, mode]);

  useEffect(() => {
    document.body.classList.toggle('ai-docked', open);
    return () => document.body.classList.remove('ai-docked');
  }, [open]);

  useEffect(() => {
    if (streamEnd.current) streamEnd.current.scrollIntoView({ block: 'end' });
  }, [threads, busy, mode]);

  const area = areaOf(pathname);
  // Server-filtered prompts: the ATS ones under "Try one of these", the rest
  // (HRMS / Accounts, this screen's area first) under "Also ask".
  const atsSuggestions = useMemo(() => ((access && access.prompts) || []).filter((q) => q.area === 'ats'), [access]);
  const questions = useMemo(() => {
    const list = ((access && access.prompts) || []).filter((q) => q.area !== 'ats');
    return [...list.filter((q) => q.area === area), ...list.filter((q) => q.area !== area)].slice(0, 5);
  }, [access, area]);

  // A prompt that needs a subject goes into the box, cursor at the end.
  const askInput = useRef(null);
  function prefill(text) {
    setDrafts((d) => ({ ...d, assistant: text }));
    setTimeout(() => {
      const el = askInput.current;
      if (el) { el.focus(); el.setSelectionRange(text.length, text.length); }
    }, 0);
  }

  const chips = useMemo(() => {
    const list = (agentCtx && agentCtx.chips) || [];
    return [...list.filter((c) => c.area === area), ...list.filter((c) => c.area !== area)].slice(0, 6);
  }, [agentCtx, area]);

  const destinations = useMemo(() => {
    const leaves = flattenGroups(groupsForUser(user));
    const ats = leaves.filter((l) => l.section === 'ats');
    return (ats.length ? ats : leaves).slice(0, 6);
  }, [user]);

  const go = (to) => { setOpen(false); navigate(to); };

  // Review #3 §25 — no count on the button (the 🔔 carries the counts).
  const fabTitle = `AI Assistant — ${statusText(status)}`;
  const pending = (data && data.pendingActions) || [];
  const waiting = pending.filter((p) => p.count > 0);
  const nextUp = ((data && data.queue) || []).slice(0, 3);

  function addTurn(which, turn) {
    setThreads((t) => ({ ...t, [which]: [...t[which], turn] }));
  }

  function patchCard(id, patch) {
    setThreads((all) => ({
      ...all,
      agent: all.agent.map((t) => (t.card && t.card.id === id ? { ...t, card: { ...t.card, ...patch } } : t)),
    }));
  }

  function say(text) {
    if (tts && text) speak(text, voiceLang);
  }

  // `voiceArg` = { lang, confidence } when the text is an unedited transcript.
  async function send(which, text, voiceArg) {
    const q = String(text || '').trim();
    if (!q || busy[which]) return;
    const heard = heardRef.current[which];
    const voice = voiceArg || (heard && heard.text === q ? { lang: heard.lang, confidence: heard.confidence } : null);
    heardRef.current[which] = null;
    setDrafts((d) => ({ ...d, [which]: '' }));
    const history = historyOf(threads[which]);
    const low = !!(voice && voice.confidence != null && voice.confidence < ((access && access.lowConfidence) || 0.6));
    addTurn(which, { role: 'user', content: q, heard: voice ? { ...voice, low } : null });
    setBusy((b) => ({ ...b, [which]: true }));
    try {
      if (which === 'assistant') {
        const res = await api.post('/assistant/ask', {
          message: q, history, page: pathname, ...(voice ? { voice } : {}),
        });
        addTurn(which, {
          role: 'assistant', content: res.data.answer, options: res.data.options || [], lang: voice ? voice.lang : undefined,
        });
        say(res.data.answer);
      } else {
        const res = await api.post('/agent/plan', {
          message: q, history, page: pathname, ...(voice ? { voice } : {}),
        });
        const plan = res.data;
        if (plan.action === 'clarify') {
          addTurn(which, { role: 'assistant', content: plan.summary, options: plan.options || [] });
          say(plan.summary);
        } else {
          addTurn(which, {
            role: 'assistant',
            card: {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              action: plan.action,
              params: plan.params,
              summary: plan.summary,
              details: plan.details,
              heard: plan.heard || null,
              // Role Catalog "execute without confirm": already carried out.
              ...(plan.executed ? { state: plan.ok ? 'done' : 'failed', message: plan.message, autoExecuted: true } : {}),
            },
          });
          say(plan.executed ? plan.message : `${plan.summary} Press Confirm to go ahead.`);
        }
      }
    } catch (err) {
      // §26 — the assistant's OWN error, word for word (e.g. the AI provider
      // refusing for want of credit), never a softened stand-in.
      const msg = err.response?.data?.error
        || (err.response ? `The AI could not answer (HTTP ${err.response.status}).` : `The AI could not be reached${err.message ? ` — ${err.message}` : ''}.`);
      if (err.response && err.response.status === 503) refreshStatus();
      addTurn(which, { role: 'assistant', error: true, content: msg });
    } finally {
      setBusy((b) => ({ ...b, [which]: false }));
    }
  }

  // THE ONLY THING THAT PERFORMS A CHANGE.
  async function confirmCard(card) {
    patchCard(card.id, { state: 'running' });
    try {
      const res = await api.post('/agent/execute', { action: card.action, params: card.params });
      patchCard(card.id, { state: 'done', message: res.data.message });
      // Counts on the agent tab (things waiting on me) may have moved.
      api.get('/agent/context').then((r) => setAgentCtx(r.data)).catch(() => {});
    } catch (err) {
      patchCard(card.id, { state: 'failed', message: err.response?.data?.error || 'That could not be done.' });
    }
  }

  function cancelCard(card) {
    patchCard(card.id, { state: 'cancelled' });
  }

  // --- Voice --------------------------------------------------------------
  function cancelPending() {
    clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    setPendingVoice(null);
  }

  // send() changes every render; the timer must call the latest one.
  const sendRef = useRef(send);
  sendRef.current = send;

  const voiceIn = useVoiceInput({
    // The live transcript goes straight into the box.
    onInterim: (text) => setDrafts((d) => ({ ...d, [listenFor.current]: text })),
    // Stopped with something heard: auto-send after 1.5 s unless Undo.
    onDone: ({ text, confidence, lang }) => {
      const which = listenFor.current;
      heardRef.current[which] = { text, confidence, lang };
      setDrafts((d) => ({ ...d, [which]: text }));
      const voice = { lang, confidence };
      setPendingVoice({ which, text, voice });
      clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        setPendingVoice(null);
        sendRef.current(which, text, voice);
      }, 1500);
    },
  });

  function toggleMic(which) {
    if (voiceIn.listening) { voiceIn.stop(); return; }
    cancelPending();
    stopSpeaking();
    listenFor.current = which;
    heardRef.current[which] = null;
    voiceIn.start(voiceLang);
  }

  function undoVoice() {
    cancelPending();
    setTimeout(() => {
      const el = askInput.current;
      if (el) el.focus();
    }, 0);
  }

  function changeLang(code) {
    setVoiceLang(code);
    writePref('tl_ai_voice_lang', code);
  }

  function changeTts(on) {
    setTts(on);
    writePref('tl_ai_tts', on ? '1' : '0');
    if (!on) stopSpeaking();
  }

  // Closing the panel stops the mic, any pending send and any speech.
  useEffect(() => {
    if (!open) { voiceIn.stop(); cancelPending(); stopSpeaking(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);

  function inputRow(which, placeholder, button) {
    const listeningHere = voiceIn.listening && listenFor.current === which;
    const pendingHere = !!(pendingVoice && pendingVoice.which === which);
    return (
      <>
        <form
          className="ai-ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (voiceIn.listening) voiceIn.stop();
            cancelPending();
            send(which, drafts[which]);
          }}
        >
          <input
            ref={askInput}
            value={drafts[which]}
            onChange={(e) => {
              if (pendingHere) cancelPending();
              setDrafts((d) => ({ ...d, [which]: e.target.value }));
            }}
            placeholder={listeningHere ? 'Listening…' : placeholder}
            disabled={busy[which]}
            maxLength={2000}
            data-testid="ai-input"
          />
          {/* Role Catalog "Voice" grant — no grant, no mic. */}
          {mayVoice && (
            <MicButton
              listening={listeningHere}
              disabled={busy[which]}
              onClick={() => toggleMic(which)}
              lang={voiceLang}
            />
          )}
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy[which] || !drafts[which].trim()}>
            {busy[which] ? '…' : button}
          </button>
        </form>
        {mayVoice && (
          <VoiceBar
            lang={voiceLang}
            onLang={changeLang}
            listening={listeningHere}
            error={listenFor.current === which ? voiceIn.error : null}
            onDismissError={voiceIn.clearError}
            pending={pendingHere}
            onUndo={undoVoice}
            tts={tts}
            onTts={changeTts}
          />
        )}
      </>
    );
  }

  const offlineBanner = status && !online && (
    <div className="notice amber" style={{ margin: '10px 12px 0' }}>
      <div>
        <b>AI is offline.</b>
        <div style={{ marginTop: 2 }}>{status.reason || 'The model is not available.'}</div>
      </div>
    </div>
  );

  // No "Ask" grant in Role Catalog (or not known yet) → no AI button at all.
  if (!access || !access.ask) return null;

  return (
    <>
      {!open && (
        <button
          className="ai-fab ai-fab-pill"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label="AI Assistant"
          title={fabTitle}
        >
          <span className="ai-fab-mark">AI Assistant</span>
          {/* Review #3 §25 — the button reads "AI Assistant" and nothing
              else: no count on it (the 🔔 carries the counts). */}
        </button>
      )}

      {open && <div className="ai-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      {open && (
        <aside className="ai-panel" role="dialog" aria-label="AI Assistant and Agent">
          <div className="ai-head">
            <div>
              <div className="ai-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot status={status} size={9} />
                How can I help?
              </div>
              <div className="small-muted" title={statusText(status)}>
                AI Assistant · {workRoleLabel(user)} · {statusText(status)}
              </div>
            </div>
            <button className="close-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="ai-modes" role="tablist" aria-label="Mode">
            <button
              role="tab"
              aria-selected={mode === 'assistant'}
              className={`ai-mode${mode === 'assistant' ? ' active' : ''}`}
              onClick={() => setMode('assistant')}
            >
              Assistant
            </button>
            {mayAgent && (
              <button
                role="tab"
                aria-selected={mode === 'agent'}
                className={`ai-mode${mode === 'agent' ? ' active' : ''}`}
                onClick={() => setMode('agent')}
              >
                Agent
                {agentCtx && agentCtx.actionableCount > 0 ? <span className="n">{agentCtx.actionableCount}</span> : null}
              </button>
            )}
          </div>
          {offlineBanner}

          {/* ------------------------------ ASSISTANT ------------------------ */}
          {mode === 'assistant' && (
            <>
              <div className="ai-body">
                {turns.length === 0 && (
                  <>
                    <div className="ai-note">
                      Ask about your leave, attendance, holidays, your pipeline or your accounts. Answers come
                      only from this app&apos;s records, read with your permissions — the Assistant never
                      changes anything.
                    </div>
                    {atsSuggestions.length > 0 && (
                      <>
                        <div className="ai-sec">Try one of these</div>
                        {/* Never disabled: if the AI can't answer, its own
                            error is shown in the conversation (§26). */}
                        {atsSuggestions.map((q) => (
                          <button
                            className="ai-sug ai-sug-slim"
                            key={q.label}
                            disabled={busy.assistant}
                            onClick={() => (q.prefill ? prefill(q.text) : send('assistant', q.text))}
                            title={q.prefill ? 'Complete the question in the box below' : q.text}
                          >
                            <span className="ai-sug-main">{q.label}{q.prefill ? ' …' : ''}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {questions.length > 0 && (
                      <>
                        <div className="ai-sec">{atsSuggestions.length ? 'Also ask' : 'Ask'}</div>
                        {questions.map((q) => (
                          <button
                            className="ai-sug ai-sug-slim"
                            key={q.text}
                            disabled={busy.assistant}
                            onClick={() => send('assistant', q.text)}
                          >
                            <span className="ai-sug-main">{q.text}</span>
                          </button>
                        ))}
                      </>
                    )}

                    {hasAts && failed && (
                      <div className="small-muted" style={{ margin: '10px 0' }}>Could not load your queue just now.</div>
                    )}
                    {hasAts && !data && !failed && <div className="small-muted" style={{ marginTop: 10 }}>Reading your queue…</div>}
                    {hasAts && data && (
                      <>
                        <div className="ai-sec">Do next</div>
                        {nextUp.length === 0 && (
                          <div className="small-muted" style={{ marginBottom: 10 }}>Nothing is waiting on you right now.</div>
                        )}
                        {nextUp.map((r) => (
                          <button className="ai-sug" key={r.id} onClick={() => go(r.to)}>
                            <span className="ai-sug-main">{r.nextAction} — {r.candidate}</span>
                            <span className="ai-sug-sub">{r.requirement} · {r.stageLabel} · <DueChip row={r} /></span>
                          </button>
                        ))}
                        {/* §26 — the heading says whose counts these are
                            ("My Team Pending Actions", "Company Pending
                            Actions"), never a bare "yours". */}
                        {waiting.length > 0 && <div className="ai-sec">{data.pendingTitle || 'My Pending Actions'}</div>}
                        {waiting.map((p) => (
                          <button className="ai-sug" key={p.id} onClick={() => go(p.to)}>
                            <span className="ai-sug-main">{p.label}<span className="n">{p.count}</span></span>
                            <span className="ai-sug-sub">{p.action}</span>
                          </button>
                        ))}
                      </>
                    )}

                    {destinations.length > 0 && <div className="ai-sec">Go to</div>}
                    {destinations.map((d) => (
                      <button className="ai-sug ai-sug-slim" key={d.to} onClick={() => go(d.to)}>
                        <span className="ai-sug-main">{d.parent ? `${d.parent.label} · ${d.label}` : d.label}</span>
                      </button>
                    ))}
                  </>
                )}
                {turns.length > 0 && (
                  <Transcript
                    turns={turns}
                    busy={busy.assistant}
                    local={!status || status.provider !== 'claude'}
                    onConfirm={confirmCard}
                    onCancel={cancelCard}
                    onPick={(o) => send(mode, o)}
                    endRef={streamEnd}
                  />
                )}
              </div>
              {inputRow('assistant', 'Ask a question', 'Ask')}
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
                Answers come from your own records and what your role can see. If something is not on record,
                the Assistant says so rather than guessing.
              </div>
            </>
          )}

          {/* ------------------------------ AGENT ---------------------------- */}
          {mode === 'agent' && mayAgent && (
            <>
              <div className="ai-body">
                {turns.length === 0 && (
                  <>
                    <div className="ai-note">
                      Tell the Agent what to do — &ldquo;apply casual leave next Monday for a family function&rdquo;,
                      &ldquo;approve Ravi&apos;s leave&rdquo;, &ldquo;schedule Priya&apos;s interview on Friday at 11&rdquo;.
                      It shows you exactly what it will do, and <b>nothing happens until you press Confirm</b>.
                    </div>
                    {agentCtx && agentCtx.actionableCount > 0 && (
                      <div className="small-muted" style={{ margin: '8px 0' }}>
                        {agentCtx.pendingLeaveDecisions > 0 && <>{agentCtx.pendingLeaveDecisions} leave request(s) </>}
                        {agentCtx.pendingLeaveDecisions > 0 && agentCtx.pendingRegularizationDecisions > 0 && 'and '}
                        {agentCtx.pendingRegularizationDecisions > 0 && <>{agentCtx.pendingRegularizationDecisions} attendance correction(s) </>}
                        waiting for your decision.
                      </div>
                    )}
                    {chips.length > 0 && <div className="ai-sec">Try</div>}
                    {chips.map((c) => (
                      <button
                        className="ai-sug ai-sug-slim"
                        key={c.action}
                        disabled={!online}
                        onClick={() => send('agent', c.prompt)}
                      >
                        <span className="ai-sug-main">{c.prompt}</span>
                        <span className="ai-sug-sub">{c.label}</span>
                      </button>
                    ))}
                    {agentCtx && chips.length === 0 && (
                      <div className="small-muted">Your role has none of the actions the Agent supports.</div>
                    )}
                    {!agentCtx && <div className="small-muted">Checking what you can do…</div>}
                  </>
                )}
                {turns.length > 0 && (
                  <Transcript
                    turns={turns}
                    busy={busy.agent}
                    local={!status || status.provider !== 'claude'}
                    onConfirm={confirmCard}
                    onCancel={cancelCard}
                    onPick={(o) => send(mode, o)}
                    endRef={streamEnd}
                  />
                )}
              </div>
              {inputRow('agent', 'Tell the agent what to do', 'Send')}
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
                Every change is shown to you first and happens only when you press Confirm — through the same
                screens&apos; rules and your own permissions. Check-in/out needs your location or camera, so do it
                from Attendance.
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

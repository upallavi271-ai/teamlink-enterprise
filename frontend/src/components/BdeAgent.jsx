import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { atsRoleOf } from '../nav';
import './BdeAgent.css';

// THE BDE AGENT (2026-11-18): a floating chat for BDE and BDE TL logins only. Answers come from the BDE's own TeamLink data
// (backend utils/bdeAgent.js: clients, agreements, requirements, candidates, pending client work, CRM) through the free fast AI.
// The server refuses everybody else (403), so hiding the button is never the control.
export function isBdeLogin(user) {
  if (!user) return false;
  if (user.bdeAgent !== undefined) return !!user.bdeAgent; // the server's rule (BDE, BDE TL, Super Admin, Developer logins)
  return atsRoleOf(user) === 'BDE' || !!(user.workflow && user.workflow.bdeTl);
}

const SUGGEST = [
  'What is pending for me today?',
  'Which agreements are not signed yet?',
  'Which open requirements have no candidates?',
  'Upcoming interviews this week?',
  'How do I follow up a client who has not replied?',
];

export default function BdeAgent() {
  const { user } = useAuth() || {};
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [chat, setChat] = useState([]);
  const [busy, setBusy] = useState(false);
  const [ov, setOv] = useState(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const show = isBdeLogin(user);

  useEffect(() => {
    if (!open || ov || !show) return;
    api.get('/bde-agent/overview').then((r) => setOv(r.data)).catch(() => setOv({ error: true }));
  }, [open, ov, show]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [chat, busy]);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  if (!show) return null;

  async function send(text) {
    const question = String(text || q).trim();
    if (!question || busy) return;
    const history = chat.filter((m) => !m.err).slice(-8).map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text }));
    setChat((c) => [...c, { who: 'me', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api.post('/bde-agent/ask', { question, history });
      setChat((c) => [...c, { who: 'ai', text: r.data.text, tag: r.data.provider ? `${r.data.provider} · ${(r.data.ms / 1000).toFixed(1)}s${r.data.note ? ` · ${r.data.note}` : ''}` : '' }]);
    } catch (e) {
      setChat((c) => [...c, { who: 'ai', text: (e.response && e.response.data && e.response.data.error) || 'The BDE Agent could not answer right now. Try again.', err: true }]);
    } finally {
      setBusy(false);
    }
  }

  // A pill in the TOP BAR (next to the AI status), not a floating button over the page (founder 2026-11-18: it covered the Quick actions).
  // The window opens under the top bar, drawn on the page body so no bar or card can clip it.
  return (
    <>
      <button type="button" className={`bde-agent-pill${open ? ' is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Ask the BDE Agent">🤝 BDE Agent</button>
      {open && createPortal(
        <div className="bde-agent-panel" role="dialog" aria-label="BDE Agent">
          <div className="bde-agent-head">
            <div>
              <b>🤝 BDE Agent</b>
              <div className="bde-agent-sub">answers from your clients, agreements, requirements and pipeline</div>
            </div>
            {chat.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setChat([])} title="Start a new conversation">New</button>}
            <button type="button" className="close-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {ov && !ov.error && (
            <div className="bde-agent-stats">
              <span><b>{ov.clients}</b> clients</span>
              <span><b>{ov.openRequirements}</b> open reqs</span>
              <span><b>{ov.unsignedAgreements}</b> unsigned</span>
              <span><b>{ov.candidates}</b> candidates</span>
            </div>
          )}
          {ov && !ov.error && !ov.aiReady && (
            <div className="bde-agent-warn">AI is not set up yet: an Admin adds a free Groq key in Administration → Integrations → Fast AI.</div>
          )}
          <div className="bde-agent-body" ref={bodyRef}>
            {!chat.length && (
              <div>
                <div className="bde-agent-hint">Ask anything about your work, in English or Telugu. For example:</div>
                {SUGGEST.map((s) => <button key={s} type="button" className="bde-agent-suggest" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className={`bde-agent-msg ${m.who}${m.err ? ' err' : ''}`}> {/* eslint-disable-line react/no-array-index-key */}
                {m.text}
                {m.tag && <div className="bde-agent-tag">{m.tag}</div>}
              </div>
            ))}
            {busy && <div className="bde-agent-msg ai bde-agent-typing">Thinking…</div>}
          </div>
          <div className="bde-agent-foot">
            <input ref={inputRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="Ask the BDE Agent" aria-label="Question for the BDE Agent" maxLength={1000} />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !q.trim()} onClick={() => send()}>Ask</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

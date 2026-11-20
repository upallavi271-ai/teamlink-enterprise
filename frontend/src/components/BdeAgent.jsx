import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { atsRoleOf } from '../nav';
import { HLink } from './search/historyOpen.jsx';
import './BdeAgent.css';

// THE BDE AGENT (2026-11-18, rebuilt 2026-11-20): a pill in the top bar and a chat window for BDE, BDE TL, Super Admin and Developer logins.
// The common questions are answered by the server IN CODE from exact numbers in the login's own scope (backend utils/bdeAgentRouter.js), each
// record with a link (a history link opens in the side drawer over the page); open-ended questions go to the fast AI with the facts built for
// them. "How I got this" shows those facts. The server refuses everybody else (403), so hiding the button is never the control.
export function isBdeLogin(user) {
  if (!user) return false;
  if (user.bdeAgent !== undefined) return !!user.bdeAgent; // the server's rule (BDE, BDE TL, Super Admin, Developer logins)
  return atsRoleOf(user) === 'BDE' || !!(user.workflow && user.workflow.bdeTl);
}

const DEFAULT_CHIPS = ["What is pending today?", "Today's interviews", 'Pending client feedback', 'Overdue invoices', 'Agreements expiring in 30 days', 'Replacements due'];
const KEEP = 12; // messages kept for this tab (the last few questions and answers)
const storeKey = (user) => `bdeAgent.chat.${user && user.id}`;
const load = (user) => { try { const v = JSON.parse(sessionStorage.getItem(storeKey(user)) || '[]'); return Array.isArray(v) ? v.slice(-KEEP) : []; } catch { return []; } };
const save = (user, chat) => { try { sessionStorage.setItem(storeKey(user), JSON.stringify(chat.slice(-KEEP))); } catch { /* private window */ } };
const narrow = () => (typeof window !== 'undefined' && window.innerWidth < 700);

function Item({ it, onGo }) {
  const sameHistory = !it.history || it.history === it.to;
  return (
    <li className="bde-agent-item" title={`${it.label}${it.sub ? ` · ${it.sub}` : ''}`}>
      <HLink to={it.to} onClick={onGo} className="bde-agent-link">{it.label}</HLink>
      {it.sub && <span className="bde-agent-sub2"> · {it.sub}</span>}
      {!sameHistory && <> <HLink to={it.history} onClick={onGo} className="bde-agent-hist" title="Complete history (opens beside the page)">history</HLink></>}
    </li>
  );
}

function Answer({ a, onGo, compact }) {
  return (
    <div className="bde-agent-ans">
      <div className="bde-agent-title">{a.title}</div>
      {!compact && (a.lines || []).map((l, i) => <div key={i} className="bde-agent-line">{l}</div>)} {/* eslint-disable-line react/no-array-index-key */}
      {(a.items || []).length > 0 && (
        <ul className={`bde-agent-items${a.items.length > 12 ? ' is-long' : ''}`}>
          {a.items.map((it, i) => <Item key={`${it.kind}-${it.id}-${i}`} it={it} onGo={onGo} />)} {/* eslint-disable-line react/no-array-index-key */}
        </ul>
      )}
      {a.more > 0 && (
        <div className="bde-agent-more">
          {`${a.items.length} shown of ${a.items.length + a.more}. `}
          {a.open ? <HLink to={a.open.to} onClick={onGo} className="bde-agent-link">{a.open.label}</HLink> : 'Narrow the question (a client, a month) to see the rest.'}
        </div>
      )}
    </div>
  );
}

function AiMessage({ m, onGo }) {
  const [why, setWhy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(m.text || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  const answers = m.answers || [];
  return (
    <div className={`bde-agent-msg ai${m.err ? ' err' : ''}`}>
      {m.err && m.text}
      {!m.err && m.source === 'model' && <div className="bde-agent-model">{m.text}</div>}
      {!m.err && m.source !== 'model' && (m.lead || []).map((l, i) => <div key={i} className="bde-agent-line">{l}</div>)} {/* eslint-disable-line react/no-array-index-key */}
      {!m.err && m.source !== 'model' && m.note && <div className="bde-agent-note">{m.note}</div>}
      {!m.err && answers.map((a, i) => <Answer key={i} a={a} onGo={onGo} compact={m.source === 'model'} />)} {/* eslint-disable-line react/no-array-index-key */}
      {!m.err && (
        <div className="bde-agent-tools">
          <span className="bde-agent-tag">{m.source === 'model' ? `${m.provider || 'AI'} · ` : 'from your data · '}{((m.ms || 0) / 1000).toFixed(1)}s</span>
          {(m.facts || []).length > 0 && <button type="button" className="bde-agent-tool" aria-expanded={why} onClick={() => setWhy((w) => !w)}>{why ? 'Hide how' : 'How I got this'}</button>}
          <button type="button" className="bde-agent-tool" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {why && <ul className="bde-agent-facts">{m.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>} {/* eslint-disable-line react/no-array-index-key */}
    </div>
  );
}

export default function BdeAgent() {
  const { user } = useAuth() || {};
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [chat, setChat] = useState(() => load(user));
  const [busy, setBusy] = useState(false);
  const [ov, setOv] = useState(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const show = isBdeLogin(user);

  useEffect(() => {
    if (!open || ov || !show) return;
    api.get('/bde-agent/overview').then((r) => setOv(r.data)).catch(() => setOv({ error: true }));
  }, [open, ov, show]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [chat, busy, open]);
  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);
  useEffect(() => { save(user, chat); }, [user, chat]);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.hxd-wrap')) setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  if (!show) return null;

  async function send(text) {
    const question = String(text || q).trim();
    if (!question || busy) return;
    const history = chat.filter((m) => !m.err).slice(-6).map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 1500) }));
    setChat((c) => [...c, { who: 'me', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api.post('/bde-agent/ask', { question, history });
      const d = r.data || {};
      setChat((c) => [...c, {
        who: 'ai', text: d.text || '', answers: d.answers || [], facts: d.facts || [], source: d.source, provider: d.provider, ms: d.ms, lead: d.lead || [], note: d.note || '',
      }]);
    } catch (e) {
      setChat((c) => [...c, { who: 'ai', text: (e.response && e.response.data && e.response.data.error) || 'The BDE Agent could not answer right now. Try again.', err: true }]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.focus();
    }
  }
  const onGo = () => { if (narrow()) setOpen(false); };
  const chips = (ov && ov.chips) || DEFAULT_CHIPS;

  // A pill in the TOP BAR (next to the AI status), not a floating button over the page (founder 2026-11-18: it covered the Quick actions).
  // The window opens under the top bar, drawn on the page body so no bar or card can clip it.
  return (
    <>
      <button type="button" className={`bde-agent-pill${open ? ' is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Ask the BDE Agent" data-testid="bde-agent-pill">🤝 BDE Agent</button>
      {open && createPortal(
        <div className="bde-agent-panel" role="dialog" aria-label="BDE Agent" data-testid="bde-agent-panel">
          <div className="bde-agent-head">
            <div>
              <b>🤝 BDE Agent</b>
              <div className="bde-agent-sub">your clients, requirements, candidates, invoices and agreements, in English or Telugu</div>
            </div>
            {chat.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setChat([])} title="Start a new conversation">New</button>}
            <button type="button" className="close-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {ov && !ov.error && (
            <div className="bde-agent-stats">
              <span><b>{ov.clients}</b> clients</span>
              <span><b>{ov.openRequirements}</b> open requirements</span>
              <span><b>{ov.unsignedAgreements}</b> agreements not signed</span>
            </div>
          )}
          {ov && !ov.error && !ov.aiReady && (
            <div className="bde-agent-warn">The common questions are answered from your data. For open questions an Admin adds a free Groq key in Administration → Integrations → Fast AI.</div>
          )}
          <div className="bde-agent-body" ref={bodyRef}>
            {!chat.length && <div className="bde-agent-hint">Ask anything about your work, or tap a question:</div>}
            {chat.map((m, i) => (m.who === 'me'
              ? <div key={i} className="bde-agent-msg me">{m.text}</div> // eslint-disable-line react/no-array-index-key
              : <AiMessage key={i} m={m} onGo={onGo} />))} {/* eslint-disable-line react/no-array-index-key */}
            {busy && <div className="bde-agent-msg ai bde-agent-typing" aria-live="polite">Thinking…</div>}
          </div>
          <div className="bde-agent-chips" role="list" aria-label="Suggested questions">
            {chips.map((s) => <button key={s} type="button" role="listitem" className="bde-agent-chip" disabled={busy} onClick={() => send(s)}>{s}</button>)}
          </div>
          <form className="bde-agent-foot" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input ref={inputRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Tell me about a client, or: ee roju interviews" aria-label="Question for the BDE Agent" maxLength={1000} enterKeyHint="send" />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !q.trim()}>Ask</button>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}

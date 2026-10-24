import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import WaChatPane from './WaChatPane.jsx';
import ConversationView from './ConversationView.jsx';
import CommunicationTimeline from './CommunicationTimeline.jsx';
import './waChats.css';
import './candidateConversation.css';

// ---------------------------------------------------------------------------
// CANDIDATE PROFILE -> CONVERSATION TAB (founder, 2026-10-22).
// The WhatsApp chat of THIS candidate sits here: what was sent and what they answered, in order, with the reply box under it, so a recruiter (or a TL /
// anyone who may follow this person up) reads and answers without leaving the profile. It is the same chat as Follow-ups > WhatsApp chats (same pane,
// same send rules, same number rules); nothing is copied. "All channels" keeps the older view (Call, Mail, SMS and WhatsApp in one timeline) as it was.
// A login that has no WhatsApp chat (role, or the server says no) simply sees the "All channels" view.
// ---------------------------------------------------------------------------
export default function CandidateConversation({ candidateId, name, applicationId, requirementId, onChanged }) {
  const [cfg, setCfg] = useState(undefined); // undefined = loading, null = not available
  const [view, setView] = useState('wa');
  useEffect(() => {
    let live = true;
    setCfg(undefined);
    api.get('/wa-chats/config').then((r) => { if (live) setCfg(r.data && r.data.allowed ? r.data : null); }).catch(() => { if (live) setCfg(null); });
    return () => { live = false; };
  }, [candidateId]);

  const chatOk = !!cfg;
  const cur = chatOk ? view : 'all';
  // the chat fills the screen under the tabs: the messages get the room and the reply box is always in view (no page scrolling to reach it)
  const boxRef = useRef(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const fit = () => { const el = boxRef.current; if (el) setH(Math.max(420, window.innerHeight - el.getBoundingClientRect().top - 14)); };
    fit();
    window.addEventListener('resize', fit);
    const t = setTimeout(fit, 400); // after the banners above the chat have appeared
    return () => { window.removeEventListener('resize', fit); clearTimeout(t); };
  }, [cur, cfg]);
  const noNumber = chatOk && cfg.numbers && !cfg.numbers.legacy && (cfg.numbers.numbers || []).length === 0;
  const isAdmin = !!(cfg && cfg.isAdmin);
  return (
    <div className="cwc">
      {chatOk && (
        <div className="cwc-switch" role="tablist" aria-label="Conversation view">
          <button type="button" role="tab" aria-selected={cur === 'wa'} className={`btn btn-sm${cur === 'wa' ? ' btn-primary' : ''}`} onClick={() => setView('wa')}>WhatsApp chat</button>
          <button type="button" role="tab" aria-selected={cur === 'all'} className={`btn btn-sm${cur === 'all' ? ' btn-primary' : ''}`} onClick={() => setView('all')}>All channels (Call · Mail · SMS)</button>
        </div>
      )}
      {cfg === undefined && <div className="small-muted">Loading the conversation…</div>}
      {chatOk && cur === 'wa' && (
        <>
          {cfg.test && cfg.test.mode && <div className="msg-box blue" role="status"><b>Test mode:</b> messages are not really sent.</div>}
          {cfg.channel && !cfg.channel.configured && (
            <div className="msg-box orange" role="alert"><b>WhatsApp is not connected.</b> {cfg.channel.reason || 'Messages cannot be sent yet.'}{isAdmin && <> <Link to="/admin/integrations">Connect it in Integrations</Link>.</>}</div>
          )}
          {noNumber && <div className="msg-box orange" role="alert"><b>No WhatsApp number is assigned to you yet.</b> Ask the Admin.</div>}
          <div className="cwc-box" ref={boxRef} style={h ? { height: h } : undefined}>
            <WaChatPane key={candidateId} audience="candidates" personId={candidateId} row={null} cfg={cfg} embedded onBack={() => setView('all')} />
          </div>
        </>
      )}
      {cfg !== undefined && cur === 'all' && (
        <>
          <CommunicationTimeline candidateId={candidateId} />
          <ConversationView audience="candidates" personId={candidateId} name={name} applicationId={applicationId} requirementId={requirementId} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

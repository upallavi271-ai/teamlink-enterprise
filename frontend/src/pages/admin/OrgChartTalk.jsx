import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import WaChatPane from '../../components/messaging/WaChatPane.jsx';
import ConversationView from '../../components/messaging/ConversationView.jsx';
import '../../components/messaging/waChats.css';
import '../../components/messaging/candidateConversation.css';

// ---------------------------------------------------------------------------
// ORGANIZATION CHART -> MESSAGE: a WhatsApp chat with that employee (founder, 2026-11-18: "visible on the WhatsApp chat ... I reply and receive").
// It is the SAME chat as the candidate profile's Conversation tab and Follow-ups > WhatsApp chats (same pane, ticks, 24-hour rule, templates, number
// rules, STOP rule), here for an employee: what was sent, what they answered, in order, with the reply box under it; new replies arrive by themselves.
// "All channels" keeps the one-person Conversation (Call, Mail, SMS, and WhatsApp) for the other ways to reach them. Nothing is copied or kept here:
// what each login may do comes from the server (/api/wa-chats, /api/conversations).
// ---------------------------------------------------------------------------
export default function OrgChartTalk({ personId, name }) {
  const [cfg, setCfg] = useState(undefined); // undefined = loading, null = not available to this login
  const [view, setView] = useState('wa');
  useEffect(() => {
    let live = true;
    setCfg(undefined);
    api.get('/wa-chats/config').then((r) => { if (live) setCfg(r.data && r.data.allowed ? r.data : null); }).catch(() => { if (live) setCfg(null); });
    return () => { live = false; };
  }, [personId]);

  const chatOk = !!cfg;
  const cur = chatOk ? view : 'all';
  const noNumber = chatOk && cfg.numbers && !cfg.numbers.legacy && (cfg.numbers.numbers || []).length === 0;
  const isAdmin = !!(cfg && cfg.isAdmin);
  return (
    <div className="cwc">
      {chatOk && (
        <div className="cwc-switch" role="tablist" aria-label="How to reach them">
          <button type="button" role="tab" aria-selected={cur === 'wa'} className={`btn btn-sm${cur === 'wa' ? ' btn-primary' : ''}`} onClick={() => setView('wa')}>WhatsApp chat</button>
          <button type="button" role="tab" aria-selected={cur === 'all'} className={`btn btn-sm${cur === 'all' ? ' btn-primary' : ''}`} onClick={() => setView('all')}>All channels (Call · Mail · SMS)</button>
        </div>
      )}
      {cfg === undefined && <div className="small-muted">Opening the chat…</div>}
      {chatOk && cur === 'wa' && (
        <>
          {cfg.test && cfg.test.mode && <div className="msg-box blue" role="status"><b>Test mode:</b> messages are not really sent.</div>}
          {cfg.channel && !cfg.channel.configured && (
            <div className="msg-box orange" role="alert">
              <b>WhatsApp is not connected.</b>
              {' '}
              {cfg.channel.reason || 'Messages cannot be sent yet.'}
              {isAdmin && <>{' '}<Link to="/admin/integrations">Connect it in Integrations</Link>.</>}
            </div>
          )}
          {noNumber && <div className="msg-box orange" role="alert"><b>No WhatsApp number is assigned to you yet.</b> Ask the Admin.</div>}
          <div className="cwc-box" style={{ height: 'min(68vh, 640px)', minHeight: 420 }}>
            <WaChatPane key={personId} audience="employees" personId={personId} row={null} cfg={cfg} embedded onBack={() => setView('all')} />
          </div>
        </>
      )}
      {cfg !== undefined && cur === 'all' && <ConversationView audience="employees" personId={personId} name={name} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { canSeeTemplates } from './msgKit.js';
import './conversation.css';

// ---------------------------------------------------------------------------
// WHICH WAYS OF REACHING PEOPLE WORK TODAY.
//   Mail       connected -> green, with whether replies can be read (the shared inbox)
//   WhatsApp   not connected -> orange, and what to do (link to Message templates > Channels)
//   SMS        same
//   Call       the phone link always works; "Call through TeamLink" when Exotel is connected
// `channels` can be passed in (the conversation already has it) or the strip asks by itself.
// ---------------------------------------------------------------------------
const NAME = { Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', Call: 'Call' };
const ICON = { Email: '✉️', WhatsApp: '🟢', SMS: '💬', Call: '📞' };

export function useChannelStrip(given) {
  const [ch, setCh] = useState(given || null);
  useEffect(() => {
    if (given) { setCh(given); return undefined; }
    let on = true;
    api.get('/conversations/channels').then((r) => { if (on) setCh(r.data.channels); }).catch(() => {});
    return () => { on = false; };
  }, [given]);
  return ch;
}

export default function ChannelStrip({ channels, showHelp = true }) {
  const { user } = useAuth() || {};
  const ch = useChannelStrip(channels);
  if (!ch) return null;
  const mayOpen = canSeeTemplates(user);
  const todo = ['Email', 'WhatsApp', 'SMS'].filter((c) => !ch[c].configured);
  return (
    <>
      <div className="cv-strip" aria-label="Ways to reach people">
        {['Email', 'WhatsApp', 'SMS', 'Call'].map((c) => {
          const x = ch[c];
          const ok = c === 'Call' ? true : x.configured;
          const word = c === 'Call'
            ? (x.configured ? 'Call through TeamLink' : 'Phone link')
            : (x.configured ? 'Connected' : 'Not connected');
          const extra = c === 'Email' && x.configured ? (x.repliesConnected ? ' · replies on' : ' · Connect an inbox to see replies') : '';
          return (
            <span key={c} className={`cv-strip-item ${ok ? 'ok' : 'no'}`} title={x.detail || x.reason || ''}>
              <span className="cv-dot" aria-hidden="true" />
              <span>{ICON[c]} <b>{NAME[c]}</b> {word}{extra}</span>
            </span>
          );
        })}
      </div>
      {showHelp && todo.length > 0 && (
        <div className="cv-strip-help">
          {todo.map((c) => NAME[c]).join(' and ')} {todo.length > 1 ? 'are' : 'is'} not connected yet, so messages there are not sent from TeamLink.{' '}
          {mayOpen ? <Link to="/admin/message-templates?tab=channels">Here is what to do</Link> : 'Ask an Admin to connect it (Message templates > Channels).'}
        </div>
      )}
    </>
  );
}

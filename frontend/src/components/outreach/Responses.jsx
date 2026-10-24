import InboxPanel from '../messaging/InboxPanel.jsx';
import './omni2.css';

// OMNI-CHANNEL > RESPONSES: every reply (email, WhatsApp, SMS, call notes) in the ONE inbox of the app (utils/conversations.js, the same data as
// ATS > Follow-ups > Inbox). The server limits each login to its own people and department; nothing is stored twice.
export default function Responses() {
  return (
    <div>
      <div className="oc-note" style={{ marginBottom: 8 }}>All replies in one list: person, last message, channel, who it is given to. Open one to read the chat, reply with a template, mark it done or give it to a colleague. You only see your own people and department.</div>
      <InboxPanel />
    </div>
  );
}

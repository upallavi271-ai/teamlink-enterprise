import { useState } from 'react';
import ContactDialog from '../messaging/ContactDialog.jsx';
import { useContactRule } from '../messaging/useMayMessage.js';
import './followups.css';

// ---------------------------------------------------------------------------
// CALL · MAIL · WHATSAPP · SMS on the candidate profile (the Contact bar).
//
// Every button ALWAYS works: it opens the same window (components/messaging/
// ContactDialog.jsx) with the ready-made message for that way of reaching the
// person, filled with their own details. What the window offers depends on what
// is really connected:
//
//   Call       the call script, the number, "Call now", then "Save the call"
//   Mail       "Send mail" from the company account, or "Open in my mail app"
//   WhatsApp   "Send WhatsApp" (Business API), or "Open in WhatsApp" (wa.me)
//   SMS        "Send SMS" (SMS account), or "Copy message"
//
// Every send, every call and every time the person opens their own app is
// logged on the profile (the follow-up's "last contact" moves too).
//
//   <QuickContact candidate={{ id, name, phone, email }} applicationId role client onLogged />
// ---------------------------------------------------------------------------

const BUTTONS = [
  ['Call', '📞', 'Call', 'See what to say, dial the number, then save how the call went'],
  ['Email', '✉️', 'Mail', 'Write an email from a template and send it (or open it in your own mail app)'],
  ['WhatsApp', '💬', 'WhatsApp', 'Write a WhatsApp message from a template and send it (or open your own WhatsApp)'],
  ['SMS', '📱', 'SMS', 'Write a text message from a template and send it (or copy it)'],
];

export default function QuickContact({
  candidate, applicationId = null, role = '', client = '', onLogged, compact = false,
}) {
  const [open, setOpen] = useState(null);
  const rule = useContactRule('candidates'); // the SERVER's answer for this login (Role Catalog: Contact)
  if (!candidate || !candidate.id) return null;
  // A role that may not contact people: one plain line, no dead buttons.
  if (rule.loaded && !rule.allowed) {
    return <div className="fux-quick-wrap"><div className="small-muted">You cannot contact people from here. {rule.reason}</div></div>;
  }
  const { phone, email, name } = candidate;
  return (
    <div className="fux-quick-wrap">
      <div className="fux-quick">
        {BUTTONS.map(([id, icon, label, hint]) => (
          <button key={id} type="button" className="btn btn-sm" title={hint} onClick={() => setOpen(id)}>
            <span aria-hidden="true">{icon}</span> {label}
          </button>
        ))}
        {!compact && <span className="fux-quick-note">{rule.masked ? 'TeamLink makes the call and sends the message for you: the number stays hidden. Everything is logged by itself.' : 'Each one opens a window with a ready message. Every call, mail, WhatsApp and SMS is logged by itself.'}</span>}
      </div>
      {open && (
        <ContactDialog
          channel={open}
          audience="candidates"
          personId={candidate.id}
          name={name}
          email={email || ''}
          phone={phone || ''}
          applicationId={applicationId}
          role={role}
          client={client}
          onClose={() => setOpen(null)}
          onLogged={onLogged}
        />
      )}
    </div>
  );
}

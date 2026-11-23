import { useState } from 'react';
import ContactDialog from '../messaging/ContactDialog.jsx';
import CallButton from '../browsercall/CallButton.jsx';
import { useContactRule } from '../messaging/useMayMessage.js';
import { useReachPriority } from '../candidate/ReachPriorityCard.jsx';
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

// BEST WAY TO REACH at the top (founder 2026-11-04): the button of the channel this person answers
// most gets a "Best" mark, and one line says why. The same answer as the card (ReachPriorityCard.jsx).
const BUTTON_OF = { 'AI call': 'Call', 'Phone call': 'Call', WhatsApp: 'WhatsApp', SMS: 'SMS', Email: 'Email' };

export default function QuickContact({
  candidate, applicationId = null, role = '', client = '', onLogged, compact = false,
}) {
  const [open, setOpen] = useState(null);
  const rule = useContactRule('candidates'); // the SERVER's answer for this login (Role Catalog: Contact)
  const { data: reach } = useReachPriority(candidate && candidate.id);
  const bestRow = reach && reach.best ? reach.channels.find((c) => c.key === reach.best) : null;
  const bestButton = bestRow ? BUTTON_OF[bestRow.key] : null;
  if (!candidate || !candidate.id) return null;
  // A role that may not contact people: one plain line, no dead buttons.
  if (rule.loaded && !rule.allowed) {
    return <div className="fux-quick-wrap"><div className="small-muted">You cannot contact people from here. {rule.reason}</div></div>;
  }
  const { phone, email, name } = candidate;
  return (
    <div className="fux-quick-wrap">
      <div className="fux-quick">
        {/* CALL = the browser call (founder 2026-11-23: "remove this button, put the other Call button in its place"): it rings the person from the SIM line straight away */}
        <CallButton candidateId={candidate.id} applicationId={applicationId} name={name} hasNumber={!!phone} size="sm" />
        {BUTTONS.filter(([id]) => id !== 'Call').map(([id, icon, label, hint]) => (
          <button
            key={id}
            type="button"
            className={`btn btn-sm${bestButton === id ? ' btn-primary' : ''}`}
            title={bestButton === id ? `Best way to reach: ${bestRow.key} (${bestRow.words}). ${hint}` : hint}
            onClick={() => setOpen(id)}
          >
            <span aria-hidden="true">{icon}</span> {label}{bestButton === id ? ' ★ Best' : ''}
          </button>
        ))}
        {bestRow && (
          <span className="fux-quick-note" style={{ color: 'var(--green, #067647)', fontWeight: 600 }}>
            Best way to reach: {bestRow.key} ({bestRow.words}){bestRow.key === 'AI call' ? ' · start it from AI Calling' : ''}
          </span>
        )}
        {!compact && <span className="fux-quick-note">{rule.masked ? 'TeamLink makes the call and sends the message for you: the number stays hidden. Everything is logged by itself.' : 'Call rings the person from the office SIM line. Mail, WhatsApp and SMS open a window with a ready message. Everything is logged by itself.'}</span>}
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

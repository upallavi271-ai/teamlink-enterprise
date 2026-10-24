import { useState } from 'react';
import { createPortal } from 'react-dom';
import ContactDialog from '../messaging/ContactDialog.jsx';
import ReachModal from './ReachModal.jsx';
import { useReachRights, copyText } from './reachKit.js';
import './reach.css';

// ONE "Contact" button on a candidate row / card. It opens a small card (a bottom sheet on a phone):
// the name and job, the phone and the email ONCE, then four full-width rows: Call · WhatsApp · SMS · Email,
// each with a one-line hint. A row opens the same window as the candidate page (ContactDialog): template,
// preview, real send where connected, "Open in WhatsApp" where not, Call with the outcome buttons.
// The parent shows this only to logins that may contact (useReachRights in Candidates.jsx), so a BDE,
// BDE TL or Accounts login never sees it. Both windows are drawn through a portal at document.body.
// person: { id (candidate), name, job, phone, email, applicationId }   (phone / email undefined = not known here)

function Chooser({ person, onPick, onClose }) {
  const rights = useReachRights();
  const [copied, setCopied] = useState('');
  const ch = rights.channels || {};
  const live = (c) => !!(ch[c] && ch[c].configured) && rights.bulk;
  const noPhone = person.phone === '';
  const noMail = person.email === '';
  const rows = [
    ['Call', '📞', 'Call', noPhone ? 'No phone on file' : (rights.call && rights.call.configured ? 'Rings your phone first, then them' : 'Opens your phone'), noPhone],
    ['WhatsApp', '🟢', 'WhatsApp', noPhone ? 'No phone on file' : (live('WhatsApp') ? 'Sends from TeamLink' : 'Opens WhatsApp'), noPhone],
    ['SMS', '💬', 'SMS', noPhone ? 'No phone on file' : (live('SMS') ? 'Sends from TeamLink' : 'Copy it, send from your phone'), noPhone],
    ['Email', '✉️', 'Email', noMail ? 'No email on file' : (live('Email') ? 'Sends from TeamLink' : 'Opens your mail app'), noMail],
  ];
  const copy = async (what, text) => { if (await copyText(text)) { setCopied(what); setTimeout(() => setCopied(''), 1500); } };
  return (
    <ReachModal compact title={`Contact ${person.name}`} onClose={onClose}>
      {person.job && <div className="rch-who-job">{person.job}</div>}
      <div className="rch-facts">
        {person.phone ? (
          <div className="rch-fact"><span>📞 {person.phone}</span><button type="button" className="link-btn" onClick={() => copy('phone', person.phone)}>{copied === 'phone' ? 'Copied' : 'Copy'}</button></div>
        ) : null}
        {person.email ? (
          <div className="rch-fact"><span>✉️ {person.email}</span><button type="button" className="link-btn" onClick={() => copy('email', person.email)}>{copied === 'email' ? 'Copied' : 'Copy'}</button></div>
        ) : null}
      </div>
      <div className="rch-list" role="group" aria-label="How do you want to reach them?">
        {rows.map(([id, icon, word, hint, off], i) => (
          <button key={id} type="button" className={`rch-lrow rch-lrow-${id.toLowerCase()}`} disabled={off} data-autofocus={i === rows.findIndex((x) => !x[4]) ? 'true' : undefined} onClick={() => onPick(id)}>
            <span className="rch-lrow-i" aria-hidden="true">{icon}</span>
            <b>{word}</b>
            <small>{hint}</small>
          </button>
        ))}
      </div>
      <div className="rch-cancel"><button type="button" className="link-btn" onClick={onClose}>Cancel</button></div>
    </ReachModal>
  );
}

export default function ReachRowButtons({ person, onLogged }) {
  const [pick, setPick] = useState(false);
  const [open, setOpen] = useState(null);
  if (!person || !person.id) return null;
  return (
    <span className="rch-row" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
      <button type="button" className="btn btn-sm rch-contact" aria-label={`Contact ${person.name}`} onClick={(e) => { e.stopPropagation(); setPick(true); }}>
        <span aria-hidden="true">📞</span> Contact
      </button>
      {pick && <Chooser person={person} onClose={() => setPick(false)} onPick={(ch) => { setPick(false); setOpen(ch); }} />}
      {open && createPortal(
        // the existing one-person window: put it above the page like every other reach window
        <div className="rch-boost">
          <ContactDialog
            channel={open}
            audience="candidates"
            personId={person.id}
            name={person.name}
            email={person.email}
            phone={person.phone}
            applicationId={person.applicationId || undefined}
            onClose={() => setOpen(null)}
            onLogged={onLogged}
          />
        </div>,
        document.body,
      )}
    </span>
  );
}

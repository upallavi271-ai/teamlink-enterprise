import { useState } from 'react';
import ReachDialog from './ReachDialog.jsx';
import SendManyDialog from '../messaging/SendMessage.jsx';
import CallQueueSheet from './CallQueueSheet.jsx';
import { useReachRights, REACH_MAX } from './reachKit.js';
import './reach.css';

// ---------------------------------------------------------------------------
// The four SEPARATE contact buttons for the ticked candidates (no dropdown):
//   [Call] [WhatsApp] [SMS] [Email]
// Shown only to a login that sees candidates' numbers (the server decides: not BDE, not BDE TL,
// not Accounts). Message / WhatsApp / Email also need the bulk right.
// items: [{ id, latestApplicationId, name, phone, requirementTitle, clientName, stageLabel }]
// ---------------------------------------------------------------------------
export default function ReachButtons({ items, onCancel, onDone }) {
  const rights = useReachRights();
  const [open, setOpen] = useState(null); // 'Call' | 'SMS' | 'WhatsApp' | 'Email' | 'WhatsAppOwn'
  if (!rights.loaded || !rights.one) return null;
  const uniq = [...new Map(items.map((x) => [x.id, x])).values()];
  const tooMany = uniq.length > REACH_MAX;
  const tip = tooMany ? `At most ${REACH_MAX} at a time: narrow the list or untick some.` : undefined;
  const btn = (ch, icon, label) => (
    <button key={ch} type="button" className={`btn btn-sm rch-b rch-b-${ch.toLowerCase()}`} title={tip || (ch === 'SMS' ? 'Send a text message (SMS)' : undefined)} onClick={() => setOpen(ch)}>
      <span aria-hidden="true">{icon}</span> {label}
    </button>
  );
  return (
    <>
      <div className="rch-btns" role="group" aria-label="Contact the selected candidates">
        {btn('Call', '📞', 'Call')}
        {rights.bulk && btn('WhatsApp', '🟢', 'WhatsApp')}
        {rights.bulk && btn('SMS', '💬', 'SMS')}
        {rights.bulk && btn('Email', '✉️', 'Email')}
        {onCancel && <button type="button" className="btn btn-sm rch-b rch-b-cancel" onClick={onCancel}>Cancel</button>}
      </div>
      {open === 'Call' && <CallQueueSheet items={uniq} onClose={() => setOpen(null)} onDone={onDone} />}
      {/* WHATSAPP TO MANY = ONE PERSON'S WHATSAPP (founder 2026-10-26): the same window, templates, company number and send path as
          the single WhatsApp, so the messages look the same and the replies land in the same chats. No company number for this
          login -> "Open in my WhatsApp, one by one" (the honest one-at-a-time list). */}
      {open === 'WhatsApp' && (
        <SendManyDialog mode="WhatsApp" audience="candidates" ids={uniq.map((x) => x.id)} onClose={() => setOpen(null)} onSent={onDone} onOwnWhatsApp={() => setOpen('WhatsAppOwn')} />
      )}
      {open === 'WhatsAppOwn' && <ReachDialog channel="WhatsApp" items={uniq} onClose={() => setOpen(null)} onDone={onDone} />}
      {open && !['Call', 'WhatsApp', 'WhatsAppOwn'].includes(open) && <ReachDialog channel={open} items={uniq} onClose={() => setOpen(null)} onDone={onDone} />}
    </>
  );
}

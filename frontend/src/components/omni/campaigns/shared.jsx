import { useEffect, useState } from 'react';
import { Btn, GsModal } from '../ui.jsx';

// Shared bits of the Campaigns page: channel look (the prototype's colours), small formatters, a CSV saver and a name prompt.
export const CHANNELS = [
  { id: 'all', label: 'All', icon: '▦', color: '#0a7040' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '📞', color: '#11985a' },
  { id: 'sms', label: 'SMS', icon: '💬', color: '#4d7ddb' },
  { id: 'email', label: 'Email', icon: '✉', color: '#b45f06' },
  { id: 'rcs', label: 'RCS', icon: '💭', color: '#0891b2' },
  { id: 'call', label: 'Voice', icon: '🎙', color: '#5b6ee1' },
  { id: 'facebook', label: 'Facebook', icon: '📘', color: '#1877f2' },
  { id: 'instagram', label: 'Instagram', icon: '📸', color: '#d6249f' },
];
export const CH_WORD = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', call: 'Voice (calls)', rcs: 'RCS', facebook: 'Facebook', instagram: 'Instagram' };
export const CH_COLOR = Object.fromEntries(CHANNELS.map((c) => [c.id, c.color]));
export const STATUS_TABS = [['all', 'All'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['notsent', 'Not sent yet'], ['completed', 'Completed'], ['paused', 'Paused'], ['approval', 'Waiting for approval']];

const ist = { timeZone: 'Asia/Kolkata' };
export const fmtShort = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { ...ist, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { ...ist, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { ...ist, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
export const n0 = (n) => Number(n || 0).toLocaleString('en-IN');

// save a Blob the browser way (the prototype's "saved" toast is done by the caller)
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// the prototype's uiPrompt: one labelled input with an inline error
export function PromptModal({ title, label, initial = '', okLabel = 'Save', validate, onSubmit, onCancel, busy }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  useEffect(() => { setErr(''); }, [v]);
  const go = () => { const e = validate ? validate(v) : ''; if (e) { setErr(e); return; } onSubmit(v.trim()); };
  return (
    <GsModal title={title} onClose={onCancel} width={440} foot={<><Btn onClick={onCancel}>Cancel</Btn><Btn primary disabled={busy} onClick={go}>{okLabel}</Btn></>}>
      <div className="field"><label>{label}</label><input autoFocus value={v} maxLength={80} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />{err && <small style={{ color: '#b3261e', fontSize: 10 }}>{err}</small>}</div>
    </GsModal>
  );
}

export const ChannelDot = ({ id }) => <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: CH_COLOR[id] || '#999', marginRight: 5 }} />;

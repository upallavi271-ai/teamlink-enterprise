// ---------------------------------------------------------------------------
// The small shared pieces of the Communication Console and the WhatsApp Inbox (colours and words of the prototype, plain helpers).
// ---------------------------------------------------------------------------
export const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', icon: '📞', color: '#11985a', soft: '#e8f7ef', kind: 'chat', tips: ['Only approved templates can be sent.', 'Phone numbers need country codes.'] },
  { key: 'sms', label: 'SMS', icon: '💬', color: '#4d7ddb', soft: '#edf3ff', kind: 'chat', tips: ['Templates must be DLT approved.', 'Use {{name}}, {{company}}: they are filled for each person.'] },
  { key: 'rcs', label: 'RCS', icon: '💭', color: '#0891b2', soft: '#e6f7fb', kind: 'chat', planned: true, tips: ['Rich cards render only on RCS-capable devices.', 'Fallback to SMS is automatic if unsupported.'] },
  { key: 'call', label: 'Voice', icon: '🎙', color: '#5b6ee1', soft: '#eef0fd', kind: 'call', tips: ['Each person becomes a call task for you (Automations > Tasks).', 'Keep the call script under 30 seconds.'] },
  { key: 'email', label: 'Email', icon: '@', color: '#666fd3', soft: '#eff0fb', kind: 'email', tips: ['Subject lines under 60 characters perform best.', 'Every email carries an unsubscribe link, added for you.'] },
  { key: 'facebook', label: 'Facebook', icon: '📘', color: '#1877f2', soft: '#e8f1fe', kind: 'social', planned: true, page: 'fbchannel', tips: ['Connect a verified Facebook Page.'] },
  { key: 'instagram', label: 'Instagram', icon: '📸', color: '#d6249f', soft: '#fcebf6', kind: 'social', planned: true, page: 'igchannel', tips: ['Use vertical 9:16 media for stories.'] },
];
export const chOf = (k) => CHANNELS.find((c) => c.key === k) || CHANNELS[0];

export const download = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
export const slug = (s) => String(s || 'send').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'send';

// "now", "5m", "3h", "2d" like the prototype's chat list
export function relTime(v) {
  if (!v) return '';
  const diff = Math.max(0, Date.now() - new Date(v).getTime());
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
export const timeOf = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
export const chWord = (c) => (c === 'Email' ? 'Mail' : c);

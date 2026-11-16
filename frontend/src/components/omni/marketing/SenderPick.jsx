import { useEffect, useState } from 'react';
import omni from '../omniApi.js';

// "SEND FROM": which of the company's connected WhatsApp numbers a message to a client leaves from (server: marketing/sender.js). The DEFAULT company number is always the first and is
// chosen when nothing is picked, so every message to a client comes from the same number. Only numbers connected in TeamLink (Administration > Integrations > WhatsApp numbers) can send,
// so this is a list to pick from, not a box to type a number in. `value` = the chosen number id ('' = the default); onChange(id).
export default function SenderPick({ value, onChange, disabled = false }) {
  const [d, setD] = useState(null);
  useEffect(() => { let on = true; omni.get('/gs/marketing/senders').then((x) => { if (on) setD(x); }).catch(() => { if (on) setD(null); }); return () => { on = false; }; }, []);
  if (!d || d.legacy || !d.numbers || !d.numbers.length) return null; // the old single connection (or not readable): nothing to pick
  const cur = value || d.defaultId || d.numbers[0].id;
  const pretty = (n) => `${n.label}${n.number ? ` · ${n.number}` : ''}${n.isDefault ? ' (default)' : ''}`;
  return (
    <div style={{ margin: '6px 0 8px' }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: '#166534', marginBottom: 4 }}>SEND WHATSAPP FROM</div>
      {d.numbers.length === 1 ? (
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{pretty(d.numbers[0])}</div>
      ) : (
        <select value={cur} disabled={disabled} onChange={(e) => onChange(e.target.value === d.defaultId ? '' : e.target.value)} aria-label="The WhatsApp number to send from" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 12 }}>
          {d.numbers.map((n) => <option key={n.id} value={n.id}>{pretty(n)}</option>)}
        </select>
      )}
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>The client gets the message from this number. Only numbers connected in TeamLink can send.</div>
    </div>
  );
}

// CRM > a lead / deal > CONVERSATION (2026-11-17): one thread of every email, WhatsApp, SMS and call with them - what we sent, what they wrote back
// (the replies the autopilot / inbox already logs), oldest at the top and the newest at the bottom, with the delivery of each message.
// The reply box sends through POST /crm/contact/send, so its rules stay: WhatsApp inside 24 hours of their last message goes as plain words,
// outside it as the approved template (or it is refused with the reason). GET /crm/conversation/:kind/:id (crm/analytics.js)
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const CH_ICON = { Email: '✉️', WhatsApp: '💬', SMS: '📱', Call: '📞' };
function Delivery({ m }) {
  if (m.direction === 'in') return <span className="status active" style={{ fontSize: 10.5 }}>Received</span>;
  if (m.delivery === 'Failed') return <span className="status rejected" style={{ fontSize: 10.5 }} title={m.deliveryDetail || ''}>✗ Not delivered</span>;
  if (m.delivery === 'Read') return <span className="status active" style={{ fontSize: 10.5 }} title={m.deliveryDetail || ''}>✓✓ Read</span>;
  if (m.delivery === 'Delivered') return <span className="status active" style={{ fontSize: 10.5 }} title={m.deliveryDetail || ''}>✓✓ Delivered</span>;
  if (m.delivery === 'Sent') return <span className="status pending" style={{ fontSize: 10.5 }} title={m.deliveryDetail || ''}>✓ Sent</span>;
  if (/^(Mail app opened|WhatsApp opened)/.test(m.subject)) return <span className="status pending" style={{ fontSize: 10.5 }} title="Opened in the person's own app: TeamLink cannot see whether it was sent">Not confirmed</span>;
  return null;
}

export default function Conversation({ kind, id, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(null);
  const [plan, setPlan] = useState(null);
  const [channel, setChannel] = useState('WhatsApp');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const load = () => api.get(`/crm/conversation/${kind}/${id}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The conversation could not be read.')));
  useEffect(() => { setD(null); load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d || !d.canReply || draft) return;
    api.get('/crm/contact/draft', { params: { kind, id } }).then((r) => {
      setDraft(r.data);
      const lastMail = [...d.messages].reverse().find((m) => m.channel === 'Email' && m.direction === 'out' && m.subject);
      setSubject(lastMail ? `Re: ${lastMail.subject.replace(/^(Re: )+/i, '')}` : r.data.email.subject);
      if (!r.data.to.phone && r.data.to.email) setChannel('Email');
    }).catch(() => setDraft({ to: {} }));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (channel !== 'WhatsApp' || !d || !d.canReply) { setPlan(null); return; }
    api.get('/crm/contact/wa-plan', { params: { kind, id } }).then((r) => setPlan(r.data)).catch(() => setPlan(null));
  }, [channel, d, kind, id]);
  useEffect(() => { if (end.current && end.current.scrollIntoView) end.current.scrollIntoView({ block: 'nearest' }); }, [d]);

  async function send() {
    setBusy(true);
    try {
      const r = await api.post('/crm/contact/send', { kind, id, channel, text, ...(channel === 'Email' ? { subject } : {}) });
      toast(r.data.usedTemplate ? 'Sent as the approved WhatsApp template (they had not written in the last 24 hours).' : `${channel === 'Email' ? 'Email' : 'WhatsApp message'} sent.`);
      setText(''); load(); if (onChanged) onChanged();
    } catch (e) { toast(errOf(e, 'The message was not sent.')); } finally { setBusy(false); }
  }
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const to = (draft && draft.to) || {};
  return (
    <div>
      <div className="crm-thread" aria-label="Conversation" role="log">
        {!d.messages.length && <div className="small-muted" style={{ textAlign: 'center', padding: 16 }}>No emails, WhatsApp messages, SMS or calls with them yet.</div>}
        {d.messages.map((m) => (
          <div key={m.id} className={`crm-msg ${m.direction}`}>
            <div className="meta">
              <span aria-hidden="true">{CH_ICON[m.channel] || '•'}</span>
              <b>{m.direction === 'in' ? 'They wrote' : m.direction === 'call' ? 'Call' : m.by || 'Sent'}</b>
              <span>{m.channel}</span>
              <span>{dateTimeOf(m.at)}</span>
              <Delivery m={m} />
            </div>
            {m.channel === 'Email' && m.subject && m.direction !== 'in' && <div style={{ fontWeight: 600, fontSize: 12.5 }}>{m.subject}</div>}
            {(m.direction === 'call' || !m.text) && <div className="body">{m.direction === 'call' ? [m.subject, m.text].filter(Boolean).join(' · ') : m.subject}</div>}
            {m.direction !== 'call' && m.text && <div className="body">{m.text}</div>}
            {m.to && <div className="small-muted" style={{ fontSize: 10.5, marginTop: 2 }}>to {m.to}</div>}
            {m.delivery === 'Failed' && m.deliveryDetail && <div style={{ fontSize: 11.5, color: 'var(--red)' }}>{m.deliveryDetail}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      {d.canReply && (
        <div className="crm-reply">
          <div className="row">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Reply by" style={{ width: 'auto' }}>
              <option value="WhatsApp">💬 WhatsApp{to.phone ? ` · ${to.phone}` : ''}</option>
              <option value="Email">✉️ Email{to.email ? ` · ${to.email}` : ''}</option>
            </select>
            {channel === 'WhatsApp' && plan && plan.ok && (plan.blocked
              ? <span className="status rejected" style={{ fontSize: 11 }}>Outside 24 hours and no approved template: it cannot go</span>
              : plan.windowOpen ? <span className="status active" style={{ fontSize: 11 }}>They wrote in the last 24 hours: plain message</span>
                : <span className="status pending" style={{ fontSize: 11 }}>Outside 24 hours: it goes as the approved template</span>)}
            {channel === 'WhatsApp' && plan && !plan.ok && <span className="small-muted" style={{ fontSize: 11.5 }}>{plan.error}</span>}
          </div>
          {channel === 'Email' && <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Email subject" />}
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={channel === 'Email' ? 'Write the email' : 'Write the WhatsApp message'} aria-label="Reply" />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim() || (channel === 'Email' && !subject.trim()) || (channel === 'WhatsApp' && plan && plan.ok && plan.blocked)} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

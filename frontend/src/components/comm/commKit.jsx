import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import './comm.css';

// ---------------------------------------------------------------------------
// Small pieces of the Communication Automation module used by every place a person contacts a candidate:
//   <ProviderLine channel="WhatsApp" />   "WhatsApp via Company number (Official) will be used" (or: nothing connected -> your own app)
//   <StatusTicks providerRef=... />       Queued -> Sent -> Delivered -> Read  /  Failed + the reason, live
// Plain words (the 15-20 year old rule); four colours: green done, blue going on, orange waiting, red problem.
// ---------------------------------------------------------------------------

export function useProviders(channel) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (channel !== 'WhatsApp' && channel !== 'SMS') { setD(null); return undefined; }
    let on = true;
    api.get('/comm/providers', { params: { channel } }).then((r) => { if (on) setD(r.data); }).catch(() => { if (on) setD(null); });
    return () => { on = false; };
  }, [channel]);
  return d;
}

export function ProviderLine({ channel, compact = false }) {
  const d = useProviders(channel);
  if (!d) return null;
  if (!d.switchOn) {
    return <div className="cm-line cm-red"><b>{channel} to candidates is switched off for the company.</b> An Admin turns it on in Administration &gt; Integrations &gt; WhatsApp &amp; SMS.</div>;
  }
  if (!d.configured) {
    return (
      <div className="cm-line cm-orange">
        <b>{channel} is not connected</b>, so nothing is sent for you. {channel === 'WhatsApp' ? 'You can open it in your own WhatsApp' : 'You can copy the message'} instead.
        {!compact && d.reason && <div className="cm-sub">{d.reason}</div>}
      </div>
    );
  }
  return (
    <div className={`cm-line ${d.prototype ? 'cm-orange' : 'cm-green'}`} data-provider={d.provider}>
      <b>{d.via}</b> will be used.
      {d.prototype && <span className="cm-badge">Prototype</span>}
      {!compact && d.warning && <div className="cm-sub">{d.warning}</div>}
      {!compact && d.templateRule && <div className="cm-sub">{d.templateRule}</div>}
      {!compact && d.providers && d.providers.length > 1 && d.providers.find((p) => p.ready && p.id !== d.provider) && (
        <div className="cm-sub">If it cannot be sent, TeamLink tries {d.providers.find((p) => p.ready && p.id !== d.provider).short}.</div>
      )}
    </div>
  );
}

const STEPS = ['queued', 'sent', 'delivered', 'read'];
const WORD = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Read' };

// Live ticks of ONE message. providerRef comes from the send answer. Stops by itself when it is final.
export function StatusTicks({ providerRef, channel, queuedNote, onFailed, initial }) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  const ended = useRef(false);
  useEffect(() => {
    ended.current = false;
    if (!providerRef) return undefined;
    let timer = null; let n = 0;
    const tick = async () => {
      if (ended.current) return;
      try {
        const r = await api.get('/comm/status', { params: { ref: providerRef } });
        setM(r.data.message); setErr('');
        if (['delivered', 'read', 'failed'].includes(r.data.message.status) && (r.data.message.status !== 'delivered' || channel !== 'WhatsApp' || n > 40)) {
          ended.current = true;
          if (r.data.message.status === 'failed' && onFailed) onFailed(r.data.message);
        }
      } catch (e) { setErr(e.response && e.response.status === 404 ? '' : 'Could not read the status.'); }
      n += 1;
      if (!ended.current && n < 80) timer = setTimeout(tick, n < 6 ? 1500 : 4000);
    };
    tick();
    return () => { ended.current = true; if (timer) clearTimeout(timer); };
  }, [providerRef]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = (m && m.status) || initial || 'sent';
  const failed = status === 'failed';
  const steps = channel === 'SMS' ? STEPS.filter((s) => s !== 'read') : STEPS;
  const at = steps.indexOf(status);
  return (
    <div className="cm-ticks" role="status" aria-live="polite">
      <div className="cm-tickrow">
        {steps.map((s, i) => (
          <span key={s} className={`cm-tick${!failed && i <= at ? ' on' : ''}${!failed && i === at ? ' now' : ''}`}>{WORD[s]}</span>
        ))}
        {failed && <span className="cm-tick fail">Failed</span>}
      </div>
      {failed && m && <div className="cm-sub cm-redtext">{m.error || 'The provider reported the message as not delivered.'}</div>}
      {status === 'queued' && queuedNote && <div className="cm-sub">{queuedNote}</div>}
      {m && m.retries > 0 && <div className="cm-sub">Tried {m.retries + 1} times.</div>}
      {err && <div className="cm-sub">{err}</div>}
    </div>
  );
}

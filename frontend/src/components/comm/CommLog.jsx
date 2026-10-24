import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import './comm.css';
import Combo from '../Combo.jsx';

// COMMUNICATION LOG: every WhatsApp and SMS message sent or received through TeamLink, with who sent it, which number / phone
// carried it and how far it got. Filters, counts and Excel / PDF buttons (separate buttons, no menu).
const PROVIDERS = [['whatsapp.cloud', 'Official WhatsApp'], ['whatsapp.qr', 'QR-linked WhatsApp (prototype)'], ['sms.android', 'Android phone'], ['sms.gateway', 'Paid SMS gateway']];
const STATUS = [['queued', 'Queued'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed']];
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export default function CommLog() {
  const [f, setF] = useState({ from: daysAgo(6), to: today(), channel: '', provider: '', status: '', sender: '', q: '', direction: '' });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(1);
  const params = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f]);

  useEffect(() => {
    let on = true;
    setErr('');
    api.get('/comm/log', { params: { ...params, page, size: 50 } }).then((r) => { if (on) setData(r.data); }).catch((e) => { if (on) setErr(e.response?.data?.error || 'Could not load the log.'); });
    return () => { on = false; };
  }, [params, page]);

  const set = (k) => (e) => { setPage(1); setF((x) => ({ ...x, [k]: e.target.value })); };
  async function download(kind) {
    try {
      const r = await api.get(`/comm/log.${kind}`, { params, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = `communication-log.${kind}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setErr('Could not download the file.'); }
  }
  const cs = (data && data.counts) || { status: {}, provider: {}, channel: {} };
  return (
    <div className="cm-page">
      <p className="cm-help">Every WhatsApp and SMS message that went through TeamLink, sent or received. {data && data.scope === 'mine' ? 'You see the messages you sent.' : 'You see everyone\'s messages.'}</p>
      <div className="cm-filters">
        <div><label>From</label><input type="date" value={f.from} onChange={set('from')} /></div>
        <div><label>To</label><input type="date" value={f.to} onChange={set('to')} /></div>
        <div><label>Channel</label><Combo value={f.channel} onChange={set('channel')}><option value="">All</option><option>WhatsApp</option><option>SMS</option></Combo></div>
        <div><label>Sent through</label><Combo value={f.provider} onChange={set('provider')}><option value="">All</option>{PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}{cs.provider[v] ? ` (${cs.provider[v]})` : ''}</option>)}</Combo></div>
        <div><label>Step</label><Combo value={f.status} onChange={set('status')}><option value="">All</option>{STATUS.map(([v, l]) => <option key={v} value={v}>{l}{cs.status[v] ? ` (${cs.status[v]})` : ''}</option>)}</Combo></div>
        <div><label>Direction</label><Combo value={f.direction} onChange={set('direction')}><option value="">Sent and received</option><option value="OUT">Sent</option><option value="IN">Received</option></Combo></div>
        {data && data.senders && data.senders.length > 0 && (
          <div><label>Sent by</label><Combo value={f.sender} onChange={set('sender')}><option value="">Everyone</option>{data.senders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Combo></div>
        )}
        <div><label>Search name or template</label><input value={f.q} onChange={set('q')} placeholder="Type a name" /></div>
      </div>
      <div className="cm-btnrow" style={{ marginTop: 0, marginBottom: 10 }}>
        <button type="button" className="btn btn-primary" onClick={() => download('xlsx')}>Download Excel</button>
        <button type="button" className="btn" onClick={() => download('pdf')}>Download PDF</button>
        {data && <span className="cm-help" style={{ alignSelf: 'center', margin: 0 }}>{data.total} message{data.total === 1 ? '' : 's'}: {STATUS.filter(([v]) => cs.status[v]).map(([v, l]) => `${cs.status[v]} ${l.toLowerCase()}`).join(', ') || 'none yet'}</span>}
      </div>
      {err && <div className="cm-line cm-red">{err}</div>}
      {data && data.rows.length === 0 && <div className="cm-line cm-blue">No messages in these dates yet. When someone sends a WhatsApp or SMS from TeamLink it shows here.</div>}
      {data && data.rows.length > 0 && (
        <table className="cm-table">
          <thead><tr><th>When</th><th>Person</th><th>To</th><th>Channel</th><th>Sent through</th><th>Sent by</th><th>Step</th><th>Problem</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<div className="cm-sub">{r.direction === 'IN' ? 'Received' : 'Sent'}</div></td>
                <td>{r.personName || '-'}{r.template && <div className="cm-sub">{r.template}</div>}</td>
                <td>{r.to || '-'}</td>
                <td>{r.channel}{r.attachments && r.attachments.length > 0 && <div className="cm-sub">File: {r.attachments.join(', ')}</div>}</td>
                <td>{r.providerLabel || '-'}</td>
                <td>{r.senderName || (r.direction === 'IN' ? 'Their reply' : '-')}</td>
                <td><span className={`cm-pill ${r.status}`}>{r.statusLabel}</span>{r.retries > 0 && <div className="cm-sub">Tried {r.retries + 1} times</div>}</td>
                <td className="cm-redtext">{r.error || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > 50 && (
        <div className="cm-btnrow">
          <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</button>
          <span className="cm-help" style={{ alignSelf: 'center', margin: 0 }}>Page {page} of {Math.ceil(data.total / 50)}</span>
          <button type="button" className="btn" disabled={page * 50 >= data.total} onClick={() => setPage((p) => p + 1)}>Older</button>
        </div>
      )}
    </div>
  );
}

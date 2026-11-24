// CRM > Follow-ups > Dialer (CRM wave B, 07.04): call a list one after another. Make a list (follow-ups due today, leads not called this week,
// a segment), then for each person: call (office line from the browser, Cloud Telephony, or the phone's dialler), say what came of it, next.
import { useEffect, useState } from 'react';
import api from '../../../api';
import { useCrm, errOf, istToday, addDays } from '../crmShared.jsx';
import { useBrowserCall } from '../../../components/browsercall/CallProvider.jsx';
import { useLoad, Empty } from './bShared.jsx';

function Runner({ id, onBack }) {
  const { me, toast, openRecord } = useCrm();
  const bc = useBrowserCall();
  const { data, reload } = useLoad(`/crm/b/dial-lists/${id}`);
  const [st, setSt] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/crm/b/calls/status').then((r) => setSt(r.data)).catch(() => setSt(null)); }, []);
  const cur = data && data.next;
  useEffect(() => { setOutcome(''); setNote(''); setNext(''); }, [cur && cur.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(skip) {
    if (!skip && !outcome && !note.trim()) { toast('Pick what came of it, or write a line.'); return; }
    setBusy(true);
    try { await api.post(`/crm/b/dial-items/${cur.id}`, skip ? { skip: true } : { outcome, note, followUpDate: next || undefined }); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } finally { setBusy(false); }
  }
  async function exotel() { try { const r = await api.post('/crm/contact/call', { kind: cur.kind, id: cur.recordId, to: cur.phone }); toast(r.data.message); } catch (e) { toast(errOf(e, 'The call could not start.')); } }
  if (!data) return <div className="small-muted">Loading…</div>;
  const today = istToday();
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={onBack}>← Lists</button>
        <b>{data.list.name}</b><span className="small-muted">{data.list.done} of {data.list.total} done</span>
        <div style={{ flex: 1, minWidth: 120, height: 6, borderRadius: 3, background: 'var(--line-soft, #e8ebf0)' }}><div style={{ width: `${Math.round((data.list.done / Math.max(1, data.list.total)) * 100)}%`, height: 6, borderRadius: 3, background: 'var(--brand, #2563eb)' }} /></div>
      </div>
      {!cur && <Empty title="All done">Everybody on this list has been called. Well done.</Empty>}
      {cur && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{cur.name || cur.company}</h2><span className="small-muted">{cur.company}</span>
            <button type="button" className="crm-linkbtn" onClick={() => openRecord(cur.kind, cur.recordId)}>Open record</button>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 0.5, margin: '6px 0 10px' }}>{cur.phone}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {st && st.canCall && bc.callCrm && <button type="button" className="btn btn-primary" onClick={() => bc.callCrm({ kind: cur.kind, id: cur.recordId, name: cur.name || cur.company, to: cur.phone })}>🎧 Call from the browser</button>}
            <button type="button" className="btn" onClick={exotel} title="Cloud Telephony: your phone rings first">📞 Call (my phone rings first)</button>
            <a className="btn" href={`tel:+91${String(cur.phone).replace(/\D/g, '').slice(-10)}`}>Phone's dialler</a>
          </div>
          <div className="section-label" style={{ margin: '0 0 6px' }}>What came of it?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {me.lists.outcomes.map((o) => <button key={o} type="button" className={`btn btn-sm${outcome === o ? ' btn-primary' : ''}`} aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}>{o}</button>)}
          </div>
          <div className="field"><label>A line about it</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Call back after 4 pm" /></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
            <span className="small-muted">Next follow-up:</span>
            {[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([l, n]) => <button key={l} type="button" className={`btn btn-sm${next === addDays(today, n) ? ' btn-primary' : ''}`} onClick={() => setNext(next === addDays(today, n) ? '' : addDays(today, n))}>{l}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save and next →'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Skip</button>
          </div>
        </div>
      )}
      <div className="tbl-wrap" style={{ marginTop: 12 }}><table>
        <thead><tr><th>#</th><th>Who</th><th>Phone</th><th>Status</th><th>What came of it</th></tr></thead>
        <tbody>{data.items.map((i) => <tr key={i.id} style={cur && cur.id === i.id ? { background: 'var(--brand-soft, #eef2ff)' } : null}><td>{i.pos}</td><td>{i.name || i.company}</td><td>{i.phone}</td><td>{i.status}</td><td className="small-muted">{[i.outcome, i.note].filter(Boolean).join(' · ')}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

export default function CrmDialer() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/dial-lists');
  const segs = useLoad('/crm/b/segments');
  const [open, setOpen] = useState(null);
  const [source, setSource] = useState('followups');
  const [segmentId, setSegmentId] = useState('');
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try { const r = await api.post('/crm/b/dial-lists', { source, segmentId: segmentId || undefined }); toast(`${r.data.total} people to call.`); reload(); setOpen(r.data.id); } catch (e) { toast(errOf(e, 'The list could not be made.')); } finally { setBusy(false); }
  }
  if (open) return <Runner id={open} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <div>
      {me.canEdit && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Start calling</div>
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Who to call" style={{ width: 'auto' }}>
              <option value="followups">My follow-ups due today or late</option>
              <option value="idle">Open leads not called this week</option>
              <option value="segment">A segment</option>
            </select>
            {source === 'segment' && <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} aria-label="Segment" style={{ width: 'auto' }}><option value="">Pick a segment…</option>{(segs.data ? segs.data.segments : []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
            <button type="button" className="btn btn-primary" disabled={busy || (source === 'segment' && !segmentId)} onClick={make}>{busy ? 'Making…' : 'Make the list'}</button>
          </div>
          <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>People without a number, and numbers marked "do not call", are left out.</div>
        </div>
      )}
      {data && !data.lists.length && <Empty title="No call lists yet">Make one above.</Empty>}
      {data && data.lists.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>List</th><th>Done</th><th>Status</th><th>By</th><th /></tr></thead>
        <tbody>{data.lists.map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.done} / {l.total}</td><td>{l.status}</td><td className="small-muted">{l.ownerName}</td><td><button type="button" className="btn btn-sm" onClick={() => setOpen(l.id)}>{l.status === 'Done' ? 'See' : 'Carry on'}</button></td></tr>)}</tbody>
      </table></div>}
    </div>
  );
}

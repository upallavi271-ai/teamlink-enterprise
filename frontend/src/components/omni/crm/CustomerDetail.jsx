import { useCallback, useEffect, useState } from 'react';
import { Btn, GsModal, Pill, Banner, ConfirmModal } from '../ui.jsx';
import omni from '../omniApi.js';
import { initialsOf, timeLabel, dayLabel, errText } from './crmUtil.js';

// The customer detail box (the prototype's openCustomerDetail): the boxes, who may message them on each channel (Allowed / Not asked / Opted out, with the date and
// how), the timeline, and the buttons. Real data: GET /gs/crm/customers/:id. Opting out: the logins that may; recording permission: an Admin only.
const TONE = { allowed: 'live', not_asked: 'draft', opted_out: 'red', none: 'draft' };
const PREF = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', call: 'Call' };
const Kv = ({ k, children }) => <div className="kv-item"><small>{k}</small><b style={{ overflowWrap: 'anywhere' }}>{children || <span className="crm-empty">Empty</span>}</b></div>;

export default function CustomerDetail({ id, meta, canSend, onClose, onEdit, onChanged, go, toast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [erase, setErase] = useState(false);
  const load = useCallback(() => omni.get(`/gs/crm/customers/${id}`).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(errText(e, 'Could not open this person.'))), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (path, channel) => {
    setBusy(true); setErr('');
    try { const r = await omni.post(`/gs/crm/customers/${id}/${path}`, { channel, reason }); toast(r.ok || 'Saved.'); setReason(''); await load(); onChanged(); } catch (e) { setErr(errText(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const doErase = async () => {
    setErase(false);
    try { await omni.del(`/contacts/${id}`, { reason: reason || 'Removed at their request' }); toast('Removed. Only a do-not-contact marker stays.'); onChanged(); onClose(); } catch (e) { setErr(errText(e, 'It could not be removed.')); }
  };
  if (!d) return <GsModal title="Customer" onClose={onClose} width={640} foot={<Btn onClick={onClose}>Close</Btn>}>{err ? <Banner tone="error">{err}</Banner> : 'Loading…'}</GsModal>;
  const c = d.contact; const fl = d.flags;
  const fields = meta.fields.filter((f) => c.customValues[f.id] !== undefined);
  const cvText = (f) => { const v = c.customValues[f.id]; return Array.isArray(v) ? v.join(', ') : (f.type === 'checkbox' ? 'Yes' : String(v)); };
  const needReason = reason.trim().length < 5;
  return (
    <GsModal title="Customer" width={680} onClose={onClose} bodyStyle={{ maxHeight: '78vh' }}
      foot={<><Btn onClick={onClose}>Close</Btn>{fl.canEdit && <Btn onClick={() => onEdit(c)}>✎ Edit customer</Btn>}{canSend && <Btn primary onClick={() => { onClose(); go('console'); }}>＋ Send message</Btn>}</>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ width: 58, height: 58, borderRadius: 17, background: 'var(--green-3)', color: 'var(--green-2)', display: 'grid', placeItems: 'center', fontSize: 18, fontWeight: 900 }}>{initialsOf(c.name)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 19, overflowWrap: 'anywhere' }}>{c.name || 'No name'}</h2>
          <p style={{ margin: '3px 0 0', fontSize: 10, color: 'var(--muted)' }}>{[c.kinds.join(', '), c.city].filter(Boolean).join(' · ') || 'No kind or city yet'}{c.fromAts ? ' · Copied from the ATS' : ''}</p>
        </div>
        <Pill tone={c.channels.some((x) => x.state === 'allowed') ? 'live' : (c.channels.some((x) => x.state === 'opted_out') ? 'red' : 'draft')}>{c.channels.some((x) => x.state === 'allowed') ? 'Allowed' : (c.channels.some((x) => x.state === 'opted_out') ? 'Opted out' : 'Not asked')}</Pill>
      </div>
      <div className="kv-grid">
        <Kv k="Phone">{c.phone}</Kv><Kv k="Email">{c.email}</Kv><Kv k="Platform ID">{c.platformId}</Kv><Kv k="Source">{c.source}</Kv>
        <Kv k="Company">{c.company}</Kv><Kv k="Skills">{c.skills}</Kv><Kv k="Language">{c.language}</Kv><Kv k="Preferred channel">{PREF[c.preferredChannel] || ''}</Kv>
        <Kv k="Last reply">{c.lastReplyAt ? timeLabel(c.lastReplyAt) : ''}</Kv><Kv k="Owner">{c.ownerName}</Kv><Kv k="Added">{dayLabel(c.createdAt)}</Kv><Kv k="Notes">{c.notes}</Kv>
        {fields.map((f) => <Kv key={f.id} k={f.name}>{cvText(f)}</Kv>)}
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="panel-title" style={{ fontSize: 11 }}>Who may message them</div>
        <div className="table-scroll" style={{ marginTop: 8, border: '1px solid var(--line)', borderRadius: 10 }}>
          <table className="table" style={{ minWidth: 520 }}>
            <thead><tr><th>Channel</th><th>Now</th><th>When and how</th><th /></tr></thead>
            <tbody>
              {c.channels.map((ch) => (
                <tr key={ch.channel}>
                  <td>{ch.label}</td>
                  <td><Pill tone={TONE[ch.state]}>{ch.words}</Pill>{ch.problem && <> <Pill tone="warn">{ch.problem}</Pill></>}</td>
                  <td style={{ fontSize: 10, color: 'var(--muted)' }}>{ch.state === 'none' ? 'No address saved' : [ch.at ? dayLabel(ch.at) : '', ch.how].filter(Boolean).join(' · ') || (ch.state === 'not_asked' ? 'Permission has not been asked yet' : '')}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {ch.state !== 'none' && fl.canOptOut && ch.state !== 'opted_out' && <button type="button" className="tiny-btn" disabled={busy || needReason} title={needReason ? 'Write a reason below first' : undefined} onClick={() => act('opt-out', ch.channel)}>Opt out</button>}
                    {ch.state !== 'none' && fl.canOptIn && ch.state !== 'allowed' && <> <button type="button" className="tiny-btn" disabled={busy || needReason} title={needReason ? 'Write a reason below first' : undefined} onClick={() => act('opt-in', ch.channel)}>{ch.state === 'opted_out' ? 'Opt in again' : 'Record permission'}</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(fl.canOptOut || fl.canOptIn) ? (
          <div className="field" style={{ marginTop: 10 }}><label>WHY? (A FEW WORDS, SAVED IN THE HISTORY)</label><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Asked us on the phone to stop" /></div>
        ) : <p style={{ fontSize: 10, color: 'var(--muted)' }}>Your login can look but not change who is opted out.</p>}
        {!fl.canOptIn && fl.canOptOut && <p style={{ fontSize: 10, color: 'var(--muted)', margin: '6px 0 0' }}>Only an Admin can record permission.</p>}
      </div>
      {err && <Banner tone="error">{err}</Banner>}

      <div style={{ marginTop: 20 }}>
        <div className="panel-title" style={{ fontSize: 11 }}>Customer journey</div>
        {d.timeline.length ? <div className="timeline">{d.timeline.slice(0, 40).map((t, i) => <div className="timeline-row" key={i}><i className="timeline-dot" /><div><b style={{ fontSize: 10 }}>{t.text}</b><small>{timeLabel(t.at)}</small></div></div>)}</div> : <p style={{ fontSize: 10, color: 'var(--muted)' }}>Nothing has happened with this person yet.</p>}
      </div>
      {d.history.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="panel-title" style={{ fontSize: 11 }}>Permission history (never deleted)</div>
          <div className="table-scroll" style={{ marginTop: 8, maxHeight: 180 }}>
            <table className="table" style={{ minWidth: 420 }}><tbody>{d.history.map((h) => <tr key={h.id}><td style={{ whiteSpace: 'nowrap' }}>{dayLabel(h.at)}</td><td>{h.channelLabel}</td><td>{h.action === 'opt_in' ? 'Allowed' : (h.action === 'opt_out' ? 'Opted out' : 'Removed')}</td><td style={{ color: 'var(--muted)', fontSize: 10 }}>{h.evidence || h.how}</td></tr>)}</tbody></table>
          </div>
        </div>
      )}
      {fl.canErase && <div style={{ marginTop: 18 }}><button type="button" className="tiny-btn" onClick={() => setErase(true)}>Remove this person for good</button></div>}
      {erase && <ConfirmModal title="Remove this person for good?" text="Their details are wiped. Only a do-not-contact marker stays so they are never messaged again. Write a reason in the box above first (or it will say: removed at their request)." yes="Remove for good" danger onYes={doErase} onNo={() => setErase(false)} />}
    </GsModal>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import Combo from '../../components/Combo.jsx';

// ---------------------------------------------------------------------------
// Administration -> Step timing -> "Joinings and drops" (Admin only): who is told, and how, when a candidate JOINS, when a joined candidate
// DROPS, and when the client DECIDES about a replacement; the standard replacement period; whether HR sees the client placements.
// Email only leaves when "Notification emails" (Attendance -> Who gets told) is ON; bells and tasks always happen.
// The wording of the emails is edited in Company Setup -> Message templates (Candidate joined, Joined candidate dropped, Client decided about a
// replacement, Joining welcome, Drop notice). Server: routes/joinDrop.js /settings.
// ---------------------------------------------------------------------------
const WAY_WORDS = { bell: 'Bell', email: 'Email', whatsapp: 'WhatsApp' };

export default function JoinDropSettings() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/join-drop/settings').then((r) => { setD(r.data); setForm(JSON.parse(JSON.stringify(r.data.settings))); }).catch(() => setD(null));
  }, []);
  if (!d || !form) return null;
  const flip = (m, p, w) => setForm((f) => ({ ...f, [m]: { ...f[m], [p]: { ...f[m][p], [w]: !f[m][p][w] } } }));
  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/join-drop/settings', form);
      setForm(JSON.parse(JSON.stringify(r.data.settings)));
      setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusy(false); }
  }
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Joinings and drops</h3>
        {d.emailsOn ? <StatusChip status="Emails are on" tone="green" /> : <StatusChip status="Emails are off: only bells and tasks go" tone="yellow" />}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div style={{ padding: '8px 18px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="small-muted">
          Tick who is told when a candidate joins, when a joined candidate drops, and when the client answers about a replacement. The client is not told about their own answer.
          The candidate&apos;s drop notice is off by default because it is sensitive: the HR head can still send it by hand from the drop screen. An automatic candidate message goes only when there is a valid reason, an address with consent, and an approved message.
        </div>
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="error-text">{err}</div>}
        {['join', 'drop', 'decision'].map((m) => (
          <div key={m}>
            <b>{d.momentWords[m]}</b>
            <div className="tbl-wrap" style={{ marginTop: 6 }}>
              <table>
                <thead><tr><th>Who</th>{(m === 'decision' ? ['bell', 'email'] : ['bell', 'email', 'whatsapp']).map((w) => <th key={w}>{WAY_WORDS[w]}</th>)}</tr></thead>
                <tbody>
                  {d.parties[m].map((p) => {
                    const ways = p === 'candidate' ? ['email', 'whatsapp'] : ['bell', 'email'];
                    return (
                      <tr key={p}>
                        <td>{d.partyWords[p]}</td>
                        {(m === 'decision' ? ['bell', 'email'] : ['bell', 'email', 'whatsapp']).map((w) => (
                          <td key={w}>{ways.includes(w) ? <input type="checkbox" checked={!!form[m][p][w]} onChange={() => flip(m, p, w)} aria-label={`${d.partyWords[p]} ${WAY_WORDS[w]}`} /> : <span className="small-muted">-</span>}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <label className="field" style={{ minWidth: 260 }}>
            <span>Standard replacement period (days), used only when a client has none of its own</span>
            <input type="number" min="1" max="730" value={form.defaultGuaranteeDays} onChange={(e) => setForm((f) => ({ ...f, defaultGuaranteeDays: Number(e.target.value) }))} />
          </label>
          <div style={{ minWidth: 300, maxWidth: 520 }}>
            <b>People who see Joining &amp; Drop (HR side)</b>
            <div className="small-muted">Only these people see the joinings and drops of client placements (names, dates and reasons: never phone, email or pay). They are the &quot;HR&quot; that is told, and they review and send the candidate drop notice. Every other HR login sees none of it and is told none of it.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' }}>
              {(form.hrPeople || []).map((c) => {
                const n = (d.hrPeopleNames || []).find((x) => x.code === c) || (d.peopleOptions || []).find((x) => x.code === c);
                return (
                  <span key={c} className="skillpill" style={{ whiteSpace: 'normal' }}>
                    {n && n.name ? `${n.name} (${c})` : c}
                    <button type="button" className="close-x" aria-label={`Remove ${c}`} style={{ marginLeft: 6 }} onClick={() => setForm((f) => ({ ...f, hrPeople: f.hrPeople.filter((x) => x !== c) }))}>×</button>
                  </span>
                );
              })}
              {(form.hrPeople || []).length === 0 && <span className="small-muted">Nobody is on the list, so nobody on the HR side sees or is told anything.</span>}
            </div>
            <Combo value="" onChange={(e) => { const c = e.target.value; if (c) setForm((f) => ({ ...f, hrPeople: [...new Set([...(f.hrPeople || []), c])] })); }}>
              <option value="">Add a person (type a name to search)</option>
              {(d.peopleOptions || []).filter((p) => !(form.hrPeople || []).includes(String(p.code).toUpperCase())).map((p) => <option key={p.code} value={String(p.code).toUpperCase()}>{`${p.name} (${p.code}${p.department ? `, ${p.department}` : ''})`}</option>)}
            </Combo>
          </div>
        </div>
        <div className="small-muted">A drop inside the replacement period always opens one &quot;Find a replacement&quot; task for the recruiter at once. Only the BDE team, a team lead or an Admin can cancel it.</div>
      </div>
    </div>
  );
}

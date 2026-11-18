import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// ADMIN SWITCHES for the clients / billing depth (audit 2026-11-18). Super Admin / Admin. Every switch that tells people something starts OFF.
//   Desk BDEs see            all clients of their desk (as always) or only the clients assigned to them
//   Client approval          a client requirement waits for the client to confirm it in the portal before it goes live
//   Renewal reminders        a daily bell to the BDE of an agreement that is Upcoming / Due / Expired
//   Overdue reminders        a bell to the owner BDE of an overdue invoice (once per invoice per 3 days); a second switch also mails the client
//   Payment approval         a receipt recorded by an Accountant waits for an Admin or another Accountant
// Backend: routes/clientDepth.js (/api/ats-clients/settings), routes/billingDepth.js (/api/ats-billing/settings).
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;

function Switch({ checked, onChange, label, note, disabled }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span><b>{label}</b><div className="small-muted">{note}</div></span>
    </label>
  );
}

export default function R3Settings() {
  const [c, setC] = useState(null);
  const [b, setB] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get('/ats-clients/settings').then((r) => setC(r.data)).catch(() => setC(null));
    api.get('/ats-billing/settings').then((r) => setB(r.data)).catch(() => setB(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!c || !b) return null;
  const save = async (fn, ok) => { setBusy(true); setMsg(null); try { await fn(); load(); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: err(e, 'Could not save.') }); } finally { setBusy(false); } };
  const preview = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/ats-billing/overdue-reminders/run', { dryRun: true });
      setMsg({ ok: true, text: r.data.enabled ? `If it ran now: ${r.data.owner.length} owner BDE reminder(s) and ${r.data.client.length} client mail(s). Nothing was sent.` : 'The reminders are OFF, so nothing would be sent.' });
    } catch (e) { setMsg({ ok: false, text: err(e, 'Could not check.') }); } finally { setBusy(false); }
  };
  return (
    <section className="card" style={{ padding: 16, marginBottom: 14 }}>
      <h2 style={{ margin: 0 }}>Clients, billing and renewals</h2>
      <p className="small-muted">Switches that tell people something start OFF. You turn them on when you are ready. Every change is written to the audit log.</p>
      {msg && <div className={`crx-flash ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      <div style={{ padding: '6px 0' }}>
        <b>Desk BDEs see</b>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={c.deskBdeSees} disabled={busy || !c.mayEdit} aria-label="Desk BDEs see" onChange={(e) => save(() => api.put('/ats-clients/settings', { deskBdeSees: e.target.value }), 'Saved. It applies to each BDE on their next screen load.')}>
            {c.deskChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="small-muted">Right now: {c.deskNote}</div>
      </div>
      <Switch checked={c.clientApproval} disabled={busy} onChange={(v) => save(() => api.put('/ats-clients/settings', { clientApproval: v }), v ? 'A client requirement now waits for the client to confirm it.' : 'Requirements go live as before.')} label="Client approval before a requirement goes live" note="When ON, activating a client's requirement asks the client to confirm it in their portal first. Internal requirements are not affected." />
      <Switch checked={c.renewalReminders} disabled={busy} onChange={(v) => save(() => api.put('/ats-clients/settings', { renewalReminders: v }), v ? 'Renewal reminders are ON.' : 'Renewal reminders are OFF.')} label="Agreement renewal reminders to the BDE" note="A bell to the assigned BDE (else the client's Owner BDE) when an agreement becomes Upcoming (60 days), Due (30 days) and Expired. Once per stage." />
      <Switch checked={b.overdueReminders} disabled={busy} onChange={(v) => save(() => api.put('/ats-billing/settings', { overdueReminders: v }), v ? 'Overdue reminders are ON.' : 'Overdue reminders are OFF.')} label="Overdue payment reminders to the owner BDE" note="A bell to the BDE who looks after the client, once per overdue invoice every 3 days." />
      <Switch checked={b.remindClient} disabled={busy || !b.overdueReminders} onChange={(v) => save(() => api.put('/ats-billing/settings', { remindClient: v }), v ? 'The client\'s finance contact is also mailed.' : 'Clients are not mailed.')} label="Also mail the client's finance contact" note="Needs the switch above. Uses the Finance contact (else the billing contact) of the client. Mail follows the usual e-mail settings." />
      <Switch checked={b.paymentApproval} disabled={busy} onChange={(v) => save(() => api.put('/ats-billing/settings', { paymentApproval: v }), v ? 'Receipts recorded by an Accountant now wait for approval.' : 'Receipts are recorded at once.')} label="Payment approval" note="An Accountant's receipt waits as pending; an Admin or another Accountant approves it (the person who recorded cannot). An Admin's own receipt is recorded at once." />
      <button type="button" className="btn btn-sm" disabled={busy} onClick={preview}>Show who the overdue reminders would reach now</button>
    </section>
  );
}

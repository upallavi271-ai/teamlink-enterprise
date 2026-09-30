import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../../components/proto.jsx';

// ---------------------------------------------------------------------------
// Attendance → Check-in Methods → "Late & missing-punch alerts" (HR settings).
// Server: backend/src/utils/attendanceAlerts.js (GET / PUT /attendance/alerts).
// TODAY ONLY, never backfilled: nothing from before the go-live moment, no
// imported days, no relieved / exited employees, no test users.
// ---------------------------------------------------------------------------
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

export default function AlertSettings() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.get('/attendance/alerts')
      .then((r) => { setData(r.data); setDraft(r.data.settings); })
      .catch((e) => setErr(e.response?.data?.error || 'Could not load the alert settings.'));
  }
  useEffect(load, []);

  if (err && !data) return <div className="notice red" style={{ marginTop: 16 }}>{err}</div>;
  if (!data || !draft) return null;
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const p = data.preview || {};

  async function save() {
    setSaving(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/attendance/alerts', {
        inApp: draft.inApp, email: draft.email, graceMinutes: Number(draft.graceMinutes),
        checkOutBufferMinutes: Number(draft.checkOutBufferMinutes), missingCheckInAfterMinutes: Number(draft.missingCheckInAfterMinutes),
        digestTime: draft.digestTime,
      });
      setData((d) => ({ ...d, ...r.data })); setDraft(r.data.settings); setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); } finally { setSaving(false); }
  }

  const num = (k, label, hint) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" min="0" value={draft[k]} onChange={(e) => set(k, e.target.value)} style={{ maxWidth: 140 }} />
      <div className="small-muted" style={{ fontSize: 11.5 }}>{hint}</div>
    </div>
  );

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Late & missing-punch alerts">
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.55 }}>
          Checked every {data.intervalMinutes || 5} minutes, for <b>today only</b>. The employee is told in-app and / or by email; their reporting
          manager and HR get <b>one digest per day</b> at the digest time. One alert per person per event per day. Never sent for days before
          these alerts went live ({fmt(data.goLiveAt)}), for imported (old HRMS) days, for relieved / exited employees or for test users. If no
          punch at all has arrived today from anyone (the device feed is down), missing check-ins are held back.
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 16, height: 16, minHeight: 0 }} checked={!!draft.inApp} onChange={(e) => set('inApp', e.target.checked)} /> In-app notifications
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 16, height: 16, minHeight: 0 }} checked={!!draft.email} onChange={(e) => set('email', e.target.checked)} /> Emails
            {!data.emailConfigured && <span className="small-muted">(email is not configured under Administration → Integrations — nothing will be sent)</span>}
          </label>
        </div>
        <div className="grid-2">
          {num('graceMinutes', 'Grace after shift start (minutes)', 'Late login = first check-in after shift start + this.')}
          {num('checkOutBufferMinutes', 'Check-out buffer after shift end (minutes)', 'Missing check-out = checked in, no check-out by shift end + this.')}
          {num('missingCheckInAfterMinutes', 'Missing check-in after shift start (minutes)', 'No punch by shift start + this, on a working day (not a holiday, weekly off or leave).')}
          <div className="field">
            <label>Digest time</label>
            <input type="time" value={draft.digestTime} onChange={(e) => set('digestTime', e.target.value)} style={{ maxWidth: 140 }} />
            <div className="small-muted" style={{ fontSize: 11.5 }}>When managers and HR get the day&apos;s summary.</div>
          </div>
        </div>
        {msg && <div className="notice">{msg}</div>}
        {err && <div className="notice red">{err}</div>}
        <div className="small-muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          <b>Right now ({p.today}):</b> {p.events || 0} event(s) — late {p.byType?.late || 0}, missing check-out {p.byType?.missingOut || 0},
          missing check-in {p.byType?.missingIn || 0}{p.duplicates ? `; ${p.duplicates} already alerted` : ''}
          {p.feedSilent ? ' · no punch has arrived today yet, so missing check-ins are held back' : ''}. Last sweep: {fmt(data.lastRun)}.
          {(p.list || []).length > 0 && (
            <div style={{ marginTop: 4 }}>{p.list.slice(0, 20).map((x) => `${x.employeeCode} ${x.name} — ${x.type}${x.time ? ` (${x.time})` : ''}`).join(' · ')}</div>
          )}
        </div>
      </div>
    </Panel>
  );
}

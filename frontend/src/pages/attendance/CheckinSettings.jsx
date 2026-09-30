import { useEffect, useState } from 'react';
import api from '../../api';
import { PanelPad, TwoCol } from '../../components/proto.jsx';
import './attendance-self.css';

// ---------------------------------------------------------------------------
// HRMS-24 §4 / §5 settings, under Check-in Methods.
//   DayRules         (Attendance policy, `configure`) — how a past working day
//                    with no check-in reads, and the weekly offs.
//   GeofenceSettings (Super Admin only) — office location + radius for web /
//                    mobile check-in, and the face-match threshold.
// ---------------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function DayRules({ canEdit }) {
  const [policy, setPolicy] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/attendance/policy').then((r) => setPolicy(r.data)).catch(() => {}); }, []);
  if (!policy) return null;
  const offs = new Set(String(policy.weeklyOffDays ?? '0,6').split(',').filter((x) => x !== '').map(Number));

  async function save(patch) {
    setMsg(''); setErr('');
    try {
      const r = await api.put('/attendance/policy', patch);
      setPolicy(r.data); setMsg('Saved.');
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); }
  }
  const toggle = (d) => {
    const next = new Set(offs); if (next.has(d)) next.delete(d); else next.add(d);
    save({ weeklyOffDays: [...next].sort().join(',') });
  };

  return (
    <PanelPad>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>Missing check-in / check-out rule</h3>
      <div className="field">
        <label>A past working day with no check-in is marked</label>
        <select disabled={!canEdit} value={policy.missingCheckInRule || 'Missing Check-In'} onChange={(e) => save({ missingCheckInRule: e.target.value })}>
          <option>Missing Check-In</option>
          <option>Absent</option>
        </select>
      </div>
      <div className="field">
        <label>Weekly off days</label>
        <div className="att-days">
          {DAYS.map((d, i) => (
            <label key={d} className="att-day">
              <input type="checkbox" disabled={!canEdit} checked={offs.has(i)} onChange={() => toggle(i)} /> {d}
            </label>
          ))}
        </div>
      </div>
      <div className="small-muted" style={{ fontSize: 11.5 }}>
        Checked in but never checked out (day over) is always <b>Missing Check-Out</b>; checked out with no check-in is <b>Missing Check-In</b>.
        The same rule applies to every employee, whatever their position — TL, STL, HR, Assistant Manager, Manager and Super Admin included.
      </div>
      {msg && <div className="small-muted" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="error-text">{err}</div>}
    </PanelPad>
  );
}

function GeofenceSettings() {
  const [g, setG] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/attendance/geofence').then((r) => setG(r.data)).catch((e) => setErr(e.response?.data?.error || '')); }, []);
  if (!g) return err ? <PanelPad><div className="error-text">{err}</div></PanelPad> : null;

  async function save(e) {
    e.preventDefault();
    setMsg(''); setErr(''); setBusy(true);
    try {
      const r = await api.put('/attendance/geofence', {
        geofenceEnabled: !!g.geofenceEnabled,
        officeLatitude: g.officeLatitude === '' ? null : g.officeLatitude,
        officeLongitude: g.officeLongitude === '' ? null : g.officeLongitude,
        geofenceRadiusM: g.geofenceRadiusM,
        faceMatchThreshold: g.faceMatchThreshold,
      });
      setG(r.data); setMsg('Saved.');
    } catch (e2) { setErr(e2.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }
  function useHere() {
    setErr('');
    if (!navigator.geolocation) { setErr('This browser cannot share a location.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setG((x) => ({ ...x, officeLatitude: Number(p.coords.latitude.toFixed(6)), officeLongitude: Number(p.coords.longitude.toFixed(6)) })),
      () => setErr('Location access was refused.'),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  }

  return (
    <PanelPad>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>Web / mobile check-in — geofence &amp; face match (Super Admin)</h3>
      <form onSubmit={save}>
        <label className="att-day" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={!!g.geofenceEnabled} onChange={(e) => setG({ ...g, geofenceEnabled: e.target.checked })} />
          {' '}Only allow check-in / check-out near the office
        </label>
        <div className="grid-2">
          <div className="field"><label>Office latitude</label><input type="number" step="any" value={g.officeLatitude ?? ''} onChange={(e) => setG({ ...g, officeLatitude: e.target.value })} /></div>
          <div className="field"><label>Office longitude</label><input type="number" step="any" value={g.officeLongitude ?? ''} onChange={(e) => setG({ ...g, officeLongitude: e.target.value })} /></div>
          <div className="field"><label>Radius (metres)</label><input type="number" min="20" value={g.geofenceRadiusM ?? 200} onChange={(e) => setG({ ...g, geofenceRadiusM: e.target.value })} /></div>
          <div className="field">
            <label>Face-match threshold (0.30 strict – 0.60 lenient)</label>
            <input type="number" step="0.01" min="0.3" max="0.6" value={g.faceMatchThreshold ?? 0.45} onChange={(e) => setG({ ...g, faceMatchThreshold: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={useHere}>Use my current location</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        A reading counts as inside when it is within the radius, allowing for up to 100 m of the device&apos;s own stated accuracy.
        Desktop browsers often locate by Wi-Fi or IP and can be hundreds of metres off, so keep the radius realistic.
      </div>
      {msg && <div className="small-muted" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="error-text">{err}</div>}
    </PanelPad>
  );
}

export default function CheckinSettings({ canEditPolicy, isSuperAdmin }) {
  return (
    <div className="att-self">
      <TwoCol style={{ gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
        <DayRules canEdit={canEditPolicy} />
        {isSuperAdmin ? <GeofenceSettings /> : <div />}
      </TwoCol>
    </div>
  );
}

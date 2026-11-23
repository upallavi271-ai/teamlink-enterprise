import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { hasAtsWork } from '../utils/useAtsAlerts';

// ---------------------------------------------------------------------------
// PROFILE -> "Client updates" (2026-11-23): my own mail preference for the client-update and interview mails
// (utils/atsUpdates.js). The pop-ups and the dashboard list stay; only the mails stop. An Admin can also switch
// themselves off the client updates altogether. GET / PUT /api/ats-updates/me.
// ---------------------------------------------------------------------------
export default function MyUpdatePrefs({ style }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const on = hasAtsWork(user);
  useEffect(() => { if (on) api.get('/ats-updates/me').then((r) => setD(r.data)).catch(() => setD(null)); }, [on]);
  if (!on || !d) return null;
  const save = async (patch) => {
    setMsg('');
    try { const r = await api.put('/ats-updates/me', patch); setD({ ...d, ...r.data }); setMsg('Saved.'); } catch { setMsg('Could not save. Try again.'); }
  };
  return (
    <div className="card section" style={{ maxWidth: 520, ...style }} data-testid="my-update-prefs">
      <h3 style={{ marginTop: 0, fontSize: 15 }}>Client updates and interview mails</h3>
      <label style={{ display: 'block', margin: '6px 0' }}>
        <input type="checkbox" checked={!!d.muteMail} onChange={(e) => save({ muteMail: e.target.checked })} /> Mute my mails (the pop-ups and the dashboard list stay)
      </label>
      {d.admin && (
        <label style={{ display: 'block', margin: '6px 0' }}>
          <input type="checkbox" checked={!!d.adminOff} onChange={(e) => save({ adminOff: e.target.checked })} /> I am an Admin: do not send me client updates at all
        </label>
      )}
      {msg && <span className="small-muted">{msg}</span>}
    </div>
  );
}

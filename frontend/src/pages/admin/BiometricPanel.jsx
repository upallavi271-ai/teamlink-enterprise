import { useEffect, useState } from 'react';
import api from '../../api';
import './BiometricPanel.css';

// ---------------------------------------------------------------------------
// Biometric device card (Administration -> Integrations -> Connections).
//
// REAL, not Demo: the eSSL unit pushes to /iclock on the TeamLink server
// (backend/src/routes/iclock.js). "Connected" means a heartbeat arrived in the
// last few minutes — it is read from the device's lastSeenAt, never set by a
// button. Refreshes every 30 s while the page is open.
// ---------------------------------------------------------------------------

function ago(iso) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} day(s) ago`;
}

const STATE_CLASS = { Connected: 'active', Offline: 'rejected', Inactive: 'rejected' };

export default function BiometricPanel({ onConfigure, onChanged }) {
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState(null);
  const [pick, setPick] = useState({});
  const [msg, setMsg] = useState({ ok: '', err: '' });
  const [, tick] = useState(0);

  function load() {
    api.get('/admin/integrations/biometric/status').then((r) => setData(r.data)).catch(() => setData({ error: true }));
  }
  useEffect(() => {
    load();
    const poll = setInterval(load, 30000);
    const clock = setInterval(() => tick((n) => n + 1), 5000); // keeps "x s ago" honest
    return () => { clearInterval(poll); clearInterval(clock); };
  }, []);

  useEffect(() => {
    if (data?.unmapped?.length && !employees) {
      api.get('/employees').then((r) => setEmployees(r.data || [])).catch(() => setEmployees([]));
    }
  }, [data, employees]);

  async function map(pin, employeeId) {
    setMsg({ ok: '', err: '' });
    try {
      const r = await api.put('/admin/integrations/biometric/map', { pin, employeeId: employeeId || null });
      setMsg({ ok: employeeId ? `PIN ${pin} mapped — ${r.data.applied} waiting punch(es) added to attendance.` : `PIN ${pin} unmapped.`, err: '' });
      load(); onChanged?.();
    } catch (err) {
      setMsg({ ok: '', err: err.response?.data?.error || 'Could not map that PIN.' });
    }
  }

  async function linkMatches() {
    const n = data.codeMatches.length;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Link ${n} device user(s) to the employee with the same code? Their waiting punches go into attendance.`)) return;
    setMsg({ ok: '', err: '' });
    try {
      const r = await api.post('/admin/integrations/biometric/link-matches');
      setMsg({ ok: `${r.data.linked} device user(s) linked — ${r.data.applied} waiting punch(es) added to attendance.`, err: '' });
      load(); onChanged?.();
    } catch (err) {
      setMsg({ ok: '', err: err.response?.data?.error || 'Could not link the matches.' });
    }
  }

  async function fetchUsers() {
    setMsg({ ok: '', err: '' });
    try {
      await api.post('/admin/integrations/biometric/fetch-users');
      setMsg({ ok: 'User-list request queued. The device picks it up on its next heartbeat (within about 30 s) and sends every enrolled PIN and name.', err: '' });
      load();
    } catch (err) {
      setMsg({ ok: '', err: err.response?.data?.error || 'Could not queue the request.' });
    }
  }

  if (!data) return null;
  if (data.error) return <div className="card section bio-card"><div className="error-text">Could not load the biometric device status.</div></div>;

  const d = data.device;
  if (!d) {
    return (
      <div className="card section bio-card">
        <h3>Biometric device</h3>
        <p className="small-muted">No device saved yet.</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={onConfigure}>Configure device</button>
      </div>
    );
  }

  const lastBeat = d.lastSeenAt ? `${new Date(d.lastSeenAt).toLocaleString()} (${ago(d.lastSeenAt)})` : 'No heartbeat received yet';
  const info = d.info || {};
  const q = data.userQuery;

  return (
    <div className="card section bio-card">
      <div className="bio-head">
        <div>
          <div className="bio-model">{d.model}</div>
          <div className="bio-proto">{d.protocol}</div>
        </div>
        <span className={`status ${STATE_CLASS[d.state] || 'pending'} bio-state`}>{d.state}</span>
      </div>

      <dl className="bio-facts">
        <div><dt>Serial</dt><dd>{d.serialNumber}</dd></div>
        <div><dt>Port</dt><dd>{d.port ?? '—'}</dd></div>
        <div><dt>Last heartbeat</dt><dd>{lastBeat}</dd></div>
        <div><dt>Endpoint</dt><dd className="bio-mono">{d.endpoint}</dd></div>
        <div><dt>Status</dt><dd>{d.status}</dd></div>
        <div><dt>Punches today / total</dt><dd>{data.counts.today} / {data.counts.total}</dd></div>
        {d.lastSeenIp && <div><dt>Last call from</dt><dd className="bio-mono">{d.lastSeenIp}</dd></div>}
        {d.lastPunchAt && <div><dt>Last punch</dt><dd>{d.lastPunchAt}</dd></div>}
        {info.firmware && <div><dt>Firmware</dt><dd>{info.firmware}</dd></div>}
        {info.users != null && <div><dt>Users / fingerprints on device</dt><dd>{info.users} / {info.fingerprints ?? '—'}</dd></div>}
      </dl>

      {d.state === 'Waiting for device' && (
        <div className="notice amber bio-note"><div>
          Saved. TeamLink has not received a call from serial <b>{d.serialNumber}</b> yet. On the device, set
          Comm → Cloud Server (ADMS) to server <b>{(() => { try { return new URL(d.endpoint).hostname; } catch { return d.endpoint; } })()}</b>,
          port <b>{d.port}</b>, and make sure the server forwards <span className="bio-mono">/iclock</span> on that port to TeamLink.
          The status turns Connected on the first heartbeat.
        </div></div>
      )}
      {d.state === 'Offline' && (
        <div className="notice amber bio-note">
          No heartbeat for more than {Math.round(d.heartbeatWindowSeconds / 60)} minutes. Check the device&apos;s power and network.
        </div>
      )}

      <div className="bio-actions">
        <button type="button" className="btn btn-sm" onClick={onConfigure}>Configure →</button>
        <button type="button" className="btn btn-sm" onClick={load}>Refresh</button>
        <button type="button" className="btn btn-sm" onClick={fetchUsers}>Fetch users from device</button>
      </div>
      <div className="small-muted bio-hint">
        {data.deviceUsers} user(s) from the device known to TeamLink.
        {q && ` Last user-list request: ${q.returnedAt
          ? `answered ${ago(q.returnedAt)} (code ${q.returnCode})`
          : q.sentAt ? `sent ${ago(q.sentAt)}, waiting for the device's reply`
            : 'queued — goes to the device on its next heartbeat'}.`}
      </div>

      {msg.ok && <div className="notice bio-note">{msg.ok}</div>}
      {msg.err && <div className="error-text">{msg.err}</div>}

      {data.codeMatches?.length > 0 && (
        <div className="bio-matches">
          <div className="bio-matches-head">
            <div>
              <b>{data.codeMatches.length} device user(s) have a PIN that is exactly an employee code</b>
              <div className="small-muted">e.g. PIN {data.codeMatches[0].pin} = {data.codeMatches[0].employeeName} ({data.codeMatches[0].employeeCode}). Check the names below, then link them all at once.</div>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={linkMatches}>Link all {data.codeMatches.length}</button>
          </div>
          <details className="bio-details">
            <summary>Show the {data.codeMatches.length} match(es)</summary>
            <div className="tbl-wrap"><table>
              <thead><tr><th>PIN</th><th>Name on device</th><th>TeamLink employee</th><th>Department</th><th>Waiting punches</th></tr></thead>
              <tbody>
                {data.codeMatches.map((m) => (
                  <tr key={m.pin}>
                    <td className="bio-mono">{m.pin}</td>
                    <td>{m.deviceName || '—'}</td>
                    <td>{m.employeeName} <span className="cell-muted">({m.employeeCode})</span></td>
                    <td className="cell-muted">{m.department || '—'}</td>
                    <td>{m.waitingPunches}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </details>
        </div>
      )}

      {data.unmapped.length > 0 && (
        <>
          <div className="section-label bio-sub">Device users not yet linked to an employee ({data.unmapped.length})</div>
          <div className="small-muted bio-hint">Their punches are kept and are added to attendance as soon as the PIN is linked.</div>
          <div className="tbl-wrap"><table>
            <thead><tr><th>PIN</th><th>Name on device</th><th>Punches</th><th>Last punch</th><th>Employee</th><th /></tr></thead>
            <tbody>
              {data.unmapped.map((u) => (
                <tr key={u.pin}>
                  <td className="bio-mono">{u.pin}</td>
                  <td>{u.deviceName || '—'}</td>
                  <td>{u.punches}</td>
                  <td className="cell-muted">{u.lastPunchAt}</td>
                  <td>
                    <select value={pick[u.pin] ?? u.suggestedEmployeeId ?? ''} onChange={(e) => setPick((p) => ({ ...p, [u.pin]: e.target.value }))}>
                      <option value="">{employees ? 'Choose employee…' : 'Loading…'}</option>
                      {(employees || []).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employeeCode})</option>)}
                    </select>
                  </td>
                  <td><button type="button" className="btn btn-sm btn-primary" disabled={!(pick[u.pin] ?? u.suggestedEmployeeId)} onClick={() => map(u.pin, pick[u.pin] ?? u.suggestedEmployeeId)}>Link</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      {data.mapped.length > 0 && (
        <details className="bio-details">
          <summary>Linked employees ({data.mapped.length})</summary>
          <div className="tbl-wrap"><table>
            <thead><tr><th>PIN</th><th>Employee</th><th>Department</th><th>Name on device</th><th /></tr></thead>
            <tbody>
              {data.mapped.map((e) => (
                <tr key={e.id}>
                  <td className="bio-mono">{e.biometricPin}</td>
                  <td>{e.name} <span className="cell-muted">({e.employeeCode})</span></td>
                  <td className="cell-muted">{e.department || '—'}</td>
                  <td className="cell-muted">{e.deviceName || '—'}</td>
                  <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => map(e.biometricPin, null)}>Unlink</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </details>
      )}

      {data.recent.length > 0 && (
        <details className="bio-details">
          <summary>Latest punches from the device</summary>
          <div className="tbl-wrap"><table>
            <thead><tr><th>When</th><th>PIN</th><th>Employee</th></tr></thead>
            <tbody>
              {data.recent.map((p) => (
                <tr key={`${p.pin}-${p.punchAt}`}>
                  <td>{p.punchAt}</td>
                  <td className="bio-mono">{p.pin}</td>
                  <td>{p.employee || <span className="cell-muted">Not linked{p.deviceName ? ` · ${p.deviceName}` : ''}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </details>
      )}

      {data.unknownDevices.length > 0 && (
        <div className="notice amber bio-note"><div>
          A device with an unregistered serial called TeamLink:{' '}
          {data.unknownDevices.map((u) => `${u.serial} (${u.ip || 'unknown IP'}, ${ago(u.at)})`).join('; ')}.
          If that is your device, correct the Serial under Configure.
        </div></div>
      )}
    </div>
  );
}

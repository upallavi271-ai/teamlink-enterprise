import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import './IntegrationHealth.css';

// ---------------------------------------------------------------------------
// INTEGRATION HEALTH — the "Health" tab of Administration → Integrations
// (change list 2026-10-03 §16; spec §E). One card per connection: Job Portal
// sync, Email, eSSL attendance device, AI (Claude) credits. Each says what is
// wrong in plain words, groups the failures by reason, gives a Fix hint and a
// Retry button.
//
// NOTHING IS RETRIED OR SENT UNTIL A PERSON PRESSES THE BUTTON, and each
// button asks first. GET /api/admin/integration-health is read-only.
// ---------------------------------------------------------------------------
const TONE = { green: 'green', blue: 'blue', orange: 'amber', red: 'red' };
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function IntegrationHealthPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});

  const load = () => api.get('/admin/integration-health')
    .then((r) => { setData(r.data); setError(''); })
    .catch((e) => setError(e.response?.data?.error || 'Could not check the connections.'));
  useEffect(() => { load(); }, []);

  async function retry(item) {
    const r = item.retry;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${r.label}?${r.note ? `\n\n${r.note}` : ''}`)) return;
    setBusy(item.id);
    setNotes((n) => ({ ...n, [item.id]: null }));
    try {
      const res = await api.post(r.url, {});
      const d = res.data || {};
      const msg = d.message
        || (item.id === 'jobportal' ? (d.portal && d.portal.ok === false ? `Still not working: ${d.portal.error}` : `Sync done — ${d.synced ?? 0} synced, ${d.failed ?? 0} failed.`) : null)
        || (d.result ? String(d.result) : null)
        || (d.reply ? 'Claude answered — AI is working.' : 'Done.');
      setNotes((n) => ({ ...n, [item.id]: { ok: true, text: msg } }));
    } catch (e) {
      setNotes((n) => ({ ...n, [item.id]: { ok: false, text: e.response?.data?.error || 'It still does not work.' } }));
    } finally {
      setBusy('');
      load();
    }
  }

  if (error && !data) return <div className="notice red">{error}</div>;
  if (!data) return <div className="small-muted">Checking the connections…</div>;

  return (
    <div className="ihealth">
      <div className="ihealth-top">
        <b>{data.problems ? `${plural(data.problems, 'connection needs', 'connections need')} attention` : 'All connections look fine'}</b>
        <span className="small-muted">{`Checked ${when(data.checkedAt)}. Nothing is retried or sent until you press a button.`}</span>
      </div>
      {data.sandbox && <div className="notice amber">This is the test copy. Nothing here contacts the Job Portal, the mail server or Claude.</div>}
      <div className="ihealth-grid">
        {data.items.map((it) => (
          <div key={it.id} className={`ihealth-card is-${it.tone}`}>
            <div className="ihealth-head">
              <h3>{it.name}</h3>
              <StatusChip tone={TONE[it.tone] || 'grey'}>{it.status}</StatusChip>
            </div>
            <p className="ihealth-msg">{it.message}</p>

            {it.id === 'jobportal' && it.failedTotal > 0 && (
              <div className="ihealth-sub">
                <div className="ihealth-count">
                  {`${plural(it.failedTotal, 'failed try', 'failed tries')} in the log`}
                  {it.lastGoodAt ? ` · ${it.failedSinceLastGood} since the last good sync (${when(it.lastGoodAt)})` : ' · no good sync yet'}
                </div>
                <ul className="ihealth-groups">
                  {it.groups.map((g) => (
                    <li key={g.key}><b>{g.count}</b> {g.reason} <span className="small-muted">{`${when(g.first)} – ${when(g.last)}`}</span></li>
                  ))}
                </ul>
                {it.jobsNotOnPortal.length > 0 && (
                  <div className="small-muted">
                    {'Not on the portal: '}
                    {it.jobsNotOnPortal.slice(0, 5).map((j, i) => <span key={j.id}>{i ? ', ' : ''}<Link to={`/requirements/${j.id}`}>{j.reqCode || j.title}</Link></span>)}
                  </div>
                )}
                <div className="small-muted">{it.note}</div>
              </div>
            )}

            {it.id === 'email' && it.failedTotal > 0 && (
              <div className="ihealth-sub">
                <ul className="ihealth-groups">
                  {it.groups.map((g) => <li key={g.key}><b>{g.count}</b> {g.reason}</li>)}
                </ul>
                <ul className="ihealth-items">
                  {it.items.slice(0, 5).map((m) => (
                    <li key={m.id}>
                      {m.candidateId ? <Link to={`/candidates/${m.candidateId}`}>{m.candidate}</Link> : m.candidate}
                      <span className="small-muted">{` · ${m.what} · ${when(m.at)}${m.hasEmailNow ? ' · has an email now' : ''}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {it.id === 'email' && it.server && <div className="small-muted">{`Mail server ${it.server.host}${it.server.port ? `:${it.server.port}` : ''}`}</div>}

            {it.id === 'biometric' && it.device && (
              <div className="ihealth-sub small-muted">
                {`Device ${it.device.serial} · server ${it.device.host || '—'} · port ${it.device.port || '—'}`}
                {it.device.lastSeenAt ? ` · last call ${when(it.device.lastSeenAt)}` : ' · never called'}
                {it.lastError && <div>{`Last check: ${it.lastError.text}`}</div>}
                {it.unknownDevices && it.unknownDevices.length > 0 && <div>{`A device with another serial called: ${it.unknownDevices.map((u) => u.serial).join(', ')} — check the serial.`}</div>}
              </div>
            )}

            {it.id === 'ai' && it.lastTest && <div className="small-muted">{`Last test ${when(it.lastTest.at)}`}</div>}

            {it.tone !== 'green' && it.fix && (
              <div className="ihealth-fix">
                <b>How to fix</b>
                {it.hints && it.hints.length ? <ul>{it.hints.map((h) => <li key={h}>{h}</li>)}</ul> : <p>{it.fix}</p>}
              </div>
            )}

            {it.retry && (
              <button type="button" className="btn btn-sm" disabled={busy === it.id} onClick={() => retry(it)}>
                {busy === it.id ? 'Working…' : it.retry.label}
              </button>
            )}
            {notes[it.id] && <div className={notes[it.id].ok ? 'ihealth-ok' : 'error-text'} role="status">{notes[it.id].text}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

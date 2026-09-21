import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { JOB_PORTAL_URL } from '../JobPortalRedirect.jsx';

// Integrations — the prototype's integrationsView() (line 10367).
//
// Two separate screens on their own tabs: the connection catalogue for every
// outside channel (adminIntegrationsCatalog, line 10314) and the Job Portal
// synchronisation (integJobPortalView, line 10394), which has its own status,
// controls and sync log.
//
// WHAT IS REAL. Two channels really talk to the outside world and are badged
// "Live": Email (SMTP), which nodemailer uses to send candidate messages, and
// the AI Assistant (Anthropic), which answers free-text questions. Everything
// else is still Demo / Simulated and keeps saying so. The Job Portal is real
// but its synchronisation is not; see the SYNC SEAM note below.
//
// SECRETS ARE NEVER ON THIS PAGE. The server sends non-secret fields and, for
// each credential field, a masked hint ("••••••a91f") in `secretHints` — never
// the value. A blank credential box therefore means "leave the stored one
// alone", which is what the placeholder says; typing "-" clears it.

function stateClass(state) {
  if (state === 'Connected') return 'active';
  if (state === 'Expired' || state === 'Reconnect Required') return 'rejected';
  return 'pending';
}

export default function Integrations() {
  const [tab, setTab] = useState('connections');
  const [data, setData] = useState(null);
  const [jp, setJp] = useState(null);
  const [configuring, setConfiguring] = useState(null); // { channel, values }
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mail, setMail] = useState(null); // GET /admin/integrations/email/status
  const [testTo, setTestTo] = useState('');
  const [sending, setSending] = useState(false);

  function load() {
    api.get('/admin/integrations').then((res) => setData(res.data)).catch(() => setError('Could not load the integration catalogue.'));
    api.get('/admin/integrations/job-portal').then((res) => setJp(res.data)).catch(() => setJp(null));
    api.get('/admin/integrations/email/status').then((res) => setMail(res.data)).catch(() => setMail(null));
  }
  useEffect(load, []);

  // Send test email — the proof that the SMTP configuration works. On failure
  // it shows the PROVIDER's own error, not a generic one.
  async function sendTestEmail() {
    setError(''); setNotice(''); setSending(true);
    try {
      const res = await api.post('/admin/integrations/email/test-message', { to: testTo.trim() });
      setNotice(`Test email accepted by the provider for ${res.data.to}${res.data.providerRef ? ` (ref ${res.data.providerRef})` : ''}.`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'The test email could not be sent.');
      load();
    } finally { setSending(false); }
  }

  async function run(fn, message) {
    setError(''); setNotice('');
    try { const r = await fn(); if (message) setNotice(typeof message === 'function' ? message(r) : message); load(); return r; } catch (err) {
      setError(err.response?.data?.error || 'That action could not be completed.');
      return null;
    }
  }

  async function openHistory(channel) {
    setError('');
    try {
      const res = await api.get(`/admin/integrations/${channel.id}/history`);
      setHistory(res.data);
    } catch (err) { setError('Could not load the sync history.'); }
  }

  async function saveConfigure() {
    const ok = await run(
      () => api.put(`/admin/integrations/${configuring.channel.id}/configure`, { values: configuring.values }),
      `${configuring.channel.name} connected (configuration saved — no live call made).`,
    );
    if (ok) setConfiguring(null);
  }

  if (!data) return <div className="page-head"><h1>Integrations</h1></div>;

  const jpStats = data.jobPortal;
  const jpBadge = jpStats.failed
    ? { cls: 'rejected', txt: `${jpStats.failed} failed` }
    : { cls: jp && jp.status === 'Connected' ? 'active' : 'pending', txt: jp ? jp.status : 'Not Connected' };

  return (
    <div>
      <div className="page-head">
        <div><h1>Integrations</h1>
          <div className="page-sub">{tab === 'connections'
            ? 'Every outside channel the platform talks to — messaging, email, calling, scheduling, job boards, storage, finance and developer access.'
            : 'Synchronisation between the TeamLink Job Portal and this ATS — status, controls and the record of every sync.'}</div></div>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        <div className={`tab${tab === 'connections' ? ' active' : ''}`} onClick={() => setTab('connections')}>
          Connections — all channels <span className="status active">{data.connected} of {data.total}</span>
        </div>
        <div className={`tab${tab === 'jobportal' ? ' active' : ''}`} onClick={() => setTab('jobportal')}>
          Job Portal Synchronisation <span className={`status ${jpBadge.cls}`}>{jpBadge.txt}</span>
        </div>
      </div>

      <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '-4px 0 14px' }}>
        {tab === 'jobportal'
          ? "Synchronisation only — what has come across from the Job Portal, the sync controls and the log of every record. The Job Portal's own connection and credentials sit on the Connections tab, under Job Boards."
          : 'The connection side of every channel — switch one on, add its credentials, test it or disconnect it. What actually syncs from the TeamLink Job Portal is on the Job Portal Synchronisation tab.'}
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      {tab === 'connections' && mail && <EmailPanel
        mail={mail}
        testTo={testTo}
        setTestTo={setTestTo}
        sending={sending}
        onSend={sendTestEmail}
        onRunWorker={() => run(
          () => api.post('/admin/integrations/email/worker/run'),
          (r) => `Worker: ${r.data.sent} sent, ${r.data.retried} retrying, ${r.data.failed} failed, ${r.data.held} held with no provider.`,
        )}
      />}

      {tab === 'connections' ? (
        <div className="panel panel-pad">
          <h3 style={{ fontSize: 14, marginBottom: 2 }}>Integrations</h3>
          <div className="cell-muted" style={{ fontSize: 12.5 }}>
            {data.connected} of {data.total} channels connected. Enable a channel and add its credentials to switch it on for every product.
          </div>
          {data.groups.map((g) => {
            const items = data.channels.filter((c) => c.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="section-label" style={{ margin: '16px 0 4px' }}>{g}</div>
                {items.map((c) => (
                  <div key={c.id}>
                    <div className="assign-row">
                      <span style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flex: 1, minWidth: 260 }}>
                        <span style={{ fontSize: 17, lineHeight: 1.2 }}>{c.glyph}</span>
                        <span><b>{c.name}</b><br />
                          <span className="cell-muted" style={{ fontSize: 11.5 }}>{c.desc}</span></span>
                      </span>
                      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span className={`status ${stateClass(c.state)}`}>{c.state}</span>
                        {c.live
                          ? <span className="status active" title="This channel really contacts the provider.">Live</span>
                          : <span className="status pending">Demo</span>}
                        {c.lastTestResult && (
                          <span
                            className="cell-muted"
                            title={`Last test ${c.lastTest} — ${c.lastTestResult}`}
                            style={{ fontSize: 11, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            Last test {c.lastTestResult}
                          </span>
                        )}
                        {c.lastSync && (
                          <span className="cell-muted" style={{ fontSize: 11 }}>
                            Last sync {c.lastSync} · {c.recordsSynced} ok / {c.recordsFailed} failed
                          </span>
                        )}
                        {c.state === 'Connected' ? (
                          <>
                            {!c.live && (
                              <button className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${c.id}/sync`), (r) => `${c.name}: ${r.data.synced} synced, ${r.data.failed} failed (Demo).`)}>Sync Now</button>
                            )}
                            <button className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${c.id}/test`), (r) => `${c.name}: ${r.data.result}`)}>Test</button>
                            {c.id === 'ai-claude' && (
                              <button className="btn btn-sm" onClick={() => run(() => api.post('/admin/integrations/ai-claude/test-message'), (r) => `Claude replied: “${r.data.reply}” (${r.data.model}).`)}>Ask the model</button>
                            )}
                            <button className="btn btn-sm btn-ghost" onClick={() => run(() => api.post(`/admin/integrations/${c.id}/disconnect`), `${c.name} disconnected.`)}>Disconnect</button>
                          </>
                        ) : (
                          <button className="btn btn-sm btn-primary" onClick={() => run(() => api.post(`/admin/integrations/${c.id}/connect`), `${c.name} connected — Demo / Simulated, no live API call was made.`)}>
                            {c.state === 'Not Connected' ? 'Connect' : 'Reconnect'}
                          </button>
                        )}
                        <button className="btn btn-sm" onClick={() => openHistory(c)}>History</button>
                        {/* A secret field opens EMPTY — the server never sends
                            the value, only a masked hint, and blank means
                            "keep what is stored". */}
                        <button className="btn btn-sm" onClick={() => setConfiguring({
                          channel: c,
                          values: Object.fromEntries(c.fields.map(([label, ph]) => [
                            label,
                            (c.secretFields || []).includes(label) ? '' : (c.values[label] || ph || ''),
                          ])),
                        })}
                        >Configure →</button>
                      </span>
                    </div>
                    {c.error && <div className="cell-muted" style={{ padding: '0 18px 10px', fontSize: 11.5, color: 'var(--red)' }}>{c.error}</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <JobPortalTab jp={jp} stats={jpStats} run={run} />
      )}

      {configuring && (
        <Modal
          title={`${configuring.channel.glyph} ${configuring.channel.name}`}
          onClose={() => setConfiguring(null)}
          foot={<>
            <button className="btn" onClick={() => setConfiguring(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveConfigure}>Save &amp; Connect</button>
          </>}
        >
          <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>{configuring.channel.desc}</div>
          {configuring.channel.fields.map(([label, placeholder]) => {
            const secret = (configuring.channel.secretFields || []).includes(label);
            const hint = (configuring.channel.secretHints || {})[label];
            return (
              <div className="field" key={label}>
                <label>{label}{secret && <span className="small-muted"> · stored encrypted, never shown</span>}</label>
                <input
                  type={secret ? 'password' : 'text'}
                  autoComplete={secret ? 'new-password' : 'off'}
                  placeholder={secret ? (hint ? `${hint} — leave blank to keep, “-” to clear` : placeholder || '') : (placeholder || '')}
                  value={configuring.values[label] || ''}
                  onChange={(e) => setConfiguring((c) => ({ ...c, values: { ...c.values, [label]: e.target.value } }))}
                />
              </div>
            );
          })}
          <div className="cell-muted" style={{ fontSize: 11.5, fontStyle: 'italic' }}>
            {configuring.channel.live
              ? 'Credentials are encrypted on the server before they are stored and are never sent back to this page. This channel really contacts the provider once it is connected.'
              : 'Configuration only — this channel is Demo / Simulated and never contacts the provider.'}
          </div>
        </Modal>
      )}

      {history && (
        <Modal
          title={`Sync History — ${history.channel}`}
          size="wide"
          onClose={() => setHistory(null)}
          foot={<button className="btn btn-primary" onClick={() => setHistory(null)}>Close</button>}
        >
          <div className="notice amber">
            Demo / Simulated — these runs were produced locally. No external API was contacted.
          </div>
          {history.history.length ? (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>Action</th><th>By</th><th>Result</th><th>Synced</th><th>Failed</th><th>Entities</th></tr></thead>
              <tbody>
                {history.history.map((h, i) => (
                  <tr key={i}>
                    <td className="cell-muted">{h.at}</td>
                    <td>{h.action}</td>
                    <td className="cell-muted">{h.by || '—'}</td>
                    <td><span className={`status ${/Fail|error/.test(String(h.result)) ? 'rejected' : 'active'}`}>{h.result}</span></td>
                    <td className="cell-muted">{h.synced || 0}</td>
                    <td className="cell-muted">{h.failed || 0}</td>
                    <td className="cell-muted">{h.entities || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <div className="empty-mini">No sync runs yet.</div>}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email (SMTP) — the live channel's own card.
//
// It says three things a catalogue row cannot: whether email is actually
// switched on right now, what the sending queue looks like, and — the whole
// point — a Send test email box that proves the configuration end to end and
// reports the provider's real error when it does not.
// ---------------------------------------------------------------------------
function EmailPanel({ mail, testTo, setTestTo, sending, onSend, onRunWorker }) {
  const q = mail.queue || {};
  return (
    <div className="card section" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>
            Email sending{' '}
            <span className={`status ${mail.configured ? 'active' : 'pending'}`}>
              {mail.configured ? 'Live' : 'Not configured'}
            </span>
          </h3>
          {mail.configured ? (
            <>
              <div className="kv"><span className="k">SMTP</span><span>{mail.host}:{mail.port} · {mail.secure ? 'SSL/TLS' : 'STARTTLS or plain'}</span></div>
              <div className="kv"><span className="k">Authenticated as</span><span>{mail.username || 'no credentials — open relay'}</span></div>
              <div className="kv"><span className="k">Envelope sender</span><span>{mail.fromName ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress}</span></div>
              <div className="kv"><span className="k">Header From</span><span>the sending employee&rsquo;s own address, with Reply-To to match</span></div>
            </>
          ) : (
            <div className="cell-muted" style={{ fontSize: 12.5 }}>{mail.reason}</div>
          )}
          <div className="kv"><span className="k">Credential encryption</span>
            <span>{mail.secretKeyConfigured
              ? <>On — AES-256-GCM, key from <code>{mail.secretKeyEnvVar}</code></>
              : <span style={{ color: 'var(--red)' }}>Off — set <code>{mail.secretKeyEnvVar}</code> in the backend environment before saving a password</span>}
            </span>
          </div>
        </div>

        <div style={{ minWidth: 260, flex: '0 1 300px' }}>
          <div className="field">
            <label>Send test email to</label>
            <input type="email" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" disabled={sending || !testTo.trim()} onClick={onSend}>
              {sending ? 'Sending…' : 'Send test email'}
            </button>
            <button className="btn btn-sm" onClick={onRunWorker}>Run sending worker</button>
          </div>
        </div>
      </div>

      <div className="statbar" style={{ marginTop: 14 }}>
        <div className="statitem"><div className="n">{q.queued || 0}</div><div className="l">Queued</div></div>
        <div className="statitem"><div className="n">{q.retrying || 0}</div><div className="l">Retrying</div></div>
        <div className="statitem"><div className="n">{q.sent || 0}</div><div className="l">Sent</div></div>
        <div className="statitem"><div className="n">{q.failed || 0}</div><div className="l">Failed</div></div>
        <div className="statitem"><div className="n">{q.notSentNoProvider || 0}</div><div className="l">Held — no provider</div></div>
      </div>

      {/* .notice is display:flex, so its content goes in ONE child element or
          every <strong> becomes its own column. */}
      <div className="notice amber" style={{ marginTop: 14 }}>
        <span>
          A candidate message is marked <strong>Sent</strong> only when the SMTP provider accepted it, and the row
          keeps the provider&rsquo;s own message reference. Delivery to the inbox is <strong>not</strong> confirmed —
          there is no bounce or delivery webhook yet. Messages go out with the sending employee&rsquo;s address in
          the <code>From</code> header over an authenticated envelope sender, which needs SPF, DKIM and DMARC on
          that employee&rsquo;s domain or the mail will be spam-foldered. SMS and WhatsApp still have no provider
          and their rows stay &ldquo;recorded, not transmitted&rdquo;.
        </span>
      </div>
    </div>
  );
}

// The Job Portal Synchronisation tab — five KPIs, the connection card with its
// controls, and the Date / Entity / Status / Reason sync log.
function JobPortalTab({ jp, stats, run }) {
  const [showConfig, setShowConfig] = useState(false);
  if (!jp) return <div className="empty-mini">Job Portal synchronisation is not available.</div>;
  const connected = jp.status === 'Connected';
  return (
    <>
      <div className="statbar">
        <div className="statitem"><div className="n">{stats.candidates}</div><div className="l">Candidates synced</div></div>
        <div className="statitem"><div className="n">{stats.applications}</div><div className="l">Applications synced</div></div>
        <div className="statitem"><div className="n">{stats.requirements}</div><div className="l">Requirements synced</div></div>
        <div className="statitem"><div className="n">{stats.needsMapping}</div><div className="l">Needing mapping</div></div>
        <div className="statitem"><div className="n">{stats.failed}</div><div className="l">Failed records</div></div>
      </div>

      <div className="card section" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="kv"><span className="k">Connection</span>
              <span><span className={`conn-dot ${connected ? 'ok' : 'fail'}`} />{jp.status}</span></div>
            <div className="kv"><span className="k">Last Sync</span><span>{jp.lastSync}</span></div>
            <div className="kv"><span className="k">Sync Status</span>
              <span><span className={`status ${connected ? 'active' : 'pending'}`}>{jp.lastSyncResult}</span></span></div>
            <div className="kv"><span className="k">Mode</span>
              <span>Portal served by this platform at <code>/job-portal/</code>; its own data store is the browser</span></div>
            <div className="kv"><span className="k">Real-time channel</span>
              <span><span className="conn-dot fail" />Not connected — the portal does not yet post applications into this ATS</span></div>
            <div className="kv"><span className="k">Sync direction</span><span>None yet — Sync re-reads this ATS only</span></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 190 }}>
            <button className="btn btn-primary btn-sm" onClick={() => run(() => api.post('/admin/integrations/job-portal/sync'), (r) => `${r.data.synced} synced, ${r.data.failed} failed.`)}>Sync</button>
            <a className="btn btn-sm" href={JOB_PORTAL_URL} target="_blank" rel="noreferrer">Open Job Portal ↗</a>
            <button className="btn btn-sm" onClick={() => run(() => api.post('/admin/integrations/jobportal/test'), (r) => `TeamLink Job Portal: ${r.data.result}`)}>Test Connection</button>
            <button className="btn btn-sm" onClick={() => setShowConfig(true)}>Configure</button>
            {stats.needsMapping > 0 && (
              <Link className="btn btn-sm" to="/candidates">Mapping queue ({stats.needsMapping}) →</Link>
            )}
          </div>
        </div>
        {/* Sync and Open Job Portal are two different actions and must stay
            that way. Neither one does the other's job. */}
        <div className="notice amber" style={{ marginTop: 14 }}>
          <strong>Open Job Portal</strong> opens the real TeamLink Job Portal (served at <code>/job-portal/</code>)
          in a new tab. It never triggers a sync.
          <br />
          <strong>Sync</strong> stays on this page: today it re-reads this ATS&apos;s own records — candidates and
          applications already carrying a portal source — refreshes the counters above and writes a sync-log row.
          It does <strong>not</strong> yet move data between this ATS and the Job Portal: the portal is the
          customer&apos;s self-contained app and keeps its jobs, candidates, applications and resumes in the
          browser&apos;s local storage, not in this database. A real two-way sync needs the portal to read and write
          through an API instead — pushing new, updated and closed requirements out, and bringing applications,
          candidate profiles, resumes, stage changes and source back in.
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Sync Logs</h3>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Date</th><th>Entity</th><th>Status</th><th>Reason</th><th /></tr></thead>
          <tbody>
            {jp.syncLog.map((l) => (
              <tr key={l.id}>
                <td>{l.date}</td>
                <td>{l.entity}</td>
                <td><span className={`status ${l.status === 'Success' ? 'active' : 'rejected'}`}>{l.status}</span></td>
                <td>{l.reason || '—'}</td>
                <td>{l.status === 'Failed' && (
                  <button className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/job-portal/log/${l.id}/retry`), 'Retried.')}>Retry</button>
                )}</td>
              </tr>
            ))}
            {jp.syncLog.length === 0 && (
              <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>No sync has run yet.</td></tr>
            )}
          </tbody>
        </table></div>
      </div>

      {showConfig && (
        <Modal
          title="Integration Configuration"
          onClose={() => setShowConfig(false)}
          foot={<button className="btn btn-primary" onClick={() => setShowConfig(false)}>Close</button>}
        >
          <div className="notice amber">
            The Job Portal is served by this platform itself, at <code>/job-portal/</code>, so there is no
            external API endpoint, API key or webhook to configure here. There is also nothing to configure for
            synchronisation yet: the portal stores its own data in the browser, so no record crosses between it
            and this database.
          </div>
          <div className="kv"><span className="k">Connection type</span><span>Internal — served by this platform at /job-portal/</span></div>
          <div className="kv"><span className="k">Portal data store</span><span>Browser local storage (the portal&apos;s own), not this database</span></div>
          <div className="kv"><span className="k">Sync direction</span><span>None yet — Sync re-reads this ATS only</span></div>
          <div className="kv"><span className="k">Sync frequency</span><span>Manual (&quot;Sync&quot;)</span></div>
          {/* ---- SYNC SEAM ------------------------------------------------
              A real Enterprise ↔ Portal sync attaches here. It needs, in this
              order: (1) the portal reading its job list from GET /api/public/jobs
              instead of its built-in DATA.jobs, so new/updated/closed
              requirements flow out; (2) the portal POSTing applications and
              candidate profiles (with resume upload) to this API instead of
              writing tl_job_portal_state_v1; (3) stage/status changes flowing
              back out so the candidate dashboard shows real progress. Until
              those exist, this screen must keep saying so rather than
              implying a live channel. -------------------------------------- */}
        </Modal>
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import JpModal from './JpModal.jsx';
import { when } from './jpKit.js';
import NaukriShineMailboxes from './NaukriShineMailboxes.jsx';
import './jobpublish.css';
import './naukriShineMailboxes.css';
import './portalSettings.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > "Job Portal settings"  (founder, 2026-10-29)
// The Job Portal admin page's Integrations module, managed from TeamLink. The settings stay in the Job Portal
// and are used by it (server: routes/portalAdmin.js + routes/portalMailboxes.js, through the portal bridge).
//   Job sites            Naukri / Shine / Indeed by the platform's authorized API or feed (portal "Integrations")
//   Naukri & Shine mailboxes   the response mailboxes and their recruiters (portal "Naukri & Shine Email Import")
//   Notifications        the portal's Email (SMTP), SMS and WhatsApp (portal "Integrations" -> channels)
//   AI screening         the standard screening questions and their weight (portal "AI Settings")
// Credentials go to the server once and never come back: a saved one shows only "saved" and its last characters.
// ---------------------------------------------------------------------------
const SUBTABS = [
  ['sites', 'Job sites'], ['mailboxes', 'Naukri & Shine mailboxes'], ['notify', 'Notifications (Email · SMS · WhatsApp)'], ['screening', 'AI screening'],
];
const errOf = (e) => {
  const x = e && e.response && e.response.data && e.response.data.error;
  return { message: (x && x.message) || (typeof (e && e.response && e.response.data && e.response.data.error) === 'string' ? e.response.data.error : '') || (e && e.message) || 'That did not work. Please try again.', details: (x && x.details) || {} };
};
const genToken = () => {
  const b = new Uint8Array(24);
  window.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

function SecretField({ id, label, info, value, onChange, clear, onClear, gen }) {
  const saved = info && info.saved;
  return (
    <div className="nsm-f">
      <label htmlFor={id}>{label}</label>
      <div className="ps-secret">
        <input id={id} type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={saved ? `•••• saved${info.hint ? ` (…${info.hint})` : ''}, type to replace` : 'Not set'} />
        {gen && <button type="button" className="btn btn-sm" onClick={() => onChange(genToken())}>Generate</button>}
      </div>
      {saved && onClear && <label className="ps-inline"><input type="checkbox" checked={!!clear} onChange={(e) => onClear(e.target.checked)} /> Clear the saved value</label>}
      {gen && value && <span className="nsm-hint">Copy it now: after Save it is never shown again.</span>}
    </div>
  );
}

/* ======================= Job sites ======================= */
const CONN_LABEL = { api: 'Partner API (TeamLink calls the platform)', xml_feed: "XML job feed (the platform pulls TeamLink's signed feed)", partner_feed: "Partner feed (the platform pulls TeamLink's signed feed)" };
const AUTH_LABEL = { bearer: 'API key as Bearer token', api_key_header: 'API key in a header', basic: 'Client ID + secret (Basic)', oauth2_client_credentials: 'OAuth 2.0 client credentials' };
const NEEDS = {
  NAUKRI: "Needs Naukri's authorized employer/partner API access (Naukri RMS or a Naukri partner agreement). Naukri issues the API endpoint and the credentials.",
  SHINE: 'Needs a Shine.com employer/partner API agreement. Shine issues the API endpoint and the credentials.',
  INDEED: "Needs Indeed to accept the Job Portal's XML job feed (Indeed's feed / partner programme) or an Indeed partner API agreement. Indeed confirms listings; nothing is marked Posted on Indeed before it does.",
};
const COUNT_WORDS = [['posted', 'Posted'], ['awaiting_confirmation', 'Awaiting confirmation'], ['pending', 'Pending'], ['failed', 'Failed'], ['integration_required', 'Waiting for this integration']];
const countsText = (c) => COUNT_WORDS.filter(([k]) => c && c[k]).map(([k, l]) => `${l}: ${c[k]}`).join(' · ') || 'No jobs ticked yet';
const formOf = (i) => ({
  enabled: !!i.enabled, connectionType: i.connectionType || '', endpointUrl: i.endpointUrl || '', authType: i.authType || '',
  accountId: i.accountId || '', clientId: i.clientId || '', tokenUrl: i.tokenUrl || '', statusUrl: i.statusUrl || '',
  apiKeyHeader: (i.options && i.options.apiKeyHeader) || '', paths: { ...((i.options && i.options.paths) || {}) },
  secrets: { apiKey: '', clientSecret: '', feedToken: '', callbackSecret: '' }, clear: {},
});

function JobSiteCard({ i, onChanged }) {
  const [f, setF] = useState(() => formOf(i));
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState(null);
  const [events, setEvents] = useState(null);
  useEffect(() => { setF(formOf(i)); }, [i]);
  const d = i.destination; const id = (k) => `ps-${d}-${k}`;
  const set = (k) => (e) => { const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e; setF((o) => ({ ...o, [k]: v })); };
  const setSecret = (k) => (v) => setF((o) => ({ ...o, secrets: { ...o.secrets, [k]: v } }));
  const setClear = (k) => (v) => setF((o) => ({ ...o, clear: { ...o.clear, [k]: v } }));
  const t = f.connectionType; const isApi = t === 'api'; const isFeed = t === 'xml_feed' || t === 'partner_feed';

  async function run(kind) {
    setBusy(kind); setRes(null);
    try {
      if (kind === 'save') {
        const paths = {}; ['validate', 'publish', 'job'].forEach((k) => { if (String(f.paths[k] || '').trim()) paths[k] = f.paths[k].trim(); });
        const secrets = {}; Object.entries(f.secrets).forEach(([k, v]) => { if (v) secrets[k] = v; });
        const body = {
          enabled: f.enabled, connectionType: t || null,
          endpointUrl: isApi ? f.endpointUrl : '', authType: isApi ? (f.authType || null) : null, tokenUrl: isApi ? f.tokenUrl : '',
          statusUrl: isFeed ? f.statusUrl : '', accountId: f.accountId, clientId: isApi ? f.clientId : '',
          options: { paths, apiKeyHeader: f.apiKeyHeader || undefined }, secrets, clearSecrets: Object.keys(f.clear).filter((k) => f.clear[k]),
        };
        const { data } = await api.put(`/portal-admin/job-sites/${encodeURIComponent(d)}`, body);
        const n = data.integration;
        setRes({ ok: true, text: `Saved.${n && n.ready ? ' Connected: waiting jobs are being published.' : n && n.blocker ? ` Not publishing yet: ${n.blocker}` : ''}` });
      } else if (kind === 'test') {
        const { data } = await api.post(`/portal-admin/job-sites/${encodeURIComponent(d)}/test`, {});
        setRes({ ok: !!data.ok, text: `${data.ok ? 'Test Connection passed' : 'Test Connection failed'}: ${data.message}` });
      } else {
        const { data } = await api.post(`/portal-admin/job-sites/${encodeURIComponent(d)}/publish-pending`, {});
        setRes({ ok: true, text: `${data.queued || 0} waiting job(s) sent through the publisher.${data.integration ? ` ${countsText(data.integration.counts)}` : ''}` });
      }
      onChanged();
    } catch (e) { setRes({ ok: false, text: errOf(e).message }); }
    setBusy('');
  }
  async function history(open) {
    if (!open || events) return;
    try { const { data } = await api.get(`/portal-admin/job-sites/${encodeURIComponent(d)}/events`); setEvents(data.events || []); } catch { setEvents([]); }
  }

  return (
    <section className="nsm-card ps-site" aria-labelledby={id('h')}>
      <div className="ps-head">
        <h3 id={id('h')}>{i.label}</h3>
        <span className={`nsm-chip ${i.ready ? 'ok' : 'warn'}`}>{i.ready ? 'Connected' : 'Integration Required'}</span>
      </div>
      <p className="jp-note" style={{ margin: 0 }}>{NEEDS[d] || 'Needs an authorized integration agreement with this platform.'}</p>
      {i.blocker ? <div className="jp-err" style={{ margin: 0 }}>Not publishing yet: {i.blocker}</div> : <div className="jp-ok" style={{ margin: 0 }}>Save &amp; Post publishes to {i.label} automatically.</div>}
      {!i.secretsReadable && <div className="jp-err" style={{ margin: 0 }}>The saved credentials cannot be read on the Job Portal server (INTEGRATION_SECRET_KEY missing or changed). Enter them again.</div>}
      <div className="nsm-grid">
        <div className="nsm-f"><label className="ps-inline ps-switch"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label><span className="nsm-hint">Off: nothing is sent to {i.label}.</span></div>
        <div className="nsm-f"><label htmlFor={id('conn')}>Connection type</label>
          <Combo id={id('conn')} value={t} onChange={set('connectionType')} placeholder="Choose">
            <option value="">Choose</option>
            {(i.connectionTypes || []).map((c) => <option key={c} value={c}>{CONN_LABEL[c] || c}</option>)}
          </Combo>
        </div>
      </div>
      {isApi && (
        <div className="nsm-grid">
          <div className="nsm-f ps-wide"><label htmlFor={id('ep')}>Authorized API endpoint (base URL)</label><input id={id('ep')} type="url" value={f.endpointUrl} onChange={set('endpointUrl')} placeholder={`https://… issued by ${i.label}`} /><span className="nsm-hint">The Job Portal calls only this address.</span></div>
          <div className="nsm-f"><label htmlFor={id('auth')}>Authentication</label>
            <Combo id={id('auth')} value={f.authType} onChange={set('authType')} placeholder="Choose">
              <option value="">Choose</option>
              {Object.entries(AUTH_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Combo>
          </div>
          <div className="nsm-f"><label htmlFor={id('acc')}>Account / employer ID</label><input id={id('acc')} value={f.accountId} onChange={set('accountId')} placeholder={`Issued by ${i.label}`} /></div>
          <div className="nsm-f"><label htmlFor={id('cid')}>Client ID</label><input id={id('cid')} value={f.clientId} onChange={set('clientId')} placeholder="For Basic or OAuth" /></div>
          <div className="nsm-f"><label htmlFor={id('tok')}>OAuth token URL</label><input id={id('tok')} type="url" value={f.tokenUrl} onChange={set('tokenUrl')} placeholder="https://… (OAuth only)" /></div>
          <div className="nsm-f"><label htmlFor={id('hdr')}>API key header name</label><input id={id('hdr')} value={f.apiKeyHeader} onChange={set('apiKeyHeader')} placeholder="X-Api-Key (header auth only)" /></div>
          <SecretField id={id('apiKey')} label="API key" info={i.secrets && i.secrets.apiKey} value={f.secrets.apiKey} onChange={setSecret('apiKey')} clear={f.clear.apiKey} onClear={setClear('apiKey')} />
          <SecretField id={id('clientSecret')} label="Client secret" info={i.secrets && i.secrets.clientSecret} value={f.secrets.clientSecret} onChange={setSecret('clientSecret')} clear={f.clear.clientSecret} onClear={setClear('clientSecret')} />
          <details className="ps-wide ps-adv"><summary>Advanced: API paths</summary>
            <div className="nsm-grid">
              {[['validate', 'Credential check (GET)', '/account'], ['publish', 'Create job (POST)', '/jobs'], ['job', 'One job (PUT / DELETE / GET)', '/jobs/{id}']].map(([k, l, ph]) => (
                <div className="nsm-f" key={k}><label htmlFor={id(`p-${k}`)}>{l}</label><input id={id(`p-${k}`)} value={f.paths[k] || ''} placeholder={ph} onChange={(e) => { const v = e.target.value; setF((o) => ({ ...o, paths: { ...o.paths, [k]: v } })); }} /></div>
              ))}
            </div>
          </details>
        </div>
      )}
      {isFeed && (
        <div className="nsm-grid">
          <SecretField id={id('feedToken')} label="Feed token (signs the feed URL)" info={i.secrets && i.secrets.feedToken} value={f.secrets.feedToken} onChange={setSecret('feedToken')} clear={f.clear.feedToken} onClear={setClear('feedToken')} gen />
          <div className="nsm-f"><label htmlFor={id('acc2')}>Publisher / account ID</label><input id={id('acc2')} value={f.accountId} onChange={set('accountId')} placeholder={`Issued by ${i.label}`} /></div>
          <div className="nsm-f"><label htmlFor={id('st')}>Status check URL (optional)</label><input id={id('st')} type="url" value={f.statusUrl} onChange={set('statusUrl')} placeholder={`https://… where ${i.label} reports listing status`} /><span className="nsm-hint">Without it, confirmation arrives through the signed callback.</span></div>
          <SecretField id={id('callbackSecret')} label="Callback signing secret" info={i.secrets && i.secrets.callbackSecret} value={f.secrets.callbackSecret} onChange={setSecret('callbackSecret')} clear={f.clear.callbackSecret} onClear={setClear('callbackSecret')} gen />
          <div className="nsm-f ps-wide"><span className="nsm-label">Give these to {i.label}</span>
            <span className="nsm-hint">Feed URL: <code>{i.feedUrl || `…/feeds/${d.toLowerCase()}.xml?token=<feed token>`}</code> (the full token is the one you typed; it is never shown again)</span>
            <span className="nsm-hint">Confirmation callback: <code>{i.callbackUrl}</code>, POST, signed with <code>X-TeamLink-Signature: sha256=&lt;HMAC of the body&gt;</code></span>
          </div>
        </div>
      )}
      <div className="jp-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run('save')}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => run('test')}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</button>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => run('pending')}>{busy === 'pending' ? 'Publishing…' : 'Publish waiting jobs now'}</button>
      </div>
      {res && <div className={res.ok ? 'jp-ok' : 'jp-err'} role={res.ok ? 'status' : 'alert'} style={{ margin: 0 }}>{res.text}</div>}
      <dl className="ps-facts">
        <dt>Last test</dt><dd>{i.lastTestAt ? `${i.lastTestOk ? '✅' : '❌'} ${when(i.lastTestAt)}${i.lastTestMessage ? ` · ${i.lastTestMessage}` : ''}` : 'never'}</dd>
        <dt>Last sync</dt><dd>{when(i.lastSyncAt) || '—'}</dd>
        <dt>Last error</dt><dd>{i.lastError ? `${i.lastError} (${when(i.lastErrorAt)})` : 'none'}</dd>
        <dt>Jobs</dt><dd>{countsText(i.counts)}</dd>
      </dl>
      <details className="ps-adv" onToggle={(e) => history(e.currentTarget.open)}><summary>Change history</summary>
        {!events ? <div className="nsm-hint">Loading…</div> : events.length ? events.map((e, n) => <div key={n} className="nsm-hint">{when(e.at)} · {e.event}{e.detail ? ` · ${e.detail}` : ''}</div>) : <div className="nsm-hint">No changes yet.</div>}
      </details>
    </section>
  );
}

function JobSites() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { const { data: d } = await api.get('/portal-admin/job-sites'); setData(d); setErr(''); } catch (e) { setErr(errOf(e).message); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!data && !err) return <div className="jp-note" role="status">Loading the job sites…</div>;
  if (!data) return <div><div className="jp-err" role="alert">{err}</div><button type="button" className="btn" onClick={load}>Try again</button></div>;
  const list = data.integrations || [];
  const own = list.filter((i) => i.kind === 'own'); const partners = list.filter((i) => i.kind !== 'own');
  return (
    <div className="nsm-wrap">
      <p className="jp-note" style={{ margin: 0 }}>Where the Job Portal&apos;s Save &amp; Post sends a job. Each job site needs an agreement with that platform and the API or feed credentials it issues. Without them a job ticked for it shows <b>Integration Required</b> and nothing is sent. No scraping and no browser automation: only the platform&apos;s authorized API or feed. (Posting from TeamLink requirements by login is on the Job portals tab.)</p>
      {data.secretKeyConfigured === false && <div className="jp-err" role="alert"><b>INTEGRATION_SECRET_KEY is not set on the Job Portal server.</b> Credentials cannot be saved until it is set (at least 16 characters).</div>}
      {err && <div className="jp-err" role="alert">{err}</div>}
      {own.length > 0 && (
        <section className="nsm-card">
          <h3 className="ps-h3">TeamLink systems</h3>
          <p className="jp-note" style={{ margin: 0 }}>Our own destinations. They work now and need no setup.</p>
          {own.map((i) => (
            <div key={i.destination} className="ps-own">
              <div><b>{i.label}</b> <span className="nsm-chip ok">Works now</span></div>
              <div className="nsm-hint">{countsText(i.counts)}</div>
              {i.feedUrl && <div className="nsm-hint">Public feed: <a href={i.feedUrl} target="_blank" rel="noopener noreferrer"><code>{i.feedUrl}</code></a>{i.rssUrl && <> · <a href={i.rssUrl} target="_blank" rel="noopener noreferrer"><code>{i.rssUrl}</code></a> (RSS)</>}</div>}
            </div>
          ))}
        </section>
      )}
      <div className="ps-sites">{partners.map((i) => <JobSiteCard key={i.destination} i={i} onChanged={load} />)}</div>
    </div>
  );
}

/* ======================= Notifications: Email / SMS / WhatsApp ======================= */
const CH_DEFS = {
  email: {
    icon: '✉️', title: 'Email (SMTP)', desc: 'Outbound email the Job Portal sends: candidate messages, logins, interview invitations and notifications.',
    fields: [
      { k: 'host', label: 'SMTP Host', ph: 'mail.tmlink.in' }, { k: 'port', label: 'Port', ph: '465' }, { k: 'fromAddress', label: 'From Address', ph: 'hr@tmlink.in' },
      { k: 'username', label: 'Username' }, { secret: true, label: 'Password / App Key' }, { k: 'encryption', label: 'Encryption', select: ['SSL', 'STARTTLS', 'None'] },
      { k: 'fromName', label: 'Default From Name', ph: 'TeamLink HR' },
    ],
  },
  sms: {
    icon: '💬', title: 'SMS Gateway', desc: 'Transactional SMS (MSG91, Fast2SMS or Twilio) for OTPs, links, interview alerts and bulk messages.',
    fields: [
      { k: 'provider', label: 'Provider', select: ['MSG91', 'Fast2SMS', 'Twilio'] }, { k: 'senderId', label: 'Sender ID (6 chars) / Twilio From Number', ph: 'TMLINK' },
      { secret: true, label: 'API Key / Auth Token' }, { k: 'twilioSid', label: 'Twilio Account SID', ph: 'Twilio only (AC…)', twilioOnly: true },
      { k: 'dltAgreement', label: 'DLT Template ID, Agreement Link', ph: 'vars: name, agreement no., link' }, { k: 'dltOtp', label: 'DLT Template ID, OTP', ph: 'vars: code, minutes' },
      { k: 'dltBulk', label: 'DLT Template ID, Bulk / General', ph: 'one var: the message' },
    ],
  },
  whatsapp: {
    icon: '🟢', title: 'WhatsApp Business', desc: 'WhatsApp Cloud API messages: approved templates; plain text only inside a 24-hour customer session.',
    fields: [
      { k: 'businessPhone', label: 'Business Phone Number', ph: '+91…' }, { k: 'phoneNumberId', label: 'Phone Number ID', ph: 'from Meta → WhatsApp → API Setup' },
      { k: 'businessId', label: 'WhatsApp Business ID' }, { secret: true, label: 'Permanent Access Token' }, { k: 'namespace', label: 'Template Namespace', ph: 'optional (legacy)' },
      { k: 'language', label: 'Template Language Code', ph: 'en' }, { k: 'templateAgreement', label: 'Template Name, Agreement Link', ph: 'body {{1}} name, {{2}} agreement no., {{3}} link' },
      { k: 'templateOtp', label: 'Template Name, OTP / Authentication', ph: 'authentication template, {{1}} code' }, { k: 'templateBulk', label: 'Template Name, Bulk / General', ph: 'body {{1}} = the message' },
    ],
  },
};

function ChannelCard({ c, onChanged, keyOk }) {
  const def = CH_DEFS[c.channel] || { icon: '•', title: c.label, desc: '', fields: [] };
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState(null);
  const [to, setTo] = useState('');
  const [modal, setModal] = useState(null);
  const [events, setEvents] = useState(null);
  const secretInfo = c.secrets && c.secrets[c.secretField];
  async function act(kind) {
    if (kind === 'disconnect' && !window.confirm(`Disconnect the Job Portal's ${def.title}? Nothing more is sent through it until it is connected again.`)) return;
    setBusy(kind); setRes(null);
    try {
      if (kind === 'test') {
        const { data } = await api.post(`/portal-admin/channels/${c.channel}/test`, { to });
        setRes({ ok: !!data.ok, text: data.message || (data.ok ? 'Test sent.' : 'The test failed.') });
      } else {
        await api.post(`/portal-admin/channels/${c.channel}/${kind}`, {});
        setRes({ ok: true, text: kind === 'connect' ? 'Connected.' : 'Disconnected.' });
      }
      onChanged();
    } catch (e) { setRes({ ok: false, text: errOf(e).message }); }
    setBusy('');
  }
  async function history(open) {
    if (!open || events) return;
    try { const { data } = await api.get(`/portal-admin/channels/${c.channel}/events`); setEvents(data.events || []); } catch { setEvents([]); }
  }
  return (
    <section className="nsm-card" aria-labelledby={`ps-ch-${c.channel}`}>
      <div className="ps-head">
        <span className="ps-ico" aria-hidden="true">{def.icon}</span>
        <h3 id={`ps-ch-${c.channel}`}>{def.title}</h3>
        <span className={`nsm-chip ${c.connected ? 'ok' : 'off'}`}>{c.status}</span>
        <span className={`nsm-chip ${c.mode === 'Live' ? 'run' : 'off'}`}>{c.mode}</span>
      </div>
      <p className="jp-note" style={{ margin: 0 }}>{def.desc}</p>
      {c.summary && <div className="nsm-hint">{c.summary}</div>}
      {c.usingEnvironment && <div className="nsm-hint">Not connected here: the Job Portal uses the settings in its server environment for this channel.</div>}
      {!c.secretsReadable && <div className="jp-err" style={{ margin: 0 }}>The saved secret cannot be read on the Job Portal server (INTEGRATION_SECRET_KEY missing or changed). Enter it again.</div>}
      {c.lastTest && <div className="nsm-hint">Last test {when(c.lastTest.at)}: {c.lastTest.ok ? '✅' : '❌'} {c.lastTest.message}</div>}
      <div className="jp-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setModal(true)}>Configure</button>
        {secretInfo && secretInfo.saved && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('connect')}>{c.connected ? 'Reconnect' : 'Connect'}</button>}
        {c.connected && <button type="button" className="btn btn-sm nsm-danger" disabled={!!busy} onClick={() => act('disconnect')}>Disconnect</button>}
      </div>
      <div className="ps-test">
        <label htmlFor={`ps-to-${c.channel}`} className="nsm-label">Send a real test message to</label>
        <div className="jp-row">
          <input id={`ps-to-${c.channel}`} value={to} onChange={(e) => setTo(e.target.value)} placeholder={c.channel === 'email' ? 'Your own email (leave empty)' : 'Mobile number, e.g. 98765 43210'} />
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('test')}>{busy === 'test' ? 'Sending…' : 'Test'}</button>
        </div>
      </div>
      {res && <div className={res.ok ? 'jp-ok' : 'jp-err'} role={res.ok ? 'status' : 'alert'} style={{ margin: 0 }}>{res.text}</div>}
      <details className="ps-adv" onToggle={(e) => history(e.currentTarget.open)}><summary>History</summary>
        {!events ? <div className="nsm-hint">Loading…</div> : events.length ? events.map((e, n) => <div key={n} className="nsm-hint">{when(e.at)} · {e.event}{e.detail ? ` · ${e.detail}` : ''}</div>) : <div className="nsm-hint">Nothing yet.</div>}
      </details>
      {modal && <ChannelDialog c={c} def={def} keyOk={keyOk} onClose={() => setModal(null)} onSaved={(text) => { setModal(null); setRes({ ok: true, text }); onChanged(); }} />}
    </section>
  );
}

function ChannelDialog({ c, def, keyOk, onClose, onSaved }) {
  const [cfg, setCfg] = useState(() => ({ ...(c.config || {}) }));
  const [secret, setSecret] = useState('');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const info = c.secrets && c.secrets[c.secretField];
  async function save() {
    setBusy(true); setErr('');
    try {
      const { data } = await api.put(`/portal-admin/channels/${c.channel}`, { config: cfg, secrets: { [c.secretField]: clear ? '-' : secret }, connect: true });
      onSaved(data.channel && data.channel.connected ? `${def.title} saved and connected.` : `${def.title} saved.`);
    } catch (e) { setErr(errOf(e).message); setSecret(''); setBusy(false); }
  }
  return (
    <JpModal title={`Configure ${def.title}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || keyOk === false} onClick={save}>{busy ? 'Saving…' : 'Save & Connect'}</button></>}>
      {err && <div className="jp-err" role="alert">{err}</div>}
      <p className="jp-note">{def.desc} The secret is stored encrypted on the Job Portal server and never shown again. Leave it empty to keep the saved one.</p>
      <div className="nsm-grid">
        {def.fields.filter((fd) => !fd.twilioOnly || cfg.provider === 'Twilio').map((fd) => (fd.secret ? (
          <SecretField key="secret" id={`ps-cfg-${c.channel}-secret`} label={fd.label} info={info} value={secret} onChange={setSecret} clear={clear} onClear={setClear} />
        ) : (
          <div className="nsm-f" key={fd.k}><label htmlFor={`ps-cfg-${c.channel}-${fd.k}`}>{fd.label}</label>
            {fd.select ? (
              <Combo id={`ps-cfg-${c.channel}-${fd.k}`} value={cfg[fd.k] || ''} onChange={(e) => { const v = e.target.value; setCfg((o) => ({ ...o, [fd.k]: v })); }} placeholder="Choose">
                <option value="">Choose</option>
                {fd.select.map((o) => <option key={o} value={o}>{o}</option>)}
              </Combo>
            ) : <input id={`ps-cfg-${c.channel}-${fd.k}`} value={cfg[fd.k] == null ? '' : cfg[fd.k]} placeholder={fd.ph || ''} onChange={(e) => { const v = e.target.value; setCfg((o) => ({ ...o, [fd.k]: v })); }} />}
          </div>
        )))}
      </div>
    </JpModal>
  );
}

function Channels() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { const { data: d } = await api.get('/portal-admin/channels'); setData(d); setErr(''); } catch (e) { setErr(errOf(e).message); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!data && !err) return <div className="jp-note" role="status">Loading the notification channels…</div>;
  if (!data) return <div><div className="jp-err" role="alert">{err}</div><button type="button" className="btn" onClick={load}>Try again</button></div>;
  return (
    <div className="nsm-wrap">
      <p className="jp-note" style={{ margin: 0 }}>How the Job Portal itself sends email, SMS and WhatsApp to candidates (logins, interview invitations, status messages). TeamLink&apos;s own email and messaging are on the Connections and Messaging tabs.</p>
      {data.secretKeyConfigured === false && <div className="jp-err" role="alert"><b>INTEGRATION_SECRET_KEY is not set on the Job Portal server.</b> Secrets cannot be saved until it is set (at least 16 characters).</div>}
      {err && <div className="jp-err" role="alert">{err}</div>}
      <div className="ps-sites">{(data.channels || []).map((c) => <ChannelCard key={c.channel} c={c} keyOk={data.secretKeyConfigured} onChanged={load} />)}</div>
    </div>
  );
}

/* ======================= AI screening ======================= */
function Screening() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const { data } = await api.get('/portal-admin/screening'); setS(data); setErr(''); } catch (e) { setErr(errOf(e).message); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!s && !err) return <div className="jp-note" role="status">Loading the screening settings…</div>;
  if (!s) return <div><div className="jp-err" role="alert">{err}</div><button type="button" className="btn" onClick={load}>Try again</button></div>;
  const setQ = (n, k, v) => setS((o) => ({ ...o, standard: o.standard.map((q, i) => (i === n ? { ...q, [k]: v } : q)) }));
  async function save() {
    setBusy(true); setRes(null);
    try {
      await api.put('/portal-admin/screening', {
        standard: (s.standard || []).map((q) => ({ ...q, text: String(q.text || '').trim(), weight: Number(q.weight) })),
        answerWeight: Number(s.answerWeight), askOnAiCalls: !!s.askOnAiCalls,
      });
      setRes({ ok: true, text: 'Screening settings saved.' });
    } catch (e) { setRes({ ok: false, text: errOf(e).message }); }
    setBusy(false);
  }
  return (
    <div className="nsm-wrap">
      <section className="nsm-card">
        <h3 className="ps-h3">Screening questions</h3>
        <p className="jp-note" style={{ margin: 0 }}>The standard questions every new Job Portal job gets, and how much the answers count in the AI score.</p>
        <div className="nsm-f">
          <label htmlFor="ps-sq-weight">Screening answers weight: <b>{s.answerWeight}%</b></label>
          <input id="ps-sq-weight" type="range" min="0" max="60" value={s.answerWeight} onChange={(e) => setS((o) => ({ ...o, answerWeight: Number(e.target.value) }))} />
          <span className="nsm-hint">The resume weights (skills, experience, education, location) scale to fill the rest.</span>
        </div>
        {(s.standard || []).map((q, n) => (
          <div key={q.key || n} className="ps-q">
            <input type="checkbox" checked={!!q.enabled} onChange={(e) => setQ(n, 'enabled', e.target.checked)} aria-label={`Add "${q.text}" to new jobs`} title="Added to new jobs" />
            <input className="ps-q-text" value={q.text || ''} maxLength={200} onChange={(e) => setQ(n, 'text', e.target.value)} aria-label={`Question ${n + 1}`} />
            <label className="ps-inline">Weight
              <Combo value={String(q.weight)} onChange={(e) => setQ(n, 'weight', Number(e.target.value || 0))} style={{ width: 72 }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((w) => <option key={w} value={String(w)}>{w}</option>)}
              </Combo>
            </label>
          </div>
        ))}
        <span className="nsm-hint">{'{location}'} and {'{mode}'} are filled in from each job. Never name a client: candidates see these questions.</span>
        <label className="ps-check"><input type="checkbox" checked={!!s.askOnAiCalls} onChange={(e) => setS((o) => ({ ...o, askOnAiCalls: e.target.checked }))} />
          <span><b>AI calls ask the pending screening questions</b><br /><span className="nsm-hint">Only when AI calling is set up. When the AI calling agent is already calling a candidate about a job, it also asks that application&apos;s unanswered questions. It never changes who is called or when.</span></span>
        </label>
        <div className="jp-row"><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save screening settings'}</button></div>
        {res && <div className={res.ok ? 'jp-ok' : 'jp-err'} role={res.ok ? 'status' : 'alert'} style={{ margin: 0 }}>{res.text}</div>}
      </section>
    </div>
  );
}

export default function JobPortalSettings({ initial = 'sites' }) {
  const [sub, setSub] = useState(SUBTABS.some(([k]) => k === initial) ? initial : 'sites');
  return (
    <div className="nsm-wrap">
      <div className="jp-tabsub" role="tablist" aria-label="Job Portal settings">
        {SUBTABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={sub === k} className={sub === k ? 'is-on' : ''} onClick={() => setSub(k)}>{l}</button>)}
      </div>
      {sub === 'sites' && <JobSites />}
      {sub === 'mailboxes' && <NaukriShineMailboxes />}
      {sub === 'notify' && <Channels />}
      {sub === 'screening' && <Screening />}
    </div>
  );
}

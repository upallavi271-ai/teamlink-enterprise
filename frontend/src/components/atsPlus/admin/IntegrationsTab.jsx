import { useEffect, useState } from 'react';
import api from '../../../api';
import TabStrip from '../../ui/TabStrip.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, Switch, when, row } from '../kit.jsx';
import { MyCalendarsZ, ContactsZ } from './WorkspaceZ.jsx'; // 07.01 / 14.05: my calendar, the booking switch, contacts (ATS wave 2 Z)

// ---------------------------------------------------------------------------
// ATS settings -> Integrations (14.01 / 14.04 / 14.05 / 14.06 / 14.09 / 14.10 / 14.15 / 15.01 / 15.14). Backend: utils/atsPlus/integrations.js,
// sso.js, idverify.js. Everything that sends something out starts OFF.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'api', label: 'API & Zapier / n8n', hint: 'API keys, the API documentation, webhooks and recipes' },
  { key: 'chat', label: 'Slack / Teams', hint: 'Short messages to a Slack or Teams channel when something happens' },
  { key: 'sso', label: 'Single sign-on', hint: 'Sign in with Google, Microsoft, Okta or any OIDC / SAML provider' },
  { key: 'vendors', label: 'Checks & tests', hint: 'Background-check and assessment vendors' },
  { key: 'boards', label: 'Job boards', hint: 'Every job board and its status' },
  { key: 'workspace', label: 'Google / Microsoft 365', more: true, hint: 'The Google and Microsoft app details; calendar links' },
  { key: 'idv', label: 'Identity check', more: true, hint: 'One-time codes to the candidate\'s phone / e-mail' },
];

function ApiKeys({ ov }) {
  const { data, err, reload } = useLoad('/ats-plus/integrations/api-keys');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ name: '', scopes: ['jobs:read'], rateLimit: 60 });
  const [made, setMade] = useState(null);
  return (
    <Section title="API keys" note="A key is shown once; only a fingerprint is kept. It reads only what the login it is tied to (you) may read, at most N requests a minute." right={<a href="/api/docs" target="_blank" rel="noreferrer">API documentation</a>}>
      <Notice tone="red">{err}</Notice>{flash}
      {made && <Notice tone="green"><span>Copy the key now: <input readOnly value={made} onFocus={(e) => e.target.select()} style={{ width: 360 }} aria-label="New API key" /></span></Notice>}
      {data && <Table rows={data.rows} empty="No keys yet."
        cols={[{ key: 'title', label: 'Key' }, { key: 'prefix', label: 'Starts with', render: (r) => <code>{r.prefix}…</code> }, { key: 'scopes', label: 'Scopes', render: (r) => r.scopes.join(', ') }, { key: 'rateLimit', label: 'Per minute' }, { key: 'actAsName', label: 'Acts as' },
          { key: 'lastUsedAt', label: 'Last used', render: (r) => (r.lastUsedAt ? `${when(r.lastUsedAt)} (${r.uses})` : 'never') }, { key: 'status', label: 'Status' },
          { key: 'x', label: '', render: (r) => r.status === 'ACTIVE' && <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/integrations/api-keys/${r.id}/revoke`), 'Key switched off.')}>Switch off</button> }]} />}
      {data && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <div style={row}><input aria-label="Key name" placeholder="Who / what uses it" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label>Per minute <input type="number" min="1" max="600" style={{ width: 70 }} value={f.rateLimit} onChange={(e) => setF({ ...f, rateLimit: e.target.value })} /></label></div>
          <div style={row}>{Object.entries(data.scopes).map(([k, l]) => <label key={k}><input type="checkbox" checked={f.scopes.includes(k)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, k] : f.scopes.filter((x) => x !== k) })} /> {l}</label>)}</div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.name} onClick={() => run(() => api.post('/ats-plus/integrations/api-keys', f), (d) => d.message).then((d) => { if (d) setMade(d.key); })}>Make a key</button>
        </div>
      )}
      {ov && <div className="small-muted" style={{ marginTop: 6 }}>Base address: <code>{window.location.origin}/api/v1/open</code></div>}
    </Section>
  );
}
function Hooks({ chat }) {
  const { data, err, reload } = useLoad('/ats-plus/integrations/webhooks');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ name: '', type: chat ? 'slack' : 'generic', url: '', events: [] });
  const [secret, setSecret] = useState(null);
  const s = data && data.settings;
  const mine = data ? data.rows.filter((h) => (chat ? h.type !== 'generic' : h.type === 'generic')) : [];
  return (
    <>
      <Section title={chat ? 'Slack and Microsoft Teams' : 'Webhooks (Zapier, n8n, Make)'} note={chat ? 'Paste an incoming-webhook address of a Slack or Teams channel and tick the events. Messages name the candidate, job and step - never a phone, e-mail or salary.' : 'TeamLink posts JSON to your address when something happens, signed with HMAC-SHA256 (header X-TeamLink-Signature). Use it in Zapier (Catch Hook), n8n (Webhook node) or Make.'}>
        <Notice tone="red">{err}</Notice>{flash}
        {s && <Switch checked={chat ? s.chatEnabled : s.enabled} onChange={(v) => run(() => api.put('/ats-plus/integrations/webhook-settings', chat ? { chatEnabled: v } : { enabled: v }), v ? 'Switched ON.' : 'Switched OFF.')} label={chat ? 'Send Slack / Teams messages' : 'Send webhooks'} note="OFF until you switch it on. While OFF nothing leaves TeamLink." />}
        {secret && <Notice tone="green"><span>Signing secret (shown once): <input readOnly value={secret} style={{ width: 340 }} aria-label="Signing secret" onFocus={(e) => e.target.select()} /></span></Notice>}
        <Table rows={mine} empty="None yet."
          cols={[{ key: 'title', label: 'Name' }, { key: 'type', label: 'Kind' }, { key: 'url', label: 'Address' }, { key: 'events', label: 'Events', render: (r) => r.events.join(', ') }, { key: 'status', label: 'On' },
            { key: 'x', label: '', render: (r) => <span style={row}><button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/integrations/webhooks/${r.id}/test`), (d) => `Test: ${d.note}`)}>Send a test</button>
              <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/integrations/webhooks/${r.id}/status`, { on: r.status !== 'ON' }), 'Saved.')}>{r.status === 'ON' ? 'Pause' : 'Resume'}</button></span> }]} />
        {data && (
          <div className="card" style={{ padding: 10, marginTop: 8 }}>
            <div style={row}>
              <input aria-label="Name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              {chat && <select aria-label="Kind" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="slack">Slack</option><option value="teams">Microsoft Teams</option></select>}
              <input aria-label="Address" placeholder="https://..." style={{ flex: 1, minWidth: 240 }} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
            </div>
            <div style={row}>{Object.entries(data.events).map(([k, l]) => <label key={k}><input type="checkbox" checked={f.events.includes(k)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, k] : f.events.filter((x) => x !== k) })} /> {l}</label>)}</div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.url || !f.events.length} onClick={() => run(() => api.post('/ats-plus/integrations/webhooks', f), (d) => d.message).then((d) => { if (d && d.secret) setSecret(d.secret); })}>Add</button>
          </div>
        )}
      </Section>
      {data && <Section title="Recent deliveries"><Table rows={data.deliveries.filter((d) => mine.some((h) => h.id === d.webhookId)).slice(0, 30)} empty="Nothing sent yet." cols={[{ key: 'at', label: 'When', render: (r) => when(r.at) }, { key: 'event', label: 'Event' }, { key: 'status', label: 'Result' }, { key: 'note', label: 'Detail' }]} /></Section>}
      {!chat && data && <Section title="Recipes" note="Ready steps for the usual automations.">{data.recipes.map((r) => <div key={r.title} style={{ marginBottom: 8 }}><b>{r.tool}: {r.title}</b><ol style={{ margin: '4px 0 0 18px' }}>{r.steps.map((x) => <li key={x}>{x}</li>)}</ol></div>)}</Section>}
    </>
  );
}
function Sso() {
  const { data, err, reload } = useLoad('/ats-plus/sso/settings');
  const { run, busy, flash } = useAction(reload);
  const [list, setList] = useState([]);
  const [tests, setTests] = useState({}); // 15.01 (ATS wave 2 Z): the Test results per provider
  useEffect(() => { if (data) setList(data.providers.map((p) => ({ ...p, allowedDomains: (p.allowedDomains || []).join(', '), clientSecret: '' }))); }, [data]);
  const set = (i, k, v) => setList(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const PRESET = { google: { name: 'Google', issuer: 'https://accounts.google.com' }, microsoft: { name: 'Microsoft', issuer: 'https://login.microsoftonline.com/<tenant id>/v2.0' }, okta: { name: 'Okta', issuer: 'https://<your org>.okta.com' } };
  return (
    <Section title="Single sign-on" note="Staff sign in with the company's identity provider. SSO never makes a login: the e-mail must belong to an active TeamLink login (and to an allowed domain when set). The provider's own two-step counts as the second step.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <div className="small-muted" style={{ marginBottom: 8 }}>Give the provider: redirect address <code>{data.redirectUri}</code> (OIDC) · ACS <code>{data.acs}</code> and entity ID <code>{data.spEntityId}</code> (SAML; metadata at <a href="/api/sso/saml/metadata" target="_blank" rel="noreferrer">/api/sso/saml/metadata</a>).</div>}
      {list.map((p, i) => (
        <div key={p.id || i} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={row}><b>{p.type === 'saml' ? 'SAML 2.0' : 'OIDC'}</b><input aria-label="Name" value={p.name} onChange={(e) => set(i, 'name', e.target.value)} /><label><input type="checkbox" checked={!!p.enabled} onChange={(e) => set(i, 'enabled', e.target.checked)} /> on the login page</label>
            <button type="button" className="btn btn-sm" onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button>
            {p.id && <button type="button" className="btn btn-sm" disabled={busy} title="Check the provider's addresses, keys and certificate (saved settings)" onClick={() => run(() => api.post(`/ats-plus/sso/${p.id}/test`), (d) => (d.ok ? 'The test passed.' : 'The test found a problem.')).then((d) => { if (d) setTests((t) => ({ ...t, [p.id]: d })); })}>Test</button>}</div>
          {p.id && tests[p.id] && <ul className="small-muted" data-testid="sso-test" style={{ margin: '4px 0 8px 18px' }}>{tests[p.id].checks.map((c) => <li key={c.name} style={{ color: c.ok ? undefined : 'var(--red, #b42318)' }}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? `: ${c.detail}` : ''}</li>)}</ul>}
          {p.type === 'oidc' ? (
            <div className="grid-2">
              <Field label="Issuer address"><input value={p.issuer || ''} onChange={(e) => set(i, 'issuer', e.target.value)} /></Field>
              <Field label="Client ID"><input value={p.clientId || ''} onChange={(e) => set(i, 'clientId', e.target.value)} /></Field>
              <Field label="Client secret" hint={p.hasSecret ? 'Saved (encrypted). Type to replace.' : ''}><input type="password" value={p.clientSecret} onChange={(e) => set(i, 'clientSecret', e.target.value)} autoComplete="new-password" /></Field>
              <Field label="Allowed e-mail domains"><input value={p.allowedDomains} onChange={(e) => set(i, 'allowedDomains', e.target.value)} placeholder="teamlink.in" /></Field>
            </div>
          ) : (
            <div className="grid-2">
              <Field label="IdP sign-in address (SSO URL)"><input value={p.entryPoint || ''} onChange={(e) => set(i, 'entryPoint', e.target.value)} /></Field>
              <Field label="E-mail attribute"><input value={p.emailAttribute || 'email'} onChange={(e) => set(i, 'emailAttribute', e.target.value)} /></Field>
              <Field label="IdP certificate (PEM)"><textarea rows={3} value={p.idpCert || ''} onChange={(e) => set(i, 'idpCert', e.target.value)} /></Field>
              <Field label="Allowed e-mail domains"><input value={p.allowedDomains} onChange={(e) => set(i, 'allowedDomains', e.target.value)} /></Field>
            </div>
          )}
        </div>
      ))}
      <div style={row}>
        {Object.entries(PRESET).map(([k, v]) => <button key={k} type="button" className="btn btn-sm" onClick={() => setList([...list, { type: 'oidc', enabled: false, clientId: '', clientSecret: '', allowedDomains: '', ...v }])}>+ {v.name}</button>)}
        <button type="button" className="btn btn-sm" onClick={() => setList([...list, { type: 'oidc', name: 'OIDC', enabled: false, issuer: '', clientId: '', clientSecret: '', allowedDomains: '' }])}>+ Other OIDC</button>
        <button type="button" className="btn btn-sm" onClick={() => setList([...list, { type: 'saml', name: 'SAML', enabled: false, entryPoint: '', idpCert: '', allowedDomains: '' }])}>+ SAML 2.0</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/sso/settings', { providers: list }), 'Saved.')}>Save</button>
      </div>
    </Section>
  );
}
// 14.09 / 14.10 (ATS wave 2 Z): the two vendor connectors whose keys are in Administration > Integrations
function VendorStatusZ() {
  const { data, err } = useLoad('/ats-plus/vendorsz/status');
  return (
    <Section title="Vendor connectors" note="A background-check vendor (SpringVerify, AuthBridge, IDfy, OnGrid ...) and a test vendor (HackerEarth, Mercer Mettl, iMocha, HackerRank ...). The keys are kept encrypted in Administration > Integrations; orders are placed from Joining > Onboarding and the result comes back on the person's record.">
      <Notice tone="red">{err}</Notice>
      {data && <Table rows={Object.entries(data.vendors).map(([k, v]) => ({ id: k, ...v }))}
        cols={[{ key: 'label', label: 'Kind' }, { key: 'vendor', label: 'Vendor' }, { key: 'ready', label: 'Status', render: (r) => (r.ready ? 'Ready' : 'Not set up - needs founder credentials') }, { key: 'x', label: '', render: (r) => (data.canSetUp ? <a href={r.setUpLink}>Set up</a> : null) }]} />}
    </Section>
  );
}
function Vendors() {
  const { data, err, reload } = useLoad('/ats-plus/integrations/connectors');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ type: 'bgv', name: '', mode: 'manual', url: '', authHeader: 'Authorization', auth: '', bodyTemplate: '' });
  return (
    <>
      <VendorStatusZ />
      <Section title="Background-check and assessment vendors (manual or own HTTP)" note="A vendor with an API: TeamLink posts the order to its address and gives it a callback link for the result. Without an API: Manual - the team types the result. Ordering is done from Joining → Onboarding (Checks and tests).">
        <Notice tone="red">{err}</Notice>{flash}
        {data && <Table rows={data.rows} empty="No vendor yet." cols={[{ key: 'title', label: 'Vendor' }, { key: 'type', label: 'Kind', render: (r) => (r.type === 'bgv' ? 'Background check' : 'Assessment') }, { key: 'mode', label: 'How', render: (r) => (r.mode === 'http' ? `API (${r.url})` : 'Manual') }, { key: 'status', label: 'On' }]} />}
        {data && data.canEdit && (
          <div className="card" style={{ padding: 10, marginTop: 8 }}>
            <div style={row}>
              <select aria-label="Kind" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="bgv">Background check</option><option value="assessment">Assessment</option></select>
              <input aria-label="Vendor" placeholder="Vendor name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <select aria-label="How" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="manual">Manual</option><option value="http">API (HTTP)</option></select>
            </div>
            {f.mode === 'http' && <div className="grid-2">
              <Field label="Order address (https://)"><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
              <Field label="Auth header name"><input value={f.authHeader} onChange={(e) => setF({ ...f, authHeader: e.target.value })} /></Field>
              <Field label="Auth header value" hint="Kept encrypted."><input type="password" value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value })} autoComplete="new-password" /></Field>
              <Field label="JSON body (optional)" hint="{{candidate.name}} {{candidate.email}} {{candidate.phone}} {{job.title}} {{order.id}} {{order.callback}}"><textarea rows={3} value={f.bodyTemplate} onChange={(e) => setF({ ...f, bodyTemplate: e.target.value })} /></Field>
            </div>}
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.name} onClick={() => run(() => api.post('/ats-plus/integrations/connectors', f), 'Vendor added.')}>Add vendor</button>
          </div>
        )}
      </Section>
      {data && <Section title="Orders"><Table rows={data.orders} empty="No orders yet." cols={[{ key: 'at', label: 'When', render: (r) => when(r.at) }, { key: 'title', label: 'Order' }, { key: 'status', label: 'Status' }, { key: 'r', label: 'Result', render: (r) => (r.result ? `${r.result.verdict}${r.result.score !== null && r.result.score !== undefined ? ` (${r.result.score})` : ''}` : '—') }]} /></Section>}
    </>
  );
}
function Boards() {
  const { data, err } = useLoad('/ats-plus/integrations/job-boards');
  return (
    <Section title="Job boards" note="Every board with its real status from the posting module (Clients & Requirements → Job posting). Boards with no partner API are posted by hand; their applicants come in by the mail or spreadsheet import.">
      <Notice tone="red">{err}</Notice>
      {data && <Table rows={data.rows} rowKey={(r) => r.key} cols={[{ key: 'name', label: 'Board' }, { key: 'how', label: 'How' }, { key: 'status', label: 'Status', render: (r) => <span style={{ color: r.ready ? 'var(--green, #1d6b3d)' : undefined }}>{r.status}</span> }, { key: 'postedLast30', label: 'Posted (30 days)' }, { key: 'note', label: 'Note', render: (r) => r.note || '—' }]} />}
    </Section>
  );
}
function Workspace() {
  const { data, err, reload } = useLoad('/ats-plus/integrations/overview');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ googleClientId: '', googleSecret: '', msTenantId: '', msClientId: '', msSecret: '' });
  useEffect(() => { if (data) setF((x) => ({ ...x, googleClientId: data.google.clientId, msTenantId: data.microsoft.tenantId, msClientId: data.microsoft.clientId })); }, [data]);
  return (
    <Section title="Google Workspace and Microsoft 365" note="Sign-in with Google or Microsoft is set up under Single sign-on (OIDC). The app details below are for the calendar and mail connection; every interview already has Add to Google Calendar / Outlook links, and Google Meet links are made from the interview screen.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <div className="grid-2">
        <Field label="Google OAuth client ID"><input value={f.googleClientId} onChange={(e) => setF({ ...f, googleClientId: e.target.value })} /></Field>
        <Field label="Google client secret" hint={data.google.hasSecret ? 'Saved (encrypted).' : ''}><input type="password" value={f.googleSecret} onChange={(e) => setF({ ...f, googleSecret: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Microsoft tenant ID"><input value={f.msTenantId} onChange={(e) => setF({ ...f, msTenantId: e.target.value })} /></Field>
        <Field label="Microsoft app (client) ID"><input value={f.msClientId} onChange={(e) => setF({ ...f, msClientId: e.target.value })} /></Field>
        <Field label="Microsoft client secret" hint={data.microsoft.hasSecret ? 'Saved (encrypted).' : ''}><input type="password" value={f.msSecret} onChange={(e) => setF({ ...f, msSecret: e.target.value })} autoComplete="new-password" /></Field>
      </div>}
      {data && data.canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/integrations/workspace', f), 'Saved.')}>Save</button>}
      {data && <div className="small-muted" style={{ marginTop: 6 }}>Kept in Administration &gt; Integrations &gt; Google Workspace / Microsoft 365 (ATS), secrets encrypted.</div>}
    </Section>
  );
}
function IdCheck() {
  const { data, err, reload } = useLoad('/ats-plus/idverify/settings');
  const { run, flash } = useAction(reload);
  return (
    <Section title="Candidate identity check" note="A recruiter makes a link from the candidate's profile (IDs & consent); the candidate proves the phone / e-mail on the profile with a one-time code. Sending the code is a message to a real person, so it is OFF until you switch it on (SMS uses the SMS gateway and its OTP template; e-mail the company mailbox).">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <Switch checked={data.sendEnabled} onChange={(v) => run(() => api.put('/ats-plus/idverify/settings', { sendEnabled: v }), v ? 'Codes can be sent.' : 'Codes are OFF.')} label="Send one-time codes to candidates" />}
    </Section>
  );
}

export default function IntegrationsTab() {
  const [tab, setTab] = useState('api');
  const ov = useLoad('/ats-plus/integrations/overview');
  return (
    <>
      <TabStrip label="Integrations" tabs={TABS} value={tab} onChange={setTab} small />
      {tab === 'api' && <><ApiKeys ov={ov.data} /><Hooks chat={false} /></>}
      {tab === 'chat' && <Hooks chat />}
      {tab === 'sso' && <Sso />}
      {tab === 'vendors' && <Vendors />}
      {tab === 'boards' && <Boards />}
      {tab === 'workspace' && <><Workspace /><MyCalendarsZ /><ContactsZ /></>}
      {tab === 'idv' && <IdCheck />}
    </>
  );
}

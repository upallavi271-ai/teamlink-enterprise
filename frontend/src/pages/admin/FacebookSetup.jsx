import { useEffect, useState } from 'react';
import api from '../../api';

// Administration > Integrations > Facebook (founder 2026-10-30: "facebook integrate cheyali antey em cheyali aa interface chesi evvu").
// The whole Facebook connection as numbered steps, each with a green tick once it is done. It only uses what already exists:
// GET /admin/integrations (the Social Media channel), GET/POST /admin/integrations/social/facebook/* (utils/facebookConnect.js: Facebook's
// own login, then the Page to use) and GET /admin/integrations-omni-channel (did Omni-Channel get the Page). No password or token is shown.
const META_APPS = 'https://developers.facebook.com/apps/';
const siteOf = (u) => { try { return new URL(u); } catch { return { host: window.location.host, origin: window.location.origin }; } };

function Step({ n, done, title, children }) {
  return (
    <div className="card" style={{ padding: 16, marginBottom: 12, borderLeft: `4px solid ${done ? '#1c7c4a' : '#c9d3de'}` }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ width: 26, height: 26, borderRadius: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, background: done ? '#1c7c4a' : '#e8edf3', color: done ? '#fff' : '#334' }}>{done ? '✓' : n}</span>
        <b style={{ fontSize: 15 }}>{title}</b>
        {done && <span style={{ color: '#1c7c4a', fontSize: 12.5, fontWeight: 600 }}>Done</span>}
      </div>
      <div style={{ paddingLeft: 36, lineHeight: 1.65, fontSize: 13.5 }}>{children}</div>
    </div>
  );
}

function CopyBox({ text }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
      <code style={{ background: '#f3f5f8', padding: '6px 10px', borderRadius: 6, wordBreak: 'break-all', userSelect: 'all', flex: '1 1 260px' }}>{text}</code>
      <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

export default function FacebookSetup() {
  const [social, setSocial] = useState(null);
  const [uri, setUri] = useState(null);
  const [omni, setOmni] = useState(null);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load() {
    api.get('/admin/integrations').then((r) => {
      const s = (r.data.channels || []).find((c) => c.id === 'social');
      setSocial(s || {});
      if (s && s.values && s.values['Meta App ID'] && !appId) setAppId(s.values['Meta App ID']);
    }).catch(() => setErr('Could not load the Facebook connection.'));
    api.get('/admin/integrations/social/facebook/redirect-uri').then((r) => setUri(r.data)).catch(() => setUri(null));
    api.get('/admin/integrations-omni-channel').then((r) => setOmni(r.data)).catch(() => setOmni(null));
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect() {
    setErr('');
    if (!appId.trim()) { setErr('Type the App ID first (step 3).'); return; }
    setBusy(true);
    try {
      const values = { 'Meta App ID': appId.trim() };
      if (secret.trim()) values['Meta App secret'] = secret.trim();
      const r = await api.post('/admin/integrations/social/facebook/start', { values });
      window.location.href = r.data.url; // Facebook's own login page; it comes back to Integrations and asks which Page
    } catch (e) { setErr(e.response?.data?.error || 'Could not open the Facebook sign-in.'); setBusy(false); }
  }

  if (!social) return <div className="small-muted">{err || 'Loading…'}</div>;
  const v = social.values || {};
  const pageId = String(v['Facebook Page ID'] || '').trim();
  const connected = social.state === 'Connected' && !!pageId;
  const hasApp = !!(uri && uri.hasApp);
  const secretSaved = !!(social.secretHints && social.secretHints['Meta App secret']);
  const gsFb = omni && omni.connections && omni.connections.workspaces
    ? omni.connections.workspaces.flatMap((w) => w.items.filter((x) => x.provider === 'facebook').map((x) => ({ ...x, ws: w.name })))
    : [];
  // Omni-Channel keeps a Page on its Social page (not always in its integrations list): the last send from TeamLink also counts
  const lastFb = omni && omni.last && omni.last.workspaces ? omni.last.workspaces.map((w) => w.channels && w.channels.facebook).filter(Boolean) : [];
  const inOmni = gsFb.some((x) => x.status === 'CONNECTED') || lastFb.some((c) => c.state === 'sent' || c.state === 'same');
  const omniWhy = lastFb.find((c) => c.state === 'failed' || c.state === 'skipped');

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="card" style={{ padding: 16, marginBottom: 14, background: connected ? '#eef9f2' : '#f5f9ff' }}>
        <b style={{ fontSize: 15 }}>{connected ? `Facebook is connected (Page ${pageId}).` : 'Facebook is not connected yet.'}</b>
        <div className="small-muted" style={{ marginTop: 4 }}>
          Connect your company Facebook Page once, here. Job posts use it, and Omni-Channel gets the same Page by itself.
          Do the steps in order; each turns green when it is done. It takes about 10 minutes the first time.
        </div>
      </div>
      {err && <div className="error-text" style={{ marginBottom: 10 }}>{err}</div>}

      <Step n={1} done={hasApp} title="Make a Meta app (one time)">
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Open <a href={META_APPS} target="_blank" rel="noreferrer">Meta for Developers → My Apps</a> and sign in with the Facebook account that manages your company Page.</li>
          <li>Already have the app you use for WhatsApp? Open it and skip to step 2. Otherwise press <b>Create app</b>, pick <b>Other</b>, then <b>Business</b>, name it <b>TeamLink</b>, and pick your business account.</li>
          <li>In the app, press <b>Add product</b> and add <b>Facebook Login for Business</b>.</li>
        </ol>
      </Step>

      <Step n={2} done={false} title="Tell Facebook about this site (one time)">
        {/* founder 2026-10-30: Facebook answered "Can't load URL - the domain of this URL isn't included in the app's domains" */}
        <b>a.</b> In the app: <b>App settings → Basic</b>. In <b>App Domains</b> type:
        {uri ? <CopyBox text={siteOf(uri.redirectUri).host} /> : null}
        Lower on the same page press <b>+ Add platform → Website</b> and put this in <b>Site URL</b>, then <b>Save changes</b>:
        {uri ? <CopyBox text={`${siteOf(uri.redirectUri).origin}/`} /> : null}
        <b>b.</b> In the app: <b>Facebook Login for Business → Settings</b>. Switch <b>Client OAuth login</b> and <b>Web OAuth login</b> to <b>Yes</b>, paste this in <b>Valid OAuth Redirect URIs</b> exactly, then <b>Save changes</b>:
        {uri ? <CopyBox text={uri.redirectUri} /> : <div className="small-muted">The address could not be read.</div>}
        <div className="small-muted" style={{ fontSize: 12 }}>
          This step has no tick: TeamLink cannot see your Meta app. Facebook says &quot;Can&apos;t load URL&quot; when <b>a</b> is missing, and &quot;URL blocked&quot; when the address in <b>b</b> is missing or different.
          Do it from the address you use every day (the live site), not from localhost.
        </div>
      </Step>

      <Step n={3} done={hasApp} title="Copy the App ID and App secret here">
        In the app: <b>App settings → Basic</b>. Copy <b>App ID</b> and <b>App secret</b> (press Show) into these boxes.
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <label className="field" style={{ flex: '1 1 220px', marginBottom: 0 }}><span>App ID</span>
            <input value={appId} inputMode="numeric" placeholder="Digits, e.g. 1234567890123456" onChange={(e) => setAppId(e.target.value.replace(/\s/g, ''))} />
          </label>
          <label className="field" style={{ flex: '1 1 220px', marginBottom: 0 }}><span>App secret</span>
            <input type="password" value={secret} autoComplete="off" placeholder={secretSaved ? 'Saved - leave empty to keep it' : 'From App settings → Basic'} onChange={(e) => setSecret(e.target.value)} />
          </label>
        </div>
        <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>Same app as WhatsApp? The secret can stay empty: the WhatsApp one is used. The secret is saved encrypted and never shown again.</div>
      </Step>

      <Step n={4} done={connected} title="Sign in with Facebook and pick your Page">
        Press the button. Facebook opens its own sign-in (TeamLink never sees your Facebook password). Allow the access, tick your company Page,
        and you come back here to pick it.
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>{busy ? 'Opening Facebook…' : connected ? 'Connect again / change Page' : 'Connect with Facebook'}</button>
        </div>
        {/* an error saved before the Meta app was set up belongs to an older try (the old demo test), so it is only shown once steps 1-3 are done */}
        {social.error && !connected && hasApp && <div className="small-muted" style={{ marginTop: 6, color: '#b42318' }}>Last time it did not connect: {social.error}</div>}
      </Step>

      <Step n={5} done={inOmni} title="Omni-Channel gets the same Page (automatic)">
        {inOmni
          ? <>Omni-Channel uses the same Page{gsFb.some((x) => x.status === 'CONNECTED') ? `: ${gsFb.filter((x) => x.status === 'CONNECTED').map((x) => `${x.account || 'Facebook'} (${x.ws})`).join(', ')}` : ''}.</>
          : connected
            ? <>Sent a few seconds after step 4. If it does not turn green, open <b>Integrations → Omni-Channel</b> and press <b>Send to Omni-Channel now</b>.</>
            : <>Happens by itself after step 4.</>}
        {!inOmni && connected && omniWhy && <div className="small-muted" style={{ fontSize: 12, color: '#b42318' }}>Omni-Channel said: {omniWhy.words}</div>}
        {omni && omni.connectionsError && <div className="small-muted" style={{ fontSize: 12 }}>{omni.connectionsError}</div>}
        <div style={{ marginTop: 8 }}><button type="button" className="btn btn-sm" onClick={load}>↻ Check again</button></div>
      </Step>

      <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Posting jobs to the Page stays <b>OFF</b> until an Admin switches it on (Postings). Instagram and Threads use the same Meta app later.
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';

// Administration > Integrations > Facebook (founder 2026-10-30: "facebook integrate cheyali antey em cheyali aa interface chesi evvu").
// The whole Facebook connection as numbered steps, each with a green tick once it is done. It only uses what already exists:
// GET /admin/integrations (the Social Media channel), GET/POST /admin/integrations/social/facebook/* (utils/facebookConnect.js: Facebook's
// own login, then the Page to use) and GET /admin/integrations-omni-channel (did Omni-Channel get the Page). No password or token is shown.
const META_APPS = 'https://developers.facebook.com/apps/';
const CONFIG = 'Meta login configuration ID';
const PERMS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
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

export default function FacebookSetup({ embedded = false }) {
  const [social, setSocial] = useState(null);
  const [uri, setUri] = useState(null);
  const [omni, setOmni] = useState(null);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [configId, setConfigId] = useState('');
  const [appCheck, setAppCheck] = useState(null); // { ok, words } from Check App ID + Secret
  const [pasted, setPasted] = useState('');
  const [thToken, setThToken] = useState('');
  const [thBusy, setThBusy] = useState(false);
  const [thMsg, setThMsg] = useState('');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load() {
    api.get('/admin/integrations').then((r) => {
      const s = (r.data.channels || []).find((c) => c.id === 'social');
      setSocial(s || {});
      if (s && s.values && s.values['Meta App ID'] && !appId) setAppId(s.values['Meta App ID']);
      if (s && s.values && s.values[CONFIG] && !configId) setConfigId(s.values[CONFIG]);
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
      values[CONFIG] = configId.trim(); // empty = ask with the permission list
      const r = await api.post('/admin/integrations/social/facebook/start', { values });
      window.location.href = r.data.url; // Facebook's own login page; it comes back to Integrations and asks which Page
    } catch (e) { setErr(e.response?.data?.error || 'Could not open the Facebook sign-in.'); setBusy(false); }
  }

  // the backup way: a token from Graph API Explorer -> the server lists the Pages -> the same "Which Facebook Page?" pick (Integrations reads ?facebook=pick)
  async function readPages() {
    setErr('');
    if (pasted.trim().length < 30) { setErr('Paste the whole Access Token from Graph API Explorer first.'); return; }
    setReading(true);
    try {
      const values = {};
      if (appId.trim()) values['Meta App ID'] = appId.trim();
      if (secret.trim()) values['Meta App secret'] = secret.trim();
      const r = await api.post('/admin/integrations/social/facebook/token', { token: pasted.trim(), values });
      window.location.href = `/admin/integrations?tab=facebook&facebook=pick&k=${encodeURIComponent(r.data.k)}`;
    } catch (e) { setErr(e.response?.data?.error || 'Facebook did not accept the token.'); setReading(false); }
  }

  // THREADS (2026-10-30): its own token -> checked with Threads -> saved -> Omni-Channel gets it
  async function connectThreads() {
    setThMsg(''); setErr('');
    if (thToken.trim().length < 20) { setErr('Paste the whole Threads access token first (step 6).'); return; }
    setThBusy(true);
    try { const r = await api.post('/admin/integrations/social/threads', { token: thToken.trim() }); setThMsg(r.data.message); setThToken(''); load(); } catch (e) { setErr(e.response?.data?.error || 'Threads did not connect.'); } finally { setThBusy(false); }
  }
  async function removeThreads() {
    setThBusy(true);
    try { await api.post('/admin/integrations/social/threads/remove'); setThMsg('Threads removed (also from Omni-Channel in a few seconds).'); load(); } catch (e) { setErr(e.response?.data?.error || 'Could not remove Threads.'); } finally { setThBusy(false); }
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
  const thProfile = String(v['Threads profile'] || '').trim();
  const lastTh = omni && omni.last && omni.last.workspaces && omni.last.workspaces[0] && omni.last.workspaces[0].channels ? omni.last.workspaces[0].channels.threads : null;

  return (
    <div style={{ maxWidth: embedded ? 'none' : 860 }}>
      {!embedded && (
      <div className="card" style={{ padding: 16, marginBottom: 14, background: connected ? '#eef9f2' : '#f5f9ff' }}>
        <b style={{ fontSize: 15 }}>{connected ? `Facebook is connected (Page ${pageId}).` : 'Facebook is not connected yet.'}</b>
        <div className="small-muted" style={{ marginTop: 4 }}>
          Connect your company Facebook Page once, here. Job posts use it, and Omni-Channel gets the same Page by itself.
          Do the steps in order; each turns green when it is done. It takes about 10 minutes the first time.
        </div>
      </div>
      )}
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
        {/* 2026-10-31: "Error validating client secret" came back after Facebook's sign-in - check the pair before signing in */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => {
            setAppCheck(null);
            const values = {};
            if (appId.trim()) values['Meta App ID'] = appId.trim();
            if (secret.trim()) values['Meta App secret'] = secret.trim();
            try { const r = await api.post('/admin/integrations/social/facebook/check-app', { values }); setAppCheck(r.data); setSecret(''); load(); } catch (e) { setAppCheck({ ok: false, words: e.response?.data?.error || 'The check could not run.' }); }
          }}>Check App ID + Secret</button>
          {uri && uri.secretFrom && <span className="small-muted" style={{ fontSize: 12 }}>Secret in use: {uri.secretFrom}</span>}
        </div>
        {appCheck && <div style={{ marginTop: 6, fontSize: 13, color: appCheck.ok ? '#1c7c4a' : '#b42318' }}>{appCheck.ok ? '✓ ' : '✗ '}{appCheck.words}</div>}

        {/* founder 2026-10-30: Facebook answered "Invalid Scopes: pages_show_list, pages_read_engagement, pages_manage_posts" */}
        <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fff8ec', border: '1px solid #f3dcae' }}>
          <b>Facebook says &quot;Invalid Scopes&quot;?</b> Your app does not have the Page permissions yet. Do <b>one</b> of these:
          <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>In the app: <b>Use cases → + Add use case → &quot;Manage everything on your Page&quot;</b>, then <b>Customize</b> and add these three permissions. Leave the box below empty.
              {PERMS.map((x) => <CopyBox key={x} text={x} />)}
            </li>
            <li>Your app uses <b>Facebook Login for Business</b>: there go to <b>Configurations → + Create configuration</b>, pick your Pages and the same three permissions, and paste the <b>Configuration ID</b> here:
              <label className="field" style={{ maxWidth: 320, margin: '6px 0 0' }}><span>Configuration ID</span>
                <input value={configId} inputMode="numeric" placeholder="Digits; empty = not used" onChange={(e) => setConfigId(e.target.value.replace(/\D/g, ''))} />
              </label>
            </li>
          </ol>
        </div>
      </Step>

      <Step n={4} done={connected} title="Sign in with Facebook and pick your Page">
        Press the button. Facebook opens its own sign-in (TeamLink never sees your Facebook password). Allow the access, tick your company Page,
        and you come back here to pick it.
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>{busy ? 'Opening Facebook…' : connected ? 'Connect again / change Page' : 'Connect with Facebook'}</button>
        </div>
        {/* an error saved before the Meta app was set up belongs to an older try (the old demo test), so it is only shown once steps 1-3 are done */}
        {social.error && !connected && hasApp && <div className="small-muted" style={{ marginTop: 6, color: '#b42318' }}>Last time it did not connect: {social.error}</div>}

        {/* founder 2026-10-30: Facebook's login page only said "Sorry, something went wrong" */}
        <details style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#f7f7fb', border: '1px solid #e0e3ea' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Facebook only says &quot;Sorry, something went wrong&quot;? Use the backup way</summary>
          <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Open <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Graph API Explorer</a> (signed in as the Page admin).</li>
            <li>On the right, <b>Meta App</b>: pick the same app as step 3{appId ? ` (${appId})` : ''}. <b>User or Page</b>: <b>Get User Access Token</b>.</li>
            <li>In <b>Permissions</b> add these three:{PERMS.map((x) => <CopyBox key={x} text={x} />)}</li>
            <li>Press <b>Generate Access Token</b>, continue on Facebook, <b>tick your company Page</b> and allow.</li>
            <li>Copy the long <b>Access Token</b> at the top and paste it here. TeamLink makes it long-lasting and lists your Pages.</li>
          </ol>
          <textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value.replace(/\s/g, ''))} placeholder="Paste the Access Token here" style={{ width: '100%', marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} />
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={readPages} disabled={reading}>{reading ? 'Reading your Pages…' : 'Read my Pages'}</button>
        </details>
      </Step>

      {/* in Integrations > Social Media (embedded) Instagram, Omni-Channel and Threads have their own tabs */}
      {!embedded && (<>
      {/* INSTAGRAM (2026-10-30): no extra step in TeamLink - the Instagram account linked to the Page comes with the Page */}
      <div className="card" style={{ padding: 14, marginBottom: 12, background: '#fdf4fb', border: '1px solid #f0d4ea' }}>
        <b>Instagram</b> comes with the Page: link your Instagram <b>professional</b> account to the Facebook Page once
        (Facebook Page → <b>Settings → Linked accounts → Instagram → Connect</b>), then press <b>Connect with Facebook</b> again and allow the Instagram access Facebook asks for.
        Omni-Channel then posts to Instagram with the same Page.
      </div>

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


      <Step n={6} done={!!thProfile} title={thProfile ? `Threads is connected (${thProfile})` : 'Threads (its own token)'}>
        Threads is not part of the Facebook sign-in; it takes its own token, made in the same Meta app:
        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>In the app: <b>App roles → Roles → Threads testers → Add</b> your Threads account. On Threads (threads.net): <b>Settings → Account → Website permissions → Invites → Accept</b>.</li>
          <li>In the app: <b>Use cases → Access the Threads API → Customize</b>: add <b>threads_basic</b> and <b>threads_content_publish</b>; in its <b>Settings</b> put this redirect address and save:
            {uri ? <CopyBox text={uri.redirectUri} /> : null}
          </li>
          <li>Same use case: <b>User Token Generator → Generate Access Token</b> for your Threads account, and copy the token.</li>
          <li>Paste it here and press <b>Connect Threads</b>. TeamLink checks it with Threads, saves it encrypted and gives it to Omni-Channel.</li>
        </ol>
        <textarea rows={2} value={thToken} onChange={(e) => setThToken(e.target.value.replace(/\s/g, ''))} placeholder="Paste the Threads access token here" style={{ width: '100%', marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={connectThreads} disabled={thBusy}>{thBusy ? 'Checking with Threads…' : thProfile ? 'Replace the Threads token' : 'Connect Threads'}</button>
          {thProfile && <button type="button" className="btn btn-sm" onClick={removeThreads} disabled={thBusy}>Remove Threads</button>}
        </div>
        {thMsg && <div className="small-muted" role="status" style={{ marginTop: 6 }}>{thMsg}</div>}
        {lastTh && lastTh.state !== 'same' && lastTh.state !== 'sent' && thProfile && <div className="small-muted" style={{ fontSize: 12 }}>Omni-Channel: {lastTh.words}</div>}
      </Step>
      </>)}

      <div className="small-muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Posting jobs to the Page stays <b>OFF</b> until an Admin switches it on (Postings).
      </div>
    </div>
  );
}

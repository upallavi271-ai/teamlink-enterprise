import { useEffect, useState } from 'react';
import api from '../../api';
import FacebookSetup from './FacebookSetup.jsx';
import Modal from '../../components/Modal.jsx';

// Administration > Integrations > Social Media (founder 2026-10-30: "separate ga tabs ravali mothaniki okka tab social media anni dantlo
// facebook anni okka tab and instagram tab ani and threds ... facebook accounts 5 ala unati anni accounts ina connect chesukodaniki undali").
// Three tabs - Facebook, Instagram, Threads - each with every connected account (any number, from any number of logins), one marked as
// the default (*): job posts and Omni-Channel use the default. Server: /admin/social-accounts (utils/socialAccounts.js). No token is shown.
// + LinkedIn (2026-10-31): job posts also go to LinkedIn (a post on the profile or Company Page, official LinkedIn API).
// + YouTube (2026-10-31, founder: "youtube ki kuda inko tab pettu"): channels through Google's own sign-in (utils/youtubeConnect.js).
const SUBS = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['threads', 'Threads'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube']];

function AccountList({ rows, noun, onDefault, onRemove, onEdit, busy, extra }) {
  if (!rows.length) return <div className="small-muted" style={{ padding: '6px 0' }}>No {noun} connected yet.</div>;
  return (
    <div className="tbl-wrap"><table>
      <thead><tr><th>{noun.charAt(0).toUpperCase() + noun.slice(1, -1)}</th><th>Default</th><th>Status</th><th>Connected by</th><th /></tr></thead>
      <tbody>{rows.map((a) => (
        <tr key={a.id}>
          <td><b>{a.name}</b>{a.username && a.name !== `@${a.username}` ? <span className="small-muted"> · @{a.username}</span> : null}<div className="small-muted" style={{ fontSize: 11.5 }}>{extra ? extra(a) : a.externalId}</div></td>
          <td>{a.isDefault ? <b style={{ color: '#1c7c4a' }}>★ Default</b> : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onDefault(a)}>Make default</button>}</td>
          <td>{a.status === 'Connected' ? <span style={{ color: '#1c7c4a', fontWeight: 600 }}>Connected</span> : <span style={{ color: '#b42318' }} title={a.error || ''}>{a.status}{a.error ? `: ${a.error}` : ''}</span>}</td>
          <td className="small-muted">{a.connectedByName || ''}{a.connectedAt ? ` · ${new Date(a.connectedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {onEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEdit(a)}>Edit</button>}{' '}
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onRemove(a)}>Remove</button>
          </td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export default function SocialMedia({ initialSub = 'facebook', reloadKey = 0 }) {
  const [sub, setSub] = useState(SUBS.some(([k]) => k === initialSub) ? initialSub : 'facebook');
  const [acc, setAcc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [thToken, setThToken] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [editing, setEditing] = useState(null); // { a, name, token } - the Edit box
  const [li, setLi] = useState(null); // LinkedIn app: { hasApp, clientId, hasSecret, redirectUri }
  const [liForm, setLiForm] = useState({ clientId: '', clientSecret: '' });
  const [liPage, setLiPage] = useState('');
  const [liPageOn, setLiPageOn] = useState(false);
  const [yt, setYt] = useState(null); // Google app: { hasApp, clientId, hasSecret, redirectUri }
  const [ytForm, setYtForm] = useState({ clientId: '', clientSecret: '' });

  // LinkedIn sends the browser back here (?sub=linkedin&linkedin=connected | denied | failed&why=...): say what happened, then clean the address
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('linkedin');
    if (!r) return;
    setSub('linkedin');
    if (r === 'connected') setMsg('LinkedIn connected. Job posts can now go to it once an Admin switches LinkedIn posting ON (Job portals).');
    else if (r === 'denied') setErr(`LinkedIn sign-in was cancelled${q.get('why') ? ` (${q.get('why')})` : ''}. Nothing was connected.`);
    else setErr(`LinkedIn did not connect: ${q.get('why') || 'it did not accept the sign-in'}.`);
    ['linkedin', 'why'].forEach((k) => q.delete(k));
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  }, []);
  // Google sends the browser back here (?sub=youtube&youtube=connected&n=2 | denied | failed&why=...)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('youtube');
    if (!r) return;
    setSub('youtube');
    if (r === 'connected') setMsg(`YouTube connected: ${q.get('n') || 'the'} channel(s) added.`);
    else if (r === 'denied') setErr('Google sign-in was cancelled. Nothing was connected.');
    else setErr(`YouTube did not connect: ${q.get('why') || 'Google did not accept the sign-in'}.`);
    ['youtube', 'why', 'n'].forEach((k) => q.delete(k));
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  }, []);
  useEffect(() => { api.get('/admin/social-accounts/youtube/app').then((r) => setYt(r.data)).catch(() => setYt(null)); }, [reloadKey]);
  async function saveYoutubeApp() {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.put('/admin/social-accounts/youtube/app', ytForm); setYt(r.data); setYtForm({ clientId: '', clientSecret: '' }); setMsg(r.data.message || 'Saved.'); } catch (e) { setErr(e.response?.data?.error || 'Could not save that.'); } finally { setBusy(false); }
  }
  async function connectYoutube() {
    setBusy(true); setErr('');
    try { const r = await api.post('/admin/social-accounts/youtube/start'); window.location.href = r.data.url; } catch (e) { setErr(e.response?.data?.error || 'Could not open the Google sign-in.'); setBusy(false); }
  }
  useEffect(() => { api.get('/admin/social-accounts/linkedin/app').then((r) => setLi(r.data)).catch(() => setLi(null)); }, [reloadKey]);
  async function saveLinkedinApp() {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.put('/admin/social-accounts/linkedin/app', liForm); setLi(r.data); setLiForm({ clientId: '', clientSecret: '' }); setMsg(r.data.message || 'Saved.'); } catch (e) { setErr(e.response?.data?.error || 'Could not save that.'); } finally { setBusy(false); }
  }
  async function connectLinkedin() {
    setBusy(true); setErr('');
    try { const r = await api.post('/admin/social-accounts/linkedin/start', { pageId: liPageOn ? liPage.trim() : '' }); window.location.href = r.data.url; } catch (e) { setErr(e.response?.data?.error || 'Could not open the LinkedIn sign-in.'); setBusy(false); }
  }

  const load =() => api.get('/admin/social-accounts').then((r) => setAcc(r.data.accounts)).catch((e) => setErr(e.response?.data?.error || 'Could not load the accounts.'));
  useEffect(() => { load(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn) {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await fn(); if (r.data.accounts) setAcc(r.data.accounts); setMsg(r.data.message || 'Done.'); } catch (e) { if (e.response?.data?.accounts) setAcc(e.response.data.accounts); setErr(e.response?.data?.error || 'That did not work.'); } finally { setBusy(false); }
  }
  const openEdit = (a) => setEditing({ a, name: a.name, token: '' });
  async function saveEdit() {
    const e = editing;
    await act(() => api.post(`/admin/social-accounts/${e.a.id}/edit`, { name: e.name, ...(e.token.trim() ? { token: e.token.trim() } : {}) }));
    setEditing(null);
  }
  const makeDefault = (a) => act(() => api.post(`/admin/social-accounts/${a.id}/default`));
  const removeOne = (a) => { if (window.confirm(`Remove ${a.name}?${a.platform === 'facebook' ? ' Its Instagram account goes too.' : ''}`)) act(() => api.post(`/admin/social-accounts/${a.id}/remove`)); };
  // another = "+ Add another Facebook account": Facebook asks to sign in again, where "Not you? Log in to another account" switches the login
  async function connectFacebook(another = false) {
    setBusy(true); setErr('');
    try { const r = await api.post('/admin/integrations/social/facebook/start', { values: {}, another: !!another }); window.location.href = r.data.url; } catch (e) { setErr(e.response?.data?.error || 'Could not open the Facebook sign-in. Do the one-time setup first.'); setShowSetup(true); setBusy(false); }
  }

  if (!acc) return <div className="small-muted">{err || 'Loading…'}</div>;
  const counts = { facebook: acc.facebook.length, instagram: acc.instagram.length, threads: acc.threads.length, linkedin: (acc.linkedin || []).length, youtube: (acc.youtube || []).length };

  const NAMES = { facebook: 'Page access token', instagram: 'Page access token (of the Page it comes with)', threads: 'Threads access token' };
  return (
    <div style={{ maxWidth: 960 }}>
      {editing && (
        <Modal title={`Edit ${editing.a.name}`} onClose={() => setEditing(null)}
          foot={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit} disabled={busy || !editing.name.trim()}>{busy ? 'Saving…' : 'Save'}</button></>}>
          <label className="field"><span>Name shown in TeamLink</span>
            <input value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          {editing.a.platform === 'youtube' ? (
            <div className="small-muted" style={{ fontSize: 12.5 }}>To renew a YouTube channel, press <b>Connect YouTube</b> again on the YouTube tab.</div>
          ) : editing.a.platform === 'linkedin' ? (
            <div className="small-muted" style={{ fontSize: 12.5 }}>A LinkedIn token lasts 60 days: to renew it, press <b>Connect LinkedIn</b> again on the LinkedIn tab.</div>
          ) : (
            <label className="field"><span>New {NAMES[editing.a.platform] || 'token'} (only if it changed)</span>
              <textarea rows={2} value={editing.token} placeholder="Leave empty to keep the saved token" onChange={(e) => setEditing({ ...editing, token: e.target.value.replace(/\s/g, '') })} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </label>
          )}
          <div className="small-muted" style={{ fontSize: 12 }}>A new token is checked first: it must belong to this same account. {editing.a.isDefault ? 'This is the default account, so job posts and Omni-Channel use the new token at once.' : ''}</div>
        </Modal>
      )}
      <div className="tabs" style={{ marginBottom: 14 }}>
        {SUBS.map(([k, label]) => (
          <div key={k} className={`tab${sub === k ? ' active' : ''}`} onClick={() => { setSub(k); setMsg(''); setErr(''); }}>
            {label} <span className="status active">{counts[k]}</span>
          </div>
        ))}
      </div>
      {msg && <div className="small-muted" role="status" style={{ marginBottom: 10, color: '#1c7c4a' }}>{msg}</div>}
      {err && <div className="error-text" style={{ marginBottom: 10 }}>{err}</div>}

      {sub === 'facebook' && (
        <>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <b style={{ fontSize: 15 }}>Facebook Pages</b>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={() => connectFacebook(false)} disabled={busy}>＋ Connect Facebook Pages</button>
                <button type="button" className="btn" onClick={() => connectFacebook(true)} disabled={busy} title="Sign in with a different Facebook account and add its Pages">＋ Add another Facebook account</button>
              </div>
            </div>
            <AccountList rows={acc.facebook} noun="Facebook Pages" onDefault={makeDefault} onRemove={removeOne} onEdit={openEdit} busy={busy} extra={(a) => `Page ID ${a.externalId}`} />
            <div className="small-muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
              Facebook asks which Pages: tick all you want, and tick them all again here. <b>Another Facebook account?</b> On Facebook&apos;s page press
              <b> Log in to another account</b> (or sign out of facebook.com first), then pick its Pages. That account needs a role in your Meta app (App roles → Roles) while the app is in development.
              The <b>★ default</b> Page is the one job posts and Omni-Channel use.
            </div>
          </div>
          <details open={showSetup || !acc.facebook.length} onToggle={(e) => setShowSetup(e.target.open)}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 10 }}>One-time setup of the Meta app (and help when Facebook shows an error)</summary>
            <FacebookSetup embedded />
          </details>
        </>
      )}

      {sub === 'instagram' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <b style={{ fontSize: 15 }}>Instagram accounts</b>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={() => connectFacebook(false)} disabled={busy} title="Instagram accounts come through the Facebook Page they are linked to">＋ Add Instagram account</button>
              <button type="button" className="btn" onClick={() => act(() => api.post('/admin/social-accounts/instagram/refresh'))} disabled={busy || !acc.facebook.length}>↻ Find Instagram accounts again</button>
            </div>
          </div>
          <AccountList rows={acc.instagram} noun="Instagram accounts" onDefault={makeDefault} onRemove={removeOne} onEdit={openEdit} busy={busy} extra={(a) => `Through the Page ${a.parentName || a.parentId}`} />
          <div className="small-muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
            Instagram comes with a Facebook Page: an Instagram <b>professional</b> (business / creator) account linked to a connected Page shows here by itself.
            To link one: Facebook Page → <b>Settings → Linked accounts → Instagram → Connect</b>, then press <b>Connect Facebook Pages</b> again on the Facebook tab
            (allow the Instagram access Facebook asks for) or <b>Find Instagram accounts again</b> here.
          </div>
        </div>
      )}

      {sub === 'threads' && (
        <div className="card" style={{ padding: 16 }}>
          <b style={{ fontSize: 15 }}>Threads profiles</b>
          <div style={{ margin: '10px 0' }}><AccountList rows={acc.threads} noun="Threads profiles" onDefault={makeDefault} onRemove={removeOne} onEdit={openEdit} busy={busy} extra={(a) => `Threads ID ${a.externalId}`} /></div>
          <b>＋ Connect a Threads profile</b> (each profile has its own token, made in the same Meta app):
          <ol style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
            <li>Meta app: <b>App roles → Roles → Threads testers → Add</b> the Threads account. On threads.net: <b>Settings → Account → Website permissions → Invites → Accept</b>.</li>
            <li>Meta app: <b>Use cases → Access the Threads API → Customize</b>: add <b>threads_basic</b> and <b>threads_content_publish</b>.</li>
            <li>Same use case: <b>User Token Generator → Generate Access Token</b> for that Threads account and copy it.</li>
            <li>Paste it below and press <b>Connect Threads</b>. Repeat for every Threads profile.</li>
          </ol>
          <textarea rows={2} value={thToken} onChange={(e) => setThToken(e.target.value.replace(/\s/g, ''))} placeholder="Paste a Threads access token here" style={{ width: '100%', marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} />
          <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={busy || thToken.length < 20}
            onClick={() => act(async () => { const r = await api.post('/admin/social-accounts/threads', { token: thToken }); setThToken(''); return r; })}>
            {busy ? 'Checking with Threads…' : 'Connect Threads'}
          </button>
          <div className="small-muted" style={{ fontSize: 12.5, marginTop: 8 }}>The <b>★ default</b> Threads profile is the one Omni-Channel uses.</div>
        </div>
      )}

      {sub === 'linkedin' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <b style={{ fontSize: 15 }}>LinkedIn accounts</b>
            <button type="button" className="btn btn-primary" onClick={connectLinkedin} disabled={busy || !(li && li.hasApp)} title={li && li.hasApp ? '' : 'Do the one-time setup below first'}>＋ Connect LinkedIn</button>
          </div>
          <AccountList rows={acc.linkedin || []} noun="LinkedIn accounts" onDefault={makeDefault} onRemove={removeOne} onEdit={openEdit} busy={busy} extra={(a) => (a.kind === 'page' ? `Company Page · posts as ${a.externalId.replace('urn:li:organization:', 'page ')}` : 'Your profile')} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13.5 }}>
            <input type="checkbox" checked={liPageOn} onChange={(e) => setLiPageOn(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span>Also post for a <b>Company Page</b> (needs LinkedIn&apos;s approval of the Community Management API for your app)</span>
          </label>
          {liPageOn && (
            <input type="text" inputMode="numeric" value={liPage} onChange={(e) => setLiPage(e.target.value.replace(/\D/g, ''))} placeholder="Company Page number, for example 12345678 (linkedin.com/company/12345678/admin)" style={{ width: '100%', maxWidth: 520, marginTop: 6 }} />
          )}
          <div className="small-muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
            You sign in on LinkedIn&apos;s own page (the password is never typed in TeamLink). By default jobs are posted on <b>your profile</b>; tick the Company Page box to post on the Page instead.
            The <b>★ default</b> account is the one job posts use. A LinkedIn token lasts about <b>60 days</b>: press Connect LinkedIn again when it says Expired.
            This posts on the LinkedIn <b>feed</b>; LinkedIn does not let programs create entries in LinkedIn Jobs (that stays the by-hand LinkedIn tile).
          </div>
          <details open={!(li && li.hasApp)} style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>One-time setup of the LinkedIn app</summary>
            <ol style={{ margin: '4px 0 8px', paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
              <li>On <b>developers.linkedin.com</b> press <b>Create app</b> (it needs a LinkedIn Page of your company to belong to).</li>
              <li><b>Products</b> tab: add <b>Sign In with LinkedIn using OpenID Connect</b> and <b>Share on LinkedIn</b> (both free and instant). For a Company Page also request <b>Community Management API</b>.</li>
              <li><b>Auth</b> tab: under <b>Authorized redirect URLs</b> add exactly this address: <code style={{ userSelect: 'all' }}>{li ? li.redirectUri : ''}</code></li>
              <li>On the same Auth tab copy the <b>Client ID</b> and <b>Client Secret</b> and type them here once.</li>
            </ol>
            {li && li.hasApp && <div className="small-muted" style={{ marginBottom: 6 }}>Saved: Client ID <b>{li.clientId}</b> · secret saved (never shown). Type new ones only to replace them.</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 13 }}>Client ID<br /><input type="text" autoComplete="off" value={liForm.clientId} onChange={(e) => setLiForm({ ...liForm, clientId: e.target.value.trim() })} placeholder={li && li.hasApp ? 'Leave empty to keep' : 'Client ID'} /></label>
              <label style={{ fontSize: 13 }}>Client Secret<br /><input type="password" autoComplete="new-password" value={liForm.clientSecret} onChange={(e) => setLiForm({ ...liForm, clientSecret: e.target.value.trim() })} placeholder={li && li.hasSecret ? 'Leave empty to keep' : 'Client Secret'} /></label>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || (!liForm.clientId && !liForm.clientSecret)} onClick={saveLinkedinApp}>Save app details</button>
            </div>
          </details>
        </div>
      )}

      {sub === 'youtube' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <b style={{ fontSize: 15 }}>YouTube channels</b>
            <button type="button" className="btn btn-primary" onClick={connectYoutube} disabled={busy || !(yt && yt.hasApp)} title={yt && yt.hasApp ? '' : 'Do the one-time setup below first'}>＋ Connect YouTube channel</button>
          </div>
          <AccountList rows={acc.youtube || []} noun="YouTube channels" onDefault={makeDefault} onRemove={removeOne} onEdit={openEdit} busy={busy} extra={(a) => `Channel ID ${a.externalId}`} />
          <div className="small-muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
            You sign in on Google&apos;s own page (the password is never typed in TeamLink) and pick the Google account or <b>Brand Account</b> that owns the channel.
            Press the button again for every other channel / Google account. The <b>★ default</b> channel is the one TeamLink uses.
          </div>
          <details open={!(yt && yt.hasApp)} style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>One-time setup of the Google app</summary>
            <ol style={{ margin: '4px 0 8px', paddingLeft: 18, lineHeight: 1.7, fontSize: 13.5 }}>
              <li>Open <b>console.cloud.google.com</b>, make (or pick) a project, then <b>APIs &amp; Services → Library</b> → enable <b>YouTube Data API v3</b>.</li>
              <li><b>OAuth consent screen</b>: type <b>External</b>, app name TeamLink, your email; while it is in <b>Testing</b>, add every Google account that will connect under <b>Test users</b>.</li>
              <li><b>Credentials → Create credentials → OAuth client ID</b> → type <b>Web application</b>; under <b>Authorized redirect URIs</b> add exactly: <code style={{ userSelect: 'all' }}>{yt ? yt.redirectUri : ''}</code></li>
              <li>Copy the <b>Client ID</b> and <b>Client secret</b> it shows and type them here once.</li>
            </ol>
            {yt && yt.hasApp && <div className="small-muted" style={{ marginBottom: 6 }}>Saved: Client ID <b>{yt.clientId}</b> · secret saved (never shown). Type new ones only to replace them.</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 13 }}>Client ID<br /><input type="text" autoComplete="off" value={ytForm.clientId} onChange={(e) => setYtForm({ ...ytForm, clientId: e.target.value.trim() })} placeholder={yt && yt.hasApp ? 'Leave empty to keep' : '1234-abc.apps.googleusercontent.com'} style={{ minWidth: 280 }} /></label>
              <label style={{ fontSize: 13 }}>Client secret<br /><input type="password" autoComplete="new-password" value={ytForm.clientSecret} onChange={(e) => setYtForm({ ...ytForm, clientSecret: e.target.value.trim() })} placeholder={yt && yt.hasSecret ? 'Leave empty to keep' : 'Client secret'} /></label>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || (!ytForm.clientId && !ytForm.clientSecret)} onClick={saveYoutubeApp}>Save app details</button>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

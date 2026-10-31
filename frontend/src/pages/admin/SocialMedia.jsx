import { useEffect, useState } from 'react';
import api from '../../api';
import FacebookSetup from './FacebookSetup.jsx';

// Administration > Integrations > Social Media (founder 2026-10-30: "separate ga tabs ravali mothaniki okka tab social media anni dantlo
// facebook anni okka tab and instagram tab ani and threds ... facebook accounts 5 ala unati anni accounts ina connect chesukodaniki undali").
// Three tabs - Facebook, Instagram, Threads - each with every connected account (any number, from any number of logins), one marked as
// the default (*): job posts and Omni-Channel use the default. Server: /admin/social-accounts (utils/socialAccounts.js). No token is shown.
const SUBS = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['threads', 'Threads']];

function AccountList({ rows, noun, onDefault, onRemove, busy, extra }) {
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
          <td><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onRemove(a)}>Remove</button></td>
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

  const load = () => api.get('/admin/social-accounts').then((r) => setAcc(r.data.accounts)).catch((e) => setErr(e.response?.data?.error || 'Could not load the accounts.'));
  useEffect(() => { load(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn) {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await fn(); if (r.data.accounts) setAcc(r.data.accounts); setMsg(r.data.message || 'Done.'); } catch (e) { if (e.response?.data?.accounts) setAcc(e.response.data.accounts); setErr(e.response?.data?.error || 'That did not work.'); } finally { setBusy(false); }
  }
  const makeDefault = (a) => act(() => api.post(`/admin/social-accounts/${a.id}/default`));
  const removeOne = (a) => { if (window.confirm(`Remove ${a.name}?${a.platform === 'facebook' ? ' Its Instagram account goes too.' : ''}`)) act(() => api.post(`/admin/social-accounts/${a.id}/remove`)); };
  async function connectFacebook() {
    setBusy(true); setErr('');
    try { const r = await api.post('/admin/integrations/social/facebook/start', { values: {} }); window.location.href = r.data.url; } catch (e) { setErr(e.response?.data?.error || 'Could not open the Facebook sign-in. Do the one-time setup first.'); setShowSetup(true); setBusy(false); }
  }

  if (!acc) return <div className="small-muted">{err || 'Loading…'}</div>;
  const counts = { facebook: acc.facebook.length, instagram: acc.instagram.length, threads: acc.threads.length };

  return (
    <div style={{ maxWidth: 960 }}>
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
              <button type="button" className="btn btn-primary" onClick={connectFacebook} disabled={busy}>＋ Connect Facebook Pages</button>
            </div>
            <AccountList rows={acc.facebook} noun="Facebook Pages" onDefault={makeDefault} onRemove={removeOne} busy={busy} extra={(a) => `Page ID ${a.externalId}`} />
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
            <button type="button" className="btn" onClick={() => act(() => api.post('/admin/social-accounts/instagram/refresh'))} disabled={busy || !acc.facebook.length}>↻ Find Instagram accounts again</button>
          </div>
          <AccountList rows={acc.instagram} noun="Instagram accounts" onDefault={makeDefault} onRemove={removeOne} busy={busy} extra={(a) => `Through the Page ${a.parentName || a.parentId}`} />
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
          <div style={{ margin: '10px 0' }}><AccountList rows={acc.threads} noun="Threads profiles" onDefault={makeDefault} onRemove={removeOne} busy={busy} extra={(a) => `Threads ID ${a.externalId}`} /></div>
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
    </div>
  );
}

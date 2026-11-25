import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './clientPosts.css';

// THE "SOCIAL POSTS" CLIENT LOGIN > MY SOCIAL ACCOUNTS (2026-11-25). Read only: the Facebook Pages / Instagram / X accounts TeamLink manages for the signed-in company, whether each is connected,
// and how many posts wait for approval / are about to go out / went out on it. Server: GET /api/portal/client/posts/accounts (marketing/clientPhone.js accounts()). Nothing can be changed here.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (iso) => { try { return iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : ''; } catch { return ''; } };
const ICON = { facebook: 'f', instagram: '◎', x: '𝕏', threads: '@', linkedin: 'in', youtube: '▶' };

export default function ClientAccounts() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/portal/client/posts/accounts').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Your accounts could not be opened just now. Please try again.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <div className="cpx"><div className="cpx-msg err">{err} <button type="button" className="cpx-back" onClick={load}>Try again</button></div></div>;
  if (!d) return <div className="cpx"><div className="cpx-meta">Loading your accounts…</div></div>;
  return (
    <div className="cpx">
      <h1>My social accounts</h1>
      <div className="cpx-sub">The accounts TeamLink looks after for {d.company}. You can see them here; to add or change one, ask your TeamLink contact.</div>
      <div className="cpx-stats">
        <div className="cpx-stat"><b>{d.counts.waiting}</b><span>waiting for you</span></div>
        <div className="cpx-stat"><b>{d.counts.approved}</b><span>approved</span></div>
        <div className="cpx-stat"><b>{d.counts.posted}</b><span>posted</span></div>
      </div>
      {d.counts.waiting > 0 ? <Link className="cpx-btn" style={{ textDecoration: 'none', marginTop: 0, marginBottom: 14 }} to="/client-posts">Look at the {d.counts.waiting} post{d.counts.waiting === 1 ? '' : 's'} waiting for you</Link> : null}
      {d.accounts.length === 0 ? (
        <div className="cpx-card"><div className="cpx-body" style={{ textAlign: 'center', padding: '24px 14px' }}>
          <div style={{ fontSize: 34 }} aria-hidden="true">📣</div>
          <h3 className="cpx-title">No account is linked yet</h3>
          <div className="cpx-meta">Our team has not linked your Facebook, Instagram or X account yet. Ask your TeamLink contact if you want your posts to go out on them.</div>
        </div></div>
      ) : (
        <div className="cpx-list">
          {d.accounts.map((a, i) => (
            <div className="cpx-card" key={`${a.platform}-${a.name}-${i}`}><div className="cpx-body">
              <div className="cpx-acct">
                <div className="cpx-ico" aria-hidden="true">{ICON[a.platform] || '●'}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h3 className="cpx-title" style={{ marginBottom: 2 }}>{a.name}</h3>
                  <div className="cpx-meta">{a.platformWord}{a.username ? ` · @${a.username.replace(/^@/, '')}` : ''}{a.pageName && a.platform === 'instagram' ? ` · on the page ${a.pageName}` : ''}</div>
                </div>
                <span className={`cpx-chip ${a.connected ? 'green' : 'amber'}`}>{a.connected ? 'Connected' : 'Needs attention'}</span>
              </div>
              {!a.connected ? <div className="cpx-msg info">{a.statusWords}.</div> : null}
              <div className="cpx-kv">
                <span>Waiting for your approval</span><span>{a.waiting}</span>
                <span>Going out soon</span><span>{a.soon}</span>
                <span>Posted so far</span><span>{a.posted}</span>
                <span>Last post</span><span>{a.lastPostedAt ? (a.lastPostUrl ? <a href={a.lastPostUrl} target="_blank" rel="noopener noreferrer">{when(a.lastPostedAt)}</a> : when(a.lastPostedAt)) : '—'}</span>
              </div>
            </div></div>
          ))}
        </div>
      )}
      {d.told.length > 0 ? (
        <>
          <h2>Pages you told us about</h2>
          <div className="cpx-card"><div className="cpx-body">{d.told.map((l) => <div key={l} className="cpx-preview" style={{ margin: '2px 0' }}>{l}</div>)}</div></div>
        </>
      ) : null}
      {d.recent.length > 0 ? (
        <>
          <h2>Recently posted</h2>
          <div className="cpx-list">{d.recent.map((r, i) => (
            <div className="cpx-card" key={`${r.title}-${i}`}><div className="cpx-body"><b>{r.title}</b><div className="cpx-meta">{r.at ? `${when(r.at)} · ` : ''}{r.on.join(', ')}</div></div></div>
          ))}</div>
        </>
      ) : null}
      {!d.postingOn ? <div className="cpx-msg info" style={{ marginTop: 14 }}>Posting by TeamLink is switched off at the moment. Approved posts are posted by our team by hand.</div> : null}
    </div>
  );
}

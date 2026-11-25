import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import './clientPosts.css';

// THE "SOCIAL POSTS" CLIENT LOGIN, ON THE PHONE (2026-11-25). A client signs in with their own login and sees the posts TeamLink made for THEIR company:
//   "Posts to approve"      each one opens full screen: the picture / video / words, the accounts and exact words it will be posted with, and two big buttons: Approve, or Reject (a reason is needed).
//   "Approved & posted"     what they already answered and where it stands (approved, posted with the link, or "you said no, we are working on it").
// Server: routes/portalPosts.js -> marketing/clientPhone.js -> marketing/clientReview.js (the same approval the private link and the WhatsApp buttons use). The name on an answer is the login's own.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (iso) => { try { return iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''; } catch { return ''; } };
const KIND = { picture: 'Picture', video: 'Video', words: 'Message' };
const TONE = { waiting: 'amber', approved: 'blue', posted: 'green', changes: 'red', updating: 'blue', expired: 'red' };

function Thumb({ p }) {
  const [bad, setBad] = useState(false);
  if (p.kind === 'video') return <div className="cpx-thumb-video">▶ Video: open to watch</div>;
  if (p.kind !== 'picture' || bad || !p.thumb) return null;
  return <img className="cpx-thumb" src={p.thumb} alt={p.title} loading="lazy" onError={() => setBad(true)} />;
}

function Card({ p, onOpen }) {
  return (
    <div className={`cpx-card${p.needsYou ? ' need' : ''}`}>
      <Thumb p={p} />
      <div className="cpx-body">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <span className={`cpx-chip ${TONE[p.status] || ''}`}>{p.words}</span>
          <span className="cpx-meta">{KIND[p.kind] || 'Post'}{p.sentAt ? ` · sent ${when(p.sentAt)}` : ''}</span>
        </div>
        <h3 className="cpx-title">{p.title}</h3>
        {p.preview ? <p className="cpx-preview">{p.preview}{p.preview.length >= 180 ? '…' : ''}</p> : null}
        {p.status === 'changes' && p.comment ? <div className="cpx-note">Your reason: “{p.comment}”</div> : null}
        {p.status === 'posted' && p.postedOn.length ? (
          <div className="cpx-meta" style={{ marginTop: 6 }}>Posted on {p.postedOn.map((x, i) => <span key={`${x.name}-${i}`}>{i ? ', ' : ''}{x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer">{x.name} ({x.platformWord})</a> : `${x.name} (${x.platformWord})`}</span>)}</div>
        ) : null}
        {p.status === 'approved' && p.decidedAt ? <div className="cpx-meta" style={{ marginTop: 6 }}>You approved it {when(p.decidedAt)}.{p.postOn.length ? ` To be posted on ${p.postOn.join(', ')}.` : ''}</div> : null}
        {['waiting', 'approved', 'posted'].includes(p.status) || p.status === 'changes' ? (
          <button type="button" className={`cpx-btn${p.needsYou ? '' : ' plain'}`} onClick={() => onOpen(p.id)}>{p.needsYou ? 'Look and answer' : 'Open'}</button>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ id, onBack, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState(false);
  const [why, setWhy] = useState('');
  const [allow, setAllow] = useState(false);
  const [tab, setTab] = useState('');
  const [picBad, setPicBad] = useState(false);
  const load = useCallback(() => api.get(`/portal/client/posts/${encodeURIComponent(id)}`).then((r) => {
    setD(r.data); setErr('');
    const ch = r.data.words && r.data.words.channels; if (ch && ch.length) setTab((t) => t || ch[0].key);
  }).catch((e) => setErr(errOf(e, 'This post could not be opened just now. Please try again.'))), [id]);
  useEffect(() => { setD(null); setDone(''); setReject(false); setWhy(''); setAllow(false); setPicBad(false); load(); }, [load]);

  const answer = async (decision) => {
    setErr('');
    if (decision === 'reject' && why.trim().length < 5) { setErr('Please tell us why, in a few words, so we can fix it.'); return; }
    setBusy(true);
    try {
      const body = { decision, comment: why.trim(), ...(decision === 'approve' && d.post && allow ? { allowPosting: true, planKey: d.post.key } : {}) };
      const r = await api.post(`/portal/client/posts/${encodeURIComponent(id)}/decision`, body);
      setDone(r.data.ok || 'Thank you.'); setReject(false); setWhy(''); setAllow(false);
      load(); if (onChanged) onChanged();
    } catch (e) { setErr(errOf(e, 'Your answer could not be saved. Please try again.')); } finally { setBusy(false); }
  };
  const allowLater = async () => {
    setErr('');
    if (!allow) { setErr('Tick the box to allow the posting.'); return; }
    setBusy(true);
    try { const r = await api.post(`/portal/client/posts/${encodeURIComponent(id)}/allow-posting`, { allowPosting: true, planKey: d.post.key }); setDone(r.data.ok || 'Thank you.'); setAllow(false); load(); if (onChanged) onChanged(); } catch (e) { setErr(errOf(e, 'It could not be saved. Please try again.')); } finally { setBusy(false); }
  };

  if (!d) return (<div><button type="button" className="cpx-back" onClick={onBack}>← Back</button>{err ? <div className="cpx-msg err">{err}</div> : <div className="cpx-meta">Opening…</div>}</div>);
  const open = d.status === 'sent' && !d.outdated;
  const what = d.kind === 'video' ? 'video' : (d.kind === 'words' ? 'message' : 'picture');
  const post = d.post;
  const accountsWords = post ? post.accounts.map((a) => `${a.name} (${a.platformWord})`).join(', ') : '';
  const postBox = post ? (
    <div className="cpx-box">
      <b>Posting after your approval</b>
      <div style={{ marginTop: 6 }}>If you allow it, {d.brand.name} will post this {what} on <b>{accountsWords}</b> with these words:</div>
      <pre className="cpx-words" style={{ marginTop: 8, background: '#fff' }}>{post.caption}</pre>
      <label htmlFor="cpx-allow"><input id="cpx-allow" type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} /><span>I allow {d.brand.name} to post the {what} on {accountsWords}, with these exact words.</span></label>
      <div className="cpx-meta" style={{ marginTop: 8 }}>Without the tick nothing is posted. If you reject it, nothing is posted: you will see the new version and these words again first.</div>
    </div>
  ) : null;

  return (
    <div>
      <button type="button" className="cpx-back" onClick={onBack}>← All posts</button>
      <div className="cpx-card"><div className="cpx-body">
        <h1 className="cpx-title" style={{ fontSize: 18 }}>{d.title}{d.version > 1 ? <span className="cpx-meta" style={{ marginLeft: 8, color: '#15803d' }}>Version {d.version}, with your changes</span> : null}</h1>
        {d.note ? <div className="cpx-note">{d.note}</div> : null}
        <div style={{ marginTop: 12 }}>
          {d.kind === 'picture' ? (picBad
            ? <div className="cpx-msg err">The picture could not be shown just now. <a href={d.fileUrl} target="_blank" rel="noopener noreferrer">Open the picture</a>.</div>
            : <><img className="cpx-media" style={{ background: '#eef1ef' }} src={d.fileUrl} alt={d.title} onError={() => setPicBad(true)} /><div style={{ textAlign: 'right', marginTop: 4 }}><a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="cpx-meta">Open full size ↗</a></div></>) : null}
          {d.kind === 'video' ? <video className="cpx-media" src={d.fileUrl} controls playsInline preload="metadata" aria-label={d.title} /> : null /* eslint-disable-line jsx-a11y/media-has-caption */}
          {d.kind === 'words' && d.words ? (
            <div>
              {d.words.channels.length > 1 ? <div className="cpx-pills" role="tablist">{d.words.channels.map((c) => <button type="button" role="tab" aria-selected={tab === c.key} key={c.key} className={`cpx-pill${tab === c.key ? ' on' : ''}`} onClick={() => setTab(c.key)}>{c.label}</button>)}</div> : null}
              {tab === 'email' && d.words.subject ? <div style={{ fontSize: 14, marginBottom: 6 }}><span className="cpx-meta">Subject: </span><b>{d.words.subject}</b></div> : null}
              <pre className="cpx-words">{d.words.texts[tab || (d.words.channels[0] && d.words.channels[0].key)] || ''}</pre>
            </div>
          ) : null}
          {d.headline ? <div className="cpx-meta" style={{ marginTop: 8 }}>Headline on it: “{d.headline}”</div> : null}
        </div>

        {done ? <div className="cpx-msg ok" role="status">{done}</div> : null}
        {d.status === 'approved' && !done ? <div className="cpx-msg ok" role="status"><b>You approved this</b> on {when(d.decidedAt)}.{d.comment ? ` “${d.comment}”` : ''}</div> : null}
        {d.status === 'changes' && !done ? <div className="cpx-msg info" role="status"><b>You said no</b> on {when(d.decidedAt)}: “{d.comment}”. Our team will send a new version here.</div> : null}
        {d.status === 'expired' ? <div className="cpx-msg err">This one expired. Please ask your TeamLink contact to send it again.</div> : null}
        {d.outdated && d.status === 'sent' ? <div className="cpx-msg info">Our team is changing this. The new version will come to you here.</div> : null}

        {d.status === 'approved' && !done && post && post.when === 'later' ? (
          <div>{postBox}
            <button type="button" className="cpx-btn ok" disabled={busy} onClick={allowLater}>{busy ? 'Saving…' : '✔ Allow the posting'}</button>
          </div>
        ) : null}

        {open && !done ? (
          <div>
            {d.mode === 'decide' ? <div className="cpx-msg info">Your answer decides. We will use this only after you approve it.</div> : null}
            {post && post.when === 'with' ? postBox : null}
            {reject ? (
              <div>
                <label className="cpx-label" htmlFor="cpx-why">Why are you rejecting it? What should change?</label>
                <textarea id="cpx-why" value={why} maxLength={600} onChange={(e) => setWhy(e.target.value)} placeholder="For example: please use our new logo and shorten the text" />
                {err ? <div className="cpx-msg err" role="alert">{err}</div> : null}
                <button type="button" className="cpx-btn no" disabled={busy} onClick={() => answer('reject')}>{busy ? 'Sending…' : 'Send my rejection'}</button>
                <button type="button" className="cpx-btn plain" disabled={busy} onClick={() => { setReject(false); setErr(''); }}>Cancel</button>
              </div>
            ) : (
              <div>
                {err ? <div className="cpx-msg err" role="alert">{err}</div> : null}
                <div className="cpx-actions">
                  <button type="button" className="cpx-btn ok" disabled={busy} onClick={() => answer('approve')}>{busy ? 'Sending…' : '✔ Approve'}</button>
                  <button type="button" className="cpx-btn no" disabled={busy} onClick={() => { setReject(true); setErr(''); }}>✖ Reject</button>
                </div>
              </div>
            )}
          </div>
        ) : (err && !reject ? <div className="cpx-msg err" role="alert">{err}</div> : null)}
      </div></div>
    </div>
  );
}

export default function ClientPosts() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'done' ? 'done' : 'approve';
  const openId = sp.get('post') || '';
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/portal/client/posts').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Your posts could not be opened just now. Please try again.'))), []);
  useEffect(() => { load(); }, [load]);
  const go = (next) => { const n = new URLSearchParams(sp); Object.keys(next).forEach((k) => { if (next[k]) n.set(k, next[k]); else n.delete(k); }); setSp(n); };

  if (openId) return <div className="cpx"><Detail id={openId} onBack={() => { go({ post: '' }); load(); }} onChanged={load} /></div>;
  if (err && !d) return <div className="cpx"><div className="cpx-msg err">{err} <button type="button" className="cpx-back" onClick={load}>Try again</button></div></div>;
  if (!d) return <div className="cpx"><div className="cpx-meta">Loading your posts…</div></div>;
  const items = tab === 'done' ? d.done : d.waiting;
  return (
    <div className="cpx">
      <h1>{d.company}</h1>
      <div className="cpx-sub">The social media posts TeamLink makes for you. Look at each one, then approve it or tell us what to change.</div>
      <div className="cpx-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'approve'} className={`cpx-tab${tab === 'approve' ? ' on' : ''}`} onClick={() => go({ tab: '' })}>To approve ({d.counts.waiting})</button>
        <button type="button" role="tab" aria-selected={tab === 'done'} className={`cpx-tab${tab === 'done' ? ' on' : ''}`} onClick={() => go({ tab: 'done' })}>Approved &amp; posted ({d.done.length})</button>
      </div>
      {err ? <div className="cpx-msg err">{err}</div> : null}
      {items.length === 0 ? (
        <div className="cpx-card"><div className="cpx-body" style={{ textAlign: 'center', padding: '28px 14px' }}>
          <div style={{ fontSize: 34 }} aria-hidden="true">{tab === 'done' ? '🗂️' : '🎉'}</div>
          <h3 className="cpx-title">{tab === 'done' ? 'Nothing here yet' : 'Nothing is waiting for you'}</h3>
          <div className="cpx-meta">{tab === 'done' ? 'Posts you approve will show here, and then where they were posted.' : 'When TeamLink has a new post for you, it shows here and you get an alert.'}</div>
        </div></div>
      ) : <div className="cpx-list">{items.map((p) => <Card key={p.id} p={p} onOpen={(id) => go({ post: id })} />)}</div>}
    </div>
  );
}

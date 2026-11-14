import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../api';

// THE CLIENT'S PAGE (/client-review/:token): no login, outside the TeamLink shell. The client sees one picture, video or set of AI-written words that the team
// has already approved, and presses "Approve" or "Request changes" (with their name and a comment). Real data: GET / POST /api/public/mk-review/:token
// (marketing/clientReview.js). Phone friendly, one column.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (iso) => { try { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }); } catch { return iso || ''; } };

export default function ClientReviewPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [gone, setGone] = useState('');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState(''); // '' | 'changes'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [tab, setTab] = useState('');
  const load = () => api.get(`/public/mk-review/${encodeURIComponent(token)}`).then((r) => { setD(r.data); document.title = `Please review: ${r.data.review.itemTitle}`; const ch = r.data.item && r.data.item.channels; if (ch && ch.length) setTab(ch[0].key); }).catch((e) => setGone(errOf(e, 'This link does not work any more. Please ask the sender for a new one.')));
  useEffect(() => { document.title = 'Please review'; load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const P = (d && d.brand && d.brand.colors && d.brand.colors.primary) || '#0f766e';
  const S2 = (d && d.brand && d.brand.colors && d.brand.colors.secondary) || '#134e4a';
  const page = { minHeight: '100vh', background: '#f4f6f5', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', color: '#1c2a24' };
  const card = { maxWidth: 640, margin: '0 auto', background: '#fff', borderRadius: 14, padding: '20px 18px', boxShadow: '0 1px 6px rgba(0,0,0,.08)' };
  const btn = (bg, fg = '#fff') => ({ border: 'none', borderRadius: 10, padding: '12px 18px', fontSize: 15, fontWeight: 800, background: bg, color: fg, cursor: busy ? 'default' : 'pointer', flex: '1 1 160px', opacity: busy ? 0.6 : 1 });
  const input = { width: '100%', boxSizing: 'border-box', border: '1px solid #cfd8d3', borderRadius: 10, padding: '11px 12px', font: 'inherit', fontSize: 15 };

  if (gone) return <div style={page}><div style={{ ...card, marginTop: 40 }}><h1 style={{ fontSize: 20, margin: '0 0 8px' }}>This link does not work</h1><p style={{ margin: 0, lineHeight: 1.6 }}>{gone}</p></div></div>;
  if (!d) return <div style={page}><div style={{ ...card, marginTop: 40 }}><p style={{ margin: 0 }}>Loading…</p></div></div>;

  const { review: r, brand, item } = d;
  const open = r.status === 'sent' && !r.outdated && !!item;
  const send = async (decision) => {
    setErr('');
    if (name.trim().length < 2) { setErr('Please write your name first.'); return; }
    if (decision === 'changes' && comment.trim().length < 5) { setMode('changes'); setErr('Please say what should change (a few words).'); return; }
    setBusy(true);
    try { const res = await api.post(`/public/mk-review/${encodeURIComponent(token)}/decision`, { decision, name: name.trim(), comment: comment.trim() }); setDone(res.data.ok || 'Thank you.'); load(); } catch (e) { setErr(errOf(e, 'It could not be sent. Please try again.')); } finally { setBusy(false); }
  };
  const fileUrl = `/api/public/mk-review/${encodeURIComponent(token)}/file`;

  return (
    <div style={page}>
      <div style={{ background: `linear-gradient(135deg, ${P}, ${S2})`, color: '#fff', padding: '22px 16px 52px' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: 12, letterSpacing: '.12em', fontWeight: 800, opacity: 0.85 }}>{String(brand.name || '').toUpperCase()}</div>
          <h1 style={{ fontSize: 22, margin: '6px 0 2px', color: '#fff', fontFamily: 'inherit' }}>Please review this{item ? (item.type === 'video' ? ' video' : item.type === 'image' ? ' picture' : ' message') : ''}</h1>
          <div style={{ fontSize: 14, opacity: 0.9 }}>For {r.clientName}{r.contactName ? ` · ${r.contactName}` : ''}</div>
        </div>
      </div>
      <div style={{ ...card, marginTop: -34 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 6px', color: '#1c2a24', fontFamily: 'inherit' }}>{r.itemTitle}</h2>
        {r.message ? <p style={{ margin: '0 0 12px', lineHeight: 1.6, background: '#f4f6f5', borderRadius: 10, padding: '10px 12px' }}>{r.message}</p> : null}

        {!item ? <p style={{ lineHeight: 1.6 }}>This content was removed by the sender. Please ask for a new link.</p> : null}
        {item && item.type === 'image' ? <img src={fileUrl} alt={r.itemTitle} style={{ width: '100%', borderRadius: 10, background: '#eef1ef', display: 'block' }} /> : null}
        {item && item.type === 'video' ? <video src={fileUrl} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 10, background: '#000', display: 'block' }} aria-label={r.itemTitle} /> : null}{/* eslint-disable-line jsx-a11y/media-has-caption */}
        {item && item.type === 'words' ? (
          <div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} role="tablist">
              {item.channels.map((c) => <button type="button" role="tab" aria-selected={tab === c.key} key={c.key} onClick={() => setTab(c.key)} style={{ border: `1px solid ${tab === c.key ? P : '#cfd8d3'}`, background: tab === c.key ? P : '#fff', color: tab === c.key ? '#fff' : '#1c2a24', borderRadius: 18, padding: '6px 12px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{c.label}</button>)}
            </div>
            {tab === 'email' && item.subject ? <div style={{ fontSize: 14, marginBottom: 6 }}><span style={{ color: '#6b7a73' }}>Subject: </span><b>{item.subject}</b></div> : null}
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', fontSize: 15, lineHeight: 1.6, background: '#f4f6f5', borderRadius: 10, padding: '12px 14px', margin: 0 }}>{item.texts[tab] || ''}</pre>
          </div>
        ) : null}
        {item && item.headline ? <p style={{ fontSize: 13, color: '#6b7a73', margin: '8px 0 0' }}>Headline on it: “{item.headline}”</p> : null}

        <div style={{ borderTop: '1px solid #e4eae6', marginTop: 16, paddingTop: 16 }}>
          {done ? <div role="status" style={{ background: '#e6f6ec', color: '#14532d', borderRadius: 10, padding: '12px 14px', fontWeight: 700 }}>{done}</div> : null}
          {r.status === 'approved' && !done ? <div role="status" style={{ background: '#e6f6ec', color: '#14532d', borderRadius: 10, padding: '12px 14px' }}><b>Approved</b> by {r.decidedByName} on {when(r.decidedAt)}.{r.comment ? ` “${r.comment}”` : ''}</div> : null}
          {r.status === 'changes' && !done ? <div role="status" style={{ background: '#fdf1e3', color: '#7a4a07', borderRadius: 10, padding: '12px 14px' }}><b>Changes requested</b> by {r.decidedByName} on {when(r.decidedAt)}: “{r.comment}”. The sender will send a new version.</div> : null}
          {r.status === 'expired' ? <div role="status" style={{ background: '#fdecea', color: '#8a1c13', borderRadius: 10, padding: '12px 14px' }}>This link has expired. Please ask the sender for a new one.</div> : null}
          {r.outdated && r.status === 'sent' ? <div role="status" style={{ background: '#fdecea', color: '#8a1c13', borderRadius: 10, padding: '12px 14px' }}>This was changed after the link was made. Please ask the sender for a new link.</div> : null}
          {open && !done ? (
            <div>
              {r.mode === 'decide' ? <p style={{ background: '#eef6ff', color: '#1d4fa8', borderRadius: 10, padding: '10px 12px', fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}><b>Your answer decides.</b> We will use this only after you approve it. If you ask for changes, we will fix it and send it to you again.</p> : null}
              <label htmlFor="rv-name" style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Your name</label>
              <input id="rv-name" style={input} value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="So we know who answered" />
              <label htmlFor="rv-comment" style={{ display: 'block', fontSize: 13, fontWeight: 700, margin: '12px 0 4px' }}>{mode === 'changes' ? 'What should change?' : 'A comment (optional for Approve)'}</label>
              <textarea id="rv-comment" style={{ ...input, minHeight: 90 }} value={comment} maxLength={600} onChange={(e) => setComment(e.target.value)} placeholder={mode === 'changes' ? 'For example: please use our new logo and shorten the text' : ''} />
              {err ? <div role="alert" style={{ color: '#b3261e', fontSize: 14, marginTop: 8 }}>{err}</div> : null}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                <button type="button" disabled={busy} style={btn('#15803d')} onClick={() => send('approve')}>{busy ? 'Sending…' : '✔ Approve'}</button>
                <button type="button" disabled={busy} style={btn('#fff', '#8a4b08')} onClick={() => (mode === 'changes' ? send('changes') : (setMode('changes'), setErr('')))}><span style={{ border: '2px solid #d98a2b', borderRadius: 10, padding: '10px 16px', display: 'block' }}>↩ Request changes</span></button>
              </div>
              <p style={{ fontSize: 12, color: '#6b7a73', margin: '12px 0 0' }}>This link is private. You can answer once; it works until {when(r.expiresAt)}.</p>
            </div>
          ) : null}
        </div>
      </div>
      <p style={{ textAlign: 'center', fontSize: 12, color: '#6b7a73', margin: '16px 0 24px' }}>Sent by {brand.name}</p>
    </div>
  );
}

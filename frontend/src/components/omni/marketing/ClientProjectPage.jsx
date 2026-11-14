import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../api';
import OurWork from './OurWork.jsx';

// THE CLIENT'S PROJECT PAGE (/client-project/:token): no login, outside the TeamLink shell. One private link for the whole life of a project:
//   invited -> the request form (what they need, their pages, their logo)      request / working -> "we have it" and what we are doing
//   awaiting_client -> the OPTIONS: pick ONE and add suggestions, or ask for changes      approved / posted -> thank you, the chosen one, the result
// Real data: GET / POST /api/public/mk-project/:token (marketing/projects.js). Phone friendly, one column.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (iso) => { try { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }); } catch { return iso || ''; } };
const day = (s) => { try { return new Date(`${s}T00:00:00+05:30`).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }); } catch { return s || ''; } };
const PLATFORMS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['whatsapp', 'WhatsApp status']];
const DELIVERABLES = [['video', 'A video'], ['image', 'Pictures'], ['both', 'Video and pictures']];
const readLogo = (file) => new Promise((resolve, reject) => {
  if (!file) { resolve(''); return; }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('Please use a PNG, JPG or WebP picture for the logo.')); return; }
  if (file.size > 300 * 1024) { reject(new Error(`The logo is too big (${Math.round(file.size / 1024)} KB). Please use one under 300 KB.`)); return; }
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('The logo could not be read.')); r.readAsDataURL(file);
});

export default function ClientProjectPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [gone, setGone] = useState('');
  const [temp, setTemp] = useState(false); // the site was busy / updating (not a dead link)
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState(''); // '' | 'changes'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [f, setF] = useState({ occasion: '', brief: '', deliverable: 'video', platforms: ['instagram'], handles: '', dueDate: '', contactName: '', contactEmail: '', contactPhone: '', colors: {} });
  const [logo, setLogo] = useState('');
  const base = `/public/mk-project/${encodeURIComponent(token)}`;
  const load = useCallback(() => api.get(base).then((r) => { setD(r.data); document.title = r.data.project.status === 'invited' ? 'Tell us what you need' : r.data.project.status === 'awaiting_client' ? 'Please choose' : 'Your request'; setF((x) => ({ ...x, contactName: x.contactName || r.data.project.contactName || '', contactEmail: x.contactEmail || r.data.project.contactEmail || '', contactPhone: x.contactPhone || r.data.project.contactPhone || '' })); }).catch((e) => {
    const s = e && e.response && e.response.status;
    if (!s || s >= 500) { setTemp(true); setGone('The page could not be opened just now: our site may be updating. Please wait a minute, then press the button below.'); return; } // a busy / updating site is not a dead link
    setTemp(false); setGone(errOf(e, 'This link does not work any more. Please ask the sender for a new one.'));
  }), [base]);
  useEffect(() => { document.title = 'Your request'; load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const P = (d && d.brand && d.brand.colors && d.brand.colors.primary) || '#0f766e';
  const S2 = (d && d.brand && d.brand.colors && d.brand.colors.secondary) || '#134e4a';
  const page = { minHeight: '100vh', background: '#f4f6f5', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', color: '#1c2a24', paddingBottom: 40 };
  const card = { maxWidth: 680, margin: '0 auto', background: '#fff', borderRadius: 14, padding: '20px 18px', boxShadow: '0 1px 6px rgba(0,0,0,.08)' };
  const btn = (bg, fg = '#fff') => ({ border: 'none', borderRadius: 10, padding: '12px 18px', fontSize: 15, fontWeight: 800, background: bg, color: fg, cursor: busy ? 'default' : 'pointer', flex: '1 1 180px', opacity: busy ? 0.6 : 1 });
  const input = { width: '100%', boxSizing: 'border-box', border: '1px solid #cfd8d3', borderRadius: 10, padding: '11px 12px', font: 'inherit', fontSize: 15 };
  const label = { display: 'block', fontSize: 13, fontWeight: 700, margin: '14px 0 4px' };
  const box = (bg, fg) => ({ background: bg, color: fg, borderRadius: 10, padding: '12px 14px', lineHeight: 1.55 });

  if (gone) return <div style={page}><div style={{ ...card, marginTop: 40 }}><h1 style={{ fontSize: 20, margin: '0 0 8px' }}>{temp ? 'Please try again in a minute' : 'This link does not work'}</h1><p style={{ margin: 0, lineHeight: 1.6 }}>{gone}</p>{temp ? <button type="button" style={{ ...btn('#15803d'), marginTop: 14, width: '100%' }} onClick={() => { setGone(''); setTemp(false); load(); }}>Try again</button> : null}</div></div>;
  if (!d) return <div style={page}><div style={{ ...card, marginTop: 40 }}><p style={{ margin: 0 }}>Loading…</p></div></div>;

  const { project: r, brand, options, suggestions } = d;
  const fileUrl = (o) => `/api/public/mk-project/${encodeURIComponent(token)}/option/${encodeURIComponent(o.id)}`;
  const media = (o, big) => (o.type === 'video'
    ? <video src={fileUrl(o)} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: 10, background: '#000', display: 'block', maxHeight: big ? 560 : 360 }} aria-label={o.label} /> // eslint-disable-line jsx-a11y/media-has-caption
    : <img src={fileUrl(o)} alt={o.label} style={{ width: '100%', borderRadius: 10, background: '#eef1ef', display: 'block', maxHeight: big ? 560 : 360, objectFit: 'contain' }} />);
  const title = { invited: 'Tell us what you need', request: 'We have your request', working: 'We are working on it', awaiting_client: 'Please choose the one you like', approved: 'Thank you: you chose', posted: 'It is live', declined: 'About your request' }[r.status] || 'Your request';

  const submitRequest = async () => {
    setErr('');
    if (f.occasion.trim().length < 2) { setErr('Please say what it is for (for example Diwali offer).'); return; }
    if (f.brief.trim().length < 10) { setErr('Please tell us what you would like, in a sentence or two.'); return; }
    if (!f.platforms.length) { setErr('Please pick where it will be posted.'); return; }
    if (f.contactName.trim().length < 2) { setErr('Please write your name.'); return; }
    setBusy(true);
    try {
      const body = { ...f, colors: f.colors && (f.colors.primary || f.colors.secondary) ? f.colors : null };
      if (logo) body.logoDataUrl = logo;
      const res = await api.post(`${base}/request`, body); setDone(res.data.ok || 'Thank you.'); load();
    } catch (e) { setErr(errOf(e, 'It could not be sent. Please try again.')); } finally { setBusy(false); }
  };
  const answer = async (kind) => {
    setErr('');
    if (name.trim().length < 2) { setErr('Please write your name first.'); return; }
    if (kind === 'choose' && !pick) { setErr('Please tap the option you like first.'); return; }
    if (kind === 'changes' && comment.trim().length < 5) { setMode('changes'); setErr('Please tell us what you would like changed (a few words).'); return; }
    setBusy(true);
    try { const res = await api.post(`${base}/${kind}`, { name: name.trim(), comment: comment.trim(), optionId: pick }); setDone(res.data.ok || 'Thank you.'); load(); } catch (e) { setErr(errOf(e, 'It could not be sent. Please try again.')); } finally { setBusy(false); }
  };

  return (
    <div style={page}>
      <div style={{ background: `linear-gradient(135deg, ${P}, ${S2})`, color: '#fff', padding: '22px 16px 54px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <div style={{ fontSize: 12, letterSpacing: '.12em', fontWeight: 800, opacity: 0.85 }}>{String(brand.name || '').toUpperCase()}</div>
          <h1 style={{ fontSize: 23, margin: '6px 0 2px', color: '#fff', fontFamily: 'inherit' }}>{title}</h1>
          <div style={{ fontSize: 14, opacity: 0.9 }}>For {r.clientName}{r.occasion ? ` · ${r.occasion}` : ''}</div>
        </div>
      </div>
      <div style={{ ...card, marginTop: -36 }}>
        {done ? <div role="status" style={{ ...box('#e6f6ec', '#14532d'), fontWeight: 700, marginBottom: 14 }}>{done}</div> : null}
        {err ? <div role="alert" style={{ ...box('#fdecea', '#8a1c13'), marginBottom: 14 }}>{err}</div> : null}

        {r.status === 'invited' && !done ? (
          <div>
            <p style={{ margin: '0 0 4px', lineHeight: 1.6 }}>Tell us what you need. We will look at it and come back to you with options to choose from.</p>
            <label htmlFor="cp-occ" style={label}>What is it for?</label>
            <input id="cp-occ" style={input} value={f.occasion} maxLength={120} onChange={(e) => setF({ ...f, occasion: e.target.value })} placeholder="For example: Diwali offer, Independence Day wishes" />
            <label htmlFor="cp-brief" style={label}>What would you like?</label>
            <textarea id="cp-brief" style={{ ...input, minHeight: 110 }} value={f.brief} maxLength={3000} onChange={(e) => setF({ ...f, brief: e.target.value })} placeholder="The message, the offer, the mood, anything we should avoid." />
            <label htmlFor="cp-del" style={label}>You would like</label>
            <select id="cp-del" style={input} value={f.deliverable} onChange={(e) => setF({ ...f, deliverable: e.target.value })}>{DELIVERABLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <div style={label}>Where will it be posted?</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 15 }}>{PLATFORMS.map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.platforms.includes(k)} onChange={() => setF({ ...f, platforms: f.platforms.includes(k) ? f.platforms.filter((x) => x !== k) : [...f.platforms, k] })} />{l}</label>)}</div>
            <label htmlFor="cp-h" style={label}>Your page links or handles</label>
            <textarea id="cp-h" style={{ ...input, minHeight: 56 }} value={f.handles} maxLength={600} onChange={(e) => setF({ ...f, handles: e.target.value })} placeholder="For example: instagram.com/yourbrand" />
            <label htmlFor="cp-due" style={label}>Needed by (optional)</label>
            <input id="cp-due" type="date" style={input} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
            <label htmlFor="cp-logo" style={label}>Your logo (PNG, JPG or WebP, under 300 KB)</label>
            <input id="cp-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => readLogo(e.target.files && e.target.files[0]).then((x) => { setLogo(x); setErr(''); }).catch((er) => { setErr(er.message); e.target.value = ''; setLogo(''); })} />
            {logo ? <img src={logo} alt="Your logo" style={{ maxHeight: 56, marginTop: 8, background: '#f4f6f5', borderRadius: 8, padding: 6, display: 'block' }} /> : null}
            <div style={label}>Your brand colours (optional)</div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 14 }}>
              <label>Main <input type="color" value={(f.colors && f.colors.primary) || '#0f766e'} onChange={(e) => setF({ ...f, colors: { ...f.colors, primary: e.target.value } })} /></label>
              <label>Second <input type="color" value={(f.colors && f.colors.secondary) || '#134e4a'} onChange={(e) => setF({ ...f, colors: { ...f.colors, secondary: e.target.value } })} /></label>
            </div>
            <label htmlFor="cp-n" style={label}>Your name</label>
            <input id="cp-n" style={input} value={f.contactName} maxLength={120} autoComplete="name" onChange={(e) => setF({ ...f, contactName: e.target.value })} />
            <label htmlFor="cp-p" style={label}>WhatsApp number (optional)</label>
            <input id="cp-p" style={input} value={f.contactPhone} maxLength={30} inputMode="tel" onChange={(e) => setF({ ...f, contactPhone: e.target.value })} placeholder="+91…" />
            <label htmlFor="cp-e" style={label}>Email (optional)</label>
            <input id="cp-e" style={input} value={f.contactEmail} maxLength={160} autoComplete="email" onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
            <div style={{ marginTop: 18 }}><button type="button" disabled={busy} style={{ ...btn('#15803d'), width: '100%' }} onClick={submitRequest}>{busy ? 'Sending…' : 'Send my request'}</button></div>
          </div>
        ) : null}

        {['request', 'working'].includes(r.status) ? (
          <div>
            <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>{r.status === 'request' ? 'Thank you. We have your request and our team will accept it shortly.' : 'Our team has accepted your request and is making your options now. We will send you a link to choose.'}</p>
            {suggestions && suggestions.length ? <div style={{ ...box('#eef6ff', '#1d4fa8'), marginBottom: 12 }}><b>Your suggestions, which we are working on:</b>{suggestions.map((s) => <div key={s.at} style={{ marginTop: 4 }}>“{s.text}”</div>)}</div> : null}
            <div style={{ ...box('#f4f6f5', '#1c2a24'), fontSize: 14 }}>
              <div><b>{r.occasion}</b></div><div style={{ whiteSpace: 'pre-wrap' }}>{r.brief}</div>
              {r.dueDate ? <div style={{ marginTop: 6, color: '#6b7a73' }}>Needed by {day(r.dueDate)}</div> : null}
            </div>
          </div>
        ) : null}

        {r.status === 'declined' ? <div style={box('#fdf1e3', '#7a4a07')}>{r.declinedNote || 'We are not able to take this one.'}</div> : null}

        {r.status === 'awaiting_client' ? (
          <div>
            {r.message ? <p style={{ margin: '0 0 12px', lineHeight: 1.6, background: '#f4f6f5', borderRadius: 10, padding: '10px 12px' }}>{r.message}</p> : null}
            {suggestions && suggestions.length ? <div style={{ ...box('#eef6ff', '#1d4fa8'), marginBottom: 12, fontSize: 14 }}><b>These options include your earlier suggestions:</b>{suggestions.map((s) => <div key={s.at} style={{ marginTop: 4 }}>“{s.text}”</div>)}</div> : null}
            {r.expired ? <div style={box('#fdecea', '#8a1c13')}>This link has expired. Please ask us for a new one.</div> : (
              <div>
                <p style={{ margin: '0 0 10px', fontSize: 14, color: '#6b7a73' }}>Tap the one you like. You can play a video before you choose.</p>
                <div style={{ display: 'grid', gap: 14 }}>
                  {options.map((o) => (
                    <div key={o.id} onClick={() => setPick(o.id)} role="radio" aria-checked={pick === o.id} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPick(o.id); } }}
                      style={{ border: `3px solid ${pick === o.id ? '#15803d' : '#dfe6e2'}`, borderRadius: 14, padding: 10, cursor: 'pointer', background: pick === o.id ? '#f0faf4' : '#fff' }}>
                      {media(o)}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontWeight: 800 }}>
                        <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 10, border: '2px solid #15803d', background: pick === o.id ? '#15803d' : '#fff', display: 'inline-block', flex: 'none' }} />{o.label}
                        {pick === o.id ? <span style={{ color: '#15803d', fontSize: 13 }}>Your choice</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
                {r.caption ? <div style={{ ...box('#f4f6f5', '#1c2a24'), marginTop: 14, fontSize: 14 }}><b>The words we will post with it:</b><div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.caption}</div></div> : null}
                <label htmlFor="cp-name" style={label}>Your name</label>
                <input id="cp-name" style={input} value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="So we know who answered" />
                <label htmlFor="cp-comment" style={label}>{mode === 'changes' ? 'What would you like changed?' : 'Your suggestions (optional)'}</label>
                <textarea id="cp-comment" style={{ ...input, minHeight: 90 }} value={comment} maxLength={800} onChange={(e) => setComment(e.target.value)} placeholder={mode === 'changes' ? 'For example: please use our new logo and a blue background' : 'Anything you would like us to adjust, for example: make the logo bigger.'} />
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                  <button type="button" disabled={busy} style={btn('#15803d')} onClick={() => answer('choose')}>{busy ? 'Sending…' : pick ? '✔ Choose this one' : '✔ Choose the one I tapped'}</button>
                  <button type="button" disabled={busy} style={btn('#fff', '#8a4b08')} onClick={() => (mode === 'changes' ? answer('changes') : (setMode('changes'), setErr('')))}><span style={{ border: '2px solid #d98a2b', borderRadius: 10, padding: '10px 16px', display: 'block' }}>↩ None of these: ask for changes</span></button>
                </div>
                <p style={{ fontSize: 12, color: '#6b7a73', margin: '12px 0 0' }}>This link is private. You can answer once; it works until {when(r.expiresAt)}. We post only the one you choose.</p>
              </div>
            )}
          </div>
        ) : null}

        {['approved', 'posted'].includes(r.status) ? (
          <div>
            {options.map((o) => <div key={o.id} style={{ marginBottom: 12 }}>{media(o, true)}<div style={{ fontWeight: 800, marginTop: 6 }}>{o.label}</div></div>)}
            <div style={box('#e6f6ec', '#14532d')}><b>Approved</b> by {r.decidedByName} on {when(r.decidedAt)}.{r.decisionNote ? <div style={{ marginTop: 4 }}>Your suggestions: “{r.decisionNote}”</div> : null}</div>
            {r.status === 'approved' ? <p style={{ margin: '12px 0 0', lineHeight: 1.6 }}>We will post it on your page shortly. This page will tell you when it is live.</p> : null}
            {r.status === 'posted' ? <p style={{ margin: '12px 0 0', lineHeight: 1.6 }}>It was posted on {when(r.postedAt)}.{r.postUrl ? <> <a href={r.postUrl} target="_blank" rel="noopener noreferrer">See the post</a></> : null}</p> : null}
          </div>
        ) : null}
      </div>
      <div style={{ padding: '24px 16px 0' }}><OurWork P={P} title="Our recent work" /></div>
    </div>
  );
}

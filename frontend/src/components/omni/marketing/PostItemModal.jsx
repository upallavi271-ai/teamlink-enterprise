import { useEffect, useMemo, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal, Banner, fmtDateTime } from '../ui.jsx';
import { ORDER, WORD } from './socialPlatforms.js';

// "POST" (AI Images / AI Video, an APPROVED picture or video): pick the connected Facebook, Instagram, LinkedIn, X and YouTube (videos) accounts (Administration > Integrations > Social Media), write the words,
// confirm, and TeamLink posts it (server: marketing/postItem.js, the same publisher a client project uses). What already went out from this item is listed, so a second post is never a surprise.

export default function PostItemModal({ item, isVideo, onClose, onChanged, toast }) {
  const [acc, setAcc] = useState(null); // { allowed, accounts }
  const [before, setBefore] = useState(null); // what already went out from this item
  const [picked, setPicked] = useState([]);
  const [caption, setCaption] = useState('');
  const [asStory, setAsStory] = useState(false);
  const tall = item.aspect === '9:16';
  const [step, setStep] = useState('pick'); // pick -> sure -> done
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState(null); // the answer of the post
  const word = isVideo ? 'video' : 'picture';
  const load = () => {
    omni.get('/gs/marketing/projects/accounts').then(setAcc).catch((e) => setErr(errOf(e, 'The connected accounts could not be read.')));
    omni.get(`/gs/marketing/images/${item.id}/posts`).then((d) => setBefore(d.posts || [])).catch(() => setBefore([]));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const accounts = useMemo(() => ((acc && acc.accounts) || []).filter((a) => a.status !== 'Removed' && (isVideo || a.platform !== 'youtube') && (!asStory || a.platform === 'facebook' || a.platform === 'instagram')).sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform) || String(a.name).localeCompare(String(b.name))), [acc, asStory]);
  const chosen = accounts.filter((a) => picked.includes(a.id));
  const hasX = chosen.some((a) => a.platform === 'x');
  const hasYt = chosen.some((a) => a.platform === 'youtube');
  const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const post = async () => {
    setBusy(true); setErr('');
    try {
      const r = await omni.post(`/gs/marketing/images/${item.id}/post`, { accountIds: chosen.map((a) => a.id), caption: asStory ? '' : caption.trim(), confirm: true, ...(asStory ? { asStory: true } : {}) });
      setOut(r); setStep('done'); toast(r.ok); load(); onChanged && onChanged();
    } catch (e) { setErr(errOf(e, 'It could not be posted.')); setStep('pick'); } finally { setBusy(false); }
  };
  const accWords = (a) => `${a.name} (${WORD[a.platform] || a.platform}${a.parentName ? `, ${a.parentName}` : ''})`;
  return (
    <GsModal title={`Post the ${word}: ${item.title}`} sub={`Approved${item.decidedByName ? ` by ${item.decidedByName}` : ''}. It goes public on the accounts you pick.`} width={600} onClose={onClose}
      foot={step === 'done' ? <Btn onClick={onClose}>Close</Btn> : step === 'sure'
        ? <><Btn onClick={() => setStep('pick')} disabled={busy}>Back</Btn><Btn primary disabled={busy} onClick={post}>{busy ? 'Posting…' : 'Yes, post it now'}</Btn></>
        : <><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={!chosen.length || (!asStory && hasX && caption.trim().length > 280) || !(acc && acc.allowed)} onClick={() => { setErr(''); setStep('sure'); }}>Post…</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!acc ? <div style={{ fontSize: 12 }}>Loading…</div> : null}
      {acc && !acc.allowed ? <Banner tone="warn">Posting from TeamLink is switched off. An Admin switches it on in AI Marketing &gt; AI usage &gt; Posting to client accounts.</Banner> : null}
      {acc && acc.allowed && !accounts.length ? <Banner tone="warn">No social account is connected yet. An Admin connects them in Administration &gt; Integrations &gt; Social Media.</Banner> : null}
      {before && before.length ? (
        <div style={{ background: '#f4f7f5', borderRadius: 10, padding: '8px 12px', marginBottom: 10, fontSize: 11.5 }}>
          <b>Already posted from this {word}:</b>
          {before.slice(0, 6).map((p) => <div key={p.id} style={{ marginTop: 3 }}>{p.ok ? '✓' : '✗'} {p.accountName} ({WORD[p.platform] || p.platform}) · {fmtDateTime(p.at)} · {p.byName}{p.ok && p.url ? <> · <a href={p.url} target="_blank" rel="noopener noreferrer">open the post</a></> : null}{!p.ok && p.error ? ` · ${p.error}` : ''}</div>)}
        </div>
      ) : null}
      {step === 'pick' ? (
        <div>
          {tall ? <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '0 0 8px' }}><input type="checkbox" checked={asStory} onChange={(e) => setAsStory(e.target.checked)} /><span><b>Post as a Story</b> (Facebook and Instagram)</span></label> : null}
          <div style={{ fontSize: 10, fontWeight: 800, color: '#166534', margin: '4px 0 6px' }}>POST ON</div>
          {accounts.map((a) => (
            <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '4px 0', opacity: a.status === 'Connected' ? 1 : 0.55 }}>
              <input type="checkbox" checked={picked.includes(a.id)} disabled={a.status !== 'Connected'} onChange={() => toggle(a.id)} />
              <span><b>{a.name}</b> · {WORD[a.platform] || a.platform}{a.parentName ? ` · on ${a.parentName}` : ''}{a.status !== 'Connected' ? ` · ${a.status}: an Admin connects it again` : ''}</span>
            </label>
          ))}
          {asStory ? <div style={{ fontSize: 12, marginTop: 10, color: 'var(--muted)' }}>A Story carries no words and disappears after 24 hours.</div> : <>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#166534', margin: '12px 0 4px' }}>THE WORDS TO POST WITH IT (OPTIONAL)</div>
          <textarea value={caption} maxLength={2200} onChange={(e) => setCaption(e.target.value)} aria-label="The words to post" style={{ width: '100%', boxSizing: 'border-box', minHeight: 90, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 12.5 }} />
          <div style={{ fontSize: 11, marginTop: 4, color: hasX && caption.trim().length > 280 ? '#b91c1c' : 'var(--muted)' }}>{caption.trim().length} characters{hasX ? ' · X allows 280' : ''}</div>
          </>}
        </div>
      ) : null}
      {step === 'sure' ? (
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          <b>Post this {word} now {asStory ? 'as a Story ' : ''}on:</b>
          <ul style={{ margin: '6px 0 8px', paddingLeft: 18 }}>{chosen.map((a) => <li key={a.id}>{accWords(a)}</li>)}</ul>
          {asStory ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No words. It disappears after 24 hours.</div> : caption.trim() ? <div style={{ background: '#f4f7f5', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap', fontSize: 12 }}>{caption.trim()}</div> : <div style={{ fontSize: 12, color: 'var(--muted)' }}>With no words, only the {word}.</div>}
          {hasYt ? <div style={{ marginTop: 8, fontSize: 12 }}>YouTube: the first line is the title; public, not made for kids.</div> : null}
          <div style={{ marginTop: 8, fontSize: 12, color: '#92400e', fontWeight: 600 }}>It goes public at once. A post you made by mistake has to be deleted on the platform itself.</div>
        </div>
      ) : null}
      {step === 'done' && out ? (
        <div>
          <div className="mk-note ok" style={{ marginBottom: 8 }}>{out.ok}</div>
          {(out.results || []).map((x) => <div key={x.accountId} style={{ fontSize: 12.5, margin: '4px 0' }}>{x.ok ? '✓' : '✗'} <b>{x.name}</b> ({WORD[x.platform] || x.platform}){x.ok && x.url ? <> · <a href={x.url} target="_blank" rel="noopener noreferrer">open the post</a></> : null}{!x.ok ? ` · ${x.error}` : ''}{x.note ? ` · ${x.note}` : ''}</div>)}
        </div>
      ) : null}
    </GsModal>
  );
}

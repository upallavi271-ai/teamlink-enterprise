import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, GsModal, ConfirmModal, Planned, Banner, fmtDate } from '../ui.jsx';
import LibraryPicker from '../templates/LibraryPicker.jsx';
import { useDebounced } from '../templates/tplCommon.jsx';
import '../templates/templates.css';

// CONTENT STUDIO: write one master message, see a version for every channel (WhatsApp, SMS, Email + Facebook, Instagram, LinkedIn, X, YouTube, Threads),
// attach media from the Library, save it (own table OmniStudioContent), load it again, send it to a campaign. The versions are made by simple RULES (not AI);
// the brand voice is saved with the content (writing in that voice with AI is Planned). Nothing is sent or posted from here.
const SAMPLE_HEAD = { whatsapp: 'WhatsApp message', sms: 'SMS', email: 'Email' };

function PostCard({ ch, text, subject, name, media }) {
  const m = media && media[0];
  const img = m && m.mediaType === 'image' ? m.url : '';
  const mediaBox = (sq) => (m ? <div className={`st-media${sq ? ' sq' : ''}`}>{img ? <img src={img} alt="" /> : `🖼 ${m.name}`}</div> : (ch.key === 'instagram' ? <div className="st-media sq">🖼 Add a visual for Instagram</div> : null));
  const body = <div className="st-text">{text || 'Your post will appear here…'}</div>;
  const brand = name || 'Your company';
  if (ch.key === 'whatsapp' || ch.key === 'sms') return <div className="st-post" style={{ background: ch.key === 'whatsapp' ? '#e9e2db' : '#f4f7f5' }}><div className="st-bubble" style={{ background: ch.key === 'whatsapp' ? '#fff' : `${ch.color}22` }}>{ch.key === 'whatsapp' ? mediaBox(false) : null}{body}<div style={{ fontSize: 9, color: '#8d9aa2', textAlign: 'right', marginTop: 4 }}>10:30 AM</div></div></div>;
  if (ch.key === 'email') return <div className="st-post"><div style={{ fontSize: 10, color: 'var(--muted)' }}>Subject</div><div style={{ fontWeight: 800, marginBottom: 8 }}>{subject || name || '—'}</div>{mediaBox(false)}<div style={{ marginTop: 8 }}>{body}</div></div>;
  const head = { facebook: [brand, 'Just now · 🌐'], instagram: [`${brand.toLowerCase().replace(/\s+/g, '')}`, 'Just now'], linkedin: [brand, 'Company · now'], x: [brand, '@' + brand.toLowerCase().replace(/\W+/g, '') + ' · now'], youtube: [brand, 'Community post'], threads: [brand.toLowerCase().replace(/\s+/g, ''), 'now'] }[ch.key] || [brand, 'now'];
  const acts = { facebook: ['👍 Like', '💬 Comment', '↱ Share'], instagram: ['♡', '💬', '➤', '🔖'], linkedin: ['👍 Like', '💬 Comment', '🔁 Repost', '➤ Send'], x: ['💬', '🔁', '♡', '📊'], youtube: ['👍', '👎', '💬', '↱ Share'], threads: ['♡', '💬', '🔁', '➤'] }[ch.key] || [];
  return (
    <div className="st-post">
      <div className="st-post-head"><span className="st-av" style={{ background: ch.color }}>{head[0].slice(0, 1).toUpperCase()}</span><div><b>{head[0]}</b><small>{head[1]}</small></div></div>
      {ch.key === 'instagram' ? <>{mediaBox(true)}<div style={{ marginTop: 8 }}>{body}</div></> : <>{body}{mediaBox(false)}</>}
      <div className="st-acts">{acts.map((a) => <span key={a}>{a}</span>)}</div>
    </div>
  );
}

export default function StudioPage() {
  const { acc, go, toast } = useOmni();
  const [meta, setMeta] = useState(null);
  const [name, setName] = useState('');
  const [voice, setVoice] = useState('Warm & confident');
  const [cta, setCta] = useState('');
  const [master, setMaster] = useState('');
  const [subject, setSubject] = useState('');
  const [adapt, setAdapt] = useState({});
  const [manual, setManual] = useState({});
  const [libIds, setLibIds] = useState([]);
  const [libItems, setLibItems] = useState([]);
  const [active, setActive] = useState('facebook');
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const [loadedId, setLoadedId] = useState('');
  const [saved, setSaved] = useState({ items: [], canSave: false });
  const [posts, setPosts] = useState([]);
  const [del, setDel] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const manualRef = useRef({}); manualRef.current = manual;
  const dm = useDebounced(`${master}|${cta}|${name}`, 300);

  const loadSaved = useCallback(() => omni.get('/gs/studio/content').then(setSaved).catch((e) => setErr(errOf(e, 'The saved content could not be read.'))), []);
  useEffect(() => {
    omni.get('/gs/studio/meta').then((m) => { setMeta(m); setActive((a) => (m.channels.some((c) => c.key === a) ? a : m.channels[0].key)); }).catch(() => {});
    loadSaved();
    omni.get('/gs/studio/posts').then((r) => setPosts(r.items || [])).catch(() => {});
  }, [loadSaved]);

  // the rule-made versions follow the master message until somebody edits a version by hand (Regenerate takes them all back)
  useEffect(() => {
    if (!master.trim()) { setAdapt((a) => Object.fromEntries(Object.entries(a).filter(([k]) => manualRef.current[k]))); return undefined; }
    let live = true;
    omni.post('/gs/studio/adapt', { master, name, cta }).then((r) => { if (live) setAdapt((a) => { const n = { ...r.adaptations }; Object.keys(manualRef.current).forEach((k) => { if (manualRef.current[k] && a[k] !== undefined) n[k] = a[k]; }); return n; }); }).catch(() => {});
    return () => { live = false; };
  }, [dm]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta) return <div><PageHead eyebrow="Content engine" title="Content Studio" lead="Create a master message once and adapt it for every channel without losing brand consistency." />{err ? <Banner tone="error">{err}</Banner> : <div className="card panel">Loading…</div>}</div>;
  const ch = meta.channels.find((c) => c.key === active) || meta.channels[0];
  const text = adapt[ch.key] || '';
  const over = (c) => (adapt[c.key] || '').length > c.limit;
  const canSave = meta.canSave;

  const regenerate = async () => {
    if (!master.trim()) { toast('Write the master message first'); return; }
    try { const r = await omni.post('/gs/studio/adapt', { master, name, cta }); setAdapt(r.adaptations); setManual({}); toast('Versions rebuilt from the master message (by rules, not AI)'); } catch (e) { toast(errOf(e, 'It could not be rebuilt.')); }
  };
  const body = () => ({ name: name.trim(), voice, cta, master, subject, adaptations: adapt, libraryIds: libIds });
  const save = async () => {
    if (!name.trim()) { toast('Give this content a name first'); return null; }
    const bad = meta.channels.find(over);
    if (bad) { toast(`The ${bad.label} version is over its character limit`); return null; }
    setBusy(true); setErr('');
    try { const r = await omni.post('/gs/studio/content', body()); setLoadedId(r.content.id); toast(`"${r.content.name}" saved to the Content Library`); await loadSaved(); return r.content; } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); return null; } finally { setBusy(false); }
  };
  const toCampaign = async () => { const c = await save(); if (c) { toast(`"${c.name}" is ready to attach in the campaign wizard`); go('campaigns', { content: c.id }); } };
  const load = async (c) => {
    try {
      const r = await omni.get(`/gs/studio/content/${c.id}`);
      const x = r.content; setName(x.name); setVoice(x.voice); setCta(x.cta); setMaster(x.master); setSubject(x.subject); setAdapt(x.adaptations); setManual(Object.fromEntries(Object.keys(x.adaptations).map((k) => [k, true]))); setLibIds(x.libraryIds); setLoadedId(x.id);
      toast(`Loaded "${x.name}" from the library`); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { toast(errOf(e, 'It could not be loaded.')); }
  };
  const remove = async () => { const c = del; setDel(null); try { await omni.del(`/gs/studio/content/${c.id}`); if (loadedId === c.id) setLoadedId(''); toast('Removed from the Content Library'); await loadSaved(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  const startEdit = () => { setEditing(ch); setEditText(text); };
  const saveEdit = () => { setAdapt({ ...adapt, [editing.key]: editText }); setManual({ ...manual, [editing.key]: true }); toast(`${editing.label} version saved`); setEditing(null); };
  const emailSubject = subject || name;

  return (
    <div>
      <PageHead eyebrow="Content engine" title="Content Studio" lead="Create a master message once and adapt it for every channel without losing brand consistency.">
        <Btn onClick={regenerate}>↻ Regenerate</Btn>
        <Btn primary disabled={busy || !canSave} onClick={save} title={canSave ? '' : 'Your login can look at saved content but not save it'}>💾 Save content</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err}</Banner> : null}
      {!canSave ? <Banner tone="info">Your login can look at saved content and load it, but not save or delete it.</Banner> : null}
      <div className="grid studio-grid">
        <div className="card panel">
          <div className="panel-title">Write the message</div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="field"><label>CONTENT NAME</label><input value={name} placeholder="Weekend Rewards" onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label>BRAND VOICE</label><select value={voice} onChange={(e) => setVoice(e.target.value)}>{meta.voices.map((v) => <option key={v}>{v}</option>)}</select></div>
            <div className="field"><label>CTA (WHAT SHOULD THEY DO)</label><input value={cta} placeholder="Shop now" onChange={(e) => setCta(e.target.value)} /></div>
            <div className="field"><label>EMAIL SUBJECT · Optional</label><input value={subject} placeholder="Uses the content name when empty" onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="field full"><label>MASTER MESSAGE</label><textarea style={{ minHeight: 150 }} value={master} placeholder={'Your weekend just got better\nMembers get 20% off selected products until Sunday midnight.\nTap below to shop now.'} onChange={(e) => setMaster(e.target.value)} /><small style={{ fontSize: 9, color: 'var(--muted)' }}>{master.length} characters</small></div>
          </div>
          <Planned>Writing in your brand voice with AI is planned. For now the voice is saved with the content, and each channel version is made by simple rules (cut to the channel&apos;s limit, your call-to-action, a hashtag). Regenerate does not use AI.</Planned>
          <div className="field full" style={{ marginTop: 12 }}><label>MEDIA LIBRARY</label>
            <LibraryPicker value={libIds} onChange={(ids, items) => { setLibIds(ids); setLibItems(items); }} />
          </div>
        </div>
        <div className="card panel">
          <div className="panel-top"><div><div className="panel-title">Channel adaptations</div><div className="panel-sub">See how the message looks on each channel. Edit any version.</div></div><Btn onClick={regenerate}>↻ Regenerate</Btn></div>
          <div className="st-chans" role="tablist" aria-label="Channels">
            {meta.channels.map((c) => <button type="button" key={c.key} role="tab" aria-selected={c.key === ch.key} className={`st-chan${c.key === ch.key ? ' on' : ''}`} style={c.key === ch.key ? { borderColor: c.color } : undefined} onClick={() => setActive(c.key)}><i style={{ background: c.color }}>{c.icon}</i>{c.label}{over(c) ? <span style={{ color: '#b3261e' }}>!</span> : null}</button>)}
          </div>
          <div className={`st-count${over(ch) ? ' over' : ''}`}><span>{text.length.toLocaleString('en-IN')} / {ch.limit.toLocaleString('en-IN')} characters{over(ch) ? ' · too long' : ''}</span><TinyBtn onClick={startEdit}>✎ Edit {ch.label} version</TinyBtn></div>
          <div className="st-limit-note" style={{ marginTop: -4, marginBottom: 8 }}>{ch.hint}{ch.send ? '' : ' · saved as text only, nothing is posted from here'}</div>
          <PostCard ch={ch} text={text} subject={emailSubject} name={name} media={libItems} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <Btn primary disabled={busy || !canSave} onClick={save}>💾 Save content</Btn>
            <Btn disabled={busy || !canSave} onClick={toCampaign}>Use in a campaign →</Btn>
          </div>
        </div>
      </div>

      <Panel title="Content Library" sub="Saved content, reused by Social Media and Campaigns. Pressing Save content adds or updates a piece here." right={<span className="pill live">{saved.items.length} saved</span>} className="" style={{ marginTop: 14 }}>
        {saved.items.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '14px 0' }}>Nothing saved yet. Fill in the content above and press Save content.</div> : saved.items.map((c) => (
          <div className="st-row" key={c.id}>
            <div><b>{c.name}</b>{loadedId === c.id ? <span className="pill scheduled" style={{ marginLeft: 8 }}>Open above</span> : null}<small>{Object.keys(c.adaptations).length} channel versions · saved {c.savedAt ? fmtDate(c.savedAt) : '—'}{c.createdByName ? ` · ${c.createdByName}` : ''}{c.department ? ` · ${c.department}` : ''}</small></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <TinyBtn onClick={() => load(c)}>✎ Edit</TinyBtn>
              {acc && acc.pages && acc.pages.includes('campaigns') ? <TinyBtn onClick={() => go('campaigns', { content: c.id })}>Use in a campaign →</TinyBtn> : null}
              {acc && acc.pages && acc.pages.includes('social') ? <TinyBtn onClick={() => { toast(`"${c.name}" ready to publish: choose accounts and post`); go('social', { content: c.id }); }}>Publish →</TinyBtn> : null}
              {c.canEdit ? <TinyBtn onClick={() => setDel(c)} title="Delete">🗑</TinyBtn> : null}
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Created posts" sub="Posts published or scheduled from your content, and the social account each went to" right={<span className="pill live">{posts.length} post{posts.length === 1 ? '' : 's'}</span>} style={{ marginTop: 14 }}>
        {posts.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)', padding: '14px 0' }}>No posts yet. Publish content from Social Media and it will appear here.</div> : posts.map((p) => (
          <div className="st-row" key={p.id}><div><b style={{ fontWeight: 600 }}>{p.text}</b><small>{(p.platforms || []).join(', ')}{p.when ? ` · ${fmtDate(p.when)}` : ''}</small></div><Pill tone={/sched/i.test(p.status) ? 'scheduled' : 'live'}>{/sched/i.test(p.status) ? 'Scheduled' : 'Posted'}</Pill></div>
        ))}
      </Panel>

      {editing ? (
        <GsModal title={`${editing.label} version`} sub={`${editing.hint} · limit ${editing.limit.toLocaleString('en-IN')} characters`} width={560} onClose={() => setEditing(null)}
          foot={<><Btn onClick={() => setEditing(null)}>Cancel</Btn><Btn primary disabled={!editText.trim() || editText.length > editing.limit} onClick={saveEdit}>Save changes</Btn></>}>
          <textarea style={{ width: '100%', minHeight: 190, border: '1px solid var(--line)', borderRadius: 10, padding: 11, font: 'inherit', fontSize: 12.5 }} autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} />
          <div className={`st-count${editText.length > editing.limit ? ' over' : ''}`} style={{ marginTop: 6 }}>{editText.length} / {editing.limit}</div>
        </GsModal>
      ) : null}
      {del ? <ConfirmModal danger title={`Delete "${del.name}"?`} text="It is removed from the Content Library. Posts and campaigns already made from it keep their words." yes="Delete content" onNo={() => setDel(null)} onYes={remove} /> : null}
    </div>
  );
}
export { SAMPLE_HEAD };

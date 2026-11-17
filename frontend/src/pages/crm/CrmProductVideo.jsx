// ---------------------------------------------------------------------------
// OUR PRODUCTS > VIDEOS (founder 2026-11-17: "upload a video, and the content is made from it"). Managers only, inside Leads > Our products.
//   VideoStudio      upload one video with all the products (again whenever it changes) or a company / general video; a product's own
//                    demo or another video for it from its card; see each upload's progress. Any product, also one added later.
//   DraftEditor      what the server found: the parts of the video per product (start - end, play each part), the intro and the closing,
//                    and the text written from that product's narration. Tick what to use and Save; until then nothing changes.
// Backend: crm/productVideo.js (/api/crm/product-videos...).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const short = (name) => String(name || '').replace(/^TeamLink\s+/i, '');
const FORMATS = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const ACCEPT = 'video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi';
const MAX = 3 * 1024 * 1024 * 1024;
// say what is wrong before a long upload starts
export function fileProblem(f) {
  if (!FORMATS.test(f.name)) return `${f.name} is not a video we can use. Upload an MP4, MOV, M4V, WebM, MKV or AVI file.`;
  if (f.size > MAX) return `${f.name} is ${(f.size / 1073741824).toFixed(1)} GB. The limit is 3 GB: export it smaller (1080p, H.264 MP4) and upload again.`;
  if (!f.size) return `${f.name} is empty.`;
  return '';
}
const ACTIVE = ['uploading', 'queued', 'analysing', 'cutting'];
const mmss = (n) => { if (n == null || n === '' || Number.isNaN(Number(n))) return ''; const v = Number(n); const m = Math.floor(v / 60); const s = (v - m * 60).toFixed(1).padStart(4, '0'); return `${m}:${s}`; };
const secs = (t) => { const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(t || '').trim()); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(n > 104857600 ? 0 : 1)} MB`;

// send the file in pieces; a piece that fails is tried again 3 times, a piece out of order restarts from where the server is
export async function uploadVideo(file, { kind, key, title }, onProgress) {
  const st = await api.post('/crm/product-videos', { kind, key, title, name: file.name, size: file.size });
  const { id, chunkSize } = st.data;
  let offset = 0;
  while (offset < file.size) {
    const piece = file.slice(offset, Math.min(file.size, offset + chunkSize));
    let tries = 0;
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.put(`/crm/product-videos/${id}/chunk`, piece, { params: { offset }, headers: { 'Content-Type': 'application/octet-stream' } });
        offset = r.data.received;
        break;
      } catch (e) {
        const got = e && e.response && e.response.data && e.response.data.received;
        if (e && e.response && e.response.status === 409 && Number.isFinite(got)) { offset = got; break; }
        tries += 1;
        if (tries > 3) throw e;
        await new Promise((res) => { setTimeout(res, 1500 * tries); }); // eslint-disable-line no-await-in-loop
      }
    }
    if (onProgress) onProgress(offset / file.size);
  }
  return (await api.post(`/crm/product-videos/${id}/finish`)).data.job;
}

export function VideoStudio({ onSaved, refreshKey, products }) {
  const { toast } = useCrm();
  const nameOf = (k) => short(((products || []).find((p) => p.key === k) || {}).name || k);
  const [company, setCompany] = useState(null); // the company video now on the demo pages
  const companyInput = useRef(null);
  const loadCompany = () => api.get('/crm/products-settings').then((r) => setCompany(r.data.settings)).catch(() => setCompany(null));
  useEffect(() => { loadCompany(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [jobs, setJobs] = useState(null);
  const [up, setUp] = useState(null); // { name, pct }
  const [open, setOpen] = useState(null); // job id whose draft is open
  const input = useRef(null);
  const load = () => api.get('/crm/product-videos').then((r) => setJobs(r.data.jobs || [])).catch(() => setJobs([]));
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // while something runs on the server, look again every 4 seconds
  useEffect(() => {
    if (!(jobs || []).some((j) => ACTIVE.includes(j.status))) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const wasActive = useRef(new Set());
  useEffect(() => {
    (jobs || []).forEach((j) => {
      if (ACTIVE.includes(j.status)) wasActive.current.add(j.id);
      else if (wasActive.current.has(j.id)) { wasActive.current.delete(j.id); if (j.status === 'done') { loadCompany(); if (onSaved) onSaved(); } if (j.status === 'draft') toast('The video is read: press Review the draft.'); }
    });
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  async function pick(e, kind) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bad = fileProblem(f);
    if (bad) { toast(bad); return; }
    let title = '';
    if (kind === 'company') { title = window.prompt('A title for this video (shown above it on the demo page):', (company && company.companyVideoTitle) || 'About TeamLink'); if (title == null) return; } // eslint-disable-line no-alert
    setUp({ name: f.name, pct: 0 });
    try { await uploadVideo(f, { kind, title }, (p) => setUp({ name: f.name, pct: p })); toast('Uploaded. The server is reading the video now - this takes a few minutes.'); } catch (err) { toast(errOf(err, 'The upload did not finish. Please try again.')); }
    setUp(null); load();
  }
  async function watchCompany() { try { const r = await api.get('/crm/products/COMPANY/watch'); window.open(r.data.url, '_blank', 'noopener'); } catch (e) { toast(errOf(e, 'The video could not be opened.')); } }
  async function removeCompany() {
    if (!window.confirm('Take the company video off the demo pages?')) return; // eslint-disable-line no-alert
    try { await api.put('/crm/products-settings', { companyVideoFile: '' }); loadCompany(); toast('Removed from the demo pages.'); } catch (e) { toast(errOf(e, 'This did not work.')); }
  }
  const forOf = (j) => (j.kind === 'single' ? `${nameOf(j.productKey)}: demo` : j.kind === 'extra' ? `${nameOf(j.productKey)}: ${j.title || 'another video'}` : j.kind === 'company' ? `Company video${j.title ? `: ${j.title}` : ''}` : 'All products');
  async function act(j, what) {
    try {
      if (what === 'retry') await api.post(`/crm/product-videos/${j.id}/retry`);
      if (what === 'delete') {
        if (!window.confirm(`Remove the upload "${j.fileName}"? Clips already live stay as they are.`)) return; // eslint-disable-line no-alert
        // this upload is what the full-video card plays: ask whether the card goes too (Cancel keeps the card and its file)
        const card = j.usedByCard && window.confirm('This upload is also shown under Videos on Our products. Remove that video too?\n\nOK = remove it from Videos as well\nCancel = keep it in Videos'); // eslint-disable-line no-alert
        await api.delete(`/crm/product-videos/${j.id}`, { params: card ? { removeCard: 1 } : {} });
        if (onSaved) onSaved();
      }
      load();
    } catch (e) { toast(errOf(e, 'This did not work.')); }
  }
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, flex: 1 }}>Product videos</h3>
        <input ref={input} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e, 'all')} />
        <input ref={companyInput} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e, 'company')} />
        <button type="button" className="btn btn-primary" disabled={!!up} onClick={() => input.current && input.current.click()}>⬆ Upload one video with all products</button>
        <button type="button" className="btn" disabled={!!up} onClick={() => companyInput.current && companyInput.current.click()}>⬆ Company / general video</button>
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '6px 0' }}>Upload as often as you like: MP4, MOV, M4V, WebM, MKV or AVI, up to 3 GB. For a video with all products, the server listens to the narration, finds where each product is (also products you add later, by their name) and writes each product's text from what is said about it. You review it all before anything changes. On each product's card: replace its demo video, or add another video for it (a feature walk-through, a customer story). “+ Add product” below adds something new to sell.</div>
      {up && (
        <div style={{ margin: '8px 0' }}>
          <div className="small-muted">Uploading {up.name}: {Math.round(up.pct * 100)}% - keep this page open</div>
          <div style={{ height: 8, background: 'var(--line-soft, #e5e7eb)', borderRadius: 4, overflow: 'hidden' }}><div style={{ width: `${Math.round(up.pct * 100)}%`, height: '100%', background: 'var(--brand, #2563eb)' }} /></div>
        </div>
      )}
      {(jobs || []).length > 0 && (
        <table style={{ fontSize: 13, marginTop: 6 }}>
          <thead><tr><th>Video</th><th>For</th><th>Status</th><th>Uploaded</th><th /></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.fileName}<div className="small-muted">{mb(j.size)}{j.duration ? ` · ${mmss(j.duration)}` : ''}</div></td>
                <td>{forOf(j)}</td>
                <td>
                  <span className={`status ${j.status === 'done' ? 'approved' : j.status === 'failed' ? 'rejected' : 'pending'}`}>{{ uploading: 'Uploading', queued: 'Waiting', analysing: 'Reading', draft: 'Draft ready', cutting: 'Making clips', done: 'Done', failed: 'Failed' }[j.status] || j.status}</span>
                  <div className="small-muted" style={{ fontSize: 11.5 }}>{j.error || j.step}</div>
                </td>
                <td className="small-muted">{dateTimeOf(j.createdAt)}{j.createdByName ? ` · ${j.createdByName}` : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {j.hasDraft && !ACTIVE.includes(j.status) && <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(j.id)}>{j.status === 'draft' ? 'Review the draft' : 'Open'}</button>}
                  {j.status === 'failed' && <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => act(j, 'retry')}>Retry</button>}
                  {!ACTIVE.includes(j.status) && <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => act(j, 'delete')} aria-label="Remove">✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <DraftEditor id={open} nameOf={nameOf} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); if (onSaved) onSaved(); }} />}
    </div>
  );
}

// a product's own video from its card
export function SingleUpload({ product, onDone }) {
  const { toast } = useCrm();
  const main = useRef(null);
  const extra = useRef(null);
  const [pct, setPct] = useState(null);
  async function pick(e, kind) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bad = fileProblem(f);
    if (bad) { toast(bad); return; }
    let title = '';
    if (kind === 'extra') { title = window.prompt(`A title for this ${short(product.name)} video (shown above it):`, f.name.replace(/\.[a-z0-9]+$/i, '')); if (title == null) return; } // eslint-disable-line no-alert
    setPct(0);
    try { await uploadVideo(f, { kind, key: product.key, title }, setPct); toast(`Uploaded. When it is read, review it under Product videos and press Save to use it for ${product.name}.`); if (onDone) onDone(); } catch (err) { toast(errOf(err, 'The upload did not finish. Please try again.')); }
    setPct(null);
  }
  return (
    <>
      <input ref={main} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e, 'single')} />
      <input ref={extra} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e, 'extra')} />
      {pct != null ? <span className="small-muted" style={{ marginTop: 10, marginRight: 6, display: 'inline-block' }}>Uploading {Math.round(pct * 100)}%</span> : (
        <>
          <button type="button" className="btn btn-sm" style={{ marginTop: 10, marginRight: 6 }} onClick={() => main.current && main.current.click()} title="This becomes the product's demo video">⬆ {product.hasVideo ? 'Replace demo video' : 'Upload demo video'}</button>
          <button type="button" className="btn btn-sm" style={{ marginTop: 10, marginRight: 6 }} onClick={() => extra.current && extra.current.click()} title="Shown under the demo, the demo stays">+ Add another video</button>
        </>
      )}
    </>
  );
}

function RangeRow({ label, range, onChange, onPlay, onRemove }) {
  const [a, setA] = useState(mmss(range && range[0]));
  const [b, setB] = useState(mmss(range && range[1]));
  useEffect(() => { setA(mmss(range && range[0])); setB(mmss(range && range[1])); }, [range && range[0], range && range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const push = (x, y) => { const s = secs(x); const e = secs(y); if (Number.isFinite(s) && Number.isFinite(e)) onChange([s, e]); };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' }}>
      <span className="small-muted" style={{ minWidth: 70 }}>{label}</span>
      <input type="text" value={a} onChange={(e) => setA(e.target.value)} onBlur={() => push(a, b)} aria-label={`${label} start`} style={{ width: 80 }} />
      <span>→</span>
      <input type="text" value={b} onChange={(e) => setB(e.target.value)} onBlur={() => push(a, b)} aria-label={`${label} end`} style={{ width: 80 }} />
      <span className="small-muted" style={{ fontSize: 12 }}>{range ? `${Math.round(range[1] - range[0])} s` : ''}</span>
      {range && <button type="button" className="btn btn-sm" onClick={() => onPlay(range)}>▶ Play</button>}
      {onRemove && <button type="button" className="btn btn-sm" onClick={onRemove} aria-label={`Remove ${label}`}>✕</button>}
    </div>
  );
}

function DraftEditor({ id, onClose, onSaved, nameOf }) {
  const { toast } = useCrm();
  const [job, setJob] = useState(null);
  const [d, setD] = useState(null);
  const [use, setUse] = useState({});
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(null); // the product whose narration is shown
  const vid = useRef(null);
  const stopAt = useRef(null);
  useEffect(() => {
    api.get(`/crm/product-videos/${id}`).then((r) => {
      const j = r.data.job;
      setJob(j);
      const dr = j.draft || { products: {} };
      setD({ ...dr, products: Object.fromEntries(Object.entries(dr.products || {}).map(([k, p]) => [k, { ...p, featuresText: (p.features || []).join('\n') }])) });
      setUse(Object.fromEntries(Object.keys(dr.products || {}).map((k) => [k, { video: true, text: !dr.products[k].noText && (dr.products[k].features || []).length > 0 }])));
    }).catch((e) => toast(errOf(e, 'The draft could not be opened.')));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  function play([s, e]) {
    const v = vid.current;
    if (!v) return;
    v.currentTime = s; stopAt.current = e; v.play().catch(() => {});
  }
  const setP = (k, patch) => setD((x) => ({ ...x, products: { ...x.products, [k]: { ...x.products[k], ...patch } } }));
  async function save() {
    setBusy(true);
    try {
      const products = Object.fromEntries(Object.entries(d.products).map(([k, p]) => [k, { segments: p.segments, tagline: p.tagline, about: p.about, features: String(p.featuresText || '').split('\n').map((x) => x.trim()).filter(Boolean), faq: p.faq }]));
      await api.post(`/crm/product-videos/${id}/apply`, { draft: { intro: d.intro, outro: d.outro, products, title: d.target ? d.target.title : undefined }, use });
      toast(Object.values(use).some((u) => u.video) ? 'Saved. The text is live now; the clips are being made and go live one by one (a few minutes).' : 'Saved. The text is live now.');
      onSaved();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
    setBusy(false);
  }
  return (
    <Modal title={job ? `Draft from ${job.fileName}` : 'Draft'} size="xwide" onClose={onClose}>
      {!d ? <div className="small-muted">Loading…</div> : (
        <div>
          <video ref={vid} src={job.srcUrl} controls preload="metadata" playsInline style={{ width: '100%', maxHeight: '42vh', background: '#000', borderRadius: 8 }}
            onTimeUpdate={(e) => { if (stopAt.current != null && e.currentTarget.currentTime >= stopAt.current) { e.currentTarget.pause(); stopAt.current = null; } }} />
          {(d.notes || []).length > 0 && <div className="notice" style={{ marginTop: 8 }}>{d.notes.join(' ')}</div>}
          <div className="small-muted" style={{ fontSize: 12, margin: '8px 0' }}>Times are minutes:seconds. Every product's clip = the intro + its parts + the closing. Nothing changes on the live demo until you press Save.</div>
          {d.target && d.target.kind !== 'single' && <label>Title (shown above the video)<input type="text" value={d.target.title || ''} onChange={(e) => setD({ ...d, target: { ...d.target, title: e.target.value } })} /></label>}
          {job.kind === 'all' && (
            <div className="card" style={{ padding: 10, marginBottom: 10 }}>
              <RangeRow label="Intro" range={d.intro} onChange={(r) => setD({ ...d, intro: r })} onPlay={play} onRemove={d.intro ? () => setD({ ...d, intro: null }) : null} />
              {!d.intro && <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, intro: [0, 8] })}>+ Intro</button>}
              <RangeRow label="Closing" range={d.outro} onChange={(r) => setD({ ...d, outro: r })} onPlay={play} onRemove={d.outro ? () => setD({ ...d, outro: null }) : null} />
              {!d.outro && <button type="button" className="btn btn-sm" onClick={() => setD({ ...d, outro: [Math.max(0, (d.duration || 10) - 10), d.duration || 10] })}>+ Closing</button>}
            </div>
          )}
          {Object.keys(d.products).length === 0 && <div className="notice">No product was found in this video. Upload a product's own video from its card instead.</div>}
          {Object.entries(d.products).map(([k, p]) => (
            <div key={k} className="card" style={{ padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, flex: 1 }}>{k === 'COMPANY' ? 'Company video' : nameOf(k)}{job.kind === 'extra' ? ' - another video' : ''}</h3>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={!!(use[k] || {}).video} onChange={(e) => setUse({ ...use, [k]: { ...use[k], video: e.target.checked } })} style={{ width: 'auto' }} /> Use the video</label>
                {!p.noText && <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={!!(use[k] || {}).text} onChange={(e) => setUse({ ...use, [k]: { ...use[k], text: e.target.checked } })} style={{ width: 'auto' }} /> Use the text</label>}
              </div>
              <div className="section-label">Parts of the video</div>
              {(p.segments || []).map((r, i) => (
                <RangeRow key={i} label={`Part ${i + 1}`} range={r} onPlay={play} onChange={(nr) => setP(k, { segments: p.segments.map((x, j) => (j === i ? nr : x)) })} onRemove={() => setP(k, { segments: p.segments.filter((_, j) => j !== i) })} />
              ))}
              <button type="button" className="btn btn-sm" onClick={() => { const last = (p.segments || []).slice(-1)[0]; const s = last ? last[1] : 0; setP(k, { segments: [...(p.segments || []), [s, Math.min(d.duration || s + 30, s + 30)]] }); }}>+ Part</button>
              {!p.noText && (<>
              <div className="section-label" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                Text {p.source === 'ai' ? '(written by AI from the narration)' : p.source === 'narration' ? '(sentences from the narration)' : ''}
                {p.narration && <button type="button" className="crm-linkbtn" onClick={() => setShowText(showText === k ? null : k)}>{showText === k ? 'Hide' : 'Show'} what is said</button>}
              </div>
              {showText === k && <div className="small-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 6 }}>{p.narration}</div>}
              <label>Tagline<input type="text" value={p.tagline || ''} onChange={(e) => setP(k, { tagline: e.target.value })} /></label>
              <label>About<textarea rows={3} value={p.about || ''} onChange={(e) => setP(k, { about: e.target.value })} /></label>
              <label>Features (one per line)<textarea rows={6} value={p.featuresText || ''} onChange={(e) => setP(k, { featuresText: e.target.value })} /></label>
              <label>Questions and answers (added to what the AI meeting answers from; prices stay as you set them)<textarea rows={4} value={p.faq || ''} onChange={(e) => setP(k, { faq: e.target.value })} /></label>
              </>)}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-primary" disabled={busy || !Object.values(use).some((u) => u.video || u.text)} onClick={save}>Save</button>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- OUR PRODUCTS > VIDEOS (founder 2026-11-17: "every video uploaded shows as a card under the product cards") ----------------------
// One card per video, newest first: the all-products videos (whole), the company video, each product's other videos and its own originals.
// Title (rename), length, when and by whom, what it belongs to, ▶ Watch, "Show on demo pages", ✕ Remove (asks; the file stays while anything
// else uses it). Not products: leads, quotes, the funnel and the AI meeting's product list do not change.
const KIND_WORD = { full: 'All products - full video', company: 'Company video', extra: 'Another video', original: 'Full original' };
export function VideosSection({ canEdit, onWatch, refreshKey }) {
  const { toast } = useCrm();
  const [cards, setCards] = useState(null);
  const load = () => api.get('/crm/video-cards').then((r) => setCards(r.data.cards || [])).catch(() => setCards([]));
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cards || !cards.length) return null;
  const watch = (c) => api.get(`/crm/video-cards/${c.id}/watch`).then((r) => onWatch(r.data)).catch((e) => toast(errOf(e, 'The video could not be opened.')));
  async function change(c, body, words) {
    try { await api.put(`/crm/video-cards/${c.id}`, body); if (words) toast(words); load(); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  function rename(c) {
    const t = window.prompt('Title of this video:', c.title); // eslint-disable-line no-alert
    if (t && t.trim() && t.trim() !== c.title) change(c, { title: t.trim() }, 'Renamed.');
  }
  async function remove(c) {
    if (!window.confirm(`Remove the video "${c.title}"? Leads stop seeing it. The product demo clips stay as they are.`)) return; // eslint-disable-line no-alert
    try { await api.delete(`/crm/video-cards/${c.id}`); toast('Removed.'); load(); } catch (e) { toast(errOf(e, 'This could not be removed.')); }
  }
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 4px' }}>Videos</h3>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 10 }}>Every video uploaded, newest first. “Show on demo pages” puts it on the leads' demo page: the company video at the top, a product's videos under that product, full all-products videos at the bottom.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
        {cards.map((c) => (
          <div key={c.id} className="card" style={{ padding: 14, opacity: c.available ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <h4 style={{ margin: 0, fontSize: 15, flex: 1, wordBreak: 'break-word' }}>{c.title}</h4>
              <span className="status approved">{c.duration ? mmss(c.duration).replace(/\.\d$/, '') : 'Video'}</span>
            </div>
            <div className="small-muted" style={{ fontSize: 12.5, margin: '4px 0' }}>{c.belongsTo} · {KIND_WORD[c.kind] || c.kind}</div>
            <div className="small-muted" style={{ fontSize: 12 }}>Uploaded {dateTimeOf(c.uploadedAt || c.createdAt)}{c.uploadedByName ? ` by ${c.uploadedByName}` : ''}</div>
            {!c.available && <div className="small-muted" style={{ fontSize: 12, color: 'var(--red)' }}>The file is not on the server any more.</div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={!c.available} onClick={() => watch(c)}>▶ Watch</button>
              {canEdit && <button type="button" className="btn btn-sm" onClick={() => rename(c)}>Rename</button>}
              {canEdit && <button type="button" className="btn btn-sm" onClick={() => remove(c)} aria-label={`Remove ${c.title}`}>✕ Remove</button>}
            </div>
            {canEdit ? (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
                <input type="checkbox" checked={!!c.showOnDemo} onChange={(e) => change(c, { showOnDemo: e.target.checked }, e.target.checked ? 'Leads see it on their demo page now.' : 'Taken off the demo pages.')} style={{ width: 'auto' }} /> Show on demo pages
              </label>
            ) : <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>{c.showOnDemo ? 'Shown on demo pages' : 'Not on demo pages'}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

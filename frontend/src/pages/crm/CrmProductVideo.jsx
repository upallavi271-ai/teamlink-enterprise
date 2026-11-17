// ---------------------------------------------------------------------------
// OUR PRODUCTS > VIDEOS (founder 2026-11-17: "upload a video, and the content is made from it"). Managers only, inside Leads > Our products.
//   VideoStudio      upload one video with all the products (or a product's own video from its card), see each upload's progress
//   DraftEditor      what the server found: the parts of the video per product (start - end, play each part), the intro and the closing,
//                    and the text written from that product's narration. Tick what to use and Save; until then nothing changes.
// Backend: crm/productVideo.js (/api/crm/product-videos...).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const NAME = { HRMS: 'HRMS', ATS: 'ATS', OMNI: 'Omni-Channel' };
const ACTIVE = ['uploading', 'queued', 'analysing', 'cutting'];
const mmss = (n) => { if (n == null || n === '' || Number.isNaN(Number(n))) return ''; const v = Number(n); const m = Math.floor(v / 60); const s = (v - m * 60).toFixed(1).padStart(4, '0'); return `${m}:${s}`; };
const secs = (t) => { const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(String(t || '').trim()); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(n > 104857600 ? 0 : 1)} MB`;

// send the file in pieces; a piece that fails is tried again 3 times, a piece out of order restarts from where the server is
export async function uploadVideo(file, { kind, key }, onProgress) {
  const st = await api.post('/crm/product-videos', { kind, key, name: file.name, size: file.size });
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

export function VideoStudio({ onSaved, refreshKey }) {
  const { toast } = useCrm();
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
      else if (wasActive.current.has(j.id)) { wasActive.current.delete(j.id); if (j.status === 'done' && onSaved) onSaved(); if (j.status === 'draft') toast('The video is read: press Review the draft.'); }
    });
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setUp({ name: f.name, pct: 0 });
    try { await uploadVideo(f, { kind: 'all' }, (p) => setUp({ name: f.name, pct: p })); toast('Uploaded. The server is reading the video now - this takes a few minutes.'); } catch (err) { toast(errOf(err, 'The upload did not finish. Please try again.')); }
    setUp(null); load();
  }
  async function act(j, what) {
    try {
      if (what === 'retry') await api.post(`/crm/product-videos/${j.id}/retry`);
      if (what === 'delete') { if (!window.confirm(`Remove the upload "${j.fileName}"? Clips already live stay as they are.`)) return; await api.delete(`/crm/product-videos/${j.id}`); } // eslint-disable-line no-alert
      load();
    } catch (e) { toast(errOf(e, 'This did not work.')); }
  }
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, flex: 1 }}>Product videos</h3>
        <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv" style={{ display: 'none' }} onChange={pick} />
        <button type="button" className="btn btn-primary" disabled={!!up} onClick={() => input.current && input.current.click()}>⬆ Upload one video with all products</button>
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '6px 0' }}>The server listens to the narration, finds where HRMS, ATS (with the Job Portal) and Omni-Channel are, and writes each product's text from what is said about it. You review it all before anything changes. To replace one product's video, use “Upload video” on its card below.</div>
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
                <td>{j.kind === 'single' ? NAME[j.productKey] : 'All products'}</td>
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
      {open && <DraftEditor id={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); if (onSaved) onSaved(); }} />}
    </div>
  );
}

// a product's own video from its card
export function SingleUpload({ product, onDone }) {
  const { toast } = useCrm();
  const input = useRef(null);
  const [pct, setPct] = useState(null);
  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setPct(0);
    try { await uploadVideo(f, { kind: 'single', key: product.key }, setPct); toast(`Uploaded. When it is read, review it under Product videos and press Save to use it for ${product.name}.`); if (onDone) onDone(); } catch (err) { toast(errOf(err, 'The upload did not finish. Please try again.')); }
    setPct(null);
  }
  return (
    <>
      <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv" style={{ display: 'none' }} onChange={pick} />
      <button type="button" className="btn btn-sm" style={{ marginTop: 10, marginRight: 6 }} disabled={pct != null} onClick={() => input.current && input.current.click()}>{pct == null ? '⬆ Upload video' : `Uploading ${Math.round(pct * 100)}%`}</button>
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

function DraftEditor({ id, onClose, onSaved }) {
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
      setUse(Object.fromEntries(Object.keys(dr.products || {}).map((k) => [k, { video: true, text: (dr.products[k].features || []).length > 0 }])));
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
      await api.post(`/crm/product-videos/${id}/apply`, { draft: { intro: d.intro, outro: d.outro, products }, use });
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
          {job.kind !== 'single' && (
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
                <h3 style={{ margin: 0, flex: 1 }}>{NAME[k]}</h3>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={!!(use[k] || {}).video} onChange={(e) => setUse({ ...use, [k]: { ...use[k], video: e.target.checked } })} style={{ width: 'auto' }} /> Use the video</label>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={!!(use[k] || {}).text} onChange={(e) => setUse({ ...use, [k]: { ...use[k], text: e.target.checked } })} style={{ width: 'auto' }} /> Use the text</label>
              </div>
              <div className="section-label">Parts of the video</div>
              {(p.segments || []).map((r, i) => (
                <RangeRow key={i} label={`Part ${i + 1}`} range={r} onPlay={play} onChange={(nr) => setP(k, { segments: p.segments.map((x, j) => (j === i ? nr : x)) })} onRemove={() => setP(k, { segments: p.segments.filter((_, j) => j !== i) })} />
              ))}
              <button type="button" className="btn btn-sm" onClick={() => { const last = (p.segments || []).slice(-1)[0]; const s = last ? last[1] : 0; setP(k, { segments: [...(p.segments || []), [s, Math.min(d.duration || s + 30, s + 30)]] }); }}>+ Part</button>
              <div className="section-label" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                Text {p.source === 'ai' ? '(written by AI from the narration)' : p.source === 'narration' ? '(sentences from the narration)' : ''}
                {p.narration && <button type="button" className="crm-linkbtn" onClick={() => setShowText(showText === k ? null : k)}>{showText === k ? 'Hide' : 'Show'} what is said</button>}
              </div>
              {showText === k && <div className="small-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 6 }}>{p.narration}</div>}
              <label>Tagline<input type="text" value={p.tagline || ''} onChange={(e) => setP(k, { tagline: e.target.value })} /></label>
              <label>About<textarea rows={3} value={p.about || ''} onChange={(e) => setP(k, { about: e.target.value })} /></label>
              <label>Features (one per line)<textarea rows={6} value={p.featuresText || ''} onChange={(e) => setP(k, { featuresText: e.target.value })} /></label>
              <label>Questions and answers (added to what the AI meeting answers from; prices stay as you set them)<textarea rows={4} value={p.faq || ''} onChange={(e) => setP(k, { faq: e.target.value })} /></label>
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

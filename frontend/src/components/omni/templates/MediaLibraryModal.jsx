import { useCallback, useEffect, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { GsModal, Btn, TinyBtn, Tabs, Banner } from '../ui.jsx';
import { fmtSize, copyText, absUrl } from './tplCommon.jsx';
import './templates.css';

// ---------------------------------------------------------------------------
// THE LIBRARY (media library), shared by Content Studio, Templates (headers), Social and the Console.
//   <MediaLibraryModal onClose onPick(items) multiple selected=[ids] types=['image', ...] />   the "All Media" window: tabs, search, upload, save a link
//   <LibraryPicker value=[ids] onChange(ids, items) types multiple label />                    a small "Attach files / Browse library" block with chips
//   uploadToLibrary(file, { department }) -> item                                              one upload (used by drop zones)
// Items come from /api/outreach/gs/library (server: outreach/library.js). A saved file has a public share address (item.url, unguessable).
// ---------------------------------------------------------------------------
const TABS = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['document', 'Documents'], ['link', 'Links']];
const ICON = { image: '🖼', video: '🎬', document: '📄', link: '🔗' };
export const TYPE_WORD = { image: 'Image', video: 'Video', document: 'Document', link: 'Link' };
const ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.doc,.docx,image/png,image/jpeg,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BIG = 5 * 1024 * 1024;

export async function uploadToLibrary(file, { department = '', name = '', note = '' } = {}) {
  if (file.size > BIG) throw new Error(`"${file.name}" is ${fmtSize(file.size)}; the limit is 5 MB.`);
  const fd = new FormData();
  fd.append('file', file); if (department) fd.append('department', department); if (name) fd.append('name', name); if (note) fd.append('note', note);
  const r = await omni.post('/gs/library/upload', fd);
  return r.item;
}

export const Thumb = ({ item, size = 64 }) => (item.mediaType === 'image'
  ? <img src={item.url} alt="" style={{ width: '100%', height: size, objectFit: 'cover', borderRadius: 9, display: 'block' }} />
  : <div className="mt-thumb" style={{ height: size }}>{ICON[item.mediaType] || '📄'}</div>);

export default function MediaLibraryModal({ onClose, onPick, multiple = true, selected = [], types = null, title = 'Media library', sub = 'Files and links your team can use. Click to pick, click again to let go.' }) {
  const { acc, toast, dept } = useOmni();
  const [tab, setTab] = useState(types && types.length === 1 ? types[0] : 'all');
  const [q, setQ] = useState('');
  const [data, setData] = useState({ items: [], counts: {}, canUpload: false });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(() => new Map());
  const [linkOpen, setLinkOpen] = useState(false);
  const [lk, setLk] = useState({ name: '', url: '' });
  const [forDept, setForDept] = useState(dept ? 'dept' : 'all');
  const fileRef = useRef(null);
  const canUpload = !!(acc && acc.canLibraryUpload);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await omni.get('/gs/library', { q: q || undefined, type: tab === 'all' ? undefined : tab }); setData(r); setErr(''); } catch (e) { setErr(errOf(e, 'The Library could not be read.')); } finally { setLoading(false); }
  }, [q, tab]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { // the items already picked (by id) are looked up once so they show ticked even when another tab hides them
    if (!selected.length) return;
    omni.post('/gs/library/links-for', { ids: selected }).then((r) => setPick(new Map((r.links || []).map((l) => [l.id, { id: l.id, name: l.name, url: l.url, mediaType: l.mediaType, kind: l.kind }])))).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allowed = (i) => !types || types.includes(i.mediaType);
  const items = (data.items || []).filter(allowed);
  const toggle = (i) => setPick((m) => {
    const n = new Map(m);
    if (n.has(i.id)) n.delete(i.id); else { if (!multiple) n.clear(); n.set(i.id, i); }
    return n;
  });
  const upload = async (files) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      let last = null;
      for (const f of Array.from(files)) { last = await uploadToLibrary(f, { department: forDept === 'dept' ? dept : '' }); } // eslint-disable-line no-await-in-loop
      toast(`${files.length === 1 ? files[0].name : `${files.length} files`} saved to the Library`);
      if (last && allowed(last)) setPick((m) => { const n = new Map(multiple ? m : []); n.set(last.id, last); return n; });
      await load();
    } catch (e) { setErr(errOf(e, e.message || 'The file could not be saved.')); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const saveLink = async () => {
    setBusy(true); setErr('');
    try { const r = await omni.post('/gs/library/link', { ...lk, department: forDept === 'dept' ? dept : '' }); toast('Link saved to the Library'); setLk({ name: '', url: '' }); setLinkOpen(false); if (allowed(r.item)) setPick((m) => { const n = new Map(multiple ? m : []); n.set(r.item.id, r.item); return n; }); await load(); } catch (e) { setErr(errOf(e, 'The link could not be saved.')); } finally { setBusy(false); }
  };
  const remove = async (i) => {
    if (!window.confirm(`Delete "${i.name}" from the Library? Links already sent keep pointing to it, and will stop working.`)) return;
    try { await omni.del(`/gs/library/${i.id}`); setPick((m) => { const n = new Map(m); n.delete(i.id); return n; }); toast('Deleted from the Library'); await load(); } catch (e) { setErr(errOf(e, 'It could not be deleted.')); }
  };
  const tabs = TABS.filter(([id]) => id === 'all' || !types || types.includes(id)).map(([id, l]) => [id, l, data.counts ? data.counts[id] : undefined]);

  return (
    <GsModal title={title} sub={sub} width={760} onClose={onClose}
      foot={(
        <>
          <span style={{ marginRight: 'auto', fontSize: 10, color: 'var(--muted)' }}>{pick.size ? `${pick.size} picked` : 'Nothing picked yet'}</span>
          {canUpload && <><input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} /><Btn disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>＋ Upload a file</Btn><Btn disabled={busy} onClick={() => setLinkOpen((v) => !v)}>🔗 Save a link</Btn></>}
          <Btn primary onClick={() => { if (onPick) onPick([...pick.values()]); onClose(); }}>Done</Btn>
        </>
      )}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <input className="search" aria-label="Search the Library" placeholder="Search by name or note…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
      </div>
      {canUpload && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10, color: 'var(--muted)', marginBottom: 8, flexWrap: 'wrap' }}>
          <span>New items can be seen by</span>
          <select className="select" value={forDept} onChange={(e) => setForDept(e.target.value)} style={{ height: 30 }}>
            <option value="all">Everybody who uses Omni-Channel</option>
            {dept ? <option value="dept">Only {dept}</option> : null}
          </select>
          <span>Pictures (PNG, JPG, WebP) and documents (PDF, DOC, DOCX) up to 5 MB. A video is saved as a link.</span>
        </div>
      )}
      {!canUpload && <Banner tone="info">Your login can pick from the Library but not add to it.</Banner>}
      {linkOpen && (
        <div className="card panel" style={{ marginBottom: 10 }}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 2fr auto', alignItems: 'end' }}>
            <div className="field"><label>NAME</label><input value={lk.name} placeholder="Walk-in interview video" onChange={(e) => setLk({ ...lk, name: e.target.value })} /></div>
            <div className="field"><label>WEB ADDRESS</label><input value={lk.url} placeholder="https://www.youtube.com/watch?v=..." onChange={(e) => setLk({ ...lk, url: e.target.value })} /></div>
            <Btn primary disabled={busy || !lk.url.trim()} onClick={saveLink}>Save link</Btn>
          </div>
        </div>
      )}
      {err && <Banner tone="error">{err}</Banner>}
      {loading && !items.length ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
        : !items.length ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>{q ? 'Nothing matches that search.' : 'The Library is empty here. Upload a file or save a link to start.'}</div>
          : (
            <div className="media-grid">
              {items.map((i) => (
                <div key={i.id} role="button" tabIndex={0} className={`media-tile${pick.has(i.id) ? ' on' : ''}`} onClick={() => toggle(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(i); } }} style={{ cursor: 'pointer' }}>
                  <span className="mt-check">✓</span>
                  <Thumb item={i} />
                  <b className="lib-name">{i.name}</b>
                  <small>{TYPE_WORD[i.mediaType]}{i.size ? ` · ${fmtSize(i.size)}` : ''}{i.department ? ` · ${i.department}` : ''}</small>
                  <small style={{ display: 'block' }}>{i.createdByName}{i.createdAt ? ` · ${new Date(i.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : ''}</small>
                  <span style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                    <TinyBtn onClick={() => { copyText(absUrl(i.url)); toast('Link copied'); }}>⧉ Copy link</TinyBtn>
                    {i.canDelete && <TinyBtn onClick={() => remove(i)} className="lib-del">🗑</TinyBtn>}
                  </span>
                </div>
              ))}
            </div>
          )}
    </GsModal>
  );
}

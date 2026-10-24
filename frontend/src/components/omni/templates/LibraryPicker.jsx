import { useEffect, useRef, useState } from 'react';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn } from '../ui.jsx';
import MediaLibraryModal, { uploadToLibrary, TYPE_WORD, Thumb } from './MediaLibraryModal.jsx';
import { fmtSize } from './tplCommon.jsx';
import './templates.css';

// A small "Media" block: the picked items as rows (thumbnail, name, remove) and two buttons, "Attach files" (straight upload into the Library)
// and "Browse library" (opens the All Media window). Other pages (Social, Console, Campaigns) import this.
//   value     array of Library item ids      onChange(ids, items)     types  ['image','video','document','link'] or null for all
export default function LibraryPicker({ value = [], onChange, types = null, multiple = true, label = 'Media library', empty = 'No media attached yet.' }) {
  const { acc, toast, dept } = useOmni();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const key = (value || []).join(',');

  useEffect(() => { // names and thumbnails of the ids we were given
    let live = true;
    if (!value.length) { setItems([]); return undefined; }
    omni.post('/gs/library/links-for', { ids: value }).then((r) => { if (live) setItems((r.links || []).map((l) => ({ ...l, mediaType: l.mediaType, url: l.url.replace(/^https?:\/\/[^/]+(?=\/api\/)/, '') }))); }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = (list) => { setItems(list); if (onChange) onChange(list.map((i) => i.id), list); };
  const add = (picked) => set(multiple ? [...items.filter((i) => !picked.some((p) => p.id === i.id)), ...picked] : picked.slice(0, 1));
  const upload = async (files) => {
    if (!files || !files.length) return;
    setBusy(true);
    try { const done = []; for (const f of Array.from(files)) done.push(await uploadToLibrary(f, { department: dept || '' })); add(done); toast(`${done.length === 1 ? done[0].name : `${done.length} files`} attached`); } catch (e) { toast((e.response && e.response.data && e.response.data.error) || e.message || 'The file could not be attached.'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const canUpload = !!(acc && acc.canLibraryUpload);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {canUpload && <><input ref={fileRef} type="file" multiple={multiple} style={{ display: 'none' }} accept=".png,.jpg,.jpeg,.webp,.pdf,.doc,.docx" onChange={(e) => upload(e.target.files)} /><Btn disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>📎 Attach files</Btn></>}
        <Btn onClick={() => setOpen(true)}>Browse library</Btn>
        <span className="pill live">{items.length} {items.length === 1 ? 'asset' : 'assets'} selected</span>
      </div>
      <div className="studio-assets">
        {items.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{empty}</div>}
        {items.map((i) => (
          <div className="studio-asset" key={i.id}>
            <span style={{ width: 44, flex: '0 0 44px' }}><Thumb item={i} size={36} /></span>
            <div style={{ flex: 1, minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{i.name}</b><small>{TYPE_WORD[i.mediaType] || 'File'}{i.size ? ` · ${fmtSize(i.size)}` : ''}</small></div>
            <button type="button" className="th-file-x" title="Remove" aria-label={`Remove ${i.name}`} onClick={() => set(items.filter((x) => x.id !== i.id))}>✕</button>
          </div>
        ))}
      </div>
      {open && <MediaLibraryModal title={label} selected={items.map((i) => i.id)} types={types} multiple={multiple} onClose={() => setOpen(false)} onPick={(p) => set(multiple ? p : p.slice(0, 1))} />}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import api from '../../api';

// "AUTOMATIC ASSETS" (2026-10-19) - inside "Assets this vendor can see". Nothing here is needed for the vendor to see its assets: the vendor's own
// master category decides, by itself, today and for every asset added later in HRMS or Accounts. This panel only
//   * shows what is automatic and why,
//   * lets Admin HIDE a category or one asset from the automatic rule (the exceptions),
//   * lists a category that two vendors share (then nobody gets it until Admin ticks it for one vendor below),
//   * lets Admin change which asset categories a kind of vendor handles (the map).
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');

export default function VendorAssetAuto({ vendorId, vendorName, data, onSaved }) {
  const auto = data.auto;
  const conflicts = data.autoConflicts || [];
  const [hide, setHide] = useState(new Set());
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const savedHidden = useMemo(() => (auto ? auto.categories.filter((c) => c.hidden).map((c) => c.value).sort() : []), [auto]);
  useEffect(() => { setHide(new Set(savedHidden)); }, [savedHidden]);
  if (!auto) return null;
  const dirty = JSON.stringify([...hide].sort()) !== JSON.stringify(savedHidden);
  const toggle = (c) => { setMsg(''); setHide((cur) => { const n = new Set(cur); if (n.has(c)) n.delete(c); else n.add(c); return n; }); };
  async function save() {
    if (busy) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.put(`/vendor-logins/asset-grants/${encodeURIComponent(vendorId)}/hide`, { categories: [...hide], assetIds: auto.excludedAssetIds || [] });
      setMsg(r.data.message || 'Saved.');
      if (onSaved) await onSaved();
    } catch (e) { setErr(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const mineConflict = conflicts.find((c) => c.key === auto.key);
  return (
    <div className="vag-auto">
      <div className="vp-lbl">Automatic (no tick needed)</div>
      {!auto.mapped ? (
        <div className="cell-muted">
          {vendorName || 'This vendor'} is filed as &ldquo;{auto.vendorCategory || 'no category'}&rdquo; in the Vendor Master, and no asset categories are set for that kind of vendor, so nothing shows by itself.
          Tick categories below, or set the vendor&apos;s category in the Vendor Master.
        </div>
      ) : (
        <>
          <div>
            Because {vendorName || 'this vendor'} is a <strong>{auto.keyLabel}</strong> vendor, <strong>{auto.total} asset{auto.total === 1 ? '' : 's'}</strong> in these categories belong to it by themselves. It is shown the ones that are free in stock ({data.available ?? 0} now) and any asset with an approved repair job. A new asset added in HRMS or Accounts
            shows on the vendor&apos;s next page load. Nobody has to import or tick anything.
          </div>
          {auto.conflict && (
            <div className="notice amber" style={{ margin: '8px 0' }}>
              <span>
                <strong>Another vendor ({auto.peers.join(', ')}) is the same kind.</strong> To stop the wrong vendor seeing an asset, these categories show to <u>nobody</u> by themselves
                {mineConflict ? ` (${mineConflict.assets} asset${mineConflict.assets === 1 ? '' : 's'} are waiting)` : ''}. Tick the categories below for the right vendor, or link the asset to it.
              </span>
            </div>
          )}
          <div className="vl-pick vag-cats">
            {auto.categories.map((c) => (
              <label key={c.value} className="vl-pick-row">
                <input type="checkbox" checked={!hide.has(c.value)} disabled={auto.conflict} onChange={() => toggle(c.value)} />
                <span>{c.value} <span className="cell-muted">({c.count} in the asset list){hide.has(c.value) ? ' - hidden from this vendor' : ''}</span></span>
              </label>
            ))}
          </div>
          <div className="cell-muted vag-note">Untick a category to hide it from this vendor. SIM cards are never in this list: they belong to the SIM / Airtel vendor.</div>
          {auto.excludedAssetIds.length > 0 && <div className="cell-muted vag-note">{auto.excludedAssetIds.length} single asset{auto.excludedAssetIds.length === 1 ? ' is' : 's are'} hidden from this vendor.</div>}
          <div className="vag-actions">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty || auto.conflict}>{busy ? 'Saving...' : 'Save what is hidden'}</button>
            {dirty && <button type="button" className="btn" onClick={() => setHide(new Set(savedHidden))} disabled={busy}>Undo</button>}
          </div>
        </>
      )}
      {msg && <div className="notice green" style={{ marginTop: 8 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
      {conflicts.length > 0 && (
        <div className="notice amber" style={{ marginTop: 8 }}>
          <span><strong>Waiting for you to decide:</strong> {conflicts.map((c) => `${c.vendors.join(' and ')} are both "${c.label}" (${c.assets} asset${c.assets === 1 ? '' : 's'} in ${c.categories.join(', ')})`).join('; ')}.</span>
        </div>
      )}
      <div className="vag-sec">
        <button type="button" className="link-btn" aria-expanded={mapOpen} onClick={() => setMapOpen((x) => !x)}>{mapOpen ? 'Hide' : 'Change'} which asset categories each kind of vendor handles</button>
        {mapOpen && <MapEditor onSaved={onSaved} />}
      </div>
    </div>
  );
}

function MapEditor({ onSaved }) {
  const [d, setD] = useState(null);
  const [map, setMap] = useState({});
  const [key, setKey] = useState('it_service');
  const [add, setAdd] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/vendor-logins/asset-grants/category-map').then((r) => { setD(r.data); setMap(r.data.map); }).catch((e) => setErr(errText(e, 'Could not load the list.'))); }, []);
  if (!d) return <div className="cell-muted">{err || 'Loading...'}</div>;
  const list = map[key] || [];
  const put = (l) => { setMsg(''); setMap((m) => ({ ...m, [key]: l })); };
  const addIt = () => { const v = add.trim(); if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) put([...list, v]); setAdd(''); };
  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.put('/vendor-logins/asset-grants/category-map', { map }); setMsg(r.data.message || 'Saved.'); if (onSaved) await onSaved(); } catch (e) { setErr(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <div className="vag-sec">
      <label className="vp-lbl" htmlFor="vag-key">Kind of vendor (its category in the Vendor Master)</label>
      <select id="vag-key" value={key} onChange={(e) => setKey(e.target.value)}>
        {d.vendorCategories.filter((c) => (map[c.key] || []).length || c.key === 'it_service').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <div className="vag-chips" aria-label="Asset categories this kind of vendor handles">
        {list.map((c) => <span key={c} className="vag-chip">{c}<button type="button" aria-label={`Remove ${c}`} onClick={() => put(list.filter((x) => x !== c))}>&times;</button></span>)}
        {!list.length && <span className="cell-muted">None - these vendors would see nothing by themselves.</span>}
      </div>
      <div className="vag-actions">
        <input list="vag-asset-cats" aria-label="Add an asset category" placeholder="Type or pick an asset category" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIt(); } }} />
        <datalist id="vag-asset-cats">{d.assetCategories.map((c) => <option key={c.value} value={c.value} />)}</datalist>
        <button type="button" className="btn btn-sm" onClick={addIt} disabled={!add.trim()}>Add</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !d.canEdit}>{busy ? 'Saving...' : 'Save this list'}</button>
      </div>
      {!d.canEdit && <div className="cell-muted">Only Admin can change this list.</div>}
      {msg && <div className="notice green"><span>{msg}</span></div>}
      {err && <div className="notice red"><span>{err}</span></div>}
    </div>
  );
}

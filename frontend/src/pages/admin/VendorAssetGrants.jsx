import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import VendorAssetAuto from './VendorAssetAuto.jsx';
import './vendorAssetGrants.css';

// ---------------------------------------------------------------------------
// "ASSETS THIS VENDOR CAN SEE" (2026-10-19) - inside the Edit vendor login window, for an asset vendor.
// The assets are the company's own HRMS assets (nothing is copied). Admin sees:
//   * "{vendor} will see N assets" - the same number the vendor's portal shows, updated as you tick, before you save
//   * whole categories (tick "All IT hardware" in one press) and single assets (type to search)
//   * the assets found by themselves, each with the reason ("Bought from this vendor", "Repaired by this vendor", ...)
//   * names the company wrote that could not be matched safely - for Admin to decide
// Saving here is separate from the window's own Save button and takes effect on the vendor's next page load.
// ---------------------------------------------------------------------------
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const IT_WORDS = /laptop|charger|mouse|head ?set|monitor|mobile|phone|keyboard|printer|tablet|desktop|router|scanner/i;
const SIM_WORDS = /\bsim\b/i;

export default function VendorAssetGrants({ vendorId, vendorName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [cats, setCats] = useState(new Set());
  const [ids, setIds] = useState(new Map()); // assetId -> { assetCode, name }
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [live, setLive] = useState(null); // the count for ticks that are not saved yet
  const [busy, setBusy] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const saved = useRef({ cats: [], ids: [] });
  const seq = useRef(0);

  const load = useCallback(() => {
    setError('');
    return api.get(`/vendor-logins/asset-grants/${encodeURIComponent(vendorId)}`).then((r) => {
      const d = r.data;
      setData(d);
      setCats(new Set(d.grants.categories));
      const idMap = new Map();
      d.grants.assetIds.forEach((id) => { const row = d.rows.find((x) => x.assetId === id); idMap.set(id, row ? { assetCode: row.assetCode, name: row.name } : { assetCode: 'Asset', name: '' }); });
      setIds(idMap);
      saved.current = { cats: [...d.grants.categories].sort(), ids: [...d.grants.assetIds].sort() };
      setLive(null);
    }).catch((e) => setError(errText(e, 'Could not load the assets.')));
  }, [vendorId]);
  useEffect(() => { setData(null); if (vendorId) load(); }, [vendorId, load]);

  const dirty = useMemo(() => JSON.stringify([[...cats].sort(), [...ids.keys()].sort()]) !== JSON.stringify([saved.current.cats, saved.current.ids]), [cats, ids, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // The number for what is ticked right now (before saving).
  useEffect(() => {
    if (!data || !dirty) { setLive(null); return undefined; }
    const n = (seq.current += 1);
    const t = setTimeout(() => {
      api.post(`/vendor-logins/asset-grants/${encodeURIComponent(vendorId)}/preview`, { assetIds: [...ids.keys()], categories: [...cats] })
        .then((r) => { if (n === seq.current) setLive(r.data); }).catch(() => { if (n === seq.current) setLive(null); });
    }, 300);
    return () => clearTimeout(t);
  }, [cats, ids, dirty, data, vendorId]);

  // Type to search the HRMS asset list.
  useEffect(() => {
    if (!q.trim()) { setFound(null); return undefined; }
    const t = setTimeout(() => {
      api.get(`/vendor-logins/asset-grants/${encodeURIComponent(vendorId)}/search`, { params: { q } }).then((r) => setFound(r.data)).catch(() => setFound({ rows: [], total: 0, failed: true }));
    }, 250);
    return () => clearTimeout(t);
  }, [q, vendorId]);

  const toggleCat = (c) => { setMsg(''); setCats((cur) => { const n = new Set(cur); if (n.has(c)) n.delete(c); else n.add(c); return n; }); };
  const tickMany = (test) => { setMsg(''); setCats((cur) => { const n = new Set(cur); (data?.categories || []).filter((c) => test(c.value)).forEach((c) => n.add(c.value)); return n; }); };
  const toggleAsset = (a) => {
    setMsg('');
    setIds((cur) => { const n = new Map(cur); if (n.has(a.assetId)) n.delete(a.assetId); else n.set(a.assetId, { assetCode: a.assetCode, name: a.name }); return n; });
  };

  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.put(`/vendor-logins/asset-grants/${encodeURIComponent(vendorId)}`, { assetIds: [...ids.keys()], categories: [...cats] });
      setMsg(r.data.message || 'Saved.');
      await load();
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  function undo() { setMsg(''); setCats(new Set(saved.current.cats)); setIds((cur) => { const n = new Map(); saved.current.ids.forEach((id) => n.set(id, cur.get(id) || { assetCode: 'Asset', name: '' })); return n; }); }

  if (!data && !error) return <div className="vag"><div className="vp-none">Loading the assets...</div></div>;
  const shown = live || data;
  const total = shown ? shown.total : 0;
  const by = shown ? shown.byReason : {};
  const rows = shown ? shown.rows : [];
  const itCount = (data?.categories || []).filter((c) => IT_WORDS.test(c.value) && !SIM_WORDS.test(c.value)).reduce((n, c) => n + c.count, 0);

  return (
    <div className="vag">
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {data && (
        <>
          <div className="vag-count" aria-live="polite">
            <strong>{vendorName || data.vendor.name} will see {total} asset{total === 1 ? '' : 's'}</strong>
            {dirty && live && <span className="vag-new"> (after you save)</span>}
            <div className="cell-muted" data-testid="vag-split">{shown && shown.available != null ? `${shown.available} available asset${shown.available === 1 ? '' : 's'} + ${shown.underRepair || 0} under repair (${shown.repairJobs || 0} repair job${shown.repairJobs === 1 ? '' : 's'}). ` : ''}Assets held by an employee are not shown to the vendor unless they have an approved repair job.{shown && shown.hiddenHeld ? ` ${shown.hiddenHeld} more match but are held by employees.` : ''}</div>
            <div className="cell-muted">
              {by.auto || 0} automatic · {by.admin || 0} chosen by you · {by.supplier || 0} bought from this vendor · {by.repaired || 0} repaired by this vendor · {by.linked || 0} linked to this vendor.
              An asset can have more than one reason, so these may add up to more than {total}.
            </div>
          </div>
          {total === 0 && !dirty && !(data.auto && data.auto.mapped && !data.auto.conflict) && <div className="notice amber" style={{ margin: '8px 0' }}><span>The asset list does not say which vendor bought or repairs any asset, so nothing shows for this vendor yet. Tick the categories or assets below, then press Save these assets.</span></div>}

          <VendorAssetAuto vendorId={vendorId} vendorName={vendorName} data={data} onSaved={load} />

          <div className="vp-lbl" style={{ marginTop: 12 }}>Whole categories (a tick here always shows, even for a vendor that shares a category)</div>
          <div className="vag-presets">
            <button type="button" className="btn btn-sm" onClick={() => tickMany((c) => IT_WORDS.test(c) && !SIM_WORDS.test(c))} disabled={!itCount}>Tick all IT hardware ({itCount})</button>
            <button type="button" className="btn btn-sm" onClick={() => tickMany((c) => SIM_WORDS.test(c))}>Tick all SIM cards</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCats(new Set())} disabled={!cats.size}>Untick all</button>
          </div>
          <div className="vl-pick vag-cats">
            {data.categories.length ? data.categories.map((c) => (
              <label key={c.value} className="vl-pick-row">
                <input type="checkbox" checked={cats.has(c.value)} onChange={() => toggleCat(c.value)} />
                <span>{c.value} <span className="cell-muted">({c.count} in the asset list)</span></span>
              </label>
            )) : <div className="vp-none">The asset list is empty.</div>}
          </div>
          <div className="cell-muted vag-note">A new asset added to a ticked category shows up for the vendor by itself.</div>

          <div className="vp-lbl" style={{ marginTop: 12 }}>Single assets</div>
          <input type="search" aria-label="Search the asset list" placeholder="Type an asset ID, name, serial number or seat" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          {found && (
            <div className="vl-pick vag-found">
              {found.failed ? <div className="vp-none">Could not search. Try again.</div> : !found.rows.length ? <div className="vp-none">No asset matches.</div> : found.rows.map((a) => (
                <label key={a.assetId} className="vl-pick-row">
                  <input type="checkbox" checked={ids.has(a.assetId)} onChange={() => toggleAsset(a)} />
                  <span>
                    <strong>{a.assetCode}</strong> {a.name} <span className="cell-muted">· {a.category} · {a.status}{a.location ? ` · ${a.location}` : ''}</span>
                    {a.inCategory && <span className="vag-tag"> already in a ticked category</span>}
                    {a.linkedTo && <span className="vag-tag vag-warn"> linked to {a.linkedTo}</span>}
                  </span>
                </label>
              ))}
              {found.total > found.rows.length && <div className="cell-muted vag-note">Showing {found.rows.length} of {found.total}. Type more to narrow it down.</div>}
            </div>
          )}
          {ids.size > 0 && (
            <div className="vag-chips" aria-label="Single assets ticked">
              {[...ids.entries()].map(([id, a]) => (
                <span key={id} className="vag-chip">{a.assetCode}{a.name ? ` · ${a.name}` : ''}<button type="button" aria-label={`Remove ${a.assetCode}`} onClick={() => toggleAsset({ assetId: id })}>&times;</button></span>
              ))}
            </div>
          )}

          <div className="vag-actions">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save these assets'}</button>
            {dirty && <button type="button" className="btn" onClick={undo} disabled={busy}>Undo my ticks</button>}
            {!dirty && !msg && <span className="cell-muted">Nothing changed yet.</span>}
          </div>
          {msg && <div className="notice green" style={{ marginTop: 8 }}><span>{msg}</span></div>}

          <div className="vag-sec">
            <button type="button" className="link-btn" aria-expanded={showAuto} onClick={() => setShowAuto((x) => !x)}>
              {showAuto ? 'Hide' : 'Show'} the {total} asset{total === 1 ? '' : 's'} this vendor will see and why
            </button>
            {showAuto && (
              <div className="tbl-wrap vag-table">
                <table>
                  <thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Why</th></tr></thead>
                  <tbody>
                    {rows.map((r) => <tr key={r.assetId}><td><strong>{r.assetCode}</strong></td><td>{r.name}</td><td>{r.category}</td><td>{(r.reasonText || []).join(', ')}</td></tr>)}
                  </tbody>
                </table>
                {shown.total > rows.length && <div className="cell-muted vag-note">Showing the first {rows.length} of {shown.total}.</div>}
                {!rows.length && <div className="vp-none">None yet.</div>}
              </div>
            )}
          </div>

          {(data.ambiguous.length > 0 || data.possible.length > 0) && (
            <div className="notice amber vag-sec">
              <span>
                <strong>{data.ambiguous.length + data.possible.length} name{data.ambiguous.length + data.possible.length === 1 ? '' : 's'} could not be matched safely, so no vendor gets them:</strong>
                <ul className="vag-list">
                  {[...data.ambiguous.map((r) => ({ ...r, kind: 'fits more than one vendor' })), ...data.possible.map((r) => ({ ...r, kind: 'only partly like this vendor' }))].slice(0, 40).map((r) => (
                    <li key={`${r.assetId}-${r.source}-${r.kind}`}><strong>{r.assetCode}</strong> {r.name} &ndash; {r.source} &ldquo;{r.text}&rdquo; ({r.kind}{r.candidates && r.candidates.length ? `: ${r.candidates.join(', ')}` : ''})</li>
                  ))}
                </ul>
                To give one to this vendor, tick it above, or link it in the &ldquo;Link assets to vendors&rdquo; tab.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

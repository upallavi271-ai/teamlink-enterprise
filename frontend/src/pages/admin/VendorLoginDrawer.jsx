import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import VendorCombobox from '../../components/VendorCombobox.jsx';
import { VendorForm } from './VendorManagement.jsx';
import VendorAssetGrants from './VendorAssetGrants.jsx';
import './vendorLoginDrawer.css';

// ---------------------------------------------------------------------------
// ADD / EDIT VENDOR LOGIN drawer (2026-10-14). Replaces the old LoginModal in VendorLogins.jsx.
//   Unchanged: Contact name, Email / username, Status, the secure-link flow, "Also email the link", Cancel, Create login.
//   New:       the Vendor field is a searchable combobox fed by the Vendor Master (loading / error + Retry / empty state
//              with "+ Add Vendor"); the category of the picked vendor decides which MODULES are pre-ticked
//              (config/vendorModules.js, served by GET /vendor-logins/vendor-picker); a permission section shows only
//              for a ticked module; the Assets block exists only when Assets is ticked.
//   Keyboard:  Esc closes (asks first when something was typed) - focus is trapped - focus starts on the Vendor field and
//              goes back to the button that opened it - Enter in a text field submits - chips are a radio group
//              (Tab to it, arrows / Space to change) - checkboxes toggle with Space.
// ---------------------------------------------------------------------------
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function RadioChips({ label, value, options, onChange }) {
  const refs = useRef([]);
  function key(e, i) {
    const n = options.length;
    let to = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + n) % n;
    if (to === null) return;
    e.preventDefault();
    onChange(options[to].value);
    refs.current[to]?.focus();
  }
  return (
    <div className="vp-choice" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          type="button" key={o.value} role="radio" aria-checked={value === o.value} tabIndex={value === o.value ? 0 : -1}
          ref={(el) => { refs.current[i] = el; }}
          className={`vp-chip${value === o.value ? ' on' : ''}`} onClick={() => onChange(o.value)} onKeyDown={(e) => key(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tick({ id, checked, onChange, label, hint, disabled }) {
  return (
    <label className="vl-switch" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><strong>{label}</strong>{hint && <><br /><span className="cell-muted">{hint}</span></>}</span>
    </label>
  );
}

export default function VendorLoginDrawer({ row, assetsOnly, opts, onClose, onSaved }) {
  const isNew = !row;
  const dialogRef = useRef(null);
  const vendorRef = useRef(null);
  const nameRef = useRef(null);
  const trigger = useRef(typeof document !== 'undefined' ? document.activeElement : null);

  const [v, setV] = useState({
    vendorId: row?.vendorId || '', name: row?.name || '', email: row?.email || '', status: row?.status || 'Active',
  });
  // One key per opening of this window: a double click on Create login (or a repeated request) is ONE login and ONE welcome email.
  const idemKey = useRef(window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
  const initial = useRef(null);
  const [pick, setPick] = useState({ loading: true, error: '', vendors: [], registry: opts?.registry || null, total: 0, ready: true });
  const [added, setAdded] = useState(null); // a vendor created from the drawer, until the list is reloaded
  const [mods, setMods] = useState(() => new Set(row?.modules || []));
  const [perms, setPerms] = useState(() => ({ ...(row?.modulePermissions || {}) }));
  const [modsTouched, setModsTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const autoFill = useRef({ name: '', email: '' });

  // ---- the vendor list: fetched when the drawer opens ---------------------------------
  const loadVendors = useCallback(() => {
    setPick((p) => ({ ...p, loading: true, error: '' }));
    return api.get('/vendor-logins/vendor-picker')
      .then((r) => { setPick({ loading: false, error: '', vendors: r.data.vendors, registry: r.data.registry, total: r.data.totalVendors, ready: r.data.modulesReady !== false }); return r.data; })
      .catch((e) => { setPick((p) => ({ ...p, loading: false, error: errText(e, 'Could not load the vendors.') })); return null; });
  }, []);
  useEffect(() => { loadVendors(); }, [loadVendors]);

  const registry = pick.registry || opts?.registry;
  const regMods = registry?.modules || [];
  const vendorOptions = useMemo(() => {
    const list = pick.vendors.map((x) => ({ id: x.id, name: x.name, category: x.category || '', disabled: x.hasLogin, note: 'Login exists' }));
    if (added && !list.some((o) => o.id === added.id)) list.push({ id: added.id, name: added.name, category: added.category || '', disabled: false });
    return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [pick.vendors, added]);
  const vendor = useMemo(() => {
    const x = pick.vendors.find((p) => p.id === v.vendorId) || (added && added.id === v.vendorId ? added : null);
    if (x) return x;
    if (row) return { id: row.vendorId, name: row.vendorName, category: '' };
    return null;
  }, [pick.vendors, added, v.vendorId, row]);
  const categoryOf = (x) => (x && x.categoryKey) || registry?.defaultCategory || 'other';

  const defaultsFor = useCallback((key) => regMods.find((m) => m.key === key)?.permissions.reduce((o, p) => ({ ...o, [p.key]: p.default }), {}) || {}, [regMods]);
  function applyCategory(x) {
    const cat = (registry?.categories || []).find((c) => c.key === categoryOf(x));
    const keys = new Set(cat ? cat.modules : []);
    const p = {};
    keys.forEach((k) => { p[k] = defaultsFor(k); });
    setMods(keys); setPerms(p); setModsTouched(false);
  }

  // Focus: the Vendor field first (new login) or Contact name (edit); focus goes back to the opener on close.
  useEffect(() => {
    const t = setTimeout(() => { (isNew ? vendorRef.current : nameRef.current)?.focus(); }, 30);
    return () => {
      clearTimeout(t);
      const el = trigger.current && document.contains(trigger.current) ? trigger.current : document.getElementById('vl-add-login-btn');
      if (el && el.focus) setTimeout(() => el.focus(), 0);
    };
  }, [isNew]);

  // What the drawer looked like when it opened (to know whether anything was typed). The row from the server already
  // carries every module's ticks merged with the defaults.
  useEffect(() => {
    if (!registry || initial.current) return;
    initial.current = JSON.stringify({ v, m: [...mods].sort(), p: perms });
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = () => initial.current !== JSON.stringify({ v, m: [...mods].sort(), p: perms });
  const tryClose = useCallback(() => {
    if (busy) return;
    if (dirty() && !window.confirm('Close without saving? What you typed will be lost.')) return;
    onClose();
  }, [busy, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes; Tab stays inside the drawer.
  function onKeyDown(e) {
    if (addOpen) return;
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); tryClose(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // Esc on the layered "Add vendor" form closes only that form.
  useEffect(() => {
    if (!addOpen) return undefined;
    const h = (e) => { if (e.key === 'Escape') { e.preventDefault(); setAddOpen(false); setTimeout(() => vendorRef.current?.focus(), 30); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [addOpen]);

  // ---- picking a vendor -----------------------------------------------------------------
  function pickVendor(o, fullOverride) {
    const full = fullOverride || pick.vendors.find((p) => p.id === o.id) || (added && added.id === o.id ? added : null) || o;
    const changed = v.vendorId !== o.id;
    setV((cur) => ({
      ...cur, vendorId: o.id,
      name: !cur.name || cur.name === autoFill.current.name ? (full.contactPerson || cur.name) : cur.name,
      email: !cur.email || cur.email === autoFill.current.email ? (full.email || cur.email) : cur.email,
    }));
    autoFill.current = { name: full.contactPerson || autoFill.current.name, email: full.email || autoFill.current.email };
    if (changed) {
      let ok = true;
      if (modsTouched && !window.confirm(`Use the usual modules for ${full.category || 'this vendor'}? The ticks you changed will be replaced.`)) ok = false;
      if (ok) applyCategory(full);
    }
    setTimeout(() => nameRef.current?.focus(), 0);
  }
  function clearVendor() {
    setV((cur) => ({ ...cur, vendorId: '' })); setMods(new Set()); setPerms({}); setModsTouched(false);
  }

  // ---- modules and permissions -----------------------------------------------------------
  function toggleModule(key, on) {
    setModsTouched(true);
    setMods((cur) => { const n = new Set(cur); if (on) n.add(key); else n.delete(key); return n; });
    if (on) setPerms((p) => ({ ...p, [key]: { ...defaultsFor(key), ...(p[key] || {}) } }));
  }
  const setPerm = (key, perm, on) => { setModsTouched(true); setPerms((p) => ({ ...p, [key]: { ...(p[key] || {}), [perm]: on } })); };

  const hasAssets = mods.has('assets');

  async function save(e) {
    if (e) e.preventDefault();
    if (busy) return;
    setError('');
    if (!v.vendorId) { setError('Pick the vendor.'); vendorRef.current?.focus(); return; }
    if (!assetsOnly) {
      if (!v.name.trim()) { setError('Enter the contact name.'); nameRef.current?.focus(); return; }
      if (!v.email.trim()) { setError('Enter the email.'); document.getElementById('vldE')?.focus(); return; }
    }
    if (!mods.size) { setError('Tick at least one module for this vendor.'); return; }
    setBusy(true);
    const modules = [...mods];
    const permissions = Object.fromEntries(modules.map((k) => [k, { ...defaultsFor(k), ...(perms[k] || {}) }]));
    const body = {
      ...(assetsOnly ? {} : { vendorId: v.vendorId, name: v.name, email: v.email, status: v.status }),
      modules, permissions,
      // Assets not ticked: no asset scope and no asset permissions are sent at all.
      ...(isNew ? { invite: true } : {}),
    };
    try {
      const res = isNew ? await api.post('/vendor-logins', body, { headers: { 'Idempotency-Key': idemKey.current } }) : await api.patch(`/vendor-logins/${row.id}`, body, { headers: { 'Idempotency-Key': idemKey.current } });
      initial.current = null;
      onSaved(res.data);
    } catch (err) { setError(errText(err, 'Could not save.')); setBusy(false); }
  }

  const title = isNew ? 'Add vendor login' : (assetsOnly ? `Assets · ${row.email}` : `Edit · ${row.email}`);
  const noVendorsAtAll = !pick.loading && !pick.error && pick.total === 0;
  const catLabel = vendor?.category || '';

  return (
    <>
      <div className="overlay show" onMouseDown={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
        <form
          className="modal wide vl-drawer" role="dialog" aria-modal="true" aria-labelledby="vldTitle" ref={dialogRef}
          onKeyDown={onKeyDown} onSubmit={save} noValidate
        >
          <div className="modal-head">
            <h3 id="vldTitle" style={{ fontSize: 15 }}>{title}</h3>
            <button type="button" className="close-x" aria-label="Close" onClick={tryClose}>×</button>
          </div>
          <div className="modal-body">
            <div className="vp-form vl-form">
              {!assetsOnly && (
                <>
                  <div className="vp-two">
                    <div>
                      <label htmlFor="vldV">Vendor</label>
                      <VendorCombobox
                        ref={vendorRef} id="vldV" value={v.vendorId} options={vendorOptions} loading={pick.loading && isNew} error={isNew ? pick.error : ''}
                        disabled={!isNew} selectedLabel={row?.vendorName} describedBy="vldVhint"
                        onRetry={loadVendors} onSelect={pickVendor} onClear={clearVendor} onAddNew={() => setAddOpen(true)}
                      />
                      <div id="vldVhint" className="cell-muted" aria-live="polite">
                        {isNew && !pick.loading && !pick.error && noVendorsAtAll && 'No vendors in the Vendor Master yet. Press the list, then “+ Add Vendor”.'}
                        {isNew && !pick.loading && !pick.error && !noVendorsAtAll && !pick.vendors.length && 'No active vendors. Switch one on in Vendors, or press the list and “+ Add Vendor”.'}
                        {isNew && !pick.loading && !pick.error && !!pick.vendors.length && pick.vendors.every((x) => x.hasLogin) && 'Every active vendor already has a login. Use “+ Add Vendor” for a new one.'}
                      </div>
                    </div>
                    <div>
                      <label htmlFor="vldN">Contact name</label>
                      <input id="vldN" ref={nameRef} value={v.name} maxLength={120} placeholder={vendor?.contactPerson || ''} onChange={(e) => setV({ ...v, name: e.target.value })} />
                    </div>
                  </div>
                  <div className="vp-two">
                    <div>
                      <label htmlFor="vldE">Login email (the invitation goes here)</label>
                      <input id="vldE" type="email" value={v.email} placeholder={vendor?.email || ''} onChange={(e) => setV({ ...v, email: e.target.value })} />
                    </div>
                    <div>
                      <div className="vp-lbl" id="vldSt">Status</div>
                      <RadioChips label="Status" value={v.status} onChange={(x) => setV({ ...v, status: x })} options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Switched off' }]} />
                    </div>
                  </div>
                  {isNew && (
                    <>
                      <div className="vp-lbl">How do they get in?</div>
                      <div className="small-muted">When you press Create login, TeamLink saves the login and <b>emails the vendor</b> (to the login email above): their login ID, a <b>temporary password</b> and a <b>secure link</b> to choose their own password. The temporary password and the link run out in 3 days. You never see or copy a password or a link. If the email cannot be sent, the login is kept and you can press Retry sending later.</div>
                    </>
                  )}
                  {!isNew && row && (
                    <div className="small-muted">{row.activated ? 'Changing the email of an active vendor asks the NEW address to confirm first; the old email keeps working until then.' : 'This vendor has not activated yet: changing the email moves the same login to the new address and sends a new invitation there.'}</div>
                  )}
                  <div className="notice blue" style={{ marginTop: 8 }}><span>The Vendor Portal shows every vendor exactly four things: Dashboard, Invoices, Payments and Purchase Orders. The ticks below do not add other pages for the vendor.</span></div>
                </>
              )}

              {/* ---- modules: only after the vendor is picked ---- */}
              {!v.vendorId ? (
                <div className="vp-none" style={{ marginTop: 10 }}>Pick the vendor first.</div>
              ) : !registry ? (
                <div className="vp-none" style={{ marginTop: 10 }}>Loading the modules...</div>
              ) : (
                <>
                  {!assetsOnly && (
                    <fieldset className="vld-mods">
                      <legend>Modules this vendor will see</legend>
                      <div className="small-muted">
                        {catLabel ? <>Vendor category: <b>{catLabel}</b>. </> : <>This vendor has no category yet, so the “{(registry.categories.find((c) => c.key === registry.defaultCategory) || {}).label}” modules are used. </>}
                        {isNew && 'The usual modules are ticked for you. Tick or untick any before you create the login.'}
                      </div>
                      {pick.ready === false && <div className="notice amber" style={{ marginTop: 6 }}><span>The vendor modules are not switched on in the database yet, so a login with modules cannot be saved here until that update is applied.</span></div>}
                      <div className="vld-modgrid">
                        {regMods.map((m) => (
                          <Tick key={m.key} id={`vldM-${m.key}`} checked={mods.has(m.key)} onChange={(x) => toggleModule(m.key, x)} label={`${m.icon} ${m.label}`} />
                        ))}
                      </div>
                    </fieldset>
                  )}

                  {regMods.filter((m) => mods.has(m.key)).map((m) => (m.assetScope ? (
                    <fieldset className="vld-sec" key={m.key}>
                      <legend>{m.label}</legend>
                      {isNew ? (
                        <div className="small-muted">Which assets this vendor can see is chosen after the login is created: press Edit on the login, then tick the categories or assets.</div>
                      ) : (
                        <>
                          <div className="vp-lbl" id="vldAs">Assets this vendor can see</div>
                          <div className="small-muted">These are the company&apos;s own assets from the asset list. Nothing is copied. The vendor sees only what is chosen here, bought from or repaired by them, or linked to them.</div>
                          <VendorAssetGrants vendorId={v.vendorId} vendorName={vendor?.name} />
                        </>
                      )}
                      {!assetsOnly && m.permissions.map((p) => (
                        <Tick key={p.key} id={`vldP-${m.key}-${p.key}`} checked={!!(perms[m.key] || {})[p.key]} onChange={(x) => setPerm(m.key, p.key, x)} label={p.label} hint={p.hint} />
                      ))}
                    </fieldset>
                  ) : (!assetsOnly && (
                    <fieldset className="vld-sec" key={m.key}>
                      <legend>{m.label}</legend>
                      {m.permissions.map((p) => (
                        <Tick key={p.key} id={`vldP-${m.key}-${p.key}`} checked={(perms[m.key] || {})[p.key] !== undefined ? !!perms[m.key][p.key] : p.default} onChange={(x) => setPerm(m.key, p.key, x)} label={p.label} hint={p.hint} />
                      ))}
                    </fieldset>
                  ))))}
                  {!mods.size && <div className="vp-none" style={{ marginTop: 8 }}>No module is ticked. Tick at least one.</div>}
                </>
              )}

              <div className="error-text" role="alert" aria-live="assertive" style={{ marginTop: 8 }}>{error}</div>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={tryClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : (isNew ? 'Create login' : 'Save')}</button>
          </div>
        </form>
      </div>

      {addOpen && (
        <VendorForm
          row={null} requireCategory registry={registry}
          onClose={() => { setAddOpen(false); setTimeout(() => vendorRef.current?.focus(), 30); }}
          onSaved={async (msg, newVendor) => {
            setAddOpen(false);
            if (newVendor) {
              const fresh = await loadVendors();
              const found = fresh?.vendors.find((x) => x.id === newVendor.id);
              const full = found || newVendor;
              if (!found) setAdded(full);
              pickVendor({ id: newVendor.id, name: newVendor.name, category: newVendor.category || '' }, full);
            }
          }}
        />
      )}
    </>
  );
}

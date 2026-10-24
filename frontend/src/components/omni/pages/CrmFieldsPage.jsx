import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Combo from '../../Combo.jsx';
import { Btn, GsModal, ConfirmModal, Banner } from '../ui.jsx';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { TYPE_ICONS, TYPE_WORDS, isDropdown, usDate, errText, TW_PALETTE, TW_SHADES, findShade } from '../crm/crmUtil.js';
import '../crm/crm.css';

// ---------------------------------------------------------------------------
// CRM FIELDS ("Custom Fields" in the prototype): the data points kept about every customer. Real data: GET/POST/PUT/DELETE /api/outreach/gs/crm/fields.
// The fields made here appear in the Add / Edit customer box, the file import mapping, the Web Forms picker, Segment rules and the column filters of All Customers.
// Only an Admin may change them (everybody who opens the page can read the list).
// ---------------------------------------------------------------------------
const slugOf = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

function Palette({ anchor, value, onPick, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    const row = anchor.current && anchor.current.getBoundingClientRect();
    const modal = anchor.current && anchor.current.closest('.modal') && anchor.current.closest('.modal').getBoundingClientRect();
    if (!row || !modal) return;
    const W = 308; const GAP = 16; const vw = window.innerWidth; const vh = window.innerHeight;
    const left = modal.left - GAP - W >= 8 ? modal.left - GAP - W : (modal.right + GAP + W <= vw - 8 ? modal.right + GAP : Math.max(8, (vw - W) / 2));
    const h = Math.min(330, vh - 32);
    setPos({ left: Math.round(left), top: Math.round(Math.max(12, Math.min(vh - h - 12, row.top - 70))) });
  }, [anchor]);
  useEffect(() => {
    const sel = ref.current && ref.current.querySelector('.cf-sw.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'center' });
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !(anchor.current && anchor.current.contains(e.target))) onClose(); };
    // Esc closes the palette first and leaves the modal open for a second Esc
    const key = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); } };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [anchor, onClose]);
  const root = document.querySelector('.gsx') || document.body;
  return createPortal(
    <div className="cf-palette show" ref={ref} style={{ left: pos.left, top: pos.top, right: 'auto' }} role="dialog" aria-label="Select a shade">
      <div className="cf-palette-head">Select a shade</div>
      <div>
        {TW_PALETTE.map(([name, shades]) => (
          <div className="cf-fam" key={name}>
            <div className="cf-fam-name">{name}</div>
            <div className="cf-fam-swatches">
              {shades.map((c, i) => <button type="button" key={c + i} className={`cf-sw${c === value ? ' sel' : ''}`} style={{ background: c }} title={`${name}-${TW_SHADES[i]} · ${c}`} aria-label={`${name} ${TW_SHADES[i]}`} onClick={() => onPick(c)} />)}
            </div>
          </div>
        ))}
      </div>
    </div>, root);
}

function FieldModal({ field, types, onClose, onSaved, toast }) {
  const editing = !!field;
  const [label, setLabel] = useState(field ? field.name : '');
  const [color, setColor] = useState(field ? field.color : '#16a34a');
  const [type, setType] = useState(field ? field.type : 'dropdown');
  const [options, setOptions] = useState(field ? [...(field.options || [])] : []);
  const [optInput, setOptInput] = useState('');
  const [desc, setDesc] = useState(field ? field.description || '' : '');
  const [required, setRequired] = useState(field ? !!field.required : false);
  const [pal, setPal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const colorRow = useRef(null);
  const nameRef = useRef(null);
  const optRef = useRef(null);
  useEffect(() => { const t = setTimeout(() => nameRef.current && nameRef.current.focus(), 40); return () => clearTimeout(t); }, []);
  const addOption = () => {
    const v = optInput.trim();
    if (!v) { if (optRef.current) optRef.current.focus(); return; }
    if (options.some((o) => o.toLowerCase() === v.toLowerCase())) { toast(`"${v}" is already an option`); if (optRef.current) optRef.current.select(); return; }
    setOptions([...options, v]); setOptInput('');
    if (optRef.current) optRef.current.focus();
  };
  const save = async () => {
    setErr('');
    if (!label.trim()) { toast('Display label is required'); if (nameRef.current) nameRef.current.focus(); return; }
    if (isDropdown(type) && !options.length) { toast('Add at least one dropdown option'); if (optRef.current) optRef.current.focus(); return; }
    setBusy(true);
    try {
      const body = { name: label.trim(), type, options: isDropdown(type) ? options : [], color, description: desc.trim(), required };
      const r = editing ? await omni.put(`/gs/crm/fields/${field.id}`, body) : await omni.post('/gs/crm/fields', body);
      toast(r.ok || (editing ? `Field "${label.trim()}" updated` : `Field "${label.trim()}" created`));
      onSaved();
    } catch (e) { setErr(errText(e, 'The field could not be saved.')); } finally { setBusy(false); }
  };
  const shade = findShade(color);
  return (
    <GsModal title={editing ? 'Edit Field' : 'Add Field'} width={460} onClose={onClose} bodyStyle={{ maxHeight: '62vh' }}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={save} disabled={busy}>{editing ? 'Update Field' : 'Create Field'}</Btn></>}>
      <div className="cf-field">
        <label htmlFor="cfName">Display Label</label>
        <input id="cfName" ref={nameRef} className="cf-input" placeholder="e.g. Lead Stage" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        {!editing && label.trim() && <small style={{ fontSize: 9, color: 'var(--muted)' }}>Saved as <code>{slugOf(label) || 'field'}</code></small>}
      </div>
      <div className="cf-field" style={{ position: 'relative' }}>
        <label>Field Color</label>
        <div className="cf-color-row" ref={colorRow} tabIndex={0} role="button" aria-haspopup="true" aria-label="Choose field color" onClick={() => setPal(!pal)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPal(!pal); } }}>
          <span className="cf-color-swatch" style={{ background: color }} />
          <span><span className="cf-color-hex">{color.toUpperCase()}</span><div className="cf-color-note">{shade ? `Tailwind ${shade[0]}-${shade[1]}` : 'Selected from Tailwind Palette'}</div></span>
        </div>
        {pal && <Palette anchor={colorRow} value={color} onPick={(c) => { setColor(c); setPal(false); }} onClose={() => setPal(false)} />}
      </div>
      <div className="cf-field">
        <label>Data Type</label>
        <Combo value={type} onChange={(e) => setType(e.target.value)} required>
          {types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </Combo>
        {editing && <div className="cf-warn">Warning: Changing type might affect existing data.</div>}
      </div>
      {isDropdown(type) && (
        <div className="cf-field">
          <div className="cf-options-panel">
            <div className="cf-options-title">Dropdown Options</div>
            <div className="cf-chip-scroll">
              {options.length ? options.map((o, i) => <span className="cf-chip" key={o}>{o}<button type="button" className="cf-chip-x" title="Remove option" aria-label={`Remove ${o}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>×</button></span>) : <div className="cf-chip-empty">No options yet — add your first one below.</div>}
            </div>
            <div className="cf-option-add">
              <input ref={optRef} placeholder="Type option & press Enter" aria-label="New option" value={optInput} maxLength={60} onChange={(e) => setOptInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }} />
              <button type="button" className="cf-add-btn" onClick={addOption}>Add</button>
            </div>
          </div>
        </div>
      )}
      <div className="cf-field">
        <label htmlFor="cfDesc">Description <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(optional)</span></label>
        <textarea id="cfDesc" className="cf-input" placeholder="What is this field used for?" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="cf-field" style={{ marginBottom: 2 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} style={{ width: 15, height: 15, accentColor: 'var(--green)', cursor: 'pointer' }} />
          Mark as required field
        </label>
        {required && <small style={{ fontSize: 9, color: 'var(--muted)' }}>A customer cannot be saved without it (in the Add / Edit box and on a Web Form that asks for it).</small>}
      </div>
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}

export default function CrmFieldsPage() {
  const { toast } = useOmni();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(10);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null); // { field } ; field null = new
  const [del, setDel] = useState(null);
  const load = useCallback(() => omni.get('/gs/crm/fields').then((r) => { setData(r); setErr(''); }).catch((e) => setErr(errText(e, 'The fields could not be loaded.'))), []);
  useEffect(() => { load(); }, [load]);
  const all = data ? data.fields : [];
  const needle = q.toLowerCase().trim();
  const list = all.filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle) || (TYPE_WORDS[f.type] || '').toLowerCase().includes(needle) || (f.options || []).some((o) => o.toLowerCase().includes(needle)));
  const pages = Math.max(1, Math.ceil(list.length / rows));
  const pg = Math.min(page, pages);
  const slice = list.slice((pg - 1) * rows, pg * rows);
  const canEdit = !!(data && data.canEdit);
  const doDelete = async () => {
    const f = del; setDel(null);
    try { await omni.del(`/gs/crm/fields/${f.id}`); toast(`"${f.name}" deleted`); load(); } catch (e) { toast(errText(e, 'The field could not be deleted.')); }
  };
  return (
    <div>
      <div className="cf-page-head">
        <div><h1>Custom Fields</h1><div className="lead">Define data points to collect from users in your Bot Flows.</div></div>
        {canEdit && <button type="button" className="btn primary" onClick={() => setModal({ field: null })}>＋ Add Field</button>}
      </div>
      {err && <Banner tone="error">{err}</Banner>}
      {data && !canEdit && <Banner>Only an Admin can add, change or delete fields. You can see them here and fill them in on a customer.</Banner>}
      <div className="cf-search-wrap">
        <span className="cf-search-ico"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" /><path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>
        <input placeholder="Search fields..." aria-label="Search custom fields" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      <div className="cf-card">
        <div className="table-scroll">
          <table className="cf-table">
            <thead><tr><th>Field Label</th><th>Field Key</th><th>Type</th><th>Last Updated</th><th>Action</th></tr></thead>
            <tbody>
              {!data && !err && <tr><td colSpan={5}><div className="cf-empty">Loading…</div></td></tr>}
              {data && !slice.length && <tr><td colSpan={5}><div className="cf-empty"><div className="cf-empty-ico">⌕</div><b>No fields found</b><div style={{ fontSize: 11 }}>Try a different search, or create a new field.</div></div></td></tr>}
              {slice.map((f) => {
                const sub = isDropdown(f.type) && f.options.length ? `Options: ${f.options.slice(0, 3).join(', ')}${f.options.length > 3 ? '…' : ''}` : (f.description || '');
                return (
                  <tr key={f.id}>
                    <td><span className="cf-label-pill" style={{ background: `${f.color}1a`, color: f.color, border: `1px solid ${f.color}33` }}><span className="cf-label-dot" style={{ background: f.color }} />{f.name}</span></td>
                    <td><code className="cf-key">{f.key}</code></td>
                    <td><div className="cf-type-main"><span className="cf-type-ico" style={{ color: f.color }}>{TYPE_ICONS[f.type] || '🏷'}</span>{TYPE_WORDS[f.type] || f.type}</div>{sub && <div className="cf-type-sub">{sub}</div>}</td>
                    <td className="cf-updated">{usDate(f.updatedAt)}</td>
                    <td>{canEdit ? (
                      <div className="cf-actions">
                        <button type="button" className="cf-icon-btn cf-icon-edit" title="Edit field" aria-label={`Edit ${f.name}`} onClick={() => setModal({ field: f })}>✎</button>
                        <button type="button" className="cf-icon-btn cf-icon-del" title="Delete field" aria-label={`Delete ${f.name}`} onClick={() => setDel(f)}>🗑</button>
                      </div>
                    ) : <span style={{ fontSize: 10, color: 'var(--muted)' }}>{f.required ? 'Required' : ''}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="cf-foot">
          <div className="cf-foot-left">Page {pg} of {pages} &nbsp;•&nbsp; Total {list.length} record{list.length === 1 ? '' : 's'}</div>
          <div className="cf-foot-right">
            <span>Rows per page:</span>
            <select className="cf-rows-select" aria-label="Rows per page" value={rows} onChange={(e) => { setRows(Number(e.target.value)); setPage(1); }}>{[5, 10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <button type="button" className="cf-page-btn" disabled={pg <= 1} onClick={() => setPage(pg - 1)} aria-label="Previous page">‹</button>
            <button type="button" className="cf-page-btn" disabled={pg >= pages} onClick={() => setPage(pg + 1)} aria-label="Next page">›</button>
          </div>
        </div>
      </div>
      {modal && <FieldModal field={modal.field} types={data.types} toast={toast} onClose={() => setModal(null)} onSaved={() => { setModal(null); setPage(1); load(); }} />}
      {del && <ConfirmModal title={`Delete the field "${del.name}"?`} text="This removes it from the customer box, forms and filters that use it. What people already typed stays saved but is no longer shown." yes="Delete field" danger onYes={doDelete} onNo={() => setDel(null)} />}
    </div>
  );
}

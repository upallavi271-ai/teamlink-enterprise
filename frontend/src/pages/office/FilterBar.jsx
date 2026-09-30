// Section 1 — the sticky filter bar: period, category, vendor, search, GST on
// the bill, status, payment mode, and the read-only money chips beside them.
import { useEffect, useRef, useState } from 'react';
import PeriodPicker from './PeriodPicker.jsx';
import MultiSelect from './MultiSelect.jsx';
import { money, currentMonthSel } from './officeUtil';
import { APPROVAL_OPTIONS } from './approval.jsx';

export const BLANK_F = {
  cats: [], vens: [], q: '', gst: 'All', status: 'All', mode: 'All', only: '',
};
export const filtersOn = (f) => f.cats.length > 0 || f.vens.length > 0 || !!f.q.trim()
  || f.gst !== 'All' || f.status !== 'All' || f.mode !== 'All' || !!f.only;

function Sel({ value, onChange, options, label }) {
  return (
    <select className={`oe-sel${value !== 'All' ? ' set' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Chip({
  label, value, title, tone, strong,
}) {
  return (
    <span className={`oe-chip${tone ? ` ${tone}` : ''}${strong ? ' strong' : ''}`} title={title}>
      <span className="oe-chip-l">{label}</span>
      <span className="oe-chip-v">{value}</span>
    </span>
  );
}

// A balance typed in by hand from a portal. Never fetched.
function BalanceChip({
  label, value, portalName, canEdit, onSave,
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const empty = value == null;
  const tip = `Typed in by you from the ${portalName} — NOT fetched. There is no live connection to the ${portalName}; this app cannot read it.`;
  const save = async (val) => {
    setBusy(true); setErr('');
    try { await onSave(val); setOpen(false); } catch (e) { setErr(e.response?.data?.error || 'Could not save'); }
    setBusy(false);
  };
  return (
    <span className="oe-chip-wrap" ref={box}>
      <button
        type="button"
        className={`oe-chip oe-chip-btn${empty ? ' warn' : ''}`}
        title={tip}
        onClick={() => { if (!canEdit) return; setV(empty ? '' : String(value)); setOpen(!open); }}
        disabled={!canEdit && empty}
      >
        <span className="oe-chip-l">{label}</span>
        <span className="oe-chip-v">{empty ? 'not entered — tap to add' : money(value)}</span>
      </button>
      {open && (
        <div className="oe-pop">
          <div className="oe-pop-t">{label}</div>
          <div className="small-muted" style={{ marginBottom: 6 }}>{tip}</div>
          <input type="number" step="0.01" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="₹ as the portal shows it"
            onKeyDown={(e) => { if (e.key === 'Enter' && v !== '') save(v); }} />
          {err && <div className="error-text" style={{ fontSize: 12, marginTop: 4 }}>{err}</div>}
          <div className="oe-pop-a">
            {!empty && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => save('')}>Clear</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || v === ''} onClick={() => save(v)}>Save</button>
          </div>
        </div>
      )}
    </span>
  );
}

export default function FilterBar({
  period, setPeriod, f, setF, data, canManage, onNew, onSaveBalance, compact,
}) {
  const o = data?.options;
  const t = data?.totals;
  const cats = o ? o.categories : [];
  const vens = o ? (f.cats.length ? o.vendors.filter((v) => o.fitVendors.includes(v.name)) : o.vendors) : [];
  const set = (patch) => setF({ ...f, ...patch });
  // The page opens on the current month (spec A), so that is what Reset goes back to.
  const on = filtersOn(f) || period !== currentMonthSel();

  return (
    <div className="oe-bar">
      <div className="oe-bar-row">
        <div className="oe-f"><span>Period</span><PeriodPicker value={period} onChange={setPeriod} /></div>
        {!compact && (
          <>
            <div className="oe-f"><span>Category</span>
              <MultiSelect noun="categories" options={cats} value={f.cats} allCount={cats.length}
                onChange={(v) => set({ cats: v })} />
            </div>
            <div className="oe-f"><span>Vendor</span>
              <MultiSelect noun="vendors" options={vens} value={f.vens} allCount={vens.length}
                onChange={(v) => set({ vens: v })} />
            </div>
            <label className="oe-f oe-f-grow"><span>Search</span>
              <input type="search" value={f.q} placeholder="Vendor, description, bill no, remarks..." onChange={(e) => set({ q: e.target.value })} />
            </label>
            <label className="oe-f"><span>GST on the bill</span>
              <Sel label="GST on the bill" value={f.gst} onChange={(v) => set({ gst: v })} options={['All', 'Yes', 'No']} />
            </label>
            <label className="oe-f"><span>Status</span>
              {/* The approval status (spec A): Pending → Approved → Paid, or Rejected. */}
              <select className={`oe-sel${f.status !== 'All' ? ' set' : ''}`} value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
                {APPROVAL_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </>
        )}
        {compact && <div className="small-muted oe-compact-note">The period applies here; category, vendor and the other filters apply to the Expenses tab.</div>}
      </div>
      {!compact && (
        <div className="oe-bar-row oe-bar-row2">
          <label className="oe-f"><span>Payment mode</span>
            <Sel label="Payment mode" value={f.mode} onChange={(v) => set({ mode: v })} options={['All', ...((o && o.modes) || ['Cash', 'Bank Transfer', 'UPI', 'Cheque'])]} />
          </label>
          <div className="oe-chips">
            <Chip label="Before GST" value={money(t?.base)} title="Sum of the bill amounts before GST, for the bills matching these filters" />
            <Chip label="GST paid" value={money(t?.gst)} title="GST we paid our vendors on these bills" />
            <Chip label="After GST" value={money(t?.afterGst)} title="After GST = Before GST + GST" />
            <Chip label="TDS we cut" value={money(t?.tds)} title="TDS we held back from the vendor and pay to Government on their behalf" />
            <Chip strong label="Total amount" value={money(t?.net)} title="Total = After GST − TDS: what is actually paid to the vendors (Before GST + GST − TDS)" />
            <Chip label="Our GSTIN" value={data?.ourGstin || 'not set'} tone={data?.ourGstin ? (data.ourGstinValid ? '' : 'bad') : 'warn'} title={data?.ourGstin ? (data.ourGstinValid ? 'From Business Details — checksum valid' : 'From Business Details — this GSTIN fails the checksum') : 'Add it under Business & portals → Business Details'} />
            <BalanceChip label="In the GST portal" value={data?.portalBalances?.gst} portalName="GST portal" canEdit={canManage} onSave={(v) => onSaveBalance({ gst: v })} />
            <BalanceChip label="In TRACES" value={data?.portalBalances?.traces} portalName="TRACES portal" canEdit={canManage} onSave={(v) => onSaveBalance({ traces: v })} />
            <Chip label="Pending" value={money(t?.pending)} tone={t && t.pending > 0.5 ? 'warn' : ''} title="Sum of the Total on every bill still Pending" />
          </div>
          <div className="oe-bar-actions">
            <button type="button" className="btn btn-sm" disabled={!on} onClick={() => { setF(BLANK_F); setPeriod(currentMonthSel()); }}>Reset all</button>
            {canManage && <button type="button" className="btn btn-sm btn-gold" onClick={onNew}>+ Add Expense</button>}
          </div>
        </div>
      )}
    </div>
  );
}

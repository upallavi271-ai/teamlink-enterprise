// THE FILTERS BAR + SUMMARY CARDS of Office & Accounts (Accounts spec S1.3;
// Office spec P1, 2026-10-05: the bar holds filters only, every figure is a card).
//
// One set of filters for the whole page — Period (the shared Accounts period
// picker), Search, Category, Vendor, GST on the bill, Status and Payment mode.
// They drive the Expenses & Bills table, these chips and the GST position; the
// API applies the very same tests to all three (routes/office.js
// ledgerFilter()), so the chips always equal the table's TOTAL row.
// Options are counted on the server against the other filters (the cascading
// filter rule) and options with no rows are hidden.
import { useEffect, useRef, useState } from 'react';
import PeriodPicker, { ALL_TIME, isAllTime, periodText } from '../../components/accounts/PeriodPicker.jsx';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { money } from './officeUtil';
import './officefilters.css';

export const OFFICE_BLANK = {
  q: '', category: '', vendor: '', gst: '', status: '', mode: '', source: '',
};
export const officeFiltersOn = (f, pv) => !isAllTime(pv) || Object.keys(OFFICE_BLANK).some((k) => String(f[k] || '').trim());

// The API params for the page filters (ledger + overview read the same names).
export function officeParams(f, pv) {
  const v = (x) => (String(x || '').trim() ? String(x).trim() : undefined);
  return {
    q: v(f.q),
    category: v(f.category),
    vendor: v(f.vendor),
    gst: v(f.gst),
    status: v(f.status),
    mode: v(f.mode),
    source: v(f.source),
    from: isAllTime(pv) ? undefined : pv.from,
    to: isAllTime(pv) ? undefined : pv.to,
  };
}

const opts = (list, labelOf) => (list || []).map((o) => ({ value: o.value, label: labelOf ? labelOf(o) : (o.label || o.value), count: o.n }));

export function OfficeFilterBar({
  f, setF, pv, setPv, facets,
}) {
  const set = (patch) => setF({ ...f, ...patch });
  const fc = facets || {};
  const labelOf = (key, val) => ((fc[key] || []).find((o) => o.value === val) || {}).label || val;
  const chips = [
    !isAllTime(pv) && { key: 'period', label: 'Period', value: periodText(pv), onRemove: () => setPv(ALL_TIME) },
    f.q.trim() && { key: 'q', label: 'Search', value: f.q.trim(), onRemove: () => set({ q: '' }) },
    f.category && { key: 'category', label: 'Category', value: f.category, onRemove: () => set({ category: '' }) },
    f.vendor && { key: 'vendor', label: 'Vendor', value: f.vendor, onRemove: () => set({ vendor: '' }) },
    f.gst && { key: 'gst', label: 'GST on the bill', value: labelOf('gst', f.gst), onRemove: () => set({ gst: '' }) },
    f.status && { key: 'status', label: 'Status', value: labelOf('status', f.status), onRemove: () => set({ status: '' }) },
    f.mode && { key: 'mode', label: 'Payment mode', value: f.mode, onRemove: () => set({ mode: '' }) },
    f.source && { key: 'source', label: 'Source', value: labelOf('source', f.source), onRemove: () => set({ source: '' }) },
  ].filter(Boolean);
  const on = chips.length > 0;
  const clearAll = () => { setF(OFFICE_BLANK); setPv(ALL_TIME); };
  return (
    <div className="ofb" role="search" aria-label="Filters for the whole page">
      <div className="ofb-grid">
        <div className="ofb-period"><PeriodPicker value={pv} onChange={setPv} /></div>
        <FacetSelect label="Category" allLabel="All categories" value={f.category} onChange={(v) => set({ category: v })} options={opts(fc.category)} loading={!facets} />
        <FacetSelect label="Vendor" allLabel="All vendors" value={f.vendor} onChange={(v) => set({ vendor: v })} options={opts(fc.vendor)} loading={!facets} />
        <label className="lph-facet ofb-q">
          <span className="lph-facet-lbl">Search</span>
          <input type="search" value={f.q} placeholder="Expense ID, bill no, vendor, category…" onChange={(e) => set({ q: e.target.value })} />
        </label>
        <FacetSelect label="GST on the bill" allLabel="All bills" value={f.gst} onChange={(v) => set({ gst: v })} options={opts(fc.gst)} loading={!facets}
          title="With GST · Without GST · Vendor GSTIN missing (GST on the bill, no valid vendor GSTIN) · Vendor GSTIN available" />
        <FacetSelect label="Status" allLabel="All" value={f.status} onChange={(v) => set({ status: v })} options={opts(fc.status)} loading={!facets} />
        <FacetSelect label="Payment mode" allLabel="All payment modes" value={f.mode} onChange={(v) => set({ mode: v })} options={opts(fc.mode)} loading={!facets} />
        <FacetSelect label="Source" allLabel="All sources" value={f.source} onChange={(v) => set({ source: v })} options={opts(fc.source)} loading={!facets} />
      </div>
      <FilterChips filters={chips} onClearAll={on ? clearAll : undefined} />
    </div>
  );
}

// THE SUMMARY CARDS (Office spec P1.2, 2026-10-05) — every figure of the top
// area, once, in one grid of equal cards. The numbers are the server's, as
// they were on the old chips: `kpi` is ledgerTotals() of the bills matching
// the page filters (= the table's TOTAL row), `recon` is officeFacts() of the
// same bills (its invoice side follows the period), and `balances` are the two
// portal balances typed in by hand for the period (GET /portals).
// A card that stands for a set of bills opens it in the table.
function BalanceCard({
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
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const empty = value == null;
  const tip = `Typed in by you from the ${portalName}, for this period. Nothing is fetched: this app has no connection to the ${portalName}.`;
  const save = async (val) => {
    setBusy(true); setErr('');
    try { await onSave(val); setOpen(false); } catch (e) { setErr(e.response?.data?.error || 'Could not save. Try again.'); }
    setBusy(false);
  };
  return (
    <div className="ofk-wrap" ref={box} role="listitem">
      <button
        type="button"
        className={`ofk-i ofk-go${empty ? ' ofk-empty' : ''}`}
        title={tip}
        onClick={() => { if (!canEdit) return; setV(empty ? '' : String(value)); setOpen(!open); }}
        disabled={!canEdit && empty}
        aria-expanded={canEdit ? open : undefined}
      >
        <span className="ofk-l">{label}</span>
        <span className="ofk-v">{empty ? 'Not entered' : money(value)}</span>
        <span className="ofk-s">{empty ? (canEdit ? 'Tap to add' : 'Not entered yet') : (canEdit ? 'Tap to change' : 'Typed in by hand')}</span>
      </button>
      {open && (
        <div className="ofk-pop" role="dialog" aria-label={label}>
          <div className="ofk-pop-t">{label}</div>
          <input type="number" step="0.01" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="₹ as the portal shows it"
            onKeyDown={(e) => { if (e.key === 'Enter' && v !== '') save(v); }} aria-label={`${label} in rupees`} />
          {err && <div className="error-text" style={{ fontSize: 12, marginTop: 4 }}>{err}</div>}
          <div className="ofk-pop-a">
            {!empty && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => save('')}>Clear</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || v === ''} onClick={() => save(v)}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function OfficeCards({
  kpi, recon, balances, canManage, onSaveBalance, f, setF, onJump,
}) {
  if (!kpi || !recon) return <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>;
  const n = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const show = (patch) => { setF({ ...f, ...patch }); if (onJump) onJump(); };
  const o = recon.outward; const p = recon.position;
  const credit = p.payable < 0;
  const items = [
    { k: 'count', l: 'Entries', v: kpi.count.toLocaleString('en-IN'), s: kpi.count ? `${kpi.withGstCount} with GST` : 'No bills in this view' },
    {
      k: 'total', l: 'Total amount', v: money(kpi.total), tone: 'navy',
      s: `before GST ${money(kpi.before)} · GST ${money(kpi.gst)} · after GST ${money(kpi.after)}`,
      t: 'Total = after GST − TDS: what the vendors are paid',
    },
    { k: 'paid', l: 'Paid', v: money(kpi.paid), s: n(kpi.paidCount, 'bill'), tone: 'green', go: kpi.paidCount ? () => show({ status: 'PAID' }) : null },
    {
      k: 'pending', l: 'Pending to pay', v: money(kpi.pending), s: kpi.pendingCount ? n(kpi.pendingCount, 'bill') : 'Nothing to pay',
      tone: kpi.pending > 0.5 ? 'orange' : 'green', go: kpi.pendingCount ? () => show({ status: 'PENDING' }) : null,
    },
    {
      k: 'gstin', l: 'GST received from clients', v: money(o.charged), s: `on ${n(o.invoices, 'invoice')}`, tone: 'gold',
      t: 'GST we charged clients on the invoices of this period (from Invoices; only the period filter applies)',
    },
    { k: 'gstout', l: 'GST paid to vendors', v: money(kpi.gst), s: `on ${n(kpi.withGstCount, 'bill')}`, tone: 'gold', go: kpi.withGstCount ? () => show({ gst: 'with' }) : null },
    {
      k: 'payable', l: credit ? 'GST credit carried forward' : 'GST payable to government', v: money(Math.abs(p.payable)), tone: credit ? 'green' : 'red',
      s: `received ${money(o.charged)} − credit we can claim ${money(recon.inward.claimable)}`,
      x: recon.ourGstin ? `Our GSTIN ${recon.ourGstin}${recon.ourState ? ` · ${recon.ourState}` : ''}` : 'Our GSTIN: not set — add it in Business details',
      xBad: !recon.ourGstin,
    },
    { k: 'tds', l: 'TDS we cut', v: money(kpi.tds), s: kpi.tdsCount ? `on ${n(kpi.tdsCount, 'bill')}` : 'No TDS cut', t: 'TDS we held back from vendors and pay to the government for them' },
  ];
  return (
    <div className="ofk ofk-cards" role="list">
      {items.map((x) => {
        const body = (
          <>
            <span className="ofk-l">{x.l}</span>
            <span className="ofk-v">{x.v}</span>
            <span className="ofk-s">{x.s}</span>
            {x.x && <span className={`ofk-x${x.xBad ? ' bad' : ''}`}>{x.x}</span>}
          </>
        );
        return x.go ? (
          <button type="button" key={x.k} role="listitem" className={`ofk-i ofk-go${x.tone ? ` ${x.tone}` : ''}`} onClick={x.go} title={x.t || 'Show these bills in the table'}>{body}</button>
        ) : (
          <div key={x.k} role="listitem" className={`ofk-i${x.tone ? ` ${x.tone}` : ''}`} title={x.t}>{body}</div>
        );
      })}
      <BalanceCard label="In the GST portal" value={balances?.gst ?? null} portalName="GST portal" canEdit={canManage} onSave={(v) => onSaveBalance({ gst: v })} />
      <BalanceCard label="In TRACES" value={balances?.traces ?? null} portalName="TRACES portal" canEdit={canManage} onSave={(v) => onSaveBalance({ traces: v })} />
    </div>
  );
}

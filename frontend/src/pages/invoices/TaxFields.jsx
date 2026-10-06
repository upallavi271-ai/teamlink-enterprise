// ---------------------------------------------------------------------------
// GST & TDS FIELDS (P4) — shared by "+ New join" (create) and "Edit GST / TDS"
// (edit). The accountant only types the amount before GST and picks the
// rates; every amount is worked out here on each change (invoices/invTax.js)
// and again on the server, which refuses an amount that does not match its %.
// ---------------------------------------------------------------------------
import { money2 } from './invFormat';
import {
  calcTax, pct, GST_TYPES, TDS_BASES, TDS_SECTIONS,
} from './invTax';
import './invTax.css';

// The form's starting value from an invoice's tax view (or a joining's defaults).
export function taxFormFrom(t = {}) {
  const gstOn = t.gstType ? t.gstType !== 'NONE' && Number(t.gstPercent) > 0 : Number(t.gstPercent) > 0;
  return {
    gstOn,
    gstType: t.gstType && t.gstType !== 'NONE' ? t.gstType : 'CGST_SGST',
    gstPercent: Number(t.gstPercent) > 0 ? String(t.gstPercent) : '18',
    tdsOn: Number(t.tdsPercent) > 0,
    tdsPercent: Number(t.tdsPercent) > 0 ? String(t.tdsPercent) : '10',
    tdsBase: t.tdsBase === 'gross' ? 'gross' : 'base',
    tdsSection: t.tdsSection || '',
    tdsDeductedOn: t.tdsDeductedOn || '',
  };
}

// The calculation for the form as it stands.
export function taxOfForm(f, base) {
  return calcTax({
    base,
    gstType: f.gstOn ? f.gstType : 'NONE',
    gstPercent: f.gstOn ? f.gstPercent : 0,
    tdsPercent: f.tdsOn ? f.tdsPercent : 0,
    tdsBase: f.tdsBase,
  });
}

// What the API is sent: the choices AND the amounts the screen shows — the
// server recalculates and refuses the save if they ever disagree.
export function taxPayload(f, base) {
  const c = taxOfForm(f, base);
  return {
    amount: c.base,
    gstApplicable: f.gstOn ? 'Yes' : 'No',
    gstType: f.gstOn ? f.gstType : 'NONE',
    gstPercent: c.gstPercent,
    gst: c.gst,
    tdsApplicable: f.tdsOn ? 'Yes' : 'No',
    tdsPercent: c.tdsPercent,
    tdsBase: f.tdsBase,
    tds: c.tds,
    net: c.net,
  };
}

// Plain-words problems with the form, keyed by field.
export function taxFormErrors(f) {
  const e = {};
  const g = Number(f.gstPercent);
  const t = Number(f.tdsPercent);
  if (f.gstOn && !(g > 0 && g <= 100)) e.gstPercent = 'Enter the GST % (more than 0, at most 100).';
  if (f.tdsOn && !(t > 0 && t <= 100)) e.tdsPercent = 'Enter the TDS % (more than 0, at most 100).';
  return e;
}

function Seg({ value, options, onChange, label }) {
  return (
    <div className="invx-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// The calculation in one line: 1,00,000 + 18,000 = 1,18,000 − 10,000 = 1,08,000.
export function CalcLine({ c, received }) {
  return (
    <div className="invx-line" aria-live="polite">
      Before GST <b>{money2(c.base)}</b> + GST <b>{money2(c.gst)}</b> = After GST <b>{money2(c.gross)}</b>
      {' '}− TDS <b>{money2(c.tds)}</b> = Net receivable <b>{money2(c.net)}</b>
      {received > 0 && <> · Received {money2(received)} · Balance <b>{money2(Math.max(0, Math.round((c.net - received) * 100) / 100))}</b></>}
    </div>
  );
}

export default function TaxFields({
  value: f, onChange, base, supplyWhy, errs = {}, details = true, received = 0,
}) {
  const set = (k, v) => onChange({ ...f, [k]: v });
  const c = taxOfForm(f, base);
  return (
    <div className="invx-form">
      <h4>GST</h4>
      <div className="field">
        <span>GST applicable</span>
        <Seg label="GST applicable" value={f.gstOn} onChange={(v) => set('gstOn', v)} options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} />
      </div>
      {f.gstOn && (
        <div className="field">
          <span>GST type</span>
          <Seg label="GST type" value={f.gstType} onChange={(v) => set('gstType', v)} options={GST_TYPES.filter((o) => o.value !== 'NONE')} />
          {supplyWhy && <div className="invx-help">{supplyWhy}</div>}
        </div>
      )}
      {f.gstOn && (
        <label className="field">
          <span>GST %</span>
          <input type="number" min="0" max="100" step="0.01" inputMode="decimal" list="invx-gst-rates" value={f.gstPercent} onChange={(e) => set('gstPercent', e.target.value)} aria-invalid={!!errs.gstPercent} />
          <datalist id="invx-gst-rates">{[5, 12, 18, 28].map((r) => <option key={r} value={r} />)}</datalist>
          {errs.gstPercent && <div className="inv-err">{errs.gstPercent}</div>}
        </label>
      )}
      <div className="field invx-span3">
        <span>GST amount (worked out)</span>
        <div className="invx-help" style={{ fontSize: 13, color: 'var(--ink)' }}>
          {c.gstType === 'NONE' ? 'No GST on this invoice — ₹0.00'
            : c.gstType === 'IGST' ? <>IGST {pct(c.gstPercent)} = <b>{money2(c.igst)}</b></>
              : <>CGST {pct(c.gstPercent / 2)} <b>{money2(c.cgst)}</b> + SGST {pct(c.gstPercent / 2)} <b>{money2(c.sgst)}</b> = <b>{money2(c.gst)}</b></>}
        </div>
      </div>

      <h4>TDS</h4>
      <div className="field">
        <span>TDS applicable</span>
        <Seg label="TDS applicable" value={f.tdsOn} onChange={(v) => set('tdsOn', v)} options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} />
      </div>
      {f.tdsOn && (
        <label className="field">
          <span>TDS %</span>
          <input type="number" min="0" max="100" step="0.01" inputMode="decimal" list="invx-tds-rates" value={f.tdsPercent} onChange={(e) => set('tdsPercent', e.target.value)} aria-invalid={!!errs.tdsPercent} />
          <datalist id="invx-tds-rates">{[1, 2, 5, 10].map((r) => <option key={r} value={r} />)}</datalist>
          {errs.tdsPercent && <div className="inv-err">{errs.tdsPercent}</div>}
        </label>
      )}
      {f.tdsOn && (
        <div className="field">
          <span>TDS worked out on</span>
          <Seg label="TDS worked out on" value={f.tdsBase} onChange={(v) => set('tdsBase', v)} options={TDS_BASES} />
        </div>
      )}
      {f.tdsOn && details && (
        <label className="field">
          <span>TDS section</span>
          <select value={f.tdsSection} onChange={(e) => set('tdsSection', e.target.value)}>
            <option value="">Not set (194J is printed)</option>
            {TDS_SECTIONS.map((s) => <option key={s} value={s}>{s === 'Other' ? 'Other' : `${s}`}</option>)}
          </select>
        </label>
      )}
      {f.tdsOn && details && (
        <label className="field">
          <span>Date the client deducted it (optional)</span>
          <input type="date" value={f.tdsDeductedOn} onChange={(e) => set('tdsDeductedOn', e.target.value)} />
        </label>
      )}
      <div className="field invx-span3">
        <span>TDS amount (worked out)</span>
        <div className="invx-help" style={{ fontSize: 13, color: 'var(--ink)' }}>
          {c.tds > 0 ? <>{pct(c.tdsPercent)} of {money2(c.tdsOn)} ({c.tdsBase === 'gross' ? 'after GST' : 'before GST'}) = <b>{money2(c.tds)}</b></> : 'No TDS — ₹0.00'}
        </div>
      </div>
      <div className="invx-span3"><CalcLine c={c} received={received} /></div>
    </div>
  );
}

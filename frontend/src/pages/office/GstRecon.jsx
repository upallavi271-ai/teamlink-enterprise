// GST RECONCILIATION (v2 §4) — how the Net GST in the Financial Overview is
// reached, worked out from the real invoices and bills (routes/office.js
// officeFacts()). The old OUTWARD / INWARD / THE POSITION figures, "If the
// GSTINs are filled in", the at-risk vendor list with Add GSTIN and "who the
// invoices went to" are all here, as expandable detail.
import { useState } from 'react';
import AddGstin from './AddGstin.jsx';
import { money, money2, fmtD } from './officeUtil';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';

// The invoice list and the purchase list under the reconciliation can run to
// a year of rows, so each carries the list filter standard: search, the few
// filters that fit, a date range, a sort, paging and a helpful empty state.
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
const byDateAsc = (a, b) => String(a.date || '').localeCompare(String(b.date || ''));
const byGst = (a, b) => (Number(b.gst) || 0) - (Number(a.gst) || 0);

const INV_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search invoice no or client…', get: (x) => `${x.invoiceNumber || ''} ${x.client || ''}` },
  { key: 'client', label: 'Client', get: (x) => x.client, primary: true },
  { key: 'date', type: 'daterange', label: 'Date range', get: (x) => x.date, primary: true },
];
const INV_SORTS = [
  { key: 'new', label: 'Newest first', cmp: byDateDesc },
  { key: 'old', label: 'Oldest first', cmp: byDateAsc },
  { key: 'gst', label: 'GST high → low', cmp: byGst },
];
function InvoiceList({ rows }) {
  const lf = useListFilters(rows, INV_FIELDS, { sorts: INV_SORTS });
  const page = usePaged(lf.rows);
  return (
    <>
      <ListFilterBar lf={lf} storageKey="office-gst-invoices" noun="invoices" />
      <div className="tbl-wrap oe-rc-tbl">
        <table>
          <thead><tr><th>Invoice</th><th>Date</th><th>Client</th><th className="num">Taxable value</th><th className="num">GST</th></tr></thead>
          <tbody>
            {page.slice.map((x) => (
              <tr key={x.id}><td className="num">{x.invoiceNumber || '—'}</td><td className="oe-nowrap">{fmtD(x.date)}</td><td>{x.client}</td><td className="num">{money2(x.taxable)}</td><td className="num">{money2(x.gst)}</td></tr>
            ))}
            {lf.rows.length === 0 && <tr><td colSpan={5}><ListEmpty lf={lf} noun="invoices" /></td></tr>}
          </tbody>
        </table>
      </div>
      {lf.rows.length > 25 && <Pager page={page} noun="invoices" />}
    </>
  );
}

const PUR_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search expense ID, vendor, bill no, GSTIN…', get: (x) => `${x.expenseCode || ''} ${x.vendor || ''} ${x.billNo || ''} ${x.gstin || ''} ${x.category || ''}` },
  { key: 'credit', label: 'Credit', allLabel: 'All bills', options: ['Claimable', 'At risk'], get: (x) => (x.claimable ? 'Claimable' : 'At risk'), primary: true },
  { key: 'category', label: 'Category', get: (x) => x.category, primary: true },
  { key: 'date', type: 'daterange', label: 'Date range', get: (x) => x.date, primary: true },
  { key: 'vendor', label: 'Vendor', get: (x) => x.vendor },
  { key: 'rate', label: 'GST rate', allLabel: 'All GST rates', get: (x) => (x.rate ? `${x.rate}%` : '') },
];
const PUR_SORTS = [
  { key: 'new', label: 'Newest first', cmp: byDateDesc },
  { key: 'old', label: 'Oldest first', cmp: byDateAsc },
  { key: 'gst', label: 'GST high → low', cmp: byGst },
  { key: 'vendor', label: 'Vendor A–Z', cmp: (a, b) => String(a.vendor || '').localeCompare(String(b.vendor || '')) },
];
function PurchaseList({ rows }) {
  const lf = useListFilters(rows, PUR_FIELDS, { sorts: PUR_SORTS });
  const page = usePaged(lf.rows);
  return (
    <>
      <ListFilterBar lf={lf} storageKey="office-gst-purchases" noun="bills" />
      <div className="tbl-wrap oe-rc-tbl">
        <table>
          <thead><tr><th>Expense</th><th>Date</th><th>Vendor</th><th>Bill no</th><th className="num">Taxable</th><th className="num">Rate</th><th className="num">GST</th><th>Vendor GSTIN</th><th>Credit</th></tr></thead>
          <tbody>
            {page.slice.map((x) => (
              <tr key={x.id}>
                <td className="num">{x.expenseCode || '—'}</td>
                <td className="oe-nowrap">{fmtD(x.date)}</td>
                <td>{x.vendor || '—'}<div className="small-muted">{x.category}</div></td>
                <td>{x.billNo || '—'}</td>
                <td className="num">{money2(x.base)}</td>
                <td className="num">{x.rate ? `${x.rate}%` : '—'}</td>
                <td className="num">{money2(x.gst)}</td>
                <td className="num">{x.gstin || '—'}</td>
                <td>{x.claimable ? <span className="status priority-low">Claimable</span> : <span className="status priority-high">At risk</span>}</td>
              </tr>
            ))}
            {lf.rows.length === 0 && (
              <tr><td colSpan={9}>{lf.activeCount ? <ListEmpty lf={lf} noun="bills" /> : <div className="empty-mini">No bills with GST in this period.</div>}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {lf.rows.length > 25 && <Pager page={page} noun="bills" />}
    </>
  );
}

function Fold({
  title, sub, open: dflt = false, children,
}) {
  return (
    <details className="oe-rc-d" open={dflt || undefined}>
      <summary><span className="oe-sec-car" aria-hidden="true" />{title}{sub && <span className="small-muted">· {sub}</span>}</summary>
      <div className="oe-rc-in">{children}</div>
    </details>
  );
}

export default function GstRecon({ facts, canManage, onChanged }) {
  const [adding, setAdding] = useState(null);
  if (!facts) return <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>;
  const d = facts.recon;
  const o = d.outward; const i = d.inward; const p = d.position;
  const head = [d.ourGstin || 'GSTIN not set', d.ourCompany, d.ourState].filter(Boolean).join(' · ');
  const top = d.riskVendors.slice(0, 3);
  const more = d.riskVendors.length - top.length;
  const pay = p.payable >= 0;

  return (
    <>
      <div className="oe-rc-eq">
        <span>Client GST collected</span><span className="oe-rc-op">−</span>
        <span>Input GST credit <span className="small-muted">(purchase GST paid, where the vendor GSTIN is on file)</span></span>
        <span className="oe-rc-op">=</span>
        <span>Net GST {pay ? 'payable' : 'receivable'}</span>
        <span className="small-muted">— worked out below from {o.invoices} invoice{o.invoices === 1 ? '' : 's'} and {i.bills} purchase bill{i.bills === 1 ? '' : 's'} with GST · under {head}</span>
      </div>

      {i.atRisk > 0.5 && (
        <div className="notice amber oe-alert" style={{ marginTop: 10, marginBottom: 0 }}>
          <span className="oe-alert-t">
            <b>{money(i.atRisk)}</b> of purchase GST cannot be claimed until the vendor&apos;s GSTIN is on the bill —{' '}
            {top.map((v, ix) => (
              <span key={v.name}>
                {ix > 0 && (ix === top.length - 1 && more <= 0 ? ' and ' : ', ')}
                <b>{v.name}</b> {money(v.gst)}
              </span>
            ))}
            {more > 0 && ` and ${more} more`}. Fill them in and you would pay {money(p.saving)} less.
          </span>
        </div>
      )}

      <Fold title="Reconciliation statement" sub={facts.period.label} open>
        <table className="oe-rc-st">
          <tbody>
            <tr className="h"><td colSpan={2}>Outward — what we billed clients (from Invoices)</td></tr>
            <tr><td>Taxable value · {o.invoices} invoice{o.invoices === 1 ? '' : 's'}</td><td className="num">{money2(o.taxable)}</td></tr>
            <tr><td>GST charged — client GST collected (A)</td><td className="num">{money2(o.charged)}</td></tr>
            <tr><td>Invoice value</td><td className="num">{money2(o.value)}</td></tr>
            <tr className="h"><td colSpan={2}>Inward — what we bought (these bills)</td></tr>
            <tr><td>Purchases with GST · {i.bills} bill{i.bills === 1 ? '' : 's'} (taxable value)</td><td className="num">{money2(i.purchases)}</td></tr>
            <tr><td>Purchase GST paid on them</td><td className="num">{money2(i.gstPaid)}</td></tr>
            <tr><td>Input GST credit you can claim — vendor GSTIN on file, {i.claimableBills} bill{i.claimableBills === 1 ? '' : 's'} (B)</td><td className="num">{money2(i.claimable)}</td></tr>
            <tr><td>At risk — no valid vendor GSTIN, {i.atRiskBills} bill{i.atRiskBills === 1 ? '' : 's'}</td><td className="num" style={{ color: i.atRisk > 0.5 ? 'var(--red)' : undefined }}>{money2(i.atRisk)}</td></tr>
            <tr className="h"><td colSpan={2}>The position</td></tr>
            <tr className="t"><td>Net GST {pay ? 'payable to Government' : 'receivable (credit carried forward)'} = A − B</td><td className="num" style={{ color: pay && p.payable > 0.5 ? 'var(--red)' : 'var(--teal)' }}>{money2(Math.abs(p.payable))}</td></tr>
            <tr><td>If the GSTINs are filled in (A − all purchase GST paid)</td><td className="num">{money2(p.ifFilled)} <span className="small-muted">· {money(p.saving)} less</span></td></tr>
            <tr><td>Total under this GSTIN (billed {money(p.billed)} + bought {money(p.bought)})</td><td className="num">{money2(p.total)}</td></tr>
            <tr><td>Our GSTIN</td><td className="num">{d.ourGstin || 'not set'}{d.ourStateCode ? ` · state code ${d.ourStateCode}` : ''}</td></tr>
          </tbody>
        </table>
      </Fold>

      {d.riskBills.length > 0 && (
        <Fold title="GST at risk, bill by bill" sub={`${d.riskBills.length} bill${d.riskBills.length === 1 ? '' : 's'} — add the vendor's GSTIN and the bill leaves this list`} open>
          {d.riskBills.map((b) => (
            <div key={b.id} className="oe-risk-row">
              <div className="oe-risk-l">
                <b>{b.vendor || 'No vendor named'}</b>
                <div className="small-muted">{b.category} · {fmtD(b.date)}{b.billNo ? ` · ${b.billNo}` : ''}</div>
              </div>
              <div className="oe-risk-r">
                <span className="small-muted">before GST {money(b.base)}</span>
                <b className="oe-risk-gst">GST {money(b.gst)}</b>
                {canManage && adding !== b.id && <button type="button" className="btn btn-sm" onClick={() => setAdding(b.id)}>Add GSTIN</button>}
              </div>
              {adding === b.id && (
                <div className="oe-risk-add">
                  <AddGstin bill={b} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); onChanged(); }} />
                </div>
              )}
            </div>
          ))}
        </Fold>
      )}

      <Fold title="Invoice-level reconciliation" sub={`${o.invoices} invoice${o.invoices === 1 ? '' : 's'}, by client`}>
        <div className="tbl-wrap oe-rc-tbl">
          <table>
            <thead><tr><th>Client</th><th className="num">Invoices</th><th className="num">Taxable value</th><th className="num">GST</th><th className="num">Invoice value</th></tr></thead>
            <tbody>
              {o.clients.map((c) => (
                <tr key={c.name}><td><b>{c.name}</b></td><td className="num">{c.n}</td><td className="num">{money2(c.taxable)}</td><td className="num">{money2(c.gst)}</td><td className="num">{money2(c.value)}</td></tr>
              ))}
              {o.clients.length === 0 && <tr><td colSpan={5} className="empty-mini">No invoices in this period.</td></tr>}
            </tbody>
          </table>
        </div>
        {d.invoices.length > 0 && (
          <details className="oe-portals-more">
            <summary>Every invoice ({d.invoices.length})</summary>
            <div style={{ marginTop: 6 }}><InvoiceList rows={d.invoices} /></div>
          </details>
        )}
      </Fold>

      <Fold title="Purchase-level reconciliation" sub={`${d.purchases.length} bill${d.purchases.length === 1 ? '' : 's'} with GST`}>
        <PurchaseList rows={d.purchases} />
      </Fold>
    </>
  );
}

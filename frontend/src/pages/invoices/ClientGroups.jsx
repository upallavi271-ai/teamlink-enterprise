// The Invoices table, ONE EXPANDABLE GROUP PER CLIENT (Accounts reconciliation spec 9).
//
// Grouped by the client's own id - two different clients that share a name stay two groups
// (told apart by a short id), and one client is never split. The main row says: client,
// invoices, candidates, total invoice amount, paid, outstanding and a status summary.
// Clicking the client name opens, directly below it, that client's INVOICES - one row
// per client invoice (all its candidates in it; invoices/clientInvoice.js), each opening
// its own panel exactly as in "Group by Invoice" (invoices/ClientInvoiceRows.jsx).
//
// Every figure is added from the same invoice rows exactly once, so the group totals
// and the grand total always equal the sum of the rows under them.
import { Fragment, useMemo, useState } from 'react';
import { money2 } from './invFormat';
import ClientInvoiceRows, { CI_HEADS, CI_NUM } from './ClientInvoiceRows.jsx';
import { buildClientInvoices } from './clientInvoice';
import './clientGroups.css';

const sum = (list, f) => Math.round(list.reduce((s, r) => s + (Number(f(r)) || 0), 0) * 100) / 100;
const STATUS_TONE = {
  Paid: 'priority-low', 'Partially Paid': 'priority-medium', Pending: '', Overdue: 'priority-high', Cancelled: '',
};

// Build the groups from the (already filtered) register rows.
export function buildClientGroups(rows, sortKey, index) {
  const map = new Map();
  rows.forEach((r) => {
    const k = r.clientId || `name:${r.client}`;
    if (!map.has(k)) map.set(k, { key: k, clientId: r.clientId || null, client: r.client, list: [] });
    map.get(k).list.push(r);
  });
  const groups = [...map.values()];
  const dup = new Set(groups.map((g) => g.client).filter((n, i, a) => a.indexOf(n) !== i));
  groups.forEach((g) => {
    const live = g.list.filter((r) => r.status !== 'Cancelled');
    g.label = dup.has(g.client) && g.clientId ? `${g.client} (id …${String(g.clientId).slice(-5)})` : g.client;
    g.live = live;
    // The client's invoices: one per client invoice, not one per candidate.
    g.inv = buildClientInvoices(g.list, index);
    g.invoices = g.inv.filter((x) => x.status !== 'Cancelled').length;
    g.candidates = new Set(live.map((r) => r.candidateId || r.candidateName).filter(Boolean)).size;
    g.total = sum(live, (r) => r.receivable);
    g.paid = sum(live, (r) => r.received);
    g.pending = sum(live, (r) => r.pending);
    g.counts = live.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    g.bankMatched = live.filter((r) => r.reconStatus === 'Bank matched').length;
    g.latest = live.map((r) => r.invoiceDate || '').sort().pop() || '';
    g.earliest = live.map((r) => r.invoiceDate || '9999').sort()[0] || '';
  });
  const by = {
    pending: (a, b) => b.pending - a.pending,
    new: (a, b) => String(b.latest).localeCompare(String(a.latest)),
    old: (a, b) => String(a.earliest).localeCompare(String(b.earliest)),
  }[sortKey];
  groups.sort(by || ((a, b) => a.label.localeCompare(b.label)));
  return groups;
}

export default function ClientGroups({
  groups, allRows, rowProps,
}) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (k) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const shownOpen = (k) => open.has(k);
  const live = useMemo(() => allRows.filter((r) => r.status !== 'Cancelled'), [allRows]);
  // The TOTAL row counts every client invoice the filters leave (not only this page's clients).
  const nInvoices = useMemo(() => (rowProps.shown || []).filter((x) => x.status !== 'Cancelled').length, [rowProps.shown]);

  return (
    <div className="cg-wrap">
      <div className="cg-tools">
        <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set(groups.map((g) => g.key)))}>Expand all</button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set())}>Collapse all</button>
        <span className="small-muted">One row per client. Click a client name to see its invoices; click an invoice to see its candidates.</span>
      </div>
      <div className="tbl-wrap">
        <table className="cg-table">
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col" className="num">Invoices</th>
              <th scope="col" className="num">Candidates</th>
              <th scope="col" className="num" title="After GST, less TDS - what the client pays">Total invoice amount</th>
              <th scope="col" className="num">Total paid</th>
              <th scope="col" className="num">Total outstanding</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className={`cg-client${shownOpen(g.key) ? ' is-open' : ''}`}>
                  <td>
                    <button type="button" className="cg-name" aria-expanded={shownOpen(g.key)} onClick={() => toggle(g.key)}>
                      <span aria-hidden="true" className="cg-caret">{shownOpen(g.key) ? '▾' : '▸'}</span> {g.label}
                    </button>
                  </td>
                  <td className="num">{g.invoices}</td>
                  <td className="num">{g.candidates}</td>
                  <td className="num">{money2(g.total)}</td>
                  <td className="num">{money2(g.paid)}</td>
                  <td className="num"><b>{money2(g.pending)}</b></td>
                  <td className="cg-sum">
                    {Object.entries(g.counts).map(([k, n]) => <span key={k} className={`status ${STATUS_TONE[k] || ''}`}>{n} {k}</span>)}
                    {g.live.length > 0 && <span className="small-muted"> · {g.bankMatched} of {g.live.length} candidate line{g.live.length === 1 ? '' : 's'} bank matched</span>}
                  </td>
                  <td>{g.clientId && rowProps.handlers.onAccount && <button type="button" className="btn btn-sm" onClick={() => rowProps.handlers.onAccount(g)}>Account</button>}</td>
                </tr>
                {shownOpen(g.key) && (
                  <tr className="cg-detail">
                    <td colSpan={8}>
                      <div className="tbl-wrap">
                        <table className="cg-inner ci-inner">
                          <thead>
                            <tr>
                              {CI_HEADS.map(([k, l]) => <th key={k} scope="col" className={CI_NUM.has(k) ? 'num' : undefined}>{l}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            <ClientInvoiceRows groups={g.inv} open={rowProps.open} toggle={rowProps.toggle} hot={rowProps.hot} handlers={rowProps.handlers} />
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {groups.length === 0 && <tr><td colSpan={8} className="small-muted" style={{ textAlign: 'center', padding: 24 }}>No invoices match these filters</td></tr>}
          </tbody>
          {live.length > 0 && (
            <tfoot>
              <tr>
                <td><b>TOTAL</b> <span className="small-muted">{nInvoices} invoice(s)</span></td>
                <td className="num">{nInvoices}</td>
                <td className="num">{new Set(live.map((r) => r.candidateName).filter(Boolean)).size}</td>
                <td className="num">{money2(sum(live, (r) => r.receivable))}</td>
                <td className="num">{money2(sum(live, (r) => r.received))}</td>
                <td className="num"><b>{money2(sum(live, (r) => r.pending))}</b></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

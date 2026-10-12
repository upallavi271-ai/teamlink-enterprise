// The Invoices table, ONE EXPANDABLE GROUP PER CLIENT (Accounts reconciliation spec 9).
//
// Grouped by the client's own id - two different clients that share a name stay two groups
// (told apart by a short id), and one client is never split. The main row says: client,
// invoices, candidates, total invoice amount, paid, outstanding and a status summary.
// Clicking the client name opens, directly below it, the candidates and their invoices with
// the invoice / due / actual payment dates, amounts, proof, Bank Line and statuses.
//
// Every figure is added from the same invoice rows exactly once, so the group totals
// and the grand total always equal the sum of the rows under them.
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { money2, fmtD } from './invFormat';
import BankLineView from './BankLineView.jsx';
import './clientGroups.css';

const sum = (list, f) => Math.round(list.reduce((s, r) => s + (Number(f(r)) || 0), 0) * 100) / 100;
const STATUS_TONE = {
  Paid: 'priority-low', 'Partially Paid': 'priority-medium', Pending: '', Overdue: 'priority-high', Cancelled: '',
};
const RECON_TONE = {
  'Bank matched': 'priority-low', 'Part matched': 'priority-medium', 'Not matched': 'priority-high', Reversed: 'priority-high', 'No payment yet': '',
};

// Build the groups from the (already filtered) register rows.
export function buildClientGroups(rows, sortKey) {
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
    g.invoices = live.length;
    g.candidates = new Set(live.map((r) => r.candidateName).filter(Boolean)).size;
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
  groups, allRows, canPay, onPay, onAccount, canBank, openAll,
}) {
  const [open, setOpen] = useState(() => new Set());
  const [lineOpen, setLineOpen] = useState(null); // `${invoiceId}:${txnId}`
  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const shownOpen = (k) => open.has(k);
  const live = useMemo(() => allRows.filter((r) => r.status !== 'Cancelled'), [allRows]);

  const viewProof = async (r) => {
    try {
      const res = await api.get(`/accounts/control/proof/invoice/${r.id}/file`, { params: { inline: 1 }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* the file may be gone; the invoice page says so */ }
  };

  const invoiceRow = (r) => (
    <tr key={r.id} className="cg-inv">
      <td><Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link></td>
      <td>{fmtD(r.invoiceDate)}</td>
      <td>{r.dueDate ? fmtD(r.dueDate) : '—'}</td>
      <td>
        {r.paymentDate ? fmtD(r.paymentDate)
          : (r.received > 0.005 ? <span className="small-muted" title="The money is recorded but nobody recorded the day it arrived">date not recorded</span> : <span className="small-muted">awaiting payment</span>)}
      </td>
      <td className="num" title={`After GST ${money2(r.invoiceValue)}, less TDS ${money2(r.tds)}`}>{money2(r.receivable)}</td>
      <td className="num">{money2(r.received)}</td>
      <td className="num"><b>{money2(r.pending)}</b></td>
      <td>
        {r.proofFile && <button type="button" className="link-btn" onClick={() => viewProof(r)}>View proof</button>}
        {r.proofRef && <div className="small-muted">ref {r.proofRef}</div>}
        {!r.proofFile && !r.proofRef && <span className="small-muted">—</span>}
      </td>
      <td>
        {(r.bankLines || []).map((b) => {
          const key = `${r.id}:${b.txnId}`;
          return (
            <div key={b.txnId}>
              <button type="button" className="link-btn" aria-expanded={lineOpen === key} onClick={() => setLineOpen(lineOpen === key ? null : key)}>
                {lineOpen === key ? 'Hide Transaction' : 'View Transaction'}
              </button>
              <div className="small-muted">{fmtD(b.date)}{b.reference ? ` · ${b.reference}` : ''} · {money2(b.applied)}</div>
            </div>
          );
        })}
        {!(r.bankLines || []).length && (r.received > 0.005 || (r.payments || []).length) ? <span className="status priority-high">Bank Line Not Matched</span> : null}
        {!(r.bankLines || []).length && !(r.received > 0.005) && !(r.payments || []).length ? <span className="small-muted">—</span> : null}
      </td>
      <td>
        <span className={`status ${STATUS_TONE[r.status] || ''}`}>{r.status}</span>{' '}
        <span className={`status ${RECON_TONE[r.reconStatus] || ''}`}>{r.reconStatus}</span>
      </td>
      <td className="cg-act">
        <Link className="btn btn-sm" to={`/invoices/${r.id}`}>Open</Link>
        {canPay && r.pending > 0.5 && r.status !== 'Cancelled' && <button type="button" className="btn btn-sm btn-primary" onClick={() => onPay(r.id)}>Record payment</button>}
      </td>
    </tr>
  );

  const candidateBlocks = (g) => {
    const byCand = new Map();
    g.list.forEach((r) => {
      const k = r.candidateName || '(no candidate - service invoice)';
      if (!byCand.has(k)) byCand.set(k, []);
      byCand.get(k).push(r);
    });
    return [...byCand.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
      const lv = list.filter((r) => r.status !== 'Cancelled');
      return (
        <Fragment key={name}>
          <tr className="cg-cand">
            <td colSpan={10}>
              <b>{name}</b>
              <span className="small-muted"> · {lv.length} invoice(s) · invoiced {money2(sum(lv, (r) => r.receivable))} · paid {money2(sum(lv, (r) => r.received))} · outstanding {money2(sum(lv, (r) => r.pending))}</span>
            </td>
          </tr>
          {list.map((r) => (
            <Fragment key={r.id}>
              {invoiceRow(r)}
              {(r.bankLines || []).filter((b) => lineOpen === `${r.id}:${b.txnId}`).map((b) => (
                <tr key={`l-${b.txnId}`} className="cg-line"><td colSpan={10}><div className="pf-drawer"><BankLineView invoiceId={r.id} txnId={b.txnId} canBank={canBank} /></div></td></tr>
              ))}
            </Fragment>
          ))}
        </Fragment>
      );
    });
  };

  return (
    <div className="cg-wrap">
      <div className="cg-tools">
        <button type="button" className="btn btn-sm" onClick={() => setOpen(new Set(groups.map((g) => g.key)))}>Expand all</button>
        <button type="button" className="btn btn-sm" onClick={() => { setOpen(new Set()); setLineOpen(null); }}>Collapse all</button>
        <span className="small-muted">One row per client. Click a client name to see its candidates and invoices.</span>
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
                    {g.invoices > 0 && <span className="small-muted"> · {g.bankMatched} of {g.invoices} bank matched</span>}
                  </td>
                  <td>{g.clientId && onAccount && <button type="button" className="btn btn-sm" onClick={() => onAccount(g)}>Account</button>}</td>
                </tr>
                {shownOpen(g.key) && (
                  <tr className="cg-detail">
                    <td colSpan={8}>
                      <div className="tbl-wrap">
                        <table className="cg-inner">
                          <thead>
                            <tr>
                              <th>Invoice no</th><th>Invoice date</th><th>Due date</th><th>Payment date</th>
                              <th className="num">Invoice amount</th><th className="num">Paid</th><th className="num">Outstanding</th>
                              <th>Proof</th><th>Bank Line</th><th>Payment / reconciliation</th><th />
                            </tr>
                          </thead>
                          <tbody>{candidateBlocks(g)}</tbody>
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
                <td><b>TOTAL</b> <span className="small-muted">{live.length} invoice(s)</span></td>
                <td className="num">{live.length}</td>
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

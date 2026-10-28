// PAYMENT CHECK — "which Paid has proof behind it?" (founder's Issue 6, 27 Oct). A tab inside Invoices, no new
// sidebar entry. READ ONLY: it shows and links, it never changes a status, a payment or a bank line.
//
// The invoice side is the register's own `verify` (backend utils/invoiceVerify.js — the one classifier; nothing is
// re-judged here): Verified paid · Paid by hand, not matched to the bank yet · Marked paid with no evidence ·
// Partly paid · Unpaid; plus every single payment still waiting for a bank check (paymentHistory[].verified).
// The bank side is GET /bank/proof-review (read only): credits with a likely invoice, credits that fit more than one
// (or were left for a person), credits with no invoice found, and lines that look printed twice. It needs
// Bank & Reconciliation view; without it the bank cards are not shown.
//
// Every row links to the invoice and, where there is one, to the bank line (Bank & Reconciliation opens that line).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { useKeptState } from '../../utils/useKeptState.js';
import { money2, fmtD } from './invFormat';
import './creditNotes.css';

const sum = (list, f) => Math.round(list.reduce((s, r) => s + (Number(f(r)) || 0), 0) * 100) / 100;
const lineLink = (txnId, invoiceId) => `/bank?line=${encodeURIComponent(txnId)}${invoiceId ? `&invoice=${encodeURIComponent(invoiceId)}` : ''}`;

// The invoice lists: classifier state -> card.
const INV_CARDS = [
  { k: 'verified', l: 'Paid, matched to the bank', tone: 'green', amt: (r) => r.received, amtWord: 'received' },
  { k: 'manual', l: 'Paid by hand, not matched to the bank yet', tone: 'orange', amt: (r) => r.verify.pendingVerification, amtWord: 'not matched yet' },
  { k: 'missing', l: 'Marked paid, but no proof at all', tone: 'red', amt: (r) => r.verify.missingEvidence, amtWord: 'with no record' },
  { k: 'partial', l: 'Partly paid (matched to the bank)', tone: 'blue', amt: (r) => r.pending, amtWord: 'still to collect' },
  { k: 'unpaid', l: 'Unpaid', tone: '', amt: (r) => r.pending, amtWord: 'to collect' },
];
const BANK_CARDS = [
  { k: 'possible', l: 'Bank credits with a likely invoice', tone: 'orange' },
  { k: 'ambiguous', l: 'Bank credits that fit more than one invoice, or need a look', tone: 'red' },
  { k: 'unmatched', l: 'Bank credits with no invoice found', tone: '' },
  { k: 'duplicates', l: 'Bank lines that look entered twice', tone: 'red' },
];

export default function PaymentCheckPanel({ rows = [], canBankView = false }) {
  // Kept when you leave and come back (utils/useKeptState.js).
  const [card, setCard] = useKeptState('invoices.check.card', 'missing');
  const [q, setQ] = useKeptState('invoices.check.q', '');
  const [bank, setBank] = useState(null);
  const [bankErr, setBankErr] = useState('');

  useEffect(() => {
    if (!canBankView) return undefined;
    let live = true;
    api.get('/bank/proof-review')
      .then((r) => { if (live) setBank(r.data); })
      .catch((e) => { if (live) setBankErr(e.response?.data?.error || 'The bank lines could not be loaded.'); });
    return () => { live = false; };
  }, [canBankView]);

  const withVerify = useMemo(() => rows.filter((r) => r.verify && r.status !== 'Cancelled'), [rows]);
  const byState = useMemo(() => {
    const m = new Map(INV_CARDS.map((c) => [c.k, []]));
    withVerify.forEach((r) => { if (m.has(r.verify.state)) m.get(r.verify.state).push(r); });
    return m;
  }, [withVerify]);
  // Every single payment that no bank credit stands behind yet.
  const waiting = useMemo(() => withVerify.flatMap((r) => (r.paymentHistory || [])
    .filter((p) => p.amount > 0 && !p.verified)
    .map((p) => ({ ...p, invoiceId: r.id, invoiceNumber: r.invoiceNumber, client: r.client, candidateName: r.candidateName }))), [withVerify]);

  const needle = q.trim().toLowerCase();
  const has = (...parts) => !needle || parts.filter(Boolean).join(' ').toLowerCase().includes(needle);
  const kind = INV_CARDS.some((c) => c.k === card) ? 'inv' : card === 'waiting' ? 'pay' : 'bank';
  const list = useMemo(() => {
    if (kind === 'inv') return (byState.get(card) || []).filter((r) => has(r.invoiceNumber, r.client, r.candidateName));
    if (kind === 'pay') return waiting.filter((p) => has(p.invoiceNumber, p.client, p.candidateName, p.reference, p.method));
    return ((bank && bank[card]) || []).filter((t) => has(t.description, t.reference, t.client, t.invoiceNumber, t.account));
  }, [kind, card, byState, waiting, bank, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = usePaged(list, 25, 'invoices.check', `${card}|${q}`);

  const cardBtn = (k, n, label, tone, sub) => (
    <button key={k} type="button" className={`cn-card ${tone}${card === k ? ' is-on' : ''}`} onClick={() => setCard(k)} title="Show this list below">
      <b>{n}</b>
      <span>{label}</span>
      {sub && <span style={{ display: 'block' }}>{sub}</span>}
    </button>
  );
  const shownCard = [...INV_CARDS, ...BANK_CARDS].find((c) => c.k === card);
  const title = card === 'waiting' ? 'Payments waiting for a bank check' : (shownCard ? shownCard.l : '');

  return (
    <div className="cn-page">
      <div className="notice" style={{ margin: 0 }}>
        <span>This page only shows. It changes nothing. Open an invoice or a bank line to fix it there.</span>
      </div>

      <h3 style={{ margin: '4px 0 0', fontSize: 15 }}>Invoices</h3>
      <div className="cn-cards">
        {INV_CARDS.map((c) => {
          const l = byState.get(c.k) || [];
          return cardBtn(c.k, l.length, c.l, l.length ? c.tone : (c.k === 'verified' ? '' : 'green'), `${money2(sum(l, c.amt))} ${c.amtWord}`);
        })}
        {cardBtn('waiting', waiting.length, 'Payments waiting for a bank check', waiting.length ? 'orange' : 'green', `${money2(sum(waiting, (p) => p.amount))} in all`)}
      </div>

      <h3 style={{ margin: '4px 0 0', fontSize: 15 }}>Bank statements</h3>
      {!canBankView && <div className="small-muted">The bank lines need Bank &amp; Reconciliation access.</div>}
      {canBankView && bankErr && <div className="notice red" style={{ margin: 0 }}><span>{bankErr}</span></div>}
      {canBankView && !bank && !bankErr && <div className="small-muted">Loading the bank lines…</div>}
      {canBankView && bank && (
        <div className="cn-cards">
          {BANK_CARDS.map((c) => {
            const l = bank[c.k] || [];
            const amount = c.k === 'duplicates' ? sum(l, (d) => d.amount * (d.copies - 1)) : sum(l, (t) => t.amount);
            return cardBtn(c.k, l.length, c.l, l.length ? c.tone : 'green', c.k === 'duplicates' ? `${money2(amount)} in the extra copies` : `${money2(amount)} in all`);
          })}
        </div>
      )}

      <div className="cn-bar">
        <b style={{ fontSize: 14 }}>{title}</b>
        <span className="grow" />
        <input type="search" value={q} placeholder="Search invoice no, client, candidate, reference…" onChange={(e) => setQ(e.target.value)} />
        {q && <button type="button" className="btn btn-sm" onClick={() => setQ('')}>Clear</button>}
      </div>

      {kind === 'bank' && !bank ? null : (
        <div className="tbl-wrap">
          <table className="cn-table">
            {kind === 'inv' && (
              <>
                <thead>
                  <tr><th>Invoice no</th><th>Client</th><th>Date</th><th className="n">Received</th><th className="n">Matched to bank</th><th className="n">By hand</th><th className="n">No proof</th><th className="n">To collect</th><th>Why</th><th>Bank line</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((r) => (
                    <tr key={r.id}>
                      <td><Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link></td>
                      <td>{r.client}{r.candidateName ? <div className="small-muted">{r.candidateName}</div> : null}</td>
                      <td>{fmtD(r.invoiceDate)}</td>
                      <td className="n">{money2(r.received)}</td>
                      <td className="n">{money2(r.verify.verifiedAmount)}</td>
                      <td className="n">{money2(r.verify.pendingVerification)}</td>
                      <td className="n">{money2(r.verify.missingEvidence)}</td>
                      <td className="n">{money2(r.pending)}</td>
                      <td style={{ maxWidth: 360 }} className="small-muted">{r.verify.reason}</td>
                      <td>
                        {(r.proofTxnIds || []).length
                          ? (r.proofTxnIds || []).map((id, n) => <div key={id}><Link to={lineLink(id, r.id)}>Open bank line{r.proofTxnIds.length > 1 ? ` ${n + 1}` : ''}</Link></div>)
                          : <span className="small-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {kind === 'pay' && (
              <>
                <thead>
                  <tr><th>Invoice no</th><th>Client</th><th>Paid on</th><th className="n">Amount</th><th>How</th><th>Reference</th><th>Where it came from</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((p) => (
                    <tr key={p.id}>
                      <td><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link></td>
                      <td>{p.client}{p.candidateName ? <div className="small-muted">{p.candidateName}</div> : null}</td>
                      <td>{fmtD(p.date)}</td>
                      <td className="n">{money2(p.amount)}</td>
                      <td>{p.method || '—'}</td>
                      <td>{p.reference || <span className="small-muted">none typed</span>}</td>
                      <td>{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {kind === 'bank' && card !== 'duplicates' && (
              <>
                <thead>
                  <tr><th>Date</th><th>Bank</th><th>Narration</th><th className="n">Amount</th><th>What the app thinks</th><th>Invoice</th><th>Bank line</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((t) => (
                    <tr key={t.id}>
                      <td>{fmtD(t.date)}</td>
                      <td>{t.account}</td>
                      <td style={{ maxWidth: 320 }}>{t.description}{t.reference ? <div className="small-muted">Ref {t.reference}</div> : null}</td>
                      <td className="n">{money2(t.amount)}</td>
                      <td style={{ maxWidth: 320 }}><b>{t.thinks}</b>{t.why ? <div className="small-muted">{t.why}</div> : null}</td>
                      <td>{t.invoiceId ? <Link to={`/invoices/${t.invoiceId}`}>{t.invoiceNumber}</Link> : <span className="small-muted">—</span>}{t.client ? <div className="small-muted">{t.client}</div> : null}</td>
                      <td><Link to={lineLink(t.id, t.invoiceId)}>Open bank line</Link></td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {kind === 'bank' && card === 'duplicates' && (
              <>
                <thead>
                  <tr><th>Date</th><th>Bank</th><th>Narration</th><th>Money</th><th className="n">Amount</th><th className="n">Copies</th><th className="n">Already posted</th><th>Bank lines</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((d) => (
                    <tr key={d.ids.join('+')}>
                      <td>{fmtD(d.date)}</td>
                      <td>{d.account}</td>
                      <td style={{ maxWidth: 320 }}>{d.description}{d.reference ? <div className="small-muted">Ref {d.reference}</div> : null}</td>
                      <td>{d.type === 'Credit' ? 'In' : 'Out'}</td>
                      <td className="n">{money2(d.amount)}</td>
                      <td className="n">{d.copies}</td>
                      <td className="n">{d.postedCopies}</td>
                      <td>{d.ids.map((id, n) => <div key={id}><Link to={lineLink(id)}>Open copy {n + 1}</Link></div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
          {list.length === 0 && <div className="small-muted" style={{ padding: 12 }}>{needle ? 'Nothing matches this search.' : 'Nothing in this list.'}</div>}
        </div>
      )}
      {list.length > 25 && <Pager page={page} noun="rows" />}
    </div>
  );
}

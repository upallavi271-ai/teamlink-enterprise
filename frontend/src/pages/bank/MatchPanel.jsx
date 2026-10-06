// THE MATCH / CATEGORISE PANEL (Accounts spec 3 part 2) — opened from Match
// or Categorise on a bank statement line. Fixed header and footer, the body
// scrolls. Two tabs:
//
//   Match transactions   what is already in the books for this line: best
//                        matches (this exact amount / the invoice the
//                        narration names), possible matches (close amounts,
//                        what the narration points at), a receipt already
//                        recorded, and hand loans. Match on a row settles it
//                        straight away; tick several and "Match the ticked
//                        one(s)" settles them oldest first.
//   Categorise manually  file the line by hand — a debit becomes an office
//                        bill (with its bill file, ≤ 8 MB); "Save & remember"
//                        also keeps a keyword rule so later lines are
//                        recognised on their own.
//
// Every write goes through routes/bank.js, which enforces the Bank &
// Reconciliation edit permission itself; the panel only opens for a login
// that holds it.
import { Fragment, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { money2, fmtD } from '../invoices/invFormat';
import { pct } from '../invoices/invTax';
import './bank.css';
import './bankTax.css';

// P4 — an invoice's calculation set against this bank line: the bank amount is
// compared with the NET RECEIVABLE still to come (after GST − TDS − already
// received), never with the base; when it differs, the panel says why.
function Breakdown({ x }) {
  const b = x.breakdown;
  const c = x.compare;
  if (!b || !c) return null;
  return (
    <div className="bkp-bd">
      <table>
        <tbody>
          <tr><td>Amount before GST</td><td className="n">{money2(b.base)}</td></tr>
          <tr><td>+ GST {b.gst > 0.005 ? `@ ${pct(b.gstPercent)} · ${b.gstTypeLabel}` : '· none'}</td><td className="n">{money2(b.gst)}</td></tr>
          <tr className="sep"><td>= Gross (after GST)</td><td className="n">{money2(b.gross)}</td></tr>
          <tr><td>− TDS {b.tds > 0.005 ? `@ ${pct(b.tdsPercent)} on the amount ${b.tdsBase === 'gross' ? 'after' : 'before'} GST` : '· none'}</td><td className="n">({money2(b.tds)})</td></tr>
          <tr className="sep k"><td>= Net receivable</td><td className="n">{money2(b.net)}</td></tr>
          {b.received > 0.5 && <tr><td>− Already received</td><td className="n">({money2(b.received)})</td></tr>}
        </tbody>
      </table>
      <table>
        <tbody>
          <tr className="k"><td>Expected receipt</td><td className="n">{money2(c.expected)}</td></tr>
          <tr><td>Bank amount</td><td className="n">{money2(c.bank)}</td></tr>
          <tr className="sep k">
            <td>Difference</td>
            <td className="n">{c.matched ? <span className="bkp-ok">✓ Matched</span> : <span className="bkp-off">{c.diff > 0 ? '+' : '−'}{money2(Math.abs(c.diff))}</span>}</td>
          </tr>
        </tbody>
      </table>
      {!c.matched && (
        <div className="bkp-why" style={{ gridColumn: '1 / -1' }}>
          <h5>Why is this amount different?</h5>
          <ul>{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

const MAX_BYTES = 8 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const DEBIT_KINDS = [
  ['expense', 'Expense — money the office spent'],
  ['hand', 'Hand loan repayment — not an expense'],
  ['transfer', 'Our own transfer — not an expense'],
];
const CREDIT_KINDS = [
  ['other', 'Other income — not a client receipt'],
  ['hand', 'Hand loan taken — not income'],
  ['transfer', 'Our own transfer — not income'],
];

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The same arithmetic the server uses (routes/bank.js billMoney): the bank
// line is what LEFT the bank = before GST + GST − TDS.
function billMoney(f, amount) {
  const g = f.gst === 'Yes' && f.reverseCharge !== 'Yes' ? Number(f.gstRate || 0) / 100 : 0;
  const t = f.tds === 'Yes' ? Number(f.tdsRate || 0) / 100 : 0;
  const base = ROUND(amount / (1 + g - t));
  const gst = ROUND(base * g);
  const tds = ROUND(Math.max(0, base + gst - amount));
  return { base, gst, tds };
}

function Err({ msg }) {
  return msg ? <div className="bkp-err" role="alert">{msg}</div> : null;
}

export default function MatchPanel({
  txn, startTab, onClose, onDone, clientNames = [],
}) {
  const isCredit = txn.type === 'Credit';
  const [tab, setTab] = useState(startTab === 'cat' ? 'cat' : 'match');
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [ticked, setTicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const [errs, setErrs] = useState({});
  const [file, setFile] = useState(null);
  const [loans, setLoans] = useState([]);
  const [shown, setShown] = useState(null); // the invoice row whose calculation is open
  const [pick, setPick] = useState(''); // "Select invoice" for a client-only line
  const [f, setF] = useState({
    kind: isCredit ? 'other' : 'expense',
    expenseAccount: '',
    vendor: '',
    date: String(txn.date || '').slice(0, 10),
    amount: String(ROUND(txn.amount)),
    gst: 'No',
    gstRate: '18',
    vendorGstin: '',
    billNumber: '',
    supplyType: '',
    hsnSac: '',
    gstTreatment: '',
    sourceState: '',
    destState: '[36] Telangana',
    reverseCharge: 'No',
    billableClient: '',
    reportingTags: '',
    tds: 'No',
    tdsRate: '10',
    paymentMode: 'Bank Transfer',
    description: String(txn.description || ''),
    match: '',
    party: '',
    loanId: '',
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    let live = true;
    api.get(`/bank/${txn.id}/candidates`).then((r) => {
      if (!live) return;
      const d = r.data;
      setData(d);
      const rec = d.recognised;
      const g = d.suggestion;
      setF((x) => ({
        ...x,
        kind: isCredit ? (g?.kind === 'transfer' ? 'transfer' : g?.kind === 'hand' ? 'hand' : 'other')
          : (g?.kind === 'transfer' ? 'transfer' : g?.kind === 'hand' ? 'hand' : 'expense'),
        expenseAccount: rec?.account || (txn.category || ''),
        vendor: rec?.vendor || txn.vendor || '',
        gst: rec?.gstRate > 0 ? 'Yes' : x.gst,
        gstRate: rec?.gstRate > 0 ? String(rec.gstRate) : x.gstRate,
        destState: d.options?.destination || x.destState,
        match: (d.words || [])[0] || '',
        party: g?.party || '',
        loanId: (d.loans || []).find((l) => l.clear)?.loanId || (d.loans || [])[0]?.loanId || '',
      }));
    }).catch((e) => live && setLoadErr(e.response?.data?.error || 'This line could not be read.'));
    api.get('/bank/hand-loans').then((r) => live && setLoans(r.data.loans || [])).catch(() => {});
    return () => { live = false; };
  }, [txn.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes, as every panel in the app does.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const amount = ROUND(txn.amount);
  const best = data?.best || [];
  const maybe = data?.maybe || [];
  const allIds = useMemo(() => [...best, ...maybe].map((x) => x.id), [best, maybe]);
  const tick = (id, on) => setTicked((t) => (on ? [...new Set([...t, id])] : t.filter((x) => x !== id)));

  async function post(url, body, said) {
    setBusy(true); setFail('');
    try {
      const r = await api.post(url, body);
      onDone(said(r.data));
      return true;
    } catch (e) {
      setFail(e.response?.data?.error || 'That did not work.');
      if (e.response?.data?.fields) setErrs(e.response.data.fields);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const matchIds = (ids) => (isCredit
    ? post(`/bank/${txn.id}/settle-invoices`, { invoiceIds: ids }, (d) => `Settled ${d.parts.map((x) => x.invoiceNumber).join(', ')} — ${money2(d.posted)} recorded against the invoice(s)${d.unallocated > 0.5 ? `; ${money2(d.unallocated)} left unposted` : ''}.`)
    : post(`/bank/${txn.id}/match-bills`, { billIds: ids }, (d) => `${d.settled} office bill(s) settled from this line${d.unposted > 0.5 ? `; ${money2(d.unposted)} left unposted` : ''}${d.pendingApproval ? ` · ${d.pendingApproval} still waiting for approval` : ''}.`));

  const linkLoan = (loanId) => post(`/bank/hand-loans/${loanId}/link`, { bankTxnId: txn.id }, (d) => (d.cleared
    ? `Linked — the loan is now cleared (${fmtD(d.clearedDate)}).`
    : `Linked to the hand loan — ${money2(d.pending)} still pending on it.`));

  // ---- Categorise manually: the form's own checks, shown under each field.
  const m = billMoney(f, Number(f.amount) || amount);
  function validate(remember) {
    const e = {};
    if (!f.kind) e.kind = 'Choose the category.';
    if (f.kind === 'expense' || f.kind === 'other') {
      if (!String(f.expenseAccount).trim()) e.expenseAccount = f.kind === 'expense' ? 'Choose the expense account.' : 'Say what this income is.';
    }
    if (f.kind === 'expense') {
      const a = Number(f.amount);
      if (!(a > 0)) e.amount = 'Enter the amount that left the bank.';
      else if (Math.abs(a - amount) > 20) e.amount = `The bank line is ${money2(amount)} — the bill has to match it.`;
      if (!f.date) e.date = 'Enter the date.';
      if (f.gst === 'Yes' && !(Number(f.gstRate) > 0)) e.gstRate = 'Choose the GST rate on the bill.';
      if (f.vendorGstin.trim() && f.vendorGstin.trim().length !== 15) e.vendorGstin = `A GSTIN is 15 characters — this one is ${f.vendorGstin.trim().length}.`;
      if (f.hsnSac.trim() && !/^(\d{4}|\d{6}|\d{8})$/.test(f.hsnSac.replace(/\s+/g, ''))) e.hsnSac = 'HSN / SAC is 4, 6 or 8 digits.';
      if (f.tds === 'Yes' && !(Number(f.tdsRate) > 0)) e.tdsRate = 'Choose the TDS rate cut.';
      if (file && file.size > MAX_BYTES) e.file = 'That file is larger than 8 MB.';
      if (file && !FILE_TYPES.includes(file.type)) e.file = 'Attach a PDF, PNG, JPEG or WebP file.';
    }
    if (f.kind === 'hand' && loans.length && !f.loanId) e.loanId = 'Choose the hand loan this belongs to.';
    if (f.kind === 'hand' && !loans.length && !f.party.trim()) e.party = 'Say who the loan is with — or add it under Hand loans first.';
    if (remember && f.kind !== 'hand') {
      if (!f.match.trim()) e.match = 'Type the words to remember, e.g. EPF0.';
      else if (f.match.replace(/[^A-Za-z0-9]/g, '').length < 3) e.match = 'Use at least three letters or digits.';
    }
    setErrs(e);
    return !Object.keys(e).length;
  }

  async function save(remember) {
    setFail('');
    if (!validate(remember)) { setFail('Some fields need attention.'); return; }
    if (f.kind === 'hand' && f.loanId) { await linkLoan(f.loanId); return; }
    if (f.kind === 'expense') {
      const payload = {
        ...f, fileAsBill: true, amount: Number(f.amount), remember: !!remember,
      };
      delete payload.party; delete payload.loanId;
      let body = payload;
      if (file) {
        body = new FormData();
        body.append('data', JSON.stringify(payload));
        body.append('file', file);
      }
      await post(`/bank/${txn.id}/categorise`, body, (d) => (d.rule
        ? `Filed as an office bill under ${f.expenseAccount} — every line carrying “${d.rule.match}” is recognised as ${d.rule.category} from now on.`
        : `Filed as an office bill under ${f.expenseAccount}.`));
      return;
    }
    await post(`/bank/${txn.id}/categorise`, {
      kind: f.kind,
      category: f.kind === 'other' ? f.expenseAccount : '',
      party: f.party || null,
      vendor: null,
      remember: !!remember,
      match: f.match,
    }, (d) => (d.rule ? `Filed — every line carrying “${d.rule.match}” is filed the same way from now on.` : 'Filed.'));
  }

  const kinds = isCredit ? CREDIT_KINDS : DEBIT_KINDS;
  const rec = data?.recognised;
  const o = data?.options || {};
  const lineLoans = data?.loans || [];

  const row = (x) => (
    <Fragment key={x.id}>
    <tr>
      <td className="bkp-tick">
        <input type="checkbox" aria-label="Tick" checked={ticked.includes(x.id)} onChange={(e) => tick(x.id, e.target.checked)} />
      </td>
      {isCredit ? (
        <>
          <td><b className="bkp-mono">{x.invoiceNumber}</b>{x.pointed && <span className="status priority-low bkp-chip">named in the narration</span>}</td>
          <td>{x.client}</td>
          <td>{fmtD(x.invoiceDate)}</td>
          <td className="num">
            {money2(x.outstanding)}<div className="small-muted">net still to come</div>
            {x.breakdown && (
              <button type="button" className="link-btn bkp-bdbtn" aria-expanded={shown === x.id} onClick={() => setShown(shown === x.id ? null : x.id)}>
                {shown === x.id ? 'Hide calculation' : (x.compare && !x.compare.matched ? 'Why different?' : 'Calculation')}
              </button>
            )}
          </td>
        </>
      ) : (
        <>
          <td><b>{x.category}</b>{x.code && <div className="small-muted bkp-mono">{x.code}{x.billNumber ? ` · bill ${x.billNumber}` : ''}</div>}</td>
          <td>{x.vendor || '—'}</td>
          <td>{fmtD(x.expenseDate)}</td>
          <td className="num">{money2(x.net)}<div className="small-muted">{x.approvalStatus === 'PENDING' ? 'awaiting approval' : String(x.approvalStatus || '').toLowerCase()}</div></td>
        </>
      )}
      <td className="num">{Math.abs(x.diff) < 0.5 ? <span className="status priority-low">exact</span> : `${x.diff > 0 ? '+' : '−'}${money2(Math.abs(x.diff))}`}</td>
      <td className="num"><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => matchIds([x.id])}>Match</button></td>
    </tr>
    {isCredit && shown === x.id && x.breakdown && (
      <tr className="bkp-bdrow"><td colSpan={7}><Breakdown x={x} /></td></tr>
    )}
    </Fragment>
  );
  // "Select invoice" (P4): the narration names only the client, who has several open invoices.
  const sel = isCredit ? data?.selectInvoice : null;
  const picked = sel ? sel.invoices.find((i) => i.id === pick) : null;
  const head = (
    <thead>
      <tr>
        <th aria-label="Tick" />
        <th>{isCredit ? 'Invoice' : 'Office bill'}</th>
        <th>{isCredit ? 'Client' : 'Paid to'}</th>
        <th>Date</th>
        <th className="num">{isCredit ? 'Pending' : 'Amount'}</th>
        <th className="num">Difference</th>
        <th />
      </tr>
    </thead>
  );

  return (
    <div className="overlay show bkp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bkp" role="dialog" aria-modal="true" aria-labelledby="bkp-title">
        <header className="bkp-head">
          <div className="bkp-head-row">
            <div>
              <h3 id="bkp-title" className={`bkp-title ${isCredit ? 'in' : 'out'}`}>{isCredit ? 'Money in' : 'Money out'} · {money2(amount)}</h3>
              <div className="bkp-meta">
                <span>{fmtD(txn.date)}</span>
                {data?.bank && <span>{data.bank}</span>}
                {txn.reference && <span>Ref {txn.reference}</span>}
              </div>
              <div className="bkp-narr" title={txn.description}>{txn.description || '—'}</div>
            </div>
            <button type="button" className="close-x" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
          </div>
          <div className="bkp-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'match'} className={`tab-btn ${tab === 'match' ? 'active' : ''}`} onClick={() => setTab('match')}>Match transactions</button>
            <button type="button" role="tab" aria-selected={tab === 'cat'} className={`tab-btn ${tab === 'cat' ? 'active' : ''}`} onClick={() => setTab('cat')}>Categorise manually</button>
          </div>
        </header>

        <div className="bkp-body">
          {loadErr && <div className="notice red"><span>{loadErr}</span></div>}
          {!data && !loadErr && <div className="small-muted">Reading the line…</div>}

          {data && tab === 'match' && (
            <>
              {data.read && data.read.kind !== 'none' && (
                <div className="bkp-read"><span className={`status ${data.read.tagClass || ''}`}>{data.read.tag}</span> {data.read.why}</div>
              )}
              {isCredit && data.payment && (
                <section className="bkp-card">
                  <div className="bkp-card-h"><h4>Already recorded</h4></div>
                  <div className="bkp-already">
                    <span>
                      A receipt of <b>{money2(data.payment.amount)}</b> on {fmtD(data.payment.date)} against <b>{data.payment.invoiceNumber || 'an invoice'}</b>
                      {data.payment.reference ? ` (ref ${data.payment.reference})` : ''} is already in the books.
                      {' '}Link this line as its proof — no second receipt is written.
                    </span>
                    {data.payment.linkable
                      ? <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => post(`/bank/${txn.id}/link-payment`, { paymentId: data.payment.id }, () => 'Linked as the proof of the receipt already recorded — nothing was posted twice.')}>Link as proof</button>
                      : <span className="small-muted">already backed by another bank line</span>}
                  </div>
                </section>
              )}
              {sel && (
                <section className="bkp-card" aria-label="Select invoice">
                  <div className="bkp-card-h">
                    <h4>Select invoice <span className="bkp-count">{sel.invoices.length}</span></h4>
                  </div>
                  <p className="bkp-empty" style={{ marginTop: 0 }}>
                    The bank line names <b>{sel.client}</b> only, and they have {sel.invoices.length} open invoices. Pick the one this money is for —
                    its calculation is shown against the bank amount before you confirm.
                  </p>
                  <div className="bkp-pick" role="radiogroup">
                    {sel.invoices.map((i) => (
                      <label key={i.id} className={pick === i.id ? 'on' : ''}>
                        <input type="radio" name="bkp-pick" checked={pick === i.id} onChange={() => setPick(i.id)} />
                        <span className="bkp-pick-main">
                          <b className="bkp-mono">{i.invoiceNumber}</b> · {i.kind}{i.candidate ? ` · ${i.candidate}` : ''}
                          <div className="small-muted">{i.fy || '—'} · dated {fmtD(i.invoiceDate)}{i.dueDate ? ` · due ${fmtD(i.dueDate)}` : ''}</div>
                        </span>
                        <span className="bkp-pick-amt">
                          {money2(i.outstanding)}
                          <div className="small-muted">
                            {i.compare?.matched ? '✓ matches the bank amount'
                              : `bank is ${money2(Math.abs(i.compare?.diff || 0))} ${(i.compare?.diff || 0) < 0 ? 'less' : 'more'}`}
                          </div>
                        </span>
                      </label>
                    ))}
                  </div>
                  {picked && <Breakdown x={picked} />}
                  <div className="bkp-pickfoot">
                    <button type="button" className="btn btn-primary" disabled={busy || !picked} onClick={() => matchIds([picked.id])}>
                      {picked ? `Confirm — post ${money2(Math.min(amount, picked.outstanding))} to ${picked.invoiceNumber}` : 'Pick an invoice to confirm'}
                    </button>
                  </div>
                </section>
              )}
              <section className="bkp-card">
                <div className="bkp-card-h">
                  <h4>Best matches <span className="bkp-count">{best.length}</span></h4>
                </div>
                {best.length ? (
                  <div className="bkp-tbl"><table>{head}<tbody>{best.map(row)}</tbody></table></div>
                ) : (
                  <p className="bkp-empty">
                    {isCredit
                      ? 'Nothing in the books matches this line exactly. Use Categorise manually to file it, or pick from the possible matches.'
                      : 'Nothing in the books matches this line exactly. Use Categorise manually to enter it as an office bill.'}
                  </p>
                )}
              </section>
              <section className="bkp-card">
                <div className="bkp-card-h">
                  <h4>Possible matches <span className="bkp-count">{maybe.length}</span></h4>
                  {maybe.length > 0 && (
                    <div className="bkp-card-acts">
                      <button type="button" className="link-btn" onClick={() => setTicked(allIds)}>Select all</button>
                      <button type="button" className="link-btn" onClick={() => setTicked([])}>Clear</button>
                    </div>
                  )}
                </div>
                {maybe.length ? (
                  <div className="bkp-tbl"><table>{head}<tbody>{maybe.map(row)}</tbody></table></div>
                ) : <p className="bkp-empty">Nothing else is close to this amount.</p>}
              </section>
              {lineLoans.length > 0 && (
                <section className="bkp-card">
                  <div className="bkp-card-h"><h4>Hand loans <span className="bkp-count">{lineLoans.length}</span></h4></div>
                  <div className="bkp-tbl">
                    <table>
                      <tbody>
                        {lineLoans.map((l) => (
                          <tr key={l.loanId}>
                            <td><b>{l.name}</b>{l.lender && <div className="small-muted">{l.lender}</div>}</td>
                            <td>{isCredit ? 'the loan being taken' : 'a repayment'}</td>
                            <td className="small-muted">{l.linked ? 'linked' : l.why}</td>
                            <td className="num">
                              {l.linked
                                ? <span className="status priority-low">linked</span>
                                : <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => linkLoan(l.loanId)}>{l.clear ? 'Link' : 'Confirm'}</button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <div className="notice bkp-note">
                <span>
                  This line is <b>{money2(amount)}</b>. Press <b>Match</b> on one row to settle it straight away, or tick several when one
                  transfer paid more than one {isCredit ? 'invoice' : 'bill'} and press <b>Match the ticked one(s)</b> below — the oldest is
                  settled first and anything left over stays unposted.
                </span>
              </div>
            </>
          )}

          {data && tab === 'cat' && (
            <form className="bkp-form" onSubmit={(e) => { e.preventDefault(); save(false); }} noValidate>
              <label className="field">
                <span>Category *</span>
                <select value={f.kind} onChange={set('kind')} aria-invalid={!!errs.kind}>
                  {kinds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <Err msg={errs.kind} />
              </label>

              {(f.kind === 'expense' || f.kind === 'other') && (
                <label className="field">
                  <span>
                    {f.kind === 'expense' ? 'Expense account *' : 'Income account *'}
                    {rec && f.kind === 'expense' && f.expenseAccount === rec.account && (
                      <span className="status priority-low bkp-chip" title={rec.why}>recognised — from {rec.why}</span>
                    )}
                  </span>
                  <input list="bkp-accounts" value={f.expenseAccount} onChange={set('expenseAccount')} placeholder={f.kind === 'expense' ? 'e.g. PF' : 'e.g. Interest received'} aria-invalid={!!errs.expenseAccount} />
                  <datalist id="bkp-accounts">{(data.categories || []).map((c) => <option key={c} value={c} />)}</datalist>
                  <Err msg={errs.expenseAccount} />
                </label>
              )}

              {f.kind === 'hand' && (
                loans.length ? (
                  <label className="field">
                    <span>Which hand loan *</span>
                    <select value={f.loanId} onChange={set('loanId')} aria-invalid={!!errs.loanId}>
                      <option value="">— choose the loan —</option>
                      {loans.map((l) => <option key={l.id} value={l.id}>{l.name}{l.lender ? ` · ${l.lender}` : ''} · {money2(l.pending)} pending</option>)}
                    </select>
                    <Err msg={errs.loanId} />
                  </label>
                ) : (
                  <label className="field">
                    <span>Who the loan is with *</span>
                    <input value={f.party} onChange={set('party')} placeholder="Name of the person" aria-invalid={!!errs.party} />
                    <div className="bkp-help">Add the loan under Bank &amp; Reconciliation → Hand loans to track what is repaid.</div>
                    <Err msg={errs.party} />
                  </label>
                )
              )}

              {f.kind === 'expense' && (
                <>
                  <label className="field">
                    <span>Paid to (vendor)</span>
                    <input value={f.vendor} onChange={set('vendor')} placeholder="Vendor name on the bill" />
                  </label>
                  <label className="field">
                    <span>Date</span>
                    <input type="date" value={f.date} onChange={set('date')} aria-invalid={!!errs.date} />
                    <Err msg={errs.date} />
                  </label>
                  <label className="field">
                    <span>Amount that left the bank</span>
                    <input inputMode="decimal" value={f.amount} onChange={set('amount')} aria-invalid={!!errs.amount} />
                    <Err msg={errs.amount} />
                  </label>
                  <label className="field">
                    <span>Does the bill carry GST?</span>
                    <select value={f.gst} onChange={set('gst')}><option>No</option><option>Yes</option></select>
                  </label>
                  <label className="field">
                    <span>GST rate</span>
                    <select value={f.gstRate} onChange={set('gstRate')} disabled={f.gst !== 'Yes'} aria-invalid={!!errs.gstRate}>
                      {(o.gstRates || [5, 12, 18, 28]).filter((x) => x > 0).map((x) => <option key={x} value={x}>{x}%</option>)}
                    </select>
                    <Err msg={errs.gstRate} />
                  </label>
                  <label className="field">
                    <span>Vendor GSTIN</span>
                    <input value={f.vendorGstin} maxLength={15} onChange={(e) => setF((x) => ({ ...x, vendorGstin: e.target.value.toUpperCase().replace(/\s+/g, '') }))} placeholder="15 characters" aria-invalid={!!errs.vendorGstin} />
                    <Err msg={errs.vendorGstin} />
                  </label>
                  <label className="field">
                    <span>Bill / invoice no</span>
                    <input value={f.billNumber} onChange={set('billNumber')} placeholder="The vendor's own number" />
                  </label>
                  <label className="field">
                    <span>Goods or service</span>
                    <select value={f.supplyType} onChange={set('supplyType')}>
                      <option value="">—</option><option>Goods</option><option>Service</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>HSN / SAC code</span>
                    <input value={f.hsnSac} onChange={set('hsnSac')} inputMode="numeric" placeholder="e.g. 997212" aria-invalid={!!errs.hsnSac} />
                    <Err msg={errs.hsnSac} />
                  </label>
                  <label className="field">
                    <span>GST treatment</span>
                    <select value={f.gstTreatment} onChange={set('gstTreatment')}>
                      <option value="">— e.g. Registered Business - Regular —</option>
                      {(o.gstTreatments || []).map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Source of supply (vendor&apos;s state)</span>
                    <select value={f.sourceState} onChange={set('sourceState')}>
                      <option value="">—</option>
                      {(o.states || []).map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Destination of supply</span>
                    <select value={f.destState} onChange={set('destState')}>
                      {(o.states || [f.destState]).map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Reverse charge</span>
                    <select value={f.reverseCharge} onChange={set('reverseCharge')}>
                      <option value="No">No — the vendor charges the GST</option>
                      <option value="Yes">Yes — we pay the GST (reverse charge)</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Billable to a client</span>
                    <input list="bkp-clients" value={f.billableClient} onChange={set('billableClient')} placeholder="Blank if it is our own cost" />
                    <datalist id="bkp-clients">{clientNames.map((c) => <option key={c} value={c} />)}</datalist>
                  </label>
                  <label className="field">
                    <span>Reporting tags</span>
                    <input value={f.reportingTags} onChange={set('reportingTags')} placeholder="e.g. Hyderabad, Recruitment, Q2" />
                  </label>
                  <label className="field">
                    <span>TDS cut by us?</span>
                    <select value={f.tds} onChange={set('tds')}><option>No</option><option>Yes</option></select>
                  </label>
                  <label className="field">
                    <span>TDS rate</span>
                    <select value={f.tdsRate} onChange={set('tdsRate')} disabled={f.tds !== 'Yes'} aria-invalid={!!errs.tdsRate}>
                      {(o.tdsRates || [1, 2, 5, 10]).map((x) => <option key={x} value={x}>{x}%</option>)}
                    </select>
                    <Err msg={errs.tdsRate} />
                  </label>
                  <label className="field">
                    <span>Payment mode</span>
                    <select value={f.paymentMode} onChange={set('paymentMode')}>
                      {(o.modes || ['Bank Transfer']).map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                </>
              )}

              {(f.kind === 'other' || f.kind === 'transfer') && (
                <label className="field">
                  <span>{isCredit ? 'Received from' : 'Paid to'}</span>
                  <input value={f.party} onChange={set('party')} placeholder="Optional" />
                </label>
              )}

              <label className="field bkp-span2">
                <span>Description</span>
                <input value={f.description} onChange={set('description')} disabled={f.kind !== 'expense'} />
              </label>

              {f.kind === 'expense' && (
                <label className="field bkp-span2">
                  <span>Attach the bill or receipt</span>
                  <input
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => { setFile(e.target.files?.[0] || null); setErrs((x) => ({ ...x, file: undefined })); }}
                    aria-invalid={!!errs.file}
                  />
                  <div className="bkp-help">One file, up to 8 MB (PDF, PNG, JPEG or WebP). Kept with the bill so the proof list never asks for it again.</div>
                  <Err msg={errs.file} />
                </label>
              )}

              {f.kind !== 'hand' && (
                <label className="field bkp-span2">
                  <span>Remember this narration as</span>
                  <input value={f.match} onChange={set('match')} placeholder="e.g. EPF0" aria-invalid={!!errs.match} />
                  <div className="bkp-help">
                    Used only if you press Save &amp; remember. Every future line carrying these words is recognised as
                    {' '}{f.expenseAccount || 'this account'} and can be filed with one press.
                  </div>
                  <Err msg={errs.match} />
                </label>
              )}

              {f.kind === 'expense' && (
                <div className="bkp-summary bkp-span2" aria-live="polite">
                  Bill before GST <b>{money2(m.base)}</b>
                  {' · '}
                  {m.gst > 0.004 ? <>GST <b>{money2(m.gst)}</b> at {f.gstRate}%</> : (f.gst === 'Yes' && f.reverseCharge === 'Yes' ? 'GST under reverse charge — paid by us separately' : 'no GST on this bill')}
                  {m.tds > 0.004 && <> · TDS kept back <b>{money2(m.tds)}</b></>}
                  {' · '}money out of the bank <b>{money2(Number(f.amount) || amount)}</b>.
                </div>
              )}
              <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
            </form>
          )}
          {fail && <div className="notice red bkp-fail" role="alert"><span>{fail}</span></div>}
        </div>

        <footer className="bkp-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {tab === 'match' ? (
            <button type="button" className="btn btn-primary" disabled={busy || !ticked.length} onClick={() => matchIds(ticked)}>
              Match the ticked one{ticked.length === 1 ? '' : 's'}{ticked.length ? ` (${ticked.length})` : ''}
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy || !data} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
              {f.kind !== 'hand' && (
                <button type="button" className="btn btn-primary" disabled={busy || !data} onClick={() => save(true)}>Save &amp; remember this narration</button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

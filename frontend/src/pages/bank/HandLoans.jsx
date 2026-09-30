// HAND LOANS (Accounts spec 3 part 4) — Bank & Reconciliation's own section.
// A loan is money borrowed from a person: the taking is a credit line on the
// statement, each repayment a debit line. Lines whose narration clearly names
// the loan (its name or the lender) with an amount that fits are linked as
// proof automatically (on import, and whenever a loan is saved); anything less
// certain is listed under "Possible matches" to confirm. Per loan: the amount
// and date taken, the repayments, total repaid, what is pending, and a Cleared
// tag with the date once nothing is pending. GET/POST /bank/hand-loans…
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { money2, fmtD, todayIso } from '../invoices/invFormat';
import './bank.css';

function LoanForm({ loan, onClose, onSaved }) {
  const [f, setF] = useState({
    name: loan?.name || '',
    lender: loan?.lender || '',
    amount: loan ? String(loan.amount) : '',
    dateTaken: loan?.dateTaken || todayIso(),
    notes: loan?.notes || '',
  });
  const [errs, setErrs] = useState({});
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async () => {
    const e = {};
    if (!f.name.trim()) e.name = 'Give the loan a name.';
    if (!(Number(f.amount) > 0)) e.amount = 'Enter the amount taken.';
    if (!f.dateTaken) e.dateTaken = 'Enter the date taken.';
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const body = { ...f, amount: Number(f.amount) };
      const r = loan ? await api.put(`/bank/hand-loans/${loan.id}`, body) : await api.post('/bank/hand-loans', body);
      onSaved(`${loan ? 'Loan updated' : 'Loan added'}${r.data.linked ? ` — ${r.data.linked} statement line(s) linked as proof` : ''}.`);
    } catch (err) {
      setFail(err.response?.data?.error || 'The loan could not be saved.');
      if (err.response?.data?.fields) setErrs(err.response.data.fields);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={loan ? `Edit ${loan.name}` : 'Add a hand loan'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save loan'}</button>
        </>
      )}
    >
      <div className="bkl-form">
        <label className="field"><span>Loan name *</span>
          <input value={f.name} onChange={set('name')} placeholder="e.g. Ravi hand loan" aria-invalid={!!errs.name} />
          {errs.name && <div className="bkp-err">{errs.name}</div>}
        </label>
        <label className="field"><span>Lender / party</span>
          <input value={f.lender} onChange={set('lender')} placeholder="As the name reads on the statement" />
        </label>
        <label className="field"><span>Amount taken (₹) *</span>
          <input inputMode="decimal" value={f.amount} onChange={set('amount')} aria-invalid={!!errs.amount} />
          {errs.amount && <div className="bkp-err">{errs.amount}</div>}
        </label>
        <label className="field"><span>Date taken *</span>
          <input type="date" value={f.dateTaken} onChange={set('dateTaken')} aria-invalid={!!errs.dateTaken} />
          {errs.dateTaken && <div className="bkp-err">{errs.dateTaken}</div>}
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Notes</span>
          <textarea rows="2" value={f.notes} onChange={set('notes')} />
        </label>
      </div>
      <div className="small-muted" style={{ marginTop: 6 }}>
        Statement lines whose narration carries the loan name or the lender are linked as proof: the credit it was taken on, then
        every repayment. Anything less certain waits under Possible matches for you to confirm.
      </div>
      {fail && <div className="notice red" style={{ marginTop: 10 }}><span>{fail}</span></div>}
    </Modal>
  );
}

// Search · Status · Date taken, and a Sort, over the loan cards.
const LOAN_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search loan name, lender or notes…', get: (l) => `${l.name || ''} ${l.lender || ''} ${l.notes || ''}` },
  { key: 'status', label: 'Status', allLabel: 'All statuses', options: ['Pending', 'Cleared'], get: (l) => (l.cleared ? 'Cleared' : 'Pending'), primary: true },
  { key: 'date', type: 'daterange', label: 'Date taken', get: (l) => l.dateTaken, primary: true },
  { key: 'lender', label: 'Lender', get: (l) => l.lender },
];
const LOAN_SORTS = [
  { key: 'new', label: 'Newest first', cmp: (a, b) => String(b.dateTaken || '').localeCompare(String(a.dateTaken || '')) },
  { key: 'pending', label: 'Pending high → low', cmp: (a, b) => (Number(b.pending) || 0) - (Number(a.pending) || 0) },
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
];

export default function HandLoans({ canManage, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState(null); // null | { loan }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/bank/hand-loans').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Hand loans could not be loaded.'));
  }, []);
  useEffect(load, [load]);

  async function run(fn, said) {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await fn();
      if (said) setNote(said(r.data));
      load();
      onChanged?.();
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  const s = data?.summary;
  const lf = useListFilters(data?.loans || [], LOAN_FIELDS, { sorts: LOAN_SORTS });
  return (
    <div>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={onBack}>← All accounts</button>
          <div>
            <h1>Hand loans</h1>
            <div className="page-sub">Money borrowed from people — the bank line it came in on, every repayment, and what is still owed.</div>
          </div>
        </div>
        {canManage && (
          <div className="qa-row">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post('/bank/hand-loans/auto-match'), (d) => (d.linked ? `${d.linked} statement line(s) linked as proof.` : 'Nothing new to link — every clear line is already linked.'))}>⟳ Match statement lines</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setForm({ loan: null })}>＋ Add a hand loan</button>
          </div>
        )}
      </div>

      {error && <div className="notice red"><span>{error}</span></div>}
      {note && <div className="notice" role="status"><span>{note}</span></div>}
      {!data && !error && <div className="small-muted">Loading…</div>}

      {data && (
        <>
          <div className="statbar">
            <div className="statitem"><div className="n">{money2(s.taken)}</div><div className="l">Total taken</div><div className="l" style={{ opacity: 0.75 }}>{s.loans} loan(s)</div></div>
            <div className="statitem"><div className="n">{money2(s.repaid)}</div><div className="l">Total repaid</div></div>
            <div className="statitem"><div className="n" style={{ color: s.pending > 0.5 ? 'var(--red)' : 'var(--teal)' }}>{money2(s.pending)}</div><div className="l">Pending</div><div className="l" style={{ opacity: 0.75 }}>{s.cleared} cleared</div></div>
          </div>

          {!data.loans.length && (
            <div className="card section">
              <h3>No hand loans yet</h3>
              <div className="small-muted">
                Add a loan with its name, the lender, the amount and the date taken. The statement lines are then found for you —
                the credit it came in on and every repayment going out.
              </div>
            </div>
          )}

          {data.loans.length > 0 && <ListFilterBar lf={lf} storageKey="bank-loans" noun="loans" />}
          {data.loans.length > 0 && lf.rows.length === 0 && <ListEmpty lf={lf} noun="loans" />}
          <div className="bkl-list">
            {lf.rows.map((l) => (
              <article key={l.id} className={`bkl-card${l.cleared ? ' cleared' : ''}`}>
                <div className="bkl-top">
                  <div>
                    <h3>
                      {l.name}
                      {l.cleared
                        ? <span className="status priority-low">Cleared · {fmtD(l.clearedDate)}</span>
                        : <span className="status priority-medium">{money2(l.pending)} pending</span>}
                    </h3>
                    <div className="bkl-sub">
                      {l.lender ? `${l.lender} · ` : ''}{money2(l.amount)} taken on {fmtD(l.dateTaken)}
                      {l.notes ? ` · ${l.notes}` : ''}
                    </div>
                  </div>
                  {canManage && (
                    <div className="bkl-acts">
                      <button type="button" className="btn btn-sm" onClick={() => setForm({ loan: l })}>Edit</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => { if (window.confirm(`Remove ${l.name}? Its statement lines go back to uncategorised; the statement itself is not touched.`)) run(() => api.delete(`/bank/hand-loans/${l.id}`), () => 'Loan removed.'); }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                <div className="bkl-figs">
                  <div className="bkl-fig"><span>Amount taken</span><strong>{money2(l.amount)}</strong></div>
                  <div className="bkl-fig"><span>Date taken</span><strong>{fmtD(l.dateTaken)}</strong></div>
                  <div className="bkl-fig good"><span>Total repaid</span><strong>{money2(l.repaid)}</strong></div>
                  <div className={`bkl-fig ${l.pending > 0.5 ? 'bad' : 'good'}`}><span>Pending</span><strong>{money2(l.pending)}</strong></div>
                </div>

                <div className="bkl-h">Taken — bank proof</div>
                {l.taken ? (
                  <div className="small-muted">
                    Credit of <b style={{ color: 'var(--ink)' }}>{money2(l.taken.amount)}</b> on {fmtD(l.taken.date)}
                    {l.taken.reference ? ` · Ref ${l.taken.reference}` : ''}{l.taken.auto ? ' · linked automatically' : ''}
                    {canManage && <> {' '}<button type="button" className="link-btn" disabled={busy} onClick={() => run(() => api.delete(`/bank/hand-loans/links/${l.taken.linkId}`), () => 'Unlinked.')}>Unlink</button></>}
                  </div>
                ) : <div className="small-muted">No statement line is linked for the taking yet.</div>}

                <div className="bkl-h">Repayments</div>
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr><th>Statement date</th><th>Reference</th><th className="num">Amount</th><th>Narration</th>{canManage && <th />}</tr>
                    </thead>
                    <tbody>
                      {l.repayments.map((x) => (
                        <tr key={x.linkId}>
                          <td>{fmtD(x.date)}</td>
                          <td className="bkp-mono">{x.reference || '—'}</td>
                          <td className="num" style={{ fontWeight: 600 }}>{money2(x.amount)}</td>
                          <td className="small-muted">{String(x.description || '').slice(0, 90)}{x.auto ? ' · auto' : ''}</td>
                          {canManage && <td><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.delete(`/bank/hand-loans/links/${x.linkId}`), () => 'Unlinked.')}>Unlink</button></td>}
                        </tr>
                      ))}
                      {!l.repayments.length && <tr><td colSpan={canManage ? 5 : 4} className="small-muted">No repayment linked yet.</td></tr>}
                    </tbody>
                    {l.repayments.length > 0 && (
                      <tfoot>
                        <tr>
                          <td colSpan="2"><b>Total repaid</b></td>
                          <td className="num"><b>{money2(l.repaid)}</b></td>
                          <td colSpan={canManage ? 2 : 1}><b>Pending {money2(l.pending)}</b>{l.overpaid > 0.5 ? ` · ${money2(l.overpaid)} repaid over the loan` : ''}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {(l.toLink.length > 0 || l.possible.length > 0) && (
                  <>
                    <div className="bkl-h">Possible matches — confirm to link</div>
                    <div className="tbl-wrap">
                      <table>
                        <thead><tr><th>Statement date</th><th>Reference</th><th className="num">Amount</th><th>Why</th>{canManage && <th />}</tr></thead>
                        <tbody>
                          {[...l.toLink, ...l.possible].map((x) => (
                            <tr key={x.txnId}>
                              <td>{fmtD(x.date)}</td>
                              <td className="bkp-mono">{x.reference || '—'}</td>
                              <td className="num">{x.type === 'Credit' ? '+' : '−'}{money2(x.amount)}</td>
                              <td className="small-muted">{x.why}<div>{String(x.description || '').slice(0, 80)}</div></td>
                              {canManage && (
                                <td>
                                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/bank/hand-loans/${l.id}/link`, { bankTxnId: x.txnId }), (d) => (d.cleared ? `Linked — ${l.name} is cleared (${fmtD(d.clearedDate)}).` : `Linked — ${money2(d.pending)} still pending.`))}>
                                    Confirm
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      {form && (
        <LoanForm
          loan={form.loan}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); setNote(msg); load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}

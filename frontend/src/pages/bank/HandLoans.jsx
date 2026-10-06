// HAND LOANS (Accounts spec 3 part 4; S6 popup) — opened from Bank & Reconciliation.
// A loan is money borrowed from a person: the taking is a credit line on the
// statement, each repayment a debit line. Lines whose narration clearly names
// the loan (its name or the lender) with an amount that fits are linked as
// proof automatically (on import, and whenever a loan is saved); anything less
// certain is listed under "Possible matches" to confirm. Per loan: the amount
// and date taken, the repayments, total repaid, what is pending, and a Cleared
// tag with the date once nothing is pending. GET/POST /bank/hand-loans…
import {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { money, money2, fmtD, todayIso } from '../invoices/invFormat';
import './bank.css';
import './bank-s6.css';

function LoanForm({
  loan, preset, onClose, onSaved,
}) {
  const [f, setF] = useState({
    name: loan?.name || preset?.name || '',
    lender: loan?.lender || preset?.lender || '',
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

const monthKey = (d) => String(d || '').slice(0, 7);
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (k) => (/^\d{4}-\d{2}$/.test(k) ? `${MON3[Number(k.slice(5, 7)) - 1]}-${k.slice(0, 4)}` : k);
const personOf = (l) => l.lender || l.name;

// The statement line behind one movement — the proof (S6 "View line").
export function ViewLine({ line, onClose }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const out = line.type !== 'Credit';
  return (
    <div className="s6-overlay top" role="dialog" aria-modal="true" aria-label={`Bank statement line · ${line.person}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="s6-modal narrow">
        <div className="s6-modal-head">
          <div>
            <h3>Bank statement line · {line.person}</h3>
            <div className="s6-sub">{line.account} · {fmtD(line.date)}</div>
          </div>
          <button type="button" className="s6-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="s6-modal-body">
          <div className="s6-kv">
            <div className="s6-kv-row"><span>Date on the statement</span><span className="s6-mono">{fmtD(line.date)}</span></div>
            <div className="s6-kv-row"><span>Account</span><span>{line.account}</span></div>
            <div className="s6-kv-row"><span>Narration</span><span className="s6-mono">{line.description || '—'}</span></div>
            <div className="s6-kv-row"><span>Reference</span><span className="s6-mono">{line.reference || '—'}</span></div>
            <div className="s6-kv-row"><span>{out ? 'Money out' : 'Money in'}</span><span className={`s6-mono ${out ? 's6-red' : 's6-green'}`}>{money2(line.amount)}</span></div>
            <div className="s6-kv-row"><span>Balance after</span><span className="s6-mono">{line.balance == null ? 'not printed on the statement' : money2(line.balance)}</span></div>
            <div className="s6-kv-row"><span>Filed as</span><span>{line.person} · {out ? 'money we gave or repaid' : 'money we took by hand'}</span></div>
            <div className="s6-kv-row"><span>Amount</span><span className="s6-mono">{money2(line.amount)}</span></div>
          </div>
          <div className="s6-dash green" style={{ marginBottom: 0 }}>
            <span>
              <b>This is the proof.</b> The money moved on this line and it is filed against {line.person} — the statement is the record.
            </span>
          </div>
        </div>
        <div className="s6-modal-foot">
          <button type="button" className="s6-btn s6-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function HandLoans({ canManage, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState(null); // null | { loan, preset }
  const [busy, setBusy] = useState(false);
  const [person, setPerson] = useState(''); // "Month by month" on one person
  const [viewLine, setViewLine] = useState(null);

  const load = useCallback(() => {
    api.get('/bank/hand-loans').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Hand loans could not be loaded.'));
  }, []);
  useEffect(load, [load]);

  // Esc closes the popup (unless a form or the line on top of it is open).
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !form && !viewLine) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [form, viewLine, onClose]);

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

  // Person by person: every hand entry, plus the people money went to with no entry.
  const people = useMemo(() => {
    if (!data) return [];
    const m = new Map();
    data.loans.forEach((l) => {
      const k = personOf(l);
      const p = m.get(k) || { name: k, entries: 0, taken: 0, cleared: 0, pending: 0, accounts: new Set(), last: null, noEntry: false };
      p.entries += 1;
      p.taken += l.amount;
      p.cleared += l.repaid;
      p.pending += l.pending;
      [l.dateTaken, ...(l.repayments || []).map((x) => x.date)].forEach((d) => { if (d && (!p.last || d > p.last)) p.last = d; });
      m.set(k, p);
    });
    (data.movements || []).forEach((mv) => {
      const loan = data.loans.find((l) => l.id === mv.loanId);
      const p = loan && m.get(personOf(loan));
      if (p && mv.account) p.accounts.add(mv.account);
    });
    (data.unentered || []).forEach((u) => {
      m.set(`~${u.name}`, {
        name: u.name, entries: 0, taken: 0, cleared: u.out, pending: 0, accounts: new Set(u.account ? u.account.split(', ') : []), last: u.last, noEntry: true,
      });
    });
    return [...m.values()].sort((a, b) => (b.noEntry - a.noEntry) || (b.pending - a.pending) || a.name.localeCompare(b.name));
  }, [data]);

  // Every month: what we took, what we cleared, what was left after it.
  const months = useMemo(() => {
    if (!data) return [];
    const loans = data.loans.filter((l) => !person || personOf(l) === person);
    const ids = new Set(loans.map((l) => l.id));
    const m = new Map();
    const at = (k) => { if (!m.has(k)) m.set(k, { key: k, entries: 0, taken: 0, cleared: 0 }); return m.get(k); };
    loans.forEach((l) => { const r = at(monthKey(l.dateTaken)); r.entries += 1; r.taken += l.amount; });
    (data.movements || []).filter((mv) => ids.has(mv.loanId) && mv.kind === 'repayment').forEach((mv) => {
      const r = at(monthKey(mv.date)); r.entries += 1; r.cleared += mv.amount;
    });
    let left = 0;
    const asc = [...m.values()].sort((a, b) => a.key.localeCompare(b.key)).map((r) => {
      left = Math.max(0, left + r.taken - r.cleared);
      return { ...r, left };
    });
    return asc.reverse();
  }, [data, person]);
  const maxMonth = Math.max(1, ...months.map((r) => r.taken + r.cleared));
  const movements = (data?.movements || []).filter((mv) => !person || personOf(data.loans.find((l) => l.id === mv.loanId) || {}) === person);
  const unentered = data?.unentered || [];

  return (
    <div className="s6-overlay" role="dialog" aria-modal="true" aria-label="Hand loans" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="s6-modal">
        <div className="s6-modal-head">
          <div>
            <h3>Hand loans — taken, cleared, still to clear</h3>
            {s && <div className="s6-sub">Taken {money(s.taken)} · cleared {money(s.repaid)} · {money(s.paidOutNoEntry)} paid out with no entry behind it</div>}
          </div>
          <button type="button" className="s6-x" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="s6-modal-body">
          {error && <div className="s6-dash red" role="alert"><span>{error}</span></div>}
          {note && <div className="s6-dash green" role="status"><span>{note}</span></div>}
          {!data && !error && <div className="s6-sub">Loading…</div>}

          {data && (
            <>
              <div className="s6-section-row" style={{ marginTop: 0 }}>
                {canManage
                  ? <button type="button" className="s6-btn s6-primary" onClick={() => setForm({ loan: null })}>+ Hand entry — I took money from someone</button>
                  : <span />}
                <span className="s6-sub">
                  {s.loans} entr{s.loans === 1 ? 'y' : 'ies'} · {people.length} person(s) · {s.accounts} account(s)
                </span>
              </div>

              {unentered.length > 0 && (
                <div className="s6-dash amber">
                  <span>
                    <b>{unentered.length} person(s) have money going out but no hand entry saying what was taken.</b>
                    {' '}Until the entry is there, the app can only show what went out — it cannot show how much is left.
                  </span>
                  {canManage && (
                    <div className="s6-name-pills">
                      {unentered.slice(0, 4).map((u) => (
                        <button key={u.name} type="button" className="s6-pill-btn" onClick={() => setForm({ loan: null, preset: { name: u.name, lender: u.name } })}>
                          + {u.name} — add what was taken
                        </button>
                      ))}
                      {unentered.length > 4 && <span className="s6-sub" style={{ alignSelf: 'center' }}>+{unentered.length - 4} more in the table below</span>}
                    </div>
                  )}
                </div>
              )}

              <div className="s6-stats">
                <div className="s6-stat"><div className="s6-label">1 · Taken by hand</div><div className="v">{money(s.taken)}</div><div className="c">money that came into the account</div></div>
                <div className="s6-stat green"><div className="s6-label">2 · Cleared so far</div><div className="v s6-green">{money(s.repaid)}</div><div className="c">paid back out of the account</div></div>
                <div className="s6-stat red"><div className="s6-label">3 · Still to clear</div><div className="v s6-red">{money(s.pending)}</div><div className="c">{money(s.paidOutNoEntry)} paid out with no entry behind it</div></div>
                <div className="s6-stat"><div className="s6-label">Picked up on its own</div><div className="v">{s.auto}</div><div className="c">matched from the statement, nothing pressed</div></div>
              </div>

              <div className="s6-section-row">
                <div>
                  <h4 className="s6-h3">Every month{person ? ` · ${person}` : ''}</h4>
                  <div className="s6-sub">what we took, what we cleared that month, and what was left after it</div>
                </div>
                {person && <button type="button" className="s6-btn sm" onClick={() => setPerson('')}>Show everybody</button>}
              </div>
              <div className="s6-tbl fixed" style={{ marginBottom: 8 }}>
                <table style={{ minWidth: 760 }}>
                  <thead>
                    <tr><th className="sort">Month</th><th className="num">Taken that month</th><th className="num">Cleared that month</th><th className="num">Still to clear after it</th><th>How the month looked</th></tr>
                  </thead>
                  <tbody>
                    {months.map((r) => (
                      <tr key={r.key}>
                        <td><span className="s6-mono">{monthName(r.key)}</span><div className="s6-cell-sub">{r.entries} entr{r.entries === 1 ? 'y' : 'ies'}</div></td>
                        <td className="num s6-mono">{r.taken ? money(r.taken) : '—'}</td>
                        <td className="num s6-mono s6-green">{r.cleared ? money(r.cleared) : '—'}</td>
                        <td className="num s6-mono s6-red">{money(r.left)}</td>
                        <td>
                          <div className="s6-bar">
                            <span className="s6-bar-track">
                              <span className="s6-bar-fill green" style={{ width: `${(r.cleared / maxMonth) * 100}%` }} />
                              <span className="s6-bar-fill red" style={{ width: `${(r.taken / maxMonth) * 100}%` }} />
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!months.length && <tr><td colSpan="5" className="bks-empty">No hand entry yet — press <b>+ Hand entry</b> when you take money from someone.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="s6-legend" style={{ marginBottom: 16 }}>
                <span><i style={{ background: 'var(--s6-green)' }} />cleared that month</span>
                <span><i style={{ background: 'var(--s6-red)' }} />taken that month</span>
              </div>

              <h4 className="s6-h3">Person by person</h4>
              <div className="s6-sub" style={{ marginBottom: 8 }}>press Month by month on anybody to see only their months</div>
              <div className="s6-tbl fixed" style={{ marginBottom: 16 }}>
                <table style={{ minWidth: 1040 }}>
                  <thead>
                    <tr>
                      <th className="sort">Person</th><th className="num">Entries</th><th className="num">Taken by hand</th><th className="num">Cleared so far</th>
                      <th className="num">Still to clear</th><th>Which account</th><th>Last movement</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={`${p.noEntry ? '~' : ''}${p.name}`}>
                        <td className="s6-cell-main">{p.name}</td>
                        <td className="num s6-mono">{p.entries}</td>
                        <td className="num s6-mono">{p.taken ? money(p.taken) : '—'}</td>
                        <td className="num s6-mono s6-green">{p.cleared ? money(p.cleared) : '—'}</td>
                        <td className="num">
                          {p.noEntry
                            ? <span className="s6-pill amber">no hand entry yet</span>
                            : <span className={`s6-mono ${p.pending > 0.5 ? 's6-red' : 's6-green'}`}>{p.pending > 0.5 ? money(p.pending) : 'cleared'}</span>}
                        </td>
                        <td className="s6-mono">{[...p.accounts].join(', ') || '—'}</td>
                        <td className="s6-mono">{p.last ? fmtD(p.last) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canManage && (
                            <button type="button" className="s6-btn sm s6-gold" onClick={() => setForm({ loan: null, preset: { name: p.name, lender: p.name } })}>+ What was taken</button>
                          )}
                          {' '}
                          {!p.noEntry && <button type="button" className="s6-btn sm" onClick={() => setPerson(p.name)}>Month by month</button>}
                        </td>
                      </tr>
                    ))}
                    {!people.length && <tr><td colSpan="8" className="bks-empty">Nobody yet — hand entries and the people paid by hand show here.</td></tr>}
                  </tbody>
                </table>
              </div>

              <h4 className="s6-h3">Every movement{person ? ` · ${person}` : ''}</h4>
              <div className="s6-sub" style={{ marginBottom: 8 }}>each one carries the statement line it came off</div>
              <div className="s6-tbl fixed" style={{ marginBottom: 16 }}>
                <table style={{ minWidth: 1040 }}>
                  <thead>
                    <tr><th className="sort">Date</th><th>Person</th><th>What happened</th><th>Account</th><th className="num">Amount</th><th>Proof</th><th /></tr>
                  </thead>
                  <tbody>
                    {movements.map((mv) => {
                      const repaid = mv.kind === 'repayment';
                      return (
                        <tr key={mv.linkId}>
                          <td className="s6-mono">{fmtD(mv.date)}</td>
                          <td className="s6-cell-main">{mv.lender || mv.person}</td>
                          <td style={{ minWidth: 260 }}>
                            <span className={`s6-pill ${repaid ? 'green' : 'navy'}`}>{repaid ? 'Cleared — paid back' : 'Taken by hand'}</span>
                            <div className="s6-sub" style={{ marginTop: 4 }}>From the statement — {String(mv.description || '').slice(0, 90)}</div>
                          </td>
                          <td className="s6-mono">{mv.account}</td>
                          <td className={`num s6-mono ${repaid ? 's6-green' : ''}`}>{repaid ? '- ' : '+ '}{money(mv.amount)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span className="s6-pill green">Bank statement</span>{' '}
                            <button type="button" className="s6-btn sm" onClick={() => setViewLine({ ...mv, person: mv.lender || mv.person })}>View line</button>
                          </td>
                          <td>
                            {canManage && (
                              <button type="button" className="s6-btn sm s6-danger" disabled={busy} onClick={() => run(() => api.delete(`/bank/hand-loans/links/${mv.linkId}`), () => 'Removed — the line is back under Uncategorised; the statement itself is untouched.')}>
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!movements.length && <tr><td colSpan="7" className="bks-empty">No movement linked yet — they are picked up from the statement as it is imported.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="s6-section-row">
                <div>
                  <h4 className="s6-h3">Each hand entry</h4>
                  <div className="s6-sub">edit an entry, confirm a line the app was not sure about, or run the matching again</div>
                </div>
                {canManage && (
                  <button type="button" className="s6-btn" disabled={busy} onClick={() => run(() => api.post('/bank/hand-loans/auto-match'), (d) => (d.linked ? `${d.linked} statement line(s) linked as proof.` : 'Nothing new to link — every clear line is already linked.'))}>⟳ Match statement lines</button>
                )}
              </div>
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
                            ? <span className="s6-pill green">Cleared · {fmtD(l.clearedDate)}</span>
                            : <span className="s6-pill red">{money2(l.pending)} still to clear</span>}
                        </h3>
                        <div className="bkl-sub">
                          {l.lender ? `${l.lender} · ` : ''}{money2(l.amount)} taken on {fmtD(l.dateTaken)}
                          {l.notes ? ` · ${l.notes}` : ''}
                        </div>
                      </div>
                      {canManage && (
                        <div className="bkl-acts">
                          <button type="button" className="s6-btn sm" onClick={() => setForm({ loan: l })}>Edit</button>
                          <button
                            type="button"
                            className="s6-btn sm s6-danger"
                            disabled={busy}
                            onClick={() => { if (window.confirm(`Remove ${l.name}? Its statement lines go back to uncategorised; the statement itself is not touched.`)) run(() => api.delete(`/bank/hand-loans/${l.id}`), () => 'Loan removed.'); }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                    {l.taken ? (
                      <div className="s6-sub">
                        Taken on the statement: <b>{money2(l.taken.amount)}</b> on {fmtD(l.taken.date)}
                        {l.taken.reference ? ` · Ref ${l.taken.reference}` : ''}{l.taken.auto ? ' · linked automatically' : ''}
                        {canManage && <> {' '}<button type="button" className="s6-btn s6-link" disabled={busy} onClick={() => run(() => api.delete(`/bank/hand-loans/links/${l.taken.linkId}`), () => 'Unlinked.')}>Unlink</button></>}
                      </div>
                    ) : <div className="s6-sub">No statement line is linked for the taking yet.</div>}
                    {(l.toLink.length > 0 || l.possible.length > 0) && (
                      <>
                        <div className="bkl-h">Possible matches — confirm to link</div>
                        <div className="s6-tbl">
                          <table style={{ minWidth: 640 }}>
                            <thead><tr><th>Statement date</th><th>Reference</th><th className="num">Amount</th><th>Why</th>{canManage && <th />}</tr></thead>
                            <tbody>
                              {[...l.toLink, ...l.possible].map((x) => (
                                <tr key={x.txnId}>
                                  <td className="s6-mono">{fmtD(x.date)}</td>
                                  <td className="s6-mono">{x.reference || '—'}</td>
                                  <td className="num s6-mono">{x.type === 'Credit' ? '+' : '−'}{money2(x.amount)}</td>
                                  <td className="s6-sub">{x.why}<div>{String(x.description || '').slice(0, 80)}</div></td>
                                  {canManage && (
                                    <td>
                                      <button type="button" className="s6-btn sm s6-primary" disabled={busy} onClick={() => run(() => api.post(`/bank/hand-loans/${l.id}/link`, { bankTxnId: x.txnId }), (d) => (d.cleared ? `Linked — ${l.name} is cleared (${fmtD(d.clearedDate)}).` : `Linked — ${money2(d.pending)} still pending.`))}>
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
        </div>

        <div className="s6-modal-foot">
          <button type="button" className="s6-btn s6-primary" onClick={onClose}>Close</button>
        </div>
      </div>

      {form && (
        <LoanForm
          loan={form.loan}
          preset={form.preset}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); setNote(msg); load(); onChanged?.(); }}
        />
      )}
      {viewLine && <ViewLine line={viewLine} onClose={() => setViewLine(null)} />}
    </div>
  );
}

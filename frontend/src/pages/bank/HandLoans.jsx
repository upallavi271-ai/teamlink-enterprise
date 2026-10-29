// HAND LOANS (Accounts spec 3 part 4; S6 popup) — opened from Bank & Reconciliation.
// A loan is money borrowed from a person: the taking is a credit line on the
// statement, each repayment a debit line. Lines whose narration clearly names
// the loan (its name or the lender) with an amount that fits are linked as
// proof automatically (on import, and whenever a loan is saved); anything less
// certain is listed under "Possible matches" to confirm. Per loan: the amount
// and date taken, the repayments, total repaid, what is pending, and a Cleared
// tag with the date once nothing is pending. GET/POST /bank/hand-loans…
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import { money, money2, fmtD, todayIso } from '../invoices/invFormat';
import BankLineModal from './BankLineModal.jsx';
import {
  entriesOfPerson, entryProblems, localToday, pickerRows, reasonProblem, removeBlock, REASON_CHIPS,
} from './handLoanActions.js';
import './bank.css';
import './bank-s6.css';
import './handLoanActions.css';

function LoanForm({
  loan, preset, facts, onClose, onSaved,
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
    if (busy) return;
    const e = entryProblems(f);
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setFail('');
    try {
      const body = { ...f, amount: Number(String(f.amount).replace(/[,\s]/g, '')) };
      if (loan) body.expectedUpdatedAt = loan.updatedAt;
      const r = loan ? await api.put(`/bank/hand-loans/${loan.id}`, body) : await api.post('/bank/hand-loans', body);
      onSaved(`${loan ? (r.data.unchanged ? 'Nothing was changed' : `Entry updated - ${f.name.trim()}`) : 'Loan added'}${r.data.linked ? ` — ${r.data.linked} statement line(s) linked as proof` : ''}.`);
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
        <label className="field"><span>Loan name</span>
          <input value={f.name} onChange={set('name')} placeholder="e.g. Ravi hand loan" aria-invalid={!!errs.name} />
          {errs.name && <div className="bkp-err">{errs.name}</div>}
        </label>
        <label className="field"><span>Lender / party</span>
          <input value={f.lender} onChange={set('lender')} placeholder="As the name reads on the statement" />
        </label>
        <label className="field"><span>Amount taken (₹)</span>
          <input inputMode="decimal" value={f.amount} onChange={set('amount')} aria-invalid={!!errs.amount} />
          {errs.amount && <div className="bkp-err">{errs.amount}</div>}
        </label>
        <label className="field"><span>Date taken</span>
          <input type="date" value={f.dateTaken} max={localToday()} onChange={set('dateTaken')} aria-invalid={!!errs.dateTaken} />
          {errs.dateTaken && <div className="bkp-err">{errs.dateTaken}</div>}
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span>Notes</span>
          <textarea rows="2" value={f.notes} onChange={set('notes')} />
        </label>
      </div>
      {loan && facts && (
        <div className="hla-facts">
          <div><b>Paid back so far:</b> {money2(facts.repaid)}{facts.repayments ? ` in ${facts.repayments} repayment${facts.repayments === 1 ? '' : 's'}` : ''}. <b>Still to clear:</b> {money2(facts.pending)}.</div>
          <div><b>Account:</b> {facts.accounts.length ? facts.accounts.join(', ') : 'no statement line is linked yet'}.</div>
          <div>The account, the repayments and the statement lines come from the bank statement, so they are not edited here. To change one, use Unlink or Remove on it under Every movement.</div>
        </div>
      )}
      <div className="small-muted" style={{ marginTop: 6 }}>
        Statement lines whose narration carries the loan name or the lender are linked as proof: the credit it was taken on, then
        every repayment. Anything less certain waits under Possible matches for you to confirm.
      </div>
      {fail && <div className="notice red" style={{ marginTop: 10 }}><span>{fail}</span></div>}
    </Modal>
  );
}

// ---- the Edit / Remove buttons beside the heading ---------------------------------------------------------------
const PencilIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
  </svg>
);

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])';

// A small window on top of the Hand loans popup: Escape closes it, Tab stays inside it.
function Sheet({
  title, sub, onClose, children, footer, label,
}) {
  const box = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return createPortal(
    <div className="s6-overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="s6-modal narrow" role="dialog" aria-modal="true" aria-label={label || title}>
        <div className="s6-modal-head">
          <div style={{ minWidth: 0 }}>
            <h3>{title}</h3>
            {sub && <div className="s6-sub">{sub}</div>}
          </div>
          <button type="button" className="s6-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="s6-modal-body">{children}</div>
        {footer && <div className="s6-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// "Which entry?" - one row per hand entry (date, amount, what it says), so the right one is picked when a person has
// several. Picking opens the Edit form or the Remove window for exactly that entry.
function EntryPicker({
  mode, loans, onPick, onClose,
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => pickerRows(loans, q), [loans, q]);
  const edit = mode === 'edit';
  return (
    <Sheet
      title={edit ? 'Which entry do you want to edit?' : 'Which entry do you want to remove?'}
      sub="Press the entry. Date, amount and the note are shown so you pick the right one."
      onClose={onClose}
      footer={<button type="button" className="s6-btn" onClick={onClose}>Cancel</button>}
    >
      <input
        className="hla-search"
        autoFocus
        placeholder="Type a name, amount or date to find it…"
        aria-label="Find an entry"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="hla-list" role="list">
        {rows.map((l) => {
          const many = entriesOfPerson(loans, l);
          return (
            <button key={l.id} type="button" role="listitem" className="hla-pick" onClick={() => onPick(l)}>
              <div className="hla-pick-top">
                <span className="hla-pick-name">{l.name}</span>
                <span className="hla-pick-amt">{money2(l.amount)}</span>
              </div>
              <div className="hla-pick-sub">
                {l.lender ? `${l.lender} · ` : ''}taken on {fmtD(l.dateTaken)} ·{' '}
                {l.cleared ? 'cleared' : `${money2(l.pending)} still to clear`}
                {many > 1 ? ` · ${many} entries for this person` : ''}
              </div>
              <div className="hla-pick-note">{l.notes ? l.notes : <span className="s6-sub">no note</span>}</div>
            </button>
          );
        })}
        {!rows.length && <div className="hla-empty">{loans.length ? 'No entry matches that. Clear the box to see all.' : 'There is no hand entry yet.'}</div>}
      </div>
    </Sheet>
  );
}

// Remove: show exactly which entry, ask why, and only then remove it. The entry is kept in the removed list with the
// reason, who and when - nothing is lost. An entry that still has statement lines linked cannot be removed yet.
function RemoveDialog({ loan, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [fail, setFail] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = removeBlock(loan);
  const bad = touched ? reasonProblem(reason) : null;

  const confirm = async () => {
    if (busy) return;
    setTouched(true);
    if (reasonProblem(reason)) return;
    setBusy(true); setFail('');
    try {
      const r = await api.delete(`/bank/hand-loans/${loan.id}`, { data: { reason: reason.trim() } });
      onDone(r.data.already ? `${loan.name} was already removed.` : `Removed ${loan.name}. It is kept in the removed list with your reason.`);
    } catch (e) {
      setFail(e.response?.data?.error || 'The entry could not be removed.');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Remove ${loan.name}?`}
      sub="Check that this is the right entry."
      label="Remove a hand entry"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button type="button" className="s6-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="hla-btn solid-red" disabled={busy || !!blocked} onClick={confirm}>{busy ? 'Removing…' : 'Confirm Remove'}</button>
        </>
      )}
    >
      <div className="s6-kv dashed">
        <div className="s6-kv-row"><span>Name</span><span>{loan.name}</span></div>
        {loan.lender && <div className="s6-kv-row"><span>Lender / party</span><span>{loan.lender}</span></div>}
        <div className="s6-kv-row"><span>Amount taken</span><span className="s6-mono">{money2(loan.amount)}</span></div>
        <div className="s6-kv-row"><span>Date taken</span><span className="s6-mono">{fmtD(loan.dateTaken)}</span></div>
        <div className="s6-kv-row"><span>Paid back so far</span><span className="s6-mono">{money2(loan.repaid)}</span></div>
        <div className="s6-kv-row"><span>Still to clear</span><span className="s6-mono">{loan.cleared ? 'cleared' : money2(loan.pending)}</span></div>
        {loan.notes && <div className="s6-kv-row"><span>Note</span><span>{loan.notes}</span></div>}
      </div>
      {blocked ? (
        <div className="s6-dash amber" role="alert"><span><b>It cannot be removed yet.</b> {blocked}</span></div>
      ) : (
        <>
          <div className="s6-dash bkl-note blue" style={{ marginBottom: 0 }}>
            <span>The entry goes to the removed list at the bottom of this window, with your reason, your name and the time. Totals update at once. The bank statement is not touched.</span>
          </div>
          <label className="hla-label" htmlFor="hla-reason">Why are you removing it?</label>
          <input
            id="hla-reason"
            className="hla-reason"
            autoFocus
            maxLength={300}
            value={reason}
            aria-invalid={!!bad}
            placeholder="A few words, e.g. entered by mistake"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          />
          {bad && <div className="hla-err">{bad}</div>}
          <div className="hla-chips">
            {REASON_CHIPS.map((c) => <button key={c} type="button" className="s6-pill-btn" style={{ height: 28, fontSize: 12 }} onClick={() => setReason(c)}>{c}</button>)}
          </div>
        </>
      )}
      {fail && <div className="s6-dash red" role="alert" style={{ marginTop: 12, marginBottom: 0 }}><span>{fail}</span></div>}
    </Sheet>
  );
}

// Remove on a person with NO hand entry (founder 2026-10-29): the only thing there is the hand loan label on the statement
// lines paid to them. Remove takes that label off each filed line (the same Undo as on the statement); the lines themselves
// stay, back under Uncategorised. Lines the app only guessed from the narration are not filed, so nothing is done to them.
function UnfileDialog({ person, onClose, onDone }) {
  const filed = person.lines.filter((x) => x.filed);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const confirm = async () => {
    if (busy) return;
    setBusy(true); setFail('');
    let done = 0;
    for (const x of filed) {
      try { await api.post(`/bank/${x.txnId}/uncategorise`); done += 1; } catch (e) { setFail(e.response?.data?.error || 'A line could not be changed.'); }
    }
    if (done === filed.length) onDone(`Took the hand loan label off ${done} line${done === 1 ? '' : 's'} paid to ${person.name}. They are back under Uncategorised.`);
    else setBusy(false);
  };
  return (
    <Sheet
      title={`Remove ${person.name} from hand loans?`}
      sub={`${filed.length} statement line${filed.length === 1 ? ' is' : 's are'} filed as a hand loan to ${person.name}.`}
      label="Remove a person from hand loans"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button type="button" className="s6-btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="hla-btn solid-red" disabled={busy || !filed.length} onClick={confirm}>{busy ? 'Removing…' : 'Confirm Remove'}</button>
        </>
      )}
    >
      <div className="s6-tbl" style={{ marginBottom: 10 }}>
        <table style={{ minWidth: 520 }}>
          <thead><tr><th>Date</th><th>Narration</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {filed.map((x) => (
              <tr key={x.txnId}><td className="s6-mono">{fmtD(x.date)}</td><td className="s6-sub">{String(x.description || '').slice(0, 80)}</td><td className="num s6-mono">{money2(x.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="s6-dash bkl-note blue" style={{ marginBottom: 0 }}>
        <span>The lines stay on the statement - only the hand loan label comes off, and they go back under Uncategorised. You can file them again any time.</span>
      </div>
      {fail && <div className="s6-dash red" role="alert" style={{ marginTop: 12, marginBottom: 0 }}><span>{fail}</span></div>}
    </Sheet>
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

// The statement line behind one movement — the proof (S6 "View line"). It is the SAME window as the Bank
// statements table's (BankLineModal.jsx); a hand-loan line is filed as the loan, so the facts are known here.
export function ViewLine({ line, onClose }) {
  const out = line.type !== 'Credit';
  const m = /^(.*?)\s*·\s*(\d{4})$/.exec(String(line.account || ''));
  const bankName = m ? m[1] : (line.account && line.account !== '—' ? line.account : null);
  const amount = Number(line.amount) || 0;
  const detail = {
    direction: out ? 'out' : 'in',
    date: line.date,
    narration: line.description || null,
    moneyOut: out ? amount : null,
    moneyIn: out ? null : amount,
    balanceAfter: line.balance == null ? null : Number(line.balance),
    bank: { name: bankName, account: m ? `xxxx${m[2]}` : null },
    filedAs: { kind: 'loan', label: `Hand loan · ${line.person}` },
    amountFiled: amount,
    unallocated: null,
  };
  return (
    <BankLineModal
      row={{ id: line.txnId, txnDate: line.date, description: line.description }}
      bank={null}
      detail={detail}
      extraRows={[['Reference', <span className="s6-mono">{line.reference || '—'}</span>]]}
      onClose={onClose}
    />
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
  const [pick, setPick] = useState(null); // null | { mode: 'edit' | 'remove', loans } - the "which entry?" window
  const [removeFor, setRemoveFor] = useState(null); // the entry the Remove window is about
  const [unfileFor, setUnfileFor] = useState(null); // a person with no entry: the lines filed as hand loan to them

  const load = useCallback(() => {
    api.get('/bank/hand-loans').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Hand loans could not be loaded.'));
  }, []);
  useEffect(load, [load]);

  // Esc closes the popup (unless a form or the line on top of it is open).
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !form && !viewLine && !pick && !removeFor && !unfileFor) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [form, viewLine, pick, removeFor, unfileFor, onClose]);

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

  // Edit / Remove beside the heading: one entry goes straight to its window; several ask which one first.
  // The same on each person's row (founder 2026-10-29), over only that person's entries.
  const startWith = (mode, loans) => {
    if (!loans.length) return;
    if (loans.length === 1) { if (mode === 'edit') setForm({ loan: loans[0] }); else setRemoveFor(loans[0]); return; }
    setPick({ mode, loans });
  };
  const startFromHead = (mode) => startWith(mode, data?.loans || []);
  const startForPerson = (mode, name) => startWith(mode, (data?.loans || []).filter((l) => personOf(l) === name));
  const chosen = (loan) => { const { mode } = pick; setPick(null); if (mode === 'edit') setForm({ loan }); else setRemoveFor(loan); };
  // What the Edit form shows about the entry (read only): what is paid back and which account the statement lines are on.
  const factsOf = (loan) => ({
    repaid: loan.repaid, pending: loan.pending, repayments: (loan.repayments || []).length,
    accounts: [...new Set((data?.movements || []).filter((mv) => mv.loanId === loan.id).map((mv) => mv.account).filter((a) => a && a !== '—'))],
  });
  const lf = useListFilters(data?.loans || [], LOAN_FIELDS, { sorts: LOAN_SORTS, keep: 'bank.handLoans' });

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
        name: u.name, entries: 0, taken: 0, cleared: u.out, pending: 0, accounts: new Set(u.account ? u.account.split(', ') : []), last: u.last, noEntry: true, lines: u.lines || [],
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
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="hla-title-row">
              <h3>Hand loans — taken, cleared, still to clear</h3>
              {canManage && (
                <div className="hla-acts">
                  <button type="button" className="hla-btn edit" disabled={!data || !data.loans.length || busy} title={data && !data.loans.length ? 'There is no hand entry to edit yet' : 'Change an entry'} onClick={() => startFromHead('edit')}>
                    <PencilIcon />Edit
                  </button>
                  <button type="button" className="hla-btn remove" disabled={!data || !data.loans.length || busy} title={data && !data.loans.length ? 'There is no hand entry to remove yet' : 'Remove an entry'} onClick={() => startFromHead('remove')}>
                    <TrashIcon />Remove
                  </button>
                </div>
              )}
            </div>
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
                          {canManage && !p.noEntry && (
                            <>
                              {' '}<button type="button" className="s6-btn sm" disabled={busy} title={`Change ${p.name}'s entry`} onClick={() => startForPerson('edit', p.name)}>Edit</button>
                              {' '}<button type="button" className="s6-btn sm s6-danger" disabled={busy} title={`Remove ${p.name}'s entry`} onClick={() => startForPerson('remove', p.name)}>Remove</button>
                            </>
                          )}
                          {canManage && p.noEntry && (
                            <>
                              {' '}
                              <button
                                type="button"
                                className="s6-btn sm s6-danger"
                                disabled={busy || !p.lines.some((x) => x.filed)}
                                title={p.lines.some((x) => x.filed) ? `Take the hand loan label off the lines paid to ${p.name}` : 'Nothing is filed - the app only guessed this from the narration'}
                                onClick={() => setUnfileFor(p)}
                              >
                                Remove
                              </button>
                            </>
                          )}
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
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {canManage && data.loans.some((l) => l.id === mv.loanId) && (
                              <><button type="button" className="s6-btn sm" disabled={busy} title="Change the hand entry this movement belongs to" onClick={() => setForm({ loan: data.loans.find((l) => l.id === mv.loanId) })}>Edit</button>{' '}</>
                            )}
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
                          <button type="button" className="s6-btn sm" disabled={busy} onClick={() => setForm({ loan: l })}>Edit</button>
                          <button
                            type="button"
                            className="s6-btn sm s6-danger"
                            disabled={busy}
                            onClick={() => setRemoveFor(l)}
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

              {(data.removed || []).length > 0 && (
                <details className="hla-removed">
                  <summary>Removed entries ({data.removed.length}) - kept for the record, not counted in any total</summary>
                  <div className="s6-tbl">
                    <table style={{ minWidth: 760 }}>
                      <thead><tr><th>Name</th><th className="num">Amount</th><th>Date taken</th><th>Removed on</th><th>By</th><th>Why</th></tr></thead>
                      <tbody>
                        {data.removed.map((x) => (
                          <tr key={x.id}>
                            <td className="s6-cell-main">{x.lender ? `${x.name} (${x.lender})` : x.name}</td>
                            <td className="num s6-mono">{money2(x.amount)}</td>
                            <td className="s6-mono">{fmtD(x.dateTaken)}</td>
                            <td className="s6-mono">{fmtD(x.removedAt)}</td>
                            <td>{x.removedByName || '—'}</td>
                            <td>{x.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
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
          facts={form.loan ? factsOf(form.loan) : null}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); setNote(msg); load(); onChanged?.(); }}
        />
      )}
      {viewLine && <ViewLine line={viewLine} onClose={() => setViewLine(null)} />}
      {pick && <EntryPicker mode={pick.mode} loans={pick.loans} onPick={chosen} onClose={() => setPick(null)} />}
      {unfileFor && (
        <UnfileDialog
          person={unfileFor}
          onClose={() => setUnfileFor(null)}
          onDone={(msg) => { setUnfileFor(null); setError(''); setNote(msg); load(); onChanged?.(); }}
        />
      )}
      {removeFor && (
        <RemoveDialog
          loan={removeFor}
          onClose={() => setRemoveFor(null)}
          onDone={(msg) => { setRemoveFor(null); setError(''); setNote(msg); load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}

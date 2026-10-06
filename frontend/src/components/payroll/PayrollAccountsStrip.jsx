// S3 (2026-10-05): the payroll month and Accounts — on HRMS → Payroll and in
// Accounts → Journal & Ledger → Payroll Mapping.
//
//   "Posted to Accounts" (green) / "Not posted" (grey) + the journal's voucher
//   no. and a link to it; "Post to Accounts" for a finalized month that is not
//   posted, with the reason it failed; "Re-open to correct" (books a
//   reversal); "Mark salary paid" (Dr Salary Payable / Cr the bank).
// The API decides who may press what; buttons are shown from `access`.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { money, monthLabel, errText } from './payrollUi';
import '../accounts/ledgerBooks.css';

function PayModal({ month, net, onClose, onDone }) {
  const [banks, setBanks] = useState([]);
  const [bank, setBank] = useState('');
  const [cands, setCands] = useState([]);
  const [txn, setTxn] = useState('');
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/payroll/runs/${month}/bank-matches${bank ? `?bankAccountId=${bank}` : ''}`).then((r) => {
      setBanks(r.data.banks || []);
      setCands(r.data.candidates || []);
      setTxn(r.data.suggested || '');
    }).catch((err) => setError(errText(err, 'Could not load the bank lines.')));
  }, [month, bank]);
  async function go() {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/payroll/runs/${month}/mark-paid`, {
        bankAccountId: bank || undefined, bankTransactionId: txn || undefined, paidDate, reference: reference || undefined,
      });
      onDone(`Saved — salary for ${monthLabel(month)} is paid (${r.data.voucherNo || 'journal booked'}).`);
    } catch (err) { setError(errText(err, 'Could not mark the salary paid.')); } finally { setBusy(false); }
  }
  const chosen = cands.find((c) => c.id === txn);
  return (
    <Modal
      title={`Mark salary paid — ${monthLabel(month)}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={go}>{busy ? 'Saving…' : `Mark paid · ${money(net)}`}</button>
        </>
      )}
    >
      <div className="lb-note">Books one entry in Accounts: <b>Dr Salary Payable / Cr the bank</b> for the month&apos;s net pay. It then shows in the bank&apos;s ledger, and the statement line (if you pick it) is matched in Bank &amp; Reconciliation.</div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Paid from which bank</label>
          <select value={bank} onChange={(e) => setBank(e.target.value)}>
            <option value="">The default bank ledger</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Paid on</label><input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} /></div>
      </div>
      <div className="field">
        <label>Bank statement line (optional)</label>
        <select value={txn} onChange={(e) => setTxn(e.target.value)}>
          <option value="">— Not on a statement yet —</option>
          {cands.map((t) => <option key={t.id} value={t.id}>{t.date} · {t.description} · {money(t.amount)}</option>)}
        </select>
        {cands.length === 0 && <div className="lb-note">No unmatched bank debit of exactly {money(net)} on file{bank ? ' for this bank' : ''} yet. You can still mark it paid and match the line later.</div>}
        {chosen && <div className="lb-note">The date of the statement line is used when you leave “Paid on” as it is.</div>}
      </div>
      <div className="field"><label>Bank reference (optional)</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / batch no." /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function PayrollAccountsStrip({ month, reloadKey = 0, onChanged = () => {}, compact = false }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  function load() {
    api.get(`/payroll/runs/${month}/accounts`).then((r) => setSt(r.data)).catch((err) => setError(errText(err, 'Could not load the Accounts status.')));
  }
  useEffect(() => { setMsg(''); setError(''); load(); }, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return error ? <div className="lb-err">{error}</div> : null;
  if (!st.records) return null;
  const a = st.access || {};
  async function post() {
    setBusy('post'); setMsg(''); setError('');
    try {
      const r = await api.post(`/payroll/runs/${month}/post`);
      setMsg(r.data.already ? 'Already posted — nothing changed.' : `Saved — ${monthLabel(month)} is posted to Accounts (${r.data.voucherNo}).`);
    } catch (err) { setError(errText(err, 'Could not post to Accounts.')); } finally { setBusy(''); load(); onChanged(); }
  }
  async function reopen() {
    const reason = window.prompt(`Why are you re-opening ${monthLabel(month)}? The posted journal will be reversed and the records go back to Draft.`);
    if (!reason) return;
    setBusy('reopen'); setMsg(''); setError('');
    try {
      const r = await api.post(`/payroll/runs/${month}/reopen`, { reason });
      setMsg(`Re-opened — ${r.data.moved} record(s) are Draft again.${r.data.voucherNo ? ` Reversal ${r.data.voucherNo} booked.` : ''} Fix them, then approve again to post a new journal.`);
    } catch (err) { setError(errText(err, 'Could not re-open the month.')); } finally { setBusy(''); load(); onChanged(); }
  }
  const je = st.journalEntry;
  return (
    <div className="lb-wrap">
      <div className="lb-strip">
        <div className="lb-what">
          <b>Accounts:</b>{' '}
          {st.posted ? <span className="lb-badge green">Posted to Accounts</span> : <span className="lb-badge grey">Not posted</span>}
          {st.paid && <> <span className="lb-badge green">Salary paid</span></>}
          {je && (
            <span className="lb-note">
              {' '}{st.voucherNo} · {je.date} · {money(je.totalDebit)}
              {a.ledger && <> · <Link to={`/accounts/journal?je=${je.id}`}>Open in the journal</Link></>}
            </span>
          )}
          {!st.posted && !compact && <div className="lb-note">{st.blockReason || (st.canPost ? 'Every record is approved — the month is ready to post.' : '')}</div>}
        </div>
        <div className="lb-actions">
          {st.canPost && (a.approve || a.post) && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={post}>{busy === 'post' ? 'Posting…' : 'Post to Accounts'}</button>}
          {st.posted && !st.paid && a.post && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setPaying(true)}>Mark salary paid</button>}
          {!st.paid && (st.posted || st.finalized) && (a.approve || a.post) && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={reopen}>{busy === 'reopen' ? 'Re-opening…' : 'Re-open to correct'}</button>}
        </div>
      </div>
      {st.lastError && !st.posted && <div className="lb-err"><b>Not posted:</b> {st.lastError}</div>}
      {error && <div className="lb-err">{error}</div>}
      {msg && <div className="lb-ok">{msg}</div>}
      {paying && <PayModal month={month} net={st.net} onClose={() => setPaying(false)} onDone={(m) => { setPaying(false); setMsg(m); load(); onChanged(); }} />}
    </div>
  );
}

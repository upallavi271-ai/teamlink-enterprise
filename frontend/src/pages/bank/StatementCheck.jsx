import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import './statementCheck.css';
import {
  statusCards, displayStatus, rowTone, canChoose, importPlan, retryPlan, summaryItems,
} from './stmtStatus.js';

// ---------------------------------------------------------------------------
// STATEMENTS MATCHING - the status strip + the list of every uploaded transaction.
//
// Shown inside the bank statement import window, between choosing the file and pressing Import, and again after the import.
// The server did the checking (backend/src/utils/bankStatementDedupe.js); this only shows its answer:
//
//   Total Statements | Already Imported | Not Imported | Duplicate in Current Upload | Needs Review | Newly Imported | Failed
//
// Each card is a button: it shows just those rows. A row that needs a person (Needs Review, or a repeat inside the file)
// has two plain choices: "Import anyway" or "Leave it out". Nothing is imported until Import New Transactions is pressed.
// ---------------------------------------------------------------------------

const inr = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const PAGE = 50;

export function StatusStrip({ counts, filter, onFilter }) {
  const cards = statusCards(counts);
  return (
    <div className="sc-strip" role="group" aria-label="Uploaded transactions by status">
      {cards.map((c) => {
        const on = (filter || '') === c.filter && (c.filter !== '' || !filter);
        return (
          <button
            key={c.key}
            type="button"
            className={`sc-card sc-${c.tone}${on ? ' on' : ''}`}
            aria-pressed={on}
            onClick={() => onFilter && onFilter(on && c.filter !== '' ? '' : c.filter)}
            title={c.help}
          >
            <span className="sc-num">{c.value}</span>
            <span className="sc-label">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ImportSummary({ counts }) {
  const items = summaryItems(counts);
  return (
    <div className="sc-summary" role="status">
      {items.map((x) => (
        <div key={x.key} className="sc-sum-item"><b>{x.value}</b><span>{x.label}</span></div>
      ))}
    </div>
  );
}

export default function StatementCheck({
  batchId, counts, onCounts, refreshKey = 0, canDecide = true, initialFilter = '', onError,
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!batchId) return;
    const id = seq.current + 1;
    seq.current = id;
    setBusy(true);
    try {
      const r = await api.get(`/accounts-import/bank-batch/${batchId}/rows`, { params: { filter, page, limit: PAGE } });
      if (id === seq.current) { setData(r.data); setErr(''); }
    } catch (e) {
      if (id === seq.current) setErr(e.response?.data?.error || 'The list could not be loaded.');
    } finally { if (id === seq.current) setBusy(false); }
  }, [batchId, filter, page]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => { setPage(1); }, [filter, batchId]);
  useEffect(() => { setFilter(initialFilter); }, [initialFilter, batchId]);

  async function choose(row, decision) {
    const next = row.decision === decision ? null : decision;
    try {
      const r = await api.post(`/accounts-import/bank-batch/${batchId}/plan`, { decisions: [{ rowNo: row.rowNo, decision: next }] });
      if (r.data.refused?.length) { setErr(r.data.refused[0].reason); return; }
      if (onCounts) onCounts(r.data.counts);
      setData((d) => ({ ...d, rows: d.rows.map((x) => (x.rowNo === row.rowNo ? { ...x, decision: next } : x)) }));
      setErr('');
    } catch (e) {
      const m = e.response?.data?.error || 'Your choice could not be saved.';
      setErr(m);
      if (onError) onError(m);
    }
  }

  const pages = Math.max(1, Math.ceil((data.total || 0) / PAGE));
  const showWhy = filter === '' || filter === 'Needs Review' || filter === 'Duplicate in Current Upload' || filter === 'Failed' || filter === 'Already Imported';

  return (
    <div className="sc-wrap">
      <StatusStrip counts={counts} filter={filter} onFilter={setFilter} />
      {err && <div className="notice amber" style={{ margin: '8px 0' }}><span>{err}</span></div>}
      <div className="sc-listhead">
        <b>{filter || 'All transactions in this file'}</b>
        <span className="small-muted">{busy ? 'Loading…' : `${data.total} row${data.total === 1 ? '' : 's'}`}</span>
        {filter && <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>Show all</button>}
      </div>
      <div className="sc-list">
        {!busy && data.rows.length === 0 && <div className="sc-empty small-muted">No rows here.</div>}
        {data.rows.map((r) => {
          const shown = displayStatus(r);
          const tone = rowTone(shown);
          const note = r.error || r.reason;
          const chooser = canDecide && canChoose(r);
          return (
            <div key={r.rowNo} className={`sc-row sc-t-${tone}`}>
              <div className="sc-r-top">
                <span className="sc-r-no" title="Row number in your file">Row {r.line ?? r.rowNo}</span>
                <span className="sc-r-date">{day(r.date)}</span>
                <span className={`sc-pill sc-${tone}`}>{shown}</span>
                <span className={`sc-r-amt ${r.type === 'Credit' ? 'in' : 'out'}`}>{r.type === 'Credit' ? 'Money in' : r.type === 'Debit' ? 'Money out' : ''} {inr(r.amount)}</span>
              </div>
              <div className="sc-r-narr">{r.description || '—'}</div>
              {(r.reference || r.externalId) && <div className="sc-r-ref small-muted">Reference: {r.reference || r.externalId}</div>}
              {showWhy && note && <div className={`sc-r-why${r.display === 'Failed' ? ' bad' : ''}`}>{r.display === 'Failed' ? 'Why it failed: ' : ''}{note}</div>}
              {chooser && (
                <div className="sc-r-choose" role="group" aria-label={`What to do with row ${r.line ?? r.rowNo}`}>
                  <button type="button" className={`btn btn-sm${r.decision === 'import' ? ' btn-primary' : ''}`} aria-pressed={r.decision === 'import'} onClick={() => choose(r, 'import')}>
                    {r.decision === 'import' ? 'Will import ✓' : 'Import anyway'}
                  </button>
                  <button type="button" className={`btn btn-sm${r.decision === 'skip' ? ' btn-primary' : ''}`} aria-pressed={r.decision === 'skip'} onClick={() => choose(r, 'skip')}>
                    {r.decision === 'skip' ? 'Left out ✓' : 'Leave it out'}
                  </button>
                  <span className="small-muted">
                    {r.status === 'Duplicate in Current Upload' ? 'Only import it if this is a real second transaction.' : 'Not imported unless you choose.'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {pages > 1 && (
        <div className="sc-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button>
          <span className="small-muted">Page {page} of {pages}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

// The two buttons: Import New Transactions + Retry failed. Kept here so the window and the tests read one rule.
export function ImportButtons({
  counts, busy, onImport, onRetry, showImport = true,
}) {
  const plan = importPlan(counts);
  const rp = retryPlan(counts);
  return (
    <>
      {rp.canRetry && (
        <button type="button" className="btn" disabled={busy} onClick={onRetry} title="Try again only the rows that failed">{busy ? 'Working…' : rp.label}</button>
      )}
      {showImport && (
        <button type="button" className="btn btn-primary" disabled={busy || !plan.canImport} onClick={onImport}>{busy ? 'Working…' : plan.label}</button>
      )}
    </>
  );
}

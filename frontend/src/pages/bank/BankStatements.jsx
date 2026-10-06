// BANK-WISE STATEMENTS (Accounts spec S4) — Bank & Reconciliation.
//
// One button per bank (GET /api/banks). Pressing a bank asks the server for
// THAT bank's lines only (GET /api/banks/:bankId/transactions) — the date
// range, the reconciled filter and the paging all run on the server, so the
// screen never filters or mixes banks itself.
//
// The URL holds the whole state (?bankId&from&to&status&page): a refresh keeps
// it, Back / Forward step through it, a missing or unknown bankId falls back to
// the first bank (and the URL is corrected in place). Each request carries an
// AbortController and a request number, so a slow answer for a bank you have
// already left can never paint over the bank you are on.
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import PeriodPicker, { ALL_TIME } from '../../components/accounts/PeriodPicker.jsx';
import ScrollSync from '../../components/accounts/ScrollSync.jsx';
import './bank-s6.css';

const STATUS = [['all', 'All lines'], ['unreconciled', 'Unreconciled'], ['reconciled', 'Reconciled']];
const STATUS_TO_API = { all: 'all', reconciled: 'true', unreconciled: 'false' };
const LIMIT = 25;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// 1,25,000.00 — Indian grouping with paise.
const amt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// DD-MM-YYYY
const ddmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (iso || '—');
};

function readParams(sp) {
  const from = sp.get('from') || '';
  const to = sp.get('to') || '';
  const status = STATUS_TO_API[sp.get('status')] ? sp.get('status') : 'all';
  const page = Math.max(1, Number.parseInt(sp.get('page') || '1', 10) || 1);
  return {
    bankId: sp.get('bankId') || '',
    from: ISO.test(from) ? from : '',
    to: ISO.test(to) ? to : '',
    status,
    page,
  };
}

// Page buttons around the current one: 1 … 4 5 [6] 7 8 … 20
function pageList(page, total) {
  const set = new Set([1, total, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= total));
  const out = [];
  [...set].sort((a, b) => a - b).forEach((n, i, arr) => {
    if (i && n - arr[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

export default function BankStatements() {
  const [sp, setSp] = useSearchParams();
  const P = readParams(sp);
  const [banks, setBanks] = useState(null);
  const [banksErr, setBanksErr] = useState('');
  const [res, setRes] = useState(null); // the last answer that belongs to the screen
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  // Change the URL (one history step per change, so Back / Forward work).
  const go = useCallback((patch, { replace = false } = {}) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => {
      if (v == null || v === '' || (k === 'status' && v === 'all') || (k === 'page' && Number(v) === 1)) next.delete(k);
      else next.set(k, String(v));
    });
    setSp(next, { replace });
  }, [sp, setSp]);
  const goRef = useRef(go);
  goRef.current = go;

  const loadBanks = useCallback(() => {
    setBanksErr('');
    api.get('/banks')
      .then((r) => setBanks(r.data))
      .catch((e) => setBanksErr(e.response?.data?.error || 'The banks could not be loaded.'));
  }, []);
  useEffect(loadBanks, [loadBanks]);

  // A missing or unknown bankId → the first bank, corrected in the URL in place.
  const valid = banks && banks.some((b) => b.id === P.bankId);
  useEffect(() => {
    if (!banks || !banks.length || valid) return;
    go({ bankId: banks[0].id, page: 1 }, { replace: true });
  }, [banks, valid, go]);

  // The statement for the bank in the URL — fetched on the server, stale
  // answers thrown away.
  useEffect(() => {
    if (!valid) return undefined;
    const id = seq.current + 1;
    seq.current = id;
    const ctl = new AbortController();
    setLoading(true);
    setErr('');
    const params = { page: P.page, limit: LIMIT, reconciled: STATUS_TO_API[P.status] };
    if (P.from) params.from = P.from;
    if (P.to) params.to = P.to;
    api.get(`/banks/${encodeURIComponent(P.bankId)}/transactions`, { params, signal: ctl.signal })
      .then((r) => {
        if (id !== seq.current) return; // a newer request owns the screen
        setRes({ ...r.data, forBank: P.bankId });
        // Past the last page (lines removed, a narrower filter typed into the URL) → the last page.
        if (r.data.total > 0 && P.page > r.data.totalPages) goRef.current({ page: r.data.totalPages }, { replace: true });
      })
      .catch((e) => {
        if (id !== seq.current || ctl.signal.aborted || e.code === 'ERR_CANCELED') return;
        setErr(e.response?.data?.error || 'The statement could not be loaded.');
      })
      .finally(() => { if (id === seq.current) setLoading(false); });
    return () => ctl.abort();
  }, [valid, P.bankId, P.from, P.to, P.status, P.page, retry]);

  const period = P.from && P.to ? { from: P.from, to: P.to, preset: 'custom' } : ALL_TIME;
  // Another bank's lines are never shown under this bank's button, not even dimmed.
  const mine = res && res.forBank === P.bankId ? res : null;
  const rows = mine ? mine.data : [];
  const shownBank = banks?.find((b) => b.id === (res?.forBank || P.bankId));
  const totalPages = mine?.totalPages || 1;

  return (
    <section className="s6-card bks" aria-labelledby="bks-title">
      <div className="s6-card-head">
        <div>
          <h3 id="bks-title" className="s6-serif">Statement by bank</h3>
          <div className="s6-sub">Pick a bank — only that bank&rsquo;s lines are shown, newest first.</div>
        </div>
      </div>

      {banksErr && (
        <div className="s6-dash amber" role="alert">
          <span>{banksErr}</span>
          <button type="button" className="s6-btn" onClick={loadBanks}>Retry</button>
        </div>
      )}
      {!banks && !banksErr && <div className="s6-sub">Loading banks…</div>}
      {banks && !banks.length && <div className="s6-sub">No bank on file yet — press <b>Add bank or credit card</b> above.</div>}

      {banks && banks.length > 0 && (
        <>
          <div className="bks-banks" role="tablist" aria-label="Banks">
            {banks.map((b) => (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={b.id === P.bankId}
                className={`s6-pill-btn${b.id === P.bankId ? ' on' : ''}`}
                onClick={() => { if (b.id !== P.bankId) go({ bankId: b.id, page: 1 }); }}
              >
                {b.name}
              </button>
            ))}
          </div>

          <div className="bks-filters">
            <PeriodPicker
              presets
              value={period}
              onChange={(v) => go({ from: v?.from || '', to: v?.to || '', page: 1 })}
            />
            <label className="bks-field">
              <span className="s6-label">Reconciled</span>
              <select value={P.status} onChange={(e) => go({ status: e.target.value, page: 1 })}>
                {STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <span className="bks-count s6-sub" aria-live="polite">
              {mine ? `${mine.total ? `${mine.total} line${mine.total === 1 ? '' : 's'}` : 'No lines'}${shownBank ? ` · ${shownBank.name}` : ''}` : ''}
            </span>
          </div>

          {err && (
            <div className="s6-dash red" role="alert">
              <span>{err}</span>
              <button type="button" className="s6-btn" onClick={() => setRetry((n) => n + 1)}>Retry</button>
            </div>
          )}

          <div aria-busy={loading}>
          <ScrollSync className={`s6-tbl bks-tbl${loading ? ' is-loading' : ''}`} deps={[rows.length, P.bankId]}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                  <th className="num">Balance</th>
                  <th>Ref no</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="s6-mono">{ddmmyyyy(t.txnDate)}</td>
                    <td className="bks-desc">{t.description}</td>
                    <td className="num s6-mono s6-red">{t.debit ? amt(t.debit) : '—'}</td>
                    <td className="num s6-mono s6-green">{t.credit ? amt(t.credit) : '—'}</td>
                    <td className="num s6-mono">{t.balance == null ? '—' : amt(t.balance)}</td>
                    <td className="s6-mono">{t.referenceNo || '—'}</td>
                    <td>
                      {t.reconciled
                        ? <span className="s6-pill green">Reconciled</span>
                        : <span className="s6-pill red">Unreconciled</span>}
                    </td>
                  </tr>
                ))}
                {mine && !rows.length && !loading && !err && (
                  <tr><td colSpan="7" className="bks-empty">No transactions found</td></tr>
                )}
                {!mine && (loading || !err) && (
                  <tr><td colSpan="7" className="bks-empty">Loading…</td></tr>
                )}
              </tbody>
            </table>
          </ScrollSync>
          </div>

          {mine && mine.total > 0 && (
            <nav className="bks-pager" aria-label="Pages">
              <button type="button" className="s6-btn" disabled={P.page <= 1 || loading} onClick={() => go({ page: P.page - 1 })}>‹ Prev</button>
              {pageList(Math.min(P.page, totalPages), totalPages).map((n, i) => (n === '…'
                ? <span key={`gap${i}`} className="s6-sub">…</span>
                : (
                  <button
                    key={n}
                    type="button"
                    className={`s6-btn${n === P.page ? ' s6-primary' : ''}`}
                    aria-current={n === P.page ? 'page' : undefined}
                    disabled={loading}
                    onClick={() => go({ page: n })}
                  >
                    {n}
                  </button>
                )))}
              <button type="button" className="s6-btn" disabled={P.page >= totalPages || loading} onClick={() => go({ page: P.page + 1 })}>Next ›</button>
              <span className="s6-sub">Page {Math.min(P.page, totalPages)} of {totalPages} · {mine.total} line(s)</span>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

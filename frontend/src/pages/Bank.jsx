import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api';
import Modal from '../components/Modal';

// Indian digit grouping with paise, as the accounting application prints it.
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const money2 = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedMoney = (n) => (n == null ? '—' : `${n < 0 ? '−' : ''}${money2(Math.abs(n))}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (k) => (/^\d{4}-\d{2}$/.test(k || '') ? `${MONTHS[Number(k.slice(5, 7)) - 1]}-${k.slice(0, 4)}` : k);
const fmtD = (d) => {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};
const todayIso = () => new Date().toISOString().slice(0, 10);

// The reconciliation state machine, as the accountant sees it.
const STATES = ['All', 'Unmatched', 'Matched', 'Reconciled', 'Ignored'];

const STATE_CLASS = {
  Reconciled: 'priority-low',
  Matched: 'priority-medium',
  Unmatched: 'priority-high',
  Ignored: '',
};

// Group the reconciliation table by month, by the statement file it came from,
// or see every line flat.
const BANK_GROUPS = [['month', 'Month'], ['imp', 'Statement file'], ['none', 'Every line, flat']];

const gapColor = (g) => (g == null ? undefined : (Math.abs(g) < 1 ? 'var(--teal)' : 'var(--red)'));

export default function Bank() {
  // overview → every account, side by side
  // account  → one account: all lines, recognised, excluded
  // recon    → the reconciliation table
  const [view, setView] = useState('overview');
  const [accounts, setAccounts] = useState([]);
  const [cashInHand, setCashInHand] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [position, setPosition] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [groups, setGroups] = useState([]);
  const [marks, setMarks] = useState(null);
  const [imports, setImports] = useState([]);
  const [rules, setRules] = useState([]);

  const [state, setState] = useState('All');
  const [group, setGroup] = useState('month');
  const [openKeys, setOpenKeys] = useState(null); // null = "anything still to match is open"
  const [clientFilter, setClientFilter] = useState('All');
  const [tab, setTab] = useState('un');
  const [pill, setPill] = useState('all');
  const [per, setPer] = useState(200);
  const [page, setPage] = useState(0);

  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [dialog, setDialog] = useState(null); // {kind, ...}

  const load = useCallback(() => {
    api.get('/bank/accounts').then((a) => {
      setAccounts(a.data.accounts);
      setCashInHand(a.data.cashInHand);
      const id = a.data.accounts.some((x) => x.id === accountId) ? accountId : (a.data.accounts[0]?.id || '');
      if (id !== accountId) setAccountId(id);
      if (!id) return;
      const q = `?bankAccountId=${encodeURIComponent(id)}`;
      Promise.all([
        api.get(`/bank${q}`),
        api.get(`/bank/summary${q}`),
        api.get('/invoices'),
        api.get(`/bank/position${q}`),
        api.get(`/bank/groups${q}&group=${group}`),
        api.get(`/bank/marks${q}`),
        api.get(`/bank/imports${q}`),
        api.get('/bank/rules'),
      ]).then(([t, s, i, p, g, m, im, r]) => {
        setTransactions(t.data);
        setSummary(s.data);
        setInvoices(i.data);
        setPosition(p.data);
        setGroups(g.data);
        setMarks(m.data);
        setImports(im.data);
        setRules(r.data);
      });
    });
  }, [accountId, group]);
  useEffect(load, [load]);

  const account = accounts.find((a) => a.id === accountId) || null;
  const byId = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  const markById = useMemo(() => new Map((marks?.marks || []).map((m) => [m.id, m])), [marks]);

  // Every transition goes through here so the failure message from the API is
  // the one the accountant reads, rather than a silent no-op.
  async function act(id, verb, body, said) {
    setBusy(`${id}:${verb}`);
    setError('');
    setNote('');
    try {
      const res = await api.post(`/bank/${id}/${verb}`, body || {});
      if (said) setNote(said(res.data));
      else if (verb === 'reconcile' && res.data.unallocated > 0.5) {
        setNote(`Reconciled — ${money2(res.data.unallocated)} of this credit is more than the invoice owed and is left unallocated.`);
      } else if (verb === 'unmatch' && res.data.reversed > 0) {
        setNote(`Unmatched — ${money2(res.data.reversed)} went back to outstanding.`);
      }
      load();
      return res.data;
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function call(method, url, body, said) {
    setError('');
    setNote('');
    try {
      const res = await api[method](url, body);
      if (said) setNote(said(res.data));
      load();
      return res.data;
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work.');
      return null;
    }
  }

  const openInvoices = invoices.filter((i) => i.status !== 'Cancelled' && i.outstanding > 0.5);
  const clientNames = useMemo(
    () => [...new Set(invoices.map((i) => i.client?.name).filter(Boolean))].sort(),
    [invoices],
  );

  const shared = {
    account, accounts, accountId, setAccountId, transactions, byId, summary, position, invoices,
    openInvoices, clientNames, groups, marks, markById, imports, rules, cashInHand,
    act, call, busy, picked, setPicked, setDialog, setView, load,
  };

  return (
    <div>
      {error && <div className="notice red">{error}</div>}
      {note && <div className="notice">{note}</div>}

      {view === 'overview' && (
        <Overview {...shared} />
      )}
      {view === 'account' && (
        <AccountView
          {...shared}
          tab={tab} setTab={setTab} pill={pill} setPill={setPill}
          per={per} setPer={setPer} page={page} setPage={setPage}
        />
      )}
      {view === 'recon' && (
        <Recon
          {...shared}
          state={state} setState={setState}
          group={group} setGroup={setGroup}
          openKeys={openKeys} setOpenKeys={setOpenKeys}
          clientFilter={clientFilter} setClientFilter={setClientFilter}
        />
      )}

      {dialog && (
        <Dialogs
          dialog={dialog} setDialog={setDialog} {...shared}
        />
      )}
    </div>
  );
}

// ===========================================================================
// 1 · Banking Overview — every account, side by side
// ===========================================================================

function Overview({ accounts, cashInHand, setAccountId, setView, setDialog, call }) {
  const totalUn = accounts.reduce((s, a) => s + a.stat.unmatched, 0);
  const totalBank = accounts.reduce((s, a) => s + (a.stat.inBank != null ? a.stat.inBank : a.stat.inBooks), 0);
  const totalBooks = accounts.reduce((s, a) => s + a.stat.inBooks, 0);
  const totalGap = accounts.filter((a) => a.stat.inBank != null).reduce((s, a) => s + a.stat.difference, 0);
  const off = accounts.filter((a) => a.stat.difference != null && Math.abs(a.stat.difference) > 1);
  const fixable = off.filter((a) => a.stat.openingGap != null && Math.abs(a.stat.openingGap) > 1);

  const open = (id) => { setAccountId(id); setView('account'); };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Bank &amp; Reconciliation</h1>
          <div className="page-sub">
            Import the bank statement, match every credit to a client and invoice automatically,
            and keep the running balance in step with the passbook.
          </div>
        </div>
      </div>

      <div className="page-head">
        <h2 style={{ fontSize: 19 }}>Banking Overview</h2>
        <div className="qa-row">
          <button className="btn btn-sm" onClick={() => setView('recon')}>🧾 Reconciliation</button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'import' })}>⬆ Import statement</button>
          <button className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: 'account', account: null })}>🏦 Add bank or credit card</button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'rules' })}>⚙ Manage transaction rules</button>
        </div>
      </div>

      <div className="statbar">
        <Stat n={money2(cashInHand)} l="Cash in hand" sub="cash receipts less cash bills" />
        <Stat n={money2(totalBank)} l="Bank balance" sub="what the statements say" />
        <div className="statitem">
          <div className="n">{totalUn}</div>
          <div className="l">Uncategorised transactions</div>
          <div className="l">
            {totalUn
              ? <button type="button" className="link-btn" onClick={() => open((accounts.find((a) => a.stat.unmatched) || accounts[0]).id)}>Categorise now →</button>
              : 'everything is filed'}
          </div>
        </div>
      </div>

      <div className="card section">
        <h3>All accounts</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {accounts.length} account{accounts.length === 1 ? '' : 's'} on file
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Account details</th>
                <th className="num">Uncategorised</th>
                <th className="num">Amount in bank</th>
                <th className="num">Amount in the books</th>
                <th className="num">Difference</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((b) => {
                const s = b.stat;
                const canFix = s.openingGap != null && Math.abs(s.openingGap) > 1
                  && s.difference != null && Math.abs(s.difference) > 1;
                return (
                  <tr key={b.id}>
                    <td>
                      <b><button type="button" className="link-btn" onClick={() => open(b.id)}>{b.bank}{b.name ? ` · ${b.name}` : ''}</button></b>
                      <div className="small-muted">
                        {b.accNo ? `xxxx${String(b.accNo).slice(-4)}` : 'no account number'}
                        {s.last ? ` · last line ${fmtD(s.last)}` : ' · nothing imported yet'}
                      </div>
                    </td>
                    <td className="num">
                      {s.unmatched
                        ? <button type="button" className="link-btn" style={{ color: 'var(--red)' }} onClick={() => open(b.id)}>{s.unmatched} transaction{s.unmatched === 1 ? '' : 's'}</button>
                        : <span className="status priority-low">all filed</span>}
                    </td>
                    <td className="num">{s.inBank == null ? <span className="small-muted">no balance column</span> : money2(s.inBank)}</td>
                    <td className="num">{money2(s.inBooks)}</td>
                    <td className="num">
                      <b style={{ color: gapColor(s.difference) }}>{signedMoney(s.difference)}</b>
                      {s.difference != null && Math.abs(s.difference) > 1 && (
                        <div className="small-muted">
                          {s.implied == null
                            ? 'no balance column on the statement'
                            : (Math.abs(s.openingGap) > 1
                              ? `opening balance is ${money2(b.openBal)}, the statement says it should be ${money2(s.implied)}`
                              : 'a statement is missing — open the account, the table marks the day')}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canFix && (
                        <button
                          className="btn btn-sm"
                          title="Work the opening balance back from the first line the statement carries"
                          onClick={() => call('post', `/bank/accounts/${b.id}/fix-opening`, {}, (d) => `Opening balance set to ${money2(d.implied)} — the statement works it out for you.`)}
                        >
                          Fix opening
                        </button>
                      )}
                      {' '}
                      <button className="btn btn-sm" onClick={() => open(b.id)}>Open</button>
                      {' '}
                      <button className="btn btn-sm" onClick={() => setDialog({ kind: 'account', account: b })}>⚙</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {accounts.length > 1 && (
              <tfoot>
                <tr>
                  <td>TOTAL</td>
                  <td className="num">{totalUn}</td>
                  <td className="num">{money2(totalBank)}</td>
                  <td className="num">{money2(totalBooks)}</td>
                  <td className="num"><b style={{ color: gapColor(totalGap) }}>{signedMoney(totalGap)}</b></td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {off.length > 0 && (
          <div className="notice amber" style={{ marginTop: 12 }}>
            <span>
              <b>{off.length} account{off.length === 1 ? ' does' : 's do'} not agree with the statement.</b>
              {' '}Almost always this is the <b>opening balance</b>: the app starts from the figure on the account and adds every
              line you import, so if that starting figure is wrong — or a statement was imported for a period before it — every
              total after it is out by the same amount.
              {fixable.length
                ? ` For ${fixable.length === off.length ? 'each of them' : `${fixable.length} of them`} the statement itself says what the opening balance should be. Press Fix opening on the row and the difference clears — nothing already imported is touched.`
                : ' Open the account and the reconciliation table marks the exact day a line is missing.'}
            </span>
          </div>
        )}
        <div className="small-muted" style={{ marginTop: 8 }}>
          <b>Amount in bank</b> is the closing balance printed on the last statement you imported.
          {' '}<b>Amount in the books</b> is this account&rsquo;s opening balance plus every line imported.
          {' '}Where they differ, a statement is missing — open the account and the table marks the exact day.
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// 2 · One account — all lines, recognised, excluded
// ===========================================================================

function AccountView({
  account, accountId, transactions, setView, setDialog, act, call, busy,
  tab, setTab, pill, setPill, per, setPer, page, setPage, position,
}) {
  if (!account) return <div className="card section">Add a bank account to begin.</div>;
  const s = account.stat;

  let list = transactions;
  if (tab === 'un') list = list.filter((t) => t.state !== 'Reconciled' && !t.category && !t.excluded);
  else if (tab === 'ok') list = list.filter((t) => t.state === 'Reconciled' || t.category);
  if (tab === 'un') {
    if (pill === 'rec') list = list.filter((t) => t.read && t.read.kind !== 'none');
    else if (pill === 'ex') list = transactions.filter((t) => t.excluded);
  }
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(page, pages - 1);
  const shown = list.slice(p * per, (p + 1) * per);

  return (
    <div>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => setView('overview')}>← All accounts</button>
          <div>
            <h1>{account.bank}{account.name ? ` · ${account.name}` : ''}</h1>
            <div className="page-sub">{account.accNo ? `Account number xxxx${String(account.accNo).slice(-4)}` : 'No account number on file'}</div>
          </div>
        </div>
        <div className="qa-row">
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'import' })}>⬆ Import statement</button>
          <button className="btn btn-sm" onClick={() => call('post', '/bank/quick-categorise', { bankAccountId: accountId }, (d) => `${d.filed} recognised debit(s) filed.`)}>⚡ Quick categorize</button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'entry' })}>＋ Add transaction</button>
          <button className="btn btn-sm" onClick={() => setView('recon')}>🧾 Reconciliation</button>
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'account', account })}>⚙</button>
        </div>
      </div>

      <div className="statbar">
        <Stat n={money2(s.inBooks)} l="Amount in the books" sub="opening balance + every line imported" />
        <Stat n={s.inBank == null ? '—' : money2(s.inBank)} l="Amount in bank" sub="closing balance printed on the statement" />
        <Stat n={s.last ? fmtD(s.last) : '—'} l="Last line" sub={`${s.lines} line(s) imported`} />
      </div>

      <div className="tabbar">
        <button className={`tab-btn ${tab === 'un' ? 'active' : ''}`} onClick={() => { setTab('un'); setPage(0); }}>
          {s.unmatched} Uncategorised transactions
        </button>
        <button className={`tab-btn ${tab === 'ok' ? 'active' : ''}`} onClick={() => { setTab('ok'); setPage(0); }}>
          {s.matched} Matched transactions
        </button>
        <button className={`tab-btn ${tab === 'all' ? 'active' : ''}`} onClick={() => { setTab('all'); setPage(0); }}>
          {s.lines + s.excluded} Every line
        </button>
      </div>

      {tab === 'un' && (
        <div className="filter-row" style={{ alignItems: 'center' }}>
          {[['all', 'All', s.unmatched], ['rec', 'Recognised', s.recognised], ['ex', 'Excluded', s.excluded]].map(([k, l, n]) => (
            <button key={k} className={`btn btn-sm ${pill === k ? 'btn-primary' : ''}`} onClick={() => { setPill(k); setPage(0); }}>
              {l} ({n})
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <span className="small-muted">{money2(s.unmatchedIn)} in · {money2(s.unmatchedOut)} out still to file</span>
        </div>
      )}

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Statement details</th><th className="num">Deposits</th><th className="num">Withdrawals</th>
              <th>What the app thinks</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id} style={t.excluded ? { opacity: 0.55 } : undefined}>
                <td>{fmtD(t.date)}</td>
                <td style={{ minWidth: 320 }}>
                  <span className="small-muted">Description: </span>{String(t.description || '—').slice(0, 150)}
                  {t.reference && <span className="small-muted"> (Ref# {t.reference})</span>}
                </td>
                <td className="num" style={{ color: 'var(--teal)' }}>
                  {t.type === 'Credit' ? <button type="button" className="link-btn" onClick={() => setDialog({ kind: 'catz', txn: t, tab: 'match' })}>{money2(t.amount)}</button> : '—'}
                </td>
                <td className="num" style={{ color: 'var(--red)' }}>
                  {t.type === 'Debit' ? <button type="button" className="link-btn" onClick={() => setDialog({ kind: 'catz', txn: t, tab: t.read?.kind === 'expense' ? 'cat' : 'match' })}>{money2(t.amount)}</button> : '—'}
                </td>
                <td><Thinks txn={t} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {(t.state === 'Reconciled' || t.category) ? (
                    <>
                      {t.category && <button className="btn btn-sm" onClick={() => setDialog({ kind: 'catz', txn: t, tab: 'cat' })}>✎ Edit</button>}{' '}
                      <button
                        className="btn btn-sm"
                        disabled={busy === `${t.id}:unmatch`}
                        onClick={() => (t.category ? act(t.id, 'uncategorise') : act(t.id, 'unmatch'))}
                      >
                        Undo
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: 'catz', txn: t, tab: 'match' })}>Match / categorize</button>{' '}
                      <button className="btn btn-sm" onClick={() => act(t.id, 'exclude', { excluded: !t.excluded })}>{t.excluded ? 'Bring back' : 'Exclude'}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan="6" className="empty">
                  {s.lines ? 'Nothing in this list.' : 'No lines yet. Press Import statement and choose your bank’s CSV or Excel file.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="filter-row" style={{ alignItems: 'center' }}>
        <span className="small-muted">Total {total} line(s)</span>
        <span style={{ flex: 1 }} />
        <label className="small-muted">
          Per page{' '}
          <select value={per} onChange={(e) => { setPer(Number(e.target.value)); setPage(0); }}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn btn-sm" disabled={p <= 0} onClick={() => setPage(p - 1)}>‹</button>
        <span className="small-muted">{total ? p * per + 1 : 0} – {Math.min(total, (p + 1) * per)}</span>
        <button className="btn btn-sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>›</button>
      </div>
      <div className="small-muted" style={{ marginTop: 8 }}>
        Press a <b>deposit</b> or a <b>withdrawal</b> figure to open it — every match the app can see, and a form to file it by hand.
        {' '}<b>Exclude</b> leaves a line on file but out of the count, for a transfer you never want to categorise.
      </div>

      <DuplicatesCard position={position} accountId={accountId} call={call} />
      <HowMatchCard position={position} />
    </div>
  );
}

// What the app thinks a line is, before anyone has said anything.
function Thinks({ txn }) {
  if (txn.category || txn.counterparty) {
    return (
      <>
        <b>{txn.category || txn.counterparty}</b>{' '}
        <span className="status">{txn.categoryKind === 'transfer' ? 'our own transfer' : txn.categoryKind === 'hand' ? 'hand loan' : 'office expense'}</span>
      </>
    );
  }
  if (txn.state === 'Reconciled') {
    return (
      <>
        <b>{txn.matchedInvoice?.invoiceNumber || '—'}</b>
        {txn.clientName && <div className="small-muted">{txn.clientName}</div>}
        <div className="small-muted">posted as a client receipt</div>
      </>
    );
  }
  const r = txn.read;
  if (!r || r.kind === 'none') return <span className="status priority-medium">not categorised</span>;
  return (
    <>
      {r.client && <b>{r.client} </b>}
      {r.party && <b>{r.party} </b>}
      <span className={`status ${r.tagClass}`}>{r.tag}</span>
      <div className="small-muted">✦ {String(r.why || '').slice(0, 90)}</div>
    </>
  );
}

// ===========================================================================
// 3 · Reconciliation — every line against the balance the bank printed
// ===========================================================================

function Recon({
  account, accounts, accountId, setAccountId, transactions, byId, summary, position, openInvoices,
  clientNames, groups, marks, markById, imports, setView, setDialog, act, call, busy, picked, setPicked,
  state, setState, group, setGroup, openKeys, setOpenKeys, clientFilter, setClientFilter,
}) {
  if (!account) return <div className="card section">Add a bank account to begin.</div>;

  const stateRows = state === 'All' ? transactions : transactions.filter((t) => t.state === state);
  const keep = new Set(stateRows.map((t) => t.id));

  const credits = transactions.filter((t) => t.type === 'Credit');
  const debits = transactions.filter((t) => t.type === 'Debit');
  const unposted = credits.filter((t) => t.state !== 'Reconciled');
  const named = unposted.filter((t) => t.read && (t.read.kind === 'sure' || t.read.kind === 'named'));
  const recognisedDebits = debits.filter((t) => t.state !== 'Reconciled' && !t.category && t.read && t.read.category).length;
  const readTotal = position ? Object.values(position.reading).reduce((s, n) => s + n, 0) : 0;
  const totIn = credits.reduce((s, t) => s + Number(t.amount || 0), 0);
  const totOut = debits.reduce((s, t) => s + Number(t.amount || 0), 0);

  // Until you collapse something yourself, any group with credits still to
  // match is already open — what needs doing is never hidden behind a triangle.
  const O = openKeys || Object.fromEntries(groups.filter((g) => g.open).map((g) => [g.key, 1]));
  const toggle = (k) => setOpenKeys({ ...O, [k]: O[k] ? undefined : 1 });
  const allOpen = Object.values(O).filter(Boolean).length > 0;

  const lineRow = (t, kid) => {
    if (!keep.has(t.id)) return null;
    const r = t.read;
    const tone = t.state !== 'Reconciled' && t.type === 'Credit' && r
      ? (r.kind === 'none' ? 'var(--red-tint)' : (r.kind === 'sure' || r.kind === 'named') ? 'var(--teal-tint)' : 'var(--amber-tint)')
      : '';
    const diff = (t.balance == null || t.runningBalance == null) ? null : Number((t.balance - t.runningBalance).toFixed(2));
    const main = (
      <tr key={t.id} style={tone ? { background: tone } : undefined}>
        <td>{kid ? '└ ' : ''}{fmtD(t.date)}</td>
        <td style={{ maxWidth: 340 }}>
          <span className="small-muted">Description: </span>{String(t.description || '—').slice(0, 140)}
          {t.reference && <span className="small-muted"> (Ref# {t.reference})</span>}
        </td>
        <td className="num">{t.type === 'Debit' ? money(t.amount) : '—'}</td>
        <td className="num" style={{ color: 'var(--teal)' }}>{t.type === 'Credit' ? money(t.amount) : '—'}</td>
        <td className="num">{t.balance == null ? '—' : money(t.balance)}</td>
        <td className="num">{t.runningBalance == null ? '—' : money(t.runningBalance)}</td>
        <td className="num">{diff == null ? '—' : <b style={{ color: gapColor(diff) }}>{signedMoney(diff)}</b>}</td>
        <td><Against txn={t} /></td>
        <td><span className={`status ${STATE_CLASS[t.state] || ''}`}>{t.state}</span></td>
        <td style={{ minWidth: 300 }}>
          <Actions
            txn={t}
            openInvoices={openInvoices}
            picked={picked[t.id] || ''}
            onPick={(v) => setPicked({ ...picked, [t.id]: v })}
            act={act}
            busy={busy}
            setDialog={setDialog}
          />
        </td>
      </tr>
    );
    if (!t.breakHere) return main;
    const bk = t.breakHere;
    return (
      <Fragment key={`${t.id}-wrap`}>
        <tr style={{ background: 'var(--amber-tint)' }}>
          <td><span className="status priority-high">gap</span></td>
          <td colSpan="8" className="small-muted">
            On <b>{fmtD(bk.date)}</b> the day does not tie — after <b>{fmtD(bk.prevDate)}</b> the balance should have reached
            {' '}{money2(bk.at.balance - bk.gap)}, but the statement prints {money2(bk.at.balance)}, a difference of
            {' '}<b>{bk.gap < 0 ? '−' : '+'}{money2(Math.abs(bk.gap))}</b>.{' '}
            {bk.gap < 0
              ? <>A payment of <b>{money(Math.abs(bk.gap))}</b> went out and was never imported.</>
              : <>A receipt of <b>{money(Math.abs(bk.gap))}</b> came in and was never imported.</>}
            {' '}<b>Download {fmtD(bk.prevDate)} to {fmtD(bk.date)}</b> from net banking again and import it — nothing here is
            deleted, the missing line simply slots in and the difference clears.
          </td>
          <td />
        </tr>
        {main}
      </Fragment>
    );
  };

  const noteRow = (n, kid) => (
    <tr key={n.id} style={{ background: 'var(--navy-tint)' }}>
      <td>{kid ? '└ ' : ''}{fmtD(n.date)}</td>
      <td><b>{n.kind}</b> — typed in by {n.recordedBy || '—'}{n.note ? <div>{n.note}</div> : null}</td>
      <td className="num">—</td>
      <td className="num">{n.cleared == null ? '—' : money(n.cleared)}</td>
      <td className="num">{n.balance == null ? '—' : money(n.balance)}</td>
      <td className="num">{n.books == null ? '—' : money(n.books)}</td>
      <td className="num">{n.gap == null ? '—' : <b style={{ color: gapColor(n.gap) }}>{signedMoney(n.gap)}</b>}</td>
      <td>
        <span className="status">note</span>
        {n.match && <div className="small-muted">watching “{n.match}”</div>}
      </td>
      <td />
      <td>
        <button className="btn btn-sm" onClick={() => call('delete', `/bank/marks/${n.id}`, undefined, () => 'Removed.')}>Delete</button>
      </td>
    </tr>
  );

  const groupRow = (g) => (
    <tr key={g.key} style={{ background: 'var(--line-soft)' }}>
      <td>
        <button type="button" className="link-btn" onClick={() => toggle(g.key)}>{O[g.key] ? '▾' : '▸'}</button>{' '}
        <b>{group === 'month' ? monthLabel(g.label) : g.label}</b>
      </td>
      <td className="small-muted">
        {g.rows.length} line(s){g.notes.length ? ` · ${g.notes.length} note(s)` : ''} ·
        {' '}{group === 'month' ? `to ${fmtD(g.on)}` : g.sub.replace(/(\d{4}-\d{2}-\d{2})/g, (d) => fmtD(d))}
      </td>
      <td className="num"><b>{g.out ? money(g.out) : '—'}</b></td>
      <td className="num" style={{ color: 'var(--teal)' }}><b>{g.in ? money(g.in) : '—'}</b></td>
      <td className="num">{g.bank == null ? <span className="small-muted">no balance</span> : money(g.bank)}</td>
      <td className="num">{g.books == null ? '—' : money(g.books)}</td>
      <td className="num">{g.gap == null ? '—' : <b style={{ color: gapColor(g.gap) }}>{signedMoney(g.gap)}</b>}</td>
      <td>
        {g.open
          ? <span className="status priority-high">{g.open} to match</span>
          : <span className="status priority-low">all matched</span>}
        {g.posted ? <div className="small-muted">{g.posted} posted</div> : null}
      </td>
      <td colSpan="2" />
    </tr>
  );

  let body = [];
  if (group === 'none') {
    const g = groups[0] || { rows: [], notes: [] };
    const merged = [
      ...g.rows.map((id) => ({ d: byId.get(id)?.date, t: byId.get(id) })),
      ...g.notes.map((id) => ({ d: markById.get(id)?.date, n: markById.get(id) })),
    ].filter((x) => x.t || x.n).sort((a, b) => String(b.d).localeCompare(String(a.d)));
    body = merged.map((x) => (x.t ? lineRow(x.t, false) : noteRow(x.n, false)));
  } else {
    groups.forEach((g) => {
      body.push(groupRow(g));
      if (!O[g.key]) return;
      const merged = [
        ...g.rows.map((id) => ({ d: byId.get(id)?.date, t: byId.get(id) })),
        ...g.notes.map((id) => ({ d: markById.get(id)?.date, n: markById.get(id) })),
      ].filter((x) => x.t || x.n).sort((a, b) => String(b.d).localeCompare(String(a.d)));
      merged.forEach((x) => body.push(x.t ? lineRow(x.t, true) : noteRow(x.n, true)));
    });
  }
  body = body.filter(Boolean);

  return (
    <div>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => setView('overview')}>← All accounts</button>
          <div>
            <h1>Bank &amp; Reconciliation</h1>
            <div className="page-sub">Reconciliation · every line against the balance the bank printed</div>
          </div>
        </div>
      </div>

      <div className="filter-row">
        <label>
          Bank account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.bank}{a.accNo ? ` · ****${String(a.accNo).slice(-4)}` : ''}{a.name ? ` · ${a.name.slice(0, 22)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select value={group} onChange={(e) => { setGroup(e.target.value); setOpenKeys(null); }}>
            {BANK_GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>
          Client
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
            <option value="All">All</option>
            {clientNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {group !== 'none' && (
          <button className="btn btn-sm" onClick={() => setOpenKeys(allOpen ? {} : Object.fromEntries(groups.map((g) => [g.key, 1])))}>
            {allOpen ? 'Collapse all' : 'Open all'}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'import' })}>⬆ Import statement</button>
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'entry' })}>＋ Entry by hand</button>
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'mark' })}>✎ Note a balance</button>
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'account', account })}>⚙ Account details</button>
        <button className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: 'account', account: null })}>🏦 Add account</button>
      </div>

      <div className="statbar">
        <Stat n={money(account.stat.inBooks)} l="Bank balance" sub={`Opening ${money(account.openBal)} + ${transactions.length} line(s)`} />
        <Stat n={money(totIn)} l="Money in" sub={`${credits.length} credit(s) in this period`} />
        <Stat n={money(totOut)} l="Money out" sub={`${debits.length} debit(s) in this period`} />
        <Stat n={unposted.length} l="Waiting to be posted" sub={`${money(unposted.reduce((s, t) => s + t.amount, 0))} not yet against a client`} />
      </div>

      {position && position.openingGap != null && Math.abs(position.openingGap) > 1 && (
        <div className="notice amber">
          <span>
            <b>The statement itself says the opening balance should be {money2(position.implied)}.</b>
            {' '}The account carries {money2(account.openBal)}, which is why every month below is off by {money2(Math.abs(position.openingGap))}.
            {' '}
            <button className="btn btn-sm" onClick={() => call('post', `/bank/accounts/${account.id}/fix-opening`, {}, (d) => `Opening balance set to ${money2(d.implied)}.`)}>
              Set it to {money(position.implied)}
            </button>
          </span>
        </div>
      )}

      {clientFilter !== 'All' && <ClientPanel name={clientFilter} invoices={openInvoices} transactions={transactions} onClear={() => setClientFilter('All')} />}

      {position && readTotal > 0 && (
        <div className="notice">
          <span>
            Of the {readTotal} unmatched credit(s):
            {' '}<b>{position.reading['client named']}</b> name a client,
            {' '}<b>{position.reading['amount only — check']}</b> fit one invoice on amount alone,
            {' '}<b>{position.reading['several match']}</b> could be several invoices,
            {' '}<b>{position.reading['check invoice']}</b> name a client with nothing outstanding, and
            {' '}<b>{position.reading['no match']}</b> have no match at all.
          </span>
        </div>
      )}

      <div className="tabbar">
        {STATES.map((s) => (
          <button key={s} className={`tab-btn ${state === s ? 'active' : ''}`} onClick={() => setState(s)}>
            {s}{summary && s !== 'All' ? ` (${summary[s.toLowerCase()]})` : ''}
          </button>
        ))}
      </div>

      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>{account.bank}{account.accNo ? ` · ****${String(account.accNo).slice(-4)}` : ''}</h3>
          <span className="small-muted">
            {transactions.length} line(s){unposted.length ? ` · ${unposted.length} credit(s) still to match` : ' · everything matched'}
            {' '}· grouped by {(BANK_GROUPS.find((x) => x[0] === group) || [])[1]}
          </span>
          <span style={{ flex: 1 }} />
          {named.length > 0 && (
            <button className="btn btn-sm" onClick={() => call('post', '/bank/post-all-named', { bankAccountId: accountId }, (d) => `${d.posted} credit(s) posted · ${money(d.value)} matched by client name.`)}>
              ⚡ Post all {named.length} matched credit(s)
            </button>
          )}
          {recognisedDebits > 0 && (
            <button
              className="btn btn-sm"
              title="Every debit the app already recognises becomes an office bill"
              onClick={() => call('post', '/bank/quick-categorise', { bankAccountId: accountId }, (d) => `${d.filed} recognised debit(s) filed.`)}
            >
              ✓ Categorise {recognisedDebits} recognised debit(s)
            </button>
          )}
          <span className="status priority-low" title="Set this in the Import statement dialog">auto-post on</span>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 1240 }}>
            <thead>
              <tr>
                <th>Date</th><th>Statement details</th><th className="num">Withdrawals</th><th className="num">Deposits</th>
                <th className="num">Bank says</th><th className="num">This app says</th><th className="num">Difference</th>
                <th>Against</th><th>State</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {body.length ? body : (
                <tr><td colSpan="10" className="empty">No lines in this period. Press <b>Import statement</b> and choose your bank&rsquo;s CSV or Excel file.</td></tr>
              )}
            </tbody>
            {transactions.length > 0 && (
              <tfoot>
                <tr>
                  <td>TOTAL</td>
                  <td className="small-muted">{transactions.length} line(s)</td>
                  <td className="num">{money(totOut)}</td>
                  <td className="num">{money(totIn)}</td>
                  <td className="num">{position?.inBank == null ? '—' : money(position.inBank)}</td>
                  <td className="num">{money(account.stat.inBooks)}</td>
                  <td colSpan="4" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          <b>Bank says</b> is the balance printed on the statement. <b>This app says</b> is your opening balance plus every line
          imported up to that point. Where they differ, a line is missing — the table marks the exact place. Rows shaded blue are
          notes typed in by hand.
        </div>
      </div>

      <BalanceLogCard marks={marks} account={account} call={call} />
      <ImportsCard imports={imports} transactions={transactions} call={call} />
      <DuplicatesCard position={position} accountId={accountId} call={call} />
      <HowMatchCard position={position} />
    </div>
  );
}

// What a credit is up against, in the accounting application's own words.
function Against({ txn }) {
  if (txn.state === 'Reconciled') {
    return (
      <>
        <b>{txn.matchedInvoice?.invoiceNumber || '—'}</b>
        <div className="small-muted">{(txn.clientName || txn.matchedInvoice?.client || '').slice(0, 26)}</div>
        {txn.excess > 0 && <span className="status priority-medium">{money(txn.excess)} unposted</span>}
      </>
    );
  }
  if (txn.state === 'Ignored') return <span className="small-muted">{txn.ignoredReason || 'Ignored'}</span>;
  if (txn.category || txn.counterparty) {
    return (
      <>
        <b>{txn.category || txn.counterparty}</b>{' '}
        <span className="status">{txn.categoryKind === 'transfer' ? 'our own transfer' : txn.categoryKind === 'hand' ? 'hand loan' : 'office expense'}</span>
      </>
    );
  }
  const r = txn.read;
  if (!r) return <span className="small-muted">—</span>;
  return (
    <>
      <span className={`status ${r.tagClass}`}>{r.tag}</span>
      {r.party && <b> {r.party}</b>}
      <div className="small-muted">{r.why}</div>
      {r.client && <div><b>{r.client}</b></div>}
      {r.plan?.parts?.length > 1 && (
        <div className="small-muted">{r.plan.parts.map((p) => `${p.invoiceNumber} ${money(p.amount)}`).join(' · ')}</div>
      )}
    </>
  );
}

// The buttons a line actually offers depend on where it sits in the state machine.
function Actions({ txn, openInvoices, picked, onPick, act, busy, setDialog }) {
  const waiting = (verb) => busy === `${txn.id}:${verb}`;

  if (txn.state === 'Ignored') {
    return <button className="btn btn-sm" disabled={waiting('unignore')} onClick={() => act(txn.id, 'unignore')}>Restore</button>;
  }

  if (txn.state === 'Reconciled') {
    return (
      <>
        <span className="small-muted" style={{ marginRight: 8 }}>Closed off.</span>
        <button className="btn btn-sm" disabled={waiting('unmatch')} onClick={() => act(txn.id, 'unmatch')}>Undo</button>
      </>
    );
  }

  if (txn.state === 'Matched') {
    return (
      <div className="qa-row">
        <button className="btn btn-primary btn-sm" disabled={waiting('reconcile')} onClick={() => act(txn.id, 'reconcile')}>Reconcile</button>
        <button className="btn btn-sm" disabled={waiting('unmatch')} onClick={() => act(txn.id, 'unmatch')}>Unmatch</button>
        <button className="btn btn-sm" disabled={waiting('ignore')} onClick={() => act(txn.id, 'ignore')}>Ignore</button>
      </div>
    );
  }

  // Unmatched. Debits are never matched to an invoice — they can only be filed
  // or parked.
  if (txn.type !== 'Credit') {
    return (
      <div className="qa-row">
        <button className="btn btn-sm" onClick={() => setDialog({ kind: 'catz', txn, tab: 'cat' })}>Match / categorize</button>
        <button className="btn btn-sm" disabled={waiting('ignore')} onClick={() => act(txn.id, 'ignore')}>Ignore</button>
      </div>
    );
  }

  const r = txn.read;
  const sure = r && (r.kind === 'sure' || r.kind === 'named');
  const multi = r?.plan?.parts?.length > 1;
  return (
    <div className="qa-row">
      {sure && (
        <button
          className="btn btn-primary btn-sm"
          disabled={waiting('post-to-client')}
          title={multi
            ? `Settles ${r.plan.parts.map((p) => p.invoiceNumber).join(', ')} — oldest first`
            : `Posts ${money2(r.amount)} against ${r.invoiceNumber}`}
          onClick={() => act(txn.id, 'post-to-client', { client: r.client })}
        >
          Post{multi ? ` all ${r.plan.parts.length}` : ''} to {String(r.client || '').split(' ')[0]}
        </button>
      )}
      {txn.suggestion && !sure && (
        <button className="btn btn-primary btn-sm" disabled={waiting('match')} onClick={() => act(txn.id, 'match')}>
          Match to {txn.suggestion.invoiceNumber}
        </button>
      )}
      <select value={picked} onChange={(e) => onPick(e.target.value)} style={{ maxWidth: 230 }}>
        <option value="">{r?.invoiceNumber ? '— change the invoice —' : '— choose the invoice —'}</option>
        {openInvoices.map((i) => (
          <option key={i.id} value={i.id}>
            {i.invoiceNumber || i.id.slice(-6)} · {i.client?.name?.slice(0, 20)} · {money(i.outstanding)}
          </option>
        ))}
      </select>
      <button className="btn btn-sm" disabled={!picked || waiting('match')} onClick={() => act(txn.id, 'match', { invoiceId: picked })}>Post</button>
      <button className="btn btn-sm" title="Every invoice this could be, and a form to file it by hand" onClick={() => setDialog({ kind: 'catz', txn, tab: 'match' })}>Match…</button>
      <button className="btn btn-sm" disabled={waiting('ignore')} onClick={() => act(txn.id, 'ignore')}>Ignore</button>
    </div>
  );
}

// ===========================================================================
// Cards
// ===========================================================================

// The client, seen from the bank page.
function ClientPanel({ name, invoices, transactions, onClear }) {
  const theirs = invoices.filter((i) => i.client?.name === name);
  const lines = transactions.filter((t) => t.clientName === name || t.read?.client === name);
  const inBank = lines.filter((t) => t.state === 'Reconciled').reduce((s, t) => s + Number(t.amount || 0), 0);
  const pending = theirs.reduce((s, i) => s + Number(i.outstanding || 0), 0);
  return (
    <div className="card section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        <span className="small-muted">{theirs.length} open invoice(s) · everything this client has done with us</span>
        <span style={{ flex: 1 }} />
        {pending > 0.5
          ? <span className="status priority-high">{money(pending)} still to come</span>
          : <span className="status priority-low">fully settled</span>}
        <button className="btn btn-sm" onClick={onClear}>✕ Clear</button>
      </div>
      <div className="statbar" style={{ marginTop: 10 }}>
        <Stat n={money(pending)} l="Still pending" sub={`${theirs.length} invoice(s) open`} />
        <Stat n={money(inBank)} l="Seen in this account" sub={`${lines.length} statement line(s)`} />
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Invoice</th><th>Raised on</th><th className="num">Invoice value</th><th className="num">Received</th><th className="num">Pending</th><th>Where it stands</th></tr>
          </thead>
          <tbody>
            {theirs.map((i) => (
              <tr key={i.id}>
                <td><b>{i.invoiceNumber || i.id.slice(-6)}</b></td>
                <td>{fmtD(i.invoiceDate)}</td>
                <td className="num">{money(i.total)}</td>
                <td className="num" style={{ color: 'var(--teal)' }}>{money(i.receivedAmount)}</td>
                <td className="num"><b style={{ color: 'var(--red)' }}>{money(i.outstanding)}</b></td>
                <td><span className={`status ${i.receivedAmount > 0.5 ? 'priority-medium' : 'priority-high'}`}>{i.receivedAmount > 0.5 ? 'part paid' : 'not paid'}</span></td>
              </tr>
            ))}
            {!theirs.length && <tr><td colSpan="6" className="empty">No invoice on file for this client in the period you are looking at.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Cleared and balance — month by month, plus notes typed by hand.
function BalanceLogCard({ marks, account, call }) {
  if (!marks) return null;
  const months = marks.months || [];
  const latest = months[0] || null;
  const totIn = months.reduce((s, m) => s + m.in, 0);
  const totOut = months.reduce((s, m) => s + m.out, 0);
  return (
    <div className="card section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Cleared and balance — month by month</h3>
        <span className="small-muted">Worked out from the statements themselves each time you import; nothing to type</span>
        <span style={{ flex: 1 }} />
        {latest && latest.gap != null && (Math.abs(latest.gap) < 1
          ? <span className="status priority-low">reconciled</span>
          : <span className="status priority-high">off by {money(Math.abs(latest.gap))}</span>)}
      </div>
      <div className="statbar">
        <Stat n={money2(account.openBal)} l="Opening balance" sub={account.openDate ? `as on ${fmtD(account.openDate)}` : 'set on the account'} />
        <Stat n={money2(totIn)} l="Cleared in" sub={`${months.length} month(s) of statement`} />
        <Stat n={money2(totOut)} l="Cleared out" sub="debits on the statement" />
        <Stat n={money2(account.stat.inBooks)} l="Balance now" sub="opening + every line imported" />
        {latest && latest.bank != null && <Stat n={money2(latest.bank)} l="Bank says" sub={`closing balance on ${fmtD(latest.on)}`} />}
        {latest && latest.gap != null && <Stat n={signedMoney(latest.gap)} l="Difference" sub={Math.abs(latest.gap) < 1 ? 'the account agrees' : 'opening balance or a missing statement'} />}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Month</th><th className="num">Lines</th><th className="num">Cleared in</th><th className="num">Cleared out</th>
              <th className="num">Bank says</th><th className="num">This app says</th><th className="num">Difference</th><th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.key}>
                <td><b>{monthLabel(m.key)}</b><div className="small-muted">to {fmtD(m.on)}</div></td>
                <td className="num">{m.lines}</td>
                <td className="num" style={{ color: 'var(--teal)' }}>{m.in ? money2(m.in) : '—'}</td>
                <td className="num" style={{ color: 'var(--red)' }}>{m.out ? money2(m.out) : '—'}</td>
                <td className="num">{m.bank == null ? <span className="small-muted">no balance column</span> : money2(m.bank)}</td>
                <td className="num">{money2(m.books)}</td>
                <td className="num">{m.gap == null ? '—' : <b style={{ color: gapColor(m.gap) }}>{signedMoney(m.gap)}</b>}</td>
                <td>
                  {m.open ? <span className="status priority-high">{m.open} to match</span> : <span className="status priority-low">all matched</span>}
                  {m.posted ? <div className="small-muted">{m.posted} posted</div> : null}
                </td>
              </tr>
            ))}
            {!months.length && (
              <tr><td colSpan="8" className="empty">No statement lines yet. Press <b>Import statement</b> — the cleared amounts and the balance fill in by themselves.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="small-muted" style={{ marginTop: 8 }}>
        <b>Bank says</b> is the closing balance printed on the statement for that month. <b>This app says</b> is the opening
        balance plus every line imported up to that date. When the two agree the month is reconciled.
      </div>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          Notes typed by hand{marks.marks.length ? ` · ${marks.marks.length}` : ''}
          <span className="small-muted"> — for a passbook figure or a cheque that is not on any statement</span>
        </summary>
        {marks.marks.length ? (
          <div className="tbl-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>Date</th><th>What</th><th className="num">Bank says</th><th className="num">Cleared</th><th className="num">This app says</th><th className="num">Difference</th><th>Note</th><th /></tr>
              </thead>
              <tbody>
                {marks.marks.map((m) => (
                  <tr key={m.id}>
                    <td>{fmtD(m.date)}<div className="small-muted">{m.recordedBy}</div></td>
                    <td>{m.kind}</td>
                    <td className="num">{m.balance == null ? '—' : money2(m.balance)}</td>
                    <td className="num">{m.cleared == null ? '—' : money2(m.cleared)}</td>
                    <td className="num">{m.books == null ? '—' : money2(m.books)}</td>
                    <td className="num">{m.gap == null ? '—' : <b style={{ color: gapColor(m.gap) }}>{signedMoney(m.gap)}</b>}</td>
                    <td className="small-muted">{m.note}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {m.balance != null && /opening/i.test(m.kind) && (
                        <button className="btn btn-sm" onClick={() => call('post', `/bank/marks/${m.id}/use-opening`, {}, (d) => `Opening balance set to ${money2(d.openBal)}.`)}>Set opening</button>
                      )}{' '}
                      <button className="btn btn-sm" onClick={() => call('delete', `/bank/marks/${m.id}`, undefined, () => 'Removed.')}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="small-muted" style={{ marginTop: 8 }}>Nothing typed in — the table above already comes from the statements.</div>
        )}
      </details>
    </div>
  );
}

function ImportsCard({ imports, transactions, call }) {
  if (!transactions.length) return null;
  return (
    <div className="card section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Statements imported · {imports.length}</h3>
        <span className="small-muted">{transactions.length} line(s) on this account in total</span>
      </div>
      {imports.length ? (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Imported on</th><th>File</th><th>Statement period</th><th className="num">Lines</th><th className="num">Money in</th><th className="num">Money out</th><th>Credits</th><th /></tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.id}>
                  <td>{fmtD(i.date)}<div className="small-muted">{i.recordedBy}</div></td>
                  <td className="small-muted">{i.file || '—'}</td>
                  <td className="small-muted">{i.fromDate ? fmtD(i.fromDate) : '—'}{i.toDate && i.toDate !== i.fromDate ? ` → ${fmtD(i.toDate)}` : ''}</td>
                  <td className="num">{i.onFile}{i.removed ? <div className="small-muted">{i.removed} removed</div> : null}</td>
                  <td className="num">{money(i.credits)}</td>
                  <td className="num">{money(i.debits)}</td>
                  <td>
                    {i.open ? <span className="status priority-high">{i.open} to match</span> : <span className="status priority-low">all matched</span>}
                    {i.posted ? <div className="small-muted">{i.posted} posted</div> : null}
                  </td>
                  <td><button className="btn btn-sm" onClick={() => call('delete', `/bank/imports/${i.id}`, undefined, (d) => `${d.deleted} line(s) removed.`)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="small-muted">
          These {transactions.length} line(s) were added before the app started keeping an import history, or entered by hand.
          Everything imported from now on is listed here with its file name and period.
        </div>
      )}
    </div>
  );
}

function DuplicatesCard({ position, accountId, call }) {
  const groups = position?.duplicates || [];
  if (!groups.length) return null;
  const extra = groups.reduce((s, g) => s + (g.copies - 1), 0);
  const value = groups.reduce((s, g) => s + (g.copies - 1) * (g.type === 'Credit' ? g.amount : -g.amount), 0);
  return (
    <div className="card section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>The same line imported more than once · {extra}</h3>
        <span className="small-muted">Same day, same amount, same reference — the second copy is counted twice in the books</span>
        <span style={{ flex: 1 }} />
        <span className="status priority-high">{signedMoney(value)} of double counting</span>
        <button className="btn btn-primary btn-sm" onClick={() => call('post', '/bank/duplicates/remove', { bankAccountId: accountId }, (d) => `${d.removed} duplicate line(s) removed.`)}>
          Remove the {extra} extra copy(ies)
        </button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Date</th><th>Statement details</th><th className="num">Withdrawal</th><th className="num">Deposit</th><th className="num">Copies</th><th>Already filed?</th></tr></thead>
          <tbody>
            {groups.slice(0, 60).map((g) => (
              <tr key={g.ids[0]}>
                <td>{fmtD(g.date)}</td>
                <td className="small-muted">{String(g.description || '—').slice(0, 110)}{g.reference ? ` (Ref# ${g.reference})` : ''}</td>
                <td className="num">{g.type === 'Debit' ? money2(g.amount) : '—'}</td>
                <td className="num">{g.type === 'Credit' ? money2(g.amount) : '—'}</td>
                <td className="num"><b>{g.copies}</b></td>
                <td>{g.postedExtras ? <span className="status priority-medium">an extra copy is already posted</span> : <span className="status priority-low">safe to remove</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small-muted" style={{ marginTop: 8 }}>
        The <b>first</b> copy of each line is kept, every later copy is removed. A copy that was already filed against a client or a
        bill must be undone first, so nothing is left pointing at a line that no longer exists.
      </div>
    </div>
  );
}

// How a credit finds its client — written down inside the app, with the live
// figures filled in, so it can never drift from the behaviour.
function HowMatchCard({ position }) {
  const e = position?.engine;
  if (!e) return null;
  const Step = ({ n, title, tag, children }) => (
    <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
      <span className="status" style={{ minWidth: 26, justifyContent: 'center' }}>{n}</span>
      <div>
        <b>{title}</b> {tag}
        <div className="small-muted">{children}</div>
      </div>
    </div>
  );
  return (
    <details className="card section">
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
        How a credit finds its client
        <span className="small-muted" style={{ fontWeight: 400 }}> — the exact order the app tries, and what each answer means</span>
      </summary>
      <div className="notice" style={{ marginTop: 12 }}>
        <span>
          Every credit is put through these in order and stops at the first one that fits. Amounts are allowed to differ by
          {' '}<b>{money2(e.tolerance)}</b> — banks and clients round differently. Right now: <b>{e.clients}</b> client(s) on file,
          {' '}<b>{e.openInvoices}</b> open invoice(s), <b>{e.rules}</b> narration rule(s) learnt.
        </span>
      </div>
      <Step n="1" title="Is it already in the books?" tag={<span className="status">already in books</span>}>
        A receipt already recorded with the same reference (five characters or more, found inside the narration), or with the
        same amount on the same day.
      </Step>
      <Step n="2" title="Is a client named in the narration?">
        Each client name is split into its words of four letters or more. A word counts if it appears in the narration — or if
        its first five letters do, because banks cut names short. A word only one or two clients use is worth two points, a
        common word one. Three points names the client. A cheque deposit that prints one word only is matched on that word
        alone when it belongs to exactly one client.
      </Step>
      <div style={{ paddingLeft: 26 }}>
        <Step n="2a" title="Their open invoice matches the amount exactly" tag={<span className="status priority-low">client named</span>}>
          The credit clears that one invoice. This is the strongest answer.
        </Step>
        <Step n="2b" title="It does not match one invoice exactly" tag={<span className="status priority-low">client named</span>}>
          The credit is spread across their open invoices, <b>oldest first</b>. Anything left over stays unposted and shows as a
          tag on the line.
        </Step>
        <Step n="2c" title="They have no invoice outstanding" tag={<span className="status priority-medium">check invoice</span>}>
          The client is named but nothing is owed — so it is left for you. It may be an advance, or a receipt against an invoice
          already settled.
        </Step>
      </div>
      <Step n="3" title="No name — does the amount fit one open invoice?" tag={<span className="status priority-medium">amount only — check</span>}>
        If exactly one open invoice is outstanding for this amount, that invoice is suggested. The narration does not name them,
        so this is a suggestion, never an automatic posting.
      </Step>
      <Step n="4" title="Several invoices are for this exact amount" tag={<span className="status priority-medium">several match</span>}>
        The app will not guess between them. Open the line and pick.
      </Step>
      <Step n="5" title="Nothing fits" tag={<span className="status priority-high">no match</span>}>
        Before giving up the app reads the narration once more: our own company name or one of our own account numbers means
        {' '}<b>our own transfer</b>; a plain person&rsquo;s name — two to four words with no LTD, COLLEGE or PVT in it — means a
        {' '}<b>hand loan</b>. Otherwise it is left for you.
      </Step>
      <div className="notice">
        <span>
          <b>What posts by itself.</b> Only <b>client named</b> — steps 2a and 2b — is posted automatically, and only while
          auto-post is on; change it in the Import statement dialog. <b>Amount only</b>, <b>several match</b> and
          {' '}<b>check invoice</b> always wait for you. Every posting can be undone from its own row.
        </span>
      </div>
      <div className="notice">
        <span>
          <b>What the app never guesses.</b> It does not invent a client, does not part-pay an invoice you did not choose beyond
          the oldest-first rule, and does not touch a line you have excluded. A credit it cannot place stays on the uncategorised
          list rather than landing in the wrong client&rsquo;s account.
        </span>
      </div>
    </details>
  );
}

// ===========================================================================
// Dialogs
// ===========================================================================

function Dialogs({ dialog, setDialog, accountId, accounts, call, load, rules, clientNames, act }) {
  const close = () => setDialog(null);
  if (dialog.kind === 'import') return <ImportDialog accountId={accountId} onClose={close} call={call} />;
  if (dialog.kind === 'account') return <AccountDialog account={dialog.account} accounts={accounts} onClose={close} call={call} />;
  if (dialog.kind === 'entry') return <EntryDialog accountId={accountId} onClose={close} call={call} />;
  if (dialog.kind === 'mark') return <MarkDialog accountId={accountId} onClose={close} call={call} />;
  if (dialog.kind === 'rules') return <RulesDialog rules={rules} onClose={close} call={call} />;
  if (dialog.kind === 'catz') return <CatzDialog txn={dialog.txn} startTab={dialog.tab} onClose={close} call={call} act={act} load={load} clientNames={clientNames} />;
  return null;
}

function ImportDialog({ accountId, onClose, call }) {
  const [csv, setCsv] = useState('');
  const [dedup, setDedup] = useState('Yes');
  const [autoPost, setAutoPost] = useState('yes');
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');

  async function doPreview(text) {
    setErr('');
    setPreview(null);
    try {
      const res = await api.post('/bank/preview', { csv: text ?? csv });
      setPreview(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not read it.');
    }
  }

  function readFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f.name);
    if (/\.xls$/i.test(f.name)) {
      setErr('This is an old Excel file (.xls). Open it in Excel and use File → Save As to save it as Excel Workbook (.xlsx) or CSV, then choose that file here.');
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const text = String(fr.result || '');
      if (text.slice(0, 2) === 'PK') {
        setErr('That is a spreadsheet, not a text file. Save it as CSV and choose it again.');
        return;
      }
      setCsv(text);
      doPreview(text);
    };
    fr.readAsText(f);
  }

  return (
    <Modal
      title="Import bank statement"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => doPreview()}>Preview</button>
          <button
            className="btn btn-primary"
            disabled={!csv.trim()}
            onClick={async () => {
              const d = await call('post', '/bank/import', { csv, dedup, autoPost, file: file || 'pasted text', bankAccountId: accountId },
                (r) => `${r.imported} line(s) imported${r.duplicates ? ` · ${r.duplicates} already there` : ''}${r.openingSetTo != null ? ` · opening balance set to ${money(r.openingSetTo)}` : ''}${r.autoPosted ? ` · ${r.autoPosted} credit(s) posted to clients` : ''}.`);
              if (d) onClose();
            }}
          >
            Import
          </button>
        </>
      )}
    >
      <div className="field">
        <label>Statement file — CSV or Excel (.xlsx)</label>
        <input type="file" accept=".csv,.txt,.tsv,.xlsx" onChange={readFile} />
        <div className="small-muted" style={{ marginTop: 4 }}>
          Choose the file straight from net banking — <b>CSV</b> or <b>Excel (.xlsx)</b> both work. An old <b>.xls</b> cannot be
          read: open it in Excel and save as .xlsx or CSV first.
        </div>
      </div>
      <div className="field">
        <label>…or paste the rows straight from the statement</label>
        <textarea
          rows={8}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 11.5 }}
          placeholder={'Date,Narration,Ref No,Withdrawal,Deposit,Balance\n29/07/2026,NEFT-GEETHANJALI COLLEGE,UTR12345,,192340.00,845210.00'}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Skip lines already imported</label>
        <select value={dedup} onChange={(e) => setDedup(e.target.value)}>
          <option value="Yes">Yes — safest</option>
          <option value="No">No — import everything</option>
        </select>
      </div>
      <div className="field">
        <label>Post the credits automatically</label>
        <select value={autoPost} onChange={(e) => setAutoPost(e.target.value)}>
          <option value="yes">Yes — post every matched credit as soon as it is read</option>
          <option value="no">No — show me the matches, I will confirm each one</option>
        </select>
        <div className="small-muted" style={{ marginTop: 4 }}>
          Only credits where the narration names a client who still owes money are posted. The oldest invoice is settled first,
          anything extra is left alone, and every posting can be undone.
        </div>
      </div>
      {err && <div className="notice amber"><span><b>Could not read it.</b> {err}</span></div>}
      {preview ? (
        <div className="notice">
          <span>
            <b>{preview.lines} line(s) read</b> — {preview.credits} credit(s) {money(preview.creditValue)} · {preview.debits} debit(s) {money(preview.debitValue)}
            <br />{fmtD(preview.from)} to {fmtD(preview.to)}
            {preview.skipped ? <><br /><span className="small-muted">{preview.skipped} line(s) skipped — no readable date.</span></> : null}
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Date</th><th>Narration</th><th className="num">Out</th><th className="num">In</th></tr></thead>
                <tbody>
                  {preview.sample.map((x, n) => (
                    <tr key={n}>
                      <td>{fmtD(x.date)}</td>
                      <td className="small-muted">{String(x.description || '').slice(0, 60)}</td>
                      <td className="num">{x.type === 'Debit' ? money(x.amount) : '—'}</td>
                      <td className="num">{x.type === 'Credit' ? money(x.amount) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </span>
        </div>
      ) : (!err && <div className="notice"><span>Choose a file or paste the rows, then press <b>Preview</b>.</span></div>)}
    </Modal>
  );
}

function AccountDialog({ account, accounts, onClose, call }) {
  const isNew = !account;
  const [f, setF] = useState({
    bank: account?.bank || '',
    name: account?.name || '',
    accNo: account?.accNo || '',
    ifsc: account?.ifsc || '',
    branch: account?.branch || '',
    openBal: account?.openBal ?? 0,
    openDate: account?.openDate || todayIso(),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={isNew ? 'Add a bank account' : (account.bank || 'Bank account')}
      note={isNew
        ? 'A second account — each one keeps its own statement, its own balance and its own opening figure'
        : `Balance now ${money2(account.stat.inBooks)} · ${account.stat.lines} statement line(s)`}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {!isNew && accounts.length > 1 && (
            <button className="btn btn-danger" onClick={async () => { const d = await call('delete', `/bank/accounts/${account.id}`, undefined, (r) => `Account removed · ${r.removed} line(s).`); if (d) onClose(); }}>Remove</button>
          )}
          <button
            className="btn btn-primary"
            onClick={async () => {
              const body = { ...f, openBal: Number(f.openBal || 0) };
              const d = isNew ? await call('post', '/bank/accounts', body, () => 'Saved.') : await call('put', `/bank/accounts/${account.id}`, body, () => 'Saved.');
              if (d) onClose();
            }}
          >
            Save
          </button>
        </>
      )}
    >
      <div className="grid-2">
        <div className="field"><label>Bank *</label><input value={f.bank} onChange={set('bank')} placeholder="HDFC Bank" /></div>
        <div className="field"><label>Account name</label><input value={f.name} onChange={set('name')} placeholder="Teamlink Consultants (OPC) Pvt Ltd" /></div>
        <div className="field"><label>Account number</label><input value={f.accNo} onChange={set('accNo')} /></div>
        <div className="field"><label>IFSC</label><input value={f.ifsc} onChange={set('ifsc')} /></div>
        <div className="field"><label>Branch</label><input value={f.branch} onChange={set('branch')} /></div>
        <div className="field"><label>Opening balance</label><input value={f.openBal} onChange={set('openBal')} inputMode="decimal" /></div>
        <div className="field"><label>Balance as on</label><input type="date" value={f.openDate} onChange={set('openDate')} /></div>
      </div>
      <div className="notice" style={{ marginTop: 12 }}>
        <span>
          The opening balance is what the account held before the first statement line you import. Get it right and the app&rsquo;s
          running balance will agree with your passbook exactly.
          {isNew && ' Statements, balances and postings are kept per account, so importing into this one will not touch the other.'}
        </span>
      </div>
    </Modal>
  );
}

function EntryDialog({ accountId, onClose, call }) {
  const [f, setF] = useState({ date: todayIso(), credit: '', debit: '', reference: '', description: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title="Add a bank entry"
      note="Type a single credit or debit by hand"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const d = await call('post', '/bank/entry', { ...f, bankAccountId: accountId }, () => 'Entry added.');
              if (d) onClose();
            }}
          >
            Add entry
          </button>
        </>
      )}
    >
      <div className="grid-2">
        <div className="field"><label>Date *</label><input type="date" value={f.date} onChange={set('date')} /></div>
        <div className="field"><label>Money in (credit)</label><input value={f.credit} onChange={set('credit')} inputMode="decimal" placeholder="0.00" /></div>
        <div className="field"><label>Money out (debit)</label><input value={f.debit} onChange={set('debit')} inputMode="decimal" placeholder="0.00" /></div>
        <div className="field"><label>Reference / UTR</label><input value={f.reference} onChange={set('reference')} /></div>
      </div>
      <div className="field"><label>Narration</label><input value={f.description} onChange={set('description')} placeholder="As it reads on the statement" /></div>
    </Modal>
  );
}

const MARK_KINDS = ['Bank balance on that date', 'Cleared / settled', 'Opening balance', 'Adjustment'];

function MarkDialog({ accountId, onClose, call }) {
  const [f, setF] = useState({ date: todayIso(), kind: MARK_KINDS[0], balance: '', cleared: '', match: '', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title="Note a balance by hand"
      note="For a passbook figure or a cheque that is not on any statement"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const d = await call('post', '/bank/marks', { ...f, bankAccountId: accountId }, () => `Noted for ${fmtD(f.date)}.`);
              if (d) onClose();
            }}
          >
            Save
          </button>
        </>
      )}
    >
      <div className="grid-2">
        <div className="field"><label>Date</label><input type="date" value={f.date} onChange={set('date')} /></div>
        <div className="field">
          <label>What is this</label>
          <select value={f.kind} onChange={set('kind')}>{MARK_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        </div>
        <div className="field"><label>Balance as per bank</label><input value={f.balance} onChange={set('balance')} inputMode="decimal" placeholder="0.00" /></div>
        <div className="field"><label>Amount cleared</label><input value={f.cleared} onChange={set('cleared')} inputMode="decimal" placeholder="0.00" /></div>
      </div>
      <div className="field">
        <label>Name to look for in the statement</label>
        <input value={f.match} onChange={set('match')} placeholder="e.g. VCARE, ARV WORKSPACES, cheque 43122" />
        <div className="small-muted" style={{ marginTop: 4 }}>Any statement line whose narration or reference carries this text is pulled in under the note.</div>
      </div>
      <div className="field"><label>Note</label><input value={f.note} onChange={set('note')} placeholder="e.g. passbook updated at the branch" /></div>
      <div className="notice" style={{ marginTop: 12 }}><span>It appears in the same table, in its own month, with the app&rsquo;s own figure beside it.</span></div>
    </Modal>
  );
}

function RulesDialog({ rules, onClose, call }) {
  return (
    <Modal
      title="Transaction rules"
      note={`${rules.length} rule(s) the app has learnt from you`}
      size="wide"
      onClose={onClose}
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Text on the statement</th><th>Becomes</th><th>Group</th><th className="num">Lines matched</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.match}</td>
                <td><b>{r.category}</b>{r.vendor && <div className="small-muted">{r.vendor}</div>}</td>
                <td className="small-muted">{r.group}</td>
                <td className="num">{r.lines}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => call('delete', `/bank/rules/${r.id}`, undefined, () => 'Rule deleted.')}>Delete</button></td>
              </tr>
            ))}
            {!rules.length && (
              <tr><td colSpan="5" className="empty">No rules yet. Categorise one line and press <b>Save &amp; remember this narration</b> — the wording is kept and every future statement uses it.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// The two-tab categorisation panel: every match the app can see, and a form to
// file the line by hand.
function CatzDialog({ txn, startTab, onClose, call, act, load }) {
  const [tab, setTab] = useState(startTab || 'match');
  const [data, setData] = useState(null);
  const [ticked, setTicked] = useState([]);
  const [form, setForm] = useState({ kind: 'expense', category: '', vendor: '', party: '', match: '', gstRate: '' });

  useEffect(() => {
    api.get(`/bank/${txn.id}/candidates`).then((r) => {
      setData(r.data);
      const g = r.data.suggestion;
      setForm((f) => ({
        ...f,
        kind: g?.kind === 'transfer' ? 'transfer' : g?.kind === 'hand' ? 'hand' : 'expense',
        category: g?.category || '',
        vendor: g?.vendor || '',
        party: g?.party || '',
        match: (r.data.words || [])[0] || '',
      }));
    });
  }, [txn.id]);

  const isCredit = txn.type === 'Credit';
  const rows = data ? [...data.best.map((x) => ({ ...x, tag: 'best' })), ...data.maybe.map((x) => ({ ...x, tag: 'maybe' }))] : [];

  return (
    <Modal
      title={`${isCredit ? 'Money in' : 'Money out'} · ${money2(txn.amount)}`}
      note={`${fmtD(txn.date)} · ${String(txn.description || '').slice(0, 110)}${txn.reference ? ` · Ref ${txn.reference}` : ''}`}
      size="wide"
      onClose={onClose}
      footer={tab === 'cat' ? (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={async () => { const d = await call('post', `/bank/${txn.id}/categorise`, { ...form }, () => 'Saved.'); if (d) onClose(); }}>Save</button>
          <button className="btn btn-primary" onClick={async () => { const d = await call('post', `/bank/${txn.id}/categorise`, { ...form, remember: true }, (r) => (r.rule ? `Saved — every line carrying “${r.rule.match}” is filed under ${r.rule.category} from now on.` : 'Saved.')); if (d) onClose(); }}>Save &amp; remember this narration</button>
        </>
      ) : (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={ticked.length !== 1}
            onClick={async () => {
              const d = isCredit
                ? await act(txn.id, 'match', { invoiceId: ticked[0] })
                : await call('post', `/bank/${txn.id}/categorise`, { kind: 'expense', category: (data.maybe.concat(data.best).find((x) => x.id === ticked[0]) || {}).category || '' }, () => 'Filed.');
              if (d) { load(); onClose(); }
            }}
          >
            Match the ticked one(s)
          </button>
        </>
      )}
    >
      <div className="tabbar">
        <button className={`tab-btn ${tab === 'match' ? 'active' : ''}`} onClick={() => setTab('match')}>Match transactions</button>
        <button className={`tab-btn ${tab === 'cat' ? 'active' : ''}`} onClick={() => setTab('cat')}>Categorise manually</button>
      </div>

      {tab === 'match' ? (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>{isCredit ? 'Invoice' : 'Office bill'}</th>
                <th>{isCredit ? 'Client' : 'Vendor'}</th>
                <th>Date</th>
                <th className="num">{isCredit ? 'Pending' : 'Net'}</th>
                <th className="num">Difference</th>
                <th>How close</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={ticked.includes(o.id)}
                      onChange={(e) => setTicked(e.target.checked ? [...ticked, o.id] : ticked.filter((x) => x !== o.id))}
                    />
                  </td>
                  <td><b>{isCredit ? o.invoiceNumber : o.category}</b></td>
                  <td>{isCredit ? o.client : (o.vendor || '—')}</td>
                  <td>{fmtD(isCredit ? o.invoiceDate : o.expenseDate)}</td>
                  <td className="num">{money2(isCredit ? o.outstanding : o.net)}</td>
                  <td className="num">{o.diff === 0 ? 'exact' : signedMoney(o.diff)}</td>
                  <td>
                    {o.tag === 'best'
                      ? <span className="status priority-low">the amount matches</span>
                      : <span className="status">worth a look</span>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan="7" className="empty">{isCredit ? 'No open invoice for this amount. Use Categorise manually.' : 'No office bill matches this amount. Use Categorise manually.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          {data?.read && (
            <div className="notice">
              <span><b>{data.read.tag}</b> — {data.read.why}</span>
            </div>
          )}
          <div className="grid-2">
            <div className="field">
              <label>What is this</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="expense">An office bill</option>
                <option value="hand">A hand loan — not an expense</option>
                <option value="transfer">Our own transfer — not an expense</option>
                <option value="other">Other income</option>
              </select>
            </div>
            {(form.kind === 'expense' || form.kind === 'other') && (
              <div className="field">
                <label>File it under</label>
                <input list="catz-cats" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Bank Fees and Charges" />
                <datalist id="catz-cats">{(data?.categories || []).map((c) => <option key={c} value={c} />)}</datalist>
              </div>
            )}
            {form.kind === 'expense' && (
              <div className="field"><label>Vendor</label><input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
            )}
            {form.kind === 'hand' && (
              <div className="field"><label>Who</label><input value={form.party} onChange={(e) => setForm({ ...form, party: e.target.value })} /></div>
            )}
            <div className="field">
              <label>Remember this wording</label>
              <input value={form.match} onChange={(e) => setForm({ ...form, match: e.target.value })} placeholder="the words to look for" />
              <div className="small-muted" style={{ marginTop: 4 }}>Every future statement line carrying this text is filed the same way.</div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ n, l, sub }) {
  return (
    <div className="statitem">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {sub && <div className="l" style={{ opacity: 0.75 }}>{sub}</div>}
    </div>
  );
}

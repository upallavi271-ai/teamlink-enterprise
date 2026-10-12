// Accounts -> Journal & Ledger -> Import (Accounts fixes, 2026-10-09).
// ONE dialog behind the Import button of the Journal tab and of the Ledger tab:
//
//   kind="journal"   a file of journal lines; every entry must balance
//   kind="ledger"    OPENING balances (the ledger is made from the journal, so an
//                    opening balance is posted as one balanced journal entry)
//
// 1 Get the sample file -> 2 Choose your file -> 3 Check (every row, nothing is
// saved) - fix cells right here or choose a corrected file -> 4 Import.
// The server checks everything again on Import and answers per entry: imported /
// skipped (already there) / failed (with the reason).
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { downloadFile, money, errText } from '../payroll/payrollUi';
import './booksImport.css';

const KIND = {
  journal: {
    title: 'Import journal entries',
    sample: 'journal-import-sample',
    cols: [
      ['entryNo', 'Entry No', 80], ['date', 'Date', 105], ['account', 'Account', 120], ['debit', 'Debit', 80], ['credit', 'Credit', 80],
      ['narration', 'Narration', 130], ['note', 'Line note', 90], ['reference', 'Reference', 80],
    ],
    help: 'One row is one line of an entry. Lines with the same Entry No make one entry, and its Debit total must equal its Credit total.',
  },
  ledger: {
    title: 'Import opening balances',
    sample: 'opening-balances-import-sample',
    cols: [
      ['date', 'As on date', 105], ['account', 'Account code', 90], ['accountName', 'Account name', 140], ['debit', 'Opening debit', 90], ['credit', 'Opening credit', 90],
      ['reference', 'Reference', 90], ['accountType', 'Type (new account)', 100],
    ],
    help: 'The ledger is built from the journal, so opening balances are saved as one balanced journal entry per date. Each account gets one opening balance.',
  },
};

const saveText = (o) => JSON.stringify(o);
const octet = { headers: { 'Content-Type': 'application/octet-stream' } };
const statusBadge = (s) => (s === 'ready' ? ['green', 'Ready'] : s === 'duplicate' ? ['grey', 'Already there'] : ['red', 'Needs fixing']);

export default function BooksImport({ kind, onClose, onDone }) {
  const cfg = KIND[kind];
  const [step, setStep] = useState('pick'); // pick | check | done
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [opts, setOpts] = useState({ createAccounts: false, plugDifference: false });
  const [dirty, setDirty] = useState(false);
  const [removed, setRemoved] = useState(0);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [result, setResult] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [sampleBusy, setSampleBusy] = useState('');
  const [imported, setImported] = useState(false);
  const seq = useRef(0);
  const nextLine = useRef(100000);

  useEffect(() => { api.get('/accounts/chart-of-accounts').then((r) => setAccounts(r.data || [])).catch(() => setAccounts([])); }, []);

  const base = `/accounts/books-import/${kind}`;
  async function sample(fmt) {
    setSampleBusy(fmt); setError('');
    try { await downloadFile(`${base}/sample?format=${fmt}`, `${cfg.sample}.${fmt}`); } catch (e) { setError(errText(e, 'The sample file could not be downloaded.')); } finally { setSampleBusy(''); }
  }

  async function readFile(f, o = opts) {
    setBusy('read'); setError('');
    try {
      const buf = await f.arrayBuffer();
      const q = `fileName=${encodeURIComponent(f.name)}${o.createAccounts ? '&createAccounts=1' : ''}${o.plugDifference ? '&plugDifference=1' : ''}`;
      const r = await api.post(`${base}/preview?${q}`, buf, octet);
      setData(r.data); setRows(r.data.rows); setDirty(false); setRemoved(0); setStep('check'); setResult(null);
    } catch (e) {
      setError(e?.response?.data?.error || errText(e, 'That file could not be read. Save it as .xlsx or .csv and try again.'));
    } finally { setBusy(''); }
  }
  function pickFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setFile(f);
    readFile(f);
  }

  // Re-check the edited rows (the server decides, the screen only shows).
  async function recheck(list = rows, o = opts) {
    const mine = seq.current + 1;
    seq.current = mine;
    setBusy('check'); setError('');
    try {
      const r = await api.post(`${base}/check`, saveText({ rows: list, options: o }), octet);
      if (seq.current !== mine) return;
      setData((d) => ({ ...d, ...r.data }));
      // keep what the person typed; take the verdicts
      const verdict = new Map(r.data.rows.map((x) => [x.line, x]));
      setRows((cur) => cur.map((x) => { const v = verdict.get(x.line); return v ? { ...x, errors: v.errors, state: v.state, resolved: v.resolved, dupNote: v.dupNote, entryKey: v.entryKey } : x; }));
      setDirty(false);
    } catch (e) {
      if (seq.current === mine) setError(errText(e, 'Could not check the rows. Please try again.'));
    } finally { if (seq.current === mine) setBusy(''); }
  }
  // Auto re-check 0.9 s after the last edit.
  useEffect(() => {
    if (!dirty || step !== 'check') return undefined;
    const t = setTimeout(() => recheck(rows, opts), 900);
    return () => clearTimeout(t);
  }, [dirty, rows, opts, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (line, field, value) => { setRows((cur) => cur.map((r) => (r.line === line ? { ...r, [field]: value } : r))); setDirty(true); };
  const drop = (line) => { setRows((cur) => cur.filter((r) => r.line !== line)); setRemoved((n) => n + 1); setDirty(true); };
  function addLine(after) {
    nextLine.current += 1;
    const blank = Object.fromEntries(cfg.cols.map(([f]) => [f, '']));
    const seed = kind === 'journal' ? { entryNo: after?.entryNo || '', date: after?.date || '', narration: '' } : { date: after?.date || '' };
    const row = { ...blank, ...seed, line: nextLine.current, errors: {}, state: 'ok', entryKey: after?.entryKey };
    setRows((cur) => {
      if (!after) return [...cur, row];
      const i = cur.findIndex((r) => r.line === after.line);
      const copy = cur.slice(); copy.splice(i + 1, 0, row); return copy;
    });
    setDirty(true);
  }
  function setOpt(k, v) {
    const o = { ...opts, [k]: v };
    setOpts(o);
    recheck(rows, o);
  }

  const sum = data?.summary || {};
  // group rows under their entry (in the entry order the server gave)
  const groups = useMemo(() => {
    if (!data) return [];
    const byKey = new Map();
    rows.forEach((r) => {
      const k = r.entryKey || '__new';
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const out = (data.entries || []).filter((e) => byKey.has(e.key)).map((e) => ({ entry: e, rows: byKey.get(e.key) }));
    if (byKey.has('__new')) out.push({ entry: { key: '__new', entryNo: 'New lines', status: 'error', message: 'Checking…', debit: 0, credit: 0 }, rows: byKey.get('__new') });
    return onlyProblems ? out.filter((g) => g.entry.status === 'error') : out;
  }, [data, rows, onlyProblems]);

  async function commit() {
    setBusy('commit'); setError('');
    try {
      const r = await api.post(`${base}/commit`, saveText({ rows, options: opts, fileName: file ? file.name : null }), octet);
      setResult(r.data); setStep('done'); setImported(true);
    } catch (e) {
      // 207 is delivered as a normal answer by axios when validateStatus allows it; anything else is a failure
      const d = e?.response?.data;
      if (d && d.summary) { setResult(d); setStep('done'); setImported(d.summary.imported > 0); } else setError(errText(e, 'The import failed - nothing was saved.'));
    } finally { setBusy(''); }
  }
  function backToFix() {
    const failedLines = new Set((result?.results || []).filter((x) => x.status === 'failed').flatMap((x) => x.rowLines));
    const keep = rows.filter((r) => failedLines.has(r.line));
    setRows(keep); setResult(null); setStep('check'); setDirty(true);
  }
  function close() { if (imported && onDone) onDone(result); onClose(); }

  const fail = result?.summary?.failed || 0;
  const busyAny = !!busy;
  const dl = <datalist id="bi-accounts">{accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}</datalist>;

  return (
    <Modal
      title={cfg.title}
      size="xwide"
      onClose={close}
      foot={step === 'done' ? (
        <>
          {fail > 0 && <button type="button" className="btn" onClick={backToFix}>Fix the {fail} that failed</button>}
          <button type="button" className="btn btn-primary" onClick={close}>Done</button>
        </>
      ) : (
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          {step === 'check' && (
            <button type="button" className="btn btn-primary" disabled={busyAny || dirty || !sum.ready} onClick={commit}>
              {busy === 'commit' ? 'Importing…' : dirty || busy === 'check' ? 'Checking…' : `Import ${sum.ready || 0} ${kind === 'journal' ? ((sum.ready === 1) ? 'entry' : 'entries') : ((sum.ready === 1) ? 'opening entry' : 'opening entries')}`}
            </button>
          )}
        </>
      )}
    >
      <div className="bi">
        {dl}
        {step === 'pick' && (
          <ol className="bi-steps">
            <li>
              <b>1. Get the sample file</b> <span className="small-muted">{cfg.help}</span>
              <div className="bi-row">
                <button type="button" className="btn btn-sm" disabled={!!sampleBusy} onClick={() => sample('xlsx')}>{sampleBusy === 'xlsx' ? 'Preparing…' : 'Download sample (Excel)'}</button>
                <button type="button" className="btn btn-sm" disabled={!!sampleBusy} onClick={() => sample('csv')}>{sampleBusy === 'csv' ? 'Preparing…' : 'Download sample (CSV)'}</button>
              </div>
            </li>
            <li>
              <b>2. Fill it in and choose it here</b> <span className="small-muted">(.xlsx or .csv, up to 5000 rows)</span>
              {kind === 'ledger' && (
                <div className="bi-row">
                  <label className="bi-chk"><input type="checkbox" checked={opts.plugDifference} onChange={(e) => setOpts((o) => ({ ...o, plugDifference: e.target.checked }))} /> Put any difference in “Opening Balance Equity”</label>
                  <label className="bi-chk"><input type="checkbox" checked={opts.createAccounts} onChange={(e) => setOpts((o) => ({ ...o, createAccounts: e.target.checked }))} /> Create new accounts that are not in the list yet</label>
                </div>
              )}
              <div className="bi-row">
                <label className={`btn btn-primary btn-sm bi-file ${busyAny ? 'disabled' : ''}`}>
                  {busy === 'read' ? 'Reading the file…' : 'Choose file'}
                  <input type="file" accept=".xlsx,.xls,.csv,.txt" disabled={busyAny} onChange={pickFile} />
                </label>
                {file && <span className="small-muted">{file.name}</span>}
              </div>
            </li>
            <li className="locked"><b>3. Check</b> — every row is checked and shown to you; nothing is saved yet.</li>
            <li className="locked"><b>4. Import</b> — only the good entries are saved. Entries with a problem are never saved.</li>
          </ol>
        )}

        {error && <div className="lb-err bi-msg">{error}</div>}

        {step === 'check' && data && (
          <>
            <div className="bi-file-line">
              <b>{file ? file.name : 'Your file'}</b>
              <label className={`btn btn-sm bi-file ${busyAny ? 'disabled' : ''}`}>
                Choose a different file
                <input type="file" accept=".xlsx,.xls,.csv,.txt" disabled={busyAny} onChange={pickFile} />
              </label>
              <button type="button" className="btn btn-sm" onClick={() => sample('xlsx')}>Sample</button>
            </div>
            {kind === 'ledger' && (
              <div className="bi-row">
                <label className="bi-chk"><input type="checkbox" checked={opts.plugDifference} onChange={(e) => setOpt('plugDifference', e.target.checked)} /> Put any difference in “Opening Balance Equity”</label>
                <label className="bi-chk"><input type="checkbox" checked={opts.createAccounts} onChange={(e) => setOpt('createAccounts', e.target.checked)} /> Create new accounts that are not in the list yet</label>
              </div>
            )}
            <div className="bi-sum">
              <span className="bi-pill green"><b>{sum.ready || 0}</b> ready</span>
              <span className="bi-pill grey"><b>{sum.duplicates || 0}</b> already there</span>
              <span className={`bi-pill ${sum.errors ? 'red' : 'grey'}`}><b>{sum.errors || 0}</b> need fixing</span>
              <span className="small-muted">{rows.length} row{rows.length === 1 ? '' : 's'} · Debit {money(sum.totalDebit)} · Credit {money(sum.totalCredit)}</span>
              {sum.sampleSkipped ? <span className="small-muted">{sum.sampleSkipped} sample row(s) ignored</span> : null}
              {removed ? <span className="small-muted">{removed} row(s) removed by you</span> : null}
              {busy === 'check' || dirty ? <span className="small-muted">Checking…</span> : null}
            </div>
            {sum.errors > 0 && <div className="lb-err bi-msg"><b>{sum.errors}</b> {kind === 'journal' ? (sum.errors === 1 ? 'entry has' : 'entries have') : 'group(s) have'} a problem and will <b>not</b> be imported. Fix the red cells below (they re-check by themselves), or choose a corrected file.</div>}
            {sum.newAccounts && sum.newAccounts.length > 0 && <div className="lb-ok bi-msg">New account(s) that will be created: {sum.newAccounts.join(', ')}</div>}
            <label className="bi-chk" style={{ margin: '6px 0' }}><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only the ones that need fixing</label>
            {rows.length === 0 ? <div className="lb-note">There are no rows left. Choose a file to start again.</div> : (
              <div className="bi-tblwrap">
                <table className="bi-tbl">
                  <thead>
                    <tr>
                      <th className="bi-ln">Row</th>
                      {cfg.cols.map(([f, l]) => <th key={f} className={f === 'debit' || f === 'credit' ? 'bi-numh' : ''}>{l}</th>)}
                      <th>What is wrong</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(({ entry, rows: gr }) => {
                      const [cls, label] = statusBadge(entry.status);
                      return [
                        <tr key={`h-${entry.key}`} className="bi-grp">
                          <td colSpan={cfg.cols.length + 3}>
                            <span className={`lb-badge ${cls}`}>{label}</span>{' '}
                            <b>{entry.entryNo}</b>{entry.date ? ` · ${entry.date}` : ''} · Debit {money(entry.debit)} · Credit {money(entry.credit)}
                            {entry.difference > 0 && <span className="bi-diff"> · difference {money(entry.difference)}</span>}
                            {entry.message && entry.status !== 'ready' && <div className="bi-gmsg">{entry.message}</div>}
                            <button type="button" className="btn btn-sm bi-add" onClick={() => addLine(gr[gr.length - 1])}>+ Add a line</button>
                          </td>
                        </tr>,
                        ...gr.map((r) => {
                          const errs = r.errors || {};
                          const why = Object.entries(errs).filter(([k]) => k !== '_entry').map(([, m]) => m);
                          return (
                            <tr key={r.line} className={r.state === 'error' ? 'bi-bad' : r.state === 'duplicate' ? 'bi-dup' : ''}>
                              <td className="bi-ln">{r.line > 99999 ? 'new' : r.line}</td>
                              {cfg.cols.map(([f, , w]) => (
                                <td key={f}>
                                  <input
                                    className={`bi-in ${errs[f] ? 'err' : ''} ${f === 'debit' || f === 'credit' ? 'num' : ''}`}
                                    style={{ minWidth: w }}
                                    value={r[f] ?? ''}
                                    list={f === 'account' ? 'bi-accounts' : undefined}
                                    title={errs[f] || ''}
                                    aria-invalid={errs[f] ? 'true' : undefined}
                                    onChange={(e) => edit(r.line, f, e.target.value)}
                                  />
                                  {f === 'account' && r.resolved && <div className="bi-res">{r.resolved.isNew ? 'New: ' : ''}{r.resolved.name}</div>}
                                </td>
                              ))}
                              <td className="bi-why">{why.length ? why.join(' ') : r.state === 'duplicate' ? (r.dupNote || 'Already there.') : (errs._entry ? '' : <span className="bi-okc">OK</span>)}</td>
                              <td><button type="button" className="bi-x" title="Remove this row from the import" aria-label="Remove this row" onClick={() => drop(r.line)}>×</button></td>
                            </tr>
                          );
                        }),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {kind === 'journal' && rows.length > 0 && <div className="bi-row"><button type="button" className="btn btn-sm" onClick={() => addLine(null)}>+ Add a new line</button></div>}
          </>
        )}

        {step === 'done' && result && (
          <div className="bi-done">
            <div className={`bi-banner ${fail ? 'amber' : 'green'}`}>
              {fail
                ? <><b>{fail}</b> {fail === 1 ? 'entry was' : 'entries were'} NOT imported. {result.summary.imported} imported, {result.summary.skipped} skipped.</>
                : result.summary.imported
                  ? <><b>Saved.</b> {result.summary.imported} {result.summary.imported === 1 ? 'entry' : 'entries'} imported{result.summary.skipped ? `, ${result.summary.skipped} skipped because they were already there` : ''}.</>
                  : <>Nothing new to import - {result.summary.skipped} {result.summary.skipped === 1 ? 'entry was' : 'entries were'} already there.</>}
            </div>
            <div className="bi-sum">
              <span className="bi-pill green"><b>{result.summary.imported}</b> imported ({result.summary.rowsImported} rows)</span>
              <span className="bi-pill grey"><b>{result.summary.skipped}</b> skipped ({result.summary.rowsSkipped} rows)</span>
              <span className={`bi-pill ${fail ? 'red' : 'grey'}`}><b>{fail}</b> failed ({result.summary.rowsFailed} rows)</span>
            </div>
            <div className="bi-tblwrap">
              <table className="bi-tbl">
                <thead><tr><th>Entry</th><th>Date</th><th className="bi-numh">Amount</th><th>Result</th><th>Why</th></tr></thead>
                <tbody>
                  {[...result.results].sort((a, b) => (a.status === 'failed' ? -1 : 0) - (b.status === 'failed' ? -1 : 0)).map((x, i) => (
                    <tr key={i} className={x.status === 'failed' ? 'bi-bad' : x.status === 'skipped' ? 'bi-dup' : ''}>
                      <td><b>{x.entryNo}</b></td><td>{x.date || '—'}</td><td className="bi-numc">{money(x.amount)}</td>
                      <td><span className={`lb-badge ${x.status === 'imported' ? 'green' : x.status === 'skipped' ? 'grey' : 'red'}`}>{x.status === 'imported' ? 'Imported' : x.status === 'skipped' ? 'Skipped' : 'Failed'}</span></td>
                      <td className="bi-why">{x.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import vendorApi, { vendorError, vendorToken } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import './vendorIo.css';

// EXPORT + IMPORT for every vendor portal (2026-10-19). One component pair used on every list page:
//   <VendorIoBar list="repairs" params={filters} importKey="repair-updates" onImported={reload} />
//   * Export Excel / Export CSV: two plain buttons. The server builds the file from the SAME list with the SAME search and filters (no paging), only
//     the columns the page shows, and only if the login has the "Download lists" tick (otherwise the buttons are shown off, with the reason).
//   * Import: opens a window - sample file, choose the file, CHECK (nothing is saved), SAVE, result with a report. A vendor imports only what it may
//     already do one by one (repair steps and costs, order steps, its own bills). Never the company's assets: those arrive by themselves.
// The server decides everything (who may, which rows, which kind of vendor); this file only draws it.

let infoCache = { token: null, promise: null };
function loadInfo(force = false) {
  const token = vendorToken();
  if (force || infoCache.token !== token || !infoCache.promise) {
    infoCache = { token, promise: vendorApi.get('/vendor-io/info').then((r) => r.data).catch((e) => { infoCache = { token: null, promise: null }; throw e; }) };
  }
  return infoCache.promise;
}
export function useVendorIo() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; loadInfo().then((d) => { if (live) setInfo(d); }).catch(() => { if (live) setFailed(true); }); return () => { live = false; }; }, []);
  return { info, failed };
}

// An error that came back as a file (responseType blob) is still a JSON answer: read the words out of it.
async function blobError(err, fallback) {
  const d = err?.response?.data;
  if (d && typeof d.text === 'function') {
    try { const j = JSON.parse(await d.text()); if (j && j.error) return j.error; } catch { /* not JSON */ }
  }
  return vendorError(err, fallback);
}
const saveBlob = (blob, name) => {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = name || 'download'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
};
const nameFrom = (h, fallback) => { const m = /filename="?([^";]+)"?/i.exec(h || ''); return m ? m[1] : fallback; };
const tidy = (p) => Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => v !== undefined && v !== null && v !== '' && !['page', 'pageSize', 'open'].includes(k)));
// A cell in the report that starts like a formula would be run by Excel: put an apostrophe in front (same rule the server uses).
const safeCell = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) && !/^[-+]?[\d\s().,]+$/.test(s) ? `'${s}` : s; };
const csvCell = (v) => { const s = safeCell(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function VendorIoBar({ list, params, importKey, onImported, assetsNote = false, className = '' }) {
  const { info } = useVendorIo();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [dialog, setDialog] = useState(false);
  const exp = info?.export;
  const imp = info?.import;
  const item = importKey && imp ? imp.items.find((i) => i.key === importKey) : null;
  const known = !!(exp && exp.lists.some((l) => l.key === list));

  const run = useCallback(async (format) => {
    if (busy) return;
    setBusy(format); setMsg(''); setErr('');
    try {
      const res = await vendorApi.get(`/vendor-io/export/${list}`, { params: { ...tidy(params), format }, responseType: 'blob' });
      saveBlob(res.data, nameFrom(res.headers['content-disposition'], `${list}.${format}`));
      const n = Number(res.headers['x-row-count']);
      setMsg(Number.isFinite(n) ? `Downloaded ${n} ${n === 1 ? 'row' : 'rows'}. The file has what you see in the list, with your search and filters.` : 'Downloaded.');
    } catch (e) { setErr(await blobError(e, 'Could not make the file. Please try again.')); } finally { setBusy(''); }
  }, [busy, list, params]);

  if (!info || !known) return null;
  const off = !exp.allowed;
  return (
    <div className={`vio-bar ${className}`}>
      <div className="vio-btns" role="group" aria-label="Download this list or import a file">
        <button type="button" className="btn btn-sm" disabled={off || !!busy} onClick={() => run('xlsx')} title={off ? exp.reason : 'Download the list as an Excel file'}>
          {busy === 'xlsx' ? 'Preparing...' : 'Export Excel'}
        </button>
        <button type="button" className="btn btn-sm" disabled={off || !!busy} onClick={() => run('csv')} title={off ? exp.reason : 'Download the list as a CSV file'}>
          {busy === 'csv' ? 'Preparing...' : 'Export CSV'}
        </button>
        {item && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!imp.allowed} onClick={() => setDialog(true)} title={imp.allowed ? item.help : imp.reason}>
            {item.title}
          </button>
        )}
      </div>
      {off && <span className="cell-muted vio-note">{exp.reason}</span>}
      {item && !imp.allowed && <span className="cell-muted vio-note">{imp.reason}</span>}
      {assetsNote && <span className="cell-muted vio-note vio-assets">{imp.assetsNote}</span>}
      {msg && <span className="vio-ok" role="status">{msg}</span>}
      {err && <span className="vio-err" role="alert">{err}</span>}
      {dialog && item && <ImportDialog item={item} imp={imp} onClose={(changed) => { setDialog(false); if (changed && onImported) onImported(); }} />}
    </div>
  );
}

const newKey = () => {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 32); } catch { return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
};
const OUTCOME = { ok: ['vp-green', 'Will be saved'], unchanged: ['vp-grey', 'Already as it is'], duplicate: ['vp-blue', 'Already there'], error: ['vp-red', 'Problem'] };

function ImportDialog({ item, imp, onClose }) {
  const [file, setFile] = useState(null);
  const [step, setStep] = useState('pick'); // pick | checking | preview | saving | done
  const [prev, setPrev] = useState(null);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [changed, setChanged] = useState(false);
  const keyRef = useRef(newKey());
  const input = useRef(null);
  const upload = (kind) => vendorApi.post(`/vendor-io/import/${item.key}/${kind}`, file, {
    params: { fileName: file.name }, headers: { 'Content-Type': 'application/octet-stream', ...(kind === 'confirm' ? { 'Idempotency-Key': keyRef.current } : {}) }, timeout: 300000,
  });
  const sample = async (format) => {
    try {
      const r = await vendorApi.get(`/vendor-io/import/${item.key}/sample`, { params: { format }, responseType: 'blob' });
      saveBlob(r.data, nameFrom(r.headers['content-disposition'], `${item.key}-sample.${format}`));
    } catch (e) { setError(await blobError(e, 'Could not download the sample file.')); }
  };
  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0];
    setError(''); setPrev(null); setRes(null); setStep('pick'); keyRef.current = newKey();
    if (!f) { setFile(null); return; }
    if (!/\.(xlsx|csv)$/i.test(f.name)) { setFile(null); setError('Choose an Excel file (.xlsx) or a CSV file (.csv). Download the sample file to see how it looks.'); return; }
    if (f.size > imp.maxMb * 1024 * 1024) { setFile(null); setError(`That file is bigger than ${imp.maxMb} MB.`); return; }
    setFile(f);
  };
  const check = async () => {
    if (!file) return;
    setStep('checking'); setError('');
    try { const r = await upload('preview'); setPrev(r.data); setStep('preview'); } catch (e) { setError(vendorError(e, 'The file could not be checked. Nothing was saved.')); setStep('pick'); }
  };
  const save = async () => {
    if (step === 'saving') return;
    setStep('saving'); setError('');
    try { const r = await upload('confirm'); setRes(r.data); setChanged(true); setStep('done'); } catch (e) {
      setError(vendorError(e, 'The import could not be finished. Open the list to see what was saved. Pressing Save again is safe: nothing is saved twice.'));
      setChanged(true); setStep('preview');
    }
  };
  const report = () => {
    const rows = (res ? res.rows : []);
    const head = ['Line', 'Item', 'Result', 'What happened', 'What to do'];
    const word = { ok: item.key === 'bills' ? 'Sent' : 'Saved', unchanged: 'Already as it was', duplicate: 'Already there', error: 'Not saved' };
    const lines = [head, ...rows.map((r) => [r.line, r.label, word[r.outcome] || r.outcome, r.message, r.fix])];
    saveBlob(new Blob([`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }), `${item.key}-import-report.csv`);
  };
  const shown = useMemo(() => {
    const rows = (step === 'done' && res ? res.rows : prev?.rows) || [];
    return onlyProblems ? rows.filter((r) => r.outcome === 'error') : rows;
  }, [prev, res, step, onlyProblems]);
  const busy = step === 'checking' || step === 'saving';
  const foot = (
    <>
      {step === 'done'
        ? <button type="button" className="btn btn-primary" onClick={() => onClose(changed)}>Close</button>
        : <button type="button" className="btn" onClick={() => onClose(changed)} disabled={step === 'saving'}>{changed ? 'Close' : 'Cancel'}</button>}
      {step === 'pick' && <button type="button" className="btn btn-primary" onClick={check} disabled={!file}>Check the file</button>}
      {step === 'preview' && <button type="button" className="btn" onClick={() => { setStep('pick'); setPrev(null); keyRef.current = newKey(); if (input.current) input.current.value = ''; setFile(null); }}>Choose another file</button>}
      {step === 'preview' && <button type="button" className="btn btn-primary" onClick={save} disabled={!prev?.canConfirm}>{prev?.canConfirm ? `Save ${prev.willChange} ${prev.willChange === 1 ? 'line' : 'lines'}` : 'Nothing to save'}</button>}
    </>
  );
  return (
    <Modal title={item.title} size="wide" onClose={() => { if (!busy) onClose(changed); }} footer={foot}>
      <div className="vio-dlg">
        {error && <div className="notice red" role="alert"><span>{error}</span></div>}
        {(step === 'pick' || step === 'checking') && (
          <>
            <p>{item.help} Nothing is saved until you press <b>Save</b>, and you see every line first.</p>
            <ol className="vio-steps">
              <li>Download the <b>sample file</b> and fill it in. Do not change the first row (the column names).
                <div className="vio-row">
                  <button type="button" className="btn btn-sm" onClick={() => sample('xlsx')}>Download sample (Excel)</button>
                  <button type="button" className="btn btn-sm" onClick={() => sample('csv')}>Download sample (CSV)</button>
                </div>
              </li>
              <li>Choose your file (Excel .xlsx or CSV, up to {imp.maxMb} MB and {imp.maxRows.toLocaleString('en-IN')} lines).
                <div className="vio-row"><input ref={input} type="file" accept=".xlsx,.csv" onChange={pickFile} aria-label="Choose the file to import" /></div>
              </li>
              <li>Press <b>Check the file</b>. You will see what will happen to each line.</li>
            </ol>
            <div className="cell-muted vio-cols">Columns: {item.columns.map((c) => c.label + (c.required ? ' (needed)' : '')).join(', ')}.</div>
            <div className="cell-muted">You cannot set a payment status here. Accounts pays, and the bank statement confirms it. {imp.assetsNote}</div>
            {step === 'checking' && <div className="vio-wait" aria-busy="true">Checking the file&hellip;</div>}
          </>
        )}
        {(step === 'preview' || step === 'saving') && prev && (
          <>
            <div className="vio-cards" aria-label="What the file will do">
              <Card n={prev.rowCount} t="lines in the file" />
              <Card n={prev.willChange} t="will be saved" tone="green" />
              <Card n={prev.unchanged} t="already as they are" />
              <Card n={prev.alreadyThere} t="already there" tone="blue" />
              <Card n={prev.failed} t="have a problem" tone={prev.failed ? 'red' : ''} />
            </div>
            <div className="notice amber"><span>{prev.note} A line with a problem is never saved; the others still are.</span></div>
            {prev.failed > 0 && <label className="vio-chk"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only the lines with a problem</label>}
            <RowsTable rows={shown} />
            {step === 'saving' && <div className="vio-wait" aria-busy="true">Saving&hellip; please wait, do not close this window.</div>}
          </>
        )}
        {step === 'done' && res && (
          <>
            <div className={`notice ${res.failed ? 'amber' : 'green'}`} role="status"><span>{res.message}</span></div>
            {res.duplicateRequest && <div className="cell-muted">This was already saved a moment ago, so nothing was saved twice.</div>}
            <div className="vio-cards" aria-label="Result">
              <Card n={res.total} t="lines in the file" />
              <Card n={item.key === 'bills' ? res.imported : res.updated} t={item.key === 'bills' ? 'sent to Accounts' : 'updated'} tone="green" />
              <Card n={res.skipped} t="skipped (already as they were)" />
              <Card n={res.alreadyThere} t="already there" tone="blue" />
              <Card n={res.failed} t="failed" tone={res.failed ? 'red' : ''} />
            </div>
            <div className="vio-row"><button type="button" className="btn btn-sm" onClick={report}>Download report (CSV)</button>
              {res.failed > 0 && <label className="vio-chk"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only the failed lines</label>}</div>
            <RowsTable rows={shown} />
          </>
        )}
      </div>
    </Modal>
  );
}

const Card = ({ n, t, tone = '' }) => <div className={`vio-card ${tone}`}><b>{n}</b><span>{t}</span></div>;

function RowsTable({ rows }) {
  if (!rows.length) return <div className="vp-none">Nothing to show.</div>;
  return (
    <div className="tbl-wrap vio-table">
      <table>
        <thead><tr><th>Line</th><th>Item</th><th>What happened</th></tr></thead>
        <tbody>
          {rows.slice(0, 400).map((r) => {
            const [cls, word] = OUTCOME[r.outcome] || ['vp-grey', r.outcome];
            return (
              <tr key={r.line}>
                <td>{r.line}</td>
                <td className="vio-wrap">{r.label || '-'}</td>
                <td className="vio-wrap"><span className={`vp-tag ${cls}`}>{word}</span><div>{r.message}</div>{r.fix ? <div className="cell-muted">{r.fix}</div> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 400 && <div className="cell-muted vio-more">Showing the first 400 of {rows.length}. The report has every line.</div>}
    </div>
  );
}

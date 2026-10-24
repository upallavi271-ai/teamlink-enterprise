// Accounts > Journal & Ledger > Fixed assets: the "Import" button and its window, one per section
// (Pending from HRMS / Assets / Asset summary / Repair cost). Backend: routes/assetAccountsImport.js.
//
//   Import  ->  window  ->  pick the source (and the file)  ->  Preview (nothing is saved)
//           ->  Confirm Import  ->  the REAL result from the server (counts, what failed and why)
//           ->  Close  ->  the page reloads its table from the saved data, filters kept.
//
// The window never says "done" on its own: every number on the result screen is what the server
// answered. While a request is in flight the buttons are off, and the Confirm carries a one-time key,
// so a double click or a retry cannot add anything twice.
import { useMemo, useRef, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import { money } from '../payroll/payrollUi';
import Pager, { usePaged } from '../Pager.jsx';
import './ledgerBooks.css';

const BASE = '/accounts/fixed-assets/import';
const SOURCES = { hrms: 'HRMS asset records', file: 'Excel or CSV file' };
const TITLES = { pending: 'Import - Pending from HRMS', assets: 'Import - Assets', summary: 'Import - Asset summary', repairs: 'Import - Repair cost' };
const SECTION_SOURCES = { pending: ['hrms'], assets: ['hrms', 'file'], summary: ['hrms'], repairs: ['hrms', 'file'] };
const WORDS = {
  'pending:hrms': 'This brings the records HRMS has sent (asset purchases, repairs, sales and write-offs) into the books, using the same steps as the Post button. Press Preview to see what will happen. Nothing is saved until you press Confirm Import. A record that is already in the books is never added again.',
  'assets:hrms': 'This brings the assets that are in HRMS but not yet in the books (their purchase) into the books. Press Preview to see what will happen. Nothing is saved until you press Confirm Import.',
  'assets:file': 'Add new assets to the register from an Excel (.xlsx) or CSV file made from the sample file. An Asset ID or Serial Number that already exists is never changed - it is listed as already there. Press Preview first; nothing is saved until you press Confirm Import. New assets then wait in Pending from HRMS to be posted.',
  'summary:hrms': 'The summary is always worked out from what is saved in the books. This brings in any HRMS records that are not counted yet (purchases, repairs, sales), and the summary then updates by itself. It never changes a purchase cost or depreciation to make the totals match.',
  'repairs:hrms': 'This brings the completed HRMS repairs that have a cost into the books. The asset must already be in the books; if it is not, the repair is listed with what to do first.',
  'repairs:file': 'Add repair costs for assets that are already in the register, from an Excel (.xlsx) or CSV file made from the sample file. A repair is never added twice and is never added to the purchase cost. Press Preview first; nothing is saved until you press Confirm Import.',
};
const ACTION = {
  create: ['Ready', 'green'], update: ['Will update', 'orange'], duplicate: ['Already there', 'grey'], skip: ['Skipped', 'grey'], error: ['Problem', 'red'],
};

async function blobError(err, fallback) {
  const d = err?.response?.data;
  if (d instanceof Blob) { try { return JSON.parse(await d.text()).error || fallback; } catch { return fallback; } }
  return d?.error || fallback;
}
function friendly(err, fallback, { writing = false } = {}) {
  const s = err?.response?.status;
  if (!err?.response) {
    return writing
      ? 'We lost the connection before the answer came. It may or may not have been saved. Close this window and look at the table. Pressing Import again is safe - nothing is added twice.'
      : 'Could not reach the server. Nothing was changed. Please try again.';
  }
  if (s === 401) return 'Your login has ended. Please sign in again, then open Import again.';
  if (s === 403) return err.response.data?.error || 'Your role is not allowed to import fixed assets.';
  return err.response.data?.error || fallback;
}
const newKey = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, '');
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a cell that starts like a formula is shown as text
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadReport(section, result) {
  const rows = [['Type', 'Record', 'Name', 'What happened', 'What to do']];
  (result.failures || []).forEach((f) => rows.push(['Not imported', f.ref, f.name, f.reason, f.fix]));
  (result.duplicateList || []).forEach((f) => rows.push(['Already there', f.ref, f.name, f.reason, f.existing ? `Existing: ${f.existing}` : '']));
  (result.skippedList || []).forEach((f) => rows.push(['Skipped', f.ref, f.name, f.reason, '']));
  const text = `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href; a.download = `fixed-assets-${section}-import-report-${(result.at || '').slice(0, 10) || 'today'}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

function Cell({ col, value }) {
  if (col.num) return <td className="lb-num">{value === '' || value == null ? '' : (Number.isFinite(Number(value)) ? money(value) : value)}</td>;
  return <td className={col.key === 'ref' || col.key === 'assetCode' ? '' : 'cell-muted'}>{value === '' || value == null ? '—' : String(value)}</td>;
}

function PreviewTable({ preview }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rows = useMemo(() => (onlyProblems ? preview.rows.filter((r) => r.action === 'error') : preview.rows), [preview, onlyProblems]);
  const page = usePaged(rows, 25);
  return (
    <>
      {preview.counts.errors > 0 && (
        <label className="prb-check" style={{ margin: '6px 0' }}><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> show only the rows with a problem</label>
      )}
      <div className="tbl-wrap acc-scroll" style={{ maxHeight: 320 }}>
        <table className="lb-tbl">
          <thead><tr>{preview.columns.map((c) => <th key={c.key} className={c.num ? 'lb-num' : ''}>{c.label}</th>)}<th>Check</th></tr></thead>
          <tbody>
            {page.slice.map((r) => {
              const [label, tone] = ACTION[r.action] || ['—', 'grey'];
              return (
                <tr key={r.key}>
                  {preview.columns.map((c) => <Cell key={c.key} col={c} value={r.cells[c.key]} />)}
                  <td style={{ minWidth: 200 }}>
                    <span className={`lb-badge ${tone}`}>{label}</span>
                    {r.problems.map((p, i) => <div key={i} className="lb-note" style={{ color: '#b42318' }}>{p.message}{p.fix ? <> <b>{p.fix}</b></> : null}</div>)}
                    {r.reason && <div className="lb-note">{r.reason}</div>}
                    {r.existing?.label && <div className="lb-note">Existing: {r.existing.label}</div>}
                    {r.notes.map((n, i) => <div key={`n${i}`} className="lb-note">{n}</div>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && <Pager page={page} noun="rows" />}
    </>
  );
}

function ResultList({ title, rows, cols }) {
  const [open, setOpen] = useState(true);
  if (!rows?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {title} ({rows.length})</button>
      {open && (
        <div className="tbl-wrap acc-scroll" style={{ maxHeight: 220, marginTop: 6 }}>
          <table className="lb-tbl">
            <thead><tr>{cols.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i}>{cols.map(([k]) => <td key={k} className={k === 'ref' ? '' : 'cell-muted'}>{r[k] || '—'}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportDialog({ section, onClose, onDone, onOpenAsset }) {
  const sources = SECTION_SOURCES[section];
  const [source, setSource] = useState(sources[0]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const key = useRef(null);
  const flight = useRef(false);
  const fileKind = section === 'repairs' ? 'repairs' : 'assets';

  const reset = () => { setPreview(null); setResult(null); setError(''); key.current = null; };
  const pickSource = (s) => { if (busy) return; setSource(s); setFile(null); reset(); };

  async function sample(format) {
    setError(''); setBusy(`sample-${format}`);
    try {
      const res = await api.get(`${BASE}/sample`, { params: { section: fileKind, format }, responseType: 'blob' });
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = `fixed-assets-${fileKind}-import-sample.${format}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (err) {
      const text = await blobError(err, 'The sample file could not be downloaded.');
      setError(err?.response?.status === 401 || !err?.response ? friendly(err, text) : text);
    } finally { setBusy(''); }
  }

  async function send(path, extra = {}, headers = {}) {
    const params = { section, source, ...(source === 'file' ? { fileName: file.name } : {}) };
    if (source === 'file') {
      const buf = await file.arrayBuffer();
      return api.post(`${BASE}/${path}`, buf, { params, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
    }
    return api.post(`${BASE}/${path}`, extra, { params, headers });
  }

  async function runPreview() {
    if (flight.current) return;
    flight.current = true; reset(); setBusy('preview');
    try {
      const res = await send('preview');
      setPreview(res.data); key.current = newKey();
    } catch (err) { setError(friendly(err, 'The check could not be done.')); } finally { flight.current = false; setBusy(''); }
  }

  async function confirm() {
    if (flight.current || !preview || !key.current) return;
    flight.current = true; setBusy('confirm'); setError('');
    try {
      const items = source === 'hrms' && preview.rows.length === preview.counts.total ? preview.rows.map((r) => r.key) : undefined;
      const res = await send('confirm', { items }, { 'Idempotency-Key': key.current });
      setResult(res.data);
    } catch (err) { setError(friendly(err, 'The import could not be finished.', { writing: true })); } finally { flight.current = false; setBusy(''); }
  }

  const ready = preview ? preview.counts.willImport + preview.counts.willUpdate : 0;
  const close = () => { if (busy === 'confirm') return; if (result) onDone(); onClose(); };
  const canPreview = !busy && (source === 'hrms' || !!file);
  const noWork = preview && preview.counts.total === 0;

  return (
    <Modal
      title={TITLES[section]}
      wide
      onClose={close}
      footer={result ? (
        <>
          {(result.failed > 0 || result.duplicates > 0 || result.skipped > 0) && <button type="button" className="btn btn-sm" onClick={() => downloadReport(section, result)}>Download report (CSV)</button>}
          <button type="button" className="btn btn-primary btn-sm" onClick={close}>Close</button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-sm" disabled={busy === 'confirm'} onClick={close}>Cancel</button>
          <button type="button" className="btn btn-sm" disabled={!canPreview} onClick={runPreview}>{busy === 'preview' ? 'Checking…' : 'Preview'}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!preview || !ready || !!busy} onClick={confirm}>{busy === 'confirm' ? 'Importing…' : ready ? `Confirm Import (${ready})` : 'Confirm Import'}</button>
        </>
      )}
    >
      {!result && <div className="small-muted" style={{ marginBottom: 10, lineHeight: 1.55 }}>{WORDS[`${section}:${source}`]}</div>}
      {!result && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <span className="lb-note" style={{ fontWeight: 700 }}>Source</span>
          {sources.length > 1 ? (
            <span className="lb-sub" style={{ padding: 0 }}>
              {sources.map((s) => <button key={s} type="button" className={`btn btn-sm ${source === s ? 'on' : ''}`} disabled={!!busy} onClick={() => pickSource(s)}>{SOURCES[s]}</button>)}
            </span>
          ) : <span>{SOURCES[source]}</span>}
        </div>
      )}
      {!result && source === 'file' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => sample('xlsx')}>{busy === 'sample-xlsx' ? 'Preparing…' : 'Sample file (Excel)'}</button>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => sample('csv')}>{busy === 'sample-csv' ? 'Preparing…' : 'Sample file (CSV)'}</button>
            <span className="lb-note">Use the sample's columns exactly. The file can be .xlsx or .csv, up to 5 MB. Formulas and macros are never run.</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <input type="file" accept=".xlsx,.csv" disabled={!!busy} onChange={(e) => { setFile(e.target.files?.[0] || null); reset(); }} />
          </div>
        </div>
      )}
      {error && <div className="lb-err" style={{ margin: '8px 0' }}>{error}</div>}

      {preview && !result && (
        <>
          <div className="lb-note" style={{ margin: '8px 0', fontSize: 12.5 }}>
            <b>{preview.counts.total}</b> row(s) checked - nothing is saved yet. <span style={{ color: '#1e7a46' }}><b>{preview.counts.willImport}</b> ready</span>
            {preview.counts.willUpdate > 0 && <> · <b>{preview.counts.willUpdate}</b> will update</>}
            {' '}· <b>{preview.counts.duplicates}</b> already there · <b>{preview.counts.skipped}</b> skipped · <span style={{ color: preview.counts.errors ? '#b42318' : undefined }}><b>{preview.counts.errors}</b> with a problem</span>
            {preview.counts.exampleRowsSkipped ? <> · {preview.counts.exampleRowsSkipped} sample row(s) ignored</> : null}
          </div>
          {preview.source === 'hrms' && preview.info?.noCost > 0 && <div className="lb-note">{preview.info.noCost} asset(s) have no purchase cost in HRMS, so there is nothing to bring in for them. Add the cost in HRMS if they should be in the books.</div>}
          {preview.info?.shownRows < preview.counts.total && <div className="lb-note">Showing the first {preview.info.shownRows} rows. Confirm still handles all {preview.counts.total}.</div>}
          {section === 'summary' && preview.byCategory?.length > 0 && (
            <div className="tbl-wrap" style={{ margin: '8px 0', maxWidth: 520 }}>
              <table className="lb-tbl">
                <thead><tr><th>Category</th><th className="lb-num">Records to bring in</th><th className="lb-num">Amount</th></tr></thead>
                <tbody>{preview.byCategory.map((c) => <tr key={c.category}><td>{c.category}</td><td className="lb-num">{c.rows}</td><td className="lb-num">{money(c.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {noWork ? (
            <div className="lb-note" style={{ padding: '10px 0' }}>{preview.source === 'hrms' ? 'There is nothing to import from HRMS right now.' : 'The file has no rows to import.'}</div>
          ) : <PreviewTable preview={preview} />}
          {!noWork && ready === 0 && <div className="lb-note" style={{ padding: '8px 0' }}>Nothing is ready to import. {preview.counts.duplicates === preview.counts.total ? 'Everything is already imported.' : 'Fix the problems shown, then press Preview again.'}</div>}
        </>
      )}

      {result && (
        <>
          <div className={result.failed || result.nothingSaved ? 'lb-err' : 'lb-ok'} style={{ margin: '0 0 10px', ...(result.failed && !result.nothingSaved ? { background: '#fdf0dc', color: '#a35f00' } : {}), ...(result.nothingSaved && !result.failed ? { background: '#eef0f3', color: '#3b4452' } : {}) }}>{result.message}{result.duplicateRequest ? ' (This was already done by your first click.)' : ''}</div>
          <div className="lb-cards" style={{ padding: 0 }}>
            {[['Total rows', result.total], ['Imported', result.imported], ['Updated', result.updated], ['Skipped', result.skipped], ['Already there', result.duplicates], ['Not imported', result.failed]].map(([l, v]) => (
              <div className="lb-card" key={l}><div className="v">{v}</div><div className="l">{l}</div></div>
            ))}
          </div>
          {result.figures && (
            <div className="lb-note" style={{ marginTop: 10 }}>
              Saved figures, worked out again from the books: cost in the books {money(result.figures.before.costInBooks)} → <b>{money(result.figures.after.costInBooks)}</b> · depreciation so far {money(result.figures.before.accumulatedDepreciation)} → <b>{money(result.figures.after.accumulatedDepreciation)}</b> · book value {money(result.figures.before.bookValue)} → <b>{money(result.figures.after.bookValue)}</b>.
            </div>
          )}
          {result.created?.length > 0 && (
            <div className="lb-note" style={{ marginTop: 10 }}>
              Added to the register: {result.created.slice(0, 12).map((a) => (
                <button key={a.id} type="button" className="btn btn-sm" style={{ margin: '2px 4px 2px 0' }} onClick={() => { onDone(); onClose(); if (onOpenAsset) onOpenAsset(a.id); }}>{a.assetCode}</button>
              ))}{result.created.length > 12 ? ` and ${result.created.length - 12} more` : ''}
            </div>
          )}
          <ResultList title="rows not imported" rows={result.failures} cols={[['ref', 'Record'], ['name', 'Name'], ['reason', 'What happened'], ['fix', 'What to do']]} />
          <ResultList title="rows already there" rows={result.duplicateList} cols={[['ref', 'Record'], ['existing', 'Existing record'], ['reason', 'Why it was not added']]} />
          <ResultList title="skipped rows" rows={result.skippedList} cols={[['ref', 'Record'], ['name', 'Name'], ['reason', 'Why']]} />
        </>
      )}
    </Modal>
  );
}

// The button. canImport = the same right as the Post button; without it the button is shown but off,
// with the reason (the server refuses anyway).
export default function FixedAssetImport({ section, canImport = false, onDone, onOpenAsset }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!canImport}
        title={canImport ? `Import - ${section === 'repairs' ? 'repair costs' : section === 'assets' ? 'assets' : section === 'summary' ? 'asset records for the summary' : 'records from HRMS'}` : 'Your role can look at fixed assets but not import them.'}
        onClick={() => setOpen(true)}
      >
        Import
      </button>
      {open && <ImportDialog section={section} onClose={() => setOpen(false)} onDone={onDone || (() => {})} onOpenAsset={onOpenAsset} />}
    </>
  );
}

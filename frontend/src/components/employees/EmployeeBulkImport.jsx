import { useEffect, useState } from 'react';
import api from '../../api';
import './EmployeeIO.css';

// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT → BULK IMPORT
//
//   Download Sample Excel → fill in → upload .xlsx / .csv (or paste CSV)
//   → Check file (row-wise errors, nothing written)
//   → Import valid rows (ONLY the rows that pass)
//   → imported / failed / skipped counts + a downloadable summary workbook
//
// The file is parsed and validated on the SERVER (SheetJS, routes/employees.js
// + utils/employeeBulkImport.js), so the check and the import read the same
// bytes the same way. The field list, the sample workbook and the allowed
// values all come from the server's one field definition.
// ---------------------------------------------------------------------------

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove();
  // Released a moment later: revoking at once can cancel the download and
  // leave an empty file in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// RFC 4180 — quoted fields may hold commas, newlines and doubled quotes.
function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  const lines = out.map((r, i) => ({ r, line: i + 1 })).filter(({ r }) => r.some((c) => String(c).trim() !== ''));
  if (!lines.length) return [];
  const headers = lines[0].r.map((h) => h.trim());
  return lines.slice(1).map(({ r, line }) => {
    const obj = { __line: line };
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

function ErrorTable({ errors }) {
  if (!errors || !errors.length) return null;
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr><th style={{ width: 60 }}>Row</th><th style={{ width: 140 }}>Field</th><th>Error</th><th>Expected</th></tr></thead>
        <tbody>
          {errors.map((e, i) => (
            <tr key={i}>
              <td><b>{e.row || e.line || '—'}</b></td>
              <td>{e.field || '—'}</td>
              <td className="error-text" style={{ margin: 0 }}>{e.message}</td>
              <td className="cell-muted">{e.expected || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EmployeeBulkImport({ onImported }) {
  const [spec, setSpec] = useState(null);
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [createLogins, setCreateLogins] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/employees/bulk-import/fields').then((r) => setSpec(r.data)).catch(() => setSpec(null));
  }, []);

  function reset() { setPreview(null); setResult(null); setError(''); }

  async function downloadSample() {
    setError(''); setBusy('sample');
    try {
      const res = await api.get('/employees/bulk-import/sample.xlsx', { responseType: 'blob' });
      saveBlob(res.data, 'employee-import-sample.xlsx');
    } catch {
      setError('The sample could not be downloaded.');
    } finally { setBusy(''); }
  }

  // The request: the uploaded file as raw bytes, or the pasted CSV as rows.
  async function send(url) {
    if (file) {
      const buf = await file.arrayBuffer();
      return api.post(url, buf, {
        headers: { 'Content-Type': 'application/octet-stream' },
        params: { fileName: file.name, createLogins: createLogins ? 'true' : 'false' },
      });
    }
    const rows = parseCsv(csvText);
    if (!rows.length) throw Object.assign(new Error('empty'), { friendly: 'Choose a file, or paste CSV with a header row and at least one data row.' });
    return api.post(url, { rows, createLogins });
  }

  async function check() {
    reset(); setBusy('check');
    try {
      const res = await send('/employees/bulk-import/preview');
      setPreview(res.data);
    } catch (err) {
      setError(err.friendly || err.response?.data?.error || 'The file could not be checked.');
    } finally { setBusy(''); }
  }

  async function runImport() {
    setError(''); setBusy('import');
    try {
      const res = await send('/employees/bulk-import');
      setResult(res.data);
      setPreview(null);
      onImported?.();
    } catch (err) {
      const data = err.response?.data;
      if (data && data.summaryFile) { setResult(data); setPreview(null); } else setError(err.friendly || data?.error || 'The import could not be run.');
    } finally { setBusy(''); }
  }

  function downloadSummary() {
    if (!result?.summaryFile) return;
    saveBlob(base64ToBlob(result.summaryFile.base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), result.summaryFile.name);
  }

  return (
    <div className="card section empio">
      <div className="empio-head">
        <h3>Bulk Import</h3>
        <button type="button" className="btn btn-sm btn-primary" onClick={downloadSample} disabled={busy === 'sample'}>
          {busy === 'sample' ? 'Preparing…' : '⬇ Download Sample Excel'}
        </button>
      </div>
      <div className="small-muted empio-lead">
        Fill in the sample (it has an <b>Instructions</b> sheet with the allowed departments, active roles, employment
        types, statuses and the date format), then upload it as <b>.xlsx</b> or <b>.csv</b>. <b>Check file</b> shows every
        problem row by row and writes nothing. <b>Import valid rows</b> imports only the rows that pass — the rest are
        listed with their reasons and can be downloaded. Rows whose Employee ID starts
        with <code>{spec?.examplePrefix || 'EXAMPLE-'}</code> are examples and are skipped.
      </div>

      {spec && (
        <div className="empio-fields">
          {spec.fields.map((f) => (
            <span key={f.key} className={`empio-chip${f.required ? ' req' : ''}`} title={f.rule}>
              {f.label}{f.required ? ' *' : ''}
            </span>
          ))}
        </div>
      )}

      <label className="empio-check">
        <input type="checkbox" checked={createLogins} onChange={(e) => { setCreateLogins(e.target.checked); reset(); }} />
        <span>
          <b>Create logins for these employees</b> — one login each (never a second one for somebody who already has
          one), with product access derived from the designation. No password is generated or emailed: each person gets
          a single-use, expiring link to set their own.
        </span>
      </label>

      <div className="empio-row">
        <input
          type="file"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => { setFile(e.target.files?.[0] || null); reset(); }}
        />
        {file && <span className="cell-muted">{file.name} · {Math.ceil(file.size / 1024)} KB</span>}
      </div>
      {!file && (
        <details className="empio-paste">
          <summary>…or paste CSV instead</summary>
          <textarea
            rows="4"
            placeholder={'Employee ID,Employee Name,Email,Phone,Department,Designation,Role,Date of Joining,Reporting Manager,Location,Employment Type,Status'}
            value={csvText}
            onChange={(e) => { setCsvText(e.target.value); reset(); }}
          />
        </details>
      )}

      <div className="empio-row">
        <button type="button" className="btn btn-sm" disabled={!!busy || (!file && !csvText.trim())} onClick={check}>
          {busy === 'check' ? 'Checking…' : 'Check file'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!!busy || !preview || !preview.canImport}
          onClick={runImport}
        >
          {busy === 'import' ? 'Importing…' : preview && preview.canImport ? `Import ${preview.validCount} valid row(s)` : 'Import valid rows'}
        </button>
        {!preview && !result && <span className="small-muted">Check the file first — the check is what you import.</span>}
      </div>

      {error && <div className="error-text">{error}</div>}

      {preview && (
        <div className="empio-out">
          <div className="empio-counts">
            <span className="status approved">{preview.validCount} valid</span>
            <span className={`status ${preview.invalidCount ? 'rejected' : 'new'}`}>{preview.invalidCount} invalid</span>
            {preview.skippedCount > 0 && <span className="status hold">{preview.skippedCount} example row(s) skipped</span>}
            <span className="small-muted">Scope: {preview.scope}</span>
          </div>
          <div className={preview.canImport ? 'notice' : 'notice amber'}>{preview.message}</div>
          {preview.invalid.length > 0 && (
            <>
              <div className="section-label">Row-wise errors ({preview.invalid.length})</div>
              <ErrorTable errors={preview.invalid} />
            </>
          )}
          {preview.valid.length > 0 && (
            <>
              <div className="section-label">Rows that will be imported ({preview.validCount})</div>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Row</th><th>Employee ID</th><th>Name</th><th>Email</th><th>Department</th><th>Designation</th><th>Role</th><th>Joining</th><th>Manager</th><th>Login</th></tr>
                  </thead>
                  <tbody>
                    {preview.valid.map((r) => (
                      <tr key={r.row}>
                        <td className="cell-muted">{r.row}</td>
                        <td>{r.employeeCode}</td>
                        <td><b>{r.name}</b></td>
                        <td className="cell-muted">{r.email || '—'}</td>
                        <td className="cell-muted">{r.department || '—'}</td>
                        <td className="cell-muted">{r.designation || '—'}</td>
                        <td className="cell-muted">{r.role || '—'}</td>
                        <td className="cell-muted">{r.dateOfJoining || '—'}</td>
                        <td className="cell-muted">{r.reportingManager || '—'}</td>
                        <td>{r.willCreateLogin ? <span className="status approved">Login + link</span> : <span className="cell-muted">Record only</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="empio-out">
          <div className="empio-counts">
            <span className="status approved">{result.imported} imported</span>
            <span className={`status ${result.failed ? 'rejected' : 'new'}`}>{result.failed} failed</span>
            {result.skipped > 0 && <span className="status hold">{result.skipped} skipped</span>}
            {result.summaryFile && (
              <button type="button" className="btn btn-sm" onClick={downloadSummary}>⬇ Download import summary</button>
            )}
          </div>
          <div className={result.ok ? 'notice' : 'notice amber'}>{result.message}</div>
          {result.failedRows && result.failedRows.length > 0 && (
            <>
              <div className="section-label">Failed rows ({result.failedRows.length})</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th style={{ width: 60 }}>Row</th><th>Employee</th><th>Reasons</th></tr></thead>
                  <tbody>
                    {result.failedRows.map((f) => (
                      <tr key={f.row}>
                        <td><b>{f.row}</b></td>
                        <td>{f.values.name || '—'} <span className="cell-muted">{f.values.employeeCode || ''}</span></td>
                        <td className="error-text" style={{ margin: 0 }}>{f.reasons.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result.invites && result.invites.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Email</th><th>Sign-in link</th></tr></thead>
                <tbody>
                  {result.invites.map((i, n) => (
                    <tr key={n}>
                      <td>{i.name}</td>
                      <td className="cell-muted">{i.email}</td>
                      <td className={i.sent ? 'cell-muted' : 'error-text'} style={{ margin: 0, wordBreak: 'break-all' }}>
                        {i.status}{!i.sent && i.link ? ` — ${i.link}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

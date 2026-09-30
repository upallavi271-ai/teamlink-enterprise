// ---------------------------------------------------------------------------
// DataIoBar — Export (everyone in scope · one employee) + Import with a
// COMPULSORY sample file, for any module registered in backend src/io/*.js.
//
//   <DataIoBar ioKey="resignation" />                        global + per-employee export, import
//   <DataIoBar ioKey="leave" exportUrl="/insights/leave/export" params={{ range }} />
//   <DataIoBar ioKey="resignation" employeeId={emp.id} employeeName={emp.name} />   one employee only
//
// Rights come from GET /api/io/modules (the server's can() + scope); the bar
// never decides them. Import without write rights is shown DISABLED with the
// reason as a tooltip — or, where the module allows it, as "Request import"
// (the Super Admin approves it). The server re-checks everything.
//
// The Import dialog opens on "Download sample file"; the upload control stays
// locked until a sample has been downloaded in this browser, and the server
// refuses any file whose header row does not match the sample.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import sharedGet from '../../utils/sharedGet';
import ExportMenu from '../ExportMenu.jsx';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import './DataIoBar.css';

const sampleKey = (k) => `tl_io_sample_${k}`;
function sampleSeen(k) {
  try { return !!localStorage.getItem(sampleKey(k)); } catch { return false; }
}
function markSample(k) {
  try { localStorage.setItem(sampleKey(k), new Date().toISOString()); } catch { /* storage blocked */ }
}

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const name = (m && m[1]) || fallback;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}

async function errorText(err, fallback) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text()).error || fallback; } catch { return fallback; }
  }
  return data?.error || fallback;
}

// Cached per login (the token is the key, so signing in as somebody else never
// reuses the previous person's rights); `refreshIoModules()` drops it.
const tokenKey = () => { try { return localStorage.getItem('tl_token') || ''; } catch { return ''; } };
let modulesPromise = null;
let modulesFor = null;
export function loadIoModules() {
  if (!modulesPromise || modulesFor !== tokenKey()) {
    modulesFor = tokenKey();
    modulesPromise = sharedGet('/io/modules').then((r) => r.data).catch((e) => { modulesPromise = null; throw e; });
  }
  return modulesPromise;
}
export function refreshIoModules() { modulesPromise = null; }

let employeesPromise = null;
let employeesFor = null;
function loadIoEmployees() {
  if (!employeesPromise || employeesFor !== tokenKey()) {
    employeesFor = tokenKey();
    employeesPromise = sharedGet('/io/employees').then((r) => r.data.employees || []).catch(() => { employeesPromise = null; return []; });
  }
  return employeesPromise;
}

export function useIoCaps(ioKey) {
  const [caps, setCaps] = useState(null);
  useEffect(() => {
    let alive = true;
    loadIoModules().then((d) => { if (alive) setCaps((d.modules || []).find((m) => m.key === ioKey) || { missing: true }); })
      .catch(() => { if (alive) setCaps({ missing: true }); });
    return () => { alive = false; };
  }, [ioKey]);
  return caps;
}

export default function DataIoBar({
  ioKey, exportUrl, params = {}, employeeId, employeeName, onImported, showEmployeePicker = true, size = 'sm', exportLabel,
  // false for an export-only module (no import makes sense for it)
  showImport = true,
}) {
  const caps = useIoCaps(ioKey);
  const [pickOpen, setPickOpen] = useState(false);
  const [employees, setEmployees] = useState(null);
  const [picked, setPicked] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!pickOpen || employees) return;
    loadIoEmployees().then(setEmployees);
  }, [pickOpen, employees]);

  if (!caps || caps.missing) return null;
  const canExportAny = caps.canExport || caps.selfExport;
  const url = exportUrl || (caps.hasExport ? `/io/${ioKey}/export` : null);
  const importTitle = caps.canImport
    ? `Import ${caps.label} — download the sample file first`
    : (caps.allowRequest ? 'Your role cannot import directly — submit an import request; the Super Admin approves it.' : (caps.importBlockedReason || 'Import is not included in your role'));

  return (
    <span className="dio">
      {url && canExportAny && (
        employeeId ? (
          <ExportMenu url={url} params={{ ...params, employeeId }} size={size} label={exportLabel || `Export ${employeeName || 'employee'}`} note={`${caps.label} · this employee only`} />
        ) : (
          <ExportMenu
            url={url}
            params={params}
            size={size}
            label={exportLabel || (caps.canExport ? 'Export all' : 'Export mine')}
            note={caps.canExport ? `${caps.label} · everyone in your scope (filters applied)` : `${caps.label} · your own records`}
          />
        )
      )}
      {url && caps.canExport && !employeeId && showEmployeePicker && (
        <span className="dio-pick">
          <button type="button" className={`btn btn-${size}`} onClick={() => setPickOpen((o) => !o)} aria-expanded={pickOpen}>
            Export one employee ▾
          </button>
          {pickOpen && (
            <span className="dio-pop">
              <Combo value={picked} onChange={(e) => setPicked(e.target.value)}>
                <option value="">{employees ? 'Choose an employee…' : 'Loading…'}</option>
                {(employees || []).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code}){e.status && e.status !== 'Active' ? ` · ${e.status}` : ''}</option>)}
              </Combo>
              <ExportMenu url={url} params={{ ...params, employeeId: picked }} disabled={!picked} label="Export" note={`${caps.label} · the chosen employee`} />
            </span>
          )}
        </span>
      )}
      {!employeeId && showImport && (
        <span title={importTitle}>
          <button
            type="button"
            className={`btn btn-${size}`}
            disabled={!caps.canImport && !caps.allowRequest}
            onClick={() => setImportOpen(true)}
          >
            {caps.canImport || !caps.allowRequest ? 'Import' : 'Request import'}
          </button>
        </span>
      )}
      {importOpen && (
        <ImportDialog
          ioKey={ioKey}
          caps={caps}
          onClose={() => setImportOpen(false)}
          onDone={(r) => { if (onImported) onImported(r); }}
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The import dialog: 1 sample → 2 file → 3 check (dry run) → 4 import / request.
// ---------------------------------------------------------------------------
export function ImportDialog({ ioKey, caps, onClose, onDone }) {
  const [hasSample, setHasSample] = useState(() => sampleSeen(ioKey));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [note, setNote] = useState('');
  const inputRef = useRef(null);
  const requestMode = !caps.canImport && caps.allowRequest;

  async function downloadSample(format) {
    setError(''); setBusy(`sample-${format}`);
    try {
      const res = await api.get(`/io/${ioKey}/sample`, { params: { format }, responseType: 'blob' });
      saveBlob(res, `${ioKey}-import-sample.${format}`);
      markSample(ioKey); setHasSample(true);
    } catch (err) {
      setError(await errorText(err, 'The sample file could not be downloaded.'));
    } finally { setBusy(''); }
  }

  async function send(path, extra = {}) {
    const buf = await file.arrayBuffer();
    return api.post(path, buf, {
      params: { fileName: file.name, ...extra },
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  async function check() {
    setError(''); setPreview(null); setResult(null); setBusy('check');
    try {
      const res = await send(`/io/${ioKey}/preview`);
      setPreview(res.data);
    } catch (err) {
      setError(await errorText(err, 'The file could not be checked.'));
    } finally { setBusy(''); }
  }

  async function commit() {
    setError(''); setBusy('import');
    try {
      const res = requestMode
        ? await send(`/io/${ioKey}/request`, note ? { note } : {})
        : await send(`/io/${ioKey}/import`);
      setResult(res.data);
      if (onDone) onDone(res.data);
    } catch (err) {
      setError(await errorText(err, requestMode ? 'The request could not be sent.' : 'The import failed.'));
    } finally { setBusy(''); }
  }

  const actionable = preview ? (preview.willCreate || 0) + (preview.willUpdate || 0) : 0;
  const rows = useMemo(() => (preview?.rows || []).filter((r) => r.action !== 'nochange').slice(0, 200), [preview]);

  return (
    <Modal
      title={`${requestMode ? 'Request import' : 'Import'} — ${caps.module} · ${caps.label}`}
      size="wide"
      onClose={onClose}
      foot={result ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button> : (
        <>
          <button type="button" className="btn" onClick={check} disabled={!file || !hasSample || !!busy}>
            {busy === 'check' ? 'Checking…' : 'Check file (dry run)'}
          </button>
          <button type="button" className="btn btn-primary" onClick={commit} disabled={!preview || !actionable || !!busy}>
            {busy === 'import' ? (requestMode ? 'Sending…' : 'Importing…')
              : requestMode ? `Send import request (${actionable} row${actionable === 1 ? '' : 's'})`
                : `Import ${actionable} valid row${actionable === 1 ? '' : 's'}`}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </>
      )}
    >
      <div className="dio-dialog">
        {requestMode && (
          <div className="notice dio-note">
            Your role can see this data but not change it, so this import goes to the <b>Super Admin as a request</b>.
            Nothing changes until it is approved.
          </div>
        )}
        <ol className="dio-steps">
          <li className={hasSample ? 'done' : 'now'}>
            <b>Download the sample file</b> <span className="small-muted">(compulsory — the importer accepts only its exact columns; allowed values are on its Lists sheet)</span>
            <div className="dio-row">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => downloadSample('xlsx')} disabled={!!busy}>
                {busy === 'sample-xlsx' ? 'Preparing…' : '⬇ Sample (Excel)'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => downloadSample('csv')} disabled={!!busy}>
                {busy === 'sample-csv' ? 'Preparing…' : '⬇ Sample (CSV)'}
              </button>
              {hasSample && <span className="dio-ok">Sample downloaded ✓</span>}
            </div>
            <div className="small-muted dio-cols">
              Columns: {(caps.columns || []).map((c) => `${c.label}${c.required ? ' ✱' : ''}${c.readOnly ? ' (read-only)' : ''}`).join(' · ')}
            </div>
          </li>
          <li className={!hasSample ? 'locked' : (file ? 'done' : 'now')}>
            <b>Choose the filled-in file</b> <span className="small-muted">(.xlsx or .csv)</span>
            <div className="dio-row">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={!hasSample || !!busy}
                onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); setError(''); }}
              />
              {!hasSample && <span className="small-muted">Download the sample first.</span>}
            </div>
          </li>
          <li className={preview ? 'done' : (file ? 'now' : 'locked')}>
            <b>Check the file</b> — every row is validated; nothing is written.
          </li>
          <li className={result ? 'done' : (preview ? 'now' : 'locked')}>
            <b>{requestMode ? 'Send the request' : 'Import'}</b> — only rows that pass every check are {requestMode ? 'sent' : 'written'}; blanks never overwrite existing values.
          </li>
        </ol>
        {requestMode && preview && !result && (
          <label className="field">
            <span>Note to the Super Admin (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        {preview && !result && (
          <div className="dio-preview">
            <div className="dio-counts">
              <span><b>{preview.rowCount}</b> row(s)</span>
              <span className="c-new"><b>{preview.willCreate}</b> new</span>
              <span className="c-upd"><b>{preview.willUpdate}</b> update</span>
              <span><b>{preview.unchanged}</b> unchanged</span>
              <span className="c-err"><b>{preview.invalidCount}</b> with errors</span>
              {preview.exampleRowsSkipped ? <span className="small-muted">{preview.exampleRowsSkipped} example row(s) skipped</span> : null}
            </div>
            {preview.ignoredReadOnly?.length ? <div className="small-muted">Ignored read-only columns: {preview.ignoredReadOnly.join(', ')}</div> : null}
            {preview.errors?.length > 0 && (
              <div className="dio-errors">
                <b>Errors (these rows will not be imported):</b>
                <ul>{preview.errors.slice(0, 200).map((e, i) => <li key={i}>Row {e.line}{e.label ? ` (${e.label})` : ''} — {e.field}: {e.message}</li>)}</ul>
              </div>
            )}
            {rows.length > 0 && (
              <div className="dio-table">
                <table className="table">
                  <thead><tr><th>Row</th><th>Record</th><th>Action</th><th>Changes</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.line}>
                        <td>{r.line}</td>
                        <td>{r.label}</td>
                        <td><span className={`dio-act a-${r.action}`}>{r.action}</span></td>
                        <td className="small-muted">
                          {r.action === 'error' ? r.errors.join(' | ')
                            : (r.changes || []).map((c) => `${c.field}: ${c.from === '' || c.from == null ? '∅' : c.from} → ${c.to}`).join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {result && (
          <div className="notice dio-result">
            {result.message || (requestMode ? 'Import request sent.' : 'Import finished.')}
            {result.failed?.length ? (
              <ul>{result.failed.slice(0, 50).map((f, i) => <li key={i}>Row {f.line}: {f.reason}</li>)}</ul>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

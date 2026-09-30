import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { HR_STATUSES } from '../../hrStatus.js';
import Modal from '../Modal.jsx';
import './EmployeeIO.css';

// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT → GLOBAL EXPORT, with the Export Fields panel.
//
// The field list is NOT kept here: it comes from GET /employees/export/fields,
// the server's one registry built from the Employee model. Each field says
// whether this login may export it; a locked one is shown with 🔒 and cannot
// be ticked — and the server strips it anyway if it is requested by hand.
//
// The export uses the same scoped query as the list, with the filters that
// are on screen right now (search, department, designation, role, login,
// position) plus an optional Date of Joining range. Status is picked in the
// panel itself and defaults to All statuses.
//
// DOCUMENTS: the "Documents" group (HR / Super Admin / Admin) adds per-employee
// document columns, and an Excel export then carries a second "Documents"
// sheet. "Include document files (ZIP)" asks the server for a .zip of the
// spreadsheet plus every employee's files; roles that may not export
// documents see it locked, and the server refuses it for them regardless.
// ---------------------------------------------------------------------------

const FILTER_LABEL = {
  q: 'Search', dept: 'Department', designation: 'Designation', role: 'Role', status: 'Status',
  login: 'Login', position: 'Position', joinedFrom: 'Joined from', joinedTo: 'Joined to',
};

const fmtMB = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;

function saveBlob(res, fallback) {
  const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || fallback;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove();
  // Released a moment later: revoking at once can cancel the download and
  // leave an empty file in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

export default function GlobalExportPanel({ filters, shownCount, onClose, onDone }) {
  const [meta, setMeta] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [format, setFormat] = useState('xlsx');
  const [joined, setJoined] = useState({ joinedFrom: '', joinedTo: '' });
  // The export covers EVERY status unless one is picked here — the list's own
  // status filter (Active by default) does not quietly narrow it.
  const [status, setStatus] = useState('');
  const [includeFiles, setIncludeFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/employees/export/fields')
      .then((r) => {
        setMeta(r.data);
        setPicked(new Set(r.data.fields.filter((f) => f.default && f.allowed).map((f) => f.key)));
      })
      .catch((err) => setError(err.response?.data?.error || 'Global Export is not included in your role’s permissions.'));
  }, []);

  const groups = useMemo(() => {
    const out = [];
    (meta?.fields || []).forEach((f) => {
      let g = out.find((x) => x.group === f.group);
      if (!g) { g = { group: f.group, sensitive: f.sensitive, fields: [] }; out.push(g); }
      g.fields.push(f);
    });
    return out;
  }, [meta]);

  const allowedKeys = (meta?.fields || []).filter((f) => f.allowed).map((f) => f.key);
  const toggle = (key) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const setGroup = (g, on) => setPicked((s) => {
    const n = new Set(s);
    g.fields.filter((f) => f.allowed).forEach((f) => (on ? n.add(f.key) : n.delete(f.key)));
    return n;
  });

  const activeFilters = { ...filters, status, ...joined };
  const filterChips = Object.entries(activeFilters).filter(([, v]) => v);

  async function runExport() {
    setError(''); setBusy(true);
    try {
      // Keep the list's order: the registry order, not the click order.
      const fields = (meta?.fields || []).filter((f) => picked.has(f.key)).map((f) => f.key);
      const zip = includeFiles && !!meta?.documentFiles?.allowed;
      const res = await api.post('/employees/export/global', { fields, format, filters: activeFilters, includeFiles: zip }, { responseType: 'blob' });
      const name = saveBlob(res, `employees.${zip ? 'zip' : format}`);
      const rows = res.headers['x-export-rows'];
      const stripped = res.headers['x-export-stripped'];
      const files = zip ? ` with ${res.headers['x-export-files'] ?? '?'} document file(s) (${fmtMB(res.headers['x-export-bytes'])})` : '';
      onDone?.(`Exported ${name} — ${rows ?? '?'} employee(s), ${fields.length} field(s)${files}.${stripped ? ` Not permitted and left out: ${stripped}.` : ''}`);
    } catch (err) {
      let msg = 'The export could not be produced.';
      const data = err.response?.data;
      if (data instanceof Blob) {
        try { msg = JSON.parse(await data.text()).error || msg; } catch { /* keep default */ }
      }
      setError(msg);
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Global Export — Export Fields"
      note={meta ? `Scope: ${meta.scope}` : null}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <span className="small-muted" style={{ marginRight: 'auto' }}>
            {picked.size} field(s) selected · {status ? status : 'all-status'} employees matching the other filters
            {joined.joinedFrom || joined.joinedTo ? ', narrowed by joining date' : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !picked.size || !meta} onClick={runExport}>
            {busy ? 'Exporting…' : `Export ${format === 'xlsx' ? 'Excel' : format.toUpperCase()}${includeFiles && meta?.documentFiles?.allowed ? ' + files (ZIP)' : ''}`}
          </button>
        </>
      )}
    >
      <div className="empio">
        {error && <div className="error-text">{error}</div>}
        {!meta && !error && <div className="small-muted">Loading fields…</div>}
        {meta && (
          <>
            <div className="empio-row">
              <span className="small-muted">Format</span>
              {meta.formats.map((f) => (
                <label key={f.id} className="empio-radio">
                  <input type="radio" name="gexp-format" checked={format === f.id} onChange={() => setFormat(f.id)} />
                  {f.label}
                </label>
              ))}
              <span style={{ marginLeft: 'auto' }} />
              <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set(allowedKeys))}>Select all</button>
              <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>Deselect all</button>
            </div>

            <div className="empio-row">
              <span className="small-muted">Employee status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {HR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </div>

            <div className="empio-row">
              <span className="small-muted">Date of Joining</span>
              <input type="date" value={joined.joinedFrom} onChange={(e) => setJoined((j) => ({ ...j, joinedFrom: e.target.value }))} />
              <span className="small-muted">to</span>
              <input type="date" value={joined.joinedTo} onChange={(e) => setJoined((j) => ({ ...j, joinedTo: e.target.value }))} />
            </div>

            {meta.documentFiles && (
              <div className="empio-row">
                <label
                  className={`empio-field${meta.documentFiles.allowed ? '' : ' locked'}`}
                  title={meta.documentFiles.lockedReason || ''}
                >
                  <input
                    type="checkbox"
                    disabled={!meta.documentFiles.allowed}
                    checked={!!meta.documentFiles.allowed && includeFiles}
                    onChange={(e) => setIncludeFiles(e.target.checked)}
                  />
                  <span>{meta.documentFiles.allowed ? '' : '🔒 '}Include document files (ZIP)</span>
                </label>
                <span className="small-muted">
                  {meta.documentFiles.allowed
                    ? `The spreadsheet plus a folder per employee with their files. Up to ${meta.documentFiles.maxFiles.toLocaleString('en-IN')} files / ${fmtMB(meta.documentFiles.maxBytes)}.`
                    : meta.documentFiles.lockedReason}
                </span>
              </div>
            )}

            <div className="empio-filters">
              <span className="small-muted">Filters applied:</span>
              {filterChips.length === 0
                ? <span className="small-muted">none — everyone in your scope</span>
                : filterChips.map(([k, v]) => <span key={k} className="empio-chip">{FILTER_LABEL[k] || k}: {v}</span>)}
            </div>

            {groups.map((g) => (
              <fieldset key={g.group} className={`empio-group${g.sensitive ? ' sensitive' : ''}`}>
                <legend>
                  {g.sensitive ? '🔐 ' : ''}{g.group}
                  {g.fields.some((f) => f.allowed) && (
                    <>
                      <button type="button" className="link-btn" onClick={() => setGroup(g, true)}>all</button>
                      <button type="button" className="link-btn" onClick={() => setGroup(g, false)}>none</button>
                    </>
                  )}
                </legend>
                <div className="empio-grid">
                  {g.fields.map((f) => (
                    <label key={f.key} className={`empio-field${f.allowed ? '' : ' locked'}`} title={f.lockedReason || ''}>
                      <input
                        type="checkbox"
                        disabled={!f.allowed}
                        checked={f.allowed && picked.has(f.key)}
                        onChange={() => toggle(f.key)}
                      />
                      <span>{f.allowed ? '' : '🔒 '}{f.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

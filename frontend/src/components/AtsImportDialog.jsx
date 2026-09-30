// ---------------------------------------------------------------------------
// AtsImportDialog — the ONE import dialog behind every ATS screen's Import
// button (hrms-25). Upload any .xlsx / .xls / .csv → the server matches the
// columns (each one can be changed here) → a preview of EVERY row: will be
// created, updated, skipped (already on file) or refused, with the reason →
// Import. Nothing is written until Import is pressed, and the server checks
// the whole file again before it writes.
//
// The work is the data importer's (routes/atsIo.js on routes/dataImport.js);
// this only shows what it says.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';

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

export async function downloadAtsTemplate(kind) {
  const res = await api.get(`/ats-io/import/${kind}/template`, { responseType: 'blob' });
  return saveBlob(res, `teamlink-${kind}-import-template.xlsx`);
}

const ACTION = { create: 'Create', update: 'Update', skip: 'Skip', error: 'Error' };

export default function AtsImportDialog({ kinds, labels = {}, info = {}, onClose, onDone }) {
  const [kind, setKind] = useState(kinds[0]);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [partial, setPartial] = useState(false);
  const [filter, setFilter] = useState('');

  function form(f, extra = {}) {
    const fd = new FormData();
    if (extra.mapping) fd.append('mapping', JSON.stringify(extra.mapping));
    if (extra.sheet) fd.append('sheet', extra.sheet);
    if (extra.partial) fd.append('partial', 'true');
    fd.append('file', f);
    return fd;
  }

  async function check(f, extra = {}, k = kind) {
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post(`/ats-io/import/${k}/check`, form(f, extra));
      setReport(res.data);
    } catch (e) {
      setReport(null);
      setErr(e.response?.data?.error || 'That file could not be read.');
    } finally { setBusy(false); }
  }

  const currentMapping = () => Object.fromEntries((report?.mapping || []).map((m) => [m.header, m.column === null ? -1 : m.column]));

  function remap(header, value) {
    const next = currentMapping();
    next[header] = value === '' ? -1 : Number(value);
    check(file, { mapping: next, sheet: report?.sheet });
  }

  async function commit() {
    setErr(''); setBusy(true);
    try {
      const res = await api.post(`/ats-io/import/${kind}/commit`, form(file, { mapping: currentMapping(), sheet: report?.sheet, partial }));
      setResult(res.data);
      if (onDone) onDone(res.data);
    } catch (e) {
      if (e.response?.data?.report) setReport(e.response.data.report);
      setErr(e.response?.data?.error || 'The import failed — nothing was written.');
    } finally { setBusy(false); }
  }

  async function template() {
    setErr('');
    try { await downloadAtsTemplate(kind); } catch { setErr('The template could not be downloaded.'); }
  }

  if (result) {
    const t = result.totals;
    return (
      <Modal title="Import finished" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="atsio-dlg">
          <div className="notice">
            <span>
              <b>{labels[kind] || kind}</b> from <b>{result.filename}</b>: {t.create} created, {t.update} updated,
              {' '}{t.skip} skipped{t.error ? `, ${t.error} not imported` : ''}.
              {t.examples > 0 && <> {t.examples} example row(s) were left out.</>}
            </span>
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>The import is recorded in the audit log.</div>
        </div>
      </Modal>
    );
  }

  const t = report?.totals;
  const writable = report && (t.create + t.update) > 0 && (report.ok || partial);
  const rows = (report?.results || []).filter((r) => !filter || r.action === filter);

  return (
    <Modal
      wide
      title={`Import — ${labels[kind] || kind}`}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !writable} onClick={commit}>
            {busy ? 'Working…' : writable ? `Import ${t.create + t.update} row${t.create + t.update === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      )}
    >
      <div className="atsio-dlg">
        <div className="atsio-row">
          {kinds.length > 1 && (
            <label className="field" style={{ margin: 0 }}><span>What to import</span>
              <select
                value={kind}
                disabled={busy}
                onChange={(e) => { setKind(e.target.value); setReport(null); if (file) check(file, {}, e.target.value); }}
              >
                {kinds.map((k) => <option key={k} value={k}>{labels[k] || k}</option>)}
              </select>
            </label>
          )}
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}><span>File (.xlsx, .xls or .csv)</span>
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt"
              onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); setReport(null); check(f); }}
            />
          </label>
          <button type="button" className="btn btn-sm" onClick={template}>Download template</button>
        </div>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          {info[kind]?.note || ''} Your own sheet works too — the columns are matched by name and you can change any match below.
          A record already on file is skipped, never duplicated. Nothing is saved until you press Import.
        </div>

        {busy && !report && <div className="small-muted">Reading the file…</div>}
        {err && <div className="notice amber" style={{ marginBottom: 8 }}><span>{err}</span></div>}

        {report && (
          <>
            <div className="small-muted">
              Sheet <b>{report.sheet}</b>, headings on row {report.headerRow}.
              {report.sheets.length > 1 && (
                <> Other sheets:{' '}
                  <select value={report.sheet} disabled={busy} onChange={(e) => check(file, { sheet: e.target.value })} style={{ width: 'auto' }}>
                    {report.sheets.map((n) => <option key={n}>{n}</option>)}
                  </select>
                </>
              )}
            </div>
            {report.missingRequired.length > 0 && (
              <div className="notice red" style={{ margin: '8px 0' }}>
                <span>Required column(s) not found: <b>{report.missingRequired.join(', ')}</b> — pick them below.</span>
              </div>
            )}
            <div className="atsio-totals">
              <button type="button" className={`atsio-pill${filter === '' ? ' update' : ''}`} onClick={() => setFilter('')}>{t.rows} row(s)</button>
              <button type="button" className="atsio-pill create" onClick={() => setFilter('create')}>{t.create} to create</button>
              <button type="button" className="atsio-pill update" onClick={() => setFilter('update')}>{t.update} to update</button>
              <button type="button" className="atsio-pill skip" onClick={() => setFilter('skip')}>{t.skip} skipped</button>
              <button type="button" className="atsio-pill error" onClick={() => setFilter('error')}>{t.error} with errors</button>
              {t.examples > 0 && <span className="atsio-pill">{t.examples} example row(s) ignored</span>}
            </div>
            {t.error > 0 && (
              <label className="atsio-check">
                <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
                Import the valid rows and leave out the {t.error} with errors
              </label>
            )}

            <details open={report.missingRequired.length > 0} style={{ margin: '8px 0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Which column is which</summary>
              <div className="atsio-map">
                {report.mapping.map((m) => (
                  <label key={m.header} className={m.required ? 'req' : ''}>
                    <span>{m.header}{m.required ? ' *' : ''}</span>
                    <select value={m.column === null ? '' : String(m.column)} disabled={busy} onChange={(e) => remap(m.header, e.target.value)}>
                      <option value="">— not in this file —</option>
                      {report.fileColumns.map((c, i) => (c ? <option key={i} value={String(i)}>{c}</option> : null))}
                    </select>
                  </label>
                ))}
              </div>
              {report.unmapped.length > 0 && (
                <div className="small-muted" style={{ marginTop: 6 }}>Not imported (no matching field): {report.unmapped.join(', ')}</div>
              )}
            </details>

            <div className="tbl-wrap atsio-res">
              <table>
                <thead><tr><th style={{ width: 60 }}>Row</th><th style={{ width: 80 }}>Result</th><th>Detail</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.row}-${i}`}>
                      <td className="cell-muted">{r.row}</td>
                      <td><span className={`atsio-act ${r.action}`}>{ACTION[r.action]}</span></td>
                      <td>{r.column ? <b>{r.column}: </b> : null}{r.message || (r.action === 'create' ? 'New record' : r.action === 'update' ? 'Will be updated' : '')}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan="3" className="small-muted" style={{ padding: 12 }}>{t.rows ? 'No rows in this group.' : 'No data rows found under the headings.'}</td></tr>
                  )}
                </tbody>
              </table>
              {report.truncated && <div className="small-muted" style={{ padding: 6 }}>Only the first 2,000 results are listed.</div>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

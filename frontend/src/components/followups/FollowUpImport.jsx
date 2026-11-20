// ---------------------------------------------------------------------------
// IMPORT FOLLOW-UPS FROM A SHEET (founder 2026-11-20, the Overall report: "give import & export options"). The "Import" button beside
// Export on the Overall report panels and on the Follow-up report. It opens one window:
//   1. Download the template, choose the file (Excel or CSV)
//   2. Which column is which (only when a column name is not recognised; it can always be changed)
//   3. The preview: every row Ready / Needs a choice / Refused (with the reason); pick the right one where several match
//   4. Apply -> the result, with "Undo this import"; the recent imports below, each with Undo
// Nothing is saved before Apply. The server (routes/followUpReport.js /import/*, utils/followUpImport.js) decides who may import what:
// a TL their own team only, a recruiter only their own rows, an Admin / Manager everyone.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import './followUpImport.css';

const STATUS_WORD = { ready: 'Ready', choice: 'Needs a choice', refused: 'Refused' };
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const errText = async (e, fallback) => {
  const d = e?.response?.data;
  if (d instanceof Blob) { try { return JSON.parse(await d.text()).error || fallback; } catch { return fallback; } }
  return d?.error || fallback;
};
const SHOW_MAX = 400;

function ImportWindow({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [choices, setChoices] = useState({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [batches, setBatches] = useState(null);
  const [note, setNote] = useState(null);

  const loadBatches = () => api.get('/followup-report/import/batches').then((r) => setBatches(r.data.batches || [])).catch(() => setBatches([]));
  useEffect(() => { loadBatches(); }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, busy]);

  async function template() {
    setErr(''); setBusy('template');
    try {
      const res = await api.get('/followup-report/import/template', { responseType: 'blob' });
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = 'teamlink-follow-ups-import-template.xlsx'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (e) { setErr(await errText(e, 'The template could not be downloaded.')); } finally { setBusy(''); }
  }

  async function preview(f, mapping) {
    if (!f) return;
    setErr(''); setBusy('preview'); setResult(null); setChoices({}); setFilter('');
    try {
      const fd = new FormData();
      if (mapping) fd.append('mapping', JSON.stringify(mapping));
      if (report?.sheet && mapping) fd.append('sheet', report.sheet);
      fd.append('file', f);
      const res = await api.post('/followup-report/import/preview', fd);
      setReport(res.data);
    } catch (e) {
      setReport(null);
      setErr(await errText(e, 'That file could not be read.'));
    } finally { setBusy(''); }
  }
  const mappingNow = () => Object.fromEntries((report?.mapping || []).map((m) => [m.key, m.column === null ? -1 : m.column]));
  const remap = (key, value) => { const next = mappingNow(); next[key] = value === '' ? -1 : Number(value); preview(file, next); };

  async function choose(row, id) {
    const next = { ...choices, [row]: id };
    if (!id) delete next[row];
    setChoices(next); setBusy('check'); setErr('');
    try {
      const res = await api.post('/followup-report/import/check', { batchId: report.batchId, choices: next });
      setReport(res.data);
    } catch (e) { setErr(await errText(e, 'The choice could not be checked.')); } finally { setBusy(''); }
  }

  async function apply() {
    const n = report.totals.ready;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Import ${n} follow-up${n === 1 ? '' : 's'}? Rows that are refused or still need a choice are left out. You can undo this import afterwards.`)) return;
    setErr(''); setBusy('apply');
    try {
      const res = await api.post('/followup-report/import/apply', { batchId: report.batchId, choices });
      setResult(res.data); setReport(null); setFile(null);
      loadBatches();
      if (onDone) onDone();
    } catch (e) { setErr(await errText(e, 'Nothing was imported: the import failed.')); } finally { setBusy(''); }
  }

  async function undo(id) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Undo this import? Its follow-ups are removed from TeamLink (any that somebody changed since are kept).')) return;
    setErr(''); setBusy(`undo:${id}`); setNote(null);
    try {
      const res = await api.post(`/followup-report/import/batches/${id}/undo`);
      setNote({ ok: true, text: res.data.message });
      if (result && result.batchId === id) setResult({ ...result, undone: res.data });
      loadBatches();
      if (onDone) onDone();
    } catch (e) { setNote({ ok: false, text: await errText(e, 'The import could not be undone.') }); } finally { setBusy(''); }
  }

  const rows = useMemo(() => (report?.rows || []).filter((r) => !filter || r.status === filter), [report, filter]);
  const t = report?.totals;
  const mapList = (report?.mapping || []).filter((m) => !m.optional || m.column !== null || (report?.missing || []).length);

  return (
    <div className="overlay show fui-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal xwide fui-modal" role="dialog" aria-modal="true" aria-label="Import follow-ups">
        <div className="modal-head">
          <h3 style={{ fontSize: 15 }}>Import follow-ups from a sheet</h3>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body fui-body">
          <p className="small-muted fui-intro">
            Bring in the follow-ups your team kept in Excel. Each row becomes a follow-up of that recruiter on that candidate, and counts in the report on the date in the sheet (marked &ldquo;Imported&rdquo;). Nothing is saved until you press Import, and every import can be undone.
          </p>
          <div className="fui-step">
            <button type="button" className="btn btn-sm" onClick={template} disabled={!!busy}>{busy === 'template' ? 'Downloading…' : 'Download template'}</button>
            <label className="btn btn-sm btn-primary fui-file">
              {file ? 'Choose another file' : 'Choose file'}
              <input type="file" accept=".xlsx,.xls,.csv" aria-label="Choose the sheet" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) { setFile(f); preview(f); } }} />
            </label>
            {file && <span className="small-muted">{file.name}</span>}
            {busy === 'preview' && <span className="small-muted">Reading the sheet…</span>}
          </div>
          <div className="small-muted">Columns: Date, Recruiter, Candidate (ID, phone, e-mail or name), Requirement (optional), What happened, Call back on, Answer, Done (optional). At most 5,000 rows and 5 MB.</div>
          {err && <div className="error-text" role="alert">{err}</div>}

          {result && (
            <div className={`fui-result${result.undone ? ' undone' : ''}`} role="status">
              <b>{result.undone ? result.undone.message : result.message}</b>
              {!result.undone && result.skipped.length > 0 && <div className="small-muted">{`${result.skipped.length} row${result.skipped.length === 1 ? ' was' : 's were'} left out (refused or still needing a choice).`}</div>}
              {!result.undone && <button type="button" className="btn btn-sm" onClick={() => undo(result.batchId)} disabled={!!busy}>{busy === `undo:${result.batchId}` ? 'Undoing…' : 'Undo this import'}</button>}
            </div>
          )}

          {report && mapList.length > 0 && (
            <details className="fui-map" open={!report.ok}>
              <summary>{report.ok ? 'Which column is which' : 'Which column is which? Some columns were not recognised'}</summary>
              {!report.ok && report.missing.length > 0 && <div className="error-text">{`Choose the column for: ${report.missing.join(', ')}.`}</div>}
              <div className="fui-map-grid">
                {mapList.map((m) => (
                  <label key={m.key} className="small-muted">
                    {m.label}{m.need ? ' *' : ''}
                    <select value={m.column === null ? '' : String(m.column)} onChange={(e) => remap(m.key, e.target.value)} disabled={!!busy} aria-label={`Column for ${m.label}`}>
                      <option value="">— not in the file —</option>
                      {report.fileColumns.map((c) => <option key={c.index} value={String(c.index)}>{c.name}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}

          {report && report.ok && t && (
            <>
              <div className="fui-counts" role="group" aria-label="Show">
                {[['', `All ${t.rows}`], ['ready', `Ready ${t.ready}`], ['choice', `Needs a choice ${t.choice}`], ['refused', `Refused ${t.refused}`]].map(([k, l]) => (
                  <button key={k || 'all'} type="button" className={`btn btn-sm fui-count ${k || 'all'}${filter === k ? ' btn-primary' : ''}`} onClick={() => setFilter(k)} aria-pressed={filter === k}>{l}</button>
                ))}
                {busy === 'check' && <span className="small-muted">Checking…</span>}
              </div>
              <div className="fui-scroll">
                <table className="fui-table">
                  <thead><tr><th>Row</th><th>Status</th><th>Date</th><th>Recruiter</th><th>Candidate / application</th><th>What happened</th><th>Call back on</th><th>Answer</th><th>Done</th></tr></thead>
                  <tbody>
                    {rows.slice(0, SHOW_MAX).map((r) => (
                      <tr key={r.row} className={`fui-${r.status}`}>
                        <td>{r.row}</td>
                        <td>
                          <span className={`fui-tag ${r.status}`}>{STATUS_WORD[r.status]}</span>
                          {r.reason && <div className="fui-reason">{r.reason}</div>}
                          {r.status === 'choice' && r.choice && (
                            <select value={choices[r.row] || ''} onChange={(e) => choose(r.row, e.target.value)} disabled={!!busy} aria-label={`Choose for row ${r.row}`}>
                              <option value="">{r.choice.kind === 'recruiter' ? 'Choose the recruiter…' : 'Choose the candidate / application…'}</option>
                              {r.choice.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                            </select>
                          )}
                        </td>
                        <td>{r.day ? fmtDay(r.day) : ''}</td>
                        <td>{r.recruiter ? r.recruiter.name : <span className="small-muted">{r.input.recruiter}</span>}</td>
                        <td>{r.application ? r.application.label : r.candidate ? r.candidate.name : <span className="small-muted">{r.input.candidate}{r.input.requirement ? ` · ${r.input.requirement}` : ''}</span>}</td>
                        <td className="fui-what">{r.what}</td>
                        <td>{r.callBack ? fmtDay(r.callBack) : ''}</td>
                        <td>{r.answer || ''}</td>
                        <td>{r.done === null ? '' : r.done ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={9} className="small-muted">No row here.</td></tr>}
                  </tbody>
                </table>
                {rows.length > SHOW_MAX && <div className="small-muted">{`The first ${SHOW_MAX} of ${rows.length} rows are shown. All of them are imported.`}</div>}
              </div>
            </>
          )}

          <div className="fui-recent">
            <h4>Recent imports</h4>
            {note && <div className={note.ok ? 'fui-ok' : 'error-text'} role="status">{note.text}</div>}
            {batches === null ? <div className="small-muted">Loading…</div> : batches.length === 0 ? <div className="small-muted">No import yet.</div> : (
              <div className="fui-scroll">
                <table className="fui-table">
                  <thead><tr><th>When</th><th>By</th><th>File</th><th>Follow-ups</th><th /></tr></thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>{fmtWhen(b.appliedAt)}</td>
                        <td>{b.byName}</td>
                        <td>{b.fileName}</td>
                        <td>{b.status === 'UNDONE' ? `${b.created} - undone${b.undoneByName ? ` by ${b.undoneByName}` : ''}${b.kept ? `, ${b.kept} kept (changed since)` : ''}` : b.created}</td>
                        <td>{b.canUndo && <button type="button" className="btn btn-sm" onClick={() => undo(b.id)} disabled={!!busy}>{busy === `undo:${b.id}` ? 'Undoing…' : 'Undo'}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy === 'apply'}>Close</button>
          {report && report.ok && t && (
            <button type="button" className="btn btn-primary" onClick={apply} disabled={!!busy || !t.ready}>
              {busy === 'apply' ? 'Importing…' : `Import ${t.ready} follow-up${t.ready === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The "Import" button. onDone() runs after an import or an undo, so the report on screen can load again. */
export default function FollowUpImportButton({ onDone, size = 'sm', label = 'Import' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-${size}`} onClick={() => setOpen(true)} title="Bring follow-ups from an Excel or CSV sheet into TeamLink">{label}</button>
      {open && <ImportWindow onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

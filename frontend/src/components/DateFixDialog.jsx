// ---------------------------------------------------------------------------
// DateFixDialog — "Fix came-on dates from a sheet" (founder 2026-11-20). For people who were ALREADY imported with the day of the import as their
// date: upload a sheet with who they are (candidate ID, email and / or phone) and the day they really came.
//
//   1. Upload the sheet (columns are found by name; each can be changed).
//   2. Preview: matched / not found / more than one person / date not readable / kept because TeamLink recorded that date itself; every row
//      shows the date now and the date it will get. NOTHING is written yet.
//   3. Apply (after a confirmation). Each batch can be undone here ("Undo this batch"); the old dates are kept.
//
// Only an Admin, a Manager or a TL sees this (the server checks again). The work is routes/atsIo.js /import/date-fix/*.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';
import { longDay } from '../utils/candidateSource.js';

const STATUS = {
  fix: 'Will be fixed', nochange: 'Already right', protected: 'Kept as it is', notfound: 'Not found', ambiguous: 'More than one person', bad: 'Date not readable', nodate: 'No date', duplicate: 'Repeated row',
};
const WORD = { fromSheet: 'From the sheet', sheet: 'From the old sheet', imported: 'Imported (original date not known)', applied: 'Applied on the portal', entered: 'Added in TeamLink' };

export default function DateFixDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [filter, setFilter] = useState('');
  const [batches, setBatches] = useState([]);
  const [undoMsg, setUndoMsg] = useState(null);

  const loadBatches = () => api.get('/ats-io/import/date-fix/batches').then((r) => setBatches(r.data.batches || [])).catch(() => setBatches([]));
  useEffect(() => { loadBatches(); }, []);

  function form(f, extra = {}) {
    const fd = new FormData();
    if (extra.mapping) fd.append('mapping', JSON.stringify(extra.mapping));
    if (extra.sheet) fd.append('sheet', extra.sheet);
    if (extra.overwrite) fd.append('overwrite', 'true');
    if (extra.confirm) fd.append('confirm', 'true');
    fd.append('file', f);
    return fd;
  }
  async function check(f, extra = {}) {
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post('/ats-io/import/date-fix/check', form(f, { overwrite, ...extra }));
      setReport(res.data);
    } catch (e) {
      setReport(null);
      setErr(e.response?.data?.error || 'That file could not be read.');
    } finally { setBusy(false); }
  }
  const currentMapping = () => Object.fromEntries((report?.mapping || []).map((m) => [m.header, m.column === null ? -1 : m.column]));
  const remap = (header, value) => { const next = currentMapping(); next[header] = value === '' ? -1 : Number(value); check(file, { mapping: next, sheet: report?.sheet }); };
  const toggleOverwrite = (v) => { setOverwrite(v); if (file) check(file, { mapping: currentMapping(), sheet: report?.sheet, overwrite: v }); };

  async function apply() {
    const n = report.totals.fix;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Change the came-on date of ${n} ${n === 1 ? 'person' : 'people'} to the date in the sheet? The old dates are kept and the whole batch can be undone.`)) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post('/ats-io/import/date-fix/apply', form(file, { mapping: currentMapping(), sheet: report?.sheet, overwrite, confirm: true }));
      setDone(res.data);
      loadBatches();
      if (onDone) onDone();
    } catch (e) {
      setErr(e.response?.data?.error || 'Nothing was changed: the fix failed.');
    } finally { setBusy(false); }
  }
  async function undo(id) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Undo this batch? Every person in it gets the date they had before.')) return;
    setBusy(true); setUndoMsg(null);
    try {
      const res = await api.post(`/ats-io/import/date-fix/batches/${id}/undo`);
      setUndoMsg({ ok: true, text: res.data.message });
      loadBatches();
      if (onDone) onDone();
    } catch (e) {
      setUndoMsg({ ok: false, text: e.response?.data?.error || 'The batch could not be undone.' });
    } finally { setBusy(false); }
  }

  const t = report?.totals;
  const rows = (report?.rows || []).filter((r) => !filter || r.status === filter);
  const missing = report?.missing || [];
  const ready = report && t && t.fix > 0 && !missing.length;

  return (
    <Modal
      wide
      title="Fix came-on dates from a sheet"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {!done && (
            <button className="btn btn-primary" disabled={busy || !ready} onClick={apply}>
              {busy ? 'Working…' : ready ? `Apply — fix ${t.fix} ${t.fix === 1 ? 'person' : 'people'}` : 'Apply'}
            </button>
          )}
        </>
      )}
    >
      <div className="atsio-dlg atsio-fix">
        <div className="small-muted" style={{ marginBottom: 8 }}>
          For people who were imported with the day of the import as their date. The sheet needs <b>who they are</b> (candidate ID, email or phone) and <b>the day they really came</b>.
          Nothing is changed until you press Apply. People whose date TeamLink recorded itself (typed in, applied on the portal) are kept unless you tick Overwrite.
        </div>
        {done ? (
          <>
            <div className="notice"><span>{done.message}</span></div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small-muted">{`Batch ${done.batchId}`}</span>
              <button type="button" className="btn btn-sm" disabled={busy || (undoMsg && undoMsg.ok)} onClick={() => undo(done.batchId)}>Undo this batch</button>
            </div>
            {undoMsg && <div className={`notice ${undoMsg.ok ? '' : 'red'}`} style={{ marginTop: 8 }}><span>{undoMsg.text}</span></div>}
          </>
        ) : (
          <>
            <div className="atsio-row">
              <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}><span>Upload the sheet (.xlsx, .xls or .csv)</span>
                <input type="file" accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); setReport(null); check(f); }} />
              </label>
            </div>
            <label className="atsio-check" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={overwrite} disabled={busy} onChange={(e) => toggleOverwrite(e.target.checked)} />
              Overwrite: also change people whose date TeamLink recorded itself
            </label>
            {busy && !report && <div className="small-muted">Reading the file…</div>}
            {err && <div className="notice amber" style={{ marginBottom: 8 }}><span>{err}</span></div>}
            {report && missing.length > 0 && (
              <div className="notice red" style={{ margin: '8px 0' }}><span>The sheet needs {missing.join(' and ')} — pick them below.</span></div>
            )}
            {report && t && (
              <>
                <div className="atsio-big" aria-label="Preview">
                  <div className="v"><b>{t.fix}</b>will be fixed</div>
                  <div className="d"><b>{t.protected + t.noChange}</b>kept as they are</div>
                  <div className="e"><b>{t.notFound + t.ambiguous + t.bad + t.noDate}</b>not usable</div>
                </div>
                <div className="atsio-totals">
                  <button type="button" className={`atsio-pill${filter === '' ? ' update' : ''}`} onClick={() => setFilter('')}>{t.rows} row(s)</button>
                  <button type="button" className="atsio-pill create" onClick={() => setFilter('fix')}>{t.fix} matched</button>
                  <button type="button" className="atsio-pill error" onClick={() => setFilter('notfound')}>{t.notFound} not found</button>
                  <button type="button" className="atsio-pill error" onClick={() => setFilter('ambiguous')}>{t.ambiguous} ambiguous</button>
                  <button type="button" className="atsio-pill error" onClick={() => setFilter('bad')}>{t.bad} bad date</button>
                  <button type="button" className="atsio-pill duplicate" onClick={() => setFilter('protected')}>{t.protected} kept (date recorded by TeamLink)</button>
                  {t.noChange > 0 && <button type="button" className="atsio-pill skip" onClick={() => setFilter('nochange')}>{t.noChange} already right</button>}
                </div>
              </>
            )}
            {report && (
              <details open={missing.length > 0} style={{ margin: '8px 0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Which column is which</summary>
                <div className="atsio-map">
                  {report.mapping.map((m) => (
                    <label key={m.header}>
                      <span>{m.header === 'Date Came' ? 'Date they came' : m.header}</span>
                      <Combo value={m.column === null ? '' : String(m.column)} disabled={busy} onChange={(e) => remap(m.header, e.target.value)}>
                        <option value="">— not in this file —</option>
                        {report.fileColumns.map((c, i) => (c ? <option key={i} value={String(i)}>{c}</option> : null))}
                      </Combo>
                    </label>
                  ))}
                </div>
              </details>
            )}
            {report && t && (
              <div className="tbl-wrap atsio-res">
                <table>
                  <thead><tr><th style={{ width: 50 }}>Row</th><th style={{ width: 140 }}>Result</th><th>Person</th><th>Date now</th><th>Date after</th><th>Detail</th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.row}-${i}`}>
                        <td className="cell-muted">{r.row}</td>
                        <td><span className={`atsio-st ${r.status}`}>{STATUS[r.status] || r.status}</span></td>
                        <td>{r.name || <span className="small-muted">{r.key}</span>}</td>
                        <td>{r.oldDay ? <>{longDay(r.oldDay)}<div className="small-muted">{WORD[r.oldKind] || ''}</div></> : ''}</td>
                        <td>{r.newDay && r.status === 'fix' ? <b>{longDay(r.newDay)}</b> : (r.newDay ? longDay(r.newDay) : '')}</td>
                        <td>{r.message}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan="6" className="small-muted" style={{ padding: 12 }}>No rows in this group.</td></tr>}
                  </tbody>
                </table>
                {report.truncated && <div className="small-muted" style={{ padding: 6 }}>Only the first 2,000 rows are listed.</div>}
              </div>
            )}
          </>
        )}
        {batches.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Earlier batches ({batches.length})</summary>
            {undoMsg && done === null && <div className={`notice ${undoMsg.ok ? '' : 'red'}`} style={{ margin: '6px 0' }}><span>{undoMsg.text}</span></div>}
            <div className="tbl-wrap atsio-hist">
              <table>
                <thead><tr><th>When</th><th>By</th><th>File</th><th>People</th><th /></tr></thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td>{new Date(b.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td>{b.by || ''}</td>
                      <td>{b.file || ''}</td>
                      <td>{b.people}{b.overwrote ? ` (${b.overwrote} overwritten)` : ''}</td>
                      <td>{b.undone ? <span className="small-muted">Undone</span> : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => undo(b.id)}>Undo this batch</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}

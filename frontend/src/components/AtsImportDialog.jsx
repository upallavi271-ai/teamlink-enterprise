// ---------------------------------------------------------------------------
// AtsImportDialog — the ONE import behind every ATS screen's Import button
// (user's spec 2026-10-03 §B: IMPORT in 3 steps):
//
//   1. Download template — the right columns (✱ required) + an example row.
//   2. Upload — any .xlsx / .xls / .csv; columns are matched by name (each
//      match can be changed).
//   3. Preview → "N valid, N errors, N duplicates", the rows with errors as a
//      downloadable file → Confirm.
//
// Never a silent overwrite: a row matching a record on file (phone / email
// for people, name / GST for clients, code / title + client for jobs) is a
// DUPLICATE and is skipped — unless "Update existing records" is ticked.
// Every import is one BATCH that can be undone for 24 hours.
// mode="request" (BDE): Confirm sends the file for approval instead.
//
// The work is the server's (routes/atsIo.js); this only shows what it says.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import Combo from './Combo.jsx';
import { longDay } from '../utils/candidateSource.js';

// The kinds whose rows carry the day the person really came (routes/atsIo.js cameFor).
const DATED_KINDS = ['candidates', 'applications'];
const DATE_FLAG = {
  bad: 'Date not readable', future: 'Date is in the future', old: 'Date is before 2000', none: 'No date: today, marked "original date not known"',
};

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

const ACTION = {
  create: 'New', update: 'Update', skip: 'No change', error: 'Error', duplicate: 'Duplicate',
};
const DUP_RULE = {
  clients: 'same client name or GST number',
  requirements: 'same requirement code, or the same requirement title for the same client',
  candidates: 'same phone or email',
  applications: 'already on that requirement',
};

export default function AtsImportDialog({
  kinds, labels = {}, info = {}, onClose, onDone, mode = 'direct', undoHours = 24, onFixDates = null,
}) {
  const [kind, setKind] = useState(kinds[0]);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [partial, setPartial] = useState(false);
  const [update, setUpdate] = useState(false);
  const [filter, setFilter] = useState('');
  const [undo, setUndo] = useState(null);
  const [gotTemplate, setGotTemplate] = useState(false);
  // "These people came on:" sheet | one | today (a sheet that has a date column starts on "sheet")
  const [dateMode, setDateMode] = useState('sheet');
  const [oneDate, setOneDate] = useState('');

  function form(f, extra = {}) {
    const fd = new FormData();
    const dm = extra.dateMode || dateMode;
    if (DATED_KINDS.includes(extra.kind || kind) && dm !== 'sheet') {
      fd.append('dateMode', dm);
      if (dm === 'one') fd.append('cameOnDate', extra.oneDate !== undefined ? extra.oneDate : oneDate);
    }
    if (extra.mapping) fd.append('mapping', JSON.stringify(extra.mapping));
    if (extra.sheet) fd.append('sheet', extra.sheet);
    if (extra.partial) fd.append('partial', 'true');
    if (extra.update) fd.append('updateExisting', 'true');
    fd.append('file', f);
    return fd;
  }

  async function check(f, extra = {}, k = kind) {
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const res = await api.post(`/ats-io/import/${k}/check`, form(f, { update, kind: k, ...extra }));
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

  // The choice of date: one tap, and the preview is worked out again with it.
  function chooseDates(mode, day = oneDate) {
    setDateMode(mode);
    if (file && (mode !== 'one' || day)) check(file, { mapping: currentMapping(), sheet: report?.sheet, dateMode: mode, oneDate: day });
  }

  function toggleUpdate(v) {
    setUpdate(v);
    if (file) check(file, { mapping: currentMapping(), sheet: report?.sheet, update: v });
  }

  async function errorsFile() {
    setErr('');
    try {
      const res = await api.post(`/ats-io/import/${kind}/errors`, form(file, { mapping: currentMapping(), sheet: report?.sheet, update }), { responseType: 'blob' });
      saveBlob(res, `teamlink-${kind}-rows-with-errors.xlsx`);
    } catch { setErr('The rows-with-errors file could not be produced.'); }
  }

  async function commit() {
    setErr(''); setBusy(true);
    try {
      const path = mode === 'request' ? `/ats-io/import/${kind}/request` : `/ats-io/import/${kind}/commit`;
      const res = await api.post(path, form(file, { mapping: currentMapping(), sheet: report?.sheet, partial, update }));
      setResult(res.data);
      if (onDone && mode !== 'request') onDone(res.data);
    } catch (e) {
      if (e.response?.data?.report) setReport(e.response.data.report);
      setErr(e.response?.data?.error || 'The import failed — nothing was written.');
    } finally { setBusy(false); }
  }

  async function undoBatch(id) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Undo this import? Every record it created is removed and every record it updated goes back to how it was.')) return;
    setBusy(true); setUndo(null);
    try {
      const res = await api.post(`/ats-io/import/batches/${id}/undo`);
      setUndo({ ok: true, text: res.data.message });
      if (onDone) onDone();
    } catch (e) {
      setUndo({ ok: false, text: e.response?.data?.error || 'The import could not be undone.' });
    } finally { setBusy(false); }
  }

  async function template() {
    setErr('');
    try { await downloadAtsTemplate(kind); setGotTemplate(true); } catch { setErr('The template could not be downloaded.'); }
  }

  const step = result ? 4 : report ? 3 : file ? 2 : 1;
  const Steps = (
    <div className="atsio-steps" aria-label="Import steps">
      <span className={`atsio-step ${gotTemplate || step > 1 ? 'done' : 'on'}`}>1 · Download template</span>
      <span className={`atsio-step ${step > 2 ? 'done' : step === 2 || (step === 1 && gotTemplate) ? 'on' : ''}`}>2 · Upload</span>
      <span className={`atsio-step ${step === 3 ? 'on' : step > 3 ? 'done' : ''}`}>3 · Preview &amp; confirm</span>
    </div>
  );

  if (result) {
    if (mode === 'request') {
      return (
        <Modal title="Sent for approval" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
          <div className="atsio-dlg">
            <div className="notice"><span>{result.message || 'Sent for approval.'}</span></div>
            <div className="small-muted" style={{ marginTop: 8 }}>You will get a notification when an Admin or Manager approves or rejects it.</div>
          </div>
        </Modal>
      );
    }
    const t = result.totals;
    return (
      <Modal title="Import finished" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="atsio-dlg">
          <div className="notice">
            <span>
              <b>{labels[kind] || kind}</b> from <b>{result.filename}</b>: {t.create} created, {t.update} updated
              {t.duplicate ? `, ${t.duplicate} duplicate(s) skipped` : ''}{t.error ? `, ${t.errorRows || t.error} row(s) not imported` : ''}.
              {t.withDate !== undefined ? ` ${t.withDate} with their own date${t.noDate ? `, ${t.noDate} without (dated today, marked "original date not known")` : ''}.` : ''}
            </span>
          </div>
          {result.batch ? (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small-muted">{`Batch ${result.batch.id} · can be undone for ${undoHours} hours (History button).`}</span>
              <button type="button" className="btn btn-sm" disabled={busy || (undo && undo.ok)} onClick={() => undoBatch(result.batch.id)}>Undo this import</button>
            </div>
          ) : <div className="small-muted" style={{ marginTop: 8 }}>Nothing was written, so there is nothing to undo.</div>}
          {undo && <div className={`notice ${undo.ok ? '' : 'red'}`} style={{ marginTop: 8 }}><span>{undo.text}</span></div>}
        </div>
      </Modal>
    );
  }

  const t = report?.totals;
  const writable = report && t.valid > 0 && (report.ok || partial) && !(dateMode === 'one' && DATED_KINDS.includes(kind) && !oneDate);
  const rows = (report?.results || []).filter((r) => !filter || r.action === filter);
  const errorRows = t ? (t.errorRows ?? t.error) : 0;

  return (
    <Modal
      wide
      title={`${mode === 'request' ? 'Import for approval' : 'Import'} — ${labels[kind] || kind}`}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !writable} onClick={commit}>
            {busy ? 'Working…' : !writable ? 'Confirm' : mode === 'request' ? `Send ${t.valid} row${t.valid === 1 ? '' : 's'} for approval` : `Confirm — import ${t.valid} row${t.valid === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <div className="atsio-dlg">
        {Steps}
        <div className="atsio-row">
          {kinds.length > 1 && (
            <label className="field" style={{ margin: 0 }}><span>What to import</span>
              <Combo
                value={kind}
                disabled={busy}
                onChange={(e) => { setKind(e.target.value); setReport(null); if (file) check(file, {}, e.target.value); }}
              >
                {kinds.map((k) => <option key={k} value={k}>{labels[k] || k}</option>)}
              </Combo>
            </label>
          )}
          <button type="button" className="btn btn-sm" onClick={template}>1 · Download template</button>
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}><span>2 · Upload the filled file (.xlsx, .xls or .csv)</span>
            <input
              type="file"
              accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt"
              onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); setReport(null); check(f); }}
            />
          </label>
        </div>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          {info[kind]?.note || ''} Nothing is saved until you confirm.
          {mode === 'request' && ' Your role sends imports for approval: an Admin or Manager approves before anything is written.'}
        </div>
        {DATED_KINDS.includes(kind) && (
          <div className="atsio-came" role="radiogroup" aria-label="These people came on">
            <div className="atsio-q">These people came on:</div>
            <label className="atsio-check">
              <input type="radio" name="came-mode" checked={dateMode === 'sheet'} disabled={busy} onChange={() => chooseDates('sheet')} />
              <span>
                <b>The date column of the sheet</b>
                {report ? (report.dateColumn ? ` — using the column "${report.dateColumn}"` : ' — no date column found in this file (pick one under "Which column is which"); people without a date get today, marked "original date not known"') : ' — for example "Applied date", "Date received", "Came on"'}
              </span>
            </label>
            <label className="atsio-check">
              <input type="radio" name="came-mode" checked={dateMode === 'one'} disabled={busy} onChange={() => { setDateMode('one'); if (oneDate && file) chooseDates('one', oneDate); }} />
              <span><b>One date for all rows</b> — for a whole sheet received on a known day</span>
              {dateMode === 'one' && (
                <input type="date" value={oneDate} max={new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)} disabled={busy} style={{ marginLeft: 8 }} aria-label="The day these people came" onChange={(e) => { setOneDate(e.target.value); chooseDates('one', e.target.value); }} />
              )}
            </label>
            <label className="atsio-check">
              <input type="radio" name="came-mode" checked={dateMode === 'today'} disabled={busy} onChange={() => chooseDates('today')} />
              <span><b>Today</b> — the day of the import (they are marked "original date not known")</span>
            </label>
            {onFixDates && <button type="button" className="atsio-link" onClick={onFixDates}>Already imported with today's date? Fix came-on dates from a sheet</button>}
          </div>
        )}
        <label className="atsio-check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={update} disabled={busy} onChange={(e) => toggleUpdate(e.target.checked)} />
          {`Update existing records that match (${DUP_RULE[kind] || 'same record'}) — blank cells keep what is there`}
        </label>

        {busy && !report && <div className="small-muted">Reading the file…</div>}
        {err && <div className="notice amber" style={{ marginBottom: 8 }}><span>{err}</span></div>}

        {report && (
          <>
            <div className="atsio-big" aria-label="Preview">
              <div className="v"><b>{t.valid}</b>valid</div>
              <div className="e"><b>{errorRows}</b>{errorRows === 1 ? 'error' : 'errors'}</div>
              <div className="d"><b>{t.duplicate || 0}</b>{t.duplicate === 1 ? 'duplicate' : 'duplicates'}</div>
            </div>
            <div className="small-muted">
              Sheet <b>{report.sheet}</b>, headings on row {report.headerRow}.
              {report.sheets.length > 1 && (
                <> Other sheets:{' '}
                  <Combo value={report.sheet} disabled={busy} onChange={(e) => check(file, { sheet: e.target.value })} style={{ width: 'auto' }}>
                    {report.sheets.map((n) => <option key={n}>{n}</option>)}
                  </Combo>
                </>
              )}
              {t.examples > 0 && ` · ${t.examples} example row(s) ignored.`}
            </div>
            {report.missingRequired.length > 0 && (
              <div className="notice red" style={{ margin: '8px 0' }}>
                <span>Required column(s) not found: <b>{report.missingRequired.join(', ')}</b> — pick them below.</span>
              </div>
            )}
            {DATED_KINDS.includes(kind) && t.withDate !== undefined && (
              <div className="small-muted" style={{ margin: '4px 0' }} aria-label="Dates in this file">
                <b>{t.withDate}</b> {t.withDate === 1 ? 'row has' : 'rows have'} a date
                {dateMode === 'one' ? ` (${longDay(report.dates?.day)} for all)` : ''}
                {t.noDate > 0 ? <> · <b>{t.noDate}</b> {t.noDate === 1 ? 'has' : 'have'} none (today, marked "original date not known")</> : null}
                {t.badDate > 0 ? <> · <b style={{ color: 'var(--red)' }}>{t.badDate}</b> {t.badDate === 1 ? 'has' : 'have'} a date that cannot be used</> : null}
              </div>
            )}
            <div className="atsio-totals">
              <button type="button" className={`atsio-pill${filter === '' ? ' update' : ''}`} onClick={() => setFilter('')}>{t.rows} row(s)</button>
              <button type="button" className="atsio-pill create" onClick={() => setFilter('create')}>{t.create} new</button>
              <button type="button" className="atsio-pill update" onClick={() => setFilter('update')}>{t.update} to update</button>
              <button type="button" className="atsio-pill duplicate" onClick={() => setFilter('duplicate')}>{t.duplicate || 0} duplicates</button>
              <button type="button" className="atsio-pill error" onClick={() => setFilter('error')}>{errorRows} with errors</button>
              {t.skip > 0 && <button type="button" className="atsio-pill skip" onClick={() => setFilter('skip')}>{t.skip} no change</button>}
              {errorRows > 0 && <button type="button" className="btn btn-sm" onClick={errorsFile}>Download rows with errors</button>}
            </div>
            {errorRows > 0 && (
              <label className="atsio-check">
                <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
                {`Import the ${t.valid} valid row(s) and leave out the ${errorRows} with errors`}
              </label>
            )}

            <details open={report.missingRequired.length > 0} style={{ margin: '8px 0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Which column is which</summary>
              <div className="atsio-map">
                {report.mapping.map((m) => (
                  <label key={m.header} className={m.required ? 'req' : ''}>
                    <span>{m.header}{m.required ? ' (needed)' : ''}</span>
                    <Combo value={m.column === null ? '' : String(m.column)} disabled={busy} onChange={(e) => remap(m.header, e.target.value)}>
                      <option value="">— not in this file —</option>
                      {report.fileColumns.map((c, i) => (c ? <option key={i} value={String(i)}>{c}</option> : null))}
                    </Combo>
                  </label>
                ))}
              </div>
              {report.unmapped.length > 0 && (
                <div className="small-muted" style={{ marginTop: 6 }}>Not imported (no matching field): {report.unmapped.join(', ')}</div>
              )}
            </details>

            <div className="tbl-wrap atsio-res">
              <table>
                <thead><tr><th style={{ width: 60 }}>Row</th><th style={{ width: 90 }}>Result</th>{DATED_KINDS.includes(kind) && <th style={{ width: 130 }}>Came on</th>}<th>Detail</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.row}-${i}`}>
                      <td className="cell-muted">{r.row}</td>
                      <td><span className={`atsio-act ${r.action}`}>{ACTION[r.action] || r.action}</span></td>
                      {DATED_KINDS.includes(kind) && (
                        <td title={r.cameOnFlag ? DATE_FLAG[r.cameOnFlag] || '' : ''} style={['bad', 'future', 'old'].includes(r.cameOnFlag) ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
                          {r.cameOn ? longDay(r.cameOn) : ['bad', 'future', 'old'].includes(r.cameOnFlag) ? DATE_FLAG[r.cameOnFlag] : (r.cameOnFlag === 'none' ? <span className="small-muted">none · today</span> : '')}
                        </td>
                      )}
                      <td>{r.column ? <b>{r.column}: </b> : null}{r.message || (r.action === 'create' ? 'New record' : r.action === 'update' ? 'Will be updated' : '')}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan="4" className="small-muted" style={{ padding: 12 }}>{t.rows ? 'No rows in this group.' : 'No data rows found under the headings.'}</td></tr>
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

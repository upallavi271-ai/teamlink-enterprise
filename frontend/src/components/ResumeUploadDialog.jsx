// ---------------------------------------------------------------------------
// Candidates → Upload resumes button (spec 2026-10-03 §B "bulk resume
// upload"). Same three steps as every import:
//   1. choose several PDF / DOCX / RTF resumes (each is read on the server by the ONE shared parser: name, email, phone, location, experience, notice period,
//      current and expected CTC, date of birth, skills, jobs, degrees - only what the resume states);
//   2. PREVIEW: "N valid, N errors, N duplicates" — a duplicate is a
//      candidate already on file with the same phone / email; correct a name
//      / email / phone in place, or leave a file out. Every read value has a
//      chip (Sure / Likely / Not sure); "Details" shows all of them, and what
//      is FLAGGED (age that cannot be, two different CTCs, a name that differs...)
//      with the resume sentence highlighted;
//   3. Confirm → one batch (undoable for 24 h), optionally added to one
//      requirement's pipeline. A flagged person is still created, marked "needs
//      verification"; an upload by a recruiter waits for the team lead's approval.
// With the Admin switch "Auto-create candidates from staff uploads when nothing is flagged" ON (default OFF) a clean resume is created at once, without Confirm.
// ---------------------------------------------------------------------------
import { Fragment, useEffect, useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';
import { PICK_SOURCES } from '../utils/candidateSource.js';
import Combo from './Combo.jsx';
import { validateSalaries } from '../utils/salaryFit'; // current + expected salary are required
import { ConfChip, FlagRow } from './candidate/VerifyBits.jsx';

const DETAIL_ROWS = [
  ['noticePeriod', 'Notice period', (it) => it.fields.noticePeriod],
  ['dob', 'Date of birth', (it) => it.fields.dob],
  ['location', 'Current location', (it) => it.fields.location],
  ['experienceYears', 'Total experience', (it) => (it.fields.experienceYears != null ? `${it.fields.experienceYears} years` : null)],
  ['skills', 'Skills', (it) => it.fields.skills],
  ['employment', 'Jobs read', (it) => ((it.details && it.details.employment) || []).map((j) => [j.title, j.company].filter(Boolean).join(' at ')).join(' · ') || null],
  ['educationEntries', 'Degrees read', (it) => ((it.details && it.details.educationEntries) || []).map((e) => [e.degree, e.specialisation && `(${e.specialisation})`, e.year].filter(Boolean).join(' ')).join(' · ') || null],
  ['languagesKnown', 'Languages known', (it) => ((it.details && it.details.languagesKnown) || []).join(', ') || null],
  ['address', 'Address', (it) => it.details && it.details.address],
  ['nativePlace', 'Native place', (it) => it.details && it.details.nativePlace],
  ['maritalStatus', 'Marital status', (it) => it.details && it.details.maritalStatus],
  ['fatherName', "Father's name", (it) => it.details && it.details.fatherName],
];

export default function ResumeUploadDialog({ onClose, onDone }) {
  const [items, setItems] = useState([]); // { token, fileName, fields, error, duplicate, warning, confidence, evidence, flags, details, autoCreated, edit:{}, skip }
  const [progress, setProgress] = useState(null);
  const [update, setUpdate] = useState(false);
  const [reqCode, setReqCode] = useState('');
  const [cameOn, setCameOn] = useState(''); // the day these resumes came (optional); blank = today, marked "original date not known"
  const [source, setSource] = useState(''); // where these resumes came from (the clean source list); blank = Other
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [auto, setAuto] = useState(false); // the Admin switch: a clean resume is created at once
  const [open, setOpen] = useState({}); // row index -> details shown
  useEffect(() => { api.get('/ats/data-verify/settings').then((r) => setAuto(!!r.data.autoCreateStaffUploads)).catch(() => {}); }, []);

  async function pick(files) {
    const list = [...files].slice(0, 200);
    setErr(''); setProgress({ done: 0, total: list.length });
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const fd = new FormData();
      if (auto) { fd.append('auto', '1'); if (reqCode.trim()) fd.append('requirementCode', reqCode.trim()); if (source) fd.append('source', source); }
      fd.append('file', list[i]);
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post('/ats-io/resumes/parse', fd);
        out.push({ ...r.data, edit: {}, skip: !!(r.data.autoCreated && !r.data.autoCreated.failed) });
      } catch (e) {
        out.push({ token: null, fileName: list[i].name, fields: {}, error: e.response?.data?.error || 'Could not be uploaded.', edit: {}, skip: true });
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setItems((cur) => [...cur, ...out]);
    setProgress(null);
    if (out.some((o) => o.autoCreated && !o.autoCreated.failed) && onDone) onDone();
  }

  const val = (it, k) => (it.edit[k] !== undefined ? it.edit[k] : (it.fields[k] || ''));
  // Current + expected salary are required for a NEW candidate (the CV may say it: read above, otherwise type it here). Fix these first.
  const salaryProblem = (it) => {
    if (it.duplicate && update) return null;
    const v = validateSalaries({ currentSalary: val(it, 'currentSalary'), expectedSalary: val(it, 'expectedSalary') });
    return v.ok ? null : v.message;
  };
  const madeAlone = (it) => !!(it.autoCreated && !it.autoCreated.failed);
  const statusOf = (it) => {
    if (madeAlone(it)) return 'created';
    if (it.skip) return 'left out';
    if (it.error || !it.token) return 'error';
    if (!val(it, 'name') || (!val(it, 'email') && !val(it, 'phone'))) return 'error';
    if (it.duplicate && !update) return 'duplicate';
    if (salaryProblem(it)) return 'error';
    return 'valid';
  };
  const n = (s) => items.filter((it) => statusOf(it) === s).length;
  const setEdit = (i, k, v) => setItems((cur) => cur.map((it, j) => (j === i ? { ...it, edit: { ...it.edit, [k]: v } } : it)));
  const setSkip = (i, v) => setItems((cur) => cur.map((it, j) => (j === i ? { ...it, skip: v } : it)));

  async function confirm() {
    setBusy(true); setErr('');
    try {
      const payload = {
        requirementCode: reqCode.trim() || undefined,
        source: source || undefined,
        cameOn: cameOn || undefined,
        updateExisting: update,
        items: items.filter((it) => it.token && !madeAlone(it)).map((it) => ({
          token: it.token, skip: statusOf(it) !== 'valid', name: val(it, 'name'), email: val(it, 'email'), phone: val(it, 'phone'), currentSalary: val(it, 'currentSalary'), expectedSalary: val(it, 'expectedSalary'),
        })),
      };
      const r = await api.post('/ats-io/resumes/commit', JSON.stringify(payload), { headers: { 'Content-Type': 'text/plain' } });
      setResult(r.data);
      if (onDone) onDone();
    } catch (e) { setErr(e.response?.data?.error || 'The resumes could not be imported.'); } finally { setBusy(false); }
  }

  async function undo() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Undo this upload? The candidates it created are removed.')) return;
    try { const r = await api.post(`/ats-io/import/batches/${result.batch.id}/undo`); setErr(''); setResult({ ...result, undone: r.data.message }); if (onDone) onDone(); } catch (e) { setErr(e.response?.data?.error || 'Could not undo.'); }
  }

  if (result) {
    const t = result.totals;
    const needCheck = (result.results || []).filter((r) => /to verify/.test(r.message || '')).length;
    const autoMade = items.filter(madeAlone).length;
    return (
      <Modal title="Resumes imported" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="atsio-dlg">
          <div className="notice"><span>{`${t.create} candidate(s) created, ${t.update} updated, ${t.duplicate} duplicate(s) skipped${t.error ? `, ${t.error} not imported` : ''}.${autoMade ? ` ${autoMade} more were created on their own (nothing flagged).` : ''}`}</span></div>
          {needCheck > 0 && <div className="notice amber" style={{ marginTop: 8 }}><span>{`${needCheck} of them need verification. They are saved and listed under "Verify" on the Candidates screen; the team lead approves them.`}</span></div>}
          {result.batch && !result.undone && (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small-muted">{`Batch ${result.batch.id} · can be undone for 24 hours.`}</span>
              <button type="button" className="btn btn-sm" onClick={undo}>Undo this upload</button>
            </div>
          )}
          {result.undone && <div className="notice" style={{ marginTop: 8 }}><span>{result.undone}</span></div>}
          {err && <div className="notice red" style={{ marginTop: 8 }}><span>{err}</span></div>}
          {(result.results || []).some((r) => r.action === 'error') && (
            <ul className="small-muted" style={{ marginTop: 8 }}>
              {result.results.filter((r) => r.action === 'error').map((r) => <li key={r.token || r.fileName}>{`${r.fileName}: ${r.message}`}</li>)}
            </ul>
          )}
        </div>
      </Modal>
    );
  }

  const valid = n('valid');
  const chip = (it, k) => (it.token && it.edit[k] === undefined ? <ConfChip level={(it.confidence || {})[k]} /> : null);
  return (
    <Modal
      wide
      title="Upload resumes"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !valid || !!progress} onClick={confirm}>{busy ? 'Working…' : `Confirm — create ${valid} candidate${valid === 1 ? '' : 's'}`}</button>
        </>
      )}
    >
      <div className="atsio-dlg">
        <div className="atsio-steps">
          <span className={`atsio-step ${items.length ? 'done' : 'on'}`}>1 · Choose resumes</span>
          <span className={`atsio-step ${items.length ? 'on' : ''}`}>2 · Preview</span>
          <span className="atsio-step">3 · Confirm</span>
        </div>
        <div className="atsio-row">
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}><span>PDF, DOCX or RTF resumes — several at once</span>
            <input type="file" multiple accept=".pdf,.docx,.doc,.rtf,.txt,.jpg,.jpeg,.png" disabled={!!progress} onChange={(e) => { if (e.target.files?.length) pick(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}><span>Add to requirement (code, optional)</span>
            <input value={reqCode} onChange={(e) => setReqCode(e.target.value)} placeholder="e.g. MED-0001" />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}><span>Where did these resumes come from?</span>
            <Combo allowCustom value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Not sure (Other)</option>
              {PICK_SOURCES.filter((s) => s !== 'Other').map((s) => <option key={s} value={s}>{s}</option>)}
            </Combo>
          </label>
          <label className="field" style={{ margin: 0, minWidth: 180 }}><span>These resumes came on (optional)</span>
            <input type="date" value={cameOn} max={new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)} onChange={(e) => setCameOn(e.target.value)} title="Blank = today. People are then marked: Imported on today's date (original date not known)." />
          </label>
        </div>
        <label className="atsio-check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
          Update candidates already on file (same phone or email) — otherwise they are skipped
        </label>
        {auto && <div className="small-muted" style={{ marginBottom: 6 }}>Auto-create is ON: a resume with nothing flagged is created as soon as it is read. Anything flagged waits here for Confirm.</div>}
        {progress && <div className="small-muted">{`Reading ${progress.done} of ${progress.total}…`}</div>}
        {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
        {items.length > 0 && (
          <>
            <div className="atsio-big">
              <div className="v"><b>{valid}</b>valid</div>
              <div className="e"><b>{n('error')}</b>errors</div>
              <div className="d"><b>{n('duplicate')}</b>duplicates</div>
              {n('created') > 0 && <div className="v"><b>{n('created')}</b>created on their own</div>}
              <div className="d"><b>{items.filter((it) => (it.flags || []).length && statusOf(it) !== 'left out').length}</b>to verify</div>
            </div>
            <div className="small-muted" style={{ marginBottom: 4 }}>The chip beside a value says how sure the reader is: Sure (the resume labels it), Likely (read from a phrase), Not sure (a guess or two different values). Press Details to see all of them.</div>
            <div className="tbl-wrap atsio-res">
              <table>
                <thead><tr><th>File</th><th>Name</th><th>Email</th><th>Phone</th><th>Current salary</th><th>Expected salary</th><th>Result</th><th /></tr></thead>
                <tbody>
                  {items.map((it, i) => {
                    const st = statusOf(it);
                    const flags = it.flags || [];
                    return (
                      <Fragment key={`${it.token || it.fileName}-${i}`}>
                        <tr>
                          <td title={it.fileName} style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.fileName}</td>
                          {['name', 'email', 'phone', 'currentSalary', 'expectedSalary'].map((k) => (
                            <td key={k}>
                              <input value={val(it, k)} disabled={!it.token || it.skip} onChange={(e) => setEdit(i, k, e.target.value)} style={{ minWidth: 0, width: '100%' }} aria-label={`${k} for ${it.fileName}`} />
                              {chip(it, k)}
                            </td>
                          ))}
                          <td>
                            <span className={`atsio-act ${st === 'valid' || st === 'created' ? 'create' : st === 'duplicate' ? 'duplicate' : st === 'error' ? 'error' : 'skip'}`}>{st}</span>
                            {flags.length > 0 && st !== 'left out' && <span className="vb-chip vb-low" title="Saved, but marked 'needs verification' until a person checks it">{`${flags.length} to verify`}</span>}
                            <div className="small-muted" style={{ fontSize: 11 }}>
                              {it.error || (it.token && !it.skip && salaryProblem(it)) || (it.duplicate ? `On file: ${it.duplicate.name}` : it.warning) || (it.autoCreated && it.autoCreated.failed ? `Auto-create failed: ${it.autoCreated.message}` : '') || ''}
                            </div>
                          </td>
                          <td>
                            {it.token && !madeAlone(it) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSkip(i, !it.skip)}>{it.skip ? 'Include' : 'Leave out'}</button>}
                            {it.token && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>{open[i] ? 'Hide' : 'Details'}</button>}
                          </td>
                        </tr>
                        {open[i] && it.token && (
                          <tr>
                            <td colSpan={8}>
                              <div style={{ padding: '4px 6px' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                                  {DETAIL_ROWS.map(([k, label, get]) => {
                                    const v = get(it);
                                    return (
                                      <div key={k}>
                                        <div className="vb-k">{label}</div>
                                        <div className="vb-v">{v || '—'}{v ? <ConfChip level={(it.confidence || {})[k]} /> : null}</div>
                                      </div>
                                    );
                                  })}
                                </div>
                                {it.details && it.details.skillCategories && (
                                  <div style={{ marginTop: 6 }} className="small-muted">
                                    {Object.entries(it.details.skillCategories).filter(([, v]) => v.length).map(([cat, v]) => `${cat}: ${v.join(', ')}`).join(' · ')}
                                  </div>
                                )}
                                {flags.length > 0 && <div style={{ marginTop: 6 }}><b>To verify</b>{flags.map((f, j) => <FlagRow key={j} flag={{ ...f, status: 'OPEN', saved: f.saved || val(it, f.field) }} />)}</div>}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

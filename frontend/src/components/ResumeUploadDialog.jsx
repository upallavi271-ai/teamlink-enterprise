// ---------------------------------------------------------------------------
// Candidates → Upload resumes button (spec 2026-10-03 §B "bulk resume
// upload"). Same three steps as every import:
//   1. choose several PDF / DOCX resumes (each is read on the server: name,
//      email, phone, location, experience, notice, salary, skills — only
//      what the resume states);
//   2. PREVIEW: "N valid, N errors, N duplicates" — a duplicate is a
//      candidate already on file with the same phone / email; correct a name
//      / email / phone in place, or leave a file out;
//   3. Confirm → one batch (undoable for 24 h), optionally added to one
//      requirement's pipeline.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../api';
import { Modal } from './proto.jsx';

export default function ResumeUploadDialog({ onClose, onDone }) {
  const [items, setItems] = useState([]); // { token, fileName, fields, error, duplicate, warning, edit:{}, skip }
  const [progress, setProgress] = useState(null);
  const [update, setUpdate] = useState(false);
  const [reqCode, setReqCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  async function pick(files) {
    const list = [...files].slice(0, 200);
    setErr(''); setProgress({ done: 0, total: list.length });
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const fd = new FormData();
      fd.append('file', list[i]);
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.post('/ats-io/resumes/parse', fd);
        out.push({ ...r.data, edit: {}, skip: false });
      } catch (e) {
        out.push({ token: null, fileName: list[i].name, fields: {}, error: e.response?.data?.error || 'Could not be uploaded.', edit: {}, skip: true });
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setItems((cur) => [...cur, ...out]);
    setProgress(null);
  }

  const val = (it, k) => (it.edit[k] !== undefined ? it.edit[k] : (it.fields[k] || ''));
  const statusOf = (it) => {
    if (it.skip) return 'left out';
    if (it.error || !it.token) return 'error';
    if (!val(it, 'name') || (!val(it, 'email') && !val(it, 'phone'))) return 'error';
    if (it.duplicate && !update) return 'duplicate';
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
        updateExisting: update,
        items: items.filter((it) => it.token).map((it) => ({
          token: it.token, skip: statusOf(it) !== 'valid', name: val(it, 'name'), email: val(it, 'email'), phone: val(it, 'phone'),
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
    return (
      <Modal title="Resumes imported" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="atsio-dlg">
          <div className="notice"><span>{`${t.create} candidate(s) created, ${t.update} updated, ${t.duplicate} duplicate(s) skipped${t.error ? `, ${t.error} not imported` : ''}.`}</span></div>
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
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}><span>PDF or DOCX resumes — several at once</span>
            <input type="file" multiple accept=".pdf,.docx,.doc,.txt" disabled={!!progress} onChange={(e) => { if (e.target.files?.length) pick(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 200 }}><span>Add to requirement (code, optional)</span>
            <input value={reqCode} onChange={(e) => setReqCode(e.target.value)} placeholder="e.g. MED-0001" />
          </label>
        </div>
        <label className="atsio-check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
          Update candidates already on file (same phone or email) — otherwise they are skipped
        </label>
        {progress && <div className="small-muted">{`Reading ${progress.done} of ${progress.total}…`}</div>}
        {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
        {items.length > 0 && (
          <>
            <div className="atsio-big">
              <div className="v"><b>{valid}</b>valid</div>
              <div className="e"><b>{n('error')}</b>errors</div>
              <div className="d"><b>{n('duplicate')}</b>duplicates</div>
            </div>
            <div className="tbl-wrap atsio-res">
              <table>
                <thead><tr><th>File</th><th>Name</th><th>Email</th><th>Phone</th><th>Result</th><th /></tr></thead>
                <tbody>
                  {items.map((it, i) => {
                    const st = statusOf(it);
                    return (
                      <tr key={`${it.token || it.fileName}-${i}`}>
                        <td title={it.fileName} style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.fileName}</td>
                        {['name', 'email', 'phone'].map((k) => (
                          <td key={k}><input value={val(it, k)} disabled={!it.token || it.skip} onChange={(e) => setEdit(i, k, e.target.value)} style={{ minWidth: 0, width: '100%' }} aria-label={`${k} for ${it.fileName}`} /></td>
                        ))}
                        <td>
                          <span className={`atsio-act ${st === 'valid' ? 'create' : st === 'duplicate' ? 'duplicate' : st === 'error' ? 'error' : 'skip'}`}>{st}</span>
                          <div className="small-muted" style={{ fontSize: 11 }}>
                            {it.error || (it.duplicate ? `On file: ${it.duplicate.name}` : it.warning) || ''}
                          </div>
                        </td>
                        <td>{it.token && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSkip(i, !it.skip)}>{it.skip ? 'Include' : 'Leave out'}</button>}</td>
                      </tr>
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

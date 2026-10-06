// ---------------------------------------------------------------------------
// AtsDataTools — the Import / Export buttons every ATS screen carries next to
// its primary button. SEPARATE BUTTONS, not a dropdown (user, 2026-10-03:
// "import, export buttons, dropdown laaga kaakunda, separate buttons ivvu —
// employees ki easy ga, clear ga ardham avvali").
//
//   <AtsDataTools
//     module="requirements"                 // the export (routes/atsIo.js EXPORTS)
//     body={() => ({ params, view, ids })}  // the screen's state at click time
//     kinds={['requirements']}              // import kinds; [] = Export only
//     onImported={load}
//   />
//
// [⬆ Import]          the 3-step import (Download template is step 1 inside it);
//                      BDE: "Import (needs approval)" — an Admin / Manager approves
// [⬆ Upload resumes]  Candidates
// [⬇ Export]          two plain questions — which rows, which file — then Download
// [History]           undo an import within 24 h, approvals, big exports
//
// Nothing is decided here. /api/ats-io/access says what this login gets, and
// every request is checked again on the server (role scope, sensitive
// columns, background exports over 10,000 rows).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import AtsImportDialog from './AtsImportDialog.jsx';
import { Modal } from './proto.jsx';
import AtsIoHistory from './AtsIoHistory.jsx';
import ResumeUploadDialog from './ResumeUploadDialog.jsx';
import './AtsDataTools.css';

// One /access call per login per page load.
const accessCache = new Map();
export function useAtsIoAccess() {
  const { user } = useAuth();
  const key = user ? user.id : '';
  const [access, setAccess] = useState(() => accessCache.get(key)?.value || null);
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    let entry = accessCache.get(key);
    if (!entry) {
      entry = { promise: api.get('/ats-io/access').then((r) => { entry.value = r.data; return r.data; }) };
      entry.promise.catch(() => accessCache.delete(key));
      accessCache.set(key, entry);
    }
    entry.promise.then((a) => { if (live) setAccess(a); }).catch(() => { if (live) setAccess({ exports: {}, imports: {}, kinds: {} }); });
    return () => { live = false; };
  }, [key]);
  return access;
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
async function jsonOfBlob(data) {
  if (data instanceof Blob) { try { return JSON.parse(await data.text()); } catch { return {}; } }
  return data || {};
}

const FORMAT_LABEL = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF' };

// The export itself: the server's file, or (big exports) a "being prepared" note.
export async function runAtsExport(module, payload, format) {
  const res = await api.post(`/ats-io/export/${module}`, JSON.stringify(payload || {}), {
    params: { format }, responseType: 'blob', headers: { 'Content-Type': 'text/plain' }, validateStatus: (s) => s < 300,
  });
  if (res.status === 202) {
    const info = await jsonOfBlob(res.data);
    return { background: true, text: info.message || 'The export is being prepared in the background.' };
  }
  const name = saveBlob(res, `export.${format}`);
  const rows = res.headers?.['x-export-rows'];
  return { background: false, text: `Downloaded ${name}${rows ? ` — ${Number(rows).toLocaleString('en-IN')} row(s)` : ''}.` };
}

const FORMAT_HINT = { xlsx: 'Best for most work', csv: 'Plain text, for other tools', pdf: 'To print or share' };

export default function AtsDataTools({
  module, body, params, kinds = [], onImported, formats = ['xlsx', 'csv', 'pdf'],
  // historyInExport: History opens from inside the Export dialog instead of
  // its own header button (keeps a header at 3 small buttons). Ignored when
  // this login cannot export — then the History button stays.
  historyInExport = false,
  // label / exportLabel kept for older callers; the buttons say what they do.
  label, exportLabel, // eslint-disable-line no-unused-vars
}) {
  const access = useAtsIoAccess();
  const [dialog, setDialog] = useState(null); // 'import' | 'request' | 'resumes' | 'export' | 'history'
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [scope, setScope] = useState('view');
  const [format, setFormat] = useState(formats[0]);

  if (!access) return null;
  const modes = access.importModes || {};
  const mayExport = !!(access.exports || {})[module];
  const allKinds = module === 'candidates' && !kinds.includes('resumes') ? [...kinds, 'resumes'] : kinds;
  const importKinds = allKinds.filter((k) => k !== 'resumes' && (modes[k] || (access.imports || {})[k]));
  const directKinds = importKinds.filter((k) => (modes[k] || 'direct') === 'direct');
  const requestKinds = importKinds.filter((k) => modes[k] === 'request');
  const mayResumes = allKinds.includes('resumes') && modes.resumes === 'direct';
  const labels = Object.fromEntries(Object.entries(access.kinds || {}).map(([k, v]) => [k, v.label]));
  const approver = !!(access.viewer && access.viewer.approver);
  if (!mayExport && !importKinds.length && !mayResumes) return null;

  async function runExport() {
    setBusy(true); setMsg(null);
    try {
      const state = (typeof body === 'function' ? body() : body) || (params ? { params } : {});
      const out = await runAtsExport(module, { ...state, scope }, format);
      setDialog(null);
      setMsg({ ok: true, text: out.text, background: out.background });
    } catch (err) {
      const info = await jsonOfBlob(err?.response?.data);
      setMsg({ ok: false, text: info.error || 'The export could not be produced.' });
    } finally { setBusy(false); }
  }

  const importKindsForDialog = dialog === 'request' ? requestKinds : directKinds;
  // Resume files are the first choice INSIDE Import (2026-10-03: the header
  // keeps 3 small buttons). Without resume rights Import opens as before.
  const openImport = (target) => setDialog(mayResumes ? `pick:${target}` : target);
  return (
    <div className="atsio">
      {directKinds.length > 0 && (
        <button type="button" className="btn btn-sm" onClick={() => openImport('import')} title={mayResumes ? 'Bulk upload (Excel list) or upload resume files' : 'Add many records at once from an Excel file'}>
          <span aria-hidden="true">⬆</span> Import
        </button>
      )}
      {requestKinds.length > 0 && (
        <button type="button" className="btn btn-sm" onClick={() => (directKinds.length ? setDialog('request') : openImport('request'))} title="Upload an Excel file — an Admin or Manager approves it before it is added">
          <span aria-hidden="true">⬆</span> Import (needs approval)
        </button>
      )}
      {mayResumes && !directKinds.length && !requestKinds.length && (
        <button type="button" className="btn btn-sm" onClick={() => setDialog('resumes')} title="Upload resume files (PDF / DOCX)">
          <span aria-hidden="true">⬆</span> Import
        </button>
      )}
      {mayExport && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setMsg(null); setDialog('export'); }} title="Download this list as Excel, CSV or PDF">
          <span aria-hidden="true">⬇</span> {busy ? 'Exporting…' : 'Export'}
        </button>
      )}
      {!(historyInExport && mayExport) && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog('history')} title="Past imports and exports — undo an import within 24 hours">
          {approver ? 'Approvals & history' : 'History'}
        </button>
      )}
      {msg && dialog !== 'export' && (
        <span className={`atsio-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">
          {msg.text}
          {msg.background && <button type="button" className="atsio-link" onClick={() => { setMsg(null); setDialog('history'); }}>Open</button>}
          <button type="button" className="atsio-x" aria-label="Dismiss" onClick={() => setMsg(null)}>×</button>
        </span>
      )}
      {dialog === 'export' && (
        <Modal
          title="Export"
          onClose={() => setDialog(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={runExport}>
                {busy ? 'Preparing…' : `⬇ Download ${FORMAT_LABEL[format] || format}`}
              </button>
            </>
          )}
        >
          <div className="atsio-exp">
            <div className="atsio-q">1 · Which rows?</div>
            <div className="atsio-choices">
              <button type="button" className={`atsio-choice ${scope === 'view' ? 'on' : ''}`} aria-pressed={scope === 'view'} onClick={() => setScope('view')}>
                <b>This list</b>
                <span>Exactly what I see now — with my search and filters.</span>
              </button>
              <button type="button" className={`atsio-choice ${scope === 'all' ? 'on' : ''}`} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                <b>Everything I can access</b>
                <span>All records I am allowed to see, without filters.</span>
              </button>
            </div>
            <div className="atsio-q">2 · File type</div>
            <div className="atsio-choices">
              {formats.map((f) => (
                <button key={f} type="button" className={`atsio-choice small ${format === f ? 'on' : ''}`} aria-pressed={format === f} onClick={() => setFormat(f)}>
                  <b>{FORMAT_LABEL[f] || f}</b>
                  <span>{FORMAT_HINT[f] || ''}</span>
                </button>
              ))}
            </div>
            <p className="atsio-note">Very big lists (over 10,000 rows) are prepared in the background — the file then appears under History.</p>
            {msg && !msg.ok && <p className="atsio-err">{msg.text}</p>}
            {historyInExport && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog('history')} title="Past imports and exports — undo an import within 24 hours">
                {approver ? 'Approvals & history' : 'History'}
              </button>
            )}
          </div>
        </Modal>
      )}
      {(dialog === 'import' || dialog === 'request') && (
        <AtsImportDialog
          kinds={importKindsForDialog}
          labels={labels}
          info={access.kinds || {}}
          mode={dialog === 'request' ? 'request' : 'direct'}
          undoHours={access.undoHours || 24}
          onClose={() => setDialog(null)}
          onDone={() => { if (onImported) onImported(); }}
        />
      )}
      {dialog && dialog.startsWith('pick:') && (
        <Modal title="Import" onClose={() => setDialog(null)} footer={<button className="btn" onClick={() => setDialog(null)}>Cancel</button>}>
          <div className="atsio-exp">
            <div className="atsio-q">What do you want to add?</div>
            <div className="atsio-choices">
              <button type="button" className="atsio-choice" onClick={() => setDialog(dialog.slice(5))}>
                <b>Bulk upload — Excel list</b>
                <span>Many people at once from an Excel or CSV file.</span>
              </button>
              <button type="button" className="atsio-choice" onClick={() => setDialog('resumes')}>
                <b>Upload resume — resume files</b>
                <span>PDF or Word resumes — we read the details for you.</span>
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'resumes' && (
        <ResumeUploadDialog onClose={() => setDialog(null)} onDone={() => { if (onImported) onImported(); }} />
      )}
      {dialog === 'history' && (
        <AtsIoHistory approver={approver} onClose={() => setDialog(null)} onChanged={() => { if (onImported) onImported(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AtsDataTools — the ONE Template · Import · Export ▾ group every ATS screen
// carries at the top right of its header (hrms-25).
//
//   <AtsDataTools
//     module="requirements"                 // the export (routes/atsIo.js EXPORTS)
//     body={() => ({ params, view, ids })}  // the screen's state at click time
//     kinds={['requirements']}              // import kinds; [] = Export only
//     onImported={load}
//   />
//
// Nothing is decided here. /api/ats-io/access says which buttons this login
// gets (Template and Import together, only with the import permission —
// Manager / Assistant Manager never see them), and every request is checked
// again on the server. Export asks the server for the file: the screen's own
// scoped list, narrowed to the rows it shows — never assembled in the browser.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import ExportMenu from './ExportMenu.jsx';
import AtsImportDialog, { downloadAtsTemplate } from './AtsImportDialog.jsx';
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

// Template: one button, or a small menu when the screen imports two kinds.
function TemplateButton({ kinds, labels }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  async function get(kind) {
    setOpen(false); setBusy(true); setErr('');
    try { await downloadAtsTemplate(kind); } catch { setErr('The template could not be downloaded.'); } finally { setBusy(false); }
  }
  const one = kinds.length === 1;
  return (
    <span className="atsio-tpl" ref={ref}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        title="Download a sample Excel for this screen's import: the right columns, required ones marked *, two example rows and an Instructions sheet"
        onClick={() => (one ? get(kinds[0]) : setOpen((o) => !o))}
      >
        {busy ? 'Downloading…' : 'Template'}{!one && <span aria-hidden="true"> ▾</span>}
      </button>
      {open && (
        <span className="atsio-menu" role="menu">
          {kinds.map((k) => (
            <button key={k} type="button" role="menuitem" className="atsio-item" onClick={() => get(k)}>{labels[k] || k}</button>
          ))}
        </span>
      )}
      {err && <span className="atsio-err" role="status">{err}</span>}
    </span>
  );
}

export default function AtsDataTools({
  module, body, params, kinds = [], onImported, exportLabel = 'Export', formats,
}) {
  const access = useAtsIoAccess();
  const [importing, setImporting] = useState(false);
  if (!access) return null;
  const mayExport = !!(access.exports || {})[module];
  const importKinds = kinds.filter((k) => (access.imports || {})[k]);
  const labels = Object.fromEntries(Object.entries(access.kinds || {}).map(([k, v]) => [k, v.label]));
  if (!mayExport && !importKinds.length) return null;
  return (
    <div className="atsio">
      {importKinds.length > 0 && <TemplateButton kinds={importKinds} labels={labels} />}
      {importKinds.length > 0 && (
        <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>Import</button>
      )}
      {mayExport && (
        <ExportMenu
          url={`/ats-io/export/${module}`}
          params={params}
          body={body}
          label={exportLabel}
          formats={formats}
          note="The rows this screen shows, in your scope."
        />
      )}
      {importing && (
        <AtsImportDialog
          kinds={importKinds}
          labels={labels}
          info={access.kinds || {}}
          onClose={() => setImporting(false)}
          onDone={() => { if (onImported) onImported(); }}
        />
      )}
    </div>
  );
}

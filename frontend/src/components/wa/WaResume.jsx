import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import WaBulkModal from './WaBulkModal.jsx';
import { useWaConfig, waMayUse, WA_ICON } from './waKit.js';
import '../reach/reach.css';
import './wa.css';

// The green "Resume" bar: shown on a list page when the person has an unfinished WhatsApp list of that kind ("3/10 sent").
//   <WaResume entityType="candidate" refreshKey={n} />
export default function WaResume({ entityType, refreshKey }) {
  const cfg = useWaConfig();
  const [s, setS] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    api.get('/wa/bulk/active').then((r) => setS(r.data.session || null)).catch(() => setS(null));
  }, []);
  const may = waMayUse(cfg, entityType);
  useEffect(() => { if (may) load(); }, [may, load, refreshKey]);
  if (!may || !s || s.entityType !== entityType) return null;
  return (
    <>
      <div className="wa-banner" role="status">
        <span aria-hidden="true">{WA_ICON}</span>
        <span>You have an unfinished WhatsApp list: <b>{s.counts.sent}/{s.counts.sent + s.counts.pending} sent</b> ({s.templateName}).</span>
        <button type="button" className="btn btn-sm wa-go" onClick={() => setOpen(true)}>Resume</button>
        <button type="button" className="btn btn-sm" onClick={() => { api.post(`/wa/bulk/${s.id}/discard`).then(load).catch(() => {}); }}>Forget it</button>
      </div>
      {open && createPortal(
        <div className="rch-boost"><WaBulkModal sessionId={s.id} onClose={() => { setOpen(false); load(); }} onDone={load} /></div>,
        document.body,
      )}
    </>
  );
}

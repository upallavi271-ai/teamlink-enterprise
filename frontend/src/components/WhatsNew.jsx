import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal.jsx';

// APP VERSION + RELEASE NOTES (2026-11-18, backend utils/releaseNotes.js, ATS audit Q16): the version in the footer, and a window with what changed.
export default function WhatsNew() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.get('/version').then((r) => setInfo(r.data)).catch(() => setInfo(null)); }, []);
  if (!info) return null;
  return (
    <>
      <button type="button" className="crm-linkbtn" style={{ fontSize: 'inherit', opacity: 0.9 }} onClick={() => setOpen(true)} title="What changed in this version">{`v${info.version} · What's new`}</button>
      {open && (
        <Modal title={`What's new — version ${info.version}`} onClose={() => setOpen(false)} foot={<button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>}>
          {(info.notes || []).map((n) => (
            <div key={n.version} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{`${n.version} · ${n.date} · ${n.title}`}</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>{n.items.map((t) => <li key={t} style={{ margin: '3px 0' }}>{t}</li>)}</ul>
            </div>
          ))}
          <div className="small-muted" style={{ fontSize: 11.5 }}>{`API ${info.apiVersion}: outside systems can call /api/${info.apiVersion}/... and read the version from the X-TeamLink-Version header.`}</div>
        </Modal>
      )}
    </>
  );
}

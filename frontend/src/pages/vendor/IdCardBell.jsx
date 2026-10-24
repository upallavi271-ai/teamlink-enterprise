import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import { when } from './assetPortalCommon.jsx';
import './idCardPortal.css';

// The ID Card Vendor Portal's notices (2026-10-19): the company's own entries in the history of THIS vendor's orders ("order placed ..."),
// with an unread count. Opening one marks it read and shows the request list for that order. Read state is kept per login on the server.
export default function IdCardBell() {
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const box = useRef(null);
  const load = useCallback(() => {
    vendorApi.get('/idcard-portal/notifications').then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the notices.')));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  async function read(ids) {
    try { const r = await vendorApi.post('/idcard-portal/notifications/read', ids ? { ids } : { all: true }); setD(r.data); } catch (e) { setError(vendorError(e, 'Could not save.')); }
  }
  function openOne(n) {
    if (!n.read) read([n.id]);
    setOpen(false);
    navigate(`/vendor/idcard-portal/requests?q=${encodeURIComponent(n.orderCode)}`);
  }
  const unread = d ? d.unread : 0;
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button type="button" className="idc-bell" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} aria-label={unread ? `Notices, ${unread} unread` : 'Notices, none unread'}>
        <span aria-hidden="true">&#128276;</span> Notices{unread > 0 && <span className="idc-count" aria-hidden="true">{unread}</span>}
      </button>
      {open && (
        <div className="idc-pop" role="dialog" aria-label="Notices">
          <div className="vm-row" style={{ justifyContent: 'space-between' }}>
            <strong>Notices</strong>
            {unread > 0 && <button type="button" className="link-btn" onClick={() => read(null)}>Mark all as read</button>}
          </div>
          {error && <div className="notice red"><span>{error}</span></div>}
          {!d ? <div className="idc-skel" style={{ margin: 8 }} /> : !d.rows.length ? <div className="vp-none">No notices yet.</div> : (
            <ul>{d.rows.map((n) => (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <button type="button" className="link-btn" onClick={() => openOne(n)} style={{ textAlign: 'left' }}><strong>{n.title}</strong></button>
                <div>{n.text}</div>
                <div className="cell-muted">{when(n.at)}{n.read ? '' : ' · new'}</div>
              </li>
            ))}</ul>
          )}
        </div>
      )}
    </div>
  );
}

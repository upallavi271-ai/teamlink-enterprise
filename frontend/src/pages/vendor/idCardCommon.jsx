import { useEffect, useState } from 'react';
import vendorApi from '../../vendorApi';
import { initialsOf } from './vendorNav.js';
import './idCardPortal.css';

// Small pieces of the ID Card Vendor Portal (2026-10-19).
export const TONE = { New: 'yellow', Received: 'blue', Printing: 'blue', Ready: 'blue', Delivered: 'green' };
// Status badges always carry the TEXT (never colour alone).
export const StatusTag = ({ status }) => <span className={`vp-tag vp-${TONE[status] || 'grey'}`}>{status}</span>;

// The employee's photo, fetched through the authenticated API (the browser cannot send the token in an <img src>); initials while it loads
// or when there is no photo. One fetch per request id.
const cache = new Map();
function load(id) {
  if (!cache.has(id)) {
    cache.set(id, vendorApi.get(`/idcard-portal/requests/${encodeURIComponent(id)}/photo`, { responseType: 'blob' })
      .then((r) => URL.createObjectURL(r.data)).catch(() => null));
  }
  return cache.get(id);
}
export function Photo({ row, big }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    if (row.hasPhoto) load(row.id).then((u) => { if (live) setSrc(u); });
    return () => { live = false; };
  }, [row.id, row.hasPhoto]);
  return (
    <span className={`idc-ph${big ? ' big' : ''}`} title={row.hasPhoto ? row.name : `${row.name} - no photo on file`} aria-label={`Photo of ${row.name}${src ? '' : ' (not available)'}`} role="img">
      {src ? <img src={src} alt="" /> : initialsOf(row.name)}
    </span>
  );
}

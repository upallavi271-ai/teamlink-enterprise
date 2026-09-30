import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import './EmpMgmtExtras.css';

// ---------------------------------------------------------------------------
// THE SMALL AVATAR in the Employee Management list.
//
// Cheap by construction:
//   * a row with no photo (photoDocId null) never makes a request — initials;
//   * a row with a photo fetches it only once it scrolls into view
//     (IntersectionObserver), at most three at a time, and the blob URL is
//     cached for the session, keyed by the photo document id — so paging back
//     and forth or re-rendering the list never downloads it twice;
//   * GET /employees/management/:id/photo is guarded by Employee Management
//     `view` and the caller's scope, so a failure simply leaves the initials.
// ---------------------------------------------------------------------------
const cache = new Map(); // photoDocId -> objectURL | 'none'
const queue = [];
let active = 0;
const MAX_PARALLEL = 3;

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    active += 1;
    api.get(`/employees/management/${job.employeeId}/photo`, { responseType: 'blob' })
      .then((r) => { const url = URL.createObjectURL(r.data); cache.set(job.photoDocId, url); job.done(url); })
      .catch(() => { cache.set(job.photoDocId, 'none'); job.done(null); })
      .finally(() => { active -= 1; pump(); });
  }
}

export function initialsOf(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export default function EmployeeAvatar({ employeeId, photoDocId, name, size = 28 }) {
  const cached = photoDocId ? cache.get(photoDocId) : 'none';
  const [src, setSrc] = useState(cached && cached !== 'none' ? cached : null);
  const ref = useRef(null);

  useEffect(() => {
    if (!photoDocId) { setSrc(null); return undefined; }
    const hit = cache.get(photoDocId);
    if (hit) { setSrc(hit === 'none' ? null : hit); return undefined; }
    let alive = true;
    const el = ref.current;
    const start = () => {
      if (cache.has(photoDocId)) { const h = cache.get(photoDocId); if (alive) setSrc(h === 'none' ? null : h); return; }
      queue.push({ employeeId, photoDocId, done: (url) => { if (alive) setSrc(url); } });
      pump();
    };
    if (!el || typeof IntersectionObserver === 'undefined') { start(); return () => { alive = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [employeeId, photoDocId]);

  return (
    <span ref={ref} className="emgx-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} title={name}>
      {src ? <img src={src} alt="" /> : initialsOf(name)}
    </span>
  );
}

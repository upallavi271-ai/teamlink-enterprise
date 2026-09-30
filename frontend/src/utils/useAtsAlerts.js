import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import sharedGet from './sharedGet';
import { useAuth } from '../context/AuthContext.jsx';

// ---------------------------------------------------------------------------
// The ATS action alerts behind the 🔔 bell and the floating AI button
// (§21 / §33) — GET /api/dashboard/ats/alerts, scoped on the server.
//
// Re-read on every navigation, when the tab regains focus and once a minute,
// and never cached (§32): an action taken on one screen is reflected the
// moment the user moves to the next. Both consumers mount together, and
// sharedGet folds their identical in-flight reads into one request.
//
// Returns null for a login with no ATS role (the bell then shows only its
// ordinary notifications, the AI button no count).
// ---------------------------------------------------------------------------
export function hasAtsWork(user) {
  return !!(user && user.products && user.products.ats && user.atsRole && user.atsRole !== 'NONE');
}

export default function useAtsAlerts() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [alerts, setAlerts] = useState(null);
  const [tick, setTick] = useState(0);
  const enabled = hasAtsWork(user);

  useEffect(() => {
    if (!enabled) return undefined;
    const bump = () => setTick((t) => t + 1);
    const timer = setInterval(bump, 60000);
    window.addEventListener('focus', bump);
    return () => { clearInterval(timer); window.removeEventListener('focus', bump); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setAlerts(null); return undefined; }
    let alive = true;
    sharedGet('/dashboard/ats/alerts')
      .then((r) => { if (alive) setAlerts(r.data); })
      .catch(() => { if (alive) setAlerts(null); });
    return () => { alive = false; };
  }, [enabled, pathname, tick]);

  return alerts;
}

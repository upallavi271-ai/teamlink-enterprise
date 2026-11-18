// ---------------------------------------------------------------------------
// The "biometric machine is late" notice at the top of the Attendance dashboard (GET /api/attendance/device-notice).
// It is on screen ONLY while the machine is silent or its punches reach TeamLink minutes after the thumb, so that a late punch is
// not mistaken for a missing one ("Not in yet" for someone who has just thumbed). Nothing to click, nothing stored: it asks again
// every minute and goes away by itself once the machine is back to normal.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';

const EVERY_MS = 60 * 1000;

export default function BiometricDelayNotice() {
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let alive = true;
    const ask = () => {
      if (typeof document !== 'undefined' && document.hidden) return; // a hidden tab does not need it
      api.get('/attendance/device-notice')
        .then((res) => { if (alive) setNotice(res.data && res.data.show ? res.data : null); })
        .catch(() => { if (alive) setNotice(null); }); // no answer = no notice, never an error on the page
    };
    ask();
    const t = setInterval(ask, EVERY_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!notice) return null;
  return (
    <div className="notice amber" role="status" style={{ marginBottom: 12 }}>
      <div>
        <strong>{notice.title}</strong>
        <div>{notice.message}</div>
      </div>
    </div>
  );
}

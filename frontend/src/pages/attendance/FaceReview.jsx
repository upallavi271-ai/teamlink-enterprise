import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { to12h } from '../../utils/csv.js';

// ---------------------------------------------------------------------------
// WEB CHECK-IN: today's numbers + the "Face check review" list (inside Attendance > Bio-Metric Logs).
//   "12 web check-ins today - 9 face matched - 3 need a look"
//   Each check-in whose face was not matched / not checked: who, when, how close the face was, a small selfie,
//   the plain reason, and two buttons: Mark OK / Not this person. Nothing here changes pay, late or leave.
// Only HR desk / Admin / Internal HR get the numbers (the server answers 403 to everybody else: nothing is drawn).
// ---------------------------------------------------------------------------

function Thumb({ id }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let alive = true;
    api.get(`/attendance/punches/${id}/image`, { responseType: 'blob' })
      .then((r) => { if (alive) { url = URL.createObjectURL(r.data); setSrc(url); } })
      .catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src
    ? <img src={src} alt="Selfie taken at check-in" style={{ width: 54, height: 40, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
    : <span className="small-muted">No photo</span>;
}

export default function FaceReview() {
  const [sum, setSum] = useState(null);
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    api.get('/attendance/face-summary').then((r) => setSum(r.data)).catch(() => setSum(null));
    api.get('/attendance/face-review').then((r) => setRows(r.data.rows || [])).catch(() => setRows(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function decide(id, decision) {
    setBusyId(id); setMsg('');
    try {
      await api.post(`/attendance/face-review/${id}`, { decision });
      setRows((rs) => (rs || []).filter((r) => r.id !== id));
      setMsg(decision === 'ok' ? 'Saved: marked OK.' : 'Saved: marked as not this person.');
      api.get('/attendance/face-summary').then((r) => setSum(r.data)).catch(() => {});
    } catch (e) { setMsg(e.response?.data?.error || 'Could not save. Try again.'); } finally { setBusyId(''); }
  }

  if (!sum) return null;
  const waiting = rows ? rows.length : sum.waitingForReview;
  return (
    <div className="ci-refused" data-testid="face-review">
      <div className={`notice ${waiting ? 'amber' : ''}`} style={{ display: 'block' }}>
        <b>{sum.webCheckins} web check-in{sum.webCheckins === 1 ? '' : 's'} today</b>
        {sum.webCheckins > 0 && <> — {sum.matched} face matched{sum.notMatched + sum.notChecked > 0 ? `, ${sum.notMatched + sum.notChecked} need a look` : ''}</>}
        {waiting > 0
          ? <> · <button type="button" className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Face check review'} ({waiting} waiting)</button></>
          : <> · No face checks are waiting for you.</>}
        {open && rows && (
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead><tr><th>Employee</th><th>Date</th><th>Time</th><th>Face</th><th>Closeness</th><th>Photo</th><th>Why</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b> <span className="small-muted">{r.employeeCode}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{to12h(r.time)} {r.direction === 'Out' ? '(out)' : '(in)'}</td>
                    <td>{r.status === 'Face not matched' ? 'Not matched' : 'Not checked'}</td>
                    <td>{r.score != null ? `${Math.round(r.score * 100)}%` : '—'}</td>
                    <td>{r.hasSelfie ? <Thumb id={r.id} /> : <span className="small-muted">No photo</span>}</td>
                    <td className="small-muted" style={{ maxWidth: 220 }}>{r.reason}{r.distanceM != null ? ` · ${r.distanceM} m from the office` : ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-sm btn-primary" disabled={busyId === r.id} onClick={() => decide(r.id, 'ok')}>Mark OK</button>{' '}
                      <button type="button" className="btn btn-sm" disabled={busyId === r.id} onClick={() => decide(r.id, 'reject')}>Not this person</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <div className="small-muted" style={{ marginTop: 6 }}>{msg}</div>}
      </div>
    </div>
  );
}

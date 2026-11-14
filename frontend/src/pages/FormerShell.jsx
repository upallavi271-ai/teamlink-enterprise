// THE LIMITED PAGE FOR SOMEONE WHO HAS LEFT (Exited / Relieved) - founder 2026-11-14.
// Their login is not closed for good: it opens to this one page, where they can download their own attendance, their leave
// records, their offer letter and their joining letter. No menu, no other screen: the server refuses every other request
// (backend/src/utils/formerAccess.js), so this page is also all there is to see.
import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';

const dmy = (d) => (d ? `${String(d).slice(8, 10)}-${String(d).slice(5, 7)}-${String(d).slice(0, 4)}` : '—');
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

// The file comes through the API (it needs the sign-in), so it is fetched as a blob and saved from here.
async function readError(err, fallback) {
  try {
    const d = err.response && err.response.data;
    if (d && typeof d.text === 'function') return (JSON.parse(await d.text()).error) || fallback;
    return (d && d.error) || fallback;
  } catch { return fallback; }
}
function nameFrom(res, fallback) {
  const m = /filename="?([^";]+)"?/i.exec(String((res.headers && res.headers['content-disposition']) || ''));
  return m ? m[1] : fallback;
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const card = { background: 'var(--paper-raised, #fff)', border: '1px solid var(--line, #ddd)', borderRadius: 12, padding: 20, marginBottom: 16 };
const h2 = { margin: '0 0 4px', fontSize: 16 };
const sub = { margin: '0 0 14px', color: 'var(--ink-soft, #667)', fontSize: 13, lineHeight: 1.5 };

export default function FormerShell() {
  const { user, logout } = useAuth();
  const f = (user && user.former) || {};
  const [letters, setLetters] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [from, setFrom] = useState(f.dateOfJoining || '');
  const [to, setTo] = useState(f.lastWorkingDate && f.lastWorkingDate < todayIst() ? f.lastWorkingDate : todayIst());

  useEffect(() => {
    api.get('/former/me')
      .then((r) => setLetters(r.data.letters || []))
      .catch(async (e) => { setLetters([]); setError(await readError(e, 'Could not load your letters. Please try again.')); });
  }, []);

  async function download(key, url, params, fallbackName) {
    setBusy(key); setError('');
    try {
      const res = await api.get(url, { params, responseType: 'blob' });
      saveBlob(res.data, nameFrom(res, fallbackName));
    } catch (e) { setError(await readError(e, 'The download did not work. Please try again, or ask HR.')); }
    setBusy('');
  }

  const Btn = ({ k, onClick, children, primary }) => (
    <button type="button" className={`btn${primary ? ' btn-primary' : ''}`} disabled={!!busy} onClick={onClick}>{busy === k ? 'Preparing…' : children}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper, #f4f5f3)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--line, #ddd)', background: 'var(--paper-raised, #fff)' }}>
        <b style={{ fontSize: 16 }}>TeamLink</b>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span>{user.name}{f.employeeCode ? ` · ${f.employeeCode}` : ''}</span>
          <button type="button" className="btn btn-sm" onClick={logout}>Sign out</button>
        </span>
      </header>
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ ...card, background: 'var(--navy-tint, #eef3f7)' }}>
          <h2 style={h2}>Your employment has ended</h2>
          <p style={{ ...sub, margin: 0 }}>
            {f.status ? `Status: ${f.status}. ` : ''}{f.lastWorkingDate ? `Last working day: ${dmy(f.lastWorkingDate)}. ` : ''}
            You can sign in only to download your attendance, your leave records, your offer letter and your joining letter.
            {f.accessUntil ? ` This access runs until ${dmy(f.accessUntil)}.` : ''} For anything else, please contact HR.
          </p>
        </div>

        {error && <div className="notice red" style={{ marginBottom: 16 }}>{error}</div>}

        <section style={card}>
          <h2 style={h2}>Attendance</h2>
          <p style={sub}>Every day from your joining date to your last working day, with check-in and check-out times. You can narrow the dates.</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12 }}>From<br /><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label style={{ fontSize: 12 }}>To<br /><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
            <Btn k="att-x" primary onClick={() => download('att-x', '/former/attendance/export', { from, to, format: 'xlsx' }, 'Attendance.xlsx')}>Download Excel</Btn>
            <Btn k="att-c" onClick={() => download('att-c', '/former/attendance/export', { from, to, format: 'csv' }, 'Attendance.csv')}>Download CSV</Btn>
          </div>
        </section>

        <section style={card}>
          <h2 style={h2}>Leave records</h2>
          <p style={sub}>All your leave requests with the type, dates, days and whether they were approved.</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Btn k="lv-x" primary onClick={() => download('lv-x', '/former/leaves/export', { format: 'xlsx' }, 'Leaves.xlsx')}>Download Excel</Btn>
            <Btn k="lv-c" onClick={() => download('lv-c', '/former/leaves/export', { format: 'csv' }, 'Leaves.csv')}>Download CSV</Btn>
          </div>
        </section>

        <section style={card}>
          <h2 style={h2}>Offer letter and joining letter</h2>
          {letters === null && <p style={sub}>Loading…</p>}
          {letters && !letters.length && <p style={sub}>No offer letter or joining letter is on file for you. Please ask HR.</p>}
          {letters && letters.length > 0 && (
            <div>
              {letters.map((l) => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--line, #ddd)' }}>
                  <span><b>{l.label}</b><br /><span style={{ fontSize: 12, color: 'var(--ink-soft, #667)' }}>{l.fileName}{l.uploadedAt ? ` · added ${dmy(String(l.uploadedAt).slice(0, 10))}` : ''}</span></span>
                  <Btn k={`l-${l.id}`} primary onClick={() => download(`l-${l.id}`, `/former/letters/${l.id}/file`, {}, l.fileName || `${l.label}.pdf`)}>Download</Btn>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

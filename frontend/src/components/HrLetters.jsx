import { useEffect, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// HR letters on an employee's file (2026-11-26): appointment, experience,
// relieving, appraisal and internship letters, filled with the employee's own
// details. HR opens a letter, types the few things the record does not hold,
// previews the PDF and presses Send. Nothing sends by itself, and Send stays
// off until the sending address is set. The server decides who sees this (HR
// desk only: anyone else gets 403 and sees nothing). backend/src/utils/hrLetters.js
// ---------------------------------------------------------------------------

const errorOf = async (err, fallback) => {
  const body = err?.response?.data;
  if (body instanceof Blob) { try { return JSON.parse(await body.text()).error || fallback; } catch { return fallback; } }
  return body?.error || fallback;
};

export default function HrLetters({ employeeId, onSent }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState('');
  const [typed, setTyped] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.get(`/hr-letters/${employeeId}`).then((r) => setData(r.data)).catch(() => setData(null));
  useEffect(() => { setData(null); setOpen(''); setTyped({}); setError(''); setNotice(''); if (employeeId) load(); }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;

  const fieldsOf = (l) => ({ ...l.defaults, ...(typed[l.key] || {}) });
  const set = (key, field, value) => setTyped((t) => ({ ...t, [key]: { ...(t[key] || {}), [field]: value } }));

  async function preview(l) {
    setError(''); setNotice(''); setBusy(`${l.key}:preview`);
    const tab = window.open('', '_blank');
    try {
      const res = await api.post(`/hr-letters/${employeeId}/${l.key}/preview`, { fields: fieldsOf(l) }, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      if (tab) tab.location.href = url;
      else { const a = document.createElement('a'); a.href = url; a.download = `${l.title}.pdf`; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (tab) tab.close();
      setError(await errorOf(err, 'The letter could not be made.'));
    } finally { setBusy(''); }
  }

  async function send(l) {
    // eslint-disable-next-line no-alert
    const address = prompt(`Send the ${l.title} to which email address?\n\n(One address. The one from the record is filled in.)`, l.emailTo || '');
    if (address === null) return;
    const to = address.trim();
    if (!to) { setError('Type the email address the letter should go to.'); return; }
    // eslint-disable-next-line no-alert
    if (!confirm(`Send the ${l.title} to ${to}?\n\nIt goes out as a real email with the PDF attached. Preview it first if you have not.`)) return;
    setError(''); setNotice(''); setBusy(`${l.key}:send`);
    try {
      const res = await api.post(`/hr-letters/${employeeId}/${l.key}/send`, { to, fields: fieldsOf(l) });
      setNotice(res.data?.message || 'The letter was emailed.');
      load();
      if (onSent) onSent();
    } catch (err) {
      setError(await errorOf(err, 'The letter could not be sent.'));
    } finally { setBusy(''); }
  }

  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: '8px 10px' }}>
      <b>HR letters</b>
      <div className="small-muted" style={{ marginBottom: 6 }}>
        Filled from this employee’s record. Preview first; nothing is sent until you press Send.
        {!data.sendOn && <> <b>Sending is switched off</b> until the sending address is set.</>}
      </div>
      {error && <div className="error-text" style={{ marginBottom: 6 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 6 }}>{notice}</div>}
      {data.letters.map((l) => (
        <div key={l.key} style={{ borderTop: '1px solid var(--border, #e5e7eb)', padding: '6px 0' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 220px' }}>
              {l.title}
              {l.why && <div className="small-muted">{l.why}</div>}
              {l.filedAt && <div className="small-muted">A copy was kept in Documents on {new Date(l.filedAt).toLocaleDateString('en-IN')}.</div>}
            </span>
            {!l.why && (
              <button type="button" className="btn btn-sm" aria-expanded={open === l.key} onClick={() => { setOpen(open === l.key ? '' : l.key); setError(''); setNotice(''); }}>
                {open === l.key ? 'Close' : 'Open'}
              </button>
            )}
          </div>
          {!l.why && open === l.key && (
            <div style={{ marginTop: 6 }}>
              {l.fields.map((f) => (
                <label key={f.key} style={{ display: 'block', marginBottom: 6 }}>
                  <span className="small-muted" style={{ display: 'block' }}>{f.label}</span>
                  <input type={f.type} value={fieldsOf(l)[f.key] ?? ''} onChange={(e) => set(l.key, f.key, e.target.value)} style={{ width: '100%', maxWidth: 420 }} />
                </label>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => preview(l)}>{busy === `${l.key}:preview` ? 'Making…' : 'Preview'}</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={!!busy || !data.sendOn} title={data.sendOn ? '' : 'Sending is switched off'} onClick={() => send(l)}>{busy === `${l.key}:send` ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

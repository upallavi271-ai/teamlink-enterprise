import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// PRIVACY (DPDP) on a candidate's profile (backend routes/privacy.js): download everything held about the person, legal hold,
// erase. Super Admin / Admin (HR may download). The server decides every rule; this only asks and shows the answer.
const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole, u && u.accountsRole].filter(Boolean);
export const mayPrivacy = (u) => rolesOf(u).some((r) => ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(r));

export default function PrivacyTools({ c, user, onChanged }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!mayPrivacy(user)) return null;
  const load = () => api.get(`/privacy/candidates/${c.id}`).then((r) => setInfo(r.data)).catch((e) => setMsg({ ok: false, text: e.response?.data?.error || 'Could not load.' }));
  const run = async (fn, ok) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ ok: true, text: ok }); setReason(''); setConfirm(''); await load(); if (onChanged) onChanged(); } catch (e) { setMsg({ ok: false, text: e.response?.data?.error || 'That did not work.' }); } finally { setBusy(false); } };
  const download = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/privacy/candidates/${c.id}/export`, { responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `candidate-data-${c.id}.json`; a.click();
      setMsg({ ok: true, text: 'Downloaded. Send it to the person by email if they asked for their data.' });
    } catch { setMsg({ ok: false, text: 'Could not download.' }); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setOpen(true); setMsg(null); load(); }} title="The person's data: download, legal hold, erase (DPDP)">🔒 Privacy</button>
      {open && (
        <Modal title={`Privacy · ${c.name}`} onClose={() => setOpen(false)}>
          <div className="small-muted" style={{ marginBottom: 10 }}>The person&apos;s rights under the DPDP Act: to see their data, and to have it erased. Everything here is recorded in the audit trail.</div>
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <b>1. Download their data</b>
              <div className="small-muted">Profile, consent, applications and steps, messages, notes, document names, who opened the profile.</div>
              <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy} onClick={download}>⬇ Download (JSON)</button>
            </div>
            {info && info.canErase && (
              <>
                <div>
                  <b>2. Legal hold</b>
                  <div className="small-muted">{info.hold ? `On hold since ${new Date(info.hold.at).toLocaleDateString('en-GB')}: ${info.hold.reason} (by ${info.hold.byName || '—'}). It cannot be erased or deleted.` : 'For a dispute or a legal case: while held, the record cannot be erased or deleted.'}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    {!info.hold && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (the case or dispute)" style={{ maxWidth: 320 }} />}
                    {info.hold
                      ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.delete(`/privacy/candidates/${c.id}/hold`, { data: {} }), 'The hold is released.')}>Release the hold</button>
                      : <button type="button" className="btn btn-sm" disabled={busy || !reason.trim()} onClick={() => run(() => api.post(`/privacy/candidates/${c.id}/hold`, { reason }), 'The record is on legal hold.')}>Place on hold</button>}
                  </div>
                </div>
                <div>
                  <b>3. Erase their data</b>
                  <div className="small-muted">Name, phone, email, birth date, salary, notes, message texts and resume / document files are removed for good. Which job and which step stay, so past counts and invoices still add up. This cannot be undone.</div>
                  {info.erasable.ok ? (
                    <div style={{ display: 'grid', gap: 6, marginTop: 6, maxWidth: 420 }}>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder='Why, e.g. "Asked to be removed, email of 17 Nov"' />
                      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type ERASE to confirm" />
                      <button type="button" className="btn btn-sm btn-danger" disabled={busy || !reason.trim() || confirm !== 'ERASE'} onClick={() => run(() => api.post(`/privacy/candidates/${c.id}/erase`, { reason, confirm }), 'Erased. The profile now shows "Erased candidate".')}>Erase for good</button>
                    </div>
                  ) : <div className="small-muted" style={{ marginTop: 6, color: 'var(--warn, #9a6700)' }}>Not now: {info.erasable.why}</div>}
                </div>
              </>
            )}
          </div>
          {msg && <div className={msg.ok ? 'notice' : 'error-text'} style={{ display: 'block', marginTop: 12 }}>{msg.text}</div>}
        </Modal>
      )}
    </>
  );
}

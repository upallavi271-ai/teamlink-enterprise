import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// ---------------------------------------------------------------------------
// EDIT A CANDIDATE'S PROFILE (founder 2026-10-29: "keep the edit option in candidates profiles page - the edit access is
// only for recruiter & super admin, developer"). The server allows the same people (routes/candidates.js PUT /:id:
// a Recruiter on the people in their own scope, a Super Admin - the Developer Team login is one - on anyone).
//
//   <EditProfileButton c onSaved />   the button + the window; draws nothing for anyone else
// ---------------------------------------------------------------------------

export function mayEditProfile(user) {
  if (!user) return false;
  return [user.role, user.atsRole].includes('SUPER_ADMIN') || user.atsRole === 'RECRUITER';
}

const FIELDS = [
  ['name', 'Full name', 'text', true],
  ['phone', 'Phone', 'tel', true],
  ['email', 'Email', 'email'],
  ['location', 'Current location', 'text'],
  ['preferredLocation', 'Preferred location', 'text'],
  ['currentCompany', 'Current company', 'text'],
  ['currentDesignation', 'Current designation', 'text'],
  ['experienceYears', 'Total experience (years)', 'number'],
  ['relevantExperienceYears', 'Relevant experience (years)', 'number'],
  ['currentSalary', 'Current salary (e.g. 4.5 LPA)', 'text'],
  ['expectedSalary', 'Expected salary (e.g. 6 LPA)', 'text'],
  ['noticePeriod', 'Notice period', 'text'],
  ['education', 'Education', 'text'],
  ['specialization', 'Specialisation', 'text'],
  ['institute', 'Institute', 'text'],
  ['passingYear', 'Passing year', 'text'],
  ['skills', 'Skills (comma separated)', 'text', false, true],
];

const valueOf = (c, k) => (c[k] === null || c[k] === undefined ? '' : String(c[k]));

export function EditProfileButton({ c, user, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dupes, setDupes] = useState(null);
  if (!c || !mayEditProfile(user)) return null;

  const start = () => {
    const f = {};
    FIELDS.forEach(([k]) => { f[k] = valueOf(c, k); });
    setForm(f); setErr(''); setDupes(null); setOpen(true);
  };
  // only what changed goes back: an untouched field is never rewritten
  const changes = () => {
    const out = {};
    FIELDS.forEach(([k, , type]) => {
      const now = String(form[k] ?? '').trim();
      if (now === valueOf(c, k).trim()) return;
      out[k] = type === 'number' ? (now === '' ? null : Number(now)) : now;
    });
    return out;
  };
  async function save(override = false) {
    const body = changes();
    if (!Object.keys(body).length) { setOpen(false); return; }
    if ('name' in body && !body.name) { setErr('The name cannot be empty.'); return; }
    if ('phone' in body && !body.phone) { setErr('The phone number cannot be empty.'); return; }
    setBusy(true); setErr('');
    try {
      await api.put(`/candidates/${c.id}`, override ? { ...body, overrideDuplicate: true } : body);
      setOpen(false);
      if (onSaved) onSaved();
    } catch (e) {
      const d = e.response?.data || {};
      if (d.duplicate) setDupes(d.matches || []);
      setErr(d.error || 'The profile could not be saved. Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="btn" onClick={start} title="Change this person's details">✏️ Edit profile</button>
      {open && (
        <Modal
          title={`Edit profile - ${c.name || ''}`}
          size="wide"
          onClose={() => setOpen(false)}
          foot={(
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              {dupes && dupes.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Save anyway</button>}
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          )}
        >
          {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
          {dupes && dupes.length > 0 && (
            <div className="notice amber" style={{ marginBottom: 8 }}>
              Same phone / email as: {dupes.map((m) => m.name || m.candidateName || m.id).join(', ')}. Check before you press Save anyway.
            </div>
          )}
          <div className="grid-2">
            {FIELDS.map(([k, label, type, required, wide]) => (
              <label key={k} className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
                <span>{label}{required ? ' *' : ''}</span>
                <input
                  type={type}
                  value={form[k] ?? ''}
                  step={type === 'number' ? '0.1' : undefined}
                  min={type === 'number' ? '0' : undefined}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="small-muted" style={{ marginTop: 6 }}>Only the boxes you change are saved. Every change is recorded with your name.</div>
        </Modal>
      )}
    </>
  );
}

export default EditProfileButton;

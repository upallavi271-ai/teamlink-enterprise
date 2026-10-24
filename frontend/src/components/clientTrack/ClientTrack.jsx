// CLIENT HIRING pieces shared by the staff Offers / Joining screens and the client portal (2026-10-13).
// On a CLIENT job the client makes the offer letter and the joining letter; TeamLink shares them.
//   ReleaseLetterModal  upload the client's own letter + a few plain fields (client portal, or the
//                       BDE recording it on the client's behalf, which needs a note)
//   ShareModal          the recruiter's separate buttons: Email / WhatsApp / SMS / Copy the link
//   TrackChip           the one-line status in plain words
//   openLetter          opens a letter file with the login token
import { useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './clientTrack.css';

export function TrackChip({ track }) {
  if (!track || !track.state) return null;
  return <StatusChip status={track.state.label} tone={track.state.tone} />;
}

export async function openLetter(url) {
  const r = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(r.data);
  window.open(href, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

const errOf = (e, d) => e.response?.data?.error || d;

// kind: 'offer' | 'joining'. endpoint: where to POST (multipart). onBehalf: staff recording for the client.
export function ReleaseLetterModal({ kind, endpoint, candidateName, onBehalf, showCtc, onClose, onDone }) {
  const offer = kind === 'offer';
  const [f, setF] = useState({ joiningDate: '', designation: '', location: '', validUntil: '', notes: '', offeredCtc: '', joiningTime: '', place: '', reportingPerson: '', note: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ready = !!file && (offer || !!f.joiningDate) && (!onBehalf || f.note.trim().length > 1);
  async function save() {
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => { if (String(v).trim() !== '') fd.append(k, v); });
      fd.append('file', file);
      const r = await api.post(endpoint, fd);
      onDone(r.data);
    } catch (e) { setErr(errOf(e, 'Could not save the letter. Please try again.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`${onBehalf ? "Record the client's" : 'Release the'} ${offer ? 'offer letter' : 'joining letter'} — ${candidateName}`}
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : (offer ? 'Release offer letter' : 'Release joining letter')}</button>}
    >
      <div className="ctk-form">
        {onBehalf && (
          <label className="ctk-f">
            <b>How did the client send it?</b>
            <input type="text" maxLength={500} placeholder="e.g. Client emailed it on 13 Oct" value={f.note} onChange={set('note')} />
            <span className="ctk-hint">This is saved as &quot;recorded on behalf of the client&quot;.</span>
          </label>
        )}
        <label className="ctk-f">
          <b>{offer ? "The client's offer letter" : "The client's joining letter"}</b>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)} />
          <span className="ctk-hint">A PDF or a photo of the letter, up to 5 MB.</span>
        </label>
        <div className="ctk-two">
          <label className="ctk-f"><b>Joining date</b><input type="date" value={f.joiningDate} onChange={set('joiningDate')} /></label>
          {offer
            ? <label className="ctk-f"><b>Offer valid until</b><input type="date" value={f.validUntil} onChange={set('validUntil')} /></label>
            : <label className="ctk-f"><b>Joining time</b><input type="time" value={f.joiningTime} onChange={set('joiningTime')} /></label>}
        </div>
        {offer ? (
          <div className="ctk-two">
            <label className="ctk-f"><b>Requirement title</b><input type="text" maxLength={120} placeholder="e.g. Lecturer" value={f.designation} onChange={set('designation')} /></label>
            <label className="ctk-f"><b>Place of work</b><input type="text" maxLength={120} value={f.location} onChange={set('location')} /></label>
          </div>
        ) : (
          <div className="ctk-two">
            <label className="ctk-f"><b>Where to come</b><input type="text" maxLength={200} value={f.place} onChange={set('place')} /></label>
            <label className="ctk-f"><b>Who to meet</b><input type="text" maxLength={120} value={f.reportingPerson} onChange={set('reportingPerson')} /></label>
          </div>
        )}
        {offer && showCtc && (
          <label className="ctk-f"><b>Yearly CTC (₹) — optional</b><input type="number" min="1" inputMode="numeric" value={f.offeredCtc} onChange={set('offeredCtc')} /></label>
        )}
        <label className="ctk-f"><b>Note (optional)</b><textarea rows="2" maxLength={1000} value={f.notes} onChange={set('notes')} /></label>
        {err && <div className="error-text">{err}</div>}
      </div>
    </Modal>
  );
}

// The recruiter's share: separate buttons, one thing each.
export function ShareModal({ kind, endpoint, candidateName, onClose, onShared }) {
  const [busy, setBusy] = useState('');
  const [out, setOut] = useState(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  async function go(via) {
    setBusy(via); setErr('');
    try {
      const r = await api.post(endpoint, { via });
      setOut(r.data);
      onShared && onShared(r.data);
    } catch (e) { setErr(errOf(e, 'Could not share. Please try again.')); } finally { setBusy(''); }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(out.text || out.url); setCopied(true); } catch { setCopied(false); }
  };
  const word = kind === 'offer' ? 'offer' : 'joining letter';
  return (
    <Modal title={`Share the ${word} with ${candidateName}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="ctk-form">
        <div className="ctk-hint">Pick one. The candidate gets a link to open the client&apos;s letter{kind === 'offer' ? ', then presses Accept or Decline' : ', then presses Confirm joining'}.</div>
        <div className="ctk-buttons">
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => go('Email')}>{busy === 'Email' ? 'Sending…' : 'Email it'}</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => go('WhatsApp')}>{busy === 'WhatsApp' ? 'Sending…' : 'WhatsApp it'}</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => go('SMS')}>{busy === 'SMS' ? 'Sending…' : 'SMS it'}</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => go('Link')}>{busy === 'Link' ? 'Making…' : 'Copy the candidate link'}</button>
        </div>
        {err && <div className="error-text">{err}</div>}
        {out && (
          <div className="ctk-result">
            <div><b>{out.message}</b></div>
            <textarea readOnly rows="4" value={out.text || out.url || ''} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

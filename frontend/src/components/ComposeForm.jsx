// ---------------------------------------------------------------------------
// The compose-form layout every Employee Services and Performance &
// Development create form now shares — modelled on the Announcement form:
//
//   Title *
//   [✨ AI Assist]
//   Body *
//   Category / other fields
//   Send to            (AudiencePicker, where the form goes to people)
//   Also deliver via   (DeliverVia, where a notification goes out)
//   ☐ Pin to top       (CheckLine)
//   [Primary]  [Cancel]
//
// Labelled fields stacked, required marks, primary + Cancel at the bottom.
// ComposeModal wraps it in the app's modal; ComposeCard is the same form on
// the page (for the screens whose create form sits inline).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../api';
import Modal from './Modal.jsx';
import './AudiencePicker.css';

export function Field({ label, required = false, hint, children, style }) {
  return (
    <div className="field" style={style}>
      {label && <label>{label}{required && <span className="compose-req"> *</span>}</label>}
      {children}
      {hint && <div className="compose-hint">{hint}</div>}
    </div>
  );
}

export function Row({ children }) {
  return <div className="compose-row">{children}</div>;
}

export function CheckLine({ checked, onChange, children }) {
  return (
    <label className="compose-check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

// ✨ AI Assist — drafts the field from the title, or polishes what is
// already typed, through the app's one AI wrapper (POST /api/audience/assist
// -> backend/src/utils/ai.js). It fills the box for the person to edit; it
// never saves anything. When the model is not running it says so.
export function AiAssist({ kind, title, text, onText }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  async function run() {
    setNote('');
    if (!String(title || '').trim() && !String(text || '').trim()) {
      setNote('Type a title or a few words first.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post('/audience/assist', { kind, title, text });
      onText(res.data.text);
      setNote(text ? 'Polished — review before sending.' : 'Drafted — review before sending.');
    } catch (err) {
      setNote(err.response?.data?.error || 'AI Assist is not available right now.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="compose-ai">
      <button type="button" className="btn btn-sm" onClick={run} disabled={busy}>
        {busy ? 'Working…' : '✨ AI Assist'}
      </button>
      {note && <span className="small-muted">{note}</span>}
    </div>
  );
}

function Actions({ submitLabel, busy, busyLabel = 'Saving…', disabled, onCancel }) {
  return (
    <div className="compose-actions">
      <button type="submit" className="btn btn-primary" disabled={busy || disabled}>{busy ? busyLabel : submitLabel}</button>
      {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

// The modal form. `onSubmit` is called on the primary button (and Enter in a
// single-line input); it owns validation and the request.
export function ComposeModal({
  title, onClose, onSubmit, submitLabel = 'Save', busy = false, busyLabel, disabled = false, error, wide = false, children, note,
}) {
  return (
    <Modal title={title} note={note} size={wide ? 'wide' : undefined} onClose={onClose}>
      <form className="compose-form" onSubmit={(e) => { e.preventDefault(); onSubmit(); }} noValidate>
        {children}
        {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
        <Actions submitLabel={submitLabel} busy={busy} busyLabel={busyLabel} disabled={disabled} onCancel={onClose} />
      </form>
    </Modal>
  );
}

// The same form, inline on the page (a card) rather than in a modal.
export function ComposeCard({
  title, onSubmit, onCancel, submitLabel = 'Save', busy = false, disabled = false, error, children,
}) {
  return (
    <form className="card section compose-form" onSubmit={(e) => { e.preventDefault(); onSubmit(); }} noValidate>
      {title && <h3 style={{ marginBottom: 12 }}>{title}</h3>}
      {children}
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      <Actions submitLabel={submitLabel} busy={busy} disabled={disabled} onCancel={onCancel} />
    </form>
  );
}

// "Sent to 37 employees · In-app: 37 · Email: 30 queued · SMS: recorded, not sent"
export function ResultNote({ children }) {
  if (!children) return null;
  return <div className="compose-result">{children}</div>;
}

// Shared submit helper: one busy flag + one error string per form.
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn, fallback = 'Could not save.') {
    setError('');
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      setError(err.response?.data?.error || fallback);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

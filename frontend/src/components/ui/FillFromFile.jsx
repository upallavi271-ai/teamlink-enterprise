// ---------------------------------------------------------------------------
// FILL FROM A FILE (2026-10-06) — the ONE entry screen shared by Add job,
// Add candidate and Add client.
//
//   <FillEntryModal>   two big choices: "Upload the …" / "Type it myself".
//                      Upload = drop a PDF / Word / TXT / picture, or paste the
//                      e-mail text → "Reading the file…" → the form opens
//                      with the found fields in light green ("Found in the
//                      file") and the empty required ones in orange ("Not
//                      found: fill in"). The person checks, edits, saves as
//                      today. The file stays attached to the saved record.
//
//   useFillFromFile(target)  the little state machine each form holds:
//       entry: 'choose' | 'upload' | 'form'
//       cls(name) / tag(name)    the green / orange marks for a field
//       apply(result)            after a successful read
//       attach(target, id)       POST the kept file to the saved record
//       reset()                  "Start over"
//
// Server: POST /api/doc-fill/:target (utils/docFill.js — rules first, the AI
// engine only when its switch + the Role Catalog gate allow). Nothing is
// invented: a value is either in the document or the field stays empty.
// ---------------------------------------------------------------------------
import { useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './fillFromFile.css';

export const ACCEPT = '.pdf,.docx,.doc,.txt,.jpg,.jpeg,.png';
export const MAX_MB = 10;
const OK_EXT = /\.(pdf|docx|doc|txt|jpe?g|png)$/i;

const LABELS = {
  job: {
    uploadTitle: 'Upload the requirement', uploadHint: 'The client sent a JD, an e-mail or a photo? We read it and fill the form.',
    typeTitle: 'Type it myself', typeHint: 'Fill the job form by hand, as before.',
    what: 'the requirement', pasteHint: 'Paste the e-mail or message the client sent',
  },
  candidate: {
    uploadTitle: 'Upload the resume', uploadHint: 'We read the resume and fill in name, phone, email, skills and experience.',
    typeTitle: 'Type it myself', typeHint: 'Fill the candidate form by hand, as before.',
    what: 'the resume', pasteHint: 'Paste the resume text or the e-mail the person sent',
  },
  client: {
    uploadTitle: 'Upload client details', uploadHint: 'A company profile, an e-mail, an old agreement or a visiting card photo.',
    typeTitle: 'Type it myself', typeHint: 'Fill the client form by hand, as before.',
    what: 'the client details', pasteHint: 'Paste the e-mail or the company details',
  },
};
export const labelsFor = (target) => LABELS[target] || LABELS.job;

export function TwoChoice({ target, onUpload, onType }) {
  const l = labelsFor(target);
  return (
    <div className="ff-choices">
      <button type="button" className="ff-choice ff-choice-upload" onClick={onUpload} autoFocus>
        <span className="ff-choice-icon" aria-hidden="true">⬆</span>
        <b>{l.uploadTitle}</b>
        <small>{l.uploadHint}</small>
        <span className="ff-choice-types">PDF · Word · TXT · JPG / PNG · pasted text</span>
      </button>
      <button type="button" className="ff-choice" onClick={onType}>
        <span className="ff-choice-icon" aria-hidden="true">✎</span>
        <b>{l.typeTitle}</b>
        <small>{l.typeHint}</small>
      </button>
    </div>
  );
}

// The drop zone + paste box. Calls onFilled(result) with the server's answer
// plus the File (kept in memory until the record is saved).
export default function FillFromFile({ target, onFilled, onBack }) {
  const l = labelsFor(target);
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  function pick(f) {
    setError('');
    if (!f) return;
    if (!OK_EXT.test(f.name)) { setError('Only PDF, Word (DOCX / DOC), TXT, JPG or PNG files can be read.'); return; }
    if (f.size > MAX_MB * 1024 * 1024) { setError(`That file is larger than ${MAX_MB} MB. Please upload a smaller one.`); return; }
    setFile(f);
  }

  async function read() {
    if (busy) return;
    if (!file && !text.trim()) { setError('Choose a file, or paste the text.'); return; }
    setBusy(true); setError('');
    try {
      let r;
      if (file) {
        const fd = new FormData();
        fd.append('file', file, file.name);
        if (text.trim()) fd.append('text', text);
        r = await api.post(`/doc-fill/${target}`, fd);
      } else {
        r = await api.post(`/doc-fill/${target}`, { text });
      }
      onFilled({ ...r.data, file: file || null, text: file ? '' : text });
    } catch (e) {
      const d = e.response?.data || {};
      setError(d.error || 'The file could not be read. Please try again, or paste the text.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ff">
      <div
        className={`ff-drop${over ? ' over' : ''}${file ? ' has' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      >
        <input ref={inputRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        {file ? (
          <>
            <b className="ff-drop-file">{file.name}</b>
            <small>{`${Math.max(1, Math.round(file.size / 1024))} KB · tap to choose another file`}</small>
          </>
        ) : (
          <>
            <b>{`Tap to choose ${l.what}`}</b>
            <small>{`or drop the file here · PDF, Word, TXT, JPG / PNG · up to ${MAX_MB} MB`}</small>
          </>
        )}
      </div>
      <div className="ff-or">or</div>
      <label className="field ff-paste">
        <span>{l.pasteHint}</span>
        <textarea rows="5" value={text} placeholder="Paste the text here…" onChange={(e) => { setText(e.target.value); setError(''); }} />
      </label>
      <div className="ff-note">We only copy what is written in the file. Anything missing stays empty for you to fill in. Pictures need the AI engine.</div>
      {error && <div className="notice red" role="alert"><span>{error}</span></div>}
      <div className="ff-actions">
        {onBack && <button type="button" className="btn" disabled={busy} onClick={onBack}>← Back</button>}
        <button type="button" className="btn btn-primary ff-read" disabled={busy || (!file && !text.trim())} onClick={read}>
          {busy ? 'Reading the file…' : (file ? 'Read the file' : 'Read the text')}
        </button>
      </div>
    </div>
  );
}

// The banner at the top of a form that was filled from a file.
export function FillBanner({ fill, names = {} }) {
  const s = fill.state;
  if (!s) return null;
  const n = s.found.size;
  const miss = [...s.missing].map((k) => names[k] || k);
  return (
    <div className="ff-banner" role="status">
      <div className="ff-banner-main">
        <b>{`Filled ${n} of ${s.total} fields from ${s.fileName || 'the pasted text'}.`}</b>
        {' '}
        <span className="ff-legend"><i className="ok" /> Found in the file</span>
        <span className="ff-legend"><i className="no" /> Not found — please fill in</span>
      </div>
      {miss.length > 0 && <div className="ff-banner-miss">{`Still to fill: ${miss.join(', ')}.`}</div>}
      {s.warnings.map((w) => <div key={w} className="ff-banner-warn">{w}</div>)}
      <div className="ff-banner-foot">
        <span className="small-muted">{`Read by: ${s.engine === 'rule' ? 'rules (nothing left this server)' : 'rules + AI'}.`}{s.aiNote ? ` ${s.aiNote}` : ''} Check every field before you save.</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={fill.reset}>Start over</button>
      </div>
    </div>
  );
}

// One modal that shows the two choices, then the upload screen. The owner
// renders its ordinary form once fill.entry === 'form'.
export function FillEntryModal({ title, target, fill, onClose, onFilled, size = 'xwide' }) {
  const l = labelsFor(target);
  return (
    <Modal title={title} size={size} onClose={onClose}>
      {fill.entry === 'choose' ? (
        <>
          <div className="ff-ask">How do you want to add it?</div>
          <TwoChoice target={target} onUpload={() => fill.setEntry('upload')} onType={() => fill.setEntry('form')} />
        </>
      ) : (
        <>
          <div className="ff-ask">{l.uploadTitle}</div>
          <FillFromFile target={target} onBack={() => fill.setEntry('choose')} onFilled={(r) => { fill.apply(r); onFilled?.(r); }} />
        </>
      )}
    </Modal>
  );
}

export function useFillFromFile(target, { enabled = true } = {}) {
  const [entry, setEntry] = useState(enabled ? 'choose' : 'form');
  const [state, setState] = useState(null);
  const cls = (name) => (state ? (state.found.has(name) ? ' ff-found' : state.missing.has(name) ? ' ff-missing' : '') : '');
  const tag = (name) => {
    if (!state) return null;
    if (state.found.has(name)) return <span className="ff-tag ok">Found in the file</span>;
    if (state.missing.has(name)) return <span className="ff-tag no">Not found: fill in</span>;
    return null;
  };
  const apply = (r) => {
    setState({
      found: new Set(r.found || []), missing: new Set(r.missing || []), total: r.total || (r.found || []).length,
      fileName: r.fileName || (r.file && r.file.name) || null, file: r.file || null, engine: r.engine || 'rule', aiNote: r.aiNote || null,
      warnings: r.warnings || [], fields: r.fields || {},
    });
    setEntry('form');
  };
  const reset = () => { setState(null); setEntry(enabled ? 'choose' : 'form'); };
  // Keeps the file on the saved record. Returns a note for the "Saved" line
  // ('' when there was nothing to attach).
  const attach = async (t, id) => {
    if (!state || !state.file || !id) return '';
    const fd = new FormData();
    fd.append('file', state.file, state.file.name);
    fd.append('engine', state.engine || 'rule');
    fd.append('fieldsFound', JSON.stringify([...state.found]));
    try {
      await api.post(`/doc-fill/attach/${t}/${id}`, fd);
      return `${state.file.name} is kept as the source document.`;
    } catch (e) {
      return e.response?.data?.error || `Saved, but ${state.file.name} could not be kept as the source document.`;
    }
  };
  return {
    entry, setEntry, state, cls, tag, apply, reset, attach, file: state ? state.file : null, target,
  };
}

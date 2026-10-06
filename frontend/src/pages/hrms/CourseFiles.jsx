import { useRef } from 'react';
import api from '../../api';
import './CourseFiles.css';

// ---------------------------------------------------------------------------
// COURSE FILES — the "Add document" / "Add video" picker used by the New
// Course form (files are queued, then uploaded once the course exists) and by
// the course's Materials panel (uploaded straight away).
//
// The types and sizes here MIRROR backend/src/utils/lmsMedia.js, which is the
// real gate: it checks the extension AND the declared type, reads the first
// bytes of the file, stores it under a random server-made name and refuses
// anything over the cap with a 413. This side only says no earlier, in the
// same words, so nobody waits for a 300 MB upload that was never going to fit.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
export const LIMITS = {
  Video: { max: 300 * MB, ext: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] },
  Document: { max: 25 * MB, ext: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'png', 'jpg', 'jpeg', 'webp'] },
};
export const LIMITS_TEXT = 'Videos: MP4, WebM or MOV, up to 300 MB. Documents: PDF, Word, PowerPoint, Excel or text, up to 25 MB.';

const ACCEPT = {
  Video: '.mp4,.webm,.mov,.m4v,.ogv,video/mp4,video/webm,video/quicktime',
  Document: '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.webp',
};

const extOf = (name) => {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
};

export function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

// '' when the file may go up as this kind, or the reason it may not.
export function checkFile(file, kind) {
  const ext = extOf(file.name);
  const other = kind === 'Video' ? 'Document' : 'Video';
  if (!LIMITS[kind].ext.includes(ext)) {
    if (LIMITS[other].ext.includes(ext)) {
      return kind === 'Video' ? 'This is a document, not a video — use "Add document".' : 'This is a video — use "Add video".';
    }
    return kind === 'Video'
      ? 'This kind of video can\'t be added. Use MP4, WebM or MOV.'
      : 'This kind of file can\'t be added. Use PDF, Word, PowerPoint, Excel or text.';
  }
  if (!file.size) return 'This file is empty.';
  if (file.size > LIMITS[kind].max) {
    return kind === 'Video' ? 'This video is bigger than 300 MB.' : 'This document is bigger than 25 MB.';
  }
  return '';
}

// Uploads one file against a course. STREAMED: the request body is the file
// itself, so a long video is written to disk as it arrives. Resolves to the
// material, or rejects with a human sentence.
export async function uploadMaterial(courseId, { file, kind, required = true }, onPct) {
  try {
    const res = await api.post(`/lms/courses/${courseId}/materials`, file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      params: { title: file.name.replace(/\.[^.]+$/, '') || file.name, kind, required },
      onUploadProgress: (p) => { if (onPct && p.total) onPct(Math.round((p.loaded / p.total) * 100)); },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error;
    if (msg) throw new Error(msg);
    if (status === 413) throw new Error(kind === 'Video' ? 'This video is bigger than 300 MB.' : 'This document is bigger than 25 MB.');
    if (status === 403) throw new Error('You are not allowed to add files to this course.');
    throw new Error('The upload stopped before it finished. Check your internet and try again.');
  }
}

let seq = 0;
// A picked file as the list holds it.
export function newItem(file, kind) {
  seq += 1;
  const error = checkFile(file, kind);
  return { key: `f${seq}`, file, kind, status: error ? 'failed' : 'waiting', pct: 0, error };
}

const STATUS_TEXT = { waiting: 'Ready', uploading: 'Uploading', done: 'Added', failed: 'Not added' };

// Two plain buttons and the list of picked files. `onPick(items)` gets the new
// items; `onRemove(key)` drops one (only offered while it is not uploading).
export default function CourseFilesPicker({ items, onPick, onRemove, disabled, hint = true, buttons = true }) {
  const docRef = useRef(null);
  const vidRef = useRef(null);

  function picked(e, kind) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // the same file can be picked again after a remove
    if (files.length) onPick(files.map((f) => newItem(f, kind)));
  }

  return (
    <div className="cfiles">
      {buttons && (
        <div className="cfiles-btns">
          <button type="button" className="btn" disabled={disabled} onClick={() => docRef.current?.click()}>
            <span aria-hidden="true">📄</span> Add document
          </button>
          <button type="button" className="btn" disabled={disabled} onClick={() => vidRef.current?.click()}>
            <span aria-hidden="true">🎬</span> Add video
          </button>
          <input ref={docRef} type="file" multiple hidden accept={ACCEPT.Document} onChange={(e) => picked(e, 'Document')} />
          <input ref={vidRef} type="file" multiple hidden accept={ACCEPT.Video} onChange={(e) => picked(e, 'Video')} />
        </div>
      )}
      {hint && <div className="cfiles-hint">{LIMITS_TEXT}</div>}
      {items.length > 0 && (
        <ul className="cfiles-list">
          {items.map((it) => (
            <li key={it.key} className={`cfiles-item is-${it.status}`}>
              <span className="cfiles-icon" aria-hidden="true">{it.kind === 'Video' ? '🎬' : '📄'}</span>
              <span className="cfiles-name">
                <span className="cfiles-file">{it.file.name}</span>
                <span className="cfiles-meta">
                  {fmtSize(it.file.size)}
                  {' · '}
                  <b className="cfiles-state">{it.status === 'uploading' ? `Uploading ${it.pct}%` : STATUS_TEXT[it.status]}</b>
                  {it.error ? <> — {it.error}</> : null}
                </span>
                {it.status === 'uploading' && (
                  <span className="cfiles-bar" aria-hidden="true"><span style={{ width: `${it.pct}%` }} /></span>
                )}
              </span>
              {it.status !== 'uploading' && it.status !== 'done' && onRemove && (
                <button type="button" className="cfiles-x" aria-label={`Remove ${it.file.name}`} title="Remove" onClick={() => onRemove(it.key)}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

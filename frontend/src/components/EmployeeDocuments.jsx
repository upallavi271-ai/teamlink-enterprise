import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import api from '../api';
import './EmployeeDocuments.css';

// ---------------------------------------------------------------------------
// Documents on an employee's file — Aadhaar, PAN, certificates, joining
// paperwork — as many as the person has, several of one type if need be.
//
// ONE component, ONE look, for every door (user, 2026-09-29: "documents must
// NOT be a separate form — they are part of the employee form, for every
// role"):
//   * Add Employee (pages/Employees.jsx) — DRAFT mode: no employee exists yet,
//     so files are held in the browser. The page creates the employee and then
//     calls ref.uploadAll(newId); each file shows its own progress / result
//     and a failed one keeps a Retry. The employee exists either way.
//   * HR's full Edit form (pages/EmployeeDetail.jsx) and the employee's own
//     profile form (pages/hrms/MyProfile.jsx) — `embedded`: drawn as a section
//     INSIDE the form (no <form> of its own, so nothing nests), and the page's
//     Save / Submit uploads anything still waiting via ref.uploadAll().
//   * Read-only views (the Employee Management drawer, the record view for a
//     view-only Manager) — the same list with only View / Download.
//
// It draws what the SERVER says this caller may do (`canUpload`, and
// `canDelete` per row) rather than deciding for itself, so a button is on
// screen exactly when the API would accept the call behind it. A caller the
// server refuses outright (403) sees no section at all. See
// routes/employees.js, EMPLOYEE DOCUMENTS, for the rules.
//
// Files are fetched through the authenticated API and handed to the browser
// as a blob — the upload directory is private and has no public URL. Nothing
// typed here is a number: Aadhaar / PAN copies are stored as files exactly as
// the existing upload does, and the Aadhaar NUMBER stays on its own field
// (last four digits only).
// ---------------------------------------------------------------------------

const OTHER = 'Other Documents';
const PHOTO = 'Photo';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Mirrors utils/attachments.js so the common mistakes are caught before the
// bytes cross the wire. The server checks again, including the file's content.
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
const DEFAULT_ALLOWED = ['application/pdf', ...IMAGE_TYPES];
const DEFAULT_MAX = 5 * 1024 * 1024;

function sizeLabel(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

let seq = 0;
const nextKey = () => { seq += 1; return `p${Date.now()}-${seq}`; };

// `employeeId`  null = draft (Add Employee); `meta` then supplies the types.
// `meta`        { docTypes, requiredTypes, maxBytes, allowedTypes } — draft only.
// `embedded`    a section inside a parent form instead of its own card.
// `readOnly`    never offer upload / delete, whatever the server allows.
// `onChange`    called with the number of files waiting to be uploaded.
// `uploadOnSave` the parent form's Save / Submit sends the waiting files
//              (ref.uploadAll), so no per-file Upload button is drawn — only
//              Retry on a file that failed. `saveLabel` names that button.
const EmployeeDocuments = forwardRef(function EmployeeDocuments({
  employeeId = null, meta = null, intro = null, lockedNote = null, embedded = false, readOnly = false, onChange = null,
  uploadOnSave = false, saveLabel = 'Save changes',
}, ref) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState('');
  // The employee the files go to. Set by uploadAll(id) in draft mode, so a
  // Retry after Add Employee still knows where to send the file.
  const [target, setTarget] = useState(employeeId);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => { if (employeeId) setTarget(employeeId); }, [employeeId]);
  useEffect(() => { if (onChange) onChange(pending.filter((p) => p.status !== 'done').length); }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  function load(id = target) {
    if (!id) return;
    api.get(`/employees/${id}/documents`)
      .then((res) => { setData(res.data); setForbidden(false); })
      .catch((err) => {
        if (err.response?.status === 403) { setForbidden(true); setData(null); return; }
        setData((d) => d || { documents: [], docTypes: [], canUpload: false });
        setError(err.response?.data?.error || 'Could not load the documents.');
      });
  }
  useEffect(() => { load(target); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = !target;
  const docTypes = (data?.docTypes?.length ? data.docTypes : meta?.docTypes) || [];
  const required = new Set((data?.requiredTypes || meta?.requiredTypes || []));
  const allowed = data?.allowedTypes || meta?.allowedTypes || DEFAULT_ALLOWED;
  const maxBytes = data?.maxBytes || meta?.maxBytes || DEFAULT_MAX;
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  // Before the list has loaded (Add Employee, the moment after create) the
  // draft's `meta` stands in, so the waiting files stay on screen.
  const canUpload = !readOnly && (data ? !!data.canUpload : !!meta);
  const docs = data?.documents || [];

  // Why this file cannot go, or '' when it can.
  function problem(item) {
    if (!item.file) return 'Choose a file.';
    if (item.docType === PHOTO && !IMAGE_TYPES.includes(item.file.type)) return 'A photo must be a JPEG, PNG or WebP image.';
    if (!allowed.includes(item.file.type)) return 'Only PDF, PNG, JPEG and WebP files can be uploaded.';
    if (item.file.size > maxBytes) return `Larger than ${maxMb}MB.`;
    if (item.docType === OTHER && !String(item.docName || '').trim()) return 'Name this document (type is Other Documents).';
    return '';
  }

  function patch(key, change) {
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  }

  function pick(docType, fileList) {
    setError(''); setNotice('');
    const added = [...(fileList || [])].map((file) => ({
      key: nextKey(), docType, docName: '', file, status: 'ready', progress: 0, error: '',
    }));
    setPending((list) => [...list, ...added]);
  }

  // One file to one employee. Resolves true on success.
  async function uploadOne(item, id) {
    const why = problem(item);
    if (why) { patch(item.key, { status: 'failed', error: why }); return false; }
    patch(item.key, { status: 'uploading', progress: 0, error: '' });
    try {
      const body = new FormData();
      body.append('docType', item.docType);
      body.append('docName', String(item.docName || '').trim());
      body.append('file', item.file);
      // No explicit Content-Type: the browser has to set the multipart boundary.
      await api.post(`/employees/${id}/documents`, body, {
        onUploadProgress: (e) => {
          if (e.total) patch(item.key, { progress: Math.round((e.loaded / e.total) * 100) });
        },
      });
      patch(item.key, { status: 'done', progress: 100 });
      return true;
    } catch (err) {
      patch(item.key, {
        status: 'failed',
        error: err.response?.status === 403
          ? "Uploading documents to this record isn't included in your role's permissions."
          : (err.response?.data?.error || 'Upload failed.'),
      });
      return false;
    }
  }

  // Uploaded files leave the waiting list once the list on file shows them.
  function settle(id) {
    setPending((list) => list.filter((p) => p.status !== 'done'));
    load(id);
  }

  async function uploadAll(id = target) {
    const queue = pendingRef.current.filter((p) => p.status !== 'done' && p.status !== 'uploading');
    if (!id || !queue.length) return { total: 0, ok: 0, failed: 0 };
    if (id !== target) setTarget(id);
    let ok = 0;
    // One after another — the server scans each file, and a list of results
    // in order is easier to read than a race.
    for (const item of queue) {
      // eslint-disable-next-line no-await-in-loop
      if (await uploadOne(item, id)) ok += 1;
    }
    settle(id);
    return { total: queue.length, ok, failed: queue.length - ok };
  }

  async function retry(item) {
    if (await uploadOne(item, target)) settle(target);
  }

  useImperativeHandle(ref, () => ({
    uploadAll,
    // '' when every waiting file can be sent, else the first reason it can't.
    validate() {
      const bad = pendingRef.current.filter((p) => p.status !== 'done').map((p) => [p, problem(p)]).find(([, why]) => why);
      return bad ? `${bad[0].docType === OTHER ? OTHER : bad[0].docType} — ${bad[0].file?.name || 'file'}: ${bad[1]}` : '';
    },
    pendingCount: () => pendingRef.current.filter((p) => p.status !== 'done').length,
  }));

  // View opens the file in a new tab; Download saves it. Both go through the
  // API, which checks access on every request.
  async function openFile(doc, disposition) {
    setError('');
    // Opened synchronously, inside the click, so a popup blocker lets it
    // through; the blob is pointed at it once it has arrived.
    const tab = disposition === 'inline' ? window.open('', '_blank') : null;
    try {
      const res = await api.get(`/employees/${target}/documents/${doc.id}/file`, {
        params: { disposition }, responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      if (tab) {
        tab.location.href = url;
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      if (tab) tab.close();
      setError('Could not open that file.');
    }
  }

  async function remove(doc) {
    // eslint-disable-next-line no-alert
    if (!confirm(`Delete "${doc.docType === OTHER ? doc.docName : doc.docType}" (${doc.fileName})? This can't be undone.`)) return;
    setError(''); setNotice(''); setBusy(doc.id);
    try {
      await api.delete(`/employees/${target}/documents/${doc.id}`);
      setNotice('Document deleted.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'That document could not be deleted.');
    } finally { setBusy(''); }
  }

  if (forbidden && !pending.length) return null;

  // Every type on the company list, plus any legacy type a document on file
  // still carries, so nothing on file is ever hidden.
  const rows = [...docTypes, ...[...new Set(docs.map((d) => d.docType))].filter((t) => !docTypes.includes(t))];
  const waiting = pending.filter((p) => p.status !== 'done');

  const statusOf = (p) => {
    if (p.status === 'uploading') return <span className="edocs-st up">Uploading… {p.progress}%</span>;
    if (p.status === 'done') return <span className="edocs-st ok">Uploaded</span>;
    if (p.status === 'failed') return <span className="edocs-st bad">{p.error || 'Failed'}</span>;
    const why = problem(p);
    if (why) return <span className="edocs-st bad">{why}</span>;
    return (
      <span className="edocs-st wait">
        {draft ? 'Uploads when the employee is created' : uploadOnSave ? `Uploads when you press ${saveLabel}` : 'Not uploaded yet'}
      </span>
    );
  };

  return (
    <div className={`edocs${embedded ? ' edocs-embedded' : ' card section'}`}>
      <h3 style={embedded ? { marginTop: 14 } : undefined}>
        Documents {data ? `(${docs.length})` : ''}
        {waiting.length > 0 && <span className="edocs-count">{waiting.length} waiting</span>}
      </h3>
      {intro && <div className="small-muted" style={{ marginBottom: 8 }}>{intro}</div>}
      {canUpload && lockedNote && <div className="small-muted" style={{ marginBottom: 8 }}>{lockedNote}</div>}
      {canUpload && (
        <div className="small-muted" style={{ marginBottom: 8 }}>
          PDF, PNG, JPEG or WebP, up to {maxMb}MB each.
          {required.size > 0 && <> <b className="edocs-req">✱</b> = required.</>}
        </div>
      )}
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 8 }}>{notice}</div>}

      {!draft && data === null && !meta && !forbidden ? <div className="small-muted">Loading…</div> : (
        <div className="edocs-list">
          {rows.map((type) => {
            const onFile = docs.filter((d) => d.docType === type);
            const mine = pending.filter((p) => p.docType === type);
            if (!canUpload && !onFile.length && !mine.length) return null;
            return (
              <div className="edocs-row" key={type}>
                <div className="edocs-type">
                  <b>{type}</b>{required.has(type) && <b className="edocs-req" title="Required"> ✱</b>}
                  {type === PHOTO && <div className="cell-muted">Profile photo — images only</div>}
                </div>
                <div className="edocs-files">
                  {onFile.map((d) => (
                    <div className="edocs-file" key={d.id}>
                      <div className="edocs-name">
                        <span className="edocs-fn">{type === OTHER ? (d.docName || OTHER) : d.fileName}</span>
                        <span className="cell-muted">
                          {type === OTHER ? `${d.fileName} · ` : (d.docName ? `${d.docName} · ` : '')}
                          {sizeLabel(d.size)} · {new Date(d.uploadedAt).toLocaleDateString('en-GB')}
                          {d.uploadedByName ? ` · ${d.uploadedByName}` : ''}
                        </span>
                      </div>
                      <div className="edocs-acts">
                        <button type="button" className="btn btn-sm" onClick={() => openFile(d, 'inline')}>View</button>
                        <button type="button" className="btn btn-sm" onClick={() => openFile(d, 'attachment')}>Download</button>
                        {!readOnly && d.canDelete && (
                          <button type="button" className="btn btn-sm btn-ghost" disabled={busy === d.id} onClick={() => remove(d)}>
                            {busy === d.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {mine.map((p) => (
                    <div className={`edocs-file edocs-pending ${p.status}`} key={p.key}>
                      <div className="edocs-name">
                        <span className="edocs-fn">{p.file?.name}</span>
                        <span className="cell-muted">{sizeLabel(p.file?.size)}</span>
                        {p.status === 'uploading' && (
                          <span className="edocs-bar"><span style={{ width: `${p.progress}%` }} /></span>
                        )}
                        {statusOf(p)}
                      </div>
                      {p.status !== 'done' && (
                        <div className="edocs-acts">
                          <input
                            className="edocs-dn"
                            value={p.docName}
                            maxLength={120}
                            disabled={p.status === 'uploading'}
                            placeholder={type === OTHER ? 'Document name *' : 'Name (optional)'}
                            onChange={(e) => patch(p.key, { docName: e.target.value, ...(p.status === 'failed' ? { status: 'ready', error: '' } : {}) })}
                            // Inside the employee form: Enter must not submit it.
                            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                          />
                          {!draft && !uploadOnSave && p.status === 'ready' && (
                            <button type="button" className="btn btn-sm btn-primary" disabled={!!problem(p)} onClick={() => retry(p)}>Upload</button>
                          )}
                          {!draft && p.status === 'failed' && (
                            <button type="button" className="btn btn-sm btn-primary" onClick={() => retry(p)}>Retry</button>
                          )}
                          {p.status !== 'uploading' && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              title="Remove this file"
                              onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
                            >Remove</button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {!onFile.length && !mine.length && <div className="cell-muted edocs-none">Not uploaded</div>}
                </div>
                {canUpload && (
                  <label className="btn btn-sm edocs-pick">
                    + Add file
                    <input
                      type="file"
                      multiple
                      accept={type === PHOTO ? IMAGE_ACCEPT : ACCEPT}
                      onChange={(e) => { pick(type, e.target.files); e.target.value = ''; }}
                    />
                  </label>
                )}
              </div>
            );
          })}
          {!canUpload && docs.length === 0 && <div className="small-muted edocs-none">No documents uploaded yet.</div>}
        </div>
      )}
    </div>
  );
});

export default EmployeeDocuments;

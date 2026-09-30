import { useEffect, useRef, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// THE EMPLOYEE'S PHOTO, on their details form.
//
// Stored as an employee document of type "Photo" (routes/employees.js), so it
// rides the same permission-checked upload as every other document and HR
// sees it on the record. The newest Photo is the one shown. JPEG, PNG or
// WebP, up to the upload limit. It sits inside the profile <form>, so it uses
// a plain button and a hidden file input — never a nested form.
// ---------------------------------------------------------------------------
const PHOTO = 'Photo';
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export default function EmployeePhoto({ employeeId, name, canChange = true }) {
  const [src, setSrc] = useState('');
  const [canUpload, setCanUpload] = useState(false);
  const [maxBytes, setMaxBytes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);

  async function load() {
    try {
      const r = await api.get(`/employees/${employeeId}/documents`);
      setCanUpload(!!r.data.canUpload);
      setMaxBytes(r.data.maxBytes || 0);
      const photos = (r.data.documents || []).filter((d) => d.docType === PHOTO)
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
      if (!photos.length) { setSrc(''); return; }
      const file = await api.get(`/employees/${employeeId}/documents/${photos[0].id}/file`, { responseType: 'blob' });
      setSrc((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file.data); });
    } catch {
      setSrc('');
    }
  }
  useEffect(() => { if (employeeId) load(); }, [employeeId]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function upload(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (!TYPES.includes(file.type)) { setError('Choose a JPEG, PNG or WebP image.'); return; }
    if (maxBytes && file.size > maxBytes) { setError(`That photo is larger than ${Math.round(maxBytes / (1024 * 1024))}MB.`); return; }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('docType', PHOTO);
      body.append('docName', 'Profile photo');
      body.append('file', file);
      await api.post(`/employees/${employeeId}/documents`, body);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload the photo.');
    } finally { setBusy(false); }
  }

  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return (
    <div className="emp-photo">
      <div className="emp-photo-img">
        {src ? <img src={src} alt={`${name || 'Employee'} photo`} /> : <span>{initials}</span>}
      </div>
      <div>
        <div className="k" style={{ fontWeight: 600, fontSize: 12.5 }}>Photo</div>
        <div className="small-muted" style={{ fontSize: 11.5 }}>JPEG, PNG or WebP — a clear, front-facing photo.</div>
        {canChange && canUpload && (
          <>
            <input ref={input} type="file" accept={TYPES.join(',')} onChange={upload} style={{ display: 'none' }} />
            <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy} onClick={() => input.current && input.current.click()}>
              {busy ? 'Uploading…' : src ? 'Change photo' : 'Upload photo'}
            </button>
          </>
        )}
        {error && <div className="error-text" style={{ marginTop: 4 }}>{error}</div>}
      </div>
    </div>
  );
}

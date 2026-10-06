// ---------------------------------------------------------------------------
// "Source document" card (2026-10-06): the file a job / client was filled
// from (GET /api/doc-fill/source/:target/:id). Shown only when there is one;
// Download is audited on the server.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './fillFromFile.css';

export default function SourceDocuments({ target, id, version }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!id) return undefined;
    let on = true;
    api.get(`/doc-fill/source/${target}/${id}`)
      .then((r) => { if (on) setRows(r.data.rows || []); })
      .catch(() => { if (on) setRows([]); });
    return () => { on = false; };
  }, [target, id, version]);
  if (!rows.length) return null;
  async function download(d) {
    setErr('');
    try {
      const res = await api.get(`/doc-fill/source/${target}/${id}/${d.id}/file`, { params: { download: 1 }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = d.fileName || 'source-document'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setErr(e.response?.data?.error || 'Could not download the file.'); }
  }
  return (
    <div className="card section">
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Source document</h3>
      <div className="small-muted" style={{ marginBottom: 6 }}>The file this record was filled from.</div>
      <ul className="ff-src">
        {rows.map((d) => (
          <li key={d.id}>
            <span className="ff-src-name">{d.fileName}</span>
            <span className="small-muted">{`${d.size ? `${Math.max(1, Math.round(d.size / 1024))} KB · ` : ''}${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString('en-GB') : ''}${d.uploadedByName ? ` · ${d.uploadedByName}` : ''}${d.fieldsFound?.length ? ` · filled ${d.fieldsFound.length} field${d.fieldsFound.length === 1 ? '' : 's'}` : ''}`}</span>
            <button type="button" className="btn btn-sm" onClick={() => download(d)}>Download</button>
          </li>
        ))}
      </ul>
      {err && <div className="error-text" role="alert">{err}</div>}
    </div>
  );
}

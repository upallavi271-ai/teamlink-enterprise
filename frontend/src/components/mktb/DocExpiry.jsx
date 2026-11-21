import { useState } from 'react';
import api from '../../api';
import {
  M, Card, Flash, useGet, useRun,
} from './kit.jsx';

// DOCUMENTS WITH EXPIRY (market wave B 03.18): on the candidate's Documents tab - an expiry date per document (a passport, a
// registration, a visa). Expired / expiring in 30 days are marked; the expiring list is in Candidates > Hiring tools > Records,
// and the owner recruiter's bell 30 days before needs the Admin switch (off by default).
export default function DocExpiry({ candidateId, mayEdit = true }) {
  const d = useGet(`${M}/candidates/${candidateId}/doc-expiry`);
  const [vals, setVals] = useState({});
  const { busy, msg, run } = useRun();
  const rows = (d.data && d.data.rows) || [];
  if (!rows.length) return null;
  return (
    <Card title="Document expiry dates" testid="mkb-doc-expiry" note="Add the date a document stops being valid. Expired and soon-to-expire documents are marked here and on the expiring list.">
      <ul className="mkb-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="mkb-grow"><b>{r.name}</b> <span className="small-muted">{r.docType}</span></span>
            {r.state && <span className={`mkb-chip ${r.state === 'Valid' ? 'good' : r.state === 'Expired' ? 'bad' : 'new'}`}>{r.state}</span>}
            <input type="date" value={vals[r.id] !== undefined ? vals[r.id] : (r.expiresOn || '')} disabled={!mayEdit} aria-label={`Expiry of ${r.name}`} onChange={(e) => setVals({ ...vals, [r.id]: e.target.value })} />
            {mayEdit && vals[r.id] !== undefined && vals[r.id] !== (r.expiresOn || '') && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`${M}/documents/${r.id}/expiry`, { expiresOn: vals[r.id] || null }), 'Saved.').then((x) => { if (x) { setVals({ ...vals, [r.id]: undefined }); d.reload(); } })}>Save</button>
            )}
          </li>
        ))}
      </ul>
      <Flash msg={msg} />
    </Card>
  );
}

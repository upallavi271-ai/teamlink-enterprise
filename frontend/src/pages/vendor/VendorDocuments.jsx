import { useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell, { openVendorFile } from './VendorShell.jsx';

// /vendor/documents - the files the company has shared with THIS vendor. Each
// opens through a short-lived signed link (the server re-checks that the file
// is yours when you press Open and again when the link is used).
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(s); return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function VendorDocuments() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    vendorApi.get('/documents').then((r) => setRows(r.data.rows)).catch((e) => setError(vendorError(e, 'Could not load your documents.')));
  }, []);
  async function open(d) {
    setError('');
    try { await openVendorFile({ kind: 'shared', id: d.id }); } catch (e) { setError(vendorError(e, 'Could not open the file.')); }
  }
  return (
    <VendorShell title="Documents for you" sub="Files the company has shared with you, like agreements and payment advice.">
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {!rows ? <div className="empty-mini">Loading…</div> : !rows.length ? (
        <div className="vp-empty"><h3>Nothing shared with you yet</h3><p>When the company shares a document with you, it shows here.</p></div>
      ) : (
        <div className="tbl-wrap vp-table">
          <table>
            <thead><tr><th>Document</th><th>Type</th><th>File</th><th>Shared on</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong>{d.note && <div className="cell-muted">{d.note}</div>}</td>
                  <td>{d.docType}</td>
                  <td>{d.name} <span className="cell-muted">· {size(d.size)}</span></td>
                  <td>{day(d.createdAt)}</td>
                  <td><button type="button" className="btn btn-sm btn-primary" onClick={() => open(d)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </VendorShell>
  );
}

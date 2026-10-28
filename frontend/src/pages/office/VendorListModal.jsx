// "Vendors" — Office & Expenses → Expenses & Bills, for Admin and the Accountant: every vendor in the vendor master,
// a search box, and Edit on each row (the Add Vendor form, filled in; PATCH /office-expenses/vendors/:id).
// Switching a vendor off and vendor logins stay in Admin → Vendor Logins.
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import AddVendorModal from './AddVendorModal.jsx';

export default function VendorListModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);

  const load = () => api.get('/office-expenses/vendors').then((r) => setRows(r.data)).catch((e) => setErr(e.response?.data?.error || 'The vendors could not be loaded.'));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || []).filter((v) => !t || [v.vendorCode, v.name, v.companyName, v.gstin, v.pan, v.phone, v.email, v.category, v.contactPerson].some((x) => String(x || '').toLowerCase().includes(t)));
  }, [rows, q]);

  return (
    <>
      <Modal size="xwide" title="Vendors" note={rows ? `${shown.length} of ${rows.length}` : null} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
        {err && <div className="notice red"><span>{err}</span></div>}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, GSTIN, phone, category…" style={{ width: '100%', marginBottom: 10 }} aria-label="Search vendors" />
        {!rows && !err && <div className="small-muted">Loading…</div>}
        {rows && (
          <div className="tbl-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>Code</th><th>Vendor</th><th>GSTIN</th><th>PAN</th><th>Contact</th><th>Phone</th><th>Category</th><th>Payment terms</th><th /></tr></thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.id}>
                    <td className="small-muted">{v.vendorCode || '—'}</td>
                    <td><b>{v.name}</b>{v.companyName && v.companyName !== v.name && <div className="small-muted">{v.companyName}</div>}</td>
                    <td>{v.gstin || '—'}</td>
                    <td>{v.pan || '—'}</td>
                    <td>{v.contactPerson || '—'}{v.email && <div className="small-muted">{v.email}</div>}</td>
                    <td>{v.phone || '—'}</td>
                    <td>{v.category || '—'}</td>
                    <td>{v.paymentTerms || '—'}</td>
                    <td><button type="button" className="btn btn-sm" onClick={() => setEdit(v)}>Edit</button></td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan="9" className="empty">{rows.length ? 'No vendor matches this search.' : 'No vendors yet. Use + Add Vendor.'}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
      {edit && (
        <AddVendorModal
          vendor={edit}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </>
  );
}

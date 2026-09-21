import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin } from '../../permissions';


export default function Documents() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  const [documents, setDocuments] = useState([]);
  const [form, setForm] = useState({ title: '', category: 'Policy', mandatory: true, target: 'All Employees', uploadedDate: new Date().toISOString().slice(0, 10) });

  function load() {
    api.get('/documents').then((res) => setDocuments(res.data));
  }
  useEffect(load, []);

  async function publish(e) {
    e.preventDefault();
    await api.post('/documents', form);
    setForm({ ...form, title: '' });
    load();
  }

  async function acknowledge(id) {
    await api.post(`/documents/${id}/acknowledge`);
    load();
  }

  async function toggleVisibility(id) {
    await api.put(`/documents/${id}/visibility`);
    load();
  }

  async function remove(id) {
    if (!confirm('Delete this document?')) return;
    await api.delete(`/documents/${id}`);
    load();
  }

  return (
    <div>
      <div className="page-head"><h1>Documents</h1></div>

      {isHR && (
        <form className="card section" onSubmit={publish}>
          <h3>Publish document</h3>
          <div className="grid-2">
            <label className="field"><span>Title</span><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field">
              <span>Category</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option>Policy</option>
                <option>Compliance</option>
              </select>
            </label>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Publish</button>
        </form>
      )}

      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Title</th><th>Category</th><th>Mandatory</th><th>Target</th><th>Uploaded by</th><th>Date</th><th>Acknowledged</th><th></th></tr></thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.category}</td>
                <td>{d.mandatory ? 'Yes' : 'No'}</td>
                <td>{d.target}</td>
                <td>{d.uploadedBy || '—'}</td>
                <td>{d.uploadedDate}</td>
                <td>{d.acknowledgments.length} of {d.totalEmployees}</td>
                <td>
                  {!isHR && <button className="btn btn-sm" onClick={() => acknowledge(d.id)}>Acknowledge</button>}
                  {isHR && (
                    <>
                      <button className="btn btn-sm" onClick={() => toggleVisibility(d.id)}>{d.published ? 'Hide from Employees' : 'Publish'}</button>{' '}
                      <button className="btn btn-sm" onClick={() => remove(d.id)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {documents.length === 0 && <tr><td colSpan="8" className="small-muted">No documents yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

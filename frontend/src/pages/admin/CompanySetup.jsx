import { useEffect, useState } from 'react';
import api from '../../api';
import PasswordAlertSetting from '../../components/PasswordAlertSetting.jsx';

// Company Setup — the prototype's companySetupView() (line 9693), field for
// field: a two-column screen with Company Information and Employment Policies
// on the left, Departments, Working Locations and Teams on the right.

export default function CompanySetup() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', hq: '', address: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function apply(res) {
    setData(res);
    setForm({
      name: res.name || '', email: res.email || '', phone: res.phone || '',
      hq: res.hq || '', address: res.address || '',
    });
  }

  useEffect(() => {
    api.get('/admin/company').then((res) => apply(res.data)).catch(() => setError('Could not load the company profile.'));
  }, []);

  async function save() {
    setError(''); setNotice('');
    try {
      const res = await api.put('/admin/company', form);
      apply(res.data);
      setNotice('Company information saved.');
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  if (!data) return <div className="page-head"><h1>Company Setup</h1></div>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div>
      <div className="page-head">
        <div><h1>Company Setup</h1>
          <div className="page-sub">Company profile, departments, locations and working teams</div></div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 12 }}>{notice}</div>}

      <div className="two-col">
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>Company Information</h3>
            <div className="grid-2">
              <div className="field"><label>Company Name</label>
                <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} /></div>
              <div className="field"><label>Contact Email</label>
                <input type="text" value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
              <div className="field"><label>Contact Phone</label>
                <input type="text" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
              <div className="field"><label>Headquarters</label>
                <input type="text" value={form.hq} onChange={(e) => set({ hq: e.target.value })} /></div>
            </div>
            <div className="field"><label>Address</label>
              <textarea rows="2" value={form.address} onChange={(e) => set({ address: e.target.value })} /></div>
            <button className="btn btn-primary btn-sm" onClick={save}>Save Company Info</button>
          </div>
          <PasswordAlertSetting />
          <div className="card">
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Employment Policies</h3>
            {data.policies.map((p) => (
              <div className="kv" key={p}><span className="k">{p}</span><span className="status active">Active</span></div>
            ))}
          </div>
        </div>
        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Departments</h3>
            {data.departments.map((d) => <span className="skillpill" key={d}>{d}</span>)}
            <div className="small-muted" style={{ marginTop: 8 }}>
              Departments are shared across HRMS and ATS requirement creation.
            </div>
          </div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Working Locations</h3>
            {data.locations.map((l) => <span className="skillpill" key={l}>{l}</span>)}
          </div>
          <div className="card">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Teams</h3>
            {/* Real teams from the Departments & Teams admin, not a fixed list. */}
            {data.teams.map((t) => (
              <div className="kv" key={`${t.department}/${t.name}`}>
                <span className="k">{t.name}</span><span>{t.department}</span>
              </div>
            ))}
            {data.teams.length === 0 && <div className="empty-mini">No teams yet — add them under Departments &amp; Teams.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

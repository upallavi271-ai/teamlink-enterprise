import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { workRoleLabel } from '../../permissions';

// Profile — the prototype's adminProfileView() (line 10593) is a single card
// with Name and Role. Main's editable form is kept below it: changing your own
// name and password is real here, and the prototype has no equivalent.

export default function Profile() {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setError(''); setSaved(false);
    try {
      const payload = { name };
      if (password) payload.password = password;
      await api.put('/auth/me', payload);
      setPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'That change could not be saved.');
    }
  }

  return (
    <div>
      <div className="page-head"><div><h1>Profile</h1></div></div>

      <div className="card">
        <div className="kv"><span className="k">Name</span><span>{user?.name}</span></div>
        <div className="kv"><span className="k">Role</span><span>{workRoleLabel(user)}</span></div>
        <div className="kv"><span className="k">Employee profile</span>
          <span>
            <Link to="/my-profile">Open your employee profile</Link>
            <span className="small-muted" style={{ marginLeft: 8 }}>
              Personal, bank and document details, and the review lifecycle.
            </span>
          </span>
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 18 }}>Edit your account</div>
      <form className="card section" onSubmit={save} style={{ maxWidth: 380 }}>
        {error && <div className="error-text">{error}</div>}
        <div className="field"><label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Email</label>
          <input value={user?.email || ''} disabled /></div>
        <div className="field"><label>New password (optional)</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} type="submit">Save</button>
        {saved && <span className="small-muted" style={{ marginLeft: 10 }}>Saved.</span>}
      </form>
    </div>
  );
}

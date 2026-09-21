import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';

export default function JobDetail() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [status, setStatus] = useState('idle'); // idle | submitting | done | error
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/public/jobs/${id}`).then((res) => setJob(res.data)).catch(() => setNotFound(true));
  }, [id]);

  async function apply(e) {
    e.preventDefault();
    setStatus('submitting');
    setError('');
    try {
      await api.post(`/public/jobs/${id}/apply`, form);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err.response?.data?.error || 'Could not submit application');
    }
  }

  if (notFound) return <div className="careers-shell"><main className="careers-content"><p>Job not found or no longer open.</p><Link to="/careers/classic">← Back to openings</Link></main></div>;
  if (!job) return <div className="careers-shell"><main className="careers-content" /></div>;

  return (
    <div className="careers-shell">
      <header className="careers-header">
        <div className="logo-lockup">
          <div className="mark">TL</div>
          <div>
            <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
            <div className="small-muted">Careers</div>
          </div>
        </div>
      </header>
      <main className="careers-content">
        <Link className="small-muted" to="/careers/classic">← Back to openings</Link>
        <h1 style={{ marginTop: 10 }}>{job.title}</h1>
        <div className="small-muted">{job.client} · {job.location || 'Location TBD'}</div>
        {job.description && <p>{job.description}</p>}

        <div className="card section" style={{ maxWidth: 420, marginTop: 20 }}>
          <h3>Apply for this role</h3>
          {status === 'done' ? (
            <div className="small-muted">Thanks — your application has been received. Our recruiting team will be in touch.</div>
          ) : (
            <form onSubmit={apply}>
              <label className="field"><span>Full name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field" style={{ marginTop: 8 }}><span>Email</span><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              <label className="field" style={{ marginTop: 8 }}><span>Phone</span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
              {error && <div className="error-text">{error}</div>}
              <button className="btn btn-primary" style={{ marginTop: 12 }} type="submit" disabled={status === 'submitting'}>
                {status === 'submitting' ? 'Submitting…' : 'Submit application'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

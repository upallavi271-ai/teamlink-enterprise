// ---------------------------------------------------------------------------
// ADMIN → FIT SETTINGS (fit_). Backend: GET/PUT /api/candidate-resumes/fit-settings.
// How much each thing counts in the Overall Fit %, and the usual minimum Fit
// for "Eligible" (each job can still set its own on the job page).
// Points are scaled to 100% automatically, so they do not have to add up.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './ResumePanel.css';
// B8: Match by meaning + scoring versions.
import { SemanticCard, VersionsCard } from '../match/FitSettingsExtras.jsx';

const ORDER = ['mand', 'good', 'exp', 'relev', 'edu', 'loc', 'sal', 'notice', 'mode', 'emp', 'jp', 'avail'];

export default function FitSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api.get('/candidate-resumes/fit-settings')
      .then((res) => { setData(res.data); setForm({ weights: { ...res.data.weights }, defaultMinFit: res.data.defaultMinFit, specBonus: res.data.specBonus, semantic: { ...(res.data.semantic || { on: false, weight: 5, engine: 'local' }) } }); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the Fit settings. Please try again.'));
  }
  useEffect(() => { load(); }, []);

  if (!data || !form) {
    return <div className="page"><div className="card section small-muted">{error || 'Loading…'}</div></div>;
  }
  const total = ORDER.reduce((s, k) => s + (Number(form.weights[k]) || 0), 0);
  const edit = data.canEdit;

  async function save(next) {
    setBusy(true); setError(''); setFlash('');
    try {
      const res = await api.put('/candidate-resumes/fit-settings', next);
      setFlash(`✓ ${res.data.message || 'Saved.'}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save. Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <div className="page fit-settings">
      <div className="page-head">
        <div>
          <h1>Fit settings</h1>
          <div className="small-muted">How much each thing counts in a person&apos;s Fit % for a job.</div>
        </div>
      </div>
      {!data.ready && <div className="notice amber">These settings are being set up. The usual weights are in use.</div>}
      {!edit && data.ready && <div className="notice">Only an Admin can change these.</div>}
      {flash && <div className="notice rsm-ok">{flash}</div>}
      {error && <div className="notice red">{error}</div>}
      <div className="card section">
        <div className="fit-grid">
          {ORDER.map((k) => (
            <label key={k} className="fit-row">
              <span className="fit-name">{data.labels[k] || k}</span>
              <input
                type="number"
                min="0"
                max="100"
                disabled={!edit}
                value={form.weights[k]}
                onChange={(e) => setForm({ ...form, weights: { ...form.weights, [k]: e.target.value } })}
              />
              <span className="fit-share small-muted">{total > 0 ? `${Math.round(((Number(form.weights[k]) || 0) / total) * 100)}%` : '—'}</span>
            </label>
          ))}
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>{`Total ${total} points. They are scaled to 100% automatically.`}</div>
        <label className="fit-row fit-min">
          <span className="fit-name"><b>Usual minimum Fit for “Eligible”</b></span>
          <input type="number" min="0" max="100" disabled={!edit} value={form.defaultMinFit} onChange={(e) => setForm({ ...form, defaultMinFit: e.target.value })} />
          <span className="fit-share small-muted">%</span>
        </label>
        <div className="small-muted">A job can set its own minimum on its “Good fit” list.</div>
        <label className="fit-row fit-min">
          <span className="fit-name"><b>Extra points for the same specialisation</b></span>
          <input type="number" min="0" max="50" disabled={!edit} value={form.specBonus ?? ''} onChange={(e) => setForm({ ...form, specBonus: e.target.value })} />
          <span className="fit-share small-muted">pts</span>
        </label>
        <div className="small-muted">Added to Overall when the job and the person have the same specialisation (for example both Dermatology). Most is 100%.</div>
        {edit && (
          <div className="rsm-foot">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(form)}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => save({ ...data.defaults, semantic: form.semantic })}>Back to the usual weights</button>
          </div>
        )}
        <div className="small-muted" style={{ marginTop: 8 }}>
          {'Scoring version now: '}
          <b>{data.versionLabel || 'v2'}</b>
          {'. Changing a weight, the specialisation points or “Match by meaning” starts a new version; Fits saved before keep their own.'}
        </div>
        {data.meta && data.meta.updatedByName && (
          <div className="small-muted" style={{ marginTop: 8 }}>{`Last changed by ${data.meta.updatedByName} · ${new Date(data.meta.updatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</div>
        )}
      </div>
      <SemanticCard data={data} form={form} setForm={setForm} edit={edit} busy={busy} onSave={() => save(form)} onReload={load} />
      <VersionsCard data={data} />
    </div>
  );
}

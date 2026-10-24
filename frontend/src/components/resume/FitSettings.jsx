// ---------------------------------------------------------------------------
// ADMIN → FIT SETTINGS (fit_). Backend: GET/PUT /api/candidate-resumes/fit-settings.
// How much each thing counts in the Overall Fit %, and the usual minimum Fit
// for "Eligible" (each job can still set its own on the job page).
// Points are scaled to 100% automatically, so they do not have to add up.
//
// 2026-10-13: ONE table by the four parts a person sees (Resume · AI · Location ·
// Salary, plus the small things), each with its share of the Fit; Salary is a real
// part (left out, never zero, when it is not known); the AI interview score can be
// given points (0 = shown beside the Fit, not counted).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import './ResumePanel.css';
// B8: Match by meaning + scoring versions.
import { SemanticCard, VersionsCard } from '../match/FitSettingsExtras.jsx';

const ORDER = ['mand', 'good', 'exp', 'relev', 'edu', 'loc', 'sal', 'notice', 'mode', 'emp', 'jp', 'avail', 'ai'];
// Used only if the server did not send the groups (it does: data.groups / data.groupKeys).
const FALLBACK_GROUPS = [
  { key: 'resume', label: 'Resume', icon: '📄', help: 'Skills, experience and education against the requirement.' },
  { key: 'ai', label: 'AI interview', icon: '🤖', help: 'Counted only for people who have an AI interview score. 0 = shown beside the Fit, not counted.' },
  { key: 'location', label: 'Location', icon: '📍', help: 'Same city, preferred city, nearby city.' },
  { key: 'salary', label: 'Salary', icon: '₹', help: 'What the person wants against the client budget.' },
  { key: 'other', label: 'Other small things', icon: '•', help: 'Work mode, requirement type, notice period, availability.' },
];
const FALLBACK_KEYS = {
  resume: ['mand', 'good', 'exp', 'relev', 'edu'], ai: ['ai'], location: ['loc'], salary: ['sal'], other: ['mode', 'emp', 'notice', 'jp', 'avail'],
};

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
  const groups = data.groups && data.groups.length ? data.groups : FALLBACK_GROUPS;
  const groupKeys = data.groupKeys || FALLBACK_KEYS;
  const pct = (n) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');
  const setW = (k, v) => setForm({ ...form, weights: { ...form.weights, [k]: v } });

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
          <div className="small-muted">How much each thing counts in a person&apos;s Fit % for a requirement.</div>
        </div>
      </div>
      {!data.ready && <div className="notice amber">These settings are being set up. The usual weights are in use.</div>}
      {!edit && data.ready && <div className="notice">Only an Admin can change these.</div>}
      {flash && <div className="notice rsm-ok">{flash}</div>}
      {error && <div className="notice red">{error}</div>}
      <div className="card section">
        <h3 style={{ fontSize: 14, margin: '0 0 2px' }}>How much each part counts</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>
          A person&apos;s Fit % is made of these parts. Give a part more points and it counts more. The points are turned into % for you, so they do not have to add up to 100.
        </div>
        <div className="tbl-wrap">
          <table className="fit-table" data-testid="fit-weights-table" style={{ width: '100%' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Part</th><th>Points</th><th>Counts for</th></tr></thead>
            <tbody>
              {groups.map((g) => {
                const keys = groupKeys[g.key] || [];
                const gp = keys.reduce((s, k) => s + (Number(form.weights[k]) || 0), 0);
                const single = keys.length === 1;
                return [
                  <tr key={g.key} className="fit-grouprow">
                    <td>
                      <b>{`${g.icon} ${g.label}`}</b>
                      <div className="small-muted" style={{ fontSize: 12 }}>{g.help}</div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {single
                        ? <input type="number" min="0" max="100" aria-label={`${g.label} points`} disabled={!edit} value={form.weights[keys[0]]} onChange={(e) => setW(keys[0], e.target.value)} style={{ width: 70 }} />
                        : <b>{gp}</b>}
                    </td>
                    <td style={{ textAlign: 'center' }}><b>{pct(gp)}</b></td>
                  </tr>,
                  ...(single ? [] : keys.map((k) => (
                    <tr key={k} className="fit-subrow">
                      <td style={{ paddingLeft: 22 }}>{data.labels[k] || k}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="number" min="0" max="100" aria-label={`${data.labels[k] || k} points`} disabled={!edit} value={form.weights[k]} onChange={(e) => setW(k, e.target.value)} style={{ width: 70 }} />
                      </td>
                      <td className="small-muted" style={{ textAlign: 'center' }}>{pct(Number(form.weights[k]) || 0)}</td>
                    </tr>
                  ))),
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>{`Total ${total} points. They are scaled to 100% automatically.`}</div>
        <div className="notice" style={{ margin: '10px 0 0' }}>
          <b>Salary in plain words.</b>
          {' '}
          The pay a person wants is checked against the client&apos;s budget for the requirement: inside the budget is 100, above it counts down. If we do not know the salary (nothing written, or something like &quot;as per norms&quot;) or the client has not given a budget, Salary is left out and the other parts count a little more, so nobody is marked down for what we do not know.
          {' '}
          The AI interview score is counted only if you give it points; at 0 it is shown next to the Fit and not counted.
        </div>
        <label className="fit-row fit-min">
          <span className="fit-name"><b>Usual minimum Fit for “Eligible”</b></span>
          <input type="number" min="0" max="100" disabled={!edit} value={form.defaultMinFit} onChange={(e) => setForm({ ...form, defaultMinFit: e.target.value })} />
          <span className="fit-share small-muted">%</span>
        </label>
        <div className="small-muted">A requirement can set its own minimum on its “Good fit” list.</div>
        <label className="fit-row fit-min">
          <span className="fit-name"><b>Extra points for the same specialisation</b></span>
          <input type="number" min="0" max="50" disabled={!edit} value={form.specBonus ?? ''} onChange={(e) => setForm({ ...form, specBonus: e.target.value })} />
          <span className="fit-share small-muted">pts</span>
        </label>
        <div className="small-muted">Added to Overall when the requirement and the person have the same specialisation (for example both Dermatology). Most is 100%.</div>
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

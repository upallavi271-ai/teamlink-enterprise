import R3Settings from '../../components/ats/R3Settings.jsx'; // desk rule, client approval, renewal / overdue reminders, payment approval switches
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import { DEFAULT_STAGE_LABELS } from '../../atsVocab';
import { loadStageLabels } from '../../utils/stageLabels';
import '../../components/candidate/CandidateRecord.css';

// ---------------------------------------------------------------------------
// Administration -> Company Setup -> PIPELINE & CHECKS (founder ATS audit 2026-11-17). Super Admin / Admin:
//   Stage names     rename any stage. The stage itself (its code, its place in the chain, who may move it) never changes.
//   Sub-statuses    an ordered list under a stage (e.g. Interview booked: Technical round, 2nd round, HR round). The owner of
//                   that stage sets one on a person; it shows as a chip next to the stage and is written to the timeline.
//   Share checklist the ticks needed before a profile is sent to the client; any item can be switched off.
// Each part has "Reset to defaults". Every change is audited. Backend: routes/atsFlowConfig.js, utils/atsFlowConfig.js.
// ---------------------------------------------------------------------------
const errText = (e, f) => e?.response?.data?.error || f;

function StageNames({ data, onSaved }) {
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setDraft({ ...data.labels }); }, [data]);
  const changed = data.codes.filter((c) => (draft[c] || '') !== (data.labels[c] || ''));
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const labels = Object.fromEntries(changed.map((c) => [c, draft[c]]));
      const r = await api.put('/ats/stage-labels', { labels });
      setMsg({ ok: true, text: `${r.data.changed} stage name${r.data.changed === 1 ? '' : 's'} saved. Every screen uses the new words.` });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function reset() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Put every stage name back to the built-in words?')) return;
    setBusy(true); setMsg(null);
    try { await api.post('/ats/stage-labels/reset'); setMsg({ ok: true, text: 'Stage names are back to the defaults.' }); onSaved(); } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not reset.') }); } finally { setBusy(false); }
  }
  return (
    <section className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div className="crx-title">
        <h2 style={{ margin: 0 }}>Stage names</h2>
        <span className="crx-row">
          <button type="button" className="btn btn-sm" onClick={reset} disabled={busy || !data.renamed.length}>Reset to defaults</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy || !changed.length}>{busy ? 'Saving…' : `Save${changed.length ? ` (${changed.length})` : ''}`}</button>
        </span>
      </div>
      <p className="small-muted">Rename what a stage is called. The stages, their order and who may move a person into them stay the same (reports and permissions depend on them).</p>
      {msg && <div className={`crx-flash ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Built-in name</th><th>Name shown</th></tr></thead>
          <tbody>
            {data.codes.map((c, i) => (
              <tr key={c}>
                <td className="small-muted">{i + 1}</td>
                <td>{(data.defaults || DEFAULT_STAGE_LABELS)[c] || c}</td>
                <td>
                  <input
                    value={draft[c] || ''}
                    maxLength={60}
                    onChange={(e) => setDraft({ ...draft, [c]: e.target.value })}
                    aria-label={`Name shown for ${(data.defaults || DEFAULT_STAGE_LABELS)[c]}`}
                    style={{ width: '100%', minWidth: 160 }}
                  />
                  {draft[c] !== (data.defaults || {})[c] && <span className="small-muted"> renamed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SubStatuses({ data, onSaved }) {
  const [rows, setRows] = useState(null);
  const [add, setAdd] = useState({ stage: 'INTERVIEW_SCHEDULED', label: '', order: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { api.get('/ats/sub-statuses', { params: { all: '1' } }).then((r) => setRows(r.data.rows || [])).catch((e) => setMsg({ ok: false, text: errText(e, 'Could not load.') })); }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ ok: true, text: ok }); load(); onSaved(); } catch (e) { setMsg({ ok: false, text: errText(e, 'That did not work.') }); } finally { setBusy(false); }
  };
  const label = (c) => data.labels[c] || c;
  const byStage = data.codes.map((c) => ({ stage: c, list: (rows || []).filter((r) => r.stage === c).sort((a, b) => a.order - b.order) })).filter((g) => g.list.length);
  return (
    <section className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div className="crx-title">
        <h2 style={{ margin: 0 }}>Sub-statuses</h2>
        <button type="button" className="btn btn-sm" disabled={busy || !(rows || []).some((r) => r.active)} onClick={() => {
          // eslint-disable-next-line no-alert
          if (window.confirm('Switch every sub-status off? People keep their history.')) run(() => api.post('/ats/sub-statuses/reset'), 'Every sub-status is switched off.');
        }}
        >
          Reset to defaults
        </button>
      </div>
      <p className="small-muted">A finer step inside a stage, for example under &quot;{label('INTERVIEW_SCHEDULED')}&quot;: Technical round, 2nd round, HR round. The owner of that stage sets it on a person. It never changes who may move the stage.</p>
      {msg && <div className={`crx-flash ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      <form
        className="crx-form crx-grid"
        onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/ats/sub-statuses', add); setAdd({ ...add, label: '', order: '' }); }, 'Sub-status added.'); }}
      >
        <label className="field"><span>Under stage</span>
          <Combo value={add.stage} onChange={(e) => setAdd({ ...add, stage: e.target.value })}>
            {data.codes.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </Combo>
        </label>
        <label className="field"><span>Sub-status</span><input value={add.label} maxLength={60} required placeholder="e.g. 2nd round" onChange={(e) => setAdd({ ...add, label: e.target.value })} /></label>
        <label className="field"><span>Order (optional)</span><input type="number" min="0" max="999" value={add.order} onChange={(e) => setAdd({ ...add, order: e.target.value })} /></label>
        <div className="crx-row"><button type="submit" className="btn btn-sm btn-primary" disabled={busy || add.label.trim().length < 2}>+ Add</button></div>
      </form>
      {rows && !byStage.length && <div className="small-muted">No sub-statuses yet.</div>}
      {byStage.map((g) => (
        <div key={g.stage} style={{ marginTop: 10 }}>
          <b>{label(g.stage)}</b>
          {g.list.map((s) => (
            <div key={s.id} className="crx-item" style={s.active ? undefined : { opacity: 0.55 }}>
              <div className="crx-main">
                <span><span className="chip">{s.label}</span></span>
                <span className="small-muted">{[`order ${s.order}`, !s.active && 'switched off', s.byName && `by ${s.byName}`].filter(Boolean).join(' · ')}</span>
              </div>
              <span className="crx-row">
                <button type="button" className="btn btn-sm" disabled={busy} title="Up" onClick={() => run(() => api.put(`/ats/sub-statuses/${s.id}`, { order: Math.max(0, s.order - 1) }))}>↑</button>
                <button type="button" className="btn btn-sm" disabled={busy} title="Down" onClick={() => run(() => api.put(`/ats/sub-statuses/${s.id}`, { order: s.order + 1 }))}>↓</button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
                  // eslint-disable-next-line no-alert
                  const v = window.prompt('New name', s.label);
                  if (v && v.trim() && v.trim() !== s.label) run(() => api.put(`/ats/sub-statuses/${s.id}`, { label: v.trim() }), 'Renamed.');
                }}
                >
                  Rename
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put(`/ats/sub-statuses/${s.id}`, { active: !s.active }))}>{s.active ? 'Switch off' : 'Switch on'}</button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(() => api.delete(`/ats/sub-statuses/${s.id}`), 'Removed (or switched off when people already used it).')}>Remove</button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function ShareChecklist() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.get('/ats/share-checklist/settings').then((r) => setD(r.data)).catch((e) => setMsg({ ok: false, text: errText(e, 'Could not load.') })); }, []);
  async function flip(key) {
    setBusy(true); setMsg(null);
    try { const r = await api.put('/ats/share-checklist/settings', { [key]: !d.on[key] }); setD(r.data); } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setMsg(null);
    try { const r = await api.post('/ats/share-checklist/settings/reset'); setD(r.data); setMsg({ ok: true, text: 'Every item is on again.' }); } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not reset.') }); } finally { setBusy(false); }
  }
  return (
    <section className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div className="crx-title">
        <h2 style={{ margin: 0 }}>Checklist before a profile goes to the client</h2>
        <button type="button" className="btn btn-sm" onClick={reset} disabled={busy || !d || Object.values(d.on).every(Boolean)}>Reset to defaults</button>
      </div>
      <p className="small-muted">The BDE TL ticks these when sending a profile to the client. A missing item stops the send and lists what is missing. Items the app can check itself (a resume on file, both salaries, a notice period) must also be on the profile.</p>
      {msg && <div className={`crx-flash ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      {d && d.items.map((i) => (
        <label key={i.key} className="crx-item" style={{ cursor: 'pointer' }}>
          <span className="crx-main"><b>{i.label}</b><span className="small-muted">{d.on[i.key] ? 'Needed' : 'Switched off'}</span></span>
          <input type="checkbox" checked={!!d.on[i.key]} disabled={busy} onChange={() => flip(i.key)} aria-label={i.label} />
        </label>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// INDUSTRY PIPELINES (2026-11-18, backend utils/deptPipelines.js): each department's own pipeline. A step a department does not use is
// switched off for it (the screens do not offer it, the server refuses it); a step can need a TL / STL / Manager / Admin to approve.
// ---------------------------------------------------------------------------
const PRESETS = [
  ['Hide the AI interview steps', ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED']],
  ['Hide the BDE steps', ['WITH_BDE', 'BDE_APPROVED']],
];
function IndustryPipelines() {
  const [data, setData] = useState(null);
  const [dept, setDept] = useState('');
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api.get('/ats/pipelines').then((r) => { setData(r.data); setDept((d) => d || (r.data.departments || [])[0] || ''); }).catch((e) => setMsg({ ok: false, text: errText(e, 'Could not load the industry pipelines.') })), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (data && dept) setDraft(JSON.parse(JSON.stringify(data.pipelines[dept] || {}))); }, [data, dept]);
  if (!data) return msg ? <div className="notice">{msg.text}</div> : null;
  const saved = data.pipelines[dept] || {};
  const differs = (s) => s && (!s.enabled || s.approverRole);
  const set = (code, patch) => setDraft({ ...draft, [code]: { ...draft[code], ...patch } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const stages = Object.fromEntries(Object.entries(draft).filter(([, s]) => differs(s)).map(([c, s]) => [c, { enabled: s.enabled, approverRole: s.approverRole || null }]));
      const r = await api.put(`/ats/pipelines/${encodeURIComponent(dept)}`, { stages });
      setMsg({ ok: true, text: r.data.message }); await load();
    } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function reset() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Put ${dept} back to every step with no extra approval?`)) return;
    setBusy(true); setMsg(null);
    try { const r = await api.post(`/ats/pipelines/${encodeURIComponent(dept)}/reset`); setMsg({ ok: true, text: r.data.message }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e, 'Could not reset.') }); } finally { setBusy(false); }
  }
  const preset = (codes) => setDraft({ ...draft, ...Object.fromEntries(codes.filter((c) => draft[c] && !draft[c].mandatory).map((c) => [c, { ...draft[c], enabled: false, approverRole: null }])) });
  return (
    <section className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div className="crx-title">
        <h2 style={{ margin: 0 }}>Industry pipelines</h2>
        <span className="crx-row">
          <button type="button" className="btn btn-sm" onClick={reset} disabled={busy || !Object.values(saved).some(differs)}>Reset {dept}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
        </span>
      </div>
      <p className="small-muted">Each department can have its own pipeline. Switch off a step the department does not use (for example the AI interview for Medical): its candidates cannot be moved into it and the screens do not offer it. A step can also need a TL, STL, Manager or Admin: anyone below that level who tries gets stopped and the approvers are told. Steps the offer, joining and client flows need are always used. Nothing is changed until you save.</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
        {data.departments.map((d) => {
          const n = Object.values(data.pipelines[d] || {}).filter(differs).length;
          return <button key={d} type="button" className={`btn btn-sm${d === dept ? ' btn-primary' : ''}`} onClick={() => setDept(d)}>{d}{n ? ` · ${n} set` : ''}</button>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 8px' }}>
        <span className="small-muted" style={{ alignSelf: 'center' }}>Quick set for {dept}:</span>
        {PRESETS.map(([label, codes]) => <button key={label} type="button" className="btn btn-sm" onClick={() => preset(codes)}>{label}</button>)}
      </div>
      {msg && <div className={`crx-flash ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>Step</th><th>{dept} uses it</th><th>Needs approval from</th></tr></thead>
          <tbody>
            {data.stages.map((s, i) => {
              const d = draft[s.code] || { enabled: true, approverRole: null };
              return (
                <tr key={s.code} style={d.enabled ? undefined : { opacity: 0.55 }}>
                  <td className="small-muted">{i + 1}</td>
                  <td>{s.label}</td>
                  <td>
                    {s.mandatory
                      ? <span className="small-muted" title="The offer, joining or client flow depends on this step">always used</span>
                      : <input type="checkbox" checked={d.enabled} onChange={(e) => set(s.code, { enabled: e.target.checked, ...(e.target.checked ? {} : { approverRole: null }) })} aria-label={`${dept} uses ${s.label}`} />}
                  </td>
                  <td>
                    <select value={d.approverRole || ''} disabled={!d.enabled} onChange={(e) => set(s.code, { approverRole: e.target.value || null })} aria-label={`Approval for ${s.label}`}>
                      <option value="">No extra approval</option>
                      {data.approvers.map((a) => <option key={a} value={a}>{a === 'TL' ? 'TL or above' : `${a.charAt(0)}${a.slice(1).toLowerCase()} or above`}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PipelineSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get('/ats/stage-labels').then((r) => { setData(r.data); setError(''); }).catch((e) => setError(errText(e, 'Could not load the pipeline settings.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  const saved = () => { load(); loadStageLabels({ fresh: true }); };
  if (error && !data) return <div className="notice">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <StageNames data={data} onSaved={saved} />
      <SubStatuses data={data} onSaved={saved} />
      <IndustryPipelines />
      <ShareChecklist />
      <R3Settings />
    </div>
  );
}

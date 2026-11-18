// ---------------------------------------------------------------------------
// MORE FOR THE CAREER TAB (founder audit 2026-11-18, round 3). TeamLink logins only; the BDE team's limited view gets nothing from the server.
//   <PersonalCard id />       address, native place, marital status, languages, father's name, preferred locations (a list) - and "confirmed current"
//   <VerifyCard id />         what the resume says vs what is saved, with the matching resume sentence; correct / approve
//   <HistoryCard id />        every earlier application with its rejection reason, earlier joinings, reapply, salary / experience changes with reasons
//   <ScoreHistoryCard id />   every change of the Fit score: date, version of the weights, reason
//   <VerifyBanner id onOpen />  "needs verification" strip for the top of the profile
// Data: /api/candidates/:id/{extra,verify,history-timeline,score-history} (backend routes/candidateData.js).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { FlagRow } from './VerifyBits.jsx';
import './CandidateRecord.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Mumbai', 'Delhi', 'Vijayawada', 'Visakhapatnam', 'Kolkata', 'Ahmedabad'];
const LANGS = ['English', 'Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam', 'Urdu', 'Marathi'];

function Flash({ msg }) {
  if (!msg) return null;
  return <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>;
}

// --- a list typed in as chips ---------------------------------------------------------------------------------------------
function ChipList({ value, onChange, suggestions, placeholder, label }) {
  const [text, setText] = useState('');
  const add = (v) => {
    const t = String(v || '').trim();
    if (!t || value.some((x) => x.toLowerCase() === t.toLowerCase())) { setText(''); return; }
    onChange([...value, t]); setText('');
  };
  return (
    <div>
      <div className="crx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {value.map((v) => (
          <span key={v} className="skillpill match" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {v}
            <button type="button" className="btn-link" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}>×</button>
          </span>
        ))}
        {!value.length && <span className="small-muted">None yet</span>}
      </div>
      <div className="crx-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <input value={text} placeholder={placeholder} aria-label={label} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(text); } }} style={{ minWidth: 140 }} />
        <button type="button" className="btn btn-sm" onClick={() => add(text)}>Add</button>
      </div>
      <div className="crx-row" style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
        {suggestions.filter((s) => !value.some((x) => x.toLowerCase() === s.toLowerCase())).map((s) => <button key={s} type="button" className="btn btn-sm btn-ghost" onClick={() => add(s)}>{`+ ${s}`}</button>)}
      </div>
    </div>
  );
}

// --- personal details -------------------------------------------------------------------------------------------------------
export function PersonalCard({ id }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { api.get(`/candidates/${id}/extra`).then((r) => setD(r.data)).catch(() => setD({ restricted: true })); }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || d.restricted) return null;
  const start = () => setForm({
    address: d.address || '', nativePlace: d.nativePlace || '', maritalStatus: d.maritalStatus || '', fatherName: d.fatherName || '', languages: d.languages || [], preferredLocations: d.preferredLocations || [],
  });
  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await api.put(`/candidates/${id}/extra`, form); setD({ ...d, ...r.data }); setForm(null); setMsg({ text: 'Saved.' }); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function confirmCurrent() {
    setBusy(true); setMsg(null);
    try { await api.post(`/candidates/${id}/confirm-current`); setMsg({ text: 'Marked as confirmed current.' }); load(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">Personal details and preferred locations</div>
        {d.canEdit && !form && <button type="button" className="btn btn-sm" onClick={start}>Edit</button>}
      </div>
      {d.stale && (
        <div className="notice amber" style={{ margin: '4px 0' }}>
          <span>{`Older than ${d.stale.days} days and nobody has confirmed it since: ${d.stale.parts.map((p) => `${p.what.toLowerCase()} (${p.days} days)`).join(', ')}.`}</span>
          {d.canEdit && <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} disabled={busy} onClick={confirmCurrent}>Confirmed current</button>}
        </div>
      )}
      {!form ? (
        <div className="crx-grid">
          <div><div className="crx-sub">Address</div><div className="crx-line">{d.address || '—'}</div></div>
          <div><div className="crx-sub">Native place / hometown</div><div className="crx-line">{d.nativePlace || '—'}</div></div>
          <div><div className="crx-sub">Marital status</div><div className="crx-line">{d.maritalStatus || '—'}</div></div>
          <div><div className="crx-sub">Father's name</div><div className="crx-line">{d.fatherName || '—'}</div></div>
          <div><div className="crx-sub">Languages known</div><div className="crx-line">{(d.languages || []).join(', ') || '—'}</div></div>
          <div><div className="crx-sub">Preferred locations</div><div className="crx-line">{(d.preferredLocations || []).join(', ') || '—'}</div></div>
        </div>
      ) : (
        <form className="crx-form" onSubmit={save}>
          <div className="crx-grid">
            <label className="field"><span>Address</span><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
            <label className="field"><span>Native place / hometown</span><input value={form.nativePlace} onChange={(e) => setForm({ ...form, nativePlace: e.target.value })} /></label>
            <label className="field"><span>Marital status</span>
              <Combo value={form.maritalStatus} onChange={(e) => setForm({ ...form, maritalStatus: e.target.value })}>
                <option value="">—</option>
                {(d.maritalOptions || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </Combo>
            </label>
            <label className="field"><span>Father's name</span><input value={form.fatherName} onChange={(e) => setForm({ ...form, fatherName: e.target.value })} /></label>
          </div>
          <div className="field" style={{ marginTop: 8 }}><span>Languages known</span><ChipList value={form.languages} onChange={(v) => setForm({ ...form, languages: v })} suggestions={LANGS} placeholder="Add a language" label="Add a language" /></div>
          <div className="field" style={{ marginTop: 8 }}><span>Preferred locations (pick as many as they would take)</span><ChipList value={form.preferredLocations} onChange={(v) => setForm({ ...form, preferredLocations: v })} suggestions={CITIES} placeholder="Add a city" label="Add a city" /></div>
          <div className="crx-row crx-span" style={{ marginTop: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setForm(null); setMsg(null); }}>Cancel</button>
          </div>
        </form>
      )}
      <div className="crx-sub" style={{ marginTop: 6 }}>These details are not shown to the BDE team. Every change is recorded with your name.</div>
      <Flash msg={msg} />
    </section>
  );
}

// --- verify -----------------------------------------------------------------------------------------------------------------------
export function VerifyCard({ id, onChanged }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => { api.get(`/candidates/${id}/verify`).then((r) => setD(r.data)).catch(() => setD({ restricted: true })); }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || d.restricted) return null;
  async function resolve(flag, body) {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/ats/data-verify/flags/${flag.id}/resolve`, body);
      setMsg({ text: r.data.waitingForTl ? 'Marked checked. The team lead approves it.' : 'Done.' });
      load(); if (onChanged) onChanged();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  async function recheck() {
    setBusy(true); setMsg(null);
    try { const r = await api.post(`/candidates/${id}/verify/recheck`); setD(r.data); setMsg({ text: r.data.rechecked ? `${r.data.rechecked} thing(s) to check.` : 'Nothing to check: the profile agrees with the resume.' }); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not check.') }); } finally { setBusy(false); }
  }
  const open = d.flags.filter((f) => f.status === 'OPEN' || f.status === 'WAIT_TL');
  const done = d.flags.filter((f) => !(f.status === 'OPEN' || f.status === 'WAIT_TL')).slice(0, 5);
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">{open.length ? `Needs verification (${open.length})` : 'Verification'}</div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={recheck} title="Check the saved profile against the latest resume again">Check again</button>
      </div>
      {!open.length && <div className="small-muted">Nothing waits to be checked. {d.resume ? `Last resume read: ${d.resume.fileName} (${day(d.resume.readAt)}).` : 'No resume has been read yet.'}</div>}
      {open.map((f) => <FlagRow key={f.id} flag={f} busy={busy} canApprove={d.canDecide} canCorrect={d.canCorrect} onResolve={resolve} />)}
      {done.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="small-muted">{`Decided before (${done.length})`}</summary>
          {done.map((f) => <FlagRow key={f.id} flag={f} />)}
        </details>
      )}
      <Flash msg={msg} />
    </section>
  );
}

export function VerifyBanner({ id, onOpen }) {
  const [n, setN] = useState(0);
  useEffect(() => { let on = true; api.get(`/candidates/${id}/verify`).then((r) => { if (on) setN(r.data.openCount || 0); }).catch(() => {}); return () => { on = false; }; }, [id]);
  if (!n) return null;
  return (
    <div className="vb-banner" role="status">
      <b>Needs verification</b>
      <span>{`${n} thing${n === 1 ? '' : 's'} from the resume ${n === 1 ? 'is' : 'are'} not checked yet.`}</span>
      {onOpen && <button type="button" className="btn btn-sm" onClick={onOpen}>See what to check</button>}
    </div>
  );
}

// --- rejoin / reapply timeline ----------------------------------------------------------------------------------------------------
export function HistoryCard({ id }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [reapply, setReapply] = useState(null); // { requirementId, reason }
  const load = useCallback(() => { api.get(`/candidates/${id}/history-timeline`).then((r) => setD(r.data)).catch(() => setD({ applications: [], events: [], previousJoinings: [] })); }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.applications.length && !d.events.length)) return null;
  async function doReapply() {
    setBusy(true); setMsg(null);
    try { const r = await api.post(`/candidates/${id}/reapply`, reapply); setMsg({ text: r.data.message }); setReapply(null); load(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not open it again.') }); } finally { setBusy(false); }
  }
  return (
    <section className="c360t-card">
      <div className="c360t-label">Applications before, joinings and data changes</div>
      {d.previousJoinings.length > 0 && (
        <div className="notice" style={{ margin: '4px 0' }}>
          {`Joined before: ${d.previousJoinings.map((j) => `${j.title || 'a requirement'}${j.client ? ` (${j.client})` : ''}${j.joined && j.joined.at ? ` on ${String(j.joined.at).slice(0, 10)}` : ''}${j.sameClientAsOpenApplication ? ' - same client as an open application' : ''}`).join('; ')}.`}
        </div>
      )}
      <ul className="vb-tl">
        {d.applications.map((a) => (
          <li key={a.applicationId}>
            <div><b>{a.title || 'Requirement'}</b>{a.reqCode ? ` (${a.reqCode})` : ''}{a.client ? ` · ${a.client}` : ''}{` · now ${String(a.stage || '').replace(/_/g, ' ').toLowerCase()}`}</div>
            <div className="when">{`Applied ${day(a.appliedAt)}`}</div>
            {a.rejections.map((r, i) => <div key={i} className="small-muted">{`Rejected ${day(r.at)}: ${r.reason || 'no reason recorded'}${r.detail ? ` - ${r.detail}` : ''}${r.by ? ` (${r.by})` : ''}`}</div>)}
            {a.reapplied.map((r, i) => <div key={i} className="small-muted">{`Applied again ${day(r.at)}${r.by ? ` (confirmed by ${r.by})` : ''}${r.note ? ` - ${r.note}` : ''}`}</div>)}
            {d.canReapply && a.stage === 'REJECTED' && a.requirementId && (
              reapply && reapply.requirementId === a.requirementId ? (
                <div className="crx-row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                  <input value={reapply.reason} placeholder="Why may they apply again?" aria-label="Reason" onChange={(e) => setReapply({ ...reapply, reason: e.target.value })} style={{ minWidth: 220 }} />
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || reapply.reason.trim().length < 3} onClick={doReapply}>Confirm reapply</button>
                  <button type="button" className="btn btn-sm" onClick={() => setReapply(null)}>Cancel</button>
                </div>
              ) : <button type="button" className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setReapply({ requirementId: a.requirementId, reason: '' })}>Apply again…</button>
            )}
          </li>
        ))}
      </ul>
      {d.events.length > 0 && (
        <>
          <div className="crx-sub">Salary, experience and other data changes</div>
          <ul className="vb-tl">
            {d.events.map((e) => (
              <li key={e.id}>
                <div>{e.title}</div>
                {e.reason && <div className="small-muted">{`Why: ${e.reason}`}</div>}
                <div className="when">{`${dayTime(e.at)}${e.byName ? ` · ${e.byName}` : ''}`}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <Flash msg={msg} />
    </section>
  );
}

// --- score history ----------------------------------------------------------------------------------------------------------------
export function ScoreHistoryCard({ id }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const load = useCallback(() => { api.get(`/candidates/${id}/score-history`).then((r) => setD(r.data)).catch(() => setD({ rows: [] })); }, [id]);
  useEffect(() => { load(); api.get(`/candidates/${id}/extra`).then((r) => setCanEdit(!!r.data.canEdit)).catch(() => {}); }, [load, id]);
  if (!d || d.restricted) return null;
  async function refresh() { setBusy(true); try { const r = await api.post(`/candidates/${id}/score-history/refresh`); setD({ ...d, rows: r.data.rows }); } finally { setBusy(false); } }
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">Score history</div>
        {canEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={refresh} title="Score the open applications again now">Recalculate</button>}
      </div>
      {!d.rows.length ? <div className="small-muted">No Fit score has been kept yet. A score is written when the person is added to a requirement.</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>When</th><th>Requirement</th><th>Fit</th><th>Weights</th><th>Why it changed</th></tr></thead>
          <tbody>
            {d.rows.map((r) => <tr key={r.id}><td>{dayTime(r.at)}</td><td>{r.title ? `${r.title}${r.reqCode ? ` (${r.reqCode})` : ''}` : '—'}</td><td><b>{r.score}%</b></td><td>{r.versionLabel || '—'}</td><td>{r.reason}{r.byName ? ` · ${r.byName}` : ''}</td></tr>)}
          </tbody>
        </table></div>
      )}
      <div className="crx-sub" style={{ marginTop: 4 }}>{d.note || 'The latest score is the one used everywhere.'}</div>
    </section>
  );
}

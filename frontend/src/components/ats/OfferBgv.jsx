// Counter-offers, background verification (BGV), the industry checklist and
// gender / age criteria (founder ATS audit, 2026-11-17).
// Backend: routes/atsOfferBgvRoutes.js + utils/atsOfferBgv.js (application side, /api/ats),
// routes/requirements.js GET/PUT /requirements/:id/industry (job side).
//
//   CounterOfferModal       record the candidate's counter, decide it, see the history (Offers row)
//   BgvModal                the five checks, vendor, report link (Offers row / profile)
//   BgvListModal            the TL / HR list of BGV in their area (Offers page)
//   ApplicationExtrasCard   the profile's card: checklist from the job's industry template, criteria flag, BGV, counters
//   RequirementIndustryCard the job's card: industry template, BGV needed, gender / age criteria (+ Admin template editor)

import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import '../interviews/Interviews.css';

const money = (n) => (n === '' || n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const errOf = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;
export const BGV_TONE = {
  Clear: 'green', 'Not needed': 'grey', Pending: 'amber', 'In progress': 'blue', Discrepancy: 'red', 'Not started': 'amber',
};
const COUNTER_TONE = { Accepted: 'green', 'Revised offer': 'blue', Refused: 'red', 'Waiting for decision': 'amber' };

// --------------------------------------------------------------------------- counter-offer
export function CounterOfferModal({
  appId, name, offeredCtc, canEdit, canDecide, onClose, onChanged,
}) {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ ctcAsked: '', joiningAsked: '', otherTerms: '', competingCompany: '', competingCtc: '' });
  const [d, setD] = useState({ decision: '', revisedCtc: '', revisedJoining: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.get(`/ats/offers/${appId}/counter`).then((r) => setRows(r.data.rows || [])).catch((e) => setErr(errOf(e, 'Could not load the counter-offers.')));
  useEffect(() => { load(); }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (rows || []).find((c) => !c.decision);
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post(`/ats/offers/${appId}/counter`, f);
      setRows(r.data.rows); setMsg('Counter-offer saved. It waits for a decision.');
      setF({ ctcAsked: '', joiningAsked: '', otherTerms: '', competingCompany: '', competingCtc: '' });
      if (onChanged) onChanged();
    } catch (e) { setErr(errOf(e, 'Could not save.')); }
    setBusy(false);
  };
  const decide = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post(`/ats/offers/${appId}/counter/${open.id}/decide`, d);
      setRows(r.data.rows); setMsg(r.data.next || `Saved: ${d.decision}.`);
      setD({ decision: '', revisedCtc: '', revisedJoining: '', note: '' });
      if (onChanged) onChanged();
    } catch (e) { setErr(errOf(e, 'Could not save the decision.')); }
    setBusy(false);
  };
  return (
    <Modal title={`Counter-offer — ${name}`} onClose={onClose} wide footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="ivx-fb">
        <div className="ivx-hint" style={{ marginTop: 0 }}>{`Our offer: ${money(offeredCtc)} a year.`}</div>
        {err && <div className="error-text" style={{ margin: '8px 0' }}>{err}</div>}
        {msg && <div className="notice" style={{ margin: '8px 0' }}>{msg}</div>}
        {open && (
          <div className="card section" style={{ marginTop: 10 }}>
            <b>Waiting for a decision</b>
            <CounterLine c={open} />
            {canDecide ? (
              <>
                <div className="ivx-two ivx-sec">
                  <label><b>Decision</b>
                    <select value={d.decision} onChange={(e) => setD({ ...d, decision: e.target.value })}>
                      <option value="">Pick…</option>
                      <option>Accepted</option>
                      <option>Revised offer</option>
                      <option>Refused</option>
                    </select>
                  </label>
                  <label><b>Note {d.decision === 'Refused' ? '(why)' : '(optional)'}</b><input value={d.note} maxLength={500} onChange={(e) => setD({ ...d, note: e.target.value })} /></label>
                </div>
                {d.decision === 'Revised offer' && (
                  <div className="ivx-two ivx-sec">
                    <label><b>New yearly CTC (₹)</b><input type="number" min="1" value={d.revisedCtc} onChange={(e) => setD({ ...d, revisedCtc: e.target.value })} /></label>
                    <label><b>New joining date</b><input type="date" value={d.revisedJoining} onChange={(e) => setD({ ...d, revisedJoining: e.target.value })} /></label>
                  </div>
                )}
                <button type="button" className="btn btn-sm btn-primary" disabled={busy || !d.decision} onClick={decide}>{busy ? 'Saving…' : 'Save decision'}</button>
              </>
            ) : <div className="small-muted">The team lead decides it.</div>}
          </div>
        )}
        {!open && canEdit && (
          <div className="card section" style={{ marginTop: 10 }}>
            <b>What did the candidate ask for?</b>
            <div className="ivx-two ivx-sec">
              <label><b>CTC asked (₹ a year)</b><input type="number" min="1" value={f.ctcAsked} onChange={(e) => setF({ ...f, ctcAsked: e.target.value })} /></label>
              <label><b>Joining date asked</b><input type="date" value={f.joiningAsked} onChange={(e) => setF({ ...f, joiningAsked: e.target.value })} /></label>
            </div>
            <div className="ivx-sec">
              <b>Other terms</b>
              <textarea rows="2" maxLength={1000} placeholder="e.g. Work from home on Fridays, joining bonus" value={f.otherTerms} onChange={(e) => setF({ ...f, otherTerms: e.target.value })} />
            </div>
            <div className="ivx-two ivx-sec">
              <label><b>Competing offer — company (optional)</b><input value={f.competingCompany} maxLength={150} onChange={(e) => setF({ ...f, competingCompany: e.target.value })} /></label>
              <label><b>Competing offer — CTC (optional)</b><input type="number" min="1" value={f.competingCtc} onChange={(e) => setF({ ...f, competingCtc: e.target.value })} /></label>
            </div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save counter-offer'}</button>
          </div>
        )}
        <div className="ivx-sec" style={{ marginTop: 12 }}>
          <b>History</b>
          {rows === null && <div className="small-muted">Loading…</div>}
          {rows && rows.length === 0 && <div className="small-muted">No counter-offer yet.</div>}
          {(rows || []).filter((c) => c.decision).map((c) => <CounterLine key={c.id} c={c} withDecision />)}
        </div>
      </div>
    </Modal>
  );
}
function CounterLine({ c, withDecision }) {
  const asked = [c.ctcAsked != null && `CTC ${money(c.ctcAsked)}`, c.joiningAsked && `joining ${day(c.joiningAsked)}`, c.otherTerms].filter(Boolean).join(' · ');
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #eee)' }}>
      <div>{asked || '—'}</div>
      {c.competingCompany && <div className="small-muted">{`Competing offer: ${c.competingCompany}${c.competingCtc ? ` · ${money(c.competingCtc)}` : ''}`}</div>}
      <div className="small-muted">{`Recorded ${day(c.at)} by ${c.byName || '—'}`}</div>
      {withDecision && (
        <div style={{ marginTop: 3 }}>
          <StatusChip status={c.decision} tone={COUNTER_TONE[c.decision]} />{' '}
          <span className="small-muted">
            {[c.decision === 'Revised offer' && c.revisedCtc != null && `new CTC ${money(c.revisedCtc)}`, c.revisedJoining && `new joining ${day(c.revisedJoining)}`, c.decisionNote, `${day(c.decidedAt)} by ${c.decidedByName || '—'}`].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}
export function CounterChip({ counter, onOpen }) {
  if (!counter) return null;
  return (
    <button type="button" className="link-btn" style={{ fontSize: 11.5 }} onClick={onOpen} title="Counter-offer history">
      <StatusChip status={`Counter: ${counter.status}`} tone={COUNTER_TONE[counter.status]} />
      {counter.count > 1 ? <span className="small-muted">{` (${counter.count})`}</span> : null}
    </button>
  );
}

// --------------------------------------------------------------------------- BGV
export function BgvModal({ appId, name, canEdit, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/ats/bgv/${appId}`).then((r) => {
      setData(r.data);
      const b = r.data.bgv;
      const checks = {};
      r.data.checks.forEach((c) => { checks[c.key] = b ? (b.checks.find((x) => x.key === c.key) || {}).status || 'Pending' : 'Pending'; });
      setForm({ checks, vendor: b ? b.vendor || '' : '', reportLink: b ? b.reportLink || '' : '', note: b ? b.note || '' : '' });
    }).catch((e) => setErr(errOf(e, 'Could not load the BGV.')));
  }, [appId]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.put(`/ats/bgv/${appId}`, form);
      if (onSaved) onSaved(r.data.bgv);
    } catch (e) { setErr(errOf(e, 'Could not save.')); }
    setBusy(false);
  };
  return (
    <Modal
      title={`Background verification — ${name}`}
      onClose={onClose}
      footer={canEdit ? <button type="button" className="btn btn-primary" disabled={busy || !form} onClick={save}>{busy ? 'Saving…' : 'Save'}</button> : <button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      {!data && !err && <div className="small-muted">Loading…</div>}
      {err && <div className="error-text" style={{ marginBottom: 8 }}>{err}</div>}
      {data && form && (
        <div className="ivx-fb">
          <div className="ivx-hint" style={{ marginTop: 0 }}>
            {data.bgvNeeded ? 'This job needs BGV: joining shows a warning until it is Clear.' : 'This job does not ask for BGV. You can still record it.'}
            {data.bgv ? ` Overall: ${data.bgv.overall} (updated ${day(data.bgv.at)} by ${data.bgv.byName || '—'}).` : ''}
          </div>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {data.checks.map((c) => (
                <tr key={c.key}>
                  <td style={{ width: '40%' }}>{c.label}</td>
                  <td>
                    <select disabled={!canEdit} value={form.checks[c.key]} onChange={(e) => setForm({ ...form, checks: { ...form.checks, [c.key]: e.target.value } })}>
                      {data.states.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ivx-two ivx-sec">
            <label><b>Vendor</b><input disabled={!canEdit} value={form.vendor} maxLength={120} placeholder="e.g. AuthBridge" onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></label>
            <label><b>Report link (optional)</b><input disabled={!canEdit} value={form.reportLink} maxLength={500} placeholder="https://…" onChange={(e) => setForm({ ...form, reportLink: e.target.value })} /></label>
          </div>
          <div className="ivx-sec">
            <b>Note</b>
            <input disabled={!canEdit} value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          {data.bgv && data.bgv.reportLink && <a href={data.bgv.reportLink} target="_blank" rel="noopener noreferrer">Open the report</a>}
        </div>
      )}
    </Modal>
  );
}
export function BgvChip({ bgv, onOpen }) {
  if (!bgv) return null;
  return (
    <button type="button" className="link-btn" style={{ fontSize: 11.5 }} onClick={onOpen} title={bgv.needed ? 'This job needs background verification' : 'Background verification'}>
      <StatusChip status={`BGV: ${bgv.overall}`} tone={BGV_TONE[bgv.overall] || 'grey'} />
    </button>
  );
}
const BGV_FILTERS = [['open', 'Not clear yet'], ['Discrepancy', 'Discrepancy'], ['Clear', 'Clear'], ['', 'All']];
export function BgvListModal({ onClose, canEdit }) {
  const [status, setStatus] = useState('open');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const load = () => api.get('/ats/bgv-list', { params: { status } }).then((r) => setData(r.data)).catch((e) => setErr(errOf(e, 'Could not load the list.')));
  useEffect(() => { setData(null); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Background verification — your area" onClose={onClose} wide footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="tabs" role="tablist" style={{ marginBottom: 8 }}>
        {BGV_FILTERS.map(([k, l]) => (
          <button key={k || 'all'} type="button" role="tab" aria-selected={status === k} className={`btn btn-sm${status === k ? ' btn-primary' : ''}`} style={{ marginRight: 6 }} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {err && <div className="error-text">{err}</div>}
      {!data && !err && <div className="small-muted">Loading…</div>}
      {data && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Candidate</th><th>Requirement</th><th>BGV</th><th>Vendor</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.candidate.name}</td>
                  <td>
                    <div>{r.requirement.title}</div>
                    <div className="small-muted" style={{ fontSize: 12 }}>{[r.requirement.clientName, r.bgvNeeded ? 'BGV needed' : null].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td><StatusChip status={r.overall} tone={BGV_TONE[r.overall] || 'grey'} /></td>
                  <td className="small-muted">{r.vendor || '—'}{r.reportLink ? <> · <a href={r.reportLink} target="_blank" rel="noopener noreferrer">report</a></> : null}</td>
                  <td className="small-muted">{r.at ? `${day(r.at)} · ${r.byName || ''}` : '—'}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>{canEdit ? 'Update' : 'View'}</button></td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan="6" className="small-muted">Nobody here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && <BgvModal appId={edit.id} name={edit.candidate.name} canEdit={canEdit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </Modal>
  );
}

// --------------------------------------------------------------------------- the profile card
export function ApplicationExtrasCard({ appId, onChanged }) {
  const [x, setX] = useState(null);
  const [err, setErr] = useState('');
  const [dialog, setDialog] = useState('');
  const load = () => api.get(`/ats/applications/${appId}/extras`).then((r) => { setX(r.data); setErr(''); }).catch((e) => { setX(null); setErr(e.response && e.response.status === 403 ? '' : errOf(e, 'Could not load the checklist.')); });
  useEffect(() => { if (appId) load(); }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!appId || (!x && !err)) return null;
  if (err) return <div className="error-text" style={{ margin: '6px 0' }}>{err}</div>;
  const tick = async (it) => {
    try { const r = await api.put(`/ats/applications/${appId}/checklist/${it.key}`, { done: !it.done }); setX(r.data); if (onChanged) onChanged(); } catch (e) { setErr(errOf(e, 'Could not save.')); }
  };
  const steps = ['Interview', 'Offer', 'Joining'].filter((s) => x.checklist.some((c) => c.step === s));
  const latest = x.counters && x.counters[0];
  return (
    <section className="cdw-card">
      <div className="cdw-label">{x.template ? `Checklist · ${x.template.name}` : 'Checklist, BGV and counter-offers'}</div>
      {x.warnings.length > 0 && <div className="notice amber" style={{ margin: '4px 0 8px' }}>{x.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
      {x.criteria && (
        <div style={{ marginBottom: 8 }}>
          <StatusChip status={`Gender / age: ${x.criteria.flag}`} tone={x.criteria.flag === 'Match' ? 'green' : x.criteria.flag === 'Mismatch' ? 'red' : 'amber'} />
          <div className="small-muted" style={{ fontSize: 12 }}>
            {[x.criteria.prefGender !== 'Any' && `Prefers ${x.criteria.prefGender}`, (x.criteria.ageMin != null || x.criteria.ageMax != null) && `age ${x.criteria.ageMin ?? 'any'}–${x.criteria.ageMax ?? 'any'}`, `reason: ${x.criteria.reason}`].filter(Boolean).join(' · ')}
          </div>
          {x.criteria.why.length > 0 && <div className="small-muted" style={{ fontSize: 12 }}>{x.criteria.why.join(' · ')}</div>}
          <div className="small-muted" style={{ fontSize: 11.5 }}>{x.criteria.note}</div>
        </div>
      )}
      {steps.map((s) => (
        <div key={s} style={{ marginBottom: 6 }}>
          <div className="small-muted" style={{ fontSize: 11.5, textTransform: 'uppercase' }}>{s}</div>
          {x.checklist.filter((c) => c.step === s).map((c) => (
            <label key={c.key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={c.done} onChange={() => tick(c)} />
              <span>{c.label}{!c.required && <span className="small-muted"> (if needed)</span>}</span>
              {c.done && c.byName && <span className="small-muted" style={{ fontSize: 11.5 }}>{`· ${c.byName}, ${day(c.at)}`}</span>}
            </label>
          ))}
        </div>
      ))}
      {!x.template && <div className="small-muted" style={{ fontSize: 12 }}>This job has no industry template.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <StatusChip status={`BGV: ${x.bgv ? x.bgv.overall : 'Not started'}`} tone={BGV_TONE[x.bgv ? x.bgv.overall : 'Not started']} />
        {x.bgvNeeded && <span className="small-muted" style={{ fontSize: 12 }}>needed for this job</span>}
        <button type="button" className="btn btn-sm" onClick={() => setDialog('bgv')}>{x.can.bgv ? 'Update BGV' : 'See BGV'}</button>
        {latest && <StatusChip status={`Counter: ${latest.status}`} tone={COUNTER_TONE[latest.status]} />}
        {(latest || x.can.counter) && <button type="button" className="btn btn-sm" onClick={() => setDialog('counter')}>{latest ? 'Counter-offers' : 'Record counter-offer'}</button>}
      </div>
      {dialog === 'bgv' && <BgvModal appId={appId} name={x.candidate.name} canEdit={x.can.bgv} onClose={() => setDialog('')} onSaved={() => { setDialog(''); load(); if (onChanged) onChanged(); }} />}
      {dialog === 'counter' && <CounterOfferModal appId={appId} name={x.candidate.name} canEdit={x.can.counter} canDecide={x.can.decide} onClose={() => { setDialog(''); load(); }} onChanged={onChanged} />}
    </section>
  );
}

// --------------------------------------------------------------------------- the job card
export function RequirementIndustryCard({ requirementId, canEdit }) {
  const [x, setX] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tplOpen, setTplOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  const load = () => api.get(`/requirements/${requirementId}/industry`).then((r) => setX(r.data)).catch(() => setX(null));
  useEffect(() => { load(); api.get('/ats/industry-templates').then((r) => setAdmin(!!r.data.canEdit)).catch(() => {}); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!x) return null;
  const c = x.criteria;
  const startEdit = () => {
    setForm({
      templateId: x.templateId || '', bgvNeeded: x.bgvNeeded, prefGender: c ? c.prefGender : 'Any',
      ageMin: c && c.ageMin != null ? c.ageMin : '', ageMax: c && c.ageMax != null ? c.ageMax : '', criteriaReason: c ? c.reason || '' : '',
    });
    setErr(''); setEditing(true);
  };
  const criteriaOn = form && (form.prefGender !== 'Any' || form.ageMin !== '' || form.ageMax !== '');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.put(`/requirements/${requirementId}/industry`, { ...form, templateId: form.templateId || null });
      setX({ ...x, ...r.data }); setEditing(false);
    } catch (e) { setErr(errOf(e, 'Could not save.')); }
    setBusy(false);
  };
  return (
    <div className="card section">
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Industry checklist &amp; BGV</h3>
      {!editing && (
        <>
          <div className="small-muted" style={{ fontSize: 12.5 }}>
            {x.template ? <><b style={{ color: 'var(--ink)' }}>{x.template.name}</b>{x.templateFrom === 'client industry' ? ' (from the client\'s industry)' : ''}</> : 'No industry template'}
          </div>
          {x.template && (
            <ul style={{ margin: '4px 0 6px 16px', padding: 0, fontSize: 12.5 }}>
              {x.template.items.map((i) => <li key={i.key}>{`${i.label} `}<span className="small-muted">{`· ${i.step}`}</span></li>)}
            </ul>
          )}
          <div style={{ fontSize: 12.5 }}>{`Background verification: ${x.bgvNeeded ? 'needed' : 'not needed'}`}</div>
          {c && (
            <div className="notice amber" style={{ margin: '6px 0', fontSize: 12.5 }}>
              <div>{[c.prefGender !== 'Any' && `Preferred gender: ${c.prefGender}`, (c.ageMin != null || c.ageMax != null) && `Age ${c.ageMin ?? 'any'}–${c.ageMax ?? 'any'}`].filter(Boolean).join(' · ')}</div>
              <div>{`Reason: ${c.reason}`}</div>
              <div className="small-muted" style={{ fontSize: 11.5 }}>{`Set by ${c.byName || '—'} on ${day(c.at)}. Not used in the fit score — shown as a match / mismatch flag only.`}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {canEdit && <button type="button" className="btn btn-sm" onClick={startEdit}>Change</button>}
            {admin && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTplOpen(true)}>Edit templates</button>}
          </div>
        </>
      )}
      {editing && form && (
        <div className="ivx-fb">
          <label className="ivx-sec" style={{ display: 'block' }}><b>Industry template</b>
            <select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} style={{ width: '100%' }}>
              <option value="">{`From the client's industry${x.defaultTemplateId ? ` (${(x.templates.find((t) => t.id === x.defaultTemplateId) || {}).name || ''})` : ' (none)'}`}</option>
              {x.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="none">No template</option>
            </select>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} className="ivx-sec">
            <input type="checkbox" checked={!!form.bgvNeeded} onChange={(e) => setForm({ ...form, bgvNeeded: e.target.checked })} />
            This job needs background verification
          </label>
          <div className="ivx-sec"><b>Gender / age (only when the law allows it)</b></div>
          <div className="ivx-two">
            <label><b>Preferred gender</b>
              <select value={form.prefGender} onChange={(e) => setForm({ ...form, prefGender: e.target.value })}>
                {x.genders.map((g) => <option key={g}>{g}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <label><b>Age from</b><input type="number" min="18" max="70" value={form.ageMin} onChange={(e) => setForm({ ...form, ageMin: e.target.value })} style={{ width: 70 }} /></label>
              <label><b>to</b><input type="number" min="18" max="70" value={form.ageMax} onChange={(e) => setForm({ ...form, ageMax: e.target.value })} style={{ width: 70 }} /></label>
            </div>
          </div>
          {criteriaOn && (
            <label className="ivx-sec" style={{ display: 'block' }}><b>Reason (required)</b>
              <input value={form.criteriaReason} maxLength={500} placeholder="e.g. Warden for a women's hostel" onChange={(e) => setForm({ ...form, criteriaReason: e.target.value })} style={{ width: '100%' }} />
            </label>
          )}
          <div className="ivx-hint">Recruiters see this with its reason. It never changes the fit score; each candidate shows a match / mismatch flag.</div>
          {err && <div className="error-text" style={{ marginTop: 6 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {tplOpen && <TemplatesModal onClose={() => { setTplOpen(false); load(); }} />}
    </div>
  );
}

// Admin: edit the industry templates (items per step), or add an industry.
function TemplatesModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [steps, setSteps] = useState(['Interview', 'Offer', 'Joining']);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = (pick) => api.get('/ats/industry-templates').then((r) => {
    setRows(r.data.rows); setSteps(r.data.steps || steps);
    const t = r.data.rows.find((x) => x.id === pick) || r.data.rows[0];
    if (t) setSel(JSON.parse(JSON.stringify(t)));
  }).catch((e) => setErr(errOf(e, 'Could not load.')));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setItem = (i, patch) => setSel({ ...sel, items: sel.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = sel.id ? await api.put(`/ats/industry-templates/${sel.id}`, sel) : await api.post('/ats/industry-templates', sel);
      setMsg('Saved.'); load(r.data.template.id);
    } catch (e) { setErr(errOf(e, 'Could not save.')); }
    setBusy(false);
  };
  return (
    <Modal title="Industry templates" onClose={onClose} wide footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={busy || !sel} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button></>}>
      {!rows && !err && <div className="small-muted">Loading…</div>}
      {err && <div className="error-text" style={{ marginBottom: 6 }}>{err}</div>}
      {msg && <div className="notice" style={{ marginBottom: 6 }}>{msg}</div>}
      {rows && (
        <div className="tabs" style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map((t) => <button key={t.id} type="button" className={`btn btn-sm${sel && sel.id === t.id ? ' btn-primary' : ''}`} onClick={() => setSel(JSON.parse(JSON.stringify(t)))}>{t.name}{t.active ? '' : ' (off)'}</button>)}
          <button type="button" className={`btn btn-sm${sel && !sel.id ? ' btn-primary' : ''}`} onClick={() => setSel({ industry: '', name: '', match: '', active: true, items: [{ label: '', step: 'Interview', required: true }] })}>+ New industry</button>
        </div>
      )}
      {sel && (
        <div className="ivx-fb">
          <div className="ivx-two ivx-sec">
            <label><b>Industry</b><input value={sel.industry} maxLength={60} onChange={(e) => setSel({ ...sel, industry: e.target.value })} /></label>
            <label><b>Name</b><input value={sel.name} maxLength={100} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></label>
          </div>
          <label className="ivx-sec" style={{ display: 'block' }}><b>Client industry words that pick it (optional, e.g. hospital|clinic)</b>
            <input value={sel.match || ''} maxLength={200} onChange={(e) => setSel({ ...sel, match: e.target.value })} style={{ width: '100%' }} />
          </label>
          <table>
            <thead><tr><th>Checklist item</th><th>Step</th><th>Required</th><th /></tr></thead>
            <tbody>
              {sel.items.map((it, i) => (
                <tr key={it.key || `n${i}`}>
                  <td><input value={it.label} maxLength={150} onChange={(e) => setItem(i, { label: e.target.value })} style={{ width: '100%' }} /></td>
                  <td><select value={it.step} onChange={(e) => setItem(i, { step: e.target.value })}>{steps.map((s) => <option key={s}>{s}</option>)}</select></td>
                  <td><input type="checkbox" checked={it.required !== false} onChange={(e) => setItem(i, { required: e.target.checked })} /></td>
                  <td><button type="button" className="link-btn" onClick={() => setSel({ ...sel, items: sel.items.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setSel({ ...sel, items: [...sel.items, { label: '', step: 'Joining', required: true }] })}>+ Add item</button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
            <input type="checkbox" checked={sel.active !== false} onChange={(e) => setSel({ ...sel, active: e.target.checked })} />
            In use (shown in the requirement&apos;s template list)
          </label>
        </div>
      )}
    </Modal>
  );
}

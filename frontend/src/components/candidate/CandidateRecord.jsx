// ---------------------------------------------------------------------------
// THE CANDIDATE RECORD (ATS-100 B5 / B6) — consent, "referred by", where they
// came from, certifications and documents with a real file.
//
//   <RecordCards c internal />      left side of the profile (ProfileLeft):
//                                   Consent card + Where they came from card
//   <RecordDocuments c internal />  the Documents tab (full page + big window)
//   <SourceExtras form set />       Add Candidate form: Referred by / Campus
//                                   drive / "Did they say yes?"
//
// Data: GET /api/candidates/:id/record (backend routes/candidateRecord.js) —
// scoped and redacted on the server; files only ever for TeamLink staff.
// Every card reloads the others when it saves (one small event per candidate).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './CandidateRecord.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const kb = (n) => (n ? (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '');

// --- one load per candidate, shared by every card ---------------------------
const listeners = new Map();
function changed(id) { (listeners.get(id) || new Set()).forEach((fn) => fn()); }
export function useCandidateRecord(id) {
  const [state, setState] = useState({ loading: true, rec: null, error: '' });
  const load = useCallback(() => {
    if (!id) return;
    api.get(`/candidates/${id}/record`)
      .then((res) => setState({ loading: false, rec: res.data, error: '' }))
      .catch((err) => setState({ loading: false, rec: null, error: err?.response?.status === 503 ? '' : errText(err, 'Could not load this part.') }));
  }, [id]);
  useEffect(() => {
    load();
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(load);
    return () => { const s = listeners.get(id); if (s) s.delete(load); };
  }, [id, load]);
  return { ...state, reload: () => changed(id) };
}

function Flash({ msg }) {
  if (!msg) return null;
  return <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>;
}

async function openFile(path, fileName, download) {
  const res = await api.get(path, { params: download ? { download: 1 } : {}, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  if (download) {
    const a = document.createElement('a');
    a.href = url; a.download = fileName || 'document';
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ===========================================================================
// CONSENT
// ===========================================================================
const CONSENT_TONE = { GIVEN: 'green', NOT_GIVEN: 'grey', WITHDRAWN: 'red' };
const CHOICES = [['GIVEN', 'Said yes'], ['NOT_GIVEN', 'Said no'], ['WITHDRAWN', 'Wants us to stop']];

function ConsentForm({ id, purposes, current, onDone }) {
  const [status, setStatus] = useState(current && current.status === 'WITHDRAWN' ? 'GIVEN' : (current?.status || 'GIVEN'));
  const [picked, setPicked] = useState(() => (current?.purposes?.length ? current.purposes : ['Recruitment']));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await api.post(`/candidates/${id}/consent`, { status, purposes: picked, note });
      onDone(res.data.message || 'Saved.');
    } catch (err) {
      setMsg({ bad: true, text: errText(err, 'Could not save. Please try again.') });
    } finally { setBusy(false); }
  }
  return (
    <form className="crx-form" onSubmit={save}>
      <div className="crx-choice" role="radiogroup" aria-label="What did they say?">
        {CHOICES.map(([k, label]) => (
          <button key={k} type="button" className={`crx-pill${status === k ? ' on' : ''}`} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {status === 'GIVEN' && (
        <div className="crx-checks">
          {purposes.map((p) => (
            <label key={p}>
              <input type="checkbox" checked={picked.includes(p)} onChange={(e) => setPicked(e.target.checked ? [...picked, p] : picked.filter((x) => x !== p))} />
              {p === 'Recruitment' ? 'Use my details for jobs' : p === 'Messages' ? 'Calls, SMS, WhatsApp, email about jobs' : 'Send my profile to clients'}
            </label>
          ))}
        </div>
      )}
      <input className="crx-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder='How did they say it? e.g. "Said yes on a call today"' />
      <div className="crx-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(null)}>Cancel</button>
      </div>
      <Flash msg={msg} />
    </form>
  );
}

export function ConsentCard({ c, rec, canEdit, reload }) {
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  const cs = rec && rec.consent;
  if (!cs) return null;
  const tone = cs.status ? CONSENT_TONE[cs.status] : 'yellow';
  return (
    <section className="pfl-card crx-card">
      <div className="pfl-label">Consent</div>
      <div className="crx-head">
        <StatusChip tone={tone}>{cs.label}</StatusChip>
        {cs.doNotContact && <span className="crx-dnc">Do not contact</span>}
      </div>
      {cs.status === 'GIVEN' && cs.purposes.length > 0 && <div className="crx-line">{`Agreed to: ${cs.purposes.join(', ')}`}</div>}
      {cs.status === 'WITHDRAWN' && <div className="crx-line">{`Asked us to stop${cs.withdrawnAt ? ` on ${day(cs.withdrawnAt)}` : ''}. No bulk messages; not in exports.`}</div>}
      {!cs.status && <div className="crx-line">Nobody has asked this person yet.</div>}
      {cs.status && (
        <div className="crx-sub">
          {[cs.sourceLabel, cs.status !== 'WITHDRAWN' && cs.at ? day(cs.at) : null].filter(Boolean).join(' · ')}
        </div>
      )}
      {cs.proof && <div className="crx-sub" title="Proof">{cs.proof}</div>}
      {canEdit && !editing && (
        <button type="button" className="btn btn-sm crx-mt" onClick={() => { setEditing(true); setMsg(null); }}>
          {cs.status ? 'Change consent' : 'Record consent'}
        </button>
      )}
      {editing && (
        <ConsentForm
          id={c.id}
          purposes={rec.purposes || ['Recruitment', 'Messages', 'Share with clients']}
          current={cs}
          onDone={(text) => { setEditing(false); if (text) { setMsg({ text }); reload(); } }}
        />
      )}
      <Flash msg={msg} />
    </section>
  );
}

// ===========================================================================
// WHERE THEY CAME FROM — referred by, campus drive, campaign
// ===========================================================================
function EmployeePicker({ onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api.get('/sourcing/employees', { params: { q } })
        .then((res) => { if (mine === seq.current) setRows(res.data.employees || []); })
        .catch(() => { if (mine === seq.current) setRows([]); });
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="crx-picker">
      <input className="crx-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type an employee name or code" />
      <div className="crx-options">
        {rows.slice(0, 8).map((e) => (
          <button key={e.id} type="button" className="crx-option" onClick={() => onPick({ employeeId: e.id, name: e.name })}>
            <b>{e.name}</b>
            <span>{[e.employeeCode, e.department].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {q.trim().length > 1 && (
          <button type="button" className="crx-option" onClick={() => onPick({ name: q.trim() })}>
            <b>{`"${q.trim()}"`}</b>
            <span>Not an employee — keep the name only</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function SourceCard({ c, rec, canEdit, reload }) {
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!rec) return null;
  const tags = (rec.attribution || []).filter((a) => a.utmCampaign || a.utmSource || a.referredByName || a.campusDriveId);
  async function save(pick) {
    setMsg(null);
    try {
      const res = await api.put(`/candidates/${c.id}/referred-by`, pick ? { ...pick, applicationId: c.latestApplicationId || undefined } : { clear: true });
      setEditing(false);
      setMsg({ text: res.data.message || 'Saved.' });
      reload();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save. Please try again.') }); }
  }
  const nothing = !rec.referredBy && !rec.campusDrive && !tags.length;
  if (nothing && !canEdit) return null;
  return (
    <section className="pfl-card crx-card">
      <div className="pfl-label">Where they came from</div>
      <div className="pfl-kv"><span>Referred by</span><b>{rec.referredBy ? rec.referredBy.name : '—'}</b></div>
      {rec.campusDrive && <div className="pfl-kv"><span>Campus drive</span><b>{`${rec.campusDrive.collegeName} · ${day(rec.campusDrive.driveDate)}`}</b></div>}
      {tags.filter((a) => a.utmCampaign || a.utmSource).map((a) => (
        <div key={a.id} className="pfl-kv">
          <span>Campaign</span>
          <b>{[a.utmCampaign || '(no name)', [a.utmSource, a.utmMedium].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}{a.requirementTitle ? ` → ${a.requirementTitle}` : ''}</b>
        </div>
      ))}
      {canEdit && !editing && (
        <button type="button" className="btn btn-sm crx-mt" onClick={() => setEditing(true)}>{rec.referredBy ? 'Change "Referred by"' : 'Add "Referred by"'}</button>
      )}
      {editing && (
        <>
          <EmployeePicker onPick={save} />
          <div className="crx-row">
            {rec.referredBy && <button type="button" className="btn btn-sm" onClick={() => save(null)}>Remove</button>}
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      )}
      <Flash msg={msg} />
    </section>
  );
}

export function RecordCards({ c, internal }) {
  const { rec } = useCandidateRecord(c && c.id);
  const reload = () => changed(c.id);
  if (!rec) return null;
  const canEdit = !!(internal && rec.rights && rec.rights.canEdit);
  return (
    <>
      <ConsentCard c={c} rec={rec} canEdit={canEdit} reload={reload} />
      {internal && <SourceCard c={c} rec={rec} canEdit={canEdit} reload={reload} />}
      {(rec.certifications.length > 0 || (rec.fromResume || []).length > 0) && (
        <section className="pfl-card crx-card">
          <div className="pfl-label">{`Certifications${rec.certifications.length ? ` (${rec.certifications.length})` : ''}`}</div>
          {rec.certifications.slice(0, 6).map((x) => (
            <div key={x.id} className="crx-row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <span className="crx-line">{[x.name, x.issuer].filter(Boolean).join(' · ')}</span>
              <StatusChip tone={CERT_TONE[x.state.key]}>{x.state.label}</StatusChip>
            </div>
          ))}
          {rec.certifications.length === 0 && (
            <div className="crx-sub">{`The resume lists ${rec.fromResume.length}: ${rec.fromResume.slice(0, 3).map((s) => s.name).join(', ')}${rec.fromResume.length > 3 ? '…' : ''}. Add them on the Documents tab.`}</div>
          )}
        </section>
      )}
    </>
  );
}

// ===========================================================================
// DOCUMENTS TAB — certifications + documents with a real file
// ===========================================================================
const CERT_TONE = { valid: 'green', soon: 'yellow', expired: 'red' };

function CertForm({ id, prefill, onDone }) {
  const [f, setF] = useState({ name: prefill?.name || '', issuer: prefill?.issuer || '', issuedOn: '', expiresOn: '', credentialId: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const fd = new FormData();
    Object.entries(f).forEach(([k, v]) => { if (v) fd.append(k, v); });
    if (prefill) fd.append('source', 'Resume');
    if (file) fd.append('file', file);
    try {
      const res = await api.post(`/candidates/${id}/certifications`, fd);
      onDone(res.data.message || 'Saved.');
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save. Please try again.') }); } finally { setBusy(false); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="crx-form crx-grid" onSubmit={save}>
      <label className="field"><span>Certification</span><input value={f.name} onChange={set('name')} placeholder="e.g. AWS Solutions Architect" required /></label>
      <label className="field"><span>Given by</span><input value={f.issuer} onChange={set('issuer')} placeholder="e.g. Amazon" /></label>
      <label className="field"><span>{prefill?.year ? `Date (the resume says ${prefill.year})` : 'Date'}</span><input type="date" value={f.issuedOn} onChange={set('issuedOn')} /></label>
      <label className="field"><span>Valid till (if any)</span><input type="date" value={f.expiresOn} onChange={set('expiresOn')} /></label>
      <label className="field"><span>Certificate number</span><input value={f.credentialId} onChange={set('credentialId')} /></label>
      <label className="field"><span>File (PDF, JPG, PNG, DOCX)</span><input type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" onChange={(e) => setFile(e.target.files[0] || null)} /></label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save certification'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(null)}>Cancel</button>
      </div>
      <Flash msg={msg} />
    </form>
  );
}

function DocUpload({ id, types, maxMb, onDone }) {
  const [docType, setDocType] = useState('ID');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function save(e) {
    e.preventDefault();
    if (!file) { setMsg({ bad: true, text: 'Choose a file first.' }); return; }
    if (file.size > maxMb * 1024 * 1024) { setMsg({ bad: true, text: `That file is bigger than ${maxMb} MB.` }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.append('docType', docType); if (name) fd.append('name', name); if (note) fd.append('note', note);
    fd.append('file', file);
    try {
      const res = await api.post(`/candidates/${id}/documents/upload`, fd);
      onDone(res.data.message || 'Uploaded.');
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not upload. Please try again.') }); } finally { setBusy(false); }
  }
  return (
    <form className="crx-form crx-grid" onSubmit={save}>
      <div className="field crx-span">
        <span>What is it?</span>
        <div className="crx-choice">
          {types.filter((t) => t !== 'Resume').map((t) => (
            <button key={t} type="button" className={`crx-pill${docType === t ? ' on' : ''}`} aria-pressed={docType === t} onClick={() => setDocType(t)}>{t === 'ID' ? 'ID proof' : t}</button>
          ))}
        </div>
      </div>
      <label className="field"><span>{`File (PDF, JPG, PNG, DOCX · up to ${maxMb} MB)`}</span><input type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" onChange={(e) => setFile(e.target.files[0] || null)} /></label>
      <label className="field"><span>Name (optional)</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aadhaar card" /></label>
      <label className="field crx-span"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(null)}>Cancel</button>
      </div>
      <div className="small-muted crx-span">Resumes go in the Resume box on the left. ID and offer papers stay inside TeamLink.</div>
      <Flash msg={msg} />
    </form>
  );
}

function DeleteAsk({ what, onDelete, onCancel }) {
  const [reason, setReason] = useState('');
  return (
    <div className="crx-ask">
      <input className="crx-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why delete this ${what}?`} autoFocus />
      <button type="button" className="btn btn-sm crx-red" onClick={() => onDelete(reason)}>Delete</button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function RecordDocuments({ c, internal }) {
  const { rec, loading, error } = useCandidateRecord(c && c.id);
  const [mode, setMode] = useState(null); // 'doc' | 'cert' | {prefill}
  const [asking, setAsking] = useState(null);
  const [msg, setMsg] = useState(null);
  const reload = () => changed(c.id);
  if (loading) return <div className="small-muted">Loading…</div>;
  if (error) return <div className="notice">{error}</div>;
  if (!rec) return null;
  const canEdit = !!(internal && rec.rights.canEdit);
  const files = !!rec.rights.canViewFiles;
  const done = (text) => { setMode(null); if (text) { setMsg({ text }); reload(); } };
  const open = async (path, name, dl) => {
    setMsg(null);
    try { await openFile(path, name, dl); } catch (err) { setMsg({ bad: true, text: 'Could not open the file. Please try again.' }); }
  };
  const del = async (path, reason) => {
    try {
      const res = await api.post(path, { reason });
      setAsking(null); setMsg({ text: res.data.message || 'Deleted.' }); reload();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not delete. Please try again.') }); }
  };

  return (
    <div className="crx-docs">
      <Flash msg={msg} />
      <section className="c360t-card">
        <div className="crx-title">
          <div className="c360t-label">{rec.certifications.length ? `Certifications (${rec.certifications.length})` : 'Certifications'}</div>
          {canEdit && !mode && <button type="button" className="btn btn-sm" onClick={() => setMode('cert')}>+ Add certification</button>}
        </div>
        {mode && mode !== 'doc' && <CertForm id={c.id} prefill={mode.prefill} onDone={done} />}
        {rec.certifications.length === 0 && !mode && <div className="small-muted">No certifications on file.</div>}
        {rec.certifications.map((x) => (
          <div key={x.id} className="crx-item">
            <div className="crx-main">
              <b>{x.name}</b>
              <span className="small-muted">{[x.issuer, x.issuedOn && day(x.issuedOn), x.expiresOn && `valid till ${day(x.expiresOn)}`, x.source === 'Resume' ? 'from resume' : null].filter(Boolean).join(' · ')}</span>
            </div>
            <StatusChip tone={CERT_TONE[x.state.key]}>{x.state.label}</StatusChip>
            {files && x.hasFile && <button type="button" className="btn btn-sm" onClick={() => open(`/candidates/${c.id}/certifications/${x.id}/file`, x.fileName, false)}>View</button>}
            {files && x.hasFile && <button type="button" className="btn btn-sm" onClick={() => open(`/candidates/${c.id}/certifications/${x.id}/file`, x.fileName, true)}>Download</button>}
            {canEdit && asking !== `c:${x.id}` && <button type="button" className="btn btn-sm crx-ghost" onClick={() => setAsking(`c:${x.id}`)}>Delete</button>}
            {asking === `c:${x.id}` && <DeleteAsk what="certification" onCancel={() => setAsking(null)} onDelete={(r) => del(`/candidates/${c.id}/certifications/${x.id}/delete`, r)} />}
          </div>
        ))}
        {canEdit && rec.fromResume && rec.fromResume.length > 0 && (
          <div className="crx-suggest">
            <div className="small-muted">The resume also lists:</div>
            {rec.fromResume.map((s) => (
              <button key={s.name} type="button" className="crx-pill" onClick={() => setMode({ prefill: s })}>{`+ ${s.name}${s.issuer ? ` (${s.issuer})` : ''}`}</button>
            ))}
          </div>
        )}
      </section>

      <section className="c360t-card">
        <div className="crx-title">
          <div className="c360t-label">{rec.documents.length ? `Documents (${rec.documents.length})` : 'Documents'}</div>
          {canEdit && !mode && <button type="button" className="btn btn-sm btn-primary" onClick={() => setMode('doc')}>+ Upload document</button>}
        </div>
        {mode === 'doc' && <DocUpload id={c.id} types={rec.docTypes} maxMb={rec.rights.maxMb} onDone={done} />}
        {rec.documents.length === 0 && mode !== 'doc' && <div className="small-muted">No documents on file.</div>}
        {rec.documents.map((d) => (
          <div key={d.id} className="crx-item">
            <div className="crx-main">
              <b>{d.name}</b>
              <span className="small-muted">
                {[d.docType === 'ID' ? 'ID proof' : d.docType, day(d.createdAt), d.uploadedByName, d.hasFile ? kb(d.size) : 'name only (no file)', internal && d.internalOnly ? 'inside TeamLink only' : null].filter(Boolean).join(' · ')}
              </span>
              {d.note && <span className="small-muted">{d.note}</span>}
            </div>
            {files && d.hasFile && <button type="button" className="btn btn-sm" onClick={() => open(`/candidates/${c.id}/documents/${d.id}/file`, d.fileName, false)}>View</button>}
            {files && d.hasFile && <button type="button" className="btn btn-sm" onClick={() => open(`/candidates/${c.id}/documents/${d.id}/file`, d.fileName, true)}>Download</button>}
            {canEdit && asking !== `d:${d.id}` && <button type="button" className="btn btn-sm crx-ghost" onClick={() => setAsking(`d:${d.id}`)}>Delete</button>}
            {asking === `d:${d.id}` && <DeleteAsk what="document" onCancel={() => setAsking(null)} onDelete={(r) => del(`/candidates/${c.id}/documents/${d.id}/delete`, r)} />}
          </div>
        ))}
      </section>
    </div>
  );
}

// ===========================================================================
// ADD CANDIDATE FORM — Referred by · Campus drive · "Did they say yes?"
// Writes into the form: referredByEmployeeId / referredByName / campusDriveId /
// consent { status, purposes, note } (routes/candidates.js POST).
// ===========================================================================
function CampusPicker({ value, onChange }) {
  const [drives, setDrives] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nd, setNd] = useState({ collegeName: '', driveDate: '' });
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/sourcing/campus-drives').then((res) => { setDrives(res.data.drives || []); setCanManage(!!res.data.canManage); }).catch(() => setDrives([]));
  useEffect(() => { load(); }, []);
  async function add() {
    setMsg(null);
    try {
      const res = await api.post('/sourcing/campus-drives', nd);
      await load();
      onChange(res.data.drive.id);
      setAdding(false); setNd({ collegeName: '', driveDate: '' });
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save the drive.') }); }
  }
  return (
    <div className="field">
      <span>Campus drive</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{drives && drives.length ? 'Pick the drive' : 'No drives yet'}</option>
        {(drives || []).map((d) => <option key={d.id} value={d.id}>{`${d.collegeName} · ${day(d.driveDate)}`}</option>)}
      </select>
      {canManage && !adding && <button type="button" className="link-btn crx-mt" onClick={() => setAdding(true)}>+ New drive</button>}
      {adding && (
        <div className="crx-ask">
          <input className="crx-input" placeholder="College name" value={nd.collegeName} onChange={(e) => setNd({ ...nd, collegeName: e.target.value })} />
          <input className="crx-input" type="date" value={nd.driveDate} onChange={(e) => setNd({ ...nd, driveDate: e.target.value })} />
          <button type="button" className="btn btn-sm btn-primary" onClick={add}>Save drive</button>
          <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
      <Flash msg={msg} />
    </div>
  );
}

export function SourceExtras({ form, set }) {
  const isReferral = /referr/i.test(form.source || '') || /referr/i.test(form.firstSource || '');
  const isCampus = /campus/i.test(form.source || '') || /campus/i.test(form.firstSource || '');
  const consent = form.consent || null;
  const setConsent = (patch) => set({ consent: { status: 'GIVEN', purposes: ['Recruitment'], note: '', ...(consent || {}), ...patch } });
  return (
    <div className="crx-extras">
      {isReferral && (
        <div className="field">
          <span>Referred by</span>
          {form.referredByName ? (
            <div className="crx-row">
              <b>{form.referredByName}</b>
              <button type="button" className="link-btn" onClick={() => set({ referredByEmployeeId: undefined, referredByName: undefined })}>change</button>
            </div>
          ) : <EmployeePicker onPick={(p) => set({ referredByEmployeeId: p.employeeId, referredByName: p.name })} />}
        </div>
      )}
      {isCampus && <CampusPicker value={form.campusDriveId} onChange={(v) => set({ campusDriveId: v || undefined })} />}
      <div className="field">
        <span>Did they agree to be in our candidate list?</span>
        <div className="crx-choice">
          <button type="button" className={`crx-pill${consent && consent.status === 'GIVEN' ? ' on' : ''}`} onClick={() => setConsent({ status: 'GIVEN' })}>Yes</button>
          <button type="button" className={`crx-pill${consent && consent.status === 'NOT_GIVEN' ? ' on' : ''}`} onClick={() => setConsent({ status: 'NOT_GIVEN' })}>No</button>
          <button type="button" className={`crx-pill${!consent ? ' on' : ''}`} onClick={() => set({ consent: undefined })}>Not asked</button>
        </div>
        {consent && (
          <input className="crx-input crx-mt" value={consent.note} onChange={(e) => setConsent({ note: e.target.value })} placeholder='How? e.g. "Said yes on a call today"' />
        )}
        {consent && consent.status === 'GIVEN' && (
          <label className="crx-inline">
            <input type="checkbox" checked={(consent.purposes || []).includes('Messages')} onChange={(e) => setConsent({ purposes: e.target.checked ? ['Recruitment', 'Messages'] : ['Recruitment'] })} />
            Also OK to call / SMS / WhatsApp / email about jobs
          </label>
        )}
        {consent && String(consent.note || '').trim().length < 5 && <div className="small-muted">Write how they said it, or it is not saved.</div>}
      </div>
    </div>
  );
}

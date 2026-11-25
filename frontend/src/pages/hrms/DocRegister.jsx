import { Fragment, useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './DocRegister.css';

// ---------------------------------------------------------------------------
// DOCUMENT EXPIRY, NDAs AND POLICY VERSIONS (founder 2026-11-25, from the HR audit questionnaire). HRMS > Expiry & policies.
// ADDITIVE: it only talks to /api/doc-register (backend/src/routes/docRegister.js) and changes no employee record, uploaded file,
// policy record or old acknowledgement. HR / Admin see three tabs (Expiry & agreements, Policies, Settings); any other login that
// arrives here from a bell notice sees only the policies it has to accept again.
// ---------------------------------------------------------------------------

const errOf = (e, fallback) => (e.response && e.response.data && e.response.data.error) || fallback;
const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const daysWords = (n) => (n === null || n === undefined ? '' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`);

async function download(url, params, name) {
  const res = await api.get(url, { params, responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name.replace(/[\\/:*?"<>|]+/g, '');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

function Pill({ text }) {
  const t = String(text);
  const cls = ['Expired', 'Overdue', 'Not acknowledged'].includes(t) ? 'bad' : ['Due soon', 'Needs re-acknowledgement'].includes(t) ? 'warn' : ['Valid', 'Current', 'On track'].includes(t) ? 'good' : 'mute';
  return <span className={`drg-pill drg-${cls}`}>{t}</span>;
}

// ---- Expiry & agreements ---------------------------------------------------------------------------------------------------------
function ItemForm({ preset, item, onDone, onCancel }) {
  const editing = !!item;
  const [f, setF] = useState(item ? { title: item.title, issuedOn: item.issuedOn || '', expiresOn: item.expiresOn || '', note: item.note || '', documentId: item.documentId || '' }
    : { employeeId: preset ? preset.employeeId : '', kind: preset ? preset.kind : 'Document', title: '', issuedOn: '', expiresOn: '', note: '', documentId: '' });
  const [who, setWho] = useState(preset ? preset.name : '');
  const [found, setFound] = useState([]);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const empId = editing ? item.employeeId : f.employeeId;

  useEffect(() => {
    if (!empId) { setFiles([]); return undefined; }
    let alive = true;
    api.get(`/doc-register/people/${empId}/documents`).then((r) => { if (alive) setFiles(r.data.rows); }).catch(() => {});
    return () => { alive = false; };
  }, [empId]);
  useEffect(() => {
    if (editing || f.employeeId || who.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => { api.get('/doc-register/people', { params: { q: who.trim() } }).then((r) => setFound(r.data.rows)).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [who, editing, f.employeeId]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { ...f, documentId: f.documentId || null, issuedOn: f.issuedOn || null, expiresOn: f.expiresOn || null };
      if (editing) { delete body.employeeId; delete body.kind; await api.put(`/doc-register/items/${item.id}`, body); } else await api.post('/doc-register/items', body);
      onDone(editing ? 'Saved.' : 'Added to the tracker.');
    } catch (er) { setError(errOf(er, 'This could not be saved.')); }
    setBusy(false);
  }
  return (
    <form className="drg-form" onSubmit={submit}>
      <h3>{editing ? `Edit: ${item.title} (${item.name})` : 'Add a document or agreement to the tracker'}</h3>
      {!editing && (
        <label className="drg-wide">Employee
          <input type="text" placeholder="Type a name or code" value={who} onChange={(e) => { setWho(e.target.value); set('employeeId', ''); }} />
          {!!found.length && (
            <ul className="drg-pick">{found.map((p) => (
              <li key={p.employeeId}><button type="button" onClick={() => { set('employeeId', p.employeeId); setWho(`${p.name} (${p.employeeCode})`); setFound([]); }}>{p.name} <span className="small-muted">{p.employeeCode} · {p.department || '—'}</span></button></li>
            ))}</ul>
          )}
        </label>
      )}
      {!editing && (
        <label>What is it
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {['Document', 'NDA', 'Confidentiality agreement', 'Bond / service agreement', 'Other agreement'].map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
      )}
      <label>Name {f.kind === 'Document' || editing ? '' : '(optional)'}
        <input type="text" placeholder="for example Passport, Driving licence, Visa" value={f.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label>Issued on <input type="date" value={f.issuedOn} onChange={(e) => set('issuedOn', e.target.value)} /></label>
      <label>Expires on {(editing ? item.kind : f.kind) === 'Document' ? '' : '(empty = never)'}
        <input type="date" value={f.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} />
      </label>
      <label className="drg-wide">The uploaded file it is about (optional)
        <select value={f.documentId} onChange={(e) => set('documentId', e.target.value)} disabled={!empId}>
          <option value="">{empId ? 'Not linked to a file' : 'Choose the employee first'}</option>
          {files.map((d) => <option key={d.id} value={d.id}>{d.docType} · {d.fileName} · {fmt(d.uploadedAt.slice(0, 10))}</option>)}
        </select>
      </label>
      <label className="drg-wide">Note (optional)<input type="text" value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
      {error && <div className="drg-wide error-text" role="alert">{error}</div>}
      <div className="drg-wide drg-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function RenewForm({ item, onDone, onCancel }) {
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.post(`/doc-register/items/${item.id}/renew`, { expiresOn, note }); onDone('Renewed. The old date stays in the history.'); } catch (er) { setError(errOf(er, 'This could not be saved.')); }
    setBusy(false);
  }
  return (
    <form className="drg-form" onSubmit={submit}>
      <h3>Renew: {item.title} ({item.name})</h3>
      <label>New expiry date<input type="date" value={expiresOn} min={item.expiresOn || undefined} onChange={(e) => setExpiresOn(e.target.value)} required /></label>
      <label>Note (optional)<input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {error && <div className="drg-wide error-text" role="alert">{error}</div>}
      <div className="drg-wide drg-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const ITEM_TABS = [['expired', 'Expired'], ['soon', 'Due soon'], ['valid', 'Valid'], ['noExpiry', 'No expiry'], ['agreements', 'NDAs & agreements'], ['noNda', 'No NDA on record'], ['all', 'All']];

function ExpiryTab({ onChanged }) {
  const [bucket, setBucket] = useState('expired');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [noNda, setNoNda] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null); // { item? , preset? }
  const [renew, setRenew] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    setError('');
    api.get('/doc-register/items', { params: { bucket: bucket === 'noNda' ? 'all' : bucket, q: bucket === 'noNda' ? '' : q, kind } }).then((r) => setData(r.data)).catch((e) => setError(errOf(e, 'The list could not be loaded.')));
    if (bucket === 'noNda') api.get('/doc-register/items/no-nda', { params: { q } }).then((r) => setNoNda(r.data)).catch((e) => setError(errOf(e, 'The list could not be loaded.')));
  }, [bucket, q, kind]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const done = (m) => { setMsg(m); setForm(null); setRenew(null); load(); onChanged(); };

  async function remove(it) {
    if (!window.confirm(`Remove "${it.title}" of ${it.name} from the tracker? Its history is kept.`)) return;
    try { await api.delete(`/doc-register/items/${it.id}`); done('Removed.'); } catch (e) { setError(errOf(e, 'This could not be removed.')); }
  }
  async function exportFile(format) {
    try { await download('/doc-register/items/export', { format, bucket, q, kind }, `Document expiry - ${bucket}.${format}`); } catch { setError('The file could not be made.'); }
  }
  const rows = data ? data.rows : [];
  const nn = noNda ? noNda.rows : [];

  return (
    <div>
      {msg && <div className="drg-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      {form && <ItemForm preset={form.preset} item={form.item} onDone={done} onCancel={() => setForm(null)} />}
      {renew && <RenewForm item={renew} onDone={done} onCancel={() => setRenew(null)} />}
      <div className="drg-tabs" role="tablist">
        {ITEM_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={bucket === k} className={`drg-tab${bucket === k ? ' on' : ''}${k === 'expired' && data && data.counts.expired ? ' alert' : ''}`} onClick={() => setBucket(k)}>
            {label}{k === 'noNda' ? (noNda ? <span className="drg-n">{nn.length}</span> : null) : (data ? <span className="drg-n">{data.counts[k]}</span> : null)}
          </button>
        ))}
      </div>
      <div className="drg-filters">
        <input type="search" placeholder="Search name, code or document" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {bucket !== 'noNda' && <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">All kinds</option>{(data ? data.kinds : []).map((k) => <option key={k}>{k}</option>)}</select>}
        <span className="drg-grow" />
        <button type="button" className="btn btn-sm" onClick={() => exportFile('xlsx')}>Download Excel</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => { setMsg(''); setForm({}); }}>Add item</button>
      </div>

      {bucket === 'noNda' && noNda && (
        <>
          <div className="small-muted drg-note">{noNda.covered} of {noNda.total} people have an NDA on record. These {nn.length} do not.</div>
          {!!nn.length && (
            <div className="tbl-wrap"><table><thead><tr><th>Name</th><th>Department</th><th>Joined</th><th /></tr></thead>
              <tbody>{nn.slice(0, 300).map((p) => (
                <tr key={p.employeeId}><td><b>{p.name}</b><div className="small-muted">{p.employeeCode}{p.designation ? ` · ${p.designation}` : ''}</div></td><td>{p.department || '—'}</td><td>{fmt(p.joined)}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => { setMsg(''); setForm({ preset: { employeeId: p.employeeId, name: `${p.name} (${p.employeeCode})`, kind: 'NDA' } }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Add NDA</button></td></tr>
              ))}</tbody></table></div>
          )}
          {nn.length > 300 && <div className="small-muted">Showing the first 300. Download the Excel for all of them.</div>}
        </>
      )}

      {bucket !== 'noNda' && data && !rows.length && <div className="small-muted drg-empty">{data.counts.all ? 'Nothing in this list.' : 'Nothing is tracked yet. Press "Add item" to start with a passport, a visa, a licence or an NDA.'}</div>}
      {bucket !== 'noNda' && !!rows.length && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Item</th><th>Expires</th><th>Status</th><th>File</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className={r.status === 'Expired' ? 'drg-row-bad' : r.status === 'Due soon' ? 'drg-row-warn' : ''}>
                    <td><b>{r.name}</b><div className="small-muted">{r.employeeCode}{r.department ? ` · ${r.department}` : ''}</div></td>
                    <td>{r.title}<div className="small-muted">{r.kind}{r.issuedOn ? ` · issued ${fmt(r.issuedOn)}` : ''}</div>{r.note && <div className="small-muted">{r.note}</div>}</td>
                    <td>{r.expiresOn ? fmt(r.expiresOn) : 'Never'}{r.daysLeft !== null && <div className={`small-muted${r.daysLeft < 0 ? ' drg-late' : ''}`}>{daysWords(r.daysLeft)}</div>}</td>
                    <td><Pill text={r.status} /></td>
                    <td>{r.file ? <span title={r.file.docType}>{r.file.fileName}</span> : <span className="small-muted">—</span>}</td>
                    <td className="drg-row-actions">
                      {r.expiresOn && <button type="button" className="btn btn-sm" onClick={() => { setMsg(''); setRenew(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Renew</button>}
                      <button type="button" className="btn btn-sm" onClick={() => { setMsg(''); setForm({ item: r }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>
                      <button type="button" className="btn btn-sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide history' : 'History'}</button>
                      <button type="button" className="btn btn-sm" onClick={() => remove(r)}>Remove</button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan="6" className="drg-hist">
                      {r.history.map((h, i) => <div key={i}><b>{h.action}</b> <span className="small-muted">{stamp(h.at)} · {h.by}</span>{(h.from || h.to) && <span> · {h.from ? `${fmt(h.from)} → ` : ''}{fmt(h.to)}</span>}{h.note ? <span> · {h.note}</span> : null}</div>)}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Policies -----------------------------------------------------------------------------------------------------------------------
const POLICY_TABS = [['all', 'All'], ['mandatory', 'Mandatory'], ['reviewDue', 'Review due'], ['reack', 'Needs re-acceptance'], ['pending', 'Not accepted'], ['noPlan', 'No review plan']];

function PolicyDetail({ id, onBack, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState({ summary: '', effectiveOn: today(), requireReack: false });
  const [plan, setPlan] = useState({ months: '', owner: '' });
  const [note, setNote] = useState('');
  const [show, setShow] = useState('all');

  const load = useCallback(() => {
    api.get(`/doc-register/policies/${id}`).then((r) => { setD(r.data); setPlan({ months: r.data.policy.review.everyMonths || '', owner: r.data.policy.review.ownerName || '' }); }).catch((e) => setError(errOf(e, 'This policy could not be opened.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(fn, ok) {
    setBusy(true); setError(''); setMsg('');
    try { const r = await fn(); setMsg(typeof ok === 'function' ? ok(r) : ok); load(); onChanged(); } catch (e) { setError(errOf(e, 'This could not be saved.')); }
    setBusy(false);
  }
  if (!d && !error) return <div className="small-muted">Opening…</div>;
  if (!d) return <div><button type="button" className="btn btn-sm" onClick={onBack}>← Back</button><div className="error-text" role="alert">{error}</div></div>;
  const p = d.policy;
  const rv = p.review;
  const people = d.people.filter((x) => show === 'all' || x.state === show);
  return (
    <div className="drg-detail">
      <div className="drg-detail-head">
        <button type="button" className="btn btn-sm" onClick={onBack}>← Back to the list</button>
        <h2>{p.title}</h2>
        {p.mandatory && <span className="drg-pill drg-warn">Mandatory</span>}
      </div>
      {msg && <div className="drg-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="drg-facts">
        <div><span>Current version</span><b>Version {p.currentVersion}</b></div>
        <div><span>Sent to</span><b>{p.target || 'All Employees'} · {p.audience} people</b></div>
        <div><span>Accepted the current version</span><b>{p.current} of {p.audience}</b></div>
        <div><span>Review</span><b><Pill text={rv.state} /> {rv.everyMonths ? `every ${rv.everyMonths} months · next ${fmt(rv.nextReviewOn)}` : ''}</b></div>
        <div><span>Last reviewed</span><b>{fmt(rv.lastReviewedOn)}</b></div>
        <div><span>Original issue</span><b>{d.original.uploadedDate || '—'}{d.original.uploadedBy ? ` · ${d.original.uploadedBy}` : ''}</b></div>
      </div>

      <div className="drg-two">
        <form className="drg-form" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/doc-register/policies/${id}/version`, ver), (r) => `Version ${r.data.policy.currentVersion} recorded${r.data.told ? ` and ${r.data.told} people told` : ''}.`).then(() => setVer({ summary: '', effectiveOn: today(), requireReack: false })); }}>
          <h3>Record a new version</h3>
          <label className="drg-wide">What changed<textarea rows="3" value={ver.summary} onChange={(e) => setVer({ ...ver, summary: e.target.value })} required /></label>
          <label>In force from<input type="date" value={ver.effectiveOn} onChange={(e) => setVer({ ...ver, effectiveOn: e.target.value })} required /></label>
          <label className="drg-check"><input type="checkbox" checked={ver.requireReack} onChange={(e) => setVer({ ...ver, requireReack: e.target.checked })} /> Everyone has to accept it again</label>
          <div className="drg-wide small-muted">This keeps a history. The policy itself is changed on the Documents page as before.</div>
          <div className="drg-wide drg-actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Record version</button></div>
        </form>
        <form className="drg-form" onSubmit={(e) => { e.preventDefault(); act(() => api.put(`/doc-register/policies/${id}/review`, { reviewEveryMonths: plan.months === '' ? null : Number(plan.months), ownerName: plan.owner }), 'Review plan saved.'); }}>
          <h3>Review plan</h3>
          <label>Reviewed every (months)<input type="number" min="1" max="60" value={plan.months} onChange={(e) => setPlan({ ...plan, months: e.target.value })} placeholder="empty = no plan" /></label>
          <label>Owner (optional)<input type="text" value={plan.owner} onChange={(e) => setPlan({ ...plan, owner: e.target.value })} /></label>
          <div className="drg-wide drg-actions"><button type="submit" className="btn btn-sm" disabled={busy}>Save plan</button></div>
          <label className="drg-wide">Note for “Mark as reviewed” (optional)<input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="drg-wide drg-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.post(`/doc-register/policies/${id}/reviewed`, { note }), 'Marked as reviewed today.').then(() => setNote(''))}>Mark as reviewed today</button></div>
        </form>
      </div>

      <h3 className="drg-h3">Versions</h3>
      {!d.versions.length && <div className="small-muted">No revision has been recorded: this is the original issue (version 1).</div>}
      <ul className="drg-timeline">
        {d.versions.map((v) => (
          <li key={v.versionNo}><b>Version {v.versionNo}</b> <span className="small-muted">in force from {fmt(v.effectiveOn)}{v.recordedBy ? ` · ${v.recordedBy}` : ''}</span>{v.requireReack && <span className="drg-pill drg-warn">Accept again</span>}<div>{v.summary}</div></li>
        ))}
      </ul>
      {!!d.history.length && (<><h3 className="drg-h3">Review and change history</h3><ul className="drg-timeline">{d.history.map((h, i) => <li key={i}><b>{h.action}</b> <span className="small-muted">{stamp(h.at)} · {h.by}</span>{h.note ? <div>{h.note}</div> : null}</li>)}</ul></>)}

      <h3 className="drg-h3">Who has accepted it</h3>
      <div className="drg-filters">
        {[['all', 'Everyone'], ['Current', 'Accepted the current version'], ['Needs re-acknowledgement', 'Needs to accept again'], ['Not acknowledged', 'Never accepted']].map(([k, l]) => (
          <button key={k} type="button" className={`drg-tab${show === k ? ' on' : ''}`} onClick={() => setShow(k)}>{l}</button>
        ))}
        <span className="drg-grow" />
        <button type="button" className="btn btn-sm" onClick={() => download(`/doc-register/policies/${id}/people`, { format: 'xlsx' }, `Policy acceptance - ${p.title}.xlsx`).catch(() => setError('The file could not be made.'))}>Download Excel</button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Department</th><th>Status</th><th>Version read</th><th>Accepted on</th></tr></thead>
          <tbody>
            {people.slice(0, 400).map((x) => <tr key={x.employeeId}><td><b>{x.name}</b><div className="small-muted">{x.employeeCode}</div></td><td>{x.department || '—'}</td><td><Pill text={x.state} /></td><td>{x.versionRead ? `Version ${x.versionRead}` : '—'}</td><td>{x.acknowledgedOn ? fmt(x.acknowledgedOn.slice(0, 10)) : '—'}</td></tr>)}
            {!people.length && <tr><td colSpan="5" className="small-muted">Nobody in this list.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PoliciesTab({ onChanged }) {
  const [bucket, setBucket] = useState('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const load = useCallback(() => {
    api.get('/doc-register/policies', { params: { bucket, q } }).then((r) => setData(r.data)).catch((e) => setError(errOf(e, 'The policies could not be loaded.')));
  }, [bucket, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  if (openId) return <PolicyDetail id={openId} onBack={() => { setOpenId(null); load(); }} onChanged={() => { load(); onChanged(); }} />;
  const rows = data ? data.rows : [];
  return (
    <div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="drg-tabs" role="tablist">
        {POLICY_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={bucket === k} className={`drg-tab${bucket === k ? ' on' : ''}`} onClick={() => setBucket(k)}>{label}{data ? <span className="drg-n">{data.counts[k]}</span> : null}</button>
        ))}
      </div>
      <div className="drg-filters"><input type="search" placeholder="Search a policy" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
      {data && !rows.length && <div className="small-muted drg-empty">No policy in this list.</div>}
      {!!rows.length && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Policy</th><th>Version</th><th>Review</th><th>Accepted</th><th>Accept again</th><th>Never accepted</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.title}</b>{r.mandatory && <span className="drg-pill drg-warn">Mandatory</span>}<div className="small-muted">{r.category || '—'} · {r.target || 'All Employees'}{!r.published ? ' · not published' : ''}</div></td>
                  <td>Version {r.currentVersion}</td>
                  <td><Pill text={r.review.state} />{r.review.nextReviewOn && <div className="small-muted">next {fmt(r.review.nextReviewOn)}</div>}</td>
                  <td>{r.current} / {r.audience}</td>
                  <td>{r.needsReack ? <b className="drg-late">{r.needsReack}</b> : 0}</td>
                  <td>{r.notAcknowledged ? <b className={r.mandatory ? 'drg-late' : ''}>{r.notAcknowledged}</b> : 0}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setOpenId(r.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Settings -----------------------------------------------------------------------------------------------------------------------
function SettingsTab({ onChanged }) {
  const [s, setS] = useState(null);
  const [days, setDays] = useState(30);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/doc-register/settings').then((r) => { setS(r.data); setDays(r.data.soonDays); }).catch((e) => setError(errOf(e, 'The settings could not be loaded.'))); }, []);
  async function save(extra, ok) {
    setBusy(true); setError(''); setMsg('');
    try { const r = await api.put('/doc-register/settings', { soonDays: Number(days), ...extra }); setS(r.data.settings); setMsg(ok || 'Saved.'); onChanged(); } catch (e) { setError(errOf(e, 'This could not be saved.')); }
    setBusy(false);
  }
  async function sweep() {
    setBusy(true); setError(''); setMsg('');
    try { const r = await api.post('/doc-register/sweep'); setMsg(r.data.skipped ? 'Reminders are switched off.' : `Done. ${r.data.expiry.told.length} expiry reminders and ${r.data.reviews.told.length} policy review reminders were sent.`); } catch (e) { setError(errOf(e, 'The run failed.')); }
    setBusy(false);
  }
  if (!s && !error) return <div className="small-muted">Opening…</div>;
  return (
    <div className="drg-settings">
      {msg && <div className="drg-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      {s && (
        <>
          <div className="drg-setrow">
            <div>
              <b>Reminders are {s.enabled ? 'ON' : 'OFF'}</b>
              <div className="small-muted">{s.enabled ? `Switched on${s.enabledByName ? ` by ${s.enabledByName}` : ''}. HR gets a bell notice 60, 30 and 7 days before a document expires, on the day, and every week while it is overdue. The same for a policy review that is due. A new policy version that must be accepted again also tells the people concerned.` : 'While it is off, nobody is reminded or told. You can still add items, record versions and look at every list.'}</div>
            </div>
            {s.enabled ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save({ enabled: false }, 'Reminders are OFF.')}>Switch off</button>
              : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { if (window.confirm('Switch the reminders on? HR starts getting bell notices for what is already expired or due soon.')) save({ enabled: true }, 'Reminders are ON.'); }}>Switch on</button>}
          </div>
          <label className="drg-field">“Due soon” means within (days)
            <input type="number" min="1" max="90" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="drg-check"><input type="checkbox" checked={s.tellEmployee} onChange={(e) => save({ tellEmployee: e.target.checked }, e.target.checked ? 'The employee is reminded too.' : 'Only HR is reminded.')} /> Also remind the employee about their own document</label>
          <div className="drg-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save({})}>Save</button>
            {s.enabled && <button type="button" className="btn btn-sm" disabled={busy} onClick={sweep}>Send the reminders now</button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- the employee's own list ----------------------------------------------------------------------------------------------------------
function MyPolicies() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { api.get('/doc-register/my-policies').then((r) => setRows(r.data.rows)).catch((e) => setError(errOf(e, 'This could not be loaded.'))); }, []);
  useEffect(() => { load(); }, [load]);
  async function accept(r) {
    setError(''); setMsg('');
    try { await api.post(`/doc-register/policies/${r.policyId}/reack`); setMsg(`Thank you. You accepted version ${r.currentVersion} of ${r.title}.`); load(); } catch (e) { setError(errOf(e, 'This could not be saved.')); }
  }
  return (
    <div>
      {msg && <div className="drg-ok" role="status">{msg}</div>}
      {error && <div className="error-text" role="alert">{error}</div>}
      {rows && !rows.length && <div className="small-muted drg-empty">You have no policy to accept again.</div>}
      {(rows || []).map((r) => (
        <div key={r.policyId} className="drg-mine">
          <div><b>{r.title}</b> <span className="small-muted">Version {r.currentVersion} · you accepted version {r.readVersion}</span><div>{r.summary}</div><div className="small-muted">Read the policy in Employee Services &gt; Documents, then accept it here.</div></div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => accept(r)}>I have read it and accept</button>
        </div>
      ))}
    </div>
  );
}

// ---- the page ------------------------------------------------------------------------------------------------------------------------------
export default function DocRegister() {
  const [mode, setMode] = useState(null); // 'hr' | 'employee'
  const [tab, setTab] = useState('expiry');
  const [ov, setOv] = useState(null);
  const loadOv = useCallback(() => {
    api.get('/doc-register/overview').then((r) => { setOv(r.data); setMode('hr'); }).catch((e) => { if (e.response && e.response.status === 403) setMode('employee'); else setMode('hr'); });
  }, []);
  useEffect(() => { loadOv(); }, [loadOv]);

  if (!mode) return <div className="drg"><div className="small-muted">Loading…</div></div>;
  if (mode === 'employee') {
    return (
      <div className="drg">
        <div className="page-head"><div><h1>Policies to accept again</h1><div className="page-sub">A policy you accepted earlier has a newer version. Please read it and accept it again.</div></div></div>
        <MyPolicies />
      </div>
    );
  }
  const items = ov ? ov.items : null;
  return (
    <div className="drg">
      <div className="page-head">
        <div>
          <h1>Document expiry &amp; policies</h1>
          <div className="page-sub">What expires and when, who has an NDA, and each policy’s versions, review date and who accepted which version.</div>
        </div>
      </div>
      {ov && !ov.settings.enabled && <div className="drg-off" role="status"><b>Reminders are switched OFF.</b> Nobody is reminded or told yet. Everything else here works. Open <button type="button" className="drg-link" onClick={() => setTab('settings')}>Settings</button> to switch them on.</div>}
      {ov && (
        <div className="drg-kpis">
          <div className="drg-kpi" title="Tracked items past their expiry date"><b className={items.expired ? 'drg-late' : ''}>{items.expired}</b><span>Expired documents</span></div>
          <div className="drg-kpi"><b>{items.soon}</b><span>Due soon ({ov.settings.soonDays} days)</span></div>
          <div className="drg-kpi"><b className={ov.policies.reviewDue ? 'drg-late' : ''}>{ov.policies.reviewDue}</b><span>Policy reviews due</span></div>
          <div className="drg-kpi"><b>{ov.policies.needsReack}</b><span>People to accept a policy again</span></div>
          <div className="drg-kpi"><b className={ov.policies.mandatoryPending ? 'drg-late' : ''}>{ov.policies.mandatoryPending}</b><span>Mandatory policies not accepted</span></div>
        </div>
      )}
      <div className="drg-tabs drg-top" role="tablist">
        {[['expiry', 'Expiry & agreements'], ['policies', 'Policies'], ['settings', 'Settings']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`drg-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'expiry' && <ExpiryTab onChanged={loadOv} />}
      {tab === 'policies' && <PoliciesTab onChanged={loadOv} />}
      {tab === 'settings' && <SettingsTab onChanged={loadOv} />}
    </div>
  );
}

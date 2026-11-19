import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { ListFilterStrip, useListXf } from '../../components/ats/ListFilters.jsx';

// ---------------------------------------------------------------------------
// CALL LISTS (founder 2026-11-17): the recruiters get data as sheets; a manager splits a sheet among recruiters; each recruiter calls the contacts of their own block from VICIdial.
// Here: the manager uploads the sheet and picks the recruiters (equal blocks); a recruiter sees only their block, one contact at a time - Copy number, dial it in VICIdial, say how
// it went, Save & next; the manager sees progress per recruiter, moves what is left, downloads the result. Server: routes/callLists.js, calllist/service.js.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const TONE = { New: 'grey', Interested: 'green', Answered: 'blue', 'Not interested': 'grey', 'Call back': 'amber', 'Not answered': 'amber', Busy: 'amber', 'Switched off': 'amber', 'Wrong number': 'red', 'Do not call': 'red' };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); document.body.removeChild(t); return ok; } catch { return false; }
  }
}
function CopyButton({ number, big }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={`btn ${big ? 'btn-primary' : 'btn-sm'}`} onClick={async () => { if (await copyText(number)) { setDone(true); setTimeout(() => setDone(false), 1800); } }} aria-label={`Copy ${number}`}>
      {done ? '✓ Copied' : '📋 Copy number'}
    </button>
  );
}

// ---- the manager's upload ------------------------------------------------------------------------------------------------------------
function UploadDialog({ onClose, onMade }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [recs, setRecs] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/call-lists/recruiters').then((r) => setRecs(r.data.recruiters)).catch((e) => setErr(errOf(e, 'The recruiters could not be loaded.'))); }, []);
  const shown = useMemo(() => recs.filter((r) => !q.trim() || `${r.name} ${r.department || ''} ${r.team || ''}`.toLowerCase().includes(q.trim().toLowerCase())), [recs, q]);
  const toggle = (id) => { setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setPreview(null); };
  async function send(dryRun) {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/call-lists/import', file, { params: { name: file.name, listName: name || undefined, recruiters: [...picked].join(','), dryRun: dryRun ? 1 : undefined }, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (dryRun) setPreview(r.data); else { onMade(r.data); onClose(); }
    } catch (e) { setErr(errOf(e, 'This file could not be used.')); setPreview(null); } finally { setBusy(false); }
  }
  return (
    <Modal title="Upload a call sheet" wide onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn" disabled={busy || !file} onClick={() => send(true)}>{busy && !preview ? 'Checking…' : 'Check the sheet'}</button>
      <button type="button" className="btn btn-primary" disabled={busy || !preview} onClick={() => send(false)}>{picked.size ? `Create the list and split among ${picked.size}` : 'Create the list (give out later)'}</button>
    </>}>
      <div className="field"><label>Excel or CSV file</label><input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { setFile(e.target.files[0] || null); setPreview(null); setErr(''); }} /></div>
      <div className="field"><label>Name of the list (optional)</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nursing batch, 17 Nov" maxLength={120} /></div>
      <div className="field">
        <label>Split among these recruiters (equal blocks, in the order of the sheet)</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a recruiter…" aria-label="Search recruiters" />
        <div style={{ maxHeight: 190, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, marginTop: 6, padding: 6 }}>
          {shown.map((r) => (
            <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 4px', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /> <span>{r.name}</span><span className="small-muted">{[r.role, r.department, r.team].filter(Boolean).join(' · ')}</span>
            </label>
          ))}
          {!shown.length && <div className="small-muted">No recruiter found.</div>}
        </div>
        <div className="small-muted" style={{ marginTop: 4 }}>{picked.size} picked. Pick none to give the contacts out later.</div>
      </div>
      {err && <div className="notice red">{err}</div>}
      {preview && (
        <div className="notice green" style={{ marginTop: 8 }}>
          <b>{preview.usable} contacts are usable</b> (of {preview.rows} rows).
          {preview.duplicate > 0 && <> {preview.duplicate} repeated number{preview.duplicate === 1 ? '' : 's'} left out.</>}
          {preview.invalid > 0 && <> {preview.invalid} wrong number{preview.invalid === 1 ? '' : 's'} left out.</>}
          {preview.blank > 0 && <> {preview.blank} blank row{preview.blank === 1 ? '' : 's'} left out.</>}
          <div className="small-muted" style={{ marginTop: 4 }}>Columns found: phone = <b>{preview.columns.phone}</b>{preview.columns.name ? <>, name = <b>{preview.columns.name}</b></> : ', no name column'}{preview.columns.location ? <>, place = <b>{preview.columns.location}</b></> : ''}{preview.columns.interest ? <>, role = <b>{preview.columns.interest}</b></> : ''}. {preview.extraColumns.length ? `Kept as extra information: ${preview.extraColumns.join(', ')}.` : ''}</div>
          {preview.split.length > 0 && <div style={{ marginTop: 4 }}>{preview.split.map((s) => `${s.recruiterName}: ${s.count}`).join(' · ')}</div>}
        </div>
      )}
    </Modal>
  );
}

// ---- the recruiter's calling card -----------------------------------------------------------------------------------------------------
function CallingCard({ listId, outcomes, row, left, onSaved, onLeave }) {
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [cb, setCb] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setOutcome(''); setNote(''); setCb(''); setErr(''); }, [row && row.id]);
  if (!row) {
    return (
      <section className="panel panel-pad">
        <h3 style={{ marginTop: 0 }}>{left ? 'The rest are call-backs for later' : 'You have called everyone in your block 🎉'}</h3>
        <div className="small-muted">{left ? `${left} still to call, but not due yet.` : 'Nothing is left to call in this list.'}</div>
      </section>
    );
  }
  async function save() {
    setBusy(true); setErr('');
    try { await api.post(`/call-lists/rows/${row.id}/call`, { outcome, note: note || undefined, callbackAt: outcome === 'Call back' ? new Date(cb).toISOString() : undefined }); onSaved(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  }
  const extras = Object.entries(row.extra || {});
  return (
    <section className="panel panel-pad" aria-label="Contact to call">
      <div className="small-muted">{left} left to call{row.calledCount ? ` · called ${row.calledCount} time${row.calledCount === 1 ? '' : 's'} before` : ''}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', margin: '6px 0' }}>
        <h2 style={{ margin: 0 }}>{row.name || 'No name'}</h2>
        {row.status !== 'New' && <StatusChip tone={TONE[row.status] || 'grey'}>{row.status}</StatusChip>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 0.5 }}>{row.phone}</div>
        <CopyButton number={row.phone} big />
      </div>
      <div className="small-muted" style={{ marginTop: 4 }}>Copy the number, paste it in VICIdial and dial. Then say how it went below.</div>
      {row.phone2 && <div style={{ marginTop: 6 }}>Alternate: <b>{row.phone2}</b> <CopyButton number={row.phone2} /></div>}
      {(row.location || row.interest || extras.length > 0) && (
        <div className="small-muted" style={{ marginTop: 8 }}>{[row.interest, row.location].filter(Boolean).join(' · ')}{extras.length ? ` · ${extras.map(([k, v]) => `${k}: ${v}`).join(' · ')}` : ''}</div>
      )}
      {row.note && <div className="notice" style={{ marginTop: 8 }}>Earlier note: {row.note}</div>}
      <div className="field" style={{ marginTop: 12 }}>
        <label>How did the call go?</label>
        <div className="msg-filter">{outcomes.map((o) => <button key={o} type="button" className={`msg-chip${outcome === o ? ' on' : ''}`} onClick={() => setOutcome(o)}>{o}</button>)}</div>
      </div>
      {outcome === 'Call back' && <div className="field"><label>Call back at</label><input type="datetime-local" value={cb} onChange={(e) => setCb(e.target.value)} /></div>}
      <div className="field"><label>Note (optional)</label><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} /></div>
      {err && <div className="notice red">{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !outcome || (outcome === 'Call back' && !cb)} onClick={save}>{busy ? 'Saving…' : 'Save and next contact'}</button>
        {onLeave && <button type="button" className="btn" onClick={onLeave}>Not this one: show the list</button>}
      </div>
    </section>
  );
}

// ---- one list ----------------------------------------------------------------------------------------------------------------------------
function ListView({ id, onBack, onChanged }) {
  const { user } = useAuth() || {};
  const [det, setDet] = useState(null);
  const [nxt, setNxt] = useState(null);
  const [picked, setPicked] = useState(null); // a contact chosen from the table instead of "next"
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [q, setQ] = useState('');
  const [recFilter, setRecFilter] = useState('');
  const xf = useListXf('callrows', user); // location, added date, called, interest (components/ats/ListFilters.jsx)
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [move, setMove] = useState({ from: '', to: new Set() });
  const [recs, setRecs] = useState([]);
  const iHave = !!(det && det.progress.some((p) => p.recruiterId === (user && user.id)));
  const loadDet = () => api.get(`/call-lists/${id}`).then((r) => setDet(r.data)).catch((e) => setErr(errOf(e, 'This list could not be opened.')));
  const loadNext = () => api.get(`/call-lists/${id}/next`).then((r) => setNxt(r.data)).catch(() => setNxt({ row: null, left: 0 }));
  const loadRows = () => api.get(`/call-lists/${id}/rows`, { params: { status: filter === 'all' ? undefined : filter, q: q || undefined, recruiter: recFilter || undefined, size: 100, ...xf.params } }).then((r) => setRows(r.data)).catch(() => setRows({ rows: [], total: 0 }));
  useEffect(() => { loadDet(); loadNext(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(loadRows, 250); return () => clearTimeout(t); }, [id, filter, q, recFilter, xf.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (det && det.canManage) api.get('/call-lists/recruiters').then((r) => setRecs(r.data.recruiters)).catch(() => {}); }, [det && det.canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { setPicked(null); loadDet(); loadNext(); loadRows(); onChanged(); };
  async function doMove() {
    setErr(''); setMsg('');
    try { const r = await api.post(`/call-lists/${id}/reassign`, { fromId: move.from || 'none', toIds: [...move.to] }); setMsg(`${r.data.moved} contacts moved: ${r.data.split.map((s) => `${s.recruiterName} ${s.count}`).join(', ')}.`); setMove({ from: '', to: new Set() }); refresh(); } catch (e) { setErr(errOf(e, 'They could not be moved.')); }
  }
  async function download() {
    try { const r = await api.get(`/call-lists/${id}/export`, { responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `${det.list.name}-result.csv`; a.click(); URL.revokeObjectURL(a.href); } catch (e) { setErr('The result could not be downloaded.'); }
  }
  async function close() {
    if (!window.confirm('Close this call list? It leaves the list of lists (nothing is deleted).')) return;
    try { await api.delete(`/call-lists/${id}`); onChanged(); onBack(); } catch (e) { setErr(errOf(e, 'It could not be closed.')); }
  }
  if (!det) return <div className="small-muted">{err || 'Loading…'}</div>;
  const card = picked || (nxt && nxt.row) || null;
  return (
    <div>
      <div className="page-head">
        <div><button type="button" className="btn btn-sm" onClick={onBack}>← All call lists</button><h1 style={{ marginTop: 8 }}>{det.list.name}</h1>
          <div className="small-muted">{det.list.total} contacts · uploaded {when(det.list.createdAt)}{det.list.createdByName ? ` by ${det.list.createdByName}` : ''}</div></div>
        {det.canManage && <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" onClick={download}>⬇ Download result</button><button type="button" className="btn" onClick={close}>Close list</button></div>}
      </div>
      {err && <div className="notice red">{err}</div>}
      {msg && <div className="notice green">{msg}</div>}

      {iHave && <CallingCard listId={id} outcomes={det.outcomes} row={card} left={nxt ? nxt.left : 0} onSaved={refresh} onLeave={picked ? () => setPicked(null) : null} />}

      {det.canManage && (
        <section className="panel panel-pad" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Progress by recruiter</h3>
          <table>
            <thead><tr><th>Recruiter</th><th>Given</th><th>Called</th><th>Answered</th><th>Interested</th><th>Call-backs</th><th>Left</th><th /></tr></thead>
            <tbody>
              {det.progress.map((p) => (
                <tr key={p.recruiterId || 'none'}>
                  <td>{p.recruiterName}</td><td>{p.assigned}</td><td>{p.called} <span className="small-muted">({pct(p.called, p.assigned)}%)</span></td><td>{p.answered}</td><td>{p.interested}</td><td>{p.callBack}</td><td>{p.remaining}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setRecFilter(p.recruiterId || 'none')}>See contacts</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ marginBottom: 6 }}>Move what is left to other recruiters</h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ margin: 0 }}><span>From</span>
              <select value={move.from} onChange={(e) => setMove({ ...move, from: e.target.value })}>
                <option value="">Not given to anyone yet</option>
                {det.progress.filter((p) => p.recruiterId).map((p) => <option key={p.recruiterId} value={p.recruiterId}>{p.recruiterName} ({p.remaining} left)</option>)}
              </select>
            </label>
            <div style={{ maxHeight: 110, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
              {recs.filter((r) => r.id !== move.from).map((r) => <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={move.to.has(r.id)} onChange={() => setMove((m) => { const n = new Set(m.to); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return { ...m, to: n }; })} />{r.name}</label>)}
            </div>
            <button type="button" className="btn btn-primary" disabled={!move.to.size} onClick={doMove}>Give to {move.to.size || ''} recruiter{move.to.size === 1 ? '' : 's'}</button>
          </div>
        </section>
      )}

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-pad"><ListFilterStrip list="callrows" xf={xf} user={user} noun="contacts" total={rows ? rows.total : null} /></div>
        <div className="panel-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <h3 style={{ margin: 0, marginRight: 8 }}>{det.canManage ? 'Contacts' : 'My contacts'}</h3>
          {[['pending', 'To call'], ['done', 'Finished'], ['all', 'All']].map(([k, label]) => <button key={k} type="button" className={`msg-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>)}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, number, place…" aria-label="Search contacts" style={{ marginLeft: 'auto', minWidth: 200 }} />
          {recFilter && <button type="button" className="btn btn-sm" onClick={() => setRecFilter('')}>✕ one recruiter only</button>}
        </div>
        <table>
          <thead><tr><th>#</th><th>Name</th><th>Phone</th><th>Role · place</th><th>Status</th>{det.canManage && <th>Recruiter</th>}<th>Note</th><th /></tr></thead>
          <tbody>
            {(rows ? rows.rows : []).map((r) => (
              <tr key={r.id}>
                <td>{r.seq + 1}</td><td>{r.name || '—'}</td><td>{r.phone} <CopyButton number={r.phone} /></td><td>{[r.interest, r.location].filter(Boolean).join(' · ') || '—'}</td>
                <td><StatusChip tone={TONE[r.status] || 'grey'}>{r.status}</StatusChip>{r.status === 'Call back' && r.callbackAt ? <div className="small-muted">{when(r.callbackAt)}</div> : null}</td>
                {det.canManage && <td>{r.recruiterName || '—'}</td>}
                <td className="small-muted">{r.note || ''}</td>
                <td>{r.recruiterId === (user && user.id) && <button type="button" className="btn btn-sm" onClick={() => { setPicked(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Call this one</button>}</td>
              </tr>
            ))}
            {rows && !rows.rows.length && <tr><td colSpan={8} className="small-muted" style={{ padding: 16 }}>No contacts here.</td></tr>}
          </tbody>
        </table>
        {rows && rows.total > rows.rows.length && <div className="small-muted panel-pad">Showing the first {rows.rows.length} of {rows.total}. Use the search or the filters.</div>}
      </section>
    </div>
  );
}

export default function CallLists() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [upload, setUpload] = useState(false);
  const [made, setMade] = useState('');
  const xf = useListXf('calllists'); // source, made-on date (components/ats/ListFilters.jsx)
  const load = () => api.get('/call-lists', { params: xf.params }).then((r) => setData(r.data)).catch((e) => setErr(errOf(e, 'The call lists could not be loaded.')));
  useEffect(() => { load(); }, [xf.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (open) return <ListView id={open} onBack={() => setOpen(null)} onChanged={load} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Call lists</h1>
          <div className="small-muted">A sheet of contacts is split among recruiters. Each recruiter calls their own block from VICIdial and says how every call went.</div>
        </div>
        {data && data.canManage && <button type="button" className="btn btn-primary" onClick={() => setUpload(true)}>⬆ Upload a call sheet</button>}
      </div>
      <ListFilterStrip list="calllists" xf={xf} noun="call lists" />
      {err && <div className="notice red">{err}</div>}
      {made && <div className="notice green">{made}</div>}
      <section className="panel">
        <table>
          <thead><tr><th>List</th><th>{data && data.canManage ? 'Contacts' : 'Mine'}</th><th>Called</th><th>Left</th><th>Interested</th>{data && data.canManage && <th>Recruiters</th>}<th>Uploaded</th><th /></tr></thead>
          <tbody>
            {(data ? data.lists : []).map((l) => (
              <tr key={l.id}>
                <td><b>{l.name}</b><div className="small-muted">{l.fileName || ''}</div></td><td>{data.canManage ? l.total : l.assigned}</td><td>{l.called} <span className="small-muted">({pct(l.called, l.assigned)}%)</span></td><td>{l.remaining}</td><td>{l.interested}</td>
                {data.canManage && <td>{l.recruiters}</td>}
                <td className="small-muted">{when(l.createdAt)}{l.createdByName ? ` · ${l.createdByName}` : ''}</td>
                <td><button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(l.id)}>{data.canManage ? 'Open' : 'Start calling'}</button></td>
              </tr>
            ))}
            {data && !data.lists.length && <tr><td colSpan={8} className="small-muted" style={{ padding: 18 }}>{data.canManage ? 'No call list yet. Upload the sheet and pick the recruiters.' : 'Nothing has been given to you yet. When a manager splits a sheet, your contacts appear here.'}</td></tr>}
            {!data && !err && <tr><td colSpan={8} className="small-muted" style={{ padding: 18 }}>Loading…</td></tr>}
          </tbody>
        </table>
      </section>
      {upload && <UploadDialog onClose={() => setUpload(false)} onMade={(r) => { setMade(`"${r.name}" is ready: ${r.usable} contacts${r.split.length ? ` split among ${r.split.length} recruiters` : ', not given out yet'}.`); load(); }} />}
    </div>
  );
}

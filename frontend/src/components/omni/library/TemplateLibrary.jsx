import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { shared, errOf } from '../omniApi.js';
import { Banner, Btn, DataTable, Empty, GsModal, Pill, Tabs, TinyBtn, fmtDateTime } from '../ui.jsx';
import Toggle from '../automation/Toggle.jsx';
import Combo from '../../Combo.jsx';
import './library.css';

// ---------------------------------------------------------------------------
// THE SHARED TEMPLATE LIBRARY (one list for the whole app: Omni-Channel, ATS, Job Portal, HRMS, Accounts). Nothing is copied: the words stay where they are written;
// this list adds who may use them (Used in), the department, the approval and the version history. Server: GET /api/omni/library/templates (the server decides
// what this login may see and use; the screen only draws it).
//   app       '' = every app (chips on top)   or one app = the list an app screen opens ("Templates" button inside ATS / Job Portal / HRMS / Accounts)
//   embedded  drawn inside an app screen's window (no page head)
//   onPick    (item) => ...  shows a "Use" button on the templates this app may use
// Every template has a visible Edit button: it opens the place where the words are changed; it is greyed out, with the reason, when the login may not edit.
// ---------------------------------------------------------------------------
const APPS = ['ATS', 'Job Portal', 'HRMS', 'Accounts', 'Omni-Channel'];
const APPROVAL_TONE = { approved: 'live', waiting: 'warn', changes: 'red' };

export default function TemplateLibrary({ app = '', embedded = false, onPick, toast = () => {}, onEdit }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [appTab, setAppTab] = useState(app || 'all');
  const [channel, setChannel] = useState('');
  const [dept, setDept] = useState('');
  const [approval, setApproval] = useState('');
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await shared.get('/library/templates', { app: appTab === 'all' ? undefined : appTab, channel: channel || undefined, approval: approval || undefined, dept: dept || undefined });
      setData(r); setErr('');
      setOpen((o) => (o ? (r.items.find((i) => i.key === o.key) || o) : o));
    } catch (e) { setErr(errOf(e, 'The template library could not be read.')); } finally { setLoading(false); }
  }, [appTab, channel, approval, dept]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { shared.get('/me').then(setMine).catch(() => {}); }, []);

  const depts = useMemo(() => [...new Set(((data && data.items) || []).map((i) => i.department).filter(Boolean))].sort(), [data]);
  const channels = data ? Object.keys(data.channels || {}).sort() : [];
  const edit = (t) => { if (onEdit) onEdit(t); else navigate(t.editPath); };
  const cols = [
    { id: 'name', label: 'Template', search: (t) => `${t.name} ${t.group} ${t.body}`, sort: (t) => t.name.toLowerCase(), render: (t) => <div><b>{t.name}</b><div className="lib-sub">{t.group}{t.language ? ` · ${t.language}` : ''}</div></div> },
    { id: 'channel', label: 'Channel', sort: (t) => t.channel, render: (t) => t.channel },
    { id: 'apps', label: 'Used in', render: (t) => <span className="lib-chips">{t.scopes.map((a) => <span key={a} className={`lib-chip${app && a === app ? ' on' : ''}`}>{a}</span>)}</span> },
    { id: 'dept', label: 'Department', sort: (t) => t.department, render: (t) => t.department || 'Everyone who may use it' },
    { id: 'vars', label: 'Variables', hide: true, render: (t) => (t.variables.length ? t.variables.map((v) => `{{${v}}}`).join(' ') : '—') },
    { id: 'approval', label: 'Approval', sort: (t) => t.approval.state, render: (t) => <span><Pill tone={APPROVAL_TONE[t.approval.state] || 'draft'} dot>{t.approval.words}</Pill>{t.provider ? <div className="lib-sub">Meta: {t.provider.status === 'None' ? 'not sent' : t.provider.status}</div> : null}</span> },
    { id: 'version', label: 'Version', sort: (t) => t.version, render: (t) => `v${t.version}` },
    { id: 'act', label: '', render: (t) => (
      <span className="lib-actions" onClick={(e) => e.stopPropagation()}>
        {onPick && <Btn small primary disabled={!t.canUseHere} title={t.canUseHere ? 'Use this template' : t.whyNot} onClick={() => onPick(t)}>Use</Btn>}
        <Btn small disabled={!t.canEdit} title={t.canEdit ? 'Change the words of this template' : t.readOnlyWhy} onClick={() => edit(t)}>Edit</Btn>
        <TinyBtn onClick={() => setOpen(t)}>Details</TinyBtn>
      </span>
    ) },
  ];

  const flip = async (k, v) => {
    try { const r = await shared.put('/library/settings', { [k]: v }); setData((d) => ({ ...d, settings: r.settings })); toast('Saved'); } catch (e) { setErr(errOf(e, 'That did not work.')); }
  };
  const counts = (data && data.counts) || {};
  return (
    <div className={`lib${embedded ? ' lib-embedded' : ''}`}>
      {err && <Banner tone="error">{err}</Banner>}
      {!app && (
        <Tabs value={appTab} onChange={setAppTab} tabs={[['all', 'All apps', counts.all], ...APPS.map((a) => [a, a, counts[a]])]} />
      )}
      <div className="lib-filters">
        <Combo value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="">All channels</option>
          {channels.map((c) => <option key={c} value={c}>{c} ({data.channels[c]})</option>)}
        </Combo>
        <Combo value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={approval} onChange={(e) => setApproval(e.target.value)} aria-label="Approval">
          <option value="">Any approval state</option>
          <option value="approved">Approved</option>
          <option value="waiting">Waiting for approval{data && data.waiting ? ` (${data.waiting} for you)` : ''}</option>
          <option value="changes">Changes needed</option>
        </Combo>
      </div>
      {data && data.settings && mine && mine.isAdmin && !embedded && (
        <div className="lib-switches">
          <label><Toggle on={data.settings.requireApproval} label="New and changed templates need approval" onChange={(v) => flip('requireApproval', v)} /> New and changed templates need approval</label>
          <label><Toggle on={data.settings.requireCampaignApproval} label="Campaigns from apps need approval" onChange={(v) => flip('requireCampaignApproval', v)} /> Campaigns from the ATS, Job Portal, HRMS and Accounts screens need approval before they are sent</label>
        </div>
      )}
      <DataTable columns={cols} rows={(data && data.items) || []} rowKey={(t) => t.key} loading={loading} persistKey={`lib_${app || 'all'}`} onRow={setOpen}
        searchPlaceholder="Search templates by name or words…" emptyText={app ? `No template is shared with ${app} for your login yet.` : 'No templates found.'} />
      {open && <TemplateDetail item={open} app={app} onClose={() => setOpen(null)} onChanged={load} onEdit={edit} onPick={onPick} toast={toast} isAdmin={!!(mine && mine.isAdmin)} />}
    </div>
  );
}

function TemplateDetail({ item: t, app, onClose, onChanged, onEdit, onPick, toast, isAdmin }) {
  const [versions, setVersions] = useState(null);
  const [scopes, setScopes] = useState(t.scopes);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dept, setDept] = useState(t.department || '');
  useEffect(() => { setScopes(t.scopes); setDept(t.department || ''); }, [t.key, t.scopes.join(), t.department]);
  useEffect(() => { shared.get(`/library/templates/${encodeURIComponent(t.key)}/versions`).then((r) => setVersions(r.versions)).catch(() => setVersions([])); }, [t.key, t.version, t.approval.state]);
  const run = async (fn, ok) => { setBusy(true); setErr(''); try { await fn(); toast(ok); await onChanged(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); } };
  const ap = t.approval;
  const toggle = (a) => setScopes((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]));
  const dirty = scopes.slice().sort().join() !== t.scopes.slice().sort().join();
  return (
    <GsModal title={t.name} sub={`${t.channel}${t.language ? ` · ${t.language}` : ''} · version ${t.version}`} width={760} onClose={onClose}
      foot={<>
        <Btn onClick={onClose}>Close</Btn>
        <Btn disabled={!t.canEdit} title={t.canEdit ? '' : t.readOnlyWhy} onClick={() => onEdit(t)}>Edit this template</Btn>
        {onPick && <Btn primary disabled={!t.canUseHere} title={t.canUseHere ? '' : t.whyNot} onClick={() => { onPick(t); onClose(); }}>Use this template</Btn>}
      </>}>
      {err && <Banner tone="error">{err}</Banner>}
      {!t.canEdit && <div className="lib-sub" style={{ marginBottom: 8 }}>{t.readOnlyWhy}</div>}
      {t.subject ? <div className="lib-box"><div className="lib-sub">Subject</div>{t.subject}</div> : null}
      <div className="lib-box lib-body">{t.body}</div>
      <div className="lib-row"><b>Variables</b> {t.variables.length ? t.variables.map((v) => <span key={v} className="lib-chip">{`{{${v}}}`}</span>) : <span className="lib-sub">none</span>}</div>

      <div className="lib-sec">
        <b>Used in</b>
        <div className="lib-checks">
          {APPS.map((a) => <label key={a}><input type="checkbox" disabled={!t.canChangeScopes || busy} checked={scopes.includes(a)} onChange={() => toggle(a)} /> {a}</label>)}
        </div>
        {t.canChangeScopes && dirty && <Btn small primary disabled={busy || !scopes.length} onClick={() => run(() => shared.put(`/library/templates/${encodeURIComponent(t.key)}/scopes`, { scopes }), 'Saved')}>Save where it is used</Btn>}
        {app && !t.scopes.includes(app) && <div className="lib-sub">This template is not shared with {app}.</div>}
      </div>

      <div className="lib-sec">
        <b>Department</b>
        {isAdmin ? (
          <div className="lib-inline">
            <input className="input" value={dept} placeholder="Everyone who may use it" onChange={(e) => setDept(e.target.value)} aria-label="Department" />
            <Btn small disabled={busy || dept === (t.department || '')} onClick={() => run(() => shared.put(`/library/templates/${encodeURIComponent(t.key)}/department`, { department: dept }), 'Saved')}>Save</Btn>
          </div>
        ) : <span> {t.department || 'Everyone who may use it'}</span>}
      </div>

      <div className="lib-sec">
        <b>Approval</b> <Pill tone={APPROVAL_TONE[ap.state] || 'draft'} dot>{ap.words}</Pill>
        {ap.note ? <div className="lib-sub">{ap.by ? `${ap.by}: ` : ''}{ap.note}</div> : null}
        <div className="lib-inline" style={{ marginTop: 6 }}>
          {t.canAsk && <Btn small disabled={busy} onClick={() => run(() => shared.post(`/library/templates/${encodeURIComponent(t.key)}/approval`, { action: 'ask', note }), 'Sent for approval')}>Ask for approval</Btn>}
          {t.canApprove && <>
            <Btn small primary disabled={busy} onClick={() => run(() => shared.post(`/library/templates/${encodeURIComponent(t.key)}/approval`, { action: 'approve', note }), 'Approved')}>Approve</Btn>
            <input className="input" placeholder="Why it is sent back (a few words)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
            <Btn small disabled={busy || note.trim().length < 5} onClick={() => run(() => shared.post(`/library/templates/${encodeURIComponent(t.key)}/approval`, { action: 'send_back', note }), 'Sent back')}>Send back</Btn>
          </>}
        </div>
      </div>

      <div className="lib-sec">
        <b>Version history</b>
        {versions === null ? <div className="lib-sub">Loading…</div> : (
          <table className="table lib-versions"><thead><tr><th>Version</th><th>Who</th><th>When</th><th>What it said</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v.version}><td>v{v.version}{v.current ? ' (now)' : ''}</td><td>{v.byName || '—'}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(v.at)}</td><td className="lib-ver-body">{v.body}{v.note ? <div className="lib-sub">{v.note}</div> : null}</td></tr>)}</tbody></table>
        )}
      </div>
    </GsModal>
  );
}

export { Empty };

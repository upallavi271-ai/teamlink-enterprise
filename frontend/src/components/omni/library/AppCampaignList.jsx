import { useCallback, useEffect, useState } from 'react';
import { shared, errOf } from '../omniApi.js';
import { Banner, Btn, DataTable, GsModal, Kpi, Kpis, Pill, Tabs, TinyBtn, fmtDateTime, fmtNum } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import AppCampaignModal from './AppCampaignModal.jsx';
import './library.css';

// ---------------------------------------------------------------------------
// CAMPAIGNS FROM THE APP SCREENS: the list, the tracking window (every person with a plain status, counts, what happened) and the buttons
// (Ask for approval · Approve · Send · Schedule · Pause · Resume · Cancel · Try failed again · Delete). The server decides which buttons exist (`can`).
//   app: '' = every app (Omni-Channel > Campaigns > From other apps)   or one app (the window of an app screen)
// ---------------------------------------------------------------------------
const TONE = { not_sent: 'draft', waiting: 'warn', changes: 'red', approved: 'scheduled', scheduled: 'scheduled', sending: 'live', paused: 'warn', done: 'live', cancelled: 'draft' };
const ITEM_TONE = { queued: 'draft', sent: 'live', delivered: 'live', failed: 'red', skipped: 'draft', blocked: 'warn', rehearsed: 'scheduled' };

export default function AppCampaignList({ app = '', toast = () => {}, embedded = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  const [appSel, setAppSel] = useState(app);
  const [open, setOpen] = useState(null);
  const load = useCallback(async () => {
    try { setData(await shared.get('/app-campaigns', { app: appSel || undefined, status: status || undefined })); setErr(''); } catch (e) { setErr(errOf(e, 'The campaigns could not be read.')); }
  }, [appSel, status]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const cols = [
    { id: 'name', label: 'Campaign', sort: (c) => c.name.toLowerCase(), search: (c) => `${c.name} ${c.template} ${c.createdByName}`, render: (c) => <div><b>{c.name}</b><div className="lib-sub">{c.template}</div></div> },
    { id: 'app', label: 'From', sort: (c) => c.app, render: (c) => <span className="lib-chip">{c.app}</span> },
    { id: 'people', label: 'People', num: true, sort: (c) => c.people, render: (c) => fmtNum(c.people) },
    { id: 'ch', label: 'Channels', render: (c) => c.channels.join(', ') },
    { id: 'status', label: 'Status', sort: (c) => c.status, render: (c) => <span><Pill tone={TONE[c.status] || 'draft'} dot>{c.statusWords}</Pill>{c.mode === 'rehearsal' ? <div className="lib-sub">Test mode: nothing sent</div> : null}{c.scheduledAt && c.status === 'scheduled' ? <div className="lib-sub">{fmtDateTime(c.scheduledAt)}</div> : null}</span> },
    { id: 'sent', label: 'Sent', num: true, sort: (c) => c.counts.sent + c.counts.delivered + c.counts.rehearsed, render: (c) => fmtNum(c.counts.sent + c.counts.delivered + c.counts.rehearsed) },
    { id: 'failed', label: 'Failed', num: true, sort: (c) => c.counts.failed, render: (c) => fmtNum(c.counts.failed) },
    { id: 'replied', label: 'Replied', num: true, sort: (c) => c.counts.replied, render: (c) => fmtNum(c.counts.replied) },
    { id: 'by', label: 'Made by', sort: (c) => c.createdByName, render: (c) => <span>{c.createdByName}<div className="lib-sub">{fmtDateTime(c.createdAt)}</div></span> },
  ];
  const waiting = data && data.waiting;
  return (
    <div className={`lib${embedded ? ' lib-embedded' : ''}`}>
      {err && <Banner tone="error">{err}</Banner>}
      {waiting > 0 && <Banner tone="warn">{waiting} campaign{waiting === 1 ? ' is' : 's are'} waiting for your approval.</Banner>}
      <div className="lib-filters">
        {!app && (
          <Combo value={appSel} onChange={(e) => setAppSel(e.target.value)} aria-label="App">
            <option value="">All apps</option>
            {['ATS', 'Job Portal', 'HRMS', 'Accounts'].map((a) => <option key={a} value={a}>{a}</option>)}
          </Combo>
        )}
      </div>
      <Tabs value={status} onChange={setStatus} tabs={[['', 'All'], ['not_sent', 'Not sent yet'], ['waiting', 'Waiting for approval'], ['scheduled', 'Scheduled'], ['sending', 'Sending'], ['paused', 'Paused'], ['done', 'Done'], ['cancelled', 'Cancelled']]} />
      <DataTable columns={cols} rows={(data && data.campaigns) || []} loading={!data} persistKey={`appcamps_${app || 'all'}`} onRow={(c) => setOpen(c.id)} searchPlaceholder="Search campaigns…"
        emptyText="No campaigns from the apps yet. Pick people in ATS, Job Portal, HRMS or Accounts and press “Make it a campaign”." />
      {open && <CampaignDetail id={open} onClose={() => { setOpen(null); load(); }} onChanged={load} toast={toast} />}
    </div>
  );
}

function CampaignDetail({ id, onClose, onChanged, toast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [itemStatus, setItemStatus] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [edit, setEdit] = useState(false);
  const load = useCallback(async () => {
    try { setD(await shared.get(`/app-campaigns/${id}`, { status: itemStatus || undefined, page })); setErr(''); } catch (e) { setErr(errOf(e, 'This campaign could not be read.')); }
  }, [id, itemStatus, page]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const run = async (fn, ok) => { setBusy(true); setErr(''); try { const r = await fn(); toast(ok || (r && r.ok) || 'Done'); await load(); onChanged(); return r; } catch (e) { setErr(errOf(e, 'That did not work.')); return null; } finally { setBusy(false); } };
  if (!d) return <GsModal title="Campaign" onClose={onClose}>{err ? <Banner tone="error">{err}</Banner> : 'Loading…'}</GsModal>;
  const c = d.campaign; const k = c.counts;
  const post = (a, body) => shared.post(`/app-campaigns/${id}/${a}`, body);
  return (
    <GsModal title={c.name} sub={`${c.app} · ${c.audience} · ${c.template || ''} · made by ${c.createdByName}`} width={880} onClose={onClose}
      foot={<>
        <Btn onClick={onClose}>Close</Btn>
        {c.can.edit && <Btn disabled={busy} onClick={() => setEdit(true)}>Change</Btn>}
        {c.can.ask && <Btn disabled={busy} onClick={() => run(() => post('submit'))}>Ask for approval</Btn>}
        {c.can.send && <Btn primary disabled={busy} onClick={() => run(() => post('send', { when: 'now' }))}>Send now</Btn>}
        {c.can.pause && <Btn disabled={busy} onClick={() => run(() => post('pause'))}>Pause</Btn>}
        {c.can.resume && <Btn primary disabled={busy} onClick={() => run(() => post('resume'))}>Resume</Btn>}
        {c.can.retry && <Btn disabled={busy} onClick={() => run(() => post('retry'))}>Try the failed ones again</Btn>}
        {c.can.cancel && <Btn danger disabled={busy} onClick={() => { if (window.confirm('Cancel this campaign? Nothing more will be sent.')) run(() => post('cancel')); }}>Cancel campaign</Btn>}
        {c.status === 'not_sent' && c.can.edit && <Btn danger disabled={busy} onClick={async () => { if (window.confirm('Delete this campaign? It was never sent.')) { const r = await run(() => shared.del(`/app-campaigns/${id}`), 'Deleted'); if (r) onClose(); } }}>Delete</Btn>}
      </>}>
      {err && <Banner tone="error">{err}</Banner>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill tone={TONE[c.status] || 'draft'} dot>{c.statusWords}</Pill>
        {c.modeWords && <Pill tone={c.mode === 'rehearsal' ? 'warn' : 'live'}>{c.modeWords}</Pill>}
        {c.scheduledAt && c.status === 'scheduled' && <span className="lib-sub">Goes out on {fmtDateTime(c.scheduledAt)}</span>}
      </div>
      {c.whySendBlocked && <Banner tone="warn">{c.whySendBlocked}</Banner>}
      {c.lastError && <Banner tone="error">The last try failed: {c.lastError}</Banner>}
      {c.can.approve && (
        <div className="lib-box"><b>This campaign is waiting for your approval.</b>
          <div className="lib-inline" style={{ marginTop: 6 }}>
            <Btn primary small disabled={busy} onClick={() => run(() => post('approve', { note }))}>Approve</Btn>
            <input className="input" placeholder="If you send it back: what to change (a few words)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
            <Btn small disabled={busy || note.trim().length < 5} onClick={() => run(() => post('reject', { note }))}>Send back</Btn>
          </div>
        </div>
      )}
      {c.status === 'not_sent' && c.can.schedule && (
        <div className="lib-inline" style={{ margin: '8px 0' }}>
          <span>Send it later:</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Date and time" />
          <Btn small disabled={busy || !when || new Date(when).getTime() < Date.now() + 60000} onClick={() => run(() => post('send', { when: 'later', at: new Date(when).toISOString() }))}>Schedule</Btn>
        </div>
      )}
      <Kpis>
        <Kpi label="People" icon="◎" value={fmtNum(k.people)} meta={`${fmtNum(k.total)} messages`} />
        <Kpi label={c.mode === 'rehearsal' ? 'Rehearsed' : 'Sent'} icon="✓" value={fmtNum(k.sent + k.delivered + k.rehearsed)} meta={k.delivered ? `${fmtNum(k.delivered)} delivered` : (c.mode === 'rehearsal' ? 'Nothing was really sent' : '')} />
        <Kpi label="Failed" icon="!" value={fmtNum(k.failed)} tone={k.failed ? 'down' : undefined} meta={k.failed ? 'See the reasons below' : ''} />
        <Kpi label="Left out" icon="–" value={fmtNum(k.skipped + k.blocked)} meta="No consent, no address, channel not set up ..." />
        <Kpi label="Replied" icon="↩" value={fmtNum(k.replied)} meta="Replies are in Inbox & Replies" />
      </Kpis>
      <div style={{ margin: '12px 0 6px' }}><Tabs value={itemStatus} onChange={(v) => { setItemStatus(v); setPage(1); }} tabs={[['', 'Everyone'], ['rehearsed', 'Rehearsed'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['failed', 'Failed'], ['skipped', 'Left out'], ['blocked', 'Not allowed'], ['queued', 'Waiting']]} /></div>
      <div className="table-scroll"><table className="table"><thead><tr><th>Person</th><th>Channel</th><th>What happened</th><th>When</th></tr></thead>
        <tbody>{d.items.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 18 }}>{c.status === 'not_sent' ? 'Nothing has been prepared yet. The list is made when the campaign is sent.' : 'Nobody here.'}</td></tr>}
          {d.items.map((i) => <tr key={i.id}><td>{i.name}</td><td>{i.channel}</td><td><Pill tone={ITEM_TONE[i.status] || 'draft'}>{i.statusWords}</Pill>{i.reason ? <div className="lib-sub">{i.reason}</div> : null}{i.repliedAt ? <div className="lib-sub">Replied {fmtDateTime(i.repliedAt)}</div> : null}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(i.sentAt)}</td></tr>)}</tbody></table></div>
      {d.total > d.pageSize && <div className="lib-inline" style={{ marginTop: 8 }}><TinyBtn disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</TinyBtn><span className="lib-sub">Page {page} of {Math.ceil(d.total / d.pageSize)}</span><TinyBtn disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>›</TinyBtn></div>}
      <div className="lib-sec"><b>What happened</b>
        <ul className="lib-ul">{d.activity.map((a, i) => <li key={i}>{fmtDateTime(a.at)} · {a.by}: {a.what}{a.note ? ` (${a.note})` : ''}</li>)}</ul></div>
      {edit && <AppCampaignModal app={c.app} audience={c.audience} ids={[]} existing={{ id, name: c.name, channels: c.channels, purposeKey: c.purposeKey }} toast={toast} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); load(); onChanged(); }} />}
    </GsModal>
  );
}

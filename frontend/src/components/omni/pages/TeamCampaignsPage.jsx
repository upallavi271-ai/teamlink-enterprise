import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHead, Kpi, Kpis, Panel, Pill, DataTable, Banner, GsModal, fmtNum, fmtDateTime, pct } from '../ui.jsx';
import omni, { errOf } from '../omniApi.js';

// CAMPAIGNS > My team (founder 2026-11-16): the recruiters of the Team Lead's OWN department, the promotions / campaigns they ran, and for each one how many
// were sent, delivered, read and answered, and to whom. An Admin sees every department and may pick one. The server decides who sees what
// (GET /api/outreach/gs/campaigns/team, outreach/teamView.js): another department's recruiters never reach this page.
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

export default function TeamCampaignsPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [department, setDepartment] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    setBusy(true); setErr('');
    omni.get('/gs/campaigns/team', { from, to, ...(department ? { department } : {}) }).then((r) => setD(r)).catch((e) => { setD(null); setErr(errOf(e, 'The team numbers could not be loaded.')); }).finally(() => setBusy(false));
  }, [from, to, department]);
  useEffect(() => { load(); }, [load]);

  const recCols = useMemo(() => [
    { id: 'name', label: 'Recruiter', render: (r) => <b>{r.name}</b>, sort: (r) => r.name, search: (r) => `${r.name} ${r.department}` },
    { id: 'department', label: 'Department', sort: (r) => r.department },
    { id: 'campaigns', label: 'Campaigns', className: 'num', render: (r) => fmtNum(r.campaigns), sort: (r) => r.campaigns },
    { id: 'sent', label: 'Sent', className: 'num', render: (r) => fmtNum(r.sent), sort: (r) => r.sent },
    { id: 'delivered', label: 'Delivered', className: 'num', render: (r) => fmtNum(r.delivered), sort: (r) => r.delivered },
    { id: 'read', label: 'Read', className: 'num', render: (r) => fmtNum(r.read), sort: (r) => r.read },
    { id: 'replied', label: 'Replies', className: 'num', render: (r) => <span>{fmtNum(r.replied)} <span style={{ fontSize: 10, color: 'var(--muted)' }}>{pct(r.replied, r.sent)}</span></span>, sort: (r) => r.replied },
    { id: 'failed', label: 'Failed', className: 'num', render: (r) => fmtNum(r.failed), sort: (r) => r.failed },
  ], []);
  const rows = useMemo(() => (d ? d.campaigns.filter((c) => !who || c.createdById === who) : []), [d, who]);
  const campCols = useMemo(() => [
    { id: 'name', label: 'Campaign', render: (r) => <span><b>{r.name}</b><div style={{ fontSize: 10, color: 'var(--muted)' }}>{r.kindWords} · {r.channelWords}</div></span>, sort: (r) => r.name, search: (r) => `${r.name} ${r.createdByName}` },
    { id: 'by', label: 'Run by', render: (r) => r.createdByName, sort: (r) => r.createdByName },
    { id: 'status', label: 'Status', render: (r) => <Pill tone="draft">{r.statusWords}</Pill>, sort: (r) => r.statusWords },
    { id: 'recipients', label: 'People', className: 'num', render: (r) => fmtNum(r.recipients), sort: (r) => r.recipients },
    { id: 'sent', label: 'Sent', className: 'num', render: (r) => fmtNum(r.sent), sort: (r) => r.sent },
    { id: 'delivered', label: 'Delivered', className: 'num', render: (r) => fmtNum(r.delivered), sort: (r) => r.delivered },
    { id: 'read', label: 'Read', className: 'num', render: (r) => fmtNum(r.read), sort: (r) => r.read },
    { id: 'replied', label: 'Replies', className: 'num', render: (r) => fmtNum(r.replied), sort: (r) => r.replied },
    { id: 'createdAt', label: 'Created', render: (r) => fmtDateTime(r.createdAt), sort: (r) => r.createdAt },
    { id: 'go', label: '', render: (r) => <button type="button" className="tiny-btn" onClick={() => setOpen(r)}>To whom</button> },
  ], []);

  const t = d ? d.totals : null;
  return (
    <div>
      <PageHead eyebrow="Campaign center" title="My team" lead={d ? `${d.scopeWords}. The campaigns your recruiters ran, how many were sent, delivered, read and answered, and to whom.` : 'The campaigns your recruiters ran, how many were sent, delivered, read and answered, and to whom.'}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>From <input className="select" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>To <input className="select" type="date" value={to} min={from} max={today()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        {d && d.all && (
          <select className="select" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
            <option value="">Every department</option>
            {d.departments.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </PageHead>
      {err && <Banner tone="error">{err} <button type="button" className="ov-banner-link" onClick={load}>Try again</button></Banner>}
      {!d && !err && <div className="card panel" style={{ fontSize: 11, color: 'var(--muted)' }}>{busy ? 'Loading the team numbers…' : ' '}</div>}
      {d && (
        <>
          <Kpis>
            <Kpi label="Recruiters" icon="☷" value={fmtNum(d.recruiters.length)} meta={`${fmtNum(t.campaigns)} campaigns`} />
            <Kpi label="Sent" icon="↗" value={fmtNum(t.sent)} meta={`${fmtNum(t.delivered)} delivered`} />
            <Kpi label="Read" icon="◉" value={fmtNum(t.read)} meta={pct(t.read, t.sent)} />
            <Kpi label="Replies" icon="↩" value={fmtNum(t.replied)} meta={pct(t.replied, t.sent)} />
          </Kpis>
          <Panel title="Recruiters" sub="Click a name to see only that recruiter's campaigns below.">
            <DataTable columns={recCols} rows={d.recruiters} rowKey={(r) => r.id} onRow={(r) => setWho(who === r.id ? '' : r.id)} emptyText="No recruiters in this department." persistKey="omni.team.recruiters" />
          </Panel>
          <Panel title={who ? `Campaigns of ${(d.recruiters.find((r) => r.id === who) || {}).name || ''}` : 'Campaigns of the team'} right={who ? <button type="button" className="tiny-btn" onClick={() => setWho('')}>Show everyone</button> : null}>
            <DataTable columns={campCols} rows={rows} rowKey={(r) => r.id} emptyText="Nobody in the team ran a campaign in these dates." persistKey="omni.team.campaigns" />
          </Panel>
        </>
      )}
      {open && <PeopleModal campaign={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PeopleModal({ campaign, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { omni.get(`/gs/campaigns/team/campaign/${encodeURIComponent(campaign.id)}/people`, { pageSize: 200 }).then(setD).catch((e) => setErr(errOf(e, 'The list could not be loaded.'))); }, [campaign.id]);
  const cols = [
    { id: 'name', label: 'Person', render: (r) => r.name, sort: (r) => r.name, search: (r) => r.name },
    { id: 'channel', label: 'Channel', render: (r) => r.channel },
    { id: 'status', label: 'Status', render: (r) => r.status },
    { id: 'sentAt', label: 'Sent', render: (r) => fmtDateTime(r.sentAt), sort: (r) => r.sentAt || '' },
    { id: 'readAt', label: 'Read', render: (r) => fmtDateTime(r.readAt) },
    { id: 'repliedAt', label: 'Replied', render: (r) => (r.replied ? fmtDateTime(r.repliedAt) : '—'), sort: (r) => r.repliedAt || '' },
  ];
  return (
    <GsModal title={campaign.name} sub={`Run by ${campaign.createdByName}${d ? ` · ${fmtNum(d.total)} people` : ''}`} width={820} onClose={onClose}>
      {err && <Banner tone="error">{err}</Banner>}
      {!d && !err && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading…</div>}
      {d && <DataTable columns={cols} rows={d.people.map((p, i) => ({ ...p, id: i }))} emptyText="Nothing was sent yet." compact />}
    </GsModal>
  );
}

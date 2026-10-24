import { useState } from 'react';
import omni from '../omniApi.js';
import { Panel, Pill, DataTable, Kpis, Kpi, fmtNum, Banner } from '../ui.jsx';
import { useLoad, MonthPick, Err, ago, monthWords } from './adminUtil.jsx';
import { useOmni } from '../omniContext.js';

// Team & Roles > Members: the people of the picked workspace who may use Omni-Channel (an Admin sees everybody, a Department Head the department, a
// Team Lead the team), with their login role, credits given / used / left this month and when they were last active. Read only: people and roles are
// added and changed in Administration > Users (one person, one login).
export default function TeamMembers({ onInvite }) {
  const { acc, dept } = useOmni();
  const [month, setMonth] = useState('');
  const { data, err, loading } = useLoad(() => omni.get('/gs/admin/team/members', month ? { month } : {}), [month, dept]);
  const admin = !!(acc && acc.isAdmin);
  const rows = (data && data.rows) || [];
  const cols = [
    { id: 'name', label: 'Member', sort: (r) => r.name, search: (r) => `${r.name} ${r.code}`, render: (r) => <div><b>{r.name}</b>{r.code ? <div style={{ fontSize: 9, color: 'var(--muted)' }}>{r.code}</div> : null}</div> },
    { id: 'department', label: 'Department', sort: (r) => r.department, render: (r) => r.department || '—' },
    { id: 'role', label: 'Role', sort: (r) => r.levelWords, render: (r) => r.levelWords },
    ...(admin ? [{ id: 'email', label: 'Email', sort: (r) => r.email, render: (r) => r.email || '—' }] : []),
    { id: 'given', label: 'Credits given', className: 'num', sort: (r) => (r.given === null ? 1e12 : r.given), render: (r) => (r.given === null ? 'No limit' : fmtNum(r.given)) },
    { id: 'used', label: 'Credits used', className: 'num', sort: (r) => r.used, render: (r) => fmtNum(r.used) },
    { id: 'left', label: 'Credits left', className: 'num', sort: (r) => (r.left === null ? 1e12 : r.left), render: (r) => (r.left === null ? 'No limit' : <span className={r.left === 0 ? 'sa-over' : ''}>{fmtNum(r.left)}</span>) },
    { id: 'sent', label: 'Messages sent', className: 'num', sort: (r) => r.sent, render: (r) => fmtNum(r.sent) },
    { id: 'testSent', label: 'Test messages', className: 'num', hide: true, sort: (r) => r.testSent, render: (r) => fmtNum(r.testSent) },
    { id: 'status', label: 'Status', sort: (r) => (r.left === 0 ? 1 : 0), render: (r) => (r.given !== null && r.left === 0 ? <Pill tone="red" dot>Credits used up</Pill> : <Pill tone="live" dot>Active</Pill>) },
    { id: 'lastActive', label: 'Last active', sort: (r) => r.lastActive || '', render: (r) => ago(r.lastActive) },
  ];
  return (
    <>
      <Err text={err} />
      {data && (
        <Kpis>
          <Kpi label="People" icon="◔" value={fmtNum(data.totals.people)} meta={data.scopeWords} />
          <Kpi label="Messages sent" icon="✉" value={fmtNum(data.totals.sent)} meta={monthWords(data.month)} />
          <Kpi label="Credits used" icon="✦" value={fmtNum(data.totals.used)} meta="Real messages only" />
          <Kpi label="Test messages" icon="◌" value={fmtNum(data.totals.testSent)} meta="Not charged, nobody got them" />
        </Kpis>
      )}
      <Panel title="Team members" sub={data ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} who can use Omni-Channel · ${data.scopeWords}` : 'Loading…'}
        right={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><MonthPick value={data ? data.month : month} months={data && data.months} onChange={setMonth} /><button type="button" className="btn primary" onClick={onInvite}>＋ Invite member</button></div>}>
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.userId} loading={loading} persistKey="adm_team" searchPlaceholder="Search a name, a code or a department" emptyText="Nobody in this view can use Omni-Channel yet." pageSizes={[10, 25, 50]} />
        {data && data.hiddenNoAccess > 0 && <div className="adm-note">{data.hiddenNoAccess} more {data.hiddenNoAccess === 1 ? 'person has' : 'people have'} a login but a role that cannot use Omni-Channel, so {data.hiddenNoAccess === 1 ? 'that person is' : 'they are'} not listed.</div>}
        <div className="adm-note">Roles and logins are changed in Administration &gt; Users. Credits are the monthly allowance each person was given (Billing shows the rules).</div>
      </Panel>
      {data && data.inviteWords && !rows.length && !loading && <Banner tone="info">{data.inviteWords}</Banner>}
    </>
  );
}

import { useEffect, useState } from 'react';
import omni from '../omniApi.js';
import { Panel, DataTable, fmtDateTime } from '../ui.jsx';
import { useLoad, Err, downloadFile } from './adminUtil.jsx';
import { useOmni } from '../omniContext.js';

// Team & Roles > Audit log: the rows of the app's audit log that belong to Omni-Channel / Outreach (who, what, when). No phone number and no email
// is ever shown: the server hides them. An Admin sees all and may download a CSV; a Department Head / Team Lead sees what their own people did.
export default function TeamAudit() {
  const { toast } = useOmni();
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => { const t = setTimeout(() => { setQLive(q); setPage(1); }, 250); return () => clearTimeout(t); }, [q]);
  const { data, err, loading } = useLoad(() => omni.get('/gs/admin/team/audit', { q: qLive || undefined, from: from || undefined, to: to || undefined, page, pageSize }), [qLive, from, to, page, pageSize]);
  const cols = [
    { id: 'at', label: 'When', render: (r) => fmtDateTime(r.at) },
    { id: 'who', label: 'Who', render: (r) => <b>{r.who}</b> },
    { id: 'action', label: 'What happened', render: (r) => r.action },
    { id: 'detail', label: 'Detail', render: (r) => r.detail || '—' },
  ];
  const csv = async () => { try { await downloadFile('/gs/admin/team/audit.csv', { q: qLive || undefined, from: from || undefined, to: to || undefined }, 'omni-audit-log.csv'); toast('Audit log downloaded'); } catch { toast('You cannot download the audit log.'); } };
  return (
    <Panel title="Audit log" sub={data ? `${data.total} recorded ${data.total === 1 ? 'action' : 'actions'} · ${data.scopeWords}` : 'Loading…'}
      right={data && data.canExport ? <button type="button" className="btn" onClick={csv}>⬇ Export CSV</button> : null}>
      <Err text={err} />
      <DataTable columns={cols} rows={(data && data.rows) || []} rowKey={(r) => r.id} loading={loading} emptyText="Nothing recorded yet. Change a setting and it appears here." pageSizes={[10, 25, 50, 100]} searchPlaceholder="Search what happened or who did it"
        toolbar={<><input type="date" className="search" style={{ minWidth: 0 }} aria-label="From day" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /><input type="date" className="search" style={{ minWidth: 0 }} aria-label="To day" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></>}
        server={{ total: data ? data.total : 0, page, pageSize, onPage: setPage, onPageSize: (n) => { setPageSize(n); setPage(1); }, onQuery: setQ, query: q }} />
      <div className="adm-note">Only Omni-Channel and Outreach actions are listed. Phone numbers and email addresses are never shown here.</div>
    </Panel>
  );
}

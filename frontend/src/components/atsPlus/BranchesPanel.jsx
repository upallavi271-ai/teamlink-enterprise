import { useEffect, useState } from 'react';
import api from '../../api';
import { Notice, Section, Table, useLoad, useAction, row } from './kit.jsx';

// ADMINISTRATION -> ATS SETTINGS -> ORGANISATION -> BRANCHES (market benchmark 05.11). Branches (or group companies) in one
// account: the people, clients and requirements of each branch, a report per branch, and the ids a Branch filter keeps.
// A requirement follows its client's branch unless it is set on its own. Backend: /api/ats-plus/branches (utils/atsPlus/people.js).
export default function BranchesPanel() {
  const { data, err, reload } = useLoad('/ats-plus/branches');
  const [list, setList] = useState([]);
  const [pick, setPick] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const rep = useLoad(`/ats-plus/branches/report?month=${month}${pick ? `&branch=${encodeURIComponent(pick)}` : ''}`);
  const { run, busy, flash } = useAction(() => { reload(); return rep.reload(); });
  const [assign, setAssign] = useState({ entity: 'User', ids: '', branch: '' });
  const [options, setOptions] = useState({ User: [], Client: [], Requirement: [] });
  useEffect(() => { if (data) setList(data.branches.map((b) => ({ ...b }))); }, [data]);
  useEffect(() => {
    api.get('/ats-plus/people-pick').then((r) => setOptions((o) => ({ ...o, User: r.data.people.map((p) => ({ id: p.id, name: `${p.name}${p.branch ? ` (${p.branch})` : ''}` })) }))).catch(() => {});
  }, []);
  const canEdit = data && data.canEdit;
  const set = (i, k, v) => setList((l) => l.map((b, j) => (j === i ? { ...b, [k]: v } : b)));
  const detail = rep.data && rep.data.detail;
  return (
    <>
      <Section title="Branches" note="Branches or group companies inside one TeamLink account. Give people, clients and requirements a branch; reports can then be read branch by branch.">
        <Notice tone="red">{err}</Notice>{flash}
        {list.map((b, i) => (
          <div key={i} style={{ ...row, marginBottom: 6 }}>
            <input aria-label="Branch name" placeholder="Branch name" value={b.name} disabled={!canEdit} onChange={(e) => set(i, 'name', e.target.value)} />
            <input aria-label="City" placeholder="City" value={b.city || ''} disabled={!canEdit} onChange={(e) => set(i, 'city', e.target.value)} />
            <input aria-label="Company" placeholder="Company (if a separate entity)" value={b.company || ''} disabled={!canEdit} onChange={(e) => set(i, 'company', e.target.value)} />
            {canEdit && <button type="button" className="btn btn-sm" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        {canEdit && (
          <div style={row}>
            <button type="button" className="btn btn-sm" onClick={() => setList((l) => [...l, { name: '', city: '', company: '' }])}>+ Add a branch</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/branches', { branches: list }), 'Branches saved.')}>Save branches</button>
          </div>
        )}
      </Section>
      {canEdit && (
        <Section title="Give a branch" note="Pick people (or paste client / requirement ids from their pages) and the branch. Leave the branch empty to clear it.">
          <div style={row}>
            <select aria-label="What" value={assign.entity} onChange={(e) => setAssign({ ...assign, entity: e.target.value, ids: '' })}>
              <option value="User">People</option><option value="Client">Clients</option><option value="Requirement">Requirements</option>
            </select>
            {assign.entity === 'User' && options.User.length ? (
              <select aria-label="People" multiple size={4} value={assign.ids ? assign.ids.split(',') : []} onChange={(e) => setAssign({ ...assign, ids: [...e.target.selectedOptions].map((o) => o.value).join(',') })}>
                {options.User.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : <input aria-label="Ids" placeholder="ids, separated by commas" value={assign.ids} onChange={(e) => setAssign({ ...assign, ids: e.target.value })} />}
            <select aria-label="Branch" value={assign.branch} onChange={(e) => setAssign({ ...assign, branch: e.target.value })}>
              <option value="">No branch</option>{(data ? data.branches : []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !assign.ids} onClick={() => run(() => api.post('/ats-plus/branches/assign', { entity: assign.entity, ids: assign.ids.split(',').map((x) => x.trim()).filter(Boolean), branch: assign.branch || null }), (d) => `Done: ${d.count} record(s).`)}>Save</button>
          </div>
        </Section>
      )}
      <Section title="Report by branch" right={<span style={row}><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        <select aria-label="Open a branch" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">All branches</option>{(data ? data.branches : []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</select></span>}>
        <Notice tone="red">{rep.err}</Notice>
        {rep.data && <Table rows={rep.data.rows} rowKey={(r) => r.branch}
          cols={[{ key: 'branch', label: 'Branch' }, { key: 'people', label: 'People' }, { key: 'clients', label: 'Clients' }, { key: 'liveJobs', label: 'Live jobs' }, { key: 'jobs', label: 'All jobs' }, { key: 'submissions', label: 'Sent to client (month)' }, { key: 'joinings', label: 'Joined (month)' }]} />}
        {detail && (
          <div className="small-muted" style={{ marginTop: 8 }}>
            <div><b>People:</b> {detail.people.map((p) => p.name).join(', ') || '—'}</div>
            <div><b>Clients:</b> {detail.clients.map((c) => c.name).join(', ') || '—'}</div>
            <div><b>Jobs:</b> {detail.jobs.map((j) => j.title).join(', ') || '—'}</div>
          </div>
        )}
      </Section>
    </>
  );
}

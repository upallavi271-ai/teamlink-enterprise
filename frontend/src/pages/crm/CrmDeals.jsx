// CRM > DEALS (2026-11-02): the pipeline board - one column per stage (Prospecting ... Negotiation, Won, Lost) with the
// count and value; drag a deal to move it (Lost asks the reason), or open it to log calls, set follow-ups and, once Won,
// Won / Lost show the last 90 days. A list view is there too (sortable by value / close date).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useCrm, errOf, money, moneyShort, dateOf, istToday, RecordForm, useMoveDeal, staleDays, download } from './crmShared.jsx';

export default function CrmDeals() {
  const { me, toast, openRecord, version } = useCrm();
  const [sp, setSp] = useSearchParams();
  const setOpen = (o) => openRecord(o.kind, o.id);
  const [adding, setAdding] = useState(sp.get('add') === '1');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [view, setView] = useState('board');
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const load = () => api.get('/crm/deals', { params: { q: q || undefined, owner: owner || undefined } })
    .then((r) => { setRows(r.data.rows); setErr(''); }).catch((e) => setErr(errOf(e, 'The deals could not be read.')));
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sp.get('add') === '1') { const n = new URLSearchParams(sp); n.delete('add'); setSp(n, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { move, dialog } = useMoveDeal(() => load());
  const today = istToday();
  const mayMove = () => me.canEdit; // a salesperson only reads their own deals; a sales manager / Admin moves any

  const openDeals = (rows || []).filter((d) => !['Won', 'Lost'].includes(d.stage));
  const card = (d) => (
    <div
      key={d.id}
      className="crm-card"
      draggable={mayMove(d)}
      onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => { setDragId(null); setOver(null); }}
      onClick={() => setOpen({ kind: 'deal', id: d.id })}
      onKeyDown={(e) => { if (e.key === 'Enter') setOpen({ kind: 'deal', id: d.id }); }}
      role="button"
      tabIndex={0}
    >
      <div className="t">{d.title}</div>
      <div className="s">{d.accountName || '—'}{me.seesAll && d.ownerName ? ` · ${d.ownerName}` : ''}</div>
      <div className="v"><span>{moneyShort(d.value)}</span><span className="small-muted" style={{ fontWeight: 500 }}>{d.probability}%</span></div>
      {(d.expectedClose || d.nextTaskDue) && (
        <div className="s">
          {d.expectedClose && <span className={d.expectedClose < today && !['Won', 'Lost'].includes(d.stage) ? 'late' : ''}>Close {dateOf(d.expectedClose)}</span>}
          {d.nextTaskDue && !['Won', 'Lost'].includes(d.stage) && <span className={d.nextTaskDue < today ? 'late' : ''}>{d.expectedClose ? ' · ' : ''}Follow-up {d.nextTaskDue === today ? 'today' : dateOf(d.nextTaskDue)}</span>}
        </div>
      )}
      {staleDays(d, null, me.lists.staleDays) > 0 && <div className="s late" title="Nothing logged for a while">💤 {staleDays(d, null, me.lists.staleDays)} days quiet</div>}
      {d.stage === 'Lost' && d.lostReason && <div className="s">{d.lostReason}</div>}
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Deals</h1>
          <div className="page-sub">{rows ? `${openDeals.length} open · ${money(openDeals.reduce((a, d) => a + (d.value || 0), 0))} in the pipeline` : 'The sales pipeline'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="btn-group" role="group" aria-label="View">
            <button type="button" className={`btn btn-sm${view === 'board' ? ' btn-primary' : ''}`} onClick={() => setView('board')}>Board</button>
            <button type="button" className={`btn btn-sm${view === 'list' ? ' btn-primary' : ''}`} onClick={() => setView('list')}>List</button>
          </div>
          {me.rights && me.rights.export && <button type="button" className="btn" onClick={() => download('/crm/export/deals', `crm-deals-${today}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
          {me.canCreate && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Deal</button>}
        </div>
      </div>
      <div className="filter-row">
        <input type="text" placeholder="Search deal or account" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} aria-label="Search deals" />
        {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        {me.canEdit && view === 'board' && <span className="small-muted">Drag a deal to its new stage.</span>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {rows == null && !err && <div className="small-muted">Loading…</div>}
      {rows && view === 'board' && (
        <div className="crm-board">
          {me.lists.stages.map((s) => {
            const ds = rows.filter((d) => d.stage === s);
            return (
              <div
                key={s}
                className={`crm-col${over === s ? ' drop' : ''}${s === 'Won' ? ' won' : ''}${s === 'Lost' ? ' lost' : ''}`}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(s); } }}
                onDragLeave={() => setOver((o) => (o === s ? null : o))}
                onDrop={(e) => { e.preventDefault(); const d = rows.find((x) => x.id === dragId); setOver(null); setDragId(null); if (d && d.stage !== s) move(d, s); }}
              >
                <div className="crm-col-head"><span>{s} · {ds.length}</span><span className="sum">{moneyShort(ds.reduce((a, d) => a + (d.value || 0), 0))}</span></div>
                {ds.map(card)}
                {!ds.length && <div className="small-muted" style={{ fontSize: 11.5, padding: '4px 4px 10px' }}>{s === 'Won' || s === 'Lost' ? 'None in the last 90 days.' : 'No deals.'}</div>}
              </div>
            );
          })}
        </div>
      )}
      {rows && view === 'list' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Deal</th><th>Account</th><th>Stage</th><th style={{ textAlign: 'right' }}>Value</th><th>Probability</th><th>Expected close</th>{me.seesAll && <th>Owner</th>}</tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={7}><div className="empty"><h3>No deals yet</h3>Convert a lead, or add a deal with "+ Deal".</div></td></tr>}
              {[...rows].sort((a, b) => (b.value || 0) - (a.value || 0)).map((d) => (
                <tr key={d.id} className="row-link" onClick={() => setOpen({ kind: 'deal', id: d.id })}>
                  <td><b>{d.title}</b></td><td>{d.accountName || '—'}</td><td>{d.stage}</td><td style={{ textAlign: 'right' }}>{money(d.value)}</td><td>{d.probability}%</td>
                  <td style={{ color: d.expectedClose && d.expectedClose < today && !['Won', 'Lost'].includes(d.stage) ? 'var(--red)' : undefined }}>{d.expectedClose ? dateOf(d.expectedClose) : '—'}</td>
                  {me.seesAll && <td>{d.ownerName || '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <RecordForm kind="deal" preset={{}} onClose={() => setAdding(false)} onSaved={(row) => { setAdding(false); load(); setOpen({ kind: 'deal', id: row.id }); }} />}
      {dialog}
    </div>
  );
}

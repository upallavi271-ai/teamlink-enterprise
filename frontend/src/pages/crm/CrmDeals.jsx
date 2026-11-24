// CRM > DEALS (2026-11-02): the pipeline board - one column per stage (Prospecting ... Negotiation, Won, Lost) with the
// count and value; drag a deal to move it (Lost asks the reason), or open it to log calls, set follow-ups and, once Won,
// Won / Lost show the last 90 days. A list view is there too (sortable by value / close date). Its third view is Invoices (the invoice
// made when a deal is Won): the CRM stays at five modules (founder 2026-11-14: "4 to 5 modules kantey ekkuva vundakudadhu"), so money lives with deals.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useCrm, errOf, money, moneyShort, dateOf, istToday, RecordForm, useMoveDeal, staleDays, download } from './crmShared.jsx';
import MultiSelect from '../../components/ats/MultiSelect.jsx'; // checkboxes: several values per filter (founder 2026-11-20)
import CrmInvoices from './CrmInvoices.jsx';
import { ListFilterStrip, useListXf } from '../../components/ats/ListFilters.jsx';
// wave D (2026-11-24): several pipelines, days in stage, bulk edit, and the Approvals / Analysis / Contracts views (CrmPlus.jsx)
import { plusOf, daysSince, BulkDealBar, ApprovalsView, AnalysisView, ContractsView } from './CrmPlus.jsx';
const VIEWS = ['board', 'list', 'invoices', 'approvals', 'analysis', 'contracts'];

export default function CrmDeals() {
  const { me, toast, openRecord, version } = useCrm();
  const [sp, setSp] = useSearchParams();
  const setOpen = (o) => openRecord(o.kind, o.id);
  const [adding, setAdding] = useState(sp.get('add') === '1');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [view, setView] = useState(VIEWS.includes(sp.get('view')) ? sp.get('view') : 'board'); // ?view=invoices: the old /crm/invoices address
  const pipelines = plusOf(me).pipelines;
  const [pipe, setPipe] = useState('default'); // the board shows one pipeline at a time
  const [picked, setPicked] = useState([]); // deals ticked in the list (bulk edit)
  const [waiting, setWaiting] = useState(null); // how many approvals wait (the Approvals button)
  useEffect(() => { api.get('/crm/plus/approvals').then((r) => setWaiting(r.data.items.length)).catch(() => setWaiting(null)); }, [version]);
  const curPipe = pipelines.find((p) => p.id === pipe) || pipelines[0];
  const inPipe = (d) => (d.pipelineId || 'default') === (curPipe ? curPipe.id : 'default');
  const dealsView = view === 'board' || view === 'list';
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const xf = useListXf('crmdeals'); // value, stage, expected close, added-on (components/ats/ListFilters.jsx)
  const load = () => api.get('/crm/deals', { params: { q: q || undefined, owner: owner || undefined, ...xf.params } })
    .then((r) => { setRows(r.data.rows); setErr(''); }).catch((e) => setErr(errOf(e, 'The deals could not be read.')));
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, owner, version, xf.key]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {d.stageSince && !['Won', 'Lost'].includes(d.stage) && <div className="s" title="Days on this stage">⏱ {daysSince(d.stageSince)} days in this stage</div>}
      {d.stage === 'Lost' && d.lostReason && <div className="s">{d.lostReason}</div>}
    </div>
  );

  const column = (s) => {
    const ds = (rows || []).filter((d) => d.stage === s && inPipe(d));
    return (
      <div
        key={s}
        className={`crm-col${over === s ? ' drop' : ''}${s === 'Won' ? ' won' : ''}${s === 'Lost' ? ' lost' : ''}`}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(s); } }}
        onDragLeave={() => setOver((o) => (o === s ? null : o))}
        onDrop={(e) => { e.preventDefault(); const d = (rows || []).find((x) => x.id === dragId); setOver(null); setDragId(null); if (d && d.stage !== s) move(d, s); }}
      >
        <div className="crm-col-head"><span>{s} · {ds.length}</span><span className="sum">{moneyShort(ds.reduce((a, d) => a + (d.value || 0), 0))}</span></div>
        {ds.map(card)}
        {!ds.length && <div className="small-muted" style={{ fontSize: 11.5, padding: '4px 4px 10px' }}>{s === 'Won' || s === 'Lost' ? 'None in the last 30 days.' : 'No deals.'}</div>}
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Deals</h1>
          <div className="page-sub">{rows ? `${openDeals.length} open · ${money(openDeals.reduce((a, d) => a + (d.value || 0), 0))} in the pipeline` : 'The sales pipeline'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: '100%' }}>
          <div className="btn-group" role="group" aria-label="View" style={{ flexWrap: 'wrap' }}>
            <button type="button" className={`btn btn-sm${view === 'board' ? ' btn-primary' : ''}`} onClick={() => setView('board')}>Board</button>
            <button type="button" className={`btn btn-sm${view === 'list' ? ' btn-primary' : ''}`} onClick={() => setView('list')}>List</button>
            <button type="button" className={`btn btn-sm${view === 'invoices' ? ' btn-primary' : ''}`} onClick={() => setView('invoices')}>Invoices</button>
            <button type="button" className={`btn btn-sm${view === 'contracts' ? ' btn-primary' : ''}`} onClick={() => setView('contracts')}>Contracts</button>
            <button type="button" className={`btn btn-sm${view === 'approvals' ? ' btn-primary' : ''}`} onClick={() => setView('approvals')}>Approvals{waiting ? ` (${waiting})` : ''}</button>
            <button type="button" className={`btn btn-sm${view === 'analysis' ? ' btn-primary' : ''}`} onClick={() => setView('analysis')}>Analysis</button>
          </div>
          {dealsView && me.rights && me.rights.export && <button type="button" className="btn" onClick={() => download(`/crm/export/deals?${new URLSearchParams(Object.entries({ q, owner, ...xf.params }).filter(([, v]) => v))}`, `crm-deals-${today}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
          {dealsView && me.canCreate && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ Deal</button>}
        </div>
      </div>
      {dealsView && <ListFilterStrip list="crmdeals" xf={xf} total={rows ? rows.length : null} noun="deals" allTime={Object.keys(xf.values).length > 0 || !!(q || owner)} />}
      {dealsView && (
        <div className="filter-row">
          {view === 'board' && pipelines.length > 1 && <select value={curPipe.id} onChange={(e) => setPipe(e.target.value)} style={{ width: 'auto', fontWeight: 600 }} aria-label="Pipeline">{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          <input type="text" placeholder="Search deal or account" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} aria-label="Search deals" />
          {me.seesAll && <MultiSelect label="Owner" allLabel="Everyone" value={owner} onChange={setOwner} options={me.owners.map((o) => ({ value: o.id, label: o.name }))} />}
          {me.canEdit && view === 'board' && <span className="small-muted">Drag a deal to its new stage.</span>}
        </div>
      )}
      {view === 'invoices' && <CrmInvoices embedded />}
      {view === 'approvals' && <ApprovalsView onCount={setWaiting} />}
      {view === 'analysis' && <AnalysisView />}
      {view === 'contracts' && <ContractsView />}
      {err && dealsView && <div className="notice" role="alert">{err}</div>}
      {rows == null && !err && dealsView && <div className="small-muted">Loading…</div>}
      {rows && view === 'board' && (
        <>
          {/* the open stages across the page; Won and Lost are a closed strip underneath, so they are never pushed off the right edge */}
          <div className="crm-board crm-board-open">
            {(curPipe ? curPipe.allStages : me.lists.stages).filter((s) => !['Won', 'Lost'].includes(s)).map(column)}
          </div>
          <div className="section-label" style={{ margin: '14px 0 6px' }}>Closed · last 30 days <span className="small-muted" style={{ fontWeight: 400 }}>(drop a deal here to win or lose it; older ones stay on their account)</span></div>
          <div className="crm-board crm-board-closed">
            {me.lists.stages.filter((s) => ['Won', 'Lost'].includes(s)).map(column)}
          </div>
        </>
      )}
      {rows && view === 'list' && me.canEdit && picked.length > 0 && <BulkDealBar ids={picked} onDone={() => { setPicked([]); load(); }} onClear={() => setPicked([])} />}
      {rows && view === 'list' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr>{me.canEdit && <th><input type="checkbox" style={{ width: 'auto' }} aria-label="Tick all" checked={rows.length > 0 && picked.length === rows.length} onChange={(e) => setPicked(e.target.checked ? rows.map((x) => x.id) : [])} /></th>}<th>Deal</th><th>Account</th><th>Stage</th><th style={{ textAlign: 'right' }}>Value</th><th>Probability</th><th>Expected close</th><th>In stage</th>{me.seesAll && <th>Owner</th>}</tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={9}><div className="empty"><h3>No deals yet</h3>Convert a lead, or add a deal with "+ Deal".</div></td></tr>}
              {[...rows].sort((a, b) => (b.value || 0) - (a.value || 0)).map((d) => (
                <tr key={d.id} className="row-link" onClick={() => setOpen({ kind: 'deal', id: d.id })}>
                  {me.canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(d.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, d.id] : x.filter((y) => y !== d.id)))} aria-label={`Tick ${d.title}`} /></td>}
                  <td><b>{d.title}</b>{pipelines.length > 1 && d.pipelineId ? <div className="small-muted" style={{ fontSize: 11 }}>{(pipelines.find((p) => p.id === d.pipelineId) || {}).name}</div> : null}</td><td>{d.accountName || '—'}</td><td>{d.stage}</td><td style={{ textAlign: 'right' }}>{money(d.value)}</td><td>{d.probability}%</td>
                  <td style={{ color: d.expectedClose && d.expectedClose < today && !['Won', 'Lost'].includes(d.stage) ? 'var(--red)' : undefined }}>{d.expectedClose ? dateOf(d.expectedClose) : '—'}</td>
                  <td className="small-muted">{d.stageSince && !['Won', 'Lost'].includes(d.stage) ? `${daysSince(d.stageSince)} d` : '—'}</td>
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

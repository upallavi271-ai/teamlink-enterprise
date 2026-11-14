// CRM > DASHBOARD (2026-11-02; redesigned after the founder's reference picture, a Zoho-style sales dashboard):
//   Overview      five cards (leads, customers, revenue won, sales target, follow-ups due) with the change against the period
//                 before; the sales funnel with the conversion rate and 6 months of won value; activities today; recent
//                 deals; follow-ups to do; the lead-to-customer flow; closing soon; where leads come from; lost reasons
//   Activities    every call, meeting, email, WhatsApp and note in one list (filters by type, date, salesperson, text)
//   Team & targets / Forecast & funnel   (CrmReports.jsx)
// A salesperson sees their own; a sales manager / Admin / Manager see the whole team, or "Only mine". Period: this month,
// last month, this quarter, this year.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, money, moneyShort, dateOf, dateTimeOf, TaskList, ACT_ICON, RecLink, RecordForm, Pill, DateField, download, istToday } from './crmShared.jsx';
import { TeamTargets, ForecastFunnel, CrmSettings } from './CrmReports.jsx';
import { TicketList } from './CrmSupport.jsx';

// EVERYTHING OPENS HERE (founder 2026-11-02: "ey buttons meedha click chesina, cards meedha click chesina, akkade display
// avvali, vere modules loki vellakudadhu"): a card, a flow step or "View all" opens its list in a window on this page, and a
// row opens the record on top (CrmPage's stack). Nothing on the dashboard goes to another page.
// what: { title, source: leads | deals | accounts | tasks | tickets, params, keep(row) }
function ListWindow({ what, onClose }) {
  const { version } = useCrm();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (what.source === 'tickets') return;
    const get = what.source === 'tasks'
      ? Promise.all(['overdue', 'today'].map((w) => api.get('/crm/tasks', { params: { when: w } }).then((r) => r.data.tasks))).then((a) => a.flat())
      : api.get(`/crm/${what.source}`, { params: what.params || {} }).then((r) => r.data.rows);
    get.then((r) => setRows(what.keep ? r.filter(what.keep) : r)).catch(() => setRows([]));
  }, [what, version]);
  const today = istToday();
  return (
    <Modal title={what.title} size="xwide" onClose={onClose} note={rows ? `${rows.length}` : ''}>
      {what.source === 'tickets' && <TicketList />}
      {what.source !== 'tickets' && !rows && <div className="small-muted">Loading…</div>}
      {rows && !rows.length && <div className="empty"><h3>Nothing here</h3>No {what.source} match.</div>}
      {rows && rows.length > 0 && (
        <div className="tbl-wrap">
          <table>
            {what.source === 'leads' && (
              <>
                <thead><tr><th>Company</th><th>Contact</th><th>Source</th><th>Rating</th><th>Status</th><th>Owner</th></tr></thead>
                <tbody>{rows.map((l) => <tr key={l.id}><td><RecLink kind="lead" id={l.id}><b>{l.company}</b></RecLink><div className="small-muted" style={{ fontSize: 11.5 }}>{[l.industry, l.city].filter(Boolean).join(' · ')}</div></td><td>{l.contactName || '—'}</td><td>{l.source || '—'}</td><td><Pill v={l.rating} /></td><td><Pill v={l.status} /></td><td>{l.ownerName || '—'}</td></tr>)}</tbody>
              </>
            )}
            {what.source === 'deals' && (
              <>
                <thead><tr><th>Deal</th><th>Account</th><th>Stage</th><th style={{ textAlign: 'right' }}>Value</th><th>Close</th><th>Owner</th></tr></thead>
                <tbody>{rows.map((x) => <tr key={x.id}><td><RecLink kind="deal" id={x.id}><b>{x.title}</b></RecLink></td><td>{x.accountName || '—'}</td><td><Pill v={x.stage} /></td><td style={{ textAlign: 'right' }}>{money(x.value)}</td><td style={{ color: x.expectedClose && x.expectedClose < today && !['Won', 'Lost'].includes(x.stage) ? 'var(--red)' : undefined }}>{x.expectedClose ? dateOf(x.expectedClose) : '—'}</td><td>{x.ownerName || '—'}</td></tr>)}</tbody>
              </>
            )}
            {what.source === 'accounts' && (
              <>
                <thead><tr><th>Company</th><th>Type</th><th>Contacts</th><th>Open deals</th><th>Owner</th></tr></thead>
                <tbody>{rows.map((a) => <tr key={a.id}><td><RecLink kind="account" id={a.id}><b>{a.name}</b></RecLink><div className="small-muted" style={{ fontSize: 11.5 }}>{[a.industry, a.city].filter(Boolean).join(' · ')}</div></td><td><Pill v={a.kind} /></td><td>{a.contacts}</td><td>{a.openDeals ? `${a.openDeals} · ${moneyShort(a.openValue)}` : '—'}</td><td>{a.ownerName || '—'}</td></tr>)}</tbody>
              </>
            )}
            {what.source === 'tasks' && (
              <>
                <thead><tr><th>Follow-up</th><th>On</th><th>Due</th><th>Owner</th></tr></thead>
                <tbody>{rows.map((t) => <tr key={t.id}><td>{t.title}</td><td>{t.recordName ? <RecLink kind={t.recordKind} id={t.recordId}>{t.recordName}</RecLink> : '—'}</td><td style={{ color: t.dueDate < today ? 'var(--red)' : undefined, fontWeight: 600 }}>{t.dueDate === today ? 'Today' : `${dateOf(t.dueDate)} · late`}{t.dueTime ? ` ${t.dueTime}` : ''}</td><td>{t.ownerName || '—'}</td></tr>)}</tbody>
              </>
            )}
          </table>
        </div>
      )}
    </Modal>
  );
}

// small line icons for the cards and lists (currentColor)
const I = {
  users: <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 9v-1a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8" />,
  hand: <path d="M2 11l4-4 4 2 3-3 4 1 5 5-4 4-3-1-3 3-4-1zM9 9l4 4M12 16l-2-2" />,
  rupee: <path d="M6 3h12M6 8h12M14 21L6 13h3a5 5 0 0 0 0-10" />,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>,
  check: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 3v3h6V3M8 13l3 3 5-6" /></>,
};
const Icon = ({ name, size = 26 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[name]}</svg>;
const KIND_COLOR = { call: 'var(--crm-green)', meeting: 'var(--crm-blue)', email: 'var(--crm-violet)', whatsapp: 'var(--crm-teal)', note: 'var(--crm-orange)', task: 'var(--crm-orange)' };
const STAGE_TONE = { Won: 'joined', Lost: 'rejected', Negotiation: 'interview', 'Proposal sent': 'offer' };

function Delta({ v }) {
  if (v == null) return <span className="crm-delta">new</span>;
  return <span className={`crm-delta${v < 0 ? ' down' : ''}`}>{v >= 0 ? '↑' : '↓'} {Math.abs(v)}%</span>;
}

function Kpi({ icon, color, label, value, children, onOpen }) {
  return (
    <div className="crm-kpi" role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} onClick={onOpen} onKeyDown={onOpen ? (e) => { if (e.key === 'Enter') onOpen(); } : undefined}>
      <div className="ic" style={{ background: color }}><Icon name={icon} /></div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="l">{label}</div>
        <div className="v">{value}</div>
        {children}
      </div>
    </div>
  );
}

function Bars({ rows, value, label = (r) => r.name, right }) {
  const max = Math.max(1, ...rows.map(value));
  if (!rows.length) return <div className="small-muted">Nothing yet.</div>;
  return (
    <div className="crm-bars">
      {rows.map((r) => (
        <div className="row" key={label(r)}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(r)}</div>
          <div className="bar"><span style={{ width: `${(value(r) / max) * 100}%` }} /></div>
          <div className="n">{right ? right(r) : value(r)}</div>
        </div>
      ))}
    </div>
  );
}

const Head = ({ title, onClick, link = 'View all' }) => (
  <div className="crm-card-head">
    <h3>{title}</h3>
    {onClick && <button type="button" className="crm-linkbtn" onClick={onClick}>{link} →</button>}
  </div>
);

const FUNNEL_COLORS = ['var(--crm-blue)', 'var(--crm-green)', 'var(--crm-orange)', 'var(--crm-violet)', 'var(--crm-navy)'];

function Overview({ mine, period, onTab }) {
  const navigate = useNavigate();
  const { me, version } = useCrm();
  const [win, setWin] = useState(null); // the list window open on this page
  const [o, setO] = useState(null);
  const [d, setD] = useState(null);
  const [sup, setSup] = useState(null);
  const [sample, setSample] = useState(null);
  const [err, setErr] = useState('');
  const { toast } = useCrm();
  const load = () => {
    const params = mine ? { mine: 1 } : {};
    api.get('/crm/sample').then((r) => setSample(r.data)).catch(() => setSample(null)); // only a manager / Admin may ask; anyone else just gets no banner
    api.get('/crm/tickets', { params: { status: 'open' } }).then((r) => setSup(r.data.stats)).catch(() => setSup(null));
    api.get('/crm/overview', { params: { ...params, period } }).then((r) => { setO(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The dashboard could not be read.')));
    api.get('/crm/dashboard', { params }).then((r) => setD(r.data)).catch(() => {});
  };
  useEffect(() => { load(); }, [mine, period, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const own = mine ? { owner: me.userId } : {};
  const W = {
    leads: { title: 'All leads (newest first)', source: 'leads', params: { status: 'all', ...own } },
    customers: { title: 'Customers', source: 'accounts', params: { kind: 'Client', ...own } },
    won: { title: 'Won deals (last 12 months)', source: 'deals', params: { ...own, closedDays: 366 }, keep: (x) => x.stage === 'Won' },
    open: { title: 'Open deals', source: 'deals', params: own, keep: (x) => !['Won', 'Lost'].includes(x.stage) },
    deals: { title: 'All deals (closed: last 30 days)', source: 'deals', params: own },
    tasks: { title: 'Follow-ups due (late and today)', source: 'tasks' },
    tickets: { title: 'Customer support tickets', source: 'tickets' },
    flow_leads: { title: 'Lead generation: new and contacted leads', source: 'leads', params: own, keep: (l) => ['New', 'Contacted'].includes(l.status) },
    flow_qualified: { title: 'Qualified leads', source: 'leads', params: { status: 'Qualified', ...own } },
    flow_convert: { title: 'Converted leads', source: 'leads', params: { status: 'Converted', ...own } },
    flow_pipeline: { title: 'Sales pipeline: open deals', source: 'deals', params: own, keep: (x) => !['Won', 'Lost'].includes(x.stage) },
    flow_customer: { title: 'Customers (won accounts)', source: 'accounts', params: { kind: 'Client', ...own } },
    sources: { title: 'Open leads', source: 'leads', params: own },
  };
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!o) return <div className="small-muted">Loading…</div>;
  const c = o.cards;
  const maxTrend = Math.max(1, ...o.trend.map((t) => t.value));
  const top = Math.max(1, o.funnel[0].count);
  const total = sample && sample.counts ? Object.values(sample.counts).reduce((a, n) => a + n, 0) : 0;
  const removeSample = async () => {
    if (!window.confirm(`Remove the ${total} sample records (leads, deals, accounts, follow-ups ...) from the CRM? Your own records stay.`)) return;
    try { await api.delete('/crm/sample'); toast('The sample data is removed.'); load(); } catch (e) { toast(errOf(e, 'The sample data could not be removed.')); }
  };
  return (
    <>
      {sample && sample.loaded && (
        <div className="notice" role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderColor: 'var(--amber, #d97706)' }}>
          <span><b>This CRM still has sample data</b> ({total} records, every owner shown as the sample team). Remove it before the team starts, or these numbers are not real.</span>
          <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={removeSample}>Remove sample data</button>
        </div>
      )}
      <div className="crm-kpis">
        <Kpi icon="users" color="var(--crm-blue)" label={`New leads · ${o.periodLabel.toLowerCase()}`} value={c.leads.value.toLocaleString('en-IN')} onOpen={() => setWin(W.leads)}><Delta v={c.leads.delta} /> <span className="crm-sub">{c.leads.open} open in all</span></Kpi>
        <Kpi icon="hand" color="var(--crm-green)" label="Total customers" value={c.customers.value.toLocaleString('en-IN')} onOpen={() => setWin(W.customers)}><span className="crm-sub">+{c.customers.newInPeriod} won {o.periodLabel.toLowerCase()}</span></Kpi>
        <Kpi icon="rupee" color="var(--crm-violet)" label={`Won value · ${o.periodLabel.toLowerCase()}`} value={moneyShort(c.revenue.value)} onOpen={() => setWin(W.won)}><Delta v={c.revenue.delta} /> <span className="crm-sub">{c.revenue.deals} deal{c.revenue.deals === 1 ? '' : 's'}</span></Kpi>
        <Kpi icon="target" color="var(--crm-orange)" label="Sales target" value={c.target.value ? moneyShort(c.target.value) : 'Not set'} onOpen={() => onTab('team')}>
          {c.target.value ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <div className="crm-progress"><span style={{ width: `${Math.min(100, c.target.pct || 0)}%` }} /></div>
              <b style={{ fontSize: 12.5 }}>{c.target.pct}%</b>
            </div>
          ) : <span className="crm-sub">{me.canAssign ? 'Set it in Team & targets' : 'Your sales manager sets it'}</span>}
        </Kpi>
        <Kpi icon="check" color="var(--crm-teal)" label="Follow-ups due" value={c.followUps.today + c.followUps.late} onOpen={() => setWin(W.tasks)}>
          {c.followUps.late ? <span className="crm-delta down">{c.followUps.late} late</span> : <span className="crm-sub">all on time</span>}
        </Kpi>
      </div>
      {o.cash && (
        <>
          <div className="small-muted" style={{ fontSize: 12, margin: '10px 2px 4px' }}><b>Money · {o.periodLabel.toLowerCase()}</b>: booked is deals won, invoiced is invoices sent out (with tax), collected is money that actually came in.</div>
          <div className="crm-kpis">
            <Kpi icon="rupee" color="var(--crm-violet)" label="Booked (deals won)" value={moneyShort(o.cash.booked.value)} onOpen={() => setWin(W.won)}><Delta v={o.cash.booked.delta} /> <span className="crm-sub">{o.cash.booked.deals} deal{o.cash.booked.deals === 1 ? '' : 's'}</span></Kpi>
            <Kpi icon="check" color="var(--crm-blue)" label="Invoiced (sent, with tax)" value={moneyShort(o.cash.invoiced.value)} onOpen={() => navigate('/crm/deals?view=invoices')}>
              <span className="crm-sub">{o.cash.invoiced.invoices} invoice{o.cash.invoiced.invoices === 1 ? '' : 's'}{o.cash.drafts.invoices ? ` · ${moneyShort(o.cash.drafts.value)} in ${o.cash.drafts.invoices} draft${o.cash.drafts.invoices === 1 ? '' : 's'} not sent` : ''}</span>
            </Kpi>
            <Kpi icon="rupee" color="var(--crm-green)" label="Collected (money received)" value={moneyShort(o.cash.collected.value)} onOpen={() => navigate('/crm/deals?view=invoices')}><Delta v={o.cash.collected.delta} /> <span className="crm-sub">{o.cash.collected.payments} payment{o.cash.collected.payments === 1 ? '' : 's'}</span></Kpi>
            <Kpi icon="target" color="var(--crm-orange)" label="Still to collect (all invoices)" value={moneyShort(o.cash.toCollect.value)} onOpen={() => navigate('/crm/deals?view=invoices')}>
              {o.cash.toCollect.overdueInvoices ? <span className="crm-delta down">{moneyShort(o.cash.toCollect.overdueValue)} overdue · {o.cash.toCollect.overdueInvoices} invoice{o.cash.toCollect.overdueInvoices === 1 ? '' : 's'}</span> : <span className="crm-sub">nothing overdue</span>}
            </Kpi>
            {o.cash.wonNoInvoice > 0 && <Kpi icon="hand" color="var(--crm-teal)" label="Won, no invoice yet" value={o.cash.wonNoInvoice} onOpen={() => navigate('/crm/deals?view=invoices')}><span className="crm-sub">open Invoices, then Create missing invoices</span></Kpi>}
          </div>
        </>
      )}

      <div className="crm-grid3">
        <div className="crm-card">
          <Head title={`Lead funnel · leads added ${o.periodLabel.toLowerCase()}`} onClick={() => setWin(W.leads)} link="View leads" />
          <div className="crm-funnel-wrap">
            <div className="crm-funnel">
              {o.funnel.map((f, i) => (
                <div key={f.step} className="crm-funnel-step" style={{ background: FUNNEL_COLORS[i], width: `${100 - i * 11}%`, opacity: f.count || i === 0 ? 1 : 0.55 }} title={`${f.step}: ${f.count}`}>
                  <span>{f.step}</span><b>{f.count.toLocaleString('en-IN')}</b>
                </div>
              ))}
            </div>
            <div className="crm-funnel-side">
              <div className="small-muted">Conversion rate</div>
              <div className="crm-big">{o.conversion != null ? `${o.conversion}%` : '—'}</div>
              <div className="small-muted" style={{ fontSize: 11 }}>leads added {o.periodLabel.toLowerCase()} that are won</div>
              <div className="crm-trend" title="Won value, last 6 months">
                {o.trend.map((t) => <span key={t.month} style={{ height: `${Math.max(4, (t.value / maxTrend) * 100)}%` }} title={`${t.month}: ${money(t.value)} (${t.won})`} />)}
              </div>
              <div className="small-muted" style={{ fontSize: 10.5 }}>won value, 6 months</div>
            </div>
          </div>
          {/* the funnel above is only the leads ADDED in the period; this is every lead as it stands now, so the two never look like a mismatch */}
          {d && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 8 }}><b>All leads right now:</b> {['New', 'Contacted', 'Qualified'].map((k) => `${k} ${(d.leads.byStatus.find((x) => x.name === k) || {}).count || 0}`).join(' · ')}</div>}
          <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}><b>Deal pipeline:</b> open {moneyShort(c.pipeline.value)} in {c.pipeline.open} deal{c.pipeline.open === 1 ? '' : 's'} · likely {moneyShort(c.pipeline.weighted)}</div>
        </div>

        <div className="crm-card">
          <Head title="Activities today" onClick={() => onTab('activities')} />
          {!o.todayList.length && <div className="small-muted">Nothing logged or due today yet.</div>}
          {o.todayList.slice(0, 7).map((x) => (
            <div key={`${x.type}${x.id}`} className="crm-today">
              <span className="dot" style={{ color: KIND_COLOR[x.kind] || 'var(--ink-soft)' }} aria-hidden="true">{x.kind === 'task' ? (x.done ? '☑' : '🔔') : ACT_ICON[x.kind]}</span>
              <span className="t">{x.time || '—'}</span>
              <span className="s">
                <span style={{ textDecoration: x.type === 'task' && x.done ? 'line-through' : undefined }}>{x.title}</span>
                {x.recordName && <> · <RecLink kind={x.recordKind} id={x.recordId}>{x.recordName}</RecLink></>}
              </span>
            </div>
          ))}
        </div>

        <div className="crm-card">
          <Head title="Recent deals" onClick={() => setWin(W.deals)} />
          {!o.recentDeals.length && <div className="small-muted">No deals yet. Convert a lead or add a deal.</div>}
          {o.recentDeals.map((x) => (
            <RecLink key={x.id} kind="deal" id={x.id} className="crm-deal-row">
              <span className="b" aria-hidden="true">🏢</span>
              <span className="n">{x.accountName || x.title}<small>{x.accountName ? x.title : ''}</small></span>
              <span className="v">{money(x.value)}</span>
              <span className={`status ${STAGE_TONE[x.stage] || 'review'}`}>{x.stage}</span>
            </RecLink>
          ))}
        </div>
      </div>

      <div className="crm-grid2">
        <div className="crm-card">
          <Head title={`Follow-ups to do${d ? ` (${d.followUps.overdue.length + d.followUps.today.length})` : ''}`} />
          {!d && <div className="small-muted">Loading…</div>}
          {d && (
            <>
              {d.followUps.overdue.length > 0 && <div className="small-muted" style={{ color: 'var(--red)', fontWeight: 600, marginBottom: 2 }}>Late</div>}
              {d.followUps.overdue.length > 0 && <TaskList tasks={d.followUps.overdue} showRecord onChanged={load} canEdit={me.canEdit} />}
              <div className="small-muted" style={{ fontWeight: 600, margin: '8px 0 2px' }}>Today</div>
              <TaskList tasks={d.followUps.today} showRecord onChanged={load} canEdit={me.canEdit} />
              {d.followUps.upcoming.length > 0 && (<><div className="small-muted" style={{ fontWeight: 600, margin: '10px 0 2px' }}>Next 7 days</div><TaskList tasks={d.followUps.upcoming} showRecord onChanged={load} canEdit={me.canEdit} /></>)}
            </>
          )}
        </div>
        <div className="crm-card">
          <Head title="CRM business flow" />
          <div className="small-muted" style={{ marginTop: -6, marginBottom: 10, fontSize: 12 }}>Lead to loyal customer</div>
          <div className="crm-flow">
            {o.flow.map((f, i) => (
              <div key={f.key} className="crm-flow-step-wrap">
                <button type="button" onClick={() => setWin(W[`flow_${f.key}`])} className="crm-flow-step" style={{ '--tone': FUNNEL_COLORS[i] }}>
                  <span className="c">{f.count.toLocaleString('en-IN')}</span>
                  <b>{f.label}</b>
                  <small>{f.sub}</small>
                </button>
                {i < o.flow.length - 1 && <span className="arrow" aria-hidden="true">→</span>}
              </div>
            ))}
          </div>
          {sup && (
            <button type="button" onClick={() => setWin(W.tickets)} className="crm-support-line">
              <span aria-hidden="true">🎧</span> <b>Customer support</b>
              <span>{sup.open} open</span>
              <span style={{ color: sup.late ? 'var(--red)' : undefined }}>{sup.late} reply late</span>
              <span>{sup.resolved30} resolved (30 days)</span>
              <span style={{ marginLeft: 'auto', color: 'var(--crm-blue)', fontWeight: 600 }}>Tickets →</span>
            </button>
          )}
          {/* a close date that has passed is not "closing in the next 30 days": it is its own list, to be updated (founder 2026-11-14) */}
          {d && d.overdueClose && d.overdueClose.length > 0 && (
            <>
              <div className="section-label" style={{ color: 'var(--red)' }}>Close date passed · {d.overdueCloseCount} deal{d.overdueCloseCount === 1 ? '' : 's'} - update the date or move the deal</div>
              {d.overdueClose.slice(0, 5).map((x) => (
                <div key={x.id} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
                  <div style={{ flex: 1, minWidth: 0 }}><RecLink kind="deal" id={x.id}>{x.title}</RecLink><div className="small-muted" style={{ fontSize: 11.5 }}>{x.accountName || ''} · {x.stage}</div></div>
                  <div style={{ textAlign: 'right' }}><b>{moneyShort(x.value)}</b><div className="small-muted" style={{ fontSize: 11.5, color: 'var(--red)' }}>was {dateOf(x.expectedClose)}</div></div>
                </div>
              ))}
            </>
          )}
          {d && d.closingSoon.length > 0 && (
            <>
              <div className="section-label">Closing in the next 30 days</div>
              {d.closingSoon.slice(0, 5).map((x) => (
                <div key={x.id} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
                  <div style={{ flex: 1, minWidth: 0 }}><RecLink kind="deal" id={x.id}>{x.title}</RecLink><div className="small-muted" style={{ fontSize: 11.5 }}>{x.accountName || ''} · {x.stage}</div></div>
                  <div style={{ textAlign: 'right' }}><b>{moneyShort(x.value)}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{dateOf(x.expectedClose)}</div></div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {win && <ListWindow what={win} onClose={() => setWin(null)} />}
      {d && (
        <div className="crm-grid2">
          <div className="crm-card">
            <Head title="Where leads come from" onClick={() => setWin(W.sources)} link="Open leads" />
            <Bars rows={d.leads.bySource} value={(r) => r.count} />
          </div>
          <div className="crm-card">
            <Head title="Pipeline by stage" onClick={() => setWin(W.open)} link="Open deals" />
            <Bars rows={d.byStage} label={(r) => (['Won', 'Lost'].includes(r.stage) ? `${r.stage} · this month` : r.stage)} value={(r) => r.value || 0} right={(r) => `${r.count} · ${moneyShort(r.value)}`} />
            {d.lostReasons.length > 0 && (<><div className="section-label">Why deals were lost (90 days)</div><Bars rows={d.lostReasons} value={(r) => r.count} /></>)}
          </div>
        </div>
      )}
    </>
  );
}

function Activities({ mine }) {
  const { me, toast } = useCrm();
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  const [d, setD] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get('/crm/activities', { params: { kind: kind || undefined, from: from || undefined, to: to || undefined, owner: (mine ? me.userId : owner) || undefined, q: q || undefined } })
        .then((r) => setD(r.data)).catch((e) => toast(errOf(e, 'The activities could not be read.')));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [kind, from, to, owner, q, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const KINDS = [['', 'All'], ...Object.entries(me.lists.activityKinds)];
  return (
    <div className="crm-card">
      <div className="filter-row">
        {KINDS.map(([k, l]) => (
          <button key={k || 'all'} type="button" className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} onClick={() => setKind(k)}>
            {k ? `${ACT_ICON[k]} ` : ''}{l}{d && k && d.byKind[k] ? ` · ${d.byKind[k]}` : ''}
          </button>
        ))}
        <DateField value={from} onChange={setFrom} aria-label="From" style={{ width: 150 }} />
        <DateField value={to} onChange={setTo} aria-label="To" style={{ width: 150 }} />
        {me.seesAll && !mine && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Salesperson"><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        <input type="text" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} aria-label="Search activities" />
        {me.rights && me.rights.export && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => download('/crm/export/activities', `crm-activities-${istToday()}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
      </div>
      {!d && <div className="small-muted">Loading…</div>}
      {d && !d.rows.length && <div className="empty"><h3>Nothing here</h3>Calls, meetings, emails, WhatsApp messages and notes logged on leads, deals and accounts show up here.</div>}
      {d && d.rows.map((a) => (
        <div key={a.id} className="crm-act-row">
          <span className="ic" style={{ background: KIND_COLOR[a.kind] }} aria-hidden="true">{ACT_ICON[a.kind]}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5 }}><b>{a.subject || me.lists.activityKinds[a.kind]}</b>{a.recordName && <> · <RecLink kind={a.recordKind} id={a.recordId}>{a.recordName}</RecLink></>}</div>
            {a.note && <div className="small-muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{a.note}</div>}
          </div>
          <div className="small-muted" style={{ fontSize: 11.5, textAlign: 'right', whiteSpace: 'nowrap' }}>{dateTimeOf(a.at)}<br />{a.byName || ''}</div>
        </div>
      ))}
    </div>
  );
}

export default function CrmDashboard() {
  const { me, reloadMe, toast, openRecord } = useCrm();
  const [sp] = useSearchParams();
  const [adding, setAdding] = useState(null); // 'lead' | 'deal' - the form opens here
  const [mine, setMine] = useState(!me.seesAll);
  const [period, setPeriod] = useState('month');
  const [tab, setTab] = useState(sp.get('tab') || 'overview'); // overview | activities | team | forecast
  const [settings, setSettings] = useState(false);
  return (
    <div className="page crm-page">
      <div className="page-head">
        <div>
          <h1>Sales Dashboard</h1>
          <div className="page-sub">Welcome back, {String(me.name || '').split(' ')[0] || 'there'} · {mine ? 'my sales' : 'whole sales team'} · {dateOf(istToday())}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {me.seesAll && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontWeight: 500 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ width: 'auto' }} /> Only mine
            </label>
          )}
          {tab === 'overview' && (
            <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto' }}>
              <option value="month">This month</option><option value="last_month">Last month</option><option value="quarter">This quarter</option><option value="year">This year</option>
            </select>
          )}
          {me.canAssign && <button type="button" className="btn" onClick={() => setSettings(true)} title="Sales team, sources, lost reasons, stage probabilities">⚙ Settings</button>}
          {me.rights && me.rights.export && <select defaultValue="" onChange={(e) => { const k = e.target.value; e.target.value = ''; if (k) download(`/crm/export/${k}`, `crm-${k}-${istToday()}.csv`).catch(() => toast('The download did not work.')); }} aria-label="Download" style={{ width: 'auto' }}>
            <option value="">Download…</option><option value="leads">Leads</option><option value="deals">Deals</option><option value="accounts">Accounts</option><option value="contacts">Contacts</option><option value="activities">Calls, meetings, notes</option><option value="tasks">Follow-ups</option>
          </select>}
          {me.canCreate && <button type="button" className="btn" onClick={() => setAdding('lead')}>+ Lead</button>}
          {me.canCreate && <button type="button" className="btn btn-primary" onClick={() => setAdding('deal')}>+ Deal</button>}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['overview', 'Overview'], ['activities', 'Activities'], ...(!me.seesAll || (me.rights && me.rights.reports) ? [['team', me.seesAll ? 'Team & targets' : 'My month & target']] : []), ...(me.rights && me.rights.reports ? [['forecast', 'Forecast & funnel']] : [])].map(([k, l]) => (
          <div key={k} role="tab" tabIndex={0} aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === 'Enter') setTab(k); }}>{l}</div>
        ))}
      </div>
      {tab === 'overview' && <Overview mine={mine} period={period} onTab={setTab} />}
      {tab === 'activities' && <Activities mine={mine} />}
      {tab === 'team' && <TeamTargets />}
      {tab === 'forecast' && <ForecastFunnel />}
      {adding && <RecordForm kind={adding} preset={adding === 'deal' ? {} : { source: '' }} onClose={() => setAdding(null)} onSaved={(row) => { const k = adding; setAdding(null); openRecord(k, row.id); }} />}
      {settings && <CrmSettings onClose={() => setSettings(false)} onSaved={() => { setSettings(false); reloadMe(); }} />}
    </div>
  );
}


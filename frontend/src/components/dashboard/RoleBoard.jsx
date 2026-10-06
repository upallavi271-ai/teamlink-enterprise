import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import Modal from '../Modal.jsx';
import { ChartCard, BarChart, DataTable } from '../charts';
import './dashboard.css';

// ---------------------------------------------------------------------------
// ONE ROLE BOARD — the user's four parts (spec 2026-09-29):
//   (A) top counts   (B) pending actions   (C) lists / widgets   (D) quick buttons
// The server builds the board (backend/src/utils/roleDashboard.js); this
// draws it. EVERY count is clickable: `to` opens the list page that shows the
// same number, `drill` opens the exact rows behind it (?list=<set> — the same
// server function counted them). Red = overdue, amber = due today / waiting,
// green = fine.
// ---------------------------------------------------------------------------

export const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
export const rupees = (n) => (n === null || n === undefined ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const shortDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};
const dateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const timeOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};
const TONE_WORD = { red: 'Overdue', amber: 'Due today', green: 'On time' };

function Score({ v }) {
  if (v === null || v === undefined) return <span className="cell-muted">—</span>;
  const cls = v >= 70 ? 'hi' : v >= 40 ? 'mid' : 'lo';
  return <span className={`rdb-score ${cls}`}>{v}</span>;
}

function DueChip({ row }) {
  if (row.note && row.tone) return <StatusChip tone={row.tone}>{row.note}</StatusChip>;
  if (row.due) {
    if (row.tone === 'red') return <StatusChip tone="red" title={`Was due ${row.due}`}>Overdue · {shortDate(row.due)}</StatusChip>;
    if (row.tone === 'amber') return <StatusChip tone="amber">Due today</StatusChip>;
    return <StatusChip tone="green">{shortDate(row.due)}</StatusChip>;
  }
  if (row.note) return <span className="rdb-sub">{row.note}</span>;
  return <span className="cell-muted">—</span>;
}

function CandLink({ r }) {
  return r.candidateId
    ? <Link className="rdb-name" to={`/candidates/${r.candidateId}`}>{r.candidate}</Link>
    : <span>{r.candidate || '—'}</span>;
}
function ReqCell({ r }) {
  return (
    <>
      {r.requirementId ? <Link className="rdb-name" style={{ fontWeight: 500 }} to={`/requirements/${r.requirementId}`}>{r.requirement}</Link> : (r.requirement || '—')}
      {r.client && <div className="rdb-sub">{r.clientId ? <Link to={`/clients/${r.clientId}`}>{r.client}</Link> : r.client}</div>}
    </>
  );
}

// ---- (A) ---------------------------------------------------------------------
function CountTile({ c, openDrill, partValues }) {
  // A tile with parts (Admin "Failed / duplicate entries") totals its parts,
  // some of which the browser reads from existing admin endpoints.
  const partSum = c.parts ? c.parts.reduce((n, p) => n + (Number(p.value ?? partValues[p.id]) || 0), 0) : null;
  const shown = c.parts ? partSum : c.value;
  const val = c.money ? rupees(shown) : c.unit === '%' ? (shown === null ? '—' : `${shown}%`) : fmt(shown);
  const tone = c.tone && shown ? c.tone : (c.parts && shown ? 'red' : '');
  const title = c.to ? `Open the list (${c.label})` : 'Show the list behind this number';
  return (
    <div className={`rdb-count${tone ? ` t-${tone}` : ''}`}>
      <div className="rdb-count-l">{c.label}</div>
      {c.to
        ? <Link className="rdb-count-n" to={c.to} title={title}>{val}</Link>
        : c.drill
          ? <button type="button" className="rdb-count-n" onClick={() => openDrill(c.drill)} title={title}>{val}</button>
          : <span className="rdb-count-n" style={{ cursor: 'default' }}>{val}</span>}
      {c.sub && (
        <div className="rdb-count-s">
          {c.subDrill ? <button type="button" onClick={() => openDrill(c.subDrill)}>{c.sub}</button>
            : c.subTo ? <Link to={c.subTo}>{c.sub}</Link>
              : c.to && c.drill ? <button type="button" onClick={() => openDrill(c.drill)} title="Show the rows">{c.sub}</button>
                : c.sub}
        </div>
      )}
      {c.parts && (
        <div className="rdb-parts">
          {c.parts.map((p) => {
            const v = p.value ?? partValues[p.id];
            return <Link key={p.id} to={p.to}><span>{p.label}</span><b className={v ? 'nz' : ''}>{fmt(v)}</b></Link>;
          })}
        </div>
      )}
    </div>
  );
}

// ---- rows tables -------------------------------------------------------------
function AppTable({ rows, kind, readOnly }) {
  if (kind === 'scored') {
    return (
      <table className="rdb-tbl">
        <thead><tr><th>Applicant</th><th>Requirement</th><th className="num">Resume</th><th className="num">AI interview</th><th>Stage</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><CandLink r={r} /></td><td><ReqCell r={r} /></td>
            <td className="num"><Score v={r.resumeScore} /></td><td className="num"><Score v={r.aiScore} /></td>
            <td><StatusChip status={r.stageLabel} /></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  if (kind === 'tlqueue') {
    return (
      <table className="rdb-tbl">
        <thead><tr><th>Candidate</th><th>Recruiter</th><th>Requirement</th><th className="num">Score</th><th>Due</th>{!readOnly && <th />}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><CandLink r={r} /></td><td>{r.recruiter || <span className="cell-muted">—</span>}</td><td><ReqCell r={r} /></td>
            <td className="num"><Score v={r.resumeScore} />{r.aiScore != null && <div className="rdb-sub">AI {r.aiScore}</div>}</td>
            <td><DueChip row={r} />{r.waitingDays ? <div className="rdb-sub">waiting {r.waitingDays}d</div> : null}</td>
            {!readOnly && <td><Link className="btn btn-sm btn-primary" to={`/candidates/${r.candidateId}`}>Review →</Link></td>}
          </tr>
        ))}</tbody>
      </table>
    );
  }
  if (kind === 'inactive') {
    return (
      <table className="rdb-tbl">
        <thead><tr><th>Candidate</th><th>Recruiter</th><th>Stage</th><th>Last action</th><th>Idle</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td><CandLink r={r} /><div className="rdb-sub">{r.requirement}</div></td><td>{r.recruiter || <span className="cell-muted">—</span>}</td>
            <td><StatusChip status={r.stageLabel} /></td><td>{shortDate(r.lastAction)}</td>
            <td><StatusChip tone={r.tone}>{r.idleDays} days</StatusChip></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  return (
    <table className="rdb-tbl">
      <thead><tr><th>Candidate</th><th>Requirement</th><th>Stage</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td><CandLink r={r} />{r.recruiter && <div className="rdb-sub">{r.recruiter}</div>}</td><td><ReqCell r={r} /></td>
          <td><StatusChip status={r.stageLabel} /></td><td><DueChip row={r} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function AccJoinTable({ rows, readOnly, withInvoice }) {
  return (
    <table className="rdb-tbl">
      <thead><tr><th>Candidate</th><th>Client</th><th>Joined</th><th className="num">CTC</th><th className="num">Fee</th>{withInvoice && <th>Invoice</th>}{!readOnly && !withInvoice && <th />}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td><CandLink r={r} />{r.guaranteeEnds && <div className="rdb-sub">guarantee ends {shortDate(r.guaranteeEnds)}</div>}</td>
          <td>{r.client}<div className="rdb-sub">{r.requirement}</div></td>
          <td>{shortDate(r.joiningDate)}</td>
          <td className="num">{r.offeredCtc ? rupees(r.offeredCtc) : <StatusChip tone="amber">CTC missing</StatusChip>}</td>
          <td className="num">{r.feePercent != null ? `${r.feePercent}%` : '—'}{r.billing ? <div className="rdb-sub">{rupees(r.billing)}</div> : null}</td>
          {withInvoice && <td>{r.invoiceId ? <Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber || 'Invoice'}</Link> : <span className="cell-muted">not invoiced</span>}{r.invoiceStatus && <div className="rdb-sub">{r.invoiceStatus}</div>}</td>}
          {!readOnly && !withInvoice && <td><Link className="btn btn-sm btn-primary" to={r.generateTo}>Generate Invoice</Link></td>}
        </tr>
      ))}</tbody>
    </table>
  );
}

function PanelHead({ title, total, tone, onTotal, to, sub }) {
  let badge = null;
  if (total !== undefined && total !== null) {
    const cls = `rdb-total${tone && total ? ` t-${tone}` : ''}`;
    badge = to ? <Link className={cls} to={to}>{fmt(total)}</Link>
      : onTotal ? <button type="button" className={cls} onClick={onTotal} title="Show every row">{fmt(total)}</button>
        : <span className={cls} style={{ cursor: 'default' }}>{fmt(total)}</span>;
  }
  return (
    <div className="panel-head">
      <h3>{title} {badge}</h3>
      {sub && <span className="small-muted">{sub}</span>}
    </div>
  );
}

// ---- (B) ---------------------------------------------------------------------
function PendingPanel({ p, openDrill, readOnly }) {
  const onTotal = p.drill ? () => openDrill(p.drill) : null;
  const tone = p.kind === 'aging' || p.kind === 'replacement' ? 'red' : 'amber';
  if (p.kind === 'count') {
    return (
      <div className="panel">
        <PanelHead title={p.title} />
        <div className="rdb-chips">
          <Link className="rdb-chipbtn" to={p.to}><b>{fmt(p.total)}</b><span>open the list</span></Link>
          {p.hint && <span className="rdb-note" style={{ alignSelf: 'center' }}>{p.hint}</span>}
        </div>
      </div>
    );
  }
  const rows = p.rows || [];
  return (
    <div className={`panel${p.kind === 'aging' ? '' : ''}`}>
      <PanelHead title={p.title} total={p.total} tone={tone} onTotal={onTotal} to={!p.drill ? p.to : null} sub={p.sub} />
      {p.kind === 'aging' && (
        <div className="rdb-chips">
          {p.buckets.map((bk) => (
            <Link key={bk.id} className={`rdb-chipbtn t-${bk.count ? bk.tone : 'green'}`} to={bk.to} title={`Invoices ${bk.label} past the due date`}>
              <b>{fmt(bk.count)}</b><span>{bk.label} · {rupees(bk.amount)}</span>
            </Link>
          ))}
        </div>
      )}
      {rows.length === 0 ? <div className="rdb-empty">{p.empty || 'Nothing here.'}</div> : (
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          {p.kind === 'accjoin' && <AccJoinTable rows={rows} readOnly={readOnly} />}
          {p.kind === 'replacement' && <AccJoinTable rows={rows} readOnly={readOnly} withInvoice />}
          {p.kind === 'aging' && (
            <table className="rdb-tbl">
              <thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th className="num">Overdue</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><Link className="rdb-name" to={r.to}>{r.invoiceNumber || 'Invoice'}</Link>{r.candidate && <div className="rdb-sub">{r.candidate}</div>}</td>
                  <td>{r.client}</td><td>{shortDate(r.dueDate)}</td>
                  <td className="num"><StatusChip tone={r.daysOverdue > 30 ? 'red' : 'amber'}>{r.daysOverdue}d</StatusChip></td>
                  <td className="num">{rupees(r.outstanding)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {!['accjoin', 'replacement', 'aging'].includes(p.kind) && <AppTable rows={rows} kind={p.kind} readOnly={readOnly} />}
        </div>
      )}
      {(p.note || p.more || (p.total > rows.length && onTotal)) && (
        <div className="rdb-foot small-muted">
          {p.total > rows.length && onTotal && <button type="button" className="link-btn" onClick={onTotal}>Show all {fmt(p.total)} →</button>}
          {p.more && <> {' · '}<Link to={p.more}>Open the full page →</Link></>}
          {p.note && <div>{p.note}</div>}
        </div>
      )}
    </div>
  );
}

// ---- (C) ---------------------------------------------------------------------
function CountRows({ rows, openDrill, unit }) {
  const top = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  return (
    <div className="rdb-rows">
      {rows.map((r) => (
        <div className="rdb-row" key={r.id || r.label}>
          <span style={{ minWidth: 0, flex: '0 1 45%' }}>{r.label}{r.sub && <span className="rdb-sub"> · {r.sub}</span>}</span>
          <span className="rdb-bar"><i style={{ width: `${((Number(r.value) || 0) / top) * 100}%` }} /></span>
          {r.drill && r.value ? <button type="button" onClick={() => openDrill(r.drill)}>{unit === 'money' ? rupees(r.value) : fmt(r.value)}</button>
            : <span className="z">{unit === 'money' ? rupees(r.value) : fmt(r.value)}</span>}
        </div>
      ))}
    </div>
  );
}

function Widget({ w, openDrill, readOnly }) {
  const rows = w.rows || [];
  const foot = w.to ? <div className="rdb-foot"><Link to={w.to}>Open the full list →</Link></div> : null;
  switch (w.type) {
    case 'reqs':
    case 'reqprogress':
      return (
        <div className="panel">
          <PanelHead title={w.title} total={w.total} to={w.to} />
          {rows.length === 0 ? <div className="rdb-empty">No open requirement in your scope.</div> : (
            <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="rdb-tbl">
                <thead><tr><th>Requirement</th><th className="num">Openings</th><th className="num">Candidates</th><th className="num">Submitted</th><th className="num">Joined</th>{w.type === 'reqprogress' && <th className="num">Remaining</th>}</tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link className="rdb-name" to={`/requirements/${r.id}`}>{r.title}</Link><div className="rdb-sub">{[r.reqCode, r.clientId ? null : r.client].filter(Boolean).join(' · ')}{r.clientId && <Link to={`/clients/${r.clientId}`}>{r.client}</Link>}</div></td>
                    <td className="num">{fmt(r.openings)}</td><td className="num">{fmt(r.candidates)}</td><td className="num">{fmt(r.submitted)}</td><td className="num">{fmt(r.joined)}</td>
                    {w.type === 'reqprogress' && <td className="num">{r.remaining ? <StatusChip tone="amber">{r.remaining}</StatusChip> : <StatusChip tone="green">filled</StatusChip>}</td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {foot}
        </div>
      );
    case 'pipeline':
    case 'outcomes':
    case 'rates':
      if (w.type === 'outcomes' || w.type === 'rates') {
        return (
          <div className="panel">
            <PanelHead title={w.title} />
            <div className="rdb-chips">
              {rows.map((r) => (
                <button key={r.id || r.label} type="button" className={`rdb-chipbtn t-${r.tone}`} onClick={() => r.drill && openDrill(r.drill)} disabled={!r.drill}>
                  <b>{w.type === 'rates' ? (r.value === null ? '—' : `${r.value}%`) : fmt(r.value)}</b>
                  <span>{r.label}{r.sub ? ` · ${r.sub}` : ''}</span>
                </button>
              ))}
            </div>
          </div>
        );
      }
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          <CountRows rows={rows} openDrill={openDrill} />
        </div>
      );
    case 'funnel':
      return (
        <ChartCard
          title={w.title}
          sub="Applications in each step now — click a number in the table for the list"
          isEmpty={!rows.some((r) => r.value)}
          empty="Nothing in the team pipeline."
          table={<DrillTable rows={rows} openDrill={openDrill} />}
        >
          <BarChart rows={rows.map((r) => ({ label: r.label, value: r.value }))} />
        </ChartCard>
      );
    case 'target':
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          <div className="rdb-rows">
            {rows.map((r) => {
              const has = r.target !== null && r.target !== undefined;
              const done = has && r.target > 0 ? Math.min(100, Math.round((r.achieved / r.target) * 100)) : 0;
              return (
                <div className="rdb-row" key={r.id}>
                  <span style={{ flex: '0 1 30%' }}>{r.label}</span>
                  {has ? <span className={`rdb-bar t-${done >= 100 ? 'green' : 'amber'}`}><i style={{ width: `${done}%` }} /></span> : <span className="rdb-sub" style={{ flex: 1 }}>No target set</span>}
                  <span><button type="button" onClick={() => openDrill(r.drill)}>{fmt(r.achieved)}</button>{has && <span className="rdb-sub"> / {fmt(r.target)}</span>}</span>
                </div>
              );
            })}
          </div>
          {w.note && <div className="rdb-foot small-muted">{w.note}</div>}
        </div>
      );
    case 'recruiters':
      return (
        <div className="panel">
          <PanelHead title={w.title} sub="Screened / submitted / selected / joined this month · active = live now" />
          {rows.length === 0 ? <div className="rdb-empty">No recruiter activity in your team yet.</div> : (
            <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="rdb-tbl">
                <thead><tr><th>Recruiter</th><th className="num">Active</th><th className="num">Screened</th><th className="num">Submitted</th><th className="num">Selected</th><th className="num">Joined</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.userId}>
                    <td><Link className="rdb-name" to={r.to}>{r.name}</Link></td>
                    <td className="num">{fmt(r.active)}</td>
                    {['screened', 'submitted', 'selected', 'joined'].map((k) => (
                      <td className="num" key={k}>{r[k] ? <button type="button" className="lnk" onClick={() => openDrill(r.drills[k])}>{fmt(r[k])}</button> : <span className="cell-muted">0</span>}</td>
                    ))}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {foot}
        </div>
      );
    case 'clients':
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          {rows.length === 0 ? <div className="rdb-empty">No client activity yet.</div> : (
            <table className="rdb-tbl">
              <thead><tr><th>Client</th><th className="num">Open req</th><th className="num">Submissions</th><th className="num">Selections</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.clientId || r.client}>
                  <td>{r.clientId ? <Link className="rdb-name" to={`/clients/${r.clientId}`}>{r.client}</Link> : r.client}</td>
                  <td className="num"><Link to={r.to}>{fmt(r.requirements)}</Link></td><td className="num">{fmt(r.submissions)}</td><td className="num">{fmt(r.selections)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {foot}
        </div>
      );
    case 'calendar': {
      const byDay = new Map();
      rows.forEach((r) => {
        const k = new Date(r.interviewAt).toDateString();
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r);
      });
      return (
        <div className="panel">
          <PanelHead title={w.title} total={rows.length} to={w.to} />
          {rows.length === 0 ? <div className="rdb-empty">No interview in the next 7 days.</div> : [...byDay.entries()].map(([day, list]) => (
            <div key={day}>
              <div className="rdb-day">{new Date(list[0].interviewAt).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}</div>
              {list.map((r) => (
                <div className="rdb-row" key={r.id}>
                  <span><b>{timeOf(r.interviewAt)}</b> <CandLink r={r} /></span>
                  <span className="rdb-sub" style={{ textAlign: 'right' }}>{r.requirement}{r.client ? ` · ${r.client}` : ''}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }
    case 'apps':
      return (
        <div className="panel">
          <PanelHead title={w.title} total={w.total} onTotal={w.drill ? () => openDrill(w.drill) : null} />
          {rows.length === 0 ? <div className="rdb-empty">{w.empty || 'Nothing here.'}</div> : <AppTable rows={rows} readOnly={readOnly} />}
        </div>
      );
    case 'funnelchart':
      return (
        <ChartCard
          title={w.title}
          sub="Cumulative — an application that reached a later step counts in every earlier one"
          isEmpty={!rows.some((r) => r.value)}
          table={<DrillTable rows={rows} openDrill={openDrill} pctCols />}
        >
          <BarChart rows={rows.map((r) => ({ label: `${r.label}${r.ofPrev !== null ? ` (${r.ofPrev}%)` : ''}`, value: r.value }))} />
          <div className="rdb-foot small-muted">{w.to && <Link to={w.to}>See the funnel in Reports →</Link>}</div>
        </ChartCard>
      );
    case 'barchart':
      return (
        <ChartCard
          title={w.title}
          isEmpty={!rows.length}
          empty="No invoice in this period."
          table={<DataTable headers={['Client', 'Revenue (before GST)']} numeric={[1]} rows={rows.map((r) => [r.label, rupees(r.value)])} />}
        >
          <BarChart rows={rows} unit="money" />
        </ChartCard>
      );
    case 'sources':
      return (
        <ChartCard
          title={w.title}
          sub="Bar = % of applications that joined · table has the counts"
          isEmpty={!rows.length}
          table={<DataTable headers={['Source', 'Applications', 'Submitted', 'Submitted %', 'Joined', 'Joined %']} numeric={[1, 2, 3, 4, 5]} rows={rows.map((r) => [r.source, fmt(r.applications), fmt(r.submitted), r.submitPct === null ? '—' : `${r.submitPct}%`, fmt(r.joined), r.joinPct === null ? '—' : `${r.joinPct}%`])} />}
        >
          <BarChart rows={rows.map((r) => ({ label: `${r.source} (${fmt(r.applications)})`, value: r.joinPct || 0 }))} />
        </ChartCard>
      );
    case 'leaderboard':
      return (
        <div className="panel">
          <PanelHead title={w.title} sub="Joinings, then client submissions" />
          <div className="rdb-lb">
            {w.groups.map((g) => (
              <div key={g.id}>
                <h4>{g.label}</h4>
                {g.rows.length === 0 ? <div className="rdb-empty">No data.</div> : (
                  <table className="rdb-tbl">
                    <thead><tr><th>#</th><th>Name</th><th className="num">Joined</th><th className="num">Submitted</th></tr></thead>
                    <tbody>{g.rows.map((r, i) => <tr key={r.userId}><td>{i + 1}</td><td>{r.name}</td><td className="num">{fmt(r.joined)}</td><td className="num">{fmt(r.submitted)}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
          {foot}
        </div>
      );
    case 'kv':
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          <div className="rdb-rows">{rows.map((r) => <div className="rdb-row" key={r.label}><span>{r.label}<div className="rdb-sub">{r.sub}</div></span><b>{r.value}</b></div>)}</div>
          {foot}
        </div>
      );
    case 'logins':
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          <table className="rdb-tbl"><tbody>{rows.map((r) => (
            <tr key={r.id}><td>{r.name}<div className="rdb-sub">{r.role}</div></td><td>{dateTime(r.at)}</td><td>{r.today ? <StatusChip tone="green">today</StatusChip> : <StatusChip status={r.status} />}</td></tr>
          ))}</tbody></table>
          {foot}
        </div>
      );
    case 'audit':
      return (
        <div className="panel">
          <PanelHead title={w.title} />
          {rows.length === 0 ? <div className="rdb-empty">No important change recorded.</div> : (
            <table className="rdb-tbl"><tbody>{rows.map((r) => (
              <tr key={r.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTime(r.at)}</td><td><b>{r.action}</b> <span className="rdb-sub">· {r.entity}</span>{r.detail && <div className="rdb-sub">{r.detail}</div>}</td><td className="rdb-sub">{r.who}</td></tr>
            ))}</tbody></table>
          )}
          {foot}
        </div>
      );
    case 'sync': {
      const x = w.extra || {};
      return (
        <div className="panel">
          <PanelHead title={w.title} sub={`${fmt(x.syncFailed)} failed sync records (30 days) · ${fmt(x.portalFailed)} postings failed · ${fmt(x.portalPending)} pending`} />
          <table className="rdb-tbl">
            <thead><tr><th>Source</th><th>State</th><th>Last sync</th><th className="num">Synced</th><th className="num">Failed</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}{r.error && <div className="rdb-sub" style={{ color: 'var(--red)' }}>{String(r.error).slice(0, 80)}</div>}</td>
                <td><StatusChip tone={r.tone}>{r.state}</StatusChip></td><td>{dateTime(r.lastSync)}</td>
                <td className="num">{fmt(r.synced)}</td><td className="num">{r.failed ? <b style={{ color: 'var(--red)' }}>{fmt(r.failed)}</b> : '0'}</td>
              </tr>
            ))}</tbody>
          </table>
          {(x.byEntity || []).length > 0 && <div className="rdb-foot small-muted">Failures by entity: {x.byEntity.map((e) => `${e.entity} ${e.failed}`).join(' · ')}</div>}
          {foot}
        </div>
      );
    }
    case 'approvals': {
      const x = w.extra || {};
      return (
        <div className="panel">
          <PanelHead title={w.title} total={rows.length} tone="amber" />
          {rows.length === 0 ? <div className="rdb-empty">No profile change or edit-access request is waiting.</div> : (
            <table className="rdb-tbl"><tbody>{rows.map((r) => (
              <tr key={r.id}><td><Link className="rdb-name" to={r.to}>{r.who}</Link><div className="rdb-sub">{r.department}</div></td><td><StatusChip tone="amber">{r.kind}</StatusChip>{r.note && <div className="rdb-sub">{r.note}</div>}</td><td className="rdb-sub">since {shortDate(r.since)}</td></tr>
            ))}</tbody></table>
          )}
          <div className="rdb-foot small-muted">
            Leave requests waiting: <Link to={x.leaveTo || '/leave'}>{fmt(x.leavePending)}</Link>
            {w.note && <div>{w.note}</div>}
          </div>
        </div>
      );
    }
    case 'clientout':
      return (
        <div className="panel">
          <PanelHead title={w.title} total={w.total} to={w.to} />
          {rows.length === 0 ? <div className="rdb-empty">Nothing outstanding.</div> : (
            <table className="rdb-tbl">
              <thead><tr><th>Client</th><th className="num">Invoices</th><th className="num">Oldest overdue</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.client}><td><Link className="rdb-name" to={r.to}>{r.client}</Link></td><td className="num">{fmt(r.invoices)}</td>
                  <td className="num">{r.oldest ? <StatusChip tone={r.oldest > 30 ? 'red' : 'amber'}>{r.oldest}d</StatusChip> : <StatusChip tone="green">not due</StatusChip>}</td><td className="num">{rupees(r.outstanding)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      );
    case 'revenue':
      return (
        <ChartCard
          title={w.title}
          sub={w.note}
          table={<DataTable headers={['Month', 'Billed', 'Received']} numeric={[1, 2]} rows={rows.map((r) => [r.label, rupees(r.billed), rupees(r.received)])} />}
        >
          <BarChart rows={rows.map((r) => ({ label: `${r.label} · billed`, value: r.billed }))} unit="money" />
          <div className="rdb-rows">{rows.map((r) => <div className="rdb-row" key={r.label}><span>{r.label}</span><span>received <b>{rupees(r.received)}</b> · <Link to={r.to}>invoices →</Link></span></div>)}</div>
        </ChartCard>
      );
    case 'guaranteecal':
      return (
        <div className="panel">
          <PanelHead title={w.title} total={w.total} />
          {rows.length === 0 ? <div className="rdb-empty">No guarantee ends in the next 30 days.</div> : (
            <table className="rdb-tbl"><tbody>{rows.map((r) => (
              <tr key={r.id}><td><StatusChip tone={r.tone}>{shortDate(r.guaranteeEnds)}</StatusChip></td><td><CandLink r={r} /><div className="rdb-sub">{r.client}</div></td><td className="rdb-sub">joined {shortDate(r.joiningDate)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      );
    default:
      return null;
  }
}

function DrillTable({ rows, openDrill, pctCols }) {
  return (
    <table className="tlc-table">
      <thead><tr><th>Step</th><th className="num">Applications</th>{pctCols && <th className="num">% of all</th>}{pctCols && <th className="num">From previous</th>}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td>{r.label}</td>
          <td className="num">{r.drill && r.value ? <button type="button" className="link-btn" onClick={() => openDrill(r.drill)}>{fmt(r.value)}</button> : fmt(r.value)}</td>
          {pctCols && <td className="num">{r.ofAll === null ? '—' : `${r.ofAll}%`}</td>}
          {pctCols && <td className="num">{r.ofPrev === null ? '—' : `${r.ofPrev}%`}</td>}
        </tr>
      ))}</tbody>
    </table>
  );
}

// ---- THE DRILL PANEL — the rows behind one count ------------------------------
export function DrillPanel({ listUrl, params, setId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    api.get(listUrl, { params: { ...params, set: setId } })
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'The list could not be loaded.'); });
    return () => { alive = false; };
  }, [listUrl, setId, JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (data && data.rows) || [];
  return (
    <Modal title={data ? data.title : 'Loading…'} note={data ? `${fmt(data.total)} in total${data.total > rows.length ? ` · showing ${fmt(rows.length)}` : ''}` : ''} size="xwide" onClose={onClose} bodyStyle={{ maxHeight: '70vh', overflow: 'auto', padding: 0 }}>
      <div className="rdb-drill">
        {error && <div className="notice red" style={{ margin: 12 }}>{error}</div>}
        {!data && !error && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}
        {data && rows.length === 0 && <div className="small-muted" style={{ padding: 16 }}>Nothing in this list right now.</div>}
        {data && rows.length > 0 && (data.kind === 'app' || data.kind === 'workflow') && (
          <table className="rdb-tbl">
            <thead><tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Stage</th><th>Status / due</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{r.candidateId ? <Link className="rdb-name" to={`/candidates/${r.candidateId}`} onClick={onClose}>{r.candidate}</Link> : r.candidate}{r.recruiter && <div className="rdb-sub">{r.recruiter}</div>}</td>
                <td>{r.requirementId ? <Link to={`/requirements/${r.requirementId}`} onClick={onClose}>{r.requirement}</Link> : r.requirement}{r.reqCode && <div className="rdb-sub">{r.reqCode}</div>}</td>
                <td>{r.client || '—'}</td>
                <td><StatusChip status={r.stageLabel} /></td>
                <td>{r.guaranteeEnds ? <span className="rdb-sub">guarantee ends {shortDate(r.guaranteeEnds)}</span> : <DueChip row={r} />}
                  {(r.resumeScore != null || r.aiScore != null) && <div className="rdb-sub">Resume {r.resumeScore ?? '—'} · AI {r.aiScore ?? '—'}</div>}
                  {r.idleDays != null && <div className="rdb-sub">idle {r.idleDays} days</div>}
                </td>
                <td className="rdb-sub">{shortDate(r.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'req' && (
          <table className="rdb-tbl"><thead><tr><th>Requirement</th><th>Client</th><th>Status</th><th className="num">Openings</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td><Link className="rdb-name" to={`/requirements/${r.id}`} onClick={onClose}>{r.title}</Link></td><td>{r.client}</td><td><StatusChip status={r.status} /></td><td className="num">{r.openings}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'inv' && (
          <table className="rdb-tbl"><thead><tr><th>Invoice</th><th>Client</th><th>Invoice date</th><th>Due</th><th>Status</th><th className="num">Before GST</th><th className="num">Outstanding</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td><Link className="rdb-name" to={r.to} onClick={onClose}>{r.invoiceNumber || 'Invoice'}</Link></td><td>{r.client}</td><td>{shortDate(r.invoiceDate)}</td><td>{shortDate(r.dueDate)}{r.daysOverdue > 0 && <div className="rdb-sub">{r.daysOverdue} days overdue</div>}</td><td><StatusChip status={r.status} /></td><td className="num">{rupees(r.amount)}</td><td className="num">{rupees(r.outstanding)}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'emp' && (
          <table className="rdb-tbl"><thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th>Today</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td><Link className="rdb-name" to={r.to} onClick={onClose}>{r.name}</Link></td><td>{r.department || '—'}</td><td>{r.designation || '—'}</td><td>{r.status ? <StatusChip status={r.status} /> : '—'}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'client' && (
          <table className="rdb-tbl"><thead><tr><th>Client</th><th>Agreement</th><th>BDE owner</th><th className="num">Open jobs</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.to ? <Link className="rdb-name" to={r.to} onClick={onClose}>{r.name}</Link> : r.name}</td><td><StatusChip tone="amber">{r.agreement || 'Not signed'}</StatusChip></td><td>{r.owner || '—'}</td><td className="num">{fmt(r.openJobs)}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'user' && (
          <table className="rdb-tbl"><thead><tr><th>User</th><th>Role</th><th>Last sign-in</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.role}</td><td>{dateTime(r.at)}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'pay' && (
          <table className="rdb-tbl"><thead><tr><th>Date</th><th>Invoice</th><th>Client</th><th>Method</th><th className="num">Amount</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id}><td>{shortDate(r.date)}</td><td><Link to={`/invoices/${r.invoiceId}`} onClick={onClose}>{r.invoiceNumber || 'Invoice'}</Link></td><td>{r.client}</td><td>{r.method}{r.reference && <div className="rdb-sub">{r.reference}</div>}</td><td className="num">{rupees(r.amount)}</td></tr>)}</tbody>
          </table>
        )}
        {data && rows.length > 0 && data.kind === 'accjoin' && (
          <div className="rdb"><AccJoinTable rows={rows} readOnly={false} /></div>
        )}
      </div>
      {data && data.kind === 'workflow' && (
        <div className="small-muted" style={{ padding: '8px 14px' }}>
          This is the same list as the box on the <button type="button" className="link-btn" onClick={() => { onClose(); navigate('/ats/workflow'); }}>Workflow view</button>.
        </div>
      )}
    </Modal>
  );
}

const WIDE = ['leaderboard', 'recruiters', 'sources'];

// ---- THE BOARD ------------------------------------------------------------------
export default function RoleBoard({ board, listUrl, listParams = {}, head = null }) {
  const [sp, setSp] = useSearchParams();
  const [partValues, setPartValues] = useState({});
  const listId = sp.get('list') || '';
  const openDrill = (id) => {
    if (!id) return;
    const p = new URLSearchParams(sp); p.set('list', id); setSp(p, { replace: false });
  };
  const closeDrill = () => { const p = new URLSearchParams(sp); p.delete('list'); setSp(p, { replace: true }); };

  // Parts the browser fills from existing admin endpoints (duplicates).
  useEffect(() => {
    const parts = (board.counts || []).flatMap((c) => c.parts || []).filter((p) => p.fetch && (p.value === null || p.value === undefined));
    let alive = true;
    parts.forEach((p) => {
      api.get(p.fetch).then((r) => {
        const d = r.data || {};
        const v = d.contact ? d.contact.groups : (d.groups ?? null);
        if (alive) setPartValues((cur) => ({ ...cur, [p.id]: v }));
      }).catch(() => {});
    });
    return () => { alive = false; };
  }, [board]);

  const readOnly = !!board.readOnly;
  const operational = ['recruiter', 'tl', 'bde'].includes(board.view);
  return (
    <div className="rdb">
      {head}
      <div className="rdb-counts" role="list" aria-label="Top counts">
        {(board.counts || []).map((c) => <CountTile key={c.id} c={c} openDrill={openDrill} partValues={partValues} />)}
      </div>
      {(board.quick || []).length > 0 && (
        <div className="rdb-quick" aria-label="Quick actions">
          {board.quick.map((q) => (q.to
            ? <Link key={q.id} className={`btn btn-sm${q.primary ? ' btn-primary' : ''}`} to={q.to} title={q.gap || q.label}>{q.label}</Link>
            : <button key={q.id} type="button" className="btn btn-sm" disabled title={q.disabledHint || ''}>{q.label}</button>))}
          {board.quick.filter((q) => q.gap).map((q) => <span key={`g-${q.id}`} className="gap">{q.gap}</span>)}
        </div>
      )}
      {(board.pending || []).length > 0 && (
        <>
          <div className="rdb-kicker">{operational ? 'My queue — what to do now' : 'Pending'}</div>
          <div className="rdb-grid">
            {board.pending.map((p) => (
              <div key={p.id} className={`rdb-cell${p.kind === 'aging' ? ' rdb-wide' : ''}`}>
                <PendingPanel p={p} openDrill={openDrill} readOnly={readOnly} />
              </div>
            ))}
          </div>
        </>
      )}
      {(board.widgets || []).length > 0 && (
        <>
          <div className="rdb-kicker">{board.view === 'management' ? 'Charts & tables' : 'Lists'}</div>
          <div className="rdb-grid">
            {board.widgets.map((w) => (
              <div key={w.id} className={`rdb-cell${WIDE.includes(w.type) ? ' rdb-wide' : ''}`}>
                <Widget w={w} openDrill={openDrill} readOnly={readOnly} />
              </div>
            ))}
          </div>
        </>
      )}
      {(board.notes || []).map((n) => <div key={n} className="rdb-note">{n}</div>)}
      {listId && <DrillPanel listUrl={listUrl} params={listParams} setId={listId} onClose={closeDrill} />}
    </div>
  );
}

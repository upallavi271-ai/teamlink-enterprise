import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import TabStrip from '../../components/ui/TabStrip.jsx';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';
import { BarChart, LineChart, ProgressBar } from '../../components/charts';
import {
  DownloadButtons, Table, ResultChart, ResultTable, postDownload, errText, dash, inr, dayText,
} from './InsightBits.jsx';
import './InsightReports.css';

// ---------------------------------------------------------------------------
// REPORTS & TEAM -> REPORTS: the "Build, forecast & data" tabs (market wave 2026-11-21; backend routes/atsInsights.js).
//   ttfjob       Time to fill by requirement and client (12.06)      openings     Per opening (12.10)
//   readiness    Closest to fill (01.10)                             forecast     Pipeline / revenue forecast (01.09)
//   bottlenecks  Bottlenecks and hiring forecast (12.16)             builder      Custom report builder (12.02)
//   askchart     Ask for a chart (01.12)                             schedules    Alerts and scheduled e-mails (01.13 / 01.14 / 12.04)
//   backdoor     Backdoor hires (12.11)                              qoh          Quality of hire (12.12)
//   compliance   Compliance pack, India DPDP (12.14)                 bifeed       BI feed for Power BI / Looker / Excel (12.15)
// Every number is counted in the viewer's own area on the server.
// ---------------------------------------------------------------------------
export const INSIGHT_TABS = [
  ['ttfjob', 'Time to fill by job & client'], ['openings', 'Per opening'], ['readiness', 'Closest to fill'], ['forecast', 'Pipeline forecast'],
  ['bottlenecks', 'Bottlenecks & forecast'], ['builder', 'Build a report'], ['askchart', 'Ask for a chart'], ['schedules', 'Alerts & e-mails'],
  ['backdoor', 'Backdoor hires'], ['qoh', 'Quality of hire'], ['compliance', 'Compliance (DPDP)'], ['bifeed', 'BI feed'],
];
export const INSIGHT_TAB_IDS = INSIGHT_TABS.map(([id]) => id);

function useGet(url, params) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const key = JSON.stringify(params || {});
  const load = useCallback(() => {
    api.get(url, { params }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load this report.')));
  }, [url, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return [d, err, load, setErr];
}
function useAccess() {
  const [a, setA] = useState(null);
  useEffect(() => { api.get('/ats-insights/access').then((x) => setA(x.data)).catch(() => setA({ access: {} })); }, []);
  return a;
}
const Err = ({ err }) => (err ? <div className="notice red"><span>{err}</span></div> : null);
const Ok = ({ msg }) => (msg ? <div className="notice green"><span>{msg}</span></div> : null);
const Note = ({ children }) => <p className="small-muted ins-note">{children}</p>;
const Loading = () => <div className="small-muted">Loading…</div>;

// --- 12.06 time to fill by job and client --------------------------------------------------------------------------
function TtfByJob({ canExport }) {
  const [days, setDays] = useState('0');
  const [client, setClient] = useState('');
  const params = useMemo(() => ({ ...(Number(days) ? { days } : {}), ...(client ? { client } : {}) }), [days, client]);
  const [d, err, , setErr] = useGet('/ats-insights/ttf', params);
  const [clients, setClients] = useState([]);
  useEffect(() => { if (d && !client) setClients(d.byClient.filter((c) => c.clientId)); }, [d, client]);
  return (
    <div>
      <div className="ins-bar">
        <label><span>Joined in</span><Combo value={days} onChange={(e) => setDays(e.target.value)}><option value="0">All time</option><option value="90">Last 90 days</option><option value="180">Last 6 months</option><option value="365">Last 12 months</option></Combo></label>
        <label><span>Client</span><Combo value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option>{clients.map((c) => <option key={c.clientId} value={c.clientId}>{c.client}</option>)}</Combo></label>
        <span className="ins-grow" />
        <DownloadButtons url="/ats-insights/ttf" params={params} name="time-to-fill" onError={setErr} show={canExport} />
      </div>
      <Err err={err} />
      {!d ? <Loading /> : (
        <>
          <StatRow>
            <StatCard label="Usual days to fill" value={d.tiles.medianFill} hint="requirement added → joined" />
            <StatCard label="Average days to fill" value={d.tiles.avgFill} />
            <StatCard label="Usual days to hire" value={d.tiles.medianHire} hint="candidate added → joined" />
            <StatCard label="People joined" value={d.tiles.joined} zeroText="None yet" />
            <StatCard label="Open requirements" value={d.tiles.openJobs} hint={d.tiles.medianOpenAge !== null ? `usually open ${d.tiles.medianOpenAge} days` : ''} />
          </StatRow>
          {d.byMonth.length > 1 && <div className="card ins-card"><h3>Usual days to fill, month by month</h3><LineChart points={d.byMonth.map((m) => ({ label: m.label, value: m.medianFill || 0 }))} height={200} /></div>}
          <h3 className="ins-h">By requirement</h3>
          <Table
            cols={[['Requirement', (r) => <Link to={`/requirements/${r.requirementId}`}>{r.requirement}</Link>], ['Client', (r) => r.client], ['Openings', (r) => r.openings, { num: true }], ['Joined', (r) => r.joined, { num: true }],
              ['Usual days to fill', (r) => dash(r.medianFill), { num: true }], ['Fastest', (r) => dash(r.fastestFill), { num: true }], ['Slowest', (r) => dash(r.slowestFill), { num: true }], ['Usual days to hire', (r) => dash(r.medianHire), { num: true }]]}
            rows={d.byJob} keyOf={(r) => r.requirementId} max={300} empty="Nobody has joined in this period."
          />
          <h3 className="ins-h">By client</h3>
          <Table
            cols={[['Client', (r) => r.client], ['Requirements', (r) => r.requirements, { num: true }], ['Joined', (r) => r.joined, { num: true }], ['Usual days to fill', (r) => dash(r.medianFill), { num: true }],
              ['Average days to fill', (r) => dash(r.avgFill), { num: true }], ['Usual days to hire', (r) => dash(r.medianHire), { num: true }]]}
            rows={d.byClient} keyOf={(r) => r.client}
          />
          <Note>{d.note}</Note>
        </>
      )}
    </div>
  );
}

// --- 12.10 per opening --------------------------------------------------------------------------
function Openings({ canExport }) {
  const [status, setStatus] = useState('live');
  const [all, setAll] = useState(false);
  const params = useMemo(() => ({ status, ...(all ? { all: '1' } : {}) }), [status, all]);
  const [d, err, , setErr] = useGet('/ats-insights/openings', params);
  const [open, setOpen] = useState('');
  return (
    <div>
      <div className="ins-bar">
        <label><span>Requirements</span><Combo value={status} onChange={(e) => setStatus(e.target.value)}><option value="live">Open</option><option value="closed">Closed</option><option value="all">All</option></Combo></label>
        <label className="ins-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Also requirements with one opening</label>
        <span className="ins-grow" />
        <DownloadButtons url="/ats-insights/openings" params={params} name="per-opening" onError={setErr} show={canExport} />
      </div>
      <Err err={err} />
      {!d ? <Loading /> : (
        <>
          <StatRow>
            <StatCard label="Requirements" value={d.requirements} />
            <StatCard label="Openings" value={d.totals.openings} />
            <StatCard label="Filled" value={d.totals.filled} tone="green" />
            <StatCard label="Still open" value={d.totals.left} tone={d.totals.left ? 'yellow' : 'green'} />
          </StatRow>
          <Table
            cols={[
              ['Requirement', (r) => <Link to={`/requirements/${r.requirementId}`}>{r.requirement}</Link>], ['Client', (r) => r.client], ['Status', (r) => r.status],
              ['Openings', (r) => r.openings, { num: true }], ['Filled', (r) => r.filled, { num: true }], ['Left', (r) => r.left, { num: true }],
              ['In offer / selected', (r) => `${r.pipeline.offer + r.pipeline.accepted} / ${r.pipeline.selected}`],
              ['Each opening', (r) => <button type="button" className="btn btn-sm" onClick={() => setOpen(open === r.requirementId ? '' : r.requirementId)}>{open === r.requirementId ? 'Hide' : 'Show'}</button>],
            ]}
            rows={d.rows} keyOf={(r) => r.requirementId} max={300} empty="No requirement with several openings here."
          />
          {open && (() => {
            const r = d.rows.find((x) => x.requirementId === open);
            return r ? (
              <div className="card ins-card">
                <h3>{r.requirement} · opened {dayText(r.openedOn)}</h3>
                <Table
                  cols={[['Opening', (s) => `#${s.opening}`], ['Status', (s) => s.status], ['Filled by', (s) => (s.candidateId ? <Link to={`/candidates/${s.candidateId}`}>{s.person}</Link> : '—')],
                    ['Filled on', (s) => dayText(s.filledOn)], ['Days to fill', (s) => dash(s.daysToFill), { num: true }], ['Open for (days)', (s) => dash(s.daysOpen), { num: true }]]}
                  rows={r.seats} keyOf={(s) => s.opening}
                />
              </div>
            ) : null;
          })()}
        </>
      )}
    </div>
  );
}

// --- 01.10 closest to fill --------------------------------------------------------------------------
export function ReadinessTable({ rows, compact = false }) {
  return (
    <Table
      cols={[
        ['Requirement', (r) => <Link to={`/requirements/${r.requirementId}`}>{r.requirement}</Link>],
        ...(compact ? [] : [['Client', (r) => r.client], ['Days open', (r) => r.ageDays, { num: true }]]),
        ['Left', (r) => `${r.left} of ${r.openings}`, { num: true }],
        ['Ready', (r) => <span className="ins-ready"><ProgressBar value={r.readiness} max={100} tone={r.readiness >= 70 ? 'green' : r.readiness >= 35 ? 'yellow' : 'red'} valueFormat={(v) => `${v}%`} /></span>],
        ['Next step', (r) => r.next],
      ]}
      rows={rows} keyOf={(r) => r.requirementId} empty="No open requirement is waiting for people."
    />
  );
}
function Readiness({ canExport }) {
  const [d, err, , setErr] = useGet('/ats-insights/readiness');
  return (
    <div>
      <div className="ins-bar"><span className="ins-grow" /><DownloadButtons url="/ats-insights/readiness" name="closest-to-fill" onError={setErr} show={canExport} /></div>
      <Err err={err} />
      {!d ? <Loading /> : (<><ReadinessTable rows={d.rows} /><Note>{d.note}</Note></>)}
    </div>
  );
}

// --- 01.09 forecast --------------------------------------------------------------------------
function Forecast({ canExport }) {
  const [d, err, , setErr] = useGet('/ats-insights/forecast');
  return (
    <div>
      <div className="ins-bar"><span className="ins-grow" /><DownloadButtons url="/ats-insights/forecast" name="pipeline-forecast" onError={setErr} show={canExport} /></div>
      <Err err={err} />
      {!d ? <Loading /> : (
        <>
          <StatRow>
            <StatCard label="Expected joinings" value={d.expectedJoinings} tone="blue" hint={`from ${d.inPipeline} people in process now`} />
            {d.revenue && <StatCard label="Expected fee" value={inr(d.revenue.expected)} hint={`${d.revenue.basedOn} people with a fee known · ${d.revenue.noFee} without`} />}
            {d.byMonth[0] && <StatCard label={`Expected in ${d.byMonth[0].label}`} value={d.byMonth[0].expected} />}
          </StatRow>
          <div className="ins-two">
            <div className="card ins-card"><h3>Expected joinings by step</h3><BarChart data={d.byStep.map((s) => ({ label: s.label, value: s.expected }))} horizontal height={220} /></div>
            <div className="card ins-card"><h3>By month</h3><BarChart data={d.byMonth.map((m) => ({ label: m.label, value: m.expected }))} height={220} /></div>
          </div>
          <h3 className="ins-h">Steps</h3>
          <Table cols={[['Step', (s) => s.label], ['People now', (s) => s.people, { num: true }], ['Chance of joining', (s) => `${s.chance}%${s.learnt ? '' : ' (usual rate)'}`, { num: true }], ['Expected joinings', (s) => s.expected, { num: true }]]} rows={d.byStep} keyOf={(s) => s.step} />
          <h3 className="ins-h">By client</h3>
          <Table cols={[['Client', (c) => c.client], ['People', (c) => c.people, { num: true }], ['Expected joinings', (c) => c.expected, { num: true }], ...(d.revenue ? [['Expected fee', (c) => inr(c.revenue), { num: true }]] : [])]} rows={d.byClient} keyOf={(c) => c.client} />
          <Note>{d.note}{d.revenue ? ` ${d.revenue.note}` : ''}</Note>
        </>
      )}
    </div>
  );
}

// --- 12.16 bottlenecks --------------------------------------------------------------------------
function Bottlenecks({ canExport }) {
  const [days, setDays] = useState('180');
  const [d, err, , setErr] = useGet('/ats-insights/bottlenecks', useMemo(() => ({ days }), [days]));
  return (
    <div>
      <div className="ins-bar">
        <label><span>People added in</span><Combo value={days} onChange={(e) => setDays(e.target.value)}><option value="90">Last 90 days</option><option value="180">Last 6 months</option><option value="365">Last 12 months</option></Combo></label>
        <span className="ins-grow" />
        <DownloadButtons url="/ats-insights/bottlenecks" params={{ days }} name="bottlenecks" onError={setErr} show={canExport} />
      </div>
      <Err err={err} />
      {!d ? <Loading /> : (
        <>
          {(d.bottleneck.conversion || d.bottleneck.waiting) && (
            <div className="notice"><span><b>Where it gets stuck:</b> {[d.bottleneck.conversion, d.bottleneck.waiting].filter(Boolean).join(' ')}</span></div>
          )}
          <div className="ins-two">
            <div className="card ins-card"><h3>How many move on at each step</h3><BarChart data={d.steps.map((s) => ({ label: `${s.from} → ${s.to}`, value: s.rate || 0 }))} horizontal height={220} valueFormat={(v) => `${v}%`} /></div>
            <div className="card ins-card"><h3>Openings raised and people joined</h3><LineChart points={[...d.trend.map((t) => ({ label: t.label, value: t.openings })), { label: `${d.nextMonth.label} (forecast)`, value: d.nextMonth.openings }]} height={220} /></div>
          </div>
          <StatRow>
            <StatCard label={`Openings expected in ${d.nextMonth.label}`} value={d.nextMonth.openings} tone="blue" />
            <StatCard label="Requirements expected" value={d.nextMonth.requirements} />
            <StatCard label="Joinings expected" value={d.nextMonth.joined} />
          </StatRow>
          <h3 className="ins-h">Waiting now, by step</h3>
          <Table cols={[['Step', (w) => w.step], ['People', (w) => w.people, { num: true }], ['Usual days in step', (w) => dash(w.usualDays), { num: true }], ['Over 7 days', (w) => w.over7, { num: true }], ['Over 15 days', (w) => w.over15, { num: true }]]} rows={d.waiting} keyOf={(w) => w.id} />
          <h3 className="ins-h">Hiring need by department (openings)</h3>
          <Table cols={[['Department', (r) => r.department], ['3 months ago', (r) => r.last3[0], { num: true }], ['2 months ago', (r) => r.last3[1], { num: true }], ['Last month', (r) => r.last3[2], { num: true }], [`${d.nextMonth.label} (forecast)`, (r) => <b>{r.nextMonth}</b>, { num: true }]]} rows={d.byDepartment} keyOf={(r) => r.department} />
          <Note>{d.note}</Note>
        </>
      )}
    </div>
  );
}

// --- 12.02 report builder + saved reports --------------------------------------------------------------------------
const RANGE_LABEL = { all: 'All time', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '180d': 'Last 6 months', '365d': 'Last 12 months', thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year', custom: 'Between dates' };
const OP_LABEL = { is: 'is', isnot: 'is not', contains: 'contains', in: 'is one of', gte: 'at least / from', lte: 'at most / until' };
export function SaveReport({ spec, onSaved }) {
  const [name, setName] = useState('');
  const [team, setTeam] = useState(false);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  async function save() {
    setErr(''); setMsg('');
    try { await api.post('/ats-insights/reports', { name, spec, shared: team ? 'team' : 'private' }); setMsg('Saved. Find it under "My reports".'); setName(''); if (onSaved) onSaved(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  return (
    <div className="ins-save">
      <input type="text" placeholder="Name this report" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Report name" />
      <label className="ins-check"><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Share with my team</label>
      <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim()} onClick={save}>Save</button>
      <Ok msg={msg} /><Err err={err} />
    </div>
  );
}
function SavedReports({ access, reload, onOpen }) {
  const [d, err, load, setErr] = useGet('/ats-insights/reports', useMemo(() => ({ r: reload }), [reload]));
  const [msg, setMsg] = useState('');
  const lead = access && access.access && access.access.lead;
  const act = async (fn, ok) => { setMsg(''); try { await fn(); setMsg(ok); load(); } catch (e) { setErr(errText(e, 'Could not do that.')); } };
  return (
    <div className="card ins-card">
      <h3>My reports</h3>
      <Err err={err} /><Ok msg={msg} />
      {!d ? <Loading /> : (
        <Table
          cols={[
            ['Report', (r) => <button type="button" className="link-btn" onClick={() => onOpen(r)}>{r.name}</button>],
            ['Made by', (r) => (r.mine ? 'You' : r.ownerName)], ['Shared', (r) => (r.shared === 'team' ? 'Team' : 'Only you')],
            ['', (r) => (
              <span className="ins-actions">
                <button type="button" className="btn btn-sm" onClick={() => act(() => api.post('/ats-insights/pins', { reportId: r.id }), 'Added to your dashboard (My charts).')}>Add to my dashboard</button>
                {lead && r.shared === 'team' && <button type="button" className="btn btn-sm" onClick={() => act(() => api.post('/ats-insights/pins', { reportId: r.id, forTeam: true }), 'Added to your team\'s dashboards.')}>Add for my team</button>}
                {r.mine && <button type="button" className="btn btn-sm" onClick={() => window.confirm(`Delete "${r.name}"?`) && act(() => api.delete(`/ats-insights/reports/${r.id}`), 'Deleted.')}>Delete</button>}
              </span>
            )],
          ]}
          rows={d.reports} empty="No saved reports yet. Build one above and press Save."
        />
      )}
      <p className="small-muted">A shared report shows each person their own numbers: sharing shares the question, not your data.</p>
    </div>
  );
}
function Builder({ canExport }) {
  const access = useAccess();
  const [schema, setSchema] = useState(null);
  const [spec, setSpec] = useState({ entity: 'applications', columns: ['candidate', 'requirement', 'client', 'stage', 'recruiter', 'addedOn'], filters: [], range: '90d', groupBy: '', measure: { op: 'count' }, chart: 'bar' });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { api.get('/ats-insights/builder/schema').then((x) => setSchema(x.data)).catch((e) => setErr(errText(e, 'Could not load.'))); }, []);
  const E = schema && schema.entities.find((e) => e.id === spec.entity);
  const fieldOf = (k) => E && E.fields.find((f) => f.id === k);
  const set = (p) => setSpec((s) => ({ ...s, ...p }));
  async function run(s = spec) {
    setBusy(true); setErr('');
    try { const x = await api.post('/ats-insights/builder/run', { spec: { ...s, groupBy: s.groupBy || null } }); setRes(x.data.result); } catch (e) { setErr(errText(e, 'Could not run the report.')); } finally { setBusy(false); }
  }
  function pickEntity(id) {
    const e = schema.entities.find((x) => x.id === id);
    set({ entity: id, columns: e.fields.slice(0, 6).map((f) => f.id), filters: [], groupBy: '', measure: { op: 'count' } });
    setRes(null);
  }
  if (!schema) return <><Err err={err} /><Loading /></>;
  const nums = E.fields.filter((f) => f.type === 'num');
  return (
    <div>
      <div className="card ins-card ins-builder">
        <div className="ins-bar">
          <label><span>Report on</span><Combo value={spec.entity} onChange={(e) => pickEntity(e.target.value)}>{schema.entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</Combo></label>
          <label><span>When</span><Combo value={spec.range} onChange={(e) => set({ range: e.target.value })}>{schema.ranges.map((r) => <option key={r} value={r}>{RANGE_LABEL[r] || r}</option>)}</Combo></label>
          {spec.range === 'custom' && <><label><span>From</span><input type="date" value={spec.from || ''} onChange={(e) => set({ from: e.target.value })} /></label><label><span>To</span><input type="date" value={spec.to || ''} onChange={(e) => set({ to: e.target.value })} /></label></>}
          <label><span>Group by</span><Combo value={spec.groupBy || ''} onChange={(e) => set({ groupBy: e.target.value })}><option value="">No grouping (a list)</option>{E.fields.filter((f) => f.type !== 'num').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Combo></label>
          {spec.groupBy && (
            <label><span>Count</span><Combo value={spec.measure.op === 'count' ? 'count' : `${spec.measure.op}:${spec.measure.field}`} onChange={(e) => { const [op, field] = e.target.value.split(':'); set({ measure: op === 'count' ? { op } : { op, field } }); }}>
              <option value="count">How many</option>
              {nums.flatMap((f) => [<option key={`s${f.id}`} value={`sum:${f.id}`}>{`Total ${f.label.toLowerCase()}`}</option>, <option key={`a${f.id}`} value={`avg:${f.id}`}>{`Average ${f.label.toLowerCase()}`}</option>])}
            </Combo></label>
          )}
          {spec.groupBy && <label><span>Chart</span><Combo value={spec.chart} onChange={(e) => set({ chart: e.target.value })}><option value="bar">Bars</option><option value="line">Line</option><option value="donut">Donut</option><option value="table">Table only</option></Combo></label>}
        </div>
        {!spec.groupBy && (
          <fieldset className="ins-cols"><legend>Columns</legend>
            {E.fields.map((f) => (
              <label key={f.id} className="ins-check"><input type="checkbox" checked={spec.columns.includes(f.id)} onChange={(e) => set({ columns: e.target.checked ? [...spec.columns, f.id] : spec.columns.filter((c) => c !== f.id) })} /> {f.label}</label>
            ))}
          </fieldset>
        )}
        <div className="ins-filters">
          <div className="small-muted">Filters</div>
          {spec.filters.map((f, i) => {
            const fd = fieldOf(f.field) || E.fields[0];
            const upd = (p) => set({ filters: spec.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <div key={i} className="ins-filter">
                <Combo value={f.field} onChange={(e) => { const nf = fieldOf(e.target.value); upd({ field: e.target.value, op: nf.ops[0], value: '' }); }} title="Field">{E.fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Combo>
                <Combo value={f.op} onChange={(e) => upd({ op: e.target.value })} title="How">{fd.ops.map((o) => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}</Combo>
                <input type={fd.type === 'date' ? 'date' : fd.type === 'num' ? 'number' : 'text'} value={f.value} onChange={(e) => upd({ value: e.target.value })} placeholder={f.op === 'in' ? 'a, b, c' : fd.type === 'month' ? 'YYYY-MM' : 'value'} aria-label="Value" />
                <button type="button" className="btn btn-sm" onClick={() => set({ filters: spec.filters.filter((x, j) => j !== i) })} aria-label="Remove filter">✕</button>
              </div>
            );
          })}
          {spec.filters.length < 12 && <button type="button" className="btn btn-sm" onClick={() => set({ filters: [...spec.filters, { field: E.fields[0].id, op: E.fields[0].ops[0], value: '' }] })}>+ Add a filter</button>}
        </div>
        <div className="ins-bar">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run()}>{busy ? 'Running…' : 'Run report'}</button>
          {res && canExport && (
            <>
              <button type="button" className="btn btn-sm" onClick={async () => { const m = await postDownload('/ats-insights/builder/export', { spec: { ...spec, groupBy: spec.groupBy || null }, format: 'xlsx' }, 'report.xlsx'); if (m) setErr(m); }}>Excel</button>
              <button type="button" className="btn btn-sm" onClick={async () => { const m = await postDownload('/ats-insights/builder/export', { spec: { ...spec, groupBy: spec.groupBy || null }, format: 'csv' }, 'report.csv'); if (m) setErr(m); }}>CSV</button>
            </>
          )}
        </div>
      </div>
      <Err err={err} />
      {res && (
        <div className="card ins-card">
          <h3>{res.title} <span className="small-muted">· {res.total} row(s){res.groupCount > (res.groups || []).length ? ` · top ${res.groups.length} of ${res.groupCount} groups` : ''}</span></h3>
          <SaveReport spec={{ ...spec, groupBy: spec.groupBy || null }} onSaved={() => setReload((n) => n + 1)} />
          <ResultChart result={res} />
          <ResultTable result={res} />
        </div>
      )}
      <SavedReports access={access} reload={reload} onOpen={(r) => { const s = { ...r.spec, groupBy: r.spec.groupBy || '' }; setSpec(s); run(s); }} />
    </div>
  );
}

// --- 01.12 ask for a chart --------------------------------------------------------------------------
const EXAMPLES = ['Joinings by client this year', 'Candidates added month by month in the last 6 months', 'Open requirements by department', 'Interviews by recruiter last 30 days', 'Average days to fill by client', 'Top 10 sources by joinings'];
export function AskChart({ compact = false }) {
  const [q, setQ] = useState('');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function ask(text = q) {
    if (!text.trim()) return;
    setBusy(true); setErr(''); setQ(text);
    try { const x = await api.post('/ats-insights/ask', { question: text }); setOut(x.data); } catch (e) { setErr(errText(e, 'Could not answer that.')); } finally { setBusy(false); }
  }
  return (
    <div>
      <form className="ins-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input type="text" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder="Ask for a chart, e.g. joinings by client this year" aria-label="Your question" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || q.trim().length < 4}>{busy ? 'Building…' : 'Show chart'}</button>
      </form>
      {!out && !compact && <div className="ins-examples">{EXAMPLES.map((x) => <button key={x} type="button" className="btn btn-sm" onClick={() => ask(x)}>{x}</button>)}</div>}
      <Err err={err} />
      {out && (
        <div className={compact ? '' : 'card ins-card'}>
          <h3>{out.result.title} <span className="small-muted">· {out.result.total} row(s)</span></h3>
          <ResultChart result={out.result} height={compact ? 180 : 240} max={compact ? 8 : 0} />
          {!compact && <ResultTable result={out.result} />}
          <p className="small-muted">{out.note}. Only TeamLink&apos;s own fields are used; the numbers are your own area.{out.dropped && out.dropped.length ? ` Not understood: ${out.dropped.join(', ')}.` : ''}</p>
          {!compact && <SaveReport spec={out.spec} />}
        </div>
      )}
    </div>
  );
}

// --- 01.13 / 01.14 / 12.04 alerts and scheduled e-mails --------------------------------------------------------------------------
function Alerts() {
  const [d, err, load, setErr] = useGet('/ats-insights/alerts');
  const [f, setF] = useState({ metric: 'stale_jobs', direction: 'above', threshold: '0', days: '5' });
  const [vals, setVals] = useState(null);
  const [msg, setMsg] = useState('');
  const m = d && d.metrics.find((x) => x.id === f.metric);
  async function add() {
    setMsg(''); setErr('');
    try { await api.post('/ats-insights/alerts', { ...f, threshold: Number(f.threshold), days: Number(f.days) }); setMsg('Alert saved.'); load(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  async function check() { try { const x = await api.post('/ats-insights/alerts/check', {}); setVals(new Map(x.data.values.map((v) => [v.id, v]))); } catch (e) { setErr(errText(e, 'Could not check.')); } }
  if (!d) return <><Err err={err} /><Loading /></>;
  return (
    <div>
      {!d.on && <div className="notice"><span>Alerts are switched off for now: you can set them and press &quot;Check now&quot;, but nothing goes to the bell until an Admin switches them on.</span></div>}
      <div className="card ins-card">
        <h3>Tell me when…</h3>
        <div className="ins-bar">
          <label className="ins-wide"><span>Number</span><Combo value={f.metric} onChange={(e) => { const nm = d.metrics.find((x) => x.id === e.target.value); setF({ ...f, metric: e.target.value, direction: nm.usual }); }}>{d.metrics.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Combo></label>
          {m && m.days && <label><span>N days</span><input type="number" min="1" max="60" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>}
          <label><span>Goes</span><Combo value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="above">above</option><option value="below">below</option></Combo></label>
          <label><span>Limit</span><input type="number" min="0" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} /></label>
          <button type="button" className="btn btn-sm btn-primary" onClick={add}>Add alert</button>
        </div>
        <Ok msg={msg} /><Err err={err} />
      </div>
      <div className="ins-bar"><h3 className="ins-h">My alerts</h3><span className="ins-grow" /><button type="button" className="btn btn-sm" onClick={check}>Check now</button></div>
      <Table
        cols={[
          ['Number', (a) => `${a.label}${a.days ? ` (${a.days} days)` : ''}`], ['Limit', (a) => `${a.direction} ${a.threshold}`],
          ['Now', (a) => { const v = vals && vals.get(a.id); return v ? <b className={v.crossed ? 'ins-red' : ''}>{dash(v.value)}{v.crossed ? ' · crossed' : ''}</b> : dash(a.lastValue); }, { num: true }],
          ['Last note', (a) => (a.lastFiredAt ? dayText(a.lastFiredAt) : '—')],
          ['', (a) => (
            <span className="ins-actions">
              <button type="button" className="btn btn-sm" onClick={async () => { await api.patch(`/ats-insights/alerts/${a.id}`, { active: !a.active }); load(); }}>{a.active ? 'Pause' : 'Resume'}</button>
              <button type="button" className="btn btn-sm" onClick={async () => { await api.delete(`/ats-insights/alerts/${a.id}`); load(); }}>Remove</button>
            </span>
          )],
        ]}
        rows={d.alerts} empty="No alerts yet."
      />
    </div>
  );
}
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function Schedules() {
  const [d, err, load, setErr] = useGet('/ats-insights/schedules');
  const [people, setPeople] = useState([]);
  const [reports, setReports] = useState([]);
  const [f, setF] = useState({ kind: 'dashboard', reportId: '', frequency: 'weekly', weekday: '1', monthDay: '1', hour: '9', recipientIds: [] });
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.get('/ats-insights/schedules/recipients').then((x) => setPeople(x.data.people || [])).catch(() => {});
    api.get('/ats-insights/reports').then((x) => setReports(x.data.reports || [])).catch(() => {});
  }, []);
  async function add() {
    setMsg(''); setErr('');
    try { await api.post('/ats-insights/schedules', { ...f, weekday: Number(f.weekday), monthDay: Number(f.monthDay), hour: Number(f.hour) }); setMsg('Schedule saved.'); load(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  if (!d) return <><Err err={err} /><Loading /></>;
  return (
    <div>
      {!d.on && <div className="notice"><span>Scheduled e-mails are switched off for now: your schedules are kept, and nothing is sent until an Admin switches them on.</span></div>}
      <div className="card ins-card">
        <h3>E-mail me…</h3>
        <div className="ins-bar">
          <label><span>What</span><Combo value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="dashboard">My dashboard</option><option value="report" disabled={!reports.length}>A saved report</option></Combo></label>
          {f.kind === 'report' && <label className="ins-wide"><span>Report</span><Combo value={f.reportId} onChange={(e) => setF({ ...f, reportId: e.target.value })}><option value="">Pick a report</option>{reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Combo></label>}
          <label><span>How often</span><Combo value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></Combo></label>
          {f.frequency === 'weekly' && <label><span>Day</span><Combo value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{WEEK.map((w, i) => <option key={w} value={String(i)}>{w}</option>)}</Combo></label>}
          {f.frequency === 'monthly' && <label><span>Day of month</span><input type="number" min="1" max="28" value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: e.target.value })} /></label>}
          <label><span>Hour (India time)</span><input type="number" min="6" max="22" value={f.hour} onChange={(e) => setF({ ...f, hour: e.target.value })} /></label>
        </div>
        {people.length > 1 && (
          <fieldset className="ins-cols"><legend>Send to (each person gets their own numbers)</legend>
            {people.slice(0, 60).map((p) => (
              <label key={p.id} className="ins-check"><input type="checkbox" checked={f.recipientIds.includes(p.id)} onChange={(e) => setF({ ...f, recipientIds: e.target.checked ? [...f.recipientIds, p.id] : f.recipientIds.filter((x) => x !== p.id) })} /> {p.name}</label>
            ))}
          </fieldset>
        )}
        <button type="button" className="btn btn-sm btn-primary" onClick={add} disabled={f.kind === 'report' && !f.reportId}>Add schedule</button>
        <Ok msg={msg} /><Err err={err} />
      </div>
      <Table
        cols={[
          ['What', (s) => s.reportName], ['When', (s) => s.when], ['To', (s) => s.recipients.map((r) => r.name).join(', ')], ['Next', (s) => (s.active ? dayText(s.nextDueAt) : 'Paused')],
          ['Last sent', (s) => (s.lastSentAt ? `${dayText(s.lastSentAt)} · ${s.lastStatus}` : '—')],
          ['', (s) => (
            <span className="ins-actions">
              <button type="button" className="btn btn-sm" onClick={async () => { await api.patch(`/ats-insights/schedules/${s.id}`, { active: !s.active }); load(); }}>{s.active ? 'Pause' : 'Resume'}</button>
              <button type="button" className="btn btn-sm" onClick={async () => { await api.delete(`/ats-insights/schedules/${s.id}`); load(); }}>Remove</button>
            </span>
          )],
        ]}
        rows={d.schedules} empty="No schedules yet."
      />
    </div>
  );
}
function Switches() {
  const [d, err, load, setErr] = useGet('/ats-insights/switches');
  const [msg, setMsg] = useState('');
  if (!d) return <><Err err={err} /><Loading /></>;
  return (
    <div className="card ins-card">
      <h3>Admin switches (all OFF until you turn them on)</h3>
      {Object.entries(d.labels).map(([k, label]) => (
        <div key={k} className="ins-switch">
          <label className="ins-check"><input type="checkbox" checked={!!d.switches[k]} onChange={async (e) => { try { await api.put('/ats-insights/switches', { [k]: e.target.checked }); setMsg('Saved.'); load(); } catch (x) { setErr(errText(x, 'Could not save.')); } }} /> {label}</label>
          <button type="button" className="btn btn-sm" onClick={async () => { try { const x = await api.post(`/ats-insights/run/${k}`, {}); setMsg(x.data.skipped || `Done: ${JSON.stringify(x.data).slice(0, 120)}`); } catch (y) { setErr(errText(y, 'Could not run.')); } }}>Run now</button>
        </div>
      ))}
      <Ok msg={msg} /><Err err={err} />
    </div>
  );
}
function AlertsAndSchedules() {
  const access = useAccess();
  const [part, setPart] = useState('alerts');
  const admin = access && access.access && access.access.admin;
  const tabs = [{ key: 'alerts', label: 'Metric alerts' }, { key: 'schedules', label: 'Scheduled e-mails' }, ...(admin ? [{ key: 'switches', label: 'Admin switches' }] : [])];
  return (
    <div>
      <TabStrip label="Alerts and e-mails" tabs={tabs} value={part} onChange={setPart} />
      {part === 'alerts' && <Alerts />}
      {part === 'schedules' && <Schedules />}
      {part === 'switches' && admin && <Switches />}
    </div>
  );
}

// --- 12.11 backdoor --------------------------------------------------------------------------
function Backdoor({ canExport }) {
  const [status, setStatus] = useState('');
  const [d, err, load, setErr] = useGet('/ats-insights/backdoor', useMemo(() => (status ? { status } : {}), [status]));
  const [clients, setClients] = useState([]);
  const [cl, setCl] = useState({ clientId: '', text: '' });
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/requirements/client-options').then((x) => setClients(x.data || [])).catch(() => setClients([])); }, []);
  async function mark(r, st) {
    setMsg(''); setErr('');
    const note = st === 'suspected' ? '' : window.prompt(st === 'confirmed' ? 'How was it confirmed? (for example "client HR said on call")' : 'Why is it not a backdoor hire?', '');
    if (note === null) return;
    try { await api.post('/ats-insights/backdoor/mark', { applicationId: r.applicationId, status: st, note }); setMsg('Saved.'); load(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  async function sendList() {
    setMsg(''); setErr('');
    try { const x = await api.post('/ats-insights/backdoor/client-list', cl); setMsg(`${x.data.matched.length} of ${x.data.lines} matched people we sent to this client${x.data.notMatched.length ? `; not matched: ${x.data.notMatched.join(', ')}` : ''}.`); setCl({ ...cl, text: '' }); load(); } catch (e) { setErr(errText(e, 'Could not record the list.')); }
  }
  return (
    <div>
      <div className="ins-bar">
        <label><span>Show</span><Combo value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="suspected">Suspected</option><option value="confirmed">Confirmed</option><option value="dismissed">Not backdoor</option></Combo></label>
        <span className="ins-grow" />
        <DownloadButtons url="/ats-insights/backdoor" params={status ? { status } : {}} name="backdoor-hires" onError={setErr} show={canExport} />
      </div>
      <Err err={err} /><Ok msg={msg} />
      {!d ? <Loading /> : (
        <>
          <StatRow>
            <StatCard label="Suspected" value={d.totals.suspected} tone={d.totals.suspected ? 'yellow' : 'green'} />
            <StatCard label="Confirmed" value={d.totals.confirmed} tone={d.totals.confirmed ? 'red' : 'green'} />
            <StatCard label="Not backdoor" value={d.totals.dismissed} />
            <StatCard label="People checked" value={d.totals.checked} hint="sent to a client, did not join through us" />
          </StatRow>
          <Table
            cols={[
              ['Candidate', (r) => <Link to={`/candidates/${r.candidateId}`}>{r.candidate}</Link>], ['Client', (r) => r.client], ['Requirement', (r) => r.requirement], ['Sent on', (r) => dayText(r.sentOn)],
              ['Outcome', (r) => r.outcome], ['Why', (r) => r.signals.join('; ') || r.note || '—'], ['Status', (r) => <b>{r.statusLabel}</b>],
              ...(d.rows.some((r) => r.feeAtRisk) ? [['Fee at risk', (r) => r.feeAtRisk || '—']] : []),
              ['', (r) => (d.canMark ? (
                <span className="ins-actions">
                  {!r.marked && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'suspected')}>Mark</button>}
                  {d.canDecide && r.status !== 'confirmed' && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'confirmed')}>Confirm</button>}
                  {d.canDecide && r.status !== 'dismissed' && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'dismissed')}>Not backdoor</button>}
                </span>
              ) : null)],
            ]}
            rows={d.rows} keyOf={(r) => r.key} empty="No suspected backdoor hire in your area."
          />
          <Note>{d.note}</Note>
          {d.canDecide && (
            <div className="card ins-card">
              <h3>The client told us who joined them directly</h3>
              <div className="ins-bar">
                <label className="ins-wide"><span>Client</span><Combo value={cl.clientId} onChange={(e) => setCl({ ...cl, clientId: e.target.value })}><option value="">Pick the client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Combo></label>
              </div>
              <textarea className="ins-text" rows={4} value={cl.text} onChange={(e) => setCl({ ...cl, text: e.target.value })} placeholder="One per line: a name, a phone number or an e-mail" aria-label="The client's list" />
              <button type="button" className="btn btn-sm btn-primary" disabled={!cl.clientId || !cl.text.trim()} onClick={sendList}>Match against the people we sent</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- 12.12 quality of hire --------------------------------------------------------------------------
function Qoh({ canExport }) {
  const [d, err, load, setErr] = useGet('/ats-insights/qoh');
  const [link, setLink] = useState(null);
  async function make(p) {
    setErr('');
    try { const x = await api.post('/ats-insights/qoh/link', { applicationId: p.applicationId, day: p.day }); setLink({ ...x.data, who: p.candidate }); load(); } catch (e) { setErr(errText(e, 'Could not make the link.')); }
  }
  return (
    <div>
      <div className="ins-bar"><span className="ins-grow" /><DownloadButtons url="/ats-insights/qoh" name="quality-of-hire" onError={setErr} show={canExport} /></div>
      <Err err={err} />
      {link && (
        <div className="notice green"><span>Link for {link.who} ({link.day} days): <input className="ins-link" readOnly value={link.link} onFocus={(e) => e.target.select()} aria-label="Survey link" /> <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(link.link)}>Copy</button> Send it to the client yourself.</span></div>
      )}
      {!d ? <Loading /> : (
        <>
          {!d.automatic && <div className="notice"><span>Automatic sending is off: make a link below and send it to the client yourself, or ask an Admin to switch on the 30 / 60 / 90-day e-mails.</span></div>}
          <StatRow>
            <StatCard label="Average rating" value={d.totals.rating === null ? null : `${d.totals.rating} / 5`} tone="blue" />
            <StatCard label="Would hire again" value={d.totals.rehire === null ? null : `${d.totals.rehire}%`} />
            <StatCard label="Answers" value={d.totals.answered} hint={`of ${d.totals.surveys} surveys`} zeroText="None yet" />
            <StatCard label="Skills / attendance" value={d.totals.skills === null ? null : `${dash(d.totals.skills)} / ${dash(d.totals.attendance)}`} />
          </StatRow>
          <h3 className="ins-h">Ask now</h3>
          <Table
            cols={[['Candidate', (p) => p.candidate], ['Requirement', (p) => p.requirement], ['Client', (p) => p.client], ['Joined', (p) => dayText(p.joinedOn)], ['Survey', (p) => `${p.day} days`],
              ['', (p) => <button type="button" className="btn btn-sm" onClick={() => make(p)}>Make link</button>]]}
            rows={d.pending} keyOf={(p) => `${p.applicationId}-${p.day}`} max={50} empty="Nobody is due for a survey right now."
          />
          <h3 className="ins-h">Answers</h3>
          <Table
            cols={[['Candidate', (r) => r.candidate], ['Client', (r) => r.client], ['Recruiter', (r) => r.recruiter], ['Day', (r) => r.day, { num: true }], ['Rating', (r) => dash(r.rating), { num: true }],
              ['Would rehire', (r) => dash(r.rehire)], ['Comment', (r) => dash(r.comment)], ['Status', (r) => (r.answeredAt ? `Answered ${dayText(r.answeredAt)}` : r.sendStatus || 'Link made')]]}
            rows={d.rows} max={300} empty="No surveys yet."
          />
          <div className="ins-two">
            <div><h3 className="ins-h">By client</h3><Table cols={[['Client', (r) => r.name], ['Answers', (r) => r.answers, { num: true }], ['Rating', (r) => dash(r.rating), { num: true }], ['Rehire %', (r) => r.rehire, { num: true }]]} rows={d.byClient} keyOf={(r) => r.name} /></div>
            <div><h3 className="ins-h">By recruiter</h3><Table cols={[['Recruiter', (r) => r.name], ['Answers', (r) => r.answers, { num: true }], ['Rating', (r) => dash(r.rating), { num: true }], ['Rehire %', (r) => r.rehire, { num: true }]]} rows={d.byRecruiter} keyOf={(r) => r.name} /></div>
          </div>
        </>
      )}
    </div>
  );
}

// --- 12.14 compliance --------------------------------------------------------------------------
function Compliance() {
  const [days, setDays] = useState('30');
  const [d, err, , setErr] = useGet('/ats-insights/compliance', useMemo(() => ({ days }), [days]));
  return (
    <div>
      <div className="ins-bar">
        <label><span>Access log for</span><Combo value={days} onChange={(e) => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></Combo></label>
        <span className="ins-grow" />
        <DownloadButtons url="/ats-insights/compliance" params={{ days }} name="compliance-dpdp" onError={setErr} />
      </div>
      <Err err={err} />
      {!d ? <Loading /> : (
        <>
          <div className="notice"><span><b>{d.law}.</b> {d.notApplicable}</span></div>
          <h3 className="ins-h">Consent</h3>
          <StatRow>
            <StatCard label="Candidates" value={d.consent.total} />
            <StatCard label={`Consent older than ${d.consent.reviewMonths} months`} value={d.consent.olderThanReview} tone={d.consent.olderThanReview ? 'yellow' : 'green'} />
            <StatCard label="Never recorded" value={d.consent.neverRecorded} tone={d.consent.neverRecorded ? 'yellow' : 'green'} />
            <StatCard label="Withdrawn / do not contact" value={d.consent.withdrawnOrDoNotContact} />
          </StatRow>
          <div className="ins-two">
            <Table cols={[['Consent', (r) => r.status], ['People', (r) => r.people, { num: true }]]} rows={d.consent.byStatus} keyOf={(r) => r.status} />
            <Table cols={[['How consent was given', (r) => r.source], ['People', (r) => r.people, { num: true }]]} rows={d.consent.bySource} keyOf={(r) => r.source} />
          </div>
          <h3 className="ins-h">Data retention</h3>
          <Table cols={[['What', (r) => r.what], ['Kept', (r) => r.keep]]} rows={d.retention.rules} keyOf={(r) => r.what} />
          <p className="small-muted">Legal holds: {d.retention.legalHolds} · erasures in the window: {d.retention.erasures}. Consent review, export and erasure: Administration → Privacy.</p>
          <h3 className="ins-h">Access log (last {d.window.days} days: {d.access.views} views of personal data)</h3>
          <div className="ins-two">
            <Table cols={[['Person', (r) => r.person], ['Opened', (r) => r.what], ['Times', (r) => r.times, { num: true }]]} rows={d.access.byPerson} max={50} keyOf={(r, i) => i} empty="No views logged in this window." />
            <Table cols={[['Person', (r) => r.person], ['Downloads', (r) => r.downloads, { num: true }]]} rows={d.access.exports} keyOf={(r) => r.person} empty="No downloads in this window." />
          </div>
        </>
      )}
    </div>
  );
}

// --- 12.15 BI feed --------------------------------------------------------------------------
function BiFeed() {
  const [d, err, load, setErr] = useGet('/ats-insights/bi/keys');
  const [label, setLabel] = useState('');
  const [feeds, setFeeds] = useState(['jobs', 'applications', 'joinings', 'clients']);
  const [made, setMade] = useState(null);
  const base = `${window.location.origin}/api/bi/v1`;
  async function create() {
    setErr('');
    try { const x = await api.post('/ats-insights/bi/keys', { label, feeds }); setMade(x.data); setLabel(''); load(); } catch (e) { setErr(errText(e, 'Could not make the key.')); }
  }
  if (err && !d) return <Err err={err} />;
  if (!d) return <Loading />;
  return (
    <div>
      <div className="card ins-card">
        <h3>Connect Power BI, Looker Studio or Excel</h3>
        <ol className="ins-steps">
          <li>Make a key below (it is shown once - copy it).</li>
          <li><b>Excel</b>: Data → From Web → paste <code>{base}/joinings.csv?key=YOUR-KEY</code>. <b>Power BI</b>: Get data → Web → the same address with <code>.json</code> or <code>.csv</code>. <b>Looker Studio</b>: a CSV / JSON-from-URL connector with the same address.</li>
          <li>Feeds: {d.feeds.map((f) => <code key={f}>{f}</code>)} · at most {d.limit} calls an hour per key · no candidate name, phone, e-mail or salary.</li>
        </ol>
        <div className="ins-bar">
          <label className="ins-wide"><span>Who uses it</span><input type="text" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Power BI - founder" /></label>
          {d.feeds.map((f) => <label key={f} className="ins-check"><input type="checkbox" checked={feeds.includes(f)} onChange={(e) => setFeeds(e.target.checked ? [...feeds, f] : feeds.filter((x) => x !== f))} /> {f}</label>)}
          <button type="button" className="btn btn-sm btn-primary" disabled={label.trim().length < 3 || !feeds.length} onClick={create}>Make key</button>
        </div>
        {made && <div className="notice green"><span>Your key (copy it now, it is not shown again): <input className="ins-link" readOnly value={made.key} onFocus={(e) => e.target.select()} aria-label="API key" /></span></div>}
        <Err err={err} />
      </div>
      <Table
        cols={[['Who uses it', (k) => k.label], ['Key ends', (k) => `…${k.keyTail}`], ['Feeds', (k) => k.feeds.join(', ')], ['Made', (k) => `${dayText(k.createdAt)} by ${k.createdByName || '—'}`], ['Used', (k) => (k.lastUsedAt ? `${k.uses} times, last ${dayText(k.lastUsedAt)}` : 'Not yet')],
          ['', (k) => (k.active ? <button type="button" className="btn btn-sm" onClick={async () => { if (window.confirm(`Revoke the key "${k.label}"? Reports using it stop refreshing.`)) { await api.delete(`/ats-insights/bi/keys/${k.id}`); load(); } }}>Revoke</button> : `Revoked ${dayText(k.revokedAt)}`)]]}
        rows={d.keys} empty="No keys yet."
      />
    </div>
  );
}

export default function InsightReports({ tab, canExport }) {
  switch (tab) {
    case 'ttfjob': return <TtfByJob canExport={canExport} />;
    case 'openings': return <Openings canExport={canExport} />;
    case 'readiness': return <Readiness canExport={canExport} />;
    case 'forecast': return <Forecast canExport={canExport} />;
    case 'bottlenecks': return <Bottlenecks canExport={canExport} />;
    case 'builder': return <Builder canExport={canExport} />;
    case 'askchart': return <AskChart />;
    case 'schedules': return <AlertsAndSchedules />;
    case 'backdoor': return <Backdoor canExport={canExport} />;
    case 'qoh': return <Qoh canExport={canExport} />;
    case 'compliance': return <Compliance />;
    case 'bifeed': return <BiFeed />;
    default: return null;
  }
}

// CRM > DASHBOARD - wave A reports (2026-11-24): the REPORT BUILDER (pick what it is about, columns, filters, period, group, count / sum,
// chart; save for yourself or share; Excel; mail it on a schedule), MY DASHBOARD (any saved report or a ready number as a widget, in your
// order and width; a Sales manager sets the team's default), the LEADERBOARD (points, ranks, badges) and the TRENDS (the open pipeline
// week by week from the daily snapshots, rebuilt from the stage moves before them; lead and deal cohorts). Plain SVG charts, no library.
// Each person sees only what the server allows (crm/reportBuilder.js, crm/insights.js).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, moneyShort, dateOf, dateTimeOf, download } from './crmShared.jsx';

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const fmt = (v, isMoney) => (isMoney ? moneyShort(v) : (typeof v === 'number' ? v.toLocaleString('en-IN') : (v == null || v === '' ? '—' : String(v))));
const looksMoney = (label) => /value|total|amount|paid|balance|tax|weighted/i.test(String(label || ''));

// ---- three small charts ------------------------------------------------------------------------------------------------------
export function MiniChart({ kind, rows, valueLabel }) {
  const [tip, setTip] = useState(null);
  const data = (rows || []).slice(0, 24);
  if (!data.length) return <div className="small-muted">Nothing to show.</div>;
  const isMoney = looksMoney(valueLabel);
  const max = Math.max(1, ...data.map((r) => Number(r.value) || 0));
  const tipView = tip ? <div className="crm-tip" style={{ left: tip.x, top: tip.y }}>{tip.t}</div> : null;
  const on = (t) => ({ onMouseMove: (e) => { const b = e.currentTarget.closest('[data-tipbox]').getBoundingClientRect(); setTip({ t, x: e.clientX - b.left + 10, y: e.clientY - b.top - 6 }); }, onMouseLeave: () => setTip(null) });
  if (kind === 'pie') {
    const top = data.slice(0, 7); const rest = data.slice(7);
    const list = [...top, ...(rest.length ? [{ group: 'Other', value: rest.reduce((a, r) => a + (Number(r.value) || 0), 0) }] : [])].filter((r) => Number(r.value) > 0);
    const total = list.reduce((a, r) => a + Number(r.value), 0);
    if (!total) return <div className="small-muted">Nothing to show.</div>;
    let a0 = -Math.PI / 2;
    const C = 60; const R = 52; const r0 = 30;
    const p = (ang, rad) => `${C + rad * Math.cos(ang)} ${C + rad * Math.sin(ang)}`;
    return (
      <div data-tipbox style={{ position: 'relative', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <svg viewBox="0 0 120 120" width="140" height="140" role="img" aria-label="Pie chart">
          {list.map((r, i) => {
            const a1 = a0 + (Number(r.value) / total) * Math.PI * 2 - 0.0001;
            const big = a1 - a0 > Math.PI ? 1 : 0;
            const d = `M ${p(a0, R)} A ${R} ${R} 0 ${big} 1 ${p(a1, R)} L ${p(a1, r0)} A ${r0} ${r0} 0 ${big} 0 ${p(a0, r0)} Z`;
            a0 = a1 + 0.0001;
            return <path key={r.group} d={d} fill={SERIES[i % SERIES.length]} {...on(`${r.group}: ${fmt(Number(r.value), isMoney)} (${Math.round((Number(r.value) / total) * 100)}%)`)} />;
          })}
        </svg>
        <div className="crm-legend" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>{list.map((r, i) => <span key={r.group}><i style={{ background: SERIES[i % SERIES.length] }} />{r.group} <b>{fmt(Number(r.value), isMoney)}</b></span>)}</div>
        {tipView}
      </div>
    );
  }
  if (kind === 'line') {
    const W = 320; const H = 140; const pad = 24;
    const x = (i) => pad + (data.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (data.length - 1));
    const y = (v) => H - pad - ((Number(v) || 0) / max) * (H - 2 * pad);
    return (
      <div data-tipbox style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 520 }} role="img" aria-label="Line chart">
          <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--line)" />
          <polyline fill="none" stroke={SERIES[0]} strokeWidth="2" points={data.map((r, i) => `${x(i)},${y(r.value)}`).join(' ')} />
          {data.map((r, i) => <circle key={r.group} cx={x(i)} cy={y(r.value)} r="4" fill={SERIES[0]} {...on(`${r.group}: ${fmt(Number(r.value), isMoney)}`)} />)}
          {data.map((r, i) => (i === 0 || i === data.length - 1 || data.length <= 6 ? <text key={`t${r.group}`} x={x(i)} y={H - 6} fontSize="9" textAnchor="middle" fill="var(--ink-soft)">{String(r.group).slice(0, 10)}</text> : null))}
        </svg>
        {tipView}
      </div>
    );
  }
  return (
    <div data-tipbox style={{ position: 'relative', display: 'grid', gap: 5 }}>
      {data.map((r, i) => (
        <div key={r.group} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 34%) 1fr auto', gap: 8, alignItems: 'center', fontSize: 12 }} {...on(`${r.group}: ${fmt(Number(r.value), isMoney)}${r.records != null ? ` · ${r.records} records` : ''}`)}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.group}>{r.group}</span>
          <span style={{ background: 'var(--line-soft)', borderRadius: 4, height: 12 }}><span style={{ display: 'block', height: 12, borderRadius: 4, width: `${Math.max(2, ((Number(r.value) || 0) / max) * 100)}%`, background: SERIES[i % SERIES.length] }} /></span>
          <b>{fmt(Number(r.value), isMoney)}</b>
        </div>
      ))}
      {tipView}
    </div>
  );
}
function ResultTable({ out }) {
  if (!out) return null;
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr>{out.columns.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
        <tbody>
          {!out.rows.length && <tr><td colSpan={out.columns.length} className="small-muted">Nothing matches.</td></tr>}
          {out.rows.slice(0, 200).map((r, i) => <tr key={i}>{out.columns.map((c) => <td key={c[0]}>{/At$|Date$|^expectedClose$|^at$/.test(c[0]) && r[c[0]] ? dateOf(String(r[c[0]]).slice(0, 10)) : fmt(r[c[0]], looksMoney(c[1]) && typeof r[c[0]] === 'number')}</td>)}</tr>)}{/* eslint-disable-line react/no-array-index-key */}
        </tbody>
      </table>
    </div>
  );
}
function Result({ out }) {
  if (!out) return null;
  return (
    <>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>{out.grouped ? `Total ${fmt(out.total, looksMoney(out.columns[1][1]))}` : `${out.total} record${out.total === 1 ? '' : 's'}${out.rows.length < out.total ? `, the first ${out.rows.length} shown` : ''}`}{out.range ? ` · ${dateOf(out.range[0])} – ${dateOf(new Date(Date.parse(`${out.range[1]}T00:00:00Z`) - 86400000).toISOString().slice(0, 10))}` : ''}</div>
      {out.grouped && out.chart !== 'table' && <div style={{ marginBottom: 10 }}><MiniChart kind={out.chart} rows={out.rows} valueLabel={out.columns[1][1]} /></div>}
      <ResultTable out={out} />
    </>
  );
}

// ---- the report builder -------------------------------------------------------------------------------------------------------
const EMPTY = { source: 'deals', columns: ['title', 'accountName', 'stage', 'value', 'ownerName'], filters: [], dateField: '', period: 'all', from: '', to: '', groupBy: '', groupDate: 'month', measure: { fn: 'count', field: '' }, chart: 'bar', sort: null, limit: 200 };
export function ReportBuilder() {
  const { me, toast } = useCrm();
  const [meta, setMeta] = useState(null);
  const [spec, setSpec] = useState(EMPTY);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState([]);
  const [cur, setCur] = useState(null); // the saved report open now
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('build'); // build | saved | schedules
  const loadSaved = () => api.get('/crm/a/builder/reports').then((r) => setSaved(r.data.reports)).catch(() => setSaved([]));
  useEffect(() => { api.get('/crm/a/builder/meta').then((r) => setMeta(r.data)).catch((e) => setErr(errOf(e, 'The report builder could not be opened.'))); loadSaved(); }, []);
  const src = meta && meta.sources.find((s) => s.key === spec.source);
  const fieldsOf = (t) => (src ? src.fields.filter((f) => !t || t.includes(f.type)) : []);
  const set = (patch) => setSpec((s) => ({ ...s, ...patch }));
  const body = () => ({ ...spec, groupBy: spec.groupBy || null, dateField: spec.dateField || null, measure: spec.measure.fn === 'count' ? { fn: 'count' } : spec.measure });
  async function run() {
    setBusy(true);
    try { const r = await api.post('/crm/a/builder/preview', body()); setOut(r.data); setErr(''); } catch (e) { setOut(null); setErr(errOf(e, 'The report could not be run.')); } finally { setBusy(false); }
  }
  async function save(asNew) {
    if (!name.trim()) { toast('Give the report a name first.'); return; }
    try {
      const r = cur && !asNew ? await api.put(`/crm/a/builder/reports/${cur.id}`, { name, spec: body(), shared }) : await api.post('/crm/a/builder/reports', { name, spec: body(), shared });
      setCur(r.data.report); toast(`Saved: ${r.data.report.name}.`); loadSaved();
    } catch (e) { toast(errOf(e, 'The report could not be saved.')); }
  }
  function open(rep) {
    const s = { ...EMPTY, ...rep.spec, groupBy: rep.spec.groupBy || '', dateField: rep.spec.dateField || '', measure: rep.spec.measure && rep.spec.measure.fn ? { fn: rep.spec.measure.fn, field: rep.spec.measure.field || '' } : { fn: 'count', field: '' } };
    setSpec(s); setCur(rep); setName(rep.name); setShared(rep.shared); setView('build');
    api.get(`/crm/a/builder/reports/${rep.id}/run`).then((r) => setOut(r.data)).catch((e) => setErr(errOf(e, 'The report could not be run.')));
  }
  async function remove(rep) {
    if (!window.confirm(`Remove the report "${rep.name}"? Its schedules go too.`)) return;
    try { await api.delete(`/crm/a/builder/reports/${rep.id}`); toast('Removed.'); if (cur && cur.id === rep.id) { setCur(null); setName(''); } loadSaved(); } catch (e) { toast(errOf(e, 'It could not be removed.')); }
  }
  if (err && !meta) return <div className="notice" role="alert">{err}</div>;
  if (!meta) return <div className="small-muted">Loading…</div>;
  const canShare = me.canAssign || (me.rights && me.rights.reports);
  return (
    <div className="card">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['build', 'Build a report'], ['saved', `Saved reports (${saved.length})`], ['schedules', 'Mailed on a schedule']].map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${view === k ? ' btn-primary' : ''}`} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'saved' && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Report</th><th>About</th><th>By</th><th>Shared</th><th /></tr></thead>
            <tbody>
              {!saved.length && <tr><td colSpan={5} className="small-muted">No saved reports yet. Build one and press Save.</td></tr>}
              {saved.map((r) => (
                <tr key={r.id}>
                  <td><button type="button" className="btn btn-sm" style={{ border: 'none', padding: 0, fontWeight: 600 }} onClick={() => open(r)}>{r.name}</button></td>
                  <td>{(meta.sources.find((s) => s.key === r.source) || {}).label || r.source}</td>
                  <td>{r.mine ? 'Me' : r.ownerName}</td>
                  <td>{r.shared ? 'With the team' : 'Only me'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {me.rights && me.rights.export && <button type="button" className="btn btn-sm" onClick={() => download(`/crm/a/builder/reports/${r.id}/xlsx`, `${r.name}.xlsx`).catch(() => toast('The download did not work.'))}>Excel</button>}
                    {r.canEdit && <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => remove(r)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view === 'schedules' && <Schedules saved={saved} />}
      {view === 'build' && (
        <>
          <div className="grid-3">
            <div className="field"><label>About</label><select value={spec.source} onChange={(e) => { const s = meta.sources.find((x) => x.key === e.target.value); setSpec({ ...EMPTY, source: e.target.value, columns: s.fields.slice(0, 5).map((f) => f.key) }); setOut(null); }}>{meta.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
            <div className="field"><label>Group by (for a chart)</label><select value={spec.groupBy} onChange={(e) => set({ groupBy: e.target.value })}><option value="">No group: a list of records</option>{fieldsOf().map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></div>
            {spec.groupBy && fieldsOf(['d']).some((f) => f.key === spec.groupBy) && <div className="field"><label>Date in steps of</label><select value={spec.groupDate} onChange={(e) => set({ groupDate: e.target.value })}><option value="month">Month</option><option value="week">Week</option><option value="day">Day</option></select></div>}
            {spec.groupBy && (
              <div className="field"><label>Count or add up</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={spec.measure.fn} onChange={(e) => set({ measure: { ...spec.measure, fn: e.target.value } })} style={{ width: 'auto' }}><option value="count">Count</option><option value="sum">Total of</option><option value="avg">Average of</option><option value="min">Lowest</option><option value="max">Highest</option></select>
                  {spec.measure.fn !== 'count' && <select value={spec.measure.field} onChange={(e) => set({ measure: { ...spec.measure, field: e.target.value } })} aria-label="Which number"><option value="">Pick a number…</option>{fieldsOf(['n']).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>}
                </div>
              </div>
            )}
            {spec.groupBy && <div className="field"><label>Chart</label><select value={spec.chart} onChange={(e) => set({ chart: e.target.value })}><option value="bar">Bars</option><option value="line">Line</option><option value="pie">Pie</option><option value="table">Table only</option></select></div>}
            <div className="field"><label>Period on</label><select value={spec.dateField} onChange={(e) => set({ dateField: e.target.value })}><option value="">Any date</option>{fieldsOf(['d']).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></div>
            {spec.dateField && <div className="field"><label>Period</label><select value={spec.period} onChange={(e) => set({ period: e.target.value })}>{meta.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></div>}
            {spec.dateField && spec.period === 'custom' && <div className="field"><label>From – to</label><div style={{ display: 'flex', gap: 6 }}><input type="date" value={spec.from} onChange={(e) => set({ from: e.target.value })} aria-label="From" /><input type="date" value={spec.to} onChange={(e) => set({ to: e.target.value })} aria-label="To" /></div></div>}
          </div>
          {!spec.groupBy && (
            <div className="field"><label>Columns</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {fieldsOf().map((f) => <label key={f.key} className="crm-right" style={{ fontSize: 12.5 }}><input type="checkbox" checked={spec.columns.includes(f.key)} onChange={(e) => set({ columns: e.target.checked ? [...spec.columns, f.key] : spec.columns.filter((c) => c !== f.key) })} /> {f.label}</label>)}
              </div>
            </div>
          )}
          <div className="field"><label>Filters</label>
            {spec.filters.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>{/* eslint-disable-line react/no-array-index-key */}
                <select value={f.field} onChange={(e) => set({ filters: spec.filters.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} aria-label="Field" style={{ flex: '1 1 140px' }}>{fieldsOf().map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
                <select value={f.op} onChange={(e) => set({ filters: spec.filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })} aria-label="How" style={{ flex: '1 1 110px' }}>{meta.ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
                {!['empty', 'not_empty'].includes(f.op) && <input type="text" value={f.value} onChange={(e) => set({ filters: spec.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} aria-label="Value" style={{ flex: '2 1 140px' }} />}
                <button type="button" className="btn btn-sm" onClick={() => set({ filters: spec.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">✕</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => set({ filters: [...spec.filters, { field: fieldsOf()[0].key, op: 'eq', value: '' }] })}>+ Filter</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 12px' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Report name" aria-label="Report name" style={{ width: 220 }} />
            {canShare && <label className="crm-right"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the sales team</label>}
            <button type="button" className="btn btn-sm" onClick={() => save(false)}>{cur ? 'Save' : 'Save report'}</button>
            {cur && <button type="button" className="btn btn-sm" onClick={() => save(true)}>Save as new</button>}
            {cur && me.rights && me.rights.export && <button type="button" className="btn btn-sm" onClick={() => download(`/crm/a/builder/reports/${cur.id}/xlsx`, `${cur.name}.xlsx`).catch(() => toast('The download did not work.'))}>Excel</button>}
          </div>
          {err && <div className="notice" role="alert">{err}</div>}
          <Result out={out} />
          <div className="small-muted" style={{ fontSize: 11.5, marginTop: 8 }}>A shared report shows each person only the records they may see.</div>
        </>
      )}
    </div>
  );
}

function Schedules({ saved }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ reportId: '', frequency: 'weekly', day: 1, time: '09:00', recipients: [me.userId] });
  const load = () => api.get('/crm/a/builder/schedules').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The schedules could not be read.') }));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const people = [{ id: me.userId, name: `${me.name} (me)` }, ...d.people.filter((p) => p.id !== me.userId)];
  async function add() {
    try { await api.post('/crm/a/builder/schedules', f); toast('Scheduled.'); load(); } catch (e) { toast(errOf(e, 'It could not be scheduled.')); }
  }
  return (
    <>
      {!d.on && <div className="notice" style={{ marginBottom: 10 }}>Scheduled mails are switched off. An Admin turns them on in Automation &gt; Switches. &quot;Send me a copy now&quot; works anyway.</div>}
      <div className="tbl-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Report</th><th>When</th><th>To</th><th>Last sent</th><th /></tr></thead>
          <tbody>
            {!d.schedules.length && <tr><td colSpan={5} className="small-muted">Nothing is scheduled yet.</td></tr>}
            {d.schedules.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b></td><td>{s.words}{s.nextAt ? <div className="small-muted" style={{ fontSize: 11.5 }}>next {dateTimeOf(s.nextAt)}</div> : null}</td>
                <td>{s.recipients.length} people</td><td>{s.lastSentAt ? `${dateTimeOf(s.lastSentAt)} · ${s.lastResult || ''}` : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm" onClick={() => api.post(`/crm/a/builder/schedules/${s.id}/send-now`).then((r) => toast(r.data.message)).catch((e) => toast(errOf(e, 'It did not go.')))}>Send me a copy now</button>
                  <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => api.delete(`/crm/a/builder/schedules/${s.id}`).then(() => { toast('Removed.'); load(); }).catch((e) => toast(errOf(e, 'It could not be removed.')))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(me.canAssign || (me.rights && me.rights.reports)) && (
        <>
          <div className="section-label">Mail a report on a schedule</div>
          <div className="grid-3">
            <div className="field"><label>Report</label><select value={f.reportId} onChange={(e) => setF({ ...f, reportId: e.target.value })}><option value="">Pick a saved report…</option>{saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
            <div className="field"><label>How often</label><select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></div>
            {f.frequency === 'weekly' && <div className="field"><label>On</label><select value={f.day} onChange={(e) => setF({ ...f, day: Number(e.target.value) })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((w, i) => <option key={w} value={i}>{w}</option>)}</select></div>}
            {f.frequency === 'monthly' && <div className="field"><label>Day of the month</label><input type="number" min={1} max={31} value={f.day} onChange={(e) => setF({ ...f, day: Number(e.target.value) })} /></div>}
            <div className="field"><label>Time (India)</label><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
          </div>
          <div className="field"><label>Who gets it (the CRM team)</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{people.map((p) => <label key={p.id} className="crm-right"><input type="checkbox" checked={f.recipients.includes(p.id)} onChange={(e) => setF({ ...f, recipients: e.target.checked ? [...f.recipients, p.id] : f.recipients.filter((x) => x !== p.id) })} /> {p.name}</label>)}</div>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={!f.reportId || !f.recipients.length} onClick={add}>Schedule it</button>
          <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>The mail has the table and the Excel file. It is read with your view of the CRM.</div>
        </>
      )}
    </>
  );
}

// ---- my dashboard ------------------------------------------------------------------------------------------------------------
export function MyDashboard() {
  const { me, toast, version } = useCrm();
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null); // the widgets being arranged
  const [reports, setReports] = useState([]);
  const [drag, setDrag] = useState(null);
  const load = () => api.get('/crm/a/my-dashboard').then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'Your dashboard could not be read.') }));
  useEffect(() => { load(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  function startEdit() {
    api.get('/crm/a/builder/reports').then((r) => setReports(r.data.reports)).catch(() => setReports([]));
    setEdit(d.widgets.map((w) => ({ type: w.type, key: w.key, reportId: w.reportId, size: w.size, chart: w.chart || null, title: w.title })));
  }
  async function save(team) {
    try { await api.put('/crm/a/my-dashboard', { widgets: edit, team: !!team }); toast(team ? 'Saved as the team\'s dashboard.' : 'Your dashboard is saved.'); setEdit(null); load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); }
  }
  async function reset() { try { await api.put('/crm/a/my-dashboard', { reset: true }); setEdit(null); load(); } catch (e) { toast(errOf(e, 'It could not be reset.')); } }
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice">{d.error}</div>;
  const move = (from, to) => { if (from === to || from == null) return; const n = [...edit]; const [x] = n.splice(from, 1); n.splice(to, 0, x); setEdit(n); };
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="small-muted" style={{ fontSize: 12 }}>{d.from === 'mine' ? 'Your own layout' : d.from === 'team' ? 'The team\'s layout (change it to make your own)' : 'The starting layout'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!edit && <button type="button" className="btn btn-sm" onClick={startEdit}>Arrange</button>}
          {!edit && d.from === 'mine' && <button type="button" className="btn btn-sm" onClick={reset}>Back to the team layout</button>}
        </span>
      </div>
      {edit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Arrange: drag to change the order</div>
          {edit.map((w, i) => (
            <div key={`${w.type}${w.key || w.reportId}${i}`} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { move(drag, i); setDrag(null); }} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 6, cursor: 'grab', background: 'var(--paper-raised)' }}>{/* eslint-disable-line react/no-array-index-key */}
              <span aria-hidden="true">⋮⋮</span>
              <b style={{ flex: '1 1 160px', fontSize: 13 }}>{w.title || (w.type === 'kpi' ? (d.kpis.find((k) => k.key === w.key) || {}).label : (reports.find((r) => r.id === w.reportId) || {}).name) || 'Widget'}</b>
              <select value={w.size} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} aria-label="Width" style={{ width: 'auto' }}><option value="small">Small</option><option value="half">Half</option><option value="full">Full width</option></select>
              {w.type === 'report' && <select value={w.chart || ''} onChange={(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, chart: e.target.value || null } : x)))} aria-label="Chart" style={{ width: 'auto' }}><option value="">As saved</option><option value="bar">Bars</option><option value="line">Line</option><option value="pie">Pie</option><option value="table">Table</option></select>}
              <button type="button" className="btn btn-sm" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Up">↑</button>
              <button type="button" className="btn btn-sm" disabled={i === edit.length - 1} onClick={() => move(i, i + 1)} aria-label="Down">↓</button>
              <button type="button" className="btn btn-sm" onClick={() => setEdit(edit.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            <select defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (!v) return; const [t, k] = v.split(':'); setEdit([...edit, t === 'kpi' ? { type: 'kpi', key: k, size: 'small' } : { type: 'report', reportId: k, size: 'half' }]); }} aria-label="Add a widget" style={{ width: 'auto' }}>
              <option value="">+ Add a widget…</option>
              <optgroup label="Ready numbers">{d.kpis.map((k) => <option key={k.key} value={`kpi:${k.key}`}>{k.label}</option>)}</optgroup>
              <optgroup label="Saved reports">{reports.map((r) => <option key={r.id} value={`report:${r.id}`}>{r.name}{r.shared ? ' (shared)' : ''}</option>)}</optgroup>
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => save(false)}>Save my dashboard</button>
            {d.canSetTeam && <button type="button" className="btn btn-sm" onClick={() => save(true)} title="Only shared reports can be on it">Save as the team&apos;s dashboard</button>}
            <button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
          {!reports.length && <div className="small-muted" style={{ fontSize: 12 }}>Build and save a report in &quot;Report builder&quot; to put a chart here.</div>}
        </div>
      )}
      <div className="crm-mydash">
        {d.widgets.map((w, i) => (
          <div key={i} className={`crm-card w-${w.size || 'half'}`}>{/* eslint-disable-line react/no-array-index-key */}
            <div className="crm-card-head"><h3>{w.title}</h3></div>
            {w.missing && <div className="small-muted">This report was removed or is no longer shared.</div>}
            {w.type === 'kpi' && w.data && <><div style={{ fontSize: 24, fontWeight: 700 }}>{w.data.money ? moneyShort(w.data.value) : Number(w.data.value || 0).toLocaleString('en-IN')}</div><div className="small-muted" style={{ fontSize: 12 }}>{w.data.sub}</div></>}
            {w.type === 'report' && w.data && (w.data.grouped && w.data.chart !== 'table' ? <MiniChart kind={w.data.chart} rows={w.data.rows} valueLabel={w.data.columns[1][1]} /> : <ResultTable out={{ ...w.data, rows: w.data.rows.slice(0, 10) }} />)}
          </div>
        ))}
        {!d.widgets.length && <div className="small-muted">Nothing here yet. Press Arrange to add widgets.</div>}
      </div>
    </>
  );
}

// ---- the leaderboard ----------------------------------------------------------------------------------------------------------
const BADGE_ICON = { closer: '🏆', active: '🔥', ontime: '⏱️', target: '🎯', first: '⭐', streak: '⚡' };
export function Leaderboard() {
  const { me } = useCrm();
  const [period, setPeriod] = useState('month');
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.get('/crm/a/leaderboard', { params: { period } }).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The leaderboard could not be read.') })); }, [period]);
  return (
    <div className="card">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>Leaderboard</div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto', marginLeft: 'auto' }}><option value="week">This week</option><option value="month">This month</option><option value="last_month">Last month</option><option value="quarter">This quarter</option><option value="year">This year</option></select>
      </div>
      {!d && <div className="small-muted">Loading…</div>}
      {d && d.error && <div className="notice">{d.error}</div>}
      {d && !d.error && (
        <>
          {d.me && <div className="notice" style={{ marginBottom: 10 }}>You are <b>#{d.me.rank}</b> with <b>{d.me.points}</b> points.</div>}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>#</th><th>Salesperson</th><th style={{ textAlign: 'right' }}>Points</th>{d.full && !d.rows.some((r) => r.hidden) && <><th style={{ textAlign: 'right' }}>Won</th><th style={{ textAlign: 'right' }}>Converted</th><th style={{ textAlign: 'right' }}>Logged</th><th style={{ textAlign: 'right' }}>On time</th><th style={{ textAlign: 'right' }}>Target</th></>}<th>Badges</th></tr></thead>
              <tbody>
                {!d.rows.length && <tr><td colSpan={9} className="small-muted">Nothing yet in this period.</td></tr>}
                {d.rows.map((r) => (
                  <tr key={r.id} style={r.id === me.userId ? { background: 'var(--line-soft)' } : undefined}>
                    <td><b>{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</b></td>
                    <td><b>{r.name}</b></td>
                    <td style={{ textAlign: 'right' }}><b>{r.points}</b></td>
                    {d.full && !d.rows.some((x) => x.hidden) && <>
                      <td style={{ textAlign: 'right' }}>{r.wonDeals ? <>{moneyShort(r.wonValue)} <span className="small-muted">({r.wonDeals})</span></> : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.converted || '—'}</td>
                      <td style={{ textAlign: 'right' }} title={`${r.calls} calls, ${r.meetings} meetings`}>{r.work || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.onTimePercent != null ? `${r.onTimePercent}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.targetPercent != null ? `${r.targetPercent}%` : '—'}</td>
                    </>}
                    <td>{(r.badges || []).map((b) => <span key={b.key} className="status review" title={b.why} style={{ marginRight: 4, whiteSpace: 'nowrap' }}>{BADGE_ICON[b.key]} {b.label}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ fontSize: 11.5, marginTop: 8 }}>Points: a won deal {d.points.wonDeal}, every ₹10,000 won {d.points.per10k}, a converted lead {d.points.converted}, each call / meeting / email logged {d.points.work}, a follow-up done on time {d.points.onTime}.</div>
        </>
      )}
    </div>
  );
}

// ---- trends and cohorts -------------------------------------------------------------------------------------------------------
export function Trends() {
  const { me } = useCrm();
  const [weeks, setWeeks] = useState(12);
  const [owner, setOwner] = useState('');
  const [t, setT] = useState(null);
  const [c, setC] = useState(null);
  const [measure, setMeasure] = useState('value');
  useEffect(() => {
    setT(null); setC(null);
    api.get('/crm/a/trends', { params: { weeks, owner: owner || undefined } }).then((r) => setT(r.data)).catch((e) => setT({ error: errOf(e, 'The trend could not be read.') }));
    api.get('/crm/a/cohorts', { params: { months: 6, owner: owner || undefined } }).then((r) => setC(r.data)).catch((e) => setC({ error: errOf(e, 'The cohorts could not be read.') }));
  }, [weeks, owner]);
  const rows = useMemo(() => (t && t.series ? t.series.map((s) => ({ group: dateOf(s.day), value: s[measure], records: s.count })) : []), [t, measure]);
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="section-label" style={{ margin: 0 }}>Open pipeline, week by week</div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select value={measure} onChange={(e) => setMeasure(e.target.value)} aria-label="Measure" style={{ width: 'auto' }}><option value="value">Value</option><option value="weighted">Weighted value</option><option value="count">Number of deals</option></select>
            <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks" style={{ width: 'auto' }}><option value={8}>8 weeks</option><option value={12}>12 weeks</option><option value={26}>26 weeks</option><option value={52}>52 weeks</option></select>
            {me.seesAll && <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Salesperson" style={{ width: 'auto' }}><option value="">Everyone</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
          </span>
        </div>
        {!t && <div className="small-muted">Loading…</div>}
        {t && t.error && <div className="notice">{t.error}</div>}
        {t && !t.error && (
          <>
            <MiniChart kind="line" rows={rows} valueLabel={measure === 'count' ? 'Deals' : 'Value'} />
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Week ending</th>{t.stages.map((s) => <th key={s} style={{ textAlign: 'right' }}>{s}</th>)}<th style={{ textAlign: 'right' }}>Total</th><th>From</th></tr></thead>
                <tbody>
                  {t.series.map((s) => (
                    <tr key={s.day}>
                      <td>{dateOf(s.day)}</td>
                      {t.stages.map((st) => { const x = s.stages.find((y) => y.stage === st); return <td key={st} style={{ textAlign: 'right' }}>{x ? (measure === 'count' ? x.count : moneyShort(x[measure])) : '—'}</td>; })}
                      <td style={{ textAlign: 'right' }}><b>{measure === 'count' ? s.count : moneyShort(s[measure])}</b></td>
                      <td className="small-muted" style={{ fontSize: 11.5 }}>{s.source === 'snapshot' ? 'Snapshot' : 'Rebuilt'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>A snapshot of the open pipeline is kept every day{t.firstSnapshot ? ` (the first on ${dateOf(t.firstSnapshot)})` : ''}. Weeks before that are rebuilt from each deal&apos;s stage moves, at today&apos;s deal values.</div>
          </>
        )}
      </div>
      <div className="card">
        <div className="section-label" style={{ marginTop: 0 }}>Cohorts: what became of each month&apos;s leads and deals</div>
        {!c && <div className="small-muted">Loading…</div>}
        {c && c.error && <div className="notice">{c.error}</div>}
        {c && !c.error && (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))' }}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Leads that came in</th><th style={{ textAlign: 'right' }}>Leads</th><th style={{ textAlign: 'right' }}>Contacted</th><th style={{ textAlign: 'right' }}>Converted</th><th style={{ textAlign: 'right' }}>Won</th></tr></thead>
                <tbody>{c.leads.map((x) => <tr key={x.month}><td>{new Date(`${x.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</td><td style={{ textAlign: 'right' }}>{x.leads}</td><td style={{ textAlign: 'right' }}>{x.contacted}{x.contactedPct != null ? <span className="small-muted"> ({x.contactedPct}%)</span> : ''}</td><td style={{ textAlign: 'right' }}>{x.converted}{x.convertedPct != null ? <span className="small-muted"> ({x.convertedPct}%)</span> : ''}</td><td style={{ textAlign: 'right' }}>{x.won ? <>{x.won} <span className="small-muted">{moneyShort(x.wonValue)}</span></> : '—'}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Deals added in</th><th style={{ textAlign: 'right' }}>Deals</th><th style={{ textAlign: 'right' }}>Won in 30 d</th><th style={{ textAlign: 'right' }}>60 d</th><th style={{ textAlign: 'right' }}>90 d</th><th style={{ textAlign: 'right' }}>Lost</th></tr></thead>
                <tbody>{c.deals.map((x) => <tr key={x.month}><td>{new Date(`${x.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</td><td style={{ textAlign: 'right' }}>{x.deals}</td><td style={{ textAlign: 'right' }}>{x.won30}</td><td style={{ textAlign: 'right' }}>{x.won60}</td><td style={{ textAlign: 'right' }}>{x.won90}{x.won90Pct != null ? <span className="small-muted"> ({x.won90Pct}%)</span> : ''}</td><td style={{ textAlign: 'right' }}>{x.lost}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}


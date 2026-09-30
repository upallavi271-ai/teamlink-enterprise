// ---------------------------------------------------------------------------
// InsightsPanel — a module dashboard's date filter, tiles and charts in one
// piece (hrms-24 §1 / §9), fed by GET /api/insights/:module.
//
// Standalone it draws its own filter row — From → To → Apply with the quick
// picks, a department filter and the Export menu — above the tiles and charts,
// so the one filter row scopes everything under it. On a dashboard that
// already has its own filters (HRMS, ATS), pass `range` (and `department`) and
// it draws only the charts, driven by the host's filters.
//
// ONE KPI ROW. A module page never draws a second tile row beside this one:
// `tileKeys` picks which server tiles to show, and `extraTiles` adds the
// page's own figures (a "now" count the insights API does not carry) as more
// cells of the same row. Order on the page: filters → tiles → charts.
//
// Every number comes from the server, computed in the range, the department
// and the viewer's data scope. Nothing here is a sample value.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import sharedGet from '../../utils/sharedGet';
import Combo from '../Combo.jsx';
import DateRangePicker, { useDateRange, rangeParams } from '../DateRangePicker.jsx';
import ExportMenu from '../ExportMenu.jsx';
import { StatRow } from '../proto.jsx';
import ChartFromSpec from './ChartFromSpec.jsx';
import { fullValue } from './format.js';
import './charts.css';

export default function InsightsPanel({
  module,
  storageKey,
  range: hostRange,
  department: hostDepartment,
  params,
  mine = false,
  tiles = true,
  tileKeys,
  extraTiles,
  only,
  exportModule,
  exportFormats,
  title,
  children,
}) {
  const [ownRange, setOwnRange] = useDateRange(storageKey || `tl_range_${module}`);
  const range = hostRange || ownRange;
  const [department, setDepartment] = useState('');
  const dept = hostDepartment !== undefined ? hostDepartment : department;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const query = {
    ...rangeParams(range),
    ...(dept ? { department: dept } : {}),
    ...(mine ? { mine: '1' } : {}),
    ...(params || {}),
  };
  const key = JSON.stringify(query);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    sharedGet(`/insights/${module}`, query)
      .then((r) => { if (alive) { setData(r.data); setError(''); } })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Could not load the charts.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, key]);

  const standalone = !hostRange;
  const exp = exportModule === undefined ? module : exportModule;
  const charts = data ? (data.charts || []).filter((c) => !only || only.includes(c.id)) : [];
  const cells = [
    // `tileKeys` also sets the order.
    ...(data ? (tileKeys ? tileKeys.map((k) => (data.tiles || []).find((t) => t.key === k)).filter(Boolean) : (data.tiles || []))
      .map((t) => ({ label: t.label, value: t.money ? fullValue(t.value, 'money') : t.value })) : []),
    ...(extraTiles || []).filter(Boolean),
  ];

  return (
    <div className="tlc-panel">
      {standalone && (
        <div className="tlc-filters filter-row">
          {title && <b style={{ fontSize: 13.5, marginRight: 4 }}>{title}</b>}
          <DateRangePicker value={ownRange} onChange={setOwnRange} period={data && data.period} />
          {data && !data.self && (data.departments || []).length > 1 && hostDepartment === undefined && (
            <Combo value={department} onChange={(e) => setDepartment(e.target.value)} title="Department">
              <option value="">All departments</option>
              {data.departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          )}
          {children}
          {exp && (
            <span style={{ marginLeft: 'auto' }}>
              <ExportMenu
                url={`/insights/${exp}/export`}
                params={query}
                formats={exportFormats}
                note={data && !data.canExport ? 'Your own data only' : `Scope: ${data ? data.scope : ''}`}
              />
            </span>
          )}
        </div>
      )}
      {error && <div className="notice red tlc-err">{error}</div>}
      {data && standalone && (
        <div className="tlc-scope">
          Showing {data.scope}{data.period ? ` · ${data.period.label}` : ''}{dept ? ` · ${dept}` : ''}
        </div>
      )}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {(data || error) && tiles && cells.length > 0 && (
        <div className={busy ? 'tlc-busy' : undefined}>
          <StatRow cells={cells} />
        </div>
      )}
      {data && charts.length > 0 && (
        <div className="tlc-grid2" style={tiles ? { marginTop: 14 } : undefined}>
          {charts.map((c) => <ChartFromSpec key={c.id} spec={c} busy={busy} />)}
        </div>
      )}
    </div>
  );
}

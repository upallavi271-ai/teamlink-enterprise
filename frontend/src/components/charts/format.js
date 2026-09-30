// Number formats and series slots shared by the dashboard charts.

const IN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

// A full figure, for tooltips and the table view.
export function fullValue(v, unit) {
  const n = Number(v) || 0;
  if (unit === 'money') return `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (unit === 'hours') return `${IN.format(n)} h`;
  return IN.format(n);
}

// A short figure, for bar tips and axis ticks: 1.2k, 3.4L, 1.1Cr.
export function shortValue(v, unit) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  let s;
  if (a >= 1e7) s = `${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  else if (a >= 1e5) s = `${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  else if (a >= 1e3) s = `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  else s = IN.format(n);
  if (unit === 'money') return `₹${s}`;
  if (unit === 'hours') return `${s}h`;
  return s;
}

// Series slot by POSITION in the series list the server fixed — so a colour
// follows its series whatever the data does. Past four, or a series called
// Other, is the grey Other bucket.
export function slotOf(index, name) {
  if (/^other$/i.test(String(name || '')) || index >= 4) return 'o';
  return String(index + 1);
}

// Clean axis ticks: 0 and three or four round steps up to at least `max`.
export function niceTicks(max, count = 4) {
  const top = Math.max(Number(max) || 0, 1);
  const raw = top / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  if (ticks[ticks.length - 1] < top) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 100) / 100);
  return ticks;
}

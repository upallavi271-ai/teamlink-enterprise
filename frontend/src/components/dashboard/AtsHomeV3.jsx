import { Link } from 'react-router-dom';
import { FunnelChart, BarChart, DonutChart, MiniBar, ProgressBar } from '../charts';
import StatCard, { StatRow } from '../ui/StatCard.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import './atsHomeV3.css';

// ---------------------------------------------------------------------------
// ATS LAYOUT v3 — the dashboard widgets (scratchpad ats-layout-spec-v3.md §1).
// Super Admin / Admin / Manager / Asst Manager get the whole v3 page; the
// role views (Recruiter / TL / BDE …) use StatCards only. Every number, card
// and chart point opens its rows in place (HomeDrill) via onDrill(setId).
// The numbers come from backend/src/utils/atsHome.js, counted by the same
// code that returns the list, so a number always equals its rows.
// Colours: green good · yellow pending · red late / rejected · blue in
// process · grey closed (the shared kit's tones).
// ---------------------------------------------------------------------------
const IN = new Intl.NumberFormat('en-IN');
const fmt = (n) => IN.format(Number(n) || 0);
const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const timeOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};
function ago(v) {
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function Box({ title, right, note, children, className = '' }) {
  return (
    <section className={`panel ahv3-box ${className}`}>
      {(title || right) && <div className="ahv3-head"><h3>{title}</h3>{right}</div>}
      {note && <div className="ahv3-note">{note}</div>}
      {children}
    </section>
  );
}
const SeeAll = ({ total, shown, drill, onDrill }) => (total > shown && drill
  ? <button type="button" className="link-btn" onClick={() => onDrill(drill)}>See all {fmt(total)} →</button>
  : null);

// A delta from the server ({ dir, text, pct }) → StatCard's props. When the
// period before had none (no % possible) the plain "▲ 3 vs last month" is the hint.
export function deltaProps(d, prevWord) {
  if (!d) return {};
  if (d.pct === null || d.pct === undefined) return { extraHint: d.text };
  return { delta: d.pct, deltaLabel: prevWord ? `vs ${prevWord}` : undefined };
}

// THE NUMBER CARDS (every role): up to 6, each opens its list.
export function Cards({ w, onDrill, prevWord }) {
  return (
    <StatRow className="ahv3-cards">
      {w.tiles.map((t) => {
        // "0 → 0" says nothing: no arrow on an empty card that did not change.
        const dp = !t.value && (!t.delta || t.delta.dir === 'same') ? {} : deltaProps(t.delta, prevWord);
        const hint = [t.value > 0 ? t.sub : null, dp.extraHint].filter(Boolean).join(' · ') || undefined;
        return (
          <StatCard
            key={t.id}
            label={t.label}
            value={t.value}
            tone={t.value ? t.tone || 'blue' : 'grey'}
            zeroText={t.zero}
            delta={dp.delta}
            deltaLabel={dp.deltaLabel}
            upIsGood={t.goodWhen !== 'down'}
            hint={hint}
            help={t.help}
            onClick={t.drill && t.value ? () => onDrill(t.drill) : undefined}
          />
        );
      })}
    </StatRow>
  );
}

// NEEDS ATTENTION: Late, Feedback late, Unsigned agreement, Client feedback
// pending — red / yellow cards (green once there is nothing).
function Alerts({ w, onDrill }) {
  return (
    <Box title={w.title} className="ahv3-alerts">
      <div className="ahv3-alert-row">
        {w.cards.map((c) => (
          <StatCard
            key={c.id}
            label={c.label}
            value={c.value}
            tone={c.value ? c.tone : 'green'}
            zeroText={c.zero}
            hint={c.hint}
            onClick={c.value ? () => onDrill(c.drill) : undefined}
            title={c.value ? `${c.button || 'Open'} — opens the list` : undefined}
          />
        ))}
      </div>
    </Box>
  );
}

function Funnel({ w, onDrill }) {
  const steps = w.rows.map((r) => ({ label: r.label, value: r.value, onClick: r.value ? () => onDrill(r.drill) : undefined }));
  return (
    <Box title={w.title} note={w.note}>
      <FunnelChart steps={steps} empty={w.zero} title={w.title} />
      <details className="ahv3-defs">
        <summary>What each step means</summary>
        <ul>{w.rows.map((r) => <li key={r.label}><b>{r.label}</b> — {r.def}</li>)}</ul>
      </details>
    </Box>
  );
}

function Joinings({ w, onDrill }) {
  const data = w.points.map((p) => ({ label: p.label, value: p.value, tone: 'green', onClick: p.value ? () => onDrill(p.drill) : undefined }));
  return (
    <Box title={w.title}>
      <BarChart data={data} height={200} empty="No joinings in the last 6 months" title={w.title} />
    </Box>
  );
}

function Rejections({ w, onDrill }) {
  const data = w.slices.map((s) => ({ label: s.label, value: s.value, tone: s.tone || undefined, onClick: () => onDrill(s.drill) }));
  return (
    <Box title={w.title} note={w.total ? `People rejected ${w.period}` : null}>
      <DonutChart data={data} centerLabel="Rejected" centerValue={fmt(w.total)} empty={w.zero} title={w.title} size={150} />
    </Box>
  );
}

// DEPARTMENT OVERVIEW: the name narrows the whole page to that department;
// every number opens its list; a mini bar shows its size against the others.
function Departments({ w, onDrill, onPickDept }) {
  return (
    <Box title={w.title} note={`Open and Selected are as of now; the rest are ${w.word}. Click a department to see only it.`}>
      {!w.rows.length ? <div className="ahv3-empty">No department in your area yet.</div> : (
        <div className="tbl-wrap ahv3-scroll">
          <table className="ahv3-tbl">
            <thead>
              <tr>
                <th>Department</th>
                {w.columns.map((c) => <th key={c.key} className="num" title={c.hint}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {w.rows.map((r) => (
                <tr key={r.department || 'none'} className={r.picked ? 'is-picked' : ''}>
                  <td>
                    {r.fixNeeded
                      ? <StatusChip tone="grey">No department</StatusChip>
                      : <button type="button" className="ahv3-dept" onClick={() => onPickDept(r.department)} title={`Show only ${r.department}`}>{r.department}</button>}
                  </td>
                  {w.columns.map((c) => (
                    <td key={c.key} className="num ahv3-mcell">
                      {r[c.key]
                        ? (
                          <>
                            <button type="button" className={`ahv3-n t-${c.tone}`} onClick={() => onDrill(r.drills[c.key])} title={`${c.hint} — open the list`}>{fmt(r[c.key])}</button>
                            <MiniBar value={r[c.key]} max={w.max[c.key] || 1} tone={c.tone} title={`${fmt(r[c.key])} of ${fmt(w.max[c.key])} (largest)`} />
                          </>
                        )
                        : <span className="cell-muted">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

function Interviews({ w, onDrill }) {
  return (
    <Box title={w.title} right={<SeeAll total={w.total} shown={w.rows.length} drill={w.drill} onDrill={onDrill} />}>
      {!w.rows.length ? <div className="ahv3-empty">{w.zero}</div> : (
        <ul className="ahv3-list">
          {w.rows.map((r) => (
            <li key={r.id}>
              <span className="ahv3-time">{timeOf(r.at)}</span>
              <span className="ahv3-main">
                <b>{r.candidate}</b>
                <span className="small-muted">{[r.client, r.job].filter(Boolean).join(' · ')}</span>
              </span>
              <StatusChip tone={r.done ? 'green' : 'blue'}>{`Round ${r.round}${r.mode ? ` · ${r.mode}` : ''}`}</StatusChip>
              <Link className="btn btn-sm" to={`/candidates/${r.candidateId}`}>Open</Link>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

// TEAM SNAPSHOT: recruiters and client managers (BDE) — Waiting, Due today,
// Late and an "on time" bar (green 80%+, yellow 50%+, red below).
function Team({ w, onDrill }) {
  const cell = (r, k, red) => (r[k]
    ? <button type="button" className={`ahv3-n${red ? ' t-red' : ''}`} onClick={() => onDrill(r.drills[k])}>{fmt(r[k])}</button>
    : <span className="cell-muted">–</span>);
  const tone = (p) => (p >= 80 ? 'green' : p >= 50 ? 'yellow' : 'red');
  return (
    <Box title={w.title} right={w.to ? <Link className="link-btn" to={w.to}>{w.toLabel}</Link> : null}>
      {!w.groups.length ? <div className="ahv3-empty">{w.zero}</div> : w.groups.map((g) => (
        <div key={g.id} className="ahv3-group">
          <div className="ahv3-gtitle">{g.title}{g.total > g.rows.length ? <span className="small-muted"> · top {g.rows.length} of {fmt(g.total)}</span> : null}</div>
          <div className="tbl-wrap ahv3-scroll">
            <table className="ahv3-tbl">
              <thead><tr><th>Name</th><th className="num">Waiting</th><th className="num">Due today</th><th className="num">Late</th><th className="ahv3-pcol">On time</th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="ahv3-ellip">{r.name}</td>
                    <td className="num">{cell(r, 'pending')}</td>
                    <td className="num">{cell(r, 'dueToday')}</td>
                    <td className="num">{cell(r, 'overdue', true)}</td>
                    <td className="ahv3-pcol"><ProgressBar value={r.onTime} max={100} tone={tone(r.onTime)} valueFormat={(n) => `${n}%`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </Box>
  );
}

// MONEY (Admin / Accounts only — the server sends it only to a login with
// the right to see invoices): Invoiced, Received, Pending.
function Money({ w, onDrill, prevWord }) {
  return (
    <Box title={w.title}>
      <StatRow className="ahv3-money">
        {w.rows.map((r) => {
          const dp = deltaProps(r.delta, prevWord);
          const hint = [r.value > 0 ? r.sub : null, dp.extraHint].filter(Boolean).join(' · ') || undefined;
          return (
            <StatCard
              key={r.id}
              label={r.label}
              value={r.value}
              format={rupees}
              tone={r.id === 'received' ? 'green' : r.id === 'pending' ? (r.tone === 'red' ? 'red' : 'yellow') : 'blue'}
              zeroText={r.zero}
              delta={dp.delta}
              deltaLabel={dp.deltaLabel}
              hint={hint}
              onClick={r.value ? () => onDrill(r.drill) : undefined}
            />
          );
        })}
      </StatRow>
    </Box>
  );
}

function Activity({ w, onDrill }) {
  return (
    <Box title={w.title} right={<SeeAll total={w.total} shown={w.rows.length} drill={w.drill} onDrill={onDrill} />}>
      {!w.rows.length ? <div className="ahv3-empty">{w.zero}</div> : (
        <ol className="ahv3-feed">
          {w.rows.map((r) => (
            <li key={r.id} className={`t-${r.tone || 'blue'}`}>
              <span className="ahv3-dot" aria-hidden="true" />
              <Link to={`/candidates/${r.candidateId}`} className="ahv3-feed-t">{r.text}</Link>
              <span className="small-muted ahv3-ago" title={new Date(r.at).toLocaleString('en-GB')}>{ago(r.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </Box>
  );
}

// widget type → how it is drawn (AtsHome.jsx merges this into its registry).
export const V3_WIDGETS = {
  alerts: Alerts, funnel3: Funnel, bars: Joinings, donut: Rejections, depts3: Departments,
  interviews: Interviews, team: Team, money3: Money, activity: Activity,
};

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../../api';
import {
  KpiRow, KpiTile, Panel, AttentionList, QuickActions, Avatar, Icon, Pill, fmtNum,
} from '../../atskit/AtsKit.jsx';
import { LineChart, DonutChart } from '../../charts';
import { can, canRaiseRequirement } from '../../../permissions';
import './atsV4.css';

// ---------------------------------------------------------------------------
// ATS DASHBOARD v4 (redesign 2026-10-08, reference ref-ats-dashboard.png).
// PRESENTATION ONLY over the data AtsHome already loads:
//   GET /api/dashboard/ats/home          (the role's widgets, tiles, greeting)
//   GET /api/dashboard/ats/home/list     (?set=__tls team leads, ?set=__jobs open jobs)
// Layout, top → bottom:
//   KPI row (6 tiles) ·
//   Needs attention | Top requirements needing attention | Quick actions ·
//   Department performance | Team snapshot ·
//   Joinings — last 6 months | Money | Hiring progress | Recent activity ·
//   everything else the role's dashboard has (Open jobs, Team leads, …),
//   each in its own collapsed section.
// Every widget is optional: a role that has no data for a slot gets the
// slot filled by its own next widget, or the slot is left out. Nothing here
// invents a number — a missing value is "—" or the widget's own empty text.
// ---------------------------------------------------------------------------
const LIST_URL = '/dashboard/ats/home/list';
const IN = new Intl.NumberFormat('en-IN');
const fmt = (n) => IN.format(Number(n) || 0);
const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
const errText = (e) => (e && e.response && e.response.data && e.response.data.error) || 'This part could not be loaded. Press Refresh to try again.';
const arr = (v) => (Array.isArray(v) ? v : []);

// Tile id → icon + tone (the reference's round tinted badges).
const LOOK = {
  'open-jobs': ['briefcase', 'blue'],
  people: ['users', 'green'],
  interviews: ['calendar', 'amber'],
  'client-feedback': ['chat', 'violet'],
  selected: ['user', 'teal'],
  joined: ['check', 'green'],
  overdue: ['alert', 'red'],
  'my-review': ['clock', 'amber'],
  clients: ['building', 'blue'],
  submitted: ['send', 'violet'],
  'agreement-pending': ['file', 'amber'],
  positions: ['briefcase', 'blue'],
  'to-review': ['clock', 'amber'],
  'iv-internal': ['calendar', 'amber'],
  offers: ['handshake', 'violet'],
  joining: ['check', 'green'],
  'my-action': ['list', 'blue'],
  'tasks-today': ['clock', 'amber'],
  'iv-today': ['calendar', 'violet'],
  feedback: ['chat', 'violet'],
  'my-jobs': ['briefcase', 'blue'],
  'my-joins': ['check', 'green'],
};
const LEAD_LAYOUTS = ['superadmin', 'admin', 'manager', 'asstmanager', 'stl'];

// ---- the 6 KPI tiles ------------------------------------------------------------------
// The role's own tiles from the server; when it sends fewer than six, the sixth
// is another number the same response already carries (never a made-up one).
export function buildTiles(data, ws) {
  const kpi = ws.find((w) => w.type === 'kpis');
  const L = data.layout;
  const g = data.greeting;
  // The greeting is built from a fixed list and only drops zeros, so a
  // missing item means 0. Without an items list the value is unknown.
  const gItem = (id) => (g && Array.isArray(g.items) ? ((g.items.find((i) => i.id === id) || {}).value || 0) : null);
  let tiles = kpi ? arr(kpi.tiles).slice() : [];
  const has = (id) => tiles.some((t) => t.id === id);
  if (kpi && tiles.length < 6) {
    if (LEAD_LAYOUTS.includes(L) && !has('client-feedback')) {
      const v = gItem('client-feedback');
      if (v !== null) {
        const at = Math.max(0, tiles.findIndex((t) => t.id === 'interviews') + 1) || tiles.length;
        tiles.splice(at, 0, {
          id: 'client-feedback', label: 'Client feedback pending', value: v, drill: 'client-feedback',
          zero: 'No feedback pending', help: 'People sent to the client with no reply yet.',
        });
      }
    } else if (L === 'tl' && !has('overdue')) {
      const v = gItem('late');
      if (v !== null) tiles.push({ id: 'overdue', label: 'Late', value: v, drill: 'overdue', zero: 'Nothing is late', help: 'Work that is past its due date.', goodWhen: 'down', tone: 'red' });
    } else if (L === 'bde' && !has('agreement-pending')) {
      const u = ws.find((w) => w.id === 'unsigned' && w.type === 'clients');
      if (u) tiles.push({ id: 'agreement-pending', label: 'Unsigned agreements', value: u.total, drill: u.drill, zero: 'All agreements are signed', help: 'Clients with open jobs and no signed agreement.' });
    }
  }
  if (!kpi && L === 'recruiter') {
    // The recruiter's page has no number row; its widgets carry the counts.
    const by = (id) => ws.find((w) => w.id === id);
    const t = by('tasks'); const iv = by('iv-today'); const fb = by('feedback'); const jobs = by('jobs'); const tg = by('target');
    tiles = [
      t && { id: 'my-action', label: 'My tasks', value: Number(t.more) || 0, drill: t.drill, zero: 'No open tasks', help: 'Everything waiting for you to act.' },
      t && { id: 'tasks-today', label: 'Due today', value: t.total, zero: 'Nothing due today', help: 'Steps and calls due today (late ones included).' },
      iv && { id: 'iv-today', label: 'Interviews today', value: iv.total, drill: iv.drill, zero: iv.zero },
      fb && { id: 'feedback', label: 'Feedback pending', value: fb.total, drill: fb.drill, zero: fb.zero },
      jobs && { id: 'my-jobs', label: 'My open jobs', value: jobs.total, drill: jobs.drill, zero: jobs.zero },
      tg && { id: 'my-joins', label: 'Joinings this month', value: tg.value, drill: tg.drill, zero: tg.zero, sub: tg.target ? `of ${fmt(tg.target)} target` : null },
    ].filter(Boolean);
  }
  return tiles;
}

function Tile({ t, onDrill, prevWord }) {
  const [icon, tone] = LOOK[t.id] || ['chart', 'blue'];
  const d = t.delta || null;
  const quiet = !t.value && (!d || d.dir === 'same');
  const pct = !quiet && d && typeof d.pct === 'number' && Number.isFinite(d.pct) ? d.pct : undefined;
  const sub = t.value ? (t.sub || (!quiet && d ? d.text : null)) : t.zero;
  const title = [t.help, t.value ? t.sub : null, d && !quiet ? d.text : null].filter(Boolean).join(' · ') || undefined;
  return (
    <KpiTile
      icon={icon}
      tone={t.tone === 'red' && t.value ? 'red' : tone}
      label={t.label}
      value={t.value}
      sub={sub || undefined}
      delta={pct}
      deltaLabel={pct !== undefined && prevWord ? `vs ${prevWord}` : undefined}
      upIsGood={t.goodWhen !== 'down'}
      title={title}
      onClick={t.drill && t.value ? () => onDrill(t.drill) : undefined}
    />
  );
}

// ---- Needs attention -------------------------------------------------------------------
function attentionOf(data, ws, onDrill) {
  const L = data.layout;
  const it = (key, count, label, sub, tone, button, drill, to) => ({
    key, count, label, sub, tone,
    action: to ? { label: button, to } : drill ? { label: button, onClick: () => onDrill(drill) } : undefined,
  });
  const lines = ws.find((w) => w.type === 'lines');
  let items = [];
  if (lines) {
    items = arr(lines.lines).map((l) => it(l.id, l.count, l.label, l.sub, l.tone === 'red' ? 'red' : 'amber', l.button || 'Open', l.drill, l.to));
  } else if (L === 'tl' && data.greeting && Array.isArray(data.greeting.items)) {
    items = data.greeting.items.map((i) => it(i.id, i.value, cap(i.label), null, i.tone === 'red' ? 'red' : 'amber', i.id === 'my-review' ? 'Check' : 'Open', i.drill));
  } else if (L === 'recruiter') {
    const by = (id) => ws.find((w) => w.id === id);
    const t = by('tasks'); const fb = by('feedback'); const iv = by('iv-today');
    if (t && t.total) items.push(it('tasks', t.total, 'Tasks due today', 'Late steps and calls due today', 'red', 'Do it', t.drill));
    if (fb && fb.total) items.push(it('feedback', fb.total, fb.title, 'Waiting for the client\'s reply', 'amber', 'Chase', fb.drill));
    if (iv && iv.total) items.push(it('iv-today', iv.total, iv.title, null, 'blue', 'Open', iv.drill));
  } else if (L === 'bde') {
    const fb = ws.find((w) => w.id === 'client-fb'); const un = ws.find((w) => w.id === 'unsigned');
    if (fb && fb.total) items.push(it('client-fb', fb.total, fb.title, 'Sent to the client, no reply yet', 'amber', 'Chase', fb.drill));
    if (un && un.total) items.push(it('unsigned', un.total, 'Clients with unsigned agreement', 'Open jobs, agreement not signed', 'red', 'Review', un.drill));
  }
  // The follow-ups line ("N candidates not followed up yet") is a problem to act on.
  const notes = [];
  arr(data.extras).filter((x) => x && !x.button).forEach((x) => {
    if (x.value > 0 && x.drill) items.push(it(x.id, x.value, cap(x.label), null, x.tone === 'red' ? 'red' : 'blue', 'Open', x.drill));
    else if (!x.value && x.label) notes.push(x.label);
  });
  return { items, more: lines ? Number(lines.more) || 0 : 0, empty: (lines && lines.empty) || 'Nothing needs attention. All caught up.', notes };
}

// ---- Top requirements needing attention (the open jobs, most late first) ----------------
function LateJobs({ params, reload, total, drill, onDrill, mayOpen }) {
  const navigate = useNavigate();
  const [st, setSt] = useState({ loading: true });
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    setSt((s) => ({ ...s, loading: true }));
    api.get(LIST_URL, { params: { ...params, set: '__jobs', d_sort: 'late', d_size: 25 } })
      .then((r) => { if (live) setSt({ data: r.data }); })
      .catch((e) => { if (live) setSt({ error: errText(e) }); });
    return () => { live = false; };
  }, [key, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = st.data ? arr(st.data.rows).filter((r) => r.late > 0 || !arr(r.recruiters).length).slice(0, 5) : [];
  return (
    <Panel
      title="Top requirements needing attention"
      icon="calendar"
      iconTone="blue"
      className="av4-reqs"
      flush
      action={total && drill ? { label: `View all ${fmt(total)}`, onClick: () => onDrill(drill) } : null}
    >
      {st.error && <div className="notice red av4-pad">{st.error}</div>}
      {!st.data && !st.error && <div className="ak-empty">Loading the open jobs…</div>}
      {st.data && !rows.length && <div className="ak-empty">No open job has late work or is missing a recruiter.</div>}
      {rows.length > 0 && (
        <table className="ak-table av4-tbl">
          <colgroup><col className="av4-c1" /><col className="av4-c2" /><col className="av4-c3" /><col className="av4-c4" /></colgroup>
          <thead><tr><th>Req. ID</th><th>Role / Position</th><th>Department</th><th className="num">Late</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={mayOpen ? 'ak-row-click' : ''}
                onClick={mayOpen ? () => navigate(`/requirements/${r.id}`) : undefined}
                title={[r.title, r.client, r.tl ? `Team lead: ${r.tl}` : null, arr(r.recruiters).length ? `Recruiter: ${r.recruiters.join(', ')}` : 'No recruiter yet'].filter(Boolean).join(' · ')}
              >
                <td className="av4-code">{r.reqCode || '—'}</td>
                <td className="av4-ellip"><span className="av4-strong">{r.title}</span>{r.client && <span className="av4-sub">{r.client}</span>}</td>
                <td className="av4-ellip">{r.department || '—'}</td>
                <td className="num">{r.late ? <span className="ak-bad">{fmt(r.late)}</span> : <Pill tone="amber">No recruiter</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// The recruiter's "My jobs by priority" / the BDE's "Open jobs per client" in the same slot.
function JobsTable({ w, onDrill }) {
  const tone = { Urgent: 'red', High: 'amber', Medium: 'blue', Low: 'slate' };
  const isClients = w.type === 'clients';
  const rows = arr(w.rows);
  const withNote = isClients && rows.some((r) => r.sub);
  return (
    <Panel
      title={w.title}
      icon={isClients ? 'building' : 'briefcase'}
      className="av4-reqs av4-mid"
      flush
      action={w.drill && w.total > rows.length ? { label: `View all ${fmt(w.total)}`, onClick: () => onDrill(w.drill) } : null}
    >
      {!rows.length ? <div className="ak-empty">{w.zero || 'No data available'}</div> : (
        <table className="ak-table av4-tbl">
          <thead>
            {isClients
              ? <tr><th>Client</th>{withNote && <th>Note</th>}<th className="num">Open jobs</th></tr>
              : <tr><th>Job</th><th>Priority</th><th className="num">In process</th></tr>}
          </thead>
          <tbody>
            {rows.map((r) => (isClients ? (
              <tr key={r.id}>
                <td className="av4-ellip">{r.to ? <Link className="av4-strong av4-link" to={r.to}>{r.name}</Link> : <span className="av4-strong">{r.name}</span>}</td>
                {withNote && <td className="av4-ellip av4-muted">{r.sub || '—'}</td>}
                <td className="num">{r.count ? <button type="button" className="av4-n" onClick={() => onDrill(r.drill)}>{fmt(r.count)}</button> : '—'}</td>
              </tr>
            ) : (
              <tr key={r.id}>
                <td className="av4-ellip"><span className="av4-strong">{r.title}</span>{r.client && <span className="av4-sub">{r.client}</span>}</td>
                <td><Pill tone={tone[r.priority] || 'blue'}>{r.priority || '—'}</Pill></td>
                <td className="num">{r.inProcess ? <button type="button" className="av4-n" onClick={() => onDrill(r.drill)}>{fmt(r.inProcess)}</button> : <span className="av4-muted">Nobody yet</span>}</td>
              </tr>
            )))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---- Department performance -----------------------------------------------------------
const DEPT_COLS = [['openJobs', 'Open jobs', 'Jobs open now'], ['active', 'In process', 'People on a job now'], ['interviews', 'Interviews', 'Interviews in the dates you picked'], ['selected', 'Selected', 'Selected or offered, not joined yet'], ['joined', 'Joined', 'Joined in the dates you picked'], ['late', 'Late', 'Work past its due date']];
const DOTS = ['blue', 'green', 'amber', 'violet', 'teal', 'pink', 'red', 'slate'];
function DeptPerf({ w, onDrill, onPickDept, tls }) {
  const tlCount = (d) => {
    const g = tls && tls.data && arr(tls.data.groups).find((x) => x.department === (d || 'No department'));
    return g ? arr(g.rows).length : 0;
  };
  return (
    <Panel title="Department performance" sub="Click a department to see only it" icon="chart" className="av4-dept" flush>
      {!arr(w.rows).length ? <div className="ak-empty">No department in your area yet.</div> : (
        <div className="av4-scroll">
          <table className="ak-table av4-tbl">
            <thead><tr><th>Department</th>{DEPT_COLS.map(([k, l, h]) => <th key={k} className="num" title={h}>{l}</th>)}<th className="num" title="Team leads in this department">Team leads</th></tr></thead>
            <tbody>
              {w.rows.map((r, i) => (
                <tr key={r.department || 'none'} className={`ak-row-click${r.picked ? ' av4-picked' : ''}`} onClick={() => r.active && onDrill(r.drills.active)}>
                  <td>
                    {r.fixNeeded
                      ? <Pill tone="red">No department</Pill>
                      : (
                        <button type="button" className="av4-dept-pick" title={`Show only ${r.department}`} onClick={(e) => { e.stopPropagation(); onPickDept(r.department); }}>
                          <span className={`av4-dot ak-f-${DOTS[i % DOTS.length]}`} aria-hidden="true" />{r.department}
                        </button>
                      )}
                  </td>
                  {DEPT_COLS.map(([k]) => (
                    <td key={k} className="num">
                      {r[k]
                        ? <button type="button" className={`av4-n${k === 'late' ? ' is-red' : ''}`} onClick={(e) => { e.stopPropagation(); onDrill(r.drills[k]); }}>{fmt(r[k])}</button>
                        : <span className="av4-dash">–</span>}
                    </td>
                  ))}
                  <td className="num">
                    {tlCount(r.department)
                      ? <button type="button" className="av4-n" title={`Show ${r.department || 'this department'} and its team leads`} onClick={(e) => { e.stopPropagation(); if (r.department) onPickDept(r.department); }}>{fmt(tlCount(r.department))}</button>
                      : <span className="av4-dash">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---- Team snapshot: team leads (or a TL's recruiters) · recruiters' waiting work --------
const TL_COLS = [['openJobs', 'Open jobs'], ['inProcess', 'In process'], ['interviews', 'Interviews'], ['selected', 'Selected'], ['joined', 'Joined'], ['late', 'Late']];
function TeamSnapshot({ tlsW, tls, peopleW, onDrill, onShowAll }) {
  const tabs = [tlsW && 'tls', peopleW && 'people'].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]);
  const cur = tabs.includes(tab) ? tab : tabs[0];
  const tlRows = tls && tls.data ? arr(tls.data.rows) : [];
  const single = tlRows.length === 1 && arr(tlRows[0].recruiters).length > 0;
  const tlLabel = single ? 'Recruiters' : 'Team leads';
  const shown = single
    ? tlRows[0].recruiters.slice().sort((x, y) => y.late - x.late || y.inProcess - x.inProcess).slice(0, 5)
    : tlRows.slice().sort((x, y) => y.late - x.late || y.inProcess - x.inProcess || y.openJobs - x.openJobs).slice(0, 5);
  const N = (r, k) => (r[k]
    ? <button type="button" className={`av4-n${k === 'late' ? ' is-red' : k === 'joined' ? ' is-green' : ''}`} onClick={() => onDrill(r.drills[k])}>{fmt(r[k])}</button>
    : <span className="av4-dash">–</span>);
  let action = null;
  if (cur === 'tls' && tlRows.length > 0) action = { label: single ? 'View team' : `View all ${fmt(tlRows.length)}`, onClick: onShowAll };
  if (cur === 'people' && peopleW && peopleW.to && peopleW.total > arr(peopleW.rows).length) action = { label: `View all ${fmt(peopleW.total)}`, to: peopleW.to };
  const extra = tabs.length > 1 ? (
    <span className="av4-tabs" role="tablist" aria-label="Team snapshot view">
      {tabs.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={cur === t} className={cur === t ? 'on' : ''} onClick={() => setTab(t)}>
          {t === 'tls' ? tlLabel : 'Waiting work'}
        </button>
      ))}
    </span>
  ) : null;
  return (
    <Panel title="Team snapshot" icon="team" iconTone="blue" className="av4-team" flush extra={extra} action={action}>
      {cur === 'tls' && (
        !tls || tls.loading ? <div className="ak-empty">Loading the team…</div>
          : tls.error ? <div className="notice red av4-pad">{tls.error}</div>
            : !shown.length ? <div className="ak-empty">No team lead here yet. Team leads show once jobs or recruiters are given to them.</div> : (
              <div className="av4-scroll">
                <table className="ak-table av4-tbl">
                  <thead><tr><th>{single ? 'Recruiter' : 'Team lead'}</th>{TL_COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id}>
                        <td><span className="ak-person"><Avatar name={r.name} size={24} /><span title={r.department ? `${r.name} · ${r.department}` : r.name}>{r.name}</span></span></td>
                        {TL_COLS.map(([k]) => <td key={k} className="num">{N(r, k)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
      )}
      {cur === 'people' && peopleW && (
        !arr(peopleW.rows).length ? <div className="ak-empty">Nobody has work waiting. All caught up.</div> : (
          <div className="av4-scroll">
            <table className="ak-table av4-tbl">
              <thead><tr><th>{peopleW.who || 'Person'}</th><th className="num">Waiting</th><th className="num">Due today</th><th className="num">Late</th></tr></thead>
              <tbody>
                {peopleW.rows.map((r) => (
                  <tr key={r.key}>
                    <td><span className="ak-person"><Avatar name={r.name} size={24} /><span>{r.name}</span></span></td>
                    <td className="num">{N(r, 'pending')}</td>
                    <td className="num">{N(r, 'dueToday')}</td>
                    <td className="num">{r.overdue ? <button type="button" className="av4-n is-red" onClick={() => onDrill(r.drills.overdue)}>{fmt(r.overdue)}</button> : <span className="av4-dash">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Panel>
  );
}

// ---- Row 4: Joinings · Money · Hiring progress · Recent activity ----------------------
function Joinings({ w, onDrill }) {
  const points = arr(w.points).map((p) => ({ label: p.label, value: p.value, onClick: p.value ? () => onDrill(p.drill) : undefined }));
  return (
    <Panel title={w.title} icon="chart" className="av4-chart">
      <LineChart points={points} height={178} empty="No joinings in the last 6 months" title={w.title} />
    </Panel>
  );
}

const MONEY_LOOK = { invoiced: ['file', 'green'], received: ['rupee', 'blue'], pending: ['clock', 'amber'] };
function Money({ w, onDrill }) {
  return (
    <Panel title={w.title} icon="rupee" iconTone="green" className="av4-money">
      <ul className="av4-money-list">
        {arr(w.rows).map((r) => {
          const [icon, tone] = MONEY_LOOK[r.id] || ['rupee', 'blue'];
          const d = r.delta && r.delta.dir !== 'same' ? r.delta : null;
          return (
            <li key={r.id} className={r.tone === 'red' ? 'is-red' : ''}>
              <span className={`av4-mic ak-t-${r.tone === 'red' ? 'red' : tone}`}><Icon name={icon} size={16} /></span>
              <span className="av4-mtxt">
                <span className="av4-mlabel">{r.label}</span>
                {r.value
                  ? <button type="button" className="av4-mval" onClick={() => onDrill(r.drill)} title="Open the list">{rupees(r.value)}</button>
                  : <span className="av4-mval is-none">{r.zero || '—'}</span>}
                {r.value > 0 && r.sub && <span className="av4-msub">{r.sub}</span>}
                {d && <span className={`av4-mdelta ${d.dir === 'up' ? (r.id === 'pending' ? 'down' : 'up') : (r.id === 'pending' ? 'up' : 'down')}`}>{d.text}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Hiring({ w, onDrill }) {
  const rows = arr(w.rows);
  const at = (label, i) => rows.find((r) => r.label === label) || rows[i] || null;
  const added = at('Added', 0); const sent = at('Sent to client', 1); const iv = at('Interview', 2);
  const sel = at('Selected', 3); const joined = at('Joined', 4);
  const selN = sel ? Number(sel.value) || 0 : 0;
  const joinN = joined ? Number(joined.value) || 0 : 0;
  const data = sel ? [
    { label: 'Joined', value: joinN, tone: 'green', onClick: joinN ? () => onDrill(joined.drill) : undefined },
    { label: 'Not joined yet', value: Math.max(0, selN - joinN), tone: 'blue' },
  ] : [];
  const step = (r) => r && (
    <li key={r.label} title={r.def}>
      <span>{r.label}</span>
      {r.value ? <button type="button" className="av4-n" onClick={() => onDrill(r.drill)}>{fmt(r.value)}</button> : <span className="av4-dash">0</span>}
    </li>
  );
  return (
    <Panel title={w.title} sub={`People added ${w.period || ''}`.trim()} icon="trend" className="av4-hiring">
      <DonutChart data={data} centerValue={fmt(selN)} centerLabel="Selected" size={120} empty={`Nobody selected ${w.period || ''}`.trim()} title={w.title} />
      <ul className="av4-steps">{[added, sent, iv].map(step)}</ul>
    </Panel>
  );
}

const TODAY_LOOK = { added: ['user', 'blue'], sent: ['send', 'violet'], interviews: ['calendar', 'amber'], offers: ['star', 'teal'], joined: ['check', 'green'] };
function Activity({ today, banner, onDrill }) {
  return (
    <Panel title="Recent activity" sub={today ? today.title : null} icon="clock" className="av4-activity">
      <ul className="av4-feed">
        {today && arr(today.items).map((i) => {
          const [icon, tone] = TODAY_LOOK[i.id] || ['list', 'blue'];
          return (
            <li key={i.id} title={i.hint}>
              <span className={`av4-fic ak-t-${tone}`}><Icon name={icon} size={14} /></span>
              <span className="av4-ftxt">{i.label}</span>
              {i.value ? <button type="button" className="av4-n" onClick={() => onDrill(i.drill)}>{fmt(i.value)}</button> : <span className="av4-dash">–</span>}
            </li>
          );
        })}
      </ul>
      {banner && (
        <div className="av4-banner">
          <Pill tone="amber">Activity not logged</Pill>
          <span>{banner.text}</span>
          {banner.to && <Link className="ak-panel-link" to={banner.to}>{banner.toLabel}</Link>}
        </div>
      )}
    </Panel>
  );
}

// ---- Collapsed sections below the reference layout ------------------------------------
const FOLD_KEY = 'atsd_v4_open';
function readOpen() {
  try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function Fold({ id, title, count, open, onToggle, children }) {
  return (
    <section className={`av4-fold${open ? ' is-open' : ''}`} id={`av4-fold-${id}`}>
      <button type="button" className="av4-fold-h" aria-expanded={open} onClick={onToggle}>
        <span className="av4-fold-c" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="av4-fold-t">{title}</span>
        {count !== undefined && count !== null && <span className="av4-fold-n">{fmtNum(count)}</span>}
        <span className="av4-fold-x">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && <div className="av4-fold-b">{children}</div>}
    </section>
  );
}
const FOLD_NAMES = { banner: 'Activity not logged', cleanup: 'Data cleanup', tls: 'Team leads', openjobs: 'Open jobs', today: 'Today' };
const foldCount = (w) => (w.type === 'openjobs' ? w.total : w.type === 'people' || w.type === 'list' || w.type === 'jobs' || w.type === 'clients' || w.type === 'review' ? w.total : undefined);

// ---- The page ----------------------------------------------------------------------------
export default function AtsV4({
  data, params, reload, tls, user, onDrill, onPickDept, draw, cleanupLink, prevWord,
}) {
  const ws = arr(data.widgets);
  const used = new Set();
  const take = (pred) => {
    const w = ws.find((x) => !used.has(x.id) && pred(x));
    if (w) used.add(w.id);
    return w || null;
  };
  const kpi = take((w) => w.type === 'kpis');
  const tiles = buildTiles(data, ws);
  const lines = take((w) => w.type === 'lines');
  void lines;
  const att = attentionOf(data, ws, onDrill);
  const openjobs = ws.find((w) => w.type === 'openjobs') || null;
  const tlsW = ws.find((w) => w.type === 'tls') || null;
  const middle = openjobs ? null : take((w) => w.type === 'jobs') || take((w) => w.type === 'clients' && w.id === 'per-client');
  const depts = take((w) => w.type === 'depts');
  const left3 = depts ? null : take((w) => w.type === 'review') || take((w) => w.type === 'tasks') || take((w) => w.type === 'list');
  const peopleW = take((w) => w.type === 'people');
  const right3 = tlsW || peopleW ? null : take((w) => w.type === 'list') || take((w) => w.type === 'clients');
  const line = take((w) => w.type === 'line');
  const money = take((w) => w.type === 'money');
  const funnel = take((w) => w.type === 'funnel');
  const today = take((w) => w.type === 'today');
  const banner = take((w) => w.type === 'banner');
  const fill = [];
  const FILL = ['list', 'target', 'clients', 'jobs', 'cleanup'];
  while ([line, money, funnel].filter(Boolean).length + fill.length < 3) {
    const w = take((x) => FILL.includes(x.type));
    if (!w) break;
    fill.push(w);
  }
  const below = ws.filter((w) => !used.has(w.id) && w.type !== 'kpis');

  // Quick actions — only what this login may do (the same can() checks the screens use).
  const qa = [
    canRaiseRequirement(user) && { key: 'post', icon: 'plus', label: 'Post a job', to: '/requirements?new=1' },
    can(user, 'ats', 'candidates', 'Add Candidate', 'create') && { key: 'add-cand', icon: 'user', label: 'Add candidate', to: '/candidates?add=1' },
    can(user, 'ats', 'requirements', 'Requirement List', 'view') && { key: 'jobs', icon: 'briefcase', label: 'View all jobs', to: '/requirements' },
    can(user, 'ats', 'candidates', 'Candidate List', 'view') && { key: 'cands', icon: 'users', label: 'View candidates', to: '/candidates' },
    can(user, 'ats', 'clients', 'Client List', 'view') && { key: 'clients', icon: 'building', label: 'View clients', to: '/clients' },
    can(user, 'ats', 'interviews', 'Calendar View', 'view') && { key: 'cal', icon: 'calendar', label: 'Interview calendar', to: '/ats/calendar' },
    can(user, null, 'reports', 'ATS Reports', 'view') && { key: 'reports', icon: 'chart', label: 'Reports', to: '/reports/ats' },
    ...arr(data.extras).filter((x) => x && x.button && x.to).map((x) => ({ key: x.id, icon: 'file', label: x.label, to: x.to })),
    cleanupLink && data.cleanup && { key: 'cleanup', icon: 'refresh', label: 'Open Data cleanup', to: data.cleanup.to },
  ].filter(Boolean);

  const [open, setOpen] = useState(readOpen);
  const toggle = (id, force) => {
    setOpen((cur) => {
      const on = force !== undefined ? force : !cur.includes(id);
      const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
      return next;
    });
  };
  const showTls = () => {
    toggle('tls', true);
    setTimeout(() => { const el = document.getElementById('av4-fold-tls'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
  };
  const mayOpenJob = can(user, 'ats', 'requirements', 'Requirement List', 'view');
  const mainAction = data.main
    ? (data.main.to ? { label: data.main.label, to: data.main.to } : { label: data.main.label, onClick: () => onDrill(data.main.drill) })
    : null;
  const row4 = [line, money, funnel, ...fill].filter(Boolean);

  return (
    <div className="av4">
      {(kpi || tiles.length > 0) && (
        <KpiRow className={`av4-kpis av4-kpis-${Math.min(6, tiles.length)}`}>
          {tiles.slice(0, 6).map((t) => <Tile key={t.id} t={t} onDrill={onDrill} prevWord={prevWord} />)}
        </KpiRow>
      )}
      {tiles.length > 6 && (
        <KpiRow className="av4-kpis av4-kpis-6">
          {tiles.slice(6).map((t) => <Tile key={t.id} t={t} onDrill={onDrill} prevWord={prevWord} />)}
        </KpiRow>
      )}

      <div className="av4-row av4-row2">
        <Panel title="Needs attention" icon="alert" iconTone="red" className="av4-att" action={mainAction}>
          <AttentionList items={att.items} empty={att.empty} />
          {att.more > 0 && <div className="av4-note">+ {fmt(att.more)} smaller {att.more === 1 ? 'item' : 'items'}</div>}
          {att.notes.map((n) => <div key={n} className="av4-note is-ok">{n}</div>)}
        </Panel>
        {openjobs
          ? <LateJobs params={params} reload={reload} total={openjobs.total} drill={openjobs.drill} onDrill={onDrill} mayOpen={mayOpenJob} />
          : middle ? <JobsTable w={middle} onDrill={onDrill} /> : null}
        {qa.length > 0 && (
          <Panel title="Quick actions" icon="bolt" iconTone="blue" className="av4-quick">
            <QuickActions items={qa} />
          </Panel>
        )}
      </div>

      {(depts || left3 || tlsW || peopleW || right3) && (
        <div className="av4-row av4-row3">
          {depts && <DeptPerf w={depts} onDrill={onDrill} onPickDept={onPickDept} tls={tls} />}
          {left3 && <div className="av4-slot">{draw(left3)}</div>}
          {(tlsW || peopleW) && <TeamSnapshot tlsW={tlsW} tls={tls} peopleW={peopleW} onDrill={onDrill} onShowAll={showTls} />}
          {right3 && <div className="av4-slot">{draw(right3)}</div>}
        </div>
      )}

      {(row4.length > 0 || today || banner) && (
        <div className="av4-row av4-row4">
          {line && <Joinings w={line} onDrill={onDrill} />}
          {money && <Money w={money} onDrill={onDrill} />}
          {funnel && <Hiring w={funnel} onDrill={onDrill} />}
          {fill.map((w) => <div key={w.id} className="av4-slot av4-fill">{draw(w)}</div>)}
          {(today || banner) && <Activity today={today} banner={banner} onDrill={onDrill} />}
        </div>
      )}

      {below.length > 0 && (
        <div className="av4-below">
          <div className="av4-below-h">More on your dashboard</div>
          {below.map((w) => (
            <Fold key={w.id} id={w.type === 'tls' ? 'tls' : w.id} title={w.title || FOLD_NAMES[w.type] || 'More'} count={foldCount(w)} open={open.includes(w.type === 'tls' ? 'tls' : w.id)} onToggle={() => toggle(w.type === 'tls' ? 'tls' : w.id)}>
              {draw(w)}
            </Fold>
          ))}
        </div>
      )}

      <footer className="av4-foot">
        <span>TeamLink · ATS Dashboard{data.scopeChip ? ` · Your area: ${data.scopeChip}` : ''}</span>
        {data.asOf && <span>Last updated: {new Date(data.asOf).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
      </footer>
    </div>
  );
}

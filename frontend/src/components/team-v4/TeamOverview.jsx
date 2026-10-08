import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import {
  KpiRow, KpiTile, Panel, AtsGrid, BarList, QuickActions, Avatar, Pill, Icon, pctChange, fmtNum,
} from '../atskit/AtsKit.jsx';
import { metricLink } from '../../pages/ats/Recruiter360.jsx';
import { LineChart, Donut } from './TeamCharts.jsx';
import {
  monthOf, prevMonth, periodRange, daysBetween, shortDay, addDays, roleText, joinRate, lcName, timeAgo, parseDay,
} from './teamData.js';
import './teamv4.css';

// ---------------------------------------------------------------------------
// TEAM OVERVIEW (v4, 2026-10-08) — the reference dashboard on top of the Team
// screen. EVERY figure is real TeamLink data, already scoped by the server:
//
//   team rows        GET /ats/team?shape=v2 (the page's own load) — who is on
//                    the team, their role, counts (open jobs, in process,
//                    interviews, joined …) → KPIs, distribution, members,
//                    workload by team lead, top performers, team workload.
//   daily report     GET /ats-daily/month?month= (this + last month) — day by
//                    day interviews scheduled, offers, joined → the line
//                    chart and "Joined this month" with its change.
//   activity         GET /ats-daily/day?day= (the latest days with work).
//   follow-ups       GET /followups/dashboard — open follow-ups per owner.
//   on leave         GET /leave/on-leave-today — only when the login holds
//                    the HRMS leave export right the endpoint asks for.
//   calendar         GET /reports/interviews?from=&to=&groupBy=recruiter, one
//                    call per day of the next 7 — only with ATS Reports view.
// A value that is not available is drawn as "—"; nothing is made up.
// ---------------------------------------------------------------------------

const C = { blue: '#2F6FE4', violet: '#8B5CF6', green: '#22A06B', amber: '#E59A1A', slate: '#8A97A8', teal: '#1BA3A1' };
const isFormer = (r) => !!r.former || r.status === 'Left';
const TOP = 6;

// What a daily-report row says, with an icon for the activity list.
const ACT_ICON = {
  added: ['user', 'blue'], calls: ['chat', 'teal'], mails: ['send', 'blue'], whatsapp: ['chat', 'green'],
  followUps: ['check', 'green'], missed: ['alert', 'red'], reviewed: ['file', 'violet'], sentTl: ['arrow', 'violet'],
  sentClient: ['send', 'amber'], interviews: ['calendar', 'blue'], attended: ['check', 'teal'], feedback: ['chat', 'violet'],
  offers: ['star', 'amber'], joined: ['handshake', 'green'],
};
const ACTIVITY_KEYS = Object.keys(ACT_ICON);

function useGet(url, enabled, deps = []) {
  const [state, setState] = useState({ data: null, error: false });
  useEffect(() => {
    if (!enabled || !url) return undefined;
    let alive = true;
    api.get(url)
      .then((r) => { if (alive) setState({ data: r.data, error: false }); })
      .catch(() => { if (alive) setState({ data: null, error: true }); });
    return () => { alive = false; };
  }, [url, enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Daily report: this month and last month (together they cover every period
// the header offers, and the like-for-like "vs last month").
function useDaily(enabled, today, reloadKey) {
  const cur = monthOf(today);
  const prev = prevMonth(cur);
  const a = useGet(`/ats-daily/month?month=${cur}`, enabled, [reloadKey]);
  const b = useGet(`/ats-daily/month?month=${prev}`, enabled, [reloadKey]);
  const byDay = useMemo(() => {
    const m = new Map();
    [b.data, a.data].forEach((d) => (d && Array.isArray(d.days) ? d.days : []).forEach((x) => m.set(x.date, x)));
    return m;
  }, [a.data, b.data]);
  return {
    cur: a.data, prev: b.data, byDay, loading: enabled && (!a.data && !a.error), error: a.error,
  };
}

// The latest one or two days that have any recorded work, then that work.
function useActivity(daily, enabled, today) {
  const days = useMemo(() => {
    const out = [];
    [...daily.byDay.values()]
      .filter((d) => d.date <= today && ACTIVITY_KEYS.some((k) => Number(d[k]) > 0))
      .sort((x, y) => (x.date < y.date ? 1 : -1))
      .forEach((d) => { if (out.length < 2) out.push(d); });
    return out;
  }, [daily.byDay, today]);
  const [rows, setRows] = useState(null);
  const key = days.map((d) => d.date).join(',');
  useEffect(() => {
    if (!enabled || daily.loading) return undefined;
    if (!days.length) { setRows([]); return undefined; }
    let alive = true;
    (async () => {
      const out = [];
      for (const d of days) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await api.get('/ats-daily/day', { params: { day: d.date } });
          out.push(...((r.data && r.data.rows) || []).map((x) => ({ ...x, day: d.date })));
        } catch { /* that day stays out */ }
        if (out.length >= TOP) break;
      }
      if (alive) setRows(out.slice(0, TOP));
    })();
    return () => { alive = false; };
  }, [enabled, daily.loading, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

// Interviews per day for the next 7 days (by recruiter) — the reports API.
const IV_KEYS = ['scheduled', 'completed', 'feedbackPending', 'noShow', 'rescheduled'];
function useWeekInterviews(enabled, today, reloadKey) {
  const [days, setDays] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const list = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    Promise.all(list.map((d) => api.get('/reports/interviews', { params: { from: d, to: d, groupBy: 'recruiter' } })
      .then((r) => ({ date: d, rows: (r.data && r.data.rows) || [] }))
      .catch(() => ({ date: d, rows: null }))))
      .then((out) => {
        if (!alive) return;
        setDays(out.map((d) => {
          const people = (d.rows || []).map((g) => ({ name: g.group, n: IV_KEYS.reduce((s, k) => s + (Number(g[k]) || 0), 0) })).filter((g) => g.n > 0);
          return { date: d.date, failed: d.rows === null, people, total: people.reduce((s, g) => s + g.n, 0) };
        }));
      });
    return () => { alive = false; };
  }, [enabled, today, reloadKey]);
  return days;
}

export default function TeamOverview({
  rows = [], loading, selfMode, isAdmin, period, today, user, onOpen, goView,
  canAdd, canReports, canLeave, reportTo, dailyTo, reloadKey = 0,
}) {
  const navigate = useNavigate();
  const daily = useDaily(true, today, reloadKey);
  const activity = useActivity(daily, true, today);
  const fu = useGet('/followups/dashboard', true, [reloadKey]);
  const leave = useGet('/leave/on-leave-today', !!canLeave && !selfMode, [reloadKey]);
  const week = useWeekInterviews(!!canReports, today, reloadKey);
  const [calDay, setCalDay] = useState(null);
  const [openTl, setOpenTl] = useState(() => new Set());

  const active = useMemo(() => rows.filter((r) => !isFormer(r)), [rows]);
  const recruiters = active.filter((r) => r.roleGroup === 'RECRUITER');
  const tls = active.filter((r) => r.roleGroup === 'TL');
  const bdes = active.filter((r) => r.roleGroup === 'BDE');
  const others = active.filter((r) => !['RECRUITER', 'TL', 'BDE'].includes(r.roleGroup));

  // On leave today: the leave list matched to the people on this team (by name —
  // the leave list carries the employee's name, not their login).
  const onLeave = useMemo(() => {
    if (!leave.data || !Array.isArray(leave.data.employees)) return null;
    const names = new Set(leave.data.employees.map((e) => lcName(e.name)));
    return new Set(active.filter((r) => names.has(lcName(r.name))).map((r) => r.id));
  }, [leave.data, active]);

  // --- the period (header) -------------------------------------------------
  const range = periodRange(period, today);
  const periodDays = daysBetween(range.from, range.to);
  const series = [
    ['interviews', 'Interviews scheduled', C.blue],
    ['offers', 'Offers', C.amber],
    ['joined', 'Joined', C.green],
  ].map(([key, label, color]) => ({
    key, label, color,
    values: periodDays.map((d) => {
      const x = daily.byDay.get(d);
      return d > today || !x ? null : Number(x[key]) || 0;
    }),
  }));
  const periodTotal = (k) => series.find((s) => s.key === k).values.reduce((n, v) => n + (v || 0), 0);

  // Joined this month vs the same days of last month (the daily report's own days).
  const dom = Number(today.slice(8, 10));
  const joinedNow = daily.cur && daily.cur.totals ? Number(daily.cur.totals.joined) : null;
  const joinedBefore = daily.prev && Array.isArray(daily.prev.days)
    ? daily.prev.days.filter((d) => Number(d.date.slice(8, 10)) <= dom).reduce((n, d) => n + (Number(d.joined) || 0), 0)
    : null;
  const joinedDelta = joinedNow === null || joinedBefore === null ? null : pctChange(joinedNow, joinedBefore);

  // --- follow-ups -------------------------------------------------------------
  const fuData = fu.data || null;
  const fuOpen = (o) => (Number(o.overdue) || 0) + (Number(o.dueToday) || 0) + (Number(o.upcoming) || 0);
  const fuOwners = fuData && fuData.team && Array.isArray(fuData.team.owners) ? fuData.team.owners : [];
  const fuDue = fuData ? (selfMode ? fuData.mine : (fuData.team || fuData.health)) : null;
  const fuDueNow = fuDue ? (Number(fuDue.overdue) || 0) + (Number(fuDue.dueToday) || 0) : null;

  // --- performers (team rows) ---------------------------------------------------
  const doers = active.filter((r) => r.roleGroup !== 'TL' && r.counts);
  const performers = [...doers]
    .filter((r) => (Number(r.counts.joined) || 0) + (Number(r.counts.interviews) || 0) + (Number(r.counts.submitted) || 0) > 0)
    .sort((a, b) => (b.counts.joined || 0) - (a.counts.joined || 0) || (b.counts.interviews || 0) - (a.counts.interviews || 0)
      || (b.counts.submitted || 0) - (a.counts.submitted || 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 5);

  const best = (list, val) => list.reduce((acc, r) => { const v = val(r); return v !== null && v > 0 && (!acc || v > acc.v) ? { r, v } : acc; }, null);
  const bestRate = best(doers.filter((r) => (Number(r.counts.joined) || 0) > 0), (r) => joinRate(r.counts));
  const mostJoined = best(doers, (r) => Number(r.counts.joined) || 0);
  const mostFu = fuOwners.reduce((acc, o) => (fuOpen(o) > 0 && (!acc || fuOpen(o) > fuOpen(acc)) ? o : acc), null);
  const mostWaiting = best(active.filter((r) => r.counts), (r) => Number(r.counts.needsAction) || 0);

  // --- members list ------------------------------------------------------------
  const members = [...active]
    .sort((a, b) => ((b.counts?.interviews || 0) + (b.counts?.joined || 0)) - ((a.counts?.interviews || 0) + (a.counts?.joined || 0))
      || String(a.name).localeCompare(String(b.name)))
    .slice(0, TOP);

  const tlRows = [...tls].sort((a, b) => (b.counts?.candidates || 0) - (a.counts?.candidates || 0) || String(a.name).localeCompare(String(b.name)));
  const recruitersOf = (tl) => recruiters.filter((r) => r.tlUserId === tl.id);

  // --- distribution ------------------------------------------------------------------
  const seg = [
    { key: 'rec', label: 'Recruiters', value: recruiters.length, color: C.blue },
    { key: 'tl', label: 'Team leads', value: tls.length, color: C.violet },
    { key: 'bde', label: 'Client managers', value: bdes.length, color: C.green },
    { key: 'oth', label: 'Others', value: others.length, color: C.slate },
  ].filter((s) => s.value > 0 || s.key !== 'oth');
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');

  // --- calendar -----------------------------------------------------------------------
  const calPick = calDay || (week && (week.find((d) => d.total > 0) || week[0]) ? (week.find((d) => d.total > 0) || week[0]).date : null);
  const calSel = week ? week.find((d) => d.date === calPick) : null;

  const quick = [
    canAdd && { key: 'add', icon: 'plus', label: 'Add team member', sub: 'Employee record and login', to: '/employees', tone: 'blue' },
    isAdmin
      ? { key: 'org', icon: 'team', label: 'Team structure', sub: 'Departments, team leads, seats', onClick: () => goView('org'), tone: 'violet' }
      : !selfMode && { key: 'asg', icon: 'team', label: 'Team structure', sub: 'Who works on which job', onClick: () => goView('assignments'), tone: 'violet' },
    reportTo && { key: 'rep', icon: 'chart', label: selfMode ? 'My results' : 'Performance report', sub: selfMode ? 'Your numbers, day by day' : 'Recruiter performance', to: reportTo, tone: 'green' },
    {
      key: 'fu', icon: 'clock', label: 'Pending follow-ups',
      sub: fuDueNow === null ? 'Who to contact, and by when' : `${fmtNum(fuDueNow)} due today or late`,
      onClick: () => goView('followups'), tone: 'amber',
    },
    selfMode && { key: 'tasks', icon: 'list', label: 'My tasks', sub: 'Next steps that are yours', onClick: () => goView('pending'), tone: 'teal' },
  ].filter(Boolean);

  const chart = (
    <Panel
      title={selfMode ? 'My Performance Overview' : 'Team Performance Overview'}
      sub={`${shortDay(range.from)} – ${shortDay(range.to)} · from the daily report`}
      action={dailyTo ? { label: 'Daily report', to: dailyTo } : null}
      className="tv4-chart-panel"
    >
      <div className="tv4-legend">
        {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label} <b>{fmtNum(periodTotal(s.key))}</b></span>)}
      </div>
      {daily.loading ? <div className="ak-empty">Loading…</div>
        : daily.error ? <div className="ak-empty">The daily report could not be loaded.</div>
          : <LineChart labels={periodDays.map(shortDay)} series={series} empty="No interviews, offers or joinings recorded in this period." />}
    </Panel>
  );

  const activityPanel = (
    <Panel title="Recent Activities" sub={selfMode ? 'Your recorded work' : 'Recorded work of the team'} action={dailyTo ? { label: 'View all', to: dailyTo } : null}>
      {activity === null ? <div className="ak-empty">Loading…</div>
        : !activity.length ? <div className="ak-empty">No recorded work in the last two months.</div>
          : (
            <ul className="tv4-acts">
              {activity.map((a, i) => {
                const [ic, tone] = ACT_ICON[a.metric] || ['bolt', 'slate'];
                const subject = [a.candidate, a.job].filter(Boolean).join(' – ');
                return (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={`${a.at}-${i}`}>
                    <span className={`tv4-act-ic ak-t-${tone}`}><Icon name={ic} size={15} /></span>
                    <span className="tv4-act-txt">
                      <span className="tv4-act-title">{a.what}{a.person && !selfMode ? <span className="tv4-act-by"> · {a.person}</span> : null}</span>
                      <span className="tv4-act-sub" title={subject}>{a.candidateId ? <Link to={`/candidates/${a.candidateId}`}>{subject || 'Open'}</Link> : (subject || a.detail || '—')}</span>
                    </span>
                    <span className="tv4-act-time">{a.timeKnown ? timeAgo(a.at) : shortDay(a.day)}</span>
                  </li>
                );
              })}
            </ul>
          )}
    </Panel>
  );

  const calendarPanel = canReports && (
    <Panel title={selfMode ? 'My Calendar' : 'Team Calendar'} sub="Interviews, next 7 days" action={{ label: 'Open', to: '/ats/calendar' }}>
      {week === null ? <div className="ak-empty">Loading…</div> : (
        <>
          <div className="tv4-week" role="group" aria-label="Pick a day">
            {week.map((d) => {
              const dt = parseDay(d.date);
              return (
                <button key={d.date} type="button" className={`tv4-wday${d.date === calPick ? ' on' : ''}${d.total ? ' has' : ''}`} onClick={() => setCalDay(d.date)} aria-pressed={d.date === calPick}>
                  <span className="tv4-wd">{dt.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                  <span className="tv4-wn">{dt.getDate()}</span>
                  <span className="tv4-wc">{d.failed ? '—' : d.total || ''}</span>
                </button>
              );
            })}
          </div>
          {calSel && (
            calSel.failed ? <div className="ak-empty">Could not load this day.</div>
              : !calSel.people.length ? <div className="ak-empty">{`No interviews on ${shortDay(calSel.date)}.`}</div>
                : (
                  <ul className="tv4-cal-list">
                    {calSel.people.slice(0, 5).map((g) => (
                      <li key={g.name}>
                        <Avatar name={g.name} size={24} />
                        <span className="tv4-cal-name">{g.name}</span>
                        <Pill tone="blue">{`${g.n} interview${g.n === 1 ? '' : 's'}`}</Pill>
                      </li>
                    ))}
                    {calSel.people.length > 5 && <li className="tv4-more">{`+${calSel.people.length - 5} more`}</li>}
                  </ul>
                )
          )}
        </>
      )}
    </Panel>
  );

  // ===========================================================================
  // RECRUITER / BDE — their own work in the same look.
  // ===========================================================================
  if (selfMode) {
    const me = active.find((r) => r.id === (user && user.id)) || active[0];
    const c = (me && me.counts) || {};
    const tiles = me && me.roleGroup === 'BDE'
      ? [['clients', 'My clients', 'building', 'blue'], ['openRequirements', 'Open jobs', 'briefcase', 'violet'], ['submitted', 'Sent to client', 'send', 'amber'],
        ['interviews', 'Interviews', 'calendar', 'teal'], ['selected', 'Selected', 'star', 'pink'], ['joined', 'Joined', 'handshake', 'green']]
      : [['openRequirements', 'Open jobs', 'briefcase', 'blue'], ['activeCandidates', 'People in process', 'users', 'violet'], ['needsAction', 'Needs action', 'alert', 'red'],
        ['interviews', 'Interviews', 'calendar', 'teal'], ['selected', 'Selected', 'star', 'amber'], ['joined', 'Joined', 'handshake', 'green']];
    return (
      <div className="tv4">
        <KpiRow className="tv4-kpis">
          {tiles.map(([k, label, icon, tone]) => (
            <KpiTile key={k} icon={icon} tone={tone} label={label} value={me ? c[k] : null} loading={loading}
              sub={k === 'joined' ? 'all time' : 'now'} onClick={me && c[k] ? () => navigate(metricLink(me.id, k)) : undefined} />
          ))}
        </KpiRow>
        <AtsGrid className="tv4-grid">
          <div className="ak-span-7 tv4-cell">{chart}</div>
          <div className="ak-span-5 tv4-cell">{activityPanel}</div>
          {calendarPanel && <div className="ak-span-6 tv4-cell">{calendarPanel}</div>}
          <div className={`${calendarPanel ? 'ak-span-6' : 'ak-span-12'} tv4-cell`}>
            <Panel title="Quick Actions"><QuickActions items={quick} /></Panel>
          </div>
        </AtsGrid>
      </div>
    );
  }

  // ===========================================================================
  // LEADS — the team.
  // ===========================================================================
  const total = rows.length;
  const left = rows.length - active.length;
  return (
    <div className="tv4">
      <KpiRow className="tv4-kpis">
        <KpiTile icon="users" tone="blue" label="Total team members" value={total} loading={loading}
          sub={left > 0 ? `incl. ${fmtNum(left)} who left` : 'in your area'} onClick={() => goView('people')} />
        <KpiTile icon="user" tone="violet" label="Recruiters" value={recruiters.length} loading={loading}
          sub={`${pct(recruiters.length, active.length)} of active`} onClick={() => goView('people', { role: 'RECRUITER' })} />
        <KpiTile icon="team" tone="teal" label="Team leads" value={tls.length} loading={loading}
          sub={`${pct(tls.length, active.length)} of active`} onClick={tls.length ? () => goView('people', { role: 'TL' }) : undefined} />
        <KpiTile icon="check" tone="green" label="Active" value={active.length} loading={loading}
          sub={bdes.length ? `${fmtNum(bdes.length)} client manager${bdes.length === 1 ? '' : 's'}` : 'working now'} />
        <KpiTile icon="leave" tone="amber" label="On leave" value={onLeave ? onLeave.size : null}
          loading={!!canLeave && !leave.data && !leave.error}
          sub={onLeave ? 'today' : 'not in your access'}
          title={onLeave ? 'Approved leave today (HRMS), matched to this team by name' : 'Leave needs the HRMS leave right'} />
        <KpiTile icon="handshake" tone="pink" label="Joined this month" value={joinedNow} loading={daily.loading}
          delta={joinedDelta} deltaLabel="vs last month" sub="candidates"
          title="Candidates who joined this month (daily report), against the same days of last month" />
      </KpiRow>

      <AtsGrid className="tv4-grid">
        <div className="ak-span-5 tv4-cell">{chart}</div>

        <div className="ak-span-3 tv4-cell">
          <Panel title="Team Distribution" sub="Active people by role">
            <div className="tv4-dist">
              <Donut segments={seg} center={fmtNum(active.length)} centerLabel="Active" />
              <ul className="tv4-dist-legend">
                {seg.map((s) => (
                  <li key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span><b>{fmtNum(s.value)}</b><em>{pct(s.value, active.length)}</em></li>
                ))}
                <li className="tv4-dist-leave">
                  <i style={{ background: C.amber }} /><span>On leave today</span>
                  <b>{onLeave ? fmtNum(onLeave.size) : '—'}</b><em>{onLeave ? pct(onLeave.size, active.length) : ''}</em>
                </li>
              </ul>
            </div>
          </Panel>
        </div>

        <div className="ak-span-4 tv4-cell">
          <Panel title="Team Members" action={{ label: 'View all', onClick: () => goView('people') }} flush>
            {!members.length ? <div className="ak-empty">{loading ? 'Loading…' : 'Nobody on the team in your area yet.'}</div> : (
              <ul className="tv4-members">
                {members.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="tv4-member" onClick={() => onOpen(r.id)} title={`Open ${r.name}'s 360`}>
                      <Avatar name={r.name} size={30} />
                      <span className="tv4-member-txt">
                        <span className="tv4-member-name">{r.name}</span>
                        <span className="tv4-member-role">{roleText(r)}{r.department ? ` · ${r.department}` : ''}</span>
                      </span>
                      <span className="tv4-member-n">{`${fmtNum(r.counts?.interviews || 0)} int | ${fmtNum(r.counts?.joined || 0)} join`}</span>
                      {onLeave && onLeave.has(r.id) ? <Pill tone="amber">On leave</Pill> : <Pill tone="green">Active</Pill>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className={`${calendarPanel ? 'ak-span-5' : 'ak-span-7'} tv4-cell`}>
          <Panel title="Workload by Team Lead" sub="Click a row for the recruiters under them"
            action={tls.length ? { label: 'View all', onClick: () => goView('people', { role: 'TL' }) } : null} flush>
            {!tlRows.length ? <div className="ak-empty">{loading ? 'Loading…' : 'No team lead in your area.'}</div> : (
              <div className="tv4-scroll">
                <table className="ak-table tv4-tl">
                  <thead>
                    <tr><th>#</th><th>Team lead</th><th className="num" title="Recruiters whose seat reports to them">Recruiters</th><th className="num">Open jobs</th><th className="num" title="Candidates in process in their team">In process</th><th className="num">Joined</th></tr>
                  </thead>
                  <tbody>
                    {tlRows.slice(0, TOP).map((t, i) => {
                      const c = t.counts || {};
                      const open = openTl.has(t.id);
                      const subs = open ? recruitersOf(t) : [];
                      const toggle = () => setOpenTl((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; });
                      const num = (k) => (c[k] ? <Link to={metricLink(t.id, k)} onClick={(e) => e.stopPropagation()}>{fmtNum(c[k])}</Link> : <span className="tv4-zero">0</span>);
                      return [
                        <tr key={t.id} className="ak-row-click" onClick={toggle} aria-expanded={open}>
                          <td className="tv4-rank">{i + 1}</td>
                          <td>
                            <span className="ak-person">
                              <span className="tv4-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                              <Avatar name={t.name} size={24} />
                              <button type="button" className="tv4-link" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} title={`Open ${t.name}'s 360`}>{t.name}</button>
                            </span>
                          </td>
                          <td className="num">{num('recruiters')}</td>
                          <td className="num">{num('requirements')}</td>
                          <td className="num">{num('candidates')}</td>
                          <td className="num">{num('joined')}</td>
                        </tr>,
                        open && (
                          <tr key={`${t.id}-x`} className="tv4-sub">
                            <td />
                            <td colSpan={5}>
                              {!subs.length ? <span className="tv4-muted">No recruiter seat reports to them.</span> : subs.map((r) => (
                                <span key={r.id} className="tv4-subrec">
                                  <button type="button" className="tv4-link" onClick={() => onOpen(r.id)}>{r.name}</button>
                                  <span className="tv4-muted">{` ${fmtNum(r.counts?.activeCandidates || 0)} in process · ${fmtNum(r.counts?.joined || 0)} joined`}</span>
                                </span>
                              ))}
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className={`${calendarPanel ? 'ak-span-4' : 'ak-span-5'} tv4-cell`}>{activityPanel}</div>
        {calendarPanel && <div className="ak-span-3 tv4-cell">{calendarPanel}</div>}

        <div className="ak-span-4 tv4-cell">
          <Panel title="Top Team Performers" sub="Joined, then interviews" action={{ label: 'View all', onClick: () => goView('people') }} flush>
            {!performers.length ? <div className="ak-empty">{loading ? 'Loading…' : 'Nobody here has a person at the client yet.'}</div> : (
              <table className="ak-table tv4-perf">
                <thead>
                  <tr><th>#</th><th>Name</th><th className="num">Interviews</th><th className="num">Joined</th><th className="num" title="Joined ÷ (sent to client + at interview + selected + joined)">Join %</th></tr>
                </thead>
                <tbody>
                  {performers.map((r, i) => {
                    const c = r.counts;
                    const rate = joinRate(c);
                    return (
                      <tr key={r.id} className="ak-row-click" onClick={() => onOpen(r.id)}>
                        <td className="tv4-rank">{i + 1}</td>
                        <td>
                          <span className="ak-person">
                            <Avatar name={r.name} size={24} />
                            <span className="tv4-perf-who"><span>{r.name}</span><small>{roleText(r)}</small></span>
                          </span>
                        </td>
                        <td className="num">{c.interviews ? <Link to={metricLink(r.id, 'interviews')} onClick={(e) => e.stopPropagation()}>{fmtNum(c.interviews)}</Link> : 0}</td>
                        <td className="num">{c.joined ? <Link to={metricLink(r.id, 'joined')} onClick={(e) => e.stopPropagation()}>{fmtNum(c.joined)}</Link> : 0}</td>
                        <td className="num">{rate === null ? '—' : `${rate.toFixed(1)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="ak-span-3 tv4-cell">
          <Panel title="Team Workload" sub="People in process, per recruiter">
            <BarList
              showShare
              empty={loading ? 'Loading…' : 'Nobody has people in process.'}
              rows={[...recruiters].sort((a, b) => (b.counts?.activeCandidates || 0) - (a.counts?.activeCandidates || 0)).slice(0, 7)
                .map((r, i) => ({
                  key: r.id, label: r.name, value: Number(r.counts?.activeCandidates) || 0, tone: ['blue', 'violet', 'teal', 'amber', 'green', 'pink', 'slate'][i],
                  onClick: () => navigate(metricLink(r.id, 'activeCandidates')),
                }))}
            />
          </Panel>
        </div>

        <div className="tv4-span-2 tv4-cell">
          <Panel title="Quick Actions"><QuickActions items={quick} /></Panel>
        </div>

        <div className="ak-span-3 tv4-cell">
          <Panel title="Key Insights" icon="bolt" iconTone="amber">
            <div className="tv4-insights">
              <Insight icon="trend" tone="green" label="Highest join rate" who={bestRate && bestRate.r.name}
                value={bestRate ? `${bestRate.v.toFixed(1)}%` : null} empty="No joinings yet" onClick={bestRate ? () => onOpen(bestRate.r.id) : null} />
              <Insight icon="handshake" tone="violet" label="Most joined" who={mostJoined && mostJoined.r.name}
                value={mostJoined ? fmtNum(mostJoined.v) : null} empty="No joinings yet" onClick={mostJoined ? () => navigate(metricLink(mostJoined.r.id, 'joined')) : null} />
              <Insight icon="clock" tone="amber" label="Most pending follow-ups" who={mostFu && mostFu.owner}
                value={mostFu ? fmtNum(fuOpen(mostFu)) : null} empty={fu.error ? '—' : 'None open'} onClick={() => goView('followups')} />
              <Insight icon="alert" tone="red" label="Most work waiting" who={mostWaiting && mostWaiting.r.name}
                value={mostWaiting ? fmtNum(mostWaiting.v) : null} empty="Nothing waiting" onClick={mostWaiting ? () => navigate(metricLink(mostWaiting.r.id, 'needsAction')) : null} />
            </div>
          </Panel>
        </div>
      </AtsGrid>
    </div>
  );
}

function Insight({ icon, tone, label, who, value, empty, onClick }) {
  const body = (
    <>
      <span className={`tv4-ins-ic ak-t-${tone}`}><Icon name={icon} size={15} /></span>
      <span className="tv4-ins-txt">
        <span className="tv4-ins-label">{label}</span>
        <span className="tv4-ins-who">{who ? <>{who} <b>({value})</b></> : <span className="tv4-muted">{empty}</span>}</span>
      </span>
    </>
  );
  return onClick
    ? <button type="button" className="tv4-ins" onClick={onClick}>{body}</button>
    : <div className="tv4-ins">{body}</div>;
}


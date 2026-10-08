import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import {
  KpiRow, KpiTile, Panel, Icon, Avatar, fmtNum,
} from '../atskit/AtsKit.jsx';
import './crq4.css';

// ---------------------------------------------------------------------------
// CLIENTS & REQUIREMENTS v4 — the Jobs overview above the list (2026-10-08).
//
// ONE call, the SAME one the old JobsSummary made: GET /requirements/summary
// with the list's own filters (the chip is not applied). Every number below is
// a field of that answer — nothing is computed from samples or defaulted:
//
//   KPI tiles        total · cards.open · cards.needsTl · cards.needsRecruiter
//                    · cards.late · cards.hold   (each opens its list, as before)
//   By stage         chain[] (Draft → Agreement Approved → … → Closed), ?dstatus=
//   Needs attention  cards.needsTl · needsRecruiter · late · waitingAgreement
//   By department    byDepartment[] (open jobs), the Department filter
//   Top clients      byClient[] (open jobs, top 8 from the server; 5 shown)
//
// A card the role may not use (needsTl / needsRecruiter null, or no chip for
// it) is not drawn — exactly the old rules.
// ---------------------------------------------------------------------------

export function useJobsSummary(params, reloadKey) {
  const [sum, setSum] = useState(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(params || {});
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.get('/requirements/summary', { params })
        .then((res) => { if (live) setSum(res.data || null); })
        .catch(() => { if (live) setSum(null); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return { sum, loading };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const pct = (part, whole) => (whole > 0 && part !== null ? Math.round((part / whole) * 100) : null);

//   views          the chips the server offers this role
//   view           the chip in use;  filters: the applied filters
export function JobsKpis({
  sum, loading, views = [], view, filters = {}, onView, onFilter,
}) {
  const c = (sum && sum.cards) || {};
  const has = (k) => views.includes(k);
  const total = sum ? num(sum.total) : null;
  const open = num(c.open);
  const tiles = [
    {
      key: 'total', icon: 'file', tone: 'blue', label: 'Total Requirements', value: total,
      sub: 'With these filters',
      onClick: has('all') ? () => onView('all') : undefined, active: view === 'all',
    },
    {
      key: 'open', icon: 'briefcase', tone: 'green', label: 'Open', value: open,
      sub: pct(open, total) !== null ? `${pct(open, total)}% of total` : 'Still finding people',
      onClick: has('open') ? () => onView('open') : undefined, active: view === 'open',
    },
    c.needsTl !== null && c.needsTl !== undefined && has('needstl') && {
      key: 'needstl', icon: 'user', tone: 'amber', label: 'Needs Team Lead', value: num(c.needsTl),
      sub: 'Nobody leads it yet', onClick: () => onView('needstl'), active: view === 'needstl',
    },
    c.needsRecruiter !== null && c.needsRecruiter !== undefined && has('unassigned') && {
      key: 'unassigned', icon: 'users', tone: 'violet', label: 'Needs Recruiter', value: num(c.needsRecruiter),
      sub: 'No recruiter yet', onClick: () => onView('unassigned'), active: view === 'unassigned',
    },
    {
      key: 'late', icon: 'clock', tone: 'red', label: 'Overdue', value: num(c.late),
      sub: 'Past the due date', onClick: () => onFilter({ deadline: filters.deadline === 'overdue' ? '' : 'overdue' }),
      active: filters.deadline === 'overdue',
    },
    {
      key: 'hold', icon: 'pause', tone: 'slate', label: 'On Hold', value: num(c.hold),
      sub: 'Paused for now', onClick: () => onFilter({ status: filters.status === 'ON_HOLD' ? '' : 'ON_HOLD' }),
      active: filters.status === 'ON_HOLD',
    },
  ].filter(Boolean);
  return (
    <KpiRow className="crq4-kpis">
      {tiles.map((t) => (
        <KpiTile
          key={t.key}
          icon={t.icon}
          tone={t.tone}
          label={t.label}
          value={sum ? t.value : null}
          loading={loading && !sum}
          sub={t.sub}
          onClick={t.onClick}
          active={t.active}
          title={t.onClick ? `Show: ${t.label}` : undefined}
        />
      ))}
    </KpiRow>
  );
}

// Draft → Agreement Approved → Assigned → Open → On Hold → Filled → Closed
const STAGE_LOOK = {
  draft: { icon: 'file', tone: 'slate', short: 'Draft' },
  approved: { icon: 'handshake', tone: 'blue', short: 'Agreement' },
  assigned: { icon: 'user', tone: 'violet', short: 'Assigned' },
  open: { icon: 'briefcase', tone: 'green', short: 'Open' },
  hold: { icon: 'pause', tone: 'amber', short: 'On Hold' },
  filled: { icon: 'check', tone: 'teal', short: 'Filled' },
  closed: { icon: 'x', tone: 'navy', short: 'Closed' },
};
export function StageFlow({ chain = [], active, onPick }) {
  if (!chain.length) return <div className="ak-empty">No data available</div>;
  return (
    <ol className="crq4-flow">
      {chain.map((s) => {
        const look = STAGE_LOOK[s.key] || { icon: 'list', tone: 'slate', short: s.label };
        const on = active === s.key;
        return (
          <li key={s.key} className={`crq4-flow-step crq4-c-${look.tone}${on ? ' is-on' : ''}`}>
            <button type="button" onClick={() => onPick(s.key)} aria-pressed={on} title={`${s.label}${s.hint ? ` — ${s.hint}` : ''}. Click to show these.`}>
              <span className="crq4-flow-dot"><Icon name={look.icon} size={16} /></span>
              <span className="crq4-flow-lbl">{look.short}</span>
              <span className="crq4-flow-n">{fmtNum(num(s.count))}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// Rows: [{ key, count, label, sub, tone, onClick }] — the whole row is the button.
export function AttentionRows({ items = [], empty = 'Nothing needs attention right now.' }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return <div className="ak-empty">{empty}</div>;
  return (
    <ul className="crq4-attn">
      {shown.map((it) => (
        <li key={it.key}>
          <button type="button" onClick={it.onClick} disabled={!it.onClick} aria-pressed={!!it.active}>
            <span className={`crq4-attn-n ak-t-${it.tone || 'red'}`}>{fmtNum(it.count)}</span>
            <span className="crq4-attn-txt">
              <span className="crq4-attn-label">{it.label}</span>
              {it.sub && <span className="crq4-attn-sub">{it.sub}</span>}
            </span>
            {it.onClick && <span className="crq4-attn-go" aria-hidden="true">›</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function jobsAttention(sum, { views = [], onView, onFilter, filters = {} }) {
  const c = (sum && sum.cards) || {};
  const has = (k) => views.includes(k);
  return [
    c.needsTl !== null && c.needsTl !== undefined && has('needstl') && {
      key: 'tl', count: num(c.needsTl), tone: 'red', label: 'Missing team lead', sub: 'Open requirements without a team lead', onClick: () => onView('needstl'),
    },
    c.needsRecruiter !== null && c.needsRecruiter !== undefined && has('unassigned') && {
      key: 'rec', count: num(c.needsRecruiter), tone: 'red', label: 'Missing recruiter', sub: 'Open requirements without a recruiter', onClick: () => onView('unassigned'),
    },
    c.late !== null && c.late !== undefined && {
      key: 'late', count: num(c.late), tone: 'red', label: 'Overdue', sub: 'Past the due date', onClick: () => onFilter({ deadline: filters.deadline === 'overdue' ? '' : 'overdue' }),
    },
    c.waitingAgreement !== null && c.waitingAgreement !== undefined && {
      key: 'agr', count: num(c.waitingAgreement), tone: 'red', label: 'Agreement pending', sub: 'Client agreement not signed yet', onClick: () => onFilter({ agreement: filters.agreement === 'pending' ? '' : 'pending' }),
    },
  ].filter(Boolean);
}

// Label + value + share on one line, the bar under it (the reference look).
//   rows: [{ key, label, value, onClick, active }]
export function ShareBars({ rows = [], max = 6, empty = 'No data available' }) {
  const list = rows.filter((r) => r && Number(r.value) > 0);
  if (!list.length) return <div className="ak-empty">{empty}</div>;
  const total = list.reduce((n, r) => n + Number(r.value), 0);
  const top = Math.max(...list.map((r) => Number(r.value)));
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  const tones = ['blue', 'blue', 'blue', 'blue', 'blue', 'blue'];
  return (
    <>
      <ul className="crq4-share">
        {shown.map((r, i) => {
          const share = total ? Math.round((Number(r.value) / total) * 100) : 0;
          const body = (
            <>
              <span className="crq4-share-lbl" title={r.label}>{r.label}</span>
              <span className="crq4-share-val">{fmtNum(Number(r.value))}</span>
              <span className="crq4-share-pct">{`${share}%`}</span>
              <span className="crq4-share-track"><span className={`crq4-share-fill ak-f-${tones[i % tones.length]}`} style={{ width: `${Math.max(3, (Number(r.value) / top) * 100)}%` }} /></span>
            </>
          );
          return (
            <li key={r.key || r.label} className={r.active ? 'is-on' : undefined}>
              {r.onClick ? <button type="button" onClick={r.onClick} aria-pressed={!!r.active}>{body}</button> : <div>{body}</div>}
            </li>
          );
        })}
      </ul>
      {rest > 0 && <div className="crq4-more">{`+ ${fmtNum(rest)} more`}</div>}
    </>
  );
}

//   rows: [{ key, name, value, onClick, active, to }]
export function RankList({ rows = [], max = 5, empty = 'No data available' }) {
  const list = rows.filter((r) => r && Number(r.value) > 0).slice(0, max);
  if (!list.length) return <div className="ak-empty">{empty}</div>;
  return (
    <ol className="crq4-rank">
      {list.map((r, i) => {
        const body = (
          <>
            <span className="crq4-rank-i">{i + 1}</span>
            <Avatar name={r.name} size={26} />
            <span className="crq4-rank-name" title={r.name}>{r.name}</span>
            <span className="crq4-rank-v">{fmtNum(Number(r.value))}</span>
          </>
        );
        return (
          <li key={r.key || r.name} className={r.active ? 'is-on' : undefined}>
            {r.onClick ? <button type="button" onClick={r.onClick} aria-pressed={!!r.active}>{body}</button>
              : r.to ? <Link to={r.to}>{body}</Link> : <div>{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

export { Panel };

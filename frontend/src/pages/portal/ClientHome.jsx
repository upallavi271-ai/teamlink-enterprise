import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './clientPosts.css';

// THE "SOCIAL POSTS" CLIENT LOGIN > DASHBOARD (2026-11-25). Founder: "the client's dashboard is too simple: it must show how many posts, on which platform, on which date, their social accounts and their
// plan, everything, and interactive." One login for the web and the phone app: this page is the first page after sign-in on both (a phone gets one column, a computer two).
//   month stepper   < November 2026 >, every number below is for that month
//   tiles           posts / waiting / approved / posted / changes asked: tap one to list only those
//   calendar        each day shows a dot per post (colour = where it stands); tap a day to list that day's posts
//   by platform     a bar per platform (Facebook, Instagram, ...): tap one to list only its posts
//   your plan       the plan, its period, and what is delivered this month against what the plan promises
//   your accounts   the social accounts TeamLink looks after for you, connected or not, posts and the last post date
//   your posts      the list, with the date of each (sent / approved / rejected / posted), opening the post to answer it
// A post has no "post on" date of its own in TeamLink, so it sits on the day of the last thing that happened to it (see marketing/clientPhone.js dashboard()).
// Server: GET /api/portal/client/posts/dashboard?month=YYYY-MM. Read only; the answers (approve / reject) are made on the post's own page.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const ICON = { facebook: 'f', instagram: '◎', x: '𝕏', threads: '@', linkedin: 'in', youtube: '▶', whatsapp: '✆', email: '✉', sms: '✉', rcs: '✉', none: '–' };
const STATUS = { waiting: ['amber', 'Waiting for you'], approved: ['blue', 'Approved'], posted: ['green', 'Posted'], changes: ['red', 'Changes asked'], updating: ['blue', 'Being updated'], expired: ['red', 'Expired'] };
const DOT = { waiting: '#e0a100', approved: '#2563eb', posted: '#15803d', changes: '#d9534f', updating: '#2563eb', expired: '#94a3b8' };
const TILES = [['', 'Posts'], ['waiting', 'Waiting for you'], ['approved', 'Approved'], ['posted', 'Posted'], ['changes', 'Changes asked']];
const monthWords = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayWords = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = (iso) => { try { return iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : ''; } catch { return ''; } };
const stepMonth = (m, by) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + by, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
const matches = (p, st) => !st || (st === 'changes' ? ['changes', 'updating'].includes(p.status) : p.status === st);
const onPlatform = (p, k) => !k || (k === 'none' ? p.platforms.length === 0 : p.platforms.some((x) => x.key === k)); // 'none' = no platform chosen yet
const dateLine = (p) => {
  if (p.status === 'posted') return `Posted ${shortDay(p.postedAt || p.at)}`;
  if (p.status === 'approved') return `Approved ${shortDay(p.decidedAt || p.at)}`;
  if (p.status === 'changes') return `Rejected ${shortDay(p.decidedAt || p.at)}`;
  return `Sent ${shortDay(p.sentAt || p.at)}`;
};
const planState = (pl) => (pl.state === 'ended' ? ['Ended', 'red'] : pl.state === 'overdue' ? ['Past its end date', 'red'] : pl.state === 'soon' ? [`Renews within ${pl.daysLeft} day${pl.daysLeft === 1 ? '' : 's'}`, 'amber'] : ['Running', 'green']);

function Calendar({ month, posts, today, picked, onPick }) {
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay = {};
  posts.forEach((p) => { (byDay[p.day] = byDay[p.day] || []).push(p); });
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(<span key={`b${i}`} className="cpx-cal-blank" />);
  for (let d = 1; d <= days; d += 1) {
    const key = `${month}-${String(d).padStart(2, '0')}`; const list = byDay[key] || [];
    cells.push(
      <button type="button" key={key} className={`cpx-cal-day${picked === key ? ' on' : ''}${today === key ? ' today' : ''}${list.length ? ' has' : ''}`} aria-pressed={picked === key}
        aria-label={`${dayWords(key)}: ${list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` : 'no posts'}`} disabled={!list.length && picked !== key} onClick={() => onPick(picked === key ? '' : key)}>
        <span className="cpx-cal-n">{d}</span>
        <span className="cpx-cal-dots">{list.slice(0, 4).map((p) => <i key={p.id} style={{ background: DOT[p.status] || '#94a3b8' }} />)}{list.length > 4 ? <em>+{list.length - 4}</em> : null}</span>
      </button>,
    );
  }
  return (
    <div>
      <div className="cpx-cal-head" aria-hidden="true">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x, i) => <span key={`${x}${i}`}>{x}</span>)}</div>
      <div className="cpx-cal">{cells}</div>
      <div className="cpx-legend">{[['waiting', 'Waiting for you'], ['approved', 'Approved'], ['posted', 'Posted'], ['changes', 'Changes asked']].map(([k, w]) => <span key={k}><i style={{ background: DOT[k] }} />{w}</span>)}</div>
    </div>
  );
}

function PostRow({ p }) {
  const [bad, setBad] = useState(false);
  const [tone, words] = STATUS[p.status] || ['', p.words];
  return (
    <Link className="cpx-row" to={`/client-posts?post=${encodeURIComponent(p.id)}`}>
      <span className="cpx-row-thumb" aria-hidden="true">{p.thumb && !bad ? <img src={p.thumb} alt="" loading="lazy" onError={() => setBad(true)} /> : (p.kind === 'video' ? '▶' : p.kind === 'words' ? '✎' : '▣')}</span>
      <span className="cpx-row-main">
        <b className="cpx-row-title">{p.title}</b>
        <span className="cpx-meta">{dateLine(p)}{p.kind === 'video' ? ' · Video' : p.kind === 'words' ? ' · Message' : ' · Picture'}</span>
        <span className="cpx-row-tags">
          <span className={`cpx-chip ${tone}`}>{words}</span>
          {p.platforms.map((x) => <span key={x.key} className="cpx-chip plat">{ICON[x.key] || '●'} {x.word}</span>)}
        </span>
        {p.status === 'changes' && p.comment ? <span className="cpx-meta">Your reason: “{p.comment}”</span> : null}
      </span>
      <span className="cpx-row-go" aria-hidden="true">›</span>
    </Link>
  );
}

export default function ClientHome() {
  const [month, setMonth] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [day, setDay] = useState('');
  const load = useCallback((m) => {
    setBusy(true);
    return api.get('/portal/client/posts/dashboard', { params: m ? { month: m } : {} })
      .then((r) => { setD(r.data); setMonth(r.data.month); setErr(''); })
      .catch((e) => setErr(errOf(e, 'Your dashboard could not be opened just now. Please try again.')))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(''); }, [load]);
  useEffect(() => { // the page is open on a phone for a long time: read it again when the person comes back to it
    const on = () => { if (document.visibilityState === 'visible') load(month); };
    document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on);
  }, [load, month]);
  const go = (m) => { setStatus(''); setPlatform(''); setDay(''); load(m); };
  const shown = useMemo(() => (d ? d.posts.filter((p) => matches(p, status) && onPlatform(p, platform) && (!day || p.day === day)) : []), [d, status, platform, day]);

  if (err && !d) return <div className="cpx cpx-home"><div className="cpx-msg err">{err} <button type="button" className="cpx-back" onClick={() => load('')}>Try again</button></div></div>;
  if (!d) return <div className="cpx cpx-home"><div className="cpx-meta">Loading your dashboard…</div></div>;

  const isNow = d.month === d.today.slice(0, 7);
  const oldest = d.months[d.months.length - 1];
  const maxPl = Math.max(1, ...d.platforms.map((x) => x.total));
  const filtered = !!(status || platform || day);
  const count = (k) => (k === '' ? d.counts.total : d.counts[k]);
  const plan = d.plan; const [pState, pTone] = plan ? planState(plan) : ['', ''];

  return (
    <div className="cpx cpx-home">
      <h1>{d.hello ? `Hello ${d.hello}` : d.company}</h1>
      <div className="cpx-sub">{d.company}: your social media posts, your plan and your accounts, all in one place.</div>

      <div className="cpx-month" role="group" aria-label="Month">
        <button type="button" className="cpx-step" aria-label="Previous month" disabled={busy || d.month <= oldest} onClick={() => go(stepMonth(d.month, -1))}>‹</button>
        <b aria-live="polite">{monthWords(d.month)}</b>
        <button type="button" className="cpx-step" aria-label="Next month" disabled={busy || isNow} onClick={() => go(stepMonth(d.month, 1))}>›</button>
        {!isNow ? <button type="button" className="cpx-link" onClick={() => go('')}>This month</button> : null}
      </div>
      {err ? <div className="cpx-msg err">{err}</div> : null}

      {d.waiting.length > 0 ? (
        <div className="cpx-card need" style={{ marginBottom: 14 }}><div className="cpx-body">
          <b className="cpx-title">{d.now.waiting} post{d.now.waiting === 1 ? '' : 's'} waiting for your answer</b>
          <div className="cpx-meta">Look at each one, then approve it or tell us what to change. Nothing is posted before you approve.</div>
          <div className="cpx-mini">
            {d.waiting.slice(0, 3).map((p) => (
              <Link key={p.id} className="cpx-mini-item" to={`/client-posts?post=${encodeURIComponent(p.id)}`}>
                <span className="cpx-row-thumb" aria-hidden="true">{p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : (p.kind === 'video' ? '▶' : '✎')}</span>
                <span><b>{p.title}</b><span className="cpx-meta" style={{ display: 'block' }}>Sent {shortDay(p.sentAt)}{p.platforms.length ? ` · ${p.platforms.map((x) => x.word).join(', ')}` : ''}</span></span>
              </Link>
            ))}
          </div>
          <Link className="cpx-btn" style={{ textDecoration: 'none' }} to="/client-posts">Look and answer</Link>
        </div></div>
      ) : null}

      <div className="cpx-tiles" role="group" aria-label="Posts this month, tap one to list only those">
        {TILES.map(([k, w]) => (
          <button type="button" key={k || 'all'} className={`cpx-tile${status === k ? ' on' : ''}`} aria-pressed={status === k} onClick={() => setStatus(status === k ? '' : k)}>
            <b>{count(k)}</b><span>{w}</span>
          </button>
        ))}
      </div>

      <div className="cpx-two">
        <section className="cpx-card"><div className="cpx-body">
          <h2 className="cpx-h">Posts by day</h2>
          <div className="cpx-meta" style={{ marginBottom: 8 }}>Each dot is one post, on the day it was last sent, answered or posted. Tap a day to see its posts.</div>
          <Calendar month={d.month} posts={d.posts.filter((p) => matches(p, status) && onPlatform(p, platform))} today={d.today} picked={day} onPick={setDay} />
        </div></section>

        <section className="cpx-card"><div className="cpx-body">
          <h2 className="cpx-h">Posts by platform</h2>
          {d.platforms.length === 0 ? <div className="cpx-meta">No post in {monthWords(d.month)} yet, so there is nothing to split by platform.</div> : (
            <div className="cpx-bars">
              {d.platforms.map((x) => (
                <button type="button" key={x.platform} className={`cpx-bar${platform === x.platform ? ' on' : ''}`} aria-pressed={platform === x.platform} onClick={() => setPlatform(platform === x.platform ? '' : x.platform)}>
                  <span className="cpx-bar-top"><span><b className="cpx-bar-ico" aria-hidden="true">{ICON[x.platform] || '●'}</b> {x.word}</span><b>{x.total} post{x.total === 1 ? '' : 's'}</b></span>
                  <span className="cpx-bar-track"><span className="cpx-bar-fill" style={{ width: `${Math.round((x.total / maxPl) * 100)}%` }} /></span>
                  <span className="cpx-meta">{[x.posted ? `${x.posted} posted` : '', x.approved ? `${x.approved} approved` : '', x.waiting ? `${x.waiting} waiting` : '', x.changes ? `${x.changes} changes asked` : ''].filter(Boolean).join(' · ') || 'No answer yet'}</span>
                </button>
              ))}
            </div>
          )}
        </div></section>

        <section className="cpx-card"><div className="cpx-body">
          <h2 className="cpx-h">Your plan</h2>
          {plan ? (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b className="cpx-title" style={{ margin: 0 }}>{plan.label} plan</b><span className={`cpx-chip ${pTone}`}>{pState}</span></div>
              <div className="cpx-meta" style={{ margin: '4px 0 10px' }}>{shortDay(`${plan.startDate}T00:00:00+05:30`)} to {shortDay(`${plan.endDate}T00:00:00+05:30`)} · {plan.months} month{plan.months === 1 ? '' : 's'}{plan.daysLeft >= 0 && plan.state !== 'ended' ? ` · ${plan.daysLeft} day${plan.daysLeft === 1 ? '' : 's'} left` : ''}</div>
              <div className="cpx-meta" style={{ fontWeight: 700, color: '#334155', marginBottom: 4 }}>Done in {monthWords(d.month)}</div>
              {plan.progress.map((x) => (
                <div key={x.item} className="cpx-prog">
                  <div className="cpx-prog-top"><span>{x.label}</span><b>{x.done} of {x.quota}{x.over ? ` (+${x.over} extra)` : ''}</b></div>
                  <div className="cpx-bar-track"><span className="cpx-bar-fill" style={{ width: `${x.pct}%`, background: x.done >= x.quota ? '#15803d' : '#0a74bd' }} /></div>
                </div>
              ))}
              <div className="cpx-meta" style={{ marginTop: 6 }}>These numbers are counted by TeamLink from the work approved for you.</div>
              {plan.includes.length ? (
                <details className="cpx-det"><summary>What your plan includes</summary><ul>{plan.includes.map((t) => <li key={t}>{t}</li>)}</ul></details>
              ) : null}
            </div>
          ) : <div className="cpx-meta">Your plan will show here once TeamLink has added it. Ask your TeamLink contact if you expected to see it already.</div>}
        </div></section>

        <section className="cpx-card"><div className="cpx-body">
          <h2 className="cpx-h">Your social accounts</h2>
          {d.accounts.length === 0 ? <div className="cpx-meta">No account is linked yet. Our team has not linked your Facebook, Instagram or X account.</div> : (
            <div>
              {d.accounts.slice(0, 6).map((a, i) => (
                <div className="cpx-acc" key={`${a.platform}-${a.name}-${i}`}>
                  <span className="cpx-ico" aria-hidden="true">{ICON[a.platform] || '●'}</span>
                  <span className="cpx-acc-main"><b>{a.name}</b><span className="cpx-meta">{a.platformWord}{a.username ? ` · @${a.username.replace(/^@/, '')}` : ''}</span><span className="cpx-meta">{a.posted} posted{a.waiting ? ` · ${a.waiting} waiting` : ''}{a.soon ? ` · ${a.soon} going out` : ''}{a.lastPostedAt ? ` · last post ${shortDay(a.lastPostedAt)}` : ''}</span></span>
                  <span className={`cpx-chip ${a.connected ? 'green' : 'amber'}`}>{a.connected ? 'Connected' : 'Needs attention'}</span>
                </div>
              ))}
              <Link className="cpx-link" to="/client-accounts">See all my accounts ›</Link>
            </div>
          )}
        </div></section>
      </div>

      <section className="cpx-card" style={{ marginTop: 14 }}><div className="cpx-body">
        <div className="cpx-listhead">
          <h2 className="cpx-h" style={{ margin: 0 }}>{day ? dayWords(day) : `Your posts in ${monthWords(d.month)}`}</h2>
          {filtered ? <button type="button" className="cpx-link" onClick={() => { setStatus(''); setPlatform(''); setDay(''); }}>Show all</button> : null}
        </div>
        <div className="cpx-meta" style={{ margin: '2px 0 8px' }}>
          {shown.length} post{shown.length === 1 ? '' : 's'}
          {status ? ` · ${(TILES.find((t) => t[0] === status) || [])[1]}` : ''}{platform ? ` · ${(d.platforms.find((x) => x.platform === platform) || {}).word || platform}` : ''}
        </div>
        {shown.length === 0 ? (
          <div className="cpx-empty">{filtered ? 'No post matches what you picked.' : `No post in ${monthWords(d.month)} yet. When TeamLink has one for you, it shows here and you get an alert.`}</div>
        ) : <div className="cpx-rows">{shown.map((p) => <PostRow key={p.id} p={p} />)}</div>}
      </div></section>

      {d.recent.length > 0 ? (
        <section className="cpx-card" style={{ marginTop: 14 }}><div className="cpx-body">
          <h2 className="cpx-h">Recently posted</h2>
          {d.recent.slice(0, 3).map((r) => <div key={r.id} className="cpx-preview" style={{ margin: '4px 0' }}><b>{r.title}</b><span className="cpx-meta" style={{ display: 'block' }}>{shortDay(r.postedAt)}{r.on.length ? ` · ${r.on.join(', ')}` : ''}</span></div>)}
        </div></section>
      ) : null}
      {!d.postingOn ? <div className="cpx-msg info" style={{ marginTop: 14 }}>Posting by TeamLink is switched off at the moment. Approved posts are posted by our team by hand.</div> : null}
    </div>
  );
}

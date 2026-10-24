import { useEffect, useState } from 'react';
import api from '../../api';
import './omni2.css';

// OMNI-CHANNEL > OVERVIEW (home) and REPORTS. Read only; the server shows only the campaigns / people the login may see.
// Server: GET /api/outreach/overview, /reports, /reports.csv.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');

export function Overview({ acc, go }) {
  const [d, setD] = useState(null);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/outreach/overview').then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'The overview could not be loaded.')));
    api.get('/outreach/me').then((r) => setMe(r.data)).catch(() => setMe(null));
  }, []);
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  if (!d.ready) return <div className="bc-warn" role="status">Omni-Channel is being set up.</div>;
  const t = d.tiles;
  const c = me && me.credits;
  return (
    <div>
      {d.testMode && <div className="bc-warn" role="status"><b>Test mode is ON.</b> Campaign emails are only rehearsed: nothing goes to real people.</div>}
      <div className="oc2-tiles">
        <div className="oc2-tile"><b>{t.contacts}</b><span>People in your contacts</span></div>
        <div className="oc2-tile"><b>{t.running}</b><span>Campaigns running now</span></div>
        <div className="oc2-tile"><b>{t.notSentYet}</b><span>Campaigns not sent yet</span></div>
        <div className="oc2-tile g"><b>{t.sentToday}</b><span>Messages sent today</span></div>
        <div className="oc2-tile"><b>{t.rehearsedToday}</b><span>Rehearsed today (not real)</span></div>
        <div className={`oc2-tile ${t.failedToday ? 'r' : ''}`}><b>{t.failedToday}</b><span>Failed today</span></div>
        <div className="oc2-tile"><b>{t.waiting}</b><span>Waiting to go out</span></div>
        <div className={`oc2-tile ${t.unreadReplies ? 'o' : ''}`}><b>{t.unreadReplies}</b><span>Replies not read yet</span></div>
        {c && <div className="oc2-tile"><b>{c.exempt ? 'No limit' : c.left}</b><span>{c.exempt ? 'Your credits' : `Credits left of ${c.allowance}`}</span></div>}
      </div>
      <div className="oc-row2">
        {go && acc.seesLeads && <button type="button" className="btn btn-primary" onClick={() => go('campaigns')}>Open campaigns</button>}
        {go && <button type="button" className="btn" onClick={() => go('inbox')}>Open Responses</button>}
      </div>
      <h4 style={{ margin: '14px 0 6px' }}>Things that went wrong</h4>
      {d.problems.length === 0 && <div className="oc-note">Nothing has failed. Good.</div>}
      {d.problems.length > 0 && (
        <div className="oc-scroll"><table className="oc2-table"><thead><tr><th>Campaign</th><th>Way</th><th>What happened</th><th>When</th></tr></thead>
          <tbody>{d.problems.map((p, i) => <tr key={i}><td className="name">{p.campaign}</td><td>{p.channel}</td><td>{p.why}</td><td>{fmt(p.at)}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

const ROLL_HEAD = ['Campaigns', 'People', 'Sent', 'Delivered', 'Clicked', 'Applied', 'Failed'];
function Roll({ title, rows }) {
  return (
    <div style={{ marginTop: 14 }}>
      <h4 style={{ margin: '0 0 6px' }}>{title}</h4>
      <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>Name</th>{ROLL_HEAD.map((h) => <th key={h} className="num">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.name}><td className="name">{r.name}</td><td className="num">{r.campaigns}</td><td className="num">{r.total}</td><td className="num">{r.sent}</td><td className="num">{r.delivered}</td><td className="num">{r.clicked}</td><td className="num">{r.applied}</td><td className="num">{r.failed}</td></tr>)}</tbody></table></div>
    </div>
  );
}

export function Reports({ acc }) {
  const [days, setDays] = useState('30');
  const [d, setD] = useState(null);
  const [fn, setFn] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/outreach/insights/funnel', { params: { days } }).then((r) => setFn(r.data)).catch(() => setFn(null)); }, [days]);
  useEffect(() => { setD(null); api.get('/outreach/reports', { params: { days } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The report could not be loaded.'))); }, [days]);
  const csv = async () => {
    try { const r = await api.get('/outreach/reports.csv', { params: { days }, responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'omni-report.csv'; a.click(); } catch (e) { setErr('The file could not be made. You may not be allowed to download it.'); }
  };
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  if (!d.ready) return <div className="bc-warn" role="status">Campaigns are being set up.</div>;
  const t = d.totals;
  return (
    <div>
      <div className="oc-bar">
        <div className="oc2-chips" role="group" aria-label="Period">{[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, l]) => <button type="button" key={v} className={`oc2-chip${days === v ? ' on' : ''}`} aria-pressed={days === v} onClick={() => setDays(v)}>{l}</button>)}</div>
        {acc.canExportLog && <button type="button" className="btn" onClick={csv}>Download CSV</button>}
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      <div className="oc2-tiles">
        <div className="oc2-tile"><b>{t.campaigns}</b><span>Campaigns</span></div>
        <div className="oc2-tile"><b>{t.sent || 0}</b><span>Sent</span></div>
        <div className="oc2-tile g"><b>{t.delivered || 0}</b><span>Delivered</span></div>
        <div className="oc2-tile"><b>{t.clicked || 0}</b><span>Opened the apply link</span></div>
        <div className="oc2-tile g"><b>{t.applied || 0}</b><span>Applied</span></div>
        <div className={`oc2-tile ${t.failed ? 'r' : ''}`}><b>{t.failed || 0}</b><span>Failed</span></div>
      </div>
      <div className="oc-note">{d.note}</div>
      {fn && fn.ready && (
        <div style={{ marginTop: 14 }}>
          <h4 style={{ margin: '0 0 6px' }}>Conversion funnel (campaigns of the last {fn.days} days)</h4>
          <div className="oc2-funnel">{fn.steps.map((x, i) => <div key={x.label} className="oc2-fstep" style={{ '--w': `${Math.max(8, fn.steps[0].n ? Math.round((x.n / fn.steps[0].n) * 100) : 8)}%` }}><span>{i + 1}. {x.label}</span><b>{x.n}</b></div>)}</div>
          <div className="oc-note">Applied, interview and joined are counted only for people we can match by phone or email to a candidate who applied to the same requirement after the campaign started.</div>
          <h4 style={{ margin: '12px 0 6px' }}>Joining report</h4>
          {fn.joinings.length === 0 ? <div className="oc-note">No joining can be linked to a campaign yet.</div> : <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>Campaign</th><th>Started by</th><th className="num">Joined</th><th>Who</th></tr></thead><tbody>{fn.joinings.map((j) => <tr key={j.campaign}><td className="name">{j.campaign}</td><td>{j.owner}</td><td className="num">{j.joined}</td><td>{j.names.join(', ')}</td></tr>)}</tbody></table></div>}
        </div>
      )}
      <Roll title="Campaign report: by campaign" rows={d.campaigns.map((c) => ({ name: `${c.name} (${c.channel}, ${c.status})`, campaigns: 1, total: c.total, sent: c.sent, delivered: c.delivered, clicked: c.clicked, applied: c.applied, failed: c.failed }))} />
      <Roll title="By way (channel)" rows={d.byChannel} />
      <Roll title="Recruiter report: by person who started them" rows={d.byPerson} />
      {d.byDay.length > 0 && (
        <div style={{ marginTop: 14 }}><h4 style={{ margin: '0 0 6px' }}>Messages sent each day</h4>
          <div className="oc-scroll"><table className="oc2-table"><thead><tr><th>Day</th><th className="num">Sent</th></tr></thead><tbody>{d.byDay.map((x) => <tr key={x.day}><td>{x.day}</td><td className="num">{x.sent}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

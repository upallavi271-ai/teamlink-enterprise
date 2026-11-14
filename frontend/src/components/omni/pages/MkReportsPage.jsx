import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Banner, Kpi, Kpis, fmtNum } from '../ui.jsx';
import '../marketing/marketing.css';

// AI MARKETING > REPORTS: plain numbers for a date range (India time) from what the other AI Marketing screens already store, with a CSV download.
// Server: marketing/reports.js. Read only.
const RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Pick dates']];
const PLAT = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', rcs: 'RCS' };
const TASK = { 'content/draft': 'AI Content: write versions', 'content/revise': 'AI Content: rewrite', 'calendar/plan': 'Calendar: plan a week', 'images/create': 'AI Images: make pictures', 'clips/create': 'AI clips: make a clip' };
const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const hrs = (h) => (h == null ? '—' : h < 1 ? 'under 1 hour' : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

function Table({ head, rows, empty }) {
  if (!rows.length) return <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '8px 0' }}>{empty}</div>;
  return (
    <div className="table-scroll">
      <table className="mk-table">
        <thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} className={i ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export default function MkReportsPage() {
  const { toast } = useOmni();
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const params = range === 'custom' ? { range, from, to } : { range };
  const load = useCallback(() => {
    setErr('');
    omni.get('/gs/marketing/reports', range === 'custom' ? { range, from, to } : { range }).then(setD).catch((e) => setErr(errOf(e, 'The report could not be made.')));
  }, [range, from, to]);
  useEffect(() => { if (range !== 'custom' || (from && to && from <= to)) load(); }, [load, range, from, to]);
  const csv = async () => {
    setBusy(true);
    try {
      const b = await omni.blob('/gs/marketing/reports/csv', params);
      const url = URL.createObjectURL(b); const a = document.createElement('a'); a.href = url; a.download = `ai-marketing-report-${d ? `${d.range.from}-to-${d.range.to}` : 'report'}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(errOf(e, 'The CSV could not be made.')); } finally { setBusy(false); }
  };

  const c = d && d.content; const m = d && d.media; const cal = d && d.calendar; const cl = d && d.clients;
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Reports" lead="Plain numbers for the dates you pick: what was written, made, approved, posted and answered by clients, and how much AI was used.">
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {range === 'custom' ? <><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} aria-label="To" /></> : null}
        <Btn disabled={busy || !d} onClick={csv}>{busy ? 'Making…' : '⬇ Download CSV'}</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner> : null}
      {!d && !err ? <div className="card panel">Loading…</div> : null}
      {d ? (
        <>
          <Banner tone="info">{d.range.from} to {d.range.to} ({d.range.days} day{d.range.days === 1 ? '' : 's'}){d.scope === 'all' ? '' : ' · your departments only'}. Counts use each item&apos;s current status.</Banner>
          <Kpis>
            <Kpi label="Words approved" icon="✔" value={fmtNum(c.approved)} meta={`${fmtNum(c.created)} written`} tone="good" />
            <Kpi label="Pictures and videos" icon="◩" value={fmtNum(m.aiPictures + m.uploadedPictures + m.videosMade + m.clipsUploaded + m.clipsMadeByAi)} meta={`${fmtNum(m.approved)} approved`} />
            <Kpi label="Posts posted" icon="➤" value={fmtNum(cal.posted)} meta={`of ${fmtNum(cal.planned)} planned`} />
            <Kpi label="Posts overdue" icon="⚠" value={fmtNum(cal.overdue)} meta="Time passed, not posted" tone={cal.overdue ? 'down' : undefined} />
            <Kpi label="Client approvals" icon="👥" value={fmtNum(cl.approved)} meta={`${fmtNum(cl.sent)} sent · ${fmtNum(cl.waiting)} waiting`} />
            <Kpi label="AI requests" icon="✧" value={fmtNum(d.ai.requests)} meta={`${fmtNum(d.ai.failed)} failed`} />
          </Kpis>
          <div className="mk-two" style={{ marginTop: 14 }}>
            <Panel title="AI Content (words)" sub="Written in this period">
              <Table head={['', 'Number']} empty="Nothing written in these dates." rows={c.created || c.waiting ? [['Written', fmtNum(c.created)], ['Waiting for approval', fmtNum(c.waiting)], ['Approved', fmtNum(c.approved)], ['Sent back', fmtNum(c.sentBack)], ['Average time to approve', hrs(c.avgApprovalHours)]] : []} />
              {c.byChannel.length ? <div style={{ marginTop: 10 }}><Table head={['Channel', 'Items']} rows={c.byChannel.map((x) => [PLAT[x.key] || x.key, fmtNum(x.n)])} empty="" /></div> : null}
            </Panel>
            <Panel title="Pictures and videos" sub="Made or uploaded in this period">
              <Table head={['', 'Number']} empty="" rows={[['AI pictures made', fmtNum(m.aiPictures)], ['Your own pictures uploaded', fmtNum(m.uploadedPictures)], ['Videos made', fmtNum(m.videosMade)], ['Video clips uploaded', fmtNum(m.clipsUploaded)], ['Clips made by AI', fmtNum(m.clipsMadeByAi)], ['Approved', fmtNum(m.approved)], ['Waiting for approval', fmtNum(m.waiting)], ['Sent back', fmtNum(m.sentBack)]]} />
            </Panel>
          </div>
          <div className="mk-two" style={{ marginTop: 14 }}>
            <Panel title="Content Calendar" sub="Posts planned for these dates">
              <Table head={['', 'Number']} empty="" rows={[['Planned', fmtNum(cal.planned)], ['Posted', fmtNum(cal.posted)], ['Posted more than 3 hours late', fmtNum(cal.postedLate)], ['Skipped', fmtNum(cal.skipped)], ['Overdue', fmtNum(cal.overdue)], ['Still to come', fmtNum(cal.upcoming)]]} />
              {d.byPlatform.length ? <div style={{ marginTop: 10 }}><Table head={['Platform', 'Posted', 'Planned']} rows={d.byPlatform.map((x) => [PLAT[x.key] || x.key, fmtNum(x.posted), fmtNum(x.total)])} empty="" /></div> : null}
            </Panel>
            <Panel title="Client approvals" sub="Sent to clients in this period">
              <Table head={['', 'Number']} empty="" rows={[['Sent', fmtNum(cl.sent)], ['Approved', fmtNum(cl.approved)], ['Changes asked', fmtNum(cl.changes)], ['Waiting', fmtNum(cl.waiting)], ['Link expired', fmtNum(cl.expired)], ['Average time to answer', hrs(cl.avgResponseHours)]]} />
            </Panel>
          </div>
          <div className="mk-two" style={{ marginTop: 14 }}>
            <Panel title="AI use" sub={d.scope === 'all' ? 'Everybody' : 'Your own requests'}>
              <Table head={['What it was for', 'Requests']} empty="No AI requests in these dates." rows={d.ai.byTask.map((x) => [TASK[x.task] || x.task, fmtNum(x.n)])} />
            </Panel>
            <Panel title="People" sub="Who made the most (up to 10)">
              <Table head={['Person', 'Words', 'Pictures', 'Videos', 'Posts']} empty="Nothing made in these dates." rows={d.people.map((p) => [p.name, fmtNum(p.content), fmtNum(p.pictures), fmtNum(p.videos), fmtNum(p.posts)])} />
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
}

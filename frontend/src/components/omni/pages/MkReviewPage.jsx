import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Kpi, Kpis, Panel, Banner, fmtNum } from '../ui.jsx';

// AI MARKETING > REVIEW AND PUBLISH (2026-11-16, simple like Green Start): what needs a person now, in one list, each with the button that opens the right screen: approve what the team
// made, read what clients answered, accept new requests, post what is ready. Numbers come from GET /gs/marketing/overview (the same ones the tab shows as "(N)").
export default function MkReviewPage() {
  const { acc, go } = useOmni();
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); omni.get('/gs/marketing/overview').then(setOv).catch((e) => setErr(errOf(e, 'The numbers could not be read.'))); };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !ov) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!ov) return <div className="card panel">Loading…</div>;
  const have = new Set((acc && Array.isArray(acc.pages) ? acc.pages : []));
  const at = ov.attention || {}; const pj = ov.projects || {};
  const review = (at.words || 0) + (at.pictures || 0);
  const publish = (at.overdue || 0) + (at.today || 0) + (pj.toPost || 0);
  // [number, words, page, button, urgent]; a row is shown only when it has something to do AND this login may open its screen
  const rows = [
    [review, 'made by your team, waiting for your approval', 'mkapprove', 'Review', true],
    [pj.newRequests, 'new client request(s) to accept or decline', 'mkprojects', 'Open Clients', true],
    [at.clientChanges, 'client answer(s) asking for changes (last 14 days)', 'mkreplies', 'Read the answers', true],
    [at.overdue, 'calendar post(s) overdue: the time passed and it is not posted', 'mkcalendar', 'Open the calendar', true],
    [at.today, 'calendar post(s) due today', 'mkcalendar', 'Open the calendar', false],
    [pj.toPost, 'approved project(s) ready to post', 'mkprojects', 'Open Clients', false],
  ].filter((r) => r[0] > 0 && have.has(r[2]));
  const waiting = (at.clientWaiting || 0) + (pj.withClient || 0);
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Review and publish" lead="What needs a person now: approve, answer, post. Nothing is posted or sent for you without a click.">
        {have.has('mkapprove') && <Btn onClick={() => go('mkapprove')}>✔ All approvals</Btn>}
        {have.has('mkcalendar') && <Btn onClick={() => go('mkcalendar')}>▦ Calendar</Btn>}
        {have.has('mkreports') && <Btn onClick={() => go('mkreports')}>▤ Numbers</Btn>}
      </PageHead>
      <Kpis>
        <Kpi label="To review" icon="✔" value={fmtNum(review)} meta={review > 0 ? 'Waiting for your approval' : 'Nothing waits for you'} tone={review > 0 ? 'warn' : 'neutral'} onClick={have.has('mkapprove') ? () => go('mkapprove') : undefined} />
        <Kpi label="To publish" icon="▦" value={fmtNum(publish)} meta="Due, overdue or ready to post" tone={publish > 0 ? 'warn' : 'neutral'} onClick={have.has('mkcalendar') ? () => go('mkcalendar') : undefined} />
        <Kpi label="With clients" icon="❝" value={fmtNum(waiting)} meta="Waiting for a client to answer" onClick={have.has('mkreplies') ? () => go('mkreplies') : undefined} />
      </Kpis>
      <Panel title={`To do${ov.todo > 0 ? ` (${ov.todo})` : ''}`} sub={rows.length ? 'Start at the top' : undefined} style={{ marginTop: 14 }} right={<Btn small onClick={load}>Refresh</Btn>}>
        {rows.length === 0 ? <div style={{ fontSize: 12, color: '#166534', fontWeight: 700, padding: '4px 0' }}>✓ All clear: nothing is waiting for you.</div> : (
          <ul className="mk-steps">
            {rows.map(([n, words, page, label, hot]) => (
              <li key={words}><span className={`dot${hot ? '' : ' done'}`} style={hot ? { background: '#f59e0b', borderColor: '#f59e0b', color: '#fff' } : undefined}>{n}</span><span style={{ flex: 1 }}><b>{n}</b> {words}</span><Btn small primary={hot} onClick={() => go(page)}>{label}</Btn></li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

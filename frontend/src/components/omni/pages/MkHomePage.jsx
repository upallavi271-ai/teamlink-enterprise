import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Kpi, Kpis, Panel, Banner, fmtNum } from '../ui.jsx';
import { useMkMeta, AiBanner } from '../marketing/mk.jsx';

// AI MARKETING > OVERVIEW: what needs this login's attention right now (approvals, overdue posts, client answers), quick starts, the next steps and the modules of the
// AI Marketing OS (live ones open; planned ones say so).
export default function MkHomePage() {
  const { go } = useOmni();
  const { meta, err } = useMkMeta();
  const [ov, setOv] = useState(null);
  const [ovErr, setOvErr] = useState('');
  // a failed read is shown as a failure, never as a page of zeros
  const loadOv = () => { setOvErr(''); omni.get('/gs/marketing/overview').then(setOv).catch((e) => setOvErr(errOf(e, 'The AI Marketing numbers could not be read.'))); };
  useEffect(loadOv, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <Banner tone="error">{err}</Banner>;
  if (ovErr && !ov) return <Banner tone="error">{ovErr} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={loadOv}>Try again</button></Banner>;
  if (!meta || !ov) return <div className="card panel">Loading…</div>;
  const c = ov.counts || {}; const u = ov.usage || {};
  const at = ov.attention || {}; const have = ov.have || {};
  // THREE LOOKS (the server decides who is which: outreach/access.js): an Admin sees everything and the settings, a Marketing login sees its working tools, an approver sees what waits for them
  const look = meta.isAdmin ? 'admin' : (meta.canWrite ? 'team' : 'approver');
  const LOOK = { admin: 'Admin view', team: 'Marketing team', approver: 'Approver' }[look];
  const steps = [
    look === 'admin' && ['Check who sees what, the AI limits and who approves (AI usage)', false, 'mkusage', 'Open AI usage'],
    meta.canWrite && ['Set up your brand kit, so the AI writes and draws like your company', ov.brandReady, 'mkbrand', ov.brandReady ? 'Change' : 'Set it up'],
    meta.canWrite && ['Get it approved: only approved work is used', (c.approved || 0) > 0, 'mkapprove', 'Approvals'],
    meta.canWrite && ['Make or upload a picture', !!have.pictures, 'mkimages', 'AI Images'],
    meta.canWrite && ['Join pictures and clips into a video', !!have.videos, 'mkvideos', 'AI Video'],
    !meta.canWrite && ['Approve or send back what your team wrote', (c.waitingForMe || 0) === 0, 'mkapprove', 'Open approvals'],
  ].filter(Boolean);
  // what needs THIS login now: nothing here is shown when it is zero
  const todo = [
    [(at.words || 0) + (at.pictures || 0), 'waiting for your approval', 'mkapprove', 'Open approvals', true],
    [at.clientChanges, 'client answer asking for changes (last 14 days)', 'mkapprove', 'See the answers', true],
    [at.clientWaiting, 'waiting for a client to answer', 'mkapprove', 'See them', false],
  ].filter((x) => x[0] > 0);
  return (
    <div>
      <PageHead eyebrow={`AI Marketing · ${LOOK}`} title="AI Marketing">
        {meta.canWrite && <Btn onClick={() => go('mkimages')}>◩ Make a picture</Btn>}
      </PageHead>
      <AiBanner ai={meta.ai} />
      <Panel title="Needs your attention" style={{ marginBottom: 14 }} right={<Btn small onClick={loadOv}>Refresh</Btn>}>
        {todo.length === 0 ? <div style={{ fontSize: 12, color: '#166534', fontWeight: 700, padding: '4px 0' }}>✓ All clear: nothing is waiting for you.</div> : (
          <ul className="mk-steps">
            {todo.map(([n, words, page, label, hot]) => (
              <li key={words}><span className={`dot${hot ? '' : ' done'}`} style={hot ? { background: '#f59e0b', borderColor: '#f59e0b', color: '#fff' } : undefined}>{n}</span><span style={{ flex: 1 }}><b>{n}</b> {words}</span><Btn small primary={hot} onClick={() => go(page)}>{label}</Btn></li>
            ))}
          </ul>
        )}
      </Panel>
      <Kpis>
        <Kpi label="Waiting for approval" icon="⏳" value={fmtNum(c.waiting || 0)} meta={(c.waitingForMe || 0) > 0 ? `${c.waitingForMe} waiting for you` : 'Nothing waits for you'} tone={(c.waitingForMe || 0) > 0 ? 'warn' : 'neutral'} onClick={() => go('mkapprove')} />
        <Kpi label="Approved this month" icon="✔" value={fmtNum(c.approvedThisMonth || 0)} meta={`${fmtNum(c.approved || 0)} approved in all`} tone="good" />
        {meta.canWrite && <Kpi label="AI requests this month" icon="✧" value={fmtNum(u.month || 0)} meta={`${fmtNum(u.today || 0)} today`} onClick={() => go('mkusage')} />}
      </Kpis>
      <Panel title="Your next step" sub={ov.brandReady ? `Brand voice: ${ov.brandName}` : 'The brand voice is not set yet'} style={{ marginTop: 14 }}>
        <ul className="mk-steps">
          {steps.map(([words, done, page, label]) => (
            <li key={words}><span className={`dot${done ? ' done' : ''}`}>{done ? '✓' : ''}</span><span style={{ flex: 1 }}>{words}</span><Btn small onClick={() => go(page)}>{label}</Btn></li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

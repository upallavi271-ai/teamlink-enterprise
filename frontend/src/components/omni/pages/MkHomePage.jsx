import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Kpi, Kpis, Panel, Pill, Banner, fmtNum } from '../ui.jsx';
import { useMkMeta, AiBanner } from '../marketing/mk.jsx';

// AI MARKETING > OVERVIEW: the six modules of the AI Marketing OS (Phase 1 = AI Content is live), what is waiting, and the next step for this login.
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
  const started = (c.draft || 0) + (c.waiting || 0) + (c.changes || 0) + (c.approved || 0) > 0;
  const steps = [
    meta.canWrite && ['Set up your brand voice, so the AI writes like your company', ov.brandReady, 'mkbrand', ov.brandReady ? 'Change' : 'Set it up'],
    meta.canWrite && ['Write your first message with AI', started, 'mkcontent', 'Write'],
    meta.canWrite && ['Get it approved: only approved words reach the Content Library and campaigns', (c.approved || 0) > 0, 'mkapprove', 'Approvals'],
    !meta.canWrite && ['Approve or send back what your team wrote', (c.waitingForMe || 0) === 0, 'mkapprove', 'Open approvals'],
  ].filter(Boolean);
  return (
    <div>
      <PageHead eyebrow="AI Marketing OS" title="AI Marketing" lead="The AI Marketing modules, built one phase at a time. Nothing is sent, posted or spent by AI Marketing without a person's approval.">
        {meta.canWrite && <Btn primary onClick={() => go('mkcontent')}>✦ Write with AI</Btn>}
      </PageHead>
      <AiBanner ai={meta.ai} />
      <Kpis>
        {meta.canWrite && <Kpi label="Saved" icon="✎" value={fmtNum(c.draft || 0)} meta="Not sent for approval" onClick={() => go('mkcontent')} />}
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
      <div className="panel-title" style={{ margin: '18px 0 8px' }}>The modules</div>
      <div className="mk-mods">
        {meta.modules.map((m) => (
          <div key={m.id} className={`card mk-mod${m.status === 'live' ? ' live' : ''}`}>
            <div className="mk-mod-top"><span className="mk-mod-no">{m.no}</span>{m.status === 'live' ? <Pill tone="live" dot>Live now</Pill> : <Pill tone="draft">Planned · Phase {m.phase}</Pill>}</div>
            <h3>{m.label}</h3>
            <p>{m.blurb}</p>
            {m.canOpen ? <div><Btn small primary onClick={() => go(m.page)}>Open</Btn></div> : <div style={{ fontSize: 10, color: 'var(--muted)' }}>{m.status === 'live' ? 'Not open for your login.' : 'Not built yet: nothing here is faked.'}</div>}
          </div>
        ))}
      </div>
      <Panel title="On the menu for later" sub="The other modules of the AI Marketing OS list. They are not built: the shared AI layer, approval, audit and roles are made so each can be added." style={{ marginTop: 18 }}>
        <div className="mk-chips">{meta.later.map((n) => <span className="mk-chip" key={n}>{n}</span>)}</div>
      </Panel>
    </div>
  );
}

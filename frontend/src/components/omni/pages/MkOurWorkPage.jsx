import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Banner, Field, Empty, GsModal, Pill, Tag, fmtDate } from '../ui.jsx';
import OurWork from '../marketing/OurWork.jsx';
import '../marketing/marketing.css';

// AI MARKETING > OUR WORK: the track record and finished projects that CLIENTS see (on their own page and on the public "Our work" link), shown here inside TeamLink so the team
// sees exactly what a client sees, and decides which finished projects are shown. Only projects marked "the client agrees we show this work" appear; the numbers name nobody.
// Server: marketing/projects.js (trackRecord, showcaseItems, setShowcase). The same block is OurWork.jsx.
export default function MkOurWorkPage() {
  const { toast, go } = useOmni();
  const [projects, setProjects] = useState(null);
  const [ver, setVer] = useState(0); // remounts the preview after a change
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState(null); // the project being added: { p, consent, showName, title }
  const [busy, setBusy] = useState('');
  const load = useCallback(() => omni.get('/gs/marketing/projects').then((d) => { setProjects((d.projects || []).filter((x) => ['approved', 'posted'].includes(x.status))); setErr(''); }).catch((e) => setErr(errOf(e, 'The projects could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  const post = async (p, body, okWords) => {
    setBusy(p.id); setErr('');
    try { const r = await omni.post(`/gs/marketing/projects/${p.id}/showcase`, body); toast(r.ok || okWords); setAsk(null); setVer((v) => v + 1); await load(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const copy = async () => { const u = `${window.location.origin}/our-work`; try { await navigator.clipboard.writeText(u); toast('Link copied: send it to a new client'); } catch { window.prompt('Copy the link:', u); } };
  if (err && !projects) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!projects) return <div className="card panel">Loading…</div>;
  const shown = projects.filter((p) => p.showcase); const rest = projects.filter((p) => !p.showcase);
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Our work" lead="Our track record and finished projects. Clients see the same thing on their own page, so a new client can see how fast and how accurate we are before giving us a project.">
        <Btn onClick={copy} title="A public page you can send to any new client">🌐 Copy the public link</Btn>
        <Btn onClick={() => window.open('/our-work', '_blank', 'noopener')}>See it as a client ↗</Btn>
      </PageHead>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <Panel title="What clients see" sub="The numbers cover every finished project and name nobody. A percentage appears once 3 projects stand behind it.">
        <div style={{ background: '#f4f6f5', borderRadius: 12, padding: '16px 12px' }}>
          <OurWork key={ver} title="Our work" />
          {!projects.length ? <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '12px 0' }}>Nothing to show yet. When a client approves their first project, the numbers start here.</div> : null}
        </div>
      </Panel>
      <Panel title="Finished projects" sub="Projects a client approved. Add the ones the client agrees we may show; they appear above and on the clients' pages." style={{ marginTop: 14 }} right={<span className="pill live">{projects.length}</span>}>
        {projects.length === 0 ? <Empty title="No approved projects yet" action={<Btn primary onClick={() => go('mkprojects')}>Open Client projects</Btn>}>Projects appear here after the client chooses an option.</Empty> : [...shown, ...rest].map((p) => (
          <div className="mk-row" key={p.id}>
            <div>
              <b>{p.title}</b> {p.showcase ? <Pill tone="live" dot>In our portfolio</Pill> : <Tag>Not shown</Tag>} {p.status === 'posted' ? <Tag green>Posted</Tag> : <Tag>Approved, not posted yet</Tag>}
              <small>{p.clientName} · {p.occasion || 'project'} · approved by {p.decidedByName || 'the client'} {p.decidedAt ? fmtDate(p.decidedAt) : ''}{p.showcase ? ` · shown as “${p.showcaseTitle || p.occasion}”${p.showcaseClient ? ' with the client\'s name' : ', without the client\'s name'}` : ''}</small>
            </div>
            <div className="mk-acts">
              {p.showcase ? <TinyBtn disabled={busy === p.id} onClick={() => post(p, { show: false }, 'Taken out')}>Take it out</TinyBtn> : <Btn small primary disabled={!!busy} onClick={() => setAsk({ p, consent: false, showName: false, title: p.occasion || p.title })}>Add to our work</Btn>}
              <TinyBtn onClick={() => go('mkprojects', { open: p.id })}>Open project</TinyBtn>
            </div>
          </div>
        ))}
      </Panel>
      {ask ? (
        <GsModal title={`Show "${ask.p.title}" to other clients`} sub="Real finished work builds trust. Only do it when the client agrees." width={500} onClose={() => setAsk(null)}
          foot={<><Btn onClick={() => setAsk(null)}>Cancel</Btn><Btn primary disabled={!ask.consent || busy === ask.p.id} onClick={() => post(ask.p, { show: true, consent: true, showName: ask.showName, title: ask.title }, 'Added')}>Add to our work</Btn></>}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5 }}><input type="checkbox" style={{ marginTop: 3 }} checked={ask.consent} onChange={(e) => setAsk({ ...ask, consent: e.target.checked })} />The client agrees that we may show this work to other clients.</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '10px 0' }}><input type="checkbox" checked={ask.showName} onChange={(e) => setAsk({ ...ask, showName: e.target.checked })} />Also show the client's name ({ask.p.clientName}). Otherwise it says “A client”.</label>
          <Field label="HOW IT IS TITLED" full><input value={ask.title} maxLength={80} onChange={(e) => setAsk({ ...ask, title: e.target.value })} placeholder="For example: Diwali offer for a software company" /></Field>
        </GsModal>
      ) : null}
    </div>
  );
}

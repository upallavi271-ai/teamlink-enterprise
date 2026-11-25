import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Tag, Banner, Field, Tabs, Empty, Kpi, Kpis, fmtDate } from '../ui.jsx';
import { CopyBox, Chips, TrendChart, sign } from './MkSeoParts.jsx';
import { KeywordsTab, ContentTab, CompetitorsTab, DashboardExtras } from './MkSeoTools.jsx';

// AI MARKETING > SEO ASSISTANT (2026-11-25): the owner's AI SEO Assistant, built on what the SEO & visibility tools already measure.
//   Dashboard        the health score of every client's website and its change, one site in full (trend, marks, technical findings, performance, progress feed), what to do first
//   Recommendations  every finding of the audits as a task, by impact and effort, with ready-to-use text where TeamLink can write it from the client's real facts; the next audit confirms a fix
//   Site and schedule  the client's website, the real facts the writers use, competitors, and how often TeamLink audits the site by itself
// HONEST BY DESIGN: the score is TeamLink's own check of what is on the pages, never a ranking; TeamLink never edits a client's website (the web person pastes the text); nothing is invented.
const STATUS = { open: ['warn', 'To do'], done: ['scheduled', 'Done, waiting for the next audit'], verified: ['live', 'Fixed (confirmed by an audit)'], skipped: ['draft', 'Skipped'] };
const blankFacts = { name: '', city: '', state: '', areas: '', services: '', specialty: '', phone: '', email: '', address: '', hours: '', audience: '', since: '' };
const nextWords = (s) => (s.schedule === 'off' ? 'Not scheduled' : s.nextRunAt ? fmtDate(s.nextRunAt) : '—');

export default function MkSeoPage() {
  const { toast } = useOmni();
  const [tab, setTab] = useState('dashboard'); const [ov, setOv] = useState(null); const [siteId, setSiteId] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [adding, setAdding] = useState(false);
  const load = useCallback(async (id) => {
    try { const d = await omni.get('/gs/marketing/seo/overview', id ? { siteId: id } : {}); setOv(d); setErr(''); if (!id && d.sites.length) setSiteId(d.sites[0].id); } catch (e) { setErr(errOf(e, 'The SEO assistant could not be opened.')); }
  }, []);
  useEffect(() => { load(siteId); }, [siteId, load]);
  useEffect(() => { if (tab === 'dashboard' && siteId) load(siteId); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps -- coming back to the dashboard shows what the other tabs just changed
  if (err && !ov) return <Banner tone="error">{err}</Banner>;
  if (!ov) return <div className="card panel">Loading…</div>;
  const site = ov.site; const none = !ov.sites.length;
  const audit = async () => {
    setBusy(true);
    try { const r = await omni.post(`/gs/marketing/seo/sites/${siteId}/audit`, {}, { timeout: 150000 }); toast(`Audit done: ${r.score} out of 100${r.delta != null ? ` (${r.delta === 0 ? 'no change' : sign(r.delta)})` : ''}. ${r.tasks.created} new, ${r.tasks.verified} fixed, ${r.tasks.reopened} came back.`); await load(siteId); } catch (e) { toast(errOf(e, 'The audit could not be run.')); } finally { setBusy(false); }
  };
  const pick = (id, to) => { setAdding(false); setSiteId(id); if (to) setTab(to); };
  const saved = async (id) => { setAdding(false); setTab('dashboard'); if (id === siteId) await load(id); else setSiteId(id); };
  const tabs = [['dashboard', 'Dashboard'], ['tasks', 'Recommendations', site ? site.tasks.open : undefined], ['keywords', 'Keywords'], ['content', 'Content'], ['competitors', 'Competitors'], ['site', 'Site and schedule']];
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="SEO assistant" lead="Audit a client's website, see what to fix first, and get ready-to-use text for each fix. TeamLink checks again later and confirms what was fixed. Nothing is posted and no website is changed." />
      <Banner>{ov.honest}</Banner>
      {!none ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
          <select aria-label="Client website" value={adding ? '' : siteId} onChange={(e) => pick(e.target.value)} style={{ minWidth: 240 }}>{adding ? <option value="">New website</option> : null}{ov.sites.map((s) => <option key={s.id} value={s.id}>{s.clientName} ({s.score != null ? `${s.score}/100` : 'not audited'})</option>)}</select>
          <Btn primary disabled={busy || adding || !siteId} onClick={audit}>{busy ? 'Auditing…' : 'Audit now'}</Btn>
          <Btn onClick={() => { setAdding(true); setTab('site'); }}>＋ Add a client website</Btn>
          {busy ? <span style={{ fontSize: 12.5 }}>Reading the website. It takes about 15 to 60 seconds: please wait here.</span> : null}
        </div>
      ) : null}
      {!none || adding ? <Tabs value={tab} onChange={setTab} tabs={tabs} /> : null}
      <div style={{ marginTop: 14 }}>
        {none && !adding ? <Empty title="No client website yet" action={<Btn primary onClick={() => { setAdding(true); setTab('site'); }}>Add the first client website</Btn>}>Add a client's website, its real facts and how often to audit it. TeamLink then audits it, lists what to fix and writes the ready-to-use text.</Empty> : null}
        {(!none || adding) && tab === 'dashboard' && !adding ? <DashboardTab ov={ov} site={site} onOpen={pick} audit={audit} busy={busy} toast={toast} /> : null}
        {(!none || adding) && tab === 'tasks' && !adding && site ? <TasksTab key={site.id} site={site} toast={toast} onChanged={() => load(siteId)} /> : null}
        {(!none && !adding && site && tab === 'keywords') ? <KeywordsTab key={`k${site.id}`} site={site} toast={toast} /> : null}
        {(!none && !adding && site && tab === 'content') ? <ContentTab key={`c${site.id}`} site={site} toast={toast} /> : null}
        {(!none && !adding && site && tab === 'competitors') ? <CompetitorsTab key={`p${site.id}`} site={site} toast={toast} /> : null}
        {(adding || (!none && tab === 'site')) ? <SiteTab key={adding ? 'new' : siteId} site={adding ? null : site} industries={ov.industries || []} toast={toast} onSaved={saved} onRemoved={() => { setSiteId(''); setAdding(false); setOv(null); load(''); }} /> : null}
      </div>
    </div>
  );
}

// ---- DASHBOARD -----------------------------------------------------------------------------------------------------------------------------------------------------------
function DashboardTab({ ov, site, onOpen, audit, busy, toast }) {
  const t = ov.totals;
  return (
    <div>
      <Kpis>
        <Kpi label="Websites" icon="⌕" value={t.sites} meta={`${t.audited} audited${t.neverAudited ? `, ${t.neverAudited} not yet` : ''}`} />
        <Kpi label="Average score" icon="◈" value={t.average != null ? `${t.average}/100` : '—'} meta={t.audited ? 'of the audited websites' : 'no audit yet'} />
        <Kpi label="Open recommendations" icon="✔" value={t.open} meta={`${t.openHigh} high impact`} tone={t.openHigh ? 'down' : 'flat'} />
        <Kpi label="Fixed and confirmed" icon="✓" value={t.verified} meta="the audit no longer finds them" tone={t.verified ? 'up' : 'flat'} />
        <Kpi label="Score dropped" icon="↓" value={t.dropped} meta={`${t.scheduled} on a schedule`} tone={t.dropped ? 'down' : 'flat'} />
      </Kpis>
      {ov.sites.length > 1 ? (
        <Panel title="All client websites" sub="Websites that need attention come first." style={{ marginTop: 12 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="mk-table" style={{ minWidth: 640 }}><thead><tr><th>CLIENT</th><th>SCORE</th><th>CHANGE</th><th>OPEN</th><th>FIXED</th><th>NEXT AUDIT</th><th /></tr></thead>
              <tbody>{ov.sites.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.clientName}</b><div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.url}</div></td>
                  <td>{s.score != null ? <b>{s.score}/100</b> : <span style={{ color: 'var(--muted)' }}>Not audited yet</span>}</td>
                  <td>{s.delta == null ? '—' : <span style={{ color: s.delta < 0 ? '#b91c1c' : s.delta > 0 ? '#15803d' : 'inherit', fontWeight: 700 }}>{s.delta === 0 ? 'No change' : `${sign(s.delta)} points`}</span>}{s.dropped ? <> <Pill tone="red">Dropped</Pill></> : null}</td>
                  <td>{s.open}{s.openHigh ? <small style={{ color: '#b91c1c' }}> ({s.openHigh} high)</small> : null}</td><td>{s.verified}</td><td>{s.schedule === 'off' ? 'Not scheduled' : s.nextRunAt ? fmtDate(s.nextRunAt) : '—'}{s.due ? <small> (due)</small> : null}</td>
                  <td><TinyBtn onClick={() => onOpen(s.id, 'dashboard')} aria-label={`Open ${s.clientName}`}>Open</TinyBtn></td>
                </tr>))}
              </tbody></table>
          </div>
        </Panel>
      ) : null}
      {site ? <SiteDash site={site} onOpen={onOpen} audit={audit} busy={busy} toast={toast} /> : null}
    </div>
  );
}

function SiteDash({ site, onOpen, audit, busy, toast }) {
  const r = site.report; const prog = site.progress; const last = site.trend[site.trend.length - 1]; const prev = site.trend.length > 1 ? site.trend[site.trend.length - 2] : null; const delta = last && prev ? last.score - prev.score : null;
  const perf = site.performance; const ps = perf && perf.pagespeed;
  const psScore = (run, key) => { const s = run && run.scores && run.scores.find((x) => x.key === key); return s && s.score != null ? s.score : '—'; };
  return (
    <div style={{ marginTop: 14 }}>
      <h2 style={{ fontSize: 17, margin: '4px 0' }}>{site.clientName} <small style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{site.url} · {site.industryLabel}</small></h2>
      {!r ? <Banner tone="warn">No audit has been saved for this website yet. Press <b>Audit now</b>: TeamLink reads the website like a visitor and lists what to fix.</Banner> : null}
      <Kpis>
        <Kpi label="Website score" icon="◈" value={r ? `${r.score}/100` : '—'} meta={delta == null ? (r ? 'first audit' : '') : `${delta === 0 ? 'No change' : `${sign(delta)} points`} since the audit before`} tone={delta == null ? 'flat' : delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat'} hint="TeamLink's own check of what is on the pages. Not a ranking." />
        <Kpi label="Open recommendations" icon="✔" value={site.tasks.open} meta={`${site.tasks.openHigh} high impact, ${site.tasks.openQuick} quick`} tone={site.tasks.openHigh ? 'down' : 'flat'} onClick={() => onOpen(site.id, 'tasks')} />
        <Kpi label="Fixed and confirmed" icon="✓" value={site.tasks.verified} meta={`${site.tasks.done} done, waiting for an audit`} tone={site.tasks.verified ? 'up' : 'flat'} />
        <Kpi label="Home page answered in" icon="⏱" value={perf && perf.responseMs != null ? `${perf.responseMs} ms` : '—'} meta="server answer, not the full page speed" />
        <Kpi label="Next audit" icon="⏲" value={nextWords(site)} meta={site.lastRunAt ? `last: ${fmtDate(site.lastRunAt)}` : 'no audit yet'} />
      </Kpis>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start', marginTop: 12 }}>
        <div className="grid" style={{ gap: 14 }}>
          <Panel title="Score over time" sub={`${site.audits} saved audit${site.audits === 1 ? '' : 's'}`}>
            <TrendChart points={site.trend} />
            {prog ? <div style={{ fontSize: 12.5, marginTop: 6 }}>First audit {fmtDate(prog.firstAt)}: {prog.firstScore}. Latest: {prog.latestScore} ({prog.change === 0 ? 'no change' : `${sign(prog.change)} points`}). {prog.fixed} recommendation{prog.fixed === 1 ? '' : 's'} fixed and confirmed. The score shows what TeamLink measured on the pages, not why it changed.</div> : <div style={{ fontSize: 12.5, marginTop: 6, color: 'var(--muted)' }}>Run another audit later to see the change.</div>}
          </Panel>
          {r ? (
            <Panel title="Marks by area" sub={`${r.pagesRead === 1 ? 'Home page' : `${r.pagesRead} pages`} read on ${fmtDate(r.checkedAt)}`}>
              {r.areas.map((a) => <div key={a.key} style={{ margin: '6px 0' }}><div style={{ fontSize: 12.5 }}><b>{a.key}</b> {a.got} of {a.marks} <span style={{ color: 'var(--muted)' }}>{a.label}</span></div><div style={{ background: '#e9eeec', borderRadius: 6, height: 8 }}><div style={{ width: `${a.marks ? Math.round((a.got / a.marks) * 100) : 0}%`, background: '#0f766e', height: 8, borderRadius: 6 }} /></div></div>)}
              <div style={{ fontSize: 12, marginTop: 6, color: 'var(--muted)' }}>Open recommendations: {site.byArea.map((a) => `${a.area} ${a.open}`).join(', ')}. {r.extraCount ? `${r.extraCount} extra finding${r.extraCount === 1 ? '' : 's'} (internal links, social card, robots) are in the recommendations but are not part of the score.` : ''}</div>
            </Panel>
          ) : null}
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <Panel title="Do these first" sub="High impact for the least work comes first." right={site.tasks.open ? <TinyBtn onClick={() => onOpen(site.id, 'tasks')}>All recommendations</TinyBtn> : null}>
            {site.topTasks.length ? <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{site.topTasks.map((t) => <li key={t.id} style={{ marginBottom: 6 }}><b>{t.title}</b><div><Chips impact={t.impact} effort={t.effort} area={t.area} />{t.hasFix ? <Tag green>Ready-to-use text</Tag> : null}</div></li>)}</ol> : <div style={{ fontSize: 13 }}>{r ? 'Nothing is open. Keep the content fresh and audit again later.' : 'Audit the website to get the list.'}</div>}
          </Panel>
          <Panel title="Technical findings still open" sub="What stops a site being found, trusted or read on a phone.">
            {site.technical.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{site.technical.map((t) => <li key={t.id}>{t.title} <Tag>{t.impact}</Tag></li>)}</ul> : <div style={{ fontSize: 13 }}>{r ? 'No technical finding is open.' : '—'}</div>}
          </Panel>
        </div>
      </div>
      {r ? (
        <Panel title="Website performance" sub="From the latest saved audit and, when it was run, Google PageSpeed (SEO & visibility > Website check)." style={{ marginTop: 14 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, fontSize: 13 }}>
            <div><b>Home page answer</b><br />{perf.responseMs} ms<br /><small style={{ color: 'var(--muted)' }}>How fast the server answered here. Not the full page speed.</small></div>
            <div><b>Links checked</b><br />{perf.links ? `${perf.links.checked} checked, ${perf.links.bad} did not open` : '—'}{perf.links && perf.links.list.length ? <small style={{ display: 'block', color: '#b91c1c' }}>{perf.links.list.join('; ')}</small> : null}</div>
            <div><b>robots.txt</b><br />{perf.robotsOk ? 'Found' : 'Not found'}<br /><b>Sitemap</b><br />{perf.sitemapOk ? 'Found' : 'Not found'}</div>
            <div><b>Google PageSpeed</b><br />{ps ? <span>Phone: performance {psScore(ps.mobile, 'performance')}, SEO {psScore(ps.mobile, 'seo')}<br />Desktop: performance {psScore(ps.desktop, 'performance')}, SEO {psScore(ps.desktop, 'seo')}<br /><small style={{ color: 'var(--muted)' }}>Run {fmtDate(ps.ranAt)}</small></span> : <span style={{ color: 'var(--muted)' }}>Not run yet. Run it from SEO &amp; visibility &gt; Website check after a saved audit.</span>}</div>
          </div>
        </Panel>
      ) : null}
      <DashboardExtras site={site} onOpen={onOpen} />
      <Panel title="Progress" sub="What changed, newest first." style={{ marginTop: 14 }}>
        {site.events.length ? <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 13 }}>{site.events.map((e) => <li key={e.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}><span style={{ color: e.level === 'bad' ? '#b91c1c' : e.level === 'warn' ? '#b45309' : e.level === 'good' ? '#15803d' : 'inherit', fontWeight: 700 }}>{e.title}</span> <small style={{ color: 'var(--muted)' }}>{fmtDate(e.at)}</small>{e.message ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{e.message}</div> : null}</li>)}</ul> : <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing yet: the first audit starts the list.</div>}
      </Panel>
      {!r ? <div style={{ marginTop: 10 }}><Btn primary disabled={busy} onClick={audit}>{busy ? 'Auditing…' : 'Audit now'}</Btn></div> : null}
    </div>
  );
}
// ---- RECOMMENDATIONS -----------------------------------------------------------------------------------------------------------------------------------------------------
function TasksTab({ site, toast, onChanged }) {
  const [data, setData] = useState(null); const [filter, setFilter] = useState('open'); const [err, setErr] = useState(''); const [busyId, setBusyId] = useState(''); const [notes, setNotes] = useState({}); const [remaking, setRemaking] = useState(false);
  const load = useCallback(() => omni.get(`/gs/marketing/seo/sites/${site.id}/tasks`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errOf(e, 'The recommendations could not be opened.'))), [site.id]);
  useEffect(() => { load(); }, [load]);
  const set = async (t, status) => { setBusyId(t.id); try { await omni.put(`/gs/marketing/seo/tasks/${t.id}`, { status, note: notes[t.id] != null ? notes[t.id] : undefined }); toast(status === 'done' ? 'Marked done. The next audit will confirm it.' : status === 'skipped' ? 'Skipped' : 'Reopened'); await load(); onChanged(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusyId(''); } };
  const remake = async () => { setRemaking(true); try { const r = await omni.post(`/gs/marketing/seo/sites/${site.id}/remake`, {}); toast(`The ready-to-use text was made again for ${r.remade} recommendation${r.remade === 1 ? '' : 's'}.`); await load(); } catch (e) { toast(errOf(e, 'It could not be made again.')); } finally { setRemaking(false); } };
  if (err && !data) return <Banner tone="error">{err}</Banner>;
  if (!data) return <div className="card panel">Loading…</div>;
  const c = data.counts; const items = filter === 'all' ? data.items : data.items.filter((t) => t.status === filter);
  return (
    <div>
      <Banner>TeamLink never edits a client's website. Give the ready-to-use text to the client's web person, press <b>Mark done</b>, and the next audit confirms it. Impact is what TeamLink's own check measures: it does not promise a higher ranking.</Banner>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        {[['open', `To do (${c.open})`], ['done', `Done, waiting (${c.done})`], ['verified', `Fixed (${c.verified})`], ['skipped', `Skipped (${c.skipped})`], ['all', `All (${c.total})`]].map(([k, l]) => <Btn key={k} small primary={filter === k} onClick={() => setFilter(k)}>{l}</Btn>)}
        <span style={{ flex: 1 }} /><TinyBtn onClick={remake} disabled={remaking}>{remaking ? 'Writing…' : 'Make the text again'}</TinyBtn>
      </div>
      {!items.length ? <Empty title={c.total ? 'Nothing in this list' : 'No recommendations yet'}>{c.total ? 'Pick another list above.' : 'Run an audit: every finding becomes a recommendation here.'}</Empty> : null}
      {items.map((t) => (
        <Panel key={t.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{t.title}</div><Pill tone={STATUS[t.status][0]} dot>{STATUS[t.status][1]}</Pill>
          </div>
          <div style={{ margin: '4px 0' }}><Chips impact={t.impact} effort={t.effort} area={t.area} /></div>
          {t.detail ? <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0' }}>{t.detail}</div> : null}
          <div style={{ fontSize: 13, margin: '4px 0' }}><b>What to do:</b> {t.fix}</div>
          {t.pages.length ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pages: {t.pages.join(', ')}</div> : null}
          {t.autoNote ? <div style={{ fontSize: 12, fontStyle: 'italic', margin: '4px 0' }}>{t.autoNote}</div> : null}
          {t.note ? <div style={{ fontSize: 12, margin: '4px 0' }}>Note: {t.note}</div> : null}
          {t.status !== 'verified' && t.drafts.length ? (
            <details style={{ marginTop: 6 }} open={t.status === 'open' && t.drafts.some((d) => d.kind !== 'needs') && t.priority >= 20}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Ready-to-use text</summary>
              {t.drafts.map((d, i) => (
                <div key={i} style={{ margin: '8px 0' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{d.label}</div>
                  {d.kind === 'needs' ? <div style={{ fontSize: 12.5, color: '#8a6410' }}>Not written yet. It needs these facts: <b>{d.needs.join(', ')}</b>. {d.note}</div> : <CopyBox text={d.value} rows={d.kind === 'code' ? Math.min(10, d.value.split('\n').length + 1) : 3} toast={toast} mono={d.kind === 'code'} />}
                  {d.kind !== 'needs' && d.note ? <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.note}</div> : null}
                </div>))}
            </details>
          ) : null}
          {t.status !== 'verified' ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
              <input aria-label={`Note for ${t.title}`} placeholder="A note (optional)" value={notes[t.id] != null ? notes[t.id] : t.note} maxLength={400} onChange={(e) => setNotes({ ...notes, [t.id]: e.target.value })} style={{ minWidth: 200, flex: 1 }} />
              {t.status !== 'done' ? <Btn small primary disabled={busyId === t.id} onClick={() => set(t, 'done')}>Mark done</Btn> : null}
              {t.status !== 'skipped' ? <Btn small disabled={busyId === t.id} onClick={() => set(t, 'skipped')}>Skip</Btn> : null}
              {t.status !== 'open' ? <Btn small disabled={busyId === t.id} onClick={() => set(t, 'open')}>Reopen</Btn> : null}
            </div>
          ) : <div style={{ marginTop: 6 }}><TinyBtn onClick={() => set(t, 'open')} disabled={busyId === t.id}>Reopen</TinyBtn></div>}
        </Panel>
      ))}
    </div>
  );
}

// ---- SITE AND SCHEDULE ---------------------------------------------------------------------------------------------------------------------------------------------------
function SiteTab({ site, industries, toast, onSaved, onRemoved }) {
  const [f, setF] = useState(() => ({ clientName: site ? site.clientName : '', url: site ? site.url : '', industry: site ? site.industry : 'other', planId: site ? site.planId || '' : '', facts: site ? { ...blankFacts, ...site.facts } : { ...blankFacts }, competitors: site ? [...site.competitors, '', '', ''].slice(0, 3) : ['', '', ''], schedule: site ? site.schedule : 'off', pages: String(site ? site.pages : 5), alertDrop: String(site ? site.alertDrop : 5), department: site ? site.department : '' }));
  const [plans, setPlans] = useState([]); const [busy, setBusy] = useState(false); const [sure, setSure] = useState(false);
  useEffect(() => { if (!site) omni.get('/gs/marketing/seo/plans').then((d) => setPlans(d.items || [])).catch(() => setPlans([])); }, [site]);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v })); const setFact = (k, v) => setF((o) => ({ ...o, facts: { ...o.facts, [k]: v } }));
  const fromPlan = async (planId) => {
    const p = plans.find((x) => x.planId === planId); if (!p) { set('planId', ''); return; }
    try { const pf = await omni.get('/gs/marketing/seo/prefill', { clientName: p.clientName }); setF((o) => ({ ...o, planId, clientName: p.clientName, industry: pf.industry || p.industry || o.industry, url: pf.website || o.url, department: p.department || '', facts: { ...o.facts, ...Object.fromEntries(Object.entries(pf.facts || {}).filter(([k, v]) => k in blankFacts && v)) } })); } catch { setF((o) => ({ ...o, planId, clientName: p.clientName, industry: p.industry || o.industry })); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { clientName: f.clientName, url: f.url, industry: f.industry, planId: f.planId || undefined, facts: f.facts, competitors: f.competitors.filter((c) => c.trim()), schedule: f.schedule, pages: Number(f.pages), alertDrop: Number(f.alertDrop), department: f.department || undefined };
      const r = site ? await omni.put(`/gs/marketing/seo/sites/${site.id}`, body) : await omni.post('/gs/marketing/seo/sites', body);
      toast(site ? 'Saved' : 'Saved. Press "Audit now" for the first audit.'); await onSaved(r.site.id);
    } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const remove = async () => { try { await omni.del(`/gs/marketing/seo/sites/${site.id}`); toast('Removed. The audits and recommendations are kept.'); onRemoved(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  const fact = (k, label, o = {}) => <Field label={label} hint={o.hint}>{o.area ? <textarea rows={2} value={f.facts[k]} onChange={(e) => setFact(k, e.target.value)} maxLength={400} /> : <input value={f.facts[k]} onChange={(e) => setFact(k, e.target.value)} maxLength={140} />}</Field>;
  const ok = f.clientName.trim() && f.url.trim();
  return (
    <div>
      <Banner>The facts below are typed by you from the client. The ready-to-use text uses only these facts: a missing fact is asked for, never made up. Nothing here is posted or changed on the website.</Banner>
      {!site && plans.length ? <Panel title="Start from a client plan" sub="Fills the name, kind of business and any facts already typed for the blog plan." style={{ marginBottom: 12 }}><select aria-label="Client plan" value={f.planId} onChange={(e) => fromPlan(e.target.value)}><option value="">Choose a client plan</option>{plans.map((p) => <option key={p.planId} value={p.planId}>{p.clientName}</option>)}</select></Panel> : null}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
        <Panel title="Website">
          <Field label="CLIENT NAME"><input value={f.clientName} maxLength={120} onChange={(e) => set('clientName', e.target.value)} /></Field>
          <Field label="WEBSITE ADDRESS"><input value={f.url} placeholder="www.example.com" onChange={(e) => set('url', e.target.value)} /></Field>
          <Field label="KIND OF BUSINESS"><select value={f.industry} onChange={(e) => set('industry', e.target.value)}>{industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></Field>
          {[0, 1, 2].map((i) => <Field key={i} label={`COMPETITOR ${i + 1} WEBSITE`} hint={i === 0 ? 'Up to 3, used by the competitor tools.' : undefined}><input value={f.competitors[i]} placeholder="www.competitor.com" onChange={(e) => set('competitors', f.competitors.map((c, j) => (j === i ? e.target.value : c)))} /></Field>)}
        </Panel>
        <Panel title="Facts about the business" sub="Used for titles, descriptions, schema and FAQs.">
          {fact('name', 'BUSINESS NAME')}{fact('city', 'CITY')}{fact('state', 'STATE')}{fact('areas', 'AREAS SERVED', { area: true, hint: 'Neighbourhoods or towns, separated by commas.' })}{fact('services', 'SERVICES OR PRODUCTS', { area: true, hint: 'Separated by commas. The first one is the main one.' })}
          {fact('specialty', 'MAIN SPECIALTY')}{fact('audience', 'WHO IT IS FOR')}{fact('phone', 'PHONE')}{fact('email', 'EMAIL')}{fact('address', 'FULL ADDRESS', { area: true })}{fact('hours', 'OPENING HOURS', { hint: 'For example: Mon-Sat 9:00-18:00; Sun closed' })}{fact('since', 'OPEN SINCE (YEAR)')}
        </Panel>
      </div>
      <Panel title="Automatic audits" sub="TeamLink audits the website by itself and rings a bell when something important changes." style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="HOW OFTEN"><select value={f.schedule} onChange={(e) => set('schedule', e.target.value)}><option value="off">Not automatic</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></Field>
          <Field label="PAGES TO READ"><select value={f.pages} onChange={(e) => set('pages', e.target.value)}><option value="1">Home page only</option><option value="3">Up to 3 pages</option><option value="5">Up to 5 pages</option><option value="10">Up to 10 pages</option></select></Field>
          <Field label="RING A BELL WHEN THE SCORE DROPS BY" hint="points or more"><input type="number" min={1} max={50} value={f.alertDrop} onChange={(e) => set('alertDrop', e.target.value)} style={{ width: 90 }} /></Field>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>An audit reads the client's public pages like a visitor. The bell also rings for a serious new problem (the site asks search engines to stay away, loses https) or when the website cannot be reached twice in a row.</div>
      </Panel>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
        <Btn primary disabled={busy || !ok} onClick={save}>{busy ? 'Saving…' : site ? 'Save' : 'Add this website'}</Btn>
        {site && !sure ? <Btn onClick={() => setSure(true)}>Remove this website</Btn> : null}
        {site && sure ? <span style={{ fontSize: 12.5 }}>Remove it from the assistant? Its audits and recommendations are kept. <Btn small danger onClick={remove}>Yes, remove</Btn> <Btn small onClick={() => setSure(false)}>No</Btn></span> : null}
      </div>
    </div>
  );
}

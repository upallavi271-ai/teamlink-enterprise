import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Tag, Banner, Field, Tabs, Empty, fmtDate } from '../ui.jsx';

// AI MARKETING > SEO & VISIBILITY (2026-11-24): the search, answer-engine (AEO), AI-search (GEO) and reputation services of the services document, as tools the team uses with plain code:
// website check, FAQ and schema, review reply drafts, wording check with the medical reviewer's sign-off, industry packs, free photos (Openverse). Nothing here posts or changes anything:
// the team copies the result and the client approves it first. Scores are TeamLink's own checks of what is on the page, never rankings.
const LEVEL = { stop: ['error', 'Change it'], review: ['warn', 'Check it'], info: ['draft', 'Good practice'], ok: ['live', 'No problem found'] };
const blankFacts = { industry: 'hospital', name: '', website: '', phone: '', email: '', street: '', city: '', state: '', pin: '', hours: '', services: '', specialty: '', social: '', since: '' };

function CopyBox({ text, rows = 8, toast }) {
  const copy = () => { try { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  return (<div><textarea readOnly rows={rows} value={text} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} onFocus={(e) => e.target.select()} /><div style={{ marginTop: 4 }}><TinyBtn onClick={copy}>Copy</TinyBtn></div></div>);
}
const IndustrySelect = ({ value, onChange, industries }) => <select value={value} onChange={onChange}>{industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select>;

export default function MkVisibilityPage() {
  const { toast } = useOmni();
  const [tab, setTab] = useState('site'); const [meta, setMeta] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { omni.get('/gs/marketing/visibility/meta').then(setMeta).catch((e) => setErr(errOf(e, 'The tools could not be opened.'))); }, []);
  if (err && !meta) return <Banner tone="error">{err}</Banner>;
  if (!meta) return <div className="card panel">Loading…</div>;
  const p = { toast, industries: meta.industries, keySet: !!(meta.pagespeed && meta.pagespeed.keySet) };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="SEO and visibility" lead="Check a client's website, make the FAQ and business data for search and AI answers, write careful review replies, check the wording, and find free photos. Nothing is posted: the client approves first." />
      <Tabs value={tab} onChange={setTab} tabs={[['site', 'Website check'], ['competitors', 'Competitors'], ['schema', 'FAQ and schema'], ['reviews', 'Review replies'], ['wording', 'Wording check'], ['packs', 'Industry packs'], ['photos', 'Free photos']]} />
      <div style={{ marginTop: 14 }}>
        {tab === 'site' ? <SiteTab {...p} /> : null}{tab === 'competitors' ? <CompetitorsTab {...p} /> : null}{tab === 'schema' ? <SchemaTab {...p} /> : null}{tab === 'reviews' ? <ReviewsTab {...p} /> : null}
        {tab === 'wording' ? <WordingTab {...p} /> : null}{tab === 'packs' ? <PacksTab {...p} /> : null}{tab === 'photos' ? <PhotosTab {...p} /> : null}
      </div>
    </div>
  );
}

// COMPETITORS: the client's website and up to 3 competitors' websites side by side (the same checks as the website check), with the Google numbers the team types from each public profile.
const MARK = { yes: ['✓', '#15803d'], partly: ['½', '#b45309'], no: ['✗', '#b91c1c'] };
const blankBiz = () => ({ name: '', url: '', rating: '', reviews: '', photos: '' });
function BizRow({ label, b, onChange, onRemove }) {
  const f = (k, ph, w) => <input value={b[k]} placeholder={ph} aria-label={`${label} ${ph}`} inputMode={['rating', 'reviews', 'photos'].includes(k) ? 'decimal' : undefined} onChange={(e) => onChange({ ...b, [k]: e.target.value })} style={{ width: w, minWidth: 0 }} />;
  return (<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' }}><b style={{ width: 92, fontSize: 12.5 }}>{label}</b>{f('name', 'Name', 140)}{f('url', 'Website', 210)}{f('rating', 'Rating', 64)}{f('reviews', 'Reviews', 74)}{f('photos', 'Photos', 66)}{onRemove ? <TinyBtn onClick={onRemove} aria-label={`Remove ${label}`}>✕</TinyBtn> : null}</div>);
}
function CompetitorsTab({ toast }) {
  const [me, setMe] = useState(blankBiz()); const [comps, setComps] = useState([blankBiz(), blankBiz()]); const [save, setSave] = useState(false); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null); const [savedId, setSavedId] = useState(''); const [past, setPast] = useState([]);
  const loadPast = useCallback(() => (me.name.trim() ? omni.get('/gs/marketing/visibility/competitor-snapshots', { clientName: me.name.trim() }).then((d) => setPast(d.items || [])).catch(() => setPast([])) : Promise.resolve(setPast([]))), [me.name]);
  useEffect(() => { loadPast(); }, [loadPast]);
  const body = () => { const g = (b) => ({ rating: b.rating, reviews: b.reviews, photos: b.photos }); return { client: { name: me.name, url: me.url, google: g(me) }, competitors: comps.filter((c) => c.url.trim()).map((c) => ({ name: c.name, url: c.url, google: g(c) })), clientName: me.name, save: save && !!me.name.trim() }; };
  const run = async () => { setBusy(true); setRes(null); setSavedId(''); try { const r = await omni.post('/gs/marketing/visibility/competitors', body(), { timeout: 90000 }); setRes(r.snapshot); setSavedId(r.id || ''); if (r.id) { toast('Snapshot saved'); loadPast(); } } catch (e) { toast(errOf(e, 'The websites could not be compared.')); } finally { setBusy(false); } };
  const copy = () => { try { navigator.clipboard.writeText(res.summary.join('\n')).then(() => toast('Summary copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  const ready = me.url.trim() && comps.some((c) => c.url.trim());
  return (
    <div>
      <Banner>Each website is read once, like a visitor would, with the same checks as the website check. The Google numbers are typed by you from each public profile: nothing is read from Google. It compares what is on each homepage, not rankings or customers.</Banner>
      <Panel title="Who to compare" sub="The first row is the client. Rating, reviews and photos are optional; leave them empty if you do not have them." style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--muted)', marginLeft: 98, flexWrap: 'wrap' }}><span style={{ width: 140 }}>NAME</span><span style={{ width: 210 }}>WEBSITE</span><span style={{ width: 64 }}>RATING</span><span style={{ width: 74 }}>REVIEWS</span><span style={{ width: 66 }}>PHOTOS</span></div>
        <BizRow label="Client" b={me} onChange={setMe} />
        {comps.map((c, i) => <BizRow key={i} label={`Competitor ${i + 1}`} b={c} onChange={(v) => setComps(comps.map((x, j) => (j === i ? v : x)))} onRemove={comps.length > 1 ? () => setComps(comps.filter((_, j) => j !== i)) : null} />)}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          {comps.length < 3 ? <TinyBtn onClick={() => setComps([...comps, blankBiz()])}>＋ Add a competitor</TinyBtn> : null}
          <label style={{ fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={save} disabled={!me.name.trim()} onChange={(e) => setSave(e.target.checked)} />Save this snapshot for the client (use the same name as in Client plans)</label>
          <Btn primary disabled={busy || !ready} onClick={run}>{busy ? 'Reading…' : 'Compare the websites'}</Btn>
        </div>
        {busy ? <div style={{ fontSize: 13, marginTop: 6 }}>Reading the websites. It takes about 20 to 60 seconds: please wait here.</div> : null}
      </Panel>
      {res ? (
        <div style={{ marginTop: 12 }}>
          {res.failed.length ? <Banner tone="error">Could not be checked: {res.failed.map((f) => `${f.name} (${f.error})`).join('; ')}</Banner> : null}
          <Panel title="Who is ahead" right={savedId ? <Pill tone="live" dot>Saved for the client</Pill> : null}>
            <table className="mk-table"><thead><tr><th>BUSINESS</th><th>WEBSITE SCORE</th><th>SEO</th><th>AEO</th><th>GEO</th></tr></thead>
              <tbody>{res.ranking.map((r) => <tr key={r.name} style={r.isClient ? { fontWeight: 800 } : undefined}><td>{r.name}{r.isClient ? ' (client)' : ''}</td><td>{r.score} / 100</td>{r.areas.map((a) => <td key={a.key}>{a.got} of {a.marks}</td>)}</tr>)}</tbody></table>
          </Panel>
          <Panel title="Summary" style={{ marginTop: 10 }} right={<TinyBtn onClick={copy}>Copy the summary</TinyBtn>}><ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>{res.summary.map((l, i) => <li key={i}>{l}</li>)}</ul></Panel>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginTop: 10 }}>
            <Panel title="Where competitors are ahead">{res.ahead.length ? <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{res.ahead.slice(0, 10).map((a) => <li key={a.key}><b>{a.gap}</b> <Tag>{a.area}</Tag> <small style={{ color: 'var(--muted)' }}>(better at {a.who.join(', ')}; +{a.lost} marks)</small><br />{a.fix}</li>)}</ol> : <div style={{ fontSize: 13 }}>No competitor is ahead on any check.</div>}</Panel>
            <Panel title="Where the client is ahead">{res.strengths.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{res.strengths.slice(0, 10).map((s) => <li key={s.key}>It {s.text} <small style={{ color: 'var(--muted)' }}>(behind: {s.behind.join(', ')})</small></li>)}</ul> : <div style={{ fontSize: 13 }}>No check where the client is clearly ahead.</div>}</Panel>
          </div>
          {res.google.length ? (
            <Panel title="Google profile numbers (typed by the team)" style={{ marginTop: 10 }}>
              <table className="mk-table"><thead><tr><th />{res.google[0].values.map((v) => <th key={v.name}>{v.name}</th>)}</tr></thead><tbody>{res.google.map((g) => <tr key={g.key}><td>{g.label}</td>{g.values.map((v) => <td key={v.name}>{v.value == null ? <span style={{ color: 'var(--muted)' }}>not given</span> : v.value}</td>)}</tr>)}</tbody></table>
            </Panel>
          ) : null}
          <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>All {res.matrix.length} checks side by side</summary>
            <div style={{ overflowX: 'auto' }}><table className="mk-table"><thead><tr><th>CHECK</th>{res.matrixOrder.map((n) => <th key={n}>{n}</th>)}</tr></thead>
              <tbody>{res.matrix.map((m) => <tr key={m.key}><td style={{ fontSize: 12.5 }}><Tag>{m.area}</Tag> {m.key} <small style={{ color: 'var(--muted)' }}>({m.marks})</small></td>{m.results.map((r, i) => <td key={i} style={{ color: MARK[r][1], fontWeight: 800 }} aria-label={r}>{MARK[r][0]}</td>)}</tr>)}</tbody></table></div>
          </details>
        </div>
      ) : null}
      {past.length ? <Panel title={`Earlier snapshots: ${me.name.trim()}`} style={{ marginTop: 12 }}><table className="mk-table"><tbody>{past.slice(0, 8).map((x) => <tr key={x.id}><td style={{ fontSize: 12.5 }}>{fmtDate(x.createdAt)}</td><td>client {x.clientScore == null ? '' : `${x.clientScore}/100`}</td><td style={{ fontSize: 12 }}>vs {x.competitors.join(', ')}</td></tr>)}</tbody></table></Panel> : null}
    </div>
  );
}

function SiteTab({ toast, keySet }) {
  const [url, setUrl] = useState(''); const [client, setClient] = useState(''); const [save, setSave] = useState(false); const [busy, setBusy] = useState(false); const [rep, setRep] = useState(null); const [past, setPast] = useState([]);
  const [ps, setPs] = useState(null); const [psBusy, setPsBusy] = useState(false); const [savedId, setSavedId] = useState('');
  const runSpeed = async () => { setPsBusy(true); setPs(null); try { setPs(await omni.post('/gs/marketing/visibility/pagespeed', { url: rep.url, checkId: savedId || undefined }, { timeout: 90000 })); } catch (e) { toast(errOf(e, 'PageSpeed could not be run.')); } finally { setPsBusy(false); } };
  const loadPast = useCallback(() => (client.trim() ? omni.get('/gs/marketing/visibility/site-checks', { clientName: client.trim() }).then((d) => setPast(d.items || [])).catch(() => setPast([])) : Promise.resolve(setPast([]))), [client]);
  useEffect(() => { loadPast(); }, [loadPast]);
  const run = async () => { setBusy(true); setRep(null); try { const r = await omni.post('/gs/marketing/visibility/site-check', { url, clientName: client, save: save && !!client.trim() }, { timeout: 60000 }); setRep(r.report); setPs(null); setSavedId(r.id || ''); if (r.id) { toast('Check saved'); loadPast(); } } catch (e) { toast(errOf(e, 'The website could not be checked.')); } finally { setBusy(false); } };
  return (
    <div>
      <Banner>It reads the page once, like a visitor would, and checks 23 things. It is TeamLink's own check of what is on the page: it does not measure rankings or traffic and promises none.</Banner>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', margin: '10px 0' }}>
        <Field label="WEBSITE ADDRESS"><input value={url} placeholder="www.example.com" onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 260 }} /></Field>
        <Field label="CLIENT (TO SAVE IT)"><input value={client} maxLength={120} onChange={(e) => setClient(e.target.value)} /></Field>
        <label style={{ fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={save} disabled={!client.trim()} onChange={(e) => setSave(e.target.checked)} />Save this check for the client</label>
        <Btn primary disabled={busy || !url.trim()} onClick={run}>{busy ? 'Checking…' : 'Check the website'}</Btn>
      </div>
      {busy ? <div style={{ fontSize: 13 }}>Checking the website. It takes about 10 to 25 seconds: please wait here.</div> : null}
      {rep ? (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,3fr)', gap: 14, alignItems: 'start' }}>
          <Panel title="Website score">
            <div style={{ fontSize: 42, fontWeight: 900, color: '#0f766e', lineHeight: 1 }}>{rep.score}<small style={{ fontSize: 18, color: 'var(--muted)' }}> / 100</small></div>
            <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>{rep.url} · answered in {rep.responseMs} ms</div>
            {rep.areas.map((a) => <div key={a.key} style={{ fontSize: 13, margin: '3px 0' }}><b>{a.key}</b> {a.got} of {a.marks} <span style={{ color: 'var(--muted)' }}>{a.label}</span></div>)}
            <div style={{ fontSize: 12, marginTop: 8 }}>Title: {rep.facts.title || 'none'}<br />Main heading: {rep.facts.h1.join(' | ') || 'none'}<br />Pictures: {rep.facts.images} ({rep.facts.imagesNoAlt} without text)<br />Schema found: {rep.facts.schemaTypes.join(', ') || 'none'}</div>
            {rep.links && rep.links.bad ? <div style={{ fontSize: 12, marginTop: 6, color: '#b91c1c' }}>Broken links: {rep.links.list.join('; ')}</div> : null}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>{rep.disclaimer}</div>
          </Panel>
          <Panel title="Do these first">
            {rep.actions.length ? <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{rep.actions.slice(0, 12).map((a) => <li key={a.key}><b>{a.gap}</b> <Tag>{a.area}</Tag> <small style={{ color: 'var(--muted)' }}>(+{a.lost} marks)</small><br />{a.fix}</li>)}</ol> : <div style={{ fontSize: 13 }}>Everything checked is in place. Keep the content fresh.</div>}
          </Panel>
        </div>
      ) : null}
      {rep ? <SpeedPanel ps={ps} busy={psBusy} onRun={runSpeed} saved={!!savedId} keySet={keySet} /> : null}
      {past.length ? <Panel title={`Earlier checks: ${client.trim()}`} style={{ marginTop: 12 }}><table className="mk-table"><tbody>{past.slice(0, 8).map((x) => <tr key={x.id}><td style={{ fontSize: 12.5 }}>{fmtDate(x.createdAt)}</td><td>{x.url}</td><td><b>{x.score}/100</b></td></tr>)}</tbody></table></Panel> : null}
    </div>
  );
}

function SchemaTab({ toast, industries }) {
  const [f, setF] = useState(blankFacts); const [out, setOut] = useState(null); const [desc, setDesc] = useState(null); const [faq, setFaq] = useState([{ question: '', answer: '' }]); const [fq, setFq] = useState(null);
  const [places, setPlaces] = useState([{ place: 'Website', name: '', address: '', phone: '' }, { place: 'Google', name: '', address: '', phone: '' }]); const [nap, setNap] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const call = async (path, body, fn) => { try { fn(await omni.post(`/gs/marketing/visibility/${path}`, body)); } catch (e) { toast(errOf(e, 'It could not be made.')); } };
  const fillFaq = async () => { try { const r = await omni.post('/gs/marketing/visibility/pack', { ...f, industry: f.industry }); setFaq(r.faq.map((x) => ({ question: x.question, answer: x.answer }))); toast('Questions filled. Write the empty answers with the client.'); } catch (e) { toast(errOf(e, 'It could not be made.')); } };
  const setPlace = (i, k, v) => setPlaces(places.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <div>
      <Panel title="1 · The business, as search and AI systems should read it" sub="Type only real facts. A field left empty is left out; nothing is guessed.">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
          <Field label="KIND OF BUSINESS"><IndustrySelect value={f.industry} industries={industries} onChange={set('industry')} /></Field>
          <Field label="BUSINESS NAME"><input value={f.name} maxLength={140} onChange={set('name')} /></Field>
          <Field label="WEBSITE"><input value={f.website} placeholder="https://" onChange={set('website')} /></Field>
          <Field label="PHONE"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="EMAIL"><input value={f.email} onChange={set('email')} /></Field>
          <Field label="STREET ADDRESS"><input value={f.street} onChange={set('street')} /></Field>
          <Field label="CITY"><input value={f.city} onChange={set('city')} /></Field>
          <Field label="STATE"><input value={f.state} onChange={set('state')} /></Field>
          <Field label="PIN CODE"><input value={f.pin} onChange={set('pin')} /></Field>
          <Field label="OPENING HOURS"><input value={f.hours} placeholder="Mon-Sat 9:00-18:00; Sun closed" onChange={set('hours')} /></Field>
          <Field label="SERVICES (SEPARATED BY COMMAS)"><input value={f.services} onChange={set('services')} /></Field>
          <Field label="MAIN SPECIALTY"><input value={f.specialty} onChange={set('specialty')} /></Field>
          <Field label="SOCIAL PAGE ADDRESSES"><input value={f.social} placeholder="https://facebook.com/…" onChange={set('social')} /></Field>
          <Field label="RUNNING SINCE (YEAR)"><input value={f.since} onChange={set('since')} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}><Btn primary disabled={!f.name.trim()} onClick={() => call('schema/business', f, setOut)}>Make the business schema</Btn><Btn disabled={!f.name.trim()} onClick={() => call('describe', f, setDesc)}>Write the description</Btn></div>
        {out ? <div><CopyBox text={out.script} rows={9} toast={toast} />{out.missing.length ? <div style={{ fontSize: 12.5, marginTop: 4 }}>Not filled yet: {out.missing.join(', ')}.</div> : null}{out.unreadHours.length ? <div style={{ fontSize: 12.5 }}>Hours that could not be read: {out.unreadHours.join('; ')}</div> : null}<div style={{ fontSize: 12, color: 'var(--muted)' }}>{out.note}</div></div> : null}
        {desc ? <div style={{ marginTop: 10 }}><b style={{ fontSize: 12.5 }}>Description for the website and AI-friendly pages</b><CopyBox text={desc.description} rows={4} toast={toast} /><b style={{ fontSize: 12.5 }}>For Google Business Profile ({desc.gbpLength} of 750 characters)</b><CopyBox text={desc.gbp} rows={4} toast={toast} /><div style={{ fontSize: 12, color: 'var(--muted)' }}>{desc.note}</div></div> : null}
      </Panel>
      <Panel title="2 · FAQ for the website" sub="Answers in the client's own words. Questions without an answer are left out of the schema." style={{ marginTop: 12 }} right={<Btn small onClick={fillFaq}>Fill the questions for this kind of business</Btn>}>
        {faq.map((q, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto', gap: 8, margin: '6px 0' }}>
            <input value={q.question} placeholder="Question" onChange={(e) => setFaq(faq.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
            <input value={q.answer} placeholder="Answer (the client's real answer)" onChange={(e) => setFaq(faq.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
            <TinyBtn onClick={() => setFaq(faq.filter((_, j) => j !== i))} aria-label="Remove this question">✕</TinyBtn>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}><TinyBtn onClick={() => setFaq([...faq, { question: '', answer: '' }])}>＋ Add a question</TinyBtn><Btn primary onClick={() => call('schema/faq', { faq }, setFq)}>Make the FAQ schema</Btn></div>
        {fq ? <div style={{ marginTop: 8 }}><CopyBox text={fq.script} rows={9} toast={toast} /><div style={{ fontSize: 12 }}>{fq.count} question(s) in the schema{fq.skipped.length ? `; left out, no answer yet: ${fq.skipped.join(' | ')}` : ''}. {fq.note}</div></div> : null}
      </Panel>
      <Panel title="3 · Same name, address and phone everywhere" sub="Write the details exactly as shown on each place. The first row is the one the others are compared with." style={{ marginTop: 12 }}>
        {places.map((p, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1.4fr 1fr', gap: 8, margin: '6px 0' }}>
            <input value={p.place} aria-label="Place" onChange={(e) => setPlace(i, 'place', e.target.value)} /><input value={p.name} placeholder="Name" onChange={(e) => setPlace(i, 'name', e.target.value)} /><input value={p.address} placeholder="Address" onChange={(e) => setPlace(i, 'address', e.target.value)} /><input value={p.phone} placeholder="Phone" onChange={(e) => setPlace(i, 'phone', e.target.value)} />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}><TinyBtn onClick={() => setPlaces([...places, { place: 'Other listing', name: '', address: '', phone: '' }])}>＋ Add a place</TinyBtn><Btn primary onClick={() => call('nap', { places }, setNap)}>Compare</Btn></div>
        {nap ? <div style={{ marginTop: 8, fontSize: 13 }}>{nap.consistent ? <Pill tone="live" dot>The same everywhere</Pill> : <><Pill tone="warn" dot>{nap.issues.length} difference(s)</Pill><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{nap.issues.map((x, i) => <li key={i}><b>{x.place}</b> {x.field}: "{x.here}" should read "{x.expected}"</li>)}</ul></>}<div style={{ fontSize: 12, color: 'var(--muted)' }}>{nap.note}</div></div> : null}
      </Panel>
    </div>
  );
}

function ReviewsTab({ toast, industries }) {
  const [b, setB] = useState({ rating: 5, text: '', reviewerName: '', business: '', industry: 'hospital', contact: '' }); const [res, setRes] = useState(null);
  const set = (k) => (e) => setB({ ...b, [k]: k === 'rating' ? Number(e.target.value) : e.target.value });
  const go = async () => { try { setRes(await omni.post('/gs/marketing/visibility/review-reply', b)); } catch (e) { toast(errOf(e, 'The replies could not be written.')); } };
  const copy = (t) => { try { navigator.clipboard.writeText(t).then(() => toast('Reply copied'), () => toast('Select the reply and copy it.')); } catch { toast('Select the reply and copy it.'); } };
  return (
    <div>
      <Banner>Three careful drafts, written from fixed sentence parts (no AI). Show the client the reply and get the approval before it is posted on Google.</Banner>
      <Panel title="The review" style={{ marginTop: 10 }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
          <Field label="STARS"><select value={b.rating} onChange={set('rating')}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? 's' : ''}</option>)}</select></Field>
          <Field label="KIND OF BUSINESS"><IndustrySelect value={b.industry} industries={industries} onChange={set('industry')} /></Field>
          <Field label="REVIEWER'S NAME (AS SHOWN)"><input value={b.reviewerName} onChange={set('reviewerName')} /></Field>
          <Field label="HOW TO REACH US (PHONE OR EMAIL)"><input value={b.contact} onChange={set('contact')} /></Field>
        </div>
        <Field label="WHAT THE REVIEW SAYS" full><textarea rows={4} maxLength={3000} value={b.text} onChange={set('text')} style={{ width: '100%' }} /></Field>
        <Btn primary onClick={go}>Write the reply drafts</Btn>
      </Panel>
      {res ? (
        <div style={{ marginTop: 12 }}>
          {res.drafts.map((d) => (
            <Panel key={d.id} title={`Draft ${d.id}`} style={{ marginBottom: 10 }} right={<span style={{ display: 'flex', gap: 6 }}><Pill tone={d.verdict === 'No problems found by this checklist' ? 'live' : 'warn'} dot>{d.verdict}</Pill><TinyBtn onClick={() => copy(d.text)}>Copy reply</TinyBtn></span>}>
              <div style={{ fontSize: 14, lineHeight: 1.55 }}>{d.text}</div>{d.flags.length ? <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>{d.flags.map((x, i) => <li key={i}>{x.why}</li>)}</ul> : null}
            </Panel>
          ))}
          <ul style={{ fontSize: 12.5, lineHeight: 1.5, paddingLeft: 18 }}>{res.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function WordingTab({ toast, industries }) {
  const [text, setText] = useState(''); const [industry, setIndustry] = useState('hospital'); const [res, setRes] = useState(null);
  const [so, setSo] = useState({ clientName: '', reviewerName: '', reviewerRole: 'Medical reviewer', note: '' }); const [done, setDone] = useState('');
  const go = async () => { setDone(''); try { setRes(await omni.post('/gs/marketing/visibility/wording-check', { text, industry })); } catch (e) { toast(errOf(e, 'The words could not be checked.')); } };
  const sign = async () => { try { const r = await omni.post('/gs/marketing/visibility/signoff', { ...so, text, industry }); setDone(`Signed off by ${r.reviewerName}`); toast('Sign-off recorded'); } catch (e) { toast(errOf(e, 'The sign-off could not be recorded.')); } };
  const [tone, label] = res ? LEVEL[res.level] : LEVEL.ok;
  return (
    <div>
      <Banner>A checklist for posts, captions, FAQ answers and replies. It is a starting list, not legal advice: the medical reviewer and the client's legal adviser decide.</Banner>
      <Panel title="The words to check" style={{ marginTop: 10 }}>
        <Field label="KIND OF BUSINESS"><IndustrySelect value={industry} industries={industries} onChange={(e) => setIndustry(e.target.value)} /></Field>
        <Field label="WORDS" full><textarea rows={6} maxLength={8000} value={text} onChange={(e) => { setText(e.target.value); setRes(null); setDone(''); }} style={{ width: '100%' }} /></Field>
        <Btn primary disabled={!text.trim()} onClick={go}>Check the words</Btn>
      </Panel>
      {res ? (
        <Panel title="Result" style={{ marginTop: 12 }} right={<Pill tone={tone} dot>{res.verdict}</Pill>}>
          {res.findings.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{res.findings.map((x, i) => <li key={i}><Pill tone={LEVEL[x.level][0]}>{LEVEL[x.level][1]}</Pill> <b>"{x.match}"</b>: {x.why} <br /><small style={{ color: 'var(--muted)' }}>{x.context}</small><br />{x.fix}</li>)}</ul> : <div style={{ fontSize: 13 }}>{label}.</div>}
          <div style={{ fontSize: 12.5, marginTop: 8 }}>{res.note}</div><div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Basis: {res.basis}</div>
          {res.needsSignoff && !res.stops ? (
            <div style={{ marginTop: 12, borderTop: '1px solid #e2e8f0', paddingTop: 10 }}><b style={{ fontSize: 13 }}>Medical reviewer's sign-off</b>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
                <Field label="CLIENT"><input value={so.clientName} onChange={(e) => setSo({ ...so, clientName: e.target.value })} /></Field>
                <Field label="REVIEWER'S NAME"><input value={so.reviewerName} onChange={(e) => setSo({ ...so, reviewerName: e.target.value })} /></Field>
                <Field label="ROLE"><input value={so.reviewerRole} onChange={(e) => setSo({ ...so, reviewerRole: e.target.value })} /></Field>
                <Field label="NOTE"><input value={so.note} onChange={(e) => setSo({ ...so, note: e.target.value })} /></Field>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}><Btn primary disabled={!so.clientName.trim() || !so.reviewerName.trim()} onClick={sign}>Record the sign-off</Btn>{done ? <Pill tone="live" dot>{done}</Pill> : null}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Record it only after the doctor or qualified reviewer has really read exactly these words.</div>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

function PacksTab({ toast, industries }) {
  const [f, setF] = useState({ ...blankFacts, specialty: '' }); const [pack, setPack] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const make = async () => { try { setPack(await omni.post('/gs/marketing/visibility/pack', { ...f, address: [f.street, f.city, f.pin].filter(Boolean).join(', ') })); } catch (e) { toast(errOf(e, 'The pack could not be made.')); } };
  const copy = (t) => { try { navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  return (
    <div>
      <Panel title="The client" sub="Facts the client really has. The pack uses only these; every other answer stays empty for the client to write.">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
          <Field label="KIND OF BUSINESS"><IndustrySelect value={f.industry} industries={industries} onChange={set('industry')} /></Field>
          <Field label="BUSINESS NAME"><input value={f.name} onChange={set('name')} /></Field><Field label="CITY"><input value={f.city} onChange={set('city')} /></Field><Field label="STATE"><input value={f.state} onChange={set('state')} /></Field>
          <Field label="STREET ADDRESS"><input value={f.street} onChange={set('street')} /></Field><Field label="PIN CODE"><input value={f.pin} onChange={set('pin')} /></Field><Field label="PHONE"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="OPENING HOURS"><input value={f.hours} onChange={set('hours')} /></Field><Field label="SERVICES (COMMAS)"><input value={f.services} onChange={set('services')} /></Field><Field label="MAIN SPECIALTY"><input value={f.specialty} onChange={set('specialty')} /></Field>
        </div>
        <div style={{ marginTop: 10 }}><Btn primary onClick={make}>Make the pack</Btn></div>
      </Panel>
      {pack ? (
        <div style={{ marginTop: 12 }}>
          <Banner>{pack.note}</Banner>
          <Panel title={`FAQ questions (${pack.faq.length})`} style={{ marginTop: 10 }} right={<TinyBtn onClick={() => copy(pack.faq.map((x) => `Q: ${x.question}\nA: ${x.answer || '(the client writes this)'}`).join('\n\n'))}>Copy all</TinyBtn>}>
            <table className="mk-table"><tbody>{pack.faq.map((x, i) => <tr key={i}><td style={{ fontSize: 13 }}><b>{x.question}</b></td><td style={{ fontSize: 13 }}>{x.ready ? x.answer : <span style={{ color: 'var(--muted)' }}>{x.askClient ? 'The client writes the real answer.' : `Fill in: ${x.needs.join(', ')}.`}</span>}</td></tr>)}</tbody></table>
          </Panel>
          <Panel title="30 post ideas for the month" style={{ marginTop: 10 }} right={<TinyBtn onClick={() => copy(pack.posts.map((x) => `${x.day}. ${x.idea}`).join('\n'))}>Copy all</TinyBtn>}><ol style={{ margin: 0, paddingLeft: 22, fontSize: 13, columns: 2, columnGap: 28 }}>{pack.posts.map((x) => <li key={x.day} style={{ breakInside: 'avoid', margin: '2px 0' }}>{x.idea}</li>)}</ol></Panel>
          <Panel title="Search phrases to research, Google profile categories, reply tone" style={{ marginTop: 10 }}>
            <div style={{ fontSize: 13 }}><b>Search phrases (research only, never a claim):</b> {pack.keywords.length ? pack.keywords.join(' · ') : 'add the city and the main specialty or service'}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}><b>Profile category ideas:</b> {pack.gbpCategories.join(' · ') || 'choose the one that says what the business is'}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}><b>Schema type:</b> {pack.schemaType} · <b>Reply tone:</b> {pack.replyTone}</div>
            <div style={{ fontSize: 13, marginTop: 6 }}><b>Rules of the trade</b></div><ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{pack.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function PhotosTab({ toast }) {
  const [q, setQ] = useState(''); const [shape, setShape] = useState(''); const [page, setPage] = useState(1); const [res, setRes] = useState(null); const [busy, setBusy] = useState(false);
  const go = async (pg = 1) => { setBusy(true); try { setRes(await omni.get('/gs/marketing/visibility/photos', { q, shape, page: pg })); setPage(pg); } catch (e) { toast(errOf(e, 'The photos could not be searched.')); } finally { setBusy(false); } };
  const copy = (t) => { try { navigator.clipboard.writeText(t).then(() => toast('Credit copied'), () => toast('Select the credit and copy it.')); } catch { toast('Select the credit and copy it.'); } };
  return (
    <div>
      <Banner>Free photos from Openverse, open to everyone. Only photos that may be used commercially are shown. Check the licence of the photo you pick and give the credit where it asks. Pixabay stays the first source in AI Images and AI Video.</Banner>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', margin: '10px 0' }}>
        <Field label="WHAT DO YOU WANT TO SEE?"><input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim().length > 1 && go(1)} style={{ minWidth: 240 }} /></Field>
        <Field label="SHAPE"><select value={shape} onChange={(e) => setShape(e.target.value)}><option value="">Any</option><option value="wide">Wide</option><option value="tall">Tall</option><option value="square">Square</option></select></Field>
        <Btn primary disabled={busy || q.trim().length < 2} onClick={() => go(1)}>{busy ? 'Searching…' : 'Search'}</Btn>
      </div>
      {res && !res.items.length ? <Empty title="No photos found">Try other words.</Empty> : null}
      {res && res.items.length ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 10 }}>
            {res.items.map((p) => (
              <div key={p.id} className="card" style={{ padding: 8, fontSize: 12 }}>
                <img src={p.thumb} alt={p.title} loading="lazy" style={{ width: '100%', height: 130, objectFit: 'cover', borderRadius: 6 }} />
                <div style={{ marginTop: 4 }}><b>{p.title}</b></div><div style={{ color: 'var(--muted)' }}>by {p.creator}</div>
                <div style={{ margin: '4px 0' }}><Pill tone={p.needsCredit ? 'warn' : 'live'}>{p.license}</Pill></div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{p.page ? <a className="tiny-btn" href={p.page} target="_blank" rel="noopener noreferrer">Open the page</a> : null}<TinyBtn onClick={() => copy(p.credit)}>Copy credit</TinyBtn></div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 12.5 }}><TinyBtn disabled={page <= 1 || busy} onClick={() => go(page - 1)}>Earlier</TinyBtn>Page {page} of {res.pages}<TinyBtn disabled={page >= res.pages || busy} onClick={() => go(page + 1)}>More</TinyBtn></div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{res.note}</div>
        </>
      ) : null}
    </div>
  );
}

// Google PageSpeed (Lighthouse) for the checked page: phone and desktop together. The numbers are Google's lab measurement of this one page at this moment, not a ranking.
const BAND = { good: ['live', 'Good'], work: ['warn', 'Needs work'], poor: ['error', 'Poor'], 'n/a': ['draft', 'n/a'] };
const scoreTone = (n) => (n == null ? 'draft' : n >= 90 ? 'live' : n >= 50 ? 'warn' : 'error');
function SpeedRun({ title, r }) {
  if (!r) return null;
  if (r.error) return <Panel title={title}><Banner tone="error">{r.error}</Banner></Panel>;
  return (
    <Panel title={title}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>{r.scores.map((s) => <span key={s.key} style={{ textAlign: 'center' }}><div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.1, color: s.score == null ? 'var(--muted)' : s.score >= 90 ? '#15803d' : s.score >= 50 ? '#b45309' : '#b91c1c' }}>{s.score == null ? '—' : s.score}</div><Pill tone={scoreTone(s.score)}>{s.label}</Pill></span>)}</div>
      <table className="mk-table"><tbody>{r.metrics.map((m) => <tr key={m.key}><td style={{ fontSize: 12.5 }}>{m.label}</td><td><b>{m.display}</b></td><td><Pill tone={BAND[m.rating][0]}>{BAND[m.rating][1]}</Pill></td></tr>)}</tbody></table>
      {r.opportunities.length ? <><b style={{ fontSize: 12.5 }}>What costs the most time</b><ul style={{ margin: '4px 0 6px', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.45 }}>{r.opportunities.map((o) => <li key={o.id}>{o.title}{o.display ? ` (${o.display})` : ''}</li>)}</ul></> : null}
      {r.issues.length ? <><b style={{ fontSize: 12.5 }}>Other things Google flags</b><ul style={{ margin: '4px 0 6px', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.45 }}>{r.issues.slice(0, 6).map((o, i) => <li key={i}><Tag>{o.category}</Tag> {o.title}{o.display ? ` (${o.display})` : ''}</li>)}</ul></> : null}
      {r.field ? <div style={{ fontSize: 12.5 }}><b>What real visitors' browsers saw{r.field.overall ? `: ${r.field.overall}` : ''}</b>{r.field.metrics.length ? ` · ${r.field.metrics.map((m) => `${m.label} ${m.value} (${m.category})`).join(' · ')}` : ''}</div> : <div style={{ fontSize: 12, color: 'var(--muted)' }}>Google has no real-visitor data for this site (too few visits).</div>}
    </Panel>
  );
}
function SpeedPanel({ ps, busy, onRun, saved, keySet }) {
  return (
    <Panel title="Google PageSpeed" sub="Phone and desktop, measured by Google with Lighthouse (open source). Free." style={{ marginTop: 12 }} right={<Btn primary disabled={busy} onClick={onRun}>{busy ? 'Measuring…' : ps ? 'Run it again' : 'Run Google PageSpeed'}</Btn>}>
      {busy ? <div style={{ fontSize: 13 }}>Google is measuring the page on a phone and on a desktop. It takes 20 to 50 seconds: please wait here.</div> : null}
      {!ps && !busy ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Measures how fast the page loads and how good it is on a phone. {keySet ? '' : 'It works without a key at low volume; if Google says its free allowance is used up, an Admin adds a free key in Administration > Integrations > Website speed.'}</div> : null}
      {ps ? (
        <div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}><SpeedRun title="On a phone" r={ps.mobile} /><SpeedRun title="On a desktop" r={ps.desktop} /></div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{ps.note} {ps.attached ? 'Kept with the saved check: it will show in the monthly report.' : saved ? '' : 'Save the check for a client to keep this result for the monthly report.'}</div>
        </div>
      ) : null}
    </Panel>
  );
}

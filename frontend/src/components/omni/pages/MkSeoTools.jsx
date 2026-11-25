import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, TinyBtn, Panel, Pill, Tag, Banner, Field, Empty, fmtDate } from '../ui.jsx';
import { CopyBox, Bars } from './MkSeoParts.jsx';

// AI MARKETING > SEO ASSISTANT > KEYWORDS, CONTENT, COMPETITORS and the keyword / content panels of the dashboard (2026-11-25).
// HONEST BY DESIGN: search volume and keyword difficulty are shown as "not available" (no data provider is connected: nothing is estimated); a position is what Search Console reported;
// content is written only from the facts typed for the client; an article needs an AI model that is ready; competitor words are what a page stresses, not keywords with traffic; no backlinks.
const INTENT = { informational: 'Wants to learn', commercial: 'Comparing or cost', transactional: 'Ready to act', navigational: 'Looks for the business', local: 'Looks for a place near them' };
const NA = <span style={{ color: 'var(--muted)' }}>not available</span>;
const tick = (set, k) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };

// ---- KEYWORDS ----------------------------------------------------------------------------------------------------------------------------------------------------------
export function KeywordsTab({ site, toast }) {
  const [res, setRes] = useState(null); const [busy, setBusy] = useState(false); const [chosen, setChosen] = useState(new Set()); const [track, setTrack] = useState(true); const [mine, setMine] = useState('');
  const [list, setList] = useState(null); const [qv, setQv] = useState(null); const [reading, setReading] = useState(false); const [csv, setCsv] = useState(''); const [day, setDay] = useState(''); const [label, setLabel] = useState(''); const [importing, setImporting] = useState(false);
  const load = useCallback(async () => { try { const [l, q] = await Promise.all([omni.get(`/gs/marketing/seo/sites/${site.id}/keywords`), omni.get(`/gs/marketing/seo/sites/${site.id}/queries`)]); setList(l); setQv(q); } catch (e) { toast(errOf(e, 'The keywords could not be opened.')); } }, [site.id, toast]);
  useEffect(() => { load(); }, [load]);
  const research = async () => { setBusy(true); setRes(null); setChosen(new Set()); try { setRes(await omni.post('/gs/marketing/seo/keywords/research', { siteId: site.id })); } catch (e) { toast(errOf(e, 'The phrases could not be made.')); } finally { setBusy(false); } };
  const keep = async (phrases) => { try { const r = await omni.post(`/gs/marketing/seo/sites/${site.id}/keywords`, { phrases, tracked: track }); toast(`${r.added} phrase${r.added === 1 ? '' : 's'} kept${r.alreadyThere ? `, ${r.alreadyThere} already on the list` : ''}`); setChosen(new Set()); setMine(''); await load(); } catch (e) { toast(errOf(e, 'The phrases could not be kept.')); } };
  const keepChosen = () => keep(res.groups.flatMap((g) => g.items.filter((i) => chosen.has(i.phrase)).map((i) => ({ phrase: i.phrase, group: g.key, intent: i.intent }))));
  const flip = async (k) => { try { await omni.put(`/gs/marketing/seo/keywords/${k.id}`, { tracked: !k.tracked }); await load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } };
  const del = async (k) => { try { await omni.del(`/gs/marketing/seo/keywords/${k.id}`); await load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  const readGsc = async () => { setReading(true); try { const r = await omni.post(`/gs/marketing/seo/sites/${site.id}/google/sync`, { what: 'gsc' }, { timeout: 120000 }); toast(`Search Console read: ${r.gsc.queries} queries kept for ${r.gsc.period.end}`); await load(); } catch (e) { toast(errOf(e, 'Search Console could not be read.')); } finally { setReading(false); } };
  const doImport = async () => { setImporting(true); try { const r = await omni.post(`/gs/marketing/seo/sites/${site.id}/queries`, { text: csv, periodEnd: day || undefined, label: label || undefined }); toast(`${r.set.rows} queries saved for ${r.set.periodEnd}${r.set.truncated ? ' (the first 1,000 of the file)' : ''}`); setCsv(''); setLabel(''); await load(); } catch (e) { toast(errOf(e, 'The file could not be read.')); } finally { setImporting(false); } };
  return (
    <div>
      <Banner>Search volume and keyword difficulty are <b>not available</b>: no keyword data provider is connected, and free sources do not give reliable numbers, so nothing is estimated. The phrases below are research ideas, not a promise of traffic or a ranking. The only real numbers are the Search Console queries you import further down.</Banner>
      <Panel title="Keyword ideas" sub="Made from the client's facts (services, city, areas, audience) and the industry's local phrases." right={<Btn primary disabled={busy} onClick={research}>{busy ? 'Thinking…' : res ? 'Make them again' : 'Find keyword ideas'}</Btn>} style={{ marginTop: 10 }}>
        {!res && !busy ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>It uses the facts saved under Site and schedule. The more facts, the better the phrases: a city gives local phrases, areas give neighbourhood phrases.</div> : null}
        {res ? (
          <div>
            {res.needs.length ? <Banner tone="warn">Add {res.needs.join(', ')} under Site and schedule for more phrases.</Banner> : null}
            {res.groups.map((g) => (
              <div key={g.key} style={{ margin: '10px 0' }}>
                <div style={{ fontWeight: 800, fontSize: 13.5 }}>{g.label} <small style={{ fontWeight: 400, color: 'var(--muted)' }}>({g.items.length})</small></div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{g.note}</div>
                <div style={{ overflowX: 'auto' }}><table className="mk-table" style={{ minWidth: 560 }}><thead><tr><th style={{ width: 28 }} /><th>PHRASE</th><th>INTENT</th><th>MONTHLY SEARCHES</th><th>DIFFICULTY</th></tr></thead>
                  <tbody>{g.items.map((i) => (<tr key={i.phrase}><td><input type="checkbox" aria-label={`Keep ${i.phrase}`} checked={chosen.has(i.phrase)} onChange={() => setChosen(tick(chosen, i.phrase))} /></td><td><b>{i.phrase}</b></td><td><Tag title={INTENT[i.intent]}>{i.intent}</Tag> <small style={{ color: 'var(--muted)' }}>{INTENT[i.intent]}</small></td><td>{NA}</td><td>{NA}</td></tr>))}</tbody></table></div>
              </div>))}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
              <Btn primary disabled={!chosen.size} onClick={keepChosen}>Keep the ticked phrases ({chosen.size})</Btn>
              <label style={{ fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />Track them (show the Search Console position)</label>
            </div>
            {res.known && res.known.items.length ? <div style={{ fontSize: 12.5 }}>Real data already saved for this client: {res.known.items.length} queries at position 4 to 20 are below under "Search Console data".</div> : null}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{res.notes.join(' ')}</div>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <input aria-label="Your own phrase" placeholder="Add your own phrase" value={mine} maxLength={90} onChange={(e) => setMine(e.target.value)} style={{ minWidth: 240 }} />
          <Btn small disabled={mine.trim().length < 2} onClick={() => keep([{ phrase: mine, group: 'typed', source: 'typed' }])}>Keep it</Btn>
        </div>
      </Panel>
      <Panel title="The client's keyword list" sub="Phrases kept for this client. A position appears once a Search Console export has the phrase." style={{ marginTop: 12 }}>
        {!list ? <div>Loading…</div> : !list.items.length ? <Empty title="No phrase kept yet">Tick phrases above and press "Keep the ticked phrases".</Empty> : (
          <div style={{ overflowX: 'auto' }}><table className="mk-table" style={{ minWidth: 560 }}><thead><tr><th>PHRASE</th><th>INTENT</th><th>POSITION</th><th>CHANGE</th><th>CLICKS / SEEN</th><th>TRACKED</th><th /></tr></thead>
            <tbody>{list.items.map((k) => (<tr key={k.id}>
              <td><b>{k.phrase}</b><div style={{ fontSize: 11, color: 'var(--muted)' }}>{k.group}</div></td><td>{k.intent}</td>
              <td>{k.position != null ? k.position : <span style={{ color: 'var(--muted)' }}>{list.sets.length ? 'not in the export' : 'no data yet'}</span>}{k.previous != null ? <small style={{ color: 'var(--muted)' }}> (was {k.previous})</small> : null}</td>
              <td>{k.change == null ? '—' : <span style={{ color: k.change > 0 ? '#15803d' : k.change < 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}>{k.change === 0 ? 'same' : k.change > 0 ? `up ${k.change}` : `down ${-k.change}`}</span>}</td>
              <td>{k.clicks != null ? `${k.clicks} / ${k.impressions}` : '—'}</td>
              <td><input type="checkbox" aria-label={`Track ${k.phrase}`} checked={k.tracked} onChange={() => flip(k)} /></td><td><TinyBtn onClick={() => del(k)} aria-label={`Remove ${k.phrase}`}>✕</TinyBtn></td></tr>))}</tbody></table></div>
        )}
        {list ? <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{list.note} Search volume and difficulty: not available (no provider).</div> : null}
      </Panel>
      <Panel title="Search Console data" sub="The real queries people used, with clicks, impressions and average position. Read them from Google, or paste the export of the Queries tab." right={site.gscProperty ? <Btn small primary disabled={reading} onClick={readGsc}>{reading ? 'Reading Google…' : 'Read Search Console now'}</Btn> : null} style={{ marginTop: 12 }}>
        {!site.gscProperty ? <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>To read Search Console directly, choose this client's property under Site and schedule (an Admin connects Google once). Until then, paste the export:</div> : null}
        <ol style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12.5 }}><li>Open Google Search Console for the client's website, then Performance.</li><li>Pick the dates (for example the last 3 months) and open the Queries tab.</li><li>Press Export, then Download CSV, open the file and paste its text here.</li></ol>
        <textarea aria-label="Search Console export" rows={5} value={csv} placeholder="Top queries,Clicks,Impressions,CTR,Position" onChange={(e) => setCsv(e.target.value)} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', margin: '8px 0' }}>
          <Field label="LAST DAY OF THE PERIOD"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label="A NAME FOR IT (OPTIONAL)"><input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Last 3 months" /></Field>
          <Btn primary disabled={importing || csv.trim().length < 20} onClick={doImport}>{importing ? 'Reading…' : 'Save these queries'}</Btn>
        </div>
        {qv && qv.sets.length ? <div style={{ fontSize: 12.5, marginBottom: 6 }}>Saved exports: {qv.sets.map((s) => `${s.label} (${s.rows} queries, to ${s.periodEnd})`).join('; ')}.</div> : null}
        {qv && qv.items.length ? (
          <div><div style={{ fontWeight: 800, fontSize: 13, margin: '6px 0' }}>Opportunities: queries at position 4 to 20 in "{qv.set.label}"</div><div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Already close to the first page, the most seen first. A page that answers the query better is the work; no result is promised.</div>
            <div style={{ overflowX: 'auto' }}><table className="mk-table" style={{ minWidth: 560 }}><thead><tr><th>QUERY</th><th>POSITION</th><th>SEEN</th><th>CLICKS</th><th /></tr></thead>
              <tbody>{qv.items.map((i) => (<tr key={i.query}><td><b>{i.query}</b></td><td>{i.position} <small style={{ color: 'var(--muted)' }}>({i.band})</small></td><td>{i.impressions}</td><td>{i.clicks}</td><td>{i.saved ? <Tag green>On the list</Tag> : <TinyBtn onClick={() => keep([{ phrase: i.query, group: 'query', source: 'search-console' }])} aria-label={`Keep ${i.query}`}>Keep</TinyBtn>}</td></tr>))}</tbody></table></div></div>
        ) : qv && qv.sets.length ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No query is at position 4 to 20 in the newest export.</div> : null}
      </Panel>
    </div>
  );
}

// ---- CONTENT ------------------------------------------------------------------------------------------------------------------------------------------------------------
const KINDS = [['meta', 'Title and description'], ['h1', 'Main heading'], ['alt', 'Alt text'], ['product', 'Product description'], ['landing', 'Location page'], ['faq', 'FAQ'], ['outline', 'Headings outline'], ['article', 'Article (AI)'], ['check', 'Check a text']];
function Options({ title, r, toast }) {
  if (!r) return null;
  return (<div style={{ margin: '8px 0' }}><div style={{ fontWeight: 800, fontSize: 13 }}>{title}</div>{r.options && r.options.length ? r.options.map((o, i) => <div key={i} style={{ margin: '6px 0' }}><CopyBox text={o.text} rows={2} toast={toast} mono={false} /><small style={{ color: 'var(--muted)' }}>{o.length} characters</small></div>) : <div style={{ fontSize: 12.5, color: '#8a6410' }}>Not written. It needs: {(r.needs || []).join(', ')}.</div>}{(r.notes || []).map((n, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n}</div>)}</div>);
}
function Flags({ checks }) {
  const tone = { stop: '#b91c1c', review: '#b45309', info: '#1d4fa8', ok: '#15803d' };
  return (<div style={{ margin: '8px 0' }}><div style={{ fontSize: 13 }}><b>{checks.words}</b> words, <b>{checks.sentences}</b> sentences, {checks.avgSentence} words per sentence{checks.phrase ? <>; the phrase "{checks.phrase.text}" appears <b>{checks.phrase.count}</b> time{checks.phrase.count === 1 ? '' : 's'} (<b>{checks.phrase.density}%</b> of the words)</> : null}.</div>
    <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12.5 }}>{checks.flags.map((f, i) => <li key={i} style={{ color: tone[f.level] || 'inherit' }}>{f.text}</li>)}</ul><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{checks.note}</div></div>);
}
export function ContentTab({ site, toast }) {
  const [kind, setKind] = useState('meta'); const [f, setF] = useState({ topic: '', what: '', name: '', features: '', price: '', audience: '', location: '', service: '', outlineKind: 'service', phrase: '', words: '700', notes: '', text: '', title: '', description: '' });
  const [busy, setBusy] = useState(false); const [out, setOut] = useState(null); const [ai, setAi] = useState(null); const [lib, setLib] = useState(null);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const loadLib = useCallback(() => omni.get(`/gs/marketing/seo/sites/${site.id}/content`).then(setLib).catch(() => setLib({ items: [] })), [site.id]);
  useEffect(() => { loadLib(); omni.get('/gs/marketing/seo/content/ai').then(setAi).catch(() => setAi({ ready: false, reason: 'The AI state could not be read.' })); }, [loadLib]);
  const go = async () => {
    setBusy(true); setOut(null);
    try {
      if (kind === 'check') setOut({ kind, checks: await omni.post('/gs/marketing/seo/content/check', { siteId: site.id, text: f.text, phrase: f.phrase, title: f.title || undefined, description: f.description || undefined }) });
      else if (kind === 'article') setOut({ kind, ...(await omni.post('/gs/marketing/seo/content/article', { siteId: site.id, topic: f.topic, phrase: f.phrase, words: Number(f.words), notes: f.notes }, { timeout: 90000 })) });
      else { const input = kind === 'alt' ? { what: f.what } : kind === 'product' ? { name: f.name, what: f.what, features: f.features, price: f.price, audience: f.audience } : kind === 'landing' ? { service: f.service, location: f.location } : kind === 'outline' ? { topic: f.topic, kind: f.outlineKind } : { topic: f.topic }; setOut({ kind, ...(await omni.post('/gs/marketing/seo/content/make', { siteId: site.id, kind, input })) }); }
    } catch (e) { toast(errOf(e, 'It could not be written.')); } finally { setBusy(false); }
  };
  const keepIt = async () => {
    const body = out.kind === 'article' ? out.article.markdown : out.kind === 'landing' ? out.result.text : out.kind === 'product' ? out.result.text : out.kind === 'faq' ? out.result.faq.map((q) => `${q.question}\n${q.ready ? q.answer : '[Answer from the client]'}`).join('\n\n') : out.kind === 'outline' ? [`H1: ${out.result.h1}`, ...out.result.h2.map((h) => `H2: ${h}`)].join('\n') : JSON.stringify(out.result);
    const title = out.kind === 'article' ? out.article.title : out.kind === 'landing' ? out.result.h1 : out.kind === 'product' ? out.result.name : '';
    try { await omni.post(`/gs/marketing/seo/sites/${site.id}/content`, { kind: out.kind, title, body }); toast('Kept in the library'); await loadLib(); } catch (e) { toast(errOf(e, 'It could not be kept.')); }
  };
  const mark = async (i, status) => { try { await omni.put(`/gs/marketing/seo/content/${i.id}`, { status }); await loadLib(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } };
  const del = async (i) => { try { await omni.del(`/gs/marketing/seo/content/${i.id}`); await loadLib(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  const inp = (k, label, o = {}) => <Field label={label} hint={o.hint}>{o.area ? <textarea rows={o.rows || 3} value={f[k]} onChange={(e) => set(k, e.target.value)} /> : <input value={f[k]} onChange={(e) => set(k, e.target.value)} maxLength={o.max || 160} />}</Field>;
  const need = { meta: true, h1: true, alt: f.what.trim().length > 2, product: f.name.trim() && f.what.trim(), landing: f.location.trim() || site.facts.city, faq: true, outline: f.topic.trim() || site.facts.services, article: f.topic.trim() && ai && ai.ready, check: f.text.trim().length > 20 }[kind];
  const r = out && out.result;
  return (
    <div>
      <Banner>Texts are written only from the facts saved for this client (Site and schedule): a missing fact is asked for, never made up. They are suggestions for the client's web person to paste; nothing is posted and no website is changed. {site.healthcare ? 'Healthcare: a doctor or qualified medical reviewer approves medical wording before it is published.' : ''}</Banner>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>{KINDS.map(([k, l]) => <Btn key={k} small primary={kind === k} onClick={() => { setKind(k); setOut(null); }}>{l}</Btn>)}</div>
      <Panel title={KINDS.find((x) => x[0] === kind)[1]} sub={{ meta: 'Page title (60 characters at most) and meta description (70 to 155).', h1: 'The single main heading of a page.', alt: 'Alternative text for a picture, from what it really shows.', product: 'A product page text from the product facts you type.', landing: 'A page for one area, with FAQ and business schema.', faq: 'Questions and the answers the facts give.', outline: 'The H1 and H2 headings of a page.', article: 'A full article, written by the AI model when one is ready, then checked.', check: 'Measure a text: how often a phrase repeats, sentence length, wording problems.' }[kind]}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          {kind === 'meta' || kind === 'h1' ? inp('topic', 'TOPIC (OPTIONAL)', { hint: 'Leave empty for the main service.' }) : null}
          {kind === 'alt' ? inp('what', 'WHAT THE PICTURE SHOWS', { hint: 'For example: doctor talking to a patient at the reception' }) : null}
          {kind === 'product' ? <>{inp('name', 'PRODUCT NAME')}{inp('what', 'WHAT IT IS (ONE LINE)')}{inp('price', 'PRICE (OPTIONAL)', { max: 40 })}{inp('audience', 'WHO IT IS FOR (OPTIONAL)')}{inp('features', 'FEATURES, ONE PER LINE', { area: true, rows: 4 })}</> : null}
          {kind === 'landing' ? <>{inp('service', 'SERVICE (OPTIONAL)', { hint: 'Default: the main service.' })}{inp('location', 'AREA OR CITY', { hint: site.facts.city ? `Default: ${site.facts.city}` : '' })}</> : null}
          {kind === 'outline' ? <>{inp('topic', 'TOPIC')}<Field label="KIND OF PAGE"><select value={f.outlineKind} onChange={(e) => set('outlineKind', e.target.value)}><option value="service">A service page</option><option value="guide">A guide</option></select></Field></> : null}
          {kind === 'article' ? <>{inp('topic', 'TOPIC')}{inp('phrase', 'FOCUS PHRASE (OPTIONAL)')}<Field label="LENGTH"><select value={f.words} onChange={(e) => set('words', e.target.value)}><option value="500">About 500 words</option><option value="700">About 700 words</option><option value="1000">About 1,000 words</option></select></Field>{inp('notes', 'NOTES FOR THE WRITER (OPTIONAL)', { area: true, rows: 2, max: 600 })}</> : null}
          {kind === 'check' ? <>{inp('text', 'THE TEXT', { area: true, rows: 6, max: 20000 })}{inp('phrase', 'FOCUS PHRASE (OPTIONAL)')}{inp('title', 'PAGE TITLE (OPTIONAL)')}{inp('description', 'META DESCRIPTION (OPTIONAL)')}</> : null}
          <Btn primary disabled={busy || !need} onClick={go}>{busy ? (kind === 'article' ? 'Writing… up to a minute' : 'Working…') : kind === 'check' ? 'Check the text' : kind === 'article' ? 'Write the article' : 'Write it'}</Btn>
        </div>
        {kind === 'article' && ai && !ai.ready ? <Banner tone="warn">An article needs an AI model, and none is ready: {ai.reason} Everything else here works without AI.</Banner> : null}
        {kind === 'article' && ai && ai.ready ? <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{ai.demo ? 'Test mode: a marked sample writer is used.' : `Written by the AI model (${ai.model || ai.provider}).`} It uses only the saved facts and writes [CLIENT TO CONFIRM] where one is missing. Counts toward the daily AI limit.</div> : null}
      </Panel>
      {out && !out.error ? (
        <Panel title="Result" right={out.kind !== 'check' ? <Btn small onClick={keepIt}>Keep in the library</Btn> : null} style={{ marginTop: 12 }}>
          {out.kind === 'meta' ? <><Options title="Page title" r={r.title} toast={toast} /><Options title="Meta description" r={r.description} toast={toast} /></> : null}
          {out.kind === 'h1' || out.kind === 'alt' ? <Options title={out.kind === 'h1' ? 'Main heading (H1)' : 'Alt text'} r={r} toast={toast} /> : null}
          {out.kind === 'product' ? <div><CopyBox text={r.text} rows={9} toast={toast} mono={false} /><div style={{ fontSize: 12.5, margin: '6px 0' }}>{r.words} words. Meta description ({r.metaLength}): {r.metaDescription}</div>{r.notes.map((n, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n}</div>)}</div> : null}
          {out.kind === 'landing' ? <div><div style={{ fontSize: 12.5, marginBottom: 6 }}>Address: <b>{r.url}</b> · Title ({r.titleLength}): {r.title}<br />Meta description: {r.metaDescription}</div><CopyBox text={r.text} rows={14} toast={toast} mono={false} />{r.sections.filter((s) => s.ask).map((s, i) => <div key={i} style={{ fontSize: 12, color: '#8a6410', marginTop: 4 }}>{s.ask}</div>)}{r.businessSchema ? <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Business schema</summary><CopyBox text={r.businessSchema} rows={8} toast={toast} /></details> : null}{r.faqSchema ? <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>FAQ schema</summary><CopyBox text={r.faqSchema} rows={8} toast={toast} /></details> : null}{r.needs.length ? <div style={{ fontSize: 12, color: '#8a6410' }}>Not in the page yet: {r.needs.join(', ')}.</div> : null}{r.notes.map((n, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n}</div>)}</div> : null}
          {out.kind === 'faq' ? <div>{r.faq.map((q, i) => <div key={i} style={{ margin: '6px 0', fontSize: 13 }}><b>{q.question}</b><div style={{ color: q.ready ? 'inherit' : '#8a6410' }}>{q.ready ? q.answer : 'Needs the client\'s own answer.'}</div></div>)}{r.schema ? <details><summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>FAQ schema (answered questions only)</summary><CopyBox text={r.schema} rows={8} toast={toast} /></details> : null}{r.notes.map((n, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n}</div>)}</div> : null}
          {out.kind === 'outline' ? <div><div style={{ fontSize: 14 }}><b>H1</b> {r.h1}</div>{r.h2.map((h, i) => <div key={i} style={{ fontSize: 13, paddingLeft: 14 }}><b>H2</b> {h}</div>)}{r.notes.map((n, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n}</div>)}</div> : null}
          {out.kind === 'article' ? <div><div style={{ fontSize: 12.5, marginBottom: 4 }}>Meta title ({out.article.metaTitle.length}): {out.article.metaTitle}<br />Meta description ({out.article.metaDescription.length}): {out.article.metaDescription}</div><CopyBox text={out.article.markdown} rows={16} toast={toast} mono={false} /><Flags checks={out.checks} />{out.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: '#8a6410' }}>{n}</div>)}</div> : null}
          {out.kind === 'check' ? <Flags checks={out.checks} /> : null}
        </Panel>
      ) : null}
      <Panel title="Library" sub="Texts kept for this client. Mark one Used when it is on the website." style={{ marginTop: 12 }}>
        {!lib ? <div>Loading…</div> : !lib.items.length ? <Empty title="Nothing kept yet">Write something above and press "Keep in the library".</Empty> : lib.items.map((i) => (
          <div key={i.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><b style={{ fontSize: 13 }}>{i.title}</b><Tag>{i.kindLabel}</Tag><Pill tone={i.status === 'used' ? 'live' : 'scheduled'}>{i.status === 'used' ? 'Used' : 'Ready'}</Pill><small style={{ color: 'var(--muted)' }}>{fmtDate(i.createdAt)}</small><span style={{ flex: 1 }} />{i.status === 'used' ? <TinyBtn onClick={() => mark(i, 'ready')}>Mark ready</TinyBtn> : <TinyBtn onClick={() => mark(i, 'used')}>Mark used</TinyBtn>}<TinyBtn onClick={() => del(i)} aria-label={`Remove ${i.title}`}>✕</TinyBtn></div>
            <details><summary style={{ cursor: 'pointer', fontSize: 12.5 }}>Show the text</summary><CopyBox text={i.body} rows={6} toast={toast} mono={false} /></details>
          </div>))}
      </Panel>
    </div>
  );
}

// ---- COMPETITORS ------------------------------------------------------------------------------------------------------------------------------------------------------
export function CompetitorsTab({ site, toast }) {
  const [urls, setUrls] = useState(() => [...site.competitors, '', '', ''].slice(0, 3)); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const run = async () => { setBusy(true); setRes(null); try { setRes(await omni.post('/gs/marketing/seo/competitor-topics', { siteId: site.id, client: site.url, clientName: site.clientName, competitors: urls.filter((u) => u.trim()) }, { timeout: 120000 })); } catch (e) { toast(errOf(e, 'The websites could not be read.')); } finally { setBusy(false); } };
  return (
    <div>
      <Banner>Each website is read once, like a visitor, with its sitemap. This shows what each site is about and where the client can say more. The words are what a page <b>stresses</b>, not keywords with traffic; <b>backlinks are not shown</b> because no backlink data provider is connected. For scores side by side use SEO & visibility &gt; Competitors.</Banner>
      <Panel title="Competitor websites" sub={`The client: ${site.url}`} style={{ marginTop: 10 }}>
        {urls.map((u, i) => <Field key={i} label={`COMPETITOR ${i + 1} WEBSITE`}><input value={u} placeholder="www.competitor.com" onChange={(e) => setUrls(urls.map((x, j) => (j === i ? e.target.value : x)))} /></Field>)}
        <Btn primary disabled={busy || !urls.some((u) => u.trim())} onClick={run}>{busy ? 'Reading the websites… up to a minute' : 'Read the websites'}</Btn>
      </Panel>
      {res ? (
        <div style={{ marginTop: 12 }}>
          {res.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0' }}>{n}</div>)}
          {res.gaps.length ? (
            <Panel title="Where the client can say more" sub="Words and phrases a competitor stresses that the client's home-page title, description and headings do not mention. Use one only if it is true for the client." style={{ marginTop: 8 }}>
              {res.gaps.map((g) => <div key={g.competitor} style={{ margin: '6px 0', fontSize: 13 }}><b>{g.competitor}</b>: {g.words.length || g.phrases.length ? <>{g.phrases.map((p) => <Tag key={p.term}>{p.term}</Tag>)} {g.words.map((w) => <Tag key={w.term}>{w.term}</Tag>)}</> : 'nothing the client does not already mention.'}</div>)}
            </Panel>
          ) : null}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginTop: 12 }}>
            {res.parties.map((p, i) => (
              <Panel key={p.url} title={`${p.name}${i === 0 ? ' (client)' : ''}`} sub={p.url}>
                {p.error ? <div style={{ fontSize: 13, color: '#b91c1c' }}>Could not be read: {p.error}</div> : (
                  <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                    <div><b>Title:</b> {p.title || 'none'}</div><div><b>Description:</b> {p.description || 'none'}</div><div><b>Main heading:</b> {p.h1.join(' | ') || 'none'}</div>
                    {p.h2.length ? <div><b>Sub-headings:</b> {p.h2.join(' · ')}</div> : null}
                    <div style={{ margin: '4px 0' }}><b>Stresses:</b> {p.terms.phrases.map((t) => <Tag key={t.term}>{t.term}</Tag>)} {p.terms.words.slice(0, 6).map((t) => <Tag key={t.term}>{t.term}</Tag>)}</div>
                    <div><b>Structured data:</b> {p.schemaTypes.join(', ') || 'none'} · {p.words} words on the page</div>
                    <div><b>Sitemap:</b> {p.sitemap.pages ? `${p.sitemap.pages} pages${p.sitemap.sections.length ? `; biggest sections ${p.sitemap.sections.slice(0, 4).map((s) => `${s.section} (${s.pages})`).join(', ')}` : ''}; ${[p.sitemap.hasBlog ? 'a blog' : '', p.sitemap.hasFaq ? 'a FAQ' : '', p.sitemap.hasPricing ? 'a pricing page' : ''].filter(Boolean).join(', ') || 'no blog, FAQ or pricing page found'}` : 'none found'}</div>
                  </div>)}
              </Panel>))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Backlinks: {res.backlinks.note}</div>
        </div>
      ) : null}
    </div>
  );
}

// ---- GOOGLE (phase 2): Search Console and Analytics 4, read-only, with the service account saved in Administration > Integrations -------------------------------------------------
const chg = (v) => (v == null ? null : <span style={{ color: v > 0 ? '#15803d' : v < 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}> ({v === 0 ? 'no change' : `${v > 0 ? '+' : ''}${v}%`})</span>);
export function GoogleSetup({ site, url, gsc, ga4, onGsc, onGa4, toast, onSynced }) {
  const [st, setSt] = useState(null); const [props, setProps] = useState(null); const [busy, setBusy] = useState(false); const [syncing, setSyncing] = useState(false); const [out, setOut] = useState(null);
  useEffect(() => { omni.get('/gs/marketing/seo/google/status').then(setSt).catch(() => setSt({ configured: false, problem: 'The Google state could not be read.' })); }, []);
  const loadProps = async () => { setBusy(true); try { const r = await omni.get('/gs/marketing/seo/google/properties', { ...(site ? { siteId: site.id } : {}), ...(url && url.trim() ? { url: url.trim() } : {}) }); setProps(r); if (r.suggest && !gsc) onGsc(r.suggest); } catch (e) { toast(errOf(e, 'The properties could not be read.')); } finally { setBusy(false); } };
  const sync = async () => { setSyncing(true); setOut(null); try { const r = await omni.post(`/gs/marketing/seo/sites/${site.id}/google/sync`, { what: 'both' }, { timeout: 120000 }); setOut(r); toast(`Google read: ${[r.gsc ? `Search Console ${r.gsc.totals.clicks} clicks` : '', r.ga4 ? `Analytics ${r.ga4.totals.now.sessions != null ? r.ga4.totals.now.sessions : 0} sessions` : ''].filter(Boolean).join(', ')}`); if (onSynced) onSynced(); } catch (e) { setOut({ error: errOf(e, 'Google could not be read.') }); } finally { setSyncing(false); } };
  const copy = (t) => { try { navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Select the email and copy it.')); } catch { toast('Select the email and copy it.'); } };
  return (
    <Panel title="Google Search Console and Analytics" sub="Real search and visitor numbers, read-only, free. TeamLink never changes anything in the client's Google account." style={{ marginTop: 14 }}>
      {!st ? <div style={{ fontSize: 13 }}>Checking…</div> : !st.configured ? (
        <Banner tone="warn">Google is not connected yet. {st.problem || 'An Admin makes a Google service account and pastes its JSON key in Administration > Integrations > "Search Console and Analytics (Google)".'} Until then the keyword positions come from the pasted Search Console export.</Banner>
      ) : (
        <div style={{ fontSize: 13, margin: '4px 0 8px' }}>Connected as <b>{st.email}</b> <TinyBtn onClick={() => copy(st.email)}>Copy the email</TinyBtn><br />
          <span style={{ color: 'var(--muted)' }}>Ask the client to add this email: in Search Console, Settings &gt; Users and permissions &gt; Add user (Restricted is enough); in Analytics, Admin &gt; Property access management &gt; Add (Viewer).</span></div>
      )}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <Field label="SEARCH CONSOLE PROPERTY" hint="Looks like sc-domain:example.com or https://www.example.com/"><input value={gsc} placeholder="sc-domain:example.com" style={{ minWidth: 260 }} onChange={(e) => onGsc(e.target.value.trim())} /></Field>
        {st && st.configured ? <Btn small disabled={busy} onClick={loadProps}>{busy ? 'Asking Google…' : 'Choose from the list'}</Btn> : null}
        <Field label="ANALYTICS 4 PROPERTY NUMBER" hint="Analytics > Admin > Property settings > Property ID"><input value={ga4} placeholder="123456789" inputMode="numeric" style={{ width: 170 }} onChange={(e) => onGa4(e.target.value.trim())} /></Field>
      </div>
      {props ? (props.problem ? <div style={{ fontSize: 12.5, color: '#8a6410', marginTop: 6 }}>{props.problem}</div> : props.items.length ? (
        <div style={{ marginTop: 6 }}><select aria-label="Search Console properties" value="" onChange={(e) => { if (e.target.value) onGsc(e.target.value); }}><option value="">Properties this service account can read ({props.items.length})</option>{props.items.map((p) => <option key={p.property} value={p.property}>{p.property}</option>)}</select>{props.suggest ? <small style={{ marginLeft: 8, color: 'var(--muted)' }}>Best fit for this website: {props.suggest}</small> : null}</div>
      ) : <div style={{ fontSize: 12.5, color: '#8a6410', marginTop: 6 }}>The service account is not a user of any Search Console property yet: no client has added it.</div>) : null}
      {site && st && st.configured ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn primary disabled={syncing || (!site.gscProperty && !site.ga4Property)} onClick={sync}>{syncing ? 'Reading Google…' : 'Read Google now'}</Btn>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{site.gscProperty || site.ga4Property ? 'Reads the saved properties (save any change first). A site on an automatic schedule is read again after every audit.' : 'Save a property first.'}</span>
        </div>
      ) : null}
      {out && out.error ? <Banner tone="error">{out.error}</Banner> : null}
      {out && !out.error && out.errors && out.errors.length ? <Banner tone="warn">{out.errors.map((e) => e.error).join(' ')}</Banner> : null}
      {out && out.gsc ? <div style={{ fontSize: 12.5, marginTop: 6 }}>Search Console: {out.gsc.totals.clicks} clicks and {out.gsc.totals.impressions} impressions, {out.gsc.period.start} to {out.gsc.period.end}; {out.gsc.queries} queries kept for the keyword list.</div> : null}
      {out && out.ga4 ? <div style={{ fontSize: 12.5 }}>Analytics: {out.ga4.totals.now.sessions} sessions, {out.ga4.totals.now.users} users, {out.ga4.period.start} to {out.ga4.period.end}.</div> : null}
    </Panel>
  );
}
// what Google answered last, on the dashboard
function GoogleBox({ site, onOpen }) {
  const g = site.google; if (!g) return null; const gs = g.gsc; const an = g.ga4;
  const has = Boolean(g.gscProperty || g.ga4Property);
  return (
    <Panel title="Google data" sub="Read from Search Console and Analytics for the last 28 days, compared with the 28 days before. Not an estimate." right={<TinyBtn onClick={() => onOpen(site.id, 'site')}>Google settings</TinyBtn>} style={{ marginTop: 14 }}>
      {!g.configured ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Google is not connected. An Admin pastes a service account key in Administration &gt; Integrations &gt; Search Console and Analytics (Google); then each client adds its email. Until then, use the Search Console export in the Keywords tab.</div>
        : !has ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Connected as {g.email}. Choose this client's Search Console property and Analytics number under Site and schedule.</div> : (
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start' }}>
            <div style={{ fontSize: 13 }}>
              <b>Search Console</b> <small style={{ color: 'var(--muted)' }}>{g.gscProperty}</small>
              {gs ? (<div>
                <div style={{ margin: '4px 0' }}>{gs.totals.clicks} clicks{chg(gs.change.clicks)} · {gs.totals.impressions} times seen{chg(gs.change.impressions)}<br />Average click rate {gs.totals.ctr != null ? `${gs.totals.ctr}%` : '—'} · average position {gs.totals.position != null ? gs.totals.position : '—'}</div>
                <Bars series={gs.series} /><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{gs.period.start} to {gs.period.end} (the newest days are not final, so the period ends 3 days ago). {gs.queries} queries kept for the keyword list. Read {fmtDate(g.gscAt)}.</div>
              </div>) : g.gscProperty ? <div style={{ color: 'var(--muted)' }}>Not read yet. Press "Read Google now" under Site and schedule.</div> : <div style={{ color: 'var(--muted)' }}>No property chosen.</div>}
              {g.gscError ? <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Last problem: {g.gscError}</div> : null}
            </div>
            <div style={{ fontSize: 13 }}>
              <b>Analytics 4</b> <small style={{ color: 'var(--muted)' }}>{g.ga4Property ? `property ${g.ga4Property}` : ''}</small>
              {an ? (<div>
                <div style={{ margin: '4px 0' }}>{an.totals.now.sessions} sessions{chg(an.change.sessions)} · {an.totals.now.users} users{chg(an.change.users)}<br />{an.totals.now.pageViews} page views{chg(an.change.pageViews)}<br />From search (Organic Search): {an.organic.now.sessions != null ? an.organic.now.sessions : 0} sessions{chg(an.change.organicSessions)}</div>
                {an.topPages.length ? <div style={{ fontSize: 12 }}>Most viewed: {an.topPages.slice(0, 5).map((p) => `${p.path} (${p.views})`).join(', ')}</div> : null}
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{an.period.start} to {an.period.end}. Read {fmtDate(g.ga4At)}.</div>
              </div>) : g.ga4Property ? <div style={{ color: 'var(--muted)' }}>Not read yet. Press "Read Google now" under Site and schedule.</div> : <div style={{ color: 'var(--muted)' }}>No property number.</div>}
              {g.ga4Error ? <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Last problem: {g.ga4Error}</div> : null}
            </div>
          </div>)}
    </Panel>
  );
}

// ---- the keyword and content panels of the dashboard --------------------------------------------------------------------------------------------------------------------
export function DashboardExtras({ site, onOpen }) {
  const k = site.keywords; const c = site.content;
  return (
    <div>
    <GoogleBox site={site} onOpen={onOpen} />
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14, alignItems: 'start', marginTop: 14 }}>
      <Panel title="Keyword opportunities" sub="Real queries from Search Console and the phrases kept for this client." right={<TinyBtn onClick={() => onOpen(site.id, 'keywords')}>Keywords</TinyBtn>}>
        {k ? (
          <div style={{ fontSize: 13 }}>
            <div>{k.saved} phrase{k.saved === 1 ? '' : 's'} kept, {k.tracked} tracked{k.withPosition ? `; ${k.improved} up, ${k.worse} down since the export before` : ''}.</div>
            {k.movers.length ? <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{k.movers.map((m) => <li key={m.phrase}>{m.phrase}: position {m.position} <span style={{ color: m.change > 0 ? '#15803d' : '#b91c1c', fontWeight: 700 }}>({m.change > 0 ? `up ${m.change}` : `down ${-m.change}`})</span></li>)}</ul> : null}
            {k.opportunities.length ? <div style={{ marginTop: 6 }}><b>Close to the first page</b> ({k.snapshot ? k.snapshot.label : ''}):<ul style={{ margin: '2px 0', paddingLeft: 18 }}>{k.opportunities.map((o) => <li key={o.query}>{o.query}: position {o.position}, seen {o.impressions} times</li>)}</ul></div> : <div style={{ color: 'var(--muted)', marginTop: 4 }}>{k.snapshot ? 'No query is at position 4 to 20 in the newest export.' : 'No Search Console export yet: import one in the Keywords tab to see real queries and positions.'}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Search volume and difficulty: not available (no data provider is connected).</div>
          </div>
        ) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>No keywords yet. Open the Keywords tab.</div>}
      </Panel>
      <Panel title="Content" sub="Texts kept for this client and the content findings of the audits." right={<TinyBtn onClick={() => onOpen(site.id, 'content')}>Content</TinyBtn>}>
        {c ? (
          <div style={{ fontSize: 13 }}>
            <div>{c.ready + c.used} text{c.ready + c.used === 1 ? '' : 's'} kept: {c.ready} ready, {c.used} used on the website.</div>
            <div style={{ marginTop: 4 }}>Content findings (titles, descriptions, headings, picture text, FAQ): {c.fix.open} to do, {c.fix.done} done and waiting, {c.fix.verified} fixed and confirmed.</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{c.ai.ready ? (c.ai.demo ? 'Articles: test sample writer.' : 'Articles: an AI model is ready.') : `Articles: ${c.ai.reason}`}</div>
          </div>
        ) : <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing kept yet. Open the Content tab.</div>}
      </Panel>
    </div>
    </div>
  );
}

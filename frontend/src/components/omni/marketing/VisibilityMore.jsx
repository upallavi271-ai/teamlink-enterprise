import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, TinyBtn, Panel, Banner, Field, fmtDate } from '../ui.jsx';

// SEO & visibility, the GEO work (2026-11-27): trusted listings (marketing/listings.js), the AI answers check a person does by hand (marketing/aiAnswers.js), and a doctor or staff profile (geoTools.profile).
const API = '/gs/marketing/visibility';
const grid = (min) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))`, gap: 10 });
const copyText = (text, toast, done = 'Copied') => { try { navigator.clipboard.writeText(text).then(() => toast(done), () => window.prompt('Copy:', text)); } catch { window.prompt('Copy:', text); } };
const Kinds = ({ value, onChange, industries }) => <select value={value} onChange={onChange}>{industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select>;

export function ListingsTab({ toast, industries }) {
  const [who, setWho] = useState({ clientName: '', industry: 'clinic' }); const [d, setD] = useState(null);
  const load = useCallback((q) => omni.get(`${API}/listings`, q).then(setD).catch((e) => toast(errOf(e, 'The listings could not be read.'))), [toast]);
  useEffect(() => { load({ clientName: '', industry: 'clinic' }); }, [load]);
  const ready = d && d.clientName && d.clientName === who.clientName.trim() && d.industry === who.industry;
  const save = async (p, patch) => { const row = { ...p, ...patch }; if (!row.status) return; try { await omni.put(`${API}/listings`, { clientName: d.clientName, place: p.key, status: row.status, url: row.url, note: row.note }); toast('Saved'); await load({ clientName: d.clientName, industry: d.industry }); } catch (e) { toast(errOf(e, 'It could not be saved.')); } };
  return (
    <Panel title="Trusted listings">
      <div style={{ ...grid(200), alignItems: 'end' }}>
        <Field label="CLIENT NAME"><input value={who.clientName} maxLength={120} onChange={(e) => setWho({ ...who, clientName: e.target.value })} /></Field>
        <Field label="KIND OF BUSINESS"><Kinds value={who.industry} industries={industries} onChange={(e) => setWho({ ...who, industry: e.target.value })} /></Field>
        <div><Btn primary disabled={!who.clientName.trim()} onClick={() => load({ clientName: who.clientName.trim(), industry: who.industry })}>Show this client</Btn></div>
      </div>
      {ready ? <div style={{ fontSize: 13, margin: '10px 0' }}><b>{d.counts.checked}</b> checked · <b>{d.counts.same.length}</b> same details · <b>{d.counts.wrong.length}</b> wrong · <b>{d.counts.missing.length}</b> not there</div> : null}
      {d ? (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="mk-table"><thead><tr><th>PLACE</th><th>WHAT IT IS</th><th>FOUND</th><th>LISTING ADDRESS</th><th>NOTE</th></tr></thead>
            <tbody>{d.places.map((p) => (
              <tr key={`${d.clientName}-${p.key}`}>
                <td><a href={p.link} target="_blank" rel="noopener noreferrer">{p.name}</a>{p.register ? <small style={{ display: 'block' }}>Official register</small> : null}</td>
                <td>{p.why}</td>
                <td><select aria-label={`found on ${p.name}`} disabled={!ready} value={ready ? p.status : ''} onChange={(e) => save(p, { status: e.target.value })}><option value="">Not checked</option>{d.statuses.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></td>
                <td><input aria-label={`listing address on ${p.name}`} disabled={!ready || !p.status} defaultValue={p.url} maxLength={400} onBlur={(e) => e.target.value !== p.url && save(p, { url: e.target.value })} /></td>
                <td><input aria-label={`note on ${p.name}`} disabled={!ready || !p.status} defaultValue={p.note} maxLength={300} onBlur={(e) => e.target.value !== p.note && save(p, { note: e.target.value })} /></td>
              </tr>
            ))}</tbody></table>
        </div>
      ) : <div style={{ fontSize: 12 }}>Loading…</div>}
    </Panel>
  );
}

const ASK_LINKS = [['ChatGPT', (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`], ['Perplexity', (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`], ['Google', (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`], ['Gemini', () => 'https://gemini.google.com/app']];
const NEW_RESULT = { engine: 'chatgpt', question: '', text: '', named: '', site: false, others: '', note: '' };

export function AiAnswersTab({ toast, industries }) {
  const [f, setF] = useState({ clientName: '', industry: 'clinic', city: '', specialty: '', services: '', website: '', phone: '' });
  const [qs, setQs] = useState(null); const [r, setR] = useState(NEW_RESULT); const [d, setD] = useState(null); const [month, setMonth] = useState(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7)); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setRes = (k) => (e) => setR({ ...r, [k]: k === 'site' ? e.target.checked : e.target.value });
  const client = f.clientName.trim();
  const load = useCallback(() => (client ? omni.get(`${API}/ai-answers`, { clientName: client, month }).then(setD).catch(() => setD(null)) : Promise.resolve(setD(null))), [client, month]);
  useEffect(() => { load(); }, [load]);
  const make = async () => { try { const x = await omni.post(`${API}/ai-answers/questions`, { name: client, industry: f.industry, city: f.city, specialty: f.specialty, services: f.services }); setQs(x.questions); } catch (e) { toast(errOf(e, 'The questions could not be made.')); } };
  const look = async () => { try { const x = await omni.post(`${API}/ai-answers/check`, { text: r.text, name: client, website: f.website, phone: f.phone }); setR({ ...r, named: x.named ? 'yes' : 'no', site: x.site }); toast(x.named ? 'The name is in the answer' : 'The name is not in the answer'); } catch (e) { toast(errOf(e, 'It could not be checked.')); } };
  const save = async () => { setBusy(true); try { await omni.post(`${API}/ai-answers`, { clientName: client, engine: r.engine, question: r.question, named: r.named === 'yes', site: r.site, others: r.others, note: r.note }); setR({ ...NEW_RESULT, engine: r.engine }); toast('Result saved'); await load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); } };
  const remove = async (x) => { try { await omni.del(`${API}/ai-answers/${x.id}`); toast('Removed'); await load(); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  return (
    <div>
      <Banner>Answers differ by person and day. This records what you saw; it is not a ranking.</Banner>
      <Panel title="1 · The client" style={{ marginTop: 10 }}>
        <div style={grid(180)}>
          <Field label="CLIENT NAME"><input value={f.clientName} maxLength={120} onChange={set('clientName')} /></Field>
          <Field label="KIND OF BUSINESS"><Kinds value={f.industry} industries={industries} onChange={set('industry')} /></Field>
          <Field label="CITY"><input value={f.city} maxLength={80} onChange={set('city')} /></Field>
          <Field label="MAIN SPECIALTY"><input value={f.specialty} maxLength={80} onChange={set('specialty')} /></Field>
          <Field label="SERVICES (SEPARATED BY COMMAS)"><input value={f.services} maxLength={300} onChange={set('services')} /></Field>
          <Field label="WEBSITE"><input value={f.website} maxLength={200} onChange={set('website')} /></Field>
          <Field label="PHONE"><input value={f.phone} maxLength={30} onChange={set('phone')} /></Field>
        </div>
        <div style={{ marginTop: 10 }}><Btn primary disabled={!client || !f.city.trim()} onClick={make}>Make the questions</Btn></div>
        {qs ? <div style={{ marginTop: 10 }}>{qs.map((q) => (
          <div key={q} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0', fontSize: 13 }}>
            <span style={{ flex: '1 1 260px' }}>{q}</span>
            <TinyBtn onClick={() => setR({ ...NEW_RESULT, engine: r.engine, question: q })}>Record</TinyBtn><TinyBtn onClick={() => copyText(q, toast, 'Question copied')}>Copy</TinyBtn>
            {ASK_LINKS.map(([w, url]) => <a key={w} className="tiny-btn" href={url(q)} target="_blank" rel="noopener noreferrer" onClick={w === 'Gemini' ? () => copyText(q, toast, 'Question copied: paste it in Gemini') : undefined}>{w}</a>)}
          </div>
        ))}</div> : null}
      </Panel>
      <Panel title="2 · What the answer showed" style={{ marginTop: 12 }}>
        <div style={grid(200)}>
          <Field label="QUESTION ASKED" full><input value={r.question} maxLength={300} onChange={setRes('question')} /></Field>
          <Field label="ASKED IN"><select value={r.engine} onChange={setRes('engine')}>{[['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'], ['google', 'Google AI Overview'], ['other', 'Other']].map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></Field>
        </div>
        <Field label="PASTE THE ANSWER (OPTIONAL, NOT SAVED)" full><textarea rows={4} value={r.text} onChange={setRes('text')} style={{ width: '100%' }} /></Field>
        <div style={{ marginBottom: 8 }}><TinyBtn disabled={!client || !r.text.trim()} onClick={look}>Check the pasted answer</TinyBtn></div>
        <div style={{ ...grid(180), alignItems: 'end' }}>
          <Field label="BUSINESS NAMED"><select value={r.named} onChange={setRes('named')}><option value="">Pick</option><option value="yes">Yes</option><option value="no">No</option></select></Field>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={r.site} onChange={setRes('site')} /> Website shown</label>
          <Field label="OTHERS NAMED"><input value={r.others} maxLength={400} onChange={setRes('others')} /></Field>
          <Field label="NOTE"><input value={r.note} maxLength={300} onChange={setRes('note')} /></Field>
          <div><Btn primary disabled={busy || !client || !r.question.trim() || !r.named} onClick={save}>Save result</Btn></div>
        </div>
      </Panel>
      <Panel title="3 · Results" style={{ marginTop: 12 }} right={<input type="month" aria-label="Month of the results" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}>
        {!d || !d.items.length ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{client ? 'No results in this month.' : 'Write the client name to see results.'}</div> : (
          <div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Named in <b>{d.counts.named}</b> of <b>{d.counts.asked}</b> · website shown in <b>{d.counts.site}</b></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="mk-table"><thead><tr><th>DATE</th><th>ASKED IN</th><th>QUESTION</th><th>NAMED</th><th>WEBSITE</th><th>OTHERS</th><th /></tr></thead>
                <tbody>{d.items.map((x) => <tr key={x.id}><td>{fmtDate(x.at)}</td><td>{x.engineWords}</td><td style={{ maxWidth: 260 }}>{x.question}</td><td>{x.named ? 'Yes' : 'No'}</td><td>{x.site ? 'Yes' : 'No'}</td><td>{x.others}</td><td><TinyBtn aria-label={`remove the result for ${x.question}`} title="Remove" onClick={() => remove(x)}>✕</TinyBtn></td></tr>)}</tbody></table>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

const NEW_PROFILE = { kind: 'doctor', name: '', role: '', qualification: '', regNo: '', council: '', specialty: '', services: '', languages: '', place: '', hours: '', phone: '', since: '', profileUrl: '', social: '', about: '' };
const PROFILE_FIELDS = [['name', 'NAME'], ['role', 'ROLE OR TITLE'], ['qualification', 'QUALIFICATIONS'], ['regNo', 'REGISTRATION NUMBER'], ['council', 'MEDICAL COUNCIL'], ['specialty', 'SPECIALITY'], ['services', 'SERVICES (SEPARATED BY COMMAS)'], ['languages', 'LANGUAGES'], ['place', 'WORKS AT'], ['hours', 'TIMINGS'], ['phone', 'PHONE'], ['since', 'PRACTISING SINCE (YEAR)'], ['profileUrl', 'PROFILE PAGE ADDRESS'], ['social', 'SOCIAL PAGE ADDRESSES']];

export function ProfilePanel({ toast }) {
  const [p, setP] = useState(NEW_PROFILE); const [res, setRes] = useState(null);
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const make = async () => { try { setRes(await omni.post(`${API}/profile`, p)); } catch (e) { toast(errOf(e, 'It could not be made.')); } };
  const box = (label, text, rows) => <div style={{ marginTop: 8 }}><b style={{ fontSize: 12.5 }}>{label}</b><textarea readOnly rows={rows} value={text} onFocus={(e) => e.target.select()} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} /><TinyBtn onClick={() => copyText(text, toast)}>Copy</TinyBtn></div>;
  return (
    <Panel title="4 · Doctor or staff profile" style={{ marginTop: 12 }}>
      <div style={grid(190)}>
        <Field label="PROFILE OF"><select value={p.kind} onChange={set('kind')}><option value="doctor">A doctor</option><option value="professional">A staff member or professional</option></select></Field>
        {PROFILE_FIELDS.map(([k, w]) => <Field key={k} label={w}><input value={p[k]} maxLength={300} onChange={set(k)} /></Field>)}
        <Field label="ABOUT (IN THEIR OWN WORDS)" full><textarea rows={3} value={p.about} maxLength={1200} onChange={set('about')} style={{ width: '100%' }} /></Field>
      </div>
      <div style={{ marginTop: 10 }}><Btn primary disabled={!p.name.trim()} onClick={make}>Make the profile</Btn></div>
      {res ? (
        <div>
          {res.warnings.length ? <Banner tone="warn">Check these words: {res.warnings.join(' · ')}</Banner> : null}
          {box('Profile words', res.text, 8)}{box('Profile schema', res.script, 8)}
          {res.missing.length ? <div style={{ fontSize: 12.5, marginTop: 6 }}>Not filled yet: {res.missing.join(', ')}.</div> : null}
          <div style={{ fontSize: 12, marginTop: 4 }}>{res.note}</div>
        </div>
      ) : null}
    </Panel>
  );
}

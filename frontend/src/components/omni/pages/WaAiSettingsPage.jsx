import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import Combo from '../../Combo.jsx';
import { useOmni } from '../omniContext.js';
import { PageHead, Panel, Field, Btn, Banner, Pill, Tabs, GsModal, ConfirmModal, Empty, fmtDateTime, fmtDate } from '../ui.jsx';
import { errOf } from '../omniApi.js';

// ---------------------------------------------------------------------------
// SETTINGS > WHATSAPP AI (Admin): the connection as it stands (tokens are typed in Administration > Integrations and are never shown), the AI settings, the marketing assistant,
// the knowledge base and what the AI did. Server: /api/omni-wa/settings, /assistant, /connection, /knowledge, /runs. The AI is OFF until an Admin switches it on.
// ---------------------------------------------------------------------------
const BASE = '/omni-wa';
const OUTCOME = { replied: ['live', 'Replied'], not_interested: ['draft', 'Not interested'], handoff_tool: ['warn', 'Passed to a person'], handoff_asked: ['warn', 'Asked for a person'], handoff_abuse: ['red', 'Abusive message'], handoff_limit: ['warn', 'Reply limit reached'], after_hours: ['draft', 'After working hours'], blocked_by_guard: ['red', 'Draft stopped by the safety check'], model_error: ['red', 'AI failed'], send_failed: ['red', 'Could not send'], paused: ['warn', 'A person is answering'], lead: ['draft', 'New number'], error: ['red', 'Error'] };

function Connection() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`${BASE}/connection`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'The connection could not be read.'))); }, []);
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!d) return <div className="small-muted">Loading…</div>;
  return (
    <Panel title="WhatsApp connection" sub="Phone number ID, access token and webhook verify token are kept encrypted on the server and are never shown here. Change them in Administration > Integrations.">
      {d.numbers.length === 0 && <p className="small-muted">No number in the list: the single connection in Administration &gt; Integrations is used.</p>}
      {d.numbers.map((n) => (
        <div key={n.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '6px 0' }}>
          <b>{n.label}</b><span className="small-muted">{n.display}</span><span className="small-muted">Number ID {n.phoneNumberId || '—'}</span>
          <Pill tone={n.active ? 'live' : 'draft'}>{n.active ? 'On' : 'Off'}</Pill>
          <Pill tone={n.hasToken ? 'live' : 'red'}>{n.hasToken ? 'Token saved' : 'No token'}</Pill>
          <Pill tone={n.hasVerifyToken ? 'live' : 'red'}>{n.hasVerifyToken ? 'Verify token saved' : 'No verify token'}</Pill>
          <Pill tone={n.hasAppSecret ? 'live' : 'red'}>{n.hasAppSecret ? 'App secret saved' : 'No app secret'}</Pill>
        </div>
      ))}
      <p className="small-muted">{d.webhook ? `Meta last called the webhook on ${fmtDateTime(d.webhook.at)}.` : 'Meta has not called the webhook yet.'} <Link to="/admin/integrations">Open Integrations</Link></p>
    </Panel>
  );
}

function AiForm() {
  const { toast } = useOmni();
  const [c, setC] = useState(null);
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`${BASE}/settings`).then((r) => { setC({ ...r.data.config, testNumbers: r.data.config.testNumbers.join(', ') }); setModel(r.data.model); }).catch((e) => setErr(errOf(e, 'The settings could not be read.'))); }, []);
  if (err && !c) return <Banner tone="warn">{err}</Banner>;
  if (!c || !fu) return <div className="small-muted">Loading…</div>;
  const set = (k) => (e) => setC((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.put(`${BASE}/settings`, c); setC({ ...r.data, testNumbers: r.data.testNumbers.join(', ') }); toast('Saved.'); } catch (e) { setErr(errOf(e, 'The settings could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <Panel title="AI assistant" sub="It answers only people who replied to a promotion, or a chat it is already in. Everyone else is left to your team.">
      {model && !model.available && <Banner tone="warn">The AI model is not ready: {model.reason || 'it does not answer'}. Until then people get the fallback message and the chat goes to a recruiter.</Banner>}
      {err && <Banner tone="warn">{err}</Banner>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={c.enabled} onChange={set('enabled')} /><b>AI replies on WhatsApp</b></label>
      <Field label="Only these numbers (for a test)" hint="Leave empty to answer everybody. With numbers here the AI answers only them."><input className="input" value={c.testNumbers} onChange={set('testNumbers')} placeholder="919876543210" /></Field>
      <Field label="Model" hint={`Empty = the app's model${model && model.model ? ` (${model.model})` : ''}`}><input className="input" value={c.model} onChange={set('model')} /></Field>
      <Field label="System prompt" hint="Who the assistant is and how it talks. The safety rules are added by TeamLink and cannot be removed here."><textarea className="input" rows={6} value={c.systemPrompt} onChange={set('systemPrompt')} /></Field>
      <Field label="Fallback message" hint="One short message, 300 letters at most. Sent when the AI cannot answer, outside working hours and when a chat goes to a person. Long rules go in the system prompt."><textarea className="input" rows={2} value={c.fallbackMessage} onChange={set('fallbackMessage')} /></Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={c.hoursOn} onChange={set('hoursOn')} /><span>Answer only in working hours (India time)</span></label>
      {c.hoursOn && (
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="From"><input className="input" type="time" value={c.hoursFrom} onChange={set('hoursFrom')} /></Field>
          <Field label="To"><input className="input" type="time" value={c.hoursTo} onChange={set('hoursTo')} /></Field>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <Field label="AI replies before a person takes over"><input className="input" type="number" min="1" max="50" value={c.maxTurns} onChange={set('maxTurns')} /></Field>
        <Field label="Messages it remembers"><input className="input" type="number" min="2" max="40" value={c.memoryCount} onChange={set('memoryCount')} /></Field>
        <Field label="Wait for more messages (seconds)"><input className="input" type="number" min="2" max="120" value={c.debounceSeconds} onChange={set('debounceSeconds')} /></Field>
        <Field label="A reply counts for a promotion for (days)"><input className="input" type="number" min="1" max="30" value={c.promoDays} onChange={set('promoDays')} /></Field>
      </div>
      <Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
    </Panel>
  );
}

// one WhatsApp number's own switch, instructions and fallback. Empty boxes = the default from AI settings.
function NumberCard({ n, saved, onChanged }) {
  const { toast } = useOmni();
  const [enabled, setEnabled] = useState(saved ? saved.enabled : true);
  const [systemPrompt, setPrompt] = useState((saved && saved.systemPrompt) || '');
  const [fallbackMessage, setFallback] = useState((saved && saved.fallbackMessage) || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.put(`${BASE}/profiles/${n.id}`, { enabled, systemPrompt, fallbackMessage }); toast('Saved.'); onChanged(); } catch (e) { setErr(errOf(e, 'This could not be saved.')); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setErr('');
    try { await api.delete(`${BASE}/profiles/${n.id}`); setEnabled(true); setPrompt(''); setFallback(''); toast('This number uses the default settings now.'); onChanged(); } catch (e) { setErr(errOf(e, 'This could not be changed.')); } finally { setBusy(false); }
  };
  return (
    <Panel title={n.label} sub={n.display}>
      {err && <Banner tone="warn">{err}</Banner>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><b>AI replies on this number</b></label>
      <Field label="Instructions for this number" hint="Empty = the system prompt from AI settings."><textarea className="input" rows={6} value={systemPrompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
      <Field label="Fallback message for this number" hint="One short message the candidate reads, 300 letters at most. Empty = the fallback from AI settings. Long rules go in the instructions."><textarea className="input" rows={2} maxLength={700} value={fallbackMessage} onChange={(e) => setFallback(e.target.value)} /></Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn primary onClick={save} disabled={busy}>Save</Btn>
        {saved && <Btn onClick={reset} disabled={busy}>Use the default</Btn>}
      </div>
    </Panel>
  );
}

function ByNumber() {
  const [numbers, setNumbers] = useState(null);
  const [saved, setSaved] = useState({});
  const [err, setErr] = useState('');
  const load = useCallback(() => Promise.all([api.get(`${BASE}/connection`), api.get(`${BASE}/profiles`)]).then(([c, p]) => {
    setNumbers(c.data.numbers);
    setSaved(Object.fromEntries(p.data.profiles.map((x) => [x.numberId, x])));
  }).catch((e) => setErr(errOf(e, 'The numbers could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!numbers) return <div className="small-muted">Loading…</div>;
  if (!numbers.length) return <Empty title="No numbers yet">Add WhatsApp numbers in Administration &gt; Integrations.</Empty>;
  return numbers.map((n) => <NumberCard key={`${n.id}${saved[n.id] ? saved[n.id].updatedAt : ''}`} n={n} saved={saved[n.id]} onChanged={load} />);
}

// what is asked after a candidate says YES: one question on each line
function Questions() {
  const { toast } = useOmni();
  const [text, setText] = useState(null);
  const [closing, setClosing] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`${BASE}/questions`).then((r) => { setText(r.data.list.join('\n')); setClosing(r.data.closing); }).catch((e) => setErr(errOf(e, 'The questions could not be read.'))); }, []);
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.put(`${BASE}/questions`, { list: text, closing }); setText(r.data.list.join('\n')); toast('Saved.'); } catch (e) { setErr(errOf(e, 'The questions could not be saved.')); } finally { setBusy(false); }
  };
  if (text === null) return err ? <Banner tone="warn">{err}</Banner> : <div className="small-muted">Loading…</div>;
  return (
    <Panel title="Questions after YES" sub="When a candidate replies YES, these are asked one at a time and saved on the chat. One question on each line.">
      {err && <Banner tone="warn">{err}</Banner>}
      <Field label="Questions" hint="[Job Role], [Location], [Salary] and [Work Mode] come from the requirement; a line is skipped when the requirement has no value. A line starting 'If working,' is skipped for someone not working."><textarea className="input" rows={20} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Closing message"><textarea className="input" rows={3} value={closing} onChange={(e) => setClosing(e.target.value)} /></Field>
      <Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
    </Panel>
  );
}

// the kinds of knowledge (AI WhatsApp Marketing Assistant): it quotes a price only from a Pricing entry, hours only from Working hours, and so on
const CATS = [['company', 'Company information'], ['services', 'Services'], ['products', 'Products'], ['pricing', 'Pricing'], ['hours', 'Working hours'], ['contact', 'Contact information'], ['policies', 'Policies'], ['faq', 'Questions and answers'], ['website', 'From our website']];
const CAT_LABEL = Object.fromEntries(CATS);
const NEW_KINDS = CATS.filter(([k]) => k !== 'website'); // the website import fills in its own kind
const DAY_MS = 86400000;
const STALE_DAYS = 90;
const HINTS = {
  pricing: 'Write the price exactly as it should be sent: what it is for, the amount, and GST or what it covers. It is sent word for word and never changed. 400 letters at most.',
  hours: 'For example: We are open Monday to Saturday, 9:30 am to 6:30 pm. Closed on Sundays and public holidays.',
  contact: 'Phone number, e-mail, address and any booking link. A link written here is sent as it is.',
  policies: 'Refunds, cancellation, payment terms, anything the business has decided. Written exactly as it should be said.',
};

function KbImport({ numbers, onClose, onDone }) {
  const [text, setText] = useState('');
  const [numberId, setNumberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState(null);
  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setText(String(r.result || ''));
    r.readAsText(f);
  };
  const go = async () => {
    setBusy(true); setErr(''); setRes(null);
    try { const r = await api.post(`${BASE}/knowledge/import`, { text, numberId }); setRes(r.data); onDone(); } catch (e) {
      setErr(errOf(e, 'The list could not be imported.'));
      if (e.response && e.response.data && e.response.data.errors) setRes({ errors: e.response.data.errors });
    } finally { setBusy(false); }
  };
  return (
    <GsModal title="Paste or upload a list" onClose={onClose} foot={<Btn primary onClick={go} disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import'}</Btn>}>
      {err && <Banner tone="warn">{err}</Banner>}
      {res && res.ok && <Banner tone="ok">{res.added} added, {res.updated} updated.</Banner>}
      <p className="small-muted">One entry on each line: <b>kind | question | answer</b>, for example <code>pricing | SEO plan | ₹10,000 per month + GST</code>. Kinds: company, services, products, pricing, hours, contact, policies, faq. A file with the columns category, question, answer (comma separated) works too. An entry with the same question is updated, not doubled.</p>
      <Field label="Upload a file (.csv or .txt)"><input type="file" accept=".csv,.txt,.tsv,text/plain,text/csv" aria-label="Upload a list" onChange={pick} /></Field>
      <Field label="The list"><textarea className="input" rows={9} aria-label="The list" value={text} onChange={(e) => setText(e.target.value)} placeholder="pricing | SEO plan | ₹10,000 per month + GST" /></Field>
      <Field label="Which WhatsApp number?">
        <Combo value={numberId} onChange={(e) => setNumberId(e.target.value)} emptyText="No such number">
          <option value="">All numbers</option>
          {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </Combo>
      </Field>
      {res && res.errors && res.errors.length > 0 && (
        <div className="small-muted" style={{ marginTop: 8 }}>
          <b>These lines were not imported:</b>
          {res.errors.slice(0, 12).map((x, i) => <div key={`${x.line}-${i}`}>{x.line ? `Line ${x.line}: ` : ''}{x.reason}</div>)} {/* eslint-disable-line react/no-array-index-key */}
        </div>
      )}
    </GsModal>
  );
}

function Knowledge() {
  const { toast } = useOmni();
  const [numbers, setNumbers] = useState([]);
  useEffect(() => { api.get(`${BASE}/connection`).then((r) => setNumbers(r.data.numbers)).catch(() => setNumbers([])); }, []);
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [gone, setGone] = useState(null);
  const [importing, setImporting] = useState(false);
  const [cat, setCat] = useState('all');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get(`${BASE}/knowledge`).then((r) => setRows(r.data.entries)).catch((e) => setErr(errOf(e, 'The entries could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    setErr('');
    try {
      if (edit.id) await api.put(`${BASE}/knowledge/${edit.id}`, edit); else await api.post(`${BASE}/knowledge`, edit);
      setEdit(null); toast('Saved.'); load();
    } catch (e) { setErr(errOf(e, 'This could not be saved.')); }
  };
  const remove = async () => { await api.delete(`${BASE}/knowledge/${gone.id}`).catch(() => {}); setGone(null); load(); };
  const counts = {};
  for (const r of rows || []) counts[r.category] = (counts[r.category] || 0) + 1;
  const shown = (rows || []).filter((r) => cat === 'all' || r.category === cat);
  const isPrice = edit && edit.category === 'pricing';
  const age = (r) => (r.confirmedAt ? Math.floor((Date.now() - r.confirmedAt) / DAY_MS) : null);
  return (
    <Panel title="Knowledge base" sub="What the AI answers from. Give each entry a kind: the marketing assistant quotes a price only from a Pricing entry, and says plainly when nothing fits." right={<><Btn small onClick={() => setImporting(true)}>Paste or upload a list</Btn> <Btn primary small onClick={() => setEdit({ question: '', answer: '', active: true, category: cat !== 'all' && cat !== 'website' ? cat : 'faq' })}>New</Btn></>}>
      {err && !edit && <Banner tone="warn">{err}</Banner>}
      <Tabs tabs={[['all', 'All', (rows || []).length], ...CATS.filter(([k]) => counts[k]).map(([k, l]) => [k, l, counts[k]])]} value={cat} onChange={setCat} />
      {rows && rows.length === 0 && <Empty title="No entries yet">Add what customers ask most: services, prices, working hours, contact details and policies. Without an entry the AI passes the question to your team.</Empty>}
      {shown.map((r) => {
        const days = r.category === 'pricing' ? age(r) : null;
        return (
          <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ flex: 1 }}>{r.question}</b>
              <Pill>{CAT_LABEL[r.category] || r.category}</Pill>
              {r.legacy && !r.numberId && <Pill tone="warn">Recruitment AI only</Pill>}
              <Pill>{(numbers.find((n) => n.id === r.numberId) || {}).label || 'All numbers'}</Pill>
              {!r.active && <Pill>Off</Pill>}
              <Btn small onClick={() => setEdit(r)}>Edit</Btn><Btn small danger onClick={() => setGone(r)}>Delete</Btn>
            </div>
            <div className="small-muted" style={{ whiteSpace: 'pre-wrap' }}>{r.answer}</div>
            {r.category === 'pricing' && <div className="small-muted">{days === null ? 'Not confirmed yet.' : `Price confirmed ${fmtDate(r.confirmedAt)}.`}{days !== null && days > STALE_DAYS ? ` It is ${days} days old: check it is still right, then save it again.` : ''}</div>}
          </div>
        );
      })}
      {edit && (
        <GsModal title={edit.id ? 'Edit entry' : 'New entry'} onClose={() => setEdit(null)} foot={<Btn primary onClick={save}>Save</Btn>}>
          {err && <Banner tone="warn">{err}</Banner>}
          <Field label="Kind" hint={edit.legacy && !edit.numberId ? 'This entry was written before kinds existed and is read by the recruitment AI. Choose a kind to let the marketing assistant use it too.' : (HINTS[edit.category] || undefined)}>
            <select className="input" aria-label="Kind" value={edit.category || 'faq'} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
              {(edit.category === 'website' ? CATS : NEW_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label={isPrice ? 'Plan or service' : 'Question or title'}><input className="input" aria-label="Question or title" maxLength={isPrice ? 120 : 300} value={edit.question} onChange={(e) => setEdit({ ...edit, question: e.target.value })} /></Field>
          <Field label={isPrice ? 'Price, exactly as it is sent' : 'Answer'}><textarea className="input" aria-label="Answer" rows={isPrice ? 3 : 5} maxLength={isPrice ? 400 : 1500} value={edit.answer} onChange={(e) => setEdit({ ...edit, answer: e.target.value })} /></Field>
          <Field label="Which WhatsApp number?">
            <Combo value={edit.numberId || ''} onChange={(e) => setEdit({ ...edit, numberId: e.target.value })} emptyText="No such number">
              <option value="">All numbers</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </Combo>
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />In use</label>
        </GsModal>
      )}
      {importing && <KbImport numbers={numbers} onClose={() => setImporting(false)} onDone={load} />}
      {gone && <ConfirmModal title="Delete this entry?" text={gone.question} yes="Delete" danger onYes={remove} onNo={() => setGone(null)} />}
    </Panel>
  );
}

// the AI WhatsApp Marketing Assistant: its switch, its words, which numbers it answers on, and a box to try a question (nothing is sent)
function Assistant() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [c, setC] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [marketing, setMarketing] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [tryNumber, setTryNumber] = useState('');
  const [ans, setAns] = useState(null);
  const [fu, setFuState] = useState(null);
  const [fuBusy, setFuBusy] = useState(false);
  const [fuErr, setFuErr] = useState('');
  const fromApi = (s) => ({ enabled: s.enabled, approval: s.approval, hours: s.intervalsHours.join(', '), tplName: s.template.name, tplLang: s.template.language, tplVars: s.template.vars.join(', ') });
  const load = useCallback(() => Promise.all([api.get(`${BASE}/assistant`), api.get(`${BASE}/connection`), api.get(`${BASE}/followup-settings`)]).then(([a, cn, f]) => {
    setD(a.data); setC(a.data.settings); setMarketing(a.data.marketingNumbers); setNumbers(cn.data.numbers); setFuState(fromApi(f.data.settings));
  }).catch((e) => setErr(errOf(e, 'The assistant could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err && !c) return <Banner tone="warn">{err}</Banner>;
  if (!c) return <div className="small-muted">Loading…</div>;
  const set = (k) => (e) => setC((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setFu = (k) => (e) => setFuState((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const saveFu = async () => {
    setFuBusy(true); setFuErr('');
    try { const r = await api.put(`${BASE}/followup-settings`, { enabled: fu.enabled, approval: fu.approval, intervalsHours: fu.hours, template: { name: fu.tplName, language: fu.tplLang, vars: fu.tplVars } }); setFuState(fromApi(r.data.settings)); toast('Saved.'); } catch (e) { setFuErr(errOf(e, 'The follow-ups could not be saved.')); } finally { setFuBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.put(`${BASE}/assistant`, c); setC(r.data.settings); toast('Saved.'); } catch (e) { setErr(errOf(e, 'The assistant could not be saved.')); } finally { setBusy(false); }
  };
  const flip = async (n, on) => {
    setErr('');
    try { const r = await api.put(`${BASE}/assistant/numbers/${n.id}`, { on }); setMarketing(r.data.numbers); } catch (e) { setErr(errOf(e, 'This number could not be changed.')); }
  };
  const ask = async () => {
    setErr(''); setAns(null);
    try { const r = await api.post(`${BASE}/assistant/ask`, { question: q, numberId: tryNumber }); setAns(r.data); } catch (e) { setErr(errOf(e, 'The question could not be tried.')); }
  };
  return (
    <>
      <Panel title="AI WhatsApp Marketing Assistant" sub="On a marketing number it answers customers from the knowledge base, word for word. It never makes up a price, an offer or a policy: when nothing fits it says so and asks your team. It works without an AI model.">
        {err && <Banner tone="warn">{err}</Banner>}
        {d && !d.aiReady && <Banner tone="info">No AI model is ready right now. The assistant still answers from the knowledge base. A model, when ready, may only re-word entries and its words are checked.</Banner>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" aria-label="The assistant answers on marketing numbers" checked={c.enabled} onChange={set('enabled')} /><b>The assistant answers on marketing numbers</b></label>
        <Field label="Business name" hint="Used in the greeting and in the first reply, like: Acme's AI assistant: ..."><input className="input" aria-label="Business name" value={c.businessName} onChange={set('businessName')} /></Field>
        <Field label="Greeting (optional)" hint="Sent when someone writes Hi. Empty = a greeting that names only the topics you have entries for."><textarea className="input" rows={2} aria-label="Greeting" maxLength={300} value={c.greeting} onChange={set('greeting')} /></Field>
        <Field label="When nothing in the knowledge base fits (optional)" hint="Sent before the chat goes to your team. Empty = a plain sentence that says it will not guess."><textarea className="input" rows={2} aria-label="When nothing fits" maxLength={300} value={c.noAnswer} onChange={set('noAnswer')} /></Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={c.aiWording} onChange={set('aiWording')} /><span>When no entry matches clearly and a model is ready, it may re-word the closest entries</span></label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" aria-label="Collect lead details" checked={c.collectLeads !== false} onChange={set('collectLeads')} /><span>When a customer shows interest, ask for their name, the service, what they need, a budget and the best time to call, and save the lead in the CRM (Leads, source WhatsApp). The details are kept only to follow up on the enquiry.</span></label>
        <Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>
      </Panel>
      <Panel title="Marketing numbers" sub="The assistant answers on these numbers only. Everyone who writes to one gets an answer from the knowledge base. Other numbers keep the recruitment AI.">
        {numbers.length === 0 && <p className="small-muted">No number in the list. Add WhatsApp numbers in Administration &gt; Integrations.</p>}
        {numbers.map((n) => (
          <label key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <input type="checkbox" aria-label={`${n.label} is a marketing number`} checked={marketing.includes(n.id)} onChange={(e) => flip(n, e.target.checked)} /><b>{n.label}</b><span className="small-muted">{n.display}</span>
          </label>
        ))}
      </Panel>
      <Panel title="Follow-ups" sub="A customer who showed interest and then went quiet gets a short, personal follow-up written from what they told the assistant. It stops by itself at STOP, at a no, when they write back, or when a person takes the chat.">
        {fuErr && <Banner tone="warn">{fuErr}</Banner>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" aria-label="Send follow-ups" checked={fu.enabled} onChange={setFu('enabled')} /><b>Follow up with customers who went quiet</b></label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" aria-label="A team member approves each follow-up" checked={fu.approval} onChange={setFu('approval')} /><span>A team member approves each follow-up before it is sent (recommended)</span></label>
        <Field label="Hours of silence before each follow-up" hint="For example 4, 48, 120: the first follow-up after 4 hours of silence, the second 48 hours after that, and so on. At most five."><input className="input" aria-label="Follow-up hours" value={fu.hours} onChange={setFu('hours')} /></Field>
        <Banner tone="info">WhatsApp lets us write free text only within 24 hours of the customer's last message. A follow-up later than that can only go as a template that Meta has approved, and only to a customer whose consent is recorded. Make the template in Omni-Channel &gt; Templates, wait for its approval, then type its exact name here. Without it, a late follow-up waits with the reason shown and is never sent.</Banner>
        <Field label="Approved template for follow-ups after 24 hours" hint="Exactly as it is at Meta, for example tl_followup. Empty = none."><input className="input" aria-label="Follow-up template" value={fu.tplName} onChange={setFu('tplName')} /></Field>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Template language"><input className="input" aria-label="Template language" style={{ width: 90 }} value={fu.tplLang} onChange={setFu('tplLang')} /></Field>
          <Field label="What fills the template's blanks, in order" hint="From: name, service, requirement, business, callback. For example: name, service."><input className="input" aria-label="Template blanks" value={fu.tplVars} onChange={setFu('tplVars')} /></Field>
        </div>
        <Btn primary onClick={saveFu} disabled={fuBusy}>{fuBusy ? 'Saving…' : 'Save follow-ups'}</Btn>
      </Panel>
      <Panel title="Try a question" sub="See what a customer would get. Nothing is sent to anybody.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 220 }} aria-label="A customer question" value={q} onChange={(e) => { setQ(e.target.value); setAns(null); }} placeholder="How much is the SEO plan?" />
          <Combo value={tryNumber} onChange={(e) => setTryNumber(e.target.value)} emptyText="No such number">
            <option value="">Entries for all numbers</option>
            {numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </Combo>
          <Btn onClick={ask} disabled={!q.trim()}>Try</Btn>
        </div>
        {ans && (
          <div style={{ marginTop: 10 }}>
            <p>{ans.handover ? <Pill tone="warn">Not in the knowledge base: a team member would be asked</Pill> : <Pill tone="live">From the knowledge base{ans.category ? `: ${CAT_LABEL[ans.category] || ans.category}` : ''}</Pill>}</p>
            <div style={{ whiteSpace: 'pre-wrap', padding: 10, background: 'var(--bg-soft, #f5f6f8)', borderRadius: 8 }}>{ans.text}</div>
            {ans.why && <p className="small-muted">{ans.why}</p>}
            {ans.entries && ans.entries.length > 0 && <p className="small-muted">Taken from: {ans.entries.map((e) => e.title).join(', ')}</p>}
            {ans.closest && ans.closest.length > 0 && <p className="small-muted">Closest entries: {ans.closest.join(', ')}</p>}
          </div>
        )}
      </Panel>
    </>
  );
}

// a number that wrote STOP gets nothing and the AI stays out, until an Admin takes it off the lists with a reason
function Blocked() {
  const { toast } = useOmni();
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true); setErr(''); setState(null);
    try { const r = await api.get(`${BASE}/blocked`, { params: { number } }); setState(r.data); } catch (e) { setErr(errOf(e, 'The number could not be checked.')); } finally { setBusy(false); }
  };
  const unblock = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post(`${BASE}/unblock`, { number, reason }); setState(r.data); setReason(''); toast('Unblocked.'); } catch (e) { setErr(errOf(e, 'The number could not be unblocked.')); } finally { setBusy(false); }
  };
  return (
    <Panel title="Blocked numbers" sub="A number that wrote STOP gets no messages and no AI replies. Unblock it only if the person asked to hear from you again.">
      {err && <Banner tone="warn">{err}</Banner>}
      <Field label="Mobile number"><input className="input" value={number} onChange={(e) => { setNumber(e.target.value); setState(null); }} placeholder="9876543210" /></Field>
      <Btn onClick={check} disabled={busy || !number.trim()}>Check</Btn>
      {state && !state.blocked && <p style={{ marginTop: 10 }}><Pill tone="live">Not blocked</Pill></p>}
      {state && state.blocked && (
        <div style={{ marginTop: 10 }}>
          <p><Pill tone="red">Blocked</Pill> {state.since ? <span className="small-muted">since {fmtDateTime(state.since)}</span> : null}</p>
          <Field label="Why may they be messaged again?"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Btn primary onClick={unblock} disabled={busy || reason.trim().length < 5}>Unblock</Btn>
        </div>
      )}
    </Panel>
  );
}

function Runs() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`${BASE}/runs`).then((r) => setRows(r.data.runs)).catch((e) => setErr(errOf(e, 'The log could not be read.'))); }, []);
  if (err) return <Banner tone="warn">{err}</Banner>;
  return (
    <Panel title="What the AI did" sub="The newest 100 runs: what came in, the tools it used, what it answered and any error.">
      {rows && rows.length === 0 && <Empty title="Nothing yet">The AI has not answered anybody.</Empty>}
      {(rows || []).map((r) => {
        const [tone, word] = OUTCOME[r.outcome] || ['draft', r.outcome];
        return (
          <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
            <button type="button" className="tiny-btn" style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center' }} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <Pill tone={tone}>{word}</Pill><span>{r.name || 'Unknown'}</span><span className="small-muted" style={{ marginLeft: 'auto' }}>{fmtDateTime(r.at)}{r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}</span>
            </button>
            {open === r.id && (
              <div className="small-muted" style={{ whiteSpace: 'pre-wrap', padding: 6 }}>
                <div><b>In:</b> {r.input}</div>
                {r.toolCalls.map((t, i) => <div key={i}><b>Tool:</b> {t.tool} {JSON.stringify(t.args)}</div>)} {/* eslint-disable-line react/no-array-index-key */}
                {r.output && <div><b>Out:</b> {r.output}</div>}
                {r.error && <div><b>Problem:</b> {r.error}</div>}
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

export default function WaAiSettingsPage() {
  const [tab, setTab] = useState('ai');
  return (
    <>
      <PageHead title="WhatsApp AI" lead="The AI assistant that answers replies to your promotions." />
      <Tabs tabs={[['ai', 'AI settings'], ['assist', 'Marketing assistant'], ['numbers', 'By number'], ['questions', 'Questions'], ['kb', 'Knowledge base'], ['runs', 'What the AI did'], ['blocked', 'Blocked numbers'], ['conn', 'Connection']]} value={tab} onChange={setTab} />
      {tab === 'ai' && <AiForm />}
      {tab === 'assist' && <Assistant />}
      {tab === 'numbers' && <ByNumber />}
      {tab === 'questions' && <Questions />}
      {tab === 'kb' && <Knowledge />}
      {tab === 'runs' && <Runs />}
      {tab === 'blocked' && <Blocked />}
      {tab === 'conn' && <Connection />}
    </>
  );
}

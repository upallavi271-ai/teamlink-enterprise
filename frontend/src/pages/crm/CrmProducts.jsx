// ---------------------------------------------------------------------------
// OUR PRODUCTS IN THE CRM (founder 2026-11-17: sell HRMS, ATS and Omni-Channel). Two pieces, both inside existing CRM screens (never a 6th sidebar item):
//   ProductSellBox   the "Products & demo" tab of a lead: which product(s) the lead wants, send the demo (link / WhatsApp / email; the demo page
//                    plays only that product's part of the video), the AI meeting link, and every AI meeting with its summary and transcript
//   ProductCatalog   the "Our products" tab of Leads: name, tagline, about, features, plans and prices, FAQ the AI answers from (managers edit)
// Backend: crm/productSales.js, routes/crm.js (/crm/products, /crm/leads/:id/products|demo|ai-meeting|ai-meetings), public pages routes/crmProductPages.js.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle
import { VideoStudio, SingleUpload, VideosSection } from './CrmProductVideo.jsx'; // eslint-disable-line import/no-cycle

const copy = async (text, toast, words) => {
  try { await navigator.clipboard.writeText(text); toast(words || 'Copied.'); } catch { window.prompt('Copy this:', text); } // eslint-disable-line no-alert
};
const DECISION = { yes: 'Interested - wants to go ahead', later: 'Needs time', no: 'Not interested' };

export function ProductSellBox({ lead, canEdit, onChanged }) {
  const { toast } = useCrm();
  const [all, setAll] = useState(null);
  const [mine, setMine] = useState([]);
  const [meetings, setMeetings] = useState(null);
  const [out, setOut] = useState(null); // { url, whatsappUrl, text } of the last demo link
  const [meet, setMeet] = useState('');
  const [open, setOpen] = useState(null); // the meeting whose transcript is open
  const [busy, setBusy] = useState(false);
  const load = () => {
    api.get('/crm/products').then((r) => setAll(r.data.products || [])).catch(() => setAll([]));
    api.get(`/crm/leads/${lead.id}/ai-meetings`).then((r) => { setMeetings(r.data.meetings || []); setMine(r.data.products || []); }).catch(() => setMeetings([]));
  };
  useEffect(load, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(key) {
    const next = mine.includes(key) ? mine.filter((k) => k !== key) : [...mine, key];
    setMine(next);
    try { await api.post(`/crm/leads/${lead.id}/products`, { products: next }); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'This could not be saved.')); load(); }
  }
  async function demo(channel) {
    setBusy(true);
    try {
      const r = await api.post(`/crm/leads/${lead.id}/demo`, { channel, products: mine });
      setOut(r.data);
      if (channel === 'email') toast(`Demo sent by email to ${lead.email}.`);
      else if (channel === 'whatsapp' && r.data.whatsappUrl) window.open(r.data.whatsappUrl, '_blank', 'noopener');
      else await copy(r.data.url, toast, 'Demo link copied.');
      if (onChanged) onChanged();
    } catch (e) { toast(errOf(e, 'The demo link could not be made.')); }
    setBusy(false);
  }
  async function meeting() {
    setBusy(true);
    try { const r = await api.post(`/crm/leads/${lead.id}/ai-meeting`, { products: mine }); setMeet(r.data.url); await copy(r.data.url, toast, 'AI meeting link copied.'); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The meeting link could not be made.')); }
    setBusy(false);
  }

  if (!all) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="section-label" style={{ marginTop: 0 }}>1 · What the lead wants</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {all.map((p) => {
            const on = mine.includes(p.key);
            return (
              <button key={p.key} type="button" disabled={!canEdit} onClick={() => toggle(p.key)} className={`btn${on ? ' btn-primary' : ''}`} aria-pressed={on} title={p.tagline}>
                {on ? '✓ ' : ''}{p.name}{p.hasVideo ? '' : ' (no video yet)'}
              </button>
            );
          })}
        </div>
        <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>The demo and the AI meeting show only the products ticked here.</div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="section-label" style={{ marginTop: 0 }}>2 · Send the demo</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={!canEdit || busy || !mine.length} onClick={() => demo('whatsapp')} title={lead.phone ? `Opens WhatsApp to ${lead.phone} with the message ready` : 'The lead has no phone number'}>Send on WhatsApp</button>
          <button type="button" className="btn" disabled={!canEdit || busy || !mine.length || !lead.email} onClick={() => demo('email')} title={lead.email || 'The lead has no email'}>Send by email</button>
          <button type="button" className="btn" disabled={!canEdit || busy || !mine.length} onClick={() => demo('link')}>Copy demo link</button>
        </div>
        {out && (
          <div className="small-muted" style={{ marginTop: 8, fontSize: 12.5, wordBreak: 'break-all' }}>
            Demo link: <a href={out.url} target="_blank" rel="noopener noreferrer">{out.url}</a>
          </div>
        )}
        <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>When the lead opens it, plays it, or presses “I’m interested”, it shows on the timeline and you get a bell. “I’m interested” takes them straight into the AI meeting.</div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="section-label" style={{ marginTop: 0 }}>3 · AI meeting</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn" disabled={!canEdit || busy || !mine.length} onClick={meeting}>Copy AI meeting link</button>
          {meet && <a href={meet} target="_blank" rel="noopener noreferrer" className="small-muted" style={{ fontSize: 12.5 }}>Open it ↗</a>}
        </div>
        <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>The AI presents the product, answers questions by text or voice from the product details in “Our products”, and never makes up a price or a discount. At the end the lead picks Go ahead / Need time / Not for now: Go ahead marks the lead Qualified and gives you a follow-up to send the proposal.</div>
      </div>

      <QuoteBox lead={lead} all={all} mine={mine} canEdit={canEdit} onChanged={onChanged} />

      <div className="section-label">AI meetings ({(meetings || []).length})</div>
      {meetings == null && <div className="small-muted">Loading…</div>}
      {meetings && !meetings.length && <div className="small-muted">No AI meeting yet.</div>}
      {(meetings || []).map((m) => {
        const s = m.summary || {};
        return (
          <div key={m.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <b>{(m.products || '').split(',').join(', ')}</b>
              <span className="small-muted">{dateTimeOf(m.startedAt)}</span>
              <span className={`status ${m.status === 'Open' ? 'pending' : m.decision === 'yes' ? 'approved' : m.decision === 'no' ? 'rejected' : 'pending'}`}>{m.status === 'Open' ? 'In progress / not finished' : DECISION[m.decision] || m.decision}</span>
              {m.score != null && <span className="small-muted">Readiness {m.score}/100</span>}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? 'Hide' : 'Transcript'} ({(m.transcript || []).length})</button>
            </div>
            {m.summary && (
              <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {s.text}
                {[['Need', s.need], ['Budget', s.budget], ['Decides', s.authority], ['Timeline', s.timeline], ['Next step', s.nextStep]].filter(([, v]) => v && !/^unknown$/i.test(v)).map(([k, v]) => <div key={k}><span className="small-muted">{k}:</span> {v}</div>)}
                {(s.objections || []).length > 0 && <div><span className="small-muted">Concerns:</span> {s.objections.join('; ')}</div>}
                {(s.openQuestions || []).length > 0 && <div style={{ color: 'var(--red)' }}>Open questions for you: {s.openQuestions.join(' · ')}</div>}
              </div>
            )}
            {open === m.id && (
              <div style={{ marginTop: 8, maxHeight: 320, overflow: 'auto', borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
                {(m.transcript || []).map((x, i) => (
                  <div key={i} style={{ fontSize: 13, margin: '4px 0' }}><b style={{ color: x.who === 'ai' ? 'var(--brand, #2563eb)' : undefined }}>{x.who === 'ai' ? 'AI' : 'Lead'}:</b> {x.text}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// a quote for the lead: a plan per product they want, how many people, yearly or monthly; GST 18% on top (crm/productDeals.js)
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const qtyWord = (unit) => { const u = String(unit || '').toLowerCase(); if (/employee/.test(u)) return 'employees'; if (/recruiter/.test(u)) return 'recruiters'; if (/user|seat/.test(u)) return 'users'; return null; };
function QuoteBox({ lead, all, mine, canEdit, onChanged }) {
  const { toast } = useCrm();
  const [quotes, setQuotes] = useState(null);
  const [pick, setPick] = useState({}); // key -> { plan, qty }
  const [billing, setBilling] = useState('yearly');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/leads/${lead.id}/quotes`).then((r) => setQuotes(r.data.quotes || [])).catch(() => setQuotes([]));
  useEffect(() => { load(); }, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const prods = (all || []).filter((p) => mine.includes(p.key) && (p.plans || []).some((x) => x.price));
  const planOf = (p) => (p.plans || []).find((x) => x.name === (pick[p.key] || {}).plan) || (p.plans || []).find((x) => x.price);
  async function make(channel) {
    setBusy(true);
    try {
      const items = prods.map((p) => ({ key: p.key, plan: planOf(p).name, qty: Number((pick[p.key] || {}).qty) || 0 }));
      const r = await api.post(`/crm/leads/${lead.id}/quote`, { items, billing, channel });
      if (channel === 'email') toast(`Quote ${r.data.quote.number} sent by email.`);
      else if (channel === 'whatsapp' && r.data.whatsappUrl) window.open(r.data.whatsappUrl, '_blank', 'noopener');
      else await copy(r.data.url, toast, `Quote ${r.data.quote.number} made - link copied.`);
      load(); if (onChanged) onChanged();
    } catch (e) { toast(errOf(e, 'The quote could not be made.')); }
    setBusy(false);
  }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="section-label" style={{ marginTop: 0 }}>4 · Quote</div>
      {!prods.length && <div className="small-muted">Tick a product with a price above to make a quote.</div>}
      {prods.map((p) => {
        const pl = planOf(p);
        const w = qtyWord(pl && pl.unit);
        return (
          <div key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <b style={{ minWidth: 170 }}>{p.name}</b>
            <select value={pl ? pl.name : ''} onChange={(e) => setPick({ ...pick, [p.key]: { ...(pick[p.key] || {}), plan: e.target.value } })} aria-label={`${p.name} plan`} style={{ width: 'auto' }}>
              {(p.plans || []).filter((x) => x.price).map((x) => <option key={x.name} value={x.name}>{x.name} · {x.price} {x.unit}</option>)}
            </select>
            {w && <input type="number" min="1" placeholder={`How many ${w}`} value={(pick[p.key] || {}).qty || ''} onChange={(e) => setPick({ ...pick, [p.key]: { ...(pick[p.key] || {}), qty: e.target.value } })} aria-label={`${p.name} ${w}`} style={{ width: 150 }} />}
          </div>
        );
      })}
      {prods.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <select value={billing} onChange={(e) => setBilling(e.target.value)} aria-label="Billing" style={{ width: 'auto' }}><option value="yearly">Yearly</option><option value="monthly">Monthly (10% more)</option></select>
          <button type="button" className="btn btn-primary" disabled={!canEdit || busy} onClick={() => make('whatsapp')}>Make quote · WhatsApp</button>
          <button type="button" className="btn" disabled={!canEdit || busy || !lead.email} onClick={() => make('email')}>Make quote · email</button>
          <button type="button" className="btn" disabled={!canEdit || busy} onClick={() => make('link')}>Make quote · copy link</button>
        </div>
      )}
      <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>GST 18% is added. When the customer accepts on the quote page, the lead becomes a deal in Negotiation and you get a follow-up to collect the payment.</div>
      {(quotes || []).length > 0 && (
        <table style={{ marginTop: 8, fontSize: 13 }}>
          <thead><tr><th>Quote</th><th>Items</th><th>Total</th><th>Status</th><th>Made</th><th /></tr></thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td><b>{q.number}</b></td>
                <td>{(q.items || []).map((x) => `${x.product} ${x.plan}${x.qtyKind ? ` × ${x.qty}` : ''}`).join(', ')}<div className="small-muted">{q.billing}{q.madeBy ? ` · by ${q.madeBy}` : ''}</div></td>
                <td>{inr(q.total)}</td>
                <td><span className={`status ${q.status === 'Accepted' ? 'approved' : q.status === 'Declined' ? 'rejected' : 'pending'}`}>{q.status}</span></td>
                <td className="small-muted">{dateTimeOf(q.createdAt)}</td>
                <td><button type="button" className="btn btn-sm" onClick={() => copy(q.url, toast, 'Quote link copied.')}>Copy link</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// the settings of the whole flow (managers) and how leads move through it
function SalesSettings() {
  const { toast } = useCrm();
  const [s, setS] = useState(null);
  useEffect(() => { api.get('/crm/products-settings').then((r) => setS(r.data.settings)).catch(() => setS(null)); }, []);
  if (!s) return null;
  async function save() {
    try { const r = await api.put('/crm/products-settings', s); setS(r.data.settings); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  return (
    <div className="card" style={{ padding: 14, marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Settings</h3>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!s.autoDemo} onChange={(e) => setS({ ...s, autoDemo: e.target.checked })} style={{ width: 'auto' }} /> Send the demo by itself to every new lead (website form or added by hand; not Excel imports), by email and WhatsApp</label>
      <div className="grid-2" style={{ marginTop: 8 }}>
        <label>WhatsApp template name (approved by Meta; needed for the first message to a new number)<input type="text" value={s.waTemplate || ''} onChange={(e) => setS({ ...s, waTemplate: e.target.value })} placeholder="e.g. product_demo" /></label>
        <label>Template language<input type="text" value={s.waTemplateLang || ''} onChange={(e) => setS({ ...s, waTemplateLang: e.target.value })} placeholder="en" /></label>
      </div>
      <div className="small-muted" style={{ fontSize: 12 }}>The template gets two values: the person's name and the demo link. Without a template the plain message is tried, which WhatsApp only delivers if the person wrote to you in the last 24 hours.</div>
      <label style={{ marginTop: 8 }}>How customers pay (shown after they accept a quote: bank account, UPI ID…)<textarea rows={4} value={s.paymentText || ''} onChange={(e) => setS({ ...s, paymentText: e.target.value })} /></label>
      <div className="grid-2">
        <label>Online payment page link (https://, optional)<input type="text" value={s.paymentLink || ''} onChange={(e) => setS({ ...s, paymentLink: e.target.value })} /></label>
        <label>A quote is valid for (days)<input type="number" min="1" max="180" value={s.quoteValidityDays || 30} onChange={(e) => setS({ ...s, quoteValidityDays: e.target.value })} /></label>
      </div>
      <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
    </div>
  );
}
function SalesFunnel() {
  const [days, setDays] = useState(90);
  const [f, setF] = useState(null);
  useEffect(() => { setF(null); api.get('/crm/products-funnel', { params: { days } }).then((r) => setF(r.data.rows || [])).catch(() => setF([])); }, [days]);
  const cols = [['demosSent', 'Demos sent'], ['opened', 'Opened'], ['interested', 'Interested'], ['meetings', 'AI meetings'], ['goAhead', 'Go ahead'], ['quotes', 'Quotes'], ['accepted', 'Accepted'], ['won', 'Won']];
  return (
    <div className="card" style={{ padding: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, flex: 1 }}>How leads move</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period" style={{ width: 'auto' }}>{[30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>Leads counted once per step, per product.</div>
      {f == null ? <div className="small-muted">Loading…</div> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Product</th>{cols.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
            <tbody>{f.map((r) => <tr key={r.key}><td><b>{r.name}</b></td>{cols.map(([k]) => <td key={k}>{r[k]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const lines = (a) => (a || []).join('\n');
export function ProductCatalog() {
  const { me, toast } = useCrm();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null); // the product being edited
  const [watch, setWatch] = useState(null); // { name, url } of the clip playing
  const [vidKey, setVidKey] = useState(0); // a product's own upload refreshes the uploads list
  const canEdit = me && ['admin', 'tl'].includes(me.role);
  const play = (p) => api.get(`/crm/products/${p.key}/watch`).then((r) => setWatch(r.data)).catch((e) => toast(errOf(e, 'The video could not be opened.')));
  const load = () => api.get('/crm/products', { params: { all: 1 } }).then((r) => setRows(r.data.products || [])).catch((e) => { setRows([]); toast(errOf(e, 'The products could not be read.')); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      await api.put(`/crm/products/${edit.key}`, { ...edit, features: String(edit.featuresText || '').split('\n').map((x) => x.trim()).filter(Boolean) });
      toast('Saved. The demo page and the AI meeting use it from now.'); setEdit(null); load();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function addProduct() {
    const name = window.prompt('Name of the new product (e.g. TeamLink Accounts):'); // eslint-disable-line no-alert
    if (!name || !name.trim()) return;
    try {
      const r = await api.post('/crm/products', { name: name.trim() });
      toast(`${r.data.product.name} added. Upload its demo video on its card: the text is written from the video, then set its plans and prices with Edit.`);
      load();
    } catch (e) { toast(errOf(e, 'The product could not be added.')); }
  }
  const setPlan = (i, k, v) => setEdit((e) => ({ ...e, plans: e.plans.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  if (!rows) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      {canEdit && <VideoStudio refreshKey={vidKey} onSaved={() => { load(); setVidKey((n) => n + 1); }} products={rows} />}
      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button type="button" className="btn" onClick={addProduct}>+ Add product</button>
        </div>
      )}
      <div className="small-muted" style={{ margin: '6px 0 12px' }}>What we sell. The demo page and the AI meeting read from here, so the AI only says what is written here. A plan with no price is quoted by a person.</div>
      <div className="grid-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12 }}>
        {rows.map((p) => (
          <div key={p.key} className="card" style={{ padding: 14, opacity: p.active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>{p.name}</h3>
              <span className={`status ${p.hasVideo ? 'approved' : 'pending'}`}>{p.hasVideo ? 'Video ready' : 'No video'}</span>
            </div>
            <div className="small-muted" style={{ margin: '4px 0 8px' }}>{p.tagline}</div>
            <ul style={{ margin: '0 0 8px 18px', padding: 0, fontSize: 13 }}>{(p.features || []).slice(0, 5).map((f, i) => <li key={i}>{f}</li>)}{(p.features || []).length > 5 && <li className="small-muted">+{p.features.length - 5} more</li>}</ul>
            <div style={{ fontSize: 13 }}>{(p.plans || []).map((x) => <div key={x.name}><b>{x.name}</b>: {x.price ? `${x.price} ${x.unit || ''}` : <span className="small-muted">price on request</span>}</div>)}</div>
            {p.hasVideo && <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10, marginRight: 6 }} onClick={() => play(p)}>▶ Watch video</button>}
            {canEdit && <SingleUpload product={p} onDone={() => setVidKey((n) => n + 1)} />}
            {canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setEdit({ ...p, featuresText: lines(p.features), plans: (p.plans || []).length ? p.plans : [{ name: 'Starter', price: '', unit: 'per user / month', includes: '' }] })}>Edit</button>}
          </div>
        ))}
      </div>
      <VideosSection canEdit={canEdit} onWatch={setWatch} refreshKey={vidKey} />
      <SalesFunnel />
      {canEdit && <SalesSettings />}
      {watch && (
        <Modal title={`${watch.name} - demo video`} size="xwide" onClose={() => setWatch(null)}>
          <video src={watch.url} controls autoPlay playsInline style={{ width: '100%', maxHeight: '72vh', background: '#000', borderRadius: 8 }} />
          <div className="small-muted" style={{ marginTop: 6, fontSize: 12 }}>This is exactly what a lead sees on the demo page for this product.</div>
        </Modal>
      )}
      {edit && (
        <div className="card" style={{ padding: 14, marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Edit {edit.name}</h3>
          <div className="grid-2">
            <label>Name<input type="text" value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label>Tagline<input type="text" value={edit.tagline || ''} onChange={(e) => setEdit({ ...edit, tagline: e.target.value })} /></label>
          </div>
          <label>About (the AI explains the product from this)<textarea rows={4} value={edit.about || ''} onChange={(e) => setEdit({ ...edit, about: e.target.value })} /></label>
          <label>Features (one per line)<textarea rows={6} value={edit.featuresText || ''} onChange={(e) => setEdit({ ...edit, featuresText: e.target.value })} /></label>
          <div className="section-label">Plans and prices</div>
          {edit.plans.map((x, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr auto', gap: 6, marginBottom: 6 }}>
              <input type="text" placeholder="Plan" value={x.name} onChange={(e) => setPlan(i, 'name', e.target.value)} aria-label="Plan name" />
              <input type="text" placeholder="Price, e.g. ₹99" value={x.price} onChange={(e) => setPlan(i, 'price', e.target.value)} aria-label="Price" />
              <input type="text" placeholder="per user / month" value={x.unit} onChange={(e) => setPlan(i, 'unit', e.target.value)} aria-label="Unit" />
              <input type="text" placeholder="What is included" value={x.includes} onChange={(e) => setPlan(i, 'includes', e.target.value)} aria-label="Includes" />
              <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...edit, plans: edit.plans.filter((_, j) => j !== i) })} aria-label="Remove plan">✕</button>
            </div>
          ))}
          {edit.plans.length < 6 && <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...edit, plans: [...edit.plans, { name: '', price: '', unit: 'per user / month', includes: '' }] })}>+ Plan</button>}
          <label style={{ marginTop: 10 }}>Questions and answers (the AI uses these word for word; write “Q: … A: …” one pair per paragraph)<textarea rows={6} value={edit.faq || ''} onChange={(e) => setEdit({ ...edit, faq: e.target.value })} /></label>
          <div className="grid-2">
            <label>Video link instead of our own video (https://, optional)<input type="text" value={edit.videoUrl || ''} onChange={(e) => setEdit({ ...edit, videoUrl: e.target.value })} /></label>
            <label>Live demo / trial link (https://, optional)<input type="text" value={edit.demoUrl || ''} onChange={(e) => setEdit({ ...edit, demoUrl: e.target.value })} /></label>
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} style={{ width: 'auto' }} /> We sell this now</label>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OUR PRODUCTS IN THE CRM (founder 2026-11-17: sell HRMS, ATS and Omni-Channel). Two pieces, both inside existing CRM screens (never a 6th sidebar item):
//   ProductSellBox   the "Products & demo" tab of a lead: which product(s) the lead wants, send the demo (link / WhatsApp / email; the demo page
//                    plays only that product's part of the video), the AI meeting link, and every AI meeting with its summary and transcript
//   ProductCatalog   the "Our products" tab of Leads: name, tagline, about, features, plans and prices, FAQ the AI answers from (managers edit)
// Backend: crm/productSales.js, routes/crm.js (/crm/products, /crm/leads/:id/products|demo|ai-meeting|ai-meetings), public pages routes/crmProductPages.js.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, dateTimeOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

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

const lines = (a) => (a || []).join('\n');
export function ProductCatalog() {
  const { me, toast } = useCrm();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null); // the product being edited
  const canEdit = me && ['admin', 'tl'].includes(me.role);
  const load = () => api.get('/crm/products', { params: { all: 1 } }).then((r) => setRows(r.data.products || [])).catch((e) => { setRows([]); toast(errOf(e, 'The products could not be read.')); });
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      await api.put(`/crm/products/${edit.key}`, { ...edit, features: String(edit.featuresText || '').split('\n').map((x) => x.trim()).filter(Boolean) });
      toast('Saved. The demo page and the AI meeting use it from now.'); setEdit(null); load();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  const setPlan = (i, k, v) => setEdit((e) => ({ ...e, plans: e.plans.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  if (!rows) return <div className="small-muted">Loading…</div>;
  return (
    <div>
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
            {canEdit && <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setEdit({ ...p, featuresText: lines(p.features), plans: (p.plans || []).length ? p.plans : [{ name: 'Starter', price: '', unit: 'per user / month', includes: '' }] })}>Edit</button>}
          </div>
        ))}
      </div>
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

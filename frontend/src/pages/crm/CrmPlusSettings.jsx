// ---------------------------------------------------------------------------
// CRM SETTINGS, WAVE D PART (2026-11-24) - shown inside the existing CRM settings window (Dashboard > ⚙ Settings), each part with its own
// Save: pipelines and stages (required fields, checklists), price books and CPQ rules, quote templates and approval, sub-teams and territories,
// field security / IP restriction / hand-over (security), online payments, the privacy notice (DPDP), mention emails and renewals.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import { useCrm, errOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const PARTS = [['pipelines', 'Pipelines'], ['prices', 'Prices & CPQ'], ['quotes', 'Quotes'], ['teams', 'Teams & territories'], ['security', 'Security'], ['payments', 'Payments'], ['privacy', 'Privacy (DPDP)'], ['other', 'Mentions & renewals']];
const lines = (v) => (Array.isArray(v) ? v.join('\n') : v || '');
const unlines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
const row = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 };
const Check = ({ checked, onChange, children, disabled }) => <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontWeight: 500, marginRight: 10 }}><input type="checkbox" style={{ width: 'auto' }} disabled={disabled} checked={!!checked} onChange={(e) => onChange(e.target.checked)} /> {children}</label>;
function useSave() {
  const { toast, reloadMe } = useCrm();
  return async (fn, ok) => { try { const r = await fn(); toast(ok || 'Saved.'); reloadMe(); return r; } catch (e) { toast(errOf(e, 'It could not be saved.')); return null; } };
}

function Pipelines() {
  const save = useSave();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/plus/config').then((r) => setD({ pipelines: r.data.pipelines.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, checklist: lines(s.checklist), probability: s.core && p.id === 'default' ? null : s.probability })) })), req: r.data.requiredFields })).catch(() => setD(null)); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  const setP = (i, patch) => setD((x) => ({ ...x, pipelines: x.pipelines.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const setS = (i, k, patch) => setP(i, { stages: d.pipelines[i].stages.map((s, j) => (j === k ? { ...s, ...patch } : s)) });
  const moveS = (i, k, dir) => { const st = [...d.pipelines[i].stages]; const t = k + dir; if (t < 0 || t >= st.length) return; [st[k], st[t]] = [st[t], st[k]]; setP(i, { stages: st }); };
  const body = () => ({ pipelines: d.pipelines.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, checklist: unlines(s.checklist) })) })) });
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>Each pipeline has its own stages in your order; Won and Lost always end it. The first pipeline keeps the six stages the reports read (🔒) and may get extra stages in between. Per stage: what a deal must have to <b>enter</b> it, and a checklist (tick &quot;must&quot; to stop a deal leaving the stage before it is all ticked).</p>
      {d.pipelines.map((p, i) => (
        <div key={p.id || i} className="card" style={{ padding: 10, marginBottom: 10 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={row}>
            <input type="text" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} style={{ flex: 1, fontWeight: 600 }} aria-label="Pipeline name" />
            {p.id !== 'default' && <button type="button" className="btn btn-sm" onClick={() => setD((x) => ({ ...x, pipelines: x.pipelines.filter((_, j) => j !== i) }))}>Remove pipeline</button>}
          </div>
          {p.stages.map((s, k) => (
            <div key={k} style={{ borderTop: '1px solid var(--line-soft, #eef0f4)', padding: '6px 0' }}>{/* eslint-disable-line react/no-array-index-key */}
              <div style={row}>
                <input type="text" value={s.name} disabled={s.core} onChange={(e) => setS(i, k, { name: e.target.value })} style={{ flex: 1, minWidth: 140 }} aria-label="Stage name" />
                {s.core ? <span className="small-muted" title="Its probability is set below in CRM settings">🔒 core</span> : <input type="number" min={0} max={100} placeholder="%" value={s.probability ?? ''} onChange={(e) => setS(i, k, { probability: e.target.value })} style={{ width: 70 }} aria-label="Probability" />}
                <button type="button" className="btn btn-sm" onClick={() => moveS(i, k, -1)} aria-label="Up">↑</button>
                <button type="button" className="btn btn-sm" onClick={() => moveS(i, k, 1)} aria-label="Down">↓</button>
                {!s.core && <button type="button" className="btn btn-sm" onClick={() => setP(i, { stages: p.stages.filter((_, j) => j !== k) })}>Remove</button>}
              </div>
              <div style={{ ...row, fontSize: 12.5 }}>
                <span className="small-muted">To enter:</span>
                {Object.entries(d.req).map(([f, label]) => <Check key={f} checked={(s.required || []).includes(f)} onChange={(on) => setS(i, k, { required: on ? [...(s.required || []), f] : (s.required || []).filter((x) => x !== f) })}>{label}</Check>)}
              </div>
              <div style={row}>
                <textarea rows={2} placeholder="Checklist, one item per line" value={s.checklist} onChange={(e) => setS(i, k, { checklist: e.target.value })} style={{ flex: 1, minWidth: 200 }} aria-label="Checklist" />
                <Check checked={s.mustTick} onChange={(v) => setS(i, k, { mustTick: v })}>must be ticked</Check>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setP(i, { stages: [...p.stages, { name: '', required: [], checklist: '', mustTick: false }] })}>+ Stage</button>
        </div>
      ))}
      <div style={row}>
        <button type="button" className="btn btn-sm" onClick={() => setD((x) => ({ ...x, pipelines: [...x.pipelines, { id: '', name: 'New pipeline', stages: [{ name: 'New', required: [], checklist: '' }, { name: 'Qualified', required: [], checklist: '' }, { name: 'Proposal', required: [], checklist: '' }] }] }))}>+ Pipeline</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/pipelines', body()), 'Pipelines saved.')}>Save pipelines</button>
      </div>
    </div>
  );
}

function Prices() {
  const save = useSave();
  const [books, setBooks] = useState(null);
  const [cat, setCat] = useState([]);
  const [cpq, setCpq] = useState(null);
  useEffect(() => {
    api.get('/crm/plus/pricebooks').then((r) => { setBooks(r.data.books.map((b) => ({ ...b, states: lines(b.states) }))); setCat(r.data.catalogue); }).catch(() => setBooks([]));
    api.get('/crm/plus/cpq').then((r) => setCpq(r.data.cpq)).catch(() => setCpq({ bundles: [], requires: [], volume: [], maxLineDiscount: null }));
  }, []);
  if (!books || !cpq) return <div className="small-muted">Loading…</div>;
  const keys = [...new Set(cat.map((c) => c.productKey))];
  const planOpts = cat.map((c) => <option key={`${c.productKey}|${c.plan}`} value={`${c.productKey}|${c.plan}`}>{c.name} (list {c.listPrice})</option>);
  const setB = (i, patch) => setBooks((x) => x.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const setC = (k, i, patch) => setCpq((x) => ({ ...x, [k]: x[k].map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  return (
    <div>
      <div className="section-label" style={{ marginTop: 0 }}>Price books</div>
      <p className="small-muted" style={{ marginTop: 0 }}>A price book gives other prices for some customers: the one picked on a deal, else one for the customer&#39;s state, else the default one, else the list prices of Our products.</p>
      {books.map((b, i) => (
        <div key={b.id || i} className="card" style={{ padding: 10, marginBottom: 8 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={row}>
            <input type="text" placeholder="Name" value={b.name} onChange={(e) => setB(i, { name: e.target.value })} style={{ flex: 1 }} aria-label="Price book name" />
            <Check checked={b.isDefault} onChange={(v) => setBooks((x) => x.map((y, j) => ({ ...y, isDefault: j === i ? v : (v ? false : y.isDefault) })))}>default</Check>
            <Check checked={b.active !== false} onChange={(v) => setB(i, { active: v })}>in use</Check>
            <button type="button" className="btn btn-sm" onClick={() => setBooks((x) => x.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <textarea rows={2} placeholder="Customer states it is for, one per line (e.g. Karnataka)" value={b.states} onChange={(e) => setB(i, { states: e.target.value })} aria-label="States" />
          {(b.entries || []).map((e, k) => (
            <div key={k} style={{ ...row, marginTop: 6 }}>{/* eslint-disable-line react/no-array-index-key */}
              <select value={`${e.productKey}|${e.plan}`} onChange={(ev) => { const [pk, pl] = ev.target.value.split('|'); setB(i, { entries: b.entries.map((y, j) => (j === k ? { ...y, productKey: pk, plan: pl } : y)) }); }} style={{ flex: 1, minWidth: 180 }} aria-label="Product">{planOpts}</select>
              <input type="number" min={0} value={e.price} onChange={(ev) => setB(i, { entries: b.entries.map((y, j) => (j === k ? { ...y, price: ev.target.value } : y)) })} style={{ width: 110 }} aria-label="Price" />
              <button type="button" className="btn btn-sm" onClick={() => setB(i, { entries: b.entries.filter((_, j) => j !== k) })}>✕</button>
            </div>
          ))}
          {cat.length > 0 && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setB(i, { entries: [...(b.entries || []), { productKey: cat[0].productKey, plan: cat[0].plan, price: cat[0].listPrice }] })}>+ Price</button>}
        </div>
      ))}
      <div style={row}>
        <button type="button" className="btn btn-sm" onClick={() => setBooks((x) => [...x, { name: '', states: '', entries: [], active: true }])}>+ Price book</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/pricebooks', { books: books.map((b) => ({ ...b, states: unlines(b.states) })) }), 'Price books saved.')}>Save price books</button>
      </div>
      <div className="section-label">CPQ rules</div>
      <p className="small-muted" style={{ marginTop: 0 }}>Bundles add several products at a bundle discount; a &quot;needs&quot; rule stops a product being sold without another; a volume discount is given by itself from a quantity.</p>
      <b style={{ fontSize: 13 }}>Bundles</b>
      {cpq.bundles.map((b, i) => (
        <div key={b.id || i} className="card" style={{ padding: 8, marginBottom: 6 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={row}><input type="text" placeholder="Bundle name" value={b.name} onChange={(e) => setC('bundles', i, { name: e.target.value })} style={{ flex: 1 }} aria-label="Bundle name" /><input type="number" min={0} max={100} value={b.discountPercent} onChange={(e) => setC('bundles', i, { discountPercent: e.target.value })} style={{ width: 80 }} aria-label="Bundle discount" /><span className="small-muted">% off</span><button type="button" className="btn btn-sm" onClick={() => setCpq((x) => ({ ...x, bundles: x.bundles.filter((_, j) => j !== i) }))}>Remove</button></div>
          {b.items.map((it, k) => (
            <div key={k} style={row}>{/* eslint-disable-line react/no-array-index-key */}
              <select value={`${it.productKey}|${it.plan}`} onChange={(ev) => { const [pk, pl] = ev.target.value.split('|'); setC('bundles', i, { items: b.items.map((y, j) => (j === k ? { ...y, productKey: pk, plan: pl } : y)) }); }} style={{ flex: 1, minWidth: 180 }} aria-label="Product">{planOpts}</select>
              <input type="number" min={1} value={it.qty} onChange={(ev) => setC('bundles', i, { items: b.items.map((y, j) => (j === k ? { ...y, qty: ev.target.value } : y)) })} style={{ width: 80 }} aria-label="Quantity" />
              <button type="button" className="btn btn-sm" onClick={() => setC('bundles', i, { items: b.items.filter((_, j) => j !== k) })}>✕</button>
            </div>
          ))}
          {cat.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setC('bundles', i, { items: [...b.items, { productKey: cat[0].productKey, plan: cat[0].plan, qty: 1 }] })}>+ Product</button>}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setCpq((x) => ({ ...x, bundles: [...x.bundles, { name: '', discountPercent: 10, items: [] }] }))}>+ Bundle</button>
      <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>Needs rules</b></div>
      {cpq.requires.map((x, i) => (
        <div key={i} style={row}>{/* eslint-disable-line react/no-array-index-key */}
          <select value={x.productKey} onChange={(e) => setC('requires', i, { productKey: e.target.value })} style={{ width: 'auto' }} aria-label="Product">{keys.map((k) => <option key={k}>{k}</option>)}</select>
          <span className="small-muted">needs</span>
          <select value={x.needs} onChange={(e) => setC('requires', i, { needs: e.target.value })} style={{ width: 'auto' }} aria-label="Needs">{keys.map((k) => <option key={k}>{k}</option>)}</select>
          <input type="text" placeholder="Message (optional)" value={x.message || ''} onChange={(e) => setC('requires', i, { message: e.target.value })} style={{ flex: 1, minWidth: 160 }} aria-label="Message" />
          <button type="button" className="btn btn-sm" onClick={() => setCpq((y) => ({ ...y, requires: y.requires.filter((_, j) => j !== i) }))}>✕</button>
        </div>
      ))}
      {keys.length > 1 && <button type="button" className="btn btn-sm" onClick={() => setCpq((x) => ({ ...x, requires: [...x.requires, { productKey: keys[0], needs: keys[1], message: '' }] }))}>+ Needs rule</button>}
      <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>Volume discounts</b></div>
      {cpq.volume.map((x, i) => (
        <div key={i} style={row}>{/* eslint-disable-line react/no-array-index-key */}
          <select value={x.productKey} onChange={(e) => setC('volume', i, { productKey: e.target.value })} style={{ width: 'auto' }} aria-label="Product">{keys.map((k) => <option key={k}>{k}</option>)}</select>
          <span className="small-muted">from</span><input type="number" min={1} value={x.minQty} onChange={(e) => setC('volume', i, { minQty: e.target.value })} style={{ width: 90 }} aria-label="From quantity" />
          <span className="small-muted">units:</span><input type="number" min={0} max={100} value={x.discountPercent} onChange={(e) => setC('volume', i, { discountPercent: e.target.value })} style={{ width: 80 }} aria-label="Discount" /><span className="small-muted">% off</span>
          <button type="button" className="btn btn-sm" onClick={() => setCpq((y) => ({ ...y, volume: y.volume.filter((_, j) => j !== i) }))}>✕</button>
        </div>
      ))}
      {keys.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setCpq((x) => ({ ...x, volume: [...x.volume, { productKey: keys[0], minQty: 50, discountPercent: 5 }] }))}>+ Volume discount</button>}
      <div style={{ ...row, marginTop: 10 }}>
        <span className="small-muted">Highest line discount a salesperson may type (empty = no cap):</span>
        <input type="number" min={0} max={100} value={cpq.maxLineDiscount ?? ''} onChange={(e) => setCpq((x) => ({ ...x, maxLineDiscount: e.target.value === '' ? null : e.target.value }))} style={{ width: 80 }} aria-label="Line discount cap" />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/cpq', cpq), 'CPQ rules saved.')}>Save CPQ rules</button>
      </div>
    </div>
  );
}

function Quotes() {
  const save = useSave();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/plus/quote-settings').then((r) => setD({ ...r.data, templates: r.data.templates.map((t) => ({ ...t, terms: lines(t.terms) })) })).catch(() => setD(null)); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  const setT = (i, patch) => setD((x) => ({ ...x, templates: x.templates.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>A product quotation template lists the deal&#39;s product lines with your title, words, terms and colour. Every quote of a deal is a numbered version; &quot;Revise&quot; makes the next one.</p>
      {d.templates.map((t, i) => (
        <div key={t.id || i} className="card" style={{ padding: 10, marginBottom: 8 }}>{/* eslint-disable-line react/no-array-index-key */}
          {t.id === 'recruitment' ? <div><b>{t.name}</b> <span className="small-muted">· built in: positions, fee % and the recruitment terms (its layout is fixed)</span></div> : (
            <>
              <div style={row}>
                <input type="text" value={t.name} disabled={t.builtIn} onChange={(e) => setT(i, { name: e.target.value })} style={{ flex: 1, fontWeight: 600 }} aria-label="Template name" />
                <input type="color" value={t.accent || '#1b2a4a'} onChange={(e) => setT(i, { accent: e.target.value })} style={{ width: 40, padding: 2 }} aria-label="Colour" />
                {!t.builtIn && <button type="button" className="btn btn-sm" onClick={() => setD((x) => ({ ...x, templates: x.templates.filter((_, j) => j !== i) }))}>Remove</button>}
              </div>
              <input type="text" placeholder="Title on the PDF" value={t.title} onChange={(e) => setT(i, { title: e.target.value })} aria-label="Title" />
              <textarea rows={2} placeholder="Opening words" value={t.intro} onChange={(e) => setT(i, { intro: e.target.value })} style={{ marginTop: 6 }} aria-label="Opening words" />
              <textarea rows={3} placeholder="Terms, one per line" value={t.terms} onChange={(e) => setT(i, { terms: e.target.value })} style={{ marginTop: 6 }} aria-label="Terms" />
              <input type="text" placeholder="Footer line" value={t.footer} onChange={(e) => setT(i, { footer: e.target.value })} style={{ marginTop: 6 }} aria-label="Footer" />
            </>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setD((x) => ({ ...x, templates: [...x.templates, { id: '', name: 'New quotation', kind: 'items', title: 'Quotation', intro: '', terms: '', footer: '', accent: '#1b2a4a' }] }))}>+ Template</button>
      <div className="section-label">Quote approval</div>
      <div style={row}>
        <select value={d.approval.mode} onChange={(e) => setD({ ...d, approval: { ...d.approval, mode: e.target.value } })} style={{ width: 'auto' }} aria-label="Approval">
          <option value="off">No approval for quotes</option>
          <option value="over-limit">A quote with a discount over the CRM limit waits for a Sales manager</option>
          <option value="all">Every quote waits for a Sales manager</option>
        </select>
        <span className="small-muted">Recruitment fee under</span><input type="number" min={0} max={100} value={d.approval.minFeePercent} onChange={(e) => setD({ ...d, approval: { ...d.approval, minFeePercent: e.target.value } })} style={{ width: 80 }} aria-label="Minimum fee" /><span className="small-muted">% waits too (0 = never)</span>
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/quote-settings', { ...d, templates: d.templates.map((t) => ({ ...t, terms: unlines(t.terms) })) }), 'Quote templates saved.')}>Save quotes</button>
    </div>
  );
}

function TeamsTerritories() {
  const { me } = useCrm();
  const save = useSave();
  const [teams, setTeams] = useState(null);
  const [people, setPeople] = useState([]);
  const [ter, setTer] = useState(null);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    api.get('/crm/plus/teams').then((r) => { setTeams(r.data.teams); setPeople(r.data.people); }).catch(() => setTeams([]));
    api.get('/crm/plus/territories').then((r) => { setTer(r.data.territories.map((t) => ({ ...t, states: lines(t.states), cities: lines(t.cities), industries: lines(t.industries) }))); setAuto(r.data.autoAssign); }).catch(() => setTer([]));
  }, []);
  if (!teams || !ter) return <div className="small-muted">Loading…</div>;
  const team = (me.salesTeam || []).length ? me.salesTeam.map((m) => ({ id: m.userId, name: m.name })) : people;
  const setTm = (i, patch) => setTeams((x) => x.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setTr = (i, patch) => setTer((x) => x.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const terBody = () => ({ autoAssign: auto, territories: ter.map((t) => ({ ...t, states: unlines(t.states), cities: unlines(t.cities), industries: unlines(t.industries) })) });
  return (
    <div>
      <div className="section-label" style={{ marginTop: 0 }}>Sub-teams</div>
      <p className="small-muted" style={{ marginTop: 0 }}>A sub-team&#39;s manager reads the records of its members (and of the teams under it) and changes only their own. Sales managers on the main list already see everyone.</p>
      {teams.map((t, i) => (
        <div key={t.id || i} className="card" style={{ padding: 10, marginBottom: 8 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={row}>
            <input type="text" placeholder="Team name" value={t.name} onChange={(e) => setTm(i, { name: e.target.value })} style={{ flex: 1 }} aria-label="Team name" />
            <select value={t.managerId || ''} onChange={(e) => setTm(i, { managerId: e.target.value })} style={{ width: 'auto' }} aria-label="Team manager"><option value="">Manager…</option>{team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select value={t.parentId || ''} onChange={(e) => setTm(i, { parentId: e.target.value || null })} style={{ width: 'auto' }} aria-label="Under"><option value="">Top level</option>{teams.filter((x) => x.id && x.id !== t.id).map((x) => <option key={x.id} value={x.id}>under {x.name}</option>)}</select>
            <button type="button" className="btn btn-sm" onClick={() => setTeams((x) => x.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <div>{team.filter((p) => p.id !== t.managerId).map((p) => <Check key={p.id} checked={(t.memberIds || []).includes(p.id)} onChange={(on) => setTm(i, { memberIds: on ? [...(t.memberIds || []), p.id] : (t.memberIds || []).filter((x) => x !== p.id) })}>{p.name}</Check>)}</div>
        </div>
      ))}
      <div style={row}>
        <button type="button" className="btn btn-sm" onClick={() => setTeams((x) => [...x, { name: '', managerId: '', memberIds: [] }])}>+ Team</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const r = await save(() => api.put('/crm/plus/teams', { teams }), 'Teams saved.'); if (r) setTeams(r.data.teams); }}>Save teams</button>
      </div>
      <div className="section-label">Territories</div>
      <p className="small-muted" style={{ marginTop: 0 }}>A territory fits an account or lead by its states, cities and industries (each list filled in must fit; the deepest territory wins). Put territories under each other for a hierarchy.</p>
      {ter.map((t, i) => (
        <div key={t.id || i} className="card" style={{ padding: 10, marginBottom: 8 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={row}>
            <input type="text" placeholder="Territory name" value={t.name} onChange={(e) => setTr(i, { name: e.target.value })} style={{ flex: 1 }} aria-label="Territory name" />
            <select value={t.parentId || ''} onChange={(e) => setTr(i, { parentId: e.target.value || null })} style={{ width: 'auto' }} aria-label="Under"><option value="">Top level</option>{ter.filter((x) => x.id && x.id !== t.id).map((x) => <option key={x.id} value={x.id}>under {x.name}</option>)}</select>
            {t.accounts != null && <span className="small-muted">{t.accounts} accounts · {t.leads} leads · {t.openDeals} open deals</span>}
            <button type="button" className="btn btn-sm" onClick={() => setTer((x) => x.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <div className="grid-3">
            <textarea rows={2} placeholder="States, one per line" value={t.states} onChange={(e) => setTr(i, { states: e.target.value })} aria-label="States" />
            <textarea rows={2} placeholder="Cities, one per line" value={t.cities} onChange={(e) => setTr(i, { cities: e.target.value })} aria-label="Cities" />
            <textarea rows={2} placeholder="Industries, one per line" value={t.industries} onChange={(e) => setTr(i, { industries: e.target.value })} aria-label="Industries" />
          </div>
          <div style={{ marginTop: 4 }}><span className="small-muted" style={{ marginRight: 6 }}>Its salespeople:</span>{people.map((p) => <Check key={p.id} checked={(t.ownerIds || []).includes(p.id)} onChange={(on) => setTr(i, { ownerIds: on ? [...(t.ownerIds || []), p.id] : (t.ownerIds || []).filter((x) => x !== p.id) })}>{p.name}</Check>)}</div>
        </div>
      ))}
      <Check checked={auto} onChange={setAuto}>A new lead a Sales manager adds without an owner goes to its territory&#39;s salespeople in turn</Check>
      <div style={{ ...row, marginTop: 6 }}>
        <button type="button" className="btn btn-sm" onClick={() => setTer((x) => [...x, { name: '', states: '', cities: '', industries: '', ownerIds: [] }])}>+ Territory</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const r = await save(() => api.put('/crm/plus/territories', terBody()), 'Territories saved.'); if (r) setTer(r.data.territories.map((t) => ({ ...t, states: lines(t.states), cities: lines(t.cities), industries: lines(t.industries) }))); }}>Save territories</button>
        <button type="button" className="btn btn-sm" onClick={() => save(() => api.post('/crm/plus/territories/apply'), 'Territories worked out for the records without one.')}>Work out territories for older records</button>
      </div>
    </div>
  );
}

function Security() {
  const { me, toast } = useCrm();
  const save = useSave();
  const [fs, setFs] = useState(null);
  const [acc, setAcc] = useState(null);
  const [h, setH] = useState({ fromId: '', toId: '', openOnly: true, kinds: ['lead', 'account', 'contact', 'deal', 'task', 'invoice', 'contract'] });
  const [pv, setPv] = useState(null);
  useEffect(() => {
    api.get('/crm/plus/fieldsec').then((r) => setFs(r.data)).catch(() => setFs(null));
    api.get('/crm/plus/access').then((r) => setAcc({ ...r.data, allowed: lines(r.data.allowed) })).catch(() => setAcc(null));
  }, []);
  useEffect(() => { if (h.fromId) api.get('/crm/plus/transfer/preview', { params: { fromId: h.fromId } }).then((r) => setPv(r.data.counts)).catch(() => setPv(null)); else setPv(null); }, [h.fromId]);
  const admin = me.role === 'admin';
  const ROLES = [['manager', 'Sales manager'], ['rep', 'Salesperson'], ['viewer', 'Viewer']];
  const setRule = (role, kind, f, v) => setFs((x) => { const rules = JSON.parse(JSON.stringify(x.rules || {})); rules[role] = rules[role] || {}; rules[role][kind] = rules[role][kind] || {}; if (v) rules[role][kind][f] = v; else delete rules[role][kind][f]; return { ...x, rules }; });
  const people = me.owners || [];
  const everyone = (me.salesTeam || []).map((m) => ({ id: m.userId, name: m.name }));
  return (
    <div>
      <div className="section-label" style={{ marginTop: 0 }}>Field security</div>
      <p className="small-muted" style={{ marginTop: 0 }}>Hide a field from a CRM role (it is not on the screen, in lists or in downloads), or make it read only. Admins always see everything.{!admin && ' Only an Admin can change this.'}</p>
      {fs && Object.entries(fs.fields).map(([kind, fields]) => (
        <div key={kind} className="tbl-wrap" style={{ marginBottom: 8 }}>
          <table style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th style={{ textTransform: 'capitalize' }}>{kind}</th>{ROLES.map(([r, l]) => <th key={r}>{l}</th>)}</tr></thead>
            <tbody>{Object.entries(fields).map(([f, label]) => (
              <tr key={f}><td>{label}</td>{ROLES.map(([r]) => (
                <td key={r}><select disabled={!admin} value={(((fs.rules || {})[r] || {})[kind] || {})[f] || ''} onChange={(e) => setRule(r, kind, f, e.target.value)} style={{ width: 'auto', padding: '2px 4px' }} aria-label={`${label} for ${r}`}><option value="">Shown</option><option value="read">Read only</option><option value="hide">Hidden</option></select></td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {admin && fs && <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/fieldsec', { rules: fs.rules }), 'Field security saved.')}>Save field security</button>}
      <div className="section-label">Open the CRM only from the office</div>
      {acc && (
        <>
          <p className="small-muted" style={{ marginTop: 0 }}>Off by default. When on, the CRM opens only from the addresses listed (one per line; a range like 203.0.113.0/24 is fine). The Super Admin is never locked out. Your address now: <b>{acc.yourIp}</b>.</p>
          <Check checked={acc.ipRestrict} disabled={!acc.canChange} onChange={(v) => setAcc({ ...acc, ipRestrict: v })}>Allow only these addresses</Check>
          <textarea rows={3} disabled={!acc.canChange} value={acc.allowed} onChange={(e) => setAcc({ ...acc, allowed: e.target.value })} aria-label="Allowed addresses" style={{ marginTop: 6 }} />
          {acc.canChange && <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 6 }} onClick={() => save(() => api.put('/crm/plus/access', { ipRestrict: acc.ipRestrict, allowed: unlines(acc.allowed) }), 'Saved.')}>Save</button>}
          <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>The idle sign-out of the whole app (Administration) still applies.</div>
        </>
      )}
      <div className="section-label">Hand over records (someone leaves)</div>
      <div style={row}>
        <select value={h.fromId} onChange={(e) => setH({ ...h, fromId: e.target.value })} style={{ width: 'auto' }} aria-label="From"><option value="">From…</option>{[...everyone, ...people.filter((p) => !everyone.some((e) => e.id === p.id))].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span>→</span>
        <select value={h.toId} onChange={(e) => setH({ ...h, toId: e.target.value })} style={{ width: 'auto' }} aria-label="To"><option value="">To…</option>{people.filter((p) => p.id !== h.fromId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <Check checked={h.openOnly} onChange={(v) => setH({ ...h, openOnly: v })}>only open ones (not won / lost / paid)</Check>
      </div>
      {pv && <div style={row}>{Object.entries(pv).map(([k, c]) => <Check key={k} checked={h.kinds.includes(k)} onChange={(on) => setH({ ...h, kinds: on ? [...h.kinds, k] : h.kinds.filter((x) => x !== k) })}>{h.openOnly ? c.open : c.all} {c.label}</Check>)}</div>}
      <button type="button" className="btn btn-sm btn-primary" disabled={!h.fromId || !h.toId} onClick={async () => {
        if (!window.confirm('Hand these records over now?')) return; // eslint-disable-line no-alert
        try { const r = await api.post('/crm/plus/transfer', h); toast(`Handed over: ${Object.entries(r.data.moved).map(([k, n]) => `${n} ${k}`).join(', ')}.`); setH({ ...h }); } catch (e) { toast(errOf(e, 'It could not be handed over.')); }
      }}>Hand over</button>
    </div>
  );
}

function Payments() {
  const save = useSave();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/plus/paylink-settings').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>Off by default. When on, a sent CRM invoice gets a &quot;Pay online&quot; box: a Razorpay payment link for the balance (the invoice turns Paid by itself when Razorpay says so), or a UPI link and QR code. The CRM keeps its own invoices; nothing goes to Accounts.</p>
      <Check checked={d.enabled} disabled={!d.canChange} onChange={(v) => setD({ ...d, enabled: v })}>Online payment for CRM invoices</Check>
      <div className="grid-2" style={{ marginTop: 6 }}>
        <div className="field"><label>Company UPI ID</label><input type="text" disabled={!d.canChange} placeholder="teamlink@icici" value={d.upiId} onChange={(e) => setD({ ...d, upiId: e.target.value })} /></div>
        <div className="field"><label>Name shown in the UPI app</label><input type="text" disabled={!d.canChange} value={d.payeeName} onChange={(e) => setD({ ...d, payeeName: e.target.value })} /></div>
      </div>
      <div className="card" style={{ padding: 10, fontSize: 13, marginBottom: 8 }}>
        Razorpay: <b>{d.razorpay.configured ? 'connected' : 'not connected'}</b>{d.razorpay.configured && !d.razorpay.webhookSet ? ' (no webhook secret: invoices will not turn Paid by themselves)' : ''}.
        <div className="small-muted" style={{ fontSize: 12 }}>The keys go in Administration &gt; Integrations &gt; Payment Gateway (Provider: Razorpay, Key ID, Key secret, Webhook secret). In the Razorpay dashboard, add the webhook <code style={{ overflowWrap: 'anywhere' }}>{d.webhookUrl}</code> for the event payment_link.paid.</div>
      </div>
      {d.canChange ? <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/paylink-settings', { enabled: d.enabled, upiId: d.upiId, payeeName: d.payeeName }), 'Payment settings saved.')}>Save</button> : <div className="small-muted">Only an Admin changes this.</div>}
    </div>
  );
}

function Privacy() {
  const save = useSave();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/plus/privacy').then((r) => setD({ ...r.data, purposes: lines(r.data.purposes) })).catch(() => setD(null)); }, []);
  if (!d) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <p className="small-muted" style={{ marginTop: 0 }}>The privacy notice for CRM leads and contacts (DPDP Act 2023), version {d.noticeVersion}. It is public at <a href="/api/crm-public/privacy-notice" target="_blank" rel="noreferrer">/api/crm-public/privacy-notice</a>; a website form that sends consent=1 records the person&#39;s consent by itself. A changed notice becomes a new version.</p>
      <div className="field"><label>Notice</label><textarea rows={5} value={d.noticeText} onChange={(e) => setD({ ...d, noticeText: e.target.value })} /></div>
      <div className="field"><label>What the details are used for (one per line)</label><textarea rows={3} value={d.purposes} onChange={(e) => setD({ ...d, purposes: e.target.value })} /></div>
      <div className="grid-3">
        <div className="field"><label>Grievance Officer</label><input type="text" value={d.grievanceName} onChange={(e) => setD({ ...d, grievanceName: e.target.value })} /></div>
        <div className="field"><label>Email</label><input type="email" value={d.grievanceEmail} onChange={(e) => setD({ ...d, grievanceEmail: e.target.value })} /></div>
        <div className="field"><label>Phone</label><input type="text" value={d.grievancePhone} onChange={(e) => setD({ ...d, grievancePhone: e.target.value })} /></div>
      </div>
      <button type="button" className="btn btn-sm btn-primary" onClick={async () => { const r = await save(() => api.put('/crm/plus/privacy', { ...d, purposes: unlines(d.purposes) }), 'Privacy notice saved.'); if (r) setD({ ...r.data, purposes: lines(r.data.purposes) }); }}>Save notice</button>
    </div>
  );
}

function Other() {
  const save = useSave();
  const [c, setC] = useState(null);
  const [rn, setRn] = useState(null);
  useEffect(() => {
    api.get('/crm/plus/collab-settings').then((r) => setC(r.data)).catch(() => setC({ mentionEmail: false }));
    api.get('/crm/plus/recurring').then((r) => setRn(r.data.settings)).catch(() => setRn({ autoRenewalDeals: false, daysBefore: 60 }));
  }, []);
  if (!c || !rn) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="section-label" style={{ marginTop: 0 }}>Mentions</div>
      <p className="small-muted" style={{ marginTop: 0 }}>A teammate @mentioned in a comment always gets a bell. An email as well is off until you turn it on.</p>
      <Check checked={c.mentionEmail} onChange={(v) => setC({ mentionEmail: v })}>Also email a teammate who is mentioned</Check>
      <div><button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 6 }} onClick={() => save(() => api.put('/crm/plus/collab-settings', c))}>Save</button></div>
      <div className="section-label">Renewal deals</div>
      <p className="small-muted" style={{ marginTop: 0 }}>A won deal with monthly / quarterly / yearly billing renews after its term (12 months unless set). &quot;Make renewal deal&quot; is always on the deal; making them by themselves is off until you turn it on.</p>
      <div style={row}>
        <Check checked={rn.autoRenewalDeals} onChange={(v) => setRn({ ...rn, autoRenewalDeals: v })}>Make the renewal deal by itself</Check>
        <select value={rn.daysBefore} onChange={(e) => setRn({ ...rn, daysBefore: Number(e.target.value) })} style={{ width: 'auto' }} aria-label="Days before">{[30, 45, 60, 90].map((n) => <option key={n} value={n}>{n} days before the renewal</option>)}</select>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save(() => api.put('/crm/plus/renewal-settings', rn))}>Save</button>
      </div>
    </div>
  );
}

export default function CrmPlusSettings() {
  const [part, setPart] = useState('pipelines');
  const BODY = { pipelines: Pipelines, prices: Prices, quotes: Quotes, teams: TeamsTerritories, security: Security, payments: Payments, privacy: Privacy, other: Other };
  const Body = BODY[part];
  return (
    <div style={{ marginTop: 16 }}>
      <div className="section-label">Deals, quotes, teams and security</div>
      <div className="tabs" role="tablist" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {PARTS.map(([k, l]) => <div key={k} role="tab" tabIndex={0} aria-selected={part === k} className={`tab${part === k ? ' active' : ''}`} onClick={() => setPart(k)} onKeyDown={(e) => { if (e.key === 'Enter') setPart(k); }}>{l}</div>)}
      </div>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>Each part here has its own Save button (the Save at the bottom of this window is for the settings above).</div>
      <Body />
    </div>
  );
}

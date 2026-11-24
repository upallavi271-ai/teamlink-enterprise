// ---------------------------------------------------------------------------
// CRM WAVE D SCREENS (2026-11-24) - all inside the five CRM modules (no new sidebar item):
//   on a deal         Products (lines, price book, bundles, MRR), Team (credit splits), Team chat (comments with @mentions, live),
//                     History (stages with days, the stage checklist, pipeline move, field history), Contracts, quote templates / versions /
//                     approval (in Proposals), the payment link (in Invoice)
//   on a lead         Comments, Consent (DPDP), History, territory;  on an account: Comments, History, territory
//   Deals page        Approvals (one inbox), Analysis (velocity, cycle, forecast, MRR / ARR, renewals), Contracts; bulk edit in the List
// The server decides who sees and changes what (backend/src/crm/pipelines.js, catalog.js, collab.js, payLink.js, consent.js).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, money, moneyShort, dateOf, dateTimeOf, istToday, Pill, RecLink, download } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

// ---- what the pages read from /crm/plus/config ------------------------------------------------------------------------
export const plusOf = (me) => (me && me.plus) || { pipelines: [{ id: 'default', name: 'Sales pipeline', stages: (me ? me.lists.stages : []).filter((s) => !['Won', 'Lost'].includes(s)).map((name) => ({ name, checklist: [], required: [] })), allStages: me ? me.lists.stages : [] }], fieldRules: {}, territories: [], teams: [], forecastCategories: ['Pipeline', 'Best case', 'Commit', 'Omitted'], billings: ['One-time', 'Monthly', 'Quarterly', 'Yearly'], payments: { enabled: false }, privacy: { purposes: [], channels: [] }, contractKinds: ['Sales order', 'Contract'], contractStatuses: ['Draft', 'Active', 'Expired', 'Renewed', 'Cancelled'] };
export const pipelineOfDeal = (me, deal) => { const pl = plusOf(me).pipelines; return pl.find((p) => p.id === ((deal && deal.pipelineId) || 'default')) || pl[0]; };
export const stagesOfDeal = (me, deal) => (pipelineOfDeal(me, deal) || {}).allStages || me.lists.stages;
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000)) : 0);
const fieldRule = (me, kind, k) => ((plusOf(me).fieldRules || {})[kind] || {})[k];
export const fieldHidden = (me, kind, k) => fieldRule(me, kind, k) === 'hide';
export const fieldReadOnly = (me, kind, k) => fieldRule(me, kind, k) === 'read';
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : 0; };
const tbl = { width: '100%', fontSize: 13 };

// ---- Products on a deal ---------------------------------------------------------------------------------------------
export function DealProducts({ deal, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [lines, setLines] = useState([]);
  const [book, setBook] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api.get(`/crm/plus/deals/${deal.id}/lines`).then((r) => { setD(r.data); setLines(r.data.lines.map((l) => ({ ...l }))); setBook(r.data.priceBookId || ''); setErr(''); }).catch((e) => setErr(errOf(e, 'The products could not be read.')));
  useEffect(() => { load(); }, [deal.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const closed = ['Won', 'Lost'].includes(deal.stage);
  const can = d.canEdit && !closed;
  const set = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i, v) => {
    if (v === 'custom') { set(i, { productKey: null, plan: null }); return; }
    const c = d.catalogue.find((x) => `${x.productKey}|${x.plan}` === v);
    if (c) set(i, { productKey: c.productKey, plan: c.plan, name: c.name, unitPrice: c.price, listPrice: c.listPrice, billing: c.billing });
  };
  const net = (l) => num(l.qty) * num(l.unitPrice) * (1 - num(l.discountPercent) / 100);
  const subtotal = lines.reduce((n, l) => n + net(l), 0);
  async function save(extra = {}) {
    setBusy(true);
    try {
      const r = await api.put(`/crm/plus/deals/${deal.id}/lines`, { lines, priceBookId: book || null, ...extra });
      setD(r.data); setLines(r.data.lines.map((l) => ({ ...l })));
      toast(r.data.notes && r.data.notes.length ? `Saved. ${r.data.notes.join('; ')}` : 'Products saved. The deal value is their total.');
      if (onChanged) onChanged();
    } catch (e) { toast(errOf(e, 'The products could not be saved.')); } finally { setBusy(false); }
  }
  async function bundle(id) {
    if (!id) return;
    setBusy(true);
    try { const r = await api.post(`/crm/plus/deals/${deal.id}/bundle`, { bundleId: id }); setD(r.data); setLines(r.data.lines.map((l) => ({ ...l }))); toast('Bundle added.'); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The bundle could not be added.')); } finally { setBusy(false); }
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="small-muted">Price book:</span>
        <select value={book} disabled={!can} onChange={(e) => setBook(e.target.value)} style={{ width: 'auto' }} aria-label="Price book">
          <option value="">{d.priceBook && !d.priceBookId ? `${d.priceBook.name} (fits this customer)` : 'List prices / the one that fits'}</option>
          {d.priceBooks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {can && d.bundles.length > 0 && (
          <select value="" onChange={(e) => bundle(e.target.value)} style={{ width: 'auto' }} aria-label="Add a bundle">
            <option value="">+ Add a bundle…</option>
            {d.bundles.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.discountPercent}% off)</option>)}
          </select>
        )}
        <span style={{ marginLeft: 'auto' }} className="small-muted">MRR <b>{money(d.mrr)}</b> · ARR <b>{money(d.mrr * 12)}</b></span>
      </div>
      <div className="tbl-wrap">
        <table style={tbl}>
          <thead><tr><th>Product</th><th>Description</th><th style={{ width: 70 }}>Qty</th><th style={{ width: 110 }}>Unit price</th><th style={{ width: 70 }}>Disc. %</th><th style={{ width: 110 }}>Billing</th><th style={{ textAlign: 'right' }}>Amount</th>{can && <th aria-label="Remove" />}</tr></thead>
          <tbody>
            {!lines.length && <tr><td colSpan={8} className="small-muted">No products yet. Add a line, or a bundle. With lines, the deal value is their total.</td></tr>}
            {lines.map((l, i) => (
              <tr key={l.id || i}>{/* eslint-disable-line react/no-array-index-key */}
                <td>
                  <select disabled={!can} value={l.productKey ? `${l.productKey}|${l.plan}` : 'custom'} onChange={(e) => pick(i, e.target.value)} aria-label="Product">
                    <option value="custom">Other (type it)</option>
                    {d.catalogue.map((c) => <option key={`${c.productKey}|${c.plan}`} value={`${c.productKey}|${c.plan}`}>{c.name} · {money(c.price)}</option>)}
                  </select>
                </td>
                <td><input type="text" disabled={!can} value={l.name || ''} onChange={(e) => set(i, { name: e.target.value })} aria-label="Description" />{(l.bundle || l.rule) && <div className="small-muted" style={{ fontSize: 11 }}>{l.bundle ? `Bundle: ${l.bundle}` : `Rule: ${l.rule}`}</div>}</td>
                <td><input type="number" min={0} disabled={!can} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label="Quantity" /></td>
                <td><input type="number" min={0} disabled={!can} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label="Unit price" /></td>
                <td><input type="number" min={0} max={100} disabled={!can} value={l.discountPercent || 0} onChange={(e) => set(i, { discountPercent: e.target.value })} aria-label="Discount" /></td>
                <td><select disabled={!can} value={l.billing || 'One-time'} onChange={(e) => set(i, { billing: e.target.value })} aria-label="Billing">{d.billings.map((b) => <option key={b}>{b}</option>)}</select></td>
                <td style={{ textAlign: 'right' }}><b>{money(net(l))}</b></td>
                {can && <td><button type="button" className="btn btn-sm" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {can && <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { name: '', qty: 1, unitPrice: 0, discountPercent: 0, billing: 'One-time' }])}>+ Line</button>}
        {can && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save products'}</button>}
        <span style={{ marginLeft: 'auto', fontSize: 13 }}>Lines {money(subtotal)}{d.dealDiscountPercent ? ` · deal discount ${d.dealDiscountPercent}%` : ''} · <b>Final {money(d.finalValue)}</b></span>
      </div>
      {d.approvalStatus === 'Pending' && <div className="notice" style={{ marginTop: 8 }}>A discount on this deal waits for a Sales manager&#39;s approval (Deals &gt; Approvals).</div>}
      {closed && <div className="small-muted" style={{ marginTop: 6 }}>A {deal.stage.toLowerCase()} deal keeps its lines. The invoice made on Won carries them.</div>}
    </div>
  );
}

// ---- credit splits --------------------------------------------------------------------------------------------------
export function DealTeam({ deal, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [rows, setRows] = useState([]);
  const load = () => api.get(`/crm/plus/deals/${deal.id}/splits`).then((r) => { setD(r.data); setRows(r.data.splits.map((s) => ({ userId: s.userId, percent: s.percent, role: s.role || '' }))); }).catch(() => setD({ splits: [], people: [] }));
  useEffect(() => { load(); }, [deal.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="small-muted">Loading…</div>;
  const total = rows.reduce((n, r) => n + num(r.percent), 0);
  const people = [...(d.people || [])];
  if (deal.ownerId && !people.some((p) => p.id === deal.ownerId)) people.push({ id: deal.ownerId, name: deal.ownerName });
  async function save() {
    try { await api.put(`/crm/plus/deals/${deal.id}/splits`, { splits: rows }); toast('Credit split saved.'); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The split could not be saved.')); }
  }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="section-label" style={{ marginTop: 0 }}>Who shares the credit {d.custom ? '' : <span className="small-muted" style={{ fontWeight: 400 }}>(no split: the owner has 100%)</span>}</div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>{/* eslint-disable-line react/no-array-index-key */}
          <select disabled={!d.canEdit} value={r.userId} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, userId: e.target.value } : y)))} style={{ flex: 2, minWidth: 140 }} aria-label="Person">
            {!people.some((p) => p.id === r.userId) && <option value={r.userId}>—</option>}
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="number" min={0} max={100} disabled={!d.canEdit} value={r.percent} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, percent: e.target.value } : y)))} style={{ width: 80 }} aria-label="Percent" />
          <input type="text" disabled={!d.canEdit} placeholder="Role (demo, closing…)" value={r.role} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))} style={{ flex: 1, minWidth: 120 }} aria-label="Role" />
          {d.canEdit && rows.length > 1 && <button type="button" className="btn btn-sm" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
        </div>
      ))}
      {d.canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn-sm" onClick={() => setRows((x) => [...x, { userId: (people.find((p) => !x.some((y) => y.userId === p.id)) || {}).id || '', percent: 0, role: '' }])}>+ Person</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={Math.abs(total - 100) > 0.01} onClick={save}>Save split</button>
          <span className="small-muted" style={{ color: Math.abs(total - 100) > 0.01 ? 'var(--red)' : undefined }}>Total {Math.round(total * 100) / 100}% (must be 100%)</span>
        </div>
      )}
    </div>
  );
}

// ---- comments / team chat with @mentions ------------------------------------------------------------------------------
export function Comments({ kind, id, live = false, title }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const load = () => api.get(`/crm/plus/comments/${kind}/${id}`).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The comments could not be read.'), comments: [], people: [] }));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // the deal room reads new lines every 8 seconds while it is open (only what came after the last one)
  const lastAt = useRef(null);
  useEffect(() => { lastAt.current = d && d.comments && d.comments.length ? d.comments[d.comments.length - 1].createdAt : null; }, [d]);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => {
      if (!lastAt.current) { load(); return; }
      api.get(`/crm/plus/comments/${kind}/${id}`, { params: { after: lastAt.current } }).then((r) => {
        if (r.data.comments.length) setD((c) => ({ ...c, comments: [...c.comments, ...r.data.comments.filter((x) => !c.comments.some((y) => y.id === x.id))], participants: r.data.participants }));
      }).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [live, kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [d && d.comments && d.comments.length]);
  const at = /@([^\s@]{0,30})$/.exec(text);
  const suggestions = at && d ? d.people.filter((p) => p.name.toLowerCase().startsWith(at[1].toLowerCase()) || p.name.toLowerCase().includes(at[1].toLowerCase())).slice(0, 6) : [];
  const mention = (p) => { setText((t) => t.replace(/@([^\s@]{0,30})$/, `@${p.name} `)); setPicked((x) => [...new Set([...x, p.id])]); };
  async function post() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.post(`/crm/plus/comments/${kind}/${id}`, { body: text, mentions: picked });
      setText(''); setPicked([]);
      setD((c) => ({ ...c, comments: [...c.comments, r.data.comment] }));
      if (r.data.told.length) toast(`Told ${r.data.told.join(', ')}.`);
      if (r.data.cannotSee.length) toast(`${r.data.cannotSee.join(', ')} cannot open this record, so ${r.data.cannotSee.length === 1 ? 'was' : 'were'} not told.`);
    } catch (e) { toast(errOf(e, 'The comment could not be posted.')); } finally { setBusy(false); }
  }
  async function remove(c) {
    try { await api.delete(`/crm/plus/comments/${c.id}`); setD((x) => ({ ...x, comments: x.comments.filter((y) => y.id !== c.id) })); } catch (e) { toast(errOf(e, 'The comment could not be deleted.')); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  const highlight = (body) => String(body).split(/(@[A-Z][^\s@,.:;!?]*(?: [A-Z][^\s@,.:;!?]*){0,4})/).map((part, i) => (part.startsWith('@') ? <b key={i} style={{ color: 'var(--accent, #2563eb)' }}>{part}</b> : part)); // eslint-disable-line react/no-array-index-key
  return (
    <div>
      {title && <div className="section-label" style={{ marginTop: 0 }}>{title}</div>}
      {live && d.participants && d.participants.length > 0 && <div className="small-muted" style={{ marginBottom: 6 }}>In this room: {d.participants.map((p) => p.name).join(', ')} · new messages appear by themselves</div>}
      {d.error && <div className="notice" role="alert">{d.error}</div>}
      <div ref={box} className="card" style={{ padding: 10, maxHeight: live ? 360 : 300, overflow: 'auto', marginBottom: 8 }}>
        {!d.comments.length && <div className="small-muted">No comments yet. Write one; type @ to tell a teammate.</div>}
        {d.comments.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: c.mine ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
            <div style={{ maxWidth: '85%', background: c.mine ? 'rgba(37, 99, 235, 0.08)' : 'var(--bg-soft, #f4f6fa)', borderRadius: 10, padding: '6px 10px', fontSize: 13.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{highlight(c.body)}</div>
            <div className="small-muted" style={{ fontSize: 11 }}>{c.byName || '—'} · {dateTimeOf(c.createdAt)}{c.mine && <button type="button" className="crm-linkbtn" style={{ marginLeft: 6, fontSize: 11 }} onClick={() => remove(c)}>Delete</button>}</div>
          </div>
        ))}
      </div>
      {d.canComment && (
        <div style={{ position: 'relative' }}>
          <textarea rows={2} value={text} placeholder="Write a comment… type @ to mention a teammate" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) post(); }} aria-label="Comment" />
          {suggestions.length > 0 && (
            <div className="card" style={{ position: 'absolute', zIndex: 6, left: 0, bottom: '100%', padding: 4, minWidth: 220 }}>
              {suggestions.map((p) => <button key={p.id} type="button" className="btn btn-sm" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none' }} onClick={() => mention(p)}>@{p.name}</button>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={post}>{busy ? 'Posting…' : live ? 'Send' : 'Post comment'}</button>
            <span className="small-muted" style={{ fontSize: 11.5 }}>A mentioned teammate gets a bell (Ctrl+Enter sends)</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- history: stages with days, the stage checklist, the pipeline, every changed field ---------------------------------------
export function FieldHistory({ kind, id }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/crm/plus/history/${kind}/${id}`).then((r) => setRows(r.data.history)).catch(() => setRows([])); }, [kind, id]);
  if (!rows) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="section-label">Field changes ({rows.length})</div>
      {!rows.length && <div className="small-muted">No field has been changed since the history started.</div>}
      {rows.length > 0 && (
        <div className="tbl-wrap"><table style={tbl}><thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr></thead>
          <tbody>{rows.map((h) => <tr key={h.id}><td>{dateTimeOf(h.at)}</td><td>{h.label}</td><td style={{ overflowWrap: 'anywhere' }}>{h.fromValue == null || h.fromValue === '' ? '—' : String(h.fromValue).slice(0, 80)}</td><td style={{ overflowWrap: 'anywhere' }}>{h.toValue == null || h.toValue === '' ? '—' : String(h.toValue).slice(0, 80)}</td><td>{h.byName || '—'}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}
export function DealHistory({ deal, canEdit, onChanged }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get(`/crm/plus/deals/${deal.id}/stages`).then((r) => setD(r.data)).catch(() => setD({ history: [] }));
  useEffect(() => { load(); }, [deal.id, deal.stage, deal.pipelineId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function tick(item, done) {
    try { const r = await api.post(`/crm/plus/deals/${deal.id}/checklist`, { stage: deal.stage, item, done }); setD((x) => ({ ...x, ticks: r.data.ticks })); } catch (e) { toast(errOf(e, 'This could not be ticked.')); }
  }
  async function movePipeline(pipelineId) {
    if (!pipelineId) return;
    try { await api.post(`/crm/plus/deals/${deal.id}/pipeline`, { pipelineId }); toast('Moved to the other pipeline.'); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The deal could not be moved.')); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  const ticks = (d.ticks || {})[deal.stage] || {};
  const open = !['Won', 'Lost'].includes(deal.stage);
  const pls = plusOf(me).pipelines;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span>Pipeline: <b>{d.pipeline ? d.pipeline.name : 'Sales pipeline'}</b> · on <b>{deal.stage}</b> for <b>{d.daysInStage} days</b></span>
        {canEdit && open && pls.length > 1 && (
          <select value="" onChange={(e) => movePipeline(e.target.value)} style={{ width: 'auto', marginLeft: 'auto' }} aria-label="Move to another pipeline">
            <option value="">Move to another pipeline…</option>
            {pls.filter((p) => p.id !== (deal.pipelineId || 'default')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {open && (d.checklist || []).length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Checklist for {deal.stage}{d.mustTick ? ' (all of it before the deal moves on)' : ''}</div>
          {d.checklist.map((c) => (
            <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500, margin: '4px 0' }}>
              <input type="checkbox" style={{ width: 'auto' }} disabled={!canEdit} checked={!!ticks[c]} onChange={(e) => tick(c, e.target.checked)} /> {c}
              {ticks[c] && <span className="small-muted" style={{ fontSize: 11 }}>· {ticks[c].by || ''} {dateTimeOf(ticks[c].at)}</span>}
            </label>
          ))}
        </div>
      )}
      {open && (d.stages || []).some((s) => s.required.length) && (
        <div className="small-muted" style={{ marginBottom: 10 }}>To enter a stage: {d.stages.filter((s) => s.required.length).map((s) => `${s.name} needs ${s.required.join(', ')}`).join(' · ')}</div>
      )}
      <div className="section-label">Stages</div>
      <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Stage</th><th>Entered</th><th>Left</th><th>Days</th><th>Moved by</th></tr></thead>
        <tbody>{(d.history || []).map((h) => <tr key={h.id}><td><b>{h.stage}</b>{h.current ? <span className="small-muted"> · now</span> : null}</td><td>{dateTimeOf(h.enteredAt)}</td><td>{h.leftAt ? dateTimeOf(h.leftAt) : '—'}</td><td>{h.days}</td><td>{h.byName || '—'}</td></tr>)}</tbody>
      </table></div>
      <FieldHistory kind="deal" id={deal.id} />
    </div>
  );
}

// ---- contracts / sales orders on a deal, and all of them on the Deals page ----------------------------------------------
function ContractForm({ deal, onClose, onSaved }) {
  const { me, toast } = useCrm();
  const P = plusOf(me);
  const [f, setF] = useState({ kind: 'Contract', title: deal.title, status: deal.stage === 'Won' ? 'Active' : 'Draft', startDate: istToday(), endDate: '', renewalDate: '', value: deal.finalValue != null ? deal.finalValue : deal.value, billing: deal.billing || '', poNumber: '', terms: '', remindDays: 30 });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    try { const r = await api.post(`/crm/plus/deals/${deal.id}/contracts`, f); toast(`${r.data.contract.code} made.`); onSaved(); } catch (e) { toast(errOf(e, 'It could not be saved.')); }
  }
  return (
    <Modal title="New sales order / contract" size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="grid-2">
        <div className="field"><label>Type</label><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{P.contractKinds.map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}>{P.contractStatuses.map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title</label><input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="field"><label>Starts</label><input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
        <div className="field"><label>Ends</label><input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
        <div className="field"><label>Renewal date</label><input type="date" value={f.renewalDate} onChange={(e) => set('renewalDate', e.target.value)} /><div className="small-muted" style={{ fontSize: 11.5 }}>Empty = the end date. An active one gets a follow-up before it.</div></div>
        <div className="field"><label>Follow-up this many days before the renewal</label><input type="number" min={0} max={180} value={f.remindDays} onChange={(e) => set('remindDays', e.target.value)} /></div>
        <div className="field"><label>Value (₹)</label><input type="number" min={0} value={f.value} onChange={(e) => set('value', e.target.value)} /></div>
        <div className="field"><label>Billing</label><select value={f.billing} onChange={(e) => set('billing', e.target.value)}><option value="">—</option>{P.billings.map((b) => <option key={b}>{b}</option>)}</select></div>
        <div className="field"><label>Customer PO number</label><input type="text" value={f.poNumber} onChange={(e) => set('poNumber', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Terms</label><textarea rows={3} value={f.terms} onChange={(e) => set('terms', e.target.value)} /></div>
      </div>
      <div className="small-muted">The deal&#39;s product lines are copied onto it.</div>
    </Modal>
  );
}
function ContractRows({ rows, canEdit, onChanged, showDeal }) {
  const { me, toast } = useCrm();
  async function status(c, s) {
    try { await api.put(`/crm/plus/contracts/${c.id}`, { status: s }); toast('Saved.'); onChanged(); } catch (e) { toast(errOf(e, 'It could not be saved.')); }
  }
  if (!rows.length) return <div className="small-muted">No sales orders or contracts yet.</div>;
  return (
    <div className="tbl-wrap"><table style={tbl}><thead><tr><th>No.</th><th>Type</th><th>Title</th>{showDeal && <th>Customer</th>}<th>Dates</th><th>Renews</th><th style={{ textAlign: 'right' }}>Value</th><th>Status</th></tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.id}>
          <td style={{ fontFamily: 'monospace' }}>{c.code}</td><td>{c.kind}</td><td>{showDeal && c.dealId ? <RecLink kind="deal" id={c.dealId}>{c.title}</RecLink> : c.title}{c.poNumber ? <div className="small-muted" style={{ fontSize: 11 }}>PO {c.poNumber}</div> : null}</td>
          {showDeal && <td>{c.accountName || '—'}</td>}
          <td>{c.startDate ? dateOf(c.startDate) : '—'} → {c.endDate ? dateOf(c.endDate) : '—'}</td>
          <td style={{ color: c.renewalSoon ? 'var(--red)' : undefined }}>{c.renewalDate ? dateOf(c.renewalDate) : '—'}</td>
          <td style={{ textAlign: 'right' }}>{money(c.value)}</td>
          <td>{canEdit ? <select value={c.status} onChange={(e) => status(c, e.target.value)} style={{ width: 'auto' }} aria-label="Status">{plusOf(me).contractStatuses.map((s) => <option key={s}>{s}</option>)}</select> : <Pill v={c.shownStatus} />}{c.shownStatus !== c.status ? <div className="small-muted" style={{ fontSize: 11 }}>past its end date</div> : null}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
export function ContractsBox({ deal, canEdit }) {
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.get('/crm/plus/contracts', { params: { dealId: deal.id } }).then((r) => setRows(r.data.contracts)).catch(() => setRows([]));
  useEffect(() => { load(); }, [deal.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="section-label" style={{ margin: 0 }}>Sales orders &amp; contracts</div>
        {canEdit && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>+ Order / contract</button>}
      </div>
      {rows == null ? <div className="small-muted">Loading…</div> : <ContractRows rows={rows} canEdit={canEdit} onChanged={load} />}
      {adding && <ContractForm deal={deal} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </div>
  );
}
export function ContractsView() {
  const { version } = useCrm();
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('');
  const load = () => api.get('/crm/plus/contracts', { params: { status: status || undefined } }).then((r) => setD(r.data)).catch(() => setD({ contracts: [] }));
  useEffect(() => { load(); }, [status, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="small-muted">Loading…</div>;
  const active = d.contracts.filter((c) => c.shownStatus === 'Active');
  return (
    <div>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status"><option value="">Every status</option>{(d.statuses || []).map((s) => <option key={s}>{s}</option>)}</select>
        <span className="small-muted">{active.length} active · {money(active.reduce((n, c) => n + (c.value || 0), 0))} · {d.contracts.filter((c) => c.renewalSoon).length} renew within 45 days</span>
      </div>
      <ContractRows rows={d.contracts} canEdit={d.canEdit} onChanged={load} showDeal />
    </div>
  );
}

// ---- quotes: templates, versions, approval (above the proposals of a deal) -------------------------------------------------
export function QuotesPlus({ deal, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [making, setMaking] = useState(null); // { templateId, discountPercent, toName, toEmail }
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/plus/deals/${deal.id}/quotes`).then((r) => setD(r.data)).catch(() => setD({ quotes: [], templates: [] }));
  useEffect(() => { load(); }, [deal.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { load(); if (onChanged) onChanged(); };
  async function make() {
    setBusy(true);
    try { const r = await api.post(`/crm/deals/${deal.id}/proposals`, making); toast(`${r.data.proposal.number} v${r.data.proposal.version} made${r.data.proposal.approvalStatus === 'Pending' ? ' - it waits for a manager\'s approval' : ''}.`); setMaking(null); done(); } catch (e) { toast(errOf(e, 'The quote could not be made.')); } finally { setBusy(false); }
  }
  async function act(q, what, body) {
    try {
      if (what === 'revise') { const r = await api.post(`/crm/plus/proposals/${q.id}/revise`); toast(`Version ${r.data.proposal.version} made.`); }
      if (what === 'approval') { await api.post(`/crm/plus/proposals/${q.id}/approval`, body); toast(body.decision === 'approve' ? 'Approved: it can be emailed now.' : 'Rejected.'); }
      if (what === 'send') {
        const to = window.prompt('Email the quote to:', ''); // eslint-disable-line no-alert
        if (!to) return;
        await api.post(`/crm/proposals/${q.id}/send`, { to }); toast(`Sent to ${to}.`);
      }
      done();
    } catch (e) { toast(errOf(e, 'This did not work.')); }
  }
  if (!d) return null;
  const itemsTemplates = d.templates.filter((t) => t.kind === 'items');
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="section-label" style={{ margin: 0 }}>Quotes and versions ({d.quotes.length})</div>
        {d.canEdit && itemsTemplates.length > 0 && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setMaking({ templateId: itemsTemplates[0].id, discountPercent: deal.discountPercent || 0, toName: '', toEmail: '' })}>+ Quote from a template</button>}
      </div>
      {!d.quotes.length && <div className="small-muted">No quotes yet. A product quotation takes the deal&#39;s product lines; the recruitment proposal is below.</div>}
      {d.quotes.length > 0 && (
        <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Number</th><th>Version</th><th>Template</th><th>Status</th><th>Approval</th><th style={{ textAlign: 'right' }}>Total</th><th aria-label="Actions" /></tr></thead>
          <tbody>{d.quotes.map((q) => (
            <tr key={q.id}>
              <td style={{ fontFamily: 'monospace' }}>{q.number}</td><td>v{q.version || 1}</td><td>{q.templateName}</td><td><Pill v={q.status} /></td>
              <td>{q.approvalStatus && q.approvalStatus !== 'None' ? <><Pill v={q.approvalStatus === 'Approved' ? 'Accepted' : q.approvalStatus === 'Rejected' ? 'Declined' : 'Sent'} /> <span className="small-muted" style={{ fontSize: 11 }}>{q.approvalStatus}{q.approvalByName ? ` · ${q.approvalByName}` : ''}</span></> : <span className="small-muted">—</span>}</td>
              <td style={{ textAlign: 'right' }}>{q.total != null ? money(q.total) : q.feePercent ? `${q.feePercent}% fee` : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="btn btn-sm" onClick={() => download(`/crm/proposals/${q.id}/pdf`, `${q.number}.pdf`, { open: true }).catch(() => toast('The PDF could not be opened.'))}>PDF</button>{' '}
                {d.canEdit && !['Replaced', 'Accepted', 'Declined'].includes(q.status) && <button type="button" className="btn btn-sm" onClick={() => act(q, 'revise')}>Revise</button>}{' '}
                {d.canEdit && q.status === 'Draft' && !['Pending', 'Rejected'].includes(q.approvalStatus) && <button type="button" className="btn btn-sm" onClick={() => act(q, 'send')}>Email</button>}{' '}
                {d.canApprove && q.approvalStatus === 'Pending' && <><button type="button" className="btn btn-sm btn-primary" onClick={() => act(q, 'approval', { decision: 'approve' })}>Approve</button> <button type="button" className="btn btn-sm" onClick={() => act(q, 'approval', { decision: 'reject' })}>Reject</button></>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {making && (
        <Modal title="New quote" onClose={() => setMaking(null)} foot={<><button type="button" className="btn" onClick={() => setMaking(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={make}>{busy ? 'Making…' : 'Make the quote'}</button></>}>
          <div className="field"><label>Template</label><select value={making.templateId} onChange={(e) => setMaking({ ...making, templateId: e.target.value })}>{itemsTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          <div className="grid-2">
            <div className="field"><label>Discount on the whole quote (%)</label><input type="number" min={0} max={100} value={making.discountPercent} onChange={(e) => setMaking({ ...making, discountPercent: e.target.value })} /></div>
            <div className="field"><label>GST %</label><input type="number" min={0} max={50} placeholder="as in CRM settings" value={making.gstPercent ?? ''} onChange={(e) => setMaking({ ...making, gstPercent: e.target.value })} /></div>
            <div className="field"><label>To (name)</label><input type="text" value={making.toName} onChange={(e) => setMaking({ ...making, toName: e.target.value })} /></div>
            <div className="field"><label>To (email)</label><input type="email" value={making.toEmail} onChange={(e) => setMaking({ ...making, toEmail: e.target.value })} /></div>
          </div>
          <div className="small-muted">The quote takes the deal&#39;s product lines (Products tab). A discount over the CRM limit waits for a Sales manager before it can be emailed.</div>
        </Modal>
      )}
    </div>
  );
}

// ---- pay online: Razorpay payment link / UPI (inside the invoice of a deal) ----------------------------------------------
export function PayBox({ inv }) {
  const { me, toast } = useCrm();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/plus/invoices/${inv.id}/pay`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { if (plusOf(me).payments.enabled) load(); }, [inv.id, inv.status, inv.paidAmount]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!plusOf(me).payments.enabled || !d || inv.status === 'Cancelled') return null;
  async function make() {
    setBusy(true);
    try { const r = await api.post(`/crm/plus/invoices/${inv.id}/pay-link`); setD(r.data); toast(r.data.links.length ? 'The payment link is ready: copy it into your WhatsApp or email.' : 'The UPI link is ready.'); } catch (e) { toast(errOf(e, 'The payment link could not be made.')); } finally { setBusy(false); }
  }
  async function check(l) {
    try { const r = await api.post(`/crm/plus/pay-links/${l.id}/refresh`); setD(r.data); toast('Checked.'); } catch (e) { toast(errOf(e, 'Razorpay could not be asked.')); }
  }
  const copy = (t) => { try { navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast(t); } };
  return (
    <div className="card" style={{ padding: 10, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b>💳 Pay online</b><span className="small-muted">Balance {money(d.balance)}</span>
        {me.canEdit && d.balance > 0 && inv.status !== 'Draft' && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={make}>{busy ? 'Making…' : d.razorpay ? 'Make payment link' : 'Show UPI link'}</button>}
      </div>
      {inv.status === 'Draft' && <div className="small-muted" style={{ fontSize: 12 }}>Send the invoice first; then make its payment link.</div>}
      {d.links.map((l) => (
        <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, marginTop: 6 }}>
          <span>{l.provider} · {money(l.amount)}</span><Pill v={l.status === 'paid' ? 'Paid' : 'Sent'} />
          {l.url && <a href={l.url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{l.url}</a>}
          {l.url && <button type="button" className="btn btn-sm" onClick={() => copy(l.url)}>Copy</button>}
          {l.status !== 'paid' && <button type="button" className="btn btn-sm" onClick={() => check(l)}>Check now</button>}
          {l.status === 'paid' && <span className="small-muted">paid {dateTimeOf(l.paidAt)}{l.method ? ` by ${l.method}` : ''}</span>}
        </div>
      ))}
      {d.upi && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          {d.qr && <img src={d.qr} alt="UPI QR code for the balance" width={110} height={110} />}
          <div style={{ fontSize: 12.5, minWidth: 0 }}>UPI for {money(d.balance)}: <a href={d.upi} style={{ overflowWrap: 'anywhere' }}>{d.upi}</a> <button type="button" className="btn btn-sm" onClick={() => copy(d.upi)}>Copy</button><div className="small-muted" style={{ fontSize: 11 }}>A UPI payment is recorded by hand (Record payment); a Razorpay one turns the invoice Paid by itself.</div></div>
        </div>
      )}
    </div>
  );
}

// ---- DPDP consent on a lead ---------------------------------------------------------------------------------------------
export function ConsentBox({ kind, id, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ purpose: 'all', status: 'Given', channel: 'Phone call', note: '' });
  const load = () => api.get(`/crm/plus/consent/${kind}/${id}`).then((r) => setD(r.data)).catch((e) => setD({ error: errOf(e, 'The consent could not be read.') }));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="small-muted">Loading…</div>;
  if (d.error) return <div className="notice" role="alert">{d.error}</div>;
  async function save() {
    try { const r = await api.post(`/crm/plus/consent/${kind}/${id}`, f); setD(r.data); toast(f.status === 'Withdrawn' ? 'Withdrawn: campaigns skip this person from now on.' : 'Consent recorded.'); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'It could not be saved.')); }
  }
  async function exportData() {
    try {
      const r = await api.get(`/crm/plus/consent/${kind}/${id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `personal-data-${kind}-${id}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast(errOf(e, 'The file could not be made.')); }
  }
  async function erase() {
    const word = window.prompt('This erases the person\'s name, phone, email, designation and notes. It cannot be undone.\n\nType ERASE to confirm:'); // eslint-disable-line no-alert
    if (word !== 'ERASE') return;
    try { await api.post(`/crm/plus/consent/${kind}/${id}/erase`, { confirm: 'ERASE' }); toast('Erased.'); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'It could not be erased.')); }
  }
  return (
    <div>
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="section-label" style={{ marginTop: 0 }}>Consent now (DPDP Act 2023)</div>
        {d.current.map((c) => <div key={c.purpose} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '3px 0' }}><span style={{ flex: 1 }}>{c.purpose}</span><Pill v={c.status === 'Given' ? 'Accepted' : c.status === 'Withdrawn' ? 'Declined' : 'Draft'} /><span className="small-muted" style={{ fontSize: 11.5, minWidth: 150 }}>{c.status}{c.at ? ` · ${dateOf(c.at)} · ${c.channel || ''} · notice v${c.noticeVersion || '-'}` : ''}</span></div>)}
        <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>Privacy notice v{d.notice.noticeVersion}: <a href="/api/crm-public/privacy-notice" target="_blank" rel="noreferrer">open the public page</a> (send this link with your first message).</div>
      </div>
      {d.canEdit && !d.erased && (
        <div className="grid-2">
          <div className="field"><label>Purpose</label><select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="all">All purposes</option>{d.notice.purposes.map((p) => <option key={p}>{p}</option>)}</select></div>
          <div className="field"><label>Given or withdrawn</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option>Given</option><option>Withdrawn</option></select></div>
          <div className="field"><label>How</label><select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{d.notice.channels.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Note</label><input type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. said yes on the call" /></div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {d.canEdit && !d.erased && <button type="button" className="btn btn-sm btn-primary" onClick={save}>Record</button>}
        <button type="button" className="btn btn-sm" onClick={exportData}>Download their data</button>
        {d.canErase && !d.erased && <button type="button" className="btn btn-sm" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={erase}>Erase personal details</button>}
      </div>
      <div className="section-label">Record ({d.records.length})</div>
      {d.records.map((x) => <div key={x.id} className="small-muted" style={{ fontSize: 12.5, padding: '2px 0' }}>{dateTimeOf(x.at)} · {x.purpose}: <b>{x.status}</b> · {x.channel || '—'}{x.source ? ` · ${x.source}` : ''} · {x.byName || '—'}</div>)}
    </div>
  );
}

// ---- territory of a lead / account ---------------------------------------------------------------------------------
export function TerritoryPick({ kind, row, canEdit, onChanged }) {
  const { me, toast } = useCrm();
  const list = plusOf(me).territories || [];
  if (!list.length) return null;
  const name = (list.find((t) => t.id === row.territoryId) || {}).name;
  if (!canEdit) return <span>{name || '—'}</span>;
  return (
    <select value={row.territoryId || ''} style={{ width: 'auto', padding: '2px 6px', fontSize: 12.5 }} aria-label="Territory"
      onChange={(e) => api.post(`/crm/plus/territory/${kind}/${row.id}`, { territoryId: e.target.value || null }).then(() => { toast('Territory set.'); if (onChanged) onChanged(); }).catch((er) => toast(errOf(er, 'It could not be set.')))}>
      <option value="">—</option>
      {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

// ---- Deals > Approvals --------------------------------------------------------------------------------------------
export function ApprovalsView({ onCount }) {
  const { toast, openRecord, version } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/plus/approvals').then((r) => { setD(r.data); if (onCount) onCount(r.data.items.length); }).catch(() => setD({ items: [], mentions: [] }));
  useEffect(() => { load(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  async function decide(x, decision) {
    const note = decision === 'reject' ? window.prompt('Why? (optional)', '') : ''; // eslint-disable-line no-alert
    if (note === null) return;
    try {
      if (x.type === 'Quote') await api.post(`/crm/plus/proposals/${x.id}/approval`, { decision, note });
      else await api.post(`/crm/deals/${x.dealId}/approval`, { decision, note });
      toast(decision === 'approve' ? 'Approved.' : 'Rejected.'); load();
    } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  if (!d) return <div className="small-muted">Loading…</div>;
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 8 }}>{d.canDecide ? 'Everything waiting for a Sales manager, in one place.' : 'Your discounts and quotes waiting for a Sales manager.'}</div>
      <div className="tbl-wrap"><table style={tbl}><thead><tr><th>What</th><th>Deal / quote</th><th>Customer</th><th>Owner</th><th>Detail</th><th>Since</th>{d.canDecide && <th aria-label="Decide" />}</tr></thead>
        <tbody>
          {!d.items.length && <tr><td colSpan={7}><div className="empty"><h3>Nothing waiting</h3>Discounts over the limit and quotes that need approval show here.</div></td></tr>}
          {d.items.map((x) => (
            <tr key={`${x.type}${x.id}`}>
              <td><Pill v={x.type === 'Quote' ? 'Sent' : 'Hot'} /> {x.type}</td>
              <td><button type="button" className="crm-linkbtn" onClick={() => openRecord('deal', x.dealId)}>{x.title}</button></td>
              <td>{x.accountName || '—'}</td><td>{x.ownerName || '—'}</td><td style={{ fontSize: 12.5 }}>{x.detail}</td><td>{dateOf(x.since)}</td>
              {d.canDecide && <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm btn-primary" onClick={() => decide(x, 'approve')}>Approve</button> <button type="button" className="btn btn-sm" onClick={() => decide(x, 'reject')}>Reject</button></td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="section-label" style={{ marginTop: 16 }}>Where I was mentioned (30 days)</div>
      {!d.mentions.length && <div className="small-muted">Nobody mentioned you.</div>}
      {d.mentions.map((m) => (
        <div key={m.id} style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--line-soft, #eef0f4)' }}>
          <button type="button" className="crm-linkbtn" onClick={() => openRecord(m.kind, m.recordId)}>{m.record}</button> <span className="small-muted">· {m.byName} · {dateTimeOf(m.createdAt)}</span>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
        </div>
      ))}
    </div>
  );
}

// ---- Deals > Analysis: velocity, cycle, conversion, forecast, MRR / ARR, renewals ------------------------------------------
const Kpi = ({ label, value, sub }) => <div className="card" style={{ padding: 12 }}><div className="small-muted">{label}</div><div style={{ fontSize: 19, fontWeight: 700 }}>{value}</div>{sub && <div className="small-muted" style={{ fontSize: 11.5 }}>{sub}</div>}</div>;
function Forecast() {
  const { me, toast } = useCrm();
  const [month, setMonth] = useState(istToday().slice(0, 7));
  const [d, setD] = useState(null);
  const [mine, setMine] = useState({ commit: '', bestCase: '', note: '' });
  const [adj, setAdj] = useState({});
  const load = () => api.get('/crm/plus/forecast', { params: { month } }).then((r) => { setD(r.data); const m = r.data.rows.find((x) => x.ownerId === me.userId); setMine({ commit: m && m.submission && m.submission.commit != null ? m.submission.commit : (m ? m.autoCommit : ''), bestCase: m && m.submission && m.submission.bestCase != null ? m.submission.bestCase : (m ? m.autoBestCase : ''), note: (m && m.submission && m.submission.note) || '' }); }).catch(() => setD({ rows: [], totals: {} }));
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit() { try { const r = await api.post('/crm/plus/forecast', { month, ...mine }); setD(r.data); toast('Forecast submitted.'); } catch (e) { toast(errOf(e, 'It could not be submitted.')); } }
  async function adjust(ownerId) { try { const r = await api.put('/crm/plus/forecast/adjust', { month, ownerId, ...(adj[ownerId] || {}) }); setD(r.data); toast('Adjusted.'); } catch (e) { toast(errOf(e, 'It could not be saved.')); } }
  if (!d) return <div className="small-muted">Loading…</div>;
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Forecast</div>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} aria-label="Month" />
        <span className="small-muted" style={{ marginLeft: 'auto' }}>Won {money(d.totals.won)} · Commit {money(d.totals.autoCommit)} · Best case {money(d.totals.autoBestCase)} · <b>Final {money(d.totals.final)}</b></span>
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>Commit = won this month + open deals in the Commit category closing this month; Best case adds the Best case deals. A deal&#39;s category is set on it (Edit), or worked out from its probability (80%+ Commit, 50%+ Best case).</div>
      <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Salesperson</th><th style={{ textAlign: 'right' }}>Won</th><th style={{ textAlign: 'right' }}>Commit</th><th style={{ textAlign: 'right' }}>Best case</th><th style={{ textAlign: 'right' }}>Pipeline</th><th>Submitted</th><th>Manager</th><th style={{ textAlign: 'right' }}>Final</th></tr></thead>
        <tbody>{d.rows.map((x) => (
          <tr key={x.ownerId}>
            <td>{x.ownerName || '—'}</td><td style={{ textAlign: 'right' }}>{moneyShort(x.won)}</td><td style={{ textAlign: 'right' }}>{moneyShort(x.autoCommit)}</td><td style={{ textAlign: 'right' }}>{moneyShort(x.autoBestCase)}</td><td style={{ textAlign: 'right' }}>{moneyShort(x.pipeline)}</td>
            <td>{x.submission && x.submission.commit != null ? <span title={x.submission.note || ''}>{moneyShort(x.submission.commit)} / {moneyShort(x.submission.bestCase)}</span> : <span className="small-muted">—</span>}</td>
            <td>{d.canAdjust ? (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <input type="number" min={0} placeholder={x.submission && x.submission.managerCommit != null ? String(x.submission.managerCommit) : 'commit'} value={(adj[x.ownerId] || {}).managerCommit ?? ''} onChange={(e) => setAdj({ ...adj, [x.ownerId]: { ...(adj[x.ownerId] || {}), managerCommit: e.target.value } })} style={{ width: 100 }} aria-label="Manager commit" />
                <button type="button" className="btn btn-sm" onClick={() => adjust(x.ownerId)}>Set</button>
              </span>
            ) : (x.submission && x.submission.managerCommit != null ? `${moneyShort(x.submission.managerCommit)} · ${x.submission.adjustedByName || ''}` : '—')}</td>
            <td style={{ textAlign: 'right' }}><b>{money(x.final)}</b></td>
          </tr>
        ))}</tbody>
      </table></div>
      {me.canEdit && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <span className="small-muted">My forecast:</span>
          <input type="number" min={0} value={mine.commit} onChange={(e) => setMine({ ...mine, commit: e.target.value })} style={{ width: 120 }} aria-label="My commit" placeholder="Commit" />
          <input type="number" min={0} value={mine.bestCase} onChange={(e) => setMine({ ...mine, bestCase: e.target.value })} style={{ width: 120 }} aria-label="My best case" placeholder="Best case" />
          <input type="text" value={mine.note} onChange={(e) => setMine({ ...mine, note: e.target.value })} style={{ flex: 1, minWidth: 140 }} aria-label="Note" placeholder="Note for the manager" />
          <button type="button" className="btn btn-sm btn-primary" onClick={submit}>Submit</button>
        </div>
      )}
    </div>
  );
}
function Recurring() {
  const { toast, openRecord } = useCrm();
  const [d, setD] = useState(null);
  const load = () => api.get('/crm/plus/recurring').then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  async function renew(x) { try { const r = await api.post(`/crm/plus/deals/${x.id}/renewal`); toast(r.data.already ? 'It already has a renewal deal.' : 'Renewal deal made.'); load(); openRecord('deal', r.data.deal.id); } catch (e) { toast(errOf(e, 'The renewal deal could not be made.')); } }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="section-label" style={{ marginTop: 0 }}>Recurring revenue</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
        <Kpi label="MRR" value={money(d.mrr)} sub={`${d.active} active subscriptions`} /><Kpi label="ARR" value={money(d.arr)} /><Kpi label="Renewals in 3 months" value={d.renewalsDue.length} sub={d.settings.autoRenewalDeals ? `renewal deals made ${d.settings.daysBefore} days before` : 'renewal deals by hand'} />
      </div>
      {d.renewalsDue.length > 0 && (
        <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Deal</th><th>Customer</th><th>Renews</th><th style={{ textAlign: 'right' }}>MRR</th><th aria-label="Renew" /></tr></thead>
          <tbody>{d.renewalsDue.map((x) => <tr key={x.id}><td><RecLink kind="deal" id={x.id}>{x.title}</RecLink></td><td>{x.accountName || '—'}</td><td>{dateOf(x.renewalDate)}</td><td style={{ textAlign: 'right' }}>{money(x.mrr)}</td><td><button type="button" className="btn btn-sm" onClick={() => renew(x)}>Make renewal deal</button></td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}
export function AnalysisView() {
  const { me, version } = useCrm();
  const [pipeline, setPipeline] = useState('default');
  const [from, setFrom] = useState(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(istToday());
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/crm/plus/analysis', { params: { pipeline, from, to } }).then((r) => setD(r.data)).catch(() => setD(null)); }, [pipeline, from, to, version]);
  const pls = plusOf(me).pipelines;
  const s = d && d.summary;
  return (
    <div>
      <div className="filter-row">
        {pls.length > 1 && <select value={pipeline} onChange={(e) => setPipeline(e.target.value)} style={{ width: 'auto' }} aria-label="Pipeline">{pls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <span className="small-muted">Closed between</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} aria-label="From" /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} aria-label="To" />
      </div>
      {!d && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
            <Kpi label="Win rate" value={`${s.winRate}%`} sub={`${s.won} won · ${s.lost} lost`} />
            <Kpi label="Sales cycle" value={`${s.avgCycleDays} days`} sub={`median ${s.medianCycleDays} days (created → won)`} />
            <Kpi label="Average won deal" value={money(s.avgWonValue)} />
            <Kpi label="Pipeline velocity" value={`${money(s.velocityPerMonth)} / month`} sub={`${s.open} open deals × win rate × average deal ÷ cycle`} />
          </div>
          <div className="section-label">Stage by stage</div>
          <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Stage</th><th>Deals that entered</th><th>Moved on</th><th>Conversion</th><th>Average days</th><th>Open now</th><th style={{ textAlign: 'right' }}>Open value</th></tr></thead>
            <tbody>{d.stages.map((x) => <tr key={x.stage}><td><b>{x.stage}</b></td><td>{x.entered}</td><td>{x.movedOn}</td><td>{x.conversion == null ? '—' : `${x.conversion}%`}</td><td>{x.avgDays == null ? '—' : x.avgDays}</td><td>{x.open}</td><td style={{ textAlign: 'right' }}>{money(x.openValue)}</td></tr>)}</tbody>
          </table></div>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <div className="section-label">By salesperson</div>
              <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Salesperson</th><th>Win rate</th><th>Cycle (days)</th><th style={{ textAlign: 'right' }}>Won</th></tr></thead>
                <tbody>{d.owners.map((o) => <tr key={o.ownerId}><td>{o.ownerName || '—'}</td><td>{o.winRate}% ({o.won}/{o.won + o.lost})</td><td>{o.avgCycleDays == null ? '—' : o.avgCycleDays}</td><td style={{ textAlign: 'right' }}>{money(o.wonValue)}</td></tr>)}</tbody>
              </table></div>
            </div>
            <div>
              <div className="section-label">Won credit with splits</div>
              <div className="tbl-wrap"><table style={tbl}><thead><tr><th>Person</th><th>Deals</th><th style={{ textAlign: 'right' }}>Credit</th></tr></thead>
                <tbody>{d.credit.map((c) => <tr key={c.userId}><td>{c.name || '—'}</td><td>{c.deals}</td><td style={{ textAlign: 'right' }}>{money(c.credit)}</td></tr>)}</tbody>
              </table></div>
            </div>
          </div>
        </>
      )}
      <div style={{ marginTop: 14 }}><Forecast /></div>
      <Recurring />
    </div>
  );
}

// ---- bulk edit bar for the deal list ----------------------------------------------------------------------------------
export function BulkDealBar({ ids, onDone, onClear }) {
  const { me, toast } = useCrm();
  const P = plusOf(me);
  const [f, setF] = useState({ stage: '', ownerId: '', expectedClose: '', forecastCategory: '', probability: '' });
  const [lost, setLost] = useState('');
  const stages = useMemo(() => [...new Set(P.pipelines.flatMap((p) => p.allStages))], [P.pipelines]);
  async function apply() {
    const set = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
    if (set.stage === 'Lost') set.lostReason = lost;
    try {
      const r = await api.post('/crm/plus/deals/bulk', { ids, set });
      toast(`${r.data.changed} changed${r.data.failed.length ? `; ${r.data.failed.length} not: ${r.data.failed.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join('; ')}` : ''}.`);
      onDone();
    } catch (e) { toast(errOf(e, 'The deals could not be changed.')); }
  }
  return (
    <div className="card" style={{ padding: 10, marginBottom: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <b>{ids.length} ticked</b>
      <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} style={{ width: 'auto' }} aria-label="Stage"><option value="">Stage…</option>{stages.map((s) => <option key={s}>{s}</option>)}</select>
      {f.stage === 'Lost' && <select value={lost} onChange={(e) => setLost(e.target.value)} style={{ width: 'auto' }} aria-label="Lost reason"><option value="">Lost because…</option>{me.lists.lostReasons.map((r) => <option key={r}>{r}</option>)}</select>}
      {me.canAssign && <select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })} style={{ width: 'auto' }} aria-label="Owner"><option value="">Owner…</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      <input type="date" value={f.expectedClose} onChange={(e) => setF({ ...f, expectedClose: e.target.value })} style={{ width: 'auto' }} aria-label="Expected close" />
      <select value={f.forecastCategory} onChange={(e) => setF({ ...f, forecastCategory: e.target.value })} style={{ width: 'auto' }} aria-label="Forecast category"><option value="">Forecast…</option>{P.forecastCategories.map((c) => <option key={c}>{c}</option>)}</select>
      <input type="number" min={0} max={100} placeholder="Prob. %" value={f.probability} onChange={(e) => setF({ ...f, probability: e.target.value })} style={{ width: 90 }} aria-label="Probability" />
      <button type="button" className="btn btn-sm btn-primary" onClick={apply}>Apply</button>
      <button type="button" className="btn btn-sm" onClick={onClear}>Clear</button>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Btn, GsModal, ConfirmModal } from '../ui.jsx';
import { ago } from './tplCommon.jsx';
import { RCS_TYPES } from './rcsShared.jsx';

// The RCS gallery of one assistant: cards with Edit / Copy / Delete, search, type chips, sort. RCS sending is planned: nothing here is sent.
const CHIPS = [['all', 'All', '▦'], ['card', 'Standalone', '▪'], ['carousel', 'Carousel', '◧'], ['text', 'Plain Text', 'T']];

function Thumb({ t }) {
  const f = t.form || {};
  const media = t.type === 'card' ? f.media : (t.type === 'carousel' ? ((f.cards || []).find((c) => c.media) || {}).media : null);
  if (media && media.url) return <img src={media.url} alt="" />;
  const hue = [...String(t.name)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  if (t.type === 'text') return <div className="rcs-thumb-plain"><span>{String(f.text || t.name).slice(0, 90)}</span></div>;
  const n = t.type === 'carousel' ? 3 : 1;
  return <div className="rcs-thumb-cards" style={{ '--h': hue }}>{Array.from({ length: n }).map((_, i) => <div className="rcs-thumb-card" style={{ '--i': i }} key={i}><div className="rcs-thumb-img" /><div className="rcs-thumb-lines"><i /><i /><i style={{ width: '55%' }} /></div></div>)}</div>;
}

export function RcsCreateModal({ agentName, existing, onCancel, onCreate }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [err, setErr] = useState('');
  const ok = name.trim().length >= 2;
  const go = () => {
    if (!ok) { setErr('Give the template a name.'); return; }
    if (existing.some((n) => n.toLowerCase() === name.trim().toLowerCase())) { setErr(`This account already has a template called "${name.trim()}".`); return; }
    onCreate(name.trim(), type);
  };
  return (
    <GsModal title="Create New Template" sub={agentName} width={620} onClose={onCancel} foot={<><Btn onClick={onCancel}>Cancel</Btn><Btn primary disabled={!ok} onClick={go}>Proceed</Btn></>}>
      <label className="rcs-lbl">Template Name</label>
      <input className="search" style={{ width: '100%' }} autoFocus maxLength={80} placeholder="e.g. Walk-in interview this Saturday" value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      <span className="rcs-hint">You can rename this later.</span>
      <div className="rcs-q">What type of message would you like to create?</div>
      <div className="rcs-type-cards">{RCS_TYPES.map((t) => <button type="button" key={t.key} className={`rcs-type-card${type === t.key ? ' on' : ''}`} onClick={() => setType(t.key)}><span className="rcs-type-ico">{t.icon}</span><b>{t.label}</b><small>{t.desc}</small></button>)}</div>
      {err ? <div style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700, marginTop: 10 }}>{err}</div> : null}
      <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 12 }}>RCS sending is planned: templates are saved here, and nothing is sent.</p>
    </GsModal>
  );
}

export default function RcsGallery({ agent, templates, loading, canWrite, onCreate, onOpen, onDuplicate, onDelete }) {
  const [q, setQ] = useState(''); const [filter, setFilter] = useState('all'); const [sort, setSort] = useState('recent'); const [del, setDel] = useState(null);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    let r = templates.filter((t) => (!n || t.name.toLowerCase().includes(n)) && (filter === 'all' || t.type === filter));
    r = sort === 'name' ? [...r].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : [...r].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return r;
  }, [templates, q, filter, sort]);
  return (
    <div>
      <div className="rcs-head"><h2 style={{ overflowWrap: 'anywhere' }}>{agent.name} Templates</h2>{canWrite ? <button type="button" className="set-cta" onClick={onCreate}>＋ Create New Template</button> : null}</div>
      <div className="mp-gate" style={{ marginBottom: 12 }}>RCS sending is planned: nothing is sent. Assistants and templates are saved here so they are ready when RCS is switched on.</div>
      <div className="rcs-toolbar">
        <input className="search rcs-search" aria-label="Search by template name" placeholder="Search by Template Name" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="rcs-chips">{CHIPS.map(([k, l, i]) => <button type="button" key={k} className={`rcs-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}><span>{i}</span> {l}</button>)}</div>
        <div className="rcs-sortwrap"><select className="rcs-sort" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">⇅ Last Modified</option><option value="name">⇅ Name (A-Z)</option></select></div>
      </div>
      {loading && !templates.length ? <div style={{ padding: 30, color: 'var(--muted)' }}>Loading…</div> : rows.length ? (
        <div className="rcs-grid">
          {rows.map((t) => (
            <div key={t.id} className="rcs-card" role="button" tabIndex={0} onClick={() => onOpen(t, 'view')} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t, 'view'); }}>
              <div className="rcs-thumb"><Thumb t={t} />
                <div className="rcs-card-acts">
                  <button type="button" title="Edit" onClick={(e) => { e.stopPropagation(); onOpen(t, 'edit'); }}>✎</button>
                  {canWrite ? <button type="button" title="Make a copy" onClick={(e) => { e.stopPropagation(); onDuplicate(t); }}>⧉</button> : null}
                  {canWrite ? <button type="button" title="Delete" className="del" onClick={(e) => { e.stopPropagation(); setDel(t); }}>🗑</button> : null}
                </div>
              </div>
              <div className="rcs-card-foot"><b>{t.name}</b>
                <div className="rcs-card-meta"><span className="rcs-type">{t.typeWord}</span><span className="rcs-dot">·</span><span>{ago(t.updatedAt)}</span><span className={`pill ${t.status === 'saved' ? 'live' : 'draft'}`}>{t.statusWord}</span></div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rcs-empty"><b>{templates.length ? 'No templates match those filters' : 'No RCS templates yet'}</b><p>{templates.length ? 'Try a different search or filter.' : 'Create one to start building rich cards and carousels.'}</p>
          {templates.length ? <button type="button" className="set-cta" onClick={() => { setFilter('all'); setQ(''); }}>Clear filters</button> : (canWrite ? <button type="button" className="set-cta" onClick={onCreate}>＋ Create New Template</button> : null)}</div>
      )}
      <p className="rcs-count">Showing {rows.length} of {templates.length} template{templates.length === 1 ? '' : 's'}</p>
      {del ? <ConfirmModal danger title={`Delete "${del.name}"?`} text="This cannot be undone." yes="Delete template" onNo={() => setDel(null)} onYes={() => { const t = del; setDel(null); onDelete(t); }} /> : null}
    </div>
  );
}

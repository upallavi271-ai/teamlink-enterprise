import { useCallback, useEffect, useState } from 'react';
import { Btn, PageHead, Banner, GsModal, ConfirmModal, Tabs } from '../ui.jsx';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import SegmentModal from '../crm/SegmentModal.jsx';
import { timeLabel, errText } from '../crm/crmUtil.js';
import '../crm/crm.css';

// ---------------------------------------------------------------------------
// SEGMENTS (our Groups / Audiences): saved rules with a live count. Real data from /api/outreach/gs/crm/segments.
// A card shows the rule in words, how many people match, who can be messaged on each channel, and when it was counted ("Count again" counts afresh).
// "Use in campaign" opens Campaigns with this segment picked (go('campaigns', { segment })). A segment with no rule matches nobody.
// ---------------------------------------------------------------------------
const icon = (s) => (s.kinds.length ? '★' : (s.rules.cities && s.rules.cities.length ? '◎' : (s.rules.fields && s.rules.fields.length ? '↗' : '◆')));
const nf = (n) => Number(n || 0).toLocaleString('en-IN');

export default function SegmentsPage() {
  const { acc, go, toast } = useOmni();
  const [type, setType] = useState(acc && !acc.canPromo && acc.canInternal ? 'internal' : 'candidate_lead');
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null); // { kind: 'edit' | 'preview' | 'dup' | 'del', seg, pv }
  const [dupName, setDupName] = useState('');
  const [dupErr, setDupErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => omni.get('/gs/crm/segments', { type }).then((r) => { setData(r); setErr(''); }).catch((e) => setErr(errText(e, 'The segments could not be loaded.'))), [type]);
  useEffect(() => { setData(null); load(); omni.get('/gs/crm/segments/meta', { type }).then(setMeta).catch(() => {}); }, [load, type]);
  const segs = data ? data.segments : [];
  const use = (s) => {
    if (!s.counts.total) { toast(`No contacts match "${s.name}" right now`); return; }
    go('campaigns', { segment: s.id });
  };
  const preview = async (s) => {
    try { const pv = await omni.get(`/gs/crm/segments/${s.id}/preview`); setModal({ kind: 'preview', seg: s, pv }); } catch (e) { toast(errText(e, 'The preview could not be made.')); }
  };
  const recount = async (s) => {
    setBusy(s.id);
    try { const r = await omni.post(`/gs/crm/segments/${s.id}/refresh`); setData((d) => ({ ...d, segments: d.segments.map((x) => (x.id === s.id ? { ...x, counts: r.counts, countedAt: r.countedAt } : x)) })); toast(`Counted again — ${nf(r.counts.total)} ${r.counts.total === 1 ? 'person' : 'people'}`); } catch (e) { toast(errText(e, 'It could not be counted.')); } finally { setBusy(''); }
  };
  const dup = async () => {
    if (dupName.trim().length < 2) { setDupErr('Give the segment a name.'); return; }
    try { const r = await omni.post(`/gs/crm/segments/${modal.seg.id}/duplicate`, { name: dupName.trim() }); setModal(null); toast(r.ok); load(); } catch (e) { setDupErr(errText(e, 'A segment with that name already exists.')); }
  };
  const del = async () => {
    const s = modal.seg; setModal(null);
    try { await omni.del(`/gs/crm/segments/${s.id}`); toast(`"${s.name}" deleted`); load(); } catch (e) { toast(errText(e, 'It could not be deleted.')); }
  };
  const word = type === 'internal' ? 'group' : 'segment';
  return (
    <div id="segments">
      <PageHead eyebrow="Audience building" title="Segments" lead="Build reusable audiences from customer attributes, behaviour and campaign activity.">
        {data && data.canCreate && <Btn primary onClick={() => setModal({ kind: 'edit', seg: null })}>＋ Create segment</Btn>}
      </PageHead>
      {acc && acc.canInternal && acc.canPromo && <Tabs value={type} onChange={setType} tabs={[['candidate_lead', 'Candidate segments'], ['internal', 'Internal (staff) groups']]} />}
      {err && <Banner tone="error">{err}</Banner>}
      {!data && !err && <div className="card panel">Loading…</div>}
      {data && (
        <div className="grid template-grid" style={{ marginTop: 10 }}>
          {segs.map((s) => (
            <div className="card template-card" key={s.id}>
              <div className="template-top"><div className="template-icon">{icon(s)}</div><span className="pill live">Dynamic</span></div>
              <h3 style={{ overflowWrap: 'anywhere' }}>{s.name}</h3>
              <p style={{ minHeight: 0, marginBottom: 6, overflowWrap: 'anywhere' }}>{s.summary}</p>
              <div className="seg-count"><b>{nf(s.counts.total)}</b> {s.counts.total === 1 ? 'contact matches' : 'contacts match'} right now</div>
              {!s.counts.emptyRule && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>Can be messaged now: WhatsApp {nf(s.counts.reachable.whatsapp)} · Email {nf(s.counts.reachable.email)} · SMS {nf(s.counts.reachable.sms)}</div>}
              <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>Counted at {timeLabel(s.countedAt)}</div>
              <div className="actions" style={{ marginTop: 12 }}>
                {data.canUse && <button type="button" className="btn primary" onClick={() => use(s)}>Use in campaign</button>}
                <button type="button" className="btn" onClick={() => preview(s)}>Preview</button>
                {data.canCreate && <button type="button" className="btn" onClick={() => { setDupName(`${s.name} copy`); setDupErr(''); setModal({ kind: 'dup', seg: s }); }}>Duplicate</button>}
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button type="button" className="tiny-btn" disabled={busy === s.id} onClick={() => recount(s)}>↻ Count again</button>
                {s.canEdit && <button type="button" className="tiny-btn" onClick={() => setModal({ kind: 'edit', seg: s })}>✎ Edit</button>}
                {s.canEdit && <button type="button" className="tiny-btn" aria-label={`Delete ${s.name}`} onClick={() => setModal({ kind: 'del', seg: s })}>🗑</button>}
              </div>
            </div>
          ))}
          {data.canCreate && (
            <button type="button" className="card template-card seg-new" onClick={() => setModal({ kind: 'edit', seg: null })}>
              <div className="template-icon">＋</div><h3>New {word}</h3><p>Build an audience from customer attributes and campaign activity.</p>
            </button>
          )}
          {!segs.length && !data.canCreate && <div className="card panel" style={{ gridColumn: '1/-1' }}>No segments to show yet.</div>}
        </div>
      )}
      {data && !segs.length && data.canCreate && <p style={{ fontSize: 11, color: 'var(--muted)' }}>No segments yet. Press &quot;New {word}&quot; to make the first one.</p>}
      {modal && modal.kind === 'edit' && meta && <SegmentModal seg={modal.seg} type={type} meta={meta} onClose={() => setModal(null)} onSaved={(r) => { setModal(null); toast(r.ok); load(); }} />}
      {modal && modal.kind === 'preview' && (
        <GsModal title={modal.seg.name} sub={`${modal.seg.summary} — ${nf(modal.pv.counts.total)} ${modal.pv.counts.total === 1 ? 'contact matches' : 'contacts match'}.`} width={520} onClose={() => setModal(null)}
          foot={<>{modal.pv.counts.total > 0 && data.canUse && <Btn primary onClick={() => { setModal(null); use(modal.seg); }}>Use this segment</Btn>}<Btn onClick={() => setModal(null)}>Close</Btn></>}>
          {modal.pv.warning && <Banner tone="warn">{modal.pv.warning}</Banner>}
          {modal.pv.people.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
              {modal.pv.people.map((p) => <li key={p.id} style={{ overflowWrap: 'anywhere' }}>{p.name || 'No name'} · {p.phone || p.email || 'no address'}</li>)}
              {modal.pv.counts.total > modal.pv.people.length && <li>… and {nf(modal.pv.counts.total - modal.pv.people.length)} more</li>}
            </ul>
          ) : <p style={{ fontSize: 12 }}>No contacts match this rule yet.</p>}
          <p style={{ fontSize: 10, color: 'var(--muted)' }}>Phone numbers and emails are always hidden in this preview.</p>
        </GsModal>
      )}
      {modal && modal.kind === 'dup' && (
        <GsModal title="Duplicate segment" width={420} onClose={() => setModal(null)} foot={<><Btn onClick={() => setModal(null)}>Cancel</Btn><Btn primary onClick={dup}>Duplicate</Btn></>}>
          <div className="field"><label>NEW SEGMENT NAME</label><input value={dupName} maxLength={80} onChange={(e) => { setDupName(e.target.value); setDupErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') dup(); }} autoFocus /></div>
          {dupErr && <p className="nc-err" role="alert">{dupErr}</p>}
        </GsModal>
      )}
      {modal && modal.kind === 'del' && <ConfirmModal title={`Delete "${modal.seg.name}"?`} text="The people stay in Customers." yes="Delete segment" danger onYes={del} onNo={() => setModal(null)} />}
    </div>
  );
}

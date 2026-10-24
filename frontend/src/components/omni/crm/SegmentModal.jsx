import { useEffect, useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import MultiPick from '../../MultiPick.jsx';
import { Btn, GsModal, Banner } from '../ui.jsx';
import omni from '../omniApi.js';
import { errText } from './crmUtil.js';

// Create / Edit segment: a name and a rule builder (kind, city, import file, language, preferred channel, reachable channels, custom field values) with a LIVE count
// of who would be in it (POST /gs/crm/segments/preview, nothing saved). A segment with no rule matches nobody, never everybody.
const opt = (a) => a.map((x) => ({ value: x, label: x }));
export default function SegmentModal({ seg, type, meta, onClose, onSaved }) {
  const editing = !!seg;
  const [name, setName] = useState(seg ? seg.name : '');
  const r0 = seg ? seg.rules : {};
  const [rules, setRules] = useState({ industries: r0.industries || [], cities: r0.cities || [], importIds: r0.importIds || [], languages: r0.languages || [], preferred: r0.preferred || [], reachable: r0.reachable || [], fields: r0.fields || [] });
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = useRef(0);
  const set = (k) => (v) => setRules((r) => ({ ...r, [k]: v }));
  useEffect(() => {
    const id = n.current + 1; n.current = id;
    const t = setTimeout(() => { omni.post('/gs/crm/segments/preview', { contactType: type, rules }).then((r) => { if (n.current === id) setPv(r); }).catch(() => {}); }, 350);
    return () => clearTimeout(t);
  }, [rules, type]);
  const usedKeys = rules.fields.map((f) => f.key);
  const addField = () => { const f = meta.fields.find((x) => !usedKeys.includes(x.id)); if (f) setRules((r) => ({ ...r, fields: [...r.fields, { key: f.id, values: [] }] })); };
  const setFieldRule = (i, patch) => setRules((r) => ({ ...r, fields: r.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const save = async () => {
    setErr('');
    if (name.trim().length < 2) { setErr('Give the segment a name.'); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), contactType: type, rules: { ...rules, fields: rules.fields.filter((f) => f.values.length) } };
      const r = editing ? await omni.put(`/gs/crm/segments/${seg.id}`, body) : await omni.post('/gs/crm/segments', body);
      onSaved(r);
    } catch (e) { setErr(errText(e, 'The segment could not be saved.')); } finally { setBusy(false); }
  };
  const isInternal = type === 'internal';
  return (
    <GsModal title={editing ? 'Edit segment' : 'Create segment'} sub="Pick who is in it. The list is always live: people who opt out leave it by themselves." width={640} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={save} disabled={busy}>{editing ? 'Save segment' : 'Create segment'}</Btn></>}>
      <div className="field"><label>SEGMENT NAME</label><input value={name} maxLength={80} placeholder="High-intent leads" onChange={(e) => setName(e.target.value)} autoFocus /></div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="field"><label>{isInternal ? 'KIND' : 'KIND (INDUSTRY)'}</label><MultiPick options={opt(meta.kinds)} value={rules.industries} onChange={set('industries')} placeholder="Any kind" /></div>
        <div className="field"><label>CITY</label><MultiPick options={opt(meta.cities)} value={rules.cities} onChange={set('cities')} placeholder="Any city" allowCustom /></div>
        <div className="field"><label>IMPORT FILE</label><MultiPick options={meta.imports.map((i) => ({ value: i.id, label: i.name, sub: `${i.count} people` }))} value={rules.importIds} onChange={set('importIds')} placeholder="Any file" /></div>
        <div className="field"><label>LANGUAGE</label><MultiPick options={opt(meta.languages)} value={rules.languages} onChange={set('languages')} placeholder="Any language" allowCustom /></div>
        <div className="field"><label>PREFERRED CHANNEL</label><MultiPick options={meta.preferred.map((p) => ({ value: p.id, label: p.label }))} value={rules.preferred} onChange={set('preferred')} placeholder="Any channel" /></div>
        <div className="field"><label>CAN BE REACHED ON (PERMISSION GIVEN)</label><MultiPick options={meta.reachable.map((p) => ({ value: p.id, label: p.label }))} value={rules.reachable} onChange={set('reachable')} placeholder="Any" /></div>
      </div>
      {meta.fields.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="panel-title" style={{ fontSize: 11 }}>Custom field values</div>
          {rules.fields.map((f, i) => {
            const def = meta.fields.find((x) => x.id === f.key) || { id: f.key, name: f.key, options: [] };
            return (
              <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,170px) 1fr auto', gap: 8, alignItems: 'start', marginTop: 8 }}>
                <Combo value={f.key} onChange={(e) => setFieldRule(i, { key: e.target.value, values: [] })} required>{meta.fields.filter((x) => x.id === f.key || !usedKeys.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Combo>
                <MultiPick options={opt(def.options)} value={f.values} onChange={(v) => setFieldRule(i, { values: v })} placeholder="Any of these values" />
                <button type="button" className="tiny-btn" aria-label="Remove this rule" onClick={() => setRules((r) => ({ ...r, fields: r.fields.filter((_, j) => j !== i) }))}>×</button>
              </div>
            );
          })}
          {rules.fields.length < meta.fields.length && <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={addField}>＋ Add a custom field rule</button>}
        </div>
      )}
      <div style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', background: '#fafbfa' }}>
        {!pv ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>Counting…</span> : (
          <>
            <div style={{ fontSize: 12 }}><b style={{ fontSize: 18 }}>{pv.counts.total.toLocaleString('en-IN')}</b> {pv.counts.total === 1 ? 'person matches' : 'people match'} right now</div>
            {!pv.counts.emptyRule && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>Can be messaged now: WhatsApp {pv.counts.reachable.whatsapp} · Email {pv.counts.reachable.email} · SMS {pv.counts.reachable.sms}</div>}
            {pv.warning && <div style={{ fontSize: 10.5, color: '#9b6d12', marginTop: 4 }}>{pv.warning}</div>}
          </>
        )}
      </div>
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}

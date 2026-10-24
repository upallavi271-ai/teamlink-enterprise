import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, Planned, ConfirmModal } from '../ui.jsx';
import { PromptModal } from './tplCommon.jsx';

// WhatsApp Flow editor: the screens of a flow (title + type), saved in our own table. Publishing a Flow to WhatsApp is Planned: nothing is published.
export default function FlowEditor({ flowId, types, onChanged, onGone }) {
  const { toast } = useOmni();
  const [flow, setFlow] = useState(null);
  const [screens, setScreens] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const load = () => omni.get('/gs/templates/flows').then((r) => { const fl = (r.flows || []).find((x) => x.id === flowId); if (!fl) { onGone(); return; } setFlow(fl); setScreens(fl.screens); setDirty(false); }).catch((e) => setErr(errOf(e, 'The flow could not be read.')));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [flowId]);
  if (!flow) return <div style={{ padding: 30, color: 'var(--muted)' }}>{err || 'Loading…'}</div>;
  const can = flow.canEdit;
  const edit = (next) => { setScreens(next); setDirty(true); setErr(''); };
  const save = async (patch = {}) => {
    try { const r = await omni.put(`/gs/templates/flows/${flow.id}`, { screens, ...patch }); setFlow(r.flow); setScreens(r.flow.screens); setDirty(false); onChanged(); return true; } catch (e) { setErr(errOf(e, 'It could not be saved.')); return false; }
  };
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= screens.length) return; const n = [...screens]; const [s] = n.splice(i, 1); n.splice(j, 0, s); edit(n); };
  const remove = (i) => { if (screens.length <= 2) { toast('A flow needs at least two screens'); return; } edit(screens.filter((_, k) => k !== i)); };
  const add = () => { const n = [...screens]; n.splice(n.length - 1, 0, { name: 'New screen', type: 'Question' }); edit(n); };
  return (
    <div>
      <div className="tpl-list-head">
        <div><h2>⛭ <span style={{ overflowWrap: 'anywhere' }}>{flow.name}</span></h2><p>{screens.length} screen{screens.length === 1 ? '' : 's'} · Saved here, not published · updated {flow.updatedAt ? new Date(flow.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</p></div>
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can ? <Btn onClick={() => setRename(true)}>✎ Rename</Btn> : null}
          {can ? <Btn onClick={() => setDel(true)}>🗑 Delete</Btn> : null}
          {can ? <Btn onClick={add}>＋ Add screen</Btn> : null}
          {can ? <Btn primary disabled={!dirty} onClick={async () => { if (await save()) toast(`"${flow.name}" saved`); }}>💾 Save flow</Btn> : null}
        </div>
      </div>
      {err ? <div role="alert" style={{ background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '0 0 10px' }}>{err}</div> : null}
      {!can ? <div className="mp-gate" style={{ marginBottom: 10 }}>You can look at this flow but not change it.</div> : null}
      <div className="flow-screens">
        {screens.map((sc, i) => (
          <div className="flow-screen" key={i}>
            <div className="flow-screen-head">SCREEN {i + 1}
              {can ? <><button type="button" className="rcsa-del" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button type="button" className="rcsa-del" title="Move down" disabled={i === screens.length - 1} onClick={() => move(i, 1)}>↓</button><button type="button" className="rcsa-del" title="Remove" disabled={screens.length <= 2} onClick={() => remove(i)}>🗑</button></> : null}
            </div>
            <div className="rcsa-grid">
              <div className="rcsa-f"><label>Screen title</label><input disabled={!can} value={sc.name} onChange={(e) => edit(screens.map((s, k) => (k === i ? { ...s, name: e.target.value } : s)))} /></div>
              <div className="rcsa-f"><label>Screen type</label><select disabled={!can} value={sc.type} onChange={(e) => edit(screens.map((s, k) => (k === i ? { ...s, type: e.target.value } : s)))}>{types.map((t) => <option key={t}>{t}</option>)}</select></div>
            </div>
          </div>
        ))}
      </div>
      <Planned>Publishing a Flow to WhatsApp is not built yet, so a Flow here is only a saved plan. You can still link it to a template button; the button then keeps the Flow&apos;s name.</Planned>
      <p className="tpl-note">Flows are attached to a template from the button editor: pick &quot;Complete flow&quot; as the button action.</p>
      {rename ? <PromptModal title="Rename flow" label="Flow name" initial={flow.name} okLabel="Rename" validate={(v) => (!v.trim() ? 'Give the flow a name.' : '')} onCancel={() => setRename(false)} onOk={async (v) => { if (await save({ name: v })) { toast(`Renamed to ${v}`); setRename(false); } else setRename(false); }} /> : null}
      {del ? <ConfirmModal danger title={`Delete "${flow.name}"?`} text="This cannot be undone. Template buttons that were linked to it keep the name but the flow is gone." yes="Delete flow" onNo={() => setDel(false)} onYes={async () => { try { await omni.del(`/gs/templates/flows/${flow.id}`); toast(`"${flow.name}" deleted`); setDel(false); onChanged(); onGone(); } catch (e) { setErr(errOf(e, 'It could not be deleted.')); setDel(false); } }} /> : null}
    </div>
  );
}

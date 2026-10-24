import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useOmni } from '../omniContext.js';
import { useOmniStore } from '../omniStore.js';
import omni, { errOf } from '../omniApi.js';
import { Banner, Btn, ConfirmModal, Empty, PageHead, Panel, Pill, fmtNum } from '../ui.jsx';
import BotFlowEditor from '../automation/BotFlowEditor.jsx';
import '../automation/automation.css';

// ---------------------------------------------------------------------------
// BOT BUILDER (prototype page "botbuilder"): "Design conversational bot flows that answer questions and route conversations automatically."
// A REAL minimal keyword bot for WhatsApp: a flow = trigger words + optional condition + action (auto-reply, or hand the chat to a person).
// A flow is Off when it is made. It answers for real ONLY when the flow is On AND an Admin has switched "Bot auto-replies" on AND Test mode is off
// AND the person agreed to WhatsApp messages; otherwise it only writes "Would have replied (Test mode)" in the log (see WhatsApp Bot Data).
// Server: /api/outreach/gs/bots (routes/omniGsBots.js -> outreach/bots.js).
// ---------------------------------------------------------------------------
export default function BotBuilderPage() {
  const { acc, go, toast } = useOmni();
  const { workspaces } = useOmniStore();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [edit, setEdit] = useState(null); // { flow|null, focus }
  const [confirm, setConfirm] = useState(null);
  const isAdmin = !!(acc && acc.kind === 'admin');
  const deptNames = useMemo(() => (workspaces && workspaces.list ? workspaces.list.map((w) => w.name) : []), [workspaces]);

  const load = useCallback(() => { omni.get('/gs/bots/flows').then((r) => { setData(r); setErr(''); }).catch((e) => setErr(errOf(e, 'The bot flows could not be loaded.'))); }, []);
  useEffect(() => { load(); }, [load]);

  const flows = data ? data.flows : [];
  const cur = flows.find((f) => f.id === sel) || flows[0] || null;
  const flip = async (f) => {
    try { const r = await omni.post(`/gs/bots/flows/${f.id}/${f.status === 'on' ? 'off' : 'on'}`); toast(f.status === 'on' ? `${f.name} switched off` : `${f.name} switched on`); if (f.status !== 'on' && r.ok) toast(r.ok); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); }
  };
  const remove = async (f) => { try { await omni.del(`/gs/bots/flows/${f.id}`); toast(`${f.name} removed`); setSel(''); load(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };

  const head = (
    <PageHead eyebrow="Automation" title="Bot Builder" lead="Design conversational bot flows that answer questions and route conversations automatically.">
      {data && data.canManage && <Btn primary onClick={() => setEdit({ flow: null, focus: null })}>＋ New Bot Flow</Btn>}
    </PageHead>
  );
  if (err && !data) return <div>{head}<Banner tone="error">{err}</Banner></div>;
  if (!data) return <div>{head}<div className="card panel">Loading…</div></div>;

  return (
    <div>
      {head}
      <Banner tone={data.state.live ? 'info' : 'test'}>
        {data.state.words}{' '}
        <button type="button" className="tiny-btn" style={{ marginLeft: 6 }} onClick={() => go('botdata')}>{data.canSwitch ? 'Open the Admin switch' : 'See what the bot did'}</button>
      </Banner>
      {err && <Banner tone="error">{err}</Banner>}

      {flows.length === 0 && (
        <Panel><Empty title="No bot flows yet" action={data.canManage ? <Btn primary onClick={() => setEdit({ flow: null, focus: null })}>＋ New Bot Flow</Btn> : null}>
          {data.canManage ? 'A flow answers a customer on WhatsApp when their message has your trigger words, or hands the chat to a person. A new flow is Off until you switch it on.' : 'The bot flows of your department will show here.'}
        </Empty></Panel>
      )}

      {cur && (
        <>
          <div className="au-flowtabs" role="tablist">
            {flows.map((f) => <button type="button" role="tab" aria-selected={f.id === cur.id} key={f.id} className={`cd-tab${f.id === cur.id ? ' on' : ''}`} onClick={() => setSel(f.id)}>{f.name}</button>)}
          </div>
          <div className="card panel au-card-gap">
            <div className="panel-top">
              <div>
                <div className="panel-title au-name">{cur.name}</div>
                <div className="panel-sub">{cur.channelWords} · {cur.statusWords}{cur.department ? ` · ${cur.department}` : ' · All departments'}</div>
              </div>
              <div className="actions">
                {cur.canEdit && <Btn onClick={() => flip(cur)}>{cur.status === 'on' ? '⏸ Switch off' : '▶ Switch on'}</Btn>}
                {cur.canEdit && <Btn onClick={() => setConfirm(cur)}>Remove</Btn>}
                <Btn primary onClick={() => setEdit({ flow: cur, focus: null })}>{cur.canEdit ? '✎ Edit flow' : 'Look at the flow'}</Btn>
              </div>
            </div>
            <div className="workflow"><div className="flow-row">
              {cur.nodes.map((n, i, a) => (
                <Fragment key={`${n.kind}${i}`}>
                  <div className={`node ${n.tone}`} role="button" tabIndex={0} title={cur.canEdit ? 'Edit this step' : 'Open'} onClick={() => setEdit({ flow: cur, focus: n.kind })} onKeyDown={(e) => { if (e.key === 'Enter') setEdit({ flow: cur, focus: n.kind }); }}>
                    <span className="node-kicker">{n.kind}</span><b>{n.title}</b><p>{n.detail}</p>
                  </div>
                  {i < a.length - 1 && <div className="arrow">→</div>}
                </Fragment>
              ))}
            </div></div>
          </div>
        </>
      )}

      {flows.length > 0 && (
        <Panel title="All bot flows" sub="Manage and switch your conversational flows">
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Flow name</th><th>Channel</th><th>Conversations handled</th><th>Status</th></tr></thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => setSel(f.id)}>
                    <td className="au-wrap"><b>{f.name}</b>{f.department ? <div className="au-sub">{f.department}</div> : null}</td>
                    <td>{f.channelWords}</td>
                    <td>{fmtNum(f.handled)}{f.uses > f.handled ? <div className="au-sub">{fmtNum(f.uses)} matches this month</div> : null}</td>
                    <td>
                      {f.canEdit
                        ? <button type="button" className="tiny-btn" style={{ border: 0, background: 'none', padding: 0 }} title={f.status === 'on' ? 'Click to switch off' : 'Click to switch on'} onClick={(e) => { e.stopPropagation(); flip(f); }}><Pill tone={f.status === 'on' ? 'live' : 'draft'} dot>{f.statusWords}</Pill></button>
                        : <Pill tone={f.status === 'on' ? 'live' : 'draft'} dot>{f.statusWords}</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {edit && (
        <BotFlowEditor flow={edit.flow} focus={edit.focus} deptNames={deptNames} isAdmin={isAdmin} toast={toast} onClose={() => setEdit(null)}
          onSaved={(f, isNew) => { toast(isNew ? `"${f.name}" created. It is Off until you switch it on` : `${f.name} saved`); if (isNew) setSel(f.id); load(); }} />
      )}
      {confirm && <ConfirmModal danger title="Remove this bot flow?" text={`Remove "${confirm.name}"? It stops answering. Its earlier log lines stay in WhatsApp Bot Data.`} yes="Remove" onNo={() => setConfirm(null)} onYes={() => { const f = confirm; setConfirm(null); remove(f); }} />}
    </div>
  );
}

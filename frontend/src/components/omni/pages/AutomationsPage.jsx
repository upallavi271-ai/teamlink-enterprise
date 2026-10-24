import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useOmni } from '../omniContext.js';
import { useOmniStore } from '../omniStore.js';
import omni, { errOf } from '../omniApi.js';
import { Banner, Btn, ConfirmModal, Empty, PageHead, Panel, Tabs, fmtNum } from '../ui.jsx';
import WorkflowEditor from '../automation/WorkflowEditor.jsx';
import { AddPeople, RunsModal } from '../automation/AutoModals.jsx';
import TasksTab from '../automation/TasksTab.jsx';
import ScheduledTab from '../automation/ScheduledTab.jsx';
import { nodesOf } from '../automation/workflow.js';
import '../automation/automation.css';

// ---------------------------------------------------------------------------
// AUTOMATIONS (prototype page "automation"): "Journey orchestration". Every automation is a real journey of the existing sequences engine: its node chain,
// an On / Off switch, "Edit workflow", the four numbers, who is in it and what happened (names only), tasks for the owner, and (Admin / HR) scheduled
// messages to staff. While Test mode is on nothing is sent: an automation only rehearses.
// Server: /api/outreach/gs/automation (routes/omniGsAutomation.js -> outreach/sequences.js, outreach/scheduled.js).
// ---------------------------------------------------------------------------
export default function AutomationsPage() {
  const { acc, toast } = useOmni();
  const { workspaces } = useOmniStore();
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [tab, setTab] = useState('flows');
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null); // { seq|null, focus }
  const [adding, setAdding] = useState(null);
  const [seen, setSeen] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const isAdmin = !!(acc && acc.kind === 'admin');
  const deptNames = useMemo(() => (workspaces && workspaces.list ? workspaces.list.map((w) => w.name) : []), [workspaces]);

  const load = useCallback(() => {
    omni.get('/gs/automation/').then((r) => { setData(r); setErr(''); }).catch((e) => setErr(errOf(e, 'The automations could not be loaded.')));
    omni.get('/gs/automation/tasks').then((r) => { setTasks(r.tasks || []); setTasksLoading(false); }).catch(() => { setTasks([]); setTasksLoading(false); });
  }, []);
  useEffect(() => { load(); omni.get('/gs/automation/templates').then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([])); }, [load]);
  const tplName = useMemo(() => Object.fromEntries(templates.map((t) => [t.key, t.name])), [templates]);

  const flip = async (s) => {
    setErr('');
    try { const r = await omni.post(`/gs/automation/${s.id}/${s.status === 'on' ? 'off' : 'on'}`); toast(s.status === 'on' ? `${s.name} switched off` : `${s.name} switched on`); if (r && r.ok && s.status !== 'on') toast(r.ok); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); }
  };
  const remove = async (s) => { try { await omni.del(`/gs/automation/${s.id}`); toast(`${s.name} removed`); load(); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } };

  if (err && !data) return <div><PageHead eyebrow="Journey orchestration" title="Automations" lead="Turn customer behavior into repeatable journeys that trigger messages, tasks and follow-ups." /><Banner tone="error">{err}</Banner></div>;
  if (!data) return <div><PageHead eyebrow="Journey orchestration" title="Automations" lead="Turn customer behavior into repeatable journeys that trigger messages, tasks and follow-ups." /><div className="card panel">Loading…</div></div>;
  const k = data.kpis;
  const openTasks = tasks.filter((t) => !t.done).length;
  const tabs = [['flows', 'Automations'], ['tasks', 'Tasks for you', openTasks || undefined]];
  if (data.canScheduled) tabs.push(['scheduled', 'Scheduled messages']);

  return (
    <div>
      <PageHead eyebrow="Journey orchestration" title="Automations" lead="Turn customer behavior into repeatable journeys that trigger messages, tasks and follow-ups.">
        {data.canManage && <Btn primary onClick={() => { setTab('flows'); setEdit({ seq: null, focus: -1 }); }}>＋ Create automation</Btn>}
      </PageHead>
      <Banner tone={data.state.live ? 'info' : 'test'}>{data.state.words}{data.state.quiet ? ` ${data.state.quiet}` : ''}</Banner>
      {err && <Banner tone="error">{err}</Banner>}
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}

      {tab === 'flows' && (
        <>
          {data.sequences.length === 0 && (
            <Panel><Empty title="No automations yet" action={data.canManage ? <Btn primary onClick={() => setEdit({ seq: null, focus: -1 })}>＋ Create automation</Btn> : null}>
              {data.canManage ? 'An automation sends messages and makes tasks for each person, step by step. Press Create automation: it starts with an example you can change.' : 'The automations of your department will show here.'}
            </Empty></Panel>
          )}
          {data.sequences.map((s) => {
            const mine = s.stats || { sent: 0, rehearsed: 0, replied: 0 };
            const inFlow = s.counts.running;
            return (
              <div className="card panel au-card-gap" key={s.id}>
                <div className="panel-top">
                  <div>
                    <div className="panel-title au-name">{s.name}</div>
                    <div className="panel-sub">{s.status === 'on' ? 'On' : 'Off'} automation · {fmtNum(inFlow)} {inFlow === 1 ? 'contact' : 'contacts'} in flow{s.department ? ` · ${s.department}` : ''}</div>
                  </div>
                  <div className="actions">
                    {data.canManage && <Btn onClick={() => flip(s)}>{s.status === 'on' ? '⏸ Switch off' : '▶ Switch on'}</Btn>}
                    {data.canManage && <Btn onClick={() => setAdding(s)}>＋ Add people</Btn>}
                    <Btn onClick={() => setSeen(s)}>What happened</Btn>
                    {data.canManage && <Btn primary onClick={() => setEdit({ seq: s, focus: -1 })}>✎ Edit workflow</Btn>}
                    {data.canManage && <Btn onClick={() => setConfirm(s)}>Remove</Btn>}
                  </div>
                </div>
                <div className="workflow"><div className="flow-row">
                  {nodesOf(s, tplName).map((n, i, a) => (
                    <Fragment key={`${n.kind}${i}`}>
                      <div className={`node ${n.tone}`} role={data.canManage ? 'button' : undefined} tabIndex={data.canManage ? 0 : undefined} title={data.canManage ? 'Edit this step' : undefined}
                        onClick={() => data.canManage && setEdit({ seq: s, focus: n.focus })} onKeyDown={(e) => { if (data.canManage && e.key === 'Enter') setEdit({ seq: s, focus: n.focus }); }}>
                        <span className="node-kicker">{n.kind}</span><b>{n.title}</b><p>{n.detail}</p>
                      </div>
                      {i < a.length - 1 && <div className="arrow">→</div>}
                    </Fragment>
                  ))}
                </div></div>
                <div className="au-line">
                  <span><b>{fmtNum(mine.sent)}</b> sent</span>
                  <span><b>{fmtNum(mine.rehearsed)}</b> rehearsed in Test mode</span>
                  <span><b>{fmtNum(mine.replied)}</b> replied and stopped</span>
                  <span>{fmtNum(s.counts.done)} finished · {fmtNum(s.counts.stopped)} stopped</span>
                  <span>{s.stopOnReply ? 'Stops on reply' : 'Keeps going after a reply'}</span>
                </div>
              </div>
            );
          })}
          <div className="grid automation-metrics">
            <div className="card metric"><small>Contacts in flow</small><b>{fmtNum(k.inFlow)}</b><span className="kpi-meta up">{fmtNum(k.everIn)} have been in an automation</span></div>
            <div className="card metric"><small>Messages sent</small><b>{fmtNum(k.sent)}</b><span className="kpi-meta up">{k.rehearsed ? `${fmtNum(k.rehearsed)} more rehearsed in Test mode` : 'Real messages only'}</span></div>
            <div className="card metric"><small>Goal rate</small><b>{k.goalRate === null ? '—' : `${k.goalRate}%`}</b><span className="kpi-meta up">{k.everIn ? `${fmtNum(k.finished)} of ${fmtNum(k.everIn)} went through every step` : 'No one has been added yet'}</span></div>
            <div className="card metric"><small>Joinings influenced</small><b>Not linked yet</b><span className="kpi-meta">Joinings are not matched to automations, so no number is shown</span></div>
          </div>
        </>
      )}

      {tab === 'tasks' && <TasksTab tasks={tasks} loading={tasksLoading} reload={load} toast={toast} />}
      {tab === 'scheduled' && data.canScheduled && <ScheduledTab toast={toast} />}

      {edit && <WorkflowEditor seq={edit.seq} focus={edit.focus} templates={templates} deptNames={deptNames} isAdmin={isAdmin} toast={toast} onClose={() => setEdit(null)}
        onSaved={(sq, isNew) => { toast(`${sq.name} ${isNew ? 'created. It is Off: switch it on when you are ready' : 'saved'}`); load(); }} />}
      {adding && <AddPeople seq={adding} onClose={() => setAdding(null)} onDone={load} />}
      {seen && <RunsModal seq={seen} onClose={() => setSeen(null)} />}
      {confirm && <ConfirmModal danger title="Remove this automation?" text={`Remove "${confirm.name}"? People still in it are stopped. Messages already sent stay in the message list.`} yes="Remove" onNo={() => setConfirm(null)} onYes={() => { const s = confirm; setConfirm(null); remove(s); }} />}
    </div>
  );
}

import { DataTable, Empty, TinyBtn, Pill, fmtDateTime } from '../ui.jsx';
import omni, { errOf } from '../omniApi.js';

// "Tasks for you": the call / follow-up tasks that automations made for this person (Admin sees everybody's)
export default function TasksTab({ tasks, loading, reload, toast }) {
  const done = async (t) => { try { await omni.post(`/gs/automation/tasks/${t.id}/done`); toast('Marked done'); reload(); } catch (e) { toast(errOf(e, 'That did not work.')); } };
  const cols = [
    { id: 'at', label: 'When', render: (t) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(t.at)}</span>, sort: (t) => t.at || '' },
    { id: 'name', label: 'Person', render: (t) => <b className="au-name">{t.name || '—'}</b>, sort: (t) => t.name || '' },
    { id: 'note', label: 'Task', render: (t) => <span className="au-wrap">{t.note}</span>, search: (t) => t.note },
    { id: 'state', label: 'State', render: (t) => (t.done ? <Pill tone="live">Done</Pill> : <TinyBtn onClick={() => done(t)}>Mark done</TinyBtn>), sort: (t) => (t.done ? 1 : 0) },
  ];
  return (
    <DataTable columns={cols} rows={tasks} loading={loading} persistKey="auto_tasks" searchPlaceholder="Search tasks" defaultSort={{ id: 'state', dir: 'asc' }}
      empty={<Empty title="No tasks yet">When an automation reaches a call or follow-up step, the task shows here for the person who owns it.</Empty>} />
  );
}

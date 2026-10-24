import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Pill } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import { useOmniStore } from '../omniStore.js';
import { useLoad, Err, Switch, SwitchRow } from './adminUtil.jsx';

// Settings > Organisation: the organisation profile (facts, set in Administration), the departments = organisations (head, uses WhatsApp, add a new
// name) and the workspace modules (real switches).
export default function SetOrg({ toast }) {
  const store = useOmniStore();
  const navigate = useNavigate();
  const meta = useLoad(() => omni.get('/config/meta'), []);
  const sw = useLoad(() => omni.get('/gs/admin/switches'), []);
  const [people, setPeople] = useState([]);
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { omni.get('/config/people').then((r) => setPeople(r.people || [])).catch(() => setPeople([])); }, []);
  useEffect(() => { if (meta.data) setRows(meta.data.departments.rows.map((r) => ({ name: r.name, inMaster: r.inMaster, head: r.head || '', whatsapp: r.whatsapp !== false }))); }, [meta.data]);
  const company = (store.workspaces && store.workspaces.company) || 'TeamLink';
  const addName = () => {
    const t = adding.trim();
    setErr('');
    if (t.length < 2) { setErr('That name is too short.'); return; }
    if (rows.some((r) => r.name.toLowerCase() === t.toLowerCase())) { setErr(`You already have an organization called "${t}".`); return; }
    setRows([...rows, { name: t, inMaster: false, head: '', whatsapp: true }]); setAdding('');
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await omni.put('/config/departments', { rows: rows.map((r) => ({ name: r.name, head: r.head || null, whatsapp: r.whatsapp })), extra: rows.filter((r) => !r.inMaster).map((r) => r.name) });
      toast('Organizations saved'); meta.reload();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const putSetting = async (body, done) => { try { await omni.put('/settings', body); toast(done); sw.reload(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  const putSwitch = async (body, done) => { try { await omni.put('/gs/admin/switches', body); toast(done); sw.reload(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  return (
    <>
      <Err text={err || meta.err} />
      <div className="adm-two">
        <Panel title="Organization profile" sub="Brand details used across the workspace.">
          <dl className="adm-kv">
            <dt>Organization</dt><dd>{company}</dd>
            <dt>Time zone</dt><dd>India time (Asia/Kolkata). Every date and time in Omni-Channel uses it.</dd>
            <dt>Currency</dt><dd>INR (₹)</dd>
            <dt>Language</dt><dd>English</dd>
          </dl>
          <div className="adm-note">These are set once for the whole TeamLink company, not here.</div>
          <Btn onClick={() => navigate('/admin/company')}>Open Administration &gt; Company Setup</Btn>
        </Panel>
        <Panel title="Workspace modules" sub="Control which features are active. Each switch is real.">
          {sw.data ? (
            <>
              <SwitchRow label="Campaign approvals" note="Require approval before a BDE's campaign is sent." on={sw.data.approvalRequired} onChange={(v) => putSwitch({ approvalRequired: v }, v ? 'Campaign approvals enabled' : 'Campaign approvals disabled')} />
              <SwitchRow label="Bot auto-replies" note="Let the WhatsApp bots answer by themselves." on={sw.data.botsEnabled} onChange={(v) => putSwitch({ botsEnabled: v }, v ? 'Bot auto-replies enabled' : 'Bot auto-replies disabled')} />
              <SwitchRow label="Internal HR may send" note="The HR desk may send messages to staff (Campaigns > staff)." on={sw.data.internalHrMaySend} onChange={(v) => putSetting({ internalHrMaySend: v }, v ? 'Internal HR may send' : 'Internal HR may not send')} />
            </>
          ) : <div className="adm-note">Loading…</div>}
        </Panel>
      </div>
      <Panel title="Organizations (departments)" sub="In TeamLink an organization is a department. Each has its own people, templates, campaigns and credits."
        right={<Btn primary onClick={save} disabled={busy || !rows}>{busy ? 'Saving…' : 'Save'}</Btn>}>
        {!rows ? <div className="adm-note">Loading…</div> : (
          <>
            <div className="card table-card"><div className="table-scroll"><table className="table">
              <thead><tr><th>Organization</th><th>Head</th><th>Uses WhatsApp</th><th>Where it comes from</th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={r.name}>
                  <td><b>{r.name}</b></td>
                  <td style={{ minWidth: 220 }}>
                    <Combo value={r.head} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, head: e.target.value } : x)))}>
                      <option value="">No head chosen</option>
                      {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.department ? ` (${p.department})` : ''}</option>)}
                    </Combo>
                  </td>
                  <td><Switch on={r.whatsapp} label={`${r.name} uses WhatsApp`} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, whatsapp: v } : x)))} /></td>
                  <td>{r.inMaster ? <Pill tone="live">Department master</Pill> : <Pill tone="scheduled">Added in Omni-Channel</Pill>}</td>
                </tr>
              ))}</tbody>
            </table></div></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <input className="search" style={{ minWidth: 240 }} aria-label="New organization name" maxLength={60} placeholder="Name of a new organization" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addName(); }} />
              <Btn onClick={addName}>＋ New Organization</Btn>
            </div>
            <div className="adm-note">The head is only a name shown to people. A person's real level (Department Head, Team Lead) comes from their role. Real departments are added in Administration &gt; Departments; a name added here only appears in Omni-Channel.</div>
          </>
        )}
      </Panel>
    </>
  );
}

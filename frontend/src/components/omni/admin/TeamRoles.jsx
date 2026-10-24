import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Banner } from '../ui.jsx';
import { PAGES } from '../omniPages.js';
import { useLoad, Err, Switch, SwitchRow } from './adminUtil.jsx';
import { useOmni } from '../omniContext.js';

const HUB_WORDS = [['dashboard', 'Dashboard'], ['inbox', 'WhatsApp inbox'], ['campaigns', 'Campaigns'], ['templates', 'Templates'], ['contacts', 'Contacts / CRM'], ['automation', 'Automations'], ['insights', 'Reports'], ['library', 'Library'], ['configuration', 'Settings']];
const INSIGHT_WORDS = { performance: 'Performance', credits: 'Credits', roi: 'ROI', reports: 'Reports' };
const Tick = ({ yes }) => (yes ? <span className="adm-yes" aria-label="Yes">✓</span> : <span className="adm-no" aria-label="No">–</span>);

// Team & Roles > Roles & permissions. READ ONLY tables made from the same rules the server checks (access.js), the Marketing capability list and the
// Campaign approval switch (Admin only). Nothing here is a copy that could disagree with what the server really does.
export default function TeamRoles() {
  const { acc, toast } = useOmni();
  const { data, err, reload } = useLoad(() => omni.get('/gs/admin/team/roles'), []);
  const admin = !!(data && data.canEdit);
  const [people, setPeople] = useState([]);
  const [ids, setIds] = useState([]);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!data) return;
    setIds((data.marketing || []).map((m) => m.userId));
    if (data.canEdit) omni.get('/config/people').then((r) => setPeople(r.people || [])).catch(() => setPeople([]));
  }, [data]);
  const saveMarketing = async () => {
    setBusy(true); setProblem(''); setMsg('');
    try { await omni.put('/config/permissions/marketing', { userIds: ids }); setMsg('Saved. Those people now get the Marketing role.'); toast('Marketing capability saved'); reload(); } catch (e) { setProblem(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const setApproval = async (on) => {
    setProblem('');
    try { await omni.put('/gs/admin/switches', { approvalRequired: on }); toast(on ? 'Campaign approval is ON' : 'Campaign approval is OFF'); reload(); } catch (e) { setProblem(errOf(e, 'It could not be saved.')); }
  };
  if (err) return <Err text={err} />;
  if (!data) return <div className="card panel">Loading…</div>;
  const kinds = data.table.roles;
  const lv = data.levels;
  const shown = people.filter((p) => !find.trim() || `${p.name} ${p.department}`.toLowerCase().includes(find.trim().toLowerCase()));
  const pageIds = Object.keys(PAGES).filter((id) => Object.values(data.pagesByLevel).some((l) => l.includes(id)));
  return (
    <>
      <Err text={problem} />
      <Panel title="Roles & permissions" sub="Admin and Super Admin always hold every permission and cannot be edited. This table is made from the same rules the server checks, so it can never disagree with what really happens.">
        <div className="table-scroll"><table className="table adm-matrix">
          <thead><tr><th>What they may do</th>{kinds.map((k) => <th key={k.kind}>{k.words}</th>)}</tr></thead>
          <tbody>{data.table.rows.map((r) => <tr key={r.id}><td>{r.words}</td>{kinds.map((k) => <td key={k.kind}><Tick yes={r.allowed[k.kind]} /></td>)}</tr>)}</tbody>
        </table></div>
        {data.table.notes.map((n) => <div className="adm-note" key={n}>{n}</div>)}
        <div className="adm-note"><b>Roles themselves</b> (who is a BDE, a Team Lead, a Manager) are changed in Administration &gt; Role Catalog and Users. Changes apply to everyone holding the role as soon as they sign in again.</div>
      </Panel>

      <Panel title="What each level can open" sub="The levels, the way TeamLink works out a person's level from their role. A tick means the screen is shown to them.">
        <div className="table-scroll"><table className="table adm-matrix">
          <thead><tr><th>Part of Omni-Channel</th>{lv.map((l) => <th key={l.id}>{l.words}{data.peopleByLevel[l.id] ? <div style={{ fontWeight: 500, fontSize: 9 }}>{data.peopleByLevel[l.id]} {data.peopleByLevel[l.id] === 1 ? 'person' : 'people'}</div> : null}</th>)}</tr></thead>
          <tbody>
            {HUB_WORDS.map(([id, label]) => <tr key={id}><td>{label}</td>{lv.map((l) => { const h = l.hubs[id]; return <td key={l.id}>{id === 'insights' ? (Array.isArray(h) && h.length ? <span style={{ fontSize: 9.5 }}>{h.map((t) => INSIGHT_WORDS[t] || t).join(', ')}</span> : <Tick yes={false} />) : <Tick yes={!!h} />}</td>; })}</tr>)}
          </tbody>
        </table></div>
      </Panel>

      <Panel title="Omni-Channel pages each level opens today" sub="Read from the real logins of your company. A dot means nobody holds that level yet.">
        <div className="table-scroll"><table className="table adm-matrix">
          <thead><tr><th>Page</th>{lv.map((l) => <th key={l.id}>{l.words}</th>)}</tr></thead>
          <tbody>{pageIds.map((id) => <tr key={id}><td>{PAGES[id].label}</td>{lv.map((l) => <td key={l.id}>{data.pagesByLevel[l.id] ? <Tick yes={data.pagesByLevel[l.id].includes(id)} /> : <span className="adm-no" title="Nobody holds this level yet">·</span>}</td>)}</tr>)}</tbody>
        </table></div>
        <div className="adm-note">You are signed in as <b>{(acc && acc.levelWords) || data.yourLevel}</b>.</div>
      </Panel>

      <div className="adm-two">
        <Panel title="Campaign approval" sub="Who must say yes before a campaign is sent.">
          <SwitchRow label="Require approval for a BDE's campaign" note={data.approvalWords} on={data.approval.required} onChange={setApproval} disabled={!admin} />
          {!admin && <div className="adm-note">Only an Admin can change this.</div>}
        </Panel>
        <Panel title="Marketing capability" sub={data.marketingWords || 'Marketing: campaigns, promotions, templates, analytics and ROI. Default: nobody.'}
          right={admin ? <Btn primary onClick={saveMarketing} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn> : null}>
          {admin ? (
            <>
              <input className="search" style={{ width: '100%' }} aria-label="Search people" placeholder="Search a person or a department" value={find} onChange={(e) => setFind(e.target.value)} />
              <div className="adm-people">
                {shown.map((p) => (
                  <div className="adm-row" key={p.userId}>
                    <div className="adm-row-main"><b>{p.name}</b><small>{p.department || 'No department'}</small></div>
                    <Switch on={ids.includes(p.userId)} onChange={(on) => setIds(on ? [...ids, p.userId] : ids.filter((x) => x !== p.userId))} label={`Marketing role for ${p.name}`} />
                  </div>
                ))}
                {!shown.length && <div className="adm-note">No person matches.</div>}
              </div>
              {msg && <Banner tone="ok">{msg}</Banner>}
            </>
          ) : (
            (data.marketing || []).length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.8 }}>{data.marketing.map((m) => <li key={m.userId}>{m.name}</li>)}</ul> : <div className="adm-note">Nobody has the Marketing role yet.</div>
          )}
        </Panel>
      </div>
    </>
  );
}

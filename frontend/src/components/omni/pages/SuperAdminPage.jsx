import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Kpis, Kpi, DataTable, GsModal, Field, Banner, fmtNum } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import { useOmni } from '../omniContext.js';
import { setDept } from '../omniStore.js';
import { useLoad, MonthPick, Err, downloadFile, monthWords } from '../admin/adminUtil.jsx';
import SuperSwitches from '../admin/SuperSwitches.jsx';

// Grant credits: give every limited person of a department, or one person, a number of credits to use EVERY month (their monthly allowance).
function GrantModal({ org, onClose, onDone }) {
  const [who, setWho] = useState('all');
  const [people, setPeople] = useState([]);
  const [userId, setUserId] = useState('');
  const [credits, setCredits] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { omni.get('/config/people').then((r) => setPeople((r.people || []).filter((p) => String(p.department || '').toLowerCase() === org.name.toLowerCase()))).catch(() => setPeople([])); }, [org.name]);
  const go = async () => {
    setErr('');
    if (credits === '') { setErr('Enter a number of credits.'); return; }
    if (who === 'one' && !userId) { setErr('Choose a person.'); return; }
    setBusy(true);
    try { const r = await omni.post('/gs/admin/super/grant', who === 'one' ? { userId, credits: Number(credits) } : { department: org.name, credits: Number(credits) }); onDone(r.ok); } catch (e) { setErr(errOf(e, 'It could not be saved.')); setBusy(false); }
  };
  return (
    <GsModal title={`Grant credits to ${org.name}`} sub="Monthly credits" width={470} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={go} disabled={busy}>{busy ? 'Saving…' : 'Grant credits'}</Btn></>}>
      <div className="checks" style={{ marginBottom: 12 }}>
        <button type="button" className={`check${who === 'all' ? ' on' : ''}`} onClick={() => setWho('all')}>Everyone in {org.name}</button>
        <button type="button" className={`check${who === 'one' ? ' on' : ''}`} onClick={() => setWho('one')}>One person</button>
      </div>
      {who === 'one' && (
        <Field label="PERSON"><Combo value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose a person</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</Combo></Field>
      )}
      <Field label="CREDITS EVERY MONTH" hint="Each person may use this many credits each month. Admins have no limit."><input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value.replace(/\D/g, ''))} placeholder="500" /></Field>
      <Err text={err} />
    </GsModal>
  );
}

// Super Admin (prototype "Operator"): in TeamLink an organisation is a department (a workspace). Admin only.
export default function SuperAdminPage() {
  const { toast, go } = useOmni();
  const navigate = useNavigate();
  const [month, setMonth] = useState('');
  const { data, err, loading, reload } = useLoad(() => omni.get('/gs/admin/super/organisations', month ? { month } : {}), [month]);
  const [grant, setGrant] = useState(null);
  const k = data && data.kpis;
  const exportCsv = async () => { try { await downloadFile('/gs/admin/super/organisations.csv', { month: data ? data.month : month }, 'omni-organisations.csv'); toast('Organisations exported'); } catch { toast('You cannot download this.'); } };
  const open = (o) => { setDept(o.noDept ? '' : o.name); go('overview'); toast(`Switched to ${o.name}`); };
  const cols = [
    { id: 'name', label: 'Department', sort: (r) => r.name, render: (r) => <div><b>{r.name}</b>{r.added ? <div style={{ fontSize: 9, color: 'var(--muted)' }}>Added in Omni-Channel</div> : null}</div> },
    { id: 'people', label: 'People', className: 'num', sort: (r) => r.people, render: (r) => fmtNum(r.people) },
    { id: 'used', label: 'Credits used', className: 'num', sort: (r) => r.creditsUsed, render: (r) => fmtNum(r.creditsUsed) },
    { id: 'messages', label: 'Messages sent', className: 'num', sort: (r) => r.messages, render: (r) => fmtNum(r.messages) },
    { id: 'given', label: 'Credits given', className: 'num', sort: (r) => r.creditsGiven, render: (r) => fmtNum(r.creditsGiven) },
    { id: 'left', label: 'Credits left', className: 'num', hide: true, sort: (r) => r.creditsLeft, render: (r) => <span className={r.zeroCredit ? 'sa-over' : ''}>{fmtNum(r.creditsLeft)}</span> },
    { id: 'status', label: 'Status', sort: (r) => r.status, render: (r) => <span style={{ whiteSpace: 'nowrap' }}><Pill tone={r.status === 'Active' ? 'live' : 'draft'} dot>{r.status}</Pill>{!r.noDept && <span className="tag" style={{ marginLeft: 6 }}>{r.whatsapp ? 'WhatsApp on' : 'WhatsApp off'}</span>}</span> },
    { id: 'act', label: '', render: (r) => <div className="row-acts adm-wide"><TinyBtn title={`Open ${r.name}`} onClick={() => open(r)}>↗ Open</TinyBtn>{!r.noDept && <TinyBtn title="Grant credits" onClick={() => setGrant(r)}>✦ Grant credits</TinyBtn>}</div> },
  ];
  return (
    <div>
      <PageHead eyebrow="Operator" title="Super Admin" lead="Every organisation on this deployment, their usage, and the switches that gate features.">
        {data && <MonthPick value={data.month} months={data.months} onChange={setMonth} />}
        <Btn onClick={exportCsv}>⬇ Export organisations</Btn>
      </PageHead>
      <Err text={err} />
      {k && (
        <Kpis>
          <Kpi label="Organisations" icon="◇" value={fmtNum(k.organisations)} meta={`${k.active} active`} />
          <Kpi label="Messages this month" icon="✉" value={fmtNum(k.messages)} meta={`${monthWords(data.month)}, all departments`} />
          <Kpi label="Credits used" icon="✦" value={fmtNum(k.creditsUsed)} meta={`of ${fmtNum(k.creditsGiven)} given`} />
          <Kpi label="People out of credits" icon="!" value={fmtNum(k.zeroCredit)} tone={k.zeroCredit ? 'down' : 'up'} meta={k.zeroCredit ? 'They cannot send until given more' : 'Everybody can still send'} />
        </Kpis>
      )}
      <Panel title="Organisations" sub="In TeamLink an organisation is a department (a workspace). Create a new one in Settings > Organisation."
        right={<Btn onClick={exportCsv}>⬇ Export CSV</Btn>}>
        <DataTable columns={cols} rows={(data && data.rows) || []} rowKey={(r) => r.name} loading={loading} persistKey="adm_super" searchPlaceholder="Search a department" emptyText="No department yet." pageSizes={[10, 25, 50]} />
      </Panel>
      <SuperSwitches toast={toast} />
      <Panel title="Support enter" sub="Looking at the screen exactly as another person sees it.">
        <p style={{ fontSize: 12, lineHeight: 1.7, margin: '0 0 10px' }}>TeamLink already has <b>View as</b> for this: an Admin opens another person's screen (read only, or Act as to edit), and every action is logged against the Admin. It is not rebuilt here.</p>
        <Btn onClick={() => navigate('/admin/view-as')}>Open Administration &gt; View as</Btn>
      </Panel>
      {grant && <GrantModal org={grant} onClose={() => setGrant(null)} onDone={(m) => { setGrant(null); toast(m || 'Credits saved'); reload(); }} />}
      {data && !data.rows.length && !loading && <Banner tone="info">No department has people yet.</Banner>}
    </div>
  );
}

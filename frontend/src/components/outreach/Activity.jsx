import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > ACTIVITY (founder note (g)): per person, for a month: credits given / used / left, messages per channel, follow-ups done,
// promotions, joinings. "My activity" for everybody; "Team activity" for an Admin (everyone), a Manager (everyone, look only) and a Team Lead
// (their department). The server decides the rows and the CSV; Admin also sets one person's credits here. Test-mode messages are shown apart.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const thisMonth = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
const left = (r) => (r.left === null ? 'No limit' : r.left);

function Tiles({ t }) {
  return (
    <div className="oc2-tiles">
      <div className="oc2-tile"><b>{t.people}</b><span>People</span></div>
      <div className="oc2-tile"><b>{t.used}</b><span>Credits used</span></div>
      <div className="oc2-tile"><b>{t.sent}</b><span>Messages sent</span></div>
      <div className="oc2-tile"><b>{t.followUps}</b><span>Follow-ups done</span></div>
      <div className="oc2-tile"><b>{t.promotions}</b><span>Promotions</span></div>
      <div className="oc2-tile g"><b>{t.joinings}</b><span>Joinings given</span></div>
    </div>
  );
}

function Mine({ r }) {
  const low = r.left !== null && r.given > 0 && r.left / r.given <= 0.1;
  return (
    <div>
      <div className="oc2-tiles">
        <div className="oc2-tile"><b>{r.given === null ? 'No limit' : r.given}</b><span>Credits you have this month</span></div>
        <div className={`oc2-tile ${low ? 'r' : ''}`}><b>{r.used}</b><span>Credits you used</span></div>
        <div className={`oc2-tile ${low ? 'r' : 'g'}`}><b>{left(r)}</b><span>Credits left</span></div>
        <div className="oc2-tile"><b>{r.followUps}</b><span>Follow-ups you did</span></div>
        <div className="oc2-tile"><b>{r.promotions}</b><span>Promotions you did</span></div>
        <div className="oc2-tile g"><b>{r.joinings}</b><span>Joinings you gave</span></div>
      </div>
      <div className="oc-note">Messages sent: {r.email} email, {r.whatsapp} WhatsApp, {r.sms} SMS, {r.call} calls logged (calls cost nothing). {r.testSent > 0 ? `${r.testSent} Test-mode messages were rehearsals: they did not use credits.` : ''}</div>
    </div>
  );
}

function SetCredits({ row, month, onClose, onSaved }) {
  const [v, setV] = useState(row.ownAllowance === null ? '' : String(row.ownAllowance));
  const [err, setErr] = useState('');
  const save = async () => {
    try { await api.put(`/outreach/credits/allowance/${row.userId}`, { allowance: v === '' ? null : Number(v) }); onSaved(); onClose(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); }
  };
  return (
    <Modal title={`Credits for ${row.name}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <label className="field"><span>Credits each month (leave empty to use the company number)</span><input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ''))} placeholder="Company number" /></label>
      <div className="oc-note">Month shown: {month}. This number applies to every month until you change it.</div>
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

export default function Activity({ acc }) {
  const [scope, setScope] = useState('me');
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [setFor, setSetFor] = useState(null);
  const [dl, setDl] = useState(false);
  const load = useCallback(() => api.get('/outreach/activity', { params: { scope, month } }).then((r) => { setData(r.data); setErr(''); })
    .catch((e) => { setErr(errOf(e, 'The numbers could not be loaded.')); setData(null); }), [scope, month]);
  useEffect(() => { load(); }, [load]);
  const csv = async () => {
    setDl(true); setErr('');
    try {
      const r = await api.get('/outreach/activity.csv', { params: { month }, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `omni-activity-${month}.csv`; a.click();
    } catch (e) { setErr('The file could not be made. You may not be allowed to download it.'); } finally { setDl(false); }
  };
  return (
    <div>
      {acc.canTeamActivity && (
        <div className="oc2-seg" role="tablist" aria-label="Activity view">
          <button type="button" role="tab" aria-selected={scope === 'me'} className={scope === 'me' ? 'on' : ''} onClick={() => setScope('me')}>My activity</button>
          <button type="button" role="tab" aria-selected={scope === 'team'} className={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>Team activity</button>
        </div>
      )}
      <div className="oc-bar">
        <label className="field" style={{ margin: 0 }}><span>Month</span><input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        {data && <span className="oc-note">{data.scopeWords}. A credit is one message: email {data.rules.cost.email}, WhatsApp {data.rules.cost.whatsapp}, SMS {data.rules.cost.sms}, call {data.rules.cost.call}.</span>}
        {data && data.canExport && <button type="button" className="btn" disabled={dl} onClick={csv}>{dl ? 'Making the file…' : 'Download CSV'}</button>}
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!data && !err && <div className="oc-note">Loading…</div>}
      {data && scope === 'me' && data.rows[0] && <Mine r={data.rows[0]} />}
      {data && scope === 'me' && !data.rows[0] && <div className="oc-empty"><b>No numbers yet.</b><div>Your login is not linked to an employee record, so there is nothing to count.</div></div>}
      {data && scope === 'team' && (
        <>
          <Tiles t={data.totals} />
          <div className="oc-scroll oc2-act">
            <table className="oc2-table">
              <thead>
                <tr><th>Name</th><th>Department</th><th className="num">Credits given</th><th className="num">Used</th><th className="num">Left</th><th className="num">Email</th><th className="num">WhatsApp</th><th className="num">SMS</th><th className="num">Follow-ups</th><th className="num">Promotions</th><th className="num">Joinings</th>{acc.canCredits && <th>Credits</th>}</tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.userId}>
                    <td className="name">{r.name}<span className="oc2-sub">{r.code}{r.testSent ? `, ${r.testSent} test` : ''}</span></td>
                    <td>{r.department}</td>
                    <td className="num">{r.given === null ? 'No limit' : r.given}</td>
                    <td className="num">{r.used}</td>
                    <td className="num">{left(r)}</td>
                    <td className="num">{r.email}</td><td className="num">{r.whatsapp}</td><td className="num">{r.sms}</td>
                    <td className="num">{r.followUps}</td><td className="num">{r.promotions}</td><td className="num">{r.joinings}</td>
                    {acc.canCredits && <td>{r.exempt ? <span className="oc-note">Exempt</span> : <button type="button" className="btn btn-sm" onClick={() => setSetFor(r)}>Set credits</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.rows.length === 0 && <div className="oc-empty"><b>Nobody to show.</b></div>}
          </div>
        </>
      )}
      {setFor && <SetCredits row={setFor} month={month} onClose={() => setSetFor(null)} onSaved={load} />}
    </div>
  );
}

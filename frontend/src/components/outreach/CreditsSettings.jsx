import { useEffect, useState } from 'react';
import api from '../../api';
import './omni2.css';

// OMNI-CHANNEL > SETTINGS > CREDITS (Admin only): the three rules the founder may change. Server: /api/outreach/credits/settings.
const ROLES = [['SUPER_ADMIN', 'Super Admin'], ['ADMIN', 'Admin'], ['MANAGER', 'Manager'], ['ASSISTANT_MANAGER', 'Assistant Manager'], ['TL', 'Team Lead'], ['HR', 'HR']];
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const num = (v) => String(v).replace(/[^\d]/g, '');

export default function CreditsSettings() {
  const [s, setS] = useState(null);
  const [chans, setChans] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [extra, setExtra] = useState('');
  useEffect(() => { api.get('/outreach/credits/settings').then((r) => { setS(r.data.settings); setChans(r.data.channels); setExtra((r.data.settings.exemptUserIds || []).join(', ')); }).catch((e) => setErr(errOf(e, 'The credit rules could not be loaded.'))); }, []);
  if (err && !s) return <div className="bc-err" role="alert">{err}</div>;
  if (!s) return <div className="oc-note">Loading…</div>;
  const toggleRole = (r) => setS({ ...s, exemptRoles: s.exemptRoles.includes(r) ? s.exemptRoles.filter((x) => x !== r) : [...s.exemptRoles, r] });
  const save = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api.put('/outreach/credits/settings', { ...s, exemptUserIds: extra.split(/[,\s]+/).filter(Boolean) });
      setS(r.data.settings); setMsg('Saved. The new rules work from the next message.');
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); }
  };
  return (
    <div>
      <div className="oc-note">Credits keep the number of messages each person can send in a month under control. You can change every rule below.</div>
      <div className="oc2-rule" style={{ marginTop: 10 }}>
        <label className="field"><span>Credits for each person every month</span><input inputMode="numeric" value={s.allowance} onChange={(e) => setS({ ...s, allowance: Number(num(e.target.value)) })} /></label>
        {chans.map((c) => (
          <label className="field" key={c.id}><span>Credits for one {c.word} {c.id === 'call' ? 'logged' : 'message'}</span><input inputMode="numeric" value={s.cost[c.id]} onChange={(e) => setS({ ...s, cost: { ...s.cost, [c.id]: Number(num(e.target.value)) } })} /></label>
        ))}
      </div>
      <div className="field"><span>Who has no limit</span>
        <div className="oc-choice">{ROLES.map(([id, label]) => <label key={id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={s.exemptRoles.includes(id)} onChange={() => toggleRole(id)} /> {label}</label>)}</div>
      </div>
      <label className="field"><span>Also no limit for these people (their login ids, separated by commas; leave empty for nobody)</span><input value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}><input type="checkbox" checked={s.enforce} onChange={(e) => setS({ ...s, enforce: e.target.checked })} /> Stop a real message when the person has used all their credits (if off, credits are only counted)</label>
      <div className="oc-note">Test-mode messages (rehearsals) never use credits. To give one person a different number, open Activity > Team activity and press "Set credits" on their row.</div>
      <div className="oc-row2"><button type="button" className="btn btn-primary" onClick={save}>Save</button></div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </div>
  );
}

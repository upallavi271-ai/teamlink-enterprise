import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import MultiPick from '../MultiPick.jsx';
import './campaigns.css';

const CH = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
// "1,240 people. 1,198 can get Email" in plain words (a group with no rule matches nobody, and says so)
function CountLine({ counts }) {
  if (!counts) return <div className="oc-note">Counting…</div>;
  if (counts.emptyRule) return <div className="bc-warn" role="status">This group has no rule, so it matches nobody. Pick an industry or kind, a city, a file or a way to reach people.</div>;
  return (
    <div className="oq-counts" aria-label="Live count">
      <span className="n">{counts.total} {counts.total === 1 ? 'person' : 'people'}</span>
      {Object.keys(CH).map((c) => <span key={c}>{counts.reachable[c]} can get {CH[c]}</span>)}
    </div>
  );
}
// ten people of the group, always with phone and email hidden
function People({ people }) {
  if (!people) return null;
  if (!people.length) return <div className="oc-note">No people to show here yet.</div>;
  return <div className="oq-people" aria-label="Ten people of this group">{people.map((p) => <div key={p.id}><b>{p.name || '(no name)'}</b> · {[p.phone, p.email, p.city].filter(Boolean).join(' · ')}</div>)}</div>;
}

function GroupEditor({ acc, type, word = 'Group', onClose, onSaved }) {
  const promo = type !== 'internal';
  const w1 = word.toLowerCase().replace(/s$/, '');
  const [name, setName] = useState('');
  const [rules, setRules] = useState({ industries: [], cities: [], reachable: [] });
  const [counts, setCounts] = useState(null);
  const [people, setPeople] = useState(null);
  const [tick, setTick] = useState(0);
  const [cities, setCities] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/outreach/contacts', { params: { type, pageSize: 5 } }).then((r) => setCities(r.data.facets.cities)).catch(() => {}); }, [type]);
  useEffect(() => {
    const t = setTimeout(() => { api.post('/outreach/segments/preview', { contactType: type, rules }).then((r) => { setCounts(r.data.counts); setPeople(r.data.people); }).catch(() => { setCounts(null); setPeople(null); }); }, 200);
    return () => clearTimeout(t);
  }, [rules, type, tick]);
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.post('/outreach/segments', { name, contactType: type, rules }); onSaved(); onClose(); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  };
  const toggleCh = (c) => setRules({ ...rules, reachable: rules.reachable.includes(c) ? rules.reachable.filter((x) => x !== c) : [...rules.reachable, c] });
  return (
    <Modal title={`New ${w1}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={save}>{busy ? 'Saving…' : `Save ${w1}`}</button></>}>
      <label className="field"><span>{`${word === 'Audiences' ? 'Audience' : 'Group'} name`}</span><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={promo ? 'Medical Hyderabad' : 'All staff in Hyderabad'} /></label>
      <div className="field"><span>{promo ? 'Industry' : 'Kind'}</span><MultiPick options={acc.industries.map((i) => ({ value: i.name, label: i.name }))} value={rules.industries} onChange={(v) => setRules({ ...rules, industries: v })} placeholder={promo ? 'Any industry' : 'Any kind'} /></div>
      <div className="field"><span>City</span><MultiPick options={cities.map((c) => ({ value: c.value, label: c.value, sub: `${c.count} people` }))} value={rules.cities} onChange={(v) => setRules({ ...rules, cities: v })} placeholder="Any city" emptyText="No cities yet." /></div>
      <div className="field"><span>Only people we can reach on</span>
        <div className="oc-choice">{Object.keys(CH).map((c) => <button type="button" key={c} className={rules.reachable.includes(c) ? 'on' : ''} onClick={() => toggleCh(c)}>{CH[c]}</button>)}</div>
      </div>
      <div className="oc-row2"><b>Who is in this group now</b><button type="button" className="btn btn-sm" onClick={() => { setCounts(null); setTick(tick + 1); }}>Count again</button></div>
      <CountLine counts={counts} />
      {counts && !counts.emptyRule && <div className="oc-note">A person "can get" a way only if they said yes to it, the address works, and they have not opted out.</div>}
      {counts && !counts.emptyRule && <div><div className="oc-note">Ten people from this group (phone and email hidden):</div><People people={people} /></div>}
      {type === 'internal' && <div className="oc-note">An internal group is for staff messages only. It can never be used for a job promotion.</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

export default function Groups({ acc, type, word = 'Groups' }) {
  const one = word === 'Audiences' ? 'audience' : 'group';
  const [list, setList] = useState(null);
  const [peek, setPeek] = useState({}); // groupId -> { counts, people } after "Count again"
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const canWrite = type === 'internal' ? acc.canImportInternal : acc.canImport;
  const load = useCallback(() => api.get('/outreach/segments', { params: { type } }).then((r) => setList(r.data.segments)).catch((e) => { setErr(e.response?.data?.error || `The ${word.toLowerCase()} could not be loaded.`); setList([]); }), [type]);
  useEffect(() => { load(); }, [load]);
  const recount = async (s) => {
    setBusyId(s.id); setErr('');
    try { const r = await api.get(`/outreach/segments/${s.id}/preview`); setPeek((p) => ({ ...p, [s.id]: r.data })); } catch (e) { setErr(e.response?.data?.error || 'The count could not be made.'); } finally { setBusyId(''); }
  };
  const del = async (s) => { if (!window.confirm(`Delete the ${one} "${s.name}"? The people stay in your contacts.`)) return; try { await api.delete(`/outreach/segments/${s.id}`); load(); } catch (e) { setErr(e.response?.data?.error || 'It could not be deleted.'); } };
  return (
    <div>
      <div className="oc-bar">{canWrite && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>{`New ${one}`}</button>}<span className="oc-note">{word === 'Audiences' ? 'An audience is a saved list of people, for example "Medical Hyderabad" or "BDE Freshers". Its count is always live.' : 'A group is a saved filter, for example "Medical, Hyderabad". Its count is always live.'}</span></div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!list && <div className="oc-note">Loading…</div>}
      {list && list.length === 0 && !err && <div className="oc-empty"><b>{`No ${word.toLowerCase()} yet.`}</b><div>{canWrite ? `Press "New ${one}" to make one.` : `${word} for you will show here.`}</div></div>}
      <div className="oc-cards">
        {(list || []).map((s) => (
          <div className="oc-card" key={s.id}>
            <h4>{s.name}</h4>
            <CountLine counts={peek[s.id] ? peek[s.id].counts : s.counts} />
            <div>{s.rules.industries.map((k) => <span key={k} className="oc-pill kind">{k}</span>)}{s.rules.cities.map((k) => <span key={k} className="oc-pill">{k}</span>)}</div>
            {peek[s.id] && <People people={peek[s.id].people} />}
            <div className="oc-row2">
              <button type="button" className="btn btn-sm" disabled={busyId === s.id} onClick={() => recount(s)}>{busyId === s.id ? 'Counting…' : (peek[s.id] ? 'Count again' : 'Count again and see 10 people')}</button>
              {canWrite && (acc.isAdmin || s.createdById) && <button type="button" className="btn btn-sm" onClick={() => del(s)}>{`Delete ${one}`}</button>}
            </div>
          </div>
        ))}
      </div>
      {adding && <GroupEditor acc={acc} type={type} word={word} onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}

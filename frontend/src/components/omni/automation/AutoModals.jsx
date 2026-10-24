import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Btn, GsModal, fmtDateTime } from '../ui.jsx';
import { OUTCOME_WORDS } from './workflow.js';

// "Add people" picker: names only (the server never sends a phone or an email here)
export function AddPeople({ seq, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setPeople([]); return; }
      omni.get('/gs/automation/people', { q }).then((r) => setPeople(r.people || [])).catch(() => setPeople([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const ids = Object.keys(chosen).filter((k) => chosen[k]);
  const add = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try { const r = await omni.post(`/gs/automation/${seq.id}/enrol`, { contactIds: ids }); setMsg(r.ok); setChosen({}); onDone(); } catch (e) { setErr(errOf(e, 'They could not be added.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title={`Add people to ${seq.name}`} sub="Type 2 letters of a name, city or skill. Only people you may see are listed." width={520} onClose={onClose}
      foot={<><Btn onClick={onClose}>Close</Btn><Btn primary disabled={!ids.length || busy} onClick={add}>{busy ? 'Adding…' : `Add ${ids.length || ''} ${ids.length === 1 ? 'person' : 'people'}`}</Btn></>}>
      <div className="field"><label>FIND PEOPLE</label><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, city or skill" /></div>
      {q.trim().length >= 2 && people.length === 0 && <div className="au-sub" style={{ marginTop: 10 }}>Nobody found.</div>}
      {people.length > 0 && (
        <div className="au-picklist">
          {people.map((p) => (
            <label key={p.id}><input type="checkbox" checked={!!chosen[p.id]} onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.checked })} />
              <span><b>{p.name}</b>{p.city ? `, ${p.city}` : ''}{p.company ? ` · ${p.company}` : ''}</span>
            </label>
          ))}
        </div>
      )}
      <div className="au-sub" style={{ marginTop: 10 }}>Adding people sends nothing by itself. Each step goes out later, and only to a person who agreed to that way. While Test mode is on it is only rehearsed.</div>
      {msg && <div className="au-ok" role="status">{msg}</div>}
      {err && <div className="au-err" role="alert">{err}</div>}
    </GsModal>
  );
}

// what happened (names only)
export function RunsModal({ seq, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { omni.get(`/gs/automation/${seq.id}/runs`).then(setD).catch(() => setD({ runs: [], log: [] })); }, [seq.id]);
  return (
    <GsModal title={`What happened: ${seq.name}`} sub="Names and steps only. No phone numbers or emails are shown here." width={760} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
      {!d && <div className="au-sub">Loading…</div>}
      {d && (
        <>
          <div className="panel-title" style={{ marginBottom: 8 }}>People in it</div>
          {d.runs.length === 0 ? <div className="au-sub">Nobody yet.</div> : (
            <div className="card table-card"><div className="table-scroll"><table className="table" style={{ minWidth: 0 }}><thead><tr><th>Name</th><th>Now at step</th><th>State</th><th>Next</th></tr></thead>
              <tbody>{d.runs.map((r) => <tr key={r.id}><td className="au-name">{r.name}</td><td>{r.step}</td><td>{r.status === 'running' ? 'Running' : (r.status === 'done' ? 'Finished' : `Stopped${r.stopReason ? ` (${r.stopReason})` : ''}`)}</td><td>{r.nextAt ? fmtDateTime(r.nextAt) : '—'}</td></tr>)}</tbody></table></div></div>
          )}
          <div className="panel-title" style={{ margin: '16px 0 8px' }}>Steps done</div>
          {d.log.length === 0 ? <div className="au-sub">Nothing yet.</div> : (
            <div className="card table-card"><div className="table-scroll"><table className="table" style={{ minWidth: 0 }}><thead><tr><th>When</th><th>Name</th><th>Step</th><th>Result</th></tr></thead>
              <tbody>{d.log.map((l, i) => <tr key={`${l.at}${i}`}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(l.at)}</td><td className="au-name">{l.name}</td><td>{l.step}</td><td className="au-wrap">{OUTCOME_WORDS[l.outcome] || l.outcome}{l.note ? `: ${l.note}` : ''}</td></tr>)}</tbody></table></div></div>
          )}
        </>
      )}
    </GsModal>
  );
}

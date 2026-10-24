import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { Chip, fmtDate } from './portalUi.jsx';
import { DropDialog, DecisionForm, dmy, when } from '../../components/joindrop/JdParts.jsx';
import ClientHistoryView from '../../components/joindrop/ClientHistoryView.jsx';
import '../../components/joindrop/joindrop.css';

// ---------------------------------------------------------------------------
// CLIENT PORTAL -> "Joinings and drops": who joined (day, place), and a prominent list of dropped candidates with the three big choices
//   We need a replacement / No replacement needed / We will decide later   (+ a comment and an expected date)
// After Save: "Your recruiter, BDE, team lead and HR have been told" with the time. The client may also press "Report a drop" for someone who
// joined. Plain words only: no TeamLink people's names, no pay, no phone or email. Server: routes/portal.js /client/join-drop.
// ---------------------------------------------------------------------------
export default function ClientJoinDrop({ onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [told, setTold] = useState({});
  const [busy, setBusy] = useState('');
  const [drop, setDrop] = useState(null);
  const [msg, setMsg] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(() => {
    api.get('/portal/client/join-drop').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(e.response?.data?.error || 'Could not load this page.'));
  }, []);
  useEffect(load, [load]);
  if (err && !d) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading…</div>;

  async function save(rec, body) {
    setBusy(rec.id);
    try {
      const r = await api.post(`/portal/client/join-drop/${rec.id}/decision`, body);
      setTold((t) => ({ ...t, [rec.id]: { message: r.data.message, at: r.data.toldAt } }));
      load(); if (onChanged) onChanged();
    } finally { setBusy(''); }
  }

  return (
    <div>
      {msg && <div className="jd-banner green" role="status">{msg}</div>}
      <div className="jd-card">
        <h4>Dropped candidates{d.counts.waiting > 0 ? ` (${d.counts.waiting} waiting for your answer)` : ''}</h4>
        {d.dropped.length === 0 && <EmptyState compact icon="👍" title="No candidate has dropped" hint="If someone who joined leaves, it shows here. You can tell us what you want us to do." />}
        {d.dropped.map((r) => (
          <div key={r.id} className="jd-card" style={{ borderColor: r.replacementDecision ? '#e2e8f0' : '#fca5a5' }}>
            <div className="jd-head">
              <div><b style={{ fontSize: 15 }}>{r.candidateName}</b><div className="small-muted">{r.jobTitle}{r.designation && r.designation !== r.jobTitle ? ` · ${r.designation}` : ''}</div></div>
              <Chip label={r.replacementDecision ? r.replacementDecisionWords : 'Waiting for your answer'} tone={r.replacementDecision ? (r.replacementDecision === 'NEEDED' ? 'green' : 'grey') : 'yellow'} />
            </div>
            <div className="jd-grid">
              <div className="jd-kv"><div className="k">Dropped on</div><div className="v">{dmy(r.droppedOn)}</div></div>
              <div className="jd-kv"><div className="k">Last working day</div><div className="v">{r.lastWorkingDay ? dmy(r.lastWorkingDay) : 'Not recorded'}</div></div>
              <div className="jd-kv"><div className="k">Reason</div><div className="v">{r.dropReason || 'Not recorded'}{r.dropReasonDetail ? ` · ${r.dropReasonDetail}` : ''}</div></div>
              <div className="jd-kv"><div className="k">Joined on</div><div className="v">{r.joinedOn ? dmy(r.joinedOn) : 'Not recorded'} · {r.location || 'place not recorded'}</div></div>
              <div className="jd-kv"><div className="k">Replacement period</div><div className="v">{r.guaranteeLine}</div></div>
              <div className="jd-kv"><div className="k">Dropped inside the period?</div><div className="v">{r.dropWithinGuarantee === 1 ? 'Yes, inside the period' : (r.dropWithinGuarantee === 0 ? 'No, after the period' : 'Not known')}</div></div>
            </div>
            {r.replacementDecision && (
              <div className="jd-banner blue">
                <b>Your answer: {r.replacementDecisionWords}.</b>{r.replacementComment ? ` “${r.replacementComment}”` : ''}{r.replacementExpectedOn ? ` Expected by ${dmy(r.replacementExpectedOn)}.` : ''}
                <div className="small-muted">{`Saved ${when(r.replacementDecidedAt)}${r.replacementOnBehalf ? ', entered by TeamLink on your behalf' : ''}. Your recruiter, BDE, team lead and HR have been told.`}{r.replacementStatus ? ` Status: ${r.replacementStatus}.` : ''}</div>
              </div>
            )}
            {told[r.id] && <div className="jd-banner green" role="status">{told[r.id].message} <span className="small-muted">{when(told[r.id].at)}</span></div>}
            {d.canEnter ? (
              <div>
                <b>{r.replacementDecision ? 'Change your answer' : 'What would you like us to do?'}</b>
                <DecisionForm key={`${r.id}-${r.replacementDecision}-${r.replacementComment}`} rec={r} big busy={busy === r.id} buttonText="Save my answer" onSave={(body) => save(r, body)} />
              </div>
            ) : <div className="small-muted">Your login can see this but cannot answer. Please ask your TeamLink contact to switch it on, or tell them your answer.</div>}
          </div>
        ))}
      </div>

      <div className="jd-card">
        <h4>Joined</h4>
        {d.joined.length === 0 ? <EmptyState compact icon="🤝" title="Nobody has joined yet" hint="Candidates who join your company are listed here with the day and the place." /> : (
          <div className="tbl-wrap">
            <table className="jd-table">
              <thead><tr><th>Candidate</th><th>Requirement</th><th>Joined on</th><th>Place</th><th>Replacement period</th><th /></tr></thead>
              <tbody>
                {d.joined.map((r) => (
                  <tr key={r.id}>
                    <td className="jd-cell-wrap"><b>{r.candidateName}</b></td>
                    <td className="jd-cell-wrap">{r.jobTitle}</td>
                    <td className="jd-cell-wrap">{r.joinedOn ? fmtDate(r.joinedOn) : 'Not recorded'}</td>
                    <td className="jd-cell-wrap">{r.location || 'Not recorded'}</td>
                    <td className="jd-cell-wrap">{r.guaranteeLine}{r.inGuarantee != null && <div className="small-muted">{r.inGuarantee ? 'Running now' : 'Over'}</div>}</td>
                    <td>{d.canEnter && <button type="button" className="btn btn-sm" onClick={() => setDrop(r)}>Report a drop</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="jd-card">
        <div className="jd-head"><h4>Our history with TeamLink</h4><button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide' : 'Show'}</button></div>
        {showHistory ? <ClientHistoryView endpoint="/portal/client/history" portal /> : <div className="small-muted">The requirements you gave us, the candidates we sent, who joined and who dropped, date by date.</div>}
      </div>

      {drop && (
        <DropDialog
          rec={drop}
          meta={{ reasons: d.reasons, otherReason: d.otherReason }}
          audience="client"
          endpoint={`/portal/client/join-drop/${drop.id}/drop`}
          onClose={() => setDrop(null)}
          onDone={(r) => { setDrop(null); setMsg(`${r.message} ${when(r.toldAt)}`); load(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}

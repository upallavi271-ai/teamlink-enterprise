import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// RECRUITER HANDOVER (founder 2026-11-10): Reports & Team -> Handover. A recruiter leaves or moves: pick them, tick their candidates,
// pick who takes over, say why, hand over. Steps, interviews, notes and history stay as they are; the old recruiter's name stays on
// their work and their joinings (utils/handover.js); a Joined candidate is never handed over. Below: every handover so far.
// Server: routes/handover.js (Team Lead, Manager, Admin - each over the candidates they may see).
// ---------------------------------------------------------------------------
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const HOW_TONE = { 'By hand': 'blue', 'Recruiter left': 'amber', 'Taken off the requirement': 'grey', 'Assigned on a candidate': 'grey' };

export default function RecruiterHandover() {
  const [recs, setRecs] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [hist, setHist] = useState(null);

  const loadRecs = () => api.get('/ats/handover/recruiters').then((r) => setRecs(r.data.rows)).catch((e) => { setErr(e.response?.data?.error || 'The recruiters could not be read.'); setRecs([]); });
  const loadHist = () => api.get('/ats/handover/history').then((r) => setHist(r.data.rows)).catch(() => setHist([]));
  useEffect(() => { loadRecs(); loadHist(); }, []);
  useEffect(() => {
    setList(null); setPicked(new Set()); setMsg('');
    if (!from) return;
    api.get('/ats/handover/candidates', { params: { from } }).then((r) => {
      setList(r.data);
      setPicked(new Set(r.data.rows.map((x) => x.id)));
    }).catch((e) => setErr(e.response?.data?.error || 'Their candidates could not be read.'));
  }, [from]);

  const fromRec = (recs || []).find((r) => r.id === from);
  const toRec = (recs || []).find((r) => r.id === to);
  const shown = useMemo(() => {
    const rows = (list && list.rows) || [];
    const n = q.trim().toLowerCase();
    return n ? rows.filter((r) => [r.candidate, r.reqCode, r.requirement, r.client, r.step].some((v) => String(v || '').toLowerCase().includes(n))) : rows;
  }, [list, q]);
  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const toggleAll = () => setPicked((cur) => { const next = new Set(cur); shown.forEach((r) => (allShownPicked ? next.delete(r.id) : next.add(r.id))); return next; });
  const toggle = (id) => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function handOver() {
    if (!window.confirm(`Hand over ${picked.size} candidate${picked.size === 1 ? '' : 's'} from ${fromRec.name} to ${toRec.name}? ${fromRec.name}'s earlier work and joinings keep their name.`)) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post('/ats/handover', { from, to, applicationIds: [...picked], reason });
      setMsg(r.data.message || 'Handed over.');
      setReason(''); setTo('');
      await Promise.all([loadRecs(), loadHist()]);
      const again = await api.get('/ats/handover/candidates', { params: { from } });
      setList(again.data); setPicked(new Set(again.data.rows.map((x) => x.id)));
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not go through. Please try again.');
    } finally { setBusy(false); }
  }

  const givers = (recs || []).filter((r) => r.candidates > 0);
  const takers = (recs || []).filter((r) => r.canReceive && r.id !== from);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Recruiter handover</h1>
          <div className="small-muted">When a recruiter leaves or moves, hand their candidates to another recruiter. Steps, interviews, notes and history stay as they are. Their earlier work and their joinings keep their name.</div>
        </div>
      </div>
      {err && <div className="notice red">{err}</div>}
      {msg && <div className="notice green">{msg}</div>}

      <section className="panel panel-pad">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, alignItems: 'end' }}>
          <label className="field" style={{ margin: 0 }}>
            <span>1. Who hands over</span>
            <Combo value={from} onChange={(e) => { setFrom(e.target.value); setTo(''); }} aria-label="Who hands over">
              <option value="">Pick the recruiter…</option>
              {givers.map((r) => <option key={r.id} value={r.id}>{`${r.name}${r.left ? ' (left)' : ''} — ${r.candidates} candidate${r.candidates === 1 ? '' : 's'}`}</option>)}
            </Combo>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>2. Who takes over</span>
            <Combo value={to} onChange={(e) => setTo(e.target.value)} disabled={!from} aria-label="Who takes over">
              <option value="">Pick the recruiter…</option>
              {takers.map((r) => <option key={r.id} value={r.id}>{`${r.name}${r.department ? ` · ${r.department}` : ''}`}</option>)}
            </Combo>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>3. Why</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. resigned, moved to another team" maxLength={300} />
          </label>
          <div>
            <button type="button" className="btn btn-primary" disabled={busy || !from || !to || !picked.size || !reason.trim()} onClick={handOver}>
              {busy ? 'Handing over…' : `Hand over ${picked.size || ''} candidate${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
        {recs && !givers.length && <div className="small-muted" style={{ marginTop: 10 }}>No recruiter in your team has candidates to hand over.</div>}
      </section>

      {from && (
        <section className="panel">
          <div className="panel-head">
            <h3>{fromRec ? `${fromRec.name}'s candidates` : 'Candidates'}{list ? ` (${list.rows.length})` : ''}</h3>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, requirement, client" style={{ maxWidth: 260 }} aria-label="Search the candidates" />
          </div>
          {list && list.joinedStay > 0 && <div className="small-muted" style={{ padding: '8px 18px 0' }}>{`${list.joinedStay} Joined candidate${list.joinedStay === 1 ? '' : 's'} stay with ${fromRec ? fromRec.name : 'them'}: those placements are their work.`}</div>}
          {!list ? <div className="empty-mini">Loading…</div> : !list.rows.length ? <div className="empty-mini">Nothing to hand over.</div> : (
            <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table>
                <thead><tr>
                  <th style={{ width: 34 }}><input type="checkbox" checked={allShownPicked} onChange={toggleAll} aria-label="Tick all shown" /></th>
                  <th>Candidate</th><th>Requirement</th><th>Client</th><th>Step</th><th>Last change</th>
                </tr></thead>
                <tbody>{shown.map((r) => (
                  <tr key={r.id}>
                    <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Tick ${r.candidate}`} /></td>
                    <td><Link to={`/candidates/${r.candidateId}`}>{r.candidate}</Link></td>
                    <td>{r.requirement}{r.reqCode && <div className="small-muted">{r.reqCode}</div>}</td>
                    <td className="cell-muted">{r.client}</td>
                    <td><StatusChip status={r.step} /></td>
                    <td className="cell-muted">{day(r.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h3>Handover history</h3></div>
        {!hist ? <div className="empty-mini">Loading…</div> : !hist.length ? <div className="empty-mini">No handovers yet.</div> : (
          <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table>
              <thead><tr><th>Date</th><th>From</th><th>To</th><th>Candidates</th><th>How</th><th>Done by</th><th>Why</th></tr></thead>
              <tbody>{hist.map((h) => (
                <tr key={`${h.day}|${h.from}|${h.to}|${h.how}|${h.by}`}>
                  <td>{day(h.at)}</td><td>{h.from || '—'}</td><td>{h.to}</td><td>{h.count}</td>
                  <td><StatusChip tone={HOW_TONE[h.how] || 'grey'}>{h.how}</StatusChip></td>
                  <td className="cell-muted">{h.by}</td><td className="cell-muted">{h.reason || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

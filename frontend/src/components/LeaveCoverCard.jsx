import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// LEAVE COVER (ATS audit 2026-11-17), on the Follow-ups page. When someone is on approved leave, their due follow-ups and tasks go
// to the backup their TL picked here (else the TL / reporting manager) and come back when the leave ends (utils/leaveCover.js,
// hourly). This card shows what you cover now, what of yours is with someone else, and - for a lead - each person's backup.
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

export default function LeaveCoverCard() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [openTeam, setOpenTeam] = useState(false);
  const load = () => api.get('/ats/team-tools/leave-cover').then((r) => setData(r.data)).catch(() => setData(null));
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const { covering, coveredForMe, team } = data;
  if (!covering.length && !coveredForMe.length && !team.length) return null;

  async function setBackup(userId, backupUserId) {
    setMsg('');
    try {
      await api.put('/ats/team-tools/leave-cover/backup', { userId, backupUserId: backupUserId || null });
      setMsg('Backup saved.');
      load();
    } catch (e) { setMsg(e?.response?.data?.error || 'Could not save the backup.'); }
  }
  const awayNow = team.filter((m) => m.onLeave);

  return (
    <div className="card section" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Leave cover</h3>
        {team.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setOpenTeam((o) => !o)}>{openTeam ? 'Hide backups' : `Backups for my team (${team.length})`}</button>}
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        When someone is on approved leave, their due follow-ups and tasks go to their backup (or their TL) and come back after the leave.
        {awayNow.length > 0 && ` On leave today: ${awayNow.map((m) => `${m.name} (till ${dmy(m.onLeave.to)})`).join(', ')}.`}
      </div>
      {covering.length > 0 && (
        <>
          <b style={{ fontSize: 13 }}>{`You are covering ${covering.length}`}</b>
          <div className="tbl-wrap" style={{ marginTop: 4 }}>
            <table>
              <thead><tr><th>For</th><th>What</th><th>Due</th><th>Back on</th></tr></thead>
              <tbody>
                {covering.map((i) => (
                  <tr key={i.id}>
                    <td>{i.from.name}</td>
                    <td>{i.candidateId ? <Link to={`/candidates/${i.candidateId}`}>{i.what}</Link> : i.what}{i.entity === 'Task' ? <span className="small-muted"> · task</span> : null}{i.done ? <span className="small-muted"> · done</span> : null}</td>
                    <td className="cell-muted">{dmy(i.due) || '—'}</td>
                    <td className="cell-muted">{i.leaveTo ? `after ${dmy(i.leaveTo)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {coveredForMe.length > 0 && (
        <div className="small-muted" style={{ marginTop: 8 }}>
          {`${coveredForMe.length} of your follow-ups / tasks are with ${[...new Set(coveredForMe.map((i) => i.to.name))].join(', ')} while you are on leave. They come back to you when it ends.`}
        </div>
      )}
      {openTeam && team.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>Person</th><th>Leave</th><th>Backup while on leave</th></tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}<span className="small-muted">{m.role ? ` · ${m.role}` : ''}</span></td>
                  <td className="cell-muted">{m.onLeave ? `${dmy(m.onLeave.from)} to ${dmy(m.onLeave.to)}` : '—'}</td>
                  <td>
                    <select value={m.backup ? m.backup.id : ''} onChange={(e) => setBackup(m.id, e.target.value)} aria-label={`Backup for ${m.name}`}>
                      <option value="">The TL (default)</option>
                      {m.backup && !team.some((x) => x.id === m.backup.id) && <option value={m.backup.id}>{m.backup.name}</option>}
                      {team.filter((x) => x.id !== m.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {msg && <div className="small-muted" role="status" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

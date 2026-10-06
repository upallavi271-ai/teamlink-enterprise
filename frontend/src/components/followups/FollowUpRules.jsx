import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './followups.css';

// ---------------------------------------------------------------------------
// WHEN IS A FOLLOW-UP DUE, PER STEP — the editable settings table (spec C1
// "Rules — USER DECIDES"; orchestrator decision: suggested defaults marked
// "suggested — confirm", nothing escalated until the user confirms).
//
// GET/PUT /api/followups/rules (backend utils/followupVisibility.js). Until
// confirmed, nothing reads these rules. After confirming they only set the
// Due today / Not followed up badges where a follow-up names no date of its
// own — they never escalate or notify. Super Admin / Admin may edit.
// ---------------------------------------------------------------------------

const MODE_SHORT = {
  after_contact: 'days after the last contact',
  before_interview: 'days before the interview',
  before_joining: 'days before the joining date',
  none: 'No follow-up in this step',
};

export default function FollowUpRules() {
  const [table, setTable] = useState(null);
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get('/followups/rules')
    .then((r) => { setTable(r.data); setEdit({}); })
    .catch((e) => setErr(e.response?.data?.error || 'Could not load the follow-up rules.'));
  useEffect(() => { load(); }, []);

  if (err && !table) return <div className="fux-err">{err}</div>;
  if (!table) return <div className="small-muted">Loading the rules…</div>;
  const canEdit = !!table.canEdit;
  const valueOf = (row) => edit[row.stage] || { mode: row.mode, days: row.days };
  const dirty = Object.keys(edit).length > 0;

  function change(row, patch) {
    const cur = valueOf(row);
    setEdit((e) => ({ ...e, [row.stage]: { ...cur, ...patch } }));
    setMsg('');
  }

  async function save(confirm) {
    setBusy(true);
    setErr('');
    try {
      const r = await api.put('/followups/rules', { rules: edit, ...(confirm === undefined ? {} : { confirm }) });
      setTable(r.data);
      setEdit({});
      setMsg(confirm === true ? 'Saved — the rules are confirmed and now set the Due today / Not followed up badges.'
        : confirm === false ? 'Saved — the rules are back to "suggested" and not in use.'
          : 'Saved.');
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not save the rules. Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <div className="fux-rules">
      <div className={`fux-banner ${table.confirmed ? 'is-green' : 'is-orange'}`}>
        <b>{table.confirmed ? 'Confirmed — in use.' : 'Suggested — confirm.'}</b>{' '}
        {table.note}
        {table.confirmed && table.confirmedBy && <> Confirmed by {table.confirmedBy}.</>}
      </div>
      <div className="fux-table-wrap">
        <table className="fux-table">
          <thead>
            <tr><th>Step</th><th>Whose job</th><th>Follow-up is due…</th><th>Suggested</th></tr>
          </thead>
          <tbody>
            {table.rows.map((row) => {
              const v = valueOf(row);
              return (
                <tr key={row.stage}>
                  <td><b>{row.word || row.label}</b>{row.word && row.word !== row.label && <div className="fux-note" style={{ marginTop: 0 }}>{row.label}</div>}</td>
                  <td className="cell-muted">{row.owner}</td>
                  <td>
                    {canEdit ? (
                      <span className="fux-inline">
                        {v.mode !== 'none' && (
                          <input
                            type="number"
                            min="0"
                            max="60"
                            style={{ width: 64 }}
                            aria-label={`Days for ${row.label}`}
                            value={v.days}
                            onChange={(e) => change(row, { days: e.target.value === '' ? '' : Number(e.target.value) })}
                          />
                        )}
                        <select aria-label={`Rule for ${row.label}`} value={v.mode} onChange={(e) => change(row, { mode: e.target.value })}>
                          {(table.modes || []).map((m) => <option key={m.id} value={m.id}>{MODE_SHORT[m.id] || m.label}</option>)}
                        </select>
                      </span>
                    ) : (
                      <span>{v.mode === 'none' ? MODE_SHORT.none : `${v.days} ${MODE_SHORT[v.mode]}`}</span>
                    )}
                  </td>
                  <td>
                    {row.changed ? <StatusChip tone="blue">Changed</StatusChip> : <span className="cell-muted">{row.suggested.text}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="fux-actions" style={{ marginTop: 12 }}>
          {!table.confirmed && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
              {dirty ? 'Save and confirm these rules' : 'Confirm these rules'}
            </button>
          )}
          {table.confirmed && dirty && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save()}>Save changes</button>}
          {!table.confirmed && dirty && <button type="button" className="btn" disabled={busy} onClick={() => save()}>Save, keep as suggested</button>}
          {dirty && <button type="button" className="btn" disabled={busy} onClick={() => { setEdit({}); setMsg(''); }}>Undo changes</button>}
          {table.confirmed && <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>Stop using the rules</button>}
        </div>
      )}
      {!canEdit && <div className="fux-note">Only a Super Admin or Admin can change these.</div>}
      {msg && <div className="fux-saved">{msg}</div>}
      {err && <div className="fux-err">{err}</div>}
    </div>
  );
}

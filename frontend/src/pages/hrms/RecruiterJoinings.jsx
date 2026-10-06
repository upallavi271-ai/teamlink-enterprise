// ---------------------------------------------------------------------------
// HRMS → Performance & Development → Recruiter joinings (user, 2026-10-05).
// Every recruiter's joinings for a month against their target (4 a month
// unless Super Admin set another), with the joining list per person, the
// month-by-month history, Super Admin's decision (incentive / raise / no
// action) and an Excel export. What each login sees is decided by the server
// (routes/recruiterJoinings.js): Super Admin everything incl. money; Admin /
// HR the list + which decision; a TL their team; a recruiter their own row.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Modal } from '../../components/proto.jsx';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import {
  JoiningsTable, RuleBox, SummaryCards, errText, nowMonth, addMonths,
} from '../../components/recruiterJoinings/RjParts.jsx';
import '../../components/recruiterJoinings/rj.css';

const FIELDS = [
  { key: 'department', get: (r) => r.department || '' },
  { key: 'tl', get: (r) => r.tlName || '' },
  { key: 'recruiter', get: (r) => r.key, label: (v, r) => `${r.name}${r.seat ? ` · ${r.seat}` : ''}` },
];
const EMPTY = { department: '', tl: '', recruiter: '' };

// Super Admin: the joinings target for everyone / a department / one person.
function TargetDialog({ board, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ scope: 'ALL', scopeKey: '', target: String(board.defaultTarget || 4), fromMonth: addMonths(nowMonth(), 0), note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.get('/recruiter-joinings/targets').then((r) => setData(r.data)).catch((e) => setError(errText(e, 'Could not load the targets.')));
  useEffect(() => { load(); }, []);
  const depts = [...new Set(board.rows.map((r) => r.department).filter(Boolean))].sort();
  const people = board.rows.filter((r) => r.employeeId).sort((a, b) => a.name.localeCompare(b.name));
  async function save() {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.post('/recruiter-joinings/targets', { ...form, target: Number(form.target) });
      setMsg(r.data.message); load(); onSaved();
    } catch (e) { setError(errText(e, 'Could not save the target.')); } finally { setBusy(false); }
  }
  async function remove(rule) {
    if (!window.confirm(`Remove "${rule.who} · ${rule.target} a month from ${rule.fromLabel}"?`)) return;
    try { await api.delete(`/recruiter-joinings/targets/${rule.id}`); setMsg('Removed.'); load(); onSaved(); } catch (e) { setError(errText(e, 'Could not remove it.')); }
  }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      title="Joinings target"
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save target'}</button>
        </>
      )}
    >
      <div className="rj rj-form">
        <p className="rj-hint">Normally every recruiter has a target of <b>{board.defaultTarget} joinings a month</b>. Change it for everyone, one department or one person, from a month onward. The most specific one wins (person, then department, then everyone).</p>
        {msg && <div className="rj-saved">{msg}</div>}
        {error && <div className="rj-error">{error}</div>}
        <div className="rj-tabs">
          {[['ALL', 'Everyone'], ['DEPARTMENT', 'A department'], ['EMPLOYEE', 'One person']].map(([k, l]) => (
            <button key={k} type="button" className={form.scope === k ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, scope: k, scopeKey: '' }))}>{l}</button>
          ))}
        </div>
        {form.scope === 'DEPARTMENT' && (
          <div className="field"><label>Department</label>
            <select value={form.scopeKey} onChange={(e) => set('scopeKey', e.target.value)}>
              <option value="">Pick a department</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
        {form.scope === 'EMPLOYEE' && (
          <div className="field"><label>Person</label>
            <select value={form.scopeKey} onChange={(e) => set('scopeKey', e.target.value)}>
              <option value="">Pick a person</option>
              {people.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}{p.seat ? ` · ${p.seat}` : ''}</option>)}
            </select>
          </div>
        )}
        <div className="rj-row2">
          <div className="field"><label>Joinings a month</label><input type="number" min="0" max="100" value={form.target} onChange={(e) => set('target', e.target.value)} /></div>
          <div className="field"><label>From month</label><input type="month" value={form.fromMonth} onChange={(e) => set('fromMonth', e.target.value)} /></div>
        </div>
        <div className="field"><label>Note (optional)</label><input value={form.note} onChange={(e) => set('note', e.target.value)} /></div>
        {data && data.rules.length > 0 && (
          <>
            <h4 style={{ fontSize: 12.5, margin: '10px 0 6px' }}>Targets set so far</h4>
            <table className="rj-mini">
              <thead><tr><th>For</th><th>From</th><th>Target</th><th>Set by</th><th /></tr></thead>
              <tbody>
                {data.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.who}</td><td>{r.fromLabel}</td><td>{r.target} a month</td><td className="rj-sub">{r.setByName || '—'}</td>
                    <td>{data.canEdit && <button className="btn btn-sm" onClick={() => remove(r)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Modal>
  );
}

function SkippedList({ month }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/recruiter-joinings/skipped', { params: { month } }).then((r) => setData(r.data)).catch((e) => setError(errText(e, 'Could not load the list.')));
  }, [month]);
  const rows = useMemo(() => (data ? [
    ...data.noRecruiter.map((a) => ({ id: a.id, candidate: a.candidate, client: a.client, job: a.job, date: a.joiningDate, reason: a.reason })),
    ...data.undated.map((a) => ({ id: a.id, candidate: a.candidate, client: a.client, job: a.job, date: a.joiningDate || '—', reason: a.reason })),
  ] : []), [data]);
  const page = usePaged(rows);
  if (error) return <div className="rj-error">{error}</div>;
  if (!data) return <div className="rj-empty">Loading…</div>;
  return (
    <div>
      <p className="rj-hint">These people have the step Joined, but cannot be counted for any recruiter or month. Fix the joining date or the recruiter on the candidate in ATS and they will be counted automatically.</p>
      <div className="tbl-wrap">
        <table className="rj-mini">
          <thead><tr><th>Candidate</th><th>Client</th><th>Job</th><th>Joining date</th><th>Why skipped</th></tr></thead>
          <tbody>{page.slice.map((a) => <tr key={a.id}><td>{a.candidate}</td><td>{a.client}</td><td>{a.job}</td><td>{a.date || '—'}</td><td><span className="rj-tag orange">{a.reason}</span></td></tr>)}</tbody>
        </table>
      </div>
      {page.total > 0 && <Pager page={page} noun="people" />}
    </div>
  );
}

export default function RecruiterJoinings() {
  const [month, setMonth] = useState(nowMonth());
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState(EMPTY);
  const [q, setQ] = useState('');
  const [targets, setTargets] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api.get('/recruiter-joinings/board', { params: { month } })
      .then((r) => setBoard(r.data))
      .catch((e) => setError(errText(e, 'Could not load recruiter joinings.')));
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const rows = board ? board.rows : [];
  const facets = useLocalFacets(rows, FIELDS, f);
  const shown = useMemo(() => rows.filter((r) => (!f.department || r.department === f.department)
    && (!f.tl || r.tlName === f.tl) && (!f.recruiter || r.key === f.recruiter)
    && (!q || `${r.name} ${r.seat || ''} ${r.employeeCode || ''}`.toLowerCase().includes(q.toLowerCase()))), [rows, f, q]);
  const page = usePaged(shown);
  const v = board?.viewer || {};

  async function exportXlsx() {
    setBusy(true);
    try {
      const res = await api.get('/recruiter-joinings/export', { params: { month, ...Object.fromEntries(Object.entries(f).filter(([, x]) => x)) }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `recruiter-joinings-${month}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setError(errText(e, 'Could not export.')); } finally { setBusy(false); }
  }
  const setFilter = (k, val) => setF((x) => ({ ...x, [k]: val }));

  return (
    <div className="rj">
      <p className="rj-lead">
        How many people each recruiter got <b>joined</b> in a month, against their target ({board?.defaultTarget || 4} a month unless changed).
        {v.decide ? ' After a month ends, decide per person: give an incentive, raise the salary, or no action.' : ''}
        {v.level === 'team' ? ' You see your team.' : ''}{v.level === 'self' ? ' You see your own joinings.' : ''}
      </p>
      <div className="rj-bar">
        <label className="lph-facet"><span className="lph-facet-lbl">Month</span>
          <input type="month" value={month} max={nowMonth()} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setF(EMPTY); } }} />
        </label>
        {v.level !== 'self' && (
          <>
            <FacetSelect label="Department" allLabel="All departments" value={f.department} options={facets.department} onChange={(x) => setFilter('department', x)} />
            <FacetSelect label="Team lead" allLabel="All team leads" value={f.tl} options={facets.tl} onChange={(x) => setFilter('tl', x)} />
            <FacetSelect label="Recruiter" allLabel="All recruiters" value={f.recruiter} options={facets.recruiter} onChange={(x) => setFilter('recruiter', x)} />
            <label className="lph-facet"><span className="lph-facet-lbl">Search</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or seat" /></label>
          </>
        )}
        <span className="rj-grow" />
        {v.setTarget && <button className="btn btn-sm" onClick={() => setTargets(true)}>Change target</button>}
        <button className="btn btn-sm" disabled={busy || !board} onClick={exportXlsx}>{busy ? 'Exporting…' : 'Export Excel'}</button>
      </div>
      {error && <div className="rj-error">{error}</div>}
      {!board ? <div className="rj-empty">Loading…</div> : (
        <>
          <SummaryCards s={board.summary} decisions={v.decisions && board.ended} />
          <RuleBox rule={board.rule} />
          {board.current && <p className="rj-hint">{board.label} is still going — these are the joinings so far. Decisions open after the month ends.</p>}
          <JoiningsTable board={board} rows={page.slice} onChanged={load} />
          {page.total > 0 && <Pager page={page} noun="recruiters" />}
          {(board.skipped.length > 0 || board.undatedCount > 0) && (
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-sm" onClick={() => setSkipped((x) => !x)}>
                {skipped ? 'Hide' : 'Show'} skipped joinings ({board.skipped.length + board.undatedCount})
              </button>
              <span className="rj-sub" style={{ marginLeft: 8 }}>Joined, but no joining date or no recruiter on record — not counted anywhere.</span>
              {skipped && <SkippedList month={month} />}
            </div>
          )}
        </>
      )}
      {targets && board && <TargetDialog board={board} onClose={() => setTargets(false)} onSaved={load} />}
    </div>
  );
}

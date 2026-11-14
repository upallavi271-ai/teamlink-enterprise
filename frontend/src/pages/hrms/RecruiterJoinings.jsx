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
import {
  JoiningsTable, RuleBox, DeptRules, SummaryCards, errText, nowMonth, addMonths,
} from '../../components/recruiterJoinings/RjParts.jsx';
import '../../components/recruiterJoinings/rj.css';
import Combo from '../../components/Combo.jsx';
import CategoryTargets from '../../components/recruiterJoinings/CategoryTargets.jsx';

const FIELDS = [
  { key: 'status', get: (r) => r.statusGroup || 'Active' },
  { key: 'department', get: (r) => r.department || '' },
  { key: 'tl', get: (r) => r.tlName || '' },
  { key: 'recruiter', get: (r) => r.key, label: (v, r) => `${r.name}${r.seat ? ` · ${r.seat}` : ''}` },
];
// ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the list opens with the people who are still here; Employee status shows the Exited / Relieved ones
// (their status is written under their name). The month's totals and the cards above always count everybody.
const EMPTY = { department: '', tl: '', recruiter: '', status: 'Active' };
const STATUS_ORDER = ['Active', 'Exited', 'Relieved'];
// DEPARTMENT BY DEPARTMENT (founder 2026-11-14): Medical (its own policy: targets by category), Education and Manufacturing (4 joinings a month each),
// BDE (4 a month each, where a joining is a new client whose agreement is signed). Any other department follows.
const DEPT_ORDER = ['Medical', 'Education', 'Manufacturing', 'BDE'];
const deptRank = (d) => { const i = DEPT_ORDER.findIndex((x) => x.toLowerCase() === String(d).toLowerCase()); return i < 0 ? 99 : i; };
const isBdeName = (d) => String(d).toLowerCase() === 'bde';
// What a department did this month: the people who are still here plus anyone who joined somebody, against their targets.
function deptFigures(rows, name) {
  const here = rows.filter((r) => r.department === name && ((r.statusGroup || 'Active') === 'Active' || r.joinings > 0));
  const joined = here.reduce((n, r) => n + r.joinings, 0);
  const target = here.reduce((n, r) => n + (r.target || 0), 0);
  const each = [...new Set(here.map((r) => r.target))];
  return { people: here.length, joined, target, each: each.length === 1 ? each[0] : null, pct: target > 0 ? Math.round((joined * 100) / target) : null };
}

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
            <Combo value={form.scopeKey} onChange={(e) => set('scopeKey', e.target.value)}>
              <option value="">Pick a department</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
          </div>
        )}
        {form.scope === 'EMPLOYEE' && (
          <div className="field"><label>Person</label>
            <Combo value={form.scopeKey} onChange={(e) => set('scopeKey', e.target.value)}>
              <option value="">Pick a person</option>
              {people.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}{p.seat ? ` · ${p.seat}` : ''}</option>)}
            </Combo>
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

// COUNTS ONLY: who these joinings are (candidate, client, job) is in ATS.
function SkippedList({ month }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/recruiter-joinings/skipped', { params: { month } }).then((r) => setData(r.data)).catch((e) => setError(errText(e, 'Could not load the numbers.')));
  }, [month]);
  if (error) return <div className="rj-error">{error}</div>;
  if (!data) return <div className="rj-empty">Loading…</div>;
  return (
    <div>
      <p className="rj-hint">
        <b>{data.noRecruiterCount}</b> joining(s) have no recruiter on record and <b>{data.undatedCount}</b> have no usable joining date, so they are counted for nobody.
        Open ATS (Candidates &amp; Pipeline) to fix the recruiter or the joining date; they are counted automatically afterwards.
      </p>
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
  const [rk, setRk] = useState(0); // bumps when the table reloads, so the category panel follows

  const load = useCallback(() => {
    setError('');
    setRk((n) => n + 1);
    api.get('/recruiter-joinings/board', { params: { month } })
      .then((r) => setBoard(r.data))
      .catch((e) => setError(errText(e, 'Could not load recruiter joinings.')));
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const rows = board ? board.rows : [];
  const facets = useLocalFacets(rows, FIELDS, f);
  const shown = useMemo(() => rows.filter((r) => (!f.department || r.department === f.department)
    && (!f.status || (r.statusGroup || 'Active') === f.status)
    && (!f.tl || r.tlName === f.tl) && (!f.recruiter || r.key === f.recruiter)
    && (!q || `${r.name} ${r.seat || ''} ${r.employeeCode || ''}`.toLowerCase().includes(q.toLowerCase()))), [rows, f, q]);
  // one section per department, in the order above; Medical is always there (when the month has Medical people) because its category panel is
  const sections = useMemo(() => {
    const by = new Map();
    shown.forEach((r) => { const d = r.department || 'No department'; if (!by.has(d)) by.set(d, []); by.get(d).push(r); });
    if ((!f.department || f.department === 'Medical') && rows.some((r) => r.department === 'Medical') && !by.has('Medical')) by.set('Medical', []);
    return [...by.entries()].sort(([a], [b]) => deptRank(a) - deptRank(b) || a.localeCompare(b)).map(([name, list]) => ({ name, list }));
  }, [shown, rows, f.department]);
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
        Department by department: how many people each recruiter got <b>joined</b> in a month, against their target ({board?.defaultTarget || 4} a month unless changed), how many candidates they <b>generated</b>, and how many <b>dropped</b>.
        Medical has its own targets by category; for a BDE a joining is a <b>new client whose agreement is signed</b>.
        {v.details ? ' Open a recruiter to see who joined, who dropped and the reason.' : ''}
        {v.decide ? ' After a month ends, decide per person: give an incentive, raise the salary, or no action.' : ''}
        {v.level === 'team' ? ' You see your team.' : ''}{v.level === 'self' ? ' You see your own joinings.' : ''}
      </p>
      <div className="rj-bar">
        <label className="lph-facet"><span className="lph-facet-lbl">Month</span>
          <input type="month" value={month} max={nowMonth()} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setF(EMPTY); } }} />
        </label>
        {v.level !== 'self' && (
          <>
            <FacetSelect label="Employee status" allLabel="All: Active, Exited and Relieved" value={f.status}
              options={[...facets.status].sort((a, b) => STATUS_ORDER.indexOf(a.value) - STATUS_ORDER.indexOf(b.value))} onChange={(x) => setFilter('status', x)} />
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
          <DeptRules rules={board.rules} example={board.example} />
          <RuleBox rule={board.rule} />
          {board.current && <p className="rj-hint">{board.label} is still going — these are the joinings so far. Decisions open after the month ends.</p>}
          {sections.map(({ name, list }) => {
            const g = deptFigures(rows, name);
            const bde = isBdeName(name);
            const med = name === 'Medical';
            return (
              <section key={name} className="rj-dept">
                <div className="rj-dept-head">
                  <h3>{name}</h3>
                  <span className="rj-dept-sum">
                    <b>{g.joined}</b> {bde ? 'client agreements signed' : 'joined'}
                    {!med && g.target > 0 ? <> of <b>{g.target}</b> target · <b>{g.pct}%</b></> : null}
                    {' · '}{g.people} {bde ? 'BDEs' : 'recruiters'}{!med && g.each ? ` · ${g.each} a month each` : ''}
                    {med ? ' · target by category below' : ''}
                  </span>
                </div>
                {bde && (
                  <p className="rj-hint">
                    A BDE&apos;s joining is a <b>new client</b>: when a client the BDE took signs the agreement, the client process is complete and that is one joining for that BDE
                    (counted on the day it is signed). Open a BDE to see which clients.
                    {board.bdeSkippedCount > 0 ? ` ${board.bdeSkippedCount} signed agreement(s) have an owner BDE who matches no employee, so they are counted for nobody.` : ''}
                  </p>
                )}
                {/* Category targets (Medical: six categories, 15 a month): the same joinings, sorted into categories (founder 2026-11-14) */}
                {med && <CategoryTargets month={month} department="Medical" filters={f} q={q} reloadKey={rk} onChanged={load} />}
                <JoiningsTable board={board} rows={list} onChanged={load} />
              </section>
            );
          })}
          {!sections.length && <div className="rj-empty">No recruiters to show for {board.label} with these filters.</div>}
          {f.status === 'Active' && rows.some((r) => (r.statusGroup || 'Active') !== 'Active') && (
            <p className="rj-hint">
              Showing the people who are still here. {rows.filter((r) => (r.statusGroup || 'Active') !== 'Active').length} exited or relieved recruiter(s) have a row for {board.label} too:
              choose <b>Employee status → All</b> (or Exited / Relieved) to see them. They are counted in the cards above.
            </p>
          )}
          {board.generatedElsewhere > 0 && (
            <p className="rj-hint">
              <b>{board.generatedElsewhere}</b> more candidate(s) were generated in {board.label} by people who are not on this list: a creator recorded only by a first name
              that matches no employee record, or no creator on record.
            </p>
          )}
          {((board.skippedCount || 0) + (board.undatedCount || 0) > 0) && (
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-sm" onClick={() => setSkipped((x) => !x)}>
                {skipped ? 'Hide' : 'Show'} joinings counted for nobody ({(board.skippedCount || 0) + (board.undatedCount || 0)})
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

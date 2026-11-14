// ---------------------------------------------------------------------------
// Category targets (founder 2026-11-14): a department's monthly joining target split by category - Medical: MD/MS Doctors (Full / Part Time),
// MD/MS Faculty (Full / Part Time), MBBS Doctors (Full Time), Staff Nurses = 15 a month - with how each one is closing, each recruiter's share
// and the incentive. The joinings are the ones Recruiter joinings counts (no second count); the server (routes/recruiterJoinings.js
// /category-board) says which category each belongs to. Rupee amounts reach Super Admin only.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import {
  inr, errText, monthLabel, DecisionLine, IncentiveDialog,
} from './RjParts.jsx';
import './rj.css';
import './rj-cat.css';

const toneOf = (n, t) => {
  if (!(t > 0)) return 'grey';
  if (n >= t) return 'green';
  if (t - n <= 1 || n >= t * 0.75) return 'orange';
  return 'red';
};
const pctWord = (p) => (p == null ? '—' : `${p}%`);

// Super Admin: the six targets and the rupees per joining, from a month.
function TargetsDialog({ dept, month, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState(dept.fromMonth || month);
  const [note, setNote] = useState('');
  const [faculty, setFaculty] = useState(false);
  const [fullCovers, setFullCovers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/recruiter-joinings/category-targets', { params: { department: dept.department } })
    .then((r) => { setData(r.data); setFaculty(!!(r.data.settings && r.data.settings.facultyImpliesMdMs)); setFullCovers(!(r.data.settings && r.data.settings.fullTimeCoversPartTime === false)); }).catch((e) => setError(errText(e, 'Could not load the targets.'))), [dept.department]);
  useEffect(() => { load(); }, [load]);
  // start from what is in force for the month on screen ...
  useEffect(() => {
    setRows(dept.categories.map((c) => ({
      category: c.key, label: c.short, note: c.note, target: c.target == null ? '' : String(c.target), incentive: c.incentive == null ? '' : String(c.incentive),
    })));
  }, [dept.department]); // eslint-disable-line react-hooks/exhaustive-deps
  // ... and when the month picked already has a saved set, show that set (so what was just saved stays on screen)
  useEffect(() => {
    if (!data) return;
    const h = data.history.find((x) => x.fromMonth === from);
    if (!h) return;
    setRows((rs) => rs.map((r) => {
      const it = h.items.find((i) => i.category === r.category);
      return it ? { ...r, target: String(it.target), incentive: it.incentive == null ? '' : String(it.incentive) } : r;
    }));
  }, [from, data]);
  const set = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const total = rows.reduce((n, r) => n + (Number(r.target) || 0), 0);
  async function save() {
    setBusy(true); setError(''); setMsg('');
    try {
      if (rows.some((r) => r.target === '' || !(Number(r.target) >= 0))) throw new Error('Give every category a target (0 or more).');
      const res = await api.post('/recruiter-joinings/category-targets', {
        department: dept.department, fromMonth: from, note, facultyImpliesMdMs: faculty, fullTimeCoversPartTime: fullCovers,
        items: rows.map((r) => ({ category: r.category, target: Number(r.target), incentive: r.incentive === '' ? null : Number(r.incentive) })),
      });
      setMsg(res.data.message); load(); onSaved();
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function remove(h) {
    if (!window.confirm(`Remove the targets that start from ${h.fromLabel}? The earlier targets will apply again.`)) return;
    try {
      const r = await api.delete('/recruiter-joinings/category-targets', { params: { department: dept.department, fromMonth: h.fromMonth } });
      setMsg(r.data.message); load(); onSaved();
    } catch (e) { setError(errText(e, 'Could not remove.')); }
  }
  return (
    <Modal
      title={`${dept.department} category targets`}
      onClose={onClose}
      wide
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save targets'}</button>
        </>
      )}
    >
      <div className="rj rj-form">
        <p className="rj-hint">
          The team&apos;s joinings wanted each month, by category, and the rupees a recruiter earns for <b>each counted joining</b> in it. Leave an amount blank until it is decided:
          nothing is paid or worked out for a blank one. The targets apply from the month you pick onward; an earlier month keeps the targets it had.
        </p>
        {msg && <div className="rj-saved">{msg}</div>}
        {error && <div className="rj-error">{error}</div>}
        <div className="tbl-wrap">
          <table className="rj-mini">
            <thead><tr><th>Category</th><th>Joinings a month</th>{data && data.money && <th>₹ per joining</th>}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.category}>
                  <td><b>{r.label}</b>{r.note ? <div className="rj-sub">{r.note}</div> : null}</td>
                  <td><input type="number" min="0" max={data ? data.maxTarget : 500} style={{ width: 90 }} value={r.target} onChange={(e) => set(i, 'target', e.target.value)} /></td>
                  {data && data.money && <td><input type="number" min="0" step="50" style={{ width: 110 }} value={r.incentive} onChange={(e) => set(i, 'incentive', e.target.value)} placeholder="not decided" /></td>}
                </tr>
              ))}
              <tr><td><b>Total</b></td><td><b>{total}</b></td>{data && data.money && <td />}</tr>
            </tbody>
          </table>
        </div>
        <label className="rj-check">
          <input type="checkbox" checked={fullCovers} onChange={(e) => setFullCovers(e.target.checked)} />
          <span>A <b>Full Time</b> doctor is enough: Full Time joinings above their own target also fill the <b>Part Time</b> target of the same group (MD/MS Doctors, MD/MS Faculty).
            <span className="rj-sub"> A Part Time joining never fills a Full Time target. This changes only the closing; the incentive is paid at the amount of the joining&apos;s own category. Applies to every month.</span></span>
        </label>
        <label className="rj-check">
          <input type="checkbox" checked={faculty} onChange={(e) => setFaculty(e.target.checked)} />
          <span>Count a Professor / Assistant Professor / Associate Professor / Senior Resident joining as <b>MD/MS Faculty</b> even when the candidate&apos;s qualification is not recorded.
            <span className="rj-sub"> Off: such a joining shows as &quot;needs a check&quot; until the qualification is filled in. This applies to every month.</span></span>
        </label>
        <div className="rj-row2">
          <div className="field"><label>Applies from month</label><input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        {data && data.history.length > 0 && (
          <>
            <h4 style={{ fontSize: 12.5, margin: '10px 0 6px' }}>Targets set so far</h4>
            <table className="rj-mini">
              <thead><tr><th>From</th><th>Joinings a month</th><th>Set by</th><th /></tr></thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.fromMonth}>
                    <td>{h.fromLabel}</td>
                    <td>{h.items.reduce((n, x) => n + x.target, 0)} in all <span className="rj-sub">({data.categories.map((c) => `${(h.items.find((x) => x.category === c.key) || {}).target ?? '—'}`).join(' · ')})</span></td>
                    <td className="rj-sub">{h.setByName || '—'}</td>
                    <td>{data.canEdit && <button className="btn btn-sm" onClick={() => remove(h)}>Remove</button>}</td>
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

function DeptPanel({ dept, month, viewer, ended, onChanged }) {
  const [edit, setEdit] = useState(false);
  const [give, setGive] = useState(null);
  const [msg, setMsg] = useState('');
  const money = !!viewer.money;
  const live = dept.categories.filter((c) => c.target != null);
  const t = dept.total;
  const partial = !!dept.partial;
  const amountsNote = money && live.some((c) => c.incentive == null);

  function saved(data) {
    setGive(null);
    const re = data.recalculate && data.recalculate.length ? ` Recalculate the ${data.recalculate.map(monthLabel).join(', ')} payroll before submitting it.` : '';
    setMsg(`${data.message || 'Saved.'}${re}`);
    onChanged();
  }

  return (
    <div className="rj-cat">
      <div className="rj-cat-head">
        <h3>{dept.department}: targets by category · {dept.label}</h3>
        {viewer.setTarget && <button className="btn btn-sm" onClick={() => setEdit(true)}>Change targets{money ? ' and amounts' : ''}</button>}
      </div>
      {msg && <div className="rj-saved">{msg}</div>}
      {!dept.set ? (
        <p className="rj-hint">No category targets are set for {dept.label}{viewer.setTarget ? ': use Change targets to set them' : ''}. Targets that start in a later month do not reach back to this one.</p>
      ) : (
        <>
          <p className="rj-hint">
            The team&apos;s joinings this month by category against its monthly target (targets from {monthLabel(dept.fromMonth)}). These are the same joinings as the table below, sorted into categories.
            {partial ? ' You see the joinings of your own area, so the closing % of the whole team is not shown.' : ''}
          </p>
          <div className="rj-cards">
            {!partial && <div className={`rj-card ${toneOf(t.achieved, t.target)}`}><b>{pctWord(t.closingPct)}</b><span>Target closed ({t.achieved} of {t.target})</span></div>}
            <div className="rj-card blue"><b>{t.joinedInSix}</b><span>Joined in the six categories{t.above ? ` (${t.above} above a target)` : ''}</span></div>
            <div className="rj-card green"><b>{t.closedCategories} of {t.categories}</b><span>Categories fully closed</span></div>
            <div className={`rj-card ${dept.otherCount ? 'orange' : 'grey'}`}><b>{dept.otherCount || 'None'}</b><span>Joined, not in the six</span></div>
            <div className={`rj-card ${dept.checkCount ? 'red' : 'grey'}`}><b>{dept.checkCount || 'None'}</b><span>Need a check</span></div>
            {money && <div className="rj-card green"><b>{t.incentive == null ? '—' : inr(t.incentive)}</b><span>{t.amountsSet ? 'Incentive earned (all categories)' : 'Incentive earned (amounts not all set)'}</span></div>}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th><th>Target</th><th>Joined</th><th>Closing</th><th>Still to go</th>
                  {money && <th>₹ per joining</th>}{money && <th>Incentive earned</th>}
                </tr>
              </thead>
              <tbody>
                {live.map((c) => (
                  <tr key={c.key}>
                    <td><b>{c.label}</b>{c.type ? <span className="rj-sub"> · {c.type}</span> : null}{c.note ? <div className="rj-sub">{c.note}</div> : null}</td>
                    <td>{c.target}</td>
                    <td>
                      <b>{c.achieved}</b>
                      {c.covered ? <span className="rj-sub"> + {c.covered} from Full Time</span> : null}
                      {c.usedForPart ? <span className="rj-sub"> ({c.usedForPart} of them fill the Part Time target)</span> : null}
                      {c.above ? <span className="rj-sub"> (+{c.above} above target)</span> : null}
                    </td>
                    <td><span className={`rj-score ${toneOf(c.achieved, c.target)}`}>{pctWord(c.closingPct)}</span></td>
                    <td>{c.left ? c.left : <span className="rj-tag green">Closed</span>}</td>
                    {money && <td>{c.incentive == null ? <span className="rj-sub">not decided</span> : inr(c.incentive)}</td>}
                    {money && <td>{c.earned == null ? <span className="rj-sub">—</span> : inr(c.earned)}</td>}
                  </tr>
                ))}
                <tr className="rj-cat-total">
                  <td><b>Total</b><div className="rj-sub">each category counted up to its own target</div></td>
                  <td><b>{t.target}</b></td>
                  <td><b>{t.achieved}</b>{t.above ? <span className="rj-sub"> (+{t.above} above)</span> : null}</td>
                  <td>{partial ? '—' : <span className={`rj-score ${toneOf(t.achieved, t.target)}`}>{pctWord(t.closingPct)}</span>}</td>
                  <td>{Math.max(0, t.target - t.achieved)}</td>
                  {money && <td />}{money && <td><b>{t.incentive == null ? '—' : inr(t.incentive)}</b></td>}
                </tr>
              </tbody>
            </table>
          </div>
          {amountsNote && <p className="rj-hint">Some categories have no amount yet, so their incentive is not worked out. Super Admin sets the rupees per joining in Change targets and amounts.</p>}
          {(dept.otherCount > 0 || dept.checkCount > 0 || dept.assumedCount > 0) && (
            <p className="rj-hint">
              {dept.otherCount > 0 && <><b>{dept.otherCount}</b> joining(s) are in posts that have no target here (for example a Pharmacist, a Lab Technician, an MBBS doctor on Part Time), so they are in Recruiter joinings but not in a category. </>}
              {dept.assumedCount > 0 && <><b>{dept.assumedCount}</b> joining(s) are counted as MD/MS Faculty only because of the post: the candidate has no qualification recorded. </>}
              {dept.checkCount > 0 && <><b>{dept.checkCount}</b> joining(s) cannot be sorted because something is missing (for example no qualification on the candidate, or an unclear employment type): they are in no category until it is fixed. </>}
              {viewer.details ? 'Open a recruiter below to see which category each joining went to and why.' : 'Open ATS to see which ones.'}
            </p>
          )}
          {dept.fullCoversPart && <p className="rj-hint">A Full Time doctor is enough: Full Time joinings above their own target also fill the Part Time target of the same group (MD/MS Doctors, MD/MS Faculty). A Part Time joining never fills a Full Time target.</p>}
          <p className="rj-hint">
            Full Time or Part Time comes from the joining&apos;s <b>Employment type</b> (ATS → the candidate&apos;s Joining &amp; Drop record → Correct the joining details), else from the job. Jobs and joinings start as Full Time, so a Part Time joining counts as Part Time only once that is set.
          </p>
          <h4 className="rj-cat-sub">Each recruiter</h4>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recruiter</th><th>Seat</th>
                  {live.map((c) => <th key={c.key} title={`${c.short}: team target ${c.target}`}>{c.label}{c.type ? <div className="rj-sub">{c.type}</div> : null}</th>)}
                  <th title="Counted joinings in a post that has no target">Not in the six</th><th title="Joinings that cannot be sorted: something is missing">Need a check</th>
                  <th title="Joinings in the six categories, and their share of the whole team target">In the six</th>
                  {money && <th>Incentive</th>}{money && ended && viewer.decide && <th>Decision</th>}
                </tr>
              </thead>
              <tbody>
                {dept.recruiters.map((r) => (
                  <tr key={r.key}>
                    <td><b>{r.name}</b>{r.left ? <div className="rj-sub">{r.employmentStatus}</div> : null}</td>
                    <td>{r.seat || '—'}</td>
                    {live.map((c) => {
                      const cell = r.cells[c.key];
                      return (
                        <td key={c.key}>{cell.count ? <b>{cell.count}</b> : <span className="rj-sub">0</span>}{cell.count && cell.pctOfTarget != null ? <div className="rj-sub">{cell.pctOfTarget}% of target</div> : null}</td>
                      );
                    })}
                    <td>{r.other ? <span className="rj-tag orange">{r.other}</span> : <span className="rj-sub">0</span>}</td>
                    <td>{r.check ? <span className="rj-tag red">{r.check}</span> : <span className="rj-sub">0</span>}</td>
                    <td><b>{r.inSix}</b>{r.sharePct != null ? <div className="rj-sub">{r.sharePct}% of {t.target}</div> : null}</td>
                    {money && (
                      <td>
                        {!r.hasAmounts ? <span className="rj-sub">—</span> : <b>{inr(r.incentive)}</b>}
                        {r.hasAmounts && !r.incentiveComplete ? <div className="rj-sub">some amounts not set</div> : null}
                      </td>
                    )}
                    {money && ended && viewer.decide && (
                      <td>
                        {r.decision ? <DecisionLine d={r.decision} /> : (
                          <span className="rj-sub">
                            {!r.employeeId ? 'No HRMS record' : !(r.hasAmounts && r.incentive > 0) ? '—' : r.left ? 'No longer on payroll: pay in the final settlement' : 'Waiting for your decision'}
                          </span>
                        )}
                        {r.employeeId && !r.left && r.hasAmounts && r.incentive > 0 && !(r.decision && r.decision.decision === 'INCENTIVE') && (
                          <div className="rj-acts" style={{ marginTop: 6 }}>
                            <button className="btn btn-sm btn-primary" onClick={() => setGive(r)}>Give {inr(r.incentive)}</button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {!dept.recruiters.length && <tr><td colSpan={5 + live.length} className="rj-sub">No {dept.department} recruiters on the list for {dept.label}.</td></tr>}
              </tbody>
            </table>
          </div>
          {money && !ended && <p className="rj-hint">Giving the incentive opens after {dept.label} ends, in the same step as every other recruiter incentive (it is paid with the next salary).</p>}
        </>
      )}
      {edit && <TargetsDialog dept={dept} month={month} onClose={() => setEdit(false)} onSaved={onChanged} />}
      {give && (
        <IncentiveDialog
          row={give} month={month} suggested={give.incentive}
          suggestedNote={`${dept.department} categories: ${live.filter((c) => (give.cells[c.key] || {}).count).map((c) => `${give.cells[c.key].count} ${c.short}`).join(', ')}`}
          onClose={() => setGive(null)} onSaved={saved}
        />
      )}
    </div>
  );
}

// month: the month picked in Recruiter joinings. department: the filter there ('' = all). reloadKey changes after a decision elsewhere.
export default function CategoryTargets({ month, department = '', reloadKey = 0, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get('/recruiter-joinings/category-board', { params: { month } })
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(errText(e, 'Could not load the category targets.')));
  }, [month]);
  useEffect(() => { setData(null); }, [month]); // another month: start clean
  useEffect(() => { load(); }, [load, reloadKey]); // a reload keeps what is on screen (an open window stays open) until the new numbers arrive
  if (error) return <div className="rj-error">{error}</div>;
  if (!data) return null;
  const depts = (data.departments || []).filter((d) => (!department || d.department === department) && (d.set || data.viewer.setTarget) && (d.recruiters.length || d.set || data.viewer.setTarget));
  if (!depts.length) return null;
  // the parent reloads its table and bumps reloadKey, which reloads this too
  const changed = () => { if (onChanged) onChanged(); else load(); };
  return (
    <div>
      {depts.map((d) => <DeptPanel key={d.department} dept={d} month={month} viewer={data.viewer} ended={data.ended} onChanged={changed} />)}
    </div>
  );
}


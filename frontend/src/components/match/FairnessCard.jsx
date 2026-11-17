// ---------------------------------------------------------------------------
// Company Setup → Fit settings → AI fairness (founder audit 2026-11-17).
// Admin only. Shows the last bias test of the Fit score (date, pass / fail,
// one row per attribute) and runs it again on demand.
// Backend: GET / POST /api/candidate-resumes/fairness-test
// (utils/fairnessTest.js, the same test as backend/scripts/ai-bias-test.js;
// method and results: docs/AI-BIAS-TEST-REPORT.md).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './match.css';

const when = (d) => (d ? new Date(d).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

export default function FairnessCard() {
  const [last, setLast] = useState(undefined); // undefined = loading, null = never run
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.get('/candidate-resumes/fairness-test')
      .then((r) => setLast(r.data.last || null))
      .catch((e) => { if (e.response && e.response.status === 403) setHidden(true); else { setLast(null); setError(e.response?.data?.error || 'Could not load the last test.'); } });
  }, []);
  if (hidden) return null;

  async function run() {
    setBusy(true); setError('');
    try {
      const r = await api.post('/candidate-resumes/fairness-test');
      setLast(r.data.last || null);
      setOpen(true);
    } catch (e) { setError(e.response?.data?.error || 'The test could not run. Please try again.'); } finally { setBusy(false); }
  }

  const attrs = (last && last.attributes) || [];
  const ff = last && last.fourFifths;
  return (
    <div className="card section b8-fs-section" data-testid="ai-fairness-card">
      <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>AI fairness</h3>
      <div className="small-muted">
        Checks that the Fit % never changes with a person&apos;s name, gender, age, marital status, photo, religion, caste,
        home state, college or a maternity break. Uses made-up people only, with the weights above.
      </div>
      {error && <div className="notice red" style={{ marginTop: 8 }}>{error}</div>}
      <div className="rsm-foot" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {last === undefined && <span className="small-muted">Loading…</span>}
        {last === null && <span className="small-muted">Not run yet.</span>}
        {last && (
          <>
            <StatusChip tone={last.pass ? 'green' : 'red'}>{last.pass ? 'Passed' : 'Failed'}</StatusChip>
            <span className="small-muted">
              {`Last run ${when(last.ranAt)}${last.ranByName ? ` by ${last.ranByName}` : ''} · ${(last.comparisons || 0).toLocaleString('en-IN')} pairs · ${last.fitVersion || ''}`}
            </span>
          </>
        )}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run test now'}</button>
        {attrs.length > 0 && <button type="button" className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Show details'}</button>}
      </div>
      {open && attrs.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table className="b8-ver-table" data-testid="ai-fairness-table">
            <thead><tr><th>What changed</th><th>Pairs</th><th>Biggest Fit difference</th><th>Eligible flipped</th><th>Result</th></tr></thead>
            <tbody>
              {attrs.map((a) => (
                <tr key={a.key}>
                  <td>
                    {a.label}
                    {a.kind === 'criterion' && <div className="small-muted" style={{ fontSize: 12 }}>A real job criterion: may move the Location part only.</div>}
                  </td>
                  <td>{a.comparisons}</td>
                  <td>{a.maxDiff}</td>
                  <td>{a.eligibleFlips}</td>
                  <td><StatusChip tone={a.pass ? 'green' : 'red'}>{a.pass ? 'Pass' : 'Fail'}</StatusChip></td>
                </tr>
              ))}
              {ff && (
                <tr>
                  <td>
                    Shortlist rates by group (80% rule)
                    <div className="small-muted" style={{ fontSize: 12 }}>{`${ff.groups.length} groups, the same ${ff.perGroup} made-up people each`}</div>
                  </td>
                  <td>{ff.perGroup * ff.groups.length}</td>
                  <td>{`Lowest ratio ${ff.minRatio}`}</td>
                  <td>{ff.identical ? 'Same for all' : 'Not the same'}</td>
                  <td><StatusChip tone={ff.pass ? 'green' : 'red'}>{ff.pass ? 'Pass' : 'Fail'}</StatusChip></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

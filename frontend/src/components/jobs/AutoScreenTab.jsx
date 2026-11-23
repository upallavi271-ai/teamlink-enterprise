import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// REQUIREMENT > KITS & TESTS > AUTO-SCREEN (founder 2026-11-23, "automatic screening (optional)").
// OFF by default. When on, every new application to this job (job portal, careers page, job boards, imports, Add) is checked in
// code: skills, experience range, expected pay vs budget (words only), notice period, location, knock-out answers, duplicate /
// fraud flags - and, when ticked, the match score. The result (Pass / Review / Not suitable + reasons) shows on the candidate
// row, and Candidates can filter on it. "Act on the result" (the job's TL / a manager / an Admin): a Pass moves a new application
// to Recruiter check, Not suitable goes On hold (rejected only when the company's auto-reject rule is on). Server: /api/ats-updates/screen/jobs/:id.
// ---------------------------------------------------------------------------
const errOf = (e) => (e && e.response && e.response.data && e.response.data.error) || 'That did not work. Please try again.';

export default function AutoScreenTab({ job }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get(`/ats-updates/screen/jobs/${job.id}`).then((r) => setD(r.data)).catch((e) => setErr(errOf(e))), [job.id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <div className="error-text">{err}</div> : <div className="small-muted">Loading…</div>;
  const save = async (patch) => {
    setErr(''); setMsg('');
    try { const r = await api.put(`/ats-updates/screen/jobs/${job.id}`, patch); setD({ ...d, ...r.data }); setMsg('Saved.'); } catch (e) { setErr(errOf(e)); }
  };
  return (
    <div className="ivt-body" data-testid="auto-screen">
      <div className="mkt-sec">
        <h3>Auto-screen new applications</h3>
        <div className="small-muted">
          Each new application is checked against this job: skills, experience, expected pay against the budget, notice period, location,
          the knock-out answers and duplicate / fraud flags. The result is Pass, Review or Not suitable, with the reasons, on the candidate&apos;s row.
          {!d.own && ` This job follows the company default (${d.enabled ? 'on' : 'off'}).`}
        </div>
        <label className="mkt-switch"><input type="checkbox" checked={!!d.enabled} disabled={!d.canEdit} onChange={(e) => save({ enabled: e.target.checked })} /><span><b>Auto-screen new applications</b><br /><span className="small-muted">Off by default.</span></span></label>
        <label className="mkt-switch"><input type="checkbox" checked={!!d.useFit} disabled={!d.canEdit || !d.enabled} onChange={(e) => save({ useFit: e.target.checked })} /><span><b>Also use the match score</b><br /><span className="small-muted">The Fit % TeamLink already works out. Nothing about the person leaves TeamLink, and a low score alone is only &quot;Review&quot;.</span></span></label>
        <label className="mkt-switch"><input type="checkbox" checked={!!d.act} disabled={!d.canEdit || !d.enabled} onChange={(e) => save({ act: e.target.checked })} /><span><b>Act on the result</b><br /><span className="small-muted">{`A Pass moves a new application to Recruiter check; Not suitable is put On hold${d.autoRejectOn ? ' - and REJECTED, because the company auto-reject rule is on' : ' (never rejected while the auto-reject rule is off)'}. Every automatic move can be undone in the review queue. Without this tick it only suggests.`}</span></span></label>
        {!d.canEdit && <div className="small-muted">Only this job&apos;s team lead, a manager or an Admin can change this.</div>}
        {d.byName && <div className="small-muted">{`Last changed by ${d.byName}.`}</div>}
      </div>
      {msg && <div className="notice">{msg}</div>}{err && <div className="error-text">{err}</div>}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { Notice, Table, useLoad, useAction, when, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// ORDER A BACKGROUND CHECK / AN ASSESSMENT FROM THE VENDOR (14.09 / IN-15 / 14.10, ATS wave 2 Z) - inside Joining -> Onboarding, per person.
// The vendor's result comes back by itself (callback, or "Check now"): a background check fills the person's BGV card, a test its score.
// The vendors' keys: Administration -> Integrations ("Background verification vendor (ATS)", "Assessment vendor (ATS)").
// Backend: utils/atsPlus/vendorsZ.js.
// ---------------------------------------------------------------------------
const LABEL = { education: 'Education', employment: 'Employment', address: 'Address', criminal: 'Criminal', identity: 'Identity' };
export default function VendorOrdersZ({ applicationId }) {
  const st = useLoad('/ats-plus/vendorsz/status');
  const { data, reload } = useLoad(`/ats-plus/vendorsz/orders?applicationId=${encodeURIComponent(applicationId)}`);
  const { run, busy, flash } = useAction(reload);
  const [bgv, setBgv] = useState({ checks: null, consent: false });
  const [testId, setTestId] = useState('');
  const s = st.data;
  if (!s) return null;
  const b = s.vendors.bgv; const a = s.vendors.assessment;
  const checks = bgv.checks || b.checks;
  return (
    <div style={{ marginTop: 12 }} data-testid="vendor-orders">
      <b>From the vendors</b>{flash}
      {s.canOrder && (
        <div className="card" style={{ padding: 10, margin: '6px 0' }}>
          {b.ready ? (
            <div style={row}>
              <span>Background check ({b.vendor}):</span>
              {s.allChecks.map((k) => <label key={k}><input type="checkbox" checked={checks.includes(k)} onChange={(e) => setBgv({ ...bgv, checks: e.target.checked ? [...checks, k] : checks.filter((x) => x !== k) })} /> {LABEL[k]}</label>)}
              <label title="DPDP Act 2023: the candidate's written consent"><input type="checkbox" checked={bgv.consent} onChange={(e) => setBgv({ ...bgv, consent: e.target.checked })} /> The candidate agreed in writing</label>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !bgv.consent || !checks.length} onClick={() => run(() => api.post('/ats-plus/vendorsz/bgv/order', { applicationId, checks, consent: bgv.consent }), (d) => `Ordered from ${b.vendor}.`)}>Order the check</button>
            </div>
          ) : <div className="small-muted">Background check vendor: not set up - needs the founder's vendor account {s.canSetUp && <Link to={b.setUpLink}>Set up</Link>}</div>}
          {a.ready ? (
            <div style={{ ...row, marginTop: 6 }}>
              <span>Test ({a.vendor}):</span>
              <input aria-label="Test ID" placeholder={a.testId ? `Test ID (default ${a.testId})` : 'Test ID'} value={testId} onChange={(e) => setTestId(e.target.value)} />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !(testId || a.testId)} onClick={() => run(() => api.post('/ats-plus/vendorsz/assessment/order', { applicationId, testId: testId || a.testId }), (d) => `Sent to ${a.vendor}.`)}>Send the test</button>
            </div>
          ) : <div className="small-muted" style={{ marginTop: 4 }}>Assessment vendor: not set up - needs the founder's vendor account {s.canSetUp && <Link to={a.setUpLink}>Set up</Link>}</div>}
        </div>
      )}
      {data && <Table rows={data.rows} empty="Nothing ordered from a vendor for this person."
        cols={[{ key: 'at', label: 'When', render: (r) => when(r.at) }, { key: 'title', label: 'Order', render: (r) => `${r.title} (${r.vendor})` }, { key: 'status', label: 'Status' },
          { key: 'result', label: 'Result', render: (r) => (r.result ? `${r.result.verdict}${r.result.score !== null && r.result.score !== undefined ? ` · ${r.result.score}${r.result.maxScore ? `/${r.result.maxScore}` : ''}` : ''}` : '—') },
          { key: 'x', label: '', render: (r) => <span style={row}>{r.testUrl && <a href={r.testUrl} target="_blank" rel="noreferrer">Test link</a>}{r.result && r.result.reportUrl && <a href={r.result.reportUrl} target="_blank" rel="noreferrer">Report</a>}
            {r.status === 'IN_PROGRESS' && s.canOrder && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/ats-plus/vendorsz/orders/${r.id}/check`), 'Checked with the vendor.')}>Check now</button>}</span> }]} />}
      <Notice tone="red">{st.err}</Notice>
    </div>
  );
}

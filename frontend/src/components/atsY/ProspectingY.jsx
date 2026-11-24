import { useState } from 'react';
import api from '../../api';
import { Card, Flash, Empty, useGet, useRun } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// 06.05 PROSPECTING (ATS wave 2 Y) - ATS > Clients > Business development > "Find companies" (not the CRM).
// Companies our own candidates work at (or worked at) that are not a client or a prospect yet, with their HR people as hiring contacts
// (name and role only), and the company-data provider's companies with verified contacts. Add one to the prospect list; enrol it in an
// outreach campaign (mails go out only when an Admin has outreach on). OFF until an Admin switches "Prospecting" on.
// ---------------------------------------------------------------------------
const Y = '/ats/y';

function Row({ s, canWrite, campaigns, onAdded }) {
  const [added, setAdded] = useState(null);
  const [camp, setCamp] = useState('');
  const { busy, msg, run } = useRun();
  return (
    <li style={{ display: 'block' }}>
      <div className="mkb-row">
        <span className="mkb-grow"><b>{s.company}</b><div className="small-muted">{[s.city, s.industry, s.source].filter(Boolean).join(' · ')}</div></span>
        {s.score != null && <span className="mkb-score">{s.score}</span>}
        {canWrite && !added && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${Y}/prospecting/add`, s), 'Added to the prospect list.').then((r) => { if (r) { setAdded(r.data.prospect); onAdded(); } })}>Add to prospects</button>}
      </div>
      {s.reasons && s.reasons.length > 0 && <div className="small-muted">{s.reasons.join(' · ')}</div>}
      {s.contacts && s.contacts.length > 0 && <div className="small-muted">{`Hiring contacts: ${s.contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.verified ? ' - verified' : ''}`).join(', ')}`}</div>}
      {added && canWrite && (
        <div className="mkb-row">
          <select value={camp} onChange={(e) => setCamp(e.target.value)} aria-label="Outreach campaign"><option value="">Start outreach with…</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <button type="button" className="btn btn-sm" disabled={busy || !camp} onClick={() => run(() => api.post(`${Y}/prospecting/contact`, { prospectId: added.id, campaignId: camp }), (r) => r.data.message)}>Enrol</button>
        </div>
      )}
      <Flash msg={msg} />
    </li>
  );
}

export default function ProspectingY({ meta }) {
  const s = useGet(`${Y}/prospecting`);
  const camps = useGet('/ats-plus/bd/campaigns');
  const [f, setF] = useState({ industry: '', location: '', hiringFor: '' });
  const [outside, setOutside] = useState(null);
  const { busy, msg, run } = useRun();
  const canWrite = !!(meta && meta.canWrite);
  const campaigns = (camps.data && camps.data.rows) || [];
  return (
    <div data-testid="atsy-prospecting">
      <Card title="New companies from our own data" note={s.data ? s.data.note : 'Companies our candidates work at that are not clients yet.'}>
        {s.error && <div className="notice">{s.error}</div>}
        {s.loading && <Empty>Looking…</Empty>}
        {s.data && !s.data.rows.length && <Empty>No new company stands out yet.</Empty>}
        <ul className="mkb-list">{((s.data && s.data.rows) || []).map((x) => <Row key={x.company} s={x} canWrite={canWrite} campaigns={campaigns} onAdded={() => {}} />)}</ul>
      </Card>
      <Card title="Companies from the company-data provider" note="Needs the founder's provider account and the Admin switch for outside look-ups. Each search is logged.">
        <div className="mkb-row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="Industry" value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} aria-label="Industry" />
          <input placeholder="City" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} aria-label="City" style={{ width: 120 }} />
          <input placeholder="Hiring for (role)" value={f.hiringFor} onChange={(e) => setF({ ...f, hiringFor: e.target.value })} aria-label="Hiring for" />
          <button type="button" className="btn btn-sm" disabled={busy || !canWrite} onClick={() => run(() => api.post(`${Y}/prospecting/outside`, f), (r) => `${r.data.rows.length} new compan${r.data.rows.length === 1 ? 'y' : 'ies'}.`).then((r) => r && setOutside(r.data.rows))}>Find companies</button>
        </div>
        <Flash msg={msg} />
        {outside && !outside.length && <Empty>Nothing new.</Empty>}
        {outside && <ul className="mkb-list">{outside.map((x) => <Row key={x.company} s={x} canWrite={canWrite} campaigns={campaigns} onAdded={() => {}} />)}</ul>}
      </Card>
    </div>
  );
}

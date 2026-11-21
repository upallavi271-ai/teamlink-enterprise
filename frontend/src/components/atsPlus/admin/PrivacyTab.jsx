import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import TabStrip from '../../ui/TabStrip.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, Switch, dmy, when, row } from '../kit.jsx';

// ---------------------------------------------------------------------------
// ATS settings -> Privacy & security (15.09 / IN-06 DPDP, IN-07 / IN-08 IDs, 13.10 retention, 15.11 residency, 15.12 / 15.16 status + SLA).
// Backend: utils/atsPlus/privacy.js and status.js. The export / legal hold / erasure of one person stay on the candidate's profile.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'notice', label: 'Notice & consent', hint: 'The privacy notice in three languages and the consent log' },
  { key: 'requests', label: 'Data requests', hint: 'See / correct / erase requests with due dates' },
  { key: 'breaches', label: 'Breaches', hint: 'The breach register and the 72-hour clock' },
  { key: 'retention', label: 'Retention', hint: 'How long each kind of data is kept (OFF until switched on)' },
  { key: 'ids', label: 'Aadhaar & PAN', hint: 'Masking, the Aadhaar sweep and who opened a full number' },
  { key: 'where', label: 'Where data is stored', more: true, hint: 'Data residency and backups' },
  { key: 'status', label: 'Status & SLA pages', more: true, hint: 'The public status, trust and SLA pages' },
];

function NoticePanel() {
  const { data, err, reload } = useLoad('/ats-plus/privacy/notice');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState(null);
  const cons = useLoad('/ats-plus/privacy/consents');
  useEffect(() => { if (data) setF({ text: { ...data.text }, officer: { ...data.officer }, retentionMonths: data.retentionMonths, purposes: data.purposes.join('\n') }); }, [data]);
  return (
    <>
      <Section title={`Privacy notice (version ${data ? data.version : '…'})`} note="The itemised notice candidates see (public at /privacy-notice, in English, Telugu and Hindi). {{purposes}}, {{months}} and {{officer}} are filled in. Saving makes a new version; each consent records the version it was given on.">
        <Notice tone="red">{err}</Notice>{flash}
        {f && <>
          <div className="grid-2">
            <Field label="Grievance officer"><input value={f.officer.name || ''} disabled={!data.canEdit} onChange={(e) => setF({ ...f, officer: { ...f.officer, name: e.target.value } })} /></Field>
            <Field label="Officer e-mail"><input value={f.officer.email || ''} disabled={!data.canEdit} onChange={(e) => setF({ ...f, officer: { ...f.officer, email: e.target.value } })} /></Field>
            <Field label="Officer phone"><input value={f.officer.phone || ''} disabled={!data.canEdit} onChange={(e) => setF({ ...f, officer: { ...f.officer, phone: e.target.value } })} /></Field>
            <Field label="Kept for (months after the last activity)"><input type="number" value={f.retentionMonths} disabled={!data.canEdit} onChange={(e) => setF({ ...f, retentionMonths: e.target.value })} /></Field>
          </div>
          <Field label="Purposes (one a line)"><textarea rows={4} value={f.purposes} disabled={!data.canEdit} onChange={(e) => setF({ ...f, purposes: e.target.value })} /></Field>
          {['en', 'te', 'hi'].map((l) => <Field key={l} label={{ en: 'English', te: 'Telugu', hi: 'Hindi' }[l]}><textarea rows={4} value={f.text[l]} disabled={!data.canEdit} onChange={(e) => setF({ ...f, text: { ...f.text, [l]: e.target.value } })} /></Field>)}
          {data.canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/privacy/notice', { ...f, purposes: f.purposes.split('\n').map((x) => x.trim()).filter(Boolean) }), 'Saved as a new version.')}>Save the notice</button>}{' '}
          <Link to="/privacy-notice" target="_blank">Open the public page</Link>
        </>}
      </Section>
      <Section title="Consent log" note="Every consent given or withdrawn, with the purpose, the notice version and how it was given. Record one from a candidate's profile (Privacy card).">
        <Notice tone="red">{cons.err}</Notice>
        {cons.data && <Table rows={cons.data.rows} empty="No consent recorded through the log yet."
          cols={[{ key: 'createdAt', label: 'When', render: (r) => when(r.createdAt) }, { key: 'refId', label: 'Candidate', render: (r) => <Link to={`/candidates/${r.refId}`}>Open</Link> }, { key: 'status', label: 'Consent' }, { key: 'noticeVersion', label: 'Notice' }, { key: 'channel', label: 'How' }, { key: 'createdByName', label: 'Recorded by' }, { key: 'reason', label: 'Words', render: (r) => r.reason || '—' }]} />}
      </Section>
    </>
  );
}

function Requests() {
  const { data, err, reload } = useLoad('/ats-plus/privacy/requests');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ type: 'ACCESS', requester: '', candidateId: '', details: '', via: 'e-mail' });
  const act = (r, status) => {
    const answer = status === 'IN_PROGRESS' ? '' : window.prompt('The answer given to the person (kept on the request):') || '';
    if (status !== 'IN_PROGRESS' && answer.trim().length < 5) return;
    const erase = status === 'DONE' && r.type === 'ERASURE' && window.confirm('Erase this person now? This cannot be undone.');
    run(() => api.post(`/ats-plus/privacy/requests/${r.id}`, { status, answer, erase }), 'Saved.');
  };
  return (
    <Section title="Data requests" note={`Requests to see, correct or erase personal data, complaints and nominations. Each is due ${data ? data.dueDays : 30} days after it is logged. "See my data" = the Export button on the profile.`}>
      <Notice tone="red">{err}</Notice>{flash}
      <div style={{ ...row, marginBottom: 8 }}>
        <select aria-label="Kind" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{data && Object.entries(data.types).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input aria-label="Who asked" placeholder="Who asked, and how to reach them" value={f.requester} onChange={(e) => setF({ ...f, requester: e.target.value })} />
        <input aria-label="Candidate id" placeholder="Candidate id (optional)" value={f.candidateId} onChange={(e) => setF({ ...f, candidateId: e.target.value.trim() })} />
        <input aria-label="Details" placeholder="What they asked" value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post('/ats-plus/privacy/requests', f), 'Request logged.')}>Log request</button>
      </div>
      {data && <Table rows={data.rows} empty="No requests yet."
        cols={[{ key: 'title', label: 'Request' }, { key: 'requester', label: 'Who' }, { key: 'candidateName', label: 'Candidate', render: (r) => (r.refId ? <Link to={`/candidates/${r.refId}`}>{r.candidateName || 'Open'}</Link> : '—') },
          { key: 'dueAt', label: 'Due', render: (r) => <span style={r.overdue ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{dmy(r.dueAt)}{r.overdue ? ' (late)' : ''}</span> }, { key: 'status', label: 'Status' }, { key: 'answer', label: 'Answer', render: (r) => r.answer || '—' },
          { key: 'a', label: '', render: (r) => !['DONE', 'REJECTED'].includes(r.status) && <span style={row}><button type="button" className="btn btn-sm" onClick={() => act(r, 'IN_PROGRESS')}>Working on it</button><button type="button" className="btn btn-sm" onClick={() => act(r, 'DONE')}>Done</button><button type="button" className="btn btn-sm" onClick={() => act(r, 'REJECTED')}>Refuse</button></span> }]} />}
    </Section>
  );
}

function Breaches() {
  const { data, err, reload } = useLoad('/ats-plus/privacy/breaches');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ what: '', dataTypes: '', people: '', severity: 'Medium' });
  return (
    <Section title="Breach register" note="A personal data breach is told to the Data Protection Board within 72 hours and to the people affected without delay (DPDP Rules 2025).">
      <Notice tone="red">{err}</Notice>{flash}
      <Field label="What happened"><textarea rows={2} value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })} /></Field>
      <div style={row}><input aria-label="Data affected" placeholder="Data affected (name, phone ...)" value={f.dataTypes} onChange={(e) => setF({ ...f, dataTypes: e.target.value })} /><input aria-label="People affected" type="number" placeholder="People" value={f.people} onChange={(e) => setF({ ...f, people: e.target.value })} />
        <select aria-label="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['Low', 'Medium', 'High'].map((x) => <option key={x}>{x}</option>)}</select>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post('/ats-plus/privacy/breaches', f), 'Breach logged. The 72-hour clock started from the time found.')}>Log breach</button></div>
      {data && <Table rows={data.rows} empty="No breach logged."
        cols={[{ key: 'discoveredAt', label: 'Found', render: (r) => when(r.discoveredAt) }, { key: 'title', label: 'What' }, { key: 'people', label: 'People' }, { key: 'severity', label: 'Severity' },
          { key: 'b', label: 'Board told', render: (r) => (r.boardNotifiedAt ? when(r.boardNotifiedAt) : <span style={r.boardLate ? { color: 'var(--red)', fontWeight: 600 } : undefined}>by {when(r.boardDueAt)}{r.boardLate ? ' (late)' : ''}</span>) },
          { key: 'p', label: 'People told', render: (r) => (r.peopleNotifiedAt ? when(r.peopleNotifiedAt) : '—') }, { key: 'status', label: 'Status' },
          { key: 'a', label: '', render: (r) => r.status !== 'CLOSED' && <span style={row}>{!r.boardNotifiedAt && <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/privacy/breaches/${r.id}`, { boardNotified: true }), 'Marked.')}>Board told</button>}
            {!r.peopleNotifiedAt && <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/privacy/breaches/${r.id}`, { peopleNotified: true }), 'Marked.')}>People told</button>}
            <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/privacy/breaches/${r.id}`, { close: true }), 'Closed.')}>Close</button></span> }]} />}
    </Section>
  );
}

function Retention() {
  const { data, err, reload } = useLoad('/ats-plus/privacy/retention');
  const { run, busy, flash } = useAction(reload);
  const [rules, setRules] = useState(null); const [dry, setDry] = useState(null);
  useEffect(() => { if (data) setRules(data.rules); }, [data]);
  return (
    <Section title="Data retention" note="How long each kind of data is kept. The dry run says how many records would go; the purge runs only when switched ON, at most 200 people a time, and never touches a record on legal hold or a placement still owed. Anonymised records cannot be brought back.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && rules && <>
        <Notice tone={data.enabled ? 'amber' : 'green'}>{data.enabled ? 'The purge is ON (it runs once a day).' : 'The purge is OFF. Nothing is removed.'}</Notice>
        {Object.entries(rules).map(([k, r]) => (
          <div key={k} style={{ ...row, marginBottom: 4 }}>
            <label style={row}><input type="checkbox" checked={r.on} disabled={!data.canEdit} onChange={(e) => setRules({ ...rules, [k]: { ...r, on: e.target.checked } })} /> {r.label}</label>
            <span>after</span><input type="number" aria-label="Months" style={{ width: 70 }} value={r.months} disabled={!data.canEdit} onChange={(e) => setRules({ ...rules, [k]: { ...r, months: e.target.value } })} /><span>months: {r.action}</span>
          </div>
        ))}
        <div style={row}>
          {data.canEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put('/ats-plus/privacy/retention', { rules }), 'Rules saved.')}>Save rules</button>}
          <button type="button" className="btn btn-sm" onClick={() => api.post('/ats-plus/privacy/retention/run', { dryRun: true }).then((r) => setDry(r.data)).catch(() => setDry(null))}>Dry run</button>
          {data.canEdit && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put('/ats-plus/privacy/retention', { enabled: !data.enabled }), data.enabled ? 'Purge switched OFF.' : 'Purge switched ON.')}>{data.enabled ? 'Switch the purge OFF' : 'Switch the purge ON'}</button>}
          {data.canEdit && data.enabled && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => { if (window.prompt('Type PURGE to run it now') === 'PURGE') run(() => api.post('/ats-plus/privacy/retention/run', { confirm: 'PURGE' }), 'Done.'); }}>Run now</button>}
        </div>
        {dry && <Table rows={dry.results.filter((x) => x.on)} rowKey={(r) => r.type} cols={[{ key: 'label', label: 'Data' }, { key: 'months', label: 'Months' }, { key: 'count', label: 'Would go now' }]} />}
        {data.lastRun && <div className="small-muted">Last run {when(data.lastRun.at)} by {data.lastRun.by}.</div>}
      </>}
    </Section>
  );
}

function Ids() {
  const views = useLoad('/ats-plus/privacy/id-views');
  const { run, busy, flash } = useAction(views.reload);
  const [dry, setDry] = useState(null);
  return (
    <>
      <Section title="Aadhaar and PAN" note="Aadhaar: only the last 4 digits are ever kept (checked first: 12 digits and the checksum). PAN and bank account numbers are kept encrypted and shown masked; a Super Admin, Admin or HR opens one with a reason. They are never in a list or an export. ID documents (Aadhaar, PAN, passport files) open only for the Super Admin, Admin, HR, the team lead and the owning recruiter.">
        {flash}
        <div style={row}>
          <button type="button" className="btn btn-sm" onClick={() => api.post('/ats-plus/privacy/aadhaar-sweep', { dryRun: true }).then((r) => setDry(r.data)).catch(() => setDry(null))}>Find full Aadhaar numbers in resumes and notes</button>
          {dry && dry.numbers > 0 && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post('/ats-plus/privacy/aadhaar-sweep', {}), (d) => `Masked ${d.numbers} number(s).`).then(() => setDry(null))}>Mask them now</button>}
        </div>
        {dry && <div className="small-muted">{dry.numbers ? `${dry.numbers} full Aadhaar number(s) in ${dry.resumes} resume(s) and ${dry.notes} note(s).` : 'No full Aadhaar number found.'}</div>}
      </Section>
      <Section title="Who opened a full number">
        <Notice tone="red">{views.err}</Notice>
        {views.data && <Table rows={views.data.rows} empty="Nobody has opened one." cols={[{ key: 'createdAt', label: 'When', render: (r) => when(r.createdAt) }, { key: 'createdByName', label: 'Who' }, { key: 'status', label: 'What' }, { key: 'refId', label: 'Candidate', render: (r) => <Link to={`/candidates/${r.refId}`}>Open</Link> }, { key: 'reason', label: 'Why' }]} />}
      </Section>
    </>
  );
}

function Where() {
  const { data, err, reload } = useLoad('/ats-plus/privacy/residency');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState(null);
  useEffect(() => { if (data) setF({ ...data }); }, [data]);
  return (
    <Section title="Where the data is stored" note="Shown on the public trust page (/trust). Fill in the hosting company and city of the server and of the backups, then press Confirm.">
      <Notice tone="red">{err}</Notice>{flash}
      {f && <>
        <div className="grid-2">
          {[['region', 'Country / region'], ['provider', 'Hosting company'], ['city', 'City / data centre'], ['backupLocation', 'Backups kept in'], ['backupProvider', 'Backup storage company']].map(([k, l]) => <Field key={k} label={l}><input value={f[k] || ''} disabled={!data.canEdit} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
        </div>
        <Field label="Other services that handle data"><textarea rows={3} value={f.processors || ''} disabled={!data.canEdit} onChange={(e) => setF({ ...f, processors: e.target.value })} /></Field>
        {data.confirmedAt && <div className="small-muted">Confirmed by {data.confirmedBy} on {dmy(data.confirmedAt)}.</div>}
        {data.canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/privacy/residency', { ...f, confirm: true }), 'Saved and confirmed.')}>Save and confirm</button>}{' '}
        <Link to="/trust" target="_blank">Open the trust page</Link>
      </>}
    </Section>
  );
}

function StatusSla() {
  const { data, err, reload } = useLoad('/ats-plus/status/settings');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState(null);
  useEffect(() => { if (data) setF({ ...data, response: { ...data.response } }); }, [data]);
  return (
    <Section title="Status, trust and SLA pages" note="Public pages: /status (live check and uptime), /trust (security practices, where data is stored), /sla (targets against measured uptime). They show no names or record counts.">
      <Notice tone="red">{err}</Notice>{flash}
      {f && <>
        <Switch checked={f.public} disabled={!data.canEdit} onChange={(v) => setF({ ...f, public: v })} label="Public pages are on" note="Off = the three pages answer 'switched off'." />
        <div className="grid-2">
          <Field label="Uptime target (%)"><input type="number" step="0.1" value={f.uptimeTarget} disabled={!data.canEdit} onChange={(e) => setF({ ...f, uptimeTarget: e.target.value })} /></Field>
          <Field label="Support hours"><input value={f.supportHours} disabled={!data.canEdit} onChange={(e) => setF({ ...f, supportHours: e.target.value })} /></Field>
          <Field label="Support e-mail"><input value={f.supportEmail} disabled={!data.canEdit} onChange={(e) => setF({ ...f, supportEmail: e.target.value })} /></Field>
          <Field label="Support phone"><input value={f.supportPhone} disabled={!data.canEdit} onChange={(e) => setF({ ...f, supportPhone: e.target.value })} /></Field>
          {['P1', 'P2', 'P3'].map((k) => <Field key={k} label={`First answer ${k}`}><input value={f.response[k]} disabled={!data.canEdit} onChange={(e) => setF({ ...f, response: { ...f.response, [k]: e.target.value } })} /></Field>)}
        </div>
        <Field label="Service credits / remedies (optional)"><textarea rows={2} value={f.credits} disabled={!data.canEdit} onChange={(e) => setF({ ...f, credits: e.target.value })} /></Field>
        <div className="small-muted">Measured uptime, last 30 days: {data.last.pct === null ? 'not measured yet' : `${data.last.pct}%`} ({data.last.samples} checks, average {data.last.avgMs ?? '—'} ms).</div>
        {data.canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/status/settings', f), 'Saved.')}>Save</button>}{' '}
        <Link to="/status" target="_blank">Status</Link> · <Link to="/trust" target="_blank">Trust</Link> · <Link to="/sla" target="_blank">SLA</Link>
      </>}
    </Section>
  );
}

export default function PrivacyTab() {
  const [tab, setTab] = useState('notice');
  return (
    <>
      <TabStrip label="Privacy and security" tabs={TABS} value={tab} onChange={setTab} small />
      {tab === 'notice' && <NoticePanel />}
      {tab === 'requests' && <Requests />}
      {tab === 'breaches' && <Breaches />}
      {tab === 'retention' && <Retention />}
      {tab === 'ids' && <Ids />}
      {tab === 'where' && <Where />}
      {tab === 'status' && <StatusSla />}
    </>
  );
}

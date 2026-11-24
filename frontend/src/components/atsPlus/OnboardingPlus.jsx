import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, dmy, when, row } from './kit.jsx';
import VendorOrdersZ from './VendorOrdersZ.jsx'; // 14.09 / IN-15 / 14.10: order from the BGV / test vendor, the result back on the record (ATS wave 2 Z)

// ---------------------------------------------------------------------------
// JOINING -> ONBOARDING (market benchmark 11.09 / 11.10 / 11.11 / 11.18): one pack per person (the checklist picked for the client and
// job type), the candidate's pre-boarding link (welcome note, their steps, uploads, short forms), the HR / recruiter / client tasks,
// and the documents that expire. Backend: utils/atsPlus/onboarding.js. Nothing is sent from here: copy the link into your message.
// ---------------------------------------------------------------------------
const ST = { OPEN: 'To do', SUBMITTED: 'Waiting for review', DONE: 'Done', VERIFIED: 'Verified', SENT_BACK: 'Sent back', WAIVED: 'Not needed' };

// background checks and assessments for this person (14.09 / 14.10): order from a vendor, see / type the result
function ChecksAndTests({ applicationId }) {
  const { data, reload } = useLoad('/ats-plus/integrations/connectors');
  const { run, busy, flash } = useAction(reload);
  const [res, setRes] = useState({});
  if (!data || !data.rows.length) return <><VendorOrdersZ applicationId={applicationId} /><div className="small-muted" style={{ marginTop: 10 }}>Other checks and tests: no manual / HTTP vendor added (Administration → ATS settings → Integrations → Checks & tests).</div></>;
  const mine = data.orders.filter((o) => o.applicationId === applicationId);
  return (
    <div style={{ marginTop: 12 }}>
      <VendorOrdersZ applicationId={applicationId} />
      <b>Background checks and tests</b>{flash}
      <div style={{ ...row, margin: '6px 0' }}>{data.rows.filter((c) => c.status === 'ON').map((c) => <button key={c.id} type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/ats-plus/integrations/connectors/${c.id}/order`, { applicationId }), (d) => `Ordered: ${d.note}`)}>Order: {c.title}</button>)}</div>
      <Table rows={mine} empty="Nothing ordered for this person."
        cols={[{ key: 'title', label: 'Order' }, { key: 'status', label: 'Status' }, { key: 'r', label: 'Result', render: (o) => (o.result ? `${o.result.verdict}${o.result.score !== null && o.result.score !== undefined ? ` (${o.result.score})` : ''}` : (
          <span style={row}><select aria-label="Verdict" value={(res[o.id] || {}).verdict || ''} onChange={(e) => setRes({ ...res, [o.id]: { ...(res[o.id] || {}), verdict: e.target.value } })}><option value="">Result…</option>{data.verdicts.map((v) => <option key={v}>{v}</option>)}</select>
            <input aria-label="Score" type="number" placeholder="Score" style={{ width: 70 }} value={(res[o.id] || {}).score || ''} onChange={(e) => setRes({ ...res, [o.id]: { ...(res[o.id] || {}), score: e.target.value } })} />
            <button type="button" className="btn btn-sm" disabled={!(res[o.id] || {}).verdict} onClick={() => run(() => api.post(`/ats-plus/integrations/orders/${o.id}/result`, res[o.id]), 'Result saved.')}>Save</button></span>
        )) }]} />
    </div>
  );
}

export function OnboardingPack({ applicationId, onClose }) {
  const { data, err, reload } = useLoad(`/ats-plus/onboarding/${applicationId}`);
  const { run, busy, flash } = useAction(reload);
  const [link, setLink] = useState('');
  const [w, setW] = useState({ firstDay: '', time: '', place: '', meet: '', welcomeText: '' });
  const [exp, setExp] = useState({});
  const p = data && data.pack;
  const open = () => run(() => api.post(`/ats-plus/onboarding/${applicationId}/open`, w), (d) => d.message).then((d) => { if (d && d.link) setLink(`${window.location.origin}${d.link}`); });
  const mark = (it, status) => {
    let note = '';
    if (['SENT_BACK', 'WAIVED'].includes(status)) { note = window.prompt(status === 'SENT_BACK' ? 'What should the person fix?' : 'Why is this not needed?') || ''; if (!note.trim()) return; }
    run(() => api.post(`/ats-plus/onboarding/${applicationId}/items/${it.key}`, { status, note, expiresOn: exp[it.key] || undefined }), `${it.label}: ${ST[status]}.`);
  };
  return (
    <Modal title={data ? `Onboarding: ${data.candidate}` : 'Onboarding'} size="wide" onClose={onClose}>
      <Notice tone="red">{err}</Notice>{flash}
      {data && !p && <Notice>Checklist for this person: <b>{data.suggested.title}</b> ({data.suggested.why}), {data.suggested.items.length} steps.</Notice>}
      {p && <div style={row}><b>{p.title}</b><span className="small-muted">{p.progress.done} of {p.progress.of} done ({p.progress.pct}%) · link {p.linkActive ? 'active' : 'stopped'}</span></div>}
      <div className="grid-2" style={{ marginTop: 8 }}>
        <Field label="First day"><input type="date" value={w.firstDay} onChange={(e) => setW({ ...w, firstDay: e.target.value })} /></Field>
        <Field label="Reporting time"><input value={w.time} onChange={(e) => setW({ ...w, time: e.target.value })} placeholder={(p && p.welcome && p.welcome.time) || '9:30 am'} /></Field>
        <Field label="Where to report"><input value={w.place} onChange={(e) => setW({ ...w, place: e.target.value })} placeholder={(p && p.welcome && p.welcome.place) || 'Office address'} /></Field>
        <Field label="Whom to meet"><input value={w.meet} onChange={(e) => setW({ ...w, meet: e.target.value })} placeholder={(p && p.welcome && p.welcome.meet) || 'Name (role)'} /></Field>
      </div>
      <Field label="Welcome note"><textarea rows={2} value={w.welcomeText} onChange={(e) => setW({ ...w, welcomeText: e.target.value })} placeholder={(p && p.welcome && p.welcome.text) || 'Welcome! Please finish these steps before your first day.'} /></Field>
      <div style={row}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={open}>{p ? 'Make a new link (the old one stops)' : 'Start onboarding and make the link'}</button>
        {p && p.linkActive && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`/ats-plus/onboarding/${applicationId}/close`), 'The link is stopped.')}>Stop the link</button>}
      </div>
      {link && <Notice tone="green"><span>Pre-boarding link: <input readOnly value={link} style={{ width: 360 }} onFocus={(e) => e.target.select()} aria-label="Pre-boarding link" /> <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(link)}>Copy</button></span></Notice>}
      {p && <Table rows={p.items} rowKey={(r) => r.key}
        cols={[
          { key: 'label', label: 'Step' }, { key: 'who', label: 'Who' },
          { key: 'status', label: 'Status', render: (r) => <span>{ST[r.status] || r.status}{r.note ? <span className="small-muted"> · {r.note}</span> : null}{r.fileName ? <span className="small-muted"> · {r.fileName}</span> : null}{r.values ? <span className="small-muted"> · {Object.values(r.values).join(' · ')}</span> : null}</span> },
          { key: 'exp', label: 'Expires', render: (r) => (r.expires ? <input type="date" aria-label="Expiry" value={exp[r.key] ?? r.expiresOn ?? ''} onChange={(e) => setExp({ ...exp, [r.key]: e.target.value })} /> : '—') },
          { key: 'a', label: '', render: (r) => <span style={row}>
            {r.type === 'doc' && r.status === 'SUBMITTED' && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'VERIFIED')}>Verify</button>}
            {r.type !== 'doc' && !['DONE', 'VERIFIED'].includes(r.status) && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'DONE')}>Done</button>}
            {['SUBMITTED', 'DONE'].includes(r.status) && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'SENT_BACK')}>Send back</button>}
            {r.status === 'OPEN' && <button type="button" className="btn btn-sm" onClick={() => mark(r, 'WAIVED')}>Not needed</button>}
          </span> },
        ]} />}
      <ChecksAndTests applicationId={applicationId} />
    </Modal>
  );
}

export function OnboardingList() {
  const { data, err } = useLoad('/ats-plus/onboarding');
  const [open, setOpen] = useState(null);
  const [appId, setAppId] = useState('');
  return (
    <Section title="Onboarding and pre-boarding" note="Each person's joining checklist (picked for the client and job type), their pre-boarding link and the tasks for HR, the recruiter and the client. Open it from a person here, or start one by the application id (Joining list → the person).">
      <Notice tone="red">{err}</Notice>
      <div style={{ ...row, marginBottom: 8 }}><input aria-label="Application id" placeholder="Application id" value={appId} onChange={(e) => setAppId(e.target.value.trim())} /><button type="button" className="btn btn-sm" disabled={!appId} onClick={() => setOpen(appId)}>Open</button></div>
      {data && <Table rows={data.rows} rowKey={(r) => r.applicationId} empty="No onboarding started yet."
        cols={[{ key: 'name', label: 'Person', render: (r) => <button type="button" className="btn btn-sm" onClick={() => setOpen(r.applicationId)}>{r.name}</button> }, { key: 'job', label: 'Job' }, { key: 'client', label: 'Client', render: (r) => r.client || '—' }, { key: 'joiningDate', label: 'Joining', render: (r) => dmy(r.joiningDate) },
          { key: 'p', label: 'Done', render: (r) => `${r.progress.done}/${r.progress.of} (${r.progress.pct}%)` }, { key: 'waiting', label: 'To review', render: (r) => r.waiting || '—' }, { key: 'l', label: 'Link', render: (r) => (r.linkActive ? 'active' : 'stopped') }]} />}
      {open && <OnboardingPack applicationId={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

export function ComplianceList() {
  const [days, setDays] = useState(30);
  const { data, err } = useLoad(`/ats-plus/onboarding-compliance?days=${days}`);
  return (
    <Section title="Documents and credentials that expire" note="Licences, medical fitness, visas and certifications: expired, expiring soon, or required with no expiry date typed."
      right={<select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Within">{[15, 30, 60, 90, 180].map((d) => <option key={d} value={d}>Within {d} days</option>)}</select>}>
      <Notice tone="red">{err}</Notice>
      {data && <div className="small-muted" style={{ marginBottom: 6 }}>Expired: {data.expired} · expiring: {data.soon} · no expiry typed: {data.missing}</div>}
      {data && <Table rows={data.rows} rowKey={(r, i) => `${r.candidateId}-${i}`} empty="Nothing expires in this window."
        cols={[{ key: 'name', label: 'Person' }, { key: 'what', label: 'Document' }, { key: 'source', label: 'From' }, { key: 'e', label: 'Expires', render: (r) => (r.missing ? <span className="cell-muted">not typed</span> : <span style={r.expired ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{dmy(r.expiresOn)}{r.expired ? ' (expired)' : ''}</span>) }]} />}
    </Section>
  );
}

// Administration -> ATS settings -> Offers & onboarding: the joining checklists
export function ChecklistTemplates() {
  const { data, err, reload } = useLoad('/ats-plus/onboarding/templates');
  const clients = useLoad('/clients');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState(null);
  const clientList = clients.data ? (Array.isArray(clients.data) ? clients.data : clients.data.rows || []) : [];
  const start = (t) => setF(t ? { id: t.id, title: t.title, clientId: t.clientId || '', jobType: t.jobType || '', welcome: t.welcome || '', items: t.items } : { title: '', clientId: '', jobType: '', welcome: '', items: data.defaults });
  const setItem = (i, k, v) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  return (
    <Section title="Joining checklists" note="One checklist per client and / or job type (employment type, hiring type or department). The most specific one is used for a person; with none saved, the built-in checklist is used.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <Table rows={data.rows} empty="No checklist saved yet: the built-in one is used."
        cols={[{ key: 'title', label: 'Checklist' }, { key: 'c', label: 'Client', render: (r) => (clientList.find((c) => c.id === r.clientId) || {}).name || (r.clientId ? r.clientId : 'any') }, { key: 'jobType', label: 'Job type', render: (r) => r.jobType || 'any' }, { key: 'n', label: 'Steps', render: (r) => r.items.length },
          { key: 'e', label: '', render: (r) => data.canEdit && <button type="button" className="btn btn-sm" onClick={() => start(r)}>Edit</button> }]} />}
      {data && data.canEdit && !f && <button type="button" className="btn btn-sm" onClick={() => start(null)}>+ New checklist</button>}
      {f && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <div className="grid-2">
            <Field label="Name"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Client"><select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">Any client</option>{clientList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Job type" hint="e.g. Contract, Full time, IT, Healthcare - empty = any"><input value={f.jobType} onChange={(e) => setF({ ...f, jobType: e.target.value })} /></Field>
            <Field label="Welcome note"><input value={f.welcome} onChange={(e) => setF({ ...f, welcome: e.target.value })} /></Field>
          </div>
          {f.items.map((it, i) => (
            <div key={i} style={{ ...row, marginBottom: 4 }}>
              <input aria-label="Step" style={{ flex: 1, minWidth: 200 }} value={it.label} onChange={(e) => setItem(i, 'label', e.target.value)} />
              <select aria-label="Who" value={it.who} onChange={(e) => setItem(i, 'who', e.target.value)}>{data.who.map((x) => <option key={x}>{x}</option>)}</select>
              <select aria-label="Kind" value={it.type} onChange={(e) => setItem(i, 'type', e.target.value)}><option value="task">Task</option><option value="doc">Upload</option><option value="form">Form</option></select>
              {it.type === 'doc' && <label><input type="checkbox" checked={!!it.expires} onChange={(e) => setItem(i, 'expires', e.target.checked)} /> expires</label>}
              <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <div style={row}>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, items: [...f.items, { label: '', who: 'Candidate', type: 'task' }] })}>+ Step</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => (f.id ? api.put(`/ats-plus/onboarding/templates/${f.id}`, f) : api.post('/ats-plus/onboarding/templates', f)), 'Checklist saved.').then((d) => { if (d) setF(null); })}>Save checklist</button>
            <button type="button" className="btn btn-sm" onClick={() => setF(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="small-muted" style={{ marginTop: 6 }}>Last change: {data && data.rows[0] ? when(data.rows[0].updatedAt) : '—'}</div>
    </Section>
  );
}

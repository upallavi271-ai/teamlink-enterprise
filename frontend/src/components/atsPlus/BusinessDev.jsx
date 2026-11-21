import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import Modal from '../Modal.jsx';
import ClientsTabs from '../clients/ClientsTabs.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, dmy, when, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// ATS -> CLIENTS -> BUSINESS DEVELOPMENT (market benchmark 06.02 / 06.04 / 06.05 / 06.06 / 06.15). The BDE's target companies before
// they are clients: Prospect -> Meeting -> Proposal -> Agreement -> Won / Lost, contacts, notes, the job postings seen (hiring
// signals -> score), an AI pitch, and mail sequences (OFF until an Admin switches them on). Not the CRM.
// Backend: /api/ats-plus/bd/* (utils/atsPlus/bd.js) - a BDE sees their own, a BDE TL / Admin everyone, a Manager reads only.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'pipeline', label: 'Pipeline', hint: 'Target companies by stage, with value and score' },
  { key: 'signals', label: 'Client signals', hint: 'Which existing clients are hiring more, and which went quiet' },
  { key: 'campaigns', label: 'Outreach mails', hint: 'Mail sequences to prospects (OFF until an Admin switches them on)' },
];
const inr = (n) => (n ? `₹${Number(n).toLocaleString('en-IN')}` : '—');
const BAND = { Hot: 'var(--red, #c0392b)', Warm: 'var(--amber, #b7791f)', Cold: 'var(--muted, #6b7280)' };

function AddProspect({ meta, onDone, onClose }) {
  const [f, setF] = useState({ name: '', industry: '', city: '', website: '', value: '', contactName: '', contactEmail: '', contactPhone: '', ownerId: '' });
  const { run, busy, flash } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(() => api.post('/ats-plus/bd/prospects', { name: f.name, industry: f.industry, city: f.city, website: f.website, value: f.value, ownerId: f.ownerId || undefined, contacts: [{ name: f.contactName, email: f.contactEmail, phone: f.contactPhone }] }), 'Added.').then((d) => { if (d) onDone(d); });
  return (
    <Modal title="Add a target company" onClose={onClose}>
      {flash}
      <Field label="Company name"><input value={f.name} onChange={set('name')} /></Field>
      <div className="grid-2">
        <Field label="Industry"><input value={f.industry} onChange={set('industry')} /></Field>
        <Field label="City"><input value={f.city} onChange={set('city')} /></Field>
        <Field label="Website"><input value={f.website} onChange={set('website')} /></Field>
        <Field label="Expected fees (₹)"><input type="number" value={f.value} onChange={set('value')} /></Field>
        <Field label="Hiring contact"><input value={f.contactName} onChange={set('contactName')} placeholder="Name" /></Field>
        <Field label="Contact e-mail"><input value={f.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="Contact phone"><input value={f.contactPhone} onChange={set('contactPhone')} /></Field>
        {meta.all && <Field label="Owner BDE"><select value={f.ownerId} onChange={set('ownerId')}><option value="">Me</option>{meta.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
      </div>
      <div style={row}><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Add</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function ProspectDrawer({ id, meta, onClose, onChanged }) {
  const { data: p, err, reload } = useLoad(`/ats-plus/bd/prospects/${id}`);
  const { run, busy, flash } = useAction(async () => { await reload(); onChanged(); });
  const [note, setNote] = useState('');
  const [post, setPost] = useState({ title: '', openings: 1, source: 'Naukri', postedAt: '' });
  const [stage, setStage] = useState({ stage: '', note: '', clientId: '' });
  const [pitch, setPitch] = useState(null);
  const clients = useLoad(stage.stage === 'WON' ? '/clients' : null);
  const clientList = clients.data ? (Array.isArray(clients.data) ? clients.data : clients.data.rows || clients.data.clients || []) : [];
  const w = meta.canWrite;
  return (
    <Modal title={p ? p.title : 'Prospect'} onClose={onClose} size="wide">
      <Notice tone="red">{err}</Notice>{flash}
      {p && (
        <>
          <div style={row}><b>{p.stageLabel}</b><span className="small-muted">Owner: {p.ownerName || '—'} · value {inr(p.value)}</span>
            <span style={{ color: BAND[p.band], fontWeight: 600 }}>Score {p.score} ({p.band})</span></div>
          <ul className="small-muted" style={{ margin: '6px 0 10px 18px' }}>{p.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {w && (
            <div style={{ ...row, marginBottom: 10 }}>
              <select aria-label="Move to" value={stage.stage} onChange={(e) => setStage({ ...stage, stage: e.target.value })}><option value="">Move to…</option>{meta.stages.filter((s) => s.key !== p.status).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
              {stage.stage === 'WON' && <select aria-label="Client" value={stage.clientId} onChange={(e) => setStage({ ...stage, clientId: e.target.value })}><option value="">Pick the client…</option>{clientList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
              {stage.stage && <input aria-label="Stage note" placeholder={stage.stage === 'LOST' ? 'Why lost (needed)' : 'Note (optional)'} value={stage.note} onChange={(e) => setStage({ ...stage, note: e.target.value })} />}
              {stage.stage && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/ats-plus/bd/prospects/${p.id}/stage`, stage), 'Moved.').then((d) => { if (d) setStage({ stage: '', note: '', clientId: '' }); })}>Move</button>}
            </div>
          )}
          <h4 style={{ margin: '8px 0 4px' }}>Contacts</h4>
          {(p.contacts || []).length ? (p.contacts || []).map((c, i) => <div key={i} className="small-muted">{[c.name, c.role, c.email, c.phone].filter(Boolean).join(' · ')}</div>) : <div className="small-muted">None yet.</div>}
          <h4 style={{ margin: '12px 0 4px' }}>Job postings seen (hiring signals)</h4>
          <Table rows={p.postings || []} rowKey={(r, i) => i} empty="None typed in yet. Add the jobs they post on Naukri, LinkedIn or their careers page."
            cols={[{ key: 'title', label: 'Job' }, { key: 'openings', label: 'Openings' }, { key: 'source', label: 'Where', render: (r) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.source}</a> : r.source) }, { key: 'postedAt', label: 'Posted', render: (r) => dmy(r.postedAt) }]} />
          {w && (
            <div style={{ ...row, margin: '6px 0' }}>
              <input aria-label="Job title" placeholder="Job title" value={post.title} onChange={(e) => setPost({ ...post, title: e.target.value })} />
              <input aria-label="Openings" type="number" min="1" style={{ width: 80 }} value={post.openings} onChange={(e) => setPost({ ...post, openings: e.target.value })} />
              <select aria-label="Where" value={post.source} onChange={(e) => setPost({ ...post, source: e.target.value })}>{['Naukri', 'LinkedIn', 'foundit', 'Shine', 'Indeed', 'Their careers page', 'Newspaper', 'Other'].map((s) => <option key={s}>{s}</option>)}</select>
              <input aria-label="Posted on" type="date" value={post.postedAt} onChange={(e) => setPost({ ...post, postedAt: e.target.value })} />
              <button type="button" className="btn btn-sm" disabled={busy || !post.title} onClick={() => run(() => api.post(`/ats-plus/bd/prospects/${p.id}/postings`, post), 'Posting added; the score is updated.').then((d) => { if (d) setPost({ title: '', openings: 1, source: 'Naukri', postedAt: '' }); })}>Add posting</button>
            </div>
          )}
          <h4 style={{ margin: '12px 0 4px' }}>Notes</h4>
          {(p.notes || []).map((n, i) => <div key={i} style={{ marginBottom: 4 }}><span className="small-muted">{when(n.at)} · {n.by}:</span> {n.text}</div>)}
          {w && <div style={row}><input aria-label="Note" style={{ flex: 1, minWidth: 200 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened, what is next" />
            <button type="button" className="btn btn-sm" disabled={busy || !note} onClick={() => run(() => api.post(`/ats-plus/bd/prospects/${p.id}/notes`, { text: note }), 'Note saved.').then((d) => { if (d) setNote(''); })}>Save note</button></div>}
          <h4 style={{ margin: '12px 0 4px' }}>Pitch</h4>
          <button type="button" className="btn btn-sm" onClick={() => api.get(`/ats-plus/bd/prospects/${p.id}/pitch`).then((r) => setPitch(r.data)).catch(() => setPitch({ pitch: 'Could not write the pitch now.' }))}>Write a pitch</button>
          {pitch && <div className="card" style={{ padding: 10, marginTop: 6, whiteSpace: 'pre-wrap' }}>{pitch.pitch}<div className="small-muted">{pitch.by === 'code' ? (pitch.note || 'Written from the record.') : `Written by ${pitch.by}. Check it before you send.`}</div></div>}
          <h4 style={{ margin: '12px 0 4px' }}>History</h4>
          {(p.history || []).map((h, i) => <div key={i} className="small-muted">{when(h.at)} · {h.by}: {h.from ? `${h.from} → ` : ''}{h.to}{h.note ? ` (${h.note})` : ''}</div>)}
        </>
      )}
    </Modal>
  );
}

function Pipeline({ meta }) {
  const [stage, setStage] = useState(''); const [q, setQ] = useState('');
  const { data, err, reload } = useLoad(`/ats-plus/bd/prospects?${stage ? `stage=${stage}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`);
  const [add, setAdd] = useState(false); const [open, setOpen] = useState(null);
  return (
    <Section title="Business development pipeline" note="Target companies before they become clients. Score = hiring signals (their job postings, our candidates working there, recent talks)."
      right={meta.canWrite && <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdd(true)}>+ Add a target company</button>}>
      <Notice tone="red">{err}</Notice>
      {data && (
        <div style={{ ...row, marginBottom: 10 }}>
          <button type="button" className={`btn btn-sm${!stage ? ' btn-primary' : ''}`} onClick={() => setStage('')}>All</button>
          {data.board.map((b) => <button key={b.key} type="button" className={`btn btn-sm${stage === b.key ? ' btn-primary' : ''}`} onClick={() => setStage(b.key)} title={`Value ${inr(b.value)}`}>{b.label} ({b.count})</button>)}
          <input aria-label="Search prospects" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {data && <Table rows={data.rows} empty="No target companies yet."
        cols={[
          { key: 'title', label: 'Company', render: (r) => <button type="button" className="btn btn-sm" onClick={() => setOpen(r.id)}>{r.title}</button> },
          { key: 'stageLabel', label: 'Stage' }, { key: 'ownerName', label: 'Owner' },
          { key: 'score', label: 'Score', render: (r) => <span style={{ color: BAND[r.band], fontWeight: 600 }} title={r.reasons.join('\n')}>{r.score} {r.band}</span> },
          { key: 'value', label: 'Value', render: (r) => inr(r.value) },
          { key: 'city', label: 'City', render: (r) => r.city || '—' },
          { key: 'client', label: 'Client', render: (r) => (r.clientId ? <Link to={`/clients/${r.clientId}`}>Open client</Link> : '—') },
        ]} />}
      {add && <AddProspect meta={meta} onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(); }} />}
      {open && <ProspectDrawer id={open} meta={meta} onClose={() => setOpen(null)} onChanged={reload} />}
    </Section>
  );
}

function Signals() {
  const { data, err } = useLoad('/ats-plus/bd/signals/clients');
  return (
    <Section title="Hiring signals of existing clients" note={data ? data.note : ''}>
      <Notice tone="red">{err}</Notice>
      {data && <Table rows={data.rows} rowKey={(r) => r.clientId} empty="No client has a signal yet."
        cols={[{ key: 'name', label: 'Client', render: (r) => <Link to={`/clients/${r.clientId}`}>{r.name}</Link> }, { key: 'score', label: 'Score' }, { key: 'trend', label: 'New jobs vs the 3 months before', render: (r) => (r.trend > 0 ? `+${r.trend}` : r.trend) }, { key: 'reasons', label: 'Why', render: (r) => r.reasons.join('; ') }]} />}
    </Section>
  );
}

function Campaigns({ meta }) {
  const { data, err, reload } = useLoad('/ats-plus/bd/campaigns');
  const pros = useLoad('/ats-plus/bd/prospects');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ name: '', startOnStage: '', steps: [{ day: 0, subject: 'Hiring at {{company}}?', body: 'Hi {{name}},\n\nWe help companies like {{company}} hire faster...\n\n{{owner}}' }] });
  const [enrol, setEnrol] = useState({});
  const [dry, setDry] = useState(null);
  const s = data && data.settings;
  return (
    <>
      <Section title="Outreach mails" note="A sequence of mails to the contacts of your prospects: the first on the day they join, the next after the days you set. A prospect that is Won, Lost or asked not to be mailed is skipped.">
        <Notice tone="red">{err}</Notice>{flash}
        {s && <Notice tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? `Sending is ON (at most ${s.dailyLimit} mails a run).` : 'Sending is OFF. Mails are only listed (dry run) until an Admin switches it on.'}</Notice>}
        {meta.canSwitch && s && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.put('/ats-plus/bd/outreach-settings', { enabled: !s.enabled }), s.enabled ? 'Outreach mails are OFF.' : 'Outreach mails are ON.')}>{s.enabled ? 'Switch sending OFF' : 'Switch sending ON'}</button>}{' '}
        <button type="button" className="btn btn-sm" onClick={() => api.post('/ats-plus/bd/campaigns/run', { dryRun: true }).then((r) => setDry(r.data)).catch(() => setDry(null))}>Show what is due now</button>
        {dry && <div className="small-muted" style={{ marginTop: 6 }}>{dry.due.length ? dry.due.map((d) => `${d.company}: "${d.subject}" to ${d.to}`).join(' · ') : 'Nothing is due.'}</div>}
        {data && <Table rows={data.rows}
          cols={[{ key: 'title', label: 'Campaign' }, { key: 'status', label: 'Status' }, { key: 'steps', label: 'Mails', render: (r) => r.steps.map((x) => `day ${x.day}`).join(', ') }, { key: 'enrolledCount', label: 'Prospects' }, { key: 'sent', label: 'Sent' },
            { key: 'start', label: 'Starts on', render: (r) => r.startOnStage || 'by hand' },
            { key: 'a', label: '', render: (r) => meta.canWrite && (
              <span style={row}>
                {r.status !== 'ACTIVE' ? <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/bd/campaigns/${r.id}/status`, { status: 'ACTIVE' }), 'Active.')}>Start</button>
                  : <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/bd/campaigns/${r.id}/status`, { status: 'PAUSED' }), 'Paused.')}>Pause</button>}
                <select aria-label="Add a prospect" value={enrol[r.id] || ''} onChange={(e) => setEnrol({ ...enrol, [r.id]: e.target.value })}><option value="">Add a prospect…</option>{(pros.data ? pros.data.rows : []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
                {enrol[r.id] && <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/ats-plus/bd/campaigns/${r.id}/enrol`, { prospectIds: [enrol[r.id]] }), 'Added to the campaign.')}>Add</button>}
              </span>
            ) }]} />}
      </Section>
      {meta.canWrite && (
        <Section title="New campaign" note="Words in {{ }} are filled in: {{company}}, {{name}} (the contact), {{owner}} (the BDE).">
          <div style={row}>
            <input aria-label="Campaign name" placeholder="Campaign name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <select aria-label="Start on stage" value={f.startOnStage} onChange={(e) => setF({ ...f, startOnStage: e.target.value })}><option value="">Start by hand</option>{meta.stages.filter((x) => !['WON', 'LOST'].includes(x.key)).map((x) => <option key={x.key} value={x.key}>When a prospect reaches {x.label}</option>)}</select>
          </div>
          {f.steps.map((st, i) => (
            <div key={i} className="card" style={{ padding: 8, margin: '6px 0' }}>
              <div style={row}><span>Day</span><input aria-label="Day" type="number" min="0" style={{ width: 70 }} value={st.day} onChange={(e) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, day: e.target.value } : x)) })} />
                <input aria-label="Subject" style={{ flex: 1, minWidth: 200 }} value={st.subject} onChange={(e) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)) })} /></div>
              <textarea aria-label="Mail text" rows={4} style={{ width: '100%', marginTop: 4 }} value={st.body} onChange={(e) => setF({ ...f, steps: f.steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} />
            </div>
          ))}
          <div style={row}>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, steps: [...f.steps, { day: (Number(f.steps[f.steps.length - 1].day) || 0) + 3, subject: 'Following up', body: 'Hi {{name}},\n\n' }] })}>+ Another mail</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.name} onClick={() => run(() => api.post('/ats-plus/bd/campaigns', f), 'Campaign saved as a draft. Start it when ready.')}>Save campaign</button>
          </div>
        </Section>
      )}
    </>
  );
}

export default function BusinessDev() {
  const [tab, setTab] = useState('pipeline');
  const { data: meta, err } = useLoad('/ats-plus/bd/meta');
  return (
    <div>
      <ClientsTabs active="bd" />
      <div className="page-head"><div><h1>Business development</h1><div className="page-sub">Target companies, the pipeline to a signed client, hiring signals and outreach</div></div></div>
      <Notice tone="red">{err}</Notice>
      {meta && <>
        <TabStrip label="Business development" tabs={TABS} value={tab} onChange={setTab} />
        {tab === 'pipeline' && <Pipeline meta={meta} />}
        {tab === 'signals' && <Signals />}
        {tab === 'campaigns' && <Campaigns meta={meta} />}
      </>}
    </div>
  );
}

// ClientDetail: "AI summary & pitch" (06.15)
export function ClientAiSummary({ clientId }) {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [e, setE] = useState('');
  const go = () => { setBusy(true); setE(''); api.get(`/ats-plus/bd/clients/${clientId}/summary`).then((r) => setD(r.data)).catch((x) => setE((x.response && x.response.data && x.response.data.error) || 'Could not write it now.')).finally(() => setBusy(false)); };
  return (
    <div className="card section" style={{ padding: 12, marginTop: 12 }}>
      <div style={row}><b>AI summary &amp; pitch</b><span className="small-muted">From this client&apos;s own record: jobs, profiles shared, interviews, joinings.</span><span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={go}>{busy ? 'Writing…' : d ? 'Write again' : 'Write it'}</button></div>
      <Notice tone="red">{e}</Notice>
      {d && <div style={{ marginTop: 8 }}>
        <div>{d.summary}</div>
        <div className="card" style={{ padding: 10, marginTop: 6, whiteSpace: 'pre-wrap' }}>{d.pitch}</div>
        <div className="small-muted">{d.by === 'code' ? (d.note || 'Written from the record.') : `Written by ${d.by} from the record. Check it before you send.`}</div>
      </div>}
    </div>
  );
}

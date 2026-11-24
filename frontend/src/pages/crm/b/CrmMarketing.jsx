// CRM > Leads > Marketing (CRM wave B, 2026-11-24): segments, nurture journeys, landing pages / web forms, events, campaign results (ROI),
// social posts, the website (chat bubble + visit tracker), ad leads. The rules are on the server (backend/src/crm/b/marketing.js); what
// sends or runs by itself stays OFF until an Admin switches it on (CRM > Dashboard > Settings).
import { useState } from 'react';
import api from '../../../api';
import { useCrm, errOf, dateTimeOf, money, download } from '../crmShared.jsx';
import { SubTabs, useLoad, OffNote, CopyBox, Empty, inHour, localToIso } from './bShared.jsx';

// ---- segments ----------------------------------------------------------------------------------------------------------------
function SegmentForm({ row, onClose, onSaved }) {
  const { me, toast } = useCrm();
  const L = me.lists;
  const [f, setF] = useState(() => ({ name: row ? row.name : '', audience: row ? row.audience : 'leads', filters: row ? { ...row.filters } : { hasEmail: false } }));
  const [pv, setPv] = useState(null);
  const setFl = (k, v) => setF((x) => ({ ...x, filters: { ...x.filters, [k]: v } }));
  const fl = f.filters;
  async function preview() { try { const r = await api.post('/crm/b/segments/preview', { audience: f.audience, filters: f.filters }); setPv(r.data); } catch (e) { toast(errOf(e, 'Could not count.')); } }
  async function save() { try { const r = row ? await api.put(`/crm/b/segments/${row.id}`, f) : await api.post('/crm/b/segments', f); toast(`Saved: ${r.data.count} people today.`); onSaved(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="grid-3">
        <div className="field"><label>Segment name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Hot IT leads in Hyderabad" /></div>
        <div className="field"><label>People</label><select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value, filters: {} })}><option value="leads">Leads</option><option value="contacts">Contacts</option></select></div>
        {f.audience === 'leads' ? (
          <>
            <div className="field"><label>Status</label><select value={fl.status || ''} onChange={(e) => setFl('status', e.target.value)}><option value="">Open leads</option>{L.leadStatuses.map((s) => <option key={s} value={s}>{s}</option>)}<option value="all">All</option></select></div>
            <div className="field"><label>Source</label><select value={fl.source || ''} onChange={(e) => setFl('source', e.target.value)}><option value="">Any</option>{L.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="field"><label>Rating</label><select value={fl.rating || ''} onChange={(e) => setFl('rating', e.target.value)}><option value="">Any</option>{L.ratings.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="field"><label>Campaign / utm_campaign</label><input value={fl.campaign || ''} onChange={(e) => setFl('campaign', e.target.value)} /></div>
          </>
        ) : (
          <>
            <div className="field"><label>Role</label><select value={fl.role || ''} onChange={(e) => setFl('role', e.target.value)}><option value="">Any</option>{L.contactRoles.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="field"><label>Account type</label><select value={fl.accountKind || ''} onChange={(e) => setFl('accountKind', e.target.value)}><option value="">Any</option><option value="Prospect">Prospects</option><option value="Client">Customers</option></select></div>
          </>
        )}
        <div className="field"><label>City</label><input value={fl.city || ''} onChange={(e) => setFl('city', e.target.value)} /></div>
        <div className="field"><label>Industry</label><input value={fl.industry || ''} onChange={(e) => setFl('industry', e.target.value)} /></div>
        <div className="field"><label>Added in the last (days)</label><input type="number" min="1" value={fl.createdDays || ''} onChange={(e) => setFl('createdDays', e.target.value)} /></div>
        <div className="field"><label>Nothing done for (days)</label><input type="number" min="1" value={fl.idleDays || ''} onChange={(e) => setFl('idleDays', e.target.value)} /></div>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" checked={!!fl.hasEmail} onChange={(e) => setFl('hasEmail', e.target.checked)} style={{ width: 'auto' }} /> Has an email</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" checked={!!fl.hasPhone} onChange={(e) => setFl('hasPhone', e.target.checked)} style={{ width: 'auto' }} /> Has a phone</label>
      </div>
      {pv && <div className="small-muted" style={{ marginBottom: 8 }}><b>{pv.count}</b> people today{pv.sample.length ? `: ${pv.sample.slice(0, 5).map((x) => x.company || x.name).join(', ')}…` : ''}</div>}
      <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-sm" onClick={preview}>Count</button><button type="button" className="btn btn-primary btn-sm" disabled={!f.name.trim()} onClick={save}>Save segment</button><button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button></div>
    </div>
  );
}
function Segments() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/segments');
  const [edit, setEdit] = useState(null);
  async function del(s) { if (!window.confirm(`Delete the segment "${s.name}"?`)) return; try { await api.delete(`/crm/b/segments/${s.id}`); reload(); } catch (e) { toast(errOf(e, 'Not deleted.')); } }
  return (
    <>
      <p className="small-muted" style={{ marginTop: 0 }}>A segment is a saved filter: who is in it is worked out again every time it is used, so it keeps itself up to date. Use one in a campaign (People: a segment), a journey or the dialer.</p>
      {me.canEdit && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({})}>+ Segment</button>}
      {edit && <SegmentForm row={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {data && !data.segments.length && <Empty title="No segments yet" />}
      {data && data.segments.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Segment</th><th>People</th><th>Last counted</th><th /></tr></thead>
        <tbody>{data.segments.map((s) => (
          <tr key={s.id}><td><b>{s.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{s.audience} · {Object.entries(s.filters).map(([k, v]) => `${k}: ${v}`).join(', ') || 'all open'}</div></td>
            <td>{s.lastCount}</td><td className="small-muted">{dateTimeOf(s.lastCountAt)}</td>
            <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn btn-sm" onClick={() => setEdit(s)}>Edit</button> {me.rights && me.rights.export && <button type="button" className="btn btn-sm" title="Hashed emails / phones for Google Customer Match or a Meta Custom Audience" onClick={() => download(`/crm/b/segments/${s.id}/audience.csv`, `audience-${s.name}.csv`).catch(() => toast('The download did not work.'))}>Ad audience file</button>} <button type="button" className="btn btn-sm" onClick={() => del(s)}>Delete</button></td></tr>
        ))}</tbody>
      </table></div>}
    </>
  );
}

// ---- journeys ----------------------------------------------------------------------------------------------------------------
function JourneyForm({ row, segments, onClose, onSaved }) {
  const { me, toast } = useCrm();
  const [f, setF] = useState(() => row ? { ...row } : { name: '', trigger: 'new_lead', source: '', segmentId: '', steps: [{ channel: 'email', afterDays: 0, subject: 'Welcome, {first_name}', body: 'Hi {first_name},\n\nThank you for your interest in TeamLink Consultants.\n\nRegards,\n{sender}' }, { channel: 'task', afterDays: 2, body: 'Call {name} at {company}' }] });
  const setStep = (i, k, v) => setF((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  async function save() { try { if (row) await api.put(`/crm/b/journeys/${row.id}`, f); else await api.post('/crm/b/journeys', f); toast('Journey saved (off until you switch it on).'); onSaved(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="grid-3">
        <div className="field"><label>Journey name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>Who goes on it</label><select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}><option value="new_lead">Every new lead</option><option value="segment">The people of a segment</option></select></div>
        {f.trigger === 'new_lead' ? <div className="field"><label>Only leads from</label><select value={f.source || ''} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="">Any source</option>{me.lists.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          : <div className="field"><label>Segment</label><select value={f.segmentId || ''} onChange={(e) => setF({ ...f, segmentId: e.target.value })}><option value="">Pick…</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
      </div>
      {f.steps.map((s, i) => (
        <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b>Step {i + 1}</b>
            <select value={s.channel} onChange={(e) => setStep(i, 'channel', e.target.value)} aria-label="Channel" style={{ width: 'auto' }}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="task">A follow-up for the owner</option></select>
            <span className="small-muted">after</span><input type="number" min="0" value={s.afterDays} onChange={(e) => setStep(i, 'afterDays', e.target.value)} style={{ width: 70 }} aria-label="Days after" /><span className="small-muted">day(s)</span>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setF((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))}>Remove</button>
          </div>
          {s.channel === 'email' && <div className="field"><label>Subject</label><input value={s.subject || ''} onChange={(e) => setStep(i, 'subject', e.target.value)} /></div>}
          <div className="field"><label>{s.channel === 'task' ? 'Follow-up' : 'Message'}</label><textarea rows={s.channel === 'task' ? 1 : 4} value={s.body || ''} onChange={(e) => setStep(i, 'body', e.target.value)} /></div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, steps: [...x.steps, { channel: 'email', afterDays: 3, subject: '', body: '' }] }))}>+ Step</button><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save journey</button><button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button></div>
      <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>A journey stops for a person who replies, opts out, or whose lead is won, lost, converted or junk. Emails carry the unsubscribe and preference links.</div>
    </div>
  );
}
function Journeys() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/journeys');
  const segs = useLoad('/crm/b/segments');
  const [edit, setEdit] = useState(null);
  const [runs, setRuns] = useState(null);
  async function toggle(j) { try { await api.post(`/crm/b/journeys/${j.id}/on`, { on: !j.on }); reload(); } catch (e) { toast(errOf(e, 'Not changed.')); } }
  async function showRuns(j) { try { const r = await api.get(`/crm/b/journeys/${j.id}/runs`); setRuns({ j, rows: r.data.runs }); } catch (e) { toast(errOf(e, 'Could not read.')); } }
  return (
    <>
      {data && <OffNote on={data.switchOn} what="Nurture journeys" />}
      {me.canAssign && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({})}>+ Journey</button>}
      {edit && <JourneyForm row={edit.id ? edit : null} segments={segs.data ? segs.data.segments : []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {data && !data.journeys.length && <Empty title="No journeys yet">A journey sends a few messages days apart to new leads (or a segment) until they reply.</Empty>}
      {(data ? data.journeys : []).map((j) => (
        <div key={j.id} className="card" style={{ padding: 10, marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 200 }}><b>{j.name}</b><div className="small-muted" style={{ fontSize: 12 }}>{j.trigger === 'new_lead' ? `New leads${j.source ? ` from ${j.source}` : ''}` : 'A segment'} · {j.steps.map((s) => `${s.channel} +${s.afterDays}d`).join(' → ')}</div><div className="small-muted" style={{ fontSize: 12 }}>{j.running} on it · {j.finished} finished · {j.stopped} stopped</div></div>
          <span className={`status ${j.on ? 'joined' : 'review'}`}>{j.on ? 'On' : 'Off'}</span>
          {me.canAssign && <button type="button" className="btn btn-sm" onClick={() => toggle(j)}>{j.on ? 'Switch off' : 'Switch on'}</button>}
          {me.canAssign && <button type="button" className="btn btn-sm" onClick={() => setEdit(j)}>Edit</button>}
          <button type="button" className="btn btn-sm" onClick={() => showRuns(j)}>Who is on it</button>
        </div>
      ))}
      {runs && <div className="card" style={{ padding: 10 }}><div style={{ display: 'flex' }}><b style={{ flex: 1 }}>{runs.j.name}</b><button type="button" className="btn btn-sm" onClick={() => setRuns(null)}>Close</button></div>
        <div className="tbl-wrap"><table><thead><tr><th>Who</th><th>Step</th><th>Status</th><th>Next</th></tr></thead><tbody>{runs.rows.map((r) => <tr key={r.id}><td>{r.company || r.recordId}</td><td>{r.step}</td><td>{r.status}</td><td className="small-muted">{r.nextAt ? dateTimeOf(r.nextAt) : (r.log.length ? r.log[r.log.length - 1].note || '' : '')}</td></tr>)}</tbody></table></div></div>}
    </>
  );
}

// ---- landing pages -----------------------------------------------------------------------------------------------------------
function Landings() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/landings');
  const [edit, setEdit] = useState(null);
  async function save() { try { const r = edit.id ? await api.put(`/crm/b/landings/${edit.id}`, edit) : await api.post('/crm/b/landings', edit); toast(`Saved: /p/${r.data.slug}`); setEdit(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  const FIELDS = data ? data.fields : {};
  return (
    <>
      <p className="small-muted" style={{ marginTop: 0 }}>A page with your words and a form, hosted by TeamLink. Every form sent is a lead (source Website, the page as its campaign). Put the web form on any website with the iframe line.</p>
      {me.canAssign && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({ title: '', headline: '', body: '', button: 'Send', fields: ['name', 'company', 'phone', 'email', 'message'], thanks: '', campaign: '', status: 'Live' })}>+ Landing page</button>}
      {edit && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div className="grid-3">
            <div className="field"><label>Title</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
            <div className="field"><label>Web address (after /p/)</label><input value={edit.slug || ''} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} placeholder="made from the title" /></div>
            <div className="field"><label>Status</label><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="Live">Live</option><option value="Draft">Draft (not shown)</option></select></div>
          </div>
          <div className="field"><label>Headline</label><input value={edit.headline || ''} onChange={(e) => setEdit({ ...edit, headline: e.target.value })} /></div>
          <div className="field"><label>Words (a blank line starts a new paragraph)</label><textarea rows={5} value={edit.body || ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
          <div className="field"><label>Form fields</label><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{Object.entries(FIELDS).map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" style={{ width: 'auto' }} checked={(edit.fields || []).includes(k)} onChange={(e) => setEdit({ ...edit, fields: e.target.checked ? [...(edit.fields || []), k] : (edit.fields || []).filter((x) => x !== k) })} />{l}</label>)}</div></div>
          <div className="grid-3">
            <div className="field"><label>Button</label><input value={edit.button || ''} onChange={(e) => setEdit({ ...edit, button: e.target.value })} /></div>
            <div className="field"><label>Thank-you words</label><input value={edit.thanks || ''} onChange={(e) => setEdit({ ...edit, thanks: e.target.value })} /></div>
            <div className="field"><label>Campaign code (utm_campaign)</label><input value={edit.campaign || ''} onChange={(e) => setEdit({ ...edit, campaign: e.target.value })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save page</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      {data && !data.pages.length && <Empty title="No landing pages yet" />}
      {(data ? data.pages : []).map((p) => (
        <div key={p.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ flex: 1 }}>{p.title}</b><span className={`status ${p.status === 'Live' ? 'joined' : 'review'}`}>{p.status}</span><span className="small-muted">{p.views} views · {p.submits} forms sent</span>
            <a className="btn btn-sm" href={`${data.base}${p.slug}`} target="_blank" rel="noopener noreferrer">Open</a>
            {me.canAssign && <button type="button" className="btn btn-sm" onClick={() => setEdit({ ...p, fields: JSON.parse(p.fieldsJson || '[]') })}>Edit</button>}
          </div>
          <CopyBox label="Put the form on another website" value={`<iframe src="${data.base}${p.slug}?embed=1" style="width:100%;max-width:520px;height:640px;border:0" title="${p.title}"></iframe>`} />
        </div>
      ))}
    </>
  );
}

// ---- events ------------------------------------------------------------------------------------------------------------------
function Events() {
  const { me, toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/events');
  const [edit, setEdit] = useState(null);
  const [regs, setRegs] = useState(null);
  async function save() { try { await api[edit.id ? 'put' : 'post'](edit.id ? `/crm/b/events/${edit.id}` : '/crm/b/events', { ...edit, startsAt: localToIso(edit.startsLocal) || edit.startsAt, endsAt: edit.endsLocal ? localToIso(edit.endsLocal) : edit.endsAt }); toast('Event saved.'); setEdit(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  async function openRegs(ev) { try { const r = await api.get(`/crm/b/events/${ev.id}/registrations`); setRegs(r.data); } catch (e) { toast(errOf(e, 'Could not read.')); } }
  async function mark(r, status) { try { await api.post(`/crm/b/event-regs/${r.id}`, { status }); openRegs(regs.event); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  return (
    <>
      {me.canAssign && !edit && <button type="button" className="btn btn-primary btn-sm" style={{ marginBottom: 10 }} onClick={() => setEdit({ title: '', kind: 'Webinar', startsLocal: inHour(), place: '', link: '', capacity: '', description: '' })}>+ Event / webinar</button>}
      {edit && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div className="grid-3">
            <div className="field"><label>Name</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
            <div className="field"><label>Kind</label><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{['Webinar', 'Event', 'Workshop', 'Meetup'].map((k) => <option key={k}>{k}</option>)}</select></div>
            <div className="field"><label>Starts</label><input type="datetime-local" value={edit.startsLocal || ''} onChange={(e) => setEdit({ ...edit, startsLocal: e.target.value })} /></div>
            <div className="field"><label>Place</label><input value={edit.place || ''} onChange={(e) => setEdit({ ...edit, place: e.target.value })} placeholder="Online / the venue" /></div>
            <div className="field"><label>Meeting link</label><input value={edit.link || ''} onChange={(e) => setEdit({ ...edit, link: e.target.value })} placeholder="https://" /></div>
            <div className="field"><label>Seats (blank = no limit)</label><input type="number" min="0" value={edit.capacity || ''} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></div>
          </div>
          <div className="field"><label>About it</label><textarea rows={4} value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      {data && !data.events.length && <Empty title="No events yet">Each event gets a public registration page; a registration is a lead (source Event).</Empty>}
      {(data ? data.events : []).map((ev) => (
        <div key={ev.id} className="card" style={{ padding: 10, marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 200 }}><b>{ev.title}</b> <span className="small-muted">· {ev.kind} · {dateTimeOf(ev.startsAt)}</span><div className="small-muted" style={{ fontSize: 12 }}>{ev.registered} registered · {ev.attended} attended{ev.capacity ? ` · ${ev.capacity} seats` : ''}</div></div>
          <a className="btn btn-sm" href={`${data.base}${ev.slug}`} target="_blank" rel="noopener noreferrer">Registration page</a>
          <button type="button" className="btn btn-sm" onClick={() => openRegs(ev)}>Registrations</button>
        </div>
      ))}
      {regs && <div className="card" style={{ padding: 10 }}><div style={{ display: 'flex' }}><b style={{ flex: 1 }}>{regs.event.title}</b><button type="button" className="btn btn-sm" onClick={() => setRegs(null)}>Close</button></div>
        <div className="tbl-wrap"><table><thead><tr><th>Name</th><th>Company</th><th>Email / phone</th><th>Status</th><th /></tr></thead><tbody>{regs.registrations.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.company}</td><td className="small-muted">{[r.email, r.phone].filter(Boolean).join(' · ')}</td><td>{r.status}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{me.canEdit && ['Attended', 'No-show'].map((s) => <button key={s} type="button" className="btn btn-sm" style={{ marginRight: 4 }} onClick={() => mark(r, s)}>{s}</button>)}</td></tr>)}</tbody></table></div></div>}
    </>
  );
}

// ---- campaign results --------------------------------------------------------------------------------------------------------
function Roi() {
  const { toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/roi');
  const [edit, setEdit] = useState(null);
  async function save() { try { await api.put(`/crm/b/campaign-meta/${edit.id}`, edit); toast('Saved.'); setEdit(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  return (
    <>
      <p className="small-muted" style={{ marginTop: 0 }}>What each campaign brought: the leads that came with its code (utm_campaign in your links or ads, or its landing page), the people it reached who were won later, the money won against what it cost. Opens and clicks show while email tracking is on.</p>
      {data && !data.campaigns.length && <Empty title="No campaigns yet">Make one in Leads → Campaigns.</Empty>}
      {data && data.campaigns.length > 0 && <div className="tbl-wrap"><table>
        <thead><tr><th>Campaign</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Leads it brought</th><th>Won</th><th>Value won</th><th>Cost</th><th>Return</th><th /></tr></thead>
        <tbody>{data.campaigns.map((c) => (
          <tr key={c.id}>
            <td><b>{c.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{c.channel} · {c.status}{c.code ? ` · code ${c.code}` : ''}{c.topic ? ` · topic ${c.topic}` : ''}</div></td>
            <td>{c.sent}</td><td>{c.tracked ? c.opened : '—'}</td><td>{c.tracked ? c.clicked : '—'}</td><td>{c.leads}</td><td>{c.wonDeals}</td><td>{money(c.wonValue)}</td><td>{c.cost == null ? '—' : money(c.cost)}</td>
            <td>{c.roiPercent == null ? '—' : <b style={{ color: c.roiPercent >= 0 ? 'var(--green, #16a34a)' : 'var(--red)' }}>{c.roiPercent}%</b>}</td>
            <td>{data.canEdit && <button type="button" className="btn btn-sm" onClick={() => setEdit({ id: c.id, cost: c.cost == null ? '' : c.cost, code: c.code || '', topic: c.topic || '' })}>Cost / code</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>}
      {edit && <div className="card" style={{ padding: 12, marginTop: 10 }}><div className="grid-3">
        <div className="field"><label>What it cost (₹)</label><input type="number" min="0" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} /></div>
        <div className="field"><label>Code (utm_campaign)</label><input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} placeholder="nov-it-mailer" /></div>
        <div className="field"><label>Topic (preference centre)</label><select value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })}><option value="">None</option>{data.topics.map((t) => <option key={t}>{t}</option>)}</select></div>
      </div><div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button><button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button></div></div>}
    </>
  );
}

// ---- social ------------------------------------------------------------------------------------------------------------------
function Social() {
  const { toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/social');
  const [f, setF] = useState({ channel: 'facebook', text: '', link: '', when: '' });
  async function save() { try { await api.post('/crm/b/social', { channel: f.channel, text: f.text, link: f.link, postAt: f.when ? localToIso(f.when) : undefined }); toast(f.when ? 'Scheduled.' : 'Saved as a draft.'); setF({ ...f, text: '', link: '', when: '' }); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  async function post(p) { if (!window.confirm(`Post this on ${p.channel} now?`)) return; try { const r = await api.post(`/crm/b/social/${p.id}/post`); toast(r.data.sandbox ? 'Test server: marked posted, nothing really went out.' : 'Posted.'); reload(); } catch (e) { toast(errOf(e, 'Not posted.')); reload(); } }
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <>
      <div className="small-muted" style={{ marginBottom: 8 }}>Company accounts (Administration → Integrations → Social Media): Facebook Page <b>{data.accounts.facebook || 'not connected'}</b> · LinkedIn <b>{data.accounts.linkedin || 'not connected'}</b>. "Post now" is pressed by a person; a scheduled post goes by itself only while "Social posts" is switched on.</div>
      {data.canPost && <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="grid-3">
          <div className="field"><label>Where</label><select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="facebook">Facebook Page</option><option value="linkedin">LinkedIn</option></select></div>
          <div className="field"><label>Link (optional)</label><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://" /></div>
          <div className="field"><label>Post at (blank = draft)</label><input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></div>
        </div>
        <div className="field"><label>The post</label><textarea rows={4} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!f.text.trim()} onClick={save}>Save</button>
      </div>}
      {!data.posts.length && <Empty title="No posts yet" />}
      {data.posts.map((p) => (
        <div key={p.id} className="card" style={{ padding: 10, marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 200 }}><span className="small-muted">{p.channel} · {p.status}{p.postAt && p.status === 'Scheduled' ? ` for ${dateTimeOf(p.postAt)}` : ''}{p.postedAt ? ` · ${dateTimeOf(p.postedAt)}` : ''}</span><div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{p.text}</div>{p.error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{p.error}</div>}</div>
          {data.canPost && p.status !== 'Posted' && <button type="button" className="btn btn-sm" onClick={() => post(p)}>Post now</button>}
        </div>
      ))}
    </>
  );
}

// ---- the website: chat bubble, visit tracker ---------------------------------------------------------------------------------
function Website() {
  const { data } = useLoad('/crm/b/settings');
  if (!data) return <div className="small-muted">Loading…</div>;
  if (!data.snippets) return <div className="small-muted">A Sales manager puts the chat bubble and the visit tracker on the website.</div>;
  return (
    <>
      <OffNote on={data.switches.chatWidget} what="Website chat" />
      <CopyBox label="Chat bubble: paste before </body> on every page of the company website" value={data.snippets.chat} />
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 12 }}>Visitors write in the bubble; the team answers in Follow-ups → Inbox → Website chat. A visitor who gives a phone or email becomes a lead.</div>
      <OffNote on={data.switches.webTracking} what="Website visit tracking" />
      <CopyBox label="Visit tracker: paste before </body> on every page" value={data.snippets.tracking} />
      <div className="small-muted" style={{ fontSize: 12 }}>Records the pages a visitor opens. When the visitor fills a form, chats or gives their email, their pages show on the lead (Web &amp; engagement). Tell visitors in the website's privacy notice.</div>
    </>
  );
}
function Ads() {
  const { data } = useLoad('/crm/b/settings');
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <>
      <OffNote on={data.switches.adsLeads} what="Ad leads" />
      <p className="small-muted" style={{ marginTop: 0 }}>Leads from Facebook / Instagram lead ads and Google Ads lead forms come in by themselves (source Other, utm_source facebook-ads / google-ads). The keys go in Administration → Integrations → CRM ad leads.</p>
      {data.snippets ? (
        <>
          <CopyBox label="Facebook: the webhook address (Meta app > Webhooks > Page > leadgen)" value={data.snippets.metaAds} rows={1} />
          <CopyBox label="Google Ads: lead form > Webhook URL (and the key you typed in Integrations)" value={data.snippets.googleAds} rows={1} />
          <div className="small-muted" style={{ fontSize: 12 }}>To show ads to people like your customers, download a segment as an "Ad audience file" (Segments) and upload it to Google Customer Match or a Meta Custom Audience. It holds only hashed emails / phones.</div>
        </>
      ) : <div className="small-muted">A Sales manager sets this up.</div>}
    </>
  );
}

export default function CrmMarketing() {
  const [tab, setTab] = useState('segments');
  return (
    <div>
      <SubTabs value={tab} onChange={setTab} tabs={[['segments', 'Segments'], ['journeys', 'Journeys'], ['landing', 'Landing pages'], ['events', 'Events'], ['roi', 'Campaign results'], ['social', 'Social'], ['website', 'Website'], ['ads', 'Ad leads']]} />
      {tab === 'segments' && <Segments />}
      {tab === 'journeys' && <Journeys />}
      {tab === 'landing' && <Landings />}
      {tab === 'events' && <Events />}
      {tab === 'roi' && <Roi />}
      {tab === 'social' && <Social />}
      {tab === 'website' && <Website />}
      {tab === 'ads' && <Ads />}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import { Notice, Section, Table, useLoad, useAction, row, when } from '../kit.jsx';

// ---------------------------------------------------------------------------
// ATS settings -> Integrations -> Google / Microsoft 365 (07.01 / 14.05, ATS wave 2 Z). Under the app details: whether the founder's
// Google / Microsoft apps are ready, MY calendar connection (Connect / Disconnect), the switch that makes bookings follow in the calendars,
// the redirect addresses to register in the apps, and the contacts picker (a Google / Outlook contact becomes a client's contact).
// Backend: utils/atsPlus/calendarZ.js, utils/mkt/interviews.js.
// ---------------------------------------------------------------------------
export function MyCalendarsZ() {
  const { data, err, reload } = useLoad('/ats-plus/calendarz/overview');
  const { run, busy, flash } = useAction(reload);
  if (!data) return <Notice tone="red">{err}</Notice>;
  return (
    <Section title="Calendars" note="Each interviewer connects their own Google or Outlook calendar. While the switch is ON, a booked interview goes into the calendars of its recruiter and panel, a new time moves it there and a cancelled one is taken out. Their busy times are used when TeamLink suggests interview slots.">
      <Notice tone="red">{err}</Notice>{flash}
      <div className="small-muted" data-testid="calendar-switch">Follow the bookings: <b>{data.pushSwitch ? 'ON' : 'OFF'}</b> {data.canEdit && <Link to={data.switchLink}>(change in Step timing and alerts &gt; Add-on switches)</Link>}</div>
      <Table rows={Object.entries(data.connections).map(([k, c]) => ({ id: k, ...c, app: data.apps[k] }))}
        cols={[{ key: 'label', label: 'Calendar' }, { key: 'app', label: 'Company app', render: (r) => (r.app.ready ? 'Ready' : <span>Not set up {data.canEdit ? <Link to={data.setUpLink}>Set up</Link> : '(ask an Admin)'} - needs founder credentials</span>) },
          { key: 'connected', label: 'Mine', render: (r) => (r.connected ? `Connected${r.account ? ` (${r.account})` : ''}${r.lastPushAt ? ` · last put in ${when(r.lastPushAt)}` : ''}` : 'Not connected') },
          { key: 'x', label: '', render: (r) => (r.connected
            ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.delete(`/ats/mkt/calendar/${r.id}`), 'Disconnected.')}>Disconnect</button>
            : <button type="button" className="btn btn-sm btn-primary" disabled={busy || !r.app.ready} onClick={() => run(async () => { const x = await api.post(`/ats/mkt/calendar/${r.id}/connect`, {}); window.location.href = x.data.url; return x; }, 'Opening the sign-in…')}>Connect</button>) },
          { key: 'lastError', label: 'Problem', render: (r) => r.lastError || '—' }]} />
      {data.canEdit && <div className="small-muted" style={{ marginTop: 6 }}>Redirect addresses to add to the apps: Google <code>{data.redirect.google}</code> · Microsoft <code>{data.redirect.microsoft}</code></div>}
    </Section>
  );
}

export function ContactsZ() {
  const [provider, setProvider] = useState('google');
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [pick, setPick] = useState(null);
  const [client, setClient] = useState({ id: '', slot: 'primary' });
  const clients = useLoad('/ats-plus/calendarz/clients');
  const { run, busy, flash } = useAction(null);
  return (
    <Section title="Contacts" note="Find a person in your own Google or Outlook contacts and make them a client's contact (the client's own edit rules apply). Nothing is copied until you press Use.">
      {flash}
      <div style={row}>
        <select aria-label="Contacts from" value={provider} onChange={(e) => setProvider(e.target.value)}><option value="google">Google contacts</option><option value="microsoft">Outlook contacts</option></select>
        <input aria-label="Find a contact" placeholder="Name, e-mail or company" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api.get('/ats-plus/calendarz/contacts', { params: { provider, q } }); setList(r.data.contacts); return r; }, (d) => `${d.contacts.length} found.`)}>Find</button>
      </div>
      {list && <Table rows={list} rowKey={(r, i) => `${r.email}-${i}`} empty="Nobody found."
        cols={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'E-mail' }, { key: 'phone', label: 'Phone' }, { key: 'company', label: 'Company' }, { key: 'x', label: '', render: (r) => <button type="button" className="btn btn-sm" onClick={() => setPick(r)}>Use</button> }]} />}
      {pick && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <b>{pick.name || pick.email}</b>
          <div style={{ ...row, marginTop: 6 }}>
            <select aria-label="Client" value={client.id} onChange={(e) => setClient({ ...client, id: e.target.value })}><option value="">Pick a client</option>{((clients.data && clients.data.clients) || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select aria-label="As" value={client.slot} onChange={(e) => setClient({ ...client, slot: e.target.value })}><option value="primary">Main contact</option><option value="secondary">Second contact</option></select>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !client.id} onClick={() => run(() => api.post('/ats-plus/calendarz/contacts/use', { provider, clientId: client.id, slot: client.slot, contact: pick }), 'Saved on the client.').then((d) => { if (d) setPick(null); })}>Save on the client</button>
          </div>
        </div>
      )}
    </Section>
  );
}

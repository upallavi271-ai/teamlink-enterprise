// CRM > ACCOUNTS & CONTACTS (2026-11-02): the companies we sell to - prospects, and customers (an account with a won deal) -
// and the people at them. An account opens with its contacts, deals, timeline and follow-ups. The CRM stands alone (2026-11-11):
// nothing comes from ATS clients.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, dateOf, moneyShort, istToday, Pill, RecordForm, download } from './crmShared.jsx';
import MultiSelect from '../../components/ats/MultiSelect.jsx'; // checkboxes: several values per filter (founder 2026-11-20)
import { TicketList } from './CrmSupport.jsx';
import CrmContactDialog from './CrmContact.jsx';
import { ListFilterStrip, useListXf } from '../../components/ats/ListFilters.jsx';
import { plusOf } from './CrmPlus.jsx'; // territories (wave D)


export default function CrmAccounts() {
  const { me, toast } = useCrm();
  const [sp] = useSearchParams();
  const { openRecord, version } = useCrm();
  const setOpen = (o) => openRecord(o.kind, o.id);
  const [tab, setTab] = useState(['contacts', 'tickets'].includes(sp.get('tab')) ? sp.get('tab') : 'accounts');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [owner, setOwner] = useState('');
  const [adding, setAdding] = useState(null); // 'account' | 'contact' | 'client'
  const [editContact, setEditContact] = useState(null);
  const [reach, setReach] = useState(null); // a contact's phone or email clicked: the Call / Email window ({ record, channel })
  // wave D: the territory filter, and many accounts / contacts given to another salesperson at once (Sales manager / Admin)
  const [territory, setTerritory] = useState('');
  const [picked, setPicked] = useState([]);
  const [giveTo, setGiveTo] = useState('');
  const territories = plusOf(me).territories || [];
  useEffect(() => { setPicked([]); }, [tab]);
  async function give() {
    try { const r = await api.post('/crm/plus/bulk-owner', { kind: tab === 'accounts' ? 'account' : 'contact', ids: picked, ownerId: giveTo }); toast(`${r.data.changed} given${r.data.failed.length ? `, ${r.data.failed.length} not` : ''}.`); setPicked([]); load(); } catch (e) { toast(errOf(e, 'They could not be given.')); }
  }
  const tick = (id, on) => setPicked((x) => (on ? [...new Set([...x, id])] : x.filter((y) => y !== id)));
  const xf = useListXf(tab === 'contacts' ? 'crmcontacts' : 'crmaccounts'); // added-on, city, industry, source / role (components/ats/ListFilters.jsx)
  const load = () => {
    if (tab === 'tickets') return Promise.resolve();
    setRows(null);
    const params = tab === 'accounts' ? { q: q || undefined, kind: kind || undefined, owner: owner || undefined, ...xf.params } : { q: q || undefined, ...xf.params };
    return api.get(`/crm/${tab}`, { params }).then((r) => { setRows(r.data.rows); setErr(''); }).catch((e) => setErr(errOf(e, 'This list could not be read.')));
  };
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [tab, q, kind, owner, version, xf.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Accounts &amp; Contacts</h1><div className="page-sub">The companies we sell to and the people we talk to</div></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {me.rights && me.rights.export && <button type="button" className="btn" onClick={() => download(`/crm/export/${tab === 'tickets' ? 'accounts' : tab}?${new URLSearchParams(Object.entries({ q, kind, owner, ...xf.params }).filter(([, v]) => v))}`, `crm-${tab === 'tickets' ? 'accounts' : tab}-${istToday()}.csv`).catch(() => toast('The download did not work.'))}>Download</button>}
          {me.canCreate && (<>
            <button type="button" className="btn" onClick={() => setAdding('contact')}>+ Contact</button>
            <button type="button" className="btn btn-primary" onClick={() => setAdding('account')}>+ Account</button>
          </>)}
        </div>
      </div>
      <div className="tabs" role="tablist">
        <div role="tab" tabIndex={0} aria-selected={tab === 'accounts'} className={`tab${tab === 'accounts' ? ' active' : ''}`} onClick={() => setTab('accounts')} onKeyDown={(e) => { if (e.key === 'Enter') setTab('accounts'); }}>Accounts</div>
        <div role="tab" tabIndex={0} aria-selected={tab === 'contacts'} className={`tab${tab === 'contacts' ? ' active' : ''}`} onClick={() => setTab('contacts')} onKeyDown={(e) => { if (e.key === 'Enter') setTab('contacts'); }}>Contacts</div>
        <div role="tab" tabIndex={0} aria-selected={tab === 'tickets'} className={`tab${tab === 'tickets' ? ' active' : ''}`} onClick={() => setTab('tickets')} onKeyDown={(e) => { if (e.key === 'Enter') setTab('tickets'); }}>Support tickets</div>
      </div>
      {tab === 'tickets' && <TicketList />}
      {tab !== 'tickets' && (<>
      <ListFilterStrip key={tab} list={tab === 'contacts' ? 'crmcontacts' : 'crmaccounts'} xf={xf} total={rows ? rows.length : null} noun={tab} allTime={Object.keys(xf.values).length > 0 || !!(q || kind || owner)} />
      <div className="filter-row">
        <input type="text" placeholder={tab === 'accounts' ? 'Search company, city, industry' : 'Search name, phone, email, company'} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} aria-label="Search" />
        {tab === 'accounts' && <MultiSelect label="Type" allLabel="Prospects and customers" value={kind} onChange={setKind} options={[{ value: 'Prospect', label: 'Prospects' }, { value: 'Client', label: 'Customers' }]} />}
        {tab === 'accounts' && me.seesAll && <MultiSelect label="Owner" allLabel="Everyone" value={owner} onChange={setOwner} options={me.owners.map((o) => ({ value: o.id, label: o.name }))} />}
        {tab === 'accounts' && territories.length > 0 && <select value={territory} onChange={(e) => setTerritory(e.target.value)} style={{ width: 'auto' }} aria-label="Territory"><option value="">Every territory</option>{territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="none">No territory</option></select>}
      </div>
      {me.canAssign && picked.length > 0 && (
        <div className="card" style={{ padding: 10, marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{picked.length} ticked</b> <span className="small-muted">give to</span>
          <select value={giveTo} onChange={(e) => setGiveTo(e.target.value)} style={{ width: 'auto' }} aria-label="Give to"><option value="">Pick a salesperson…</option>{me.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <button type="button" className="btn btn-sm btn-primary" disabled={!giveTo} onClick={give}>Give</button>
          <button type="button" className="btn btn-sm" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
      {err && <div className="notice" role="alert">{err}</div>}
      <div className="tbl-wrap">
        {tab === 'accounts' ? (
          <table>
            <thead><tr>{me.canAssign && <th aria-label="Tick" />}<th>Company</th><th>Type</th><th>Contacts</th><th>Open deals</th><th>Last touched</th>{me.seesAll && <th>Owner</th>}</tr></thead>
            <tbody>
              {rows == null && !err && <tr><td colSpan={6} className="small-muted">Loading…</td></tr>}
              {rows && !rows.length && <tr><td colSpan={6}><div className="empty"><h3>No accounts here</h3>Convert a lead or add an account.</div></td></tr>}
              {(rows || []).filter((a) => !territory || (territory === 'none' ? !a.territoryId : a.territoryId === territory)).map((a) => (
                <tr key={a.id} className="row-link" onClick={() => setOpen({ kind: 'account', id: a.id })}>
                  {me.canAssign && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(a.id)} onChange={(e) => tick(a.id, e.target.checked)} aria-label={`Tick ${a.name}`} /></td>}
                  <td><b>{a.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{[a.industry, a.city].filter(Boolean).join(' · ')}</div></td>
                  <td><Pill v={a.kind} /></td>
                  <td>{a.contacts}</td>
                  <td>{a.openDeals ? `${a.openDeals} · ${moneyShort(a.openValue)}` : '—'}</td>
                  <td className="small-muted">{a.lastActivityAt ? dateOf(a.lastActivityAt) : 'Never'}</td>
                  {me.seesAll && <td>{a.ownerName || '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead><tr>{me.canAssign && <th aria-label="Tick" />}<th>Name</th><th>Company</th><th>Role</th><th>Phone</th><th>Email</th></tr></thead>
            <tbody>
              {rows == null && !err && <tr><td colSpan={5} className="small-muted">Loading…</td></tr>}
              {rows && !rows.length && <tr><td colSpan={5}><div className="empty"><h3>No contacts here</h3>Add the people you talk to at each company.</div></td></tr>}
              {(rows || []).map((c) => (
                <tr key={c.id} className="row-link" onClick={() => (c.accountId ? setOpen({ kind: 'account', id: c.accountId }) : setEditContact(c))}>
                  {me.canAssign && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(c.id)} onChange={(e) => tick(c.id, e.target.checked)} aria-label={`Tick ${c.name}`} /></td>}
                  <td><b>{c.name}</b><div className="small-muted" style={{ fontSize: 11.5 }}>{c.designation || ''}</div></td>
                  <td>{c.accountName || '—'}</td>
                  <td>{c.role || '—'}</td>
                  <td>{c.phone ? <a href={`tel:${c.phone}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReach({ record: { kind: 'contact', id: c.id, name: c.name }, channel: 'Call' }); }}>{c.phone}</a> : '—'}</td>
                  <td>{c.email ? <a href={`mailto:${c.email}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReach({ record: { kind: 'contact', id: c.id, name: c.name }, channel: 'Email' }); }}>{c.email}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>)}
      {(adding === 'account' || adding === 'contact') && <RecordForm kind={adding} onClose={() => setAdding(null)} onSaved={(row) => { const k = adding; setAdding(null); if (k === 'account') { setTab('accounts'); load(); setOpen({ kind: 'account', id: row.id }); } else { setTab('contacts'); load(); } }} />}
      {reach && <CrmContactDialog record={reach.record} channel={reach.channel} onClose={() => setReach(null)} onDone={load} />}
      {editContact && <RecordForm kind="contact" row={editContact} onClose={() => setEditContact(null)} onSaved={() => { setEditContact(null); load(); }} />}
    </div>
  );
}

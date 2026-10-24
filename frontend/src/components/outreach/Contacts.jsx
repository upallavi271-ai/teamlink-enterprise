import { useCallback, useEffect, useState } from 'react';
import api, { viewAsToken, actAsMode } from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import MultiPick from '../MultiPick.jsx';
import ImportWizard from './ImportWizard.jsx';
import Groups from './Groups.jsx';
import ImportHistory from './ImportHistory.jsx';
import Templates from './Templates.jsx';

const CH = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
const OPT = { opted_in: 'Allowed', opted_out: 'Opted out', unknown: 'Not confirmed' };
const when = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function Pills({ channels }) {
  if (!channels.length) return <span className="oc-note">No address</span>;
  return channels.map((c) => <span key={c.channel} className={`oc-pill ${c.optIn === 'opted_in' ? 'in' : (c.optIn === 'opted_out' ? 'out' : '')}`} title={`${CH[c.channel]}: ${OPT[c.optIn]}`}>{CH[c.channel]}: {OPT[c.optIn]}</span>);
}

// ---------------------------------------------------------------- one person
function Detail({ id, acc, type, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [tl, setTl] = useState(null); // 360 audit: what happened with this person (messages, permission changes)
  useEffect(() => { api.get(`/outreach/contacts/${id}/timeline`).then((r) => setTl(r.data.items)).catch(() => setTl([])); }, [id]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState('');
  const [kinds, setKinds] = useState(null);
  const load = useCallback(() => api.get(`/outreach/contacts/${id}`).then((r) => { setD(r.data); setKinds(r.data.contact.industries); }).catch((e) => setErr(e.response?.data?.error || 'Could not open this person.')), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (path, body, okText) => {
    setErr(''); setMsg('');
    try { const r = await api.post(`/outreach/contacts/${id}/${path}`, body); setMsg(r.data.ok || okText); setReason(''); await load(); onChanged(); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); }
  };
  const erase = async () => {
    if (!window.confirm('Remove this person for good? Their details are wiped. Only a do-not-contact marker stays so they are never messaged again.')) return;
    try { await api.delete(`/outreach/contacts/${id}`, { params: { reason: reason || 'Removed at their request' } }); onChanged(); onClose(); } catch (e) { setErr(e.response?.data?.error || 'It could not be removed.'); }
  };
  const saveKinds = async (next) => { setKinds(next); try { await api.put(`/outreach/contacts/${id}/industries`, { industries: next }); setMsg('Kinds saved.'); onChanged(); } catch (e) { setErr(e.response?.data?.error || 'Not saved.'); } };
  if (!d) return <Modal title="Contact" size="wide" onClose={onClose}><div className="oc-note">{err || 'Loading…'}</div></Modal>;
  const c = d.contact;
  const canWrite = type === 'internal' ? acc.canImportInternal : acc.canImport;
  return (
    <Modal title={c.name || 'Contact'} size="wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="oc-row2"><b>{c.phone || 'No phone'}</b><span>{c.email || 'No email'}</span><span className="oc-note">{[c.company, c.city].filter(Boolean).join(' · ')}</span></div>
      <div className="oc-note">{c.source ? `From: ${c.source}. ` : ''}Added {when(c.createdAt)}. {c.consentSource ? `Permission recorded ${when(c.consentAt)}.` : 'No permission recorded.'}{c.unsubscribedAt ? ` Unsubscribed ${when(c.unsubscribedAt)}.` : ''}</div>
      <h4 style={{ margin: '14px 0 6px' }}>{type === 'internal' ? 'Kinds' : 'Industry'}</h4>
      <MultiPick options={acc.industries.map((i) => ({ value: i.name, label: i.name }))} value={kinds || []} onChange={saveKinds} disabled={!canWrite} placeholder={type === 'internal' ? 'No kind yet' : 'No industry yet'} />
      <h4 style={{ margin: '14px 0 6px' }}>Who may message them</h4>
      <div className="oc-scroll"><table className="oc-table"><thead><tr><th>Channel</th><th>Now</th><th>Why</th><th /></tr></thead><tbody>
        {c.channels.map((ch) => (
          <tr key={ch.channel}><td>{CH[ch.channel]}</td><td><span className={`oc-pill ${ch.optIn === 'opted_in' ? 'in' : (ch.optIn === 'opted_out' ? 'out' : '')}`}>{OPT[ch.optIn]}</span>{ch.health !== 'ok' && <span className="oc-pill out">Address problem</span>}</td><td className="oc-note">{ch.optOutWords || ''}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {acc.canOptOut && ch.optIn !== 'opted_out' && <button type="button" className="btn btn-sm" disabled={reason.trim().length < 5} onClick={() => act('opt-out', { channel: ch.channel, reason }, 'Opted out.')}>Opt out</button>}
              {acc.canOptIn && ch.optIn !== 'opted_in' && <button type="button" className="btn btn-sm" disabled={reason.trim().length < 5} onClick={() => act('opt-in', { channel: ch.channel, reason }, 'Allowed.')}>{ch.optIn === 'opted_out' ? 'Opt in again' : 'Record permission'}</button>}
            </td></tr>
        ))}
      </tbody></table></div>
      {(acc.canOptOut || acc.canOptIn) && (
        <label className="field" style={{ display: 'block', marginTop: 8 }}><span>Why? (a few words, saved in the history)</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Asked us on the phone to stop" /></label>
      )}
      {!acc.canOptOut && <div className="oc-note">Your login can look but not change who is opted out.</div>}
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {d.history.length > 0 && (
        <>
          <h4 style={{ margin: '14px 0 6px' }}>History (never deleted)</h4>
          <div className="oc-scroll" style={{ maxHeight: 200 }}><table className="oc-table"><tbody>
            {d.history.map((h) => <tr key={h.id}><td>{when(h.at)}</td><td>{CH[h.channel]}</td><td>{h.action === 'opt_in' ? 'Allowed' : (h.action === 'opt_out' ? 'Opted out' : 'Removed')}</td><td className="oc-note">{h.evidence}</td></tr>)}
          </tbody></table></div>
        </>
      )}
      {tl && tl.length > 0 && (
        <>
          <h4 style={{ margin: '14px 0 6px' }}>What happened with this person</h4>
          <div className="oc-scroll" style={{ maxHeight: 220 }}><table className="oc-table"><tbody>{tl.map((x, i) => <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{when(x.at)}</td><td>{x.text}</td></tr>)}</tbody></table></div>
        </>
      )}
      {acc.isAdmin && <div style={{ marginTop: 14 }}><button type="button" className="btn btn-sm" onClick={erase}>Remove this person for good</button></div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- add one person
function AddPerson({ acc, type, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', company: '', city: '', industries: [] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.post('/outreach/contacts', { ...f, contactType: type }); onSaved(); onClose(); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add a person" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || (!f.phone && !f.email)} onClick={save}>{busy ? 'Saving…' : 'Add this person'}</button></>}>
      <div className="grid-2">
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>Phone / WhatsApp</span><input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <label className="field"><span>Email</span><input value={f.email} onChange={set('email')} inputMode="email" /></label>
        <label className="field"><span>Company</span><input value={f.company} onChange={set('company')} /></label>
        <label className="field"><span>City</span><input value={f.city} onChange={set('city')} /></label>
      </div>
      <div className="field"><span>{type === 'internal' ? 'Kind' : 'Industry'}</span><MultiPick options={acc.industries.map((i) => ({ value: i.name, label: i.name }))} value={f.industries} onChange={(v) => setF({ ...f, industries: v })} placeholder={type === 'internal' ? 'Pick a kind' : 'Pick an industry'} /></div>
      <div className="oc-note">A person added by hand is saved as "Not confirmed": they cannot get promotions until an Admin records their permission.</div>
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

// Industry filter options: every industry the Admin has listed (Medical, BDE, Education, Manufacturing + added ones) with its live count under the other filters (0 when nobody matches);
// people tagged with an industry that is no longer listed still show. Internal contacts keep the plain facet list.
function industryOptions(acc, fx, promo) {
  const counts = new Map(fx.industries.map((i) => [i.value, i.count]));
  const names = promo ? [...new Set([...(acc.industries || []).map((i) => i.name), ...fx.industries.map((i) => i.value)])] : fx.industries.map((i) => i.value);
  return names.map((n) => ({ value: n, label: n, sub: `${counts.get(n) || 0} people` }));
}

// ---------------------------------------------------------------- the people list
function People({ acc, type }) {
  const [f, setF] = useState({ q: '', industries: [], cities: [], importIds: [], channel: '', optin: '', page: 1 });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  // View as is read-only: Import / Add need "Switch to Act as (edit)" (the server refuses the change too; the banner above explains it)
  const readOnly = !!viewAsToken() && !actAsMode();
  const canWrite = type === 'internal' ? acc.canImportInternal : acc.canImport;
  const roTip = readOnly ? 'You are in View as mode, which is read-only. Switch to Act as (edit) first.' : undefined;
  const promo = type !== 'internal';
  const load = useCallback((ff) => {
    setErr('');
    api.get('/outreach/contacts', { params: { type, q: ff.q || undefined, industries: ff.industries.join('|') || undefined, cities: ff.cities.join('|') || undefined, importIds: ff.importIds.join('|') || undefined, channel: ff.channel || undefined, optin: ff.optin || undefined, page: ff.page } })
      .then((r) => setData(r.data)).catch((e) => { setErr(e.response?.data?.error || 'The contacts could not be loaded.'); setData({ contacts: [], total: 0, facets: { industries: [], cities: [], optin: [], imports: [] } }); });
  }, [type]);
  useEffect(() => { const t = setTimeout(() => load(f), f.q ? 250 : 0); return () => clearTimeout(t); }, [f, load]);
  const upd = (patch) => setF((p) => ({ ...p, page: 1, ...patch }));
  const download = async () => { try { const r = await api.get('/outreach/contacts/export', { params: { type }, responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'outreach-contacts.xlsx'; a.click(); } catch (e) { setErr('You cannot download this list.'); } };
  const fx = data ? data.facets : { industries: [], cities: [], optin: [], imports: [] };
  const filtered = f.q || f.industries.length || f.cities.length || f.importIds.length || f.channel || f.optin;
  const optCount = (v) => (fx.optin.find((o) => o.value === v) || {}).count || 0;

  return (
    <div>
      <div className="oc-bar">
        <input type="search" placeholder={data && data.masked ? 'Search name, company, city' : 'Search name, phone, email, company'} value={f.q} onChange={(e) => upd({ q: e.target.value })} aria-label="Search contacts" />
        {canWrite && <button type="button" className="btn btn-primary" disabled={readOnly} title={roTip} onClick={() => setImporting(true)}>Import contacts</button>}
        {canWrite && <button type="button" className="btn" disabled={readOnly} title={roTip} onClick={() => setAdding(true)}>Add a person</button>}
        {acc.isAdmin && <button type="button" className="btn" onClick={download}>Download list</button>}
      </div>
      <div className="oc-filters">
        <div><label>{promo ? 'Industry' : 'Kind'}</label><MultiPick options={industryOptions(acc, fx, promo)} value={f.industries} onChange={(v) => upd({ industries: v })} placeholder={promo ? 'All industries' : 'All kinds'} emptyText={promo ? 'No industries yet.' : 'No kinds yet.'} /></div>
        <div><label>City</label><MultiPick options={fx.cities.map((i) => ({ value: i.value, label: i.value, sub: `${i.count} people` }))} value={f.cities} onChange={(v) => upd({ cities: v })} placeholder="All cities" emptyText="No cities yet." /></div>
        <div><label>Import file</label><MultiPick options={fx.imports.map((i) => ({ value: i.value, label: i.label, sub: `${i.count} people` }))} value={f.importIds} onChange={(v) => upd({ importIds: v })} placeholder="All files" emptyText="No imports yet." /></div>
        <div><label>Channel</label><Combo value={f.channel} onChange={(e) => upd({ channel: e.target.value })}><option value="">All channels</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></Combo></div>
        <div><label>Permission</label><Combo value={f.optin} onChange={(e) => upd({ optin: e.target.value })}><option value="">Everyone</option><option value="opted_in">{`Allowed (${optCount('opted_in')})`}</option><option value="opted_out">{`Opted out (${optCount('opted_out')})`}</option><option value="unknown">{`Not confirmed (${optCount('unknown')})`}</option></Combo></div>
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {data && data.masked && <div className="oc-note">Phone numbers and emails are hidden for your login.</div>}
      {!data && <div className="oc-note">Loading…</div>}
      {data && data.contacts.length === 0 && !err && (
        <div className="oc-empty">
          {filtered ? <><b>Nobody matches these filters.</b><div>Clear a filter to see more people.</div><button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setF({ q: '', industries: [], cities: [], importIds: [], channel: '', optin: '', page: 1 })}>Clear filters</button></>
            : <><b>No contacts yet.</b><div>{canWrite ? 'Press "Import contacts" and upload your Excel or CSV file.' : 'Contacts shared with you will show here.'}</div></>}
        </div>
      )}
      {data && data.contacts.length > 0 && (
        <>
          <div className="oc-scroll"><table className="oc-table"><thead><tr><th>Name</th><th>Phone</th><th className="oc-hide-m">Email</th><th>{promo ? 'Industry' : 'Kind'}</th><th>Permission</th><th className="oc-hide-m">Added</th></tr></thead><tbody>
            {data.contacts.map((c) => (
              <tr key={c.id} className="oc-row" onClick={() => setOpen(c.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c.id); }}>
                <td><b>{c.name || '—'}</b><div className="oc-note">{[c.company, c.city].filter(Boolean).join(' · ')}</div></td>
                <td>{c.phone}</td><td className="oc-hide-m">{c.email}</td>
                <td>{c.industries.map((k) => <span key={k} className="oc-pill kind">{k}</span>)}</td>
                <td><Pills channels={c.channels} /></td><td className="oc-hide-m">{when(c.createdAt)}</td>
              </tr>
            ))}
          </tbody></table></div>
          <div className="oc-bar">
            <button type="button" className="btn btn-sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Back</button>
            <span className="oc-note">{`Page ${data.page} · ${data.total.toLocaleString('en-IN')} people`}</span>
            <button type="button" className="btn btn-sm" disabled={data.page * data.pageSize >= data.total} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</button>
          </div>
        </>
      )}
      {open && <Detail id={open} acc={acc} type={type} onClose={() => setOpen(null)} onChanged={() => load(f)} />}
      {adding && <AddPerson acc={acc} type={type} onClose={() => setAdding(false)} onSaved={() => load(f)} />}
      {importing && <ImportWizard acc={acc} type={type} onClose={() => setImporting(false)} onSaved={() => load(f)} />}
    </div>
  );
}

// ---------------------------------------------------------------- the tab
// only: undefined = the old layout (People | Groups | Imports [| Messages]); 'people' | 'groups' | 'imports' = just that part (Internal menu);
// 'contacts' = People with an Import history switch (Job Promotions > Contacts)
export default function Contacts({ acc, type, only }) {
  const [sub, setSub] = useState('people');
  if (only === 'people') return <><InternalNote type={type} /><People acc={acc} type={type} /></>;
  if (only === 'groups') return <><InternalNote type={type} /><Groups acc={acc} type={type} word={type === 'internal' ? 'Groups' : 'Audiences'} /></>;
  if (only === 'imports') return <><InternalNote type={type} /><ImportHistory acc={acc} type={type} /></>;
  const subs = only === 'contacts' ? [['people', 'People'], ['imports', 'Import history']] : [['people', 'People'], ['groups', 'Groups'], ['imports', 'Imports']];
  if (!only && type === 'internal') subs.push(['messages', 'Messages']);
  return (
    <div>
      <InternalNote type={type} />
      <div className="oc-sub">{subs.map(([id, label]) => <button type="button" key={id} className={`bc-tab${sub === id ? ' on' : ''}`} onClick={() => setSub(id)}>{label}</button>)}</div>
      {sub === 'people' && <People acc={acc} type={type} />}
      {sub === 'groups' && <Groups acc={acc} type={type} />}
      {sub === 'imports' && <ImportHistory acc={acc} type={type} />}
      {sub === 'messages' && <Templates acc={acc} type="internal" />}
    </div>
  );
}
function InternalNote({ type }) {
  return type === 'internal' ? <div className="bc-warn">Internal contacts are your own staff. They never get job promotions, tracked apply links or funnel numbers.</div> : null;
}

import { useState } from 'react';
import Combo from '../../Combo.jsx';
import MultiPick from '../../MultiPick.jsx';
import { Btn, GsModal } from '../ui.jsx';
import omni from '../omniApi.js';
import FieldInput from './FieldInput.jsx';
import { errText } from './crmUtil.js';

// Add Customer / Edit Customer (the prototype's boxes: Full name, Phone, Email, Platform ID, "Additional Info (N fields linked)").
// Real data: POST /gs/crm/customers, PUT /gs/crm/customers/:id. The custom fields come from CRM Fields. A saved phone or email is shown but not replaced here.
const PREF = [['', '-- Select --'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['sms', 'SMS'], ['call', 'Call']];
export default function CustomerModal({ initial, meta, type, context = 'Default', onClose, onSaved }) {
  const editing = !!initial;
  const masked = !!meta.masked;
  const fields = meta.fields.filter((f) => !(masked && ['phone', 'email'].includes(f.type)));
  const cv = (initial && initial.customValues) || {};
  const [f, setF] = useState({
    name: initial ? initial.name : '', phone: '', email: '', platformId: initial ? initial.platformId : '', language: initial ? initial.language : '', preferredChannel: initial ? initial.preferredChannel : '',
    notes: initial ? initial.notes : '', city: initial ? initial.city : '', company: initial ? initial.company : '', skills: initial ? initial.skills : '', kinds: initial ? initial.kinds : [],
  });
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((x) => [x.id, cv[x.id] !== undefined ? cv[x.id] : (x.type === 'multi' ? [] : '')])));
  const [err, setErr] = useState('');
  const [bad, setBad] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const hasPhone = editing && initial.phone; const hasEmail = editing && initial.email;
  const save = async () => {
    setErr(''); setBad([]);
    if (!editing && !f.name.trim() && !f.phone.trim()) { setErr('Enter at least a name or a phone number — a contact with neither cannot be reached.'); setBad(['name', 'phone']); return; }
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) { setErr('That email address does not look valid.'); setBad(['email']); return; }
    setBusy(true);
    try {
      const customValues = { ...vals };
      const body = { name: f.name, language: f.language, preferredChannel: f.preferredChannel, notes: f.notes, city: f.city, company: f.company, skills: f.skills, kinds: f.kinds, customValues };
      if (!hasPhone && f.phone.trim()) body.phone = f.phone.trim();
      if (!hasEmail && f.email.trim()) body.email = f.email.trim();
      let r;
      if (editing) { customValues._platformId = f.platformId; r = await omni.put(`/gs/crm/customers/${initial.id}`, body); } else { body.platformId = f.platformId; body.contactType = type; r = await omni.post('/gs/crm/customers', body); }
      onSaved(r, editing, f);
    } catch (e) {
      setErr(errText(e, 'The customer could not be saved.'));
      if (e.response && e.response.status === 409) setBad(['phone']);
    } finally { setBusy(false); }
  };
  return (
    <GsModal title={editing ? 'Edit Customer' : 'Add New Customer'} sub={`Context: ${context}`} width={560} onClose={onClose} bodyStyle={{ maxHeight: '65vh' }}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Customer'}</Btn></>}>
      <div className="nc-grid">
        <div className={`nc-field${bad.includes('name') ? ' nc-bad' : ''}`}><label htmlFor="ncName">Full name</label><input id="ncName" placeholder="Jane Doe" value={f.name} maxLength={120} onChange={set('name')} autoFocus /></div>
        <div className={`nc-field${bad.includes('phone') ? ' nc-bad' : ''}`}><label htmlFor="ncPhone">Phone</label>
          {hasPhone ? <input id="ncPhone" value={initial.phone} disabled title="A saved number is not changed here" /> : <input id="ncPhone" placeholder="+91…" inputMode="tel" value={f.phone} maxLength={25} onChange={set('phone')} />}</div>
        <div className={`nc-field${bad.includes('email') ? ' nc-bad' : ''}`}><label htmlFor="ncEmail">Email address</label>
          {hasEmail ? <input id="ncEmail" value={initial.email} disabled title="A saved address is not changed here" /> : <input id="ncEmail" type="email" placeholder="jane@example.com" value={f.email} maxLength={160} onChange={set('email')} />}</div>
        <div className="nc-field"><label htmlFor="ncPid">Platform ID</label><input id="ncPid" placeholder="e.g. FB Lead ID" value={f.platformId} maxLength={80} onChange={set('platformId')} /></div>
        {(hasPhone || hasEmail) && <div className="nc-full" style={{ fontSize: 9.5, color: 'var(--muted)' }}>A saved phone or email is not replaced here. To use a different one, add the person again.</div>}
        <div className="nc-divider"><b>Additional Info</b><span>({fields.length + 7} fields linked)</span></div>
        <div className="nc-field nc-full"><label>Kind</label><MultiPick options={meta.kinds.map((k) => ({ value: k, label: k }))} value={f.kinds} onChange={(v) => setF({ ...f, kinds: v })} placeholder="No kind yet" /></div>
        <div className="nc-field"><label htmlFor="ncCity">City</label><input id="ncCity" value={f.city} maxLength={80} onChange={set('city')} /></div>
        <div className="nc-field"><label htmlFor="ncCo">Company</label><input id="ncCo" value={f.company} maxLength={120} onChange={set('company')} /></div>
        <div className="nc-field nc-full"><label htmlFor="ncSkills">Skills</label><input id="ncSkills" value={f.skills} maxLength={200} onChange={set('skills')} /></div>
        <div className="nc-field"><label htmlFor="ncLang">Language</label><input id="ncLang" placeholder="e.g. Telugu" value={f.language} maxLength={40} onChange={set('language')} /></div>
        <div className="nc-field"><label>Preferred channel</label><Combo value={f.preferredChannel} onChange={set('preferredChannel')}>{PREF.map(([v, w]) => <option key={v} value={v}>{w}</option>)}</Combo></div>
        <div className="nc-field nc-full"><label htmlFor="ncNotes">Notes</label><textarea id="ncNotes" value={f.notes} maxLength={1000} onChange={set('notes')} style={{ width: '100%', minHeight: 64, border: '1px solid var(--line)', borderRadius: 9, padding: '9px 11px', font: 'inherit' }} /></div>
        {fields.map((x) => (
          <div className="nc-field nc-full" key={x.id}>
            <label htmlFor={`ncf_${x.id}`}>{x.name}{x.required ? ' (needed)' : ''}</label>
            <FieldInput id={`ncf_${x.id}`} field={x} value={vals[x.id]} onChange={(v) => setVals({ ...vals, [x.id]: v })} />
            {x.description && <small style={{ fontSize: 9, color: 'var(--muted)' }}>{x.description}</small>}
          </div>
        ))}
        {err && <div className="nc-full nc-err" role="alert">{err}</div>}
      </div>
    </GsModal>
  );
}

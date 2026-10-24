import { useState } from 'react';
import { Btn, GsModal, Banner } from '../ui.jsx';
import omni from '../omniApi.js';
import { errText } from './crmUtil.js';

// Create / Edit a Web Form (the prototype's two-column box): General Information on the left (title, description, + the permission words, thank-you words, ways of
// contact), Configuration on the right (custom fields to ask, permitted members). Real data: POST / PUT /gs/crm/forms.
const initial = (n) => String(n || '?').trim()[0].toUpperCase();
export default function FormModal({ form, catalog, members, channels, defaultConsent, onClose, onSaved }) {
  const editing = !!form;
  const [title, setTitle] = useState(form ? form.title : '');
  const [description, setDescription] = useState(form ? form.description : '');
  const [consentText, setConsentText] = useState(form ? form.consentText : defaultConsent);
  const [thanks, setThanks] = useState(form ? form.thanks : 'Thank you. We have your details.');
  const [chs, setChs] = useState(form ? form.channels : channels.map((c) => c.id));
  const [status, setStatus] = useState(form ? form.status : 'on');
  const [keys, setKeys] = useState(form ? form.fields : ['name', 'phone', 'email']);
  const [memberIds, setMemberIds] = useState(form ? form.memberIds : []);
  const [fq, setFq] = useState('');
  const [mq, setMq] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fRows = catalog.filter((f) => !fq.trim() || f.label.toLowerCase().includes(fq.toLowerCase().trim()));
  const mRows = members.filter((m) => !mq.trim() || `${m.name} ${m.email}`.toLowerCase().includes(mq.toLowerCase().trim()));
  const toggle = (arr, set, v) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const save = async () => {
    setErr('');
    if (!title.trim()) { setErr('Form title is required'); return; }
    setBusy(true);
    try {
      const body = { title: title.trim(), description: description.trim(), fields: keys, memberIds, channels: chs, consentText: consentText.trim(), thanks: thanks.trim(), status };
      const r = editing ? await omni.put(`/gs/crm/forms/${form.id}`, body) : await omni.post('/gs/crm/forms', body);
      onSaved(r, editing);
    } catch (e) { setErr(errText(e, 'The form could not be saved.')); } finally { setBusy(false); }
  };
  const pillCount = (n) => <span className="pill draft">{n} SELECTED</span>;
  return (
    <GsModal title={editing ? 'Edit Form' : 'Create New Form'} width={960} onClose={onClose} bodyStyle={{ maxHeight: '70vh' }}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Form'}</Btn></>}>
      <div className="crm-form-cols">
        <div>
          <b style={{ fontSize: 12 }}>General Information</b>
          <div className="field" style={{ marginTop: 14 }}><label>FORM TITLE</label><input placeholder="E.g., Customer Intake Form" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} autoFocus /></div>
          <div className="field" style={{ marginTop: 14 }}><label>DESCRIPTION</label><textarea placeholder="Provide details about this form's purpose..." style={{ minHeight: 90 }} value={description} maxLength={400} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="field" style={{ marginTop: 14 }}><label>PERMISSION WORDS (THE PERSON MUST TICK THIS)</label><textarea style={{ minHeight: 84 }} value={consentText} maxLength={600} onChange={(e) => setConsentText(e.target.value)} /><small style={{ fontSize: 9, color: 'var(--muted)' }}>Each yes is saved with this form&apos;s name and these words. Change the words and the version changes.</small></div>
          <div className="field" style={{ marginTop: 14 }}><label>WAYS THE PERSON MAY AGREE TO</label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>{channels.map((c) => <label key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={chs.includes(c.id)} onChange={() => toggle(chs, setChs, c.id)} /> {c.label}</label>)}</div></div>
          <div className="field" style={{ marginTop: 14 }}><label>THANK-YOU WORDS</label><input value={thanks} maxLength={300} onChange={(e) => setThanks(e.target.value)} /></div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, margin: '14px 0 0', cursor: 'pointer' }}><input type="checkbox" checked={status === 'on'} onChange={(e) => setStatus(e.target.checked ? 'on' : 'off')} /> The form is switched on (the link works)</label>
        </div>
        <div>
          <b style={{ fontSize: 12 }}>Configuration</b>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 8, fontWeight: 850, letterSpacing: '.08em', color: 'var(--muted)' }}>CUSTOM FIELDS {pillCount(keys.length)}</span>
              <button type="button" className="link-btn" onClick={() => setKeys(keys.length === catalog.length ? [] : catalog.map((f) => f.key))}>{keys.length === catalog.length ? 'Clear all' : 'Select All'}</button>
            </div>
            <input className="search" style={{ width: '100%', marginTop: 8 }} placeholder="Search fields..." value={fq} onChange={(e) => setFq(e.target.value)} />
            <div className="form-picker-list">
              {fRows.map((f) => <label className="form-picker-row" key={f.key}><div><b>{f.label}</b><small style={{ color: 'var(--muted)', fontWeight: 700 }}>{f.type}</small></div><input type="checkbox" checked={keys.includes(f.key)} onChange={() => toggle(keys, setKeys, f.key)} /></label>)}
              {!fRows.length && <p style={{ padding: 14, textAlign: 'center', color: 'var(--muted)', fontSize: 10 }}>No fields match your search.</p>}
            </div>
            <small style={{ fontSize: 9, color: 'var(--muted)' }}>Pick Phone Number or Email Address (or both) so we can reach the person.</small>
          </div>
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 8, fontWeight: 850, letterSpacing: '.08em', color: 'var(--muted)' }}>PERMITTED MEMBERS {pillCount(memberIds.length)}</span>
              <button type="button" className="link-btn" onClick={() => setMemberIds(memberIds.length === members.length ? [] : members.map((m) => m.id))}>{memberIds.length === members.length ? 'Clear all' : 'Select All'}</button>
            </div>
            <input className="search" style={{ width: '100%', marginTop: 8 }} placeholder="Search members..." value={mq} onChange={(e) => setMq(e.target.value)} />
            <div className="form-picker-list">
              {mRows.map((m) => <label className="form-picker-row" key={m.id}><span className="fp-avatar">{initial(m.name)}</span><div><b style={{ overflowWrap: 'anywhere' }}>{m.name}</b><small style={{ color: 'var(--muted)', fontWeight: 700 }}>{m.role}</small></div><input type="checkbox" checked={memberIds.includes(m.id)} onChange={() => toggle(memberIds, setMemberIds, m.id)} /></label>)}
              {!mRows.length && <p style={{ padding: 14, textAlign: 'center', color: 'var(--muted)', fontSize: 10 }}>No members match your search.</p>}
            </div>
            <small style={{ fontSize: 9, color: 'var(--muted)' }}>People you pick may open this form&apos;s data, together with you and an Admin.</small>
          </div>
        </div>
      </div>
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}

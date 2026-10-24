import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';

const CH = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
const WA = { draft: 'Not sent for approval', pending: 'Waiting for WhatsApp', approved: 'Approved', rejected: 'Rejected' };

// who the message comes from, from Settings > Sender details (plain words)
function senderLine(channel, s) {
  if (channel === 'email') return `From: ${s.fromName || 'TeamLink'}${s.fromEmail ? ` <${s.fromEmail}>` : ''}${s.replyTo ? `. Replies go to ${s.replyTo}.` : '.'}`;
  if (channel === 'whatsapp') return s.whatsappShown ? `Will be sent from the WhatsApp number ${s.whatsappShown}.` : 'No WhatsApp business number is saved yet (Settings > Sender details).';
  return s.smsSenderId ? `Sender ID ${s.smsSenderId}${s.smsDltEntityId ? `, DLT entity ${s.smsDltEntityId}` : ''}.` : 'No SMS sender ID is saved yet (Settings > Sender details).';
}

function Editor({ type, vars, tpl, onClose, onSaved }) {
  const [f, setF] = useState(tpl ? { ...tpl } : { name: '', channel: 'email', subject: '', body: '', promotional: true, waTemplateName: '', waLanguage: 'en', waApprovalStatus: 'draft', dltTemplateId: '', senderId: '' });
  const [prev, setPrev] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    const t = setTimeout(() => { api.post('/outreach/templates/preview', { ...f, audience: type }).then((r) => setPrev(r.data)).catch(() => setPrev(null)); }, 250);
    return () => clearTimeout(t);
  }, [f, type]);
  const insert = (v) => {
    const el = bodyRef.current; const tag = `{{${v}}}`;
    if (!el) { setF({ ...f, body: `${f.body}${tag}` }); return; }
    const a = el.selectionStart; const b = el.selectionEnd;
    setF({ ...f, body: `${f.body.slice(0, a)}${tag}${f.body.slice(b)}` });
    setTimeout(() => { el.focus(); el.selectionStart = a + tag.length; el.selectionEnd = a + tag.length; }, 0);
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (tpl) await api.put(`/outreach/templates/${tpl.id}`, f); else await api.post('/outreach/templates', { ...f, audience: type });
      onSaved(); onClose();
    } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  };
  const shownVars = type === 'internal' ? vars.filter((v) => v.name !== 'apply_link') : vars;
  return (
    <Modal title={tpl ? (type === 'internal' ? 'Edit staff template' : 'Edit template') : (type === 'internal' ? 'New staff template' : 'New template')} size="xwide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !f.name.trim() || !f.body.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="oc-split">
        <div>
          <div className="grid-2">
            <label className="field"><span>Name</span><input value={f.name} maxLength={80} onChange={set('name')} placeholder="Nurse job, first message" /></label>
            <div className="field"><span>Channel</span>
              <Combo value={f.channel} onChange={set('channel')} disabled={!!tpl}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></Combo>
            </div>
          </div>
          {f.channel === 'email' && <label className="field"><span>Subject</span><input value={f.subject} maxLength={200} onChange={set('subject')} placeholder="{{job_title}} at {{company}}" /></label>}
          <div className="field"><span>Message</span>
            <div className="oc-vars">{shownVars.map((v) => <button type="button" key={v.name} onClick={() => insert(v.name)} title={v.words}>{`{{${v.name}}}`}</button>)}</div>
            <textarea ref={bodyRef} className="oc-text" value={f.body} maxLength={4000} onChange={set('body')} />
          </div>
          {type !== 'internal' && <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={f.promotional} onChange={(e) => setF({ ...f, promotional: e.target.checked })} /> This is a promotion (it must tell people how to stop it)</label>}
          {f.channel === 'whatsapp' && (
            <div className="grid-2" style={{ marginTop: 8 }}>
              <label className="field"><span>WhatsApp template name</span><input value={f.waTemplateName} onChange={set('waTemplateName')} /></label>
              <label className="field"><span>Language</span><input value={f.waLanguage} maxLength={12} onChange={set('waLanguage')} /></label>
              <div className="field"><span>WhatsApp approval</span><Combo value={f.waApprovalStatus} onChange={set('waApprovalStatus')}>{Object.keys(WA).map((k) => <option key={k} value={k}>{WA[k]}</option>)}</Combo></div>
            </div>
          )}
          {f.channel === 'sms' && (
            <div className="grid-2" style={{ marginTop: 8 }}>
              <label className="field"><span>DLT template number</span><input value={f.dltTemplateId} inputMode="numeric" onChange={set('dltTemplateId')} /></label>
              <label className="field"><span>Sender ID</span><input value={f.senderId} maxLength={20} onChange={set('senderId')} /></label>
            </div>
          )}
        </div>
        <div>
          <b>How it looks (sample person)</b>
          <div className="oc-prev" style={{ marginTop: 6 }}>
            {prev ? <>{f.channel === 'email' && <div style={{ fontWeight: 700, marginBottom: 6 }}>{prev.preview.subject}</div>}{prev.preview.body}</> : 'Loading…'}
          </div>
          {prev && prev.sender && <div className="oc-note" style={{ marginTop: 6 }}>{senderLine(f.channel, prev.sender)}</div>}
          {prev && prev.problems.length > 0 && <div className="bc-warn" role="status">{prev.problems.map((p) => <div key={p}>{p}</div>)}</div>}
          {prev && prev.problems.length === 0 && <div className="bc-ok">This message is fine to save.</div>}
          {prev && !prev.ready && prev.problems.length === 0 && <div className="oc-note">{prev.why}</div>}
        </div>
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
    </Modal>
  );
}

export default function Templates({ acc, type }) {
  const [list, setList] = useState(null);
  const [vars, setVars] = useState([]);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);
  const canEdit = type === 'internal' ? acc.canEditInternalTemplates : acc.canEditTemplates;
  const load = useCallback(() => api.get('/outreach/templates', { params: { type } }).then((r) => { setList(r.data.templates); setVars(r.data.variables); }).catch((e) => { setErr(e.response?.data?.error || 'The messages could not be loaded.'); setList([]); }), [type]);
  useEffect(() => { load(); }, [load]);
  const [msg, setMsg] = useState('');
  const copy = async (t) => { setErr(''); setMsg(''); try { const r = await api.post(`/outreach/templates/${t.id}/duplicate`); setMsg(`Made a copy: "${r.data.template.name}". Press Edit to change it.`); load(); } catch (e) { setErr(e.response?.data?.error || 'The copy could not be made.'); } };
  const del = async (t) => { if (!window.confirm(`Delete the message "${t.name}"?`)) return; try { await api.delete(`/outreach/templates/${t.id}`); load(); } catch (e) { setErr(e.response?.data?.error || 'It could not be removed.'); } };
  return (
    <div>
      <div className="oc-bar">{canEdit && <button type="button" className="btn btn-primary" onClick={() => setEdit({})}>New message</button>}<span className="oc-note">{type === 'internal' ? 'Reminder and announcement messages for your staff. Use {{name}} for their name. No apply link.' : 'Words for your Email, WhatsApp and SMS job messages. Every promotion must tell people how to stop it. WhatsApp needs approval; SMS needs the DLT number.'}</span></div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!list && <div className="oc-note">Loading…</div>}
      {list && list.length === 0 && !err && <div className="oc-empty"><b>No messages yet.</b><div>{canEdit ? 'Press "New message" to write the first one.' : 'Messages will show here.'}</div></div>}
      <div className="oc-cards">
        {(list || []).map((t) => (
          <div className="oc-card" key={t.id}>
            <h4>{t.name}</h4>
            <div><span className="oc-pill kind">{CH[t.channel]}</span>{t.promotional && <span className="oc-pill">Promotion</span>}{t.channel === 'whatsapp' && <span className={`oc-pill ${t.waApprovalStatus === 'approved' ? 'in' : ''}`}>{WA[t.waApprovalStatus] || WA.draft}</span>}{t.ready ? <span className="oc-pill in">Ready</span> : <span className="oc-pill out">Not ready</span>}</div>
            {!t.ready && <div className="oc-note">{t.why}</div>}
            <div className="oc-note" style={{ whiteSpace: 'pre-wrap', maxHeight: 70, overflow: 'hidden' }}>{t.subject ? `${t.subject} — ` : ''}{t.body}</div>
            {type === 'internal' && (t.usedByCampaigns > 0 || t.usedByRules > 0) && <div className="oc-note">{`Used by ${t.usedByCampaigns} sent message${t.usedByCampaigns === 1 ? '' : 's'}${t.usedByRules ? ` and ${t.usedByRules} scheduled rule${t.usedByRules === 1 ? '' : 's'}` : ''}.`}</div>}
            {canEdit && <div className="oc-row2"><button type="button" className="btn btn-sm" onClick={() => setEdit(t)}>Edit</button><button type="button" className="btn btn-sm" onClick={() => copy(t)}>Make a copy</button><button type="button" className="btn btn-sm" disabled={type === 'internal' && (t.usedByCampaigns > 0 || t.usedByRules > 0)} title={type === 'internal' && (t.usedByCampaigns > 0 || t.usedByRules > 0) ? 'It was used, so it stays. Make a copy and change the copy.' : undefined} onClick={() => del(t)}>Delete</button></div>}
          </div>
        ))}
      </div>
      {edit && <Editor type={type} vars={vars} tpl={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import TemplateLibrary from '../jobs/TemplateLibrary.jsx';
import './broadcast.css';

// ---------------------------------------------------------------------------
// "YOUR READY TEMPLATE" — written the moment a job is saved as a template (or from a saved job):
// the long job post, the short WhatsApp message, the SMS and the email. Editable, versioned, Regenerate / Use this.
// Server: /api/job-broadcast (broadcast/template.js). Two modes:
//   fields        the Add job form (nothing saved yet): the text is written from what is on the form and kept here;
//                 when the job is saved the form sends the same text to the job (RequirementForm).
//   requirementId a saved job: every change is a new version; "Use this" makes it the text Post and WhatsApp use.
// ---------------------------------------------------------------------------
const TABS = [['jobPost', 'Job post'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];
const PREV = [['naukri', 'Naukri'], ['indeed', 'Indeed'], ['shine', 'Shine'], ['whatsapp', 'WhatsApp']];
const hhmm = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function ReadyTemplatePanel({ requirementId = null, fields = null, onClose = null, side = false, onTexts = null, title = 'Your ready template' }) {
  const [data, setData] = useState(null);
  const [texts, setTexts] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('whatsapp');
  const [prev, setPrev] = useState('whatsapp');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [lib, setLib] = useState([]);
  const [libName, setLibName] = useState('');
  const first = useRef(true);

  const apply = (d) => {
    setData(d);
    setTexts(d.texts);
    setDirty(false);
    if (onTexts) onTexts(d.texts, false);
  };
  const load = async () => {
    setErr('');
    try {
      if (requirementId) apply((await api.get(`/job-broadcast/jobs/${requirementId}/ready-template`)).data);
      else apply((await api.post('/job-broadcast/ready-template/preview', { fields })).data);
    } catch (e) { setErr(e.response?.data?.error || 'The template could not be written. Please try again.'); }
  };
  const loadLib = () => api.get('/job-broadcast/templates').then((r) => setLib(r.data.templates || [])).catch(() => {});
  useEffect(() => { load(); loadLib(); first.current = false; }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (side) { document.body.classList.add('bc-side-open'); return () => document.body.classList.remove('bc-side-open'); } return undefined; }, [side]);

  const edit = (k, v) => { const next = { ...texts, [k]: v }; setTexts(next); setDirty(true); setMsg(''); if (onTexts) onTexts(next, true); };
  const saved = requirementId && data;
  const canEdit = !requirementId || (data && data.canEdit);

  async function run(key, fn) {
    setBusy(key); setErr(''); setMsg('');
    try { await fn(); } catch (e) { setErr(e.response?.data?.error || 'That did not work. Please try again.'); } finally { setBusy(''); }
  }
  const regenerate = (ai) => run(ai ? 'ai' : 'regen', async () => {
    if (requirementId) { const r = await api.post(`/job-broadcast/jobs/${requirementId}/ready-template`, { regenerate: true, ai: !!ai }); setMsg(r.data.ok); await load(); } else { await load(); setMsg('Written again from the form.'); }
  });
  const saveEdit = () => run('save', async () => {
    const r = await api.post(`/job-broadcast/jobs/${requirementId}/ready-template`, { texts });
    setMsg(r.data.ok); await load();
  });
  const useThis = () => run('use', async () => {
    let v = data.version;
    if (dirty) { const r = await api.post(`/job-broadcast/jobs/${requirementId}/ready-template`, { texts }); v = r.data.version; }
    const u = await api.post(`/job-broadcast/jobs/${requirementId}/ready-template/use`, { version: v });
    setMsg(u.data.ok); await load();
  });
  const openVersion = (v) => run('ver', async () => {
    const r = await api.get(`/job-broadcast/jobs/${requirementId}/ready-template/versions/${v}`);
    setTexts(r.data.texts); setDirty(true); setMsg(`Showing version ${v}. Press "Use this" to use it again.`);
  });
  const saveLib = () => run('lib', async () => {
    const r = await api.post('/job-broadcast/templates', { name: libName, texts, jobTitle: data?.job?.title || data?.facts?.title || '' });
    setMsg(r.data.ok); setLibName(''); loadLib();
  });
  const fromLib = (t) => { setTexts(t.texts); setDirty(true); if (onTexts) onTexts(t.texts, true); setMsg(`Filled from "${t.name}". Read it, then ${requirementId ? 'press "Use this"' : 'save the requirement'}.`); };

  const sample = data?.sample || {};
  const resolve = (t) => String(t || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => ({ firstName: sample.firstName, jobTitle: sample.jobTitle, location: sample.location, applyLink: sample.applyLink, name: sample.firstName })[k] || m);
  const inUse = data?.used || 0;

  const body = (
    <>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!data && !err && <div className="bc-note">Writing your template…</div>}
      {data && texts && (
        <>
          <div className="bc-row" style={{ marginTop: 0 }}>
            <span className="status-pill" style={{ fontSize: 12 }}>{data.label}</span>
            {data.hidesClient && <span className="bc-note">The client name is hidden ("our client").</span>}
            {requirementId && <span className="bc-note">Version {data.version}{inUse ? ` · in use: version ${inUse}` : ' · not marked "in use" yet'}</span>}
          </div>
          {data.missing && data.missing.length > 0 && <div className="bc-warn">Not on the requirement yet, so left out: {data.missing.map((m) => m.label || m.key).join(', ')}. Fill them in on the requirement to improve the text.</div>}
          {!requirementId && <div className="bc-note" style={{ marginBottom: 6 }}>Written from what is on the form. When you save the requirement, this same text goes with it.</div>}
          <div className="bc-tabs" role="tablist">
            {TABS.map(([k, l]) => <button type="button" key={k} className={`bc-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'jobPost' && (
            <div>
              <div className="bc-note">For Naukri, Indeed, Shine and the careers page. Long text.</div>
              <textarea className="bc-text" style={{ minHeight: 220 }} value={texts.jobPost} disabled={!canEdit} onChange={(e) => edit('jobPost', e.target.value)} aria-label="Job post" />
            </div>
          )}
          {tab === 'whatsapp' && (
            <div>
              <div className="bc-note">Short message, with the apply link and "Reply YES to apply / STOP to stop". {'{{firstName}} {{jobTitle}} {{location}} {{applyLink}}'} are filled for each person.</div>
              <textarea className="bc-text short" value={texts.whatsapp} disabled={!canEdit} onChange={(e) => edit('whatsapp', e.target.value)} aria-label="WhatsApp message" />
            </div>
          )}
          {tab === 'sms' && (
            <div>
              <div className="bc-note">{`About ${[...resolve(texts.sms)].length} letters (a single SMS is 160).`}</div>
              <textarea className="bc-text short" style={{ minHeight: 80 }} value={texts.sms} disabled={!canEdit} onChange={(e) => edit('sms', e.target.value)} aria-label="SMS" />
              {[...resolve(texts.sms)].length > 160 && <div className="bc-warn">This is longer than 160 letters, so it goes as more than one SMS.</div>}
            </div>
          )}
          {tab === 'email' && (
            <div>
              <label className="field" style={{ margin: '0 0 6px' }}><span>Subject</span><input value={texts.emailSubject} disabled={!canEdit} onChange={(e) => edit('emailSubject', e.target.value)} /></label>
              <textarea className="bc-text" value={texts.emailBody} disabled={!canEdit} onChange={(e) => edit('emailBody', e.target.value)} aria-label="Email" />
            </div>
          )}

          {canEdit ? <div className="bc-note">To edit the words, type in the box above, then press "Save my edit".</div> : <div className="bc-note">You can read this template. Only the people who run job posting can edit it.</div>}
          <div className="bc-row">
            {canEdit && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => regenerate(false)}>{busy === 'regen' ? 'Writing…' : 'Reset to auto'}</button>}
            {canEdit && (data.ai?.available
              ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => regenerate(true)}>{busy === 'ai' ? 'Asking AI…' : 'Polish with AI'}</button>
              : <span className="bc-note" title={data.ai?.reason || ''}>AI is not connected, so this is the template version.</span>)}
            {saved && canEdit && dirty && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={saveEdit}>{busy === 'save' ? 'Saving…' : 'Save my edit'}</button>}
            {saved && canEdit && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={useThis} title="Posting and WhatsApp use this text">{busy === 'use' ? 'Saving…' : 'Use this'}</button>}
          </div>
          {msg && <div className="bc-ok" role="status">{msg}</div>}

          <h4 style={{ fontSize: 12.5, margin: '12px 0 6px' }}>How it looks on</h4>
          <div className="bc-tabs">
            {PREV.map(([k, l]) => <button type="button" key={k} className={`bc-tab${prev === k ? ' on' : ''}`} onClick={() => setPrev(k)}>{l}</button>)}
          </div>
          {prev === 'whatsapp'
            ? <div className="bc-wabg"><div className="bc-wa">{resolve(texts.whatsapp)}</div></div>
            : (
              <div className="bc-prev">
                <div className="bc-ptitle">{data.previews?.[prev]?.title || sample.jobTitle}</div>
                {resolve(data.previews?.[prev]?.text || texts.jobPost)}
              </div>
            )}
          <div className="bc-note" style={{ marginTop: 4 }}>A simple preview. Nothing is sent or posted from here.</div>

          {requirementId && data.versions && data.versions.length > 1 && (
            <>
              <h4 style={{ fontSize: 12.5, margin: '12px 0 6px' }}>Versions</h4>
              <div className="bc-versions">
                {[...data.versions].reverse().map((v) => (
                  <button type="button" key={v.v} className={`bc-ver${v.v === data.version ? ' on' : ''}${v.v === inUse ? ' used' : ''}`} onClick={() => openVersion(v.v)} title={`${v.label}${v.note ? ` · ${v.note}` : ''}`}>
                    {`v${v.v} · ${v.edited ? 'edited by ' : ''}${v.byName}${v.v === inUse ? ' · in use' : ''} · ${hhmm(v.at)}`}
                  </button>
                ))}
              </div>
            </>
          )}

          <h4 style={{ fontSize: 12.5, margin: '12px 0 6px' }}>My job templates</h4>
          <TemplateLibrary texts={texts} jobTitle={data?.job?.title || data?.facts?.title || ''} onUse={fromLib} />
        </>
      )}
    </>
  );

  if (side) {
    return (
      <aside className="bc-side bc-fixedbottom" aria-label={title}>
        <div className="bc-head"><b style={{ flex: 1 }}>{title}</b>{onClose && <button type="button" className="close-x" onClick={onClose} aria-label="Close">×</button>}</div>
        <div className="bc-body">{body}</div>
      </aside>
    );
  }
  return (
    <div className="bc-panel">
      <div className="bc-head"><b style={{ flex: 1 }}>{title}</b></div>
      <div className="bc-body">{body}</div>
    </div>
  );
}

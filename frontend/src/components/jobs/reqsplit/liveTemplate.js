import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../api';

// ---------------------------------------------------------------------------
// THE LIVE READY TEMPLATE for the split Add / Edit job window (2026-10-13).
// It does NOT write text itself: it asks the same server writer the "Your ready template" panel uses
// (POST /job-broadcast/ready-template/preview, template only: no AI, nothing saved), 600 ms after the last key.
// A tab the person edits stops auto-filling ("Reset to auto" brings it back). The merged texts are what Save & Post keeps.
// ---------------------------------------------------------------------------
export const TABS = [['jobPost', 'Job post'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];
export const TAB_KEYS = { jobPost: ['jobPost'], whatsapp: ['whatsapp'], sms: ['sms'], email: ['emailSubject', 'emailBody'] };
export const SMS_LIMIT = 160;

// The form, in the shape the writer reads.
export function templateFields(form, { internal, salary }) {
  return {
    title: form.title, clientId: internal ? '' : form.clientId, department: form.department, openings: Number(form.openings) || 1,
    experience: form.expMin !== '' && form.expMin != null ? `${form.expMin}-${form.expMax !== '' && form.expMax != null ? form.expMax : form.expMin} yrs` : '',
    salary: salary || '', salaryType: form.salaryType, jobDescription: form.jobDescription, description: form.jobDescription,
    responsibilities: form.responsibilities, qualifications: form.qualifications, education: form.education, skills: form.skills,
    goodToHaveSkills: form.goodToHaveSkills, employmentType: form.employmentType, workMode: form.workMode, location: form.location,
    joiningTimeline: form.joiningTimeline, noticePeriodMax: form.noticePeriodMax, priority: form.priority, internal: !!internal,
  };
}

// The fields a good post needs: "Template ready" only when none is missing.
export function missingForTemplate(form, internal) {
  const blank = (v) => !String(v ?? '').trim();
  const out = [];
  if (blank(form.title)) out.push('job title');
  if (!internal && blank(form.clientId)) out.push('client');
  if (blank(form.location)) out.push('location');
  if (blank(form.expMin)) out.push('experience');
  if (blank(form.skills)) out.push('skills');
  if (blank(form.employmentType)) out.push('employment type');
  if (blank(form.jobDescription)) out.push('description');
  if (blank(form.joiningTimeline)) out.push('joining time');
  return out;
}

// useLiveTemplate(fields, { enabled })  -> { state, data, error, texts, edits, setText, resetTab, isEdited, editedAny, resetAll, setMany }
export function useLiveTemplate(fields, { enabled = true, delay = 600 } = {}) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle'); // idle | waiting | loading | ready | error | hidden
  const [error, setError] = useState('');
  const [edits, setEdits] = useState({});
  const seq = useRef(0);
  const key = JSON.stringify(fields);
  const hasTitle = !!String(fields.title || '').trim();

  useEffect(() => {
    if (!enabled) return undefined;
    if (!hasTitle) { setState('idle'); return undefined; }
    const my = seq.current + 1;
    seq.current = my;
    setState((s) => (s === 'ready' ? 'waiting' : 'loading'));
    let retry = null;
    const attempt = (n) => api.post('/job-broadcast/ready-template/preview', { fields })
      .then((r) => { if (seq.current === my) { setData(r.data); setError(''); setState('ready'); } })
      .catch((err) => {
        if (seq.current !== my) return;
        if (err.response?.status === 403) { setState('hidden'); return; }
        if (n < 2) { retry = setTimeout(() => attempt(n + 1), 1500); return; }
        setError(err.response?.data?.error || 'The preview is not available right now.');
        setState('error');
      });
    const t = setTimeout(() => attempt(0), delay);
    return () => { clearTimeout(t); if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, hasTitle]);

  const texts = useMemo(() => {
    const auto = (data && data.texts) || {};
    const out = {};
    ['jobPost', 'whatsapp', 'sms', 'emailSubject', 'emailBody'].forEach((k) => { out[k] = edits[k] !== undefined ? edits[k] : (auto[k] || ''); });
    return out;
  }, [data, edits]);

  const setText = useCallback((k, v) => setEdits((e) => ({ ...e, [k]: v })), []);
  const setMany = useCallback((patch) => setEdits((e) => ({ ...e, ...patch })), []);
  const resetTab = useCallback((tab) => setEdits((e) => { const n = { ...e }; (TAB_KEYS[tab] || []).forEach((k) => { delete n[k]; }); return n; }), []);
  const resetAll = useCallback(() => setEdits({}), []);
  const isEdited = (tab) => (TAB_KEYS[tab] || []).some((k) => edits[k] !== undefined);
  const editedAny = Object.keys(edits).length > 0;
  return {
    state, data, error, texts, edits, setText, setMany, resetTab, resetAll, isEdited, editedAny,
  };
}

// Fill {{firstName}} {{jobTitle}} {{location}} {{applyLink}} with the sample person, for reading only.
export function resolveText(text, sample = {}) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => ({
    firstName: sample.firstName, jobTitle: sample.jobTitle, location: sample.location, applyLink: sample.applyLink, name: sample.firstName,
  }[k] || m));
}
export const countWords = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);

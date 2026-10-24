import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { useClientDuplicateCheck, ClientDuplicateWarning } from './ClientDuplicateCheck.jsx';
import { gateConfirm, pendingLine } from '../../utils/clientLocation.js';
import { loadClientAliases } from '../clientAliases.js';
import ClientForm, {
  emptyClientForm, bodyFromForm, validateClientForm, SECTION_OF,
} from './ClientForm.jsx';
// docfill_: "Upload client details" / "Type it myself" (components/ui/FillFromFile.jsx).
import { useFillFromFile, FillEntryModal, FillBanner } from '../ui/FillFromFile.jsx';
import { clientFieldsToForm, CLIENT_FIELD_NAMES } from '../ui/fillMaps.js';
import AgreementLivePreview from '../agreements/AgreementLivePreview.jsx';
import '../agreements/agreementLink.css';
import './clientsrole.css';
import './addClientModal.css';

// ---------------------------------------------------------------------------
// ADD CLIENT (2026-10-05) — two columns: the form in 9 sections on the left
// (components/clients/ClientForm.jsx; the first 4 open), the LIVE agreement on
// the right, rebuilt by the server as the user types (POST
// /clients/agreement-preview runs the same code the save does — one template,
// utils/vendorAgreement.js). On a phone the preview sits behind "Preview
// agreement".
//
// Bottom bar: [Cancel] [Save draft] [Save & create agreement]
//   Save draft                only the company name; the rest are listed as
//                             missing; no agreement yet
//   Save & create agreement   the 10 required fields; the draft agreement is
//                             exactly the preview (the server checks the hash)
// Then the client's Agreement card opens with the next step in one sentence.
// Documents chosen here upload right after the client is saved.
// The same-name guard still runs before anything is saved - as a friendly QUESTION (2026-10-22, one company many locations): "This client
// already exists ... do you still want to add another one?" with Yes (add another location) / No (open the existing client).
// ---------------------------------------------------------------------------
const OPEN_FIRST = { basic: true, contact: true, owner: true, commercial: true };

export default function AddClientWizard({ user, meta, onClose, onSaved }) {
  const navigate = useNavigate();
  const ownerLocked = meta?.ownerLocked || null;
  const [defaults, setDefaults] = useState(null);
  const [form, setForm] = useState(() => emptyClientForm(user, ownerLocked, null));
  const touched = useRef(new Set());
  const [open, setOpen] = useState(OPEN_FIRST);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [docQueue, setDocQueue] = useState([]);
  // docfill_: the two-choice entry; a read file fills the form and is kept as
  // a client document (kind "Source document") once the client is saved.
  const fill = useFillFromFile('client');
  const dup = useClientDuplicateCheck();
  // The friendly line under the form (blue, never red) and the save that was waiting for the answer to the question.
  const [notice, setNotice] = useState('');
  const pendingSave = useRef(null);
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState('loading');
  const [showPreview, setShowPreview] = useState(false);
  const previewSeq = useRef(0);
  // Agreement steps (2026-10-13): the BDE fills sections 1-5 and sends the client to Purna Sir; 6-9 are his and the Admin's.
  const [flow, setFlow] = useState(null);
  useEffect(() => { api.get('/agreement-flow/settings').then((r) => setFlow(r.data)).catch(() => setFlow(null)); }, []);
  const hrLabel = flow?.hrLabel || 'HR';
  const canCommercial = !!defaults?.canEdit || !!flow?.canCommercial;
  const hrAccess = defaults?.canEdit ? 'edit' : 'hidden';

  const set = (patch) => {
    Object.keys(patch).forEach((k) => touched.current.add(k));
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => { delete n[k]; }); if (!Object.keys(n).length) setError(''); return n; });
  };

  // The Admin's agreement defaults fill the commercial fields the user has not typed.
  useEffect(() => {
    api.get('/clients/agreement-settings').then((r) => {
      setDefaults(r.data);
      const d = r.data || {};
      const fill = { agreementFeePercent: String(d.feePercent ?? 8.33), paymentDays: String(d.paymentDays ?? 6), guaranteeDays: String(d.guaranteeDays ?? 30), agreementTemplate: d.templateName || 'Vendor Services Agreement' };
      setForm((f) => {
        const n = { ...f };
        Object.entries(fill).forEach(([k, v]) => { if (!touched.current.has(k)) n[k] = v; });
        return n;
      });
    }).catch(() => setDefaults(null));
  }, []);

  // The question went away (the name changed): so does the waiting save and the line under the form.
  useEffect(() => { if (!dup.question) { pendingSave.current = null; setNotice(''); } }, [dup.question]);

  // The question depends on the Location too: ask again a moment after it is typed / picked.
  useEffect(() => {
    if (!String(form.name || '').trim()) return undefined;
    const t = setTimeout(() => { dup.check(form); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.location, form.state]);

  const bodyOf = () => {
    const b = bodyFromForm(form, { canCommercial, hrEditable: hrAccess === 'edit' });
    if (ownerLocked) b.bdeOwner = ownerLocked;
    return b;
  };

  // Rebuild the preview 400 ms after the user stops typing; retried (it only reads).
  useEffect(() => {
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    setPreviewState('loading');
    let retry = null;
    const attempt = (n) => {
      const b = bodyOf();
      delete b.bankAccountNo;
      return api.post('/clients/agreement-preview', b)
        .then((r) => { if (previewSeq.current === seq) { setPreview(r.data); setPreviewState('ready'); } })
        .catch((err) => {
          if (previewSeq.current !== seq) return;
          if (err.response?.status === 403) { setPreviewState('hidden'); return; }
          if (n < 4) { retry = setTimeout(() => attempt(n + 1), 1500); return; }
          setPreviewState('error');
        });
    };
    const t = setTimeout(() => attempt(0), 400);
    return () => { clearTimeout(t); if (retry) clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, canCommercial]);

  // Open the section of the first problem and scroll to the field.
  function showErrors(errs) {
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (!first) return;
    const sec = SECTION_OF[first];
    if (sec) setOpen((o) => ({ ...o, [sec]: true }));
    setTimeout(() => {
      const el = document.getElementById(`cf-${first}`) || document.getElementById(`cf-sec-${sec}`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); const i = el.querySelector('input,select,textarea'); if (i) i.focus({ preventScroll: true }); }
    }, 60);
  }

  // The question box is the answer to a save that found a client with this name: show it, remember which save was asked for.
  function askQuestion(question, mode, sendToHr) {
    pendingSave.current = { mode, sendToHr };
    setNotice(pendingLine(question));
    setTimeout(() => document.getElementById('csn-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return null;
  }
  // "Yes" was pressed but the Location (or the one-line reason) is still empty: say so on the box, plainly.
  function needMore(gate) {
    setNotice(gate.error);
    if (gate.field === 'location') showErrors({ location: gate.error });
    else setTimeout(() => { const el = document.querySelector('.csn-reason input'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); } }, 60);
    return null;
  }
  // "Yes, add another location": the save that was waiting goes on, with the confirm.
  function answeredYes() {
    const p = pendingSave.current;
    pendingSave.current = null;
    if (p) { setNotice(''); save(p.mode, { sendToHr: p.sendToHr }); } else setNotice('Good. Press Save when you are ready.');
  }
  function openExisting(m) {
    if (!m) return;
    onClose();
    navigate(`/clients/${m.id}`);
  }

  async function uploadQueued(id) {
    let failed = 0;
    // eslint-disable-next-line no-restricted-syntax
    for (const d of docQueue) {
      const fd = new FormData();
      fd.append('kind', d.kind); fd.append('name', d.name); fd.append('expiryDate', d.expiryDate || ''); fd.append('pending', d.pending ? 'true' : 'false');
      fd.append('file', d.file, d.file.name);
      // eslint-disable-next-line no-await-in-loop
      try { await api.post(`/clients/${id}/documents`, fd); } catch { failed += 1; }
    }
    return failed;
  }

  async function save(mode, { sendToHr = false } = {}) {
    setError('');
    const errs = validateClientForm(form, mode, { canCommercial });
    if (Object.keys(errs).length) {
      showErrors(errs);
      return setError(mode === 'create' ? 'Some fields need a fix. They are marked in red.' : Object.values(errs)[0]);
    }
    const found = await dup.check(form);
    if (found.question && !found.acked) return askQuestion(found.question, mode, sendToHr);
    if (found.question) {
      const gate = gateConfirm(found.question, { location: form.location, reason: dup.note });
      if (!gate.ok) return needMore(gate);
    }
    setNotice('');
    const body = {
      ...bodyOf(), mode, createAgreement: mode === 'create', ...dup.overrideBody(),
      previewHash: mode === 'create' && previewState === 'ready' && preview ? preview.hash : undefined,
    };
    setSaving(sendToHr ? 'send' : mode);
    try {
      const created = (await api.post('/clients', body)).data;
      loadClientAliases({ force: true }); // the new client's Name - Location label reaches every dropdown
      const failed = docQueue.length ? await uploadQueued(created.id) : 0;
      // docfill_: keep the uploaded profile / e-mail / agreement on the client.
      // PDF / JPG / PNG up to 5 MB go into its Documents (kind Source document);
      // anything else (DOCX / TXT / bigger) into the source-document store.
      let sourceNote = '';
      if (fill.file) {
        const f = fill.file;
        let kept = false;
        if (/\.(pdf|png|jpe?g)$/i.test(f.name) && f.size <= 5 * 1024 * 1024) {
          const fd = new FormData();
          fd.append('kind', 'SOURCE'); fd.append('name', `Source: ${f.name.replace(/\.[^.]+$/, '')}`.slice(0, 200)); fd.append('expiryDate', ''); fd.append('pending', 'false');
          fd.append('file', f, f.name);
          try { await api.post(`/clients/${created.id}/documents`, fd); kept = true; sourceNote = ` ${f.name} is kept in Documents as the source document.`; } catch { kept = false; }
        }
        if (!kept) sourceNote = ` ${await fill.attach('client', created.id)}`;
      }
      setSaving('');
      const docNote = `${failed ? ` ${failed} document${failed === 1 ? '' : 's'} did not upload — add ${failed === 1 ? 'it' : 'them'} again in Edit.` : ''}${sourceNote}`;
      // Show the numbers that were made for this client.
      const nums = [created.clientCode && `Client ID ${created.clientCode}`, created.agreementId && `Agreement ${created.agreementId}`].filter(Boolean).join(' · ');
      // The BDE's one big button: save, make the agreement, and hand the client to Purna Sir.
      let sentNote = '';
      if (sendToHr) {
        try {
          await api.post(`/agreement-flow/${created.id}/action`, { action: 'send_to_hr' });
          sentNote = ` Sent to ${hrLabel}. ${hrLabel} fills Tax & billing and sends it on.`;
        } catch (e) { sentNote = ` It is saved, but not sent to ${hrLabel} yet: ${e.response?.data?.error || 'please try again from the client page.'}`; }
      }
      const msg = sendToHr ? `Saved. ${created.name} added.${sentNote}${docNote}` : mode === 'draft'
        ? `Saved for later${nums ? ` (${nums})` : ''}.${created.missing?.length ? ` Still missing: ${created.missing.join(', ')}.` : ''}${docNote}`
        : `Saved. ${created.name} added${nums ? ` (${nums})` : ''} and the agreement is ready${created.agreementMatchesPreview === true ? ' — exactly as previewed' : ''}.${docNote}`;
      onSaved?.(created, msg);
      navigate(`/clients/${created.id}?tab=agreement&saved=${sendToHr ? 'create' : mode}`);
    } catch (err) {
      setSaving('');
      const d = err.response?.data || {};
      // The server asks the same question the form shows (409), or says what the confirmed add still needs (400 with the question).
      if ((err.response?.status === 409 || d.question) && (d.question || d.duplicates)) {
        dup.fromServer(d);
        if (err.response?.status === 409) return askQuestion(d.question, mode, sendToHr);
        pendingSave.current = { mode, sendToHr };
        return needMore({ field: d.code === 'NEEDS_LOCATION' ? 'location' : 'separateReason', error: d.error });
      }
      if (Array.isArray(d.errors) && d.errors.length) showErrors(Object.fromEntries(d.errors.map((x) => [x.field, x.error])));
      return setError(d.error || 'Could not save the client. Please try again.');
    }
    return null;
  }

  // docfill_: the two big choices first; "Type it myself" or a read file then
  // shows the 9-section form + live agreement exactly as before.
  if (fill.entry !== 'form') {
    return (
      <FillEntryModal
        title="Add client"
        target="client"
        fill={fill}
        onClose={onClose}
        onFilled={(r) => {
          const patch = clientFieldsToForm(r.fields || {});
          if (Object.keys(patch).length) set(patch);
          setOpen((o) => ({ ...o, tax: !!(patch.gst || patch.pan || patch.billingEmail), agreement: !!(patch.agreementFeePercent || patch.specialTerms) }));
        }}
      />
    );
  }

  return (
    <Modal
      title="Add client"
      size="xwide acw-modal"
      onClose={onClose}
      footer={(
        <div className="cf-bar">
          <span className="cf-bar-note">Save for later needs only the company name. {hrAccess === 'hidden' ? `Save and send to ${hrLabel} needs the main company details; ${hrLabel} fills the rest.` : 'Save & create agreement needs the main company details. If one is missing, it is listed for you.'}</span>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={!!saving} onClick={() => save('draft')}>{saving === 'draft' ? 'Saving…' : 'Save for later'}</button>
          {hrAccess === 'edit' && <button className="btn" type="button" disabled={!!saving} onClick={() => save('create')}>{saving === 'create' ? 'Saving…' : 'Save & create agreement'}</button>}
          <button className="btn btn-primary" type="button" disabled={!!saving} onClick={() => save('create', { sendToHr: true })}>{saving === 'send' ? 'Saving…' : `Save and send to ${hrLabel}`}</button>
        </div>
      )}
    >
      <ClientDuplicateWarning dup={dup} form={form} onYes={answeredYes} onOpenExisting={openExisting} />
      <div className="acw-wrap">
        <div className="acw-form">
          <FillBanner fill={fill} names={CLIENT_FIELD_NAMES} />
          <ClientForm
            fill={fill}
            user={user}
            form={form}
            set={set}
            errors={errors}
            open={open}
            setOpen={setOpen}
            canCommercial={canCommercial}
            canEditCode={canCommercial}
            ownerLocked={ownerLocked}
            defaults={defaults}
            hrAccess={hrAccess}
            hrLabel={hrLabel}
            mode="add"
            docQueue={docQueue}
            setDocQueue={setDocQueue}
            onBlurIdentity={() => dup.check(form)}
            usedPlaces={(dup.matches || []).filter((m) => m.sameName && m.place).map((m) => m.place)}
          />
          {notice && <div className="csn-line" role="status">{notice}</div>}
          {error && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        {previewState !== 'hidden' && (
          <div className="acw-side">
            <button type="button" className="btn acw-toggle" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? 'Hide agreement preview' : 'Preview agreement'}
            </button>
            <AgreementLivePreview className={showPreview ? '' : 'is-hidden'} preview={preview} state={previewState} />
          </div>
        )}
      </div>
    </Modal>
  );
}

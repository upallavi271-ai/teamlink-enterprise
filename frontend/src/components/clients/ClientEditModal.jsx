import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { useClientDuplicateCheck, ClientDuplicateWarning } from './ClientDuplicateCheck.jsx';
import { gateConfirm, pendingLine } from '../../utils/clientLocation.js';
import ClientForm, {
  formFromClient, bodyFromForm, validateClientForm, SECTION_OF,
} from './ClientForm.jsx';
import AgreementLivePreview from '../agreements/AgreementLivePreview.jsx';
import '../agreements/agreementLink.css';
import './addClientModal.css';

// ---------------------------------------------------------------------------
// EDIT CLIENT (2026-10-05) — the SAME 9 sections as Add client
// (components/clients/ClientForm.jsx). Only the CHANGED fields are sent.
// Changing the name / GSTIN / PAN / phone / email re-runs the duplicate
// check; a collision with another client asks the friendly question ("already exists - save anyway?") and the server
// keeps the answer in the audit trail. Another LOCATION of the same company never stops a save. The Owner BDE is
// changed by an Admin only; commercial terms by Super Admin / Admin only —
// the server enforces both. Documents upload straight away here.
// The preview on the right shows how a NEW draft would look; the saved
// agreement changes only with "Make a new draft" on the Agreement tab.
// ---------------------------------------------------------------------------
const OPEN_FIRST = { basic: true, contact: true, owner: true, commercial: true };

export default function ClientEditModal({ client, canCommercial, canReassign = false, onClose, onSaved }) {
  const initial = useMemo(() => formFromClient(client), [client]);
  const [form, setForm] = useState(initial);
  const [open, setOpen] = useState(OPEN_FIRST);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState(null);
  const dup = useClientDuplicateCheck({ excludeId: client.id });
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState('loading');
  const [showPreview, setShowPreview] = useState(false);
  const seqRef = useRef(0);
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => { delete n[k]; }); return n; });
  };
  // Agreement steps (2026-10-13): who may touch sections 6-9 (Purna Sir / Admin edit; the BDE TL reads; the BDE desk does not see them).
  const [fr, setFr] = useState(null); // null = loading, false = no part in the steps
  useEffect(() => { api.get(`/agreement-flow/${client.id}`).then((r) => setFr(r.data)).catch(() => setFr(false)); }, [client.id]);
  const hrAccess = client.hrSectionsHidden ? 'hidden' : (fr === null ? 'view' : (fr && fr.rights ? (fr.rights.editHr ? 'edit' : 'view') : 'edit'));
  const hrLabel = (fr && fr.hrLabel) || 'HR';
  const locked = !!(fr && fr.rights && fr.rights.lockedCommercial);
  useEffect(() => { api.get('/clients/agreement-settings').then((r) => setDefaults(r.data)).catch(() => setDefaults(null)); }, []);

  const changedBody = () => {
    const now = bodyFromForm(form, { canCommercial, hrEditable: hrAccess === 'edit' });
    const was = bodyFromForm(initial, { canCommercial, hrEditable: hrAccess === 'edit' });
    const out = {};
    Object.keys(now).forEach((k) => { if (String(now[k] ?? '') !== String(was[k] ?? '')) out[k] = now[k]; });
    if (!canReassign) delete out.bdeOwner;
    delete out.status;
    return out;
  };

  useEffect(() => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setPreviewState('loading');
    const t = setTimeout(() => {
      const b = { ...bodyFromForm(form, { canCommercial }), clientId: client.id };
      delete b.bankAccountNo;
      api.post('/clients/agreement-preview', b)
        .then((r) => { if (seqRef.current === seq) { setPreview(r.data); setPreviewState('ready'); } })
        .catch((err) => { if (seqRef.current === seq) setPreviewState(err.response?.status === 403 ? 'hidden' : 'error'); });
    }, 400);
    return () => clearTimeout(t);
  }, [form, canCommercial, client.id]);

  function showErrors(errs) {
    setErrors(errs);
    const first = Object.keys(errs)[0];
    const sec = SECTION_OF[first];
    if (sec) setOpen((o) => ({ ...o, [sec]: true }));
    setTimeout(() => document.getElementById(`cf-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }

  // A client like this exists already: the friendly question (blue box above the form); "Yes" saves again with the confirm.
  const [notice, setNotice] = useState('');
  const waiting = useRef(false);
  function askQuestion(question) {
    waiting.current = true;
    setNotice(pendingLine(question));
    setTimeout(() => document.getElementById('csn-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return null;
  }
  function answeredYes() {
    if (waiting.current) { waiting.current = false; setNotice(''); save(); } else setNotice('Good. Press Save changes when you are ready.');
  }

  async function save() {
    setError('');
    const errs = validateClientForm(form, 'edit', { canCommercial });
    if (Object.keys(errs).length) { showErrors(errs); return setError(Object.values(errs)[0]); }
    const body = changedBody();
    if (!Object.keys(body).length) return onClose();
    const found = await dup.check(form, initial);
    if (found.question && !found.acked) return askQuestion(found.question);
    if (found.question) {
      const gate = gateConfirm(found.question, { location: form.location, reason: dup.note });
      if (!gate.ok) return setNotice(gate.error);
    }
    setNotice('');
    setSaving(true);
    try {
      const res = await api.put(`/clients/${client.id}`, { ...body, ...dup.overrideBody() });
      onSaved(res.data);
    } catch (err) {
      const d = err.response?.data || {};
      if ((err.response?.status === 409 || d.question) && (d.question || d.duplicates)) {
        dup.fromServer(d);
        askQuestion(d.question);
      } else {
        if (Array.isArray(d.errors) && d.errors.length) showErrors(Object.fromEntries(d.errors.map((x) => [x.field, x.error])));
        setError(d.error || 'Could not save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
    return null;
  }

  return (
    <Modal
      title={`Edit client — ${client.name}`}
      size="xwide acw-modal"
      onClose={onClose}
      footer={(
        <div className="cf-bar">
          <span className="cf-bar-note">Only the fields you change are saved.</span>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={saving || locked} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      )}
    >
      {locked && <div className="cf-lock" role="status">It is with {fr.waitingOn} now, so it cannot be changed. Ask {fr.waitingOn} to send it back, or ask an Admin.</div>}
      <ClientDuplicateWarning dup={dup} form={form} mergeWith={client.id} onYes={answeredYes} onOpenExisting={(m) => { if (m) { onClose(); window.location.assign(`/clients/${m.id}`); } }} />
      <div className="acw-wrap">
        <div className="acw-form">
          <ClientForm
            user={null}
            form={form}
            set={set}
            errors={errors}
            open={open}
            setOpen={setOpen}
            canCommercial={canCommercial}
            canEditCode={canCommercial}
            ownerLocked={canReassign ? null : (client.bdeOwner || 'Nobody yet')}
            defaults={defaults}
            mode="edit"
            hrAccess={hrAccess}
            hrLabel={hrLabel}
            client={client}
            onBlurIdentity={() => dup.check(form, initial)}
          />
          {notice && <div className="csn-line" role="status">{notice}</div>}
          {error && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</div>}
        </div>
        {previewState !== 'hidden' && (
          <div className="acw-side">
            <button type="button" className="btn acw-toggle" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? 'Hide agreement preview' : 'Preview agreement'}
            </button>
            <AgreementLivePreview
              className={showPreview ? '' : 'is-hidden'}
              preview={preview}
              state={previewState}
              title="How a new agreement would look"
              note="The saved agreement changes only when you press Make a new agreement on the Agreement tab."
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { useClientDuplicateCheck, ClientDuplicateWarning } from './ClientDuplicateCheck.jsx';
import ClientForm, {
  formFromClient, bodyFromForm, validateClientForm, SECTION_OF,
} from './ClientForm.jsx';
import AgreementLivePreview from '../agreements/AgreementLivePreview.jsx';
import '../agreements/agreementLink.css';

// ---------------------------------------------------------------------------
// EDIT CLIENT (2026-10-05) — the SAME 9 sections as Add client
// (components/clients/ClientForm.jsx). Only the CHANGED fields are sent.
// Changing the name / GSTIN / PAN / phone / email re-runs the duplicate
// check, and the server refuses a same-GSTIN / PAN / name collision unless
// "Save anyway" was clicked (audit-logged with the note). The Owner BDE is
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
  useEffect(() => { api.get('/clients/agreement-settings').then((r) => setDefaults(r.data)).catch(() => setDefaults(null)); }, []);

  const changedBody = () => {
    const now = bodyFromForm(form, { canCommercial });
    const was = bodyFromForm(initial, { canCommercial });
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

  async function save() {
    setError('');
    const errs = validateClientForm(form, 'edit', { canCommercial });
    if (Object.keys(errs).length) { showErrors(errs); return setError(Object.values(errs)[0]); }
    const body = changedBody();
    if (!Object.keys(body).length) return onClose();
    const found = await dup.check(form, initial);
    if (found.matches.length && !found.acked) {
      return setError('This client may already exist. Open it above, or press Save anyway.');
    }
    setSaving(true);
    try {
      const res = await api.put(`/clients/${client.id}`, { ...body, ...dup.overrideBody() });
      onSaved(res.data);
    } catch (err) {
      const d = err.response?.data || {};
      if (err.response?.status === 409 && d.duplicates) {
        dup.fromServer(d);
        setError(d.error);
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
      size="xwide"
      onClose={onClose}
      footer={(
        <div className="cf-bar">
          <span className="cf-bar-note">Only the fields you change are saved.</span>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      )}
    >
      <ClientDuplicateWarning dup={dup} anywayLabel="Save anyway" subject="this client" mergeWith={client.id} />
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
            client={client}
            onBlurIdentity={() => dup.check(form, initial)}
          />
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
              title="How a new draft would look"
              note="The saved agreement changes only when you press Make a new draft on the Agreement tab."
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import TeamLinkSeal from './TeamLinkSeal.jsx';
import '../clients/agreementStep.css';

// ---------------------------------------------------------------------------
// SPEC 6 — AGREEMENT SETTINGS (Super Admin / Admin change; others read).
// The defaults every NEW client's agreement draft starts with, the template,
// and the renewal alert. GET / PUT /clients/agreement-settings — the server
// checks who may change them. The template text is still a PLACEHOLDER until
// the user decides #9; the screen says so plainly.
// ---------------------------------------------------------------------------
export function AgreementSettingsButton({ label = 'Agreement settings', className = 'btn btn-sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <AgreementSettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export default function AgreementSettingsDialog({ onClose }) {
  const [s, setS] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/clients/agreement-settings')
      .then((r) => {
        setS(r.data);
        setForm({
          feePercent: r.data.feePercent, guaranteeDays: r.data.guaranteeDays, paymentDays: r.data.paymentDays,
          renewalDays: (r.data.renewalDays || []).join(', '), renewalEmail: !!r.data.renewalEmail,
          // The old "[… to be confirmed]" placeholders show as empty boxes.
          templateNote: r.data.placeholder ? '' : (r.data.templateNote || ''),
          signatoryName: /^\[.*\]$/.test(String(r.data.signatoryName || '').trim()) ? '' : (r.data.signatoryName || ''),
          signatoryTitle: /^\[.*\]$/.test(String(r.data.signatoryTitle || '').trim()) ? '' : (r.data.signatoryTitle || ''),
          linkDays: r.data.linkDays || 14,
          activeReminderTime: r.data.activeReminderTime || '10:00',
          activeReminderEveryDays: r.data.activeReminderEveryDays || 1,
          activeReminderEmail: !!r.data.activeReminderEmail,
        });
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not open the agreement settings.'));
  }, []);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const edit = !!s?.canEdit;

  async function save() {
    setError(''); setSaved(''); setSaving(true);
    try {
      const r = await api.put('/clients/agreement-settings', {
        ...form,
        feePercent: Number(form.feePercent),
        guaranteeDays: Number(form.guaranteeDays),
        paymentDays: Number(form.paymentDays),
        linkDays: Number(form.linkDays),
        activeReminderEveryDays: Number(form.activeReminderEveryDays),
        renewalDays: String(form.renewalDays).split(/[,\s]+/).filter(Boolean).map(Number),
      });
      setS(r.data);
      setSaved(r.data.changed?.length ? 'Saved. New clients get these terms from now on.' : 'Saved. Nothing changed.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save. Try again.');
    }
    setSaving(false);
  }

  return (
    <Modal
      title="Agreement settings"
      size="wide"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {edit && <button type="button" className="btn btn-primary" disabled={saving || !form} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
        </>
      )}
    >
      {!form ? (
        error ? <div className="error-text">{error}</div> : <div className="small-muted">Loading…</div>
      ) : (
        <>
          <div className="section-label" style={{ marginTop: 0 }}>Every new client starts with</div>
          <div className="agr6-form">
            <label className="field"><span>Fee %</span><input type="number" step="0.01" min="0" max="100" disabled={!edit} value={form.feePercent} onChange={(e) => set({ feePercent: e.target.value })} /></label>
            <label className="field"><span>Guarantee (days)</span><input type="number" step="1" min="0" disabled={!edit} value={form.guaranteeDays} onChange={(e) => set({ guaranteeDays: e.target.value })} /></label>
            <label className="field"><span>Payment within (days)</span><input type="number" step="1" min="0" disabled={!edit} value={form.paymentDays} onChange={(e) => set({ paymentDays: e.target.value })} /></label>
          </div>
          <div className="small-muted" style={{ fontSize: 12 }}>Changing these does not change agreements already made.</div>

          <div className="section-label">Template</div>
          <div style={{ fontSize: 13 }}>{`${s.templateName} — your Word document, used for every new agreement.`}</div>
          <label className="field"><span>Note about the template (optional)</span><textarea rows="2" disabled={!edit} value={form.templateNote} placeholder="e.g. Updated in Oct 2026" onChange={(e) => set({ templateNote: e.target.value })} /></label>

          <div className="section-label" id="agr-teamlink-signer">TeamLink signer (printed on every agreement)</div>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Name and Designation are printed under "Team link Consultants (OPC) PVT. LTD.". The date is filled when TeamLink signs.
            Press Save at the bottom for the name and designation; the signature and stamp save with their own buttons.
          </div>
          <div className="grid-2">
            <label className="field"><span>Name</span><input disabled={!edit} value={form.signatoryName} placeholder="e.g. Vasu Chitturi" onChange={(e) => set({ signatoryName: e.target.value })} /></label>
            <label className="field"><span>Designation</span><input disabled={!edit} value={form.signatoryTitle} placeholder="e.g. Director" onChange={(e) => set({ signatoryTitle: e.target.value })} /></label>
          </div>
          {edit && <TeamLinkSeal mode="settings" signerName={form.signatoryName} signerTitle={form.signatoryTitle} />}

          <div className="section-label">Agreement link</div>
          <label className="field"><span>A new link works for (days)</span><input type="number" step="1" min="1" max="90" disabled={!edit} value={form.linkDays} onChange={(e) => set({ linkDays: e.target.value })} /></label>

          <div className="section-label">After the client signs</div>
          <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>
            The client's BDE, every Admin and Super Admin get a bell notice to sign &amp; stamp for TeamLink and make it Active — and a reminder until it is.
          </div>
          <div className="grid-2">
            <label className="field"><span>Remind at (time)</span><input type="time" disabled={!edit} value={form.activeReminderTime} onChange={(e) => set({ activeReminderTime: e.target.value })} /></label>
            <label className="field"><span>Remind every (days)</span><input type="number" min="1" max="30" step="1" disabled={!edit} value={form.activeReminderEveryDays} onChange={(e) => set({ activeReminderEveryDays: e.target.value })} /></label>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} disabled={!edit} checked={form.activeReminderEmail} onChange={(e) => set({ activeReminderEmail: e.target.checked })} />
            Also email staff (off by default — the bell notice always goes; the client is never emailed)
          </label>

          <div className="section-label">Renewal alert</div>
          <label className="field"><span>Alert the BDE and Admin this many days before the end</span><input disabled={!edit} value={form.renewalDays} onChange={(e) => set({ renewalDays: e.target.value })} placeholder="30, 7" /></label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" style={{ width: 'auto' }} disabled={!edit} checked={form.renewalEmail} onChange={(e) => set({ renewalEmail: e.target.checked })} />
            Also send the alert by email (off by default — the bell alert always goes)
          </label>
          {!edit && <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>Only a Super Admin or Admin changes these.</div>}
          {s.updatedByName && <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>{`Last changed by ${s.updatedByName}`}</div>}
          {error && <div className="error-text" role="alert">{error}</div>}
          {saved && <div className="notice" style={{ marginTop: 8 }}>{saved}</div>}
        </>
      )}
    </Modal>
  );
}

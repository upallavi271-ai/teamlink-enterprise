import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import ClientForm, { formFromClient, bodyFromForm, validateClientForm, HR_BODY_KEYS } from '../components/clients/ClientForm.jsx';
import AgreementFlow, { StageChip } from '../components/agreements/AgreementFlow.jsx';
import '../components/agreements/agreementFlow.css';

// ---------------------------------------------------------------------------
// THE AGREEMENT STEPS - the HR (Purna Sir) side (user, 2026-10-13). No sidebar entry: it opens from the bell,
// the dashboard card "Agreements waiting for you" and the Clients list.
//   /tax-billing        what waits for me
//   /tax-billing/:id    one client: its name and basics (read only) + sections 6 Tax & billing, 7 Payment
//                          details, 8 Documents, 9 Notes to fill, then "Send to BDE TL".
// He never sees the fee, guarantee or payment terms (the server does not send them).
// ---------------------------------------------------------------------------
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');

export function WaitingRows({ rows }) {
  return (
    <div className="af-wait-list">
      {rows.map((r) => (
        <div className="af-wait-row" key={r.id}>
          <div className="af-grow">
            <b>{r.name}</b> {r.clientCode && <span className="small-muted">· {r.clientCode}</span>}
            <div className="small-muted">{r.todo}{r.from ? ` · from ${r.from}` : ''}{r.since ? ` · ${when(r.since)}` : ''}</div>
            {r.reason && <div className="af-back">Sent back: {r.reason}</div>}
          </div>
          <StageChip label={r.stageLabel} colour={r.stage === 'DRAFT' ? 'red' : 'orange'} />
          <Link className="btn btn-primary btn-sm" to={r.stage === 'WITH_HR' ? `/tax-billing/${r.id}` : `/clients/${r.id}?tab=agreement`}>Open</Link>
        </div>
      ))}
    </div>
  );
}

export function AgreementFlowList() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/agreement-flow/waiting').then((r) => setD(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load.'));
  }, []);
  return (
    <div className="page-narrow">
      <h2 style={{ marginBottom: 4 }}>Agreements waiting for you</h2>
      <div className="small-muted" style={{ marginBottom: 12 }}>Open one, do your part, and send it to the next person.</div>
      {err && <div className="error-text" role="alert">{err}</div>}
      {d && d.rows.length === 0 && <div className="notice">Nothing is waiting for you. New ones appear here and in your bell.</div>}
      {d && d.rows.length > 0 && <WaitingRows rows={d.rows} />}
    </div>
  );
}

export default function AgreementFlowPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { client, editable, stage }
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [open, setOpen] = useState({ tax: true, payment: true, docs: true, notes: true });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [hrLabel, setHrLabel] = useState('HR');
  const [dupAsk, setDupAsk] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const load = () => {
    api.get(`/agreement-flow/${id}/hr`)
      .then((r) => { setData(r.data); setForm(formFromClient(r.data.client)); setErr(''); })
      .catch((e) => setErr(e.response?.data?.error || 'This client is not waiting for you.'));
  };
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get('/agreement-flow/settings').then((r) => setHrLabel(r.data.hrLabel || 'HR')).catch(() => {}); }, []);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => { delete n[k]; }); return n; });
  };

  async function save(anyway = false) {
    setNote(''); setErr('');
    const errs = validateClientForm({ ...form, name: data.client.name }, 'edit', { canCommercial: false });
    if (Object.keys(errs).length) { setErrors(errs); setErr(Object.values(errs)[0]); return false; }
    const all = bodyFromForm(form, { canCommercial: false, hrEditable: true });
    const body = {};
    HR_BODY_KEYS.forEach((k) => { if (all[k] !== undefined) body[k] = all[k]; });
    setSaving(true);
    try {
      const r = await api.put(`/agreement-flow/${id}/sections`, { ...body, ...(anyway ? { allowDuplicate: true } : {}) });
      setNote(r.data.saved ? 'Saved.' : 'Nothing changed.');
      setDupAsk(false);
      setData((d) => ({ ...d, client: r.data.client }));
      setRefresh((x) => x + 1);
      setSaving(false);
      return true;
    } catch (e) {
      const d = e.response?.data || {};
      if (e.response?.status === 409 && d.duplicates) setDupAsk(true);
      if (Array.isArray(d.errors) && d.errors.length) setErrors(Object.fromEntries(d.errors.map((x) => [x.field, x.error])));
      setErr(d.error || 'Could not save. Please try again.');
      setSaving(false);
      return false;
    }
  }
  async function saveAndSend() {
    if (!(await save())) return;
    try {
      await api.post(`/agreement-flow/${id}/action`, { action: 'send_to_tl' });
      navigate('/tax-billing', { replace: true });
    } catch (e) { setErr(e.response?.data?.error || 'It is saved, but it could not be sent on.'); setRefresh((x) => x + 1); }
  }
  async function showPreview() {
    if (preview) { setPreview(null); return; }
    try { setPreview((await api.get(`/agreement-flow/${id}/preview`)).data); } catch { setPreview({ text: 'The preview is not available.' }); }
  }

  if (err && !data) {
    return (
      <div className="page-narrow">
        <div className="notice" role="alert">{err}</div>
        <Link className="btn" to="/tax-billing">Back to the list</Link>
      </div>
    );
  }
  if (!data || !form) return <div className="page-narrow small-muted">Loading…</div>;
  const c = data.client;
  const editable = !!data.editable;

  return (
    <div className="page-narrow">
      <div style={{ marginBottom: 10 }}><Link to="/tax-billing" className="small-muted">← Agreements waiting for you</Link></div>
      <h2 style={{ marginBottom: 4 }}>{c.name} {c.clientCode && <span className="small-muted" style={{ fontSize: 13 }}>· {c.clientCode}</span>}</h2>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        {[c.industry, c.location, c.state, c.ownerDepartment && `${c.ownerDepartment} team`, c.bdeOwner && `Client manager: ${c.bdeOwner}`, c.contactName && `Contact: ${c.contactName}`].filter(Boolean).join(' · ')}
      </div>

      <AgreementFlow clientId={id} refreshKey={refresh} onChanged={() => { load(); setRefresh((x) => x + 1); }} />

      {!editable && <div className="notice">This one is not with you now. You can read it here.</div>}

      <ClientForm
        user={null}
        form={form}
        set={set}
        errors={errors}
        open={open}
        setOpen={setOpen}
        canCommercial={false}
        canEditCode={false}
        ownerLocked={c.bdeOwner || 'Nobody yet'}
        defaults={null}
        mode="edit"
        client={{ id, bankAccountMasked: c.bankAccountMasked, bankIfsc: c.bankIfsc, bankAccountHolder: c.bankAccountHolder }}
        hrAccess={editable ? 'edit' : 'view'}
        hrLabel={hrLabel}
        docsBase="/agreement-flow"
        onlySections={['tax', 'payment', 'docs', 'notes']}
      />

      <div className="af" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-sm" onClick={showPreview}>{preview ? 'Hide the agreement' : 'See the agreement (without the fee numbers)'}</button>
        {preview && (
          <>
            <div className="small-muted" style={{ margin: '6px 0' }}>{preview.note}</div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 360, overflow: 'auto' }}>{preview.text}</pre>
          </>
        )}
      </div>

      {err && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      {note && <div className="af-ok" role="status">{note}</div>}
      {dupAsk && <div className="af-actions"><button type="button" className="btn" onClick={() => save(true)}>Save anyway</button></div>}
      {editable && (
        <div className="af-actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn" disabled={saving} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={saveAndSend}>Save and send to BDE TL</button>
        </div>
      )}
    </div>
  );
}

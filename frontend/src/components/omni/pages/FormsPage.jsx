import { useCallback, useEffect, useState } from 'react';
import Combo from '../../Combo.jsx';
import { Btn, PageHead, Panel, Pill, Banner, GsModal, ConfirmModal } from '../ui.jsx';
import omni from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import FormModal from '../crm/FormModal.jsx';
import { timeLabel, errText } from '../crm/crmUtil.js';
import '../crm/crm.css';

// ---------------------------------------------------------------------------
// WEB FORMS (the prototype's "Forms"): lead-capture forms with a real public page. Real data from /api/outreach/gs/crm/forms.
// People who fill a form land in Customers (source "Form: <title>") with their permission saved per way of contact. Names only in the submissions list.
// ---------------------------------------------------------------------------
const STATUS_TONE = { New: 'warn', 'Already known': 'draft' };
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');

export default function FormsPage() {
  const { go, toast, acc } = useOmni();
  const [data, setData] = useState(null);
  const [subs, setSubs] = useState([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // { kind: 'edit' | 'del' | 'sub', form, row }
  const [embedId, setEmbedId] = useState('');
  const load = useCallback(() => {
    omni.get('/gs/crm/forms').then((r) => { setData(r); setErr(''); setEmbedId((cur) => cur || (r.forms[0] ? r.forms[0].id : '')); }).catch((e) => setErr(errText(e, 'The forms could not be loaded.')));
    omni.get('/gs/crm/forms/submissions', { limit: 10 }).then((r) => setSubs(r.rows)).catch(() => setSubs([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const forms = data ? data.forms : [];
  const needle = q.toLowerCase().trim();
  const rows = forms.filter((f) => !needle || f.title.toLowerCase().includes(needle) || f.description.toLowerCase().includes(needle));
  const del = async () => {
    const f = modal.form; setModal(null);
    try { await omni.del(`/gs/crm/forms/${f.id}`); toast(`${f.title} deleted`); load(); } catch (e) { toast(errText(e, 'It could not be deleted.')); }
  };
  const embedForm = forms.find((f) => f.id === embedId) || null;
  const link = embedForm ? `${origin()}${embedForm.path}` : '';
  const code = embedForm ? `<iframe src="${link}" width="100%" height="680" style="border:0" title="${embedForm.title.replace(/"/g, '&quot;')}"></iframe>` : '';
  const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast('Select the text and copy it by hand.'); } };
  return (
    <div id="forms">
      <PageHead eyebrow="Lead capture" title="Forms" lead="Manage templates and custom fields for your customers.">
        {data && data.canCreate && <Btn primary onClick={() => setModal({ kind: 'edit', form: null })}>＋ New Form</Btn>}
      </PageHead>
      {err && <Banner tone="error">{err}</Banner>}
      {data && !data.canCreate && !forms.length && <Banner>Forms are made by Team Leads, client managers and Admins. Yours will show here when you are named on one.</Banner>}
      <input className="search" style={{ width: '100%', marginBottom: 12 }} placeholder="Search forms..." aria-label="Search forms" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card table-card">
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 820 }}>
            <thead><tr><th>Form Title</th><th>Description</th><th>Custom Fields</th><th>Permitted Members</th><th>Data</th><th>Actions</th></tr></thead>
            <tbody>
              {!data && !err && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px 0' }}>Loading…</td></tr>}
              {data && (
                <tr>
                  <td className="campaign-name">Default <span className="pill live" style={{ marginLeft: 6 }}>⛨ DEFAULT</span></td>
                  <td style={{ maxWidth: 280 }}>Every customer, however they were added: by hand, by file, from the ATS or from a form.</td>
                  <td><span className="pill draft">{data.customFieldCount} fields</span></td>
                  <td><span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Everyone who can open Customers</span></td>
                  <td><button type="button" className="tiny-btn" style={{ color: 'var(--accent)', borderColor: '#f1e2ae', background: '#fffbe6' }} onClick={() => go('customers')}>🗄 View</button></td>
                  <td />
                </tr>
              )}
              {rows.map((f) => (
                <tr key={f.id}>
                  <td className="campaign-name" style={{ overflowWrap: 'anywhere' }}>{f.title} {f.status === 'off' && <span className="pill draft" style={{ marginLeft: 6 }}>Switched off</span>}</td>
                  <td style={{ maxWidth: 280, overflowWrap: 'anywhere' }}>{f.description}</td>
                  <td><span className="pill draft">{f.fieldCount} fields</span></td>
                  <td style={{ overflowWrap: 'anywhere' }}>{f.members.length ? f.members.map((m) => m.name).join(', ') : <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>None</span>}</td>
                  <td><button type="button" className="tiny-btn" style={{ color: 'var(--accent)', borderColor: '#f1e2ae', background: '#fffbe6' }} onClick={() => { toast(`Opening customer data captured by "${f.title}"`); go('customers', { form: f.id }); }}>🗄 View{f.submissions ? ` (${f.submissions})` : ''}</button></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{f.canEdit && <><button type="button" className="tiny-btn" title="Edit" aria-label={`Edit ${f.title}`} onClick={() => setModal({ kind: 'edit', form: f })}>✎</button>{' '}<button type="button" className="tiny-btn" title="Delete" aria-label={`Delete ${f.title}`} onClick={() => setModal({ kind: 'del', form: f })}>🗑</button></>}</td>
                </tr>
              ))}
              {data && !rows.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px 0' }}>{forms.length ? 'No forms match your search.' : 'No forms yet. Press "New Form" to make the first one.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Panel title="Recent submissions" sub="Every form writes straight into the CRM as a lead." right={<Btn small onClick={() => go('customers')}>Open CRM →</Btn>} style={{ marginTop: 16 }}>
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 640 }}>
            <thead><tr><th>Form</th><th>Person</th><th>Answer</th><th>Received</th><th>Status</th><th /></tr></thead>
            <tbody>
              {!subs.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '22px 0' }}>Nothing here yet. When someone fills a form, they show here.</td></tr>}
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.form}</td><td style={{ overflowWrap: 'anywhere' }}><b>{s.person}</b></td><td style={{ overflowWrap: 'anywhere' }}>{s.answer || '—'}</td><td style={{ whiteSpace: 'nowrap' }}>{timeLabel(s.at)}</td>
                  <td><Pill tone={STATUS_TONE[s.status] || 'draft'}>{s.status}</Pill></td>
                  <td><button type="button" className="tiny-btn" style={{ color: 'var(--accent)', borderColor: '#f1e2ae', background: '#fffbe6' }} onClick={() => setModal({ kind: 'sub', row: s })}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Embedding" sub="Drop this on any page, or share the hosted link." style={{ marginTop: 16 }}>
        {!embedForm ? <p style={{ fontSize: 11, color: 'var(--muted)' }}>Make a form first. Its link and embed code will show here.</p> : (
          <>
            {forms.length > 1 && <div style={{ maxWidth: 320, marginBottom: 10 }}><Combo value={embedId} onChange={(e) => setEmbedId(e.target.value)} required>{forms.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</Combo></div>}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <code style={{ flex: '1 1 320px', background: '#f3f6f4', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', fontSize: 10.5, overflowWrap: 'anywhere', lineHeight: 1.6 }}>{code}</code>
              <Btn onClick={() => copy(code, 'Embed code copied')}>⧉ Copy</Btn>
            </div>
            <p style={{ fontSize: 10.5, color: 'var(--muted)' }}>Hosted link: <a href={link} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{link}</a> <button type="button" className="link-btn" onClick={() => copy(link, 'Link copied')}>Copy link</button></p>
            {embedForm.status === 'off' && <Banner tone="warn">This form is switched off, so the link does not open until you switch it on.</Banner>}
          </>
        )}
      </Panel>

      {modal && modal.kind === 'edit' && data && <FormModal form={modal.form} catalog={data.catalog} members={data.members} channels={data.channels} defaultConsent={data.defaultConsent} onClose={() => setModal(null)} onSaved={(r, editing) => { setModal(null); toast(editing ? 'Form updated' : 'Form created'); load(); }} />}
      {modal && modal.kind === 'del' && <ConfirmModal title={`Delete "${modal.form.title}"?`} text="The link stops working at once. The people it collected stay in Customers." yes="Delete form" danger onYes={del} onNo={() => setModal(null)} />}
      {modal && modal.kind === 'sub' && (
        <GsModal title={modal.row.person} sub={`${modal.row.form} · received ${timeLabel(modal.row.at)}`} width={440} onClose={() => setModal(null)}
          foot={<>{modal.row.contactId && <Btn primary onClick={() => { setModal(null); go('customers', { form: modal.row.formId }); }}>Open in CRM</Btn>}<Btn onClick={() => setModal(null)}>Close</Btn></>}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.9 }}>
            {modal.row.answer && <li>Answer: {modal.row.answer}</li>}
            <li>Status: {modal.row.status}</li>
            <li>{modal.row.outcome === 'created' ? 'Written to the CRM as a new lead' : 'Already in the CRM: nothing already saved was replaced'}</li>
          </ul>
          <p style={{ fontSize: 10, color: 'var(--muted)' }}>{acc && acc.masked ? 'Phone numbers and emails are hidden for your login.' : 'Open the person in Customers to see the rest.'}</p>
        </GsModal>
      )}
    </div>
  );
}

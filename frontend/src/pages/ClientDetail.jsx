import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import {
  agreementStatusLabel, agreementBadgeClass, agreementIsActive, agreementIsSigned,
  stageLabel, stageBadgeClass, requirementStatusLabel, requirementBadgeClass,
  interviewStatusLabel, protoDate,
} from '../atsVocab';
import { isClientUser, can } from '../permissions';
import { inr } from '../utils/csv';
import { useClientsMeta } from '../components/clients/clientsMeta.js';
import '../components/clients/clientsrole.css';
import { RelationshipStrip, shortDate } from '../components/clients/relationship.jsx';
import ClientEditModal from '../components/clients/ClientEditModal.jsx';
import '../components/clients/clients.css';
import StatusChip from '../components/ui/StatusChip.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';
import AgreementPanel from '../components/agreements/AgreementPanel.jsx';
import PortalInviteButton from '../components/portal/PortalInviteButton.jsx';

// ---------------------------------------------------------------------------
// Client Detail.
//
// The old screen showed six fields. A client profile actually carries:
//   Company Name · Client Code · Industry · Business Type · Location · Address
//   · GST · TDS · Payment Terms · Account Manager · BDE · Agreement Status
//   · Agreement Date · Agreement Expiry · Contact Persons · Billing Contact
//   · Recruitment Contact
// and nine tabs:
//   Overview · Requirements · Candidates · Interviews · Selections · Joinings
//   · Invoices · Agreement · Activity
//
// Everything below the header comes from ONE scoped endpoint,
// GET /clients/:id/overview, which is where the redaction happens: a client
// login is never sent fee internals, salary internals, recruiter notes, AI
// evaluation detail or any other client's data. Hiding it here would be a
// courtesy; not sending it is the control.
// ---------------------------------------------------------------------------
// ONE CLIENT WORKSPACE (UX spec §8): Client Details · Agreement ·
// Requirements · Candidates · Interviews · Joining · Invoices / Accounts ·
// Activity — sections of this one page, not separate screens. Invoices /
// Accounts is drawn only for logins the server says may see accounts
// (overview.canSeeInvoices; the API does not send the rows otherwise).
// Review #3 §5 — CLIENT 360: Basic Details · GST / PAN · Locations · Contacts
// · Agreement · Assigned BDE · Assigned TL on the first tab; Requirements ·
// Candidates · Interviews · Selected · Joined · Invoices (Accounts-permitted
// only) · Activity as tabs; the Agreement workflow keeps its own tab.
// CLIENTS ROLE SPEC (2026-09-29) §5 — ONE page, "Client 360", eleven tabs.
// Which of them a login gets is the SERVER's answer (GET /clients/:id
// `tabs`): a hidden tab's rows are not in the response at all.
//   Overview · Contacts · Requirements · Candidates · Interviews ·
//   Selected / Joined · Replacements · Agreements · Invoices · Payments ·
//   Activity
const TABS = [
  ['overview', 'Overview'],
  ['contacts', 'Contacts'],
  ['requirements', 'Requirements'],
  ['candidates', 'Candidates'],
  ['interviews', 'Interviews'],
  ['selected', 'Selected / Joined'],
  ['replacements', 'Replacements'],
  ['agreement', 'Agreements'],
  ['invoices', 'Invoices'],
  ['payments', 'Payments'],
  ['activity', 'Activity'],
];
// Older links (?tab=joining / selections / joinings / joined / agreements)
// land on the tab that now carries them.
const TAB_ALIASES = {
  selections: 'selected', joining: 'selected', joinings: 'selected', joined: 'selected', details: 'overview',
  agreements: 'agreement', outstanding: 'invoices', notes: 'activity', replacement: 'replacements',
};

// "Hyderabad (3 requirements)" — the client's own location first, then every
// location its requirements (in this login's scope) are raised for.
function locationsOf(c, requirements) {
  const out = new Map();
  const add = (loc, source) => {
    const k = String(loc || '').trim();
    if (!k) return;
    const cur = out.get(k.toLowerCase()) || { name: k, client: false, reqs: 0 };
    if (source === 'client') cur.client = true; else cur.reqs += 1;
    out.set(k.toLowerCase(), cur);
  };
  add(c.location, 'client');
  (requirements || []).forEach((r) => add(r.location, 'req'));
  return [...out.values()].sort((a, b) => Number(b.client) - Number(a.client) || b.reqs - a.reqs || a.name.localeCompare(b.name));
}
// Distinct names with how many requirements carry each.
function countNames(list) {
  const m = new Map();
  list.filter(Boolean).forEach((n) => m.set(n, (m.get(n) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const EMPTY_OVERVIEW = {
  requirements: [], candidates: [], interviews: [], selections: [],
  joinings: [], replacements: [], invoices: [], payments: [], activity: [], redacted: false,
};

function Row({ k, children }) {
  return <div className="kv"><span className="k">{k}</span><span>{children || '—'}</span></div>;
}

function Empty({ cols, children }) {
  return <tr><td colSpan={cols} className="small-muted" style={{ padding: 16 }}>{children}</td></tr>;
}

export default function ClientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  // A Recruiter (or anyone without the Clients list) never opens a client —
  // the API answers 403 too (clients role spec §2 / §6).
  const allowed = can(user, 'ats', 'clients', 'Client List', 'view');
  const { meta } = useClientsMeta(user, allowed);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab') || 'overview';
  const tab = TAB_ALIASES[rawTab] || rawTab;
  const setTab = (t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });

  const [client, setClient] = useState(null);
  const [data, setData] = useState(EMPTY_OVERVIEW);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [signing, setSigning] = useState({ signedByName: '', signedByTitle: '' });
  const [signingLink, setSigningLink] = useState('');
  const [upload, setUpload] = useState({ open: false, fileName: '', document: '' });
  const [reject, setReject] = useState({ open: false, reason: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showAgreement, setShowAgreement] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activityKind, setActivityKind] = useState('all');

  function load() {
    if (!allowed) return;
    api.get(`/clients/${id}`)
      .then((res) => setClient(res.data))
      .catch((err) => setDenied(err.response?.data?.error || 'This record is not available to you'));
    api.get(`/clients/${id}/overview`)
      .then((res) => setData({ ...EMPTY_OVERVIEW, ...res.data }))
      .catch(() => setData(EMPTY_OVERVIEW));
  }
  useEffect(load, [id]);

  // FILTERS ON EVERY CLIENT 360 LIST (user notes #1 / #11, review #3 §14 /
  // §21 / §22): Search + the useful filters, More Filters ▾, chips, Sort,
  // 25/50/100 rows and a "No X match these filters — Clear filters" empty
  // state. The lists arrive whole from /clients/:id/overview (already scoped
  // and redacted by the server), so they are filtered here. TL / Recruiter /
  // BDE / Who are never offered to a client login (data.redacted).
  const internalView = !data.redacted;
  const newest = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
  const oldest = (k) => (a, b) => String(a[k] || '9999').localeCompare(String(b[k] || '9999'));
  const az = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));
  const reqLabel = (a) => a.requirementCode || a.requirementTitle;
  const reqLf = useListFilters(data.requirements, [
    { key: 'q', type: 'search', placeholder: 'Search requirement ID, title or location…', get: (r) => `${r.reqCode || ''} ${r.title || ''} ${r.location || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (r) => requirementStatusLabel(r.status) },
    { key: 'department', label: 'Department', primary: true, get: (r) => r.department },
    { key: 'location', label: 'Location', get: (r) => r.location },
    { key: 'priority', label: 'Priority', get: (r) => r.priority },
    { key: 'tl', label: 'TL', get: (r) => r.tlName, show: internalView },
    { key: 'recruiter', label: 'Recruiter', get: (r) => r.recruiterName, show: internalView },
    { key: 'bde', label: 'BDE', get: (r) => r.bdeName, show: internalView },
    { key: 'target', type: 'daterange', label: 'Target date', get: (r) => r.targetDate || r.closingDate },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'title', label: 'Job title A–Z', cmp: az('title') },
      { key: 'target', label: 'Target date — soonest', cmp: (a, b) => String(a.targetDate || a.closingDate || '9999').localeCompare(String(b.targetDate || b.closingDate || '9999')) },
    ],
  });
  const reqPage = usePaged(reqLf.rows);
  const candLf = useListFilters(data.candidates, [
    { key: 'q', type: 'search', placeholder: 'Search candidate, requirement or role…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''} ${a.candidateDesignation || ''}` },
    { key: 'stage', label: 'Stage', primary: true, get: (a) => stageLabel(a.stage) },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
    { key: 'location', label: 'Location', get: (a) => a.candidateLocation },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'name', label: 'Candidate A–Z', cmp: az('candidateName') },
      ...(internalView ? [{ key: 'match', label: 'Match — highest first', cmp: (a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1) }] : []),
    ],
  });
  const candPage = usePaged(candLf.rows);
  const ivLf = useListFilters(data.interviews, [
    { key: 'q', type: 'search', placeholder: 'Search interview ID, candidate or requirement…', get: (a) => `${a.interviewCode || ''} ${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (a) => (a.interviewStatus ? interviewStatusLabel(a.interviewStatus) : '') },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
    { key: 'type', label: 'Type', get: (a) => a.interviewType },
    { key: 'when', type: 'daterange', label: 'Interview date', get: (a) => a.interviewAt },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'new', label: 'Interview date — newest first', cmp: newest('interviewAt') },
      { key: 'old', label: 'Interview date — oldest first', cmp: oldest('interviewAt') },
    ],
  });
  const ivPage = usePaged(ivLf.rows);
  const selLf = useListFilters(data.selections, [
    { key: 'q', type: 'search', placeholder: 'Search candidate or requirement…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'stage', label: 'Stage', primary: true, get: (a) => stageLabel(a.stage) },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
    { key: 'joining', type: 'daterange', label: 'Joining date', get: (a) => a.joiningDate },
  ]);
  const selPage = usePaged(selLf.rows);
  const repLf = useListFilters(data.replacements, [
    { key: 'q', type: 'search', placeholder: 'Search candidate or requirement…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'case', label: 'Case', primary: true, get: (a) => a.caseStatus },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
  ]);
  const repPage = usePaged(repLf.rows);
  const payLf = useListFilters(data.payments, [
    { key: 'q', type: 'search', placeholder: 'Search invoice number or reference…', get: (p) => `${p.invoiceNumber || ''} ${p.reference || ''}` },
    { key: 'method', label: 'Method', primary: true, get: (p) => p.method, show: data.invoiceMode === 'amounts' },
    { key: 'date', type: 'daterange', label: 'Received on', primary: true, get: (p) => p.date },
  ]);
  const payPage = usePaged(payLf.rows);
  const invLf = useListFilters(data.invoices, [
    { key: 'q', type: 'search', placeholder: 'Search invoice number…', get: (i) => i.invoiceNumber || i.id },
    { key: 'status', label: 'Status', primary: true, get: (i) => i.status },
    { key: 'date', type: 'daterange', label: 'Invoice date', primary: true, get: (i) => i.invoiceDate },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'new', label: 'Invoice date — newest first', cmp: newest('invoiceDate') },
      { key: 'due', label: 'Due date — soonest', cmp: oldest('dueDate') },
    ],
  });
  const invPage = usePaged(invLf.rows);
  const actKindOf = (a) => (a.kind === 'stage' ? 'candidate' : a.kind === 'note' ? 'note' : a.entity === 'Requirement' ? 'requirement' : 'client');
  const actRows = useMemo(
    () => data.activity.filter((a) => activityKind === 'all' || actKindOf(a) === activityKind),
    [data.activity, activityKind],
  );
  const actLf = useListFilters(actRows, [
    { key: 'q', type: 'search', placeholder: 'Search what, on, note…', get: (a) => `${a.action || ''} ${a.subject || a.entity || ''} ${a.reason || ''} ${a.fromValue || ''} ${a.toValue || ''}` },
    { key: 'who', label: 'Who', primary: true, get: (a) => a.by || 'System', show: internalView },
    { key: 'when', type: 'daterange', label: 'Date range', primary: true, get: (a) => a.createdAt },
  ]);
  const actPage = usePaged(actLf.rows);

  async function agreementAction(path, body) {
    setError('');
    setNote('');
    try {
      const res = await api.post(`/clients/${id}/agreement/${path}`, body || {});
      if (res.data.signingPath) setSigningLink(`${window.location.origin}${res.data.signingPath}`);
      // Send / Resend deliver the link by Email, SMS and WhatsApp — one honest
      // result per channel (Sent / Not configured / Skipped / Failed + reason).
      if (res.data.delivery) {
        const parts = Object.entries(res.data.delivery).map(([ch, r]) => `${ch}: ${r.outcome}${r.to ? ` (${r.to})` : ''}${r.error && r.outcome !== 'Sent' ? ` — ${r.error}` : ''}`);
        const any = Object.values(res.data.delivery).some((r) => r.outcome === 'Sent');
        setNote(`${any ? 'Signing link sent.' : 'The signing link could not be delivered on any channel — copy it below and share it yourself.'} ${parts.join(' · ')}`);
      } else if (res.data.email) {
        setNote(res.data.email.emailed
          ? `Signing link emailed to ${res.data.email.to}.`
          : `Signing link NOT emailed — ${res.data.email.reason} Copy the link below and share it yourself.`);
      }
      if (res.data.autoActivated) setNote('Signed by the client (OTP verified) and countersigned by TeamLink — the agreement is now Active automatically.');
      if (res.data.requirementsWaiting) {
        setNote(`${res.data.requirementsWaiting} requirement(s) were held at Agreement Check and can now be opened.`);
      }
      load();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not complete that action');
      return false;
    }
  }

  async function confirmAgreement(e) {
    e.preventDefault();
    if (await agreementAction('confirm', signing)) setSigning({ signedByName: '', signedByTitle: '' });
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    setError('');
    try {
      await api.post(`/clients/${id}/notes`, { note: noteText.trim() });
      setNoteText('');
      setNote('Note added.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the note');
    } finally {
      setNoteSaving(false);
    }
  }

  // §6 — Admin only; the server refuses (409) while the client has an active
  // requirement, and never deletes a client that carries any history.
  async function deleteClient() {
    if (!window.confirm(`Delete ${client.name}? This cannot be undone.`)) return;
    setError('');
    try {
      await api.delete(`/clients/${id}`);
      navigate('/clients');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete this client');
    }
  }

  if (!allowed) {
    return (
      <div className="notice clrole-denied">
        Client records are not part of your role. You see the client&apos;s name on the requirements you work on.
      </div>
    );
  }
  if (denied) return <div className="notice">{denied}</div>;
  if (!client) return <div className="small-muted">Loading…</div>;

  const c = client;
  const p = c.permissions || {};
  // The lifecycle buttons are the SAME can() results the API enforces.
  const canManage = !!p.lifecycle || !!p.share;
  const mine = isClientUser(user) && user?.clientId === c.id;
  const canSign = !!p.approve && mine && ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(c.agreementStatus);
  const status = agreementStatusLabel(c.agreementStatus);
  const address = [c.houseNumber, c.street, c.landmark, c.area, c.location, c.state, c.pincode, c.country]
    .filter(Boolean).join(', ');

  const counts = {
    requirements: data.requirements.length,
    candidates: data.candidates.length,
    interviews: data.interviews.length,
    selected: data.selections.length,
    replacements: data.replacements.length,
    invoices: data.invoices.length,
    payments: data.payments.length,
    activity: data.activity.length,
  };
  // The tabs this login may open — the server's list (GET /clients/:id).
  const allowedTabs = c.tabs || data.tabs || TABS.map(([k]) => k);
  const tabOk = (k) => allowedTabs.includes(k);
  const activeTab = tabOk(tab) ? tab : 'overview';
  // Commercial terms / statutory ids reach Admin, Management, BDE, Accounts.
  const commercialLevel = !meta || meta.level === 'full' || meta.level === 'billing';
  const invoiceMode = data.invoiceMode || (data.redacted ? 'client' : 'none');
  const locations = locationsOf(c, data.requirements);
  const bdes = countNames([...data.requirements.map((r) => r.bdeName)]);
  const tls = countNames(data.requirements.map((r) => r.tlName));
  const contacts = [
    ['Primary', c.contactName, c.contactDesignation, [c.contactEmail, c.contactPhone, c.contactWhatsApp && `WhatsApp ${c.contactWhatsApp}`]],
    ['Secondary', c.secondaryContactName, c.secondaryContactDesignation, [c.secondaryContactEmail, c.secondaryContactPhone]],
    ['Billing', c.billingContactName, c.billingContactDesignation, [c.billingContactEmail, c.billingContactPhone]],
    ['Recruitment', c.recruitmentContactName, c.recruitmentContactDesignation, [c.recruitmentContactEmail, c.recruitmentContactPhone]],
    ['Agreement signatory', c.agreementSignedBy, c.agreementSignedByTitle, [c.agreementSignedAt ? `signed ${protoDate(c.agreementSignedAt)}` : null]],
  ].filter(([, name, , reach]) => name || reach.some(Boolean));

  return (
    <div>
      <Link className="small-muted" to="/clients">← Clients</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1 style={{ fontSize: 20 }}>{c.name}</h1>
          <div className="page-sub">
            {[c.displayCode, c.legalName && c.legalName !== c.name ? `Legal: ${c.legalName}` : null, c.industry, c.businessType,
              [c.location, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {p.edit && !data.redacted && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit Client</button>
          )}
          {/* User notes #4 — the client's own portal login (SA / Admin / BDE). */}
          {!data.redacted && p.assign && <PortalInviteButton kind="client" id={c.id} />}
          {p.delete && !data.redacted && (
            <button type="button" className="btn btn-sm btn-danger" onClick={deleteClient} title="Admin only — refused while the client has active requirements">Delete</button>
          )}
          <span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span>
          {tabOk('agreement') && (
            <button className="btn btn-sm" onClick={() => setShowAgreement(true)}>
              {agreementIsActive(c.agreementStatus) ? 'View Agreement' : 'Open Agreement'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {note && <div className="notice">{note}</div>}
      {data.redacted && (
        <div className="notice">
          You are signed in as {c.name}. This view shows your own company, your requirements and the
          candidates shared with you — internal recruiter notes, AI evaluation detail, fee and salary
          internals and every other client&apos;s data are not sent to this login at all.
        </div>
      )}
      {!agreementIsActive(c.agreementStatus) && counts.requirements > 0 && (
        <div className="notice amber">
          The service agreement is <b>{status}</b>. Client requirements for {c.name} cannot go live until it
          is Active.
        </div>
      )}

      {/* §24 ownership and §9 relationship numbers — the complete client
          picture before any tab is opened. Internal logins only (the server
          sends no summary to a client login). */}
      {data.summary && (
        <>
          <div className="clhead-own">
            <span>Department: <b>{c.ownerDepartment || '—'}</b></span>
            <span>Account Manager: <b>{c.accountManager || '—'}</b></span>
            <span>BDE: <b>{data.summary.bdeName || c.bdeOwner || '—'}</b></span>
            {data.summary.recruiterName !== undefined && <span>Recruiter: <b>{data.summary.recruiterName || '—'}</b></span>}
            {data.summary.workStatus !== undefined && <span>Status: <b>{data.summary.workStatus || '—'}</b></span>}
            {data.summary.health && (
              <span>Health: <span className={`clrole-health ${data.summary.health}`}>{data.summary.healthLabel}</span></span>
            )}
            {data.summary.nextAction && <span>Next: <b>{data.summary.nextAction}</b></span>}
          </div>
          <RelationshipStrip s={data.summary} onTab={setTab} guaranteePeriod={c.guaranteePeriod} tabs={allowedTabs} />
        </>
      )}

      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.filter(([key]) => tabOk(key)).map(([key, label]) => (
          <div key={key} className={`tab${activeTab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
            {counts[key] != null && counts[key] > 0 ? ` (${counts[key]})` : ''}
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'overview' && (
        <div className="two-col">
          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center' }}>
                Basic Details
                {p.edit && !data.redacted && (
                  <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>Edit</button>
                )}
              </h3>
              <div className="grid-2">
                <div>
                  <Row k="Client ID">
                    {c.displayCode}
                    {!c.clientCode && c.displayCode ? <span className="small-muted" style={{ fontSize: 11 }}> (display code)</span> : null}
                  </Row>
                  <Row k="Display Name">{c.name}</Row>
                  <Row k="Legal Name">{c.legalName}</Row>
                  <Row k="Industry">{c.industry}</Row>
                  <Row k="Business Type">{c.businessType}</Row>
                </div>
                <div>
                  <Row k="Client Type">{c.clientType}</Row>
                  <Row k="Department">{c.ownerDepartment}</Row>
                  <Row k="Website">{c.website}</Row>
                  <Row k="Status"><StatusChip status={c.status || '—'} />{c.priority ? <span className="small-muted" style={{ fontSize: 11 }}>{` · ${c.priority} priority`}</span> : null}</Row>
                  <Row k="Since">{c.activeDate || (c.createdAt ? protoDate(c.createdAt) : null)}</Row>
                </div>
              </div>
            </div>

            {commercialLevel && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>GST / PAN</h3>
              <div className="grid-2">
                <div>
                  <Row k="GSTIN">{c.gst}</Row>
                  <Row k="PAN">{c.pan}</Row>
                  <Row k="TAN">{c.tan}</Row>
                </div>
                <div>
                  <Row k="GST %">{c.gstPercent != null ? `${c.gstPercent}%` : null}</Row>
                  <Row k="TDS">{c.tdsPercent != null ? `${c.tdsPercent}%` : null}</Row>
                  <Row k="Payment Terms">{c.paymentTerms}</Row>
                </div>
              </div>
              {!data.redacted && (
                <>
                  <Row k="Placement Fee">{c.agreementFeePercent != null ? `${c.agreementFeePercent}% of annual CTC` : null}</Row>
                  <Row k="Invoice Trigger">{c.invoiceTrigger}</Row>
                  <Row k="Guarantee Period">{c.guaranteePeriod}</Row>
                </>
              )}
            </div>
            )}

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>{`Locations (${locations.length})`}</h3>
              <Row k="Address">{address}</Row>
              {locations.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {locations.map((l) => (
                    <span key={l.name} className="clrel-pill" title={l.client ? 'The client\'s own location' : 'Where its requirements are raised'}>
                      {l.name}
                      {l.client ? ' · head office' : ''}
                      {l.reqs ? ` · ${l.reqs} req` : ''}
                    </span>
                  ))}
                </div>
              ) : <div className="small-muted">No location recorded.</div>}
            </div>

            {tabOk('contacts') ? (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>{`Contacts (${contacts.length})`}</h3>
                {contacts.length
                  ? <Row k={contacts[0][0]}>{[contacts[0][1], contacts[0][2]].filter(Boolean).join(' · ')}</Row>
                  : <div className="small-muted">No contact recorded.</div>}
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setTab('contacts')}>
                  Open Contacts →
                </button>
              </div>
            ) : (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>{`Contacts (${contacts.length})`}</h3>
              {contacts.length ? contacts.map(([label, name, desig, reach]) => (
                <div key={label} style={{ marginBottom: 6 }}>
                  <div className="section-label" style={{ margin: '4px 0 2px' }}>{label}</div>
                  <Row k="Name">{[name, desig].filter(Boolean).join(' · ')}</Row>
                  <Row k="Reach">{reach.filter(Boolean).join(' · ')}</Row>
                </div>
              )) : <div className="small-muted">No contact recorded on this client or its agreement.</div>}
            </div>
            )}
          </div>

          <div>
            {tabOk('agreement') && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement</h3>
              <Row k="Status"><StatusChip status={status} tone={agreementIsActive(c.agreementStatus) ? 'green' : ['EXPIRED', 'REJECTED'].includes(c.agreementStatus) ? 'red' : 'amber'} /></Row>
              <Row k="Agreement ID">{c.agreementId}</Row>
              <Row k="Agreement Date">{c.agreementStart || (c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : null)}</Row>
              <Row k="Agreement Expiry">{c.agreementEnd}</Row>
              <Row k="Template">{c.agreementTemplate}</Row>
              <div className="divider" />
              <button className="btn btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setTab('agreement')}>
                Go to the agreement workflow →
              </button>
            </div>
            )}
            {!data.redacted && (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Assigned BDE</h3>
                <Row k="Client owner (BDE)">{c.bdeOwner || data.summary?.bdeName}</Row>
                <Row k="Account Manager">{c.accountManager}</Row>
                {bdes.length > 0 && (
                  <Row k="On its requirements">{bdes.map(([n, k]) => `${n} (${k})`).join(', ')}</Row>
                )}
              </div>
            )}
            {!data.redacted && (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Assigned TL</h3>
                {tls.length
                  ? tls.map(([n, k]) => <Row key={n} k={n}>{`${k} requirement${k === 1 ? '' : 's'}`}</Row>)
                  : <div className="small-muted">No TL on this client&apos;s requirements (in your scope).</div>}
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setTab('requirements')}>
                  {`Requirements (${counts.requirements}) →`}
                </button>
              </div>
            )}
            {!data.redacted && commercialLevel && (
              <div className="card">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Risk</h3>
                <Row k="Risk Flag">{c.riskFlag}</Row>
                <Row k="Notes">{c.riskNotes}</Row>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §5 Contacts — Admin / BDE full, Management read, a TL the NAMES
          only, Accounts the billing contact. The API sends only those
          fields, so what is not sent simply is not drawn. */}
      {activeTab === 'contacts' && (() => {
        const cards = [
          ['Primary (HR)', c.contactName, c.contactDesignation, c.contactPhone, c.contactEmail, c.contactWhatsApp],
          ['Secondary', c.secondaryContactName, c.secondaryContactDesignation, c.secondaryContactPhone, c.secondaryContactEmail],
          ['Billing', c.billingContactName, c.billingContactDesignation, c.billingContactPhone, c.billingContactEmail],
          ['Recruitment', c.recruitmentContactName, c.recruitmentContactDesignation, c.recruitmentContactPhone, c.recruitmentContactEmail],
        ].filter(([, n, , ph, em]) => n || ph || em);
        const tel = (v) => String(v).replace(/[^\d+]/g, '');
        return (
          <>
            {meta?.level === 'names' && <div className="notice">Contact names only — phone numbers and e-mails are with the BDE team.</div>}
            {meta?.level === 'billing' && <div className="notice">The billing contact — the other client contacts are with the BDE team.</div>}
            {cards.length ? (
              <div className="clrole-contacts">
                {cards.map(([label, name, desig, phone, email, wa]) => (
                  <div key={label} className="card">
                    <div className="role">{label}</div>
                    <div className="who">{name || '—'}</div>
                    {desig && <Row k="Designation">{desig}</Row>}
                    {phone && <Row k="Phone"><a href={`tel:${tel(phone)}`}>{phone}</a></Row>}
                    {email && <Row k="Email"><a href={`mailto:${email}`}>{email}</a></Row>}
                    {wa && <Row k="WhatsApp">{wa}</Row>}
                  </div>
                ))}
              </div>
            ) : <div className="small-muted">No contact recorded for this client.</div>}
          </>
        );
      })()}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'requirements' && (
        <>
        {!data.redacted && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 8 }}>
            <Link className="btn btn-sm" to={`/requirements?clientId=${encodeURIComponent(c.id)}`}>Open in Jobs / Requirements</Link>
            {meta?.actions?.newRequirement && (
              <Link className="btn btn-sm btn-primary" to={`/requirements?new=1&clientId=${encodeURIComponent(c.id)}`}>+ New Requirement</Link>
            )}
          </div>
        )}
        <ListFilterBar lf={reqLf} storageKey="cl360-req" noun="requirements" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement ID</th><th>Job Title</th><th>Department</th><th>Location</th>
                <th>Openings</th><th>Priority</th>
                {!data.redacted && <><th>TL</th><th>Recruiter</th><th>BDE</th></>}
                <th>Target Date</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reqPage.slice.map((r) => (
                <tr key={r.id} className="row-link">
                  <td><Link to={`/requirements/${r.id}`}>{r.reqCode || r.id.slice(0, 8)}</Link></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{r.department || '—'}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.openings}</td>
                  <td className="cell-muted">{r.priority}</td>
                  {!data.redacted && <><td className="cell-muted">{r.tlName || '—'}</td><td className="cell-muted">{r.recruiterName || '—'}</td><td className="cell-muted">{r.bdeName || '—'}</td></>}
                  <td className="cell-muted">{r.targetDate || r.closingDate || '—'}</td>
                  <td><span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span></td>
                </tr>
              ))}
              {!data.requirements.length && <Empty cols={10}>No requirements in your scope for this client.</Empty>}
              {data.requirements.length > 0 && !reqLf.rows.length && <tr><td colSpan={11} style={{ padding: 0 }}><ListEmpty lf={reqLf} noun="requirements" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={reqPage} noun="requirements" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'candidates' && (
        <>
          {data.redacted && (
            <div className="notice">
              Candidates shared with you. Resume scores, AI evaluation detail, recruiter notes, sourcing
              channel and salary expectations are internal and are not part of this response.
            </div>
          )}
          <ListFilterBar lf={candLf} storageKey="cl360-cand" noun="candidates" />
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th><th>Requirement</th><th>Location</th><th>Experience</th>
                  <th>Current Role</th>
                  {!data.redacted && <><th>Match</th><th>AI Score</th></>}
                  <th>Stage</th><th />
                </tr>
              </thead>
              <tbody>
                {candPage.slice.map((a) => (
                  <tr key={a.id}>
                    <td>{a.candidateName}</td>
                    <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                    <td className="cell-muted">{a.candidateLocation || '—'}</td>
                    <td className="cell-muted">{a.candidateExperience != null ? `${a.candidateExperience} yrs` : '—'}</td>
                    <td className="cell-muted">{a.candidateDesignation || '—'}</td>
                    {!data.redacted && (
                      <>
                        <td className="cell-muted">{a.matchScore != null ? `${a.matchScore}%` : '—'}</td>
                        <td className="cell-muted">{a.aiInterviewScore != null ? `${a.aiInterviewScore}%` : '—'}</td>
                      </>
                    )}
                    <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                    <td><Link className="btn btn-sm" to={`/candidates/${a.candidateId}`}>View</Link></td>
                  </tr>
                ))}
                {!data.candidates.length && <Empty cols={9}>No candidates yet.</Empty>}
                {data.candidates.length > 0 && !candLf.rows.length && <tr><td colSpan={9} style={{ padding: 0 }}><ListEmpty lf={candLf} noun="candidates" /></td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={candPage} noun="candidates" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'interviews' && (
        <>
        <ListFilterBar lf={ivLf} storageKey="cl360-iv" noun="interviews" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Interview</th><th>Candidate</th><th>Requirement</th><th>When</th><th>Round</th><th>Type / Mode</th><th>Interviewer</th><th>Status</th><th>Result</th></tr>
            </thead>
            <tbody>
              {ivPage.slice.map((a) => (
                <tr key={a.id}>
                  <td>{a.interviewCode || '—'}</td>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                  <td className="cell-muted">{a.interviewAt ? protoDate(a.interviewAt) : '—'}</td>
                  <td className="cell-muted">{a.interviewRound || '—'}</td>
                  <td className="cell-muted">{[a.interviewType, a.interviewMode].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="cell-muted">{a.interviewer || '—'}</td>
                  <td><span className="status review">{interviewStatusLabel(a.interviewStatus)}</span></td>
                  <td className="cell-muted">{a.interviewResult || '—'}</td>
                </tr>
              ))}
              {!data.interviews.length && <Empty cols={9}>No interviews scheduled for this client yet.</Empty>}
              {data.interviews.length > 0 && !ivLf.rows.length && <tr><td colSpan={9} style={{ padding: 0 }}><ListEmpty lf={ivLf} noun="interviews" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={ivPage} noun="interviews" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'selected' && (
        <>
        <div className="section-label" style={{ marginTop: 0 }}>{`Selected / offer / joined (${data.selections.length})`}</div>
        <ListFilterBar lf={selLf} storageKey="cl360-sel" noun="candidates" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Candidate</th><th>Requirement</th><th>Stage</th>{!data.redacted && <th>Offered CTC</th>}<th>Joining Date</th></tr>
            </thead>
            <tbody>
              {selPage.slice.map((a) => (
                <tr key={a.id}>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">{a.requirementCode || a.requirementTitle}</td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  {!data.redacted && <td className="cell-muted">{a.offeredCtc != null ? `₹${a.offeredCtc}` : '—'}</td>}
                  <td className="cell-muted">{a.joiningDate || '—'}</td>
                </tr>
              ))}
              {!data.selections.length && <Empty cols={5}>Nobody selected yet.</Empty>}
              {data.selections.length > 0 && !selLf.rows.length && <tr><td colSpan={5} style={{ padding: 0 }}><ListEmpty lf={selLf} noun="candidates" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={selPage} noun="candidates" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §5 Replacements — joinings inside the guarantee period and the
          replacement cases on the joining (Replacement Due / Replaced /
          Left after Guarantee). The guarantee end date comes only to a
          login that may see the guarantee period. */}
      {activeTab === 'replacements' && (
        <>
        <div className="section-label" style={{ marginTop: 0 }}>{`Guarantee / replacement cases (${data.replacements.length})`}</div>
        <ListFilterBar lf={repLf} storageKey="cl360-rep" noun="cases" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th><th>Requirement</th><th>Joined on</th><th>Case</th>
                {data.replacements.some((r) => r.guaranteeEnds !== undefined) && <th>Guarantee ends</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {repPage.slice.map((r) => (
                <tr key={r.id}>
                  <td>{r.candidateName || '—'}</td>
                  <td className="cell-muted">{r.requirementId ? <Link to={`/requirements/${r.requirementId}`}>{r.requirementCode || r.requirementTitle}</Link> : '—'}</td>
                  <td className="cell-muted">{r.joiningDate || '—'}</td>
                  <td><StatusChip status={r.caseStatus} tone={r.caseStatus === 'Replacement Due' ? 'red' : r.caseStatus === 'Guarantee running' ? 'amber' : 'grey'} /></td>
                  {data.replacements.some((x) => x.guaranteeEnds !== undefined) && <td className="cell-muted">{r.guaranteeEnds || '—'}</td>}
                  <td><Link className="btn btn-sm" to={`/candidates/${r.candidateId}`}>View</Link></td>
                </tr>
              ))}
              {!data.replacements.length && <Empty cols={6}>No joining is inside its guarantee period and no replacement is recorded.</Empty>}
              {data.replacements.length > 0 && !repLf.rows.length && <tr><td colSpan={6} style={{ padding: 0 }}><ListEmpty lf={repLf} noun="cases" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={repPage} noun="cases" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §6 Invoices — amounts for Admin / Management / Accounts; a BDE gets
          the STATUS only (the API sends no amount to a BDE); a TL no tab. */}
      {activeTab === 'invoices' && (
        <>
        {invoiceMode === 'status' && (
          <div className="notice">Invoice status only — amounts are with Accounts.</div>
        )}
        <ListFilterBar lf={invLf} storageKey="cl360-inv" noun="invoices" />
        <div className="tbl-wrap">
          <table>
            <thead>
              {invoiceMode === 'status' && <tr><th>Invoice</th><th>Date</th><th>Due</th><th>Status</th></tr>}
              {invoiceMode === 'client' && <tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>GST</th><th>TDS</th><th>Status</th></tr>}
              {invoiceMode === 'amounts' && (
                <tr>
                  <th>Invoice</th><th>Date</th><th>Due</th><th className="clrole-money">Amount</th><th className="clrole-money">GST</th>
                  <th className="clrole-money">TDS</th><th className="clrole-money">Total</th><th className="clrole-money">Received</th>
                  <th className="clrole-money">Outstanding</th><th>Status</th>
                </tr>
              )}
            </thead>
            <tbody>
              {invPage.slice.map((i) => (
                <tr key={i.id}>
                  <td>{invoiceMode === 'amounts' ? <Link to={`/invoices/${i.id}`}>{i.invoiceNumber || i.id.slice(0, 8)}</Link> : (i.invoiceNumber || i.id.slice(0, 8))}</td>
                  <td className="cell-muted">{i.invoiceDate}</td>
                  <td className="cell-muted">{i.dueDate || '—'}</td>
                  {invoiceMode === 'client' && (
                    <>
                      <td>{i.amount}</td>
                      <td className="cell-muted">{i.gst}</td>
                      <td className="cell-muted">{i.tds}</td>
                    </>
                  )}
                  {invoiceMode === 'amounts' && (
                    <>
                      <td className="clrole-money">{inr(i.amount)}</td>
                      <td className="clrole-money cell-muted">{inr(i.gst)}</td>
                      <td className="clrole-money cell-muted">{inr(i.tds)}</td>
                      <td className="clrole-money">{inr(i.total)}</td>
                      <td className="clrole-money">{inr(i.receivedAmount)}</td>
                      <td className={`clrole-money${i.outstanding > 0.5 ? ' bad' : ''}`}>{inr(i.outstanding)}</td>
                    </>
                  )}
                  <td><span className={`status ${i.status === 'Paid' ? 'active' : i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status}</span></td>
                </tr>
              ))}
              {!data.invoices.length && <Empty cols={10}>No invoices yet.</Empty>}
              {data.invoices.length > 0 && !invLf.rows.length && <tr><td colSpan={10} style={{ padding: 0 }}><ListEmpty lf={invLf} noun="invoices" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={invPage} noun="invoices" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Payments — receipts against this client's invoices (InvoicePayment
          lines, or the received amount recorded on the invoice). */}
      {activeTab === 'payments' && (
        <>
        {invoiceMode === 'status' && (
          <div className="notice">Which invoices have been paid, and when — amounts are with Accounts.</div>
        )}
        <ListFilterBar lf={payLf} storageKey="cl360-pay" noun="payments" />
        <div className="tbl-wrap">
          <table>
            <thead>
              {invoiceMode === 'amounts'
                ? <tr><th>Received on</th><th>Invoice</th><th className="clrole-money">Amount</th><th>Method</th><th>Reference</th><th>Recorded by</th></tr>
                : <tr><th>Received on</th><th>Invoice</th><th>Status</th></tr>}
            </thead>
            <tbody>
              {payPage.slice.map((p2) => (
                <tr key={p2.id}>
                  <td className="cell-muted">{p2.date || '—'}</td>
                  <td>{invoiceMode === 'amounts' ? <Link to={`/invoices/${p2.invoiceId}`}>{p2.invoiceNumber || p2.invoiceId.slice(0, 8)}</Link> : (p2.invoiceNumber || '—')}</td>
                  {invoiceMode === 'amounts' ? (
                    <>
                      <td className="clrole-money">{inr(p2.amount)}</td>
                      <td className="cell-muted">{p2.method || (p2.fromInvoice ? 'Recorded on the invoice' : '—')}</td>
                      <td className="cell-muted">{p2.reference || '—'}</td>
                      <td className="cell-muted">{p2.recordedBy || '—'}</td>
                    </>
                  ) : <td><StatusChip status={p2.status || 'Received'} tone="green" /></td>}
                </tr>
              ))}
              {!data.payments.length && <Empty cols={6}>No payment received yet.</Empty>}
              {data.payments.length > 0 && !payLf.rows.length && <tr><td colSpan={6} style={{ padding: 0 }}><ListEmpty lf={payLf} noun="payments" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={payPage} noun="payments" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'agreement' && (
        <div className="two-col">
          <div>
            {/* Execution: per-channel send result, signatures, OTP, TeamLink
                countersign (SA/Admin), signed PDF, audit trail. */}
            {c.agreementDocument && (
              <AgreementPanel clientId={id} refreshKey={`${c.agreementStatus}|${c.agreementSentAt || ''}|${c.agreementSignedAt || ''}`} onChanged={load} />
            )}
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Agreement workflow</h3>
              <div className="small-muted" style={{ marginBottom: 10 }}>
                Add Client → Generate → Send to client (email + SMS + WhatsApp) → client reads it and presses
                OK, Proceed → e-signs (type / draw / upload) → OTP to their registered mobile → Signed →
                TeamLink countersigns → Active
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['DRAFT', 'SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING', 'SIGNED', 'ACTIVE'].map((s) => (
                  <span
                    key={s}
                    className={`status ${c.agreementStatus === s ? agreementBadgeClass(s) : ''}`}
                    style={c.agreementStatus === s ? undefined : { background: 'var(--line-soft)', color: 'var(--ink-soft)' }}
                  >
                    {agreementStatusLabel(s)}
                  </span>
                ))}
              </div>
              {['EXPIRED', 'REJECTED'].includes(c.agreementStatus) && (
                <div className="notice amber" style={{ marginTop: 10, marginBottom: 0 }}>
                  {`This agreement is ${status}.`}
                  {c.agreementRejectedReason ? ` Reason: ${c.agreementRejectedReason}` : ''}
                  {' Regenerate or upload a new document to restart the workflow.'}
                </div>
              )}
            </div>

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Document</h3>
              <div
                style={{
                  border: '1px solid var(--line)', borderRadius: 8, padding: 16,
                  maxHeight: 360, overflowY: 'auto', background: 'var(--paper)',
                }}
              >
                {c.agreementDocument
                  ? <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.6 }}>{c.agreementDocument}</div>
                  : <div className="small-muted">No agreement generated for this client yet.</div>}
              </div>
              {!canManage && !data.redacted && !agreementIsActive(c.agreementStatus) && (
                <div className="notice amber" style={{ marginTop: 10, marginBottom: 0 }}>
                  Generating, sending and activating the agreement is done by an Admin. Until it is Active,
                  requirements for this client wait at Agreement Check.
                </div>
              )}
              {canManage && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('generate')}
                    disabled={agreementIsSigned(c.agreementStatus)}
                  >
                    {c.agreementDocument ? 'Regenerate from client data' : 'Generate Agreement'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setUpload({ open: true, fileName: '', document: c.agreementDocument || '' })}
                    disabled={agreementIsSigned(c.agreementStatus)}
                  >
                    Upload Agreement
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => agreementAction('send')}
                    disabled={!c.agreementDocument || !['DRAFT', 'REJECTED', 'EXPIRED'].includes(c.agreementStatus)}
                  >
                    Send to Client
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('resend')}
                    disabled={!['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(c.agreementStatus)}
                  >
                    Resend
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => agreementAction('request-confirmation')}
                    disabled={!['SENT', 'VIEWED'].includes(c.agreementStatus)}
                  >
                    Request Client Confirmation
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => agreementAction('activate')}
                    disabled={c.agreementStatus !== 'SIGNED'}
                  >
                    Activate Agreement
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => agreementAction('expire')}
                    disabled={!['ACTIVE', 'SIGNED'].includes(c.agreementStatus)}
                  >
                    Mark Expired
                  </button>
                </div>
              )}
              {(signingLink || c.signingPath) && (
                <div className="section" style={{ marginTop: 12 }}>
                  <div className="small-muted">Signing link for the client (no TeamLink login needed):</div>
                  <input readOnly value={signingLink || `${window.location.origin}${c.signingPath}`} onFocus={(e) => e.target.select()} style={{ width: '100%' }} />
                </div>
              )}
            </div>

            {canSign && (
              <div className="card section">
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Review &amp; e-sign</h3>
                <div className="small-muted" style={{ marginBottom: 8 }}>
                  Sign on the secure agreement page (the link in the Execution panel above): read it, press OK, Proceed,
                  sign, and confirm with the code sent to your registered mobile. You can also decline here.
                </div>
                <button className="btn btn-sm btn-danger" type="button" onClick={() => setReject({ open: true, reason: '' })}>
                  Decline the agreement
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement record</h3>
              <Row k="Status"><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></Row>
              <Row k="Agreement ID">{c.agreementId}</Row>
              <Row k="Required">{c.agreementRequired}</Row>
              <Row k="Template">{c.agreementTemplate}</Row>
              <Row k="Source">{c.agreementSource}</Row>
              <Row k="Agreement Date">{c.agreementStart}</Row>
              <Row k="Agreement Expiry">{c.agreementEnd}</Row>
              <Row k="Fee">{c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : null}</Row>
              <Row k="Signed Copy">{c.agreementSignedCopyName}</Row>
              {canManage && (
                <button
                  className="btn btn-sm"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  onClick={() => {
                    const fileName = window.prompt('File name of the signed copy you are attaching');
                    if (fileName) agreementAction('signed-copy', { fileName });
                  }}
                >
                  Attach signed copy
                </button>
              )}
            </div>
            <div className="card">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>History</h3>
              <Row k="Draft">{protoDate(c.createdAt)}</Row>
              <Row k="Sent">{c.agreementSentAt ? protoDate(c.agreementSentAt) : null}</Row>
              <Row k="Viewed">{c.agreementViewedAt ? protoDate(c.agreementViewedAt) : null}</Row>
              <Row k="Confirmation requested">{c.agreementConfirmationRequestedAt ? protoDate(c.agreementConfirmationRequestedAt) : null}</Row>
              <Row k="Signed">
                {c.agreementSignedAt
                  ? `${protoDate(c.agreementSignedAt)} · ${c.agreementSignedBy || '—'}${c.agreementSignedByTitle ? ` (${c.agreementSignedByTitle})` : ''}`
                  : null}
              </Row>
              <Row k="Active">{c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : null}</Row>
              <Row k="Rejected">{c.agreementRejectedAt ? protoDate(c.agreementRejectedAt) : null}</Row>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §23 — who, when, what and why: the client's audit rows, its
          requirements' audit rows and the pipeline events on its candidates,
          newest first. */}
      {activeTab === 'activity' && (() => {
        const KINDS = [
          ['all', 'All'],
          ['client', 'Client & agreement'],
          ['requirement', 'Requirements'],
          ['candidate', 'Candidates'],
          ['note', 'Notes'],
        ].filter(([k]) => k !== 'candidate' || tabOk('candidates'));
        const kindOf = actKindOf;
        const rows = actLf.rows;
        const time = (v) => {
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        };
        return (
          <>
            {/* §8.5 / §5 — Add Note: Admin, BDE, Accounts (own). */}
            {meta?.actions?.note && !data.redacted && (
              <div className="clrole-note">
                <textarea rows="2" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note to this client — call summary, follow-up…" />
                <button type="button" className="btn btn-sm btn-primary" disabled={noteSaving || !noteText.trim()} onClick={addNote}>{noteSaving ? 'Saving…' : 'Add Note'}</button>
              </div>
            )}
            {meta?.role === 'accounts' && <div className="small-muted" style={{ marginBottom: 8, fontSize: 12 }}>Your own notes and actions on this client.</div>}
            {!data.redacted && (
              <div className="clact-filter">
                {KINDS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm${activityKind === k ? ' btn-primary' : ''}`}
                    onClick={() => setActivityKind(k)}
                  >
                    {label}
                    {k !== 'all' ? ` (${data.activity.filter((a) => kindOf(a) === k).length})` : ''}
                  </button>
                ))}
              </div>
            )}
            <ListFilterBar lf={actLf} storageKey="cl360-act" noun="activity rows" />
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    {!data.redacted && <th>Who</th>}
                    <th>What</th><th>On</th><th>Change</th>
                    {!data.redacted && <th>Why / note</th>}
                  </tr>
                </thead>
                <tbody>
                  {actPage.slice.map((a) => (
                    <tr key={a.id}>
                      <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                        {shortDate(a.createdAt)}
                        <span className="small-muted" style={{ display: 'block', fontSize: 11 }}>{time(a.createdAt)}</span>
                      </td>
                      {!data.redacted && (
                        <td className="cell-muted">
                          {a.by || 'System'}
                          {a.byRole ? <span className="small-muted" style={{ display: 'block', fontSize: 11 }}>{a.byRole}</span> : null}
                        </td>
                      )}
                      <td>{a.action}</td>
                      <td className="cell-muted">{a.subject || a.entity}</td>
                      <td className="cell-muted" style={{ whiteSpace: 'normal', maxWidth: 380 }}>
                        {a.kind === 'stage'
                          ? [a.fromValue ? stageLabel(a.fromValue) : null, a.toValue ? stageLabel(a.toValue) : null].filter(Boolean).join(' → ') || '—'
                          : a.field
                            ? `${a.field}: ${a.fromValue || '—'} → ${a.toValue || '—'}`
                            : [a.fromValue, a.toValue].filter(Boolean).join(' → ') || '—'}
                      </td>
                      {!data.redacted && <td className="clact-why">{a.reason || '—'}</td>}
                    </tr>
                  ))}
                  {!rows.length && (actLf.activeCount
                    ? <tr><td colSpan={6} style={{ padding: 0 }}><ListEmpty lf={actLf} noun="activity" /></td></tr>
                    : <Empty cols={6}>{activityKind === 'all' ? 'No activity recorded yet.' : 'No activity of this kind yet. Choose "All" to see everything.'}</Empty>)}
                </tbody>
              </table>
            </div>
            <Pager page={actPage} noun="activity rows" />
          </>
        );
      })()}

      {editing && (
        <ClientEditModal
          client={c}
          canCommercial={!!p.commercialTerms}
          canReassign={!!meta?.actions?.reassign}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setNote('Client saved.'); load(); }}
        />
      )}

      {upload.open && (
        <Modal
          title="Upload agreement"
          size="wide"
          onClose={() => setUpload({ ...upload, open: false })}
          footer={(
            <>
              <button className="btn" onClick={() => setUpload({ ...upload, open: false })}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  if (await agreementAction('upload', { document: upload.document, fileName: upload.fileName })) {
                    setUpload({ open: false, fileName: '', document: '' });
                  }
                }}
              >
                Store uploaded agreement
              </button>
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            This app has no file store, so an uploaded agreement is kept as its text — the same field the
            generated document uses, so Preview, Send and the client signing link all keep working.
          </div>
          <label className="field">
            <span>File name</span>
            <input value={upload.fileName} onChange={(e) => setUpload({ ...upload, fileName: e.target.value })} placeholder="Orbit-MSA-signed.pdf" />
          </label>
          <label className="field">
            <span>Agreement text</span>
            <textarea rows="14" value={upload.document} onChange={(e) => setUpload({ ...upload, document: e.target.value })} />
          </label>
        </Modal>
      )}

      {reject.open && (
        <Modal
          title="Reject agreement"
          onClose={() => setReject({ open: false, reason: '' })}
          footer={(
            <>
              <button className="btn" onClick={() => setReject({ open: false, reason: '' })}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (await agreementAction('reject', { reason: reject.reason })) setReject({ open: false, reason: '' });
                }}
              >
                Reject agreement
              </button>
            </>
          )}
        >
          <label className="field">
            <span>Reason</span>
            <textarea rows="4" value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} />
          </label>
        </Modal>
      )}

      {showAgreement && (
        <Modal
          title={`Recruitment / Staffing Services Agreement — ${c.name}`}
          size="wide"
          onClose={() => setShowAgreement(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setShowAgreement(false)}>Close</button>
              <button className="btn btn-primary" onClick={() => { setShowAgreement(false); setTab('agreement'); }}>
                Open the agreement workflow →
              </button>
            </>
          )}
        >
          <div className="notice amber">
            Generated from TeamLink&apos;s standard agreement template using this client&apos;s own commercial
            terms. The client signs it through the tokenised signing link — no external e-signature or DSC
            provider is connected.
          </div>
          <Row k="Status"><span className={`status ${agreementBadgeClass(c.agreementStatus)}`}>{status}</span></Row>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 18, margin: '12px 0', maxHeight: 340, overflowY: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--navy)' }}>TeamLink Consultants</div>
              <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6 }}>RECRUITMENT / STAFFING SERVICES AGREEMENT</div>
              <div className="small-muted" style={{ fontStyle: 'italic' }}>
                {`Between ${c.name} ("Client") and TeamLink Consultants (OPC) Pvt. Ltd. ("Consultant")`}
              </div>
            </div>
            {c.agreementDocument
              ? <div className="small-muted" style={{ whiteSpace: 'pre-line', fontSize: 12, lineHeight: 1.6 }}>{c.agreementDocument}</div>
              : <div className="small-muted">No agreement generated for this client yet.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api';
import Modal from '../components/Modal.jsx';
import {
  agreementIsActive,
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
import AgreementFlow, { StageChip } from '../components/agreements/AgreementFlow.jsx';
import AgreementLinkCard from '../components/agreements/AgreementLinkCard.jsx';
import AgreementDriveCard from '../components/agreements/AgreementDriveCard.jsx';
import OwnAgreementFile from '../components/agreements/OwnAgreementFile.jsx';
import SignedAgreementFiles, { ViewAgreementButton } from '../components/agreements/SignedAgreementFiles.jsx'; // every signed agreement file kept on the client
import { agreementBlind } from '../utils/agreementPrivacy.js';
import AgreementDocView, { signersFrom } from '../components/agreements/AgreementDocView.jsx';
import TeamLinkSeal, { AuthImg } from '../components/agreements/TeamLinkSeal.jsx';
import TeamLinkSignerNotice from '../components/agreements/TeamLinkSignerNotice.jsx';
// Spec B1: Client 360 -> Portal access (who at the client can sign in).
import ClientPortalAccess from '../components/clients/ClientPortalAccess.jsx';
import ClientHistoryView from '../components/joindrop/ClientHistoryView.jsx'; // History tab: the client date by date
// Spec 6 — the agreement step badge (+ "Step N of 6").
import {
  AgreementStepChip, agreementStepLabel, agreementStepOf,
} from '../components/clients/AgreementStep.jsx';
import {
  ClientLifecycleDialog, ClientPausedBanner, LifecycleChip, lifecycleItemsFor,
} from '../components/clients/ClientLifecycle.jsx';
import ClientBusiness from '../components/clients/ClientBusiness.jsx';
// ATS layout v3 — the Performance tab, the job status chain, Signed / Unsigned.
import ClientPerformance from '../components/clients/ClientPerformance.jsx';
import ClientWork from '../components/clients/ClientWork.jsx'; // 4th tab: what is waiting on this client + all activity (2026-10-10)
import { JobStatusChip } from '../components/jobs/reqStatus.jsx';
import { agreementIsSigned } from '../atsVocab';
import ClientSlaCard from '../components/clients/ClientSlaCard.jsx'; // B9.2: per-client SLA
import ConversationView from '../components/messaging/ConversationView.jsx'; // the client's Conversation: Call / Mail / WhatsApp / SMS in one place
import WaButton from '../components/wa/WaButton.jsx'; // free WhatsApp quick chat (wa.me link)
import ContactDialog from '../components/messaging/ContactDialog.jsx';// Message the client contact: Call / Mail / WhatsApp / SMS with templates
import useMayMessage from '../components/messaging/useMayMessage.js'; // the server says who may message clients
import { rowClickProps } from '../utils/rowClick.js';
import '../components/clients/ccr.css';

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
// SPEC 6 (2026-10-03) + simplicity checklist — Client 360 is ONE page with
// seven plain tabs: Overview · Jobs · People sent · Agreement · Invoices ·
// Notes · Contacts. "Interviews", "Selected / joined" and "Guarantee cases"
// sit inside People sent, Payments inside Invoices, Portal access inside
// Contacts. Server keys stay the same (GET /clients/:id `tabs` decides; a
// section a role may not open is HIDDEN). The third value lists the server
// keys a merged tab also carries.
// ATS LAYOUT v3 (2026-10-03) — THREE tabs. The seven older ones are folded
// in as SECTIONS, nothing dropped:
//   Details & Agreement  Details · Contacts · Portal access · Agreement
//                        (steps, terms, document, signing) · Notes & history
//   Requirements         the client's jobs: openings, filled, recruiters, status
//   Performance          sent / interviewed / joined, rejection reasons, money,
//                        and the lists behind them (People sent, Interviews,
//                        Selected and joined, Guarantee cases, Invoices, Payments)
// The third value lists the server tab keys (GET /clients/:id `tabs`) a tab
// carries; a tab shows when the login may open ANY of them, and each section
// inside still checks its own key (a hidden section's rows are not sent).
const TABS = [
  ['details', 'Details & Agreement', ['overview', 'contacts', 'portal', 'agreement', 'activity']],
  ['requirements', 'Requirements', []],
  ['performance', 'Performance', ['candidates', 'interviews', 'selected', 'replacements', 'invoices', 'payments']],
  // Shown only when GET /clients/:id/work answers (the internal client desk); see tabShown.
  ['work', 'Client work', []],
  // 2026-10-17: what happened with this client, date by date (the server cuts it for each login: agreement steps, logins and invoices only for those who may see them).
  ['history', 'History', []],
];
// Every older link (?tab=overview / contacts / agreement / candidates /
// invoices / joining / payments …) lands on the tab that now carries it, and
// the page scrolls to that section (SECTION_OF).
const TAB_ALIASES = {
  overview: 'details', contacts: 'details', portal: 'details', agreement: 'details', agreements: 'details',
  activity: 'details', notes: 'details',
  jobs: 'requirements',
  candidates: 'performance', people: 'performance', interviews: 'performance', selected: 'performance',
  selections: 'performance', joining: 'performance', joinings: 'performance', joined: 'performance',
  replacements: 'performance', replacement: 'performance', invoices: 'performance', payments: 'performance',
  outstanding: 'performance',
};
// Which section an older key scrolls to (ids: ccr-sec-<key>).
const SECTION_OF = {
  contacts: 'contacts', portal: 'portal', agreement: 'agreement', agreements: 'agreement', activity: 'activity', notes: 'activity',
  candidates: 'candidates', people: 'candidates', interviews: 'interviews', selected: 'selected', selections: 'selected',
  joining: 'selected', joinings: 'selected', joined: 'selected', replacements: 'replacements', replacement: 'replacements',
  invoices: 'invoices', payments: 'payments', outstanding: 'invoices',
};
// The Performance lists: People (sent · interviews · selected · guarantee) or Money (invoices · payments).
const MONEY_SECTIONS = ['invoices', 'payments'];

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

// 12 Oct 2026 - the joining date everywhere (user, 2026-10-17). A joined person shows the day they joined; someone not joined yet shows the planned day.
const dmyDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}` : null; };
const joinCellText = (a) => (['JOINED', 'HIRED'].includes(a.stage) ? (dmyDay(a.joinedDay || a.joiningDate) || 'Not recorded') : (dmyDay(a.joiningDate) ? `${dmyDay(a.joiningDate)} (planned)` : 'Not recorded'));

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
  const rawTab = params.get('tab') || 'details';
  const tab = TAB_ALIASES[rawTab] || rawTab;
  // Any key works — a tab (details / requirements / performance) or an older
  // section key (agreement, interviews, invoices …), which opens its tab and
  // scrolls to the section.
  const setTab = (t) => {
    // Same key again (e.g. "See contacts" twice): just scroll to it.
    if (t === rawTab && SECTION_OF[t]) document.getElementById(`ccr-sec-${SECTION_OF[t]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setParams(t === 'details' ? {} : { tab: t }, { replace: true });
  };
  const section = SECTION_OF[rawTab] || '';

  const [client, setClient] = useState(null);
  const [data, setData] = useState(EMPTY_OVERVIEW);
  // Set when the API refuses this record for scope reasons.
  const [denied, setDenied] = useState('');
  const [signingLink, setSigningLink] = useState('');
  const [upload, setUpload] = useState({ open: false, fileName: '', document: '' });
  const [reject, setReject] = useState({ open: false, reason: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Spec 6 — Agreement tab: which action is running, and its two small dialogs.
  const [agrBusy, setAgrBusy] = useState('');
  const [signedDlg, setSignedDlg] = useState({ open: false });
  const [termsDlg, setTermsDlg] = useState({ open: false });
  // "Sign & stamp for TeamLink" dialog (2026-10-05).
  const [tlSealOpen, setTlSealOpen] = useState(false);
  const [flow, setFlow] = useState(null); // the agreement steps (Made > HR > BDE TL > client), null = this login has no part in them
  // The error of whichever agreement dialog is open (shown inside it).
  const [dlgError, setDlgError] = useState('');
  const [editing, setEditing] = useState(false);
  const [activityKind, setActivityKind] = useState('all');
  // Pause / Reactivate / Request pause / Archive / Un-archive / Delete dialog.
  const [lcDialog, setLcDialog] = useState('');
  // "Message" on the client's contact person (only when the server allows this login to).
  const mayMessage = useMayMessage('clients');
  const [msgOpen, setMsgOpen] = useState(false);
  const [convOpen, setConvOpen] = useState(false);

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
  // Client work (2026-10-10): asked once per client; a 403 means no client desk, so the tab is not drawn.
  const [work, setWork] = useState(null);
  useEffect(() => {
    setWork(null);
    if (!allowed) return undefined;
    let live = true;
    api.get(`/clients/${id}/work`, { params: { kind: 'all', limit: 30 } })
      .then((res) => { if (live) setWork(res.data); })
      .catch(() => { if (live) setWork(null); });
    return () => { live = false; };
  }, [id, allowed]);
  // An older ?tab= key (agreement, interviews, invoices …) scrolls to its section.
  const clientReady = !!client;
  useEffect(() => {
    if (!section || !clientReady) return undefined;
    // Again once the lists arrive (the section may only exist then).
    const t = setTimeout(() => {
      const el = document.getElementById(`ccr-sec-${section}`);
      if (el) el.scrollIntoView({ block: 'start' });
    }, 120);
    return () => clearTimeout(t);
  }, [section, clientReady, data]);

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
    { key: 'q', type: 'search', placeholder: 'Search requirement ID, requirement or location…', get: (r) => `${r.reqCode || ''} ${r.title || ''} ${r.location || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (r) => requirementStatusLabel(r.status) },
    { key: 'department', label: 'Department', primary: true, get: (r) => r.department },
    { key: 'location', label: 'Location', get: (r) => r.location },
    { key: 'priority', label: 'Priority', get: (r) => r.priority },
    { key: 'tl', label: 'Team lead', get: (r) => r.tlName, show: internalView },
    { key: 'recruiter', label: 'Recruiter', get: (r) => r.recruiterName, show: internalView },
    { key: 'bde', label: 'Client manager (BDE)', get: (r) => r.bdeName, show: internalView },
    { key: 'target', type: 'daterange', label: 'Target date', get: (r) => r.targetDate || r.closingDate },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'title', label: 'Requirement A–Z', cmp: az('title') },
      { key: 'target', label: 'Target date — soonest', cmp: (a, b) => String(a.targetDate || a.closingDate || '9999').localeCompare(String(b.targetDate || b.closingDate || '9999')) },
    ],
  });
  const reqPage = usePaged(reqLf.rows);
  const candLf = useListFilters(data.candidates, [
    { key: 'q', type: 'search', placeholder: 'Search name, requirement or role…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''} ${a.candidateDesignation || ''}` },
    { key: 'stage', label: 'Step', primary: true, get: (a) => stageLabel(a.stage) },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
    { key: 'location', label: 'Location', get: (a) => a.candidateLocation },
  ], {
    sorts: [
      { key: 'default', label: 'Default order', cmp: null },
      { key: 'name', label: 'Name A–Z', cmp: az('candidateName') },
      ...(internalView ? [{ key: 'match', label: 'Fit % — highest first', cmp: (a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1) }] : []),
    ],
  });
  const candPage = usePaged(candLf.rows);
  const ivLf = useListFilters(data.interviews, [
    { key: 'q', type: 'search', placeholder: 'Search interview ID, name or requirement…', get: (a) => `${a.interviewCode || ''} ${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
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
    { key: 'q', type: 'search', placeholder: 'Search name or requirement…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'stage', label: 'Step', primary: true, get: (a) => stageLabel(a.stage) },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
    { key: 'joining', type: 'daterange', label: 'Joining date', get: (a) => a.joiningDate },
  ]);
  const selPage = usePaged(selLf.rows);
  // how many people were selected (selected / offer / joined) against each requirement, from the client's whole list
  const selectedPerReq = new Map();
  (data.selections || []).forEach((a) => { if (a.requirementId) selectedPerReq.set(a.requirementId, (selectedPerReq.get(a.requirementId) || 0) + 1); });
  const repLf = useListFilters(data.replacements, [
    { key: 'q', type: 'search', placeholder: 'Search name or requirement…', get: (a) => `${a.candidateName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'case', label: 'Case', primary: true, get: (a) => a.caseStatus },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
  ]);
  const repPage = usePaged(repLf.rows);
  // Replacements: who left, when, whose place, and who came in his / her place
  const leftCases = data.replacementCases || [];
  const leftLf = useListFilters(leftCases, [
    { key: 'q', type: 'search', placeholder: 'Search name or requirement…', get: (a) => `${a.candidateName || ''} ${a.replacementName || ''} ${a.requirementCode || ''} ${a.requirementTitle || ''}` },
    { key: 'case', label: 'Case', primary: true, get: (a) => a.caseStatus },
    { key: 'requirement', label: 'Requirement', primary: true, get: reqLabel },
  ]);
  const leftPage = usePaged(leftLf.rows);
  const payLf = useListFilters(data.payments, [
    { key: 'q', type: 'search', placeholder: 'Search invoice number or reference…', get: (p) => `${p.invoiceNumber || ''} ${p.reference || ''}` },
    { key: 'method', label: 'Method', primary: true, get: (p) => p.method, show: data.invoiceMode === 'amounts' },
    { key: 'date', type: 'daterange', label: 'Received on', primary: true, get: (p) => p.date },
  ]);
  const payPage = usePaged(payLf.rows);
  const invLf = useListFilters(data.invoices, [
    { key: 'q', type: 'search', placeholder: 'Search invoice number…', get: (i) => i.invoiceNumber || i.id },
    { key: 'status', label: 'Status', primary: true, get: (i) => (i.status === 'Overdue' ? 'Late' : i.status) },
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

  // `showError` — a dialog passes its own setter so the error shows INSIDE
  // the dialog (not on the page behind it).
  async function agreementAction(path, body, showError = setError) {
    setError('');
    if (showError !== setError) showError('');
    setNote('');
    try {
      const res = await api.post(`/clients/${id}/agreement/${path}`, body || {});
      if (res.data.signingPath) setSigningLink(`${window.location.origin}${res.data.signingPath}`);
      // Send / Resend deliver the link by Email, SMS and WhatsApp — the
      // channels that worked are named; nothing raw from the server.
      if (res.data.delivery) {
        const sent = Object.entries(res.data.delivery).filter(([, r]) => r.outcome === 'Sent').map(([ch]) => ch);
        setNote(sent.length
          ? `Sent to the client by ${sent.join(', ')}.`
          : 'Not sent. Copy the link below and share it.');
      } else if (res.data.email) {
        setNote(res.data.email.emailed
          ? `Signing link emailed to ${res.data.email.to}.`
          : 'Not emailed. Copy the link below and share it.');
      }
      if (res.data.autoActivated) setNote('Signed by both sides. The agreement is now Active.');
      if (res.data.jobsOpened) {
        // e2e gap 7: the parked jobs went live by themselves; their TLs were told.
        setNote(`Active. ${res.data.jobsOpened} waiting requirement${res.data.jobsOpened === 1 ? ' is' : 's are'} live now — the team lead was told.${res.data.requirementsWaiting ? ` ${res.data.requirementsWaiting} requirement${res.data.requirementsWaiting === 1 ? '' : 's'} still waiting to be opened.` : ''}`);
      } else if (res.data.requirementsWaiting) {
        setNote(`Active. ${res.data.requirementsWaiting} waiting requirements can go live. Open each and press Activate.`);
      } else if (path === 'activate') setNote('Active. Requirements for this client can go live now.');
      else if (path === 'generate') setNote('Saved. A new agreement is ready.');
      else if (path === 'expire') setNote('Saved. The agreement is marked as ended.');
      load();
      return true;
    } catch (err) {
      showError(err.response?.data?.error || 'That did not work. Please try again.');
      return false;
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    setError('');
    try {
      await api.post(`/clients/${id}/notes`, { note: noteText.trim() });
      setNoteText('');
      setNote('Note saved.');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the note. Try again.');
    } finally {
      setNoteSaving(false);
    }
  }

  // Spec 2026-10-03 §A — every lifecycle change goes through a dialog with a
  // reason (the permanent delete also asks for the typed client name).
  function lifecycleDone(message, _res, mode) {
    setLcDialog('');
    if (mode === 'delete') { navigate('/clients'); return; }
    setError('');
    setNote(message);
    load();
  }

  if (!allowed) {
    return (
      <div className="notice clrole-denied">
        Clients is not part of your role. You see client names on your requirements.
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
  const status = agreementStepLabel(c.agreementStatus);
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
    performance: data.candidates.length,
  };
  // The tabs this login may open — the server's list (GET /clients/:id).
  const allowedTabs = c.tabs || data.tabs || TABS.map(([k]) => k);
  // 'portal' (spec B1) is not in the server's tab list: it shows for whoever
  // holds clients / Client Portal Logins, and its own API checks again.
  const portalTab = !data.redacted && (can(user, null, 'clients', 'Client Portal Logins', 'view') || can(user, null, 'clients', 'Client Portal Logins', 'approve'));
  const tabOk = (k) => allowedTabs.includes(k) || (k === 'portal' && portalTab);
  // A merged tab shows when the login may open ANY of the sections it carries.
  const tabShown = (k) => {
    const def = TABS.find(([key]) => key === k);
    if (k === 'work') return !!work && !data.redacted;
    if (k === 'history') return !data.redacted;
    return !!def && (tabOk(k) || (def[2] || []).some(tabOk));
  };
  const activeTab = tabShown(tab) ? tab : (TABS.find(([k]) => tabShown(k)) || ['details'])[0];
  // Performance lists: People (sent / interviews / selected / guarantee) or Money.
  const perfPeopleOk = ['candidates', 'interviews', 'selected', 'replacements'].some(tabOk);
  const perfMoneyOk = tabOk('invoices') || tabOk('payments');
  let perfList = MONEY_SECTIONS.includes(section) ? 'money' : 'people';
  if (perfList === 'people' && !perfPeopleOk) perfList = 'money';
  if (perfList === 'money' && !perfMoneyOk) perfList = 'people';
  // ONE main button: + New job (roles that may create jobs, client not paused).
  const canNewJob = !data.redacted && !!meta?.actions?.newRequirement && !['Paused', 'Archived'].includes(c.lifecycle);
  // Header: Edit + at most 2 lifecycle buttons. When Archive is offered,
  // "Delete permanently" is reached from inside the Archive dialog.
  const lcItems = lifecycleItemsFor(c);
  // User, 2026-10-05: "where is the delete option" — Delete is its own button
  // (Super Admin only; the server decides who gets it).
  const headerLc = lcItems;
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
          {/* One company, many locations (2026-10-22): the Location sits right under the name. */}
          {(c.location || c.state) && <div className="page-sub" style={{ fontWeight: 600 }}>{`Location: ${[c.location, c.state].filter(Boolean).join(', ')}`}</div>}
          <div className="page-sub">
            {[c.displayCode, c.agreementId ? `Agreement ${c.agreementId}` : null, c.legalName && c.legalName !== c.name ? `Legal: ${c.legalName}` : null, c.industry, c.businessType].filter(Boolean).join(' · ') || '—'}
          </div>
          {/* Who looks after this client: Name · Position (user, 2026-10-09). */}
          {!data.redacted && (
            <div className="page-sub">{`Client manager (BDE): ${c.bdeLabel || c.bdeOwner || data.summary?.bdeLabel || 'Nobody yet'}${c.ownerDepartment ? ` · ${c.ownerDepartment}` : ''}`}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <LifecycleChip lifecycle={c.lifecycle} />
          {!data.redacted && <WaButton entityType="client" id={c.id} name={c.name} hasNumber={c.contactPhone === undefined ? undefined : !!(c.contactPhone || c.contactWhatsApp)} label="WhatsApp" />}
          {p.edit && !data.redacted && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
          {!data.redacted && headerLc.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`btn btn-sm${k === 'delete' ? ' btn-danger' : ''}`}
              onClick={() => setLcDialog(k)}
              title={k === 'pause' ? 'No new requirements or people sent. Nothing is deleted.' : k === 'requestPause' ? 'An Admin or the department Manager decides.' : k === 'archive' ? 'Hide from the list. Every record is kept.' : k === 'delete' ? 'Only for a client added by mistake.' : undefined}
            >
              {label}
            </button>
          ))}
          {canNewJob && (
            <Link className="btn btn-primary" to={`/requirements?new=1&clientId=${encodeURIComponent(c.id)}`}>+ New Requirement</Link>
          )}
          {/* A login without the Agreement section here (a TL) still VIEWS the
              agreement — the server decides who may (routes/agreementSeal.js). */}
          {/* ONE shared "View agreement" (components/agreements/SignedAgreementFiles.jsx): always there for the logins allowed to see agreements. */}
          {!mine && <ViewAgreementButton clientId={c.id} esign={!!c.agreementDocument} onChanged={load} />}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {note && <div className="notice">{note}</div>}
      {/* Right after Add client: the next step, in one sentence (2026-10-05). */}
      {!note && params.get('saved') && (
        <div className="notice" role="status">
          {params.get('saved') === 'draft'
            ? `Saved for later.${c.missingRequired?.length ? ` Next: fill ${c.missingRequired.join(', ')} with Edit, then make the agreement.` : ' Next: press Edit and then make the agreement.'}`
            : (canManage
              ? 'Saved. The agreement is ready. Next: press 🔗 Create agreement link below and send it to the client.'
              : 'Saved. The agreement is ready. Next: ask an Admin to send the agreement link to the client.')}
        </div>
      )}
      <ClientPausedBanner clientName={c.name} lifecycle={c.lifecycle}>
        {c.lifecycleActions?.reactivate ? ' Press Reactivate above to resume.' : c.lifecycleActions?.unarchive ? ' Press Restore above to bring it back.' : ''}
      </ClientPausedBanner>
      {lcDialog && (
        <ClientLifecycleDialog key={lcDialog} client={c} mode={lcDialog} onClose={() => setLcDialog('')} onDone={lifecycleDone} onSwitch={setLcDialog} />
      )}
      {data.redacted && (
        <div className="notice">You see your own company&apos;s requirements and people.</div>
      )}

      {/* §9 relationship numbers — internal logins only (the server sends
          no summary to a client login). Client manager, department and next
          step are on the Overview tab. */}
      {data.summary && <RelationshipStrip s={data.summary} onTab={setTab} tabs={allowedTabs} />}
      {/* BDE business workspace (2026-10-10): onboarding steps, follow-ups / meetings / client feedback, and the asks
          a Manager / Admin decides. Drawn for the client desk only; the server decides every button. */}
      {!data.redacted && <ClientBusiness client={c} enabled={!!meta?.actions?.businessActivities} onChanged={load} />}

      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.filter(([key]) => tabShown(key)).map(([key, label]) => (
          <div key={key} className={`tab${activeTab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {agreementBlind(user) && label === 'Details & Agreement' ? 'Details' : label}
            {key === 'work'
              ? (work && work.pending && work.pending.total > 0 ? ` (${work.pending.total} waiting)` : '')
              : (counts[key] != null && counts[key] > 0 ? ` (${counts[key]})` : '')}
          </div>
        ))}
      </div>

      {activeTab === 'work' && work && <ClientWork key={c.id} clientId={c.id} initial={work} onGoTab={setTab} />}
      {activeTab === 'history' && <div className="card section"><ClientHistoryView key={c.id} endpoint={`/join-drop/client-history/${c.id}`} /></div>}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'details' && (
        <div className="two-col">
          <div>
            {/* B9.2: Feedback within N days / Send first profiles within N days (blank = Step-timing default). */}
            {!c.redacted && <ClientSlaCard clientId={c.id} initial={c.sla || null} canEdit={!!p.commercialTerms} />}
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center' }}>
                Details
                {p.edit && !data.redacted && (
                  <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>Edit</button>
                )}
              </h3>
              <div className="grid-2">
                <div>
                  <Row k="Client ID">{c.displayCode}</Row>
                  <Row k="Client name">{c.name}</Row>
                  <Row k="Legal name">{c.legalName}</Row>
                  <Row k="Industry">{c.industry}</Row>
                  <Row k="Business type">{c.businessType}</Row>
                </div>
                <div>
                  <Row k="Client type">{c.clientType}</Row>
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
                  <Row k="Payment terms">{c.paymentTerms}</Row>
                </div>
              </div>
              {!data.redacted && (
                <>
                  <Row k="Commission">{c.agreementFeePercent != null ? `${c.agreementFeePercent}% of annual CTC` : null}</Row>
                  <Row k="Invoice when">{c.invoiceTrigger}</Row>
                  <Row k="Replacement period">{c.guaranteePeriod}</Row>
                </>
              )}
            </div>
            )}

            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>{locations.length ? `Locations (${locations.length})` : 'Locations'}</h3>
              <Row k="Address">{address}</Row>
              {locations.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {locations.map((l) => (
                    <span key={l.name} className="clrel-pill" title={l.client ? 'The client\'s own location' : 'Where its requirements are'}>
                      {l.name}
                      {l.client ? ' · head office' : ''}
                      {l.reqs ? ` · ${l.reqs} ${l.reqs === 1 ? 'requirement' : 'requirements'}` : ''}
                    </span>
                  ))}
                </div>
              ) : <div className="small-muted">No location recorded.</div>}
            </div>

            {tabOk('contacts') ? (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>{contacts.length ? `Contacts (${contacts.length})` : 'Contacts'}</h3>
                {contacts.length
                  ? <Row k={contacts[0][0]}>{[contacts[0][1], contacts[0][2]].filter(Boolean).join(' · ')}</Row>
                  : <div className="small-muted">No contact yet.</div>}
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setTab('contacts')}>
                  See contacts
                </button>
              </div>
            ) : (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>{contacts.length ? `Contacts (${contacts.length})` : 'Contacts'}</h3>
              {contacts.length ? contacts.map(([label, name, desig, reach]) => (
                <div key={label} style={{ marginBottom: 6 }}>
                  <div className="section-label" style={{ margin: '4px 0 2px' }}>{label}</div>
                  <Row k="Name">{[name, desig].filter(Boolean).join(' · ')}</Row>
                  <Row k="Reach">{reach.filter(Boolean).join(' · ')}</Row>
                </div>
              )) : <div className="small-muted">No contact yet.</div>}
            </div>
            )}
          </div>

          <div>
            {tabOk('agreement') && (
            <div className="card section">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Agreement</h3>
              <Row k="Signed?"><StatusChip status={agreementIsSigned(c.agreementStatus) ? 'Signed' : 'Unsigned'} tone={agreementIsSigned(c.agreementStatus) ? 'green' : 'amber'} /></Row>
              <Row k="Step"><AgreementStepChip status={c.agreementStatus} /></Row>
              <Row k="Ends">{c.agreementEnd || (c.agreementStart ? 'Renews every 12 months' : null)}</Row>
              <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setTab('agreement')}>
                See agreement
              </button>
              <ViewAgreementButton clientId={c.id} esign={!!c.agreementDocument} onChanged={load} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} />
            </div>
            )}
            {!data.redacted && (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Client manager (BDE)</h3>
                <Row k="Client manager (BDE)">{c.bdeLabel || c.bdeOwner || data.summary?.bdeLabel || data.summary?.bdeName || 'Nobody yet'}</Row>
                {c.secondaryBde ? <Row k="Second BDE">{c.secondaryBdeLabel || c.secondaryBde}</Row> : null}
                <Row k="Account manager">{c.accountManager}</Row>
                {bdes.length > 0 && (
                  <Row k="On its requirements">{bdes.map(([n, k]) => `${n} (${k})`).join(', ')}</Row>
                )}
                {data.summary?.nextAction && <Row k="Next step">{data.summary.nextAction}</Row>}
              </div>
            )}
            {!data.redacted && (
              <div className="card section">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Team leads</h3>
                {tls.length
                  ? tls.map(([n, k]) => <Row key={n} k={n}>{`${k} ${k === 1 ? 'requirement' : 'requirements'}`}</Row>)
                  : <div className="small-muted">No team lead on its requirements yet.</div>}
                <button type="button" className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => setTab('requirements')}>
                  See requirements
                </button>
              </div>
            )}
            {!data.redacted && commercialLevel && (
              <div className="card">
                <h3 style={{ fontSize: 13, marginBottom: 10 }}>Risk</h3>
                <Row k="Risk flag">{c.riskFlag}</Row>
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
      {/* Portal access (spec B1) sits inside Contacts: who at the client
          can sign in. Its own API checks the right again. */}
      {activeTab === 'details' && tabOk('contacts') && (() => {
        const cards = [
          ['Primary (HR)', c.contactName, c.contactDesignation, c.contactPhone, c.contactEmail, c.contactWhatsApp],
          ['Secondary', c.secondaryContactName, c.secondaryContactDesignation, c.secondaryContactPhone, c.secondaryContactEmail],
          ['Billing', c.billingContactName, c.billingContactDesignation, c.billingContactPhone, c.billingContactEmail],
          ['Recruitment', c.recruitmentContactName, c.recruitmentContactDesignation, c.recruitmentContactPhone, c.recruitmentContactEmail],
        ].filter(([, n, , ph, em]) => n || ph || em);
        const tel = (v) => String(v).replace(/[^\d+]/g, '');
        return (
          <div id="ccr-sec-contacts" className="ccr-section">
            <div className="section-label">{cards.length ? `Contacts (${cards.length})` : 'Contacts'}</div>
            {mayMessage && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0 10px' }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setMsgOpen(true)}>{meta?.level === 'billing' ? 'Send a payment reminder' : 'Message the client'}</button>
                <button type="button" className="btn btn-sm" onClick={() => setConvOpen((v) => !v)}>{convOpen ? 'Hide the conversation' : 'Open the conversation'}</button>
              </div>
            )}
            {convOpen && mayMessage && <ConversationView audience="clients" personId={c.id} name={meta?.level === 'billing' ? `${c.billingContactName || 'Billing contact'} (${c.name})` : (c.contactName ? `${c.contactName} (${c.name})` : c.name)} onChanged={load} />}
            {meta?.level === 'names' && <div className="notice">Names only. The BDE team has phones and emails.</div>}
            {meta?.level === 'billing' && <div className="notice">The billing contact. The BDE team has the others.</div>}
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
            ) : <div className="small-muted">No contact yet.</div>}
          </div>
        );
      })()}
      {msgOpen && mayMessage && (
        <ContactDialog
          audience="clients"
          personId={c.id}
          purposeLabel={meta?.level === 'billing' ? 'Payment reminder' : 'Client agreement link'}
          name={meta?.level === 'billing' ? `${c.billingContactName || 'Billing contact'} (${c.name})` : (c.contactName ? `${c.contactName} (${c.name})` : c.name)}
          email={c.contactEmail === undefined ? undefined : (c.contactEmail || '')}
          phone={c.contactPhone === undefined ? undefined : (c.contactPhone || '')}
          onClose={() => setMsgOpen(false)}
          onLogged={load}
        />
      )}
      {activeTab === 'details' && portalTab && (
        <div id="ccr-sec-portal" className="ccr-section" style={{ marginTop: 16 }}>
          <div className="section-label">Portal access</div>
          <ClientPortalAccess clientId={c.id} />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'requirements' && (
        <>
        {!agreementIsActive(c.agreementStatus) && counts.requirements > 0 && (
          <div className="notice amber">
            {`New requirements go live only after the agreement is Active. Now: ${status}.`}
          </div>
        )}
        <ListFilterBar lf={reqLf} storageKey="cl360-req" noun="requirements" />
        {/* 8 columns (simplicity checklist #12). Department, Priority and
            Recruiter are filters here and on the job's own page. */}
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Requirement ID</th><th>Requirement</th><th>Location</th><th>Openings</th>
                {!data.redacted && <><th>Filled</th><th>Recruiters</th></>}
                <th>Due date</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reqPage.slice.map((r) => (
                <tr key={r.id} {...rowClickProps(() => navigate(`/requirements/${r.id}`), { href: `/requirements/${r.id}` })}>
                  <td><Link to={`/requirements/${r.id}`}>{r.reqCode || r.id.slice(0, 8)}</Link></td>
                  <td>{r.title}</td>
                  <td className="cell-muted">{r.location || '—'}</td>
                  <td className="cell-muted">{r.openings || '—'}</td>
                  {!data.redacted && (
                    <>
                      <td className="cell-muted">{r.filled ? `${r.filled} of ${r.openings || 1}` : 'None yet'}</td>
                      <td className="cell-muted clrel-wrap">
                        {(r.recruiters || []).length ? r.recruiters.join(', ') : <span className="rr-unassigned">Needs a recruiter</span>}
                        {r.tlName ? <span className="clrel-sub">{`TL ${r.tlName}`}</span> : null}
                      </td>
                    </>
                  )}
                  <td className="cell-muted">{r.targetDate || r.closingDate || '—'}</td>
                  <td>{r.displayStatus ? <JobStatusChip status={r.displayStatus} /> : <span className={`status ${requirementBadgeClass(r.status)}`}>{requirementStatusLabel(r.status)}</span>}</td>
                </tr>
              ))}
              {!data.requirements.length && <Empty cols={8}>{canNewJob ? 'No requirements yet. Press + New Requirement to add one.' : 'No requirements yet.'}</Empty>}
              {data.requirements.length > 0 && !reqLf.rows.length && <tr><td colSpan={8} style={{ padding: 0 }}><ListEmpty lf={reqLf} noun="requirements" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={reqPage} noun="requirements" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* ATS layout v3 — Performance: charts first, then the lists behind them. */}
      {activeTab === 'performance' && (
        <>
          <ClientPerformance clientId={c.id} data={data} onList={(k) => setTab(k)} />
          {perfPeopleOk && perfMoneyOk && (
            <div className="ccr-pick" role="group" aria-label="Show">
              <button type="button" className={`btn btn-sm${perfList === 'people' ? ' btn-primary' : ''}`} aria-pressed={perfList === 'people'} onClick={() => setTab('candidates')}>People sent</button>
              <button type="button" className={`btn btn-sm${perfList === 'money' ? ' btn-primary' : ''}`} aria-pressed={perfList === 'money'} onClick={() => setTab('invoices')}>Invoices</button>
            </div>
          )}
        </>
      )}
      {activeTab === 'performance' && perfList === 'people' && tabOk('candidates') && (
        <div id="ccr-sec-candidates" className="ccr-section">
          <div className="section-label">{data.candidates.length ? `People sent (${data.candidates.length})` : 'People sent'}</div>
          {data.redacted && (
            <div className="notice">People shared with you.</div>
          )}
          <ListFilterBar lf={candLf} storageKey="cl360-cand" noun="people" />
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Requirement</th><th>Location</th><th>Experience</th>
                  <th>Current role</th>
                  {!data.redacted && <><th>Fit %</th><th>AI interview %</th></>}
                  <th>Step</th><th />
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
                {!data.candidates.length && <Empty cols={9}>Nobody sent yet.</Empty>}
                {data.candidates.length > 0 && !candLf.rows.length && <tr><td colSpan={9} style={{ padding: 0 }}><ListEmpty lf={candLf} noun="people" /></td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={candPage} noun="people" />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Interviews — a section of People sent (server key 'interviews'). */}
      {activeTab === 'performance' && perfList === 'people' && tabOk('interviews') && (data.interviews.length > 0 || !tabOk('candidates')) && (
        <>
        <div id="ccr-sec-interviews" className="section-label ccr-section">{data.interviews.length ? `Interviews (${data.interviews.length})` : 'Interviews'}</div>
        <ListFilterBar lf={ivLf} storageKey="cl360-iv" noun="interviews" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Interview</th><th>Name</th><th>Requirement</th><th>When</th><th>Round</th><th>Type / Mode</th><th>Interviewer</th><th>Status</th><th>Result</th></tr>
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
                  <td><StatusChip status={interviewStatusLabel(a.interviewStatus)} /></td>
                  <td className="cell-muted">{a.interviewResult || '—'}</td>
                </tr>
              ))}
              {!data.interviews.length && <Empty cols={9}>No interviews yet.</Empty>}
              {data.interviews.length > 0 && !ivLf.rows.length && <tr><td colSpan={9} style={{ padding: 0 }}><ListEmpty lf={ivLf} noun="interviews" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={ivPage} noun="interviews" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'performance' && perfList === 'people' && tabOk('selected') && data.selections.length > 0 && (
        <>
        <div id="ccr-sec-selected" className="section-label ccr-section">{`Selected and joined (${data.selections.length})`}</div>
        <ListFilterBar lf={selLf} storageKey="cl360-sel" noun="people" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Requirement</th><th>Step</th>{!data.redacted && <th>Offered CTC</th>}<th>Joining date</th></tr>
            </thead>
            <tbody>
              {selPage.slice.map((a) => (
                <tr key={a.id}>
                  <td>{a.candidateName}</td>
                  <td className="cell-muted">
                    {a.requirementId
                      ? <Link to={`/requirements/${a.requirementId}?tab=candidates&pipe=selected`} title="Open this requirement: who was selected">{a.requirementCode || a.requirementTitle}</Link>
                      : (a.requirementCode || a.requirementTitle)}
                    {a.requirementId && selectedPerReq.get(a.requirementId) ? <span style={{ marginLeft: 6 }}>({selectedPerReq.get(a.requirementId)} selected)</span> : null}
                  </td>
                  <td><span className={`status ${stageBadgeClass(a.stage)}`}>{stageLabel(a.stage)}</span></td>
                  {!data.redacted && <td className="cell-muted">{a.offeredCtc != null ? `₹${a.offeredCtc}` : '—'}</td>}
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{joinCellText(a)}</td>
                </tr>
              ))}
              {!data.selections.length && <Empty cols={5}>Nobody selected yet.</Empty>}
              {data.selections.length > 0 && !selLf.rows.length && <tr><td colSpan={5} style={{ padding: 0 }}><ListEmpty lf={selLf} noun="people" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={selPage} noun="people" />
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* §5 Replacements — joinings inside the guarantee period and the
          replacement cases on the joining (Replacement Due / Replaced /
          Left after Guarantee). The guarantee end date comes only to a
          login that may see the guarantee period. */}
      {activeTab === 'performance' && perfList === 'people' && tabOk('replacements') && leftCases.length > 0 && (
        <>
        <div id="ccr-sec-replacements" className="section-label ccr-section">{`Replacements (${leftCases.length})`}</div>
        <div className="cell-muted" style={{ marginBottom: 6 }}>People who left a job, the date they left, and who came in their place.</div>
        <ListFilterBar lf={leftLf} storageKey="cl360-left" noun="cases" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Left (whose place)</th><th>Requirement</th><th>Joined on</th><th>Left on</th><th>Why</th><th>Case</th><th>Replaced by</th><th>Replacement joined on</th></tr>
            </thead>
            <tbody>
              {leftPage.slice.map((r) => (
                <tr key={r.id}>
                  <td>{r.candidateId ? <Link to={`/candidates/${r.candidateId}`}>{r.candidateName || '—'}</Link> : (r.candidateName || '—')}</td>
                  <td className="cell-muted">{r.requirementId ? <Link to={`/requirements/${r.requirementId}`}>{r.requirementCode || r.requirementTitle}</Link> : '—'}</td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{dmyDay(r.joinedOn) || 'Not recorded'}</td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{dmyDay(r.leftOn) || 'Not recorded'}</td>
                  <td className="cell-muted">{r.reason || '—'}</td>
                  <td><StatusChip status={r.caseStatus} tone={r.caseStatus === 'Replacement due' ? 'red' : r.caseStatus === 'Replaced' ? 'green' : 'amber'} /></td>
                  <td>{r.replacementName ? (r.replacementId ? <Link to={`/candidates/${r.replacementId}`}>{r.replacementName}</Link> : r.replacementName) : <span className="cell-muted">Not yet</span>}</td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{r.replacementName ? (dmyDay(r.replacementJoinedOn) || (r.replacementStage ? 'Not joined yet' : '—')) : '—'}</td>
                </tr>
              ))}
              {leftCases.length > 0 && !leftLf.rows.length && <tr><td colSpan={8} style={{ padding: 0 }}><ListEmpty lf={leftLf} noun="cases" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={leftPage} noun="cases" />
        </>
      )}

      {activeTab === 'performance' && perfList === 'people' && tabOk('replacements') && data.replacements.length > 0 && (
        <>
        <div id="ccr-sec-guarantee" className="section-label ccr-section">{`Guarantee cases (${data.replacements.length})`}</div>
        <ListFilterBar lf={repLf} storageKey="cl360-rep" noun="cases" />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Requirement</th><th>Joined on</th><th>Case</th>
                {data.replacements.some((r) => r.guaranteeEnds !== undefined) && <th>Guarantee ends</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {repPage.slice.map((r) => (
                <tr key={r.id}>
                  <td>{r.candidateName || '—'}</td>
                  <td className="cell-muted">{r.requirementId ? <Link to={`/requirements/${r.requirementId}`}>{r.requirementCode || r.requirementTitle}</Link> : '—'}</td>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>{dmyDay(r.joiningDate) || 'Not recorded'}</td>
                  <td><StatusChip status={r.caseStatus} tone={r.caseStatus === 'Replacement Due' ? 'red' : r.caseStatus === 'Replaced' ? 'green' : 'amber'} /></td>
                  {data.replacements.some((x) => x.guaranteeEnds !== undefined) && <td className="cell-muted">{r.guaranteeEnds || '—'}</td>}
                  <td><Link className="btn btn-sm" to={`/candidates/${r.candidateId}`}>View</Link></td>
                </tr>
              ))}
              {!data.replacements.length && <Empty cols={6}>No guarantee cases.</Empty>}
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
      {activeTab === 'performance' && perfList === 'money' && tabOk('invoices') && (
        <div id="ccr-sec-invoices" className="ccr-section">
        <div className="section-label">{data.invoices.length ? `Invoices (${data.invoices.length})` : 'Invoices'}</div>
        {invoiceMode === 'status' && (
          <div className="notice">Status only. Accounts has the amounts.</div>
        )}
        <ListFilterBar lf={invLf} storageKey="cl360-inv" noun="invoices" />
        {/* Amounts view: 8 columns (simplicity checklist #12). GST and TDS
            are on the invoice's own page (click the invoice number). */}
        <div className="tbl-wrap">
          <table>
            <thead>
              {invoiceMode === 'status' && <tr><th>Invoice</th><th>Date</th><th>Due</th><th>Status</th></tr>}
              {invoiceMode === 'client' && <tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>GST</th><th>TDS</th><th>Status</th></tr>}
              {invoiceMode === 'amounts' && (
                <tr>
                  <th>Invoice</th><th>Date</th><th>Due</th><th className="clrole-money">Amount</th>
                  <th className="clrole-money">Total</th><th className="clrole-money">Received</th>
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
                      <td className="clrole-money">{inr(i.total)}</td>
                      <td className="clrole-money">{inr(i.receivedAmount)}</td>
                      <td className={`clrole-money${i.outstanding > 0.5 ? ' bad' : ''}`}>{inr(i.outstanding)}</td>
                    </>
                  )}
                  <td><span className={`status ${i.status === 'Paid' ? 'active' : i.status === 'Overdue' ? 'rejected' : 'pending'}`}>{i.status === 'Overdue' ? 'Late' : i.status}</span></td>
                </tr>
              ))}
              {!data.invoices.length && <Empty cols={8}>No invoices yet.</Empty>}
              {data.invoices.length > 0 && !invLf.rows.length && <tr><td colSpan={8} style={{ padding: 0 }}><ListEmpty lf={invLf} noun="invoices" /></td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={invPage} noun="invoices" />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Payments — receipts against this client's invoices (InvoicePayment
          lines, or the received amount recorded on the invoice). */}
      {activeTab === 'performance' && perfList === 'money' && tabOk('payments') && data.payments.length > 0 && (
        <div id="ccr-sec-payments" className="ccr-section">
        <div className="section-label">{`Payments (${data.payments.length})`}</div>
        {invoiceMode === 'status' && (
          <div className="notice">Which invoices are paid, and when.</div>
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
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {activeTab === 'details' && tabOk('agreement') && (() => {
        // SPEC 6 — ONE clear Agreement tab: the six steps, what is happening
        // now, the terms, and ONE main button for the next step (Super Admin /
        // Admin only — everyone else reads it). The document, the signing
        // details and the history sit under "Show …" so the screen stays calm.
        const step = agreementStepOf(c.agreementStatus);
        const when = (v) => (v ? protoDate(v) : '');
        const lead = {
          DRAFT: c.agreementDocument ? 'The agreement is ready. Next: make the agreement link and share it with the client.' : 'No agreement made yet. Make it from the standard template.',
          SENT: `Sent${c.agreementSentAt ? ` on ${when(c.agreementSentAt)}` : ''}. Waiting for the client to open it.`,
          VIEWED: `The client opened it${c.agreementViewedAt ? ` on ${when(c.agreementViewedAt)}` : ''}. Waiting for their signature.`,
          SIGNED: `Signed${c.agreementSignedBy ? ` by ${c.agreementSignedBy}` : ''}${c.agreementSignedAt ? ` on ${when(c.agreementSignedAt)}` : ''}${!c.agreementCompanySignFile || !c.agreementCompanyStampFile ? '. Next: TeamLink adds its signature & stamp (press Sign & stamp for TeamLink).' : '. Next: make it active.'}`,
          ACTIVE: `Active${c.agreementActivatedAt ? ` since ${when(c.agreementActivatedAt)}` : ''}. Requirements for this client can go live.`,
          EXPIRED: 'This agreement has ended. Make a new agreement to renew it.',
          REJECTED: `The client said no${c.agreementRejectedReason ? ` (“${c.agreementRejectedReason}”)` : ''}. Change the terms and make a new agreement.`,
        }[step] || '';
        const busy = (k) => agrBusy === k;
        const run = async (k, path, body) => { setAgrBusy(k); await agreementAction(path, body); setAgrBusy(''); };
        const main = !canManage ? null : ({
          // With a draft, the main button is "Create agreement link" in the
          // link card below (2026-10-05).
          DRAFT: c.agreementDocument
            ? null
            : ['generate', 'Make the agreement', () => run('generate', 'generate')],
          // Active needs BOTH sides' signature + stamp (2026-10-05).
          SIGNED: (!c.agreementCompanySignFile || !c.agreementCompanyStampFile)
            ? ['tlseal', 'Sign & stamp for TeamLink', () => setTlSealOpen(true)]
            : ['activate', 'Make it active', () => run('activate', 'activate')],
          EXPIRED: ['generate', 'Make a new agreement', () => run('generate', 'generate')],
          REJECTED: ['generate', 'Make a new agreement', () => run('generate', 'generate')],
        }[step] || null);
        const canChangeTerms = canManage && ['DRAFT', 'EXPIRED', 'REJECTED'].includes(step);
        const fee = c.agreementFeePercent != null ? `${c.agreementFeePercent}%` : '—';
        const signed = agreementIsSigned(c.agreementStatus);
        return (
          <div id="ccr-sec-agreement" className="ccr-section">
            <div className="section-label ccr-sign">
              Agreement
              <StatusChip status={signed ? 'Signed' : 'Unsigned'} tone={signed ? 'green' : 'amber'} />
              {flow && <StageChip label={flow.stageLabel} colour={flow.colour} />}
            </div>
            <AgreementFlow clientId={id} onChanged={load} onLoaded={setFlow} refreshKey={`${c.agreementStatus}|${c.agreementSentAt || ''}|${c.updatedAt || ''}`} />
            <div className="card section agr6-card">
              {/* SIMPLE (founder 2026-10-31: "agreement signing daggara structure messy ga, clumsy ga undhi"): the steps live in the
                  stepper above; this card says what happens now, who signed, and how it gets signed. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <AgreementStepChip status={c.agreementStatus} />
              </div>
              <div className="agr6-lead">{lead}</div>
              {/* Who still has to sign + stamp (2026-10-05). */}
              {c.agreementDocument && !['EXPIRED', 'REJECTED'].includes(step) && (
                <div className="agr-wait">
                  <span className={c.agreementCompanySignFile && c.agreementCompanyStampFile ? 'ok' : 'wait'}>
                    {c.agreementCompanySignFile && c.agreementCompanyStampFile ? '✓ TeamLink signed & stamped' : 'Waiting for TeamLink signature & stamp'}
                  </span>
                  <span className={(c.agreementClientSignFile || c.agreementEsignProvider === 'eMudhra') && c.agreementClientStampFile && c.agreementSignedAt ? 'ok' : 'wait'}>
                    {(c.agreementClientSignFile || c.agreementEsignProvider === 'eMudhra') && c.agreementClientStampFile && c.agreementSignedAt
                      ? `✓ Client signed & stamped${c.agreementEsignProvider === 'eMudhra' ? ' (Aadhaar eSign, eMudhra)' : ''}` : 'Waiting for client signature & stamp'}
                  </span>
                </div>
              )}
              {canManage && c.agreementDocument && !['ACTIVE', 'EXPIRED', 'REJECTED'].includes(step) && <TeamLinkSignerNotice refreshKey={tlSealOpen} />}
              {!agreementIsActive(c.agreementStatus) && counts.requirements > 0 && (
                <div className="agr6-sub">{`${counts.requirements} ${counts.requirements === 1 ? 'requirement waits' : 'requirements wait'} for this agreement to be Active.`}</div>
              )}
              {canManage ? (
                <>
                <div className="agr6-actions">
                  {main && (
                    <button type="button" className="btn btn-primary" disabled={!!agrBusy} onClick={main[2]}>
                      {busy(main[0]) ? 'Working…' : main[1]}
                    </button>
                  )}
                  <ViewAgreementButton clientId={id} esign={!!c.agreementDocument} onChanged={load} />
                </div>
                {/* HOW IT GETS SIGNED - one of three, said plainly (2026-10-31) */}
                {c.agreementDocument && ['DRAFT', 'SENT', 'VIEWED', 'SIGNED'].includes(step) && !(flow && ['DRAFT', 'WITH_HR', 'WITH_TL'].includes(flow.stage)) && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>How will it be signed? Pick one way:</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                      <div style={{ border: '1px solid var(--line, #d5dbe5)', borderRadius: 8, padding: 10 }}>
                        <div style={{ fontWeight: 600 }}>1. Online link</div>
                        <div className="small-muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>TeamLink signs &amp; stamps, the client signs on the link with a code to their mobile.</div>
                        {!(main && main[0] === 'tlseal') && <button type="button" className="btn btn-sm" onClick={() => setTlSealOpen(true)}>✍️ Sign &amp; stamp for TeamLink</button>}
                        {['DRAFT', 'SENT', 'VIEWED'].includes(step) && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>The link to send is just below.</div>}
                      </div>
                      <div style={{ border: '1px solid var(--line, #d5dbe5)', borderRadius: 8, padding: 10 }}>
                        <div style={{ fontWeight: 600 }}>2. Aadhaar eSign (DigiLocker, free)</div>
                        <div className="small-muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>Each side eSigns its copy in DigiLocker; upload both copies. Both valid = Active.</div>
                        <ViewAgreementButton clientId={id} esign={!!c.agreementDocument} onChanged={load} />
                      </div>
                      <div style={{ border: '1px solid var(--line, #d5dbe5)', borderRadius: 8, padding: 10 }}>
                        <div style={{ fontWeight: 600 }}>3. Signed on paper / email</div>
                        <div className="small-muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>Upload the signed agreement and Vasu sir&apos;s confirmation in View agreement.</div>
                        {['SENT', 'VIEWED'].includes(step) && (
                          <button type="button" className="btn btn-sm" disabled={!!agrBusy} onClick={() => { setDlgError(''); setSignedDlg({ open: true, name: '', title: '', file: '' }); }}>Mark as signed (paper / email)</button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {/* the rest, out of the way */}
                <details className="agr6-moreacts" style={{ marginTop: 10 }}>
                  <summary className="small-muted" style={{ cursor: 'pointer' }}>More actions (terms, client&apos;s own agreement, close / open)</summary>
                <div className="agr6-actions" style={{ marginTop: 8 }}>
                  {['SIGNED', 'ACTIVE', 'EXPIRED'].includes(step) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={!!agrBusy}
                      onClick={async () => {
                        if (!window.confirm('Edit the terms of a signed agreement? The signed copy stays in history, and a new agreement is made that must be signed again by both sides.')) return;
                        setAgrBusy('newver'); setError('');
                        try {
                          await api.post(`/agreement/${id}/new-version`, { reason: 'Terms edited by Admin' });
                          setNote('Done. The signed copy is kept in history. A new agreement is ready — press Change terms, then send it again.');
                          load();
                        } catch (err) { setError(err.response?.data?.error || 'That did not work. Please try again.'); }
                        setAgrBusy('');
                      }}
                    >
                      Edit terms (new version)
                    </button>
                  )}
                  {canChangeTerms && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setDlgError('');
                        setTermsDlg({
                          open: true,
                          fee: c.agreementFeePercent ?? '',
                          guarantee: (String(c.guaranteePeriod || '').match(/\d+/) || ['0'])[0],
                          payment: (String(c.paymentTerms || '').match(/within (\d+) days/) || [null, '6'])[1],
                        });
                      }}
                    >
                      Change terms
                    </button>
                  )}
                  {canChangeTerms && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDlgError(''); setUpload({ open: true, fileName: '', document: c.agreementDocument || '' }); }}>Use the client&apos;s own agreement</button>
                  )}
                  {step === 'ACTIVE' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={!!agrBusy}
                      onClick={() => { if (window.confirm(`Close the agreement with ${c.name}? New requirements will wait until it is opened again or a new one is Active. You can open it again later.`)) run('expire', 'expire'); }}
                    >
                      Close agreement
                    </button>
                  )}
                  {step === 'EXPIRED' && (c.agreementSignedAt || c.agreementActivatedAt) && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!!agrBusy}
                      onClick={() => { if (window.confirm(`Open the agreement with ${c.name} again? Requirements for this client can go live again.`)) run('reopen', 'reopen'); }}
                    >
                      Open agreement again
                    </button>
                  )}
                </div>
                </details>
                </>
              ) : (
                !data.redacted && (
                  <div className="small-muted" style={{ fontSize: 12.5 }}>
                    <div style={{ margin: '6px 0' }}><ViewAgreementButton clientId={id} esign={!!c.agreementDocument} onChanged={load} /></div>
                    {step === 'DRAFT' && c.agreementDocument && !p.sendLink ? 'Ask an Admin to send the agreement link to the client.' : (p.sendLink ? 'Use the box below to make the agreement link and send it to the client. An Admin changes the terms.' : 'Only an Admin changes or sends it. You can read it here.')}
                  </div>
                )
              )}
              {tlSealOpen && (
                <Modal title={`Sign & stamp for TeamLink — ${c.name}`} size="wide" onClose={() => { setTlSealOpen(false); load(); }}>
                  <TeamLinkSeal mode="agreement" clientId={id} onDone={() => load()} />
                </Modal>
              )}
              {/* 2026-10-05 — the agreement link: make, copy, WhatsApp, email, stop. */}
              {(canManage || p.sendLink) && c.agreementDocument && ['DRAFT', 'SENT', 'VIEWED'].includes(step) && !(flow && ['DRAFT', 'WITH_HR', 'WITH_TL'].includes(flow.stage)) && (
                <AgreementLinkCard clientId={id} onChanged={load} />
              )}
            </div>

            <div className="card section agr6-card">
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Terms</h3>
              <div className="agr6-terms">
                <div className="agr6-term"><div className="k">Commission</div><div className="v">{fee}</div></div>
                <div className="agr6-term"><div className="k">Replacement period</div><div className="v">{c.guaranteePeriod || '—'}</div></div>
                <div className="agr6-term"><div className="k">Payment</div><div className="v">{c.paymentDue || c.paymentTerms || '—'}</div></div>
                <div className="agr6-term"><div className="k">Starts</div><div className="v">{c.agreementStart || (c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : 'Not set')}</div></div>
                <div className="agr6-term"><div className="k">Ends</div><div className="v">{c.agreementEnd || (c.agreementStart ? 'Renews every 12 months' : 'Not set')}</div></div>
              </div>
              <div className="small-muted" style={{ fontSize: 12 }}>{`${c.agreementId ? `Agreement No. ${c.agreementId}` : 'Agreement No. is made when the agreement is made'} ·${c.agreementTemplate || 'Standard template'}${c.agreementSource ? ` · ${c.agreementSource === 'Uploaded' ? "the client's own agreement" : 'made from the template'}` : ''}`}</div>
              <OwnAgreementFile clientId={id} show={c.agreementSource === 'Uploaded'} refreshKey={`${c.agreementSignedCopyName || ''}|${c.agreementStatus}`} />
            </div>

            {/* FILES, THE DOCUMENT AND THE HISTORY - one place, closed until opened (2026-10-31: the tab was a long column of cards) */}
            <details className="card section agr6-more">
              <summary>Signed files, Drive link, document and history</summary>
            {/* Every signed agreement file kept on this client (imported PDFs / pictures): the list, View and Download. Nothing shows when there are none. */}
            <SignedAgreementFiles clientId={id} skip={agreementBlind(user)} />

            {/* The Google Drive link of the signed agreement (2026-10-12): the owner BDE, BDE TL, Admin; Manager / Accounts read it. */}
            <AgreementDriveCard clientId={id} clientName={c.name} />

            <details className="card section agr6-more">
              <summary>Show the agreement document</summary>
              <div className="agr6-doc agr6-doc-word" style={{ marginTop: 8 }}>
                {/* Both sides' real signature + stamp images (the same the PDF prints). */}
                <AgreementDocView
                  text={c.agreementDocument}
                  {...signersFrom({
                    company: { signedBy: c.agreementCompanySignedBy, sealedAt: c.agreementCompanySealedAt, hasSignature: !!c.agreementCompanySignFile, hasStamp: !!c.agreementCompanyStampFile },
                    clientSide: { signedBy: c.agreementSignedBy, signedByTitle: c.agreementSignedByTitle, hasSignature: !!c.agreementClientSignFile, hasStamp: !!c.agreementClientStampFile, esign: c.agreementEsignProvider === 'eMudhra' && c.agreementEsignTxnId ? 'eMudhra' : null },
                    signedAt: c.agreementSignedAt,
                    teamlinkName: c.teamlinkSigner?.name, teamlinkTitle: c.teamlinkSigner?.title,
                  }, (kind) => <AuthImg path={`/agreement/${id}/file/${kind}`} alt={kind} bust={`${c.agreementSignedAt}|${c.agreementCompanySealedAt}`} />)}
                />
              </div>
            </details>
            {c.agreementDocument && ['SENT', 'VIEWED', 'SIGNED', 'ACTIVE'].includes(step) && (
              <details className="card section agr6-more">
                <summary>Show signing details (signatures, stamp, PDF)</summary>
                <AgreementPanel bare clientId={id} refreshKey={`${c.agreementStatus}|${c.agreementSentAt || ''}|${c.agreementSignedAt || ''}`} onChanged={load} />
              </details>
            )}
            <details className="card section agr6-more">
              <summary>Show history</summary>
              <Row k="Made">{protoDate(c.createdAt)}</Row>
              <Row k="Sent">{c.agreementSentAt ? protoDate(c.agreementSentAt) : null}</Row>
              <Row k="Viewed">{c.agreementViewedAt ? protoDate(c.agreementViewedAt) : null}</Row>
              <Row k="Signed">
                {c.agreementSignedAt
                  ? `${protoDate(c.agreementSignedAt)} · ${c.agreementSignedBy || '—'}${c.agreementSignedByTitle ? ` (${c.agreementSignedByTitle})` : ''}${c.agreementSignedCopyName ? ` · ${c.agreementSignedCopyName}` : ''}`
                  : null}
              </Row>
              <Row k="Active">{c.agreementActivatedAt ? protoDate(c.agreementActivatedAt) : null}</Row>
              <Row k="Said no">{c.agreementRejectedAt ? protoDate(c.agreementRejectedAt) : null}</Row>
            </details>
            </details>

            {canSign && (
              <div className="card section">
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Review &amp; sign</h3>
                <div className="small-muted" style={{ marginBottom: 8 }}>
                  Sign with the link in the email. Or decline here.
                </div>
                <button className="btn btn-sm btn-danger" type="button" onClick={() => { setDlgError(''); setReject({ open: true, reason: '' }); }}>
                  Decline the agreement
                </button>
              </div>
            )}

            {signedDlg.open && (
              <Modal
                title="Mark as signed"
                onClose={() => setSignedDlg({ open: false })}
                footer={(
                  <>
                    <button type="button" className="btn" onClick={() => setSignedDlg({ open: false })}>Cancel</button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!!agrBusy}
                      onClick={async () => {
                        if (!signedDlg.name.trim()) { setDlgError('Write who signed for the client.'); return; }
                        if (!signedDlg.file.trim()) { setDlgError('Write the name of the signed copy.'); return; }
                        setAgrBusy('signed');
                        const done = await agreementAction('confirm', { signedByName: signedDlg.name.trim(), signedByTitle: signedDlg.title.trim(), signedCopyName: signedDlg.file.trim() }, setDlgError);
                        setAgrBusy('');
                        if (done) { setSignedDlg({ open: false }); setNote('Saved. Marked as signed. Next, make it active.'); }
                      }}
                    >
                      Save
                    </button>
                  </>
                )}
              >
                <div className="small-muted" style={{ marginBottom: 10 }}>For a copy signed on paper or by email.</div>
                <label className="field"><span>Signed by (client side)</span><input value={signedDlg.name} onChange={(e) => setSignedDlg({ ...signedDlg, name: e.target.value })} autoFocus /></label>
                <label className="field"><span>Their designation</span><input value={signedDlg.title} onChange={(e) => setSignedDlg({ ...signedDlg, title: e.target.value })} placeholder="HR Manager" /></label>
                <label className="field"><span>Signed copy file name</span><input value={signedDlg.file} onChange={(e) => setSignedDlg({ ...signedDlg, file: e.target.value })} placeholder="client-signed-agreement.pdf" /></label>
                {dlgError && <div className="error-text">{dlgError}</div>}
              </Modal>
            )}

            {termsDlg.open && (
              <Modal
                title="Change terms"
                onClose={() => setTermsDlg({ open: false })}
                footer={(
                  <>
                    <button type="button" className="btn" onClick={() => setTermsDlg({ open: false })}>Cancel</button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!!agrBusy}
                      onClick={async () => {
                        const f = Number(termsDlg.fee); const g = Number(termsDlg.guarantee); const d = Number(termsDlg.payment);
                        if (!Number.isFinite(f) || f <= 0 || f > 100) { setDlgError('Fee must be between 0 and 100 (e.g. 8.33).'); return; }
                        if (!Number.isInteger(g) || g < 0) { setDlgError('Guarantee must be whole days (0 for none).'); return; }
                        if (!Number.isInteger(d) || d < 0) { setDlgError('Payment days must be whole days.'); return; }
                        setAgrBusy('terms'); setError(''); setDlgError('');
                        try {
                          await api.put(`/clients/${id}`, {
                            agreementFeePercent: f,
                            guaranteePeriod: g === 0 ? 'No replacement' : `${g} Days`,
                            paymentTerms: `Invoice 6 days after joining; payment due within ${d} days of invoice`,
                            paymentDue: `${d} days after invoice`,
                          });
                          const done = await agreementAction('generate', undefined, setDlgError);
                          if (done) { setTermsDlg({ open: false }); setNote('Saved. Terms changed. A new agreement is ready.'); }
                        } catch (err) {
                          setDlgError(err.response?.data?.error || 'Could not change the terms. Try again.');
                        }
                        setAgrBusy('');
                      }}
                    >
                      Save and make a new agreement
                    </button>
                  </>
                )}
              >
                <div className="agr6-form">
                  <label className="field"><span>Fee %</span><input type="number" step="0.01" min="0" max="100" value={termsDlg.fee} onChange={(e) => setTermsDlg({ ...termsDlg, fee: e.target.value })} /></label>
                  <label className="field"><span>Guarantee (days)</span><input type="number" step="1" min="0" value={termsDlg.guarantee} onChange={(e) => setTermsDlg({ ...termsDlg, guarantee: e.target.value })} /></label>
                  <label className="field"><span>Payment within (days)</span><input type="number" step="1" min="0" value={termsDlg.payment} onChange={(e) => setTermsDlg({ ...termsDlg, payment: e.target.value })} /></label>
                </div>
                <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>A new agreement is made with these terms.</div>
                {dlgError && <div className="error-text">{dlgError}</div>}
              </Modal>
            )}
          </div>
        );
      })()}

      {/* ---------------------------------------------------------------- */}
      {/* §23 — who, when, what and why: the client's audit rows, its
          requirements' audit rows and the pipeline events on its candidates,
          newest first. */}
      {activeTab === 'details' && tabOk('activity') && (() => {
        const KINDS = [
          ['all', 'All'],
          ['client', agreementBlind(user) ? 'Client' : 'Client & agreement'],
          ['requirement', 'Requirements'],
          ['candidate', 'People'],
          ['note', 'Notes'],
        ].filter(([k]) => k !== 'candidate' || tabOk('candidates'));
        const kindOf = actKindOf;
        const rows = actLf.rows;
        const time = (v) => {
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        };
        return (
          <div id="ccr-sec-activity" className="ccr-section">
            <div className="section-label">Notes &amp; history</div>
            {/* §8.5 / §5 — Add Note: Admin, BDE, Accounts (own). */}
            {meta?.actions?.note && !data.redacted && (
              <div className="clrole-note">
                <textarea rows="2" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Write a note: call summary, follow-up…" />
                <button type="button" className="btn btn-sm btn-primary" disabled={noteSaving || !noteText.trim()} onClick={addNote}>{noteSaving ? 'Saving…' : 'Save note'}</button>
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
                    {(() => {
                      const n = k !== 'all' ? data.activity.filter((a) => kindOf(a) === k).length : 0;
                      return n > 0 ? ` (${n})` : '';
                    })()}
                  </button>
                ))}
              </div>
            )}
            <ListFilterBar lf={actLf} storageKey="cl360-act" noun="updates" />
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
                    ? <tr><td colSpan={6} style={{ padding: 0 }}><ListEmpty lf={actLf} noun="updates" /></td></tr>
                    : <Empty cols={6}>{activityKind === 'all' ? 'No updates yet.' : 'None of this kind yet. Press All to see everything.'}</Empty>)}
                </tbody>
              </table>
            </div>
            <Pager page={actPage} noun="updates" />
          </div>
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
          title="Client's own agreement"
          size="wide"
          onClose={() => setUpload({ ...upload, open: false })}
          footer={(
            <>
              <button className="btn" onClick={() => setUpload({ ...upload, open: false })}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const f = upload.file;
                  if (f) {
                    const okType = /\.(pdf|docx?|png|jpe?g|webp)$/i.test(f.name);
                    if (!okType) { setDlgError('Only PDF, Word or image files (PNG, JPG, WebP) are accepted.'); return; }
                    if (f.size > 10 * 1024 * 1024) { setDlgError('That file is too big. The limit is 10 MB.'); return; }
                  }
                  let fd = null;
                  if (f) { fd = new FormData(); fd.append('file', f, f.name); }
                  if (await agreementAction(f ? 'upload-file' : 'upload', f ? fd : { document: upload.document, fileName: upload.fileName }, setDlgError)) {
                    setUpload({ open: false, fileName: '', document: '' });
                    setNote('Saved. The client\'s own agreement is now the agreement to send.');
                  }
                }}
              >
                Save
              </button>
            </>
          )}
        >
          <label className="field">
            <span>Agreement file (PDF, Word or picture, up to 10 MB)</span>
            <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,application/pdf" onChange={(e) => { setDlgError(''); setUpload({ ...upload, file: e.target.files[0] || null }); }} />
          </label>
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {upload.file ? 'The file will be used. The text below is ignored.' : 'Or paste the agreement text here.'}
          </div>
          <label className="field">
            <span>File name</span>
            <input value={upload.fileName} onChange={(e) => setUpload({ ...upload, fileName: e.target.value })} placeholder="Orbit-MSA-signed.pdf" />
          </label>
          <label className="field">
            <span>Agreement text</span>
            <textarea rows="14" value={upload.document} onChange={(e) => setUpload({ ...upload, document: e.target.value })} />
          </label>
          {dlgError && <div className="error-text">{dlgError}</div>}
        </Modal>
      )}

      {reject.open && (
        <Modal
          title="Decline the agreement"
          onClose={() => setReject({ open: false, reason: '' })}
          footer={(
            <>
              <button className="btn" onClick={() => setReject({ open: false, reason: '' })}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (await agreementAction('reject', { reason: reject.reason }, setDlgError)) {
                    setReject({ open: false, reason: '' });
                    setNote('Saved. You declined the agreement.');
                  }
                }}
              >
                Decline
              </button>
            </>
          )}
        >
          <label className="field">
            <span>Reason</span>
            <textarea rows="4" value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} />
          </label>
          {dlgError && <div className="error-text">{dlgError}</div>}
        </Modal>
      )}

    </div>
  );
}

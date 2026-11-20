import { useMemo } from 'react';
import FilterBar, { useUrlFilters, keysOfConfig } from './FilterBar.jsx';
import { AGREEMENT_STATUS_CODES, AGREEMENT_STATUS_LABELS } from '../../atsVocab.js';

// ---------------------------------------------------------------------------
// THE EXTRA FILTERS OF THE OTHER ATS LISTS (founder 2026-11-18), one config per screen for the shared FilterBar.
// The page keeps the filters it already has; these ADD to them. The values are the list route's own parameter names
// (backend/src/utils/atsListFilters.js, utils/intJoinList.js), kept in the address bar.
//
//   const xf = useListXf('requirements');            // { values, set, clear, params, key }
//   ... api.get('/requirements', { params: { ...pageParams, ...xf.params } }) ...
//   <ListFilterStrip list="requirements" xf={xf} total={n} noun="requirements" />
// ---------------------------------------------------------------------------
const opt = (list) => list.map(([value, label]) => ({ value, label }));
const WORK_MODES = opt([['Work From Office', 'Work from office'], ['Hybrid', 'Hybrid'], ['Remote', 'Remote'], ['Work From Home', 'Work from home']]);
const PRIORITIES = opt([['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]);
const IV_STATUS = opt([['SCHEDULED', 'Scheduled'], ['CONFIRMED', 'Confirmed'], ['STARTED', 'Started'], ['COMPLETED', 'Completed'], ['PENDING_FEEDBACK', 'Feedback pending'], ['FEEDBACK_SUBMITTED', 'Feedback given'], ['CANCELLED', 'Cancelled'], ['NO_SHOW', 'No show'], ['RESCHEDULED', 'Rescheduled']]);
const IV_MODE = opt([['Online', 'Online'], ['In Person', 'In person'], ['Telephonic', 'Telephonic']]);
const IV_ROUND = opt([['1', 'Round 1'], ['2', 'Round 2'], ['3', 'Round 3'], ['4', 'Round 4']]);
const BGV = opt([['Pending', 'Not started'], ['In progress', 'In progress'], ['Clear', 'Clear'], ['Discrepancy', 'Discrepancy'], ['Not needed', 'Not needed']]);
const OFFER_STATUS = opt([['Not Issued', 'Not issued'], ['Offer being prepared', 'Being prepared'], ['Offer Released', 'Offer sent'], ['Offer Accepted', 'Accepted'], ['Offer Declined', 'Declined'], ['Offer Expired', 'Expired']]);
const COUNTER = opt([['pending', 'Waiting for a decision']]);
const GUARANTEE = opt([['active', 'Guarantee running'], ['ended', 'Guarantee over'], ['none', 'No guarantee'], ['na', 'Not joined yet']]);
const INVOICE = opt([['none', 'No invoice yet'], ['Pending', 'Pending'], ['Partially Paid', 'Partly paid'], ['Paid', 'Paid'], ['Overdue', 'Overdue']]);
const FU_TYPE = opt([['Call', 'Call'], ['WhatsApp', 'WhatsApp'], ['Email', 'Email'], ['SMS', 'SMS'], ['In Person', 'In person']]);
const FU_DUE = opt([['today', 'Due today'], ['overdue', 'Overdue'], ['week', 'Due this week'], ['none', 'No due date']]);
const FU_PRIO = opt([['Urgent', 'Urgent'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]);
const PORTAL_STATUS = opt([['new', 'New'], ['resume_reviewed', 'Resume checked'], ['ai_pending', 'AI interview pending'], ['ai_completed', 'AI interview done'], ['ready', 'Ready for recruiter'], ['sent', 'Sent to ATS'], ['rejected', 'Rejected'], ['hold', 'On hold']]);

/** which screens a login may use pay / invoice filters on (the server ignores them otherwise; this only hides the boxes) */
const noPay = (u) => !!u && (u.atsRole === 'BDE' || (u.caps && u.caps.candidateContact === false));
const sawInvoices = (u) => !!u && ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'ACCOUNTANT', 'ACCOUNTS', 'BDE'].includes(u.atsRole || u.role);

export function configFor(list, user) {
  switch (list) {
    case 'requirements': return [
      { id: 'daysOpen', label: 'Days open', type: 'range', primary: true, unit: 'days', keys: { min: 'daysOpenMin', max: 'daysOpenMax' } },
      { id: 'openLeft', label: 'Openings left', type: 'range', primary: true, keys: { min: 'openLeftMin', max: 'openLeftMax' } },
      { id: 'ctc', label: 'CTC', type: 'range', primary: true, unit: 'lakh / year', step: 0.5, keys: { min: 'ctcMin', max: 'ctcMax' }, title: 'Jobs whose pay band overlaps this range' },
      { id: 'industry', label: 'Industry', type: 'text', keys: { value: 'industry' }, placeholder: 'e.g. Healthcare' },
      { id: 'posted', label: 'Posted on job sites', type: 'yesno', keys: { value: 'posted' }, yesLabel: 'Posted', noLabel: 'Not posted' },
      { id: 'workMode', label: 'Work mode', type: 'multi', keys: { value: 'workMode' }, options: WORK_MODES, allLabel: 'Any', plural: 'modes' },
    ];
    case 'clients': return [
      { id: 'priority', label: 'Priority', type: 'multi', primary: true, keys: { value: 'priority' }, options: PRIORITIES, allLabel: 'Any', plural: 'priorities' },
      { id: 'agreementStatus', label: 'Agreement status', type: 'multi', primary: true, keys: { value: 'agreementStatus' }, options: AGREEMENT_STATUS_CODES.map((c) => ({ value: c, label: AGREEMENT_STATUS_LABELS[c] || c })), allLabel: 'Any', plural: 'statuses' },
      { id: 'reqCount', label: 'Requirements', type: 'range', primary: true, keys: { min: 'reqMin', max: 'reqMax' }, title: 'How many requirements the client has' },
      { id: 'hasJoinings', label: 'Joinings', type: 'yesno', primary: true, keys: { value: 'hasJoinings' }, yesLabel: 'Has joinings', noLabel: 'No joinings yet' },
      { id: 'industry', label: 'Industry', type: 'text', keys: { value: 'industry' }, placeholder: 'e.g. Healthcare' },
      { id: 'clientSince', label: 'Client added on', type: 'daterange', primary: true, keys: { from: 'createdFrom', to: 'createdTo' } },
    ];
    case 'interviews': return [
      { id: 'ivDate', label: 'Interview date', type: 'daterange', primary: true, keys: { from: 'ivFrom', to: 'ivTo' } },
      { id: 'ivStatus', label: 'Status', type: 'multi', primary: true, keys: { value: 'ivStatus' }, options: IV_STATUS, allLabel: 'Any', plural: 'statuses' },
      { id: 'ivRound', label: 'Round', type: 'multi', primary: true, keys: { value: 'ivRound' }, options: IV_ROUND, allLabel: 'Any', plural: 'rounds' },
      { id: 'ivMode', label: 'Mode', type: 'multi', keys: { value: 'ivMode' }, options: IV_MODE, allLabel: 'Any', plural: 'modes' },
      { id: 'ivInterviewer', label: 'Interviewer', type: 'text', keys: { value: 'ivInterviewer' }, placeholder: 'Name' },
    ];
    case 'feedback': return [
      { id: 'fbDate', label: 'Interview date', type: 'daterange', primary: true, keys: { from: 'dFrom', to: 'dTo' } },
    ];
    case 'offers': return [
      { id: 'offerDate', label: 'Offer date', type: 'daterange', primary: true, keys: { from: 'dFrom', to: 'dTo' } },
      { id: 'offerStatus', label: 'Offer status', type: 'multi', primary: true, keys: { value: 'offerStatus' }, options: OFFER_STATUS, allLabel: 'Any', plural: 'statuses' },
      { id: 'offerCtc', label: 'Offered CTC', type: 'range', primary: true, show: !noPay(user), unit: 'lakh / year', step: 0.5, keys: { min: 'ctcMin', max: 'ctcMax' } },
      { id: 'bgv', label: 'BGV status', type: 'multi', keys: { value: 'bgv' }, options: BGV, allLabel: 'Any', plural: 'statuses' },
      { id: 'counter', label: 'Counter-offer', type: 'select', keys: { value: 'counter' }, options: COUNTER, allLabel: 'Any' },
    ];
    case 'joining': return [
      { id: 'joinDate', label: 'Joining date', type: 'daterange', primary: true, keys: { from: 'dFrom', to: 'dTo' } },
      { id: 'guarantee', label: 'Guarantee', type: 'multi', primary: true, keys: { value: 'guarantee' }, options: GUARANTEE, allLabel: 'Any', plural: 'statuses' },
      { id: 'invoice', label: 'Invoice', type: 'multi', primary: true, show: sawInvoices(user), keys: { value: 'invoice' }, options: INVOICE, allLabel: 'Any', plural: 'statuses' },
    ];
    case 'followups': return [
      { id: 'fuDue', label: 'Due', type: 'select', primary: true, keys: { value: 'fuDue' }, options: FU_DUE, allLabel: 'Any time' },
      { id: 'fuDates', label: 'Due between', type: 'daterange', primary: true, keys: { from: 'fuFrom', to: 'fuTo' } },
      { id: 'fuType', label: 'Type', type: 'multi', primary: true, keys: { value: 'fuType' }, options: FU_TYPE, allLabel: 'Any', plural: 'types' },
      { id: 'fuPriority', label: 'Priority', type: 'multi', primary: true, keys: { value: 'fuPriority' }, options: FU_PRIO, allLabel: 'Any', plural: 'priorities' },
      { id: 'fuCandidate', label: 'Candidate', type: 'text', keys: { value: 'fuCandidate' }, placeholder: 'Name' },
      { id: 'fuRequirement', label: 'Requirement', type: 'text', keys: { value: 'fuRequirement' }, placeholder: 'Title or code' },
    ];
    case 'portal': return [
      { id: 'jpDate', label: 'Applied on', type: 'daterange', primary: true, keys: { from: 'jpFrom', to: 'jpTo' } },
      { id: 'jpStatus', label: 'Status', type: 'multi', primary: true, keys: { value: 'jpStatus' }, options: PORTAL_STATUS, allLabel: 'Any', plural: 'statuses' },
      { id: 'jpSource', label: 'Source', type: 'text', primary: true, keys: { value: 'jpSource' }, placeholder: 'e.g. Naukri' },
      { id: 'jpLocation', label: 'Location', type: 'text', keys: { value: 'jpLocation' }, placeholder: 'City' },
    ];
    case 'calllists': return [
      { id: 'cDate', label: 'List made on', type: 'daterange', primary: true, keys: { from: 'from', to: 'to' } },
      { id: 'source', label: 'Source (list or file)', type: 'text', primary: true, keys: { value: 'source' }, placeholder: 'Name' },
    ];
    case 'callrows': return [
      { id: 'location', label: 'Location', type: 'text', primary: true, keys: { value: 'location' }, placeholder: 'City' },
      { id: 'cDate', label: 'Added on', type: 'daterange', primary: true, keys: { from: 'cFrom', to: 'cTo' } },
      { id: 'called', label: 'Called', type: 'yesno', primary: true, keys: { value: 'called' }, yesLabel: 'Called', noLabel: 'Not called yet' },
      { id: 'interest', label: 'Interested in', type: 'text', keys: { value: 'interest' }, placeholder: 'Text' },
    ];
    // ---- HRMS lists (2026-11-20)
    case 'exitrecords': return [
      { id: 'q', label: 'Search exits', type: 'text', primary: true, keys: { value: 'q' }, placeholder: 'Name, ID or reason' },
      { id: 'lwd', label: 'Last working day', type: 'daterange', primary: true, keys: { from: 'lwdFrom', to: 'lwdTo' } },
      { id: 'started', label: 'Exit started on', type: 'daterange', primary: true, keys: { from: 'startFrom', to: 'startTo' } },
    ];
    case 'employees': return [
      { id: 'location', label: 'Location', type: 'multi', primary: true, keys: { value: 'location' }, allLabel: 'All locations', plural: 'locations' },
      { id: 'joined', label: 'Joined the company', type: 'daterange', primary: true, keys: { from: 'jFrom', to: 'jTo' } },
      { id: 'empType', label: 'Employee type', type: 'multi', primary: true, keys: { value: 'empType' }, allLabel: 'Any', plural: 'types' },
      { id: 'manager', label: 'Reporting manager', type: 'multi', keys: { value: 'manager' }, allLabel: 'Any', plural: 'managers' },
      { id: 'tl', label: 'Team lead', type: 'multi', keys: { value: 'tl' }, allLabel: 'Any', plural: 'team leads' },
      { id: 'team', label: 'Team', type: 'multi', keys: { value: 'team' }, allLabel: 'Any', plural: 'teams' },
    ];
    case 'paystructures': return [
      { id: 'ctc', label: 'CTC per month', type: 'range', primary: true, unit: 'rupees', step: 1000, keys: { min: 'ctcMin', max: 'ctcMax' } },
      { id: 'net', label: 'Net per month', type: 'range', primary: true, unit: 'rupees', step: 1000, keys: { min: 'netMin', max: 'netMax' } },
      { id: 'location', label: 'Location', type: 'multi', keys: { value: 'location' }, allLabel: 'All locations', plural: 'locations' },
    ];
    case 'payruns': return [
      { id: 'month', label: 'Month', type: 'daterange', primary: true, keys: { from: 'mFrom', to: 'mTo' }, title: 'The first and last month (pick any day in it)' },
      { id: 'net', label: 'Net paid', type: 'range', primary: true, unit: 'rupees', step: 10000, keys: { min: 'netMin', max: 'netMax' } },
    ];
    case 'leaverequests': return [
      { id: 'days', label: 'Days of leave', type: 'range', primary: true, step: 0.5, keys: { min: 'daysMin', max: 'daysMax' } },
      { id: 'applied', label: 'Applied on', type: 'daterange', primary: true, keys: { from: 'aFrom', to: 'aTo' } },
      { id: 'location', label: 'Location', type: 'multi', keys: { value: 'location' }, allLabel: 'All locations', plural: 'locations' },
    ];
    // ---- CRM lists (2026-11-20): the search boxes and filters the pages already have stay; these add dates, amounts and places
    case 'crmleads': return [
      { id: 'cDate', label: 'Added on', type: 'daterange', primary: true, keys: { from: 'cFrom', to: 'cTo' } },
      { id: 'city', label: 'City', type: 'text', primary: true, keys: { value: 'city' }, placeholder: 'City' },
      { id: 'industry', label: 'Industry', type: 'text', primary: true, keys: { value: 'industry' }, placeholder: 'e.g. Hospital' },
    ];
    case 'crmaccounts': return [
      { id: 'cDate', label: 'Added on', type: 'daterange', primary: true, keys: { from: 'cFrom', to: 'cTo' } },
      { id: 'city', label: 'City', type: 'text', primary: true, keys: { value: 'city' }, placeholder: 'City' },
      { id: 'industry', label: 'Industry', type: 'text', primary: true, keys: { value: 'industry' }, placeholder: 'e.g. Hospital' },
      { id: 'source', label: 'Source', type: 'text', keys: { value: 'source' }, placeholder: 'e.g. Website' },
    ];
    case 'crmcontacts': return [
      { id: 'cDate', label: 'Added on', type: 'daterange', primary: true, keys: { from: 'cFrom', to: 'cTo' } },
      { id: 'role', label: 'Role', type: 'multi', primary: true, keys: { value: 'role' }, options: opt([['Decision maker', 'Decision maker'], ['HR', 'HR'], ['Influencer', 'Influencer'], ['Finance', 'Finance'], ['Other', 'Other']]), allLabel: 'Any', plural: 'roles' },
    ];
    case 'crmdeals': return [
      { id: 'dealValue', label: 'Deal value', type: 'range', primary: true, unit: 'rupees', step: 1000, keys: { min: 'valueMin', max: 'valueMax' } },
      { id: 'dealStage', label: 'Stage', type: 'multi', primary: true, keys: { value: 'stage' }, options: opt(['Prospecting', 'Contacted', 'Meeting', 'Requirement discussed', 'Proposal sent', 'Negotiation', 'Won', 'Lost'].map((s) => [s, s])), allLabel: 'Any', plural: 'stages' },
      { id: 'close', label: 'Expected close', type: 'daterange', primary: true, keys: { from: 'closeFrom', to: 'closeTo' } },
      { id: 'cDate', label: 'Added on', type: 'daterange', keys: { from: 'cFrom', to: 'cTo' } },
    ];
    case 'crminvoices': return [
      { id: 'amount', label: 'Invoice total', type: 'range', primary: true, unit: 'rupees', step: 1000, keys: { min: 'amtMin', max: 'amtMax' } },
      { id: 'issue', label: 'Issued on', type: 'daterange', primary: true, keys: { from: 'issueFrom', to: 'issueTo' } },
      { id: 'due', label: 'Due on', type: 'daterange', primary: true, keys: { from: 'dueFrom', to: 'dueTo' } },
    ];
    case 'crmtasks': return [
      { id: 'q', label: 'Search follow-ups', type: 'text', primary: true, keys: { value: 'q' }, placeholder: 'Task, lead, deal or account' },
    ];
    case 'crmcampaigns': return [
      { id: 'q', label: 'Search campaigns', type: 'text', primary: true, keys: { value: 'q' }, placeholder: 'Campaign name' },
      { id: 'status', label: 'Status', type: 'multi', primary: true, keys: { value: 'status' }, options: opt([['Draft', 'Draft'], ['Sending', 'Sending'], ['Sent', 'Sent'], ['Cancelled', 'Cancelled']]), allLabel: 'Any', plural: 'statuses' },
      { id: 'channel', label: 'Sent by', type: 'multi', primary: true, keys: { value: 'channel' }, options: opt([['email', 'Email'], ['whatsapp', 'WhatsApp']]), allLabel: 'Any', plural: 'channels' },
      { id: 'cDate', label: 'Made on', type: 'daterange', keys: { from: 'cFrom', to: 'cTo' } },
    ];
    case 'team': return [
      { id: 'period', label: 'Results for', type: 'period', primary: true, keys: { range: 'range', from: 'from', to: 'to' }, title: 'Sent to client, interviews, joinings and target for a date range' },
      { id: 'location', label: 'Location', type: 'select', primary: true, keys: { value: 'location' }, allLabel: 'All locations' },
      { id: 'perf', label: 'Performance', type: 'select', primary: true, keys: { value: 'perf' }, allLabel: 'Any' },
      { id: 'ach', label: 'Target', type: 'select', primary: true, keys: { value: 'ach' }, allLabel: 'Any' },
      { id: 'stl', label: 'Senior team lead', type: 'select', keys: { value: 'stl' }, allLabel: 'Any' },
      { id: 'seat', label: 'Seat', type: 'select', keys: { value: 'seat' }, allLabel: 'All seats' },
      { id: 'empStatus', label: 'HR status', type: 'select', keys: { value: 'empStatus' }, allLabel: 'Any' },
      { id: 'joinedCo', label: 'Joined the company', type: 'daterange', keys: { from: 'jFrom', to: 'jTo' } },
      { id: 'open', label: 'Open work', type: 'yesno', keys: { value: 'open' }, yesLabel: 'Has open work', noLabel: 'No open work' },
      { id: 'hasJoin', label: 'Joinings', type: 'yesno', keys: { value: 'hasJoin' }, yesLabel: 'Has joinings', noLabel: 'No joinings' },
    ];
    default: return [];
  }
}

/** the screen's extra filters, kept in the address bar */
export function useListXf(list, user, { onWrite, extraKeys = [] } = {}) {
  const keys = useMemo(() => [...keysOfConfig(configFor(list, user)), ...extraKeys], [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const u = useUrlFilters(keys, { onWrite });
  return {
    values: u.values, set: u.set, clear: u.clear, replace: u.replace, params: u.values, key: u.sig,
  };
}

export function ListFilterStrip({
  list, xf, user, total = null, noun = 'results', saved = null, allTime,
}) {
  const config = useMemo(() => configFor(list, user), [list, user]);
  // the options are fixed words: the counts are the list's own total
  const count = Object.keys(xf.values).length;
  return (
    <FilterBar
      config={config}
      values={xf.values}
      onChange={xf.set}
      facets={{}}
      total={total}
      noun={noun}
      onClear={xf.clear}
      canClear={count > 0}
      allTime={allTime !== undefined ? allTime : count > 0}
      saved={saved}
      storageKey={`list-${list}`}
      className={`fbar-${list}`}
    />
  );
}

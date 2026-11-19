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
    ];
    case 'interviews': return [
      { id: 'ivDate', label: 'Interview date', type: 'daterange', primary: true, keys: { from: 'ivFrom', to: 'ivTo' } },
      { id: 'ivStatus', label: 'Status', type: 'multi', primary: true, keys: { value: 'ivStatus' }, options: IV_STATUS, allLabel: 'Any', plural: 'statuses' },
      { id: 'ivRound', label: 'Round', type: 'multi', primary: true, keys: { value: 'ivRound' }, options: IV_ROUND, allLabel: 'Any', plural: 'rounds' },
      { id: 'ivMode', label: 'Mode', type: 'multi', keys: { value: 'ivMode' }, options: IV_MODE, allLabel: 'Any', plural: 'modes' },
      { id: 'ivInterviewer', label: 'Interviewer', type: 'text', keys: { value: 'ivInterviewer' }, placeholder: 'Name' },
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
    default: return [];
  }
}

/** the screen's extra filters, kept in the address bar */
export function useListXf(list, user, { onWrite } = {}) {
  const keys = useMemo(() => keysOfConfig(configFor(list, user)), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const u = useUrlFilters(keys, { onWrite });
  return {
    values: u.values, set: u.set, clear: u.clear, replace: u.replace, params: u.values, key: u.sig,
  };
}

export function ListFilterStrip({
  list, xf, user, total = null, noun = 'results', saved = null,
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
      saved={saved}
      storageKey={`list-${list}`}
      className={`fbar-${list}`}
    />
  );
}

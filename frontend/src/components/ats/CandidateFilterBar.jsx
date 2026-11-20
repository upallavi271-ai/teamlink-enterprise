import { useMemo } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import FilterBar, { useUrlFilters } from './FilterBar.jsx';

// ---------------------------------------------------------------------------
// THE RECRUITER'S FILTERS ON THE CANDIDATES SCREEN (founder 2026-11-18). One config for the pipeline and the People list; the
// options and their counts come from GET /ats-io/facets/candidates (only over the people this login may see). A role that may not
// see pay / locations simply gets no such facet from the server: those controls are not drawn.
//
// The new filters live here (useCandidateXf, kept in the address bar); the filters the page already owns (specialization,
// qualification, step, status, owner, client, requirement, source, tag) are routed back to the page's own state, so there is ONE
// value for each.
// ---------------------------------------------------------------------------
export const XF_KEYS = [
  'ctcCurMin', 'ctcCurMax', 'ctcCurBucket', 'ctcExpMin', 'ctcExpMax', 'ctcExpBucket', 'expMin', 'expMax',
  'locCur', 'locPref', 'locNative', 'jobTitle', 'skillSet', 'skillMode', 'noticeBand', 'workMode', 'empType',
  'addedFrom', 'addedTo', 'updatedFrom', 'updatedTo', 'contactedFrom', 'contactedTo', 'sharedFrom', 'sharedTo',
  'resume', 'scoreMin', 'scoreMax', 'scoreBucket', 'dup',
];
// the page's own filters this bar also edits
const PAGE_KEYS = ['spec', 'qual', 'stage', 'status', 'owner', 'clientId', 'requirementId', 'source', 'tag'];

/** the new filters' state, in the address bar. onWrite: the page marks the address change as its own. */
export function useCandidateXf({ onWrite } = {}) {
  const u = useUrlFilters(XF_KEYS, { onWrite });
  return {
    values: u.values, set: u.set, clear: u.clear, replace: u.replace, params: u.values, key: u.sig,
  };
}

// The existing page filters that were not in the address bar: kept there now, so Back from a candidate keeps them.
export const URL_FILTER_KEYS = ['location', 'spec', 'qual', 'desig', 'expBand', 'notice', 'tag', 'skills', 'minExp', 'maxExp', 'maxSalary', 'minMatch',
  'qualificationId', 'specialisationId', 'owner', 'contact', 'rejectedBefore', 'salaryFit', 'appliedFrom', 'appliedTo', 'contactAge'];
export function readUrlFilters(sp) {
  const out = {};
  URL_FILTER_KEYS.forEach((k) => { const v = sp.get(k); if (v) out[k] = v; });
  return out;
}
/** writes the page's filters into `sp`; true when something changed */
export function writeUrlFilters(sp, filters) {
  let changed = false;
  URL_FILTER_KEYS.forEach((k) => {
    const v = (filters && filters[k]) || '';
    if ((sp.get(k) || '') !== v) { if (v) sp.set(k, v); else sp.delete(k); changed = true; }
  });
  return changed;
}

export function candidateConfig(f) {
  // f: { ctc, loc, priv, internal } = which groups the server offered (decided from the facets it sent)
  return [
    { id: 'locCur', label: 'Current location', type: 'multi', primary: true, show: f.loc, keys: { value: 'locCur' }, allLabel: 'Any location', plural: 'locations', title: 'Where the person lives now, with how many people in each place' },
    { id: 'spec', label: 'Specialization', type: 'select', primary: true, keys: { value: 'spec' }, allLabel: 'All specializations' },
    { id: 'ctcCur', label: 'Current CTC', type: 'range', primary: true, show: f.ctc, unit: 'lakh / year', step: 0.5, keys: { min: 'ctcCurMin', max: 'ctcCurMax', bucket: 'ctcCurBucket' }, facet: 'ctcCurBucket' },
    { id: 'ctcExp', label: 'Expected CTC', type: 'range', primary: true, show: f.ctc, unit: 'lakh / year', step: 0.5, keys: { min: 'ctcExpMin', max: 'ctcExpMax', bucket: 'ctcExpBucket' }, facet: 'ctcExpBucket' },
    { id: 'exp', label: 'Experience', type: 'range', primary: true, unit: 'years', step: 0.5, keys: { min: 'expMin', max: 'expMax' } },
    { id: 'noticeBand', label: 'Notice period', type: 'multi', primary: true, keys: { value: 'noticeBand' }, allLabel: 'Any notice', plural: 'bands' },
    { id: 'stage', label: 'Stage', type: 'select', primary: true, show: !f.master, keys: { value: 'stage' }, allLabel: 'All stages', facet: '_stage' },
    // ---- more filters
    { id: 'locPref', label: 'Preferred location', type: 'multi', show: f.loc, keys: { value: 'locPref' }, allLabel: 'Any', plural: 'locations', title: 'Places the person is willing to work in' },
    { id: 'locNative', label: 'Native / hometown', type: 'multi', show: f.loc, keys: { value: 'locNative' }, allLabel: 'Any', plural: 'places' },
    { id: 'jobTitle', label: 'Job title', type: 'multi', show: f.internal, keys: { value: 'jobTitle' }, allLabel: 'Any title', plural: 'titles', title: 'The standardised job title from the Career tab' },
    { id: 'qual', label: 'Education', type: 'select', keys: { value: 'qual' }, allLabel: 'All qualifications' },
    { id: 'skillSet', label: 'Skills', type: 'multimode', keys: { value: 'skillSet', mode: 'skillMode' }, allLabel: 'Any skill', plural: 'skills' },
    { id: 'workMode', label: 'Work mode', type: 'multi', show: f.internal, keys: { value: 'workMode' }, allLabel: 'Any', plural: 'modes' },
    { id: 'empType', label: 'Employment type', type: 'multi', show: f.internal, keys: { value: 'empType' }, allLabel: 'Any', plural: 'types' },
    { id: 'source', label: 'Source', type: 'multi', show: f.internal, keys: { value: 'source' }, allLabel: 'All sources', plural: 'sources' },
    { id: 'status', label: 'Status', type: 'select', show: !f.master, keys: { value: 'status' }, allLabel: 'All statuses' },
    { id: 'owner', label: 'Owner', type: 'select', show: f.internal && !f.master, keys: { value: 'owner' }, allLabel: 'Anyone', title: 'Whose move it is now' },
    { id: 'clientId', label: 'Client', type: 'select', keys: { value: 'clientId' }, allLabel: 'All clients' },
    { id: 'requirementId', label: 'Requirement', type: 'select', keys: { value: 'requirementId' }, allLabel: 'All requirements' },
    { id: 'tag', label: 'Tags', type: 'multi', show: f.internal, keys: { value: 'tag' }, allLabel: 'Any tag', plural: 'tags' },
    { id: 'added', label: 'Added on', type: 'daterange', primary: true, show: f.dates, keys: { from: 'addedFrom', to: 'addedTo' } },
    { id: 'updated', label: 'Last updated', type: 'daterange', show: f.dates, keys: { from: 'updatedFrom', to: 'updatedTo' } },
    { id: 'contacted', label: 'Last contacted', type: 'daterange', show: f.dates, keys: { from: 'contactedFrom', to: 'contactedTo' } },
    { id: 'shared', label: 'Shared with client', type: 'daterange', show: f.dates, keys: { from: 'sharedFrom', to: 'sharedTo' } },
    { id: 'resume', label: 'Resume', type: 'yesno', show: f.loc, keys: { value: 'resume' }, yesLabel: 'On file', noLabel: 'Not on file' },
    { id: 'score', label: 'Profile completeness', type: 'range', show: f.loc, unit: '%', step: 5, keys: { min: 'scoreMin', max: 'scoreMax', bucket: 'scoreBucket' }, facet: 'scoreBucket' },
    { id: 'dup', label: 'Duplicate', type: 'select', show: f.internal, keys: { value: 'dup' }, allLabel: 'Either' },
  ];
}

export default function CandidateFilterBar({
  xf, filters, setFilter, facets, loading, total, stageOptions, onClear, canClear, saved, master = false,
}) {
  // what the server offered tells which groups this login may use
  const { user } = useAuth() || {};
  const groups = { ctc: facets.ctcCurBucket !== undefined, loc: facets.locCur !== undefined, internal: facets.dup !== undefined, dates: !!user && !['CLIENT', 'CANDIDATE'].includes(user.role) && !['CLIENT', 'CANDIDATE'].includes(user.atsRole), master }; // the date filters belong to every staff login: they do not wait for the facets to answer
  const config = useMemo(() => candidateConfig(groups), [groups.ctc, groups.loc, groups.internal, groups.dates, groups.master]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = { ...xf.values };
  PAGE_KEYS.forEach((k) => { if (filters[k]) values[k] = filters[k]; });
  const onChange = (patch) => {
    const mine = {}; const page = {};
    Object.entries(patch).forEach(([k, v]) => { if (XF_KEYS.includes(k)) mine[k] = v; else page[k] = v; });
    if (Object.keys(mine).length) xf.set(mine);
    if (Object.keys(page).length) {
      // choosing another client clears the requirement picked under the old one (as the page's own filter does)
      if ('clientId' in page) page.requirementId = '';
      setFilter(page);
    }
  };
  const merged = {
    ...facets,
    _stage: stageOptions || [],
    status: (facets.status || []).map((o) => ({ ...o, label: o.value === 'Hold' ? 'On hold' : o.label })),
    dup: (facets.dup || []).filter((o) => o.value === 'yes'),
    resume: undefined,
  };
  return (
    <FilterBar
      config={config}
      values={values}
      onChange={onChange}
      facets={merged}
      loading={loading}
      total={total}
      noun="candidates"
      onClear={onClear}
      saved={saved}
      chipSkip={['source', 'status', 'stage', 'owner', 'clientId', 'requirementId', 'tag']}
      canClear={canClear}
      allTime={!!canClear}
      storageKey="cand"
      className="fbar-cand"
    />
  );
}

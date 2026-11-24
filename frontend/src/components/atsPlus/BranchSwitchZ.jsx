import { useEffect, useState } from 'react';
import api from '../../api';
import { t } from '../../i18n.jsx';

// ---------------------------------------------------------------------------
// THE WORKING BRANCH SWITCH (market benchmark 05.11, ATS wave 2 Z, 2026-11-25). Branches or group companies are set up in
// Administration -> ATS settings -> Organisation -> Branches. This switch sits on the working lists (Clients, Requirements):
// pick a branch and the list shows only that branch's clients / jobs (a job follows its client's branch unless it has its own).
// The choice is kept in this browser and follows the person from list to list; "All branches" switches it off.
// It only NARROWS what the person may already see: the server applies `branch` after the list's own scope
// (backend/src/utils/atsListFilters.js -> utils/atsPlus/people.js branchScope). No branches set up = nothing is drawn.
//
//   const [branch] = useWorkingBranch();          ... api.get('/requirements', { params: { ...p, ...(branch ? { branch } : {}) } })
//   <BranchSwitchZ />                             the switch (with this branch's counts from GET /ats-plus/branches/scope)
// ---------------------------------------------------------------------------
const KEY = 'tl_ats_branch';
let current = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
const listeners = new Set();
export function setWorkingBranch(b) {
  current = String(b || '');
  try { if (current) localStorage.setItem(KEY, current); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  listeners.forEach((fn) => fn(current));
}
export function useWorkingBranch() {
  const [b, set] = useState(current);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return [b, setWorkingBranch];
}

let branchCache = null; // one read per page load: { at, list }
function loadBranches() {
  if (branchCache && Date.now() - branchCache.at < 60000) return Promise.resolve(branchCache.list);
  return api.get('/ats-plus/branches').then((r) => { branchCache = { at: Date.now(), list: (r.data && r.data.branches) || [] }; return branchCache.list; }).catch(() => []);
}

export default function BranchSwitchZ({ what = 'list' }) {
  const [branch, setBranch] = useWorkingBranch();
  const [list, setList] = useState(null);
  const [scope, setScope] = useState(null);
  useEffect(() => { loadBranches().then((l) => setList(l)); }, []);
  // a branch that was removed in the settings is not kept as the working branch
  useEffect(() => { if (list && branch && !list.some((b) => b.name === branch)) setBranch(''); }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!branch) { setScope(null); return; }
    api.get('/ats-plus/branches/scope', { params: { branch } }).then((r) => setScope(r.data)).catch(() => setScope(null));
  }, [branch]);
  if (!list || !list.length) return null;
  return (
    <div className="branch-switch-z" data-testid="branch-switch" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 8px' }}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
        <span>{t('Branch')}</span>
        <select aria-label={t('Working branch')} value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">{t('All branches')}</option>
          {list.map((b) => <option key={b.name} value={b.name}>{b.name}{b.city ? ` (${b.city})` : ''}</option>)}
        </select>
      </label>
      {branch && (
        <span className="small-muted" data-testid="branch-switch-note">
          {t('Showing only {branch}', { branch })}
          {scope ? ` · ${scope.clientIds.length} ${t('clients')} · ${scope.requirementIds.length} ${t('jobs')} · ${scope.userIds.length} ${t('people')}` : ''}
          {' '}<button type="button" className="btn btn-sm btn-ghost" onClick={() => setBranch('')}>{t('All branches')}</button>
        </span>
      )}
      {!branch && what && <span className="small-muted">{t('Pick a branch to work on its {what} only.', { what: t(what) })}</span>}
    </div>
  );
}

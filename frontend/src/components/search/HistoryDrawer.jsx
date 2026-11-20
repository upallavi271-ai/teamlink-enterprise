import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import RecruiterHistory from '../ats/RecruiterHistory.jsx';
import TlHistory from '../ats/TlHistory.jsx';
import ClientHistory from '../ats/ClientHistory.jsx';
import HistoryTab from '../ats/HistoryTab.jsx';
import CandidateHistory from '../ats/CandidateHistory.jsx';
import {
  getDrawerList, hostMounted, mountHost, parseOpen, parseTarget, targetKey, useHistoryOpener,
} from './historyOpen.jsx';
import './search.css';

// ---------------------------------------------------------------------------
// THE HISTORY DRAWER (founder 2026-11-20). A person, client, requirement or candidate History opens in a large side drawer (about 80% of the
// width, full height; full screen on a phone) OVER the page that is open: the search box, the results and the scroll position underneath stay
// exactly as they were. The drawer is driven by the address (?open=recruiter:<id>), so Refresh restores it and the browser Back button closes it.
//   Close (X) / Esc / click outside / Back   closes          "Open as a full page"   the same History as its own page
//   Previous / Next                          the next result of the same group, without closing
// One host, mounted once in the page frame (Shell.jsx), serves the Search page, the dashboard bar, the top-bar typeahead and every name link
// (<HLink>). The History components are the ones the full pages use, so there is one set of screens.
// ---------------------------------------------------------------------------
const TITLE = { recruiter: 'Recruiter history', tl: 'Team history', candidate: 'Candidate history', client: 'Client history', requirement: 'Requirement history' };
const FULL = {
  recruiter: (id) => `/ats/history/recruiter/${id}`, tl: (id) => `/ats/history/tl/${id}`, candidate: (id) => `/ats/history/candidate/${id}`,
  client: (id) => `/clients/${id}?tab=history`, requirement: (id) => `/requirements/${id}?tab=history`,
};

export default function HistoryDrawerHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const openIt = useHistoryOpener();
  const sp = new URLSearchParams(location.search);
  const target = parseOpen(sp.get('open'));
  const focus = sp.get('focus') || '';
  const panel = useRef(null);
  const close = () => {
    if (location.state && location.state.drawer) { navigate(-1); return; } // the drawer was pushed on top of the page: Back is exactly "close"
    const next = new URLSearchParams(location.search);
    next.delete('open'); next.delete('focus');
    const qs = next.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true, state: null });
  };

  useEffect(() => mountHost(), []);
  const key = target ? targetKey(target) : '';
  useEffect(() => {
    if (!key) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => { if (panel.current) panel.current.focus(); }, 30);
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Previous / Next among the results of the group the person opened from
  const nav = useMemo(() => {
    if (!target) return null;
    const rows = getDrawerList().filter((r) => parseTarget(r.to));
    const idx = rows.findIndex((r) => { const t = parseTarget(r.to); return t.kind === target.kind && t.id === target.id; });
    return { rows, idx, row: idx >= 0 ? rows[idx] : null };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!target || !hostMounted()) return null;
  const go = (d) => { const r = nav.rows[nav.idx + d]; if (r) openIt(r, { replace: true }); };
  const hasNav = nav && nav.rows.length > 1 && nav.idx >= 0;
  const heading = (nav && nav.row && (nav.row.title || nav.row.name)) || TITLE[target.kind];
  return createPortal(
    <div className="hxd-wrap" role="presentation">
      <div className="hxd-back" onMouseDown={close} aria-hidden="true" />
      <aside className="hxd-panel" role="dialog" aria-modal="true" aria-label={TITLE[target.kind]} ref={panel} tabIndex={-1}>
        <div className="hxd-bar">
          <button type="button" className="hxd-x hxd-back-arrow" onClick={close} aria-label="Back to the results">←</button>
          <div className="hxd-title"><span className="hxd-kind">{TITLE[target.kind]}</span><b>{heading}</b></div>
          {hasNav && (
            <div className="hxd-nav">
              <button type="button" className="btn btn-sm" onClick={() => go(-1)} disabled={nav.idx <= 0} aria-label="Previous result">‹ Previous</button>
              <span className="hxd-pos">{nav.idx + 1} of {nav.rows.length}</span>
              <button type="button" className="btn btn-sm" onClick={() => go(1)} disabled={nav.idx >= nav.rows.length - 1} aria-label="Next result">Next ›</button>
            </div>
          )}
          <Link className="btn btn-sm" to={FULL[target.kind](target.id) + (focus ? `${target.kind === 'client' ? '&' : '?'}focus=${encodeURIComponent(focus)}` : '')} onClick={() => { /* a plain navigation: the drawer is left behind with the page */ }}>Open as a full page</Link>
          <button type="button" className="btn btn-sm btn-primary hxd-x" onClick={close} aria-label="Close the history">Close ✕</button>
        </div>
        <div className="hxd-body" data-testid="history-drawer-body">
          {target.kind === 'recruiter' && <RecruiterHistory key={target.id} personId={target.id} embedded />}
          {target.kind === 'tl' && <TlHistory key={target.id} personId={target.id} embedded />}
          {target.kind === 'candidate' && <CandidateHistory key={target.id} candidateId={target.id} embedded />}
          {target.kind === 'client' && <ClientHistory key={target.id} clientId={target.id} />}
          {target.kind === 'requirement' && <HistoryTab key={target.id} requirementId={target.id} />}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

import { useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// OPEN A HISTORY IN PLACE (founder 2026-11-20: "when I click History it opens a new page, I have to come back, search again and scroll down again").
// A history opens in the side drawer (HistoryDrawer.jsx) OVER the page the person is on: the address gets ?open=recruiter:<id> (and &focus=...),
// the page underneath stays exactly as it was. Back closes the drawer. Ctrl / middle click still opens the full page in a new tab.
//   parseTarget(to)        a history address -> { kind, id, focus } | null   (kind: recruiter | tl | candidate | client | requirement)
//   useHistoryOpener()     (rowOrAddress, { list, replace }) -> true when it was opened in the drawer
//   <HLink to="...">       a Link that opens the drawer for a history address (when the drawer is on the page), else navigates
// ---------------------------------------------------------------------------
export const KINDS = ['recruiter', 'tl', 'candidate', 'client', 'requirement'];

export function parseTarget(to) {
  const s = String(to || '');
  const [path, query = ''] = s.split('?');
  const q = new URLSearchParams(query);
  let m = /^\/ats\/history\/(recruiter|tl|candidate)\/([^/]+)$/.exec(path);
  if (m) return { kind: m[1], id: m[2], focus: q.get('focus') || '' };
  m = /^\/clients\/([^/]+)$/.exec(path);
  if (m && q.get('tab') === 'history') return { kind: 'client', id: m[1], focus: q.get('focus') || '' };
  m = /^\/requirements\/([^/]+)$/.exec(path);
  if (m && q.get('tab') === 'history') return { kind: 'requirement', id: m[1], focus: '' };
  return null;
}
export const drawerTarget = (row) => parseTarget(row && row.to);
export const targetKey = (t) => `${t.kind}:${t.id}`;
export const parseOpen = (open) => {
  const [kind, ...rest] = String(open || '').split(':');
  const id = rest.join(':');
  return KINDS.includes(kind) && id ? { kind, id } : null;
};

// the results the drawer steps through with Previous / Next (the group the person opened from)
let list = [];
export const setDrawerList = (rows) => { list = Array.isArray(rows) ? rows : []; };
export const getDrawerList = () => list;
let hosts = 0;
export const mountHost = () => { hosts += 1; return () => { hosts -= 1; }; };
export const hostMounted = () => hosts > 0;

export function useHistoryOpener() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback((rowOrTo, opts = {}) => {
    const to = typeof rowOrTo === 'string' ? rowOrTo : rowOrTo && rowOrTo.to;
    const t = parseTarget(to);
    if (!t || !hostMounted()) return false;
    if (opts.list) setDrawerList(opts.list);
    const sp = new URLSearchParams(location.search);
    const already = sp.has('open');
    sp.set('open', targetKey(t));
    if (t.focus) sp.set('focus', t.focus); else sp.delete('focus');
    navigate({ pathname: location.pathname, search: `?${sp.toString()}` }, { replace: opts.replace !== undefined ? opts.replace : already, state: { ...(location.state || {}), drawer: !already || !!(location.state && location.state.drawer) } });
    return true;
  }, [navigate, location]);
}

const plainClick = (e) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

export function HLink({
  to, children, onClick, ...rest
}) {
  const open = useHistoryOpener();
  const click = (e) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented || !plainClick(e) || !parseTarget(to)) return;
    if (open(to)) e.preventDefault();
  };
  return <Link to={to} onClick={click} {...rest}>{children}</Link>;
}

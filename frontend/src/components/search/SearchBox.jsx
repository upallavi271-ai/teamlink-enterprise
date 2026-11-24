import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../../api';
import { GroupRows } from './SearchResults.jsx';
import { useHistoryOpener } from './historyOpen.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import './search.css';

// ---------------------------------------------------------------------------
// THE ONE SEARCH BOX. The top bar's "Search TeamLink" (variant "compact") and the big bar on every ATS dashboard (variant "bar") are this component,
// asking the one endpoint GET /api/ats/history/search?mode=type. Results appear as you type (200 ms pause, a slower answer never replaces a newer
// one), grouped, each opening its complete history; Enter opens the full results page (/ats/search); the last 5 searches show when the box is
// focused and empty; "/" focuses the box. Works on a phone: the panel is as wide as the screen.
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 200;
const RECENT_KEY = 'tl_recent_searches';
const readRecent = () => {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : []; } catch { return []; }
};
const saveRecent = (term) => {
  try {
    const list = [term, ...readRecent().filter((x) => x.toLowerCase() !== term.toLowerCase())].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private window: no recent list */ }
};

// "/" goes to the biggest search box on the page (the dashboard bar when there is one)
const boxes = new Set();
let slashBound = false;
function bindSlash() {
  if (slashBound || typeof document === 'undefined') return;
  slashBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    const list = [...boxes].filter((b) => b.el && b.el.offsetParent !== null).sort((a, b) => b.weight - a.weight);
    if (!list.length) return;
    e.preventDefault();
    list[0].el.focus();
  });
}

export default function SearchBox({ variant = 'compact', placeholder = 'Search TeamLink', autoFocus = false, crmOnly = false }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const openHistory = useHistoryOpener();
  // CRM records (leads, accounts, contacts, deals) join the results for a login on the CRM team (GET /api/crm/plusc/search, scoped by the CRM's own rules)
  const { user } = useAuth() || {};
  const crm = !!(user && user.crmRole);
  const [crmData, setCrmData] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState([]);
  const wrap = useRef(null);
  const input = useRef(null);
  const ctl = useRef(null);
  const bar = variant === 'bar';

  useEffect(() => {
    bindSlash();
    const entry = { el: input.current, weight: bar ? 2 : 1 };
    boxes.add(entry);
    return () => { boxes.delete(entry); };
  }, [bar]);
  useEffect(() => { if (autoFocus && input.current) input.current.focus(); }, [autoFocus]);

  // typeahead: 200 ms pause, the previous request is cancelled
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { if (ctl.current) ctl.current.abort(); setData(null); setError(''); setBusy(false); return undefined; }
    if (crmOnly) { setData({ groups: [], total: 0 }); setError(''); setBusy(false); return undefined; }
    setBusy(true);
    const t = setTimeout(() => {
      if (ctl.current) ctl.current.abort();
      const c = new AbortController();
      ctl.current = c;
      api.get('/ats/history/search', { params: { q: term, mode: 'type' }, signal: c.signal })
        .then((res) => { if (!c.signal.aborted) { setData(res.data); setError(''); setBusy(false); } })
        .catch((e) => {
          if (c.signal.aborted || (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError'))) return;
          setData(null); setError('Search is not available right now.'); setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const term = q.trim();
    if (!crm || term.length < 2) { setCrmData(null); return undefined; }
    let live = true;
    const t = setTimeout(() => api.get('/crm/plusc/search', { params: { q: term } }).then((r) => { if (live) setCrmData(r.data); }).catch(() => { if (live) setCrmData(null); }), DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [q, crm]);

  useEffect(() => { setOpen(false); setActive(-1); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  const groups = useMemo(() => [...(data ? data.groups || [] : []), ...(crmData ? crmData.groups || [] : [])], [data, crmData]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => { setActive(-1); }, [data]);
  const term = q.trim();
  const showRecent = open && term.length < 2 && recent.length > 0;

  const openAll = useCallback((text) => {
    const t = (text || term).trim();
    if (!t || crmOnly) return;
    saveRecent(t);
    setOpen(false);
    navigate(`/ats/search?q=${encodeURIComponent(t)}`);
  }, [navigate, term]);
  // a history opens in the drawer OVER the page the person is on (the dashboard, a list ...); anything else opens its own page
  const openRow = (r, g) => { saveRecent(term); setOpen(false); if (!openHistory(r, { list: g ? g.rows : [r], replace: false })) navigate(r.to); };
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setOpen(true); setActive((i) => (flat.length ? (i + 1) % flat.length : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setActive((i) => (flat.length ? (i <= 0 ? flat.length - 1 : i - 1) : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && flat[active]) openRow(flat[active], groups.find((g) => g.rows.includes(flat[active]))); else openAll();
    }
  };
  const total = (data ? data.total : 0) + (crmData ? crmData.total : 0);
  return (
    <div className={`gsearch gsx srb srb-${variant}`} ref={wrap} role="search">
      <input
        ref={input}
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => { setRecent(readRecent()); setOpen(true); }}
        onKeyDown={onKey}
        placeholder={placeholder}
        aria-label="Search TeamLink: candidates, people, clients, requirements, interviews, invoices"
        aria-expanded={open}
        aria-controls={`srb-panel-${variant}`}
        aria-activedescendant={active >= 0 ? `srb-opt-${variant}-${active}` : undefined}
        role="combobox"
        autoComplete="off"
        enterKeyHint="search"
      />
      {bar && <span className="srb-hint" aria-hidden="true">press / to search</span>}
      {open && (term.length >= 2 || showRecent) && (
        <div className="sr-panel" id={`srb-panel-${variant}`} role="listbox" aria-label="Search results">
          {showRecent && (
            <div className="sr-group">
              <div className="sr-head"><span className="sr-gtitle">Recent searches</span></div>
              {recent.map((r) => <button key={r} type="button" className="sr-recent" onMouseDown={(e) => { e.preventDefault(); setQ(r); setOpen(true); }}>{r}</button>)}
            </div>
          )}
          {term.length >= 2 && busy && !data && <div className="sr-note">Searching…</div>}
          {term.length >= 2 && error && <div className="sr-note sr-err">{error}</div>}
          {term.length >= 2 && data && !error && total === 0 && !busy && <div className="sr-note">Nothing in your scope matches “{term}”.</div>}
          {term.length >= 2 && !error && <GroupRows groups={groups} compact active={active} onOpen={openRow} idPrefix={`srb-opt-${variant}`} onHover={setActive} />}
          {term.length >= 2 && data && !crmOnly && <button type="button" className="sr-all" onMouseDown={(e) => { e.preventDefault(); openAll(); }}>See all results for “{term}” →</button>}
        </div>
      )}
    </div>
  );
}

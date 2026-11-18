import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import ListFilterBar, { useListFilters } from '../../components/ui/ListFilters.jsx';
import OrgChartWhatsApp from './OrgChartWhatsApp.jsx'; // the WhatsApp screen: the chats on the left, the open chat on the right
import useVisiblePoll from '../../components/messaging/useVisiblePoll.js';
import { useContactRule } from '../../components/messaging/useMayMessage.js';
import './org-chart.css';

// ---------------------------------------------------------------------------
// ORGANIZATION CHART (Administration) — the whole company at a glance, and a direct way to talk to anyone on it.
//
//   Super Admin
//     Managers / Assistant Managers
//     Departments -> STL -> TL -> employees
//
// It draws what the app already knows (GET /api/org-chart, built from the employee records: reporting manager, TL, STL,
// department, team, seats and today's attendance); it keeps nothing of its own. "Message" opens the person's WhatsApp chat
// (the same chat as Follow-ups > WhatsApp chats: sent, answered, ticks, live replies; Call / Mail / SMS one tab away), so what is said is logged on their history, and
// the server decides who may contact whom. The tree only shows the people the signed-in login may see in Employee Management.
// ---------------------------------------------------------------------------

const PRESENCE = {
  present: { word: 'Present', cls: 'ok' },
  late: { word: 'Present (late)', cls: 'ok' },
  half: { word: 'Half day', cls: 'warn' },
  leave: { word: 'On leave', cls: 'info' },
  absent: { word: 'Absent', cls: 'bad' },
};
const presenceWord = (p) => (p && PRESENCE[p] ? PRESENCE[p].word : 'Not marked yet');
const presenceCls = (p) => (p && PRESENCE[p] ? PRESENCE[p].cls : '');
const TODAY_CHOICES = ['Present', 'Half day', 'On leave', 'Absent', 'Not marked yet'];
const todayChoice = (p) => (p === 'late' ? 'Present' : presenceWord(p));

const initials = (name) => {
  const parts = String(name || '').replace(/[^\p{L}\p{N}\s.]/gu, ' ').split(/[\s.]+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || ''))).toUpperCase();
};
const tone = (name) => { let h = 0; String(name || '').split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) % 6; }); return `av${h}`; };
const isLead = (n) => n.type === 'person' && ['STL', 'TL'].includes(n.level);

function walk(node, fn, parent = null, depth = 0) {
  fn(node, parent, depth);
  (node.children || []).forEach((c) => walk(c, fn, node, depth + 1));
}

// Keep the people who pass the filters and the boxes above them (so a hit is shown in its place on the chart).
function prune(node, ids) {
  const kids = (node.children || []).map((c) => prune(c, ids)).filter(Boolean);
  const hit = node.type === 'person' && ids.has(node.id);
  if (!hit && !kids.length) return null;
  return { ...node, children: hit && !kids.length ? node.children : kids, _hit: hit, _auto: kids.length > 0 };
}

function Avatar({ node, big = false, src = '' }) {
  return (
    <span className={`oc-av ${tone(node.name)}${big ? ' lg' : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : initials(node.name)}
      <span className={`oc-dot ${presenceCls(node.presence)}`} title={`Today: ${presenceWord(node.presence)}`} />
    </span>
  );
}

function Branch({ node, depth, ctx }) {
  const kids = node.children || [];
  const has = kids.length > 0;
  const open = ctx.isOpen(node, depth);
  const sel = ctx.selected === node.id;
  const person = node.type === 'person';
  const people = node.size || 0;
  const key = (e, fn) => { if (e.target !== e.currentTarget) return; fn(); };
  return (
    <li role="treeitem" aria-expanded={has ? open : undefined} aria-selected={sel} className={`oc-item oc-${node.type}${isLead(node) ? ' oc-lead' : ''}`}>
      <div
        className={`oc-row${sel ? ' sel' : ''}${node._hit ? ' hit' : ''}`}
        tabIndex={0}
        onClick={() => ctx.select(node.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') key(e, () => ctx.select(node.id));
          else if (e.key === ' ') { if (e.target === e.currentTarget) { e.preventDefault(); ctx.select(node.id); } } else if (e.key === 'ArrowRight' && has && !open) key(e, () => ctx.toggle(node, depth));
          else if (e.key === 'ArrowLeft' && has && open) key(e, () => ctx.toggle(node, depth));
        }}
      >
        {has
          ? <button type="button" className="oc-caret" aria-label={`${open ? 'Close' : 'Open'} ${node.name}`} onClick={(e) => { e.stopPropagation(); ctx.toggle(node, depth); }}>{open ? '▾' : '▸'}</button>
          : <span className="oc-caret gap" />}
        {person ? <Avatar node={node} /> : <span className="oc-ico" aria-hidden="true">{node.type === 'dept' ? '🏢' : node.type === 'top' ? '👑' : node.type === 'ghost' ? '❔' : '👥'}</span>}
        <div className="oc-main">
          <div className="oc-name">
            <span className="oc-nm">{node.name}</span>
            {node.isViewer && <span className="oc-you">you</span>}
          </div>
          <div className="oc-sub">
            {[node.type === 'dept' ? `${people} ${people === 1 ? 'person' : 'people'}${node.teams > 1 ? ` · ${node.teams} teams` : ''}` : node.title, node.code, person && node.seat ? `Seat ${node.seat}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="oc-tags">
          {person && <span className={`oc-lvl l-${node.level}`}>{node.levelLabel}</span>}
          {person && node.team && <span className="oc-team">{node.team}</span>}
          {person && node.status && node.status !== 'Active' && <span className="status pending">{node.status}</span>}
          {person && people > 0 && <span className="oc-count" title="People under them">{`${people} under`}</span>}
          {!person && node.type !== 'dept' && people > 0 && <span className="oc-count">{people}</span>}
          {ctx.canMessage && person && node.messageable && !node.isViewer && (
            <button type="button" className="btn btn-sm oc-msg" title={`Start a conversation with ${node.name}`} onClick={(e) => { e.stopPropagation(); ctx.message(node); }}>💬 Message</button>
          )}
        </div>
      </div>
      {has && open && (
        <ul role="group" className="oc-kids">
          {kids.map((c) => <Branch key={c.id} node={c} depth={depth + 1} ctx={ctx} />)}
        </ul>
      )}
    </li>
  );
}

function usePhoto(id) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let url = '';
    let on = true;
    setSrc('');
    if (!id) return undefined;
    api.get(`/employees/management/${id}/photo`, { responseType: 'blob' })
      .then((r) => { if (on) { url = URL.createObjectURL(r.data); setSrc(url); } })
      .catch(() => { /* no photo, or not allowed to see it: initials stay */ });
    return () => { on = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src;
}

function Detail({ node, parent, ctx, onClose }) {
  const photo = usePhoto(node && node.type === 'person' ? node.id : null);
  if (!node) {
    return (
      <aside className="panel panel-pad oc-detail idle">
        <div className="empty-mini">Click anyone on the chart to see their details here, and to start a conversation with them.</div>
      </aside>
    );
  }
  const person = node.type === 'person';
  // the boss is the nearest person (or grey TL box) above; department boxes are only a way of grouping
  let boss = null;
  for (let up = parent; up && !boss; up = up.type === 'top' ? null : (ctx.parentOf(up.id) || null)) {
    if (up.type === 'person' || up.type === 'ghost') boss = up;
    else if (up.type === 'bucket') break;
  }
  const tally = { present: 0, leave: 0, absent: 0, none: 0 };
  walk(node, (n) => { if (n.type === 'person') { if (n.presence === 'present' || n.presence === 'late' || n.presence === 'half') tally.present += 1; else if (n.presence === 'leave') tally.leave += 1; else if (n.presence === 'absent') tally.absent += 1; else tally.none += 1; } });
  return (
    <aside className="panel panel-pad oc-detail" aria-label="Details">
      <button type="button" className="oc-x" aria-label="Close details" onClick={onClose}>×</button>
      <div className="oc-dhead">
        {person ? <Avatar node={node} big src={photo} /> : <span className="oc-ico" style={{ width: 64, height: 64, flexBasis: 64, fontSize: 28 }}>{node.type === 'dept' ? '🏢' : node.type === 'top' ? '👑' : node.type === 'ghost' ? '❔' : '👥'}</span>}
        <div style={{ minWidth: 0 }}>
          <h3>{node.name}</h3>
          {person ? <span className={`oc-lvl l-${node.level}`}>{node.levelLabel}</span> : <span className="small-muted">{node.title}</span>}
        </div>
      </div>

      {person && (
        <dl>
          <dt>Role</dt><dd>{node.title}</dd>
          {node.code && (<><dt>Employee ID</dt><dd>{node.code}</dd></>)}
          <dt>Department</dt><dd>{node.department || '—'}</dd>
          {node.team && (<><dt>Team</dt><dd>{node.team}</dd></>)}
          {node.seat && (<><dt>Seat</dt><dd>{node.seat}</dd></>)}
          <dt>Status</dt><dd>{node.status || 'Active'}</dd>
          <dt>Today</dt><dd><span className={`oc-dot ${presenceCls(node.presence)}`} style={{ marginRight: 6, verticalAlign: 'middle' }} />{presenceWord(node.presence)}</dd>
          <dt>Reports to</dt>
          <dd>
            {boss
              ? <button type="button" className="oc-linkbtn" onClick={() => ctx.select(boss.id)}>{boss.name}</button>
              : (parent && parent.type === 'bucket' ? 'No TL assigned yet' : (node.reportsTo || '—'))}
            {boss && boss.type === 'ghost' && <span className="small-muted">{' (not on the chart)'}</span>}
          </dd>
          <dt>Team size</dt><dd>{node.size ? `${node.size} ${node.size === 1 ? 'person' : 'people'} under them (${node.directs} direct)` : 'Nobody under them'}</dd>
        </dl>
      )}
      {!person && (
        <dl>
          <dt>People</dt><dd>{node.size || 0}</dd>
          <dt>Today</dt><dd>{`${tally.present} present · ${tally.leave} on leave · ${tally.absent} absent · ${tally.none} not marked`}</dd>
        </dl>
      )}
      {node.note && <div className="oc-note">{node.note}</div>}

      <div className="oc-acts">
        {person && node.messageable && !node.isViewer && ctx.canMessage && <button type="button" className="btn btn-primary" onClick={() => ctx.message(node)}>💬 Message {node.name.split(' ')[0]}</button>}
        {person && !ctx.canMessage && ctx.messageLoaded && <div className="oc-note" style={{ margin: 0 }}>{ctx.noMessageReason || 'Messaging people is not switched on for your role.'}</div>}
        {person && <Link className="btn" to={`/employees/${node.id}`}>Open profile</Link>}
        {(node.children || []).length > 0 && <button type="button" className="btn" onClick={() => ctx.focus(node.id)}>Show only this branch</button>}
      </div>
    </aside>
  );
}

export default function OrgChart() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [openMap, setOpenMap] = useState({});
  // Chart | WhatsApp chats, and which chat is open, live in the address (?view=whatsapp&chat=EMPLOYEE:<id>): a link opens the same screen
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'whatsapp' ? 'whatsapp' : 'chart';
  const chatParam = sp.get('chat') || '';
  const chatId = chatParam.startsWith('EMPLOYEE:') ? chatParam.slice(9) : null;
  const go = useCallback((v, id) => {
    const n = new URLSearchParams(sp);
    if (v === 'whatsapp') n.set('view', 'whatsapp'); else n.delete('view');
    if (v === 'whatsapp' && id) n.set('chat', `EMPLOYEE:${id}`); else n.delete('chat');
    setSp(n, { replace: true });
  }, [sp, setSp]);
  const [waUnread, setWaUnread] = useState(0); // chats with a reply nobody has read (employees only)
  const contact = useContactRule('employees'); // the server's answer: may this login contact employees at all
  // the number on the WhatsApp tab: asked every minute while the chart is shown (the WhatsApp screen keeps it up to date itself)
  useVisiblePoll(async (signal) => {
    const r = await api.get('/wa-chats', { params: { type: 'EMPLOYEE', state: 'unread' }, signal });
    setWaUnread(r.data.unreadChats || 0);
    return true;
  }, 60000, { enabled: contact.allowed && view === 'chart', key: 'oc-wa-badge' });

  const load = useCallback(() => {
    setBusy(true); setError('');
    api.get('/org-chart')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.status === 403 ? 'Your login may not open the organization chart.' : (e.response?.data?.error || 'Could not load the organization chart.')))
      .finally(() => setBusy(false));
  }, []);
  useEffect(load, [load]);

  // every person as one flat row, so the standard filter bar can search and filter them
  const rows = useMemo(() => {
    const out = [];
    if (data) walk(data.root, (n) => { if (n.type === 'person') out.push({ id: n.id, isViewer: !!n.isViewer, messageable: n.messageable, name: n.name, code: n.code, title: n.title, levelLabel: n.levelLabel, department: n.department, team: n.team, seat: n.seat, today: todayChoice(n.presence) }); });
    return out;
  }, [data]);
  const lf = useListFilters(rows, [
    { key: 'q', type: 'search', placeholder: 'Search name, ID, role, team…', get: (r) => `${r.name} ${r.code || ''} ${r.title || ''} ${r.department || ''} ${r.team || ''} ${r.seat || ''}` },
    { key: 'department', label: 'Department', get: (r) => r.department || '', primary: true, allLabel: 'All departments' },
    { key: 'levelLabel', label: 'Level', get: (r) => r.levelLabel, primary: true, allLabel: 'All levels' },
    { key: 'today', label: 'Today', get: (r) => r.today, options: TODAY_CHOICES, primary: true, allLabel: 'Anyone today' },
  ], {});
  const filtering = lf.activeCount > 0;
  useEffect(() => { setOpenMap({}); }, [lf.sig]);

  const index = useMemo(() => {
    const m = new Map();
    if (data) walk(data.root, (n, parent) => m.set(n.id, { node: n, parent }));
    return m;
  }, [data]);

  const shown = useMemo(() => {
    if (!data) return null;
    let root = data.root;
    if (focusId && index.has(focusId)) root = index.get(focusId).node;
    if (!filtering) return root;
    return prune(root, new Set(lf.rows.map((r) => r.id)));
  }, [data, filtering, lf.rows, focusId, index]);

  const isOpen = useCallback((node, depth) => {
    if (Object.prototype.hasOwnProperty.call(openMap, node.id)) return openMap[node.id];
    if (filtering) return !!node._auto;
    return depth <= 1;
  }, [openMap, filtering]);
  const toggle = useCallback((node, depth) => setOpenMap((m) => ({ ...m, [node.id]: !isOpen(node, depth) })), [isOpen]);
  const expandAll = () => { const m = {}; if (shown) walk(shown, (n) => { if ((n.children || []).length) m[n.id] = true; }); setOpenMap(m); };
  const collapseAll = () => { const m = {}; if (shown) walk(shown, (n) => { if ((n.children || []).length) m[n.id] = false; }); if (shown) m[shown.id] = true; setOpenMap(m); };

  const select = useCallback((id) => {
    setSelected(id);
    // open the boxes above a person picked from the "Reports to" link
    setOpenMap((m) => {
      const next = { ...m };
      let cur = index.get(id);
      while (cur && cur.parent) { next[cur.parent.id] = true; cur = index.get(cur.parent.id); }
      return next;
    });
  }, [index]);

  const ctx = {
    selected, select, isOpen, toggle, focus: (id) => { setFocusId(id); setOpenMap({}); },
    parentOf: (id) => (index.get(id) ? index.get(id).parent : null),
    canMessage: contact.allowed, messageLoaded: contact.loaded, noMessageReason: contact.reason, message: (n) => { go('whatsapp', n.id); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  };

  const sel = selected && index.has(selected) ? index.get(selected) : null;
  const stats = data && data.stats;
  const tidy = data && data.tidy;
  const only = data && !data.root.children.length; // nobody (or only the Super Admin) on the chart yet

  const cell = (label, value, extra = {}) => (
    <div className={`stat-cell${extra.on ? ' on' : ''}`} {...(extra.goto ? { 'data-goto': '1', role: 'button', tabIndex: 0, onClick: extra.goto, onKeyDown: (e) => { if (e.key === 'Enter') extra.goto(); } } : {})}>
      <div className="v">{extra.dot && <span className={`dot oc-dot ${extra.dot}`} />}{value}</div>
      <div className="l">{label}</div>
    </div>
  );
  const pick = (v) => () => lf.setValue('today', lf.values.today === v ? '' : v);

  return (
    <div className="org-chart">
      <div className="page-head">
        <div>
          <h1>Organization Chart</h1>
          <div className="page-sub">The whole company at a glance, from the Super Admin down to every team. Click anyone to see their details, or open a WhatsApp chat with them.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </div>

      {contact.allowed && (
        <div className="oc-views" role="tablist" aria-label="Chart or WhatsApp chats">
          <button type="button" role="tab" aria-selected={view === 'chart'} className={`btn btn-sm${view === 'chart' ? ' btn-primary' : ''}`} onClick={() => go('chart')}>🌳 Chart</button>
          <button type="button" role="tab" aria-selected={view === 'whatsapp'} className={`btn btn-sm${view === 'whatsapp' ? ' btn-primary' : ''}`} onClick={() => go('whatsapp', chatId)}>
            💬 WhatsApp chats
            {waUnread > 0 && <span className="oc-badge" aria-label={`${waUnread} chats with a new reply`}>{waUnread}</span>}
          </button>
        </div>
      )}

      {view === 'whatsapp' && <OrgChartWhatsApp people={rows} personId={chatId} onSelect={(id) => go('whatsapp', id)} onUnread={setWaUnread} />}

      {view === 'chart' && error && (
        <div className="notice" role="alert" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={load}>Try again</button>
        </div>
      )}
      {view === 'chart' && !data && !error && <div className="panel panel-pad"><div className="oc-skel">Loading the organization chart…</div></div>}

      {view === 'chart' && data && (
        <>
          <div className="oc-stats">
            {cell('People on the chart', stats.people)}
            {cell('Departments', stats.departments)}
            {cell('Team leads (STL / TL)', stats.leads)}
            {cell('Present today', stats.present, { dot: 'ok', goto: pick('Present'), on: lf.values.today === 'Present' })}
            {cell('Half day', stats.half, { dot: 'warn', goto: pick('Half day'), on: lf.values.today === 'Half day' })}
            {cell('On leave', stats.leave, { dot: 'info', goto: pick('On leave'), on: lf.values.today === 'On leave' })}
            {cell('Absent', stats.absent, { dot: 'bad', goto: pick('Absent'), on: lf.values.today === 'Absent' })}
            {cell('Not marked yet', stats.notMarked, { dot: '', goto: pick('Not marked yet'), on: lf.values.today === 'Not marked yet' })}
          </div>

          {tidy && (tidy.withoutTl > 0 || tidy.teamsOfMissingTl > 0) && (
            <div className="notice">
              <span>
                {[
                  tidy.withoutTl > 0 ? `${tidy.withoutTl} ${tidy.withoutTl === 1 ? 'person has' : 'people have'} no TL or manager on their record` : null,
                  tidy.teamsOfMissingTl > 0 ? `${tidy.teamsOfMissingTl} ${tidy.teamsOfMissingTl === 1 ? 'team hangs' : 'teams hang'} under a TL who is not on the chart` : null,
                ].filter(Boolean).join(', and ')}
                {'. They are shown in grey boxes below; set the TL or Reporting manager in '}
                <Link to="/employees">Employee Management</Link>
                {' and they move to the right place.'}
              </span>
            </div>
          )}

          <ListFilterBar
            lf={lf}
            storageKey="admin-org-chart"
            noun="on the chart"
            extra={(
              <span className="oc-bar-ctl">
                <button type="button" className="btn btn-sm" onClick={expandAll}>Expand all</button>
                <button type="button" className="btn btn-sm" onClick={collapseAll}>Collapse all</button>
              </span>
            )}
          />

          {focusId && index.has(focusId) && (
            <div className="oc-focus">
              <span>{`Showing only ${index.get(focusId).node.name}'s branch.`}</span>
              <button type="button" className="btn btn-sm" onClick={() => { setFocusId(null); setOpenMap({}); }}>Show the whole company</button>
            </div>
          )}

          <div className="oc-legend" aria-label="Today's marks">
            <span>Today:</span>
            <span><i className="oc-dot ok" />Present</span>
            <span><i className="oc-dot warn" />Half day</span>
            <span><i className="oc-dot info" />On leave</span>
            <span><i className="oc-dot bad" />Absent</span>
            <span><i className="oc-dot" />Not marked yet</span>
            <span className="small-muted">{`· ${data.scope ? `Showing: ${data.scope}` : ''}`}</span>
          </div>

          <div className="oc-layout">
            <div className="panel oc-treebox">
              {shown ? (
                <ul role="tree" className="oc-tree" aria-label="Organization chart">
                  <Branch key={shown.id} node={shown} depth={0} ctx={ctx} />
                </ul>
              ) : (
                <div className="empty-mini">
                  No one on the chart matches these filters.
                  {' '}
                  <button type="button" className="oc-linkbtn" onClick={lf.clear}>Clear the filters</button>
                </div>
              )}
              {shown && only && !filtering && (
                <div className="empty-mini">
                  {data.root.type === 'person' ? 'Only the Super Admin is on the chart so far.' : 'Nobody is on the chart yet.'}
                  {' '}
                  People appear here once they are added in
                  {' '}
                  <Link to="/employees">Employee Management</Link>
                  {' '}
                  with a department and a TL or reporting manager.
                </div>
              )}
            </div>
            <Detail node={sel && sel.node} parent={sel && sel.parent} ctx={ctx} onClose={() => setSelected(null)} />
          </div>
        </>
      )}

    </div>
  );
}

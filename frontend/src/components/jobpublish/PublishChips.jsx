import './jobpublish.css';
import { portalName } from './jpKit.js';

// ---------------------------------------------------------------------------
// THE SHARED STATUS CHIPS for job publishing (icon + words, never colour alone).
//   portalState({ posting, info })  -> { key, label, tone, icon, detail }
//     posting = one item of GET /job-publish/jobs/:id/status .portals[]  (may be null)
//     info    = one item of GET /job-publish/portals         .portals[]  (may be null)
//   <PortalChip state label? />   one chip
//   <PortalChipRow postings infos only? />   a wrapped row of "Naukri: Posted" chips
// "Posted" shows ONLY when the status is PUBLISHED.
// ---------------------------------------------------------------------------
const ICON = { green: '✔', blue: '⟳', yellow: '!', red: '✖', grey: '○' };

export function portalState({ posting, info } = {}) {
  const st = posting && posting.status;
  const lq = posting && posting.lastQueue;
  const lqs = lq && lq.status;
  const mk = (key, label, tone, detail) => ({ key, label, tone, icon: ICON[tone] || '○', detail: detail || '' });
  if (st === 'PUBLISHED') return mk('PUBLISHED', 'Posted', 'green', 'Live on the site.');
  if (lq && lq.waiting) return mk('HELP', 'Needs your help', 'yellow', lq.waiting.reason || 'The site asked for a one-time code. Type it in the box.');
  if (lqs === 'RUNNING') return mk('RUNNING', 'Running', 'blue', 'We are posting it now.');
  if (st === 'QUEUED' || lqs === 'QUEUED') return mk('QUEUED', 'Queued', 'blue', 'Waiting its turn to be posted.');
  if ((st === 'NEEDS_CHECK' || lqs === 'NEEDS_HUMAN') && lq && lq.help) return mk('NEEDS_CHECK', 'Needs your help', 'yellow', lq.help.title);
  if (st === 'NEEDS_CHECK' || lqs === 'NEEDS_HUMAN') return mk('NEEDS_CHECK', 'Needs your help', 'yellow', 'Needs checking: we pressed Submit but could not confirm it. Open the portal and check.');
  if (st === 'FAILED' || lqs === 'DEAD' || lqs === 'FAILED') return mk('FAILED', 'Failed', 'red', (posting && posting.lastError) || (lq && lq.errorCode) || 'It did not post.');
  if (st === 'UNPUBLISHED') return mk('UNPUBLISHED', 'Taken down', 'grey', 'This requirement was taken off the site.');
  if (st === 'EXPIRED') return mk('EXPIRED', 'Expired', 'grey', 'The posting ran out.');
  if (info) {
    if (info.kind === 'manual' || info.manualOnly) return mk('BY_HAND', 'Post by hand', 'yellow', 'LinkedIn does not allow posting by a program. We make a task and you post it by hand.');
    if (info.kind === 'internal') return mk('READY', 'Ready', 'green', 'Goes live at once on our careers page.');
    const c = info.credential || {};
    if (info.kind === 'api') {
      if (c.hasLogin === false) return mk('NOT_CONNECTED', 'Not connected', 'grey', 'An Admin sets this up once (Integrations, Job portals). Nothing is posted until then.');
      if (!c.enabled) return mk('OFF', 'Switched off', 'grey', 'An Admin switches posting ON. A dry run (check only) still works.');
      if (c.status === 'FAILED') return mk('LOGIN_FAILED', 'Failed', 'red', 'The token was not accepted. An Admin saves a new one.');
      return mk('READY', 'Ready', 'green', 'We can post here.');
    }
    if (c.hasLogin === false) return mk('NOT_CONNECTED', 'Not connected', 'grey', 'No login saved for this site yet. We make a by-hand task instead.');
    if (c.enabled === false || c.enabled === 0 || c.status === 'DISABLED') return mk('OFF', 'Switched off', 'grey', 'Automatic posting is off for this site. We make a by-hand task instead.');
    if (c.status === 'NEEDS_HUMAN' || c.humanHold || info.humanHold) return mk('LOGIN', 'Waiting for your login (human step)', 'yellow', 'A person must sign in to this site once.');
    if (c.status === 'FAILED') return mk('LOGIN_FAILED', 'Failed', 'red', 'The last sign-in failed. Ask an Admin to fix the login.');
    if (c.status === 'CONNECTED' || c.status === 'UNVERIFIED' || c.enabled) return mk('READY', 'Ready', 'green', 'We can post here.');
    return mk('NOT_CONNECTED', 'Not connected', 'grey', 'No login saved for this site yet.');
  }
  return mk('DRAFT', 'Not posted', 'grey', 'Not posted yet.');
}

export function PortalChip({ state, label }) {
  if (!state) return null;
  return (
    <span className={`jp-chip jp-${state.tone}`} title={state.detail || undefined}>
      <span aria-hidden="true" className="jp-chip-i">{state.icon}</span>
      <span>{label ? `${label}: ${state.label}` : state.label}</span>
    </span>
  );
}

export function PortalChipRow({ postings = [], infos = [], only = null }) {
  const keys = only || Array.from(new Set([...postings.map((p) => p.portal), ...infos.map((i) => i.portal)]));
  return (
    <span className="jp-chips" role="list">
      {keys.map((k) => {
        const p = postings.find((x) => x.portal === k);
        const i = infos.find((x) => x.portal === k);
        return <span role="listitem" key={k}><PortalChip label={portalName(k) !== k ? portalName(k) : (i && i.name) || (p && p.portalName) || k} state={portalState({ posting: p, info: i })} /></span>;
      })}
    </span>
  );
}

// the queue's own words (queue list rows)
const QSTATE = {
  QUEUED: ['Queued', 'blue'], RUNNING: ['Running', 'blue'], SUCCEEDED: ['Done', 'green'], FAILED: ['Failed', 'red'],
  NEEDS_HUMAN: ['Needs your help', 'yellow'], DEAD: ['Gave up', 'red'], CANCELLED: ['Cancelled', 'grey'],
};
export const QUEUE_WORDS = Object.fromEntries(Object.entries(QSTATE).map(([k, v]) => [k, v[0]]));
export function QueueChip({ status, dryRun }) {
  const [label, tone] = QSTATE[status] || [status, 'grey'];
  return <PortalChip state={{ label: dryRun && status === 'SUCCEEDED' ? 'Checked (nothing posted)' : label, tone, icon: ICON[tone] }} />;
}

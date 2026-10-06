import { useEffect, useState } from 'react';
import api from '../../api';

// "N candidates not followed up yet" for the ATS dashboard (spec 2026-10-03,
// C1). Scoped by the server exactly like the Candidates list (active
// applications in the caller's area) — GET /api/followups/not-followed-summary.
//
//   const { count, link, text, loading, error } = useNotFollowedCount();
//   count  distinct candidates with the red "Not followed up" badge
//   link   opens exactly those rows on the Candidates page
//   text   the line in plain words (never a bare zero)
export function notFollowedText(count) {
  if (count === null || count === undefined) return '';
  if (count === 0) return 'Everyone is followed up';
  return `${count.toLocaleString('en-IN')} candidate${count === 1 ? '' : 's'} not followed up yet`;
}

export default function useNotFollowedCount({ enabled = true } = {}) {
  const [state, setState] = useState({
    count: null, never: null, dueToday: null, link: null, loading: !!enabled, error: '',
  });
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.get('/followups/not-followed-summary')
      .then((r) => {
        if (!live) return;
        const d = r.data || {};
        setState({
          count: d.notFollowed, never: d.never, dueToday: d.dueToday, link: (d.links && d.links.notFollowed) || null, links: d.links || {}, loading: false, error: '',
        });
      })
      .catch((e) => { if (live) setState((s) => ({ ...s, loading: false, error: e.response?.data?.error || 'Could not count the follow-ups.' })); });
    return () => { live = false; };
  }, [enabled]);
  return { ...state, text: notFollowedText(state.count) };
}

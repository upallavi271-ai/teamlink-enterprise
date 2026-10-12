import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// How many conversations have a reply nobody has read yet (inside the viewer's own area): the badge on the
// Follow-ups tab. Asks again every minute and whenever `refresh()` is called (after reading one).
export default function useUnreadReplies(enabled = true) {
  const [n, setN] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    api.get('/conversations/unread-count').then((r) => setN(Number(r.data.conversations) || 0)).catch(() => {});
  }, [enabled]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
  }, [refresh]);
  return [n, refresh, setN];
}

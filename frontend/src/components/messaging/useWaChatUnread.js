import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import useVisiblePoll from './useVisiblePoll.js';

// How many WhatsApp chats have a reply THIS login has not read: the number on the "WhatsApp chats" tab.
// Asks every 30 seconds while the page is visible (one cheap request), and whenever refresh() is called.
// A login that has no WhatsApp chats at all (403) stops asking.
export default function useWaChatUnread(enabled = true) {
  const [n, setN] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return api.get('/wa-chats/unread-count').then((r) => setN(Number(r.data.chats) || 0)).catch(() => {});
  }, [enabled]);
  useEffect(() => { refresh(); }, [refresh]);
  useVisiblePoll(async (signal) => {
    try {
      const r = await api.get('/wa-chats/unread-count', { signal });
      setN(Number(r.data.chats) || 0);
      return true;
    } catch (e) {
      if (e.response && e.response.status === 403) return false;
      throw e;
    }
  }, 30000, { enabled });
  return [n, refresh, setN];
}

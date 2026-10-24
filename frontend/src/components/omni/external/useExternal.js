import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';

// One service's connection (GET /gs/external/connection/<id>): { conn, canConnect, settings, loading, error }, plus reload / setConn / saveSettings.
// A secret never comes back from the server (only a masked hint), so nothing here can show one.
export function useConnection(id) {
  const [st, setSt] = useState({ conn: null, canConnect: false, settings: null, loading: true, error: '' });
  const load = useCallback(async () => {
    try {
      const d = await omni.get(`/gs/external/connection/${id}`);
      setSt({ conn: d.connection, canConnect: !!d.canConnect, settings: d.settings, loading: false, error: '' });
    } catch (e) { setSt((s) => ({ ...s, loading: false, error: errOf(e, 'This page could not be loaded.') })); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const setConn = useCallback((conn) => setSt((s) => ({ ...s, conn })), []);
  const saveSettings = useCallback(async (key, patch) => {
    const d = await omni.put(`/gs/external/settings/${key}`, patch);
    setSt((s) => ({ ...s, settings: d.settings }));
    return d.settings;
  }, []);
  const setSettings = useCallback((settings) => setSt((s) => ({ ...s, settings })), []);
  return { ...st, reload: load, setConn, saveSettings, setSettings };
}

// the saved plans of one list ('ad_campaign' | 'google_campaign')
export function useItems(kind) {
  const { dept } = useOmni();
  const [st, setSt] = useState({ items: [], loading: true, error: '' });
  const load = useCallback(async () => {
    try { const d = await omni.get('/gs/external/items', { kind }); setSt({ items: d.items || [], loading: false, error: '' }); } catch (e) { setSt({ items: [], loading: false, error: errOf(e, 'The list could not be loaded.') }); }
  }, [kind, dept]);
  useEffect(() => { load(); }, [load]);
  return { ...st, reload: load };
}

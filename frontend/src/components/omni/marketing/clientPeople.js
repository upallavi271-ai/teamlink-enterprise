import { useEffect, useMemo, useState } from 'react';
import api from '../../../api';
import omni from '../omniApi.js';

// 2026-11-23 (owner: "every time I cannot enter the client details, their name, number and mail"): ONE list of clients to pick from = the company's clients (ATS) plus the people this login has
// already sent something to or made a project for (server: marketing/clientReview.js contacts), with the contact details typed LAST TIME. Picking a name fills the contact person, the
// WhatsApp number and the email. -> { people: [{ name, clientId, contactName, contactEmail, contactPhone }], find(name) }
export default function useClientPeople() {
  const [ats, setAts] = useState([]);
  const [seen, setSeen] = useState([]);
  useEffect(() => {
    let on = true;
    api.get('/clients').then((r) => { if (on) setAts(Array.isArray(r.data) ? r.data : (r.data && r.data.clients) || []); }).catch(() => { if (on) setAts([]); });
    omni.get('/gs/marketing/client-contacts').then((r) => { if (on) setSeen((r && r.contacts) || []); }).catch(() => { if (on) setSeen([]); });
    return () => { on = false; };
  }, []);
  const people = useMemo(() => {
    const m = new Map();
    seen.forEach((c) => m.set(String(c.name).toLowerCase(), { name: c.name, clientId: c.clientId || '', contactName: c.contactName || '', contactEmail: c.contactEmail || '', contactPhone: c.contactPhone || '' }));
    ats.forEach((c) => {
      if (!c || !c.name) return;
      const k = String(c.name).toLowerCase(); const cur = m.get(k) || { name: c.name, clientId: '', contactName: '', contactEmail: '', contactPhone: '' };
      m.set(k, { name: cur.name, clientId: c.id || cur.clientId, contactName: cur.contactName || c.contactName || '', contactEmail: cur.contactEmail || c.contactEmail || '', contactPhone: cur.contactPhone || c.contactWhatsApp || c.contactPhone || '' });
    });
    return [...m.values()];
  }, [ats, seen]);
  const find = (name) => people.find((p) => p.name.toLowerCase() === String(name || '').trim().toLowerCase());
  return { people, find };
}

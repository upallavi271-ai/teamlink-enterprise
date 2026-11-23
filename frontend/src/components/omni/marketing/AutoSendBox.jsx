import { useCallback, useSyncExternalStore } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Field } from '../ui.jsx';
import useClientPeople from './clientPeople.js';

// 2026-11-23 (owner: "I want to send the work automatically to the client for approval or changes through WhatsApp after generating the image or video"):
// an opt-in switch (off until the person ticks it; kept in this browser) on AI Images and AI Video. With it on, every picture or video made here is sent to the chosen client on WhatsApp as
// itself with Approve / Reject (server: marketing/clientReview.js sendToClient; the client's answer is the approval), and by email too when asked and there is an address.
// Not used for pictures made for a client PROJECT (the project has its own Send).
const KEY = 'tl_mk_autosend';
const BLANK = { on: false, clientName: '', contactName: '', contactPhone: '', contactEmail: '', email: false };
const readSaved = () => { try { return { ...BLANK, ...(JSON.parse(window.localStorage.getItem(KEY) || '{}')) }; } catch { return { ...BLANK }; } };
const complete = (c) => c.on && String(c.clientName).trim().length >= 2 && String(c.contactPhone).trim().length >= 8;
// one setting for the whole page: the box in the studio and the AI Video page's Save read the same one
let current = null; const listeners = new Set();
const snapshot = () => { if (!current) current = readSaved(); return current; };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const change = (patch) => { current = { ...snapshot(), ...patch }; try { window.localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* no storage: it works until the page is closed */ } listeners.forEach((fn) => fn()); };
export const resetAutoSend = () => { current = null; listeners.forEach((fn) => fn()); }; // for tests

export function useAutoSend(toast) {
  const cfg = useSyncExternalStore(subscribe, snapshot);
  const send = useCallback(async (ids) => {
    const c = snapshot();
    if (!complete(c) || !ids || !ids.length) return;
    const list = ids.slice(0, 4); let ok = 0; const bad = [];
    for (const id of list) { // eslint-disable-line no-restricted-syntax
      try { await omni.post(`/gs/marketing/images/${id}/send-to-client`, { clientName: c.clientName.trim(), contactName: c.contactName.trim(), contactPhone: c.contactPhone.trim(), contactEmail: c.contactEmail.trim(), email: !!c.email && !!c.contactEmail.trim() }); ok += 1; } // eslint-disable-line no-await-in-loop
      catch (e) { bad.push(errOf(e, 'not sent')); }
    }
    toast(ok ? `Sent ${ok} to ${c.clientName.trim()} on WhatsApp for approval${bad.length ? `. ${bad.length} not sent: ${bad[0]}` : ''}` : `Not sent to ${c.clientName.trim()}: ${bad[0] || 'nothing was made'}`);
  }, [toast]);
  return { cfg, update: change, send, ready: complete(cfg) };
}

export default function AutoSendBox({ auto }) {
  const { people, find } = useClientPeople();
  const { cfg, update } = auto;
  const pick = (name) => { const p = find(name); update({ clientName: name, ...(p ? { contactName: p.contactName || cfg.contactName, contactPhone: p.contactPhone || cfg.contactPhone, contactEmail: p.contactEmail || cfg.contactEmail } : {}) }); };
  return (
    <div className="card" style={{ padding: '10px 14px', margin: '0 0 12px' }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, fontWeight: 800, cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.on} onChange={(e) => update({ on: e.target.checked })} />
        Send to a client for approval on WhatsApp as soon as it is made
      </label>
      {cfg.on ? (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="CLIENT (COMPANY)" full>
            <input list="mk-autosend-clients" value={cfg.clientName} maxLength={120} onChange={(e) => pick(e.target.value)} placeholder="Pick or type the client's name" />
            <datalist id="mk-autosend-clients">{people.map((p) => <option key={p.name} value={p.name} />)}</datalist>
          </Field>
          <Field label="CONTACT PERSON"><input value={cfg.contactName} maxLength={120} onChange={(e) => update({ contactName: e.target.value })} /></Field>
          <Field label="WHATSAPP NUMBER"><input value={cfg.contactPhone} maxLength={30} inputMode="tel" placeholder="+91…" onChange={(e) => update({ contactPhone: e.target.value })} /></Field>
          <Field label="EMAIL (OPTIONAL)"><input value={cfg.contactEmail} maxLength={160} onChange={(e) => update({ contactEmail: e.target.value })} /></Field>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', alignSelf: 'end' }}><input type="checkbox" checked={cfg.email} disabled={!cfg.contactEmail.trim()} onChange={(e) => update({ email: e.target.checked })} />Also send by email</label>
          {!auto.ready ? <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#92400e', fontWeight: 600 }}>Write the client's name and WhatsApp number: until then nothing is sent by itself.</div> : <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#166534', fontWeight: 600 }}>On: each picture or video made here goes to {cfg.clientName.trim()} with Approve / Reject.</div>}
        </div>
      ) : null}
    </div>
  );
}

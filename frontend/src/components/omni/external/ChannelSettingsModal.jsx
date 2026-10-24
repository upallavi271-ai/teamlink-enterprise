import { useState } from 'react';
import { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, GsModal, Field, Planned } from '../ui.jsx';
import './external.css';

// The prototype's "<Facebook Page | Instagram account> settings" sheet (channelSettingsModal), shared by both Meta channel pages.
// The choices are SAVED (server, per company). They take effect when the Page is connected and the auto-reply is built (planned): the note says so.
// Only an Admin can save; everybody else sees the sheet read-only.
const WORDS = { facebook: 'Facebook Page', instagram: 'Instagram account' };
export default function ChannelSettingsModal({ channel, settings, defaultName, canChange, saveSettings, onClose }) {
  const { toast } = useOmni();
  const cur = (settings && settings[channel]) || {};
  const [name, setName] = useState(cur.name || defaultName || '');
  const [autoReplyHours, setAuto] = useState(cur.autoReplyHours !== false);
  const [handoff, setHandoff] = useState(cur.handoff === true);
  const [syncCatalog, setSync] = useState(cur.syncCatalog !== false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { setErr('The account name cannot be empty.'); toast('The account name cannot be empty'); return; }
    setBusy(true); setErr('');
    try { await saveSettings(channel, { name: name.trim(), autoReplyHours, handoff, syncCatalog }); toast(`${WORDS[channel]} settings saved`); onClose(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const opt = (checked, set, text) => <label className="ext-opt"><input type="checkbox" checked={checked} disabled={!canChange} onChange={(e) => set(e.target.checked)} /> {text}</label>;
  return (
    <GsModal title={`${WORDS[channel]} settings`} sub="Applies to this workspace only." width={460} onClose={onClose}
      foot={<><Btn onClick={onClose}>{canChange ? 'Cancel' : 'Close'}</Btn>{canChange && <Btn primary disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</Btn>}</>}>
      <Field label="DISPLAY NAME"><input value={name} disabled={!canChange} onChange={(e) => { setName(e.target.value); setErr(''); }} maxLength={80} /></Field>
      {opt(autoReplyHours, setAuto, 'Auto-reply outside business hours')}
      {opt(handoff, setHandoff, 'Hand unanswered threads to an agent after 15 minutes')}
      {opt(syncCatalog, setSync, 'Keep the product catalog in sync')}
      {err && <div className="ext-err" role="alert">{err}</div>}
      <Planned>These choices are saved, but they do nothing yet: auto-reply and catalog sync are planned. {!canChange && 'Only an Admin can change them.'}</Planned>
    </GsModal>
  );
}

import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, Pill, fmtDate } from '../ui.jsx';
import PhonePreview from './PhonePreview.jsx';
import MediaLibraryModal from './MediaLibraryModal.jsx';
import { LANGS } from './tplCommon.jsx';

// A voice script: what a call says (read aloud, or replaced by an audio link). Saved scripts are ours (table OmniVoiceScript); the built-in call scripts are read only.
export default function VoiceForm({ item, mode, onBack, onSaved, onMode }) {
  const { toast } = useOmni();
  const isNew = !item;
  const builtin = item && item.source === 'script';
  const ro = mode === 'view' || builtin;
  const can = isNew || (item && item.canEdit);
  const init = () => ({ name: item ? item.name : '', category: item ? item.category || 'Utility' : 'Utility', language: item ? item.language || 'en_US' : 'en_US', script: item ? item.body || '' : '', audio: item ? item.audio || null : null });
  const [f, setF] = useState(init);
  const [snap, setSnap] = useState(() => JSON.stringify(init()));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState(false);
  const set = (p) => { setF({ ...f, ...p }); setErr(''); };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (isNew) await omni.post('/gs/templates/voice', f); else await omni.put(`/gs/templates/voice/${item.id}`, f);
      toast(`"${f.name}" saved`); onSaved();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const cancel = () => { setF(JSON.parse(snap)); onMode('view'); toast('Changes discarded'); };
  const edit = () => { setSnap(JSON.stringify(f)); onMode('edit'); };
  return (
    <div>
      {isNew ? (
        <>
          <button type="button" className="ca-back" onClick={onBack}>← Back</button>
          <h2 style={{ margin: '2px 0 3px', fontSize: 19 }}>Create Voice Template</h2>
          <p style={{ fontSize: 10, color: 'var(--muted)', margin: '0 0 16px' }}>Creating for: <span className="pill live">Call scripts</span></p>
        </>
      ) : (
        <div className="tpl-edit-head">
          <div className="tpl-edit-id">
            <button type="button" className="tpl-edit-back" onClick={onBack} aria-label="Back to templates">←</button>
            <div><div className="tpl-edit-name"><span style={{ overflowWrap: 'anywhere' }}>{f.name}</span><Pill tone="live">{builtin ? 'BUILT IN' : 'READY'}</Pill></div><div className="tpl-edit-sub">Channel: <span className="pill live">Voice</span> · Call scripts{builtin ? ' · read only' : ''}</div></div>
          </div>
          <div className="tpl-edit-acts">{builtin ? <span style={{ fontSize: 10, color: 'var(--muted)', maxWidth: 260 }}>{item.readOnlyWhy}</span> : (mode === 'view' ? (can ? <Btn className="tpl-editbtn" onClick={edit}>✎ Edit Template</Btn> : <span style={{ fontSize: 10, color: 'var(--muted)' }}>You can look at this script but not change it.</span>) : <><Btn onClick={cancel}>✕ Cancel</Btn><Btn className="tpl-save" disabled={busy} onClick={save}>💾 Save Changes</Btn></>)}</div>
        </div>
      )}
      <div className="tpl-two">
        <div className={`tpl-config${ro ? ' tpl-readonly' : ''}`}>
          <b style={{ fontSize: 13 }}>Template Configuration</b>
          <p style={{ fontSize: 10, color: 'var(--muted)', margin: '3px 0 0' }}>{ro ? 'View the details of this script.' : 'Write what the call says.'}</p>
          <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="tpl-form-grid">
              <div className="full"><label>TEMPLATE NAME</label><input placeholder="ivr_greeting_v1 (a name for your team)" value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
              <div><label>CATEGORY</label><select value={f.category} onChange={(e) => set({ category: e.target.value })}><option value="Utility">UTILITY</option><option value="Marketing">MARKETING</option></select></div>
              <div><label>LANGUAGE</label><select value={f.language} onChange={(e) => set({ language: e.target.value })}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div className="full"><label>VOICE SCRIPT</label><textarea value={f.script} placeholder="Hello, this is a message from TeamLink regarding your application." onChange={(e) => set({ script: e.target.value })} /><div className="tpl-hint">This script is read aloud by text-to-speech, or replaced entirely by the audio link below. Voice calls are not sent from Omni-Channel yet: this is where the wording is kept.</div></div>
              <div className="full"><label>AUDIO LINK · Optional</label>
                <div className="tpl-media-box">
                  {!ro ? <Btn onClick={() => setLib(true)}>🎵 {f.audio ? 'Replace audio link' : 'Choose audio link'}</Btn> : null}
                  {f.audio ? <div style={{ marginTop: 8, fontSize: 10, fontWeight: 700, color: '#5b6ee1', overflowWrap: 'anywhere' }}>{f.audio.name}</div> : (ro ? <span style={{ fontSize: 10, color: 'var(--muted)' }}>No audio attached.</span> : null)}
                </div>
                <div className="tpl-hint">The Library keeps pictures and documents; an audio file is saved there as a link.</div>
              </div>
            </div>
          </fieldset>
        </div>
        <div className="tpl-rail">
          <div className="card panel"><b style={{ fontSize: 13 }}>Live Preview</b><p style={{ fontSize: 9, color: 'var(--muted)', margin: '3px 0 12px' }}>How this script looks on a phone.</p><div style={{ display: 'flex', justifyContent: 'center' }}><PhonePreview f={{ channel: 'voice', voiceScript: f.script, audio: f.audio }} /></div></div>
        </div>
      </div>
      {err ? <div role="alert" style={{ background: '#fdeced', border: '1px solid #f4c9cc', color: '#9b1c1c', borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '12px 0 0' }}>{err}</div> : null}
      {isNew ? <button type="button" className="btn primary" style={{ width: '100%', height: 46, marginTop: 16, fontSize: 12 }} disabled={busy} onClick={save}>Save template</button>
        : <div className="tpl-edit-foot"><span>{ro ? `Last updated ${item.updatedAt ? fmtDate(item.updatedAt) : '—'}` : 'Save your changes.'}</span></div>}
      {lib ? <MediaLibraryModal title="Choose an audio link" types={['link', 'video']} multiple={false} onClose={() => setLib(false)} onPick={(p) => { if (p[0]) set({ audio: { libraryId: p[0].id, name: p[0].name, url: p[0].url } }); }} /> : null}
    </div>
  );
}

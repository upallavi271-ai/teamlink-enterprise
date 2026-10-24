import { SAMPLE } from './policy.js';

// The phone mock of the Templates page (WhatsApp / SMS / Email / Voice), with the prototype's own classes (gs.css: .phone, .wa-*, .media-preview-box ...).
// It shows the message with sample values (Anita, ICU Staff Nurse ...) the way WhatsApp's own reviewers see the example.
export const fill = (text, unsub) => String(text || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => (Object.prototype.hasOwnProperty.call(SAMPLE, v) ? (v === 'unsubscribe' ? (unsub || SAMPLE.unsubscribe) : SAMPLE[v]) : m));
export const BTN_ICON = { reply: '', url: '🔗 ', phone: '📞 ', whatsapp: '📱 ', code: '🏷 ', flow: '📋 ', order: '🧾 ' };
const COLORS = { whatsapp: '#11985a', sms: '#4d7ddb', email: '#666fd3', voice: '#5b6ee1' };

function HeaderMedia({ f }) {
  const t = f.headerType;
  const m = f.headerMedia && f.headerMedia.url ? f.headerMedia : null;
  if (t === 'location') {
    return (
      <div className="wa-hdr-media" style={{ minHeight: 78, background: '#dfe7e2', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 17 }}>📍</span>
        <span className="wa-hdr-ph">{(f.location && f.location.name) || 'LOCATION'}</span>
        {f.location && f.location.address ? <span style={{ fontSize: 7, color: '#6b7a82' }}>{f.location.address}</span> : null}
      </div>
    );
  }
  if (t === 'text') return f.headerText ? <div className="wa-hdr-text">{fill(f.headerText)}</div> : null;
  if (['image', 'video', 'document'].includes(t)) {
    return (
      <div className="wa-hdr-media">
        {m && t === 'image' ? <img src={m.url} alt="" /> : <span className="wa-hdr-ph">{m ? `${t === 'video' ? '▶' : '📄'} ${m.name || t.toUpperCase()}` : `${t.toUpperCase()} HEADER`}</span>}
      </div>
    );
  }
  return null;
}

export default function PhonePreview({ f }) {
  const ch = f.channel;
  const buttons = (f.buttons || []).filter((b) => b.label);
  if (ch === 'voice') {
    const bars = [12, 26, 17, 34, 14, 30, 19, 24];
    return (
      <div className="phone">
        <div className="phone-top"><span>Voice</span><span>9:41</span></div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', padding: 10 }}>
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: `${COLORS.voice}22`, display: 'grid', placeItems: 'center', fontSize: 22 }}>🎙</div>
          <div className="voice-bars">{bars.map((h, i) => <span key={i} style={{ height: h, background: COLORS.voice }} />)}</div>
          <div style={{ fontSize: 8, lineHeight: 1.6, color: 'var(--muted)', maxWidth: 200, overflowWrap: 'anywhere' }}>{fill(f.voiceScript || 'Your script will appear here.')}</div>
          {f.audio && f.audio.name ? <div style={{ fontSize: 8, color: COLORS.voice, fontWeight: 800 }}>🎵 {f.audio.name}</div> : null}
        </div>
      </div>
    );
  }
  if (ch === 'whatsapp') {
    return (
      <div className="phone">
        <div className="phone-status"><span>9:41</span><span className="phone-notch" /><span className="phone-status-r">▂▄▆ ᯤ ▮</span></div>
        <div className="wa-bar"><span className="wa-bar-logo">💬</span><span><b>WhatsApp Business</b><span>Business Account</span></span></div>
        <div className="phone-chat">
          <div className="wa-e2e">Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.</div>
          <div className="wa-msg">
            <HeaderMedia f={f} />
            <div className="wa-body">{f.body ? fill(f.body) : 'Your message will appear here.'}</div>
            {f.footer ? <div className="wa-foot">{f.footer}</div> : null}
            <div className="wa-time">10:30 AM</div>
            {f.callPermission ? (
              <>
                <div className="wa-callperm"><span className="wa-callperm-ico">📞</span><div className="wa-callperm-txt"><b>Allow calls</b><span>This business wants to call you on WhatsApp</span></div></div>
                <div className="wa-callperm-btns"><div className="wa-callperm-btn block">Block</div><div className="wa-callperm-btn allow">Allow</div></div>
              </>
            ) : buttons.map((b, i) => <div className="wa-btn" key={i}>{BTN_ICON[b.type] || ''}{b.label}</div>)}
          </div>
        </div>
        <div className="wa-compose"><i>＋</i><span className="wa-compose-in">Message</span><i>📷</i><i>🎤</i></div>
      </div>
    );
  }
  const color = COLORS[ch] || COLORS.email;
  const banner = f.headerMedia && f.headerMedia.url && ch === 'email' ? f.headerMedia : null;
  return (
    <div className="phone" style={{ background: '#f4f7f5', borderRadius: 30, padding: 10 }}>
      <div className="phone-top" style={{ height: 31, background: '#fff', borderRadius: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 11px', fontSize: 8, fontWeight: 900 }}><span>{ch === 'email' ? 'Email' : 'SMS'}</span><span>9:41</span></div>
      <div className="bubble" style={{ background: `${color}1a`, display: 'flex', flexDirection: 'column', gap: 5, overflowWrap: 'anywhere' }}>
        {banner ? <div className="media-preview-box" style={{ padding: 0, overflow: 'hidden' }}><img src={banner.url} alt="" style={{ width: '100%', display: 'block' }} /></div> : (ch === 'email' && f.headerType === 'image' ? <div className="media-preview-box"><span>🖼 Banner image</span></div> : null)}
        {ch === 'email' && f.subject ? <div style={{ fontWeight: 900, fontSize: 9 }}>{fill(f.subject)}</div> : null}
        <div>{f.body ? fill(f.body, ch === 'email' ? 'https://example.org/unsubscribe' : SAMPLE.unsubscribe) : 'Your message will appear here.'}</div>
        {f.footer ? <div style={{ marginTop: 6, fontSize: 7, color: '#8a958e' }}>{f.footer}</div> : null}
      </div>
    </div>
  );
}

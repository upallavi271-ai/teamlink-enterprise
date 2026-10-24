import { chOf } from './consoleKit.js';

// the prototype's phone preview: WhatsApp / SMS bubble, voice call card, email card. {{variables}} are shown highlighted (the real name is filled at send).
const VAR_SPLIT = /(\{\{[^{}]+\}\})/g;
const IS_VAR = /^\{\{[^{}]+\}\}$/;
function Words({ text }) {
  return String(text || '').split(VAR_SPLIT).map((part, i) => (IS_VAR.test(part) ? <span key={i} className="cp-var">{part}</span> : <span key={i}>{part}</span>)); // eslint-disable-line react/no-array-index-key
}
const withStop = (t) => (/\bSTOP\b/i.test(t) ? t : `${t}\n\nReply STOP to stop.`);

export default function ConsolePreview({ channel, account, templateName, body, subject, campaignName }) {
  const ch = chOf(channel);
  const text = String(body || '');
  if (!templateName && !text) {
    return (
      <div className="phone">
        <div className="preview-placeholder">
          <div className="ph-icon">💬</div>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink)' }}>No Template Selected</div>
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 5, maxWidth: 220 }}>Select an account and a template to see its preview here.</div>
        </div>
      </div>
    );
  }
  if (ch.kind === 'call') {
    const bars = [12, 26, 17, 34, 14, 30, 19, 24];
    return (
      <div className="phone">
        <div className="phone-top"><span>Voice</span><span>9:41</span></div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', padding: 10 }}>
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: ch.soft, display: 'grid', placeItems: 'center', fontSize: 22 }}>{ch.icon}</div>
          <div><b style={{ fontSize: 11 }}>{templateName || campaignName || 'Call task'}</b><br /><small style={{ fontSize: 8, color: 'var(--muted)' }}>Call task for you</small></div>
          <div className="voice-bars">{bars.map((h, i) => <span key={i} style={{ height: h, background: ch.color }} />)}</div>
          <div style={{ fontSize: 8, lineHeight: 1.6, color: 'var(--muted)', maxWidth: 200 }}><Words text={text} /></div>
        </div>
      </div>
    );
  }
  if (ch.kind === 'email') {
    return (
      <div className="phone">
        <div className="phone-top"><span>Email</span><span>9:41</span></div>
        <div className="cp-email">
          <div className="cp-email-head"><b>{subject || campaignName || templateName || 'Subject'}</b><small>from {account ? (account.sub && account.sub.includes('@') ? account.sub : account.name) : 'your company address'}</small></div>
          <div className="cp-email-body" style={{ whiteSpace: 'pre-wrap' }}><Words text={text} /></div>
          <div className="cp-footer" style={{ fontSize: 8, color: 'var(--muted)' }}>An unsubscribe link is added at the bottom when it is sent.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="phone phone-wa">
      <div className="cp-wa-top" style={{ background: ch.color }}><span className="cp-wa-av">{ch.icon}</span><div><b>{account ? account.name : ch.label}</b><small>Business Account</small></div></div>
      <div className="cp-thread" style={{ background: '#e9e2db' }}>
        <div className="cp-e2e">Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.</div>
        <div className="cp-bubble">
          <div className="cp-body" style={{ whiteSpace: 'pre-wrap' }}><Words text={withStop(text)} /></div>
          <div className="cp-time">9:41</div>
        </div>
      </div>
      <div className="composer"><input placeholder="Message" disabled /><button type="button" style={{ background: ch.color }}>➤</button></div>
    </div>
  );
}

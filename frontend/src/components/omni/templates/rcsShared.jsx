// RCS pieces shared by the gallery, the editor and the wizard: action types, blank forms, the Android-style phone preview (.rp-*), the carrier JSON preview.
export const RCS_TYPES = [
  { key: 'text', label: 'Plain Text', icon: 'T', desc: 'A single message, text only', pill: 'Text Message' },
  { key: 'card', label: 'Standalone Card', icon: '▪', desc: 'One card with an image, a title and buttons', pill: 'Standalone Card' },
  { key: 'carousel', label: 'Carousel', icon: '◧', desc: 'Several cards the customer can swipe through', pill: 'Carousel' },
];
export const RCS_ACTIONS = [
  { key: 'reply', label: 'Suggested Reply', ico: '💬', field: null },
  { key: 'url', label: 'Open URL', ico: '🔗', field: { key: 'url', label: 'URL', ph: 'https://teamlink.in/apply' } },
  { key: 'dial', label: 'Dial Phone', ico: '📞', field: { key: 'phone', label: 'Phone number', ph: '+91 90000 00000' } },
  { key: 'location', label: 'View Location', ico: '📍', field: { key: 'place', label: 'Place or address', ph: 'Banjara Hills, Hyderabad' } },
  { key: 'calendar', label: 'Calendar Event', ico: '📅', field: { key: 'event', label: 'Event title', ph: 'Walk-in interview' } },
];
export const MAX_ACTIONS = { text: 3, card: 4, carousel: 4 };
export const HEIGHTS = { short: 'SHORT_HEIGHT', medium: 'MEDIUM_HEIGHT', tall: 'TALL_HEIGHT' };
export const blankCard = () => ({ title: '', description: '', orientation: 'vertical', mediaHeight: 'medium', media: null, actions: [] });
let aid = 1;
export const withActionIds = (list) => (list || []).map((a) => ({ ...a, id: a.id || `a${aid++}` }));
export const newAction = () => ({ id: `a${aid++}`, type: 'reply', label: '', url: '', phone: '', place: '', event: '' });
export function prepForm(type, f) {
  const form = JSON.parse(JSON.stringify(f || {}));
  if (type === 'text') return { text: form.text || '', actions: withActionIds(form.actions) };
  if (type === 'card') return { ...blankCard(), ...form, actions: withActionIds(form.actions) };
  return { cards: (form.cards && form.cards.length ? form.cards : [blankCard(), blankCard()]).map((c) => ({ ...blankCard(), ...c, actions: withActionIds(c.actions) })) };
}
export const stripIds = (type, form) => {
  const a = (list) => (list || []).map(({ id, ...r }) => r); // eslint-disable-line no-unused-vars
  if (type === 'text') return { text: form.text, actions: a(form.actions) };
  if (type === 'card') return { ...form, actions: a(form.actions) };
  return { cards: form.cards.map((c) => ({ ...c, actions: a(c.actions) })) };
};
const icoOf = (t) => (RCS_ACTIONS.find((a) => a.key === t) || RCS_ACTIONS[0]).ico;

function Card({ c }) {
  return (
    <>
      <div className="rp-card">
        {c.media && c.media.url ? <img className={`rp-card-img ${c.mediaHeight || 'medium'}`} src={c.media.url} alt="" /> : <div className={`rp-card-img ph ${c.mediaHeight || 'medium'}`}>🖼</div>}
        {c.title ? <div className="rp-card-title">{c.title}</div> : null}
        {c.description ? <div className="rp-card-desc">{c.description}</div> : null}
      </div>
      {(c.actions || []).filter((a) => a.label).map((a, i) => <div className="rp-btn" key={i}>{icoOf(a.type)} {a.label}</div>)}
    </>
  );
}
export function RcsPhone({ type, form, agentName }) {
  const name = agentName || 'Your assistant';
  let body;
  if (type === 'text') {
    body = (
      <>
        <div className="rp-bubble" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{form.text || 'Your message will appear here.'}<span className="rp-stamp">RCS • Now</span></div>
        {(form.actions || []).filter((a) => a.label).map((a, i) => <div className="rp-btn" key={i}>{icoOf(a.type)} {a.label}</div>)}
      </>
    );
  } else if (type === 'card') body = <div className="rp-rich"><Card c={form} /><span className="rp-stamp">RCS • Now</span></div>;
  else body = <><div className="rp-carousel">{(form.cards || []).map((c, i) => <div className="rp-slide" key={i}><Card c={c} /></div>)}</div><span className="rp-stamp">RCS • Now</span></>;
  return (
    <div className="rp-phone">
      <div className="rp-status"><span>12:30</span><span className="rp-notch" /><span>5G 100%</span></div>
      <div className="rp-bar"><span>←</span><span className="rp-av">{name.slice(0, 1).toUpperCase()}</span><b>{name}</b><span className="rp-verified">●</span><span className="rp-bar-r">🔍 ⋮</span></div>
      <div className="rp-chat"><div className="rp-day">Today</div>{body}</div>
      <div className="rp-compose"><span>＋</span><span className="rp-input">RCS message</span><span>💬</span></div>
    </div>
  );
}

// the JSON a carrier would receive (preview only; nothing is sent). Same shape as the server's rcs.payload().
export function payloadOf(type, form) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const sug = (acts) => (acts || []).filter((a) => a.label).map((a) => {
    if (a.type === 'reply') return { reply: { text: a.label, postbackData: String(a.label).toLowerCase().replace(/\W+/g, '_') } };
    const action = { text: a.label };
    if (a.type === 'url') action.openUrlAction = { url: a.url || '' };
    if (a.type === 'dial') action.dialAction = { phoneNumber: a.phone || '' };
    if (a.type === 'location') action.viewLocationAction = { query: a.place || '' };
    if (a.type === 'calendar') action.createCalendarEventAction = { title: a.event || a.label };
    return { action };
  });
  const cc = (c) => ({ title: c.title || '', description: c.description || '', ...(c.media && c.media.url ? { media: { height: HEIGHTS[c.mediaHeight] || 'MEDIUM_HEIGHT', contentInfo: { fileUrl: `${origin}${c.media.url}` } } } : {}), suggestions: sug(c.actions) });
  let content;
  if (type === 'text') content = { plainText: form.text || '', suggestions: sug(form.actions) };
  else if (type === 'card') content = { standaloneCard: { cardOrientation: form.orientation === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL', cardContent: cc(form) } };
  else content = { carouselCard: { cardWidth: 'MEDIUM', cardContents: (form.cards || []).map(cc) } };
  return { messageID: 'PREVIEW_MESSAGE_ID', agentID: 'PREVIEW_AGENT_ID', campaignID: 'generated_campaign', contacts: ['+91XXXXXXXXXX'], data: { content } };
}

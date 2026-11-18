import { MeetLinkField } from './MeetStart.jsx';

// ---------------------------------------------------------------------------
// MEETING LINK with a provider (audit 235): Google Meet / Zoom / Teams / Other. Google Meet keeps its own field ("Create a Meet link", the
// standing link). The others take a pasted link, checked against that provider's link pattern as you type (the server checks again).
// ---------------------------------------------------------------------------
export const PROVIDERS = ['Google Meet', 'Zoom', 'Teams', 'Other'];
const RE = {
  'Google Meet': /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/i,
  Zoom: /^https:\/\/([a-z0-9-]+\.)?zoom\.(us|com)\/(j|my|wc\/join)\/[A-Za-z0-9_.-]+(\?.*)?$/i,
  Teams: /^https:\/\/(teams\.microsoft\.com\/(l\/meetup-join|meet)\/|teams\.live\.com\/meet\/)\S+$/i,
};
const EXAMPLE = { Zoom: 'https://zoom.us/j/123456789', Teams: 'https://teams.microsoft.com/l/meetup-join/…', Other: 'https://…' };
export function providerCheck(provider, raw) {
  const v = String(raw || '').trim();
  if (!v) return { state: 'empty' };
  if (/\s/.test(v)) return { state: 'bad', text: 'Paste only the link, without spaces.' };
  if (!/^https:\/\//i.test(v)) return { state: 'bad', text: 'The link should start with https://' };
  if (provider !== 'Other' && RE[provider] && !RE[provider].test(v)) return { state: 'bad', text: `That is not a ${provider} link. It looks like ${EXAMPLE[provider]}` };
  return { state: 'ok', text: `${provider} link looks good.` };
}

export default function MeetingProviderField({ provider, onProvider, value, onChange }) {
  const chk = providerCheck(provider, value);
  return (
    <div>
      <div role="radiogroup" aria-label="Meeting provider" style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        {PROVIDERS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={provider === p} className={`btn btn-sm${provider === p ? ' btn-primary' : ''}`} onClick={() => onProvider(p)}>{p}</button>
        ))}
      </div>
      {provider === 'Google Meet' ? <MeetLinkField value={value} onChange={onChange} /> : (
        <>
          <input type="url" aria-label={`${provider} link`} placeholder={`Paste the ${provider} link (${EXAMPLE[provider]})`} value={value} onChange={(e) => onChange(e.target.value)} />
          {chk.state !== 'empty' && <div className={`ims-chk is-${chk.state}`} role="status">{chk.text}</div>}
          <div className="ims-hint">Create the meeting in {provider === 'Other' ? 'your video tool' : provider}, copy its link and paste it here. You can also add it later.</div>
        </>
      )}
    </div>
  );
}

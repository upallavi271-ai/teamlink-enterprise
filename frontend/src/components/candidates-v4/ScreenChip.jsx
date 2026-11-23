// The auto-screen result on a candidate row (utils/autoScreen.js on the server): Pass / Review / Not suitable, the reasons on hover.
const TONE = { Pass: 'green', Review: 'amber', 'Not suitable': 'red' };
export const SCREEN_OPTIONS = [
  { value: 'pass', label: 'Pass' }, { value: 'review', label: 'Review' }, { value: 'notsuitable', label: 'Not suitable' }, { value: 'none', label: 'Not screened' },
];
export default function ScreenChip({ s }) {
  if (!s || !s.result) return null;
  const tone = TONE[s.result] || 'grey';
  const why = (s.reasons || []).join('\n');
  return (
    <span className={`scr-chip scr-${tone}`} title={`Auto-screen: ${s.result}${s.score != null ? ` (${s.score}%)` : ''}${why ? `\n${why}` : ''}${s.acted ? `\n${s.acted}` : ''}`}>
      {`Screen: ${s.result}`}
    </span>
  );
}

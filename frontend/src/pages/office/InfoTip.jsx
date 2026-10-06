// A small "i" next to a title: the explanation that used to be a paragraph on
// the page, shown as a tooltip on hover, on keyboard focus and on a tap
// (Office spec P2.4). Styles: officep2.css (.ofp-i).
import './officep2.css';

export default function InfoTip({ text, label = 'More about this' }) {
  if (!text) return null;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <span className="ofp-i" tabIndex={0} role="note" aria-label={`${label}: ${text}`} data-tip={text}>
      <span aria-hidden="true">i</span>
    </span>
  );
}

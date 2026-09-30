import logoMark from '../assets/teamlink-full-logo.png';

// ---------------------------------------------------------------------------
// The TeamLink Consultants lockup.
//
// This is the exact artwork tmlink.in serves (assets/teamlink-full-logo.png),
// untouched — the wordmark, the interlocking-rings glyph and every colour are
// the company's own. Nothing here recolours it: a CSS filter or a redrawn
// "close enough" vector is how a logo stops being the logo.
//
// WHY IT IS SHARP NOW. The old file was a 136x33 bitmap, so on any screen with
// more than one device pixel per CSS pixel (every laptop at 125–150% scaling,
// every phone) it was being stretched and looked blurred. This one is
// 1600x335 with a transparent background, so it is only ever scaled DOWN and
// stays crisp at every size the app draws it.
// ---------------------------------------------------------------------------

const NATURAL_W = 1600;
const NATURAL_H = 335;
const DEFAULT_W = 170;

export function TeamLinkMark({ width = DEFAULT_W }) {
  const w = Math.min(width, NATURAL_W);
  return (
    <img
      className="brand-mark"
      src={logoMark}
      alt="TeamLink Consultants"
      width={w}
      height={Math.round((w / NATURAL_W) * NATURAL_H)}
      decoding="async"
      draggable="false"
    />
  );
}

// The sidebar lockup: the mark on its plate, product name underneath.
export default function Logo({ width = DEFAULT_W, plate = true }) {
  return (
    <span className="brand-lockup">
      <span className={plate ? 'brand-plate' : undefined}>
        <TeamLinkMark width={width} />
      </span>
      <span className="b2">TeamLink.Enterprise</span>
    </span>
  );
}

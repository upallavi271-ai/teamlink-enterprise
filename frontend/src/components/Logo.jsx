import logoLight from '../assets/teamlink-logo-light.svg';
import logoDark from '../assets/teamlink-logo.svg';

// ---------------------------------------------------------------------------
// The TeamLink Consultants lockup.
//
// What was wrong: this app had NO logo asset at all. The sidebar's "brand" was
// two lines of small, low-contrast text (11px #8b96b8 on #121c34) and the
// login card drew a serif letter in a rounded box. Nothing was artwork, so
// there was nothing crisp to look at — at 125%/150% Windows scaling or on a
// HiDPI screen the small grey type is exactly what reads as blurry.
//
// The fix is the real wordmark as VECTOR: an SVG (the "TeamLink Consultants"
// wordmark with the interlocking-rings glyph) referenced at its natural
// aspect ratio, 1452:324. Because it is SVG it is resolution-independent —
// nothing is upscaled, so it stays sharp at any zoom or pixel density. Two
// colourways ship: the navy original for light surfaces and a white/blue
// variant for the dark sidebar, so the mark is never recoloured by a CSS
// filter (which is what makes a logo look washed out).
// ---------------------------------------------------------------------------

const ASPECT = 1452 / 324;

export function TeamLinkMark({ width = 168, variant = 'light' }) {
  const src = variant === 'light' ? logoLight : logoDark;
  return (
    <img
      className="brand-mark"
      src={src}
      alt="TeamLink Consultants"
      width={width}
      height={Math.round(width / ASPECT)}
      draggable="false"
    />
  );
}

// The sidebar lockup: the wordmark, with the product name under it.
export default function Logo({ width = 168, variant = 'light' }) {
  return (
    <span className="brand-lockup">
      <TeamLinkMark width={width} variant={variant} />
      <span className="b2">TeamLink.Enterprise</span>
    </span>
  );
}

import logoMark from '../assets/teamlink-logo.png';

// ---------------------------------------------------------------------------
// The TeamLink Consultants lockup.
//
// This is the client's own artwork, cropped to its bounding box and otherwise
// untouched — the wordmark, the interlocking-rings glyph and every colour are
// exactly the supplied file's. Nothing here recolours it: a CSS filter or a
// redrawn "close enough" vector is how a logo stops being the logo.
//
// It is a 136x33 bitmap, so it is rendered at its natural size and never
// scaled up; upscaling is what made the old mark look blurry. The artwork has
// a white background and near-black navy type, so on the dark sidebar it sits
// on a white plate (.brand-plate) rather than being inverted.
//
// If a vector original (SVG) or a larger export turns up, drop it in beside
// this file and swap the import — it will then be crisp at any size.
// ---------------------------------------------------------------------------

const NATURAL_W = 136;
const NATURAL_H = 33;

export function TeamLinkMark({ width = NATURAL_W }) {
  const w = Math.min(width, NATURAL_W); // never upscale
  return (
    <img
      className="brand-mark"
      src={logoMark}
      alt="TeamLink Consultants"
      width={w}
      height={Math.round((w / NATURAL_W) * NATURAL_H)}
      draggable="false"
    />
  );
}

// The sidebar lockup: the mark on its white plate, product name underneath.
export default function Logo({ width = NATURAL_W, plate = true }) {
  return (
    <span className="brand-lockup">
      <span className={plate ? 'brand-plate' : undefined}>
        <TeamLinkMark width={width} />
      </span>
      <span className="b2">TeamLink.Enterprise</span>
    </span>
  );
}

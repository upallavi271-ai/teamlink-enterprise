import logoMark from '../assets/teamlink-full-logo.png';
import logo180 from '../assets/teamlink-logo-180.png';
import logo240 from '../assets/teamlink-logo-240.png';
import logo340 from '../assets/teamlink-logo-340.png';
import logo480 from '../assets/teamlink-logo-480.png';
import logo680 from '../assets/teamlink-logo-680.png';
import logo1000 from '../assets/teamlink-logo-1000.png';

// SHARP AT EVERY SIZE (founder 2026-11-10: "logo chaala blur avuthundhi"): the browser shrank the 1600px artwork about ten times
// in one go, which softens the lettering. These are the same artwork shrunk once, carefully (Lanczos, a light sharpen), to the
// widths the app draws it at; the browser picks the one that fits the screen's pixel density and barely has to scale it.
const SRCSET = `${logo180} 180w, ${logo240} 240w, ${logo340} 340w, ${logo480} 480w, ${logo680} 680w, ${logo1000} 1000w, ${logoMark} 1600w`;

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
      src={logo340}
      srcSet={SRCSET}
      sizes={`${w}px`}
      alt="TeamLink Consultants"
      width={w}
      height={Math.round((w / NATURAL_W) * NATURAL_H)}
      decoding="sync"
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

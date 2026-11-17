// ---------------------------------------------------------------------------
// WHOSE COPY OF THE APPLICATION IS THIS? (2026-11-16, docs/second-company.md)
//
// TeamLink's own build sets nothing, so every value below is exactly what the screens always said. A SEPARATE COMPANY's copy is built
// with its own name, for example   VITE_BRAND_NAME="NISHTECHNOLOGIES INDIA PVT LTD"  npm run build
// and then shows that name (as a text mark, until the company gives a logo) on the sign-in page, the menu and the browser tab,
// and does not offer TeamLink's Job Portal link (that is a separate program with its own database that this copy does not have).
//
//   VITE_BRAND_NAME      the company's name, shown as the mark.            (unset = TeamLink Consultants, the picture logo)
//   VITE_BRAND_PRODUCT   the product line under it / in the tab title.     (unset = TeamLink.Enterprise; with a name: "<name> · Enterprise")
// ---------------------------------------------------------------------------
const env = (import.meta && import.meta.env) || {};
const NAME = String(env.VITE_BRAND_NAME || '').trim();

export const BRAND = Object.freeze({
  // true only in a separate company's build
  separate: !!NAME,
  name: NAME || 'TeamLink Consultants',
  product: String(env.VITE_BRAND_PRODUCT || '').trim() || (NAME ? 'Enterprise' : 'TeamLink.Enterprise'),
});

export default BRAND;

import { useLocation } from 'react-router-dom';
import { vendorToken } from '../../vendorApi';

// Who may be where (spec v2 §1), UI side — the server's global guard is what
// actually refuses the APIs:
//   * a VENDOR signed in on this browser: every address outside the Vendor
//     Portal goes to /vendor/assets;
//   * a STAFF login (Admin / Accountant …) on /vendor/*: back to its own home.
//     No impersonation — staff never see the portal through their own token.
export function useVendorRedirect() {
  const { pathname } = useLocation();
  const vendor = !!vendorToken();
  const inPortal = pathname === '/vendor-login' || pathname === '/vendor' || pathname.startsWith('/vendor/');
  if (vendor) return inPortal ? null : '/vendor/assets';
  let staff = false;
  try { staff = !!localStorage.getItem('tl_token'); } catch { staff = false; }
  if (staff && (pathname === '/vendor' || pathname.startsWith('/vendor/'))) return '/';
  return null;
}

export default useVendorRedirect;

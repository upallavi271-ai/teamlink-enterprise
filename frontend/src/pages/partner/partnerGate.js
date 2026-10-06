import { useLocation } from 'react-router-dom';
import { partnerToken } from '../../partnerApi';

// While a partner is signed in on this browser, every address outside the
// Partner Portal (/partner-login, /partner/...) goes to /partner/jobs. UI only
// — the server's global guard is what actually refuses the other APIs (403).
export function usePartnerRedirect() {
  const { pathname } = useLocation();
  if (!partnerToken()) return null;
  if (pathname === '/partner-login' || pathname === '/partner' || pathname.startsWith('/partner/')) return null;
  return '/partner/jobs';
}

export default usePartnerRedirect;

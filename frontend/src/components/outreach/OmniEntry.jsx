import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOmniEntry } from './useOmniChildren.js';
import { omniAllowed } from './access.js';
import GreenStart from './GreenStart.jsx';
import { OMNI_BASE } from '../omni/omniPages.js';

// ---------------------------------------------------------------------------
// What the sidebar entry "Omni-Channel" (/omni-channel) opens (founder, 2026-10-21): his own Green Start product, as it is (green-start-app/).
// - a login that may open it (Admin, Manager / AM, TL / STL, HR; GREENSTART_ALL_ROLES=1 widens it) sees Green Start;
// - every other Omni-Channel login (BDE, BDE TL, Recruiter, Marketing, Finance) goes to the native Omni-Channel pages, because Green Start
//   has no phone / email masking;
// - the native pages themselves live on at /omni-channel-native/... (type the address), nothing was deleted.
// To switch the native pages back as the main entry: in App.jsx point the routes "omni" and "omni-channel" at <OmniApp /> again.
// ---------------------------------------------------------------------------
// full: the /green-start page (its own tab, Green Start over the whole window, no TeamLink sidebar).
export default function OmniEntry({ full = false }) {
  const { user } = useAuth();
  const { kids, greenStart } = useOmniEntry(user);
  const { search } = useLocation();
  if (user && !omniAllowed(user)) return <Navigate to="/" replace />;
  if (kids === null) return <div className="gs-wrap"><div className="oc-note">Loading…</div></div>;
  if (!kids.length) return <div className="gs-wrap"><div className="oc-note" role="status">There is nothing for your login in Omni-Channel yet.</div></div>;
  if (!greenStart) return <Navigate to={`${OMNI_BASE}${search}`} replace />;
  return <GreenStart full={full} />;
}

// Old addresses (/omni-channel/<page>[/<tab>]) keep working: they open the same page in the native Omni-Channel.
export function OmniLegacyRedirect() {
  const { hub, view } = useParams();
  const { search } = useLocation();
  return <Navigate to={`${OMNI_BASE}/${hub}${view ? `/${view}` : ''}${search}`} replace />;
}

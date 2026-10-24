import { Navigate, useParams } from 'react-router-dom';
import { SCREENS } from './vendorScreens.js';

// /vendor/m/:moduleKey - the ONE route that serves every module screen (the screen map is vendorScreens.js). A key that has
// no screen goes back to the Overview; a module the login does not have is turned back by the shell's route guard
// (and the API answers 403 for it anyway).
export default function VendorModuleRoute() {
  const { moduleKey } = useParams();
  const Screen = SCREENS[moduleKey];
  if (!Screen) return <Navigate to="/vendor/dashboard" replace />;
  return <Screen />;
}

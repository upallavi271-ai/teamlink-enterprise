import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { loadListMasters } from '../utils/specMaster';

// Reads the Admin's master lists (Sources, Reject reasons, Priorities,
// Locations) once per signed-in internal login and fills the dropdown lists
// with them (utils/specMaster.js). Draws nothing.
const EXTERNAL = ['CLIENT', 'CANDIDATE'];
export default function ListMastersLoader() {
  const { user } = useAuth();
  const id = user && !EXTERNAL.includes(user.role) ? user.id : null;
  useEffect(() => { if (id) loadListMasters(); }, [id]);
  return null;
}

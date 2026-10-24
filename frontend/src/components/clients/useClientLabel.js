import { useSyncExternalStore } from 'react';
import { clientLabel, clientLabelOf, clientPlacesVersion, onClientPlacesChange } from '../../utils/clientLocation.js';

// A dropdown / list that shows clients: `const label = useClientLabel();` then `label(c)` ({ id, name, placeLabel? })
// or `label.of(id, name)`. Same-name clients read "Name - Location"; the screen redraws when the list arrives.
export default function useClientLabel() {
  useSyncExternalStore(onClientPlacesChange, clientPlacesVersion);
  const f = (c) => clientLabel(c);
  f.of = clientLabelOf;
  return f;
}

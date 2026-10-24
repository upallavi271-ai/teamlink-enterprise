// What every Omni-Channel page can ask for:  const { acc, go, toast, dept } = useOmni();
//   acc    the /api/outreach/me answer (level, pages, canX flags, departments ...)
//   go(page, params)  open another Omni-Channel page (params -> ?query), e.g. go('campaigns', { channel: 'whatsapp' })
//   toast(text)       the small green message at the bottom (the prototype's showToast)
//   dept   the picked workspace (department) or ''
import { createContext, useContext } from 'react';

export const OmniCtx = createContext({ acc: null, go: () => {}, toast: () => {}, dept: '' });
export const useOmni = () => useContext(OmniCtx);

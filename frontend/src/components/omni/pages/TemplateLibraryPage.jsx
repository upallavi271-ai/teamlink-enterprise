import { PageHead } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import TemplateLibrary from '../library/TemplateLibrary.jsx';

// TEMPLATES > Template library: ONE list of every template of the app (Omni-Channel, ATS, Job Portal, HRMS, Accounts): where it is used, department, channel, words,
// variables, approval, version history, and an Edit button on every row. The same list opens inside the ATS, Job Portal, HRMS and Accounts screens
// (button "Templates & campaigns"), cut to the templates that app may use. Server: /api/omni/library.
export default function TemplateLibraryPage() {
  const { go, toast } = useOmni();
  return (
    <div>
      <PageHead eyebrow="One library for every app" title="Template library" lead="Every message template in one place. Each one says where it is used (ATS, Job Portal, HRMS, Accounts, Omni-Channel), who approved it, and keeps every earlier version." />
      <TemplateLibrary toast={toast} onEdit={(t) => go('templates', { channel: String(t.channel || '').toLowerCase() })} />
    </div>
  );
}

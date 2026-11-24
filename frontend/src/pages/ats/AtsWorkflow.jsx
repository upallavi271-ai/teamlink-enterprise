// ATS -> Workflow: the user's actual workflow with live counts per box, in
// the viewer's own scope. Reached from the ATS Dashboard ("See workflow") and
// the Workflow tab of ATS Reports; not a sidebar module.
import { Link } from 'react-router-dom';
import WorkflowDiagram from '../../components/workflow/WorkflowDiagram.jsx';
import { t as tr } from '../../i18n.jsx'; // ATS headings in Telugu / Hindi (ATS wave 2 Z, 13.06)

export default function AtsWorkflow() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{tr('Workflow')}</h1>
          <div className="page-sub">
            Requirement → Job Portal screening → Send to ATS → client or internal hiring → joining →
            guarantee → Accounts → invoice → payment. Every box counts the candidates at that step right
            now; click a box for the list.
          </div>
        </div>
        <Link className="btn" to="/ats/dashboard">Back to Dashboard</Link>
      </div>
      <WorkflowDiagram />
    </div>
  );
}

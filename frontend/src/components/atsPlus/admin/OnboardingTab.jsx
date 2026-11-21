import { ClauseLibrary } from '../OffersPlus.jsx';
import { ChecklistTemplates } from '../OnboardingPlus.jsx';

// ATS settings -> Offers & onboarding: the offer clause library (11.06) and the joining checklists by client and job type (11.10).
export default function OnboardingTab() {
  return (
    <>
      <ClauseLibrary />
      <ChecklistTemplates />
    </>
  );
}

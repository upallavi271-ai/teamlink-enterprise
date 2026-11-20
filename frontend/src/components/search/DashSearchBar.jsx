import SearchBox from './SearchBox.jsx';
import './search.css';

// The big search bar at the top of every ATS dashboard (inside the page, above the cards). The same box as the top bar's, so there is one engine
// and one result component: whatever is typed, the complete end-to-end history comes (candidate, recruiter, TL, client, requirement, interview, offer,
// joining, invoice, agreement ...). One tag in each dashboard.
export default function DashSearchBar() {
  return (
    <div className="dsb" data-testid="dash-search-bar">
      <SearchBox variant="bar" placeholder="Search anything: candidate, recruiter, TL, client, requirement, phone, invoice…" />
    </div>
  );
}

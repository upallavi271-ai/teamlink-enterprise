import SearchBox from './search/SearchBox.jsx';
import './GlobalSearch.css';

// ---------------------------------------------------------------------------
// "Search TeamLink": the top bar's search box. It is the SAME box and the SAME engine as the big bar on every ATS dashboard
// (components/search/SearchBox.jsx -> GET /api/ats/history/search): results as you type, grouped, each opening its complete history; Enter opens
// the full results page (/ats/search). The server scopes every group to what this login may see.
// ---------------------------------------------------------------------------
export default function GlobalSearch() {
  return <SearchBox variant="compact" placeholder="Search TeamLink" />;
}

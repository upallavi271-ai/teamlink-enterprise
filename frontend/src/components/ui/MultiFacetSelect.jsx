import './MultiFacetSelect.css';
import MultiSelect from '../ats/MultiSelect.jsx';

// The checkbox dropdown with counts: now ONE component for every filter (components/ats/MultiSelect.jsx). value / onChange are a comma list.
export default function MultiFacetSelect(props) {
  return <MultiSelect {...props} />;
}

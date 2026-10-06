// A recruiter's own "3 of 4 joinings this month" (HRMS dashboard). Renders
// nothing for anybody who is not on the recruiter list.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { PanelPad } from '../proto.jsx';
import './rj.css';

export default function MyJoiningsCard() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/recruiter-joinings/mine').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d || !d.listed) return null;
  const left = Math.max(0, d.target - d.joinings);
  return (
    <PanelPad style={{ marginBottom: 16 }}>
      <div className="rj rj-mine">
        <span className={`rj-score ${d.tone}`}><b>{d.joinings} of {d.target}</b></span>
        <div>
          <div style={{ fontWeight: 600 }}>My joinings — {d.label}{d.seat ? ` · ${d.seat}` : ''}</div>
          <div className="rj-sub">
            {d.joinings === 0 ? 'No joinings yet this month. ' : ''}
            {left > 0 ? `${left} more to reach your target.` : 'Target reached — well done!'}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Link className="btn btn-sm" to="/performance?tab=joinings">See my joinings</Link>
      </div>
    </PanelPad>
  );
}

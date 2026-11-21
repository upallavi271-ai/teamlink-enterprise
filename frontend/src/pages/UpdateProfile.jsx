import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import '../components/mktb/mktb.css';

// THE CANDIDATE'S OWN PROFILE-UPDATE LINK (market wave B 03.17), /update-profile/:token - no login. The recruiter makes the link on
// the candidate's Hiring tools tab and sends it; the person corrects their own details once (14 days). Phone and e-mail are not
// shown or changed here (the link could be forwarded). Backend: routes/mktBPublic.js -> utils/mktb/cands.js linkView / linkSubmit.
const LABELS = {
  currentCompany: 'Current company', currentDesignation: 'Current job title', experienceYears: 'Total experience (years)', location: 'City you live in',
  preferredLocation: 'Cities you would work in', noticePeriod: 'Notice period (e.g. 30 Days, Immediate)', currentSalary: 'Current salary (yearly, e.g. 6 LPA)',
  expectedSalary: 'Expected salary (yearly)', skills: 'Your skills (separate with commas)', education: 'Highest education',
};
export default function UpdateProfile() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [vals, setVals] = useState({});
  const [state, setState] = useState({ step: 'loading', text: '' });
  useEffect(() => {
    api.get(`/public/mkt/profile/${token}`).then((r) => { setData(r.data); setVals(r.data.values); setState({ step: 'form', text: '' }); })
      .catch((e) => setState({ step: 'error', text: e?.response?.data?.error || 'This link is not valid.' }));
  }, [token]);
  const submit = async (e) => {
    e.preventDefault();
    setState({ step: 'sending', text: '' });
    try { const r = await api.post(`/public/mkt/profile/${token}`, vals); setState({ step: 'done', text: r.data.message }); } catch (err) { setState({ step: 'form', text: err?.response?.data?.error || 'Could not save. Please try again.' }); }
  };
  return (
    <main className="mkb-public">
      <h1 style={{ fontSize: 22 }}>Update your details</h1>
      {state.step === 'loading' && <p>Loading…</p>}
      {state.step === 'error' && <div className="mkb-flash bad">{state.text}</div>}
      {state.step === 'done' && <div className="mkb-flash good">{state.text}</div>}
      {data && ['form', 'sending'].includes(state.step) && (
        <form onSubmit={submit}>
          <p>{`Hello ${data.firstName}, please check these details and correct anything that has changed. This link works once.`}</p>
          {data.fields.map((k) => (
            <div key={k}>
              <label htmlFor={`up-${k}`}>{LABELS[k] || k}</label>
              <input id={`up-${k}`} type={k === 'experienceYears' ? 'number' : 'text'} step="0.5" min="0" value={vals[k] == null ? '' : vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
            </div>
          ))}
          {state.text && <div className="mkb-flash bad">{state.text}</div>}
          <button type="submit" className="btn btn-primary" style={{ marginTop: 14 }} disabled={state.step === 'sending'}>Save my details</button>
          <p className="small-muted">Your phone number and e-mail are not shown here. To change them, reply to your recruiter.</p>
        </form>
      )}
    </main>
  );
}

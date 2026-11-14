import { useEffect, useState } from 'react';
import api from '../../../api';
import OurWork from './OurWork.jsx';

// /our-work: the public "Our work" page (no login) a salesperson can send to a new client. Same content as the block on the client's project page.
export default function OurWorkPage() {
  const [brand, setBrand] = useState(null);
  const [none, setNone] = useState(false);
  useEffect(() => {
    document.title = 'Our work';
    api.get('/public/mk-work').then((r) => { setBrand(r.data.brand); setNone(!r.data.items.length && !(r.data.stats && r.data.stats.approved)); }).catch(() => setNone(true));
  }, []);
  const P = (brand && brand.colors && brand.colors.primary) || '#0f766e';
  const S2 = (brand && brand.colors && brand.colors.secondary) || '#134e4a';
  return (
    <div style={{ minHeight: '100vh', background: '#f4f6f5', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', color: '#1c2a24', paddingBottom: 40 }}>
      <div style={{ background: `linear-gradient(135deg, ${P}, ${S2})`, color: '#fff', padding: '26px 16px 40px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <div style={{ fontSize: 12, letterSpacing: '.12em', fontWeight: 800, opacity: 0.85 }}>{String((brand && brand.name) || '').toUpperCase()}</div>
          <h1 style={{ fontSize: 26, margin: '6px 0 2px', color: '#fff', fontFamily: 'inherit' }}>Our work</h1>
          <div style={{ fontSize: 14, opacity: 0.9 }}>What we made for clients, and how we handle a project from request to post.</div>
        </div>
      </div>
      <div style={{ padding: '18px 16px 0' }}>
        {none ? <div style={{ maxWidth: 680, margin: '0 auto', background: '#fff', borderRadius: 14, padding: 18, boxShadow: '0 1px 6px rgba(0,0,0,.08)', lineHeight: 1.6 }}>We are adding our first finished projects here. Please ask us for examples.</div> : <OurWork P={P} title="Finished projects" />}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { TeamLinkMark } from '../../components/Logo.jsx';
import './home.css';

// ---------------------------------------------------------------------------
// The public home page of TeamLink.Enterprise.
//
// Shown to a logged-out visitor at "/" (ProtectedRoute renders it in place of
// the redirect to /login) and always at "/home". Everything on it is a
// capability statement: no figures, logos or testimonials that the product
// cannot stand behind. The one mock (the AI chat) is labelled as illustrative.
//
// All styling lives in ./home.css under the .home root class, so nothing here
// leaks into the app, and the app's own `main{}` rule is neutralised there.
// ---------------------------------------------------------------------------

const ADDRESS = '#606, 6th Floor, ARV Work Spaces LLP, KPHB, Hyderabad – 500072, Telangana, India';
const WEBSITE = 'https://tmlink.in';

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToId(id, focus) {
  const el = document.getElementById(id);
  if (!el) return;
  // A background tab runs no animation frames, so a smooth scroll there never moves.
  const instant = reducedMotion() || document.hidden;
  el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
  if (focus) {
    const target = el.querySelector('h2') || el;
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
}

// In-page anchors: a real href (works without JS, copyable), smooth scroll on click.
function Anchor({ to, children, className, onNavigate }) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        if (onNavigate) onNavigate();
        scrollToId(to, true);
        window.history.replaceState(null, '', `#${to}`);
      }}
    >
      {children}
    </a>
  );
}

/* ----------------------------- content ------------------------------ */

const FLOW = [
  { n: '01', t: 'Client & agreement', d: 'BDE onboards the client; the agreement is signed online.', phase: 'sales' },
  { n: '02', t: 'Requirement', d: 'Role, openings, fee terms and an owner.', phase: 'sales' },
  { n: '03', t: 'Candidates', d: 'Sourced or applied from the job portal; everyone lands at New.', phase: 'recruit' },
  { n: '04', t: 'Reviews', d: 'AI interview, recruiter, TL and BDE screens, each on an SLA.', phase: 'recruit' },
  { n: '05', t: 'Client interview', d: 'Scheduled on the shared calendar, feedback captured.', phase: 'client' },
  { n: '06', t: 'Selected', d: 'Offer and expected date of joining recorded.', phase: 'client' },
  { n: '07', t: 'Joined', d: 'Joining confirmed — the moment billing starts.', phase: 'client' },
  { n: '08', t: 'Invoice', d: 'Raised automatically from the agreement’s terms, with GST.', phase: 'money' },
  { n: '09', t: 'Paid', d: 'Matched against the bank statement; TDS recorded.', phase: 'money' },
];

const PIPELINE = ['New', 'AI Interview', 'Recruiter', 'TL', 'BDE', 'Client', 'Interview', 'Selected', 'Joined'];

const PRODUCTS = [
  {
    key: 'hrms',
    code: 'HRMS',
    title: 'People, time and pay',
    lead: 'Everything that happens to an employee, from the day they join.',
    items: [
      'Employee records, documents and seat history',
      'Attendance with GPS, biometric and face check-in',
      'Leave policies, approvals and balances',
      'Payroll runs and payslips',
      'LMS courses with certificates, and performance reviews',
    ],
  },
  {
    key: 'ats',
    code: 'ATS',
    title: 'Clients to candidates',
    lead: 'The recruitment desk, from a client’s first requirement to a joining.',
    items: [
      'Clients, agreements and requirements',
      'Follow-ups with SLA escalation when something stalls',
      'Interview calendar and a public job portal',
      'Reports that drill down to the record behind every number',
    ],
    pipeline: true,
  },
  {
    key: 'acc',
    code: 'Accounts',
    title: 'Joinings to cash',
    lead: 'Billing that follows the pipeline instead of chasing it.',
    items: [
      'An invoice raised automatically when a candidate joins',
      'Payments and receipts against each invoice',
      'Bank reconciliation from the statement',
      'GST and TDS handled on every bill',
      'Office expenses and vendors',
    ],
  },
];

const SECURITY = [
  {
    t: 'Role-based',
    d: 'Every screen and every API call checks the role a person holds in that product.',
    icon: <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />,
  },
  {
    t: 'Department-scoped',
    d: 'Data is limited to the person’s department and team, not just hidden in the menu.',
    icon: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>,
  },
  {
    t: 'Audit log',
    d: 'Approvals and changes to records are written to an audit trail administrators can review.',
    icon: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7M9 7h3" /></>,
  },
  {
    t: 'OTP-verified email',
    d: 'Email addresses are confirmed with a one-time code before they are trusted.',
    icon: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  },
];

/* ------------------------------ pieces ------------------------------ */

function Glyph({ children }) {
  return (
    <svg className="home-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function SignUpChooser() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    panelRef.current?.querySelector('a,button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="home-signup">
      <button
        ref={btnRef}
        type="button"
        className="home-btn home-btn-primary home-btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="home-signup-panel"
        onClick={() => setOpen((v) => !v)}
      >
        Sign up
      </button>
      {open && (
        <div
          ref={panelRef}
          id="home-signup-panel"
          className="home-chooser"
          role="dialog"
          aria-label="Choose how to sign up"
        >
          <div className="home-chooser-title">Who are you signing up as?</div>
          <Link to="/job-portal" className="home-choice">
            <span className="home-choice-icon" aria-hidden="true">
              <Glyph><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></Glyph>
            </span>
            <span className="home-choice-text">
              <strong>I’m looking for a job</strong>
              <span>Create a candidate profile on the Job Portal and apply.</span>
            </span>
            <span className="home-choice-arrow" aria-hidden="true">→</span>
          </Link>
          <a
            href="#contact"
            className="home-choice"
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              scrollToId('contact', true);
            }}
          >
            <span className="home-choice-icon" aria-hidden="true">
              <Glyph><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5h6v2" /></Glyph>
            </span>
            <span className="home-choice-text">
              <strong>I’m hiring</strong>
              <span>For companies — talk to TeamLink Consultants.</span>
            </span>
            <span className="home-choice-arrow" aria-hidden="true">↓</span>
          </a>
          <p className="home-chooser-note">
            Employees: your login is created by HR — use <Link to="/login">Log in</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

function HeroVisual() {
  return (
    <div className="home-orbit" aria-hidden="true">
      <svg className="home-orbit-svg" viewBox="0 0 520 480" focusable="false">
        <defs>
          <radialGradient id="hv-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#BF8F00" stopOpacity=".28" />
            <stop offset="1" stopColor="#BF8F00" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="260" cy="232" r="96" fill="url(#hv-glow)" className="hv-pulse" />
        <g className="hv-rings">
          <circle className="hv-ring hv-hrms" cx="188" cy="192" r="128" />
          <circle className="hv-ring hv-ats" cx="332" cy="192" r="128" />
          <circle className="hv-ring hv-acc" cx="260" cy="316" r="128" />
        </g>
        {/* dotted guides — the orbits the travellers run on */}
        <circle className="hv-guide" cx="188" cy="192" r="146" />
        <circle className="hv-guide" cx="332" cy="192" r="146" />
        <circle className="hv-guide" cx="260" cy="316" r="146" />
        <g className="hv-spin hv-spin-1"><circle cx="188" cy="46" r="5.5" className="hv-dot" /></g>
        <g className="hv-spin hv-spin-2"><circle cx="332" cy="46" r="5.5" className="hv-dot" /></g>
        <g className="hv-spin hv-spin-3"><circle cx="260" cy="170" r="5.5" className="hv-dot" /></g>
      </svg>

      <div className="hv-label hv-l-hrms">
        <b>HRMS</b><span>people<br />attendance<br />payroll</span>
      </div>
      <div className="hv-label hv-l-ats">
        <b>ATS</b><span>clients<br />pipeline<br />interviews</span>
      </div>
      <div className="hv-label hv-l-acc">
        <b>Accounts</b><span>invoices<br />bank<br />GST</span>
      </div>

      <div className="hv-core">
        <span className="hv-core-icon">
          <Glyph><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></Glyph>
        </span>
        <span>One login</span>
      </div>

      <div className="hv-chip hv-chip-1"><i className="hv-chip-dot is-teal" />Candidate joined</div>
      <div className="hv-chip hv-chip-2"><i className="hv-chip-dot is-gold" />Invoice raised</div>
      <div className="hv-chip hv-chip-3"><i className="hv-chip-dot is-navy" />Face check-in</div>
    </div>
  );
}

function Flow() {
  return (
    <div className="home-flow">
      <div className="home-flow-phases" aria-hidden="true">
        <span className="ph-sales">Sales · BDE</span>
        <span className="ph-recruit">Recruitment · Recruiter &amp; TL</span>
        <span className="ph-client">With the client</span>
        <span className="ph-money">Accounts</span>
      </div>
      <ol className="home-flow-steps">
        {FLOW.map((s) => (
          <li key={s.n} className={`home-step ph-${s.phase}`}>
            <span className="home-step-node" aria-hidden="true" />
            <span className="home-step-n">{s.n}</span>
            <strong className="home-step-t">{s.t}</strong>
            <span className="home-step-d">{s.d}</span>
          </li>
        ))}
      </ol>
      <div className="home-flow-branch">
        <span className="home-branch-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" focusable="false"><path d="M6 6v12c0 8 6 14 14 14h14" /><path d="M28 26l6 6-6 6" /></svg>
        </span>
        <p>
          <strong>Internal hire?</strong> The same pipeline ends in HRMS instead: the selected
          candidate becomes an employee with a login — not an invoice.
        </p>
      </div>
    </div>
  );
}

function ProfileCard() {
  return (
    <figure className="home-profile" aria-labelledby="home-profile-cap">
      <div className="home-profile-head">
        <span className="home-avatar" aria-hidden="true">TL</span>
        <div>
          <div className="home-profile-name">A team lead</div>
          <div className="home-profile-mail">one email · one password</div>
        </div>
        <span className="home-profile-key" aria-hidden="true">
          <Glyph><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></Glyph>
        </span>
      </div>
      <dl className="home-roles">
        <div className="home-role r-hrms">
          <dt>HRMS</dt><dd>Employee</dd>
        </div>
        <div className="home-role r-ats">
          <dt>ATS</dt><dd>Team Lead</dd>
        </div>
        <div className="home-role r-acc">
          <dt>Accounts</dt><dd className="is-none">No access</dd>
        </div>
      </dl>
      <div className="home-scope">
        <span className="home-scope-k">Data scope</span>
        <span className="home-scope-path">
          <span>Recruitment</span><i aria-hidden="true">›</i><span>IT hiring team</span>
        </span>
      </div>
      <figcaption id="home-profile-cap" className="home-fig-cap">
        Illustrative profile — roles and scope come from the employee record.
      </figcaption>
    </figure>
  );
}

function ChatMock() {
  return (
    <figure className="home-chat" aria-labelledby="home-chat-cap">
      <div className="home-chat-bar">
        <span className="home-chat-dot" aria-hidden="true" />
        <span>TeamLink assistant</span>
        <span className="home-chat-tag">Illustrative</span>
      </div>
      <div className="home-chat-body">
        <p className="home-bubble home-bubble-q">
          Which of my requirements have candidates waiting on client feedback for more than two days?
        </p>
        <div className="home-bubble home-bubble-a">
          <p>Two requirements in your team’s scope:</p>
          <ul>
            <li><b>Staff Nurse · Sample Hospital</b> — 2 profiles with the client, follow-up overdue</li>
            <li><b>Java Developer · Sample Tech</b> — 1 profile, interview feedback pending</li>
          </ul>
          <p className="home-bubble-src">From ATS · follow-ups and pipeline</p>
        </div>
      </div>
      <figcaption id="home-chat-cap" className="home-fig-cap">
        Example conversation with sample names — not real data.
      </figcaption>
    </figure>
  );
}

/* ------------------------------- page ------------------------------- */

export default function Home() {
  const { user } = useAuth() || {};
  const [solid, setSolid] = useState(false);
  const [contact, setContact] = useState(null);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const prev = document.title;
    document.title = 'TeamLink.Enterprise — HRMS, ATS and Accounts on one login';
    return () => { document.title = prev; };
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/public/company-contact')
      .then((res) => { if (live) setContact(res.data || null); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const year = new Date().getFullYear();

  return (
    <div className="home">
      <a className="home-skip" href="#home-main">Skip to content</a>

      <header className={`home-header${solid ? ' is-solid' : ''}`}>
        <div className="home-wrap home-header-row">
          <Link to="/home" className="home-brand" aria-label="TeamLink.Enterprise home">
            <TeamLinkMark width={150} />
          </Link>
          <nav className="home-nav" aria-label="Sections">
            <Anchor to="workflow">Workflow</Anchor>
            <Anchor to="products">Products</Anchor>
            <Anchor to="access">Access</Anchor>
            <Anchor to="assistant">AI assistant</Anchor>
            <Anchor to="contact">Contact</Anchor>
          </nav>
          <div className="home-actions">
            {user ? (
              <Link to={user.landingPath || '/'} className="home-btn home-btn-primary home-btn-sm">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="home-btn home-btn-ghost home-btn-sm">Log in</Link>
                <SignUpChooser />
              </>
            )}
          </div>
        </div>
      </header>

      <main id="home-main">
        {/* HERO */}
        <section className="home-hero" aria-labelledby="home-hero-title">
          <div className="home-wrap home-hero-grid">
            <div className="home-hero-copy">
              <p className="home-kicker">
                <span>TeamLink.Enterprise</span>
                <i aria-hidden="true" />
                <span>HRMS · ATS · Accounts</span>
              </p>
              <h1 id="home-hero-title">
                Run the whole consultancy on <span className="home-mark">one login</span>.
              </h1>
              <p className="home-lede">
                HRMS, ATS and Accounts in one platform. A client’s requirement travels from
                the first call to a paid invoice, and your own people are hired, paid and trained,
                without anyone switching systems.
              </p>
              <div className="home-cta">
                {user ? (
                  <Link to={user.landingPath || '/'} className="home-btn home-btn-primary">Open your dashboard</Link>
                ) : (
                  <Link to="/login" className="home-btn home-btn-primary">Log in</Link>
                )}
                <Anchor to="workflow" className="home-btn home-btn-outline">
                  Explore the platform <span aria-hidden="true">↓</span>
                </Anchor>
              </div>
              <p className="home-hero-note">
                Built by TeamLink Consultants for Medical, Education, IT and Manufacturing hiring.
              </p>
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* WORKFLOW */}
        <section id="workflow" className="home-section home-section-flow" aria-labelledby="home-flow-title">
          <div className="home-wrap">
            <header className="home-sec-head">
              <p className="home-eyebrow"><span>01</span> The workflow</p>
              <h2 id="home-flow-title">From requirement to paid invoice.</h2>
              <p>
                One record moves down the line. Nobody re-keys a candidate into a spreadsheet or a
                joining into an invoice — each step hands the next one what it needs.
              </p>
            </header>
            <Flow />
          </div>
        </section>

        {/* PRODUCTS */}
        <section id="products" className="home-section home-section-products" aria-labelledby="home-products-title">
          <div className="home-wrap">
            <header className="home-sec-head home-sec-head-dark">
              <p className="home-eyebrow"><span>02</span> Three products</p>
              <h2 id="home-products-title">Three products. One set of records.</h2>
              <p>
                They share the same people, clients and money — so a joining in the ATS is already
                an invoice in Accounts, and an internal hire is already an employee in HRMS.
              </p>
            </header>
            <div className="home-products">
              {PRODUCTS.map((p) => (
                <article key={p.key} className={`home-product home-product-${p.key}`} aria-labelledby={`home-p-${p.key}`}>
                  <div className="home-product-top">
                    <span className="home-product-code">{p.code}</span>
                    <span className="home-product-rule" aria-hidden="true" />
                  </div>
                  <h3 id={`home-p-${p.key}`}>{p.title}</h3>
                  <p className="home-product-lead">{p.lead}</p>
                  {p.pipeline && (
                    <div className="home-pipe" aria-label="Candidate pipeline stages">
                      <ol>
                        {PIPELINE.map((s) => <li key={s}>{s}</li>)}
                      </ol>
                    </div>
                  )}
                  <ul className="home-product-list">
                    {p.items.map((it) => <li key={it}>{it}</li>)}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ONE LOGIN */}
        <section id="access" className="home-section" aria-labelledby="home-one-title">
          <div className="home-wrap home-split">
            <div className="home-split-copy">
              <p className="home-eyebrow"><span>03</span> Access</p>
              <h2 id="home-one-title">One person, one login.</h2>
              <p className="home-body">
                A recruiter, a team lead or a BDE is still one employee — with one account and a role in
                each product. Nobody picks a role at sign-in; it follows from their department and designation.
              </p>
              <ul className="home-ticks">
                <li>A separate role in HRMS, ATS and Accounts — or no access at all</li>
                <li>Data scoped to the person’s department and team</li>
                <li>Change someone’s team on their record and their access follows</li>
              </ul>
            </div>
            <ProfileCard />
          </div>
        </section>

        {/* AI + INBOX */}
        <section id="assistant" className="home-section home-section-ai" aria-labelledby="home-ai-title">
          <div className="home-wrap home-split home-split-rev">
            <ChatMock />
            <div className="home-split-copy">
              <p className="home-eyebrow"><span>04</span> AI assistant</p>
              <h2 id="home-ai-title">Ask your data a question.</h2>
              <p className="home-body">
                The assistant answers in plain language from HRMS, ATS and Accounts — attendance, pipelines,
                follow-ups, invoices — and only from what the person asking is allowed to see.
              </p>
              <div className="home-inbox">
                <span className="home-inbox-icon" aria-hidden="true">
                  <Glyph><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></Glyph>
                </span>
                <p>
                  <strong>An omnichannel inbox</strong> sits alongside it, so conversations are handled
                  in the same place as the work they are about.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* SECURITY */}
        <section className="home-section home-section-sec" aria-labelledby="home-sec-title">
          <div className="home-wrap">
            <header className="home-sec-head">
              <p className="home-eyebrow"><span>05</span> Security &amp; access</p>
              <h2 id="home-sec-title">Access is decided by the server, not the menu.</h2>
            </header>
            <ul className="home-sec-grid">
              {SECURITY.map((s) => (
                <li key={s.t} className="home-sec-card">
                  <span className="home-sec-icon" aria-hidden="true"><Glyph>{s.icon}</Glyph></span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* CONTACT */}
        <section id="contact" className="home-section home-contact" aria-labelledby="home-contact-title">
          <div className="home-wrap home-contact-grid">
            <div>
              <p className="home-eyebrow home-eyebrow-dark"><span>06</span> I’m hiring</p>
              <h2 id="home-contact-title">Hiring? Talk to TeamLink Consultants.</h2>
              <p className="home-body">
                Recruitment and placement for Medical, Education, IT and Manufacturing — run end to end on
                this platform.
              </p>
              <ul className="home-sectors" aria-label="Sectors">
                <li>Medical</li><li>Education</li><li>IT</li><li>Manufacturing</li>
              </ul>
              <p className="home-contact-alt">
                Looking for a job instead? <Link to="/job-portal">Browse openings on the Job Portal →</Link>
              </p>
            </div>
            <address className="home-card-contact">
              <div className="home-cc-row">
                <span className="home-cc-k">Office</span>
                <span className="home-cc-v">{ADDRESS}</span>
              </div>
              {contact?.email && (
                <div className="home-cc-row">
                  <span className="home-cc-k">Email</span>
                  <a className="home-cc-v" href={`mailto:${contact.email}`}>{contact.email}</a>
                </div>
              )}
              {contact?.phone && (
                <div className="home-cc-row">
                  <span className="home-cc-k">Phone</span>
                  <a className="home-cc-v" href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a>
                </div>
              )}
              <div className="home-cc-row">
                <span className="home-cc-k">Website</span>
                <a className="home-cc-v" href={WEBSITE} target="_blank" rel="noopener noreferrer">
                  tmlink.in <span aria-hidden="true">↗</span>
                  <span className="home-sr">(opens in a new tab)</span>
                </a>
              </div>
            </address>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-wrap home-footer-row">
          <div className="home-footer-brand">
            <span className="home-footer-plate"><TeamLinkMark width={132} /></span>
            <span>TeamLink.Enterprise — HRMS · ATS · Accounts</span>
          </div>
          <nav className="home-footer-nav" aria-label="Footer">
            <Link to="/login">Log in</Link>
            <Link to="/job-portal">Job Portal</Link>
            <a href={WEBSITE} target="_blank" rel="noopener noreferrer">tmlink.in</a>
          </nav>
          <p className="home-footer-copy">© {year} TeamLink Consultants</p>
        </div>
      </footer>
    </div>
  );
}

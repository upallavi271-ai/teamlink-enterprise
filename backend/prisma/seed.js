const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('password123', 10);

  const departmentNames = ['IT', 'HR', 'R&D', 'QA', 'Manufacturing', 'Medical', 'Educational', 'BDE', 'Accounts'];
  const departmentsByName = {};
  for (const name of departmentNames) {
    departmentsByName[name] = await prisma.department.create({ data: { name } });
  }
  await prisma.team.createMany({
    data: [
      { name: 'Team-A', departmentId: departmentsByName['Educational'].id },
      { name: 'Team-B', departmentId: departmentsByName['Educational'].id },
      // The teams the scope tests exercise: a Medical TL sees Medical Team-A,
      // an IT recruiter sees Section A, and neither sees the other's work.
      { name: 'Medical Team-A', departmentId: departmentsByName['Medical'].id },
      { name: 'Medical Team-B', departmentId: departmentsByName['Medical'].id },
      { name: 'Section A', departmentId: departmentsByName['IT'].id },
      { name: 'Business Development', departmentId: departmentsByName['BDE'].id },
    ],
  });

  // Orbit's agreement is Active, so its requirements can be activated and
  // posted; Medivant's is still a Draft, so its requirement correctly cannot.
  // Client names, industries and locations follow the prototype's CLIENTS_SEED.
  const orbit = await prisma.client.create({
    data: {
      name: 'Orbit Software Solutions', legalName: 'Orbit Software Solutions Pvt. Ltd.',
      clientCode: 'CLI0001',
      industry: 'IT', location: 'Hyderabad', state: 'Telangana', country: 'India',
      houseNumber: 'Plot 42', street: 'Cyber Towers Road', area: 'HITEC City', pincode: '500081',
      billingContactName: 'Sudha Reddy', billingContactDesignation: 'Finance Manager',
      billingContactEmail: 'ap@orbit.com', billingContactPhone: '9100000011',
      recruitmentContactName: 'Ravi Teja', recruitmentContactDesignation: 'Head of Talent',
      recruitmentContactEmail: 'hr@orbit.com', recruitmentContactPhone: '9100000001',
      ownerDepartment: 'IT', clientType: 'Direct', priority: 'High', status: 'Active',
      businessType: 'Private Limited', website: 'https://orbitsoftware.example',
      contactName: 'Ravi Teja', contactDesignation: 'Head of Talent',
      contactEmail: 'hr@orbit.com', contactPhone: '9100000001',
      commPrimary: 'Email', commSecondary: 'Phone', commChannels: 'Email,WhatsApp',
      accountManager: 'Kiran Kumar', bdeOwner: 'Sanjay Mehta',
      gst: '36AAAAA1111A1Z5', pan: 'AAAAA1111A', tdsPercent: 10, gstPercent: 18,
      agreementFeePercent: 8.33, guaranteePeriod: '30 Days',
      paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice',
      invoiceTrigger: 'Candidate Joining', paymentDue: '6 days after invoice',
      riskFlag: 'None',
      agreementId: 'AGR0001', agreementStatus: 'ACTIVE',
      agreementRequired: 'Yes', agreementTemplate: 'Standard Recruitment / Staffing',
      agreementStart: '2026-08-01', agreementEnd: '2027-07-31',
      agreementDocument: 'TEAMLINK CONSULTANTS\nRECRUITMENT / STAFFING SERVICES AGREEMENT\nClient: Orbit Software Solutions (IT)\n\n(Seeded sample — use “Regenerate document” on the client page for the full text.)',
      esignToken: 'ESN-SEEDORBIT0001', agreementSentAt: new Date('2026-09-01'),
      agreementSignedAt: new Date('2026-09-03'), agreementSignedBy: 'Ravi Teja', agreementSignedByTitle: 'Head of Talent',
      agreementActivatedAt: new Date('2026-09-03'),
    },
  });
  const medivant = await prisma.client.create({
    data: {
      name: 'Medivant Healthcare', legalName: 'Medivant Healthcare Pvt. Ltd.',
      clientCode: 'CLI0002',
      industry: 'Healthcare', location: 'Bengaluru', state: 'Karnataka', country: 'India',
      houseNumber: '7th Floor', street: 'Residency Road', area: 'Ashok Nagar', pincode: '560025',
      businessType: 'Private Limited',
      agreementStart: '2026-09-15', agreementEnd: '2027-09-14',
      billingContactName: 'Rahul Menon', billingContactDesignation: 'Accounts Lead',
      billingContactEmail: 'accounts@medivant.com', billingContactPhone: '9100000012',
      recruitmentContactName: 'Anita Desai', recruitmentContactDesignation: 'HR Manager',
      recruitmentContactEmail: 'hr@medivant.com', recruitmentContactPhone: '9100000002',
      ownerDepartment: 'Medical', clientType: 'Direct', priority: 'Medium', status: 'Active',
      contactName: 'Anita Desai', contactDesignation: 'HR Manager',
      contactEmail: 'hr@medivant.com', contactPhone: '9100000002',
      accountManager: 'Meera Iyer', bdeOwner: 'Pooja Bhatt',
      gst: '36AAAAA1112A1Z5', tdsPercent: 10, gstPercent: 18,
      agreementFeePercent: 10, guaranteePeriod: '30 Days',
      agreementStatus: 'DRAFT', riskFlag: 'Watch',
      riskNotes: 'New account — first invoice not yet settled.',
    },
  });

  // -------------------------------------------------------------------------
  // Designation -> ATS role mapping. THE mapping, as data: change a row here
  // and every employee with that designation follows, in every department.
  // There is no "Medical TL" role anywhere — only department=Medical plus
  // designation=TL, which the engine resolves to atsRole=TL, scope=Medical.
  // -------------------------------------------------------------------------
  const DESIGNATION_ROLES = [
    { designation: 'Super Admin', atsRole: 'SUPER_ADMIN', hrms: true, ats: true, accounts: true, landing: 'ats', position: 0 },
    { designation: 'Admin', atsRole: 'ADMIN', hrms: true, ats: true, accounts: true, landing: 'ats', position: 1 },
    { designation: 'Manager', atsRole: 'MANAGER', hrms: true, ats: true, accounts: true, landing: 'ats', position: 2 },
    { designation: 'Assistant Manager', atsRole: 'ASSISTANT_MANAGER', hrms: true, ats: true, accounts: false, landing: 'ats', position: 3 },
    { designation: 'STL', atsRole: 'STL', hrms: true, ats: true, accounts: false, landing: 'ats', position: 4 },
    { designation: 'Senior Team Lead', atsRole: 'STL', hrms: true, ats: true, accounts: false, landing: 'ats', position: 5 },
    { designation: 'TL', atsRole: 'TL', hrms: true, ats: true, accounts: false, landing: 'ats', position: 6 },
    { designation: 'Team Lead', atsRole: 'TL', hrms: true, ats: true, accounts: false, landing: 'ats', position: 7 },
    { designation: 'Recruiter', atsRole: 'RECRUITER', hrms: true, ats: true, accounts: false, landing: 'ats', position: 8 },
    { designation: 'Senior Recruiter', atsRole: 'RECRUITER', hrms: true, ats: true, accounts: false, landing: 'ats', position: 9 },
    { designation: 'BDE', atsRole: 'BDE', hrms: true, ats: true, accounts: false, landing: 'ats', position: 10 },
    { designation: 'Accountant', atsRole: null, hrms: true, ats: false, accounts: true, landing: 'accounts', position: 11 },
    // THE HR DESK (§6) — HRMS ONLY, every employee visible, no ATS and no
    // Accounts. It names its HRMS role explicitly because there is no ATS role
    // to derive one from; without it the designation would imply EMPLOYEE.
    { designation: 'HR', hrmsRole: 'HR', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 12 },
    { designation: 'HR Executive', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 13 },
    { designation: 'Junior Developer', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 14 },
    { designation: 'Employee', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 15 },
  ];
  // DERIVATION STAYS IN THE TABLE, and the table carries ALL THREE product
  // roles now. The rows above name only the ATS role because that is the one
  // that varies; the HRMS and Accounts roles are derived by the same rule the
  // engine and the prodrole migration use, so the three sources cannot drift.
  //   designation -> { hrmsRole, atsRole, accountsRole }
  // There is no compound role: "Medical Recruiter" is department=Medical +
  // atsRole=RECRUITER, and no role name anywhere carries a department.
  const NO_ROLE = 'NONE';
  const impliedRoleOf = (r) => (r.atsRole
    || (r.accounts && !r.ats ? 'ACCOUNTANT' : 'EMPLOYEE'));
  // A row that NAMES a product role keeps it — that is how 'HR' gets an HRMS
  // role there is no ATS role to derive. Everything else derives as before.
  const namedRole = (v) => (v && v !== NO_ROLE ? v : null);
  const withProductRoles = (r) => ({
    ...r,
    hrmsRole: r.hrms ? (namedRole(r.hrmsRole) || impliedRoleOf(r)) : NO_ROLE,
    accountsRole: r.accounts ? (namedRole(r.accountsRole) || impliedRoleOf(r)) : NO_ROLE,
  });
  // upsert, not create: migration hrrole_hr_role inserts the 'HR' mapping row
  // so that an already-migrated database picks the role up without a re-seed,
  // and `migrate reset && seed` must not then collide on it.
  for (const row of DESIGNATION_ROLES) {
    const data = withProductRoles(row);
    await prisma.designationRole.upsert({
      where: { designation: data.designation }, create: data, update: data,
    });
  }

  // -------------------------------------------------------------------------
  // Demo logins. ONE EMPLOYEE = ONE USER = ONE LOGIN. Nobody here has a second
  // "ATS" account: the same person works in ATS because their designation maps
  // to an ATS role and their department supplies the scope.
  //
  // The demo password for every one of them is DEMO_PASSWORD below. It is
  // documented in the README and printed at the end of this script — it is
  // never shown anywhere in the UI.
  // -------------------------------------------------------------------------
  const admin = await prisma.user.create({
    data: {
      name: 'Vasu (Admin)', email: 'admin@teamlink.test', passwordHash: password, role: 'SUPER_ADMIN',
      username: 'admin@teamlink.test', branch: 'Hyderabad', team: 'Leadership',
      hrmsAccess: true, atsAccess: true, accountsAccess: true, atsRole: 'SUPER_ADMIN', landingWorkspace: 'ats',
    },
  });
  // Kiran Kumar — Department: Medical, HRMS Designation: Recruiter.
  //   HRMS: employee self-service.  ATS: Recruiter, scoped to Medical.
  const recruiterMedical = await prisma.user.create({
    data: {
      name: 'Kiran Kumar', email: 'kiran@teamlink.test', passwordHash: password, role: 'RECRUITER',
      atsDepartment: 'Medical', username: 'kiran.kumar', branch: 'Hyderabad', team: 'Medical Team-A',
      hrmsAccess: true, atsAccess: true, accountsAccess: false, atsRole: 'RECRUITER',
      atsScopeDepartments: 'Medical', atsScopeTeams: 'Medical Team-A',
    },
  });
  // The IT Recruiter — same role, different department, no separate record type.
  const recruiter = await prisma.user.create({
    data: {
      name: 'Arun Nair', email: 'recruiter@teamlink.test', passwordHash: password, role: 'RECRUITER',
      atsDepartment: 'IT', username: 'arun.nair', branch: 'Hyderabad', team: 'Section A',
      hrmsAccess: true, atsAccess: true, accountsAccess: false, atsRole: 'RECRUITER',
      atsScopeDepartments: 'IT', atsScopeTeams: 'Section A',
    },
  });
  const bde = await prisma.user.create({
    data: {
      name: 'Sanjay Mehta', email: 'bde@teamlink.test', passwordHash: password, role: 'BDE',
      atsDepartment: 'BDE', username: 'sanjay.mehta', branch: 'Bengaluru', team: 'Business Development',
      hrmsAccess: true, atsAccess: true, accountsAccess: false, atsRole: 'BDE',
      atsScopeClients: `${orbit.id},${medivant.id}`,
    },
  });
  // Divya Rao — Department: Medical, HRMS Designation: TL.
  //   HRMS: employee self-service.  ATS: TL, scoped to Medical.
  const tlMedical = await prisma.user.create({
    data: {
      name: 'Divya Rao', email: 'divya@teamlink.test', passwordHash: password, role: 'TL',
      atsDepartment: 'Medical', username: 'divya.rao', branch: 'Hyderabad', team: 'Medical Team-A',
      hrmsAccess: true, atsAccess: true, accountsAccess: false, atsRole: 'TL',
      atsScopeDepartments: 'Medical', atsScopeTeams: 'Medical Team-A',
    },
  });
  // The IT TL — keeps the original tl@teamlink.test login working.
  const tl = await prisma.user.create({
    data: {
      name: 'Rekha Nair', email: 'tl@teamlink.test', passwordHash: password, role: 'TL',
      atsDepartment: 'IT', username: 'rekha.nair', branch: 'Hyderabad', team: 'Section A',
      hrmsAccess: true, atsAccess: true, accountsAccess: false, atsRole: 'TL',
      atsScopeDepartments: 'IT', atsScopeTeams: 'Section A',
    },
  });
  // Multi-product employee: one login, three products, a workspace switcher —
  // and never a second account or a role prompt.
  const multiProduct = await prisma.user.create({
    data: {
      name: 'Priya Nambiar', email: 'multi@teamlink.test', passwordHash: password, role: 'MANAGER',
      atsDepartment: 'Medical', username: 'priya.nambiar', branch: 'Hyderabad', team: 'Medical Team-A',
      hrmsAccess: true, atsAccess: true, accountsAccess: true, atsRole: 'MANAGER',
      // A Manager's scope is CONFIGURED, not automatically global: these two
      // departments only, which is what utils/scope.js then enforces.
      atsScopeDepartments: 'Medical,IT',
    },
  });
  // Client A and Client B — external logins with no employee record.
  await prisma.user.create({
    data: {
      name: 'Orbit Software Solutions (Client)', email: 'client@teamlink.test', passwordHash: password,
      role: 'CLIENT', clientId: orbit.id, username: 'orbit.client', branch: 'Hyderabad',
      hrmsAccess: false, atsAccess: true, accountsAccess: true, atsRole: 'CLIENT',
    },
  });
  await prisma.user.create({
    data: {
      name: 'Medivant Healthcare (Client)', email: 'clientb@teamlink.test', passwordHash: password,
      role: 'CLIENT', clientId: medivant.id, username: 'medivant.client', branch: 'Bengaluru',
      hrmsAccess: false, atsAccess: true, accountsAccess: true, atsRole: 'CLIENT',
    },
  });
  const accountant = await prisma.user.create({
    data: {
      name: 'Lakshmi Narayan', email: 'accounts@teamlink.test', passwordHash: password, role: 'ACCOUNTANT',
      username: 'lakshmi.narayan', branch: 'Hyderabad', team: 'Accounts',
      hrmsAccess: true, atsAccess: false, accountsAccess: true, landingWorkspace: 'accounts',
    },
  });
  // A second accountant, so the original accountant@teamlink.test login keeps
  // working without giving one person two accounts.
  const accountant2 = await prisma.user.create({
    data: {
      name: 'Vikram Shetty', email: 'accountant@teamlink.test', passwordHash: password, role: 'ACCOUNTANT',
      username: 'vikram.shetty', branch: 'Bengaluru', team: 'Accounts',
      hrmsAccess: true, atsAccess: false, accountsAccess: true, landingWorkspace: 'accounts',
    },
  });
  // HRMS-only employee — no ATS, no Accounts.
  const employeeUser = await prisma.user.create({
    data: {
      name: 'Meera Iyer', email: 'employee@teamlink.test', passwordHash: password, role: 'EMPLOYEE',
      username: 'meera.iyer', branch: 'Hyderabad', team: 'HR',
      hrmsAccess: true, atsAccess: false, accountsAccess: false, landingWorkspace: 'hrms',
    },
  });

  // Requirement titles, skills, experience bands, locations, work modes and
  // salary bands follow the prototype's reqDefs demo set.
  const req1 = await prisma.requirement.create({
    data: {
      title: 'Java Developer',
      description: 'Build and own core Java services for the Orbit platform team.',
      jobDescription: 'Build and own core Java services for the Orbit platform team, working across Spring Boot microservices and the SQL data layer.',
      responsibilities: 'Design and ship Spring Boot microservices\nOwn service reliability and on-call for your area\nReview peers’ code and raise the team’s engineering bar',
      qualifications: 'Bachelor’s degree in Computer Science or equivalent practical experience.',
      reqCode: 'REQ-0001',
      clientId: orbit.id, department: 'IT', priority: 'High', recruiterId: recruiter.id, bdeId: bde.id,
      // The assignment chain: Requirement -> TL -> Recruiter(s) -> BDE -> Client.
      tlId: tl.id, stlId: multiProduct.id, accountManager: 'Kiran Kumar',
      targetDate: '2026-11-15', portalSyncStatus: 'Synced',
      skills: 'Java, Spring Boot, Microservices, SQL', goodToHaveSkills: 'AWS, Docker',
      experience: '4-7 yrs', relevantExperience: '4 yrs', openings: 2,
      education: 'B.Tech', employmentType: 'Full Time', workMode: 'Hybrid',
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      joiningTimeline: 'Within 15 Days', noticePeriodMax: '30 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹14L - ₹20L',
      closingDate: '2026-10-31', tl: 'Rekha Nair', stl: 'Priya Nambiar',
    },
  });
  const req2 = await prisma.requirement.create({
    data: {
      title: 'Clinical Research Associate',
      description: 'Run clinical trial sites end to end for a 200-bed multi-specialty group.',
      jobDescription: 'Run clinical trial sites end to end, owning protocol compliance, monitoring visits and regulatory submissions.',
      clientId: medivant.id, department: 'Medical', priority: 'Medium',
      // Medical work: Kiran (Medical Recruiter) owns it, Divya (Medical TL)
      // oversees it. An IT recruiter must never see this requirement.
      reqCode: 'REQ-0002',
      recruiterId: recruiterMedical.id, bdeId: bde.id, tl: 'Divya Rao', stl: 'Priya Nambiar',
      tlId: tlMedical.id, stlId: multiProduct.id, accountManager: 'Meera Iyer',
      targetDate: '2026-11-30',
      skills: 'Clinical Trials, GCP, Regulatory Affairs', goodToHaveSkills: 'Data Analysis',
      experience: '3-6 yrs', relevantExperience: '3 yrs',
      education: 'B.Sc', employmentType: 'Full Time', workMode: 'Work From Office',
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      joiningTimeline: 'Within 30 Days', noticePeriodMax: '30 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹10L - ₹15L',
    },
  });
  // Raised but not yet activated — Medivant's agreement is still a Draft, so
  // "Activate requirement" on this one is correctly refused.
  await prisma.requirement.create({
    data: {
      title: 'Data Analyst',
      jobDescription: 'Own reporting and analysis across the Medivant clinical operations group.',
      reqCode: 'REQ-0003',
      clientId: medivant.id, department: 'Medical', priority: 'Low', status: 'AGREEMENT_CHECK',
      recruiterId: recruiterMedical.id, tl: 'Divya Rao', tlId: tlMedical.id,
      accountManager: 'Meera Iyer', targetDate: '2026-12-15',
      skills: 'SQL, Excel, Data Analysis, Python', goodToHaveSkills: 'Machine Learning',
      experience: '2-4 yrs', relevantExperience: '2 yrs',
      education: 'Any Degree', employmentType: 'Full Time', workMode: 'Work From Office',
      location: 'Pune', preferredLocation: 'Pune',
      joiningTimeline: 'Within 30 Days', noticePeriodMax: '30 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹8L - ₹12L',
    },
  });
  // REQ-0004 — the worked example of the assignment chain:
  //   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
  //   REQ-0004 Java Developer, Client Orbit
  //     TL: Divya Rao · Recruiter: Kiran Kumar · BDE: Sanjay Mehta
  //
  // Note that Kiran and Divya sit in the MEDICAL department while this is an
  // IT requirement for Orbit. That is deliberate: it is the ASSIGNMENT, not
  // the department, that puts this requirement in Kiran's scope, which is
  // exactly what utils/scope.js now enforces.
  await prisma.requirement.create({
    data: {
      title: 'Java Developer',
      reqCode: 'REQ-0004',
      description: 'Second Java squad for Orbit — assigned across departments.',
      jobDescription: 'Join Orbit’s second Java squad building payment and settlement services on Spring Boot.',
      responsibilities: 'Ship and own Spring Boot services\nPartner with the payments domain team',
      qualifications: 'Bachelor’s degree in Computer Science or equivalent practical experience.',
      clientId: orbit.id, department: 'IT', priority: 'High', status: 'RECRUITER_ASSIGNED',
      tlId: tlMedical.id, tl: 'Divya Rao',
      recruiterId: recruiterMedical.id,
      recruiterIds: recruiter.id, // Arun Nair joins as a co-recruiter
      bdeId: bde.id, stlId: multiProduct.id, stl: 'Priya Nambiar',
      accountManager: 'Kiran Kumar',
      skills: 'Java, Spring Boot, Kafka, SQL', goodToHaveSkills: 'AWS, Kubernetes',
      experience: '5-8 yrs', relevantExperience: '5 yrs', openings: 3,
      education: 'B.Tech', employmentType: 'Full Time', workMode: 'Hybrid',
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      joiningTimeline: 'Within 30 Days', noticePeriodMax: '60 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹18L - ₹26L',
      closingDate: '2026-12-31', targetDate: '2026-12-01', portalSyncStatus: 'Pending',
      postingSources: 'Job Portal, Naukri',
    },
  });

  // An internal TeamLink opening — no client, so it needs no agreement.
  await prisma.requirement.create({
    data: {
      title: 'Talent Acquisition Executive',
      reqCode: 'REQ-0005',
      jobDescription: 'Internal TeamLink hiring — own end-to-end recruitment for our own delivery teams.',
      clientId: orbit.id, internal: true, department: 'HR', priority: 'Medium',
      recruiterId: recruiter.id,
      skills: 'Recruitment, Client Servicing', experience: '2-4 yrs', relevantExperience: '2 yrs',
      education: 'Any Degree', employmentType: 'Full Time', workMode: 'Work From Office',
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      joiningTimeline: 'Within 15 Days', noticePeriodMax: '30 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹6L - ₹9L',
    },
  });

  // Candidates carry the full profile the matching formula actually scores on.
  const cand1 = await prisma.candidate.create({
    data: {
      name: 'Arjun Mehta', email: 'arjun@example.com', phone: '9000000001',
      source: 'Naukri', firstSource: 'Naukri', sourceCampaign: 'Sep-2026 Java drive',
      skills: 'Java, Spring Boot, Microservices, SQL', goodToHaveSkills: 'Docker',
      technicalSkills: 'Git, Jenkins', softSkills: 'Communication, Stakeholder management',
      experienceYears: 6, relevantExperienceYears: 5,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Infotech Systems', currentDesignation: 'Senior Software Engineer',
      currentSalary: '14L', expectedSalary: '18L',
      noticePeriod: '15 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
      education: 'B.Tech', specialization: 'Computer Science', institute: 'JNTU Hyderabad', passingYear: '2018',
      resumeName: 'Arjun_Mehta_Java.pdf', resumeScore: 88, profileStatus: 'Active',
    },
  });
  const cand2 = await prisma.candidate.create({
    data: {
      name: 'Priya Sharma', email: 'priya@example.com', phone: '9000000002',
      source: 'LinkedIn', firstSource: 'Naukri',
      skills: 'Java, Spring Boot, SQL', goodToHaveSkills: 'AWS, Docker',
      experienceYears: 7, relevantExperienceYears: 6,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Zenith Labs', currentDesignation: 'Lead Engineer',
      currentSalary: '17L', expectedSalary: '20L',
      noticePeriod: '30 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
      education: 'B.Tech', specialization: 'Information Technology', institute: 'Osmania University', passingYear: '2017',
      resumeName: 'Priya_Sharma.pdf', resumeScore: 84, profileStatus: 'Active',
    },
  });
  const cand3 = await prisma.candidate.create({
    data: {
      name: 'Rahul Verma', email: 'rahul@example.com', phone: '9000000003',
      source: 'TeamLink Website', firstSource: 'TeamLink Website',
      skills: 'Clinical Trials, GCP, Regulatory Affairs',
      experienceYears: 4, relevantExperienceYears: 3,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Vireo Clinical', currentDesignation: 'Clinical Research Associate',
      currentSalary: '9L', expectedSalary: '12L',
      noticePeriod: '30 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Work From Office',
      education: 'B.Sc', specialization: 'Life Sciences', institute: 'Andhra University', passingYear: '2020',
      resumeName: 'Rahul_Verma.pdf', resumeScore: 79, profileStatus: 'Active',
    },
  });
  // Not linked to anything yet — shows up under the Java Developer
  // requirement's matching candidates.
  await prisma.candidate.create({
    data: {
      name: 'Sneha Kulkarni', email: 'sneha@example.com', phone: '9000000004',
      source: 'Naukri', firstSource: 'Referral',
      skills: 'Java, Spring Boot, Microservices, SQL', goodToHaveSkills: 'AWS',
      experienceYears: 5, relevantExperienceYears: 4,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Nimbus Tech', currentDesignation: 'Software Engineer',
      currentSalary: '12L', expectedSalary: '16L',
      noticePeriod: 'Immediate', availability: 'Available immediately',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
      education: 'B.Tech', specialization: 'Computer Science', institute: 'VNR VJIET', passingYear: '2019',
      resumeName: 'Sneha_Kulkarni.pdf', resumeScore: 86, profileStatus: 'Active',
    },
  });

  // A candidate login: external, no employee record, and scoped to exactly one
  // candidate row — their own profile, applications, interviews and documents.
  await prisma.user.create({
    data: {
      name: 'Arjun Mehta', email: 'candidate@teamlink.test', passwordHash: password, role: 'CANDIDATE',
      username: 'arjun.mehta', candidateId: cand1.id,
      hrmsAccess: false, atsAccess: true, accountsAccess: false, atsRole: 'CANDIDATE',
    },
  });

  await prisma.application.create({
    data: {
      candidateId: cand1.id, requirementId: req1.id, stage: 'RECRUITER_REVIEW',
      matchScore: 97, resumeScore: 88, source: 'Naukri', firstSource: 'Naukri',
      applicationMethod: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 82,
    },
  });
  await prisma.application.create({
    data: {
      candidateId: cand2.id, requirementId: req1.id, stage: 'WITH_BDE',
      matchScore: 90, resumeScore: 84, source: 'LinkedIn', firstSource: 'Naukri',
      applicationMethod: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 76,
    },
  });
  await prisma.application.create({
    data: {
      candidateId: cand3.id, requirementId: req2.id, stage: 'AI_INTERVIEW_SCHEDULED',
      matchScore: 88, resumeScore: 79, source: 'TeamLink Website', firstSource: 'TeamLink Website',
      applicationMethod: 'Manual', aiInterviewStatus: 'Scheduled',
      // Deliberately in the past, so the AI Interview tab demonstrates the
      // Expired row — which never rejects the candidate, only offers Extend /
      // Resend / Manual Review.
      aiInterviewDeadline: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10),
    },
  });

  // ---- Interview Calendar ---------------------------------------------------
  // One interview at each interesting point of the chain, so the calendar shows
  // the real status vocabulary rather than an empty table. Each gets its own
  // candidate, so Sneha Kulkarni stays unassigned for the matching-candidates demo.
  const inDays = (n, hour) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hour, 0, 0, 0); return d; };

  const candIv1 = await prisma.candidate.create({
    data: {
      name: 'Vikram Nair', email: 'vikram@example.com', phone: '9000000005',
      source: 'Naukri', firstSource: 'Referral',
      skills: 'Java, Spring Boot, Microservices, SQL', goodToHaveSkills: 'AWS, Kafka',
      experienceYears: 6, relevantExperienceYears: 6,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Helios Systems', currentDesignation: 'Senior Engineer',
      currentSalary: '15L', expectedSalary: '19L',
      noticePeriod: '30 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
      education: 'B.Tech', specialization: 'Computer Science', institute: 'NIT Warangal', passingYear: '2018',
      resumeName: 'Vikram_Nair.pdf', resumeScore: 86, profileStatus: 'Active',
    },
  });
  const candIv2 = await prisma.candidate.create({
    data: {
      name: 'Ananya Das', email: 'ananya@example.com', phone: '9000000006',
      source: 'LinkedIn', firstSource: 'LinkedIn',
      skills: 'Clinical Trials, GCP, Regulatory Affairs',
      experienceYears: 5, relevantExperienceYears: 4,
      location: 'Hyderabad', preferredLocation: 'Hyderabad',
      currentCompany: 'Medira Life Sciences', currentDesignation: 'Senior CRA',
      currentSalary: '11L', expectedSalary: '14L',
      noticePeriod: '30 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Work From Office',
      education: 'M.Sc', specialization: 'Pharmacology', institute: 'Osmania University', passingYear: '2019',
      resumeName: 'Ananya_Das.pdf', resumeScore: 88, profileStatus: 'Active',
    },
  });
  const candIv3 = await prisma.candidate.create({
    data: {
      name: 'Rohit Desai', email: 'rohit@example.com', phone: '9000000007',
      source: 'Referral', firstSource: 'Referral',
      skills: 'Java, Spring Boot, SQL', goodToHaveSkills: 'Docker',
      experienceYears: 5, relevantExperienceYears: 4,
      location: 'Bengaluru', preferredLocation: 'Hyderabad',
      currentCompany: 'Cobalt Software', currentDesignation: 'Software Engineer',
      currentSalary: '13L', expectedSalary: '17L',
      noticePeriod: '60 Days', availability: 'Available after notice period',
      jobPreference: 'Permanent', preferredEmploymentType: 'Full Time', preferredWorkMode: 'Hybrid',
      education: 'B.E', specialization: 'Computer Science', institute: 'RV College', passingYear: '2019',
      resumeName: 'Rohit_Desai.pdf', resumeScore: 81, profileStatus: 'Active',
    },
  });

  const ivConfirmed = await prisma.application.create({
    data: {
      candidateId: candIv1.id, requirementId: req1.id, stage: 'INTERVIEW_SCHEDULED',
      matchScore: 92, resumeScore: 86, source: 'Naukri', firstSource: 'Referral',
      applicationMethod: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 88,
      aiInterviewFeedback: 'Strong on Java and Spring Boot; brief on system design.',
      interviewStatus: 'CONFIRMED', interviewAt: inDays(3, 11),
      interviewCode: 'INT-000101', interviewRound: 1, interviewType: 'Client Interview',
      interviewer: 'Arun Prasad (Orbit)', interviewMode: 'Online',
      interviewMeetingLink: 'https://meet.example.com/orbit-java-r1',
      interviewCreatedBy: 'Kiran Kumar',
    },
  });
  await prisma.interviewEvent.createMany({
    data: [
      { applicationId: ivConfirmed.id, status: 'SCHEDULED', by: 'Kiran Kumar' },
      { applicationId: ivConfirmed.id, status: 'CONFIRMED', by: 'Kiran Kumar' },
    ],
  });

  const ivPending = await prisma.application.create({
    data: {
      candidateId: candIv2.id, requirementId: req2.id, stage: 'INTERVIEW_COMPLETED',
      matchScore: 91, resumeScore: 88, source: 'LinkedIn', firstSource: 'LinkedIn',
      applicationMethod: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 82,
      interviewStatus: 'PENDING_FEEDBACK', interviewAt: inDays(-1, 15),
      interviewCode: 'INT-000102', interviewRound: 2, interviewType: 'Internal Panel',
      interviewer: 'Divya Rao', interviewMode: 'In Person', interviewLocation: 'Hyderabad — Floor 4',
      interviewCreatedBy: 'Divya Rao',
      interviewStartedAt: inDays(-1, 15), interviewCompletedAt: inDays(-1, 16),
    },
  });
  await prisma.interviewEvent.createMany({
    data: [
      { applicationId: ivPending.id, status: 'SCHEDULED', by: 'Divya Rao' },
      { applicationId: ivPending.id, status: 'CONFIRMED', by: 'Divya Rao' },
      { applicationId: ivPending.id, status: 'STARTED', by: 'Divya Rao' },
      { applicationId: ivPending.id, status: 'COMPLETED', by: 'Divya Rao' },
      { applicationId: ivPending.id, status: 'PENDING_FEEDBACK', by: 'System' },
    ],
  });

  const ivRescheduled = await prisma.application.create({
    data: {
      candidateId: candIv3.id, requirementId: req1.id, stage: 'INTERVIEW_SCHEDULED',
      matchScore: 84, resumeScore: 81, source: 'Referral', firstSource: 'Referral',
      applicationMethod: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 70,
      interviewStatus: 'RESCHEDULED', interviewAt: inDays(6, 10),
      interviewCode: 'INT-000103', interviewRound: 1, interviewType: 'Client Interview',
      interviewer: 'Arun Prasad (Orbit)', interviewMode: 'Online',
      interviewMeetingLink: 'https://meet.example.com/orbit-java-r1b',
      interviewCreatedBy: 'Kiran Kumar', interviewRescheduleCount: 1,
    },
  });
  await prisma.interviewEvent.createMany({
    data: [
      { applicationId: ivRescheduled.id, status: 'SCHEDULED', by: 'Kiran Kumar' },
      {
        applicationId: ivRescheduled.id, status: 'RESCHEDULED', by: 'Kiran Kumar',
        reason: 'Client panel unavailable', fromSlot: inDays(1, 10).toISOString(), toSlot: inDays(6, 10).toISOString(),
      },
    ],
  });

  // HRMS
  const ONBOARDING = ['Offer letter signed', 'ID proof collected', 'PAN card collected', 'Laptop/asset assigned', 'Reporting manager introduction', 'System access provisioned'];
  const tasks = (doneCount) => JSON.stringify(ONBOARDING.map((task, i) => ({ task, completed: i < doneCount })));

  const empMeera = await prisma.employee.create({
    data: {
      userId: employeeUser.id, employeeCode: 'EMP-001', name: 'Meera Iyer', email: 'employee@teamlink.test',
      department: 'HR', designation: 'HR Executive', location: 'Hyderabad', dateOfJoining: new Date('2024-03-01'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Female', dateOfBirth: new Date('1996-04-12'),
      emergencyContactName: 'Suresh Iyer', emergencyContactPhone: '9812345670', address: 'Banjara Hills, Hyderabad',
      onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  // Kiran Kumar — Medical / Recruiter. The SAME record drives HRMS
  // self-service and the ATS Recruiter workspace, scoped to Medical.
  const empKiran = await prisma.employee.create({
    data: {
      userId: recruiterMedical.id, employeeCode: 'EMP-002', name: 'Kiran Kumar', email: 'kiran@teamlink.test',
      department: 'Medical', team: 'Medical Team-A', designation: 'Recruiter',
      location: 'Hyderabad', dateOfJoining: new Date('2023-07-15'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Male', dateOfBirth: new Date('1994-11-02'),
      onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  // Divya Rao — Medical / TL. Same department, one rung up: ATS TL, Medical.
  const empDivya = await prisma.employee.create({
    data: {
      userId: tlMedical.id, employeeCode: 'EMP-003', name: 'Divya Rao', email: 'divya@teamlink.test',
      department: 'Medical', team: 'Medical Team-A', designation: 'TL',
      location: 'Bengaluru', dateOfJoining: new Date('2022-01-10'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Female', dateOfBirth: new Date('1990-06-20'),
      onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  // The IT Recruiter and IT TL — identical designations, different department,
  // so identical ATS roles with a different scope. No new record type.
  const empArun = await prisma.employee.create({
    data: {
      userId: recruiter.id, employeeCode: 'EMP-005', name: 'Arun Nair', email: 'recruiter@teamlink.test',
      department: 'IT', team: 'Section A', designation: 'Recruiter',
      location: 'Hyderabad', dateOfJoining: new Date('2023-02-01'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Male', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  const empRekha = await prisma.employee.create({
    data: {
      userId: tl.id, employeeCode: 'EMP-006', name: 'Rekha Nair', email: 'tl@teamlink.test',
      department: 'IT', team: 'Section A', designation: 'TL',
      location: 'Hyderabad', dateOfJoining: new Date('2021-05-04'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Female', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  const empSanjay = await prisma.employee.create({
    data: {
      userId: bde.id, employeeCode: 'EMP-007', name: 'Sanjay Mehta', email: 'bde@teamlink.test',
      department: 'BDE', team: 'Business Development', designation: 'BDE',
      location: 'Bengaluru', dateOfJoining: new Date('2022-09-12'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Male', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  const empPriya = await prisma.employee.create({
    data: {
      userId: multiProduct.id, employeeCode: 'EMP-008', name: 'Priya Nambiar', email: 'multi@teamlink.test',
      department: 'Medical', team: 'Medical Team-A', designation: 'Manager',
      location: 'Hyderabad', dateOfJoining: new Date('2020-11-02'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Female', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  const empLakshmi = await prisma.employee.create({
    data: {
      userId: accountant.id, employeeCode: 'EMP-009', name: 'Lakshmi Narayan', email: 'accounts@teamlink.test',
      department: 'Accounts', team: 'Accounts', designation: 'Accountant',
      location: 'Hyderabad', dateOfJoining: new Date('2021-08-16'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Female', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  await prisma.employee.create({
    data: {
      userId: accountant2.id, employeeCode: 'EMP-010', name: 'Vikram Shetty', email: 'accountant@teamlink.test',
      department: 'Accounts', team: 'Accounts', designation: 'Accountant',
      location: 'Bengaluru', dateOfJoining: new Date('2023-04-03'), employmentStatus: 'Active',
      employeeType: 'Full-time', gender: 'Male', onboardingTasks: tasks(6), profileStage: 'Locked', isLocked: true,
    },
  });
  const newJoinerUser = await prisma.user.create({
    data: {
      name: 'Rahul Verma', email: 'rahul.verma@teamlink.test', passwordHash: password, role: 'EMPLOYEE',
      hrmsAccess: true, atsAccess: false, accountsAccess: false, landingWorkspace: 'hrms',
    },
  });
  const empNewJoiner = await prisma.employee.create({
    data: {
      userId: newJoinerUser.id, employeeCode: 'EMP-004', name: 'Rahul Verma', email: 'rahul.verma@teamlink.test',
      department: 'IT', designation: 'Junior Developer', dateOfJoining: new Date(), employmentStatus: 'On Probation',
      reportingManagerId: empDivya.id, onboardingTasks: tasks(3),
      // Bare login only — profile deliberately unfilled to demo the employee fill-in → HR review → lock flow.
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  await prisma.attendance.create({ data: { employeeId: empMeera.id, date: today, status: 'Present', checkIn: '09:12', checkOut: '18:05' } });
  await prisma.attendance.create({ data: { employeeId: empKiran.id, date: today, status: 'Late', checkIn: '10:20' } });
  await prisma.attendance.create({ data: { employeeId: empDivya.id, date: today, status: 'Present', checkIn: '09:00', checkOut: '18:30' } });

  // Device punches for the last 10 working days, so the Biometric list, the Punch
  // Log and the monthly report have something real to derive from. Every third day
  // the check-in is after the 09:30 grace time, which is what makes it Late — and
  // what turns into half-day cuts once the two free lates a month are used up.
  const CHECKIN_METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)'];
  const LOCATIONS = ['Hyderabad HQ', 'Bengaluru Office', 'Remote'];
  const punchEmployees = [empMeera, empKiran, empDivya];
  const punchRows = [];
  const attendanceRows = [];
  let dayOffset = 1;
  let workdays = 0;
  while (workdays < 10) {
    const d = new Date(Date.now() - dayOffset * 86400000);
    dayOffset += 1;
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    workdays += 1;
    const iso = d.toISOString().slice(0, 10);
    punchEmployees.forEach((emp, i) => {
      const seq = workdays + i;
      const status = seq % 7 === 0 ? 'Leave' : 'Present';
      const inTime = seq % 3 === 0 ? '09:47' : '09:12';
      attendanceRows.push({ employeeId: emp.id, date: iso, status, checkIn: status === 'Leave' ? null : inTime, checkOut: status === 'Leave' ? null : '18:41' });
      if (status === 'Leave') return;
      const method = CHECKIN_METHODS[seq % CHECKIN_METHODS.length];
      const location = LOCATIONS[seq % LOCATIONS.length];
      punchRows.push({ employeeId: emp.id, date: iso, time: inTime, direction: 'In', method, location });
      punchRows.push({ employeeId: emp.id, date: iso, time: '18:41', direction: 'Out', method, location });
    });
  }
  await prisma.attendance.createMany({ data: attendanceRows });
  await prisma.attendancePunch.createMany({ data: punchRows });
  // Today's punches, matching the three records marked above.
  await prisma.attendancePunch.createMany({
    data: [
      { employeeId: empMeera.id, date: today, time: '09:12', direction: 'In', method: 'Biometric (Fingerprint)', location: 'Hyderabad HQ' },
      { employeeId: empMeera.id, date: today, time: '18:05', direction: 'Out', method: 'Biometric (Fingerprint)', location: 'Hyderabad HQ' },
      { employeeId: empKiran.id, date: today, time: '10:20', direction: 'In', method: 'Mobile App', location: 'Remote' },
      { employeeId: empDivya.id, date: today, time: '09:00', direction: 'In', method: 'Web Check-in', location: 'Bengaluru Office' },
      { employeeId: empDivya.id, date: today, time: '18:30', direction: 'Out', method: 'Web Check-in', location: 'Bengaluru Office' },
    ],
  });

  await prisma.leaveRequest.create({ data: { employeeId: empMeera.id, type: 'Casual Leave', fromDate: '2026-09-25', toDate: '2026-09-26', days: 2, reason: 'Family function', status: 'Pending' } });
  await prisma.leaveRequest.create({ data: { employeeId: empKiran.id, type: 'Sick Leave', fromDate: '2026-09-10', toDate: '2026-09-10', days: 1, reason: 'Fever', status: 'Approved', decidedAt: new Date(), decidedBy: 'Vasu (Admin)' } });
  await prisma.leaveRequest.create({ data: { employeeId: empDivya.id, type: 'Casual Leave', fromDate: '2026-10-05', toDate: '2026-10-09', days: 5, reason: 'Vacation', status: 'Approved', decidedAt: new Date(), decidedBy: 'Vasu (Admin)', approvalReason: 'Approved per Company Policy' } });

  await prisma.attendanceRegularization.create({ data: { employeeId: empKiran.id, date: today, requestedCheckIn: '09:15', reason: 'Biometric device was offline at the gate.' } });

  // Leave policy — types, approval reasons, holiday calendar
  const LEAVE_TYPES = [
    { code: 'CL', name: 'Casual Leave', cap: 12, unit: 'yr', carries: false },
    { code: 'SL', name: 'Sick Leave', cap: 1, unit: 'month', carries: true },
    { code: 'EL', name: 'Earned Leave', cap: 18, unit: 'yr', carries: false, active: false },
    { code: 'ML', name: 'Maternity', cap: 182, unit: 'yr', carries: false, active: false },
    { code: 'PL', name: 'Paternity', cap: 15, unit: 'yr', carries: false, active: false },
    { code: 'LWP', name: 'Loss of Pay', cap: 0, unit: 'unpaid', carries: false, active: false },
  ];
  for (const t of LEAVE_TYPES) await prisma.leaveType.create({ data: t });

  const LEAVE_REASONS = ['Medical Emergency', 'Family Function / Event', 'Personal Reasons', 'Approved per Company Policy', 'Other'];
  for (const label of LEAVE_REASONS) await prisma.leaveReason.create({ data: { label } });

  await prisma.holiday.create({ data: { name: 'Gandhi Jayanti', date: '2026-10-02', type: 'National Holiday' } });
  await prisma.holiday.create({ data: { name: 'Diwali', date: '2026-11-08', type: 'Festival' } });
  await prisma.holiday.create({ data: { name: 'Diwali (2nd day)', date: '2026-11-09', type: 'Festival' } });
  await prisma.holiday.create({ data: { name: 'Christmas', date: '2026-12-25', type: 'National Holiday' } });
  await prisma.holiday.create({ data: { name: 'Republic Day', date: '2027-01-26', type: 'National Holiday' } });
  await prisma.holiday.create({ data: { name: 'Independence Day', date: '2026-08-15', type: 'National Holiday' } });

  // Opening leave balances. `total` is the year's entitlement (a monthly cap is
  // multiplied out to 12); `taken` is what has already been approved.
  const allEmployees = [empMeera, empKiran, empDivya, empNewJoiner];
  const balanceSeed = [
    { type: 'Casual Leave', total: 12 },
    { type: 'Sick Leave', total: 12 },
  ];
  for (const emp of allEmployees) {
    for (const b of balanceSeed) {
      await prisma.leaveBalance.create({ data: { employeeId: emp.id, type: b.type, total: b.total, taken: 0 } });
    }
  }
  // Reflect the two approved leaves seeded above.
  await prisma.leaveBalance.update({ where: { employeeId_type: { employeeId: empKiran.id, type: 'Sick Leave' } }, data: { taken: 1 } });
  await prisma.leaveBalance.update({ where: { employeeId_type: { employeeId: empDivya.id, type: 'Casual Leave' } }, data: { taken: 5 } });

  // Salary structures (feed the payroll run)
  await prisma.salaryStructure.create({ data: { employeeId: empDivya.id, payMode: 'Package', ctc: 1800000, basic: 75000, hra: 30000, bonus: 6250, specialAllowance: 38750, employerPf: 1800, employeePf: 1800, professionalTax: 200, gratuity: 3608 } });
  await prisma.salaryStructure.create({ data: { employeeId: empKiran.id, payMode: 'Package', ctc: 900000, basic: 37500, hra: 15000, bonus: 3125, specialAllowance: 15375, employerPf: 1800, employeePf: 1800, professionalTax: 200, gratuity: 1804 } });
  await prisma.salaryStructure.create({ data: { employeeId: empMeera.id, payMode: 'Package', ctc: 720000, basic: 30000, hra: 12000, bonus: 2500, specialAllowance: 11500, employerPf: 1800, employeePf: 1800, professionalTax: 200, gratuity: 1443 } });
  await prisma.salaryStructure.create({ data: { employeeId: empNewJoiner.id, payMode: 'Stipend', stipend: 25000 } });

  await prisma.payslip.create({ data: { employeeId: empDivya.id, month: '2026-08', basic: 75000, hra: 30000, allowances: 45000, deductions: 2000, netPay: 148000, bonus: 6250, specialAllowance: 38750, employerPf: 1800, employeePf: 1800, professionalTax: 200, gratuity: 3608, lopDays: 0, gross: 150000, lateCut: 0, lateDays: 0, payMode: 'Package' } });
  await prisma.payrollRun.create({
    data: {
      month: '2026-08', period: 'August 2026', status: 'Paid', employees: 1,
      totalGross: 150000, totalDeductions: 2000, totalLateCuts: 0, totalNet: 148000,
      processedBy: 'Vasu (Admin)', paidAt: new Date('2026-09-01'),
    },
  });

  // Accounts
  // An invoice is worth amount + GST - TDS: the client deducts TDS at source,
  // so 150000 + 27000 - 15000 = 162000 is what actually lands in the bank.
  const invoice1 = await prisma.invoice.create({
    data: { clientId: orbit.id, candidateId: cand1.id, requirementId: req1.id, invoiceNumber: 'INV-2026-0001', amount: 150000, gst: 27000, tds: 15000, status: 'Pending', invoiceDate: '2026-09-05', dueDate: '2026-10-05', paymentTerms: 'Net 30' },
  });
  await prisma.invoice.create({
    data: { clientId: medivant.id, invoiceNumber: 'INV-2026-0002', amount: 80000, gst: 14400, tds: 8000, status: 'Overdue', invoiceDate: '2026-08-01', dueDate: '2026-08-31', paymentTerms: 'Net 30' },
  });
  // Part-settled, so "Partially Paid" has something to show.
  const invoice3 = await prisma.invoice.create({
    data: { clientId: orbit.id, invoiceNumber: 'INV-2026-0003', amount: 200000, gst: 36000, tds: 20000, status: 'Partially Paid', invoiceDate: '2026-07-10', dueDate: '2026-08-09', paymentTerms: 'Net 30', receivedAmount: 100000 },
  });
  await prisma.invoicePayment.create({
    data: { invoiceId: invoice3.id, date: '2026-08-14', amount: 100000, method: 'Bank Transfer', reference: 'UTR8841207', notes: 'Part payment on account', recordedBy: 'Lakshmi Narayan' },
  });

  // Bank statement: one credit that clears invoice1 exactly, one that does not
  // match anything, and office debits.
  await prisma.bankTransaction.create({ data: { date: '2026-09-08', description: 'NEFT CR-ORBIT SOFTWARE SOLUTIONS-INV0001', reference: 'UTR9930114', type: 'Credit', amount: 162000, matched: false, reconStatus: 'Unmatched', balance: 1042000 } });
  await prisma.bankTransaction.create({ data: { date: '2026-09-10', description: 'IMPS CR-MEDIVANT HEALTHCARE-PART', reference: 'UTR9930255', type: 'Credit', amount: 43000, matched: false, reconStatus: 'Unmatched', balance: 1085000 } });
  await prisma.bankTransaction.create({ data: { date: '2026-09-12', description: 'Office rent - Hyderabad', reference: 'NEFT7710', type: 'Debit', amount: 85000, matched: false, reconStatus: 'Unmatched', balance: 1000000 } });
  await prisma.bankTransaction.create({ data: { date: '2026-09-15', description: 'BANK CHARGES QTR', type: 'Debit', amount: 590, matched: false, reconStatus: 'Ignored', ignoredReason: 'Bank charges — not a client transaction', balance: 999410 } });

  await prisma.officeExpense.create({ data: { category: 'Office Rent', location: 'Hyderabad', monthlyAmount: 85000, vendor: 'Sai Estates', expenseDate: '2026-09-01', gstAmount: 12966, paidStatus: 'Paid' } });
  await prisma.officeExpense.create({ data: { category: 'Office Rent', location: 'Bengaluru', monthlyAmount: 110000, vendor: 'Prestige Facilities', expenseDate: '2026-09-01', gstAmount: 16780, paidStatus: 'Paid' } });
  await prisma.officeExpense.create({ data: { category: 'Software Subscriptions', location: 'All', monthlyAmount: 22000, vendor: 'Naukri / LinkedIn', expenseDate: '2026-09-03', gstAmount: 3356, paidStatus: 'Paid' } });
  await prisma.officeExpense.create({ data: { category: 'Internet & Telecom', location: 'Hyderabad', monthlyAmount: 9500, vendor: 'ACT Fibernet', expenseDate: '2026-09-05', gstAmount: 1449, paidStatus: 'Unpaid' } });
  await prisma.officeExpense.create({ data: { category: 'Office Rent', location: 'Hyderabad', monthlyAmount: 85000, vendor: 'Sai Estates', expenseDate: '2026-08-01', gstAmount: 12966, paidStatus: 'Paid' } });

  // HRMS long tail
  await prisma.performanceReview.create({ data: { employeeId: empDivya.id, period: '2026-H1', score: 82, band: 'High', recommendation: 'Recommended', notes: 'Consistently exceeds targets.' } });

  // LMS — the prototype's four courses. Compliance and onboarding courses are
  // mandatory and certify at a higher pass mark; the rest sit at the default 70.
  const courseOnboarding = await prisma.course.create({ data: { title: 'New Hire Orientation', category: 'Onboarding', duration: '2h', mandatory: true, passMark: 70 } });
  const coursePosh = await prisma.course.create({ data: { title: 'POSH Awareness', category: 'Compliance', duration: '1h', mandatory: true, passMark: 80 } });
  const courseRecruiting = await prisma.course.create({ data: { title: 'Recruitment Fundamentals', category: 'ATS', duration: '3h', mandatory: false, passMark: 70 } });
  const courseComms = await prisma.course.create({ data: { title: 'Client Communication Standards', category: 'Soft Skills', duration: '1.5h', mandatory: false, passMark: 65 } });
  const done = (d) => new Date(d);
  await prisma.courseAssignment.create({ data: { courseId: courseOnboarding.id, employeeId: empMeera.id, completed: true, completedAt: done('2026-04-18') } });
  await prisma.courseAssignment.create({ data: { courseId: coursePosh.id, employeeId: empMeera.id, completed: false } });
  await prisma.courseAssignment.create({ data: { courseId: coursePosh.id, employeeId: empKiran.id, completed: true, completedAt: done('2026-05-06') } });
  // Medical desk learning, so a Medical TL's scoped view has real figures.
  await prisma.courseAssignment.create({ data: { courseId: courseRecruiting.id, employeeId: empKiran.id, completed: false } });
  await prisma.courseAssignment.create({ data: { courseId: courseRecruiting.id, employeeId: empDivya.id, completed: true, completedAt: done('2026-03-11') } });
  await prisma.courseAssignment.create({ data: { courseId: coursePosh.id, employeeId: empDivya.id, completed: false } });
  await prisma.courseAssignment.create({ data: { courseId: courseComms.id, employeeId: empArun.id, completed: false } });

  const project1 = await prisma.project.create({ data: { name: 'Client Portal Revamp', status: 'Active' } });
  await prisma.projectAssignment.create({ data: { projectId: project1.id, employeeId: empDivya.id, role: 'Lead' } });
  await prisma.projectAssignment.create({ data: { projectId: project1.id, employeeId: empKiran.id, role: 'Contributor' } });

  await prisma.survey.create({ data: { title: 'Q3 Engagement Pulse', status: 'Active', questions: JSON.stringify(['How satisfied are you with your role?', 'Would you recommend TeamLink as a place to work?']) } });

  await prisma.policyDocument.create({ data: { title: 'Leave Policy', category: 'Policy', mandatory: true, published: true, target: 'All Employees', uploadedBy: 'Vasu (Admin)', uploadedDate: '01 Jan 2026' } });
  await prisma.policyDocument.create({ data: { title: 'POSH Awareness Handbook', category: 'Compliance', mandatory: true, published: true, target: 'All Employees', uploadedBy: 'Vasu (Admin)', uploadedDate: '01 Feb 2026' } });

  await prisma.announcement.create({ data: { title: 'Diwali Holiday Schedule', body: 'Office will be closed 08–09 Nov 2026 for Diwali.', category: 'Holiday', pinned: true, target: 'All Employees', postedBy: 'Vasu (Admin)', date: '15 Sep 2026' } });
  await prisma.announcement.create({ data: { title: 'Updated WFH Policy', body: 'Hybrid policy now allows 3 WFH days per week.', category: 'Policy', pinned: false, target: 'All Employees', postedBy: 'Vasu (Admin)', date: '10 Sep 2026' } });

  await prisma.hrConfig.create({ data: {} });
  await prisma.company.create({ data: { name: 'TeamLink Consultants', email: 'hello@teamlink.test', phone: '+91 40 1234 5678', address: 'Hyderabad, India' } });

  // Shift patterns
  await prisma.shiftPattern.create({ data: { name: 'Morning', startTime: '09:00', endTime: '18:00' } });
  await prisma.shiftPattern.create({ data: { name: 'Evening', startTime: '14:00', endTime: '23:00' } });
  await prisma.shiftPattern.create({ data: { name: 'Night', startTime: '22:00', endTime: '07:00' } });

  // EmployeeRecord-backed long tail
  await prisma.employeeRecord.create({ data: { type: 'WEEKLY_IDEA', employeeId: empMeera.id, title: 'Auto-tag candidate source in the weekly recruiter report', detail: 'Would save ~20 min/week of manual tagging.', status: 'Approved' } });
  await prisma.employeeRecord.create({ data: { type: 'HELPDESK', employeeId: empKiran.id, title: 'Laptop running slow', detail: 'Requesting IT to check disk space.', status: 'Open', category: 'IT Support', priority: 'Medium', assignedTo: empDivya.id, notes: '[]' } });
  await prisma.employeeRecord.create({ data: { type: 'HELPDESK', employeeId: empMeera.id, title: 'Payslip for August not visible', detail: 'The Payslips tab shows nothing for last month.', status: 'In Progress', category: 'Payroll Query', priority: 'High', assignedTo: empDivya.id, notes: JSON.stringify([{ author: 'Divya Rao', text: 'Checking whether the August run covered this employee.', internal: true }]) } });
  await prisma.employeeRecord.create({ data: { type: 'HELPDESK', employeeId: empNewJoiner.id, title: 'Access card not working at the Hyderabad gate', detail: 'Card beeps red since Monday.', status: 'Resolved', category: 'Facilities', priority: 'Urgent', resolution: 'Card reissued by facilities; old card deactivated.', resolvedAt: today, csat: 5, escalated: true, notes: '[]' } });

  // One employee already serving notice, so the Resignation screen has a live
  // notice period to count down and the exit checklist something to sit against.
  await prisma.employeeRecord.create({
    data: {
      type: 'RESIGNATION', employeeId: empKiran.id, title: 'Moving to a product role',
      detail: 'Offered a platform engineering position elsewhere.', status: 'Notice Period',
      date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    },
  });
  await prisma.employee.update({ where: { id: empKiran.id }, data: { employmentStatus: 'Notice Period', offboardingStatus: 'Serving Notice' } });
  await prisma.employeeRecord.create({ data: { type: 'ASSET', employeeId: empDivya.id, title: 'Dell Latitude 5420', detail: 'Serial: DL5420-8891', status: 'Assigned', category: 'Laptop', amount: 78000, date: '2022-01-15' } });
  await prisma.employeeRecord.create({ data: { type: 'EXPENSE', employeeId: empKiran.id, title: 'Client site travel', detail: 'Cab fare for Orbit Software client visit', status: 'Pending', category: 'Travel', location: 'Hyderabad', amount: 850, date: today } });
  await prisma.employeeRecord.create({ data: { type: 'TIMESHEET', employeeId: empDivya.id, title: 'Client Portal Revamp', status: 'Logged', hours: 6.5, date: today } });
  await prisma.employeeRecord.create({ data: { type: 'SHIFT', employeeId: empMeera.id, title: 'General Shift (9:00–18:00)', status: 'Scheduled', date: today } });
  await prisma.employeeRecord.create({ data: { type: 'RECOGNITION', employeeId: empKiran.id, title: 'Above & Beyond', detail: 'Highest offers-to-joins ratio in Q3.', status: 'Awarded', date: '2026-09-01', fromName: 'Vasu (Admin)', points: 50 } });
  await prisma.employeeRecord.create({ data: { type: 'TARGET', employeeId: empKiran.id, title: '5 confirmed joins this quarter', status: 'In Progress', date: '2026-12', progressPct: 40, amount: 5, achieved: 2, unit: 'joins' } });
  await prisma.employeeRecord.create({ data: { type: 'KT', employeeId: empDivya.id, title: 'Client Portal handover', status: 'In Progress', date: today, fromName: empDivya.name, toName: empMeera.name } });

  // Company asset inventory (Employee Services → Assets). Kept separate from the
  // employee-raised ASSET requests above, which feed the Asset Approval screen.
  await prisma.asset.createMany({
    data: [
      { assetCode: 'AST-0001', name: 'Dell Latitude 5420', category: 'Laptop', status: 'Assigned', assignedToId: empDivya.id, purchaseDate: '2022-01-15', warrantyUntil: '2025-01-15', history: JSON.stringify([{ at: '2022-01-15 10:00', by: 'HR', text: `Assigned to ${empDivya.name}` }]) },
      { assetCode: 'AST-0002', name: 'MacBook Air M2', category: 'Laptop', status: 'Available', purchaseDate: '2024-06-02', warrantyUntil: '2027-06-02', history: '[]' },
      { assetCode: 'AST-0003', name: 'Dell 24" Monitor', category: 'Monitor', status: 'In Repair', purchaseDate: '2023-03-11', history: JSON.stringify([{ at: '2026-09-01 09:00', by: 'HR', text: 'Sent for repair' }]) },
      { assetCode: 'AST-0004', name: 'iPhone 13', category: 'Mobile', status: 'Assigned', assignedToId: empKiran.id, purchaseDate: '2023-08-20', warrantyUntil: '2025-08-20', history: JSON.stringify([{ at: '2023-08-20 11:00', by: 'HR', text: `Assigned to ${empKiran.name}` }]) },
    ],
  });

  // ===========================================================================
  // THE ROLE-BY-ROLE TEST ACCOUNTS  (@teamlink.com)
  //
  // The @teamlink.test logins above are UNCHANGED and keep working — the
  // README documents them and they are what the existing demo data is wired
  // to. These are ADDITIONAL, on a different domain, so nothing collides:
  // `email` is unique, and `.com` and `.test` are different addresses. Where a
  // name overlaps (accounts@, employee@, client@, clientb@, candidate@) the
  // two are separate people with separate records, not two logins for one.
  //
  // ONE EMPLOYEE = ONE USER = ONE LOGIN for every staff account below, and
  // NOTHING IS HARD-CODED: staffLogin() looks the designation up in
  // DESIGNATION_ROLES — the same table utils/identity.js reads — and takes the
  // role, the ATS role, the three product booleans and the landing workspace
  // from it. The DEPARTMENT supplies the data scope. There is no "Medical
  // Recruiter" role anywhere: that person is department=Medical +
  // designation=Recruiter, which the engine resolves to RECRUITER scoped to
  // Medical.
  // ===========================================================================
  const designationByName = Object.fromEntries(DESIGNATION_ROLES.map((d) => [d.designation, d]));

  // The login's role code for a designation — the same rule the API uses
  // (utils/employeeAdmin.js loginRoleFor).
  function roleForDesignation(name) {
    const m = designationByName[name];
    if (!m) return 'EMPLOYEE';
    if (m.atsRole) return m.atsRole;
    // An HRMS-only designation that NAMES its HRMS role keeps it — 'HR' (§6).
    // Same rule as utils/employeeAdmin.js loginRoleFor().
    if (m.hrmsRole && m.hrmsRole !== NO_ROLE && !m.ats) return m.hrmsRole;
    if (m.accounts && !m.ats) return 'ACCOUNTANT';
    return 'EMPLOYEE';
  }

  let staffSeq = 10; // EMP-001 .. EMP-010 are taken above.
  async function staffLogin({
    email, name, department, team, designation, location = 'Hyderabad',
    scopeDepartments, scopeClients, username,
  }) {
    const m = designationByName[designation];
    if (!m) throw new Error(`Seed: no DesignationRole row for "${designation}"`);
    const role = roleForDesignation(designation);
    staffSeq += 1;
    const employeeCode = `EMP-${String(staffSeq).padStart(4, '0')}`;
    const user = await prisma.user.create({
      data: {
        name,
        email,
        username: username || email,
        passwordHash: password,
        // DERIVED, every one of them — including ALL THREE PRODUCT ROLES.
        // `role` is the ACCOUNT-LEVEL role; hrmsRole / atsRole / accountsRole
        // are what the permission engine resolves against, one per product.
        role,
        hrmsRole: m.hrms ? role : 'NONE',
        atsRole: m.ats ? (m.atsRole || role) : 'NONE',
        accountsRole: m.accounts ? role : 'NONE',
        hrmsAccess: !!m.hrms,
        atsAccess: !!m.ats,
        accountsAccess: !!m.accounts,
        landingWorkspace: m.landing || null,
        // The DEPARTMENT is the scope.
        atsDepartment: department,
        atsScopeDepartments: scopeDepartments || department,
        atsScopeTeams: team || null,
        atsScopeClients: scopeClients || null,
        branch: location,
        team: team || null,
        status: 'Active',
      },
    });
    const employee = await prisma.employee.create({
      data: {
        userId: user.id, employeeCode, name, email,
        department, team: team || null, designation, location,
        dateOfJoining: new Date('2024-01-08'), employmentStatus: 'Active',
        employeeType: 'Full-time', onboardingTasks: tasks(6),
        profileStage: 'Locked', isLocked: true,
      },
    });
    return { user, employee, role };
  }

  // Two more teams so the Manufacturing and Education desks are real.
  await prisma.team.createMany({
    data: [
      { name: 'Manufacturing Team-A', departmentId: departmentsByName['Manufacturing'].id },
      { name: 'Education Team-A', departmentId: departmentsByName['Educational'].id },
    ],
  });

  // --- Leadership ------------------------------------------------------------
  const cSuperAdmin = await staffLogin({
    email: 'superadmin@teamlink.com', name: 'Aarti Deshpande', department: 'HR',
    team: 'Leadership', designation: 'Super Admin',
  });
  const cAdmin = await staffLogin({
    email: 'admin@teamlink.com', name: 'Nikhil Joshi', department: 'HR',
    team: 'Leadership', designation: 'Admin',
  });
  // A Manager's scope is CONFIGURED, not automatically global: these
  // departments only, which is what utils/scope.js then enforces.
  const cManager = await staffLogin({
    email: 'manager@teamlink.com', name: 'Shalini Pillai', department: 'Medical',
    designation: 'Manager', scopeDepartments: 'Medical,IT,Manufacturing,Educational,BDE',
  });
  const cAsstManager = await staffLogin({
    email: 'asstmanager@teamlink.com', name: 'Rohit Bansal', department: 'IT',
    designation: 'Assistant Manager', scopeDepartments: 'IT,Manufacturing',
  });
  const cStl = await staffLogin({
    email: 'stl@teamlink.com', name: 'Ganesh Iyer', department: 'Medical',
    designation: 'STL', scopeDepartments: 'Medical,IT',
  });

  // --- Team leads. Same designation, different department = different scope --
  const cMedicalTl = await staffLogin({
    email: 'medicaltl@teamlink.com', name: 'Sunita Raj', department: 'Medical',
    team: 'Medical Team-A', designation: 'TL',
  });
  const cItTl = await staffLogin({
    email: 'ittl@teamlink.com', name: 'Harish Gupta', department: 'IT',
    team: 'Section A', designation: 'TL',
  });
  const cMfgTl = await staffLogin({
    email: 'manufacturingtl@teamlink.com', name: 'Prakash Naidu', department: 'Manufacturing',
    team: 'Manufacturing Team-A', designation: 'TL', location: 'Pune',
  });
  const cEduTl = await staffLogin({
    email: 'edutl@teamlink.com', name: 'Latha Menon', department: 'Educational',
    team: 'Education Team-A', designation: 'TL', location: 'Bengaluru',
  });
  const cBdeTl = await staffLogin({
    email: 'bdetl@teamlink.com', name: 'Imran Qureshi', department: 'BDE',
    team: 'Business Development', designation: 'TL', location: 'Bengaluru',
  });

  // --- Recruiters and the BDE ------------------------------------------------
  const cMedical1 = await staffLogin({
    email: 'medical1@teamlink.com', name: 'Anjali Verma', department: 'Medical',
    team: 'Medical Team-A', designation: 'Recruiter',
  });
  const cIt1 = await staffLogin({
    email: 'itrecruiter1@teamlink.com', name: 'Vivek Sharma', department: 'IT',
    team: 'Section A', designation: 'Recruiter',
  });
  const cMfg1 = await staffLogin({
    email: 'manufacturingrecruiter1@teamlink.com', name: 'Deepa Kulkarni',
    department: 'Manufacturing', team: 'Manufacturing Team-A', designation: 'Recruiter', location: 'Pune',
  });
  const cEdu1 = await staffLogin({
    email: 'edu1@teamlink.com', name: 'Farhan Shaikh', department: 'Educational',
    team: 'Education Team-A', designation: 'Recruiter', location: 'Bengaluru',
  });

  // --- The two new client accounts the BDE owns ------------------------------
  const vertex = await prisma.client.create({
    data: {
      name: 'Vertex Industrial Manufacturing', legalName: 'Vertex Industrial Manufacturing Pvt. Ltd.',
      clientCode: 'CLI0003', industry: 'Manufacturing', location: 'Pune', state: 'Maharashtra', country: 'India',
      ownerDepartment: 'Manufacturing', clientType: 'Direct', priority: 'High', status: 'Active',
      businessType: 'Private Limited',
      contactName: 'Mahesh Kadam', contactDesignation: 'Plant HR Head',
      contactEmail: 'hr@vertexmfg.example', contactPhone: '9100000003',
      recruitmentContactName: 'Mahesh Kadam', recruitmentContactEmail: 'hr@vertexmfg.example',
      recruitmentContactPhone: '9100000003',
      billingContactName: 'Snehal Pawar', billingContactEmail: 'ap@vertexmfg.example', billingContactPhone: '9100000013',
      accountManager: 'Imran Qureshi', bdeOwner: 'Nandita Rao',
      gst: '27AAAAA1113A1Z5', tdsPercent: 10, gstPercent: 18,
      agreementFeePercent: 8.5, guaranteePeriod: '60 Days',
      agreementId: 'AGR0003', agreementStatus: 'ACTIVE', agreementRequired: 'Yes',
      agreementTemplate: 'Standard Recruitment / Staffing',
      agreementStart: '2026-07-01', agreementEnd: '2027-06-30',
      agreementActivatedAt: new Date('2026-07-01'), agreementSignedAt: new Date('2026-06-28'),
      agreementSignedBy: 'Mahesh Kadam', agreementSignedByTitle: 'Plant HR Head',
      esignToken: 'ESN-SEEDVERTEX003', riskFlag: 'None',
    },
  });
  const nalanda = await prisma.client.create({
    data: {
      name: 'Nalanda Learning Group', legalName: 'Nalanda Learning Group Pvt. Ltd.',
      clientCode: 'CLI0004', industry: 'Education', location: 'Bengaluru', state: 'Karnataka', country: 'India',
      ownerDepartment: 'Educational', clientType: 'Direct', priority: 'Medium', status: 'Active',
      businessType: 'Private Limited',
      contactName: 'Revathi Nair', contactDesignation: 'Academic Director',
      contactEmail: 'hr@nalanda.example', contactPhone: '9100000004',
      recruitmentContactName: 'Revathi Nair', recruitmentContactEmail: 'hr@nalanda.example',
      recruitmentContactPhone: '9100000004',
      billingContactName: 'Arun Shetty', billingContactEmail: 'ap@nalanda.example', billingContactPhone: '9100000014',
      accountManager: 'Imran Qureshi', bdeOwner: 'Nandita Rao',
      gst: '29AAAAA1114A1Z5', tdsPercent: 10, gstPercent: 18,
      agreementFeePercent: 7.5, guaranteePeriod: '30 Days',
      agreementId: 'AGR0004', agreementStatus: 'ACTIVE', agreementRequired: 'Yes',
      agreementTemplate: 'Standard Recruitment / Staffing',
      agreementStart: '2026-08-01', agreementEnd: '2027-07-31',
      agreementActivatedAt: new Date('2026-08-01'), agreementSignedAt: new Date('2026-07-30'),
      agreementSignedBy: 'Revathi Nair', agreementSignedByTitle: 'Academic Director',
      esignToken: 'ESN-SEEDNALANDA004', riskFlag: 'None',
    },
  });

  // A BDE is scoped to the CLIENTS assigned to them, not to a department.
  const cBde1 = await staffLogin({
    email: 'bde1@teamlink.com', name: 'Nandita Rao', department: 'BDE',
    team: 'Business Development', designation: 'BDE', location: 'Bengaluru',
    scopeClients: `${vertex.id},${nalanda.id},${orbit.id}`,
  });

  // --- Accounts and plain HRMS self-service ---------------------------------
  const cAccountant = await staffLogin({
    email: 'accounts@teamlink.com', name: 'Suresh Pattnaik', department: 'Accounts',
    team: 'Accounts', designation: 'Accountant',
  });
  const cEmployee = await staffLogin({
    email: 'employee@teamlink.com', name: 'Kavya Reddy', department: 'HR',
    designation: 'Employee',
  });

  // --- The HR desk (§6) ------------------------------------------------------
  // HRMS ONLY, and NOT department-scoped: every employee in the company is
  // visible to HR, which is what makes it different from the Manager / STL /
  // TL rows above. Nothing here is a special case — the designation maps to
  // hrmsRole=HR, atsRole=NONE, accountsRole=NONE, and the engine does the rest.
  const cHr = await staffLogin({
    email: 'hr@teamlink.com', name: 'Meghana Rao', department: 'HR',
    team: 'Leadership', designation: 'HR',
  });

  // --- External logins: no employee record, scope pinned to one row ---------
  await prisma.user.create({
    data: {
      name: 'Ravi Teja (Orbit)', email: 'client@teamlink.com', username: 'client@teamlink.com',
      passwordHash: password, role: 'CLIENT', clientId: orbit.id, branch: 'Hyderabad',
      hrmsAccess: false, atsAccess: true, accountsAccess: true,
      hrmsRole: 'NONE', atsRole: 'CLIENT', accountsRole: 'CLIENT', landingWorkspace: 'client',
    },
  });
  await prisma.user.create({
    data: {
      name: 'Anita Desai (Medivant)', email: 'clientb@teamlink.com', username: 'clientb@teamlink.com',
      passwordHash: password, role: 'CLIENT', clientId: medivant.id, branch: 'Bengaluru',
      hrmsAccess: false, atsAccess: true, accountsAccess: true,
      hrmsRole: 'NONE', atsRole: 'CLIENT', accountsRole: 'CLIENT', landingWorkspace: 'client',
    },
  });

  // --- Requirements, one desk at a time -------------------------------------
  // A Manufacturing recruiter with no Manufacturing requirement proves nothing,
  // so every department above gets work of its own. A RECRUITER's scope is the
  // ASSIGNMENT (recruiterId / recruiterIds); a TL's is their tlId plus their
  // department; a BDE's is their assigned clients.
  const reqCommon = {
    employmentType: 'Full Time', jobPreference: 'Permanent', salaryType: 'Annual CTC',
    currency: 'INR', noticePeriodMax: '30 Days', joiningTimeline: 'Within 30 Days',
    stlId: cStl.user.id, stl: cStl.user.name,
  };
  const cReqMed1 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0006', title: 'Staff Nurse — ICU',
      jobDescription: 'Run ICU shifts for a 200-bed multi-specialty group, owning patient charting and handover.',
      clientId: medivant.id, department: 'Medical', priority: 'High', openings: 4,
      recruiterId: cMedical1.user.id, tlId: cMedicalTl.user.id, tl: cMedicalTl.user.name,
      bdeId: cBde1.user.id, accountManager: cMedicalTl.user.name,
      skills: 'Critical Care, Patient Monitoring, BLS', experience: '2-5 yrs', relevantExperience: '2 yrs',
      education: 'B.Sc Nursing', workMode: 'Work From Office', location: 'Hyderabad', preferredLocation: 'Hyderabad',
      salary: '₹4L - ₹6L', targetDate: '2026-11-20',
    },
  });
  const cReqMed2 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0007', title: 'Pharmacovigilance Associate',
      jobDescription: 'Own adverse-event intake, triage and regulatory reporting for the clinical group.',
      clientId: medivant.id, department: 'Medical', priority: 'Medium', openings: 2,
      recruiterId: cMedical1.user.id, tlId: cMedicalTl.user.id, tl: cMedicalTl.user.name,
      skills: 'Pharmacovigilance, Argus, MedDRA', experience: '2-4 yrs', relevantExperience: '2 yrs',
      education: 'B.Pharm', workMode: 'Hybrid', location: 'Hyderabad', preferredLocation: 'Hyderabad',
      salary: '₹5L - ₹8L', targetDate: '2026-12-05',
    },
  });
  const cReqIt1 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0008', title: 'React Frontend Engineer',
      jobDescription: 'Build Orbit’s customer console in React, owning the design-system components end to end.',
      clientId: orbit.id, department: 'IT', priority: 'High', openings: 3,
      recruiterId: cIt1.user.id, tlId: cItTl.user.id, tl: cItTl.user.name,
      bdeId: cBde1.user.id, accountManager: cItTl.user.name,
      skills: 'React, TypeScript, CSS, REST', goodToHaveSkills: 'Vite, Testing Library',
      experience: '3-6 yrs', relevantExperience: '3 yrs',
      education: 'B.Tech', workMode: 'Hybrid', location: 'Hyderabad', preferredLocation: 'Hyderabad',
      salary: '₹12L - ₹18L', targetDate: '2026-11-25',
    },
  });
  const cReqIt2 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0009', title: 'DevOps Engineer',
      jobDescription: 'Own Orbit’s build, deploy and observability pipeline across AWS and Kubernetes.',
      clientId: orbit.id, department: 'IT', priority: 'Medium', openings: 1,
      recruiterId: cIt1.user.id, tlId: cItTl.user.id, tl: cItTl.user.name,
      skills: 'AWS, Kubernetes, Terraform, CI/CD', experience: '4-8 yrs', relevantExperience: '4 yrs',
      education: 'B.Tech', workMode: 'Remote', location: 'Hyderabad', preferredLocation: 'Anywhere',
      salary: '₹16L - ₹24L', targetDate: '2026-12-20',
    },
  });
  const cReqMfg1 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0010', title: 'CNC Production Supervisor',
      jobDescription: 'Supervise a two-shift CNC machining line, owning output, scrap rate and shop-floor safety.',
      clientId: vertex.id, department: 'Manufacturing', priority: 'High', openings: 2,
      recruiterId: cMfg1.user.id, tlId: cMfgTl.user.id, tl: cMfgTl.user.name,
      bdeId: cBde1.user.id, accountManager: cMfgTl.user.name,
      skills: 'CNC, Lean Manufacturing, Shop Floor Safety', experience: '5-9 yrs', relevantExperience: '5 yrs',
      education: 'B.E Mechanical', workMode: 'Work From Office', location: 'Pune', preferredLocation: 'Pune',
      salary: '₹7L - ₹11L', targetDate: '2026-11-18',
    },
  });
  const cReqMfg2 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0011', title: 'Quality Inspector — Castings',
      jobDescription: 'Inspect incoming and in-process castings against drawing tolerance and raise NCRs.',
      clientId: vertex.id, department: 'Manufacturing', priority: 'Medium', openings: 3,
      recruiterId: cMfg1.user.id, tlId: cMfgTl.user.id, tl: cMfgTl.user.name,
      skills: 'QA/QC, GD&T, Metrology', experience: '2-5 yrs', relevantExperience: '2 yrs',
      education: 'Diploma Mechanical', workMode: 'Work From Office', location: 'Pune', preferredLocation: 'Pune',
      salary: '₹3L - ₹5L', targetDate: '2026-12-10',
    },
  });
  const cReqEdu1 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0012', title: 'Senior Physics Faculty',
      jobDescription: 'Teach senior-secondary Physics and own the board-exam revision programme.',
      clientId: nalanda.id, department: 'Educational', priority: 'High', openings: 2,
      recruiterId: cEdu1.user.id, tlId: cEduTl.user.id, tl: cEduTl.user.name,
      bdeId: cBde1.user.id, accountManager: cEduTl.user.name,
      skills: 'Physics, Curriculum Design, Classroom Management', experience: '3-8 yrs', relevantExperience: '3 yrs',
      education: 'M.Sc Physics', workMode: 'Work From Office', location: 'Bengaluru', preferredLocation: 'Bengaluru',
      salary: '₹6L - ₹10L', targetDate: '2026-11-28',
    },
  });
  const cReqEdu2 = await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0013', title: 'Academic Counsellor',
      jobDescription: 'Run admissions counselling for the Bengaluru campuses and own the enrolment funnel.',
      clientId: nalanda.id, department: 'Educational', priority: 'Medium', openings: 4,
      recruiterId: cEdu1.user.id, tlId: cEduTl.user.id, tl: cEduTl.user.name,
      skills: 'Counselling, Admissions, CRM', experience: '1-4 yrs', relevantExperience: '1 yrs',
      education: 'Any Degree', workMode: 'Work From Office', location: 'Bengaluru', preferredLocation: 'Bengaluru',
      salary: '₹3L - ₹5L', targetDate: '2026-12-15',
    },
  });
  // The BDE desk's own hiring — internal, so it needs no client agreement. It
  // is what puts a requirement in the BDE TL's department scope.
  await prisma.requirement.create({
    data: {
      ...reqCommon, reqCode: 'REQ-0014', title: 'Business Development Executive — South',
      jobDescription: 'Open new staffing accounts across Karnataka and Tamil Nadu for TeamLink.',
      clientId: orbit.id, internal: true, department: 'BDE', priority: 'High', openings: 2,
      tlId: cBdeTl.user.id, tl: cBdeTl.user.name, bdeId: cBde1.user.id,
      skills: 'Client Acquisition, Staffing Sales, Negotiation', experience: '2-6 yrs', relevantExperience: '2 yrs',
      education: 'Any Degree', workMode: 'Hybrid', location: 'Bengaluru', preferredLocation: 'Bengaluru',
      salary: '₹5L - ₹9L', targetDate: '2026-11-30',
    },
  });

  // --- Candidates and applications, so every desk has a live pipeline -------
  const candDefs = [
    ['Nurse Anila Thomas', 'anila.thomas@example.com', '9000001001', 'Critical Care, Patient Monitoring, BLS', 4, 'Hyderabad', cReqMed1, 'RECRUITER_REVIEW', 86],
    ['Joseph Mathew', 'joseph.mathew@example.com', '9000001002', 'Critical Care, BLS, ACLS', 3, 'Hyderabad', cReqMed1, 'SHARED_WITH_CLIENT', 81],
    ['Swetha Bala', 'swetha.bala@example.com', '9000001003', 'Pharmacovigilance, Argus, MedDRA', 3, 'Hyderabad', cReqMed2, 'NEW', 78],
    ['Nikhil Rao', 'nikhil.rao@example.com', '9000001004', 'React, TypeScript, CSS, REST', 5, 'Hyderabad', cReqIt1, 'INTERVIEW_SCHEDULED', 92],
    ['Tanvi Shah', 'tanvi.shah@example.com', '9000001005', 'React, TypeScript, Vite', 4, 'Pune', cReqIt1, 'RECRUITER_REVIEW', 87],
    ['Ashok Pillai', 'ashok.pillai@example.com', '9000001006', 'AWS, Kubernetes, Terraform, CI/CD', 7, 'Bengaluru', cReqIt2, 'NEW', 83],
    ['Ramesh Jadhav', 'ramesh.jadhav@example.com', '9000001007', 'CNC, Lean Manufacturing, Shop Floor Safety', 8, 'Pune', cReqMfg1, 'RECRUITER_REVIEW', 89],
    ['Sunil Gaikwad', 'sunil.gaikwad@example.com', '9000001008', 'CNC, Production Planning', 6, 'Pune', cReqMfg1, 'SHARED_WITH_CLIENT', 80],
    ['Meenal Deshmukh', 'meenal.deshmukh@example.com', '9000001009', 'QA/QC, GD&T, Metrology', 3, 'Pune', cReqMfg2, 'NEW', 76],
    ['Dr. Kavitha Suresh', 'kavitha.suresh@example.com', '9000001010', 'Physics, Curriculum Design', 9, 'Bengaluru', cReqEdu1, 'RECRUITER_REVIEW', 90],
    ['Naveen Kumar', 'naveen.kumar@example.com', '9000001011', 'Physics, Classroom Management', 4, 'Bengaluru', cReqEdu1, 'NEW', 77],
    ['Pooja Hegde', 'pooja.hegde@example.com', '9000001012', 'Counselling, Admissions, CRM', 2, 'Bengaluru', cReqEdu2, 'RECRUITER_REVIEW', 74],
  ];
  for (const [nm, em, ph, sk, yrs, loc, req, stage, score] of candDefs) {
    // eslint-disable-next-line no-await-in-loop
    const c = await prisma.candidate.create({
      data: {
        name: nm, email: em, phone: ph, source: 'Naukri', firstSource: 'Naukri',
        skills: sk, experienceYears: yrs, relevantExperienceYears: Math.max(1, yrs - 1),
        location: loc, preferredLocation: loc, noticePeriod: '30 Days',
        availability: 'Available after notice period', jobPreference: 'Permanent',
        preferredEmploymentType: 'Full Time', profileStatus: 'Active',
        resumeName: `${nm.replace(/\W+/g, '_')}.pdf`, resumeScore: score,
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.create({
      data: {
        candidateId: c.id, requirementId: req.id, stage,
        matchScore: score, resumeScore: score, source: 'Naukri', firstSource: 'Naukri',
        applicationMethod: 'Manual',
      },
    });
  }

  // The candidate login — external, no employee record, pinned to their own
  // candidate row by utils/scope.js.
  const cCandidate = await prisma.candidate.create({
    data: {
      name: 'Sharath Kamath', email: 'candidate@teamlink.com', phone: '9000001099',
      source: 'TeamLink Website', firstSource: 'TeamLink Website',
      skills: 'React, TypeScript, Node.js', experienceYears: 4, relevantExperienceYears: 3,
      location: 'Hyderabad', preferredLocation: 'Hyderabad', noticePeriod: 'Immediate',
      availability: 'Available immediately', jobPreference: 'Permanent',
      preferredEmploymentType: 'Full Time', profileStatus: 'Active',
      resumeName: 'Sharath_Kamath.pdf', resumeScore: 85,
    },
  });
  await prisma.application.create({
    data: {
      candidateId: cCandidate.id, requirementId: cReqIt1.id, stage: 'RECRUITER_REVIEW',
      matchScore: 85, resumeScore: 85, source: 'TeamLink Website', firstSource: 'TeamLink Website',
      applicationMethod: 'Self Apply',
    },
  });
  await prisma.user.create({
    data: {
      name: 'Sharath Kamath', email: 'candidate@teamlink.com', username: 'candidate@teamlink.com',
      passwordHash: password, role: 'CANDIDATE', candidateId: cCandidate.id,
      hrmsAccess: false, atsAccess: true, accountsAccess: false, atsRole: 'CANDIDATE',
      landingWorkspace: 'candidate',
    },
  });

  // A little HRMS substance for the new logins, so HRMS is not empty for them.
  await prisma.attendance.createMany({
    data: [cMedical1, cIt1, cMfg1, cEdu1, cAccountant, cEmployee, cHr].map((s) => ({
      employeeId: s.employee.id, date: today, status: 'Present', checkIn: '09:05', checkOut: '18:15',
    })),
  });
  await prisma.leaveRequest.create({
    data: {
      employeeId: cMfg1.employee.id, type: 'Casual Leave', fromDate: '2026-10-02', toDate: '2026-10-02',
      days: 1, reason: 'Personal', status: 'Pending',
    },
  });
  await prisma.leaveRequest.create({
    data: {
      employeeId: cEdu1.employee.id, type: 'Sick Leave', fromDate: '2026-09-18', toDate: '2026-09-18',
      days: 1, reason: 'Fever', status: 'Pending',
    },
  });

  await prisma.auditLog.create({ data: { userId: admin.id, action: 'Demo data seeded', entity: 'System' } });

  console.log('Seed complete.');
  console.log('');
  console.log('DEMO PASSWORD for every login below: password123');
  console.log('(documented here and in the README; never shown in the UI)');
  console.log('');
  console.log('  admin@teamlink.test       Super Admin              — all products, global');
  console.log('  divya@teamlink.test       Medical / TL             — HRMS + ATS (TL, Medical)');
  console.log('  kiran@teamlink.test       Medical / Recruiter      — HRMS + ATS (Recruiter, Medical)');
  console.log('  recruiter@teamlink.test   IT / Recruiter           — HRMS + ATS (Recruiter, IT)');
  console.log('  tl@teamlink.test          IT / TL                  — HRMS + ATS (TL, IT)');
  console.log('  multi@teamlink.test       Medical / Manager        — HRMS + ATS + Accounts, one login');
  console.log('  bde@teamlink.test         BDE                      — HRMS + ATS (BDE, assigned clients)');
  console.log('  accounts@teamlink.test    Accountant               — Accounts + HRMS self-service');
  console.log('  accountant@teamlink.test  Accountant (second)      — Accounts + HRMS self-service');
  console.log('  employee@teamlink.test    HR Executive             — HRMS only');
  console.log('  rahul.verma@teamlink.test Junior Developer         — HRMS only, profile unfilled');
  console.log('  client@teamlink.test      Client A (Orbit)         — own company only');
  console.log('  clientb@teamlink.test     Client B (Medivant)      — own company only');
  console.log('  candidate@teamlink.test   Candidate (Arjun Mehta)  — own profile only');
  console.log('');
  console.log('THE ROLE-BY-ROLE TEST ACCOUNTS (@teamlink.com), same password.');
  console.log('Every role below is DERIVED from department + designation — no compound');
  // ---------------------------------------------------------------------
  // ONE LOGIN, THREE PRODUCT ROLES — the final pass.
  //
  // The rows above set the ACCOUNT-LEVEL role column and the three product
  // booleans. This derives hrmsRole / atsRole / accountsRole from them by the
  // same rule the prodrole migration backfills an existing database with, so
  // a freshly seeded database and a migrated one are identical:
  //   product held -> the role already named for it, else the account role
  //   product not held -> 'NONE', which the engine refuses outright.
  // ---------------------------------------------------------------------
  const keep = (v, fallback) => (v && v !== 'NONE' ? v : fallback);
  for (const u of await prisma.user.findMany()) {
    await prisma.user.update({
      where: { id: u.id },
      data: {
        hrmsRole: u.hrmsAccess ? keep(u.hrmsRole, u.role) : 'NONE',
        atsRole: u.atsAccess ? keep(u.atsRole, u.role) : 'NONE',
        accountsRole: u.accountsAccess ? keep(u.accountsRole, u.role) : 'NONE',
      },
    });
  }

  console.log('role such as "Medical Recruiter" is stored anywhere.');
  console.log('');
  console.log('  superadmin@teamlink.com               HR / Super Admin          -> SUPER_ADMIN, all departments');
  console.log('  admin@teamlink.com                    HR / Admin                -> ADMIN, all departments');
  console.log('  manager@teamlink.com                  Medical / Manager         -> MANAGER, Medical+IT+Manufacturing+Educational+BDE');
  console.log('  asstmanager@teamlink.com              IT / Assistant Manager    -> ASSISTANT_MANAGER, IT+Manufacturing');
  console.log('  stl@teamlink.com                      Medical / STL             -> STL, Medical+IT');
  console.log('  medicaltl@teamlink.com                Medical / TL              -> TL, Medical (Medical Team-A)');
  console.log('  ittl@teamlink.com                     IT / TL                   -> TL, IT (Section A)');
  console.log('  manufacturingtl@teamlink.com          Manufacturing / TL        -> TL, Manufacturing');
  console.log('  edutl@teamlink.com                    Educational / TL          -> TL, Educational');
  console.log('  bdetl@teamlink.com                    BDE / TL                  -> TL, BDE');
  console.log('  medical1@teamlink.com                 Medical / Recruiter       -> RECRUITER, assigned Medical reqs');
  console.log('  itrecruiter1@teamlink.com             IT / Recruiter            -> RECRUITER, assigned IT reqs');
  console.log('  manufacturingrecruiter1@teamlink.com  Manufacturing / Recruiter -> RECRUITER, assigned Manufacturing reqs');
  console.log('  edu1@teamlink.com                     Educational / Recruiter   -> RECRUITER, assigned Education reqs');
  console.log('  bde1@teamlink.com                     BDE / BDE                 -> BDE, assigned clients (Vertex, Nalanda, Orbit)');
  console.log('  accounts@teamlink.com                 Accounts / Accountant     -> ACCOUNTANT, Accounts + HRMS self-service');
  console.log('  employee@teamlink.com                 HR / Employee             -> EMPLOYEE, HRMS self-service only');
  console.log('  hr@teamlink.com                       HR / HR                   -> HR, HRMS only, EVERY employee, no ATS/Accounts');
  console.log('  client@teamlink.com                   Client A (Orbit)          -> own company only');
  console.log('  clientb@teamlink.com                  Client B (Medivant)       -> own company only');
  console.log('  candidate@teamlink.com                Candidate (Sharath K.)    -> own profile only');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('password123', 10);

  const departmentNames = ['IT', 'HR', 'R&D', 'QA', 'Manufacturing', 'Medical', 'Educational', 'BDE'];
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
      industry: 'IT', location: 'Hyderabad', state: 'Telangana', country: 'India',
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
      industry: 'Healthcare', location: 'Bengaluru', state: 'Karnataka', country: 'India',
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
    { designation: 'HR Executive', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 12 },
    { designation: 'Junior Developer', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 13 },
    { designation: 'Employee', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms', position: 14 },
  ];
  for (const row of DESIGNATION_ROLES) await prisma.designationRole.create({ data: row });

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
      clientId: orbit.id, department: 'IT', priority: 'High', recruiterId: recruiter.id, bdeId: bde.id,
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
      recruiterId: recruiterMedical.id, bdeId: bde.id, tl: 'Divya Rao', stl: 'Priya Nambiar',
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
      clientId: medivant.id, department: 'Medical', priority: 'Low', status: 'DRAFT',
      recruiterId: recruiterMedical.id, tl: 'Divya Rao',
      skills: 'SQL, Excel, Data Analysis, Python', goodToHaveSkills: 'Machine Learning',
      experience: '2-4 yrs', relevantExperience: '2 yrs',
      education: 'Any Degree', employmentType: 'Full Time', workMode: 'Work From Office',
      location: 'Pune', preferredLocation: 'Pune',
      joiningTimeline: 'Within 30 Days', noticePeriodMax: '30 Days', jobPreference: 'Permanent',
      salaryType: 'Annual CTC', currency: 'INR', salary: '₹8L - ₹12L',
    },
  });
  // An internal TeamLink opening — no client, so it needs no agreement.
  await prisma.requirement.create({
    data: {
      title: 'Talent Acquisition Executive',
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

  const courseOnboarding = await prisma.course.create({ data: { title: 'New Hire Orientation', category: 'Onboarding', duration: '2h' } });
  const coursePosh = await prisma.course.create({ data: { title: 'POSH Awareness', category: 'Compliance', duration: '1h' } });
  await prisma.courseAssignment.create({ data: { courseId: courseOnboarding.id, employeeId: empMeera.id, completed: true } });
  await prisma.courseAssignment.create({ data: { courseId: coursePosh.id, employeeId: empMeera.id, completed: false } });
  await prisma.courseAssignment.create({ data: { courseId: coursePosh.id, employeeId: empKiran.id, completed: true } });

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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

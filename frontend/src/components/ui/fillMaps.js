// ---------------------------------------------------------------------------
// Fill from a file (2026-10-06): the server's fields -> each form's own
// shape. Only non-empty values are copied, so a field the file does not
// mention keeps what the form already had (its default, or what was typed).
// ---------------------------------------------------------------------------
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const num = (v) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v) => (has(v) ? String(v).trim() : undefined);
const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// The names shown in "Still to fill: …".
export const JOB_FIELD_NAMES = {
  title: 'Job Title', clientName: 'Client', jobDescription: 'Job description', skills: 'Mandatory skills', location: 'Work location', expMin: 'Minimum experience',
};
export const CANDIDATE_FIELD_NAMES = { firstName: 'First name', phone: 'Mobile', email: 'Email', skills: 'Mandatory skills' };
export const CLIENT_FIELD_NAMES = { name: 'Company name', industry: 'Industry', contactName: 'Contact name', contactEmail: 'Contact email', contactPhone: 'Contact mobile' };

// Add job (components/RequirementForm.jsx). `clients` = the form's client list.
export function jobFieldsToForm(f, { clients = [], departments = [] } = {}) {
  const out = {
    title: str(f.title),
    department: departments.length ? departments.find((d) => d.toLowerCase() === String(f.department || '').toLowerCase()) : str(f.department),
    location: str(f.location),
    workMode: str(f.workMode),
    expMin: num(f.expMin),
    expMax: num(f.expMax),
    salaryMin: num(f.salaryMin) !== undefined ? String(f.salaryMin) : undefined,
    salaryMax: num(f.salaryMax) !== undefined ? String(f.salaryMax) : undefined,
    openings: num(f.openings),
    skills: str(f.skills),
    goodToHaveSkills: str(f.goodToHaveSkills),
    education: str(f.education),
    noticePeriodMax: str(f.noticePeriodMax),
    employmentType: str(f.employmentType),
    jobDescription: str(f.jobDescription),
    responsibilities: str(f.responsibilities),
    qualifications: str(f.qualifications),
  };
  // A client matched by name on the server, if it is in this form's list.
  if (f.clientId && clients.some((c) => c.id === f.clientId)) out.clientId = f.clientId;
  if (out.expMin !== undefined && out.expMax === undefined && out.expMin > 6) out.expMax = out.expMin + 4;
  return pick(out);
}

// Add candidate (pages/Candidates.jsx).
export function candidateFieldsToForm(f) {
  return pick({
    firstName: str(f.firstName), lastName: str(f.lastName), phone: str(f.phone), email: str(f.email), dob: str(f.dob), gender: str(f.gender),
    location: str(f.location), currentCompany: str(f.currentCompany), currentDesignation: str(f.currentDesignation),
    experienceYears: num(f.experienceYears) !== undefined ? String(f.experienceYears) : undefined,
    currentSalary: str(f.currentSalary), expectedSalary: str(f.expectedSalary), noticePeriod: str(f.noticePeriod),
    education: str(f.education), specialization: str(f.specialization), institute: str(f.institute), passingYear: str(f.passingYear),
    skills: str(f.skills),
  });
}

// Add client (components/clients/AddClientWizard.jsx + ClientForm.jsx).
export function clientFieldsToForm(f) {
  const out = pick({
    name: str(f.name), legalName: str(f.legalName), companyType: str(f.companyType), industry: str(f.industry), website: str(f.website),
    companyEmail: str(f.companyEmail), landline: str(f.landline), street: str(f.street), location: str(f.location), state: str(f.state), pincode: str(f.pincode),
    contactName: str(f.contactName), contactDesignation: str(f.contactDesignation), contactEmail: str(f.contactEmail), contactPhone: str(f.contactPhone),
    gst: str(f.gst), pan: str(f.pan), tan: str(f.tan), billingEmail: str(f.billingEmail), billingContactName: str(f.billingContactName),
    bankIfsc: str(f.bankIfsc), paymentBankName: str(f.paymentBankName), bankAccountHolder: str(f.bankAccountHolder),
    feeType: str(f.feeType), agreementFeePercent: str(f.agreementFeePercent), paymentDays: str(f.paymentDays), guaranteeDays: str(f.guaranteeDays),
    invoiceMode: str(f.invoiceMode), invoiceDays: str(f.invoiceDays), specialTerms: str(f.specialTerms), agreementStart: str(f.agreementStart),
  });
  if (has(f.billingAddress)) { out.billingSameAsAddress = false; out.billingAddress = String(f.billingAddress).trim(); }
  return out;
}

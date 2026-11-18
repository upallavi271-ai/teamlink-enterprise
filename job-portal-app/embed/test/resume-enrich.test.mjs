// Work history and education read from a resume's text. node --test job-portal-app/embed/test/resume-enrich.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workHistory, educationList } from '../resume-enrich.mjs';

const A = `Amjad Khan
Email: amjad@example.com  Mobile: 9876543210

WORK EXPERIENCE
Senior Dental Surgeon - Apollo Hospitals, Hyderabad
Jan 2021 - Present
Handled implants and root canals.

Dental Surgeon - Care Clinic, Pune
Jun 2018 - Dec 2020
General dentistry.

EDUCATION
BDS - Osmania Dental College, 2017, 72%
MDS Prosthodontics - Nair Hospital Dental College, 2020, 68%
Intermediate - Narayana Junior College, 2012, 91%

SKILLS
Implants
`;

test('every dated job becomes a row with title, company and location', () => {
  const w = workHistory(A);
  assert.equal(w.length, 2);
  assert.equal(w[0].jobTitle, 'Senior Dental Surgeon');
  assert.match(w[0].company, /Apollo Hospitals/);
  assert.match(w[0].responsibilities, /Jan 2021 - Present/);
  assert.match(w[0].responsibilities, /implants/);
  assert.equal(w[1].jobTitle, 'Dental Surgeon');
  assert.match(w[1].company, /Care Clinic/);
});

test('every degree becomes a row with its own year, college and marks', () => {
  const e = educationList(A);
  assert.equal(e.length, 3);
  assert.equal(e[0].qualification, 'BDS');
  assert.equal(e[0].passingYear, '2017');
  assert.match(e[0].institution, /Osmania/);
  assert.equal(e[0].score, '72%');
  assert.equal(e[0].educationType, 'Graduation');
  assert.match(e[1].qualification, /MDS/);
  assert.equal(e[1].passingYear, '2020');
  assert.equal(e[1].educationType, 'Post Graduation');
  assert.equal(e[2].educationType, 'Higher Secondary');
});

test('a header on two lines and the period beside the company still read', () => {
  const t = `EXPERIENCE
Consultant Dentist
Care Clinic | Jun 2018 - Dec 2020 | Pune
EDUCATION
Bachelor of Dental Surgery (BDS) from Osmania Dental College 2017 CGPA 8.2`;
  const w = workHistory(t);
  assert.equal(w.length, 1);
  assert.match(`${w[0].company} ${w[0].jobTitle}`, /Care Clinic/);
  const e = educationList(t);
  assert.equal(e.length, 1);
  assert.equal(e[0].passingYear, '2017');
});

test('text with no sections gives nothing, never an error', () => {
  assert.deepEqual(workHistory('hello world'), []);
  assert.deepEqual(educationList(''), []);
});

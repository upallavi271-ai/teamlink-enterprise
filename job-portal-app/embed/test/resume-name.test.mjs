// A name for a resume whose name the portal's reader did not find. node --test job-portal-app/embed/test/resume-name.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFallback } from '../resume-name.mjs';

test('a dot between the initial and the name is a name', () => {
  assert.equal(nameFallback('GADAM.ROHITH KUMAR\nHARDWARE DESIGN & TESTING ENGINEER\nHyderabad | 9700000000', 'x@y.test', 'a.pdf'), 'Gadam Rohith Kumar');
});

test('headings, job titles and cities at the top are passed over', () => {
  assert.equal(nameFallback('CURRICULUM VITAE\nSoftware Engineer\nHyderabad\nName: Asha Reddy\n', '', 'x.pdf'), 'Asha Reddy');
});

test('no usable line: the file name without job words, then the email', () => {
  assert.equal(nameFallback('9700000000\n----', 'q@y.test', 'Rohith hardware eng.pdf'), 'Rohith');
  assert.equal(nameFallback('12345', 'asha.reddy@mail.test', 'resume.pdf'), 'Asha Reddy');
});

test('nothing at all gives an empty answer', () => {
  assert.equal(nameFallback('', '', 'cv.pdf'), '');
});

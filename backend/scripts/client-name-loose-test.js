#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENT NAMES AS BANKS PRINT THEM (founder 2026-10-29: "client name narration lo unte automatic ga match avvadam ledu").
//   cd backend && node scripts/client-name-loose-test.js        pure: utils/reconMatch.js clientNamed, no database
// The narrations are the founder's real statement lines; the clients are as they are named on file.
// ---------------------------------------------------------------------------
const RM = require('../src/utils/reconMatch');

const clients = [
  ['mam', 'Mamatha Academy of Medical Sciences'],
  ['lords', 'Lords Institute of Engineering & Technology'],
  ['royal', 'Royal College of Engineering & Technology'],
  ['peter', "St. Peter's Engineering College"],
  ['stpm', 'St Peter Medical College'],
  ['sanj', 'Sanjivani Group of Institutes, Maharashtra & Sanjivani University'],
  ['mrw', 'Malla Reddy Engineering College for Women'],
  ['mrm', 'Malla Reddy Engineering College & Management Sciences'],
  ['mru', 'Malla Reddy University'],
  ['sid', 'Siddhartha Institute of Technonlogy and Science'],
  ['ssh', 'Sri Sai Hospital Research Centre'],
  ['own', 'TeamLink Consultants — Internal Hiring'],
  ['talla', 'Talla Padmavathi College of Engineering (Autonomous)'],
  ['geeth', 'Geethanjali College of Engineering & Technology'],
].map(([id, name]) => ({ id, name, legalName: null }));
const ctx = () => ({ clients, clientAliases: [], rules: [] });
const named = (narr) => RM.clientNamed(RM.norm(narr), ctx(), narr);

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); };
const is = (n, narr, id, via) => { const r = named(narr); check(n, r && r.clientId === id && (!via || r.via === via), r); };
const none = (n, narr) => { const r = named(narr); check(n, r == null, r); };
const ambiguous = (n, narr, ids) => { const r = named(narr); check(n, r && r.ambiguous && ids.every((x) => r.ambiguous.includes(x)) && r.ambiguous.length === ids.length, r); };

// found
is('L1 spelling: MAMATA = Mamatha', 'NEFT CR-UBIN0816205-MAMATA ACADEMY OF MEDICAL SCIENCES -TEAMLINKCONSULTANTSPVTLTD-010715155492', 'mam', 'name, spelt differently');
is('L2 cut short at the field end: LORDS INSTITUTE OF ENGINEERING T-', 'RTGS CR-UBIN0808547-LORDS INSTITUTE OF ENGINEERING T-TEAM LINK CONSULTANTS P LTD-UBINR220260527', 'lords', 'name cut short by the bank');
is('L3 "&" printed as "-" and cut short: ROYAL COLLEGE OF ENGINEERING - TECH-', 'NEFT CR-ICIC0SF0002-ROYAL COLLEGE OF ENGINEERING - TECH-TEAMLINKCONSULTANTS-IN42615652958382', 'royal', 'name cut short by the bank');
is("L4 apostrophe: ST PETERS = St. Peter's (exact, not St Peter Medical)", 'NEFT CR-ICIC0SF0002-ST PETERS ENGINEERING COLLEGE-TEAMLINK CONSULTANTS (OPC)-IN42614153067258', 'peter', 'name');
is('L5 part of a joined name: SANJIVANI UNIVERSITY', 'NEFT CR-UTIB0002826-SANJIVANI UNIVERSITY -TEAMLINK CONSULTANT PVT LTD-AXISP00787422637', 'sanj', 'part of the name');
is('L6 cut short mid-word: TALLA PADMAVATHI COLLEGE OF EN-', 'NEFT CR-UBIN0802999-TALLA PADMAVATHI COLLEGE OF EN-TEAMLINK CONSULTANTS OPC PVT LTD-0000002913603357', 'talla', 'name cut short by the bank');
is('L7 cut at the end of the line: GEETHANJALI COLLEGE OF ENGINEERING', 'FT - C53830130826100945 - - 50100457758976 - GEETHANJALI COLLEGE OF ENGINEERING', 'geeth', 'name cut short by the bank');
is('L8 "and" written out: ROYAL COLLEGE OF ENGINEERING AND TECHNOLOGY', 'NEFT CR-X-ROYAL COLLEGE OF ENGINEERING AND TECHNOLOGY-TEAMLINK', 'royal', 'name, spelt differently');
// never guessed
ambiguous('N1 MALLA REDDY ENGINEER- fits two clients: a person decides', 'IMPS-622016539778-MALLA REDDY ENGINEER-IDFB-XXXXXXX8828-CONSULTANCYSERVICES', ['mrw', 'mrm']);
none('N2 a different name with the same start: SIDDHARTHA INSTITUTE OF ENGG AND TE is not "...of Technology and Science"', 'NEFT CR-SBIN0020090-SIDDHARTHA INSTITUTE OF ENGG AND TE-TEAMLINK CONSULTANTS PVT LTD-SBIN226103');
none('N3 the name goes on (SRI SAI HOSPITAL KADAPA): not cut, not that client', 'NEFT CR-X-SRI SAI HOSPITAL KADAPA-TEAMLINK');
none('N4 a generic part never counts (MANAGEMENT SCIENCES)', 'NEFT CR-X-XYZ INSTITUTE OF MANAGEMENT SCIENCES-TEAMLINK');
none('N5 our own company (TEAMLINK CONSULTANTS) is never a client', 'IMPS-609917778170-TEAMLINK CONSULTANTS-ICIC-XXXXXXXX3333-TEAMLINKHDFC');
none('N6 too short a start (2 words) is not enough', 'NEFT CR-X-LORDS INSTITUTE-TEAMLINK');
none('N7 a person, not a client', 'UPI-CHITTURI VASUDEVA R-9959598863-6@AXL-SBIN0002728-523624215780-PAYMENT FROM PHONE');
// the old exact reading is unchanged
is('E1 the exact full name still wins', 'NEFT CR-X-MALLA REDDY ENGINEERING COLLEGE FOR WOMEN-TEAMLINK', 'mrw', 'name');
is('E2 without the raw narration (older callers) the spelling reading still works', 'MAMATA ACADEMY OF MEDICAL SCIENCES', 'mam');
check('E3 ... but cut-short needs the raw narration', RM.clientNamed(RM.norm('LORDS INSTITUTE OF ENGINEERING T-X'), ctx()) == null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

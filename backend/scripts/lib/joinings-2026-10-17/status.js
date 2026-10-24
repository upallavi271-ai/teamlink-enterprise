// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - WHAT EACH ROW SAYS ABOUT THE PERSON.
//
// The rules (all written down so the founder can see them in the report):
//  * A "Joinings" sheet (2022 ... 2026, bio-metric, Medical, Manufacturing) lists people who JOINED. Its status word then says
//    how it went: Continue / Working / Regular / On Roll / Replace / Rejoin / Visiting / Part time / Biometric = joined (still there),
//    a date or a month in the status = joined, left then.
//  * "Drop" (Droped, Discontinue ...): joined and then LEFT only when the row itself shows the person joined (an invoice number, or
//    words like worked / left / resigned / relieved / only 10 days / not reporting). Words that say the person never joined
//    (did not join / won't join / not joined ...) always win. A "Drop" with no evidence either way is treated as DID NOT JOIN, because
//    the app never claims a joining that the row does not prove (the Team A / Team B sheets use "Drop" the same way).
//  * The pipeline sheets (Missing Joinings, Reporting Profiles) and the Documents-pending sheet carry an interview / joining status
//    word, mapped below. Only Joined counts as a joining. A word this file does not know is NOT applied: it is listed.
// ---------------------------------------------------------------------------
const { oneLine, lc, datesIn } = require('./parse');

const DNJ_CUE = /(did ?n.?t (the )?join|did not (the )?join|not (the )?join|never join|didnt jion|didn.?t jion|won.?t join|wont join|not joining|not willing to join|not interested to join|rejected (her|him)|not genuine|didnt attend the college)/i;
const LEFT_CUE = /(worked|working|joined|continue[d]?|attended? (the )?class|\bleft\b|resign|relieve|last working|abscond|terminated|not reporting|only \d+ ?(days?|months?|weeks?)|days only|dropout|drop out)/i;

function monthOnly(s) {
  const m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?$/i.exec(oneLine(s));
  return m ? { month: m[1].toLowerCase(), year: m[2] || null } : null;
}

// the text of every free-text cell of the row (what a person wrote about this candidate)
function allText(f, row) {
  return [f.remarkRaw, f.statusRaw, f.respRaw, f.feedbackRaw, f.followRaw, ...Object.values(row.extras || {})].filter(Boolean).join(' \n ');
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ---- the pipeline words ------------------------------------------------------------------------------
// word (letters only, lower case) -> { stage, side?, category?, offerStatus?, joined? }
const PIPE = {
  joined: { stage: 'JOINED' }, joining: { stage: 'JOINED' },
  willjoin: { stage: 'OFFER_ACCEPTED' }, report: { stage: 'OFFER_ACCEPTED', note: 'Report (reporting to the college)' }, reported: { stage: 'OFFER_ACCEPTED', note: 'Reported (reporting to the college)' }, reporting: { stage: 'OFFER_ACCEPTED' },
  selected: { stage: 'SELECTED' },
  rejected: { stage: 'REJECTED', side: 'Client', category: 'Not Selected' },
  noteligible: { stage: 'REJECTED', side: 'Client', category: 'Not Eligible' },
  notattended: { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Attend Interview' },
  wontjoin: { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Join', dnj: true },
  notinterested: { stage: 'REJECTED', side: 'Candidate', category: 'Not Interested' },
  notresponding: { stage: 'REJECTED', side: 'Candidate', category: 'Not Reachable' },
  waitingforfeedback: { stage: 'INTERVIEW_COMPLETED' },
  rescheduled: { stage: 'INTERVIEW_SCHEDULED' }, reschedule: { stage: 'INTERVIEW_SCHEDULED' },
  redomo: { stage: 'INTERVIEW_SCHEDULED', note: 'Re-demo' },
  hold: { stage: 'HOLD' },
};
const wordKey = (s) => lc(s).replace(/[^a-z]/g, '');

// "Same" and "College End" are labels, not outcomes; when the interview-status cell holds one of them (or nothing) the REMARK cell
// (the sheet's last column) is read instead, if it carries a status word.
function pipelineStatus(f) {
  const q = wordKey(f.statusRaw);
  const label = !q || q === 'same' || q === 'collegeend';
  let hit = q ? PIPE[q] : null;
  let text = f.statusRaw;
  let from = 'interview status';
  if ((!hit || label) && PIPE[wordKey(f.remarkRaw)]) { hit = PIPE[wordKey(f.remarkRaw)]; text = f.remarkRaw; from = 'remark column'; }
  if (!hit) return { unknown: true, why: !q ? 'no interview status written' : `status word "${f.statusRaw}" is not one this import knows` };
  return { ...hit, text, from };
}

// ---- joinings sheets --------------------------------------------------------------------------------
// returns { joined:true, left?:{ on, month, text }, dnj?:bool, text, note, evidence }
function joiningsStatus(f, row, sheetCode) {
  const text = allText(f, row);
  const remark = oneLine(f.remarkRaw);
  const stat = oneLine(f.statusRaw);
  const rl = lc(remark);
  // an explicit date in the status cell itself (2026 sheet: M = 46142) = left on that day
  const cellM = row.cells[row.sheetCfg.cols.remark];
  if (cellM && cellM.t === 'n' && cellM.v > 40000 && cellM.v < 60000) {
    const iso = new Date(Date.UTC(1899, 11, 30) + Math.round(cellM.v) * 86400000).toISOString().slice(0, 10);
    return { joined: true, left: { on: iso, text: remark }, statusText: remark, note: `Joined - left on ${iso} (status cell holds a date)` };
  }
  const mo = monthOnly(remark);
  if (mo) return { joined: true, left: { on: null, month: mo.month, text: remark }, statusText: remark, note: `Joined - left in ${remark} (status cell holds a month)` };
  const dropWord = /\b(drop|droped|dropped|dropout|discontinue)/i;
  const isDrop = dropWord.test(remark) || /^(drop|discontinue)/i.test(stat) || (/(^|\W)drop(\W|$)/i.test(stat));
  if (isDrop) {
    const dnjCue = DNJ_CUE.test(text);
    const inv = /^\d{3,5}$|^[A-Z]{1,4}\d*-\d+/i.test(oneLine(f.invoiceRaw));
    const evidence = inv || LEFT_CUE.test(text.replace(DNJ_CUE, ' '));
    const trigger = dropWord.test(remark) ? remark : stat;
    const dropDates = datesIn(trigger);
    const monthWord = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b\.?(?:\s*\d{4})?/i.exec(trigger);
    const leftOn = dropDates.find((d) => d.iso && (!f.joinIso || d.iso >= f.joinIso) && d.iso <= todayIso());
    if (dnjCue) return { joined: false, dnj: true, statusText: trigger || remark, note: 'Drop - the notes say the candidate did not join', evidence: 'notes say did not join' };
    if (evidence) return { joined: true, left: { on: leftOn ? leftOn.iso : null, month: monthWord ? monthWord[0] : null, text: trigger || remark }, statusText: trigger || remark, note: `Drop - joined, then left${leftOn ? ` on ${leftOn.iso}` : ''}`, evidence: inv ? 'invoice number on the row' : 'notes show the candidate worked / left' };
    return { joined: false, dnj: true, statusText: trigger || remark, note: 'Drop - nothing on the row proves the candidate joined, so treated as did not join', evidence: 'no proof of joining' };
  }
  // everything else on a joinings sheet = joined
  let note = remark ? `Joined - status "${remark}"` : 'Joined - status not written';
  if (/^continue/i.test(remark)) note = 'Joined - still continuing';
  return { joined: true, statusText: remark, note, possibleLeaver: LEFT_CUE.test(text) && /(not working|left|resign|relieved|not continue|discontinu|didn.?t continue)/i.test(text) && !/^(drop)/i.test(remark) };
}

// ---- Medical joinings -------------------------------------------------------------------------------
function medicalStatus(f, row) {
  const raw = oneLine(f.statusRaw);
  const k = wordKey(raw);
  const text = allText(f, row);
  if (k === 'joined') return { joined: true, statusText: raw, note: 'Joined' };
  if (k === 'onroll') return { joined: true, statusText: raw, note: 'Joined - on roll (on the client\'s payroll)' };
  if (k === 'replace') return { joined: true, statusText: raw, note: 'Joined - as a replacement (the invoice number is the one of the person replaced)' };
  if (k === 'joineddropped') return { joined: true, left: { on: null, text: raw }, statusText: raw, note: 'Joined, then dropped (date not written)' };
  if (k === 'droped' || k === 'dropped' || k === 'drop') {
    const dnjCue = DNJ_CUE.test(text);
    const inv = /^\d{3,5}$|^[A-Z]{1,4}\d*-\d+/i.test(oneLine(f.invoiceRaw));
    const evidence = inv || LEFT_CUE.test(text.replace(DNJ_CUE, ' '));
    if (dnjCue || !evidence) return { joined: false, dnj: true, statusText: raw, note: dnjCue ? 'Droped - the notes say the candidate did not join' : 'Droped - nothing on the row proves the candidate joined, so treated as did not join', evidence: dnjCue ? 'notes say did not join' : 'no proof of joining' };
    return { joined: true, left: { on: null, text: raw }, statusText: raw, note: 'Droped - joined, then left (date not written)', evidence: inv ? 'invoice number on the row' : 'notes show the candidate worked / left' };
  }
  return { unknown: true, why: `Joining Status "${raw}" is not one this import knows` };
}

// ---- Documents-submission-pending sheet ---------------------------------------------------------------
function docsStatus(f, row) {
  const text = allText(f, row);
  const s = wordKey(f.statusRaw);
  if (s === 'drop' || s === 'wontjoin') return { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Join', dnj: true, text: `Did not join (status "${f.statusRaw}")`, why: 'status says ' + f.statusRaw };
  if (/(not interested to join|not interested|said he is not|not willing|rejected salary|rejected)/i.test(text) && !/selected/i.test(text.split('\n')[0] || '')) {
    return { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Join', dnj: true, text: 'Did not join (documents pending; the notes say it was turned down)', why: 'the notes say the candidate / college turned it down' };
  }
  const inv = /^\d{3,5}$/.test(oneLine(f.invoiceRaw));
  if (inv || /(will continue the classes|is joined|he joined|she joined|joined the college)/i.test(text)) return { stage: 'JOINED', documents: 'Pending', text: 'Joined, documents pending', why: inv ? 'invoice number on the row' : 'the notes say the candidate is attending / joined' };
  return { stage: 'SELECTED', documents: 'Pending', text: 'Selected, joining / documents pending', why: 'selected; joining not confirmed in the notes' };
}

module.exports = { joiningsStatus, medicalStatus, pipelineStatus, docsStatus, allText, DNJ_CUE, LEFT_CUE, wordKey, monthOnly };

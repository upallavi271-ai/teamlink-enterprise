// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - WHICH CLIENT IS "Cmr-It", "ST.Peters", "Vcare Health Clinic , Goa" ...
//
// The sheets write short / nickname spellings (and a branch after a dash or comma). Each rule below says: when the text of the sheet's
// client cell matches this pattern (in the given department), it is THIS client (written as the app calls it BEFORE the official-name
// rename; the planner turns the name into an id once, at load time). First matching rule wins.
// Anything no rule covers is looked up by exact normalised name (official name / old name / alias); if that fails the row is NOT
// applied and is listed for a decision. A branch (Aurora-Nampally, Vcare ... Goa) is not a different client here: the college text is
// kept on every row's notes.
// ---------------------------------------------------------------------------
const E = 'Education'; const M = 'Medical'; const F = 'Manufacturing';
// [department, regex on the lower-case cell text, client name]
const RULES = [
  [E, /^ace\b/, 'ACE Engineering College'],
  [E, /^adith?ya/, 'Aditya University'],
  [E, /^(sri )?annamacharya/, 'Annamacharya Institute of Technology & Sciences'],
  [E, /^anurag/, 'Anurag Engineering College'],
  [E, /^aurora/, 'Aurora Colleges'],
  [E, /^avanthi/, 'Avanthi Institute of Engineering & Technology'],
  [E, /^avn\b/, 'AVN'],
  [E, /^bhaskar/, 'Bhaskar Engineering College'],
  [E, /^bvc\b/, 'BVC Engineering College (Bonam Venkata Chalamayya)'],
  [E, /^cmr[ -]*(it|institute)\b/, 'CMR Institute of Technology'],
  [E, /^cmr[ -]*ec\b/, 'CMR Engineering College'],
  [E, /^cmr[ -]*tech/, 'CMR Technical Campus'],
  [E, /^cmr[ -]*cet\b/, 'CMR College of Engineering & Technology (CMRCET)'],
  [E, /^drk\b/, 'DRK'],
  [E, /^ellenki\b/, 'Ellenki'],
  [E, /^g\.? ?pullaiah|^pullaiah/, 'G. Pullaiah Engineering College'],
  [E, /^geethanjali/, 'Geethanjali College of Engineering & Technology'],
  [E, /^godavari|^godawari/, 'Godavari Institute of Engineering & Technology (GIET)'],
  [E, /^gvr ?& ?s\b|^gvr&s/, 'G.v.r & S College Of Engineering & Technology'],
  [E, /^hitam\b/, 'HITAM'],
  [E, /^holimarry|^holly ?mary|^holy ?mary|^holymary/, 'Holy Mary Institute of Technology & Science'],
  [E, /^jaya ?prak|^jayaprak|^jayaprakesh/, 'Jaya Prakash Narayan College of Engineering'],
  [E, /^jbiet\b/, 'J.B. Institute of Engineering and Technology (JBIET)'],
  [E, /^jbrec\b/, 'JBREC'],
  [E, /^k\.?k\.? ?wagh/, 'K.K. Wagh Institute of Engineering Education and Research'],
  [E, /^kg[- ]?reddy/, 'Kg Reddy'],
  [E, /^kmit\b/, 'kmit'],
  [E, /^kuppam/, 'Kuppam Engineering College'],
  [E, /^lords\b/, 'Lords Institute of Engineering & Technology'],
  [E, /^mahaveer\b/, 'Mahaveer'],
  [E, /^mall?a ?reddy wom|^mallareddy wom|^malla reddy womens|^mallareddy women/, "Malla Reddy Women's College"],
  [E, /^mall?areddy univ|^malla reddy univ/, 'Malla Reddy University'],
  [E, /^methodist/, 'Methodist College of Engineering and Technology'],
  [E, /^mlrit\b/, 'MLRIT'],
  [E, /^mr-?cet\b/, 'Mr Cet'],
  [E, /^mrem\b/, 'Malla Reddy Engineering College & Management Sciences (MREM)'],
  [E, /^mrits\b/, 'mrits'],
  [E, /^narasaropet|^narasaraopet/, 'Narasaraopeta Engineering College(NEC)'],
  [E, /^pragathi|^pragtahi|^pragati/, 'Pragati Engineering College'],
  [E, /^presidency/, 'Presidency University'],
  [E, /^pullareddy|^pulla ?reddy/, 'Pulla Reddy Institute of Pharmacy'],
  [E, /^ramachandra/, 'Ramachandra College of Engineering'],
  [E, /^ravindra/, 'Ravindra College of Engineering for Women'],
  [E, /^rishi/, 'Rishi MS Institute of Engineering and Technology for Women'],
  [E, /^rk\b/, 'RK College Of Engineering'],
  [E, /^royal/, 'Royal College of Engineering & Technology'],
  [E, /^samkurthi|^samskruthi|^samskruti/, 'Samskruti College of Engineering & Technology'],
  [E, /^sanjeevani|^sanjivani/, 'Sanjivani University'],
  [E, /^sbit\b/, 'SBIT'],
  [E, /^scient\b/, 'Scient Institute of Technology'],
  [E, /^sharada\b/, 'Sharada College'],
  [E, /^sharad\b/, 'Sharad Institute of Technology College of Engineering'],
  [E, /^sri sai ?- ?raychoty/, 'Sri Sai Institute of Technology and Science'],
  [E, /^shri sak?thi|^sri sak?thi|^sri shakthi/, 'Sri Shakthi Institute of Engineering and Technology'],
  [E, /^sidd?h?arat?h?a|^siddartha|^siddharath|^siddhartha/, 'Siddhartha Group of Institutions'],
  [E, /^sir c r reddy/, 'Sir C R Reddy College of Engineering'],
  [E, /^sree[ -]*chait|^sri[ -]*chait|^sri[ -]*chiath|^sri chaitanya|^sri-chaith|^sree-chaith/, 'Sri Chaitanya Group of Colleges'],
  [E, /^sreenidhi/, 'Sreenidhi Institute of Science and Technology'],
  [E, /^sreyas/, "Sreya's College"],
  [E, /^srgec\b/, 'Srgec'],
  [E, /^sri vasavi/, 'Sri Vasavi Engineering College'],
  [E, /^sri venkateswara|^sri venkateshwara/, 'Sri Venkateswara College of Engineering'],
  [E, /^sri vi?hsnu|^sri vishnu|^svecw\b/, 'Shri Vishnu Engineering College for Women (SVECW)'],
  [E, /^st\.? ?peter/, "St. Peter's Engineering College"],
  [E, /^st\.? ?mary/, "St. Mary's Group of Institutions"],
  [E, /^st\.? ?martin/, 'St. Martins'],
  [E, /^stanley/, 'Stanley College of Engineering & Technology for Women'],
  [E, /^thalla padmavathi|^talla padmavathi/, 'Talla Padmavathi College of Engineering'],
  [E, /^trr\b/, 'T R R'],
  [E, /^vageshwari|^vageswari/, 'Vageswari College of Engineering'],
  [E, /^vbit\b/, 'Vbit'],
  [E, /^vignan\b/, "Vignan's Institute of Management and Technology for Women"],
  [E, /^vsb\b/, 'VSB Engineering College'],

  [M, /^agur prime/, 'Agur Prime Hospital'],
  [M, /^apollo medical college/, 'Apollo Medical College'],
  [M, /^cmr medical/, 'CMR Institute of Medical Sciences'],
  [M, /^east coast/, 'East Coast Hospital'],
  [M, /^fortune medicare/, 'Fortune Medicare Hospital'],
  [M, /^hyderabad kidney/, 'Hyderabad Kidney And Laparoscopic Centre Hospital'],
  [M, /^lims hospital/, 'LIMS Hospital'],
  [M, /^mamatha/, 'Mamatha Medical College'],
  [M, /^med ?one/, 'Med One Hospital'],
  [M, /^muslim/, "Muslim Maternity and Children's Hospital"],
  [M, /^nova institute/, 'NEW:Nova Institute of Medical Sciences and Research Center'],
  [M, /^prathima/, 'Prathima Relief Medical College'],
  [M, /^r ?v ?r mother/, 'RVR Mother and Child Hospital'],
  [M, /^rajasthan hospital/, 'Rajasthan Hospital Limited (RHL)'],
  [M, /^relive health/, 'ReLiv Healthy India Pvt Ltd'],
  [M, /^renovo|^renova/, 'Renova Hospitals'],
  [M, /^shifa/, 'Shifa Hospitals'],
  [M, /^sreekeshava/, 'Sree Keshav Hospital'],
  [M, /^sri sai srinivasa/, 'Sri Sai Srinivasa Specialty Hospital'],
  [M, /^sunrise/, 'Sunrise Super Speciality Hospital'],
  [M, /^trr medical/, 'Trr Medical College'],
  [M, /^vcare/, 'Vcare Health Clinic Pvt Ltd'],
  [M, /^vivekandha|^vivekanandha/, 'Vivekanandha Hospital'],
  [M, /^zen hospital/, 'Zen Hospitals'],
  [M, /^apollo/, 'Apollo Medical College'],

  [F, /^aurochemicals/, 'Aurochem Pharmaceuticals (India )Private Limited'],
  [F, /^fortune bio ?tech/, 'Fortune Biotech Pvt Ltd'],
  [F, /^ijm\b/, 'IJM Concrete Products Private Limited'],
  [F, /^modular container/, 'Modular Container Pvt Ltd'],
];

// Which rule set applies to a row: the sheet's department, or (Manufacturing sheet) the row's own Department column.
function deptOf(sheetDept, rowDept) {
  const d = String(rowDept || '').trim().toLowerCase();
  if (sheetDept === 'Manufacturing' && d) return d.startsWith('edu') ? E : (d.startsWith('med') ? M : F);
  return sheetDept;
}

module.exports = { RULES, deptOf };

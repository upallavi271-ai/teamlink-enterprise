// ---------------------------------------------------------------------------
// LOCATION MATCHING — "which candidates are in this requirement's city, and
// which open requirements are in this candidate's city" (user notes #6).
//
// The data is typed by hand, so one city arrives in many spellings and very
// often as a locality instead of the city: "Hyderabad", "HYDERABAD", "Hyd",
// "Hydrabad", "Secunderabad", "Kukatpally", "KPHB", "Bachupally, Hyderabad",
// "Kandlakoya (V), Medchal Road". Comparing the raw strings would put most of
// Hyderabad in a dozen different cities. So every location is reduced to the
// CITY (metro) it belongs to:
//
//   cityKeysOf("Kukatpally, Hyderabad")    -> ["hyderabad"]
//   cityKeysOf("Bachupally, Khammam")      -> ["hyderabad", "khammam"]  (multi)
//   cityKeysOf("Banglore")                 -> ["bengaluru"]
//
// A location that is not in the alias table keeps its own cleaned spelling as
// its key, so two "Gajwel"s still meet; a bare state ("Telangana", "Kerala")
// is not a city and matches nothing — counting a whole state as "in the same
// location" would be meaningless.
//
// Results are cached per raw string: the same few thousand distinct values are
// asked about again on every request, and the answer never changes.
// ---------------------------------------------------------------------------

// canonical city -> every spelling / locality that means it. Keys are compared
// with everything but letters removed ("L.B. Nagar" = "lbnagar").
const CITY_ALIASES = {
  Hyderabad: [
    'hyderabad', 'hyd', 'hydrabad', 'hyderbad', 'hyderabadtelangana', 'hyderabd', 'hydearbad', 'secunderabad',
    'secunderbad', 'secundrabad', 'cyberabad', 'ghmc', 'rangareddy', 'rangareddi', 'medchalmalkajgiri',
    'uppal', 'kukatpally', 'kukatpalli', 'kphb', 'kphbcolony', 'gachibowli', 'medchal', 'medchalroad', 'kompally',
    'miyapur', 'ameerpet', 'lbnagar', 'mehdipatnam', 'bachupally', 'bachupalli', 'begumpet', 'banjarahills',
    'bangarahills', 'jubileehills', 'madhapur', 'hitechcity', 'hitec', 'hiteccity', 'kondapur', 'dilsukhnagar',
    'kandlakoya', 'kandlakoyav', 'moinabad', 'ibrahimpatnam', 'himayathsagar', 'himayatsagar', 'himayathnagar',
    'himayatnagar', 'gandipet', 'ghatkesar', 'nampally', 'punjagutta', 'punjagunta', 'abids', 'filmnagar',
    'chandrayangutta', 'chikkadapally', 'chikkadpally', 'shamshabad', 'manikonda', 'nizampet', 'bowenpally',
    'alwal', 'malkajgiri', 'tarnaka', 'habsiguda', 'ecil', 'kushaiguda', 'sainikpuri', 'asraonagar', 'attapur',
    'tolichowki', 'somajiguda', 'khairatabad', 'lakdikapul', 'koti', 'charminar', 'rajendranagar', 'shamirpet',
    'patancheru', 'bhel', 'lingampally', 'chandanagar', 'serilingampally', 'nanakramguda', 'financialdistrict',
    'narsingi', 'kokapet', 'boduppal', 'peerzadiguda', 'nagole', 'vanasthalipuram', 'hayathnagar', 'hayatnagar',
    'saroornagar', 'kothapet', 'malakpet', 'santoshnagar', 'balanagar', 'jeedimetla', 'quthbullapur',
    'qutubullapur', 'suchitra', 'dundigal', 'gajularamaram', 'pragathinagar', 'hafeezpet', 'yousufguda',
    'srnagar', 'erragadda', 'sanathnagar', 'moosapet', 'borabanda', 'kapra', 'keesara', 'medipally', 'neredmet',
    'yapral', 'trimulgherry', 'marredpally', 'paradise', 'musheerabad', 'amberpet', 'barkatpura', 'narayanguda',
    'kachiguda', 'chaderghat', 'saidabad', 'champapet', 'karmanghat', 'bnreddynagar', 'meerpet', 'badangpet',
    'adibatla', 'pocharam', 'hayathnagarmandal', 'shankarpally', 'tellapur', 'ameenpur', 'beeramguda', 'isnapur',
    'kollur', 'gowlidoddy', 'raidurg', 'raidurgam', 'shaikpet', 'mallapur', 'nacharam', 'chengicherla',
    'jawaharnagar', 'dammaiguda', 'nagaram', 'kismatpur', 'bandlaguda', 'puppalaguda', 'kukatpallyhousingboard',
  ],
  Bengaluru: [
    'bengaluru', 'bangalore', 'banglore', 'bangaluru', 'bengalore', 'bangalor', 'blr', 'bengaluu', 'bangalur',
    'whitefield', 'electroniccity', 'koramangala', 'hsrlayout', 'marathahalli', 'btmlayout', 'btm', 'jayanagar',
    'indiranagar', 'hebbal', 'yelahanka', 'jpnagar', 'bellandur', 'sarjapur', 'banashankari', 'rajajinagar',
    'malleshwaram', 'yeshwanthpur', 'kengeri', 'bommanahalli', 'mahadevapura', 'krpuram',
  ],
  Visakhapatnam: ['visakhapatnam', 'vishakapatnam', 'vishakhapatnam', 'visakapatnam', 'vizag', 'vskp', 'gajuwaka'],
  Vijayawada: ['vijayawada', 'vijaywada', 'bezawada', 'vijayawda', 'benzcircle'],
  Chennai: ['chennai', 'madras', 'chenai', 'tambaram', 'guindy', 'velachery', 'omr', 'porur', 'annanagar', 'tnagar', 'adyar'],
  Mumbai: ['mumbai', 'bombay', 'navimumbai', 'andheri', 'powai', 'bandra', 'vashi', 'borivali', 'goregaon', 'malad', 'kurla'],
  Delhi: ['delhi', 'newdelhi', 'ndelhi', 'dilli'],
  Gurugram: ['gurugram', 'gurgaon', 'gurgoan'],
  Noida: ['noida', 'greaternoida', 'noidaextension'],
  Kolkata: ['kolkata', 'calcutta', 'kolkatta', 'saltlake', 'howrah'],
  Pune: ['pune', 'poona', 'hinjewadi', 'hinjawadi', 'kharadi', 'wakad', 'pimprichinchwad', 'hadapsar', 'magarpatta', 'baner'],
  Mysuru: ['mysuru', 'mysore'],
  Warangal: ['warangal', 'hanamkonda', 'hanumakonda', 'kazipet'],
  Tirupati: ['tirupati', 'tirupathi'],
  Kochi: ['kochi', 'cochin', 'ernakulam'],
  Thiruvananthapuram: ['thiruvananthapuram', 'trivandrum'],
  Karimnagar: ['karimnagar', 'karimnagr'],
  Khammam: ['khammam'],
  Guntur: ['guntur'],
  Nellore: ['nellore', 'nelluru'],
  Kurnool: ['kurnool', 'karnool'],
  Kakinada: ['kakinada'],
  Rajahmundry: ['rajahmundry', 'rajamahendravaram', 'rajamundry'],
  Coimbatore: ['coimbatore', 'kovai'],
  Ahmedabad: ['ahmedabad', 'ahmadabad'],
  Nagpur: ['nagpur'],
  Indore: ['indore'],
  Bhopal: ['bhopal'],
};

// A bare state or country is not a location anyone can be "in" for matching.
const NOT_A_CITY = new Set([
  'telangana', 'telengana', 'telagana', 'andhrapradesh', 'ap', 'ts', 'karnataka', 'kerala', 'tamilnadu', 'tn',
  'maharashtra', 'maharastra', 'westbengal', 'wb', 'mp', 'madhyapradesh', 'up', 'uttarpradesh', 'odisha', 'orissa',
  'bihar', 'assam', 'gujarat', 'rajasthan', 'punjab', 'haryana', 'goa', 'india', 'ind', 'any', 'anywhere',
  'anylocation', 'pan india', 'panindia', 'remote', 'wfh', 'workfromhome', 'na', 'nil', 'none', 'other', 'others',
  'v', 'dist', 'district', 'mandal', 'road', 'rd',
]);

const ALIAS_TO_CITY = new Map();
Object.entries(CITY_ALIASES).forEach(([city, aliases]) => {
  ALIAS_TO_CITY.set(city.toLowerCase().replace(/[^a-z]/g, ''), city);
  aliases.forEach((a) => ALIAS_TO_CITY.set(a, city));
});

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const titleCase = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// One comma/slash/"&"/"and"-separated part -> { key, label } or null.
function cityOfPart(part) {
  let p = String(part || '')
    .replace(/\(.*?\)/g, ' ') // "(V)", "(Dist)"
    .replace(/\b(dist(rict)?|mandal|near|opp|beside|road|rd)\b\.?/gi, ' ')
    .replace(/[.\-_]+/g, ' ')
    .trim();
  if (!p) return null;
  const whole = squash(p);
  if (!whole || NOT_A_CITY.has(whole)) return null;
  if (ALIAS_TO_CITY.has(whole)) {
    const city = ALIAS_TO_CITY.get(whole);
    return { key: squash(city), label: city };
  }
  // "Kukatpally Hyderabad", "Hyderabad Telangana 500072": any word that is a
  // known city/locality decides it.
  const words = p.split(/\s+/).map(squash).filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n -= 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const k = words.slice(i, i + n).join('');
      if (ALIAS_TO_CITY.has(k)) {
        const city = ALIAS_TO_CITY.get(k);
        return { key: squash(city), label: city };
      }
    }
  }
  p = p.replace(/\d+/g, ' ').trim();
  const key = squash(p);
  if (!key || key.length < 3 || NOT_A_CITY.has(key)) return null;
  return { key, label: titleCase(p) };
}

const cache = new Map();
const CACHE_MAX = 50000;

// Every city a location string names, de-duplicated: [{ key, label }].
function citiesOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (cache.has(s)) return cache.get(s);
  const seen = new Map();
  s.split(/[,;/|&+]|\band\b|\bor\b/i).forEach((part) => {
    const c = cityOfPart(part);
    if (c && !seen.has(c.key)) seen.set(c.key, c);
  });
  const out = [...seen.values()];
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(s, out);
  return out;
}

const cityKeysOf = (raw) => citiesOf(raw).map((c) => c.key);

// The cities a candidate can be matched on: where they are now and where they
// would like to work ("Any" names no city, so it matches nothing).
function candidateCities(candidate) {
  const seen = new Map();
  [candidate && candidate.location, candidate && candidate.preferredLocation].forEach((v) => {
    citiesOf(v).forEach((c) => { if (!seen.has(c.key)) seen.set(c.key, c); });
  });
  return [...seen.values()];
}

// Given the distinct values of a location column (from a groupBy), the raw
// values that fall in any of `keys` — used to turn a city into an `in: [...]`
// filter the database can use, instead of scanning every row in JavaScript.
function valuesInCities(distinctValues, keys) {
  const want = new Set(keys);
  return distinctValues.filter((v) => v && cityKeysOf(v).some((k) => want.has(k)));
}

module.exports = { citiesOf, cityKeysOf, candidateCities, valuesInCities, CITY_ALIASES };

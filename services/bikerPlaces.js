// services/bikerPlaces.js
// ═════════════════════════════════════════════════════════════════════════════
// Zimbabwe place → city detection for ZimQuote Bikers.
// ─────────────────────────────────────────────────────────────────────────────
// Customers type "Collect order, CBD to Belgravia". Belgravia is obviously
// Harare, so we should NOT ask "Which city?". This module knows the common
// suburbs, townships and landmarks of Zimbabwe's towns and resolves the city.
//
//   detectCity("CBD to Belgravia")            → { city: "Harare", sure: true }
//   detectCity("Hillside to town")            → { city: null, options: ["Harare","Bulawayo",...] }
//   detectCity("Hillside to town", "Bulawayo")→ { city: "Bulawayo", sure: true }  (last city breaks ties)
//
// Names that exist in more than one town (Hillside, Morningside, Ascot, Msasa,
// Riverside, Kopje...) are detected automatically and treated as ambiguous.
// Generic words (CBD, town, city centre) never decide a city on their own.
//
// To add a place: put it in the right city array below (lowercase). That's it.
// ═════════════════════════════════════════════════════════════════════════════

const PLACES = {
  Harare: [
    // CBD / landmarks
    "harare", "hre", "harare cbd", "joina city", "eastgate", "copacabana", "market square",
    "fourth street", "4th street", "mbare musika", "musika", "machipisa", "parirenyatwa",
    "parirenyatwa hospital", "harare hospital", "uz", "university of zimbabwe", "rgm airport",
    "harare airport", "sam levy", "sam levys", "borrowdale village", "westgate", "avondale shops",
    "chisipite shops", "highland park", "arundel village", "newlands shopping centre", "bond street",
    "kopje plaza", "the avenues", "avenues", "a1 mall",
    // Northern suburbs
    "avondale", "belgravia", "milton park", "borrowdale", "borrowdale brooke", "mount pleasant",
    "mt pleasant", "mt p", "marlborough", "vainona", "pomona", "greystone park", "emerald hill",
    "bluff hill", "avonlea", "mabelreign", "meyrick park", "northwood", "mt hampden", "mount hampden",
    "gun hill", "alexandra park", "newlands", "highlands", "chisipite", "colne valley", "glen lorne",
    "hogerty hill", "ballantyne park", "mandara", "greendale", "eastlea", "arcadia", "braeside",
    "queensdale", "belvedere", "strathaven", "tynwald", "haig park", "ashdown park", "sentosa",
    "bloomingdale", "madokero", "cranborne", "philadelphia", "crowborough", "marimba park",
    "kensington", "msasa", "msasa park", "kopje", "athlone", "lewisam", "rolf valley", "carrick creagh", "helensvale",
    "philadelphia", "monavale", "harare gardens", "mabvazuva",
    // Southern / western / high-density
    "mbare", "highfield", "highfields", "glen view", "glenview", "glen norah", "glennorah", "budiriro",
    "kuwadzana", "kwadzana", "dzivarasekwa", "dzivaresekwa", "warren park", "mufakose", "kambuzuma",
    "rugare", "lochinvar", "southerton", "workington", "ardbennie", "hopley", "southlea park",
    "waterfalls", "hatfield", "prospect", "parktown", "mainway meadows", "malvern", "logan park",
    "houghton park", "sunningdale", "graniteside", "willowvale", "coronation park", "mabvuku", "tafara",
    "caledonia", "cranborne park", "glen view 7", "kuwadzana extension", "crowborough north",
    "snake park", "whitecliff", "goodhope", "good hope", "letombo", "harare south", "retreat",
    "eyecourt", "ushewokunze", "stoneridge", "granary", "budiriro 5", "warren hills"
  ],
  Chitungwiza: [
    "chitungwiza", "chi town", "chitown", "ctown", "zengeza", "seke", "st marys", "st mary s",
    "makoni", "manyame park", "unit l", "unit k", "unit m", "unit o", "unit p", "unit j", "unit n",
    "chikwanha", "zengeza 3", "zengeza 4", "huruyadzo"
  ],
  Epworth: ["epworth", "domboramwari", "overspill", "chizungu", "makomo"],
  Ruwa: ["ruwa", "zimre park", "damofalls", "damafalls", "windsor park ruwa", "springvale"],
  Norton: ["norton", "katanga", "knowe", "ngoni", "galloway"],
  Bulawayo: [
    "bulawayo", "byo", "bulawayo cbd", "egodini", "nust", "mpilo", "united bulawayo hospitals", "ubh",
    "bradfield", "kumalo", "famona", "suburbs", "parklands", "burnside", "killarney", "paddonhurst",
    "northend", "north end", "barham green", "romney park", "lobengula", "nkulumane", "entumbane",
    "pumula", "magwegwe", "cowdray park", "emakhandeni", "luveve", "njube", "mzilikazi", "makokoba",
    "sizinda", "tshabalala", "nketa", "emganwini", "mganwini", "mpopoma", "pelandaba", "gwabalanda",
    "mabutweni", "bellevue", "selborne park", "belmont", "raylton", "mahatshula", "woodville",
    "montrose", "glencoe", "sauerstown", "ilanda", "matsheumhlope", "queens park", "eloana",
    "hyde park", "kenilworth", "tegela", "lochview", "fortunes gate", "iminyela", "thorngrove",
    "westondale", "newton west", "emhlangeni", "old magwegwe", "robert sinyoka", "emthunzini",
    "hillside", "morningside", "ascot", "riverside", "khumalo", "nkulumane 12", "old pumula",
    "pumula south", "luveve 5", "lobengula west", "mpopoma south"
  ],
  Mutare: [
    "mutare", "sakubva", "dangamvura", "chikanga", "hobhouse", "fairbridge park", "murambi",
    "palmerstone", "yeovil", "greenside", "darlington", "bordervale", "tigers kloof", "florida",
    "morningside", "westlea", "fern valley", "weirmouth", "natview park", "meikles park"
  ],
  Gweru: [
    "gweru", "msu", "mkoba", "senga", "mtapa", "mambo", "ascot", "southview", "nehosho", "ivene",
    "lundi park", "riverside", "daylesford", "clydesdale park", "woodlands", "windsor park",
    "kopje", "nashville", "northlea", "brackenhurst", "ridgemont"
  ],
  Masvingo: [
    "masvingo", "mucheke", "rujeko", "runyararo", "rhodene", "victoria ranch", "clipsham", "eastvale",
    "hillside", "target kopje"
  ],
  Kwekwe: ["kwekwe", "mbizo", "amaveni", "redcliff", "fitchley", "newtown", "msasa", "garikai", "torwood"],
  Kadoma: ["kadoma", "rimuka", "waverley", "ngezi", "westview", "eiffel flats"],
  Marondera: ["marondera", "dombotombo", "nyameni", "cherutombo", "rusike", "paradise park"],
  Bindura: ["bindura", "chipadze", "chiwaridzo", "aerodrome bindura"],
  Chinhoyi: ["chinhoyi", "chikonohono", "gadzema", "hunyani", "brundish", "mzari", "coldstream"],
  "Victoria Falls": ["victoria falls", "vic falls", "vicfalls", "chinotimba", "mkhosana"],
  Chegutu: ["chegutu", "pfupajena", "kaguvi"],
  Zvishavane: ["zvishavane", "mandava", "maglas"],
  Beitbridge: ["beitbridge", "dulivhadzimu"],
  Hwange: ["hwange", "lwendulu", "empumalanga"],
  Kariba: ["kariba", "nyamhunga", "mahombekombe"]
};

// Towns served by the same pool of riders (a Chitungwiza rider can take a
// Harare job and vice versa). The first entry is the "metro" name.
const METROS = [
  ["Harare", "Chitungwiza", "Epworth", "Ruwa", "Norton"]
];

// Words that appear in every town - never decide a city by themselves.
const GENERIC = new Set(["cbd", "town", "city", "city centre", "centre", "center", "mall", "rank", "hospital", "airport", "station", "kumba", "home", "work", "office"]);

// ── Build lookup: name → Set(cities) ─────────────────────────────────────────
function norm(s = "") {
  return String(s).toLowerCase().replace(/['’]/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const NAME_TO_CITIES = new Map();
for (const [city, names] of Object.entries(PLACES)) {
  for (const n of names) {
    const k = norm(n);
    if (!k || GENERIC.has(k)) continue;
    if (!NAME_TO_CITIES.has(k)) NAME_TO_CITIES.set(k, new Set());
    NAME_TO_CITIES.get(k).add(city);
  }
}
// Longest names first so "glen view" wins over "view", "mount pleasant" over "mount".
const NAMES_SORTED = [...NAME_TO_CITIES.keys()].sort((a, b) => b.length - a.length);

export const KNOWN_CITIES = Object.keys(PLACES);

// Which places appear in a piece of text? Returns [{ name, cities:[...] }].
export function findPlaces(text = "") {
  let hay = ` ${norm(text)} `;
  const hits = [];
  for (const name of NAMES_SORTED) {
    const needle = ` ${name} `;
    const at = hay.indexOf(needle);
    if (at >= 0) {
      hits.push({ name, at, cities: [...NAME_TO_CITIES.get(name)] });
      // consume (keep length so positions stay valid) so shorter names don't double-hit
      hay = hay.split(needle).join(" " + "|".repeat(name.length) + " ");
    }
  }
  return hits.sort((a, b) => a.at - b.at);   // pickup side first
}

// Is this text a known place (exactly / as a suffix)? Used to split "parcel Mbare".
export function isKnownPlace(text = "") {
  return NAME_TO_CITIES.has(norm(text));
}

/**
 * Work out the city for a trip.
 * @param {string} text      pickup + dropoff (+ task) text
 * @param {string} lastCity  the customer's last used city (tie-breaker), optional
 * @returns {{ city: string|null, sure: boolean, options: string[] }}
 */
export function detectCity(text = "", lastCity = "") {
  const hits = findPlaces(text);
  if (!hits.length) return { city: null, sure: false, options: [] };

  // 1) Places that belong to exactly one town decide it (first one wins = pickup side).
  const unique = hits.filter(h => h.cities.length === 1);
  if (unique.length) return { city: unique[0].cities[0], sure: true, options: [] };

  // 2) Only ambiguous names: intersect their towns.
  let inter = new Set(hits[0].cities);
  for (const h of hits.slice(1)) inter = new Set([...inter].filter(c => h.cities.includes(c)));
  const pool = inter.size ? [...inter] : [...new Set(hits.flatMap(h => h.cities))];
  const lc = String(lastCity || "").trim().toLowerCase();
  const fromLast = pool.find(c => c.toLowerCase() === lc);
  if (fromLast) return { city: fromLast, sure: true, options: pool };
  if (pool.length === 1) return { city: pool[0], sure: true, options: pool };
  return { city: null, sure: false, options: pool };
}

// Metro grouping: all town names that share riders with `city` (lowercase).
export function metroGroup(city = "") {
  const c = String(city || "").trim().toLowerCase();
  const m = METROS.find(g => g.some(x => x.toLowerCase() === c));
  return m ? m.map(x => x.toLowerCase()) : (c ? [c] : []);
}

export function sameMetro(a = "", b = "") {
  return metroGroup(a).includes(String(b || "").trim().toLowerCase());
}

// ── Route parsing ────────────────────────────────────────────────────────────
// Accepts English and Shona/Ndebele-ish forms:
//   "Collect documents, CBD to Avondale"
//   "deliver cake from Avondale to Borrowdale"
//   "parcel Mbare to Highfield"        (place-aware split)
//   "CBD → Avondale" / "CBD -> Avondale" / "CBD - Avondale"
//   "kubva ku Mbare kuenda ku Highfield"   (Shona)
//   "ukusuka eNkulumane ukuya eCBD"        (Ndebele - basic)
const ARROW = /\s*(?:→|->|=>|➡️|➡)\s*|\s+[-–]\s+|\s+to\s+|\s+kuenda\s+ku\s*|\s+kuenda\s+|\s+ukuya\s+e?/i;

function _clean(s = "") {
  return String(s).replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").trim().slice(0, 120);
}

// "CBD to Avondale" → { pickup, dropoff }
export function splitRoute(raw = "") {
  const s = String(raw || "").trim()
    .replace(/^(from|kubva\s+ku|kubva|ukusuka\s+e?|ukusuka)\s+/i, "");
  const parts = s.split(ARROW).map(_clean).filter(Boolean);
  if (parts.length >= 2) return { pickup: parts[0], dropoff: parts.slice(1).join(" to ").slice(0, 120) };
  return { pickup: "", dropoff: "" };
}

// Split the left side "parcel Mbare" into task="parcel", place="Mbare" using known places.
function _splitTaskPlace(left = "") {
  const words = String(left).trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {         // longest suffix first
    const tail = words.slice(i).join(" ");
    if (isKnownPlace(tail) || GENERIC.has(norm(tail))) {
      return { task: words.slice(0, i).join(" "), place: tail };
    }
  }
  return { task: "", place: "" };
}

/**
 * One combined message → { task, pickup, dropoff }.
 * Empty pickup/dropoff means the route was not found.
 */
export function parseWhatWhere(raw = "") {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { task: "", pickup: "", dropoff: "" };

  // a) "<task>, <route>"
  if (s.includes(",")) {
    const i = s.indexOf(",");
    const task = _clean(s.slice(0, i));
    const r = splitRoute(s.slice(i + 1));
    if (r.pickup && r.dropoff) return { task: task.slice(0, 200), ...r };
  }

  // b) "<task> from X to Y"  /  "<task> kubva ku X kuenda ku Y"
  const m = s.match(/^(.*?)\b(?:from|kubva\s+ku|kubva|ukusuka)\s+(.+)$/i);
  if (m) {
    const r = splitRoute(m[2]);
    if (r.pickup && r.dropoff) return { task: _clean(m[1]).slice(0, 200) || "Delivery", ...r };
  }

  // c) "<task> <Place> to <Place>"  (no comma / no "from")
  const r = splitRoute(s);
  if (r.pickup && r.dropoff) {
    const { task, place } = _splitTaskPlace(r.pickup);
    if (place) return { task: _clean(task).slice(0, 200) || "Delivery", pickup: _clean(place), dropoff: r.dropoff };
    // unknown left side: treat it all as the pickup, task stays general
    return { task: "Delivery", pickup: r.pickup, dropoff: r.dropoff };
  }

  return { task: _clean(s).slice(0, 200), pickup: "", dropoff: "" };
}

export default { detectCity, findPlaces, metroGroup, sameMetro, splitRoute, parseWhatWhere, KNOWN_CITIES };
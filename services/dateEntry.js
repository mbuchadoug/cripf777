// services/dateEntry.js
// ─────────────────────────────────────────────────────────────────────────────
// Reusable, dependency-free date entry for the WhatsApp accounting bot.
//
// WhatsApp has no native date picker, so "easy & fast to enter or select" means:
//   • quick-reply buttons for the common cases (Today / Yesterday)
//   • forgiving free-text typing with clear examples
//   • a friendly preview label so the user can spot & fix mistakes
//
// Zimbabwe-friendly: dates are read DAY-FIRST (12/08 = 12 August), never US
// month-first. Everything here is pure — no models, no side effects — so it can
// be imported anywhere (receipts, invoices, expenses, income) with zero risk.
// ─────────────────────────────────────────────────────────────────────────────

const DOW   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON   = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = {
  jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11,
  january:0, february:1, march:2, april:3, june:5, july:6, august:7,
  september:8, october:9, november:10, december:11,
};

function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function valid(d) { return d instanceof Date && !isNaN(d.getTime()); }

/** "Tue 12 Aug 2026" */
export function formatDateLabel(d) {
  if (!valid(d)) return "";
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

/** Short ISO yyyy-mm-dd (stable for storing in session / Mongo). */
export function toISODate(d) {
  if (!valid(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Parse a human date string into a normalised result, or null if unreadable.
 * Returns { date, label, iso, future } where `future` flags a date after today
 * (usually a typo when recording something that already happened).
 *
 * Accepts: today | yesterday | tomorrow | "N days ago" | 12/08 | 12-08-2026 |
 *          12/8/26 | 2026-08-12 | "12 Aug" | "Aug 12" | "12 August 2026" | 12
 */
export function parseDateInput(input, now = new Date()) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const today = midnight(now);
  const wrap = (dt) => (valid(dt) ? { date: dt, label: formatDateLabel(dt), iso: toISODate(dt), future: dt > today } : null);
  const mk = (y, m, d) => {
    const dt = new Date(y, m, d);
    // reject overflow like 31/02 silently rolling into March
    return (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) ? dt : null;
  };

  if (["today", "tdy", "now", "2day"].includes(s)) return wrap(today);
  if (["yesterday", "yst", "yda", "yter"].includes(s)) return wrap(addDays(today, -1));
  if (["tomorrow", "tmr", "tom"].includes(s)) return wrap(addDays(today, 1));

  let m = s.match(/^(\d{1,3})\s*(?:days?|d)\s*(?:ago|back)$/);
  if (m) return wrap(addDays(today, -parseInt(m[1], 10)));

  // ISO yyyy-mm-dd
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return wrap(mk(+m[1], +m[2] - 1, +m[3]));

  // DAY-first  dd/mm  |  dd/mm/yyyy  |  dd/mm/yy
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (m) {
    let d = +m[1], mo = +m[2], y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return wrap(mk(y, mo - 1, d));
  }

  // "12 aug [2026]"
  m = s.match(/^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/);
  if (m && MONTHS[m[2]] != null) return wrap(mk(m[3] ? +m[3] : now.getFullYear(), MONTHS[m[2]], +m[1]));

  // "aug 12 [2026]"
  m = s.match(/^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/);
  if (m && MONTHS[m[1]] != null) return wrap(mk(m[3] ? +m[3] : now.getFullYear(), MONTHS[m[1]], +m[2]));

  // bare day number -> this month
  m = s.match(/^(\d{1,2})$/);
  if (m) { const d = +m[1]; if (d >= 1 && d <= 31) return wrap(mk(now.getFullYear(), now.getMonth(), d)); }

  return null;
}

/** Extract a date from the END of a free-text line and return the split parts. */
/** e.g. "fuel 20 yesterday" -> { rest:"fuel 20", parsed:{...} }. If none, parsed=null. */
export function extractTrailingDate(text, now = new Date()) {
  if (!text) return { rest: text, parsed: null };
  const raw = String(text).trim();

  // Try progressively longer tails (up to 3 words) as a date phrase.
  const words = raw.split(/\s+/);
  for (let take = Math.min(3, words.length); take >= 1; take--) {
    const tail = words.slice(words.length - take).join(" ");
    const parsed = parseDateInput(tail, now);
    if (parsed) {
      const rest = words.slice(0, words.length - take).join(" ").trim();
      if (rest) return { rest, parsed };   // keep something before the date
    }
  }
  return { rest: raw, parsed: null };
}

/** One-line examples string for prompts. */
export function dateExamplesText() {
  return "Type a date like *today*, *yesterday*, *12/08*, *12 Aug*, or *3 days ago*.";
}

/**
 * A full list of every month shortcode / numeric prefix, with examples — handy
 * to show under the date prompt so the user knows exactly what they can type.
 * Renders (day-first, so 12/08 = 12 August):
 *
 *   🗓️ Months you can type (day-first, e.g. 12/08 = 12 Aug):
 *   Jan (01) · Feb (02) · Mar (03) · Apr (04)
 *   May (05) · Jun (06) · Jul (07) · Aug (08)
 *   Sep (09) · Oct (10) · Nov (11) · Dec (12)
 *
 *   Examples: 12 Jan · 5 Feb · 30 Mar · 1 Dec 2026
 */
export function monthShortcodesText() {
  const rows = [];
  for (let i = 0; i < 12; i += 4) {
    rows.push(
      MON.slice(i, i + 4)
        .map((m, k) => `${m} (${String(i + k + 1).padStart(2, "0")})`)
        .join(" · ")
    );
  }
  return (
    "🗓️ *Months you can type* (day-first, e.g. 12/08 = 12 Aug):\n" +
    rows.join("\n") +
    "\n\nExamples: *12 Jan* · *5 Feb* · *30 Mar* · *1 Dec 2026*"
  );
}

/** Quick-reply buttons. Caller registers these ids (see wiring notes). */
export function dateQuickButtons(prefix = "docdate") {
  return [
    { id: `${prefix}_today`,     title: "📅 Today" },
    { id: `${prefix}_yesterday`, title: "⬅️ Yesterday" },
    { id: `${prefix}_type`,      title: "⌨️ Type a date" },
  ];
}

/** Friendly preview line, e.g. "📅 Date: Tue 12 Aug 2026 (today)". */
export function previewDateLine(date, now = new Date()) {
  const d = valid(date) ? date : midnight(now);
  const today = midnight(now);
  let suffix = "";
  if (toISODate(d) === toISODate(today)) suffix = " (today)";
  else if (toISODate(d) === toISODate(addDays(today, -1))) suffix = " (yesterday)";
  return `📅 Date: ${formatDateLabel(d)}${suffix}`;
}

/** Resolve a stored value (ISO string, Date, or null) to a real Date, default today. */
export function resolveDate(value, now = new Date()) {
  if (!value) return midnight(now);
  const d = value instanceof Date ? value : new Date(value);
  return valid(d) ? d : midnight(now);
}

export default {
  parseDateInput,
  extractTrailingDate,
  formatDateLabel,
  toISODate,
  dateExamplesText,
  monthShortcodesText,
  dateQuickButtons,
  previewDateLine,
  resolveDate,
};
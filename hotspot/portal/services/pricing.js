// ==============================
// 💰 PRICING ENGINE  (Zimbabwe cash-friendly)
// Every price is a WHOLE DOLLAR. No cents - Zimbabwe rarely has coins/change
// below $1, so whole-dollar pricing means the bar/reception never struggles
// to give change. Minimum sale is $1.
//
// Benchmarked against Econet USD bundles (2026): 1hr ≈ $1, 2hr ≈ $2. We sell
// TIME on unmetered Starlink, so we match/undercut mobile data while our
// marginal cost per voucher is ~zero (Starlink is a fixed monthly cost).
//
// Design: a simple PRICE TABLE by duration. A custom duration rounds UP to the
// plan that covers it. Extra simultaneous devices add half the base each.
// Tune the table freely - it stays whole-dollar automatically.
// ==============================

export const PRICING = {
  currency: "USD",

  // Duration ceilings → base price (1 device), cheapest first.
  // A voucher of N minutes pays the first row whose maxMin >= N.
  // Tuned to UNDERCUT Econet: 2h = $1 (Econet 2h ≈ $2), etc.
  table: [
    { maxMin: 120,    price: 1  },   // up to 2 hours  → $1   (entry / lunch)
    { maxMin: 300,    price: 2  },   // up to 5 hours  → $2   (evening)
    { maxMin: 1440,   price: 3  },   // up to 1 day    → $3   (day pass)
    { maxMin: 4320,   price: 5  },   // up to 3 days   → $5
    { maxMin: 10080,  price: 6  },   // up to 1 week   → $6   (Econet week ≈ $10+)
    { maxMin: 44640,  price: 20 }    // up to ~1 month → $20  (monthly subscription)
  ],

  // Beyond the table (very long custom passes): $ per extra week on top of $20.
  perExtraWeek: 4,

  extraDevicePct: 0.5,   // each extra simultaneous device adds 50% of base
  minPrice: 1            // never sell below $1
};

function wholeDollar(n) {
  return Math.max(PRICING.minPrice, Math.round(n));
}

// Suggested whole-dollar price for a duration + device count.
export function suggestPrice({ durationMinutes, devices = 1 }) {
  const mins = Math.max(1, Number(durationMinutes) || 0);
  const dev = Math.max(1, Number(devices) || 1);

  let base;
  const row = PRICING.table.find((t) => mins <= t.maxMin);
  if (row) {
    base = row.price;
  } else {
    const weeks = Math.ceil(mins / 10080);
    base = 20 + Math.max(0, weeks - 4) * PRICING.perExtraWeek;   // beyond a month
  }

  const withDevices = base * (1 + (dev - 1) * PRICING.extraDevicePct);
  return {
    price: wholeDollar(withDevices),
    currency: PRICING.currency,
    basePrice: base,
    devices: dev,
    durationMinutes: mins
  };
}

// "Cheaper than mobile data" line for the buy page.
const ECONET_REF = [
  { maxMin: 60,       label: "Econet 1hr bundle ≈ $1" },
  { maxMin: 300,      label: "Econet 2hr bundle ≈ $2" },
  { maxMin: 1440,     label: "a day of Econet bundles ≈ $3–4" },
  { maxMin: 10080,    label: "a week of Econet bundles ≈ $10+" },
  { maxMin: Infinity, label: "a month of Econet bundles ≈ $30+" }
];
export function econetComparison(durationMinutes) {
  const ref = ECONET_REF.find((r) => durationMinutes <= r.maxMin) || ECONET_REF[ECONET_REF.length - 1];
  return ref.label;
}
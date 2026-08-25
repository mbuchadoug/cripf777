/* ============================================================================
   groceryCatalogue.js — the ONE source of truth for grocery prices & fees.
   The website only ever shows estimates; every payable total is recomputed
   here on the server. Update SELLING prices as your sourcing cost moves.
   SELLING price already includes your procurement margin (see MARGIN note).
   ========================================================================== */

// sku: [display name, unit, SELLING price USD]
// SELLING = your sourcing cost x (1 + procurement margin). Keep it profitable.
export const CATALOGUE = {
  mealie_meal:  ["Mealie meal", "10kg", 6.50],
  cooking_oil:  ["Cooking oil", "2L", 4.30],
  sugar:        ["Sugar", "2kg", 2.70],
  rice:         ["Rice", "2kg", 3.20],
  flour:        ["Flour", "2kg", 2.20],
  bread:        ["Bread", "loaf", 1.10],
  salt:         ["Salt", "1kg", 0.70],
  beans:        ["Dried beans", "1kg", 2.20],
  chicken:      ["Chicken", "2kg", 6.50],
  beef:         ["Beef / meat", "1kg", 7.00],
  kapenta:      ["Kapenta / matemba", "500g", 3.20],
  eggs:         ["Eggs", "tray of 30", 5.30],
  milk:         ["Milk", "1L / powder", 1.60],
  peanut_butter:["Peanut butter", "375g", 2.20],
  veg:          ["Vegetables", "bundle", 1.10],
  tomatoes:     ["Tomatoes", "bundle", 1.10],
  onions:       ["Onions", "bundle", 1.10],
  potatoes:     ["Potatoes", "pocket", 4.30],
  washing:      ["Washing powder / soap", "2kg", 2.70],
  bathsoap:     ["Bath soap", "pack", 1.60],
  toothpaste:   ["Toothpaste", "tube", 1.60],
  toiletpaper:  ["Toilet paper", "pack", 2.20],
  tea:          ["Tea / coffee", "250g", 2.20]
};

// Delivery zones from Harare CBD — flat fees set ABOVE real rider fuel+time.
export const ZONES = {
  cbd:   { label: "CBD / Avenues / inner (≤5km)", fee: 3 },
  mid:   { label: "Mid suburbs (Borrowdale, Waterfalls, Mbare, Highfield…)", fee: 5 },
  outer: { label: "Outer / Chitungwiza / Norton edge (12–25km)", fee: 8 }
};

export const MIN_GOODS = 20;          // minimum goods value to dispatch a delivery
export const SERVICE_MIN = 2;         // service fee floor (USD)
export const SERVICE_PCT = 0.05;      // 5% of goods

/**
 * Recompute an order's money server-side from trusted catalogue + zone.
 * @param {Array} clientItems  [{ sku, name, unit, qty, custom }]
 * @param {String} zone        cbd | mid | outer
 * @returns {{items, amounts, hasCustomItems, payableNow, errors}}
 */
export function priceOrder(clientItems, zone) {
  const errors = [];
  const items = [];
  let goods = 0;
  let hasCustomItems = false;

  for (const raw of (clientItems || [])) {
    const qty = Math.max(1, parseInt(raw.qty, 10) || 1);

    if (raw.custom || !CATALOGUE[raw.sku]) {
      // custom / not-in-catalogue item — no price yet
      hasCustomItems = true;
      items.push({
        sku: null,
        name: String(raw.name || "Custom item").slice(0, 80),
        unit: String(raw.unit || "").slice(0, 24),
        qty,
        unitPrice: null,
        lineTotal: 0,
        custom: true
      });
      continue;
    }

    const [name, unit, price] = CATALOGUE[raw.sku];
    const lineTotal = Math.round(price * qty * 100) / 100;
    goods += lineTotal;
    items.push({ sku: raw.sku, name, unit, qty, unitPrice: price, lineTotal, custom: false });
  }

  goods = Math.round(goods * 100) / 100;

  const zoneDef = ZONES[zone];
  if (!zoneDef) errors.push("Please choose a valid delivery zone.");

  // Enforce minimum on catalogue goods (custom items are priced later).
  if (goods > 0 && goods < MIN_GOODS && !hasCustomItems) {
    errors.push(`Minimum order is $${MIN_GOODS} of goods (yours is $${goods.toFixed(2)}).`);
  }
  if (items.length === 0) errors.push("Your basket is empty.");

  const serviceFee = goods > 0 ? Math.max(SERVICE_MIN, Math.round(goods * SERVICE_PCT * 100) / 100) : SERVICE_MIN;
  const deliveryFee = zoneDef ? zoneDef.fee : 0;
  const total = Math.round((goods + serviceFee + deliveryFee) * 100) / 100;

  // Orders with custom items are NOT payable until an admin prices them.
  const payableNow = !hasCustomItems && errors.length === 0;

  return {
    items,
    hasCustomItems,
    amounts: { goods, serviceFee, deliveryFee, total, currency: "USD" },
    payableNow,
    errors
  };
}

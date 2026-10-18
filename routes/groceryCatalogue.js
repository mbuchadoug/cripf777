/* ============================================================================
   groceryCatalogue.js - the ONE source of truth for grocery prices & fees.
   The website only ever shows estimates; every payable total is recomputed
   here on the server, so no browser can ever underpay.
   SELLING price already includes your procurement margin.
   Prices reviewed: 2026-10-15 (fuel + cost increases; min order raised to $30).
   Update SELLING prices here as your sourcing cost moves - the whole system follows.
   ========================================================================== */

// sku: [display name, unit, SELLING price USD]
export const CATALOGUE = {
  mealie_meal:   ["Mealie meal", "10kg", 8.50],
  roller_meal:   ["Roller meal", "10kg", 7.50],
  rice:          ["Rice", "2kg", 3.60],
  flour:         ["Flour", "2kg", 2.60],
  self_raising:  ["Self-raising flour", "2kg", 3.00],
  macaroni:      ["Macaroni / pasta", "500g", 1.80],
  spaghetti:     ["Spaghetti", "500g", 1.80],
  samp:          ["Samp", "1kg", 2.20],
  sugar:         ["Sugar", "2kg", 3.60],
  salt:          ["Salt", "1kg", 1.00],
  cooking_oil:   ["Cooking oil", "2L", 4.90],
  bread:         ["Bread", "loaf", 1.30],
  chicken:       ["Chicken", "2kg", 7.50],
  drumsticks:    ["Chicken drumsticks", "2kg", 14.00],
  beef:          ["Beef / meat", "1kg", 8.80],
  mince:         ["Beef mince", "1kg", 7.80],
  pork:          ["Pork", "1kg", 7.50],
  sausages:      ["Sausages / boerewors", "1kg", 6.50],
  polony:        ["Polony", "750g", 3.00],
  kapenta:       ["Kapenta / matemba", "500g", 3.90],
  fish:          ["Fish (frozen)", "1kg", 5.50],
  pilchards:     ["Canned pilchards", "400g", 2.30],
  beans:         ["Dried beans", "1kg", 2.70],
  veg:           ["Vegetables (covo/rape)", "bundle", 1.50],
  tomatoes:      ["Tomatoes", "bundle", 1.50],
  onions:        ["Onions", "bundle", 1.50],
  potatoes:      ["Potatoes", "pocket", 6.00],
  cabbage:       ["Cabbage", "head", 1.40],
  carrots:       ["Carrots", "pack", 1.70],
  butternut:     ["Butternut", "each", 1.90],
  bananas:       ["Bananas", "bunch", 2.00],
  apples:        ["Apples", "pack", 3.10],
  oranges:       ["Oranges", "pack", 3.10],
  eggs:          ["Eggs", "tray of 30", 6.20],
  milk:          ["Fresh milk", "2L", 2.70],
  milk_powder:   ["Milk powder", "400g", 4.20],
  margarine:     ["Margarine", "500g", 2.60],
  cheese:        ["Cheese", "250g", 3.60],
  yoghurt:       ["Yoghurt", "500ml", 2.10],
  peanut_butter: ["Peanut butter", "375g", 3.00],
  jam:           ["Jam", "375g", 3.00],
  tomato_sauce:  ["Tomato sauce", "bottle", 2.30],
  mayonnaise:    ["Mayonnaise", "750ml", 3.30],
  soup:          ["Soup / stock cubes", "pack", 1.60],
  cereal:        ["Cereal / cornflakes", "box", 4.30],
  oats:          ["Oats", "1kg", 3.40],
  tea:           ["Tea / coffee", "250g", 2.80],
  juice:         ["Juice / cordial", "2L", 3.10],
  softdrink:     ["Soft drink", "2L", 2.30],
  water:         ["Bottled water", "5L", 1.90],
  mahewu:        ["Mahewu", "pack", 1.60],
  washing:       ["Washing powder", "2kg", 3.40],
  dishwash:      ["Dishwashing liquid", "750ml", 2.50],
  bleach:        ["Bleach (Jik)", "750ml", 2.00],
  bathsoap:      ["Bath soap", "pack", 2.10],
  toiletpaper:   ["Toilet paper", "pack", 2.90],
  matches:       ["Matches / candles", "pack", 1.10],
  toothpaste:    ["Toothpaste", "tube", 2.10],
  vaseline:      ["Vaseline / lotion", "400ml", 3.00],
  roll_on:       ["Roll-on / deodorant", "each", 2.50],
  shampoo:       ["Shampoo", "400ml", 3.20],
  pads:          ["Sanitary pads", "pack", 2.00],
  diapers:       ["Diapers / nappies", "pack", 7.80],
  formula:       ["Baby formula", "400g", 6.50],
  wipes:         ["Baby wipes", "pack", 2.60],
};

// Delivery zones from Harare CBD - flat fees set ABOVE real rider fuel+time.
// Raised 2026-10-15 for higher fuel (CG125 ~$0.85 mid / ~$2 outer round-trip + rider pay).
export const ZONES = {
  cbd:   { label: "CBD / Avenues / inner (≤5km)", fee: 4 },
  mid:   { label: "Mid suburbs (Borrowdale, Waterfalls, Mbare, Highfield…)", fee: 6 },
  outer: { label: "Outer / Chitungwiza / Norton edge (12–25km)", fee: 10 }
};

export const MIN_GOODS = 30;
export const SERVICE_MIN = 3;
export const SERVICE_PCT = 0.05;

export function priceOrder(clientItems, zone) {
  const errors = [];
  const items = [];
  let goods = 0;
  let hasCustomItems = false;
  for (const raw of (clientItems || [])) {
    const qty = Math.max(1, parseInt(raw.qty, 10) || 1);
    if (raw.custom || !CATALOGUE[raw.sku]) {
      hasCustomItems = true;
      items.push({ sku: null, name: String(raw.name || "Custom item").slice(0,80),
        unit: String(raw.unit || "").slice(0,24), qty, unitPrice: null, lineTotal: 0, custom: true });
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
  if (goods > 0 && goods < MIN_GOODS && !hasCustomItems) {
    errors.push(`Minimum order is $${MIN_GOODS} of goods (yours is $${goods.toFixed(2)}).`);
  }
  if (items.length === 0) errors.push("Your basket is empty.");
  const serviceFee = goods > 0 ? Math.max(SERVICE_MIN, Math.round(goods * SERVICE_PCT * 100)/100) : SERVICE_MIN;
  const deliveryFee = zoneDef ? zoneDef.fee : 0;
  const total = Math.round((goods + serviceFee + deliveryFee) * 100) / 100;
  const payableNow = !hasCustomItems && errors.length === 0;
  return { items, hasCustomItems, amounts: { goods, serviceFee, deliveryFee, total, currency: "USD" }, payableNow, errors };
}

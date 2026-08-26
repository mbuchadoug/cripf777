/* ============================================================================
   groceryCatalogue.js - the ONE source of truth for grocery prices & fees.
   The website only ever shows estimates; every payable total is recomputed
   here on the server. Update SELLING prices as your sourcing cost moves.
   SELLING price already includes your procurement margin.
   ========================================================================== */

// sku: [display name, unit, SELLING price USD]
export const CATALOGUE = {
  mealie_meal:   ["Mealie meal", "10kg", 6.50],
  roller_meal:   ["Roller meal", "10kg", 6.00],
  rice:          ["Rice", "2kg", 3.20],
  flour:         ["Flour", "2kg", 2.20],
  self_raising:  ["Self-raising flour", "2kg", 2.40],
  macaroni:      ["Macaroni / pasta", "500g", 1.20],
  spaghetti:     ["Spaghetti", "500g", 1.30],
  samp:          ["Samp", "1kg", 1.80],
  sugar:         ["Sugar", "2kg", 2.70],
  salt:          ["Salt", "1kg", 0.70],
  cooking_oil:   ["Cooking oil", "2L", 4.30],
  bread:         ["Bread", "loaf", 1.10],
  chicken:       ["Chicken", "2kg", 6.50],
  drumsticks:    ["Chicken drumsticks", "2kg", 6.00],
  beef:          ["Beef / meat", "1kg", 7.00],
  mince:         ["Beef mince", "1kg", 6.50],
  pork:          ["Pork", "1kg", 6.50],
  sausages:      ["Sausages / boerewors", "1kg", 5.50],
  polony:        ["Polony", "750g", 2.50],
  kapenta:       ["Kapenta / matemba", "500g", 3.20],
  fish:          ["Fish (frozen)", "1kg", 4.50],
  pilchards:     ["Canned pilchards", "400g", 1.80],
  beans:         ["Dried beans", "1kg", 2.20],
  veg:           ["Vegetables (covo/rape)", "bundle", 1.10],
  tomatoes:      ["Tomatoes", "bundle", 1.10],
  onions:        ["Onions", "bundle", 1.10],
  potatoes:      ["Potatoes", "pocket", 4.30],
  cabbage:       ["Cabbage", "head", 1.00],
  carrots:       ["Carrots", "pack", 1.20],
  butternut:     ["Butternut", "each", 1.50],
  bananas:       ["Bananas", "bunch", 1.50],
  apples:        ["Apples", "pack", 2.50],
  oranges:       ["Oranges", "pack", 2.50],
  eggs:          ["Eggs", "tray of 30", 5.30],
  milk:          ["Fresh milk", "2L", 2.20],
  milk_powder:   ["Milk powder", "400g", 3.50],
  margarine:     ["Margarine", "500g", 1.80],
  cheese:        ["Cheese", "250g", 2.80],
  yoghurt:       ["Yoghurt", "500ml", 1.60],
  peanut_butter: ["Peanut butter", "375g", 2.20],
  jam:           ["Jam", "375g", 2.20],
  tomato_sauce:  ["Tomato sauce", "bottle", 1.80],
  mayonnaise:    ["Mayonnaise", "750ml", 2.60],
  soup:          ["Soup / stock cubes", "pack", 1.20],
  cereal:        ["Cereal / cornflakes", "box", 3.50],
  oats:          ["Oats", "1kg", 2.80],
  tea:           ["Tea / coffee", "250g", 2.20],
  juice:         ["Juice / cordial", "2L", 2.50],
  softdrink:     ["Soft drink", "2L", 1.80],
  water:         ["Bottled water", "5L", 1.50],
  mahewu:        ["Mahewu", "pack", 1.20],
  washing:       ["Washing powder", "2kg", 2.70],
  dishwash:      ["Dishwashing liquid", "750ml", 1.80],
  bleach:        ["Bleach (Jik)", "750ml", 1.50],
  bathsoap:      ["Bath soap", "pack", 1.60],
  toiletpaper:   ["Toilet paper", "pack", 2.20],
  matches:       ["Matches / candles", "pack", 0.80],
  toothpaste:    ["Toothpaste", "tube", 1.60],
  vaseline:      ["Vaseline / lotion", "400ml", 2.20],
  roll_on:       ["Roll-on / deodorant", "each", 1.80],
  shampoo:       ["Shampoo", "400ml", 2.50],
  pads:          ["Sanitary pads", "pack", 1.50],
  diapers:       ["Diapers / nappies", "pack", 6.50],
  formula:       ["Baby formula", "400g", 5.50],
  wipes:         ["Baby wipes", "pack", 2.00]
};

// Delivery zones from Harare CBD - flat fees set ABOVE real rider fuel+time.
export const ZONES = {
  cbd:   { label: "CBD / Avenues / inner (≤5km)", fee: 3 },
  mid:   { label: "Mid suburbs (Borrowdale, Waterfalls, Mbare, Highfield…)", fee: 5 },
  outer: { label: "Outer / Chitungwiza / Norton edge (12–25km)", fee: 8 }
};

export const MIN_GOODS = 20;
export const SERVICE_MIN = 2;
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

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

  // ── Snacks & treats (supplier stock; selling price = cost + margin) ──
  sn_ferrero_moments:  ["Ferrero Moments", "box", 13.50],
  sn_ferrero_collection: ["Ferrero Collection", "box", 16.00],
  sn_ferrero_t16:      ["Ferrero Rocher T16", "box", 13.50],
  sn_stimorol:         ["Stimorol gum", "slab of 14", 2.00],
  sn_kitkat:           ["Kit Kat", "each", 0.80],
  sn_smarties:         ["Smarties", "each", 0.80],
  sn_skittles:         ["Skittles", "each", 1.50],
  sn_maynards:         ["Maynards", "each", 1.50],
  sn_sour_punks:       ["Sour Punks", "each", 1.50],
  sn_bar_one:          ["Bar One", "each", 0.80],
  sn_crunchie:         ["Crunchie", "each", 1.50],
  sn_mentos:           ["Mentos", "each", 1.50],
  sn_lindt:            ["Lindt chocolate", "each", 0.80],
  sn_clorets:          ["Clorets gum", "box of 56", 5.50],
  sn_sherbet:          ["Sherbet", "tub of 72", 5.50],
  sn_pascal_mallow:    ["Pascall Marshmallows", "each", 0.80],
  sn_brats:            ["Brats sweets", "each", 1.50],
  sn_rascals:          ["Rascals sweets", "each", 1.50],
  sn_stylos:           ["Stylos", "each", 1.50],
  sn_sniggles:         ["Sniggles", "6-pack", 1.50],
  sn_doritos:          ["Doritos", "each", 0.80],
  sn_lays:             ["Lays", "each", 0.80],
  sn_nik_naks:         ["Nik Naks", "5-pack", 1.50],
  sn_pringles_70:      ["Pringles 70g", "each", 2.80],
  sn_pringles_reg:     ["Pringles (regular)", "each", 2.20],
  sn_simba_pr:         ["Simba Peanuts & Raisins", "each", 0.80],
  sn_spuds:            ["Spuds", "each", 0.80],
  sn_bakers_choice:    ["Bakers Choice Assorted 1kg", "1kg", 17.00],
  sn_de_vries:         ["De Vries Assorted Biscuits", "big box", 7.00],
  sn_tennis:           ["Bakers Tennis biscuits", "pack", 2.80],
  sn_red_label:        ["Bakers Red Label biscuits", "pack", 2.80],
  sn_blue_label:       ["Bakers Blue Label biscuits", "pack", 2.80],
  sn_good_morning:     ["Good Morning biscuits", "box of 6", 4.50],
  sn_cheezy_bites:     ["Cheezy Bites", "pack", 4.00],
  sn_mini_cheddars:    ["Mini Cheddars", "pack", 4.00],
  sn_oreos:            ["Oreos", "each", 0.80],
  sn_mini_oreos:       ["Mini Oreos", "each", 0.80],
  sn_real_tea:         ["Real Tea biscuits", "pack of 48", 4.50],
  sn_provita:          ["Provita crackers", "pack", 4.50],
  sn_biscoff_biscuits: ["Biscoff biscuits", "pack", 4.50],
  sn_enjoy:            ["Enjoy biscuits", "each", 0.80],
  sn_toppers:          ["Toppers", "each", 0.80],
  sn_eetsummor:        ["Eet Sum Mor mini biscuits", "pack", 4.00],
  sn_cerevita:         ["Cerevita", "box", 4.00],
  sn_coco_pops:        ["Coco Pops", "box", 5.50],
  sn_froot_loops:      ["Froot Loops", "box", 5.50],
  sn_all_bran:         ["All Bran", "box", 5.50],
  sn_granola_450:      ["Granola 450g", "450g", 6.00],
  sn_granola_700:      ["Granola 700g", "700g", 8.00],
  sn_weetbix:          ["Weetbix", "box", 3.50],
  sn_weetbix_900:      ["Weetbix 900g", "900g", 6.00],
  sn_otees:            ["Otees cereal", "box", 6.00],
  sn_choco_comets:     ["Choco Comets", "box", 4.00],
  sn_honey_hoops:      ["Honey Hoops", "box", 4.00],
  sn_rainbow_hoops:    ["Rainbow Hoops", "box", 4.00],
  sn_oatso_easy:       ["Oatso Easy (10 sachets)", "box of 10", 7.50],
  sn_rhodes_juice:     ["Rhodes Juice", "6-pack", 4.00],
  sn_liqui_fruit:      ["Liqui Fruit (small)", "6-pack", 4.50],
  sn_basil_drink:      ["Basil drink", "each", 2.80],
  sn_lucozade:         ["Lucozade", "each", 2.80],
  sn_la_cabonada:      ["La Cabonada", "each", 2.20],
  sn_appletizer:       ["Appletizer", "each", 2.20],
  sn_revive:           ["Revive", "box of 24", 10.00],
  sn_hug_in_mug:       ["Hug in a Mug", "pack", 10.00],
  sn_hot_choc:         ["Hot Chocolate", "tin", 8.00],
  sn_biscoff_spread:   ["Biscoff Spread", "jar", 10.50],
  sn_all_gold:         ["All Gold Tomato Sauce", "bottle", 4.00],
  sn_wellington:       ["Wellington Sauce", "bottle", 4.00],
  sn_mrs_balls:        ["Mrs Balls Chutney", "bottle", 4.50],
  sn_danone_yoghurt:   ["Danone Yoghurt", "4-pack", 3.00],
  sn_ultramel:         ["Ultra Mel Custard Yoghurt", "4-pack", 3.00],
  sn_parmalat_1kg:     ["Parmalat Yoghurt 1kg", "1kg", 4.50],
  sn_melrose:          ["Melrose Cheese (12 slices)", "12 slices", 4.00],
  sn_parmalat_24:      ["Parmalat Cheese (24 slices)", "24 slices", 6.50],
  sn_parmalat_54:      ["Parmalat Cheese (54 slices)", "54 slices", 13.00],
  sn_cheese_block_850: ["Cheese Block 850g", "850g", 15.50],
  sn_everyday_milk:    ["Everyday Powdered Milk", "pack", 4.50],
  sn_golf_noodles:     ["Golf Noodles", "5-pack", 2.00],
  sn_migoreng:         ["Mi Goreng Stir Fry Noodles", "pack", 3.50],
  sn_indomie:          ["Indomie Noodles", "pack", 3.00],

};

// Delivery zones from Harare CBD - flat fees set ABOVE real rider fuel+time.
// Raised 2026-10-15 for higher fuel (CG125 ~$0.85 mid / ~$2 outer round-trip + rider pay).
export const ZONES = {
  cbd:     { label: "CBD / Avenues / inner (≤5km)", fee: 4 },
  mid:     { label: "Mid suburbs (Borrowdale, Waterfalls, Mbare, Highfield…)", fee: 6 },
  outer:   { label: "Outer / Chitungwiza / Norton edge (12–25km)", fee: 10 },
  // Collection / pickup: customer collects from the ZimQuote point, no delivery fee.
  collect: { label: "Collection / pickup (no delivery fee)", fee: 0 }
};

export const MIN_GOODS = 30;      // delivery minimum (rider economics)
export const MIN_COLLECT = 5;     // collection/pickup minimum (no rider cost)
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
  const minGoods = zone === "collect" ? MIN_COLLECT : MIN_GOODS;
  if (goods > 0 && goods < minGoods && !hasCustomItems) {
    errors.push(`Minimum order is $${minGoods} of goods (yours is $${goods.toFixed(2)}).`);
  }
  if (items.length === 0) errors.push("Your basket is empty.");
  const serviceFee = goods > 0 ? Math.max(SERVICE_MIN, Math.round(goods * SERVICE_PCT * 100)/100) : SERVICE_MIN;
  const deliveryFee = zoneDef ? zoneDef.fee : 0;
  const total = Math.round((goods + serviceFee + deliveryFee) * 100) / 100;
  const payableNow = !hasCustomItems && errors.length === 0;
  return { items, hasCustomItems, amounts: { goods, serviceFee, deliveryFee, total, currency: "USD" }, payableNow, errors };
}

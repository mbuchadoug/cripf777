// services/groceryBot.js
// ─── ZimQuote Groceries on WhatsApp - shop, cart, hampers, calculator ────────
//
// One shop, five ways in, no paging:
//   🎁 Hampers & packages      ready baskets, cheaper than item by item
//   🛒 Shop by aisle           numbered price list per aisle - reply "3" or "1, 4x2"
//   ✍️ Type / photo your list  "2 sugar, cooking oil, 3 bread, avocados" - priced
//                              at once; anything we don't stock is priced by us
//   🧮 Grocery calculator      people + week/month (+ optional budget) → basket
//   🧺 Cart → checkout         Harare delivery (zone fee) or collect → EcoCash/OneMoney
//                              prompt or Visa/Mastercard link (Stripe) · min $40
//   📦 My orders               numbered list → tracker, pay, reorder ("track GRO-…")
//
// Typing anything with letters while the shop is open ADDS it to the cart
// (English + common Shona: upfu, mafuta, shuga, mupunga, huku, mazai…).
// Cart commands: "remove 2", "2=3" (set qty), "clear", "checkout".
//
// Prices, fees and minimums come from routes/groceryCatalogue.js - the same
// file the website shop uses - and orders are saved as GroceryOrder, so they
// show on /grocery-admin AND /zq-admin/grocery-orders. Payment uses
// services/zqPayments.js (ZimQuote's Paynow, EcoCash/OneMoney PIN prompt).
//
// Entry: "groceries" / "hampers" / ZQ:GROCERY, the Groceries & Food section
// in Find, Buy & Hire, Marketplace → 🛒 Groceries, and 🛒 Buy Groceries on the main menu.
//
// Actions (grc_*, whitelisted in chatbotEngine.js):
//   grc_home grc_pkgs grc_pkg_<key> grc_padd_<key> grc_aisles grc_list grc_cart
//   grc_clear grc_checkout grc_zone_<zone> grc_cme grc_confirm grc_cancel_co
//   grc_calc grc_calcp_w grc_calcp_m grc_calcadd grc_calcbud grc_orders
//   grc_reorder_<ref> grc_addraw grc_search
// State: UserSession.tempData.grc = { m, ...ctx, at }  (mode, 2 h)
//        UserSession.tempData.grcCart = [{ k, n, u, q, p, img }]
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import crypto from "crypto";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import * as GC from "../routes/groceryCatalogue.js";

const CATALOGUE   = GC.CATALOGUE || {};
const ZONES       = GC.ZONES || {};
const MIN_GOODS   = GC.MIN_GOODS ?? 30;
const MIN_COLLECT = GC.MIN_COLLECT ?? 5;
const SERVICE_MIN = GC.SERVICE_MIN ?? 3;
const SERVICE_PCT = GC.SERVICE_PCT ?? 0.05;
const COLLECT_POINT = process.env.ZQ_GROCERY_COLLECT || "Harare CBD - 5th Street & Central Avenue, next to the ZINARA building (No. 49)";
// Who customers call/WhatsApp to arrange collection or ask about an order
const SUPPORT_PHONE = process.env.ZQ_GROCERY_SUPPORT || process.env.ZQ_SUPPORT_PHONE || "0789 901 058";
// Card payments (Stripe Checkout) - same page the website shop returns to
const CARD_RETURN = process.env.ZQ_GROCERY_SITE || "https://zimqoute.co.zw/grocery-delivery-harare/";
// Delivery zones shown as a numbered list (key, label)
const ZONE_ORDER = [
  ["cbd",   "CBD, Avenues & nearby (up to 5km)"],
  ["mid",   "Mid suburbs - Borrowdale, Waterfalls, Mbare, Highfield…"],
  ["outer", "Outer - Chitungwiza, Norton edge, Ruwa (12-25km)"]
];

// Tell the number router this shop's numbered menu is the latest one on screen
// (services/numList.js - optional; never breaks the shop if missing).
async function _markNum(from) {
  try { const { markNumList } = await import("./numList.js"); await markNumList(from, "grocery"); } catch (_) {}
}
async function _newerList(from) {
  try { const { newerListThanFor } = await import("./numList.js"); return await newerListThanFor(from, "grocery"); } catch (_) { return false; }
}
const MODE_MS = 2 * 60 * 60 * 1000;

const _digits = (p) => String(p || "").replace(/\D+/g, "");
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const _intl = (p) => { let d = _digits(p); if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1); return d; };
const _local = (p) => { const d = _intl(p); return d.startsWith("263") ? "0" + d.slice(3) : d; };

// ═════════════════════════════════════════════════════════════════════════════
// CATALOGUE HELPERS: aisles + typed-name matching
// ═════════════════════════════════════════════════════════════════════════════
export const AISLES = [
  { id: "staples",   label: "🌽 Staples",                hint: "mealie meal, rice, oil, sugar" },
  { id: "meat",      label: "🍗 Meat & fish",            hint: "chicken, beef, kapenta" },
  { id: "veg",       label: "🥬 Veg & fruit",            hint: "tomatoes, onions, potatoes" },
  { id: "dairy",     label: "🥛 Dairy & eggs",           hint: "milk, eggs, cheese" },
  { id: "breakfast", label: "🥣 Breakfast & hot drinks", hint: "cereal, tea, oats" },
  { id: "pantry",    label: "🥫 Sauces & spreads",       hint: "peanut butter, jam, sauces" },
  { id: "drinks",    label: "🥤 Drinks",                 hint: "juice, soft drinks, water" },
  { id: "biscuits",  label: "🍪 Biscuits & crackers",    hint: "Tennis, Provita, Oreos" },
  { id: "snacks",    label: "🍫 Snacks & sweets",        hint: "chips, chocolates, gum" },
  { id: "household", label: "🧼 Household & cleaning",   hint: "washing powder, Jik, tissue" },
  { id: "personal",  label: "🧴 Personal care",          hint: "soap, lotion, toothpaste" },
  { id: "baby",      label: "👶 Baby",                   hint: "nappies, formula, wipes" },
  { id: "other",     label: "📦 Other",                  hint: "" }
];
const AISLE_OF = {
  staples: ["mealie_meal", "roller_meal", "rice", "flour", "self_raising", "macaroni", "spaghetti", "samp", "sugar", "salt", "cooking_oil", "bread", "beans", "sn_golf_noodles", "sn_migoreng", "sn_indomie"],
  meat: ["chicken", "drumsticks", "beef", "mince", "pork", "sausages", "polony", "kapenta", "fish", "pilchards"],
  veg: ["veg", "tomatoes", "onions", "potatoes", "cabbage", "carrots", "butternut", "bananas", "apples", "oranges"],
  dairy: ["eggs", "milk", "milk_powder", "margarine", "cheese", "yoghurt", "sn_everyday_milk", "sn_danone_yoghurt", "sn_ultramel", "sn_parmalat_1kg", "sn_melrose", "sn_parmalat_24", "sn_parmalat_54", "sn_cheese_block_850"],
  breakfast: ["cereal", "oats", "tea", "mahewu", "sn_cerevita", "sn_coco_pops", "sn_froot_loops", "sn_all_bran", "sn_granola_450", "sn_granola_700", "sn_weetbix", "sn_weetbix_900", "sn_otees", "sn_choco_comets", "sn_honey_hoops", "sn_rainbow_hoops", "sn_oatso_easy", "sn_hug_in_mug", "sn_hot_choc"],
  pantry: ["peanut_butter", "jam", "tomato_sauce", "mayonnaise", "soup", "sn_biscoff_spread", "sn_all_gold", "sn_wellington", "sn_mrs_balls"],
  drinks: ["juice", "softdrink", "water", "sn_rhodes_juice", "sn_liqui_fruit", "sn_basil_drink", "sn_lucozade", "sn_la_cabonada", "sn_appletizer", "sn_revive"],
  biscuits: ["sn_bakers_choice", "sn_de_vries", "sn_tennis", "sn_red_label", "sn_blue_label", "sn_good_morning", "sn_cheezy_bites", "sn_mini_cheddars", "sn_oreos", "sn_mini_oreos", "sn_real_tea", "sn_provita", "sn_biscoff_biscuits", "sn_enjoy", "sn_toppers", "sn_eetsummor"],
  household: ["washing", "dishwash", "bleach", "toiletpaper", "matches"],
  personal: ["bathsoap", "toothpaste", "vaseline", "roll_on", "shampoo", "pads"],
  baby: ["diapers", "formula", "wipes"]
};
const _skuAisle = new Map();
for (const [aid, skus] of Object.entries(AISLE_OF)) for (const s of skus) _skuAisle.set(s, aid);
export function aisleItems(aid) {
  return Object.keys(CATALOGUE).filter(sku => {
    const a = _skuAisle.get(sku) || (sku.startsWith("sn_") ? "snacks" : "other");
    return a === aid;
  });
}
const _aislesWithItems = () => AISLES.filter(a => aisleItems(a.id).length);
const _itemName = (sku) => { const c = CATALOGUE[sku]; return c ? `${c[0]} ${c[1]}`.replace(/\s+/g, " ") : sku; };

// Extra names people type (English + Shona + brands) → sku
const ALIASES = {
  mealie_meal: ["mealie meal", "mealiemeal", "mealie", "upfu", "hupfu", "sadza", "maize meal", "white meal", "mealie-meal", "iyezi", "impuphu"],
  roller_meal: ["roller meal", "roller", "upfu hwechikiti"],
  rice: ["rice", "mupunga", "irayisi"],
  flour: ["flour", "cake flour", "furawa"],
  self_raising: ["self raising", "self raising flour", "srf"],
  macaroni: ["macaroni", "pasta"],
  spaghetti: ["spaghetti"],
  sugar: ["sugar", "shuga", "white sugar", "brown sugar", "ishukela"],
  salt: ["salt", "munyu", "usawoti"],
  cooking_oil: ["cooking oil", "oil", "mafuta", "mafuta ekubikisa", "olive oil", "sunflower oil"],
  bread: ["bread", "chingwa", "loaf", "loaves", "isinkwa"],
  chicken: ["chicken", "huku", "whole chicken", "inkukhu"],
  drumsticks: ["drumsticks", "drum sticks", "chicken drumsticks", "chicken pieces"],
  beef: ["beef", "meat", "nyama", "stewing beef", "steak", "inyama"],
  mince: ["mince", "minced meat", "beef mince"],
  pork: ["pork", "nyama yenguruve"],
  sausages: ["sausages", "sausage", "boerewors", "wors"],
  polony: ["polony"],
  kapenta: ["kapenta", "matemba", "kapenta fish", "ingwebu"],
  fish: ["fish", "hove", "frozen fish", "bream"],
  pilchards: ["pilchards", "tinned fish", "canned fish", "lucky star"],
  beans: ["beans", "nyemba", "sugar beans", "dried beans"],
  veg: ["vegetables", "veg", "muriwo", "covo", "rape", "spinach", "greens", "derere", "imibhida"],
  tomatoes: ["tomatoes", "tomato", "madomasi", "domasi", "amatamatisi"],
  onions: ["onions", "onion", "hanyanisi", "anyanisi"],
  potatoes: ["potatoes", "potato", "mbatatisi", "pocket of potatoes"],
  cabbage: ["cabbage", "kabichi"],
  carrots: ["carrots", "carrot"],
  butternut: ["butternut", "pumpkin", "manhanga"],
  bananas: ["bananas", "banana", "mabhanana"],
  apples: ["apples", "apple"],
  oranges: ["oranges", "orange", "maranjisi"],
  eggs: ["eggs", "egg", "mazai", "tray of eggs", "amaqanda"],
  milk: ["milk", "fresh milk", "mukaka", "amasi"],
  milk_powder: ["milk powder", "powdered milk", "cremora"],
  margarine: ["margarine", "butter", "stork", "rama", "buttercup"],
  cheese: ["cheese", "chizi"],
  yoghurt: ["yoghurt", "yogurt", "yoghurts"],
  peanut_butter: ["peanut butter", "dovi", "peanutbutter"],
  jam: ["jam"],
  tomato_sauce: ["tomato sauce", "sauce", "ketchup"],
  mayonnaise: ["mayonnaise", "mayo"],
  soup: ["soup", "royco", "stock cubes", "knorr", "benny"],
  cereal: ["cereal", "cornflakes", "corn flakes"],
  oats: ["oats", "jungle oats", "porridge"],
  tea: ["tea", "coffee", "tii", "tea leaves", "tea bags", "freshpak"],
  juice: ["juice", "cordial", "mazoe", "squash", "orange juice", "fruit juice"],
  softdrink: ["soft drink", "soda", "coke", "coca cola", "fanta", "sprite", "cool drink", "fizzy drink"],
  water: ["water", "bottled water", "mvura"],
  mahewu: ["mahewu", "maheu"],
  washing: ["washing powder", "omo", "surf", "boom", "soap powder", "sipo yekuwachisa"],
  dishwash: ["dishwashing liquid", "dish washing liquid", "sunlight liquid", "dishwash"],
  bleach: ["bleach", "jik"],
  bathsoap: ["bath soap", "soap", "sipo", "lux", "protex", "geisha", "bathing soap"],
  toiletpaper: ["toilet paper", "tissue", "tissues", "toilet tissue", "toilet roll"],
  matches: ["matches", "candles", "machisi", "makenduru"],
  toothpaste: ["toothpaste", "colgate", "close up"],
  vaseline: ["vaseline", "lotion", "body lotion", "petroleum jelly"],
  roll_on: ["roll on", "roll-on", "deodorant", "deo"],
  shampoo: ["shampoo"],
  pads: ["sanitary pads", "pads", "always"],
  diapers: ["diapers", "nappies", "napkins", "pampers", "huggies"],
  formula: ["baby formula", "formula", "nan", "lactogen"],
  wipes: ["baby wipes", "wipes"]
};

const STOP = new Set(["a", "an", "the", "of", "and", "some", "please", "pls", "i", "want", "need", "would", "like", "buy", "get", "me", "for", "x", "bag", "bags", "pack", "packs", "packet", "packets", "bottle", "bottles", "box", "boxes", "tin", "tins", "pcs", "pc", "piece", "pieces", "kg", "g", "l", "ml", "litre", "litres", "liter", "liters", "lt", "ltr", "tray", "trays", "dozen", "bundle", "bundles", "head", "heads", "bunch", "pocket", "pockets", "packs", "units", "unit", "each", "add", "also", "plus", "with", "na", "ne"]);
const _stem = (w) => (w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
const _tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  .filter(w => w && !STOP.has(w) && !/^\d+(kg|g|l|ml|lt|ltr|litres?)?$/.test(w)).map(_stem);

let _phrases = null;
function _phraseIndex() {
  if (_phrases) return _phrases;
  _phrases = [];
  for (const [sku, [name]] of Object.entries(CATALOGUE)) {
    const names = new Set([name.toLowerCase(), ...(ALIASES[sku] || [])]);
    for (const n of names) {
      const toks = _tokens(n);
      if (toks.length) _phrases.push({ sku, toks, exact: toks.join(" "), core: !sku.startsWith("sn_"), alias: (ALIASES[sku] || []).includes(n) });
    }
  }
  return _phrases;
}

/** Best catalogue sku for a typed name, or null. */
export function matchSku(name) {
  const q = _tokens(name);
  if (!q.length) return null;
  const qs = q.join(" ");
  let best = null, bestScore = 0;
  for (const p of _phraseIndex()) {
    let score = 0;
    if (p.exact === qs) score = 100 + (p.alias ? 5 : 0);
    else if (q.every(w => p.toks.includes(w))) score = 50 + 20 * (q.length / p.toks.length);
    else if (p.toks.every(w => q.includes(w))) score = 40 + 20 * (p.toks.length / q.length);
    else continue;
    if (p.core) score += 3;
    if (score > bestScore) { best = p.sku; bestScore = score; }
  }
  return bestScore >= 45 ? best : null;
}

/** "2 sugar, cooking oil x2\n3 bread" → [{ qty, name, sku|null }] */
export function parseList(text) {
  const parts = String(text || "")
    .replace(/\r/g, "")
    .split(/\n|,|;|\s+\+\s+|\s+&\s+|\s+and\s+|\s+ne\s+|\s+na\s+/i)
    .map(s => s.replace(/^\s*(?:[-•*·]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const out = [];
  for (let p of parts) {
    let qty = 1, m;
    if ((m = p.match(/^(\d{1,3})\s*(?:x|×|\*)?\s+(.+)$/i)) && !/^(kg|g|l|ml|lt|ltr|litres?|liters?)\b/i.test(m[2])) { qty = +m[1]; p = m[2]; }
    else if ((m = p.match(/^(\d{1,3})(?:x|×)\s*(.+)$/i))) { qty = +m[1]; p = m[2]; }
    else if ((m = p.match(/^(.+?)\s*(?:x|×|\*)\s*(\d{1,3})$/i))) { qty = +m[2]; p = m[1]; }
    else if ((m = p.match(/^(.+?\D)\s+(\d{1,3})$/))) { qty = +m[2]; p = m[1]; }
    p = p.trim();
    if (!/[a-z]/i.test(p) || p.length < 2) continue;
    qty = Math.min(99, Math.max(1, qty || 1));
    out.push({ qty, name: p.slice(0, 60), sku: matchSku(p) });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// HAMPERS & PACKAGES (editable on /zq-admin/grocery-packages)
// ═════════════════════════════════════════════════════════════════════════════
const pkgSchema = new mongoose.Schema({
  key:         { type: String, unique: true },
  name:        String,
  blurb:       String,
  lines:       [{ sku: String, qty: Number }],
  discountPct: { type: Number, default: 5 },
  active:      { type: Boolean, default: true },
  order:       { type: Number, default: 100 }
}, { timestamps: true });
export const GroceryPackage = mongoose.models.GroceryPackage || mongoose.model("GroceryPackage", pkgSchema);

const L = (s) => s.split(",").map(x => { const [sku, q] = x.trim().split(":"); return { sku, qty: +(q || 1) }; });
export const DEFAULT_PACKAGES = [
  { key: "xmas",      order: 10, discountPct: 5, name: "🎄 Christmas Hamper",          blurb: "Festive meat, treats & drinks for 4-6",
    lines: L("chicken:2,drumsticks,beef,sausages,rice:2,cooking_oil,sugar,softdrink:3,juice:2,mayonnaise,sn_mrs_balls,sn_all_gold,sn_de_vries,sn_tennis,sn_ferrero_t16,tea") },
  { key: "family",    order: 20, discountPct: 5, name: "👨‍👩‍👧‍👦 Family Month Hamper", blurb: "A month of basics for 4-5 people",
    lines: L("mealie_meal:2,rice:2,flour,cooking_oil:2,sugar:2,salt,beans:2,chicken:2,beef,kapenta,pilchards:2,tomatoes:2,onions:2,potatoes,cabbage:2,soup:2,tea,milk_powder,margarine,peanut_butter,washing,bathsoap:2,toiletpaper:2,dishwash") },
  { key: "basic",     order: 30, discountPct: 5, name: "🧺 Basic Basket",              blurb: "Two weeks of basics for 1-2 people",
    lines: L("mealie_meal,rice,cooking_oil,sugar,salt,beans,kapenta,tomatoes,onions,soup,bathsoap,washing") },
  { key: "breakfast", order: 40, discountPct: 5, name: "🍳 Breakfast Pack",            blurb: "Bread, eggs, milk, spreads & tea",
    lines: L("bread:2,eggs,milk:2,margarine,jam,peanut_butter,tea,cereal,oats,sugar") },
  { key: "household", order: 50, discountPct: 5, name: "🧼 Household & Hygiene",       blurb: "Cleaning and toiletries for the month",
    lines: L("washing,dishwash,bleach,bathsoap:2,toiletpaper:2,toothpaste:2,vaseline,roll_on,matches") },
  { key: "baby",      order: 60, discountPct: 5, name: "👶 Baby Pack",                 blurb: "Nappies, formula and wipes",
    lines: L("diapers:2,formula,wipes:2,vaseline,bathsoap") },
  { key: "student",   order: 70, discountPct: 5, name: "🎓 Student Pack",              blurb: "Quick meals for one - noodles, pasta, tins",
    lines: L("rice,spaghetti:2,sn_golf_noodles:2,pilchards:2,polony,bread:2,peanut_butter,eggs,tea,sugar,cooking_oil") },
  { key: "sendhome",  order: 80, discountPct: 5, name: "💝 Send-Home Hamper",          blurb: "For family in Harare - add their name & number at checkout",
    lines: L("mealie_meal:2,rice,cooking_oil:2,sugar:2,salt,beans,chicken,beef,kapenta,tomatoes,onions,soup,tea,milk_powder,washing,bathsoap:2,toiletpaper") }
];

let _pkgCache = null, _pkgAt = 0;
export function invalidatePackages() { _pkgCache = null; _pkgAt = 0; }
export async function getPackages({ includeInactive = false } = {}) {
  if (!_pkgCache || Date.now() - _pkgAt > 60000) {
    let docs = [];
    try { docs = await GroceryPackage.find({}).lean(); } catch (_) {}
    _pkgCache = docs.length ? docs : DEFAULT_PACKAGES.map(p => ({ ...p, active: true }));
    _pkgAt = Date.now();
  }
  const list = _pkgCache
    .map(p => ({ ...p, lines: (p.lines || []).filter(l => CATALOGUE[l.sku] && l.qty > 0) }))
    .filter(p => p.lines.length && (includeInactive || p.active !== false))
    .sort((a, b) => (a.order || 100) - (b.order || 100));
  return list.map(p => {
    const full = r2(p.lines.reduce((t, l) => t + CATALOGUE[l.sku][2] * l.qty, 0));
    const price = r2(full * (1 - (Number(p.discountPct) || 0) / 100));
    return { ...p, full, price, save: r2(full - price) };
  });
}
async function _pkg(key) { return (await getPackages()).find(p => p.key === key) || null; }

// ═════════════════════════════════════════════════════════════════════════════
// SESSION: mode + cart
// ═════════════════════════════════════════════════════════════════════════════
async function _US() { return (await import("../models/userSession.js")).default; }
async function _load(from) {
  const US = await _US();
  const s = await US.findOne({ phone: _digits(from) }, { "tempData.grc": 1, "tempData.grcCart": 1 }).lean();
  const td = s?.tempData || {};
  const mode = td.grc && td.grc.at && Date.now() - new Date(td.grc.at).getTime() < MODE_MS ? td.grc : null;
  return { mode, cart: Array.isArray(td.grcCart) ? td.grcCart : [] };
}
async function _setMode(from, m) {
  const US = await _US();
  if (m) await US.updateOne({ phone: _digits(from) }, { $set: { "tempData.grc": { ...m, at: new Date() } } }, { upsert: true });
  else await US.updateOne({ phone: _digits(from) }, { $unset: { "tempData.grc": "" } });
}
async function _saveCart(from, cart) {
  const US = await _US();
  await US.updateOne({ phone: _digits(from) }, { $set: { "tempData.grcCart": cart.slice(0, 80) } }, { upsert: true });
}
export async function disarmGrocery(from) { try { await _setMode(from, null); } catch (_) {} }

function _addToCart(cart, line) {
  const same = line.k ? cart.find(c => c.k === line.k) : cart.find(c => !c.k && !line.img && String(c.n).toLowerCase() === String(line.n).toLowerCase());
  if (same) same.q = Math.min(99, (same.q || 1) + (line.q || 1));
  else cart.push(line);
  return cart;
}
const _skuLine = (sku, q = 1) => ({ k: sku, n: CATALOGUE[sku][0], u: CATALOGUE[sku][1], q, p: CATALOGUE[sku][2] });

/** Price the cart with today's catalogue + hamper prices + zone fees. */
export async function priceCart(cart, zone = null) {
  const pkgs = await getPackages({ includeInactive: true });
  const items = [];
  let goods = 0, hasCustom = false;
  for (const c of cart) {
    const q = Math.max(1, Math.min(99, parseInt(c.q, 10) || 1));
    if (c.k && c.k.startsWith("pkg:")) {
      const p = pkgs.find(x => x.key === c.k.slice(4));
      if (!p) { hasCustom = true; items.push({ sku: null, name: c.n, unit: "hamper", qty: q, unitPrice: null, lineTotal: 0, custom: true }); continue; }
      const lt = r2(p.price * q); goods += lt;
      items.push({ sku: c.k, name: p.name.replace(/^[^\p{L}]+/u, ""), unit: "hamper", qty: q, unitPrice: p.price, lineTotal: lt, custom: false });
    } else if (c.k && CATALOGUE[c.k]) {
      const [name, unit, price] = CATALOGUE[c.k];
      const lt = r2(price * q); goods += lt;
      items.push({ sku: c.k, name, unit, qty: q, unitPrice: price, lineTotal: lt, custom: false });
    } else {
      hasCustom = true;
      items.push({ sku: null, name: String(c.n || "Item").slice(0, 80), unit: String(c.u || "").slice(0, 24), qty: q, unitPrice: null, lineTotal: 0, custom: true, img: c.img || null });
    }
  }
  goods = r2(goods);
  const zoneDef = zone ? ZONES[zone] : null;
  const serviceFee = goods > 0 ? Math.max(SERVICE_MIN, r2(goods * SERVICE_PCT)) : SERVICE_MIN;
  const deliveryFee = zoneDef ? zoneDef.fee : 0;
  const total = r2(goods + serviceFee + deliveryFee);
  const minGoods = zone === "collect" ? MIN_COLLECT : MIN_GOODS;
  const short = !hasCustom && goods < minGoods ? r2(minGoods - goods) : 0;
  return { items, hasCustom, goods, serviceFee, deliveryFee, total, minGoods, short };
}

// ═════════════════════════════════════════════════════════════════════════════
// SCREENS
// ═════════════════════════════════════════════════════════════════════════════
// WhatsApp button messages are capped at 1024 characters. Long lists go as a
// plain text message first, then a short message carries the buttons.
async function _textThenButtons(from, text, buttons, short) {
  if (text.length <= 1000) return sendButtons(from, { text, buttons });
  await sendText(from, text.slice(0, 4000));
  return sendButtons(from, { text: short || "What next?", buttons });
}
async function _cartLine(cart) {
  if (!cart.length) return "🧺 Your cart is empty";
  const pr = await priceCart(cart);
  const n = cart.reduce((t, c) => t + (c.q || 1), 0);
  return `🧺 Cart: *${n} item${n === 1 ? "" : "s"}* · ${money(pr.goods)}${pr.hasCustom ? " + items we'll price" : ""}`;
}

export async function showHome(from) {
  const { cart } = await _load(from);
  await _setMode(from, { m: "home" });
  await _markNum(from);
  return sendText(from,
`🛒 *ZimQuote Groceries*
Delivered to your door in *Harare*. Pay with *EcoCash* or *card*.
Minimum order *${money(MIN_GOODS)}* · delivery from *${money(Math.min(...ZONE_ORDER.map(([z]) => ZONES[z]?.fee ?? 99)))}*
${await _cartLine(cart)}

*1.* 🎁 Hampers & packages
*2.* 🛒 Shop by aisle (price list)
*3.* ✍️ Send us your list (type or photo)
*4.* 🧮 Grocery calculator
*5.* 🧺 View cart & checkout
*6.* 📦 My orders, payments & tracking
*7.* 🚚 Delivery areas & fees

👉 *Reply with a number*, or just type what you want, e.g. *2 sugar, cooking oil, 10kg mealie meal*
🏠 *menu* = main menu`);
}

/** Delivery areas, fees, minimum and collection. */
export async function showDeliveryInfo(from) {
  await _setMode(from, { m: "home" });
  const fees = ZONE_ORDER.filter(([z]) => ZONES[z]).map(([z, l]) => `• ${l}: *${money(ZONES[z].fee)}*`).join("\n");
  return sendButtons(from, {
    text:
`🚚 *Delivery & collection*

We deliver in *Harare only*:
${fees}

🧾 Minimum order: *${money(MIN_GOODS)}* of groceries (plus a small service fee of 5%, min ${money(SERVICE_MIN)}).
🏪 Prefer to collect? Choose *Collect* at checkout and we'll contact you to arrange - or call/WhatsApp *${SUPPORT_PHONE}*.
💳 Pay with EcoCash, OneMoney or Visa/Mastercard.
⏰ Orders paid by 2pm are usually delivered the same day.`,
    buttons: [{ id: "grc_pkgs", title: "🎁 Hampers" }, { id: "grc_aisles", title: "🛒 Shop by aisle" }, { id: "grc_cart", title: "🧺 My cart" }]
  });
}

export async function showPackages(from) {
  const pkgs = await getPackages();
  if (!pkgs.length) { await sendText(from, "No hampers available right now - type your list instead, e.g. *2 sugar, rice*."); return _setMode(from, { m: "home" }); }
  await _setMode(from, { m: "pkgs", keys: pkgs.map(p => p.key) });
  await _markNum(from);
  const lines = pkgs.map((p, i) => `*${i + 1}.* ${p.name} - *${money(p.price)}*${p.save > 0 ? ` _(save ${money(p.save)})_` : ""}\n      _${p.blurb || ""}_`).join("\n");
  return sendText(from,
`🎁 *Hampers & packages*
Ready-made baskets - cheaper than buying item by item.

${lines}

👉 *Reply with a number* to see what's inside.
_Minimum order ${money(MIN_GOODS)} - add items to a smaller pack to reach it._`);
}

export async function showPackage(from, key) {
  const p = await _pkg(key);
  if (!p) return showPackages(from);
  await _setMode(from, { m: "pkg", k: p.key });
  const inside = p.lines.map(l => `• ${l.qty} × ${_itemName(l.sku)}`).join("\n");
  return _textThenButtons(from,
`${p.name}
_${p.blurb || ""}_

${inside}

💵 *${money(p.price)}*${p.save > 0 ? ` (items bought separately: ${money(p.full)} - you save ${money(p.save)})` : ""}`,
    [
      { id: `grc_padd_${p.key}`, title: "🛒 Add to cart" },
      { id: "grc_pkgs",          title: "🎁 Other hampers" },
      { id: "grc_cart",          title: "🧺 View cart" }
    ],
    `${p.name} - *${money(p.price)}*`);
}

export async function showAisles(from) {
  const list = _aislesWithItems();
  await _setMode(from, { m: "aisles", ids: list.map(a => a.id) });
  await _markNum(from);
  return sendText(from,
`🛒 *Shop by aisle*

${list.map((a, i) => `*${i + 1}.* ${a.label} (${aisleItems(a.id).length})${a.hint ? `\n      _${a.hint}_` : ""}`).join("\n")}

👉 *Reply with a number* to see prices.`);
}

export async function showAisle(from, aid) {
  const a = AISLES.find(x => x.id === aid);
  const skus = aisleItems(aid);
  if (!a || !skus.length) return showAisles(from);
  await _setMode(from, { m: "aisle", a: aid, skus });
  await _markNum(from);
  const lines = skus.map((s, i) => `*${i + 1}.* ${_itemName(s)} - ${money(CATALOGUE[s][2])}`).join("\n");
  return sendText(from,
`${a.label}

${lines}

👉 Reply with the numbers to add, e.g. *3* or *1, 4x2, 7*
🧺 *cart* to view · *aisles* for other aisles`.slice(0, 4000));
}

export async function showCart(from, note = "") {
  const { cart } = await _load(from);
  await _setMode(from, { m: "cart" });
  if (!cart.length) {
    return sendButtons(from, {
      text: `${note ? note + "\n\n" : ""}🧺 *Your cart is empty.*\n\nType what you want (e.g. *2 sugar, rice, cooking oil*) or pick a hamper.`,
      buttons: [{ id: "grc_pkgs", title: "🎁 Hampers" }, { id: "grc_aisles", title: "🛒 Shop by aisle" }, { id: "grc_calc", title: "🧮 Calculator" }]
    });
  }
  const pr = await priceCart(cart);
  const lines = pr.items.map((it, i) => it.custom
    ? `*${i + 1}.* ${it.img ? "📷 " : ""}${it.name} × ${it.qty} - _we'll price it_`
    : `*${i + 1}.* ${it.name}${it.unit && it.unit !== "hamper" ? " " + it.unit : ""} × ${it.qty} - ${money(it.lineTotal)}`).join("\n");
  const minNote = pr.goods < MIN_GOODS && !pr.hasCustom
    ? `\n_Minimum order is ${money(MIN_GOODS)} - add ${money(MIN_GOODS - pr.goods)} more to check out._` : "";
  return _textThenButtons(from,
`${note ? note + "\n\n" : ""}🧺 *Your cart*

${lines}

Goods: *${money(pr.goods)}*${pr.hasCustom ? " + items we'll price" : ""}${minNote}
━━━━━━━━━━━━
✏️ *remove 2* · *1=3* (change qty) · *clear*
➕ Add more: just type it, e.g. *rice, 2 bread*`,
    [
      { id: "grc_checkout", title: "✅ Checkout" },
      { id: "grc_pkgs",     title: "🎁 Hampers" },
      { id: "grc_aisles",   title: "🛒 Shop by aisle" }
    ],
    `🧺 Cart total: *${money(pr.goods)}*${pr.hasCustom ? " + items we'll price" : ""}`);
}

async function _addedMsg(from, added, unknown, { asked = false } = {}) {
  const { cart } = await _load(from);
  const a = added.length ? `✅ Added: ${added.map(x => `${x.n}${x.u ? " " + x.u : ""} ×${x.q}`).join(", ")}` : "";
  const u = unknown.length ? `\n📝 We'll price for you: ${unknown.map(x => `${x.n} ×${x.q}`).join(", ")}` : "";
  await _setMode(from, { m: "cart" });
  return _textThenButtons(from, `${a}${u}\n\n${await _cartLine(cart)}\n\nType more items, or tap Checkout.`.trim(), [
      { id: "grc_checkout", title: "✅ Checkout" },
      { id: "grc_cart",     title: "🧺 View cart" },
      { id: asked ? "grc_pkgs" : "grc_aisles", title: asked ? "🎁 Hampers" : "🛒 Shop by aisle" }
    ], await _cartLine(cart));
}

/** Add typed text to the cart. allowUnknown = the user chose "send your list". */
async function _addTyped(from, text, { allowUnknown = false } = {}) {
  const parsed = parseList(text);
  if (!parsed.length) return false;
  const known = parsed.filter(p => p.sku), unknown = parsed.filter(p => !p.sku);
  if (!known.length && !allowUnknown) {
    // Nothing recognised: ask before adding (it may be a normal search)
    await _setMode(from, { m: "ask", raw: String(text).slice(0, 300) });
    await sendButtons(from, {
      text: `🤔 *${String(text).slice(0, 60)}* isn't on our grocery price list.\n\nShall we add it to your order and find a price for you?`,
      buttons: [
        { id: "grc_addraw", title: "➕ Yes, add it" },
        { id: "grc_search", title: "🔍 Search sellers" },
        { id: "grc_home",   title: "🛒 Groceries" }
      ]
    });
    return true;
  }
  const { cart } = await _load(from);
  const added = [], notStocked = [];
  for (const p of known) { _addToCart(cart, _skuLine(p.sku, p.qty)); added.push({ n: CATALOGUE[p.sku][0], u: CATALOGUE[p.sku][1], q: p.qty }); }
  for (const p of unknown) { _addToCart(cart, { k: null, n: p.name, u: "", q: p.qty, p: null }); notStocked.push({ n: p.name, q: p.qty }); }
  await _saveCart(from, cart);
  await _addedMsg(from, added, notStocked);
  return true;
}

// ── Checkout ─────────────────────────────────────────────────────────────────
export async function startCheckout(from) {
  const { cart } = await _load(from);
  if (!cart.length) return showCart(from);
  const pr = await priceCart(cart);
  if (pr.short > 0) {
    return sendButtons(from, {
      text: `⚠️ The minimum order is *${money(MIN_GOODS)}* of groceries - your cart is *${money(pr.goods)}*.\n\nAdd *${money(pr.short)}* more to check out.`,
      buttons: [{ id: "grc_pkgs", title: "🎁 Add a hamper" }, { id: "grc_aisles", title: "🛒 Add items" }, { id: "grc_cart", title: "🧺 View cart" }]
    });
  }
  const zones = ZONE_ORDER.filter(([z]) => ZONES[z]).map(([z]) => z).concat(ZONES.collect ? ["collect"] : []);
  await _setMode(from, { m: "co_zone", zones });
  await _markNum(from);
  const lines = zones.map((z, i) => z === "collect"
    ? `*${i + 1}.* 🏪 Collect in Harare CBD - *free*\n      _we'll contact you to arrange (or call ${SUPPORT_PHONE})_`
    : `*${i + 1}.* 🚚 ${ZONE_ORDER.find(x => x[0] === z)[1]} - *${money(ZONES[z].fee)}*`).join("\n");
  return sendText(from,
`🚚 *Delivery or collection?*
Groceries: *${money(pr.goods)}*${pr.hasCustom ? " + items we'll price" : ""}

We deliver in *Harare only*. The delivery fee is added to your total:

${lines}

👉 *Reply with a number.*  ·  *cart* to go back`);
}

async function _pickZone(from, zone) {
  if (!ZONES[zone]) return startCheckout(from);
  if (zone === "collect") {
    await _setMode(from, { m: "co_name", zone });
    return sendButtons(from, {
      text: `🏪 *Collection* - Harare CBD\n${COLLECT_POINT}\n\nWe'll WhatsApp you when it's packed to agree a time (or call *${SUPPORT_PHONE}*).\n\nWho will collect? *Type their name and number*, or tap *Me*.`,
      buttons: [{ id: "grc_cme", title: "👤 Me" }, { id: "grc_cart", title: "🧺 Back to cart" }]
    });
  }
  await _setMode(from, { m: "co_addr", zone });
  return sendText(from,
`📍 *Delivery address in Harare* (${ZONES[zone].label} - ${money(ZONES[zone].fee)})

Send it in *one message*: name, house number & street, suburb and a landmark.
e.g. _Tendai Moyo, 12 Fife Ave, Avenues, opposite Spar_

🎁 Sending to family? Add *their* name and phone number.`);
}

function _splitNamePhone(t) {
  const phone = (String(t).match(/(?:\+?263|0)\s*7\d(?:[\s-]?\d){7}/) || [""])[0].replace(/[\s-]/g, "");
  const rest = String(t).replace(phone, "").replace(/\s{2,}/g, " ").trim();
  const first = rest.split(/[,\n]/)[0].trim();
  const name = first && !/\d/.test(first) && first.split(/\s+/).length <= 4 ? first : "";
  return { phone: phone ? _local(phone) : "", name, rest };
}

async function _summary(from, co) {
  const { cart } = await _load(from);
  if (!cart.length) return showCart(from);
  const pr = await priceCart(cart, co.zone);
  await _setMode(from, { m: "co_confirm", ...co });
  const lines = pr.items.map(it => it.custom ? `• ${it.name} × ${it.qty} - _we'll price_` : `• ${it.name}${it.unit && it.unit !== "hamper" ? " " + it.unit : ""} × ${it.qty} - ${money(it.lineTotal)}`).join("\n");
  const where = co.zone === "collect"
    ? `🏪 Collect: ${COLLECT_POINT}${co.who ? `\n👤 Collecting: ${co.who}` : ""}`
    : `📍 Deliver to: ${co.address}`;
  if (pr.short > 0) {
    return sendButtons(from, {
      text: `⚠️ The minimum order is *${money(pr.minGoods)}* of groceries - your cart is *${money(pr.goods)}*.\n\nAdd *${money(pr.short)}* more to check out.`,
      buttons: [{ id: "grc_pkgs", title: "🎁 Add a hamper" }, { id: "grc_aisles", title: "🛒 Add items" }, { id: "grc_cart", title: "🧺 View cart" }]
    });
  }
  const zl = co.zone === "collect" ? "Collection" : `Delivery (${String(ZONES[co.zone]?.label || "").split("(")[0].trim()})`;
  const _btns = [
    { id: "grc_confirm",   title: pr.hasCustom ? "✅ Send my order" : "✅ Confirm & pay" },
    { id: "grc_cart",      title: "✏️ Edit cart" },
    { id: "grc_cancel_co", title: "❌ Cancel" }
  ];
  return _textThenButtons(from,
`🧾 *Order summary*

${lines}

Goods: ${money(pr.goods)}${pr.hasCustom ? " + items we'll price" : ""}
Service fee: ${money(pr.serviceFee)}
${zl}: ${money(pr.deliveryFee)}
*Total: ${money(pr.total)}*${pr.hasCustom ? " + priced items" : ""}

${where}
${pr.hasCustom ? "\n📝 We'll price the marked items and send you the final total to pay." : "\n💳 Next: pay with EcoCash, OneMoney or card."}

Reply *1* to confirm · *2* to edit cart · *3* to cancel`,
    _btns,
    `*Total: ${money(pr.total)}*${pr.hasCustom ? " + priced items" : ""} - confirm your order?`);
}

async function _GroceryOrder() { return (await import("../models/groceryOrder.js")).default; }
function _orderRef() { return "GRO-" + crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(6, "0").slice(-6); }

async function _confirm(from, co) {
  const { cart } = await _load(from);
  if (!cart.length) return showCart(from);
  const pr = await priceCart(cart, co.zone);
  if (pr.short > 0) return _summary(from, co);
  const GroceryOrder = await _GroceryOrder();
  const photos = pr.items.filter(i => i.img).map(i => i.img);
  const reference = _orderRef();
  const recipient = co.zone === "collect" ? _splitNamePhone(co.who || "") : _splitNamePhone(co.address || "");
  const order = await GroceryOrder.create({
    reference,
    customer: { name: recipient.name || "WhatsApp customer", phone: _intl(from), email: null, isDiaspora: false, country: "ZW" },
    recipient: { name: recipient.name || null, phone: recipient.phone || null },
    delivery: {
      zone: co.zone, area: "", address: co.zone === "collect" ? `COLLECT: ${COLLECT_POINT}` : String(co.address || "").slice(0, 160),
      landmark: "", geo: { lat: null, lng: null },
      notes: (`WhatsApp order${co.who ? ` · collecting: ${co.who}` : ""}${photos.length ? ` · list photo: ${photos.join(" ")}` : ""}`).slice(0, 240)
    },
    items: pr.items.map(({ img, ...it }) => it),
    hasCustomItems: pr.hasCustom,
    amounts: { goods: pr.goods, serviceFee: pr.serviceFee, deliveryFee: pr.deliveryFee, total: pr.total, currency: "USD" },
    fulfilment: { status: pr.hasCustom ? "quote_pending" : "awaiting_payment", timeline: [
      { at: new Date(), event: "created", note: pr.hasCustom ? "WhatsApp order - needs prices" : "WhatsApp order" }
    ] }
  });
  await _saveCart(from, []);
  await _setMode(from, null);

  _alertAdmins(order, pr).catch(() => {});

  if (pr.hasCustom) {
    return sendButtons(from, {
      text:
`✅ *Order ${reference} received!*

We're pricing the items we don't stock. You'll get the final total here and can pay with EcoCash or card - usually within 30 minutes (8am-6pm).
Track it any time: type *track ${reference}*.

Type *groceries* any time to shop again.`,
      buttons: [{ id: "grc_orders", title: "📦 My orders" }, { id: "main_menu_back", title: "🏠 Main Menu" }]
    });
  }
  await sendText(from, `✅ *Order ${reference} saved* - ${money(order.amounts.total)}.\nWe start packing as soon as it's paid.`);
  return showPayMethods(from, reference);
}

// ── Payment: EcoCash / OneMoney (Paynow PIN prompt) or card (Stripe) ─────────
export async function showPayMethods(from, ref) {
  const GroceryOrder = await _GroceryOrder();
  const o = await GroceryOrder.findOne({ reference: String(ref).toUpperCase() }).lean();
  if (!o) return _myOrders(from);
  if (o.payment?.status === "paid") return showOrder(from, o.reference, "✅ This order is already paid.");
  if (o.hasCustomItems) return showOrder(from, o.reference, "⏳ We're still pricing some items - we'll send the total here.");
  const card = !!process.env.STRIPE_SECRET_KEY;
  await _setMode(from, { m: "pay_method", ref: o.reference, card });
  await _markNum(from);
  return sendText(from,
`💳 *Pay for ${o.reference}* - *${money(o.amounts?.total)}*

*1.* 📱 EcoCash or OneMoney (PIN prompt on your phone)${card ? "\n*2.* 💳 Visa / Mastercard (secure card link)" : ""}

👉 *Reply with a number.*  ·  *orders* to pay later`);
}

async function _payEcocash(from, ref) {
  const GroceryOrder = await _GroceryOrder();
  const o = await GroceryOrder.findOne({ reference: String(ref).toUpperCase() }).lean();
  if (!o) return _myOrders(from);
  if (o.payment?.status === "paid") return showOrder(from, o.reference, "✅ This order is already paid.");
  const { ZqPayment, createPaymentRequest, startPay } = await import("./zqPayments.js");
  let p = await ZqPayment.findOne({ orderRef: o.reference, status: { $nin: ["cancelled", "paid"] } }).sort({ createdAt: -1 }).lean();
  if (p && Math.abs(Number(p.amount) - Number(o.amounts?.total)) > 0.009) {
    await ZqPayment.updateOne({ _id: p._id, status: { $in: ["requested", "failed"] } }, { $set: { status: "cancelled" } });
    p = null;
  }
  if (!p) p = await createPaymentRequest({
    phone: from, amount: o.amounts.total, purpose: "grocery", orderRef: o.reference,
    description: `Groceries ${o.reference}`, name: o.recipient?.name || o.customer?.name || "", requestedBy: "grocery checkout"
  });
  await _setMode(from, null);
  return startPay(from, p.reference);
}

/** Stripe Checkout link for a grocery order (webhook: metadata.type = grocery_order). */
async function _cardLink(order) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const back = CARD_RETURN + (CARD_RETURN.includes("?") ? "&" : "?");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        product_data: { name: `ZimQuote groceries ${order.reference}` },
        unit_amount: Math.round(Number(order.amounts.total) * 100)
      }
    }],
    metadata: { type: "grocery_order", reference: order.reference },
    success_url: `${back}paid=1&ref=${order.reference}`,
    cancel_url: `${back}cancelled=1&ref=${order.reference}`
  });
  const GroceryOrder = await _GroceryOrder();
  await GroceryOrder.updateOne(
    { _id: order._id, "payment.status": { $ne: "paid" } },
    { $set: { "payment.gatewayId": session.id },
      $push: { "fulfilment.timeline": { at: new Date(), event: "payment_initiated", note: "Card link sent on WhatsApp" } } }
  ).catch(() => {});
  return session.url;
}

async function _payCardLink(from, ref) {
  const GroceryOrder = await _GroceryOrder();
  const o = await GroceryOrder.findOne({ reference: String(ref).toUpperCase() }).lean();
  if (!o) return _myOrders(from);
  if (o.payment?.status === "paid") return showOrder(from, o.reference, "✅ This order is already paid.");
  let url = null;
  try { url = await _cardLink(o); } catch (e) { console.error("[GROCERY CARD]", e.message); }
  if (!url) {
    await sendText(from, "❌ Card payment isn't available right now. Please pay with EcoCash or OneMoney.");
    return showPayMethods(from, o.reference);
  }
  await _setMode(from, { m: "home" });            // keep the shop open: "orders", "track…" still work
  return sendButtons(from, {
    text:
`💳 *Pay ${money(o.amounts.total)} by card* - order *${o.reference}*

Tap the secure link below (Visa / Mastercard):
${url}

We'll confirm here on WhatsApp as soon as the payment goes through.`,
    buttons: [{ id: `grc_order_${o.reference}`, title: "📦 Track order" }, { id: `grc_payeco_${o.reference}`, title: "📱 Use EcoCash" }]
  });
}

async function _alertAdmins(order, pr) {
  const { adminPhones } = await import("./zqPayments.js");
  const site = String(process.env.SITE_URL || "https://cripfcnt.com").replace(/\/$/, "");
  const lines = order.items.slice(0, 15).map(i => `• ${i.name} ×${i.qty}${i.custom ? " ❓" : ""}`).join("\n");
  const txt =
`🛒 *New WhatsApp grocery order ${order.reference}*
${order.fulfilment.status === "quote_pending" ? "❓ *Needs prices* - " : ""}${money(order.amounts.total)} · ${order.delivery.zone}
Customer: ${_local(order.customer.phone)}
${order.delivery.address}

${lines}${order.items.length > 15 ? `\n…+${order.items.length - 15} more` : ""}

${site}/zq-admin/grocery-orders/${order.reference}`;
  for (const p of adminPhones()) { try { await sendText(p, txt); } catch (_) {} }
}

// ── Paid hook (from zqPayments) ──────────────────────────────────────────────
export async function markGroceryPaid(orderRef, { method = "ecocash", reference = "" } = {}) {
  const GroceryOrder = await _GroceryOrder();
  const order = await GroceryOrder.findOne({ reference: orderRef });
  if (!order || order.payment?.status === "paid") return;
  const prev = order.payment?.toObject ? order.payment.toObject() : (order.payment || {});
  // Keep the web schema's method values (ecocash | stripe); OneMoney/cash go in the timeline.
  order.payment = { ...prev, status: "paid", method: ["ecocash", "stripe"].includes(method) ? method : (prev.method || "ecocash"), reference: reference || prev.reference, paidAt: new Date() };
  const before = order.fulfilment?.status;
  const early = ["received", "quote_pending", "awaiting_payment", undefined, null, ""].includes(before);
  if (early) order.fulfilment.status = "paid";          // never move a packed/sent order backwards
  if (typeof order.pushTimeline === "function") order.pushTimeline("paid", `Paid via ${method} ${reference}`);
  await order.save();
  if (!early) return;
  const collect = order.delivery?.zone === "collect";
  try {
    await sendButtons(_intl(order.customer.phone), {
      text: `🛒 *${order.reference}* is paid - we're packing it now.\n\n${collect ? `🏪 We'll message you when it's ready to collect at ${COLLECT_POINT}.` : "🏍️ We'll message you when the rider is on the way."}`,
      buttons: [{ id: "grc_orders", title: "📦 My orders" }, { id: "grc_home", title: "🛒 Shop again" }]
    });
  } catch (_) {}
}

/** Website-paid orders: WhatsApp the customer too (called from routes/groceryOrders.js). */
export async function onWebOrderPaid(order) {
  // Paid by card/website → close any EcoCash request still open for this order
  try {
    const { ZqPayment, adminPhones } = await import("./zqPayments.js");
    await ZqPayment.updateMany({ orderRef: order.reference, status: { $in: ["requested", "failed"] } },
      { $set: { status: "cancelled", note: `Paid by ${order.payment?.method || "card"}` } });
    for (const p of adminPhones()) {
      sendText(p, `💰 *Grocery order paid* ${money(order.amounts?.total)} by ${order.payment?.method || "card"}\nOrder ${order.reference} · ${_local(order.customer?.phone)}`).catch(() => {});
    }
  } catch (_) {}
  try {
    const to = _intl(order?.customer?.phone);
    if (!/^263\d{9}$/.test(to)) return;
    await sendText(to, `✅ *ZimQuote Groceries*\nPayment received for *${order.reference}* (${money(order.amounts?.total)}). We're packing your order and will update you here.`);
  } catch (_) {}
}

/** Admin priced the custom items (web or /zq-admin) → send the EcoCash request. */
export async function sendGroceryPaymentRequest(order, { by = "admin" } = {}) {
  const { createPaymentRequest, sendPaymentRequest, ZqPayment } = await import("./zqPayments.js");
  if (!order || order.hasCustomItems || order.payment?.status === "paid") return null;
  await ZqPayment.updateMany({ orderRef: order.reference, status: { $in: ["requested", "failed"] } }, { $set: { status: "cancelled" } });
  const doc = await createPaymentRequest({
    phone: order.customer.phone, amount: order.amounts.total, purpose: "grocery", orderRef: order.reference,
    description: `Groceries ${order.reference}`, name: order.customer?.name || "", requestedBy: by
  });
  try {
    await sendText(_intl(order.customer.phone),
`🧾 *Your grocery order ${order.reference} is priced*

${order.items.map(i => `• ${i.name} × ${i.qty} - ${money(i.lineTotal)}`).join("\n").slice(0, 700)}

Service fee: ${money(order.amounts.serviceFee)}
Delivery: ${money(order.amounts.deliveryFee)}
*Total: ${money(order.amounts.total)}*`);
  } catch (_) {}
  const r = await sendPaymentRequest(doc);
  // Card option too (only lands inside the 24h WhatsApp window - EcoCash request above always goes)
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      await sendButtons(_intl(order.customer.phone), {
        text: `Prefer to pay by *Visa / Mastercard*? Tap below for a secure card link.\nTrack your order any time: *track ${order.reference}*`,
        buttons: [{ id: `grc_paycard_${order.reference}`, title: "💳 Pay by card" }, { id: `grc_order_${order.reference}`, title: "📦 Track order" }]
      });
    } catch (_) {}
  }
  return { doc, ...r };
}

const STATUS_TEXT = {
  shopping:         "🛒 We're shopping for your order now.",
  out_for_delivery: "🏍️ Your order is on the way!",
  delivered:        "✅ Delivered - thank you for shopping with ZimQuote! Type *groceries* to order again.",
  cancelled:        "❌ Your order was cancelled. If you paid, we'll refund you - reply here if you have questions."
};
/** Tell the customer about a status change (admin pages). */
export async function notifyGroceryStatus(order, status, { rider = "", note = "" } = {}) {
  let msg = STATUS_TEXT[status];
  if (!msg) return;
  if (status === "out_for_delivery" && order.delivery?.zone === "collect") msg = `🏪 Your order is *ready to collect* at ${COLLECT_POINT}.`;
  const txt = `*${order.reference}* - ${msg}${rider && status === "out_for_delivery" ? `\nRider: ${rider}` : ""}${note ? `\n${note}` : ""}`;
  const to = _intl(order.customer?.phone);
  try { await sendText(to, txt); }
  catch (_) {
    try { const { _sendTemplate } = await import("./buyerRequestNotifications.js"); await _sendTemplate(to, "zq_order_update", [order.reference, msg.replace(/[*_]/g, "").replace(/\n/g, " ")]); } catch (__) {}
  }
}

// ── My orders ────────────────────────────────────────────────────────────────
const ORDER_STATUS = {
  quote_pending: "⏳ Being priced", awaiting_payment: "💳 Waiting for payment", received: "💳 Waiting for payment",
  paid: "✅ Paid - packing", shopping: "🛒 Shopping", out_for_delivery: "🏍️ On the way / ready to collect",
  delivered: "✅ Delivered", cancelled: "❌ Cancelled"
};
const _payLabel = (o) => o.payment?.status === "paid" ? `✅ Paid${o.payment?.method ? " (" + (o.payment.method === "stripe" ? "card" : o.payment.method) + ")" : ""}`
  : o.hasCustomItems ? "⏳ Not priced yet" : o.payment?.status === "pending" ? "⏳ Payment started" : "❌ Not paid";

async function _myOrders(from) {
  const GroceryOrder = await _GroceryOrder();
  const p = _intl(from), l = _local(from);
  const list = await GroceryOrder.find({ "customer.phone": { $in: [p, l, "+" + p] } }).sort({ createdAt: -1 }).limit(10).lean();
  if (list.length) {
    await _setMode(from, { m: "orders", refs: list.map(o => o.reference) });
    await _markNum(from);
    const lines = list.map((o, i) =>
      `*${i + 1}.* ${o.reference} · ${new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · *${money(o.amounts?.total)}*\n      ${ORDER_STATUS[o.fulfilment?.status] || o.fulfilment?.status || ""} · ${_payLabel(o)}`).join("\n");
    return sendText(from,
`📦 *My grocery orders & payments*

${lines}

👉 *Reply with a number* to track an order, pay for it or order it again.
🛒 *groceries* to shop`);
  }
  return _myOrdersEmpty(from);
}

/** One order: items, totals, payment, delivery and a progress tracker. */
export async function showOrder(from, ref, note = "") {
  const GroceryOrder = await _GroceryOrder();
  const o = await GroceryOrder.findOne({ reference: String(ref).toUpperCase() }).lean();
  if (!o) { await sendText(from, `❌ Order *${String(ref).toUpperCase()}* not found.`); return _myOrders(from); }
  const mine = [_intl(from), _local(from), "+" + _intl(from)].includes(String(o.customer?.phone || "")) || _intl(o.customer?.phone) === _intl(from);
  if (!mine) { await sendText(from, "❌ That order isn't on this WhatsApp number."); return _myOrders(from); }
  const st = o.fulfilment?.status || "received";
  const collect = o.delivery?.zone === "collect";
  const steps = [
    ["Order placed", true],
    ["Paid", o.payment?.status === "paid"],
    ["Shopping & packing", ["shopping", "out_for_delivery", "delivered"].includes(st)],
    [collect ? "Ready to collect" : "On the way", ["out_for_delivery", "delivered"].includes(st)],
    [collect ? "Collected" : "Delivered", st === "delivered"]
  ];
  const track = st === "cancelled" ? "❌ Cancelled" : steps.map(([s, done]) => `${done ? "✅" : "⬜"} ${s}`).join("\n");
  const items = (o.items || []).slice(0, 25).map(i => `• ${i.name} × ${i.qty}${i.custom ? " - _being priced_" : ` - ${money(i.lineTotal)}`}`).join("\n");
  const canPay = o.payment?.status !== "paid" && !o.hasCustomItems && !["cancelled", "delivered"].includes(st);
  const opts = [];
  if (canPay) opts.push(["pay", "💳 Pay now (EcoCash or card)"]);
  opts.push(["reorder", "🔁 Order the same again"]);
  opts.push(["orders", "📦 Back to my orders"]);
  await _setMode(from, { m: "order", ref: o.reference, opts: opts.map(x => x[0]) });
  await _markNum(from);
  return sendText(from,
`${note ? note + "\n\n" : ""}📦 *Order ${o.reference}* · ${new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}

${track}

${items}${(o.items || []).length > 25 ? `\n…+${o.items.length - 25} more` : ""}

Groceries: ${money(o.amounts?.goods)} · Service: ${money(o.amounts?.serviceFee)} · ${collect ? "Collection" : "Delivery"}: ${money(o.amounts?.deliveryFee)}
*Total: ${money(o.amounts?.total)}* · ${_payLabel(o)}
${collect ? `🏪 Collect: ${COLLECT_POINT}` : `📍 ${String(o.delivery?.address || "").slice(0, 120)}`}${o.fulfilment?.rider ? `\n🏍️ Rider: ${o.fulfilment.rider}` : ""}

${opts.map((x, i) => `*${i + 1}.* ${x[1]}`).join("\n")}

👉 *Reply with a number.*  ·  Questions? *${SUPPORT_PHONE}*`);
}

async function _myOrdersEmpty(from) {
  return sendButtons(from, { text: "📦 You have no grocery orders yet.", buttons: [{ id: "grc_pkgs", title: "🎁 Hampers" }, { id: "grc_home", title: "🛒 Groceries" }] });
}

async function _reorder(from, ref) {
  const GroceryOrder = await _GroceryOrder();
  const o = await GroceryOrder.findOne({ reference: ref.toUpperCase() }).lean();
  if (!o) return _myOrders(from);
  const { cart } = await _load(from);
  for (const it of o.items || []) {
    if (it.sku && it.sku.startsWith("pkg:")) _addToCart(cart, { k: it.sku, n: it.name, u: "hamper", q: it.qty, p: it.unitPrice });
    else if (it.sku && CATALOGUE[it.sku]) _addToCart(cart, _skuLine(it.sku, it.qty));
    else _addToCart(cart, { k: null, n: it.name, u: it.unit || "", q: it.qty, p: null });
  }
  await _saveCart(from, cart);
  return showCart(from, `🔁 Added everything from *${o.reference}* at today's prices.`);
}

async function _payOrder(from, ref) {
  return showPayMethods(from, ref);
}

// ═════════════════════════════════════════════════════════════════════════════
// GROCERY CALCULATOR
// ═════════════════════════════════════════════════════════════════════════════
// [sku, units per person per month, priority 1=essential 2=normal 3=extra]
const CALC = [
  ["mealie_meal", 0.7, 1], ["rice", 0.5, 1], ["cooking_oil", 0.4, 1], ["sugar", 0.5, 1], ["salt", 0.15, 1],
  ["beans", 0.4, 1], ["kapenta", 0.3, 2], ["chicken", 0.4, 1], ["beef", 0.4, 2], ["pilchards", 0.4, 2],
  ["flour", 0.2, 2], ["eggs", 0.25, 2], ["bread", 2.5, 2], ["tomatoes", 2, 1], ["onions", 1, 1],
  ["veg", 3, 1], ["potatoes", 0.2, 2], ["cabbage", 0.8, 2], ["milk", 1, 2], ["tea", 0.25, 2],
  ["margarine", 0.3, 3], ["peanut_butter", 0.25, 3], ["soup", 0.5, 2], ["washing", 0.25, 1],
  ["bathsoap", 0.5, 1], ["toiletpaper", 0.5, 1], ["toothpaste", 0.3, 2], ["dishwash", 0.25, 3], ["vaseline", 0.25, 3]
].filter(([s]) => CATALOGUE[s]);

export function calcBasket(people, period = "month", budget = null) {
  const f = period === "week" ? 1 / 4.3 : 1;
  let lines = CALC.map(([sku, per, pri]) => {
    const raw = per * people * f;
    const q = pri === 1 ? Math.max(1, Math.round(raw + 0.2)) : Math.round(raw);
    return { sku, q, pri };
  }).filter(l => l.q > 0);
  const total = () => r2(lines.reduce((t, l) => t + CATALOGUE[l.sku][2] * l.q, 0));
  if (budget && budget > 0) {
    let guard = 500;
    while (total() > budget && guard-- > 0) {
      // Trim extras first, then normal items; essentials keep at least 1.
      // Within a priority, cut the line with the most units (spreads the cut).
      const cand = lines.filter(l => l.q > (l.pri === 1 ? 1 : 0))
        .sort((a, b) => (b.pri - a.pri) || (b.q - a.q) || (CATALOGUE[b.sku][2] - CATALOGUE[a.sku][2]))[0];
      if (!cand) break;
      cand.q -= 1;
      lines = lines.filter(l => l.q > 0);
    }
  }
  return { lines, total: total() };
}

async function _showCalc(from, people, period, budget = null) {
  const { lines, total } = calcBasket(people, period, budget);
  await _setMode(from, { m: "calc_done", people, period, budget, basket: lines.map(l => [l.sku, l.q]) });
  const days = period === "week" ? 7 : 30;
  const body = lines.map(l => `• ${l.q} × ${_itemName(l.sku)} - ${money(CATALOGUE[l.sku][2] * l.q)}`).join("\n");
  return _textThenButtons(from,
`🧮 *Groceries for ${people} ${people === 1 ? "person" : "people"} - one ${period}*${budget ? ` (budget ${money(budget)})` : ""}

${body}

*Estimated total: ${money(total)}*
≈ ${money(total / people / days)} per person per day${period === "week" && people <= 2 ? "\n_Staples like mealie meal and oil last longer than a week._" : ""}
_+ service fee; delivery from $4 or free collection._${budget && total > budget ? `\n⚠️ ${money(budget)} is below the basic basket - this is the smallest list we suggest.` : ""}`,
    [
      { id: "grc_calcadd", title: "🛒 Add all to cart" },
      { id: "grc_calcbud", title: budget ? "💲 Change budget" : "💲 Fit my budget" },
      { id: "grc_pkgs",    title: "🎁 See hampers" }
    ],
    `🧮 Estimated total: *${money(total)}* for ${people} ${people === 1 ? "person" : "people"}, one ${period}.`);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY - called by chatbotEngine.js before the free-text grabbers
// ═════════════════════════════════════════════════════════════════════════════
const ENTRY_RE = /^(?:zq:grocer(?:y|ies)|groceries|grocery|grocery shop|grocery store|buy groceries|order groceries|groceries delivery|grocery delivery|hampers?|grocery hampers?|christmas hampers?|my grocery cart|grocery cart|grocery list|zvekudya|grosari)[.!]?$/i;
const ORDERS_RE = /^(?:my grocery orders?|grocery orders?|grocery payments?|track my groceries|track grocery order)[.!]?$/i;

/**
 * @returns {Promise<boolean>} true when the message was handled here.
 *  action   = button id (lower-case) when isTap, else ""
 *  dispatch = (action) => re-enter the engine (for "search sellers")
 */
export async function handleGroceryMessage({ from, text = "", action = "", isTap = false, imageUrl = null, dispatch = null }) {
  const a = String(action || "").toLowerCase();
  if (a.startsWith("grc_")) { await _handleAction(from, a, dispatch); return true; }

  const t = String(text || "").trim();
  if (isTap) {                                    // any other button → leave the shop (cart kept)
    if (t || a) await _disarmIfArmed(from);
    return false;
  }
  // "track GRO-ABC123" works anywhere (from the order confirmation)
  const _trk = t.match(/^(?:track|order|status)\s+(gro-[a-z0-9-]{4,40})$/i) || t.match(/^(gro-[a-z0-9]{4,12})$/i);
  if (_trk) { await showOrder(from, _trk[1]); return true; }
  if (ORDERS_RE.test(t)) { await _myOrders(from); return true; }
  if (t && (ENTRY_RE.test(t) || /^(?:hi+e?[,! ]+)?(?:i\s+(?:want|would like|need)\s+to\s+)?(?:order|buy)\s+(?:some\s+)?(?:groceries|grocery)\b[\w\s,.!]{0,60}$/i.test(t))) {
    if (/hamper/i.test(t)) await showPackages(from); else await showHome(from);
    return true;
  }

  const { mode } = await _load(from);
  if (!mode) return false;

  // A newer numbered list (seller search, schools…) owns a typed number → leave the shop
  if (/^\d{1,3}$/.test(t) && await _newerList(from)) { await _setMode(from, null); return false; }

  if (imageUrl) {                                 // photo of a shopping list
    const { cart } = await _load(from);
    _addToCart(cart, { k: null, n: "Shopping list photo", u: "", q: 1, p: null, img: imageUrl });
    await _saveCart(from, cart);
    await _addedMsg(from, [], [{ n: "📷 your list photo", q: 1 }], { asked: true });
    return true;
  }
  if (!t) return false;

  // Leaving words / a marketplace search → fall through to the normal bot
  if (/^(0|00|menu|main menu|hi|hie|hey|hello|start|exit|stop|bye)$/i.test(t) ||
      /^(find|search|looking for|look for|zq:)/i.test(t)) { await _setMode(from, null); return false; }

  const lt = t.toLowerCase();
  // Shop-wide words
  if (/^(cart|my cart|basket|view cart|show cart|trolley)$/.test(lt)) { await showCart(from); return true; }
  if (/^(checkout|check out|pay|order now|place order|done)$/.test(lt) && !String(mode.m).startsWith("co_")) { await startCheckout(from); return true; }
  if (/^(hampers?|packages?|baskets?)$/.test(lt)) { await showPackages(from); return true; }
  if (/^(aisles?|shop|price ?list|prices)$/.test(lt)) { await showAisles(from); return true; }
  if (/^(calc|calculator|budget)$/.test(lt)) { await _handleAction(from, "grc_calc"); return true; }
  if (/^(orders|my orders|my grocery orders|payments|my payments|track|track order|track my order)$/.test(lt)) { await _myOrders(from); return true; }
  if (/^(delivery|delivery fees|fees|areas|collection|collect)$/.test(lt) && !String(mode.m).startsWith("co_")) { await showDeliveryInfo(from); return true; }
  if (/^(clear|clear cart|empty cart|empty)$/.test(lt)) { await _saveCart(from, []); await showCart(from, "🗑️ Cart cleared."); return true; }
  if (/^(cancel)$/.test(lt) && String(mode.m).startsWith("co_")) { await showCart(from, "👍 Checkout stopped - your cart is saved."); return true; }

  // Cart edits: "remove 2", "delete 2", "-2", "2=3"
  let m;
  if ((m = lt.match(/^(?:remove|delete|del|rm|-)\s*(\d{1,2})$/))) {
    const { cart } = await _load(from);
    const i = +m[1] - 1;
    if (!cart[i]) { await sendText(from, `Your cart has ${cart.length} line${cart.length === 1 ? "" : "s"} - type *cart* to see the numbers.`); return true; }
    const gone = cart.splice(i, 1)[0];
    await _saveCart(from, cart);
    await showCart(from, `🗑️ Removed ${gone.n}.`);
    return true;
  }
  if ((m = lt.match(/^(\d{1,2})\s*=\s*(\d{1,2})$/))) {
    const { cart } = await _load(from);
    const i = +m[1] - 1, q = +m[2];
    if (!cart[i]) { await sendText(from, "Type *cart* to see the line numbers."); return true; }
    if (q === 0) cart.splice(i, 1); else cart[i].q = q;
    await _saveCart(from, cart);
    await showCart(from, "✏️ Cart updated.");
    return true;
  }

  // Mode-specific replies
  switch (mode.m) {
    case "home": {
      if (/^[1-7]$/.test(lt)) {
        const map = { 1: "grc_pkgs", 2: "grc_aisles", 3: "grc_list", 4: "grc_calc", 5: "grc_cart", 6: "grc_orders", 7: "grc_info" };
        await _handleAction(from, map[lt], dispatch); return true;
      }
      break;
    }
    case "pkgs": {
      if (/^\d{1,2}$/.test(lt)) {
        const key = (mode.keys || [])[+lt - 1];
        if (!key) { await sendText(from, `Please reply with a number from 1 to ${(mode.keys || []).length}.`); return true; }
        await showPackage(from, key); return true;
      }
      break;
    }
    case "aisles": {
      if (/^\d{1,2}$/.test(lt)) {
        const id = (mode.ids || [])[+lt - 1];
        if (!id) { await sendText(from, `Please reply with a number from 1 to ${(mode.ids || []).length}.`); return true; }
        await showAisle(from, id); return true;
      }
      break;
    }
    case "aisle": {
      if (/^\s*\d{1,2}(\s*[x×*]\s*\d{1,2})?(\s*[,;\s]\s*\d{1,2}(\s*[x×*]\s*\d{1,2})?)*\s*$/.test(lt)) {
        const skus = mode.skus || [];
        const { cart } = await _load(from);
        const added = [], bad = [];
        for (const part of lt.replace(/\s*[x×*]\s*/g, "x").split(/[,;\s]+/).filter(Boolean)) {
          const pm = part.match(/^(\d{1,2})(?:x(\d{1,2}))?$/);
          if (!pm) continue;
          const sku = skus[+pm[1] - 1];
          if (!sku || !CATALOGUE[sku]) { bad.push(pm[1]); continue; }
          const q = Math.max(1, +(pm[2] || 1));
          _addToCart(cart, _skuLine(sku, q));
          added.push({ n: CATALOGUE[sku][0], u: CATALOGUE[sku][1], q });
        }
        await _saveCart(from, cart);
        if (!added.length) { await sendText(from, `Those numbers aren't in this aisle (1-${skus.length}).`); return true; }
        await _addedMsg(from, added, []);
        await _setMode(from, { ...mode, at: undefined });       // stay in the aisle for more numbers
        if (bad.length) await sendText(from, `(${bad.join(", ")} not in this aisle - ignored)`);
        return true;
      }
      break;
    }
    case "calc_people": {
      const n = parseInt(lt, 10);
      if (n >= 1 && n <= 20 && /^\d{1,2}$/.test(lt)) {
        await _setMode(from, { m: "calc_period", people: n });
        await sendButtons(from, {
          text: `🧮 Groceries for *${n} ${n === 1 ? "person" : "people"}* - for how long?`,
          buttons: [{ id: "grc_calcp_w", title: "📅 One week" }, { id: "grc_calcp_m", title: "🗓️ One month" }]
        });
        return true;
      }
      await sendText(from, "Please type the number of people, e.g. *4*.");
      return true;
    }
    case "calc_budget": {
      const b = parseFloat(lt.replace(/[^0-9.]/g, ""));
      if (b >= 5 && b <= 5000) { await _showCalc(from, mode.people || 4, mode.period || "month", b); return true; }
      await sendText(from, "Type your budget in US dollars, e.g. *80*.");
      return true;
    }
    case "co_zone": {
      if (/^\d{1,2}$/.test(lt)) {
        const z = (mode.zones || [])[+lt - 1];
        if (!z) { await sendText(from, `Please reply with a number from 1 to ${(mode.zones || []).length}.`); return true; }
        await _pickZone(from, z); return true;
      }
      await sendText(from, "👉 Reply with the number of your area, or type *cart* to go back.");
      return true;
    }
    case "pay_method": {
      if (lt === "1") { await _payEcocash(from, mode.ref); return true; }
      if (lt === "2" && mode.card) { await _payCardLink(from, mode.ref); return true; }
      if (/^(ecocash|onemoney|eco cash|mobile)$/.test(lt)) { await _payEcocash(from, mode.ref); return true; }
      if (/^(card|visa|mastercard|bank card)$/.test(lt) && mode.card) { await _payCardLink(from, mode.ref); return true; }
      await sendText(from, `👉 Reply *1* for EcoCash/OneMoney${mode.card ? " or *2* for card" : ""}.`);
      return true;
    }
    case "orders": {
      if (/^\d{1,2}$/.test(lt)) {
        const ref = (mode.refs || [])[+lt - 1];
        if (!ref) { await sendText(from, `Please reply with a number from 1 to ${(mode.refs || []).length}.`); return true; }
        await showOrder(from, ref); return true;
      }
      break;
    }
    case "order": {
      if (/^\d$/.test(lt)) {
        const op = (mode.opts || [])[+lt - 1];
        if (op === "pay") { await showPayMethods(from, mode.ref); return true; }
        if (op === "reorder") { await _reorder(from, mode.ref); return true; }
        if (op === "orders") { await _myOrders(from); return true; }
        await sendText(from, `Please reply with a number from 1 to ${(mode.opts || []).length}.`);
        return true;
      }
      break;
    }
    case "co_addr": {
      if (t.length < 8 || !/[a-z]/i.test(t)) { await sendText(from, "Please send the full address: name, house number & street, suburb and a landmark."); return true; }
      await _summary(from, { zone: mode.zone, address: t.slice(0, 200) });
      return true;
    }
    case "co_name": {
      await _summary(from, { zone: mode.zone, who: t.slice(0, 120) });
      return true;
    }
    case "co_confirm": {
      if (/^(yes|y|ok|confirm|1|pay|pay now)$/.test(lt)) { await _confirm(from, mode); return true; }
      if (lt === "2") { await showCart(from); return true; }
      if (lt === "3") { await showCart(from, "👍 Checkout stopped - your cart is saved."); return true; }
      break;
    }
    case "ask": {
      if (/^(yes|y|ok|add)$/.test(lt)) { await _handleAction(from, "grc_addraw", dispatch); return true; }
      break;
    }
    case "list": {
      if (/[a-z]/i.test(t)) { await _addTyped(from, t, { allowUnknown: true }); return true; }
      break;
    }
    default: break;
  }

  // Anything with letters → add to cart (typed list)
  if (/[a-z]/i.test(t) && !String(mode.m).startsWith("co_")) {
    if (await _addTyped(from, t)) return true;
  }
  if (/^\d{1,3}$/.test(lt)) {
    await sendText(from, "🛒 Type *aisles* for the price list, *hampers* for baskets, *cart* to see your cart - or type what you want, e.g. *2 sugar*.");
    return true;
  }
  return false;
}

async function _disarmIfArmed(from) {
  try {
    const US = await _US();
    await US.updateOne({ phone: _digits(from), "tempData.grc": { $exists: true } }, { $unset: { "tempData.grc": "" } });
  } catch (_) {}
}

async function _handleAction(from, a, dispatch = null) {
  if (a === "grc_home") return showHome(from);
  if (a === "grc_pkgs") return showPackages(from);
  if (a.startsWith("grc_pkg_")) return showPackage(from, a.slice(8));
  if (a.startsWith("grc_padd_")) {
    const p = await _pkg(a.slice(9));
    if (!p) return showPackages(from);
    const { cart } = await _load(from);
    _addToCart(cart, { k: `pkg:${p.key}`, n: p.name, u: "hamper", q: 1, p: p.price });
    await _saveCart(from, cart);
    return _addedMsg(from, [{ n: p.name, u: "", q: 1 }], [], { asked: true });
  }
  if (a === "grc_aisles") return showAisles(from);
  if (a === "grc_list") {
    await _setMode(from, { m: "list" });
    return sendText(from,
`✍️ *Send your shopping list*

Type it in one message - one item per line or separated by commas:
_10kg mealie meal_
_2 cooking oil_
_3 bread, eggs, avocados_

📷 Or send a *photo* of your handwritten list.
We price what we stock instantly. Anything we don't stock, our team prices and replies here (8am-6pm), then you pay with EcoCash or card.`);
  }
  if (a === "grc_cart") return showCart(from);
  if (a === "grc_clear") { await _saveCart(from, []); return showCart(from, "🗑️ Cart cleared."); }
  if (a === "grc_checkout") return startCheckout(from);
  if (a.startsWith("grc_zone_")) return _pickZone(from, a.slice(9));
  if (a === "grc_cme") {
    const { mode } = await _load(from);
    return _summary(from, { zone: mode?.zone || "collect", who: `Me (${_local(from)})` });
  }
  if (a === "grc_confirm") {
    const { mode } = await _load(from);
    if (!mode || mode.m !== "co_confirm") return startCheckout(from);
    return _confirm(from, mode);
  }
  if (a === "grc_cancel_co") return showCart(from, "👍 Checkout stopped - your cart is saved.");
  if (a === "grc_calc") {
    await _setMode(from, { m: "calc_people" });
    return sendText(from, "🧮 *Grocery calculator*\n\nHow many people are you buying for? Reply with a number, e.g. *4*.");
  }
  if (a === "grc_calcp_w" || a === "grc_calcp_m") {
    const { mode } = await _load(from);
    return _showCalc(from, mode?.people || 4, a.endsWith("_w") ? "week" : "month");
  }
  if (a === "grc_calcbud") {
    const { mode } = await _load(from);
    await _setMode(from, { m: "calc_budget", people: mode?.people || 4, period: mode?.period || "month" });
    return sendText(from, "💲 What's your budget in US dollars? e.g. *80*\n\nWe'll keep the essentials and trim the extras to fit.");
  }
  if (a === "grc_calcadd") {
    const { mode, cart } = await _load(from);
    const basket = mode?.basket || calcBasket(4, "month").lines.map(l => [l.sku, l.q]);
    const added = [];
    for (const [sku, q] of basket) if (CATALOGUE[sku]) { _addToCart(cart, _skuLine(sku, q)); added.push({ n: CATALOGUE[sku][0], u: CATALOGUE[sku][1], q }); }
    await _saveCart(from, cart);
    return showCart(from, `✅ Added ${added.length} items from the calculator. Remove anything you don't need with *remove 3*.`);
  }
  if (a === "grc_orders") return _myOrders(from);
  if (a === "grc_info") return showDeliveryInfo(from);
  if (a.startsWith("grc_order_")) return showOrder(from, a.slice(10));
  if (a.startsWith("grc_paymeth_")) return showPayMethods(from, a.slice(12));
  if (a.startsWith("grc_payeco_")) return _payEcocash(from, a.slice(11));
  if (a.startsWith("grc_paycard_")) return _payCardLink(from, a.slice(12));
  if (a.startsWith("grc_reorder_")) return _reorder(from, a.slice(12));
  if (a.startsWith("grc_payorder_")) return _payOrder(from, a.slice(13));
  if (a === "grc_addraw") {
    const { mode } = await _load(from);
    if (!mode?.raw) return showCart(from);
    return _addTyped(from, mode.raw, { allowUnknown: true });
  }
  if (a === "grc_search") {
    const { mode } = await _load(from);
    await _setMode(from, null);
    if (mode?.raw && dispatch) {
      try {
        const { runAutoCitySearch } = await import("./findMenu.js");
        return runAutoCitySearch({ from, biz: null, saveBiz: null, product: mode.raw, dispatch });
      } catch (_) {}
    }
    if (dispatch) return dispatch("find_supplier");
    return sendText(from, "Type what you're looking for, e.g. *electrician harare*.");
  }
  return showHome(from);
}

export default { handleGroceryMessage, showHome, priceCart, parseList, matchSku, getPackages, calcBasket, markGroceryPaid, sendGroceryPaymentRequest, notifyGroceryStatus, onWebOrderPaid };

// routes/pageSellersAdmin.js
// Zq-admin > 🧩 Page Sellers: choose which sellers / businesses / smart links
// appear on each zimqoute.co.zw blog post, tool and city page.
// Registered from routes/supplierAdmin.js:
//   registerPageSellersAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge });
import express from "express";
import mongoose from "mongoose";
import PageSellers from "../models/pageSellers.js";
import SupplierProfile from "../models/supplierProfile.js";
import { assignSlugToSupplier } from "../services/supplierSmartLink.js";
import { normPath, safeLink, waLink, clearPageSellersCache } from "../services/pageSellers.js";

const SITE = "https://zimqoute.co.zw";

// Pages on zimqoute.co.zw (from the site files). fixed = has the built-in
// "Trusted ... on ZimQuote" seller box. live = has a live provider list (city picker).
const SITE_PAGES = [
  {"path": "/blog/brake-pads-and-discs-price-harare", "title": "Brake Pads & Discs Prices in Harare (2026 Guide)", "group": "Blog", "fixed": 1},
  {"path": "/blog/buy-genuine-auto-spares-harare", "title": "How to Buy Genuine Auto Spares in Harare Without Getting Ripped Off", "group": "Blog", "fixed": 1},
  {"path": "/blog/clutch-brakes-hydraulics-service-guide", "title": "Clutch, Brakes & Hydraulics: A Zimbabwean Driver's Service Guide", "group": "Blog", "fixed": 1},
  {"path": "/blog/squealing-or-vibrating-brakes-zimbabwe", "title": "Squealing or Vibrating Brakes? What Your Car Is Telling You (Zimbabwe)", "group": "Blog", "fixed": 1},
  {"path": "/plumber-quote-generator-zimbabwe", "title": "Free Plumber Quote & Invoice Generator Zimbabwe - Make Professional Quotes", "group": "Tools"},
  {"path": "/plumbing-cost-calculator-zimbabwe", "title": "Plumbing Cost Calculator Zimbabwe 2026 - Geyser, Tank, Leak & Drain Prices", "group": "Tools", "live": 1},
  {"path": "/tools/building-materials-calculator-zimbabwe", "title": "Building Materials Cost Calculator Zimbabwe 2026 (Prices & Estimator)", "group": "Tools", "live": 1},
  {"path": "/tools/car-import-duty-calculator", "title": "Car Import Duty Calculator Zimbabwe 2026 (ZIMRA Estimate)", "group": "Tools", "fixed": 1},
  {"path": "/tools/car-service-cost-calculator-zimbabwe", "title": "Car Spare Parts & Service Price Checker Zimbabwe 2026 - Find Parts by Make, Model & Year", "group": "Tools"},
  {"path": "/tools/fuel-cost-calculator-zimbabwe", "title": "Fuel Cost Calculator Zimbabwe 2026 - Trip, Profit & Split", "group": "Tools", "fixed": 1},
  {"path": "/tools/grocery-price-calculator-zimbabwe", "title": "Grocery Price Calculator Zimbabwe 2026 - Monthly Basket Cost", "group": "Tools"},
  {"path": "/tools/plumber-quote-generator-zimbabwe", "title": "Free Plumber Quote & Invoice Generator Zimbabwe - Make Professional Quotes", "group": "Tools"},
  {"path": "/tools/plumbing-cost-calculator-zimbabwe", "title": "Plumbing Cost Calculator Zimbabwe 2026 - Geyser, Tank, Leak & Drain Prices", "group": "Tools", "live": 1},
  {"path": "/tools/school-fees-calculator-zimbabwe", "title": "Zimbabwe School Fees Calculator & School Finder 2026", "group": "Tools"},
  {"path": "/tools/solar-system-calculator-zimbabwe", "title": "Solar System Size & Cost Calculator Zimbabwe 2026", "group": "Tools", "live": 1},
  {"path": "/auto-spares-in-bulawayo", "title": "Auto Spares in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages", "fixed": 1},
  {"path": "/auto-spares-in-chitungwiza", "title": "Auto Spares in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages", "fixed": 1},
  {"path": "/auto-spares-in-harare", "title": "Auto Spares in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages", "fixed": 1},
  {"path": "/auto-spares-in-mutare", "title": "Auto Spares in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages", "fixed": 1},
  {"path": "/auto-spares-zimbabwe", "title": "Auto Spares in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages", "fixed": 1},
  {"path": "/borehole-drilling-in-bulawayo", "title": "Borehole Drilling in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/borehole-drilling-in-chitungwiza", "title": "Borehole Drilling in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/borehole-drilling-in-harare", "title": "Borehole Drilling in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/borehole-drilling-in-mutare", "title": "Borehole Drilling in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/borehole-drilling-zimbabwe", "title": "Borehole Drilling in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/builders-in-bulawayo", "title": "Builders & Construction in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/builders-in-chitungwiza", "title": "Builders & Construction in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/builders-in-harare", "title": "Builders & Construction in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/builders-in-mutare", "title": "Builders & Construction in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/builders-zimbabwe", "title": "Builders & Construction in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/cleaning-services-in-bulawayo", "title": "Cleaning Services in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/cleaning-services-in-chitungwiza", "title": "Cleaning Services in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/cleaning-services-in-harare", "title": "Cleaning Services in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/cleaning-services-in-mutare", "title": "Cleaning Services in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/cleaning-services-zimbabwe", "title": "Cleaning Services in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/electricians-in-bulawayo", "title": "Electricians in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/electricians-in-chitungwiza", "title": "Electricians in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/electricians-in-harare", "title": "Electricians in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/electricians-in-mutare", "title": "Electricians in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/electricians-zimbabwe", "title": "Electricians in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/groceries-wholesalers-in-bulawayo", "title": "Groceries & Wholesalers in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/groceries-wholesalers-in-chitungwiza", "title": "Groceries & Wholesalers in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/groceries-wholesalers-in-harare", "title": "Groceries & Wholesalers in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/groceries-wholesalers-in-mutare", "title": "Groceries & Wholesalers in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/groceries-wholesalers-zimbabwe", "title": "Groceries & Wholesalers in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/grocery-delivery-avondale-harare", "title": "Grocery Delivery in Avondale, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-borrowdale-harare", "title": "Grocery Delivery in Borrowdale, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-budiriro-harare", "title": "Grocery Delivery in Budiriro, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-chitungwiza-harare", "title": "Grocery Delivery in Chitungwiza, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-eastlea-harare", "title": "Grocery Delivery in Eastlea, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-epworth-harare", "title": "Grocery Delivery in Epworth, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-glen-view-harare", "title": "Grocery Delivery in Glen View, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-greendale-harare", "title": "Grocery Delivery in Greendale, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-harare", "title": "Grocery & Snacks Delivery Harare | Shop, Pay EcoCash or Visa", "group": "City & service pages"},
  {"path": "/grocery-delivery-highfield-harare", "title": "Grocery Delivery in Highfield, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-highlands-harare", "title": "Grocery Delivery in Highlands, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-kuwadzana-harare", "title": "Grocery Delivery in Kuwadzana, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-marlborough-harare", "title": "Grocery Delivery in Marlborough, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-mbare-harare", "title": "Grocery Delivery in Mbare, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-mount-pleasant-harare", "title": "Grocery Delivery in Mount Pleasant, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-norton-harare", "title": "Grocery Delivery in Norton, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-ruwa-harare", "title": "Grocery Delivery in Ruwa, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-the-avenues-harare", "title": "Grocery Delivery in The Avenues, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/grocery-delivery-waterfalls-harare", "title": "Grocery Delivery in Waterfalls, Harare - Order & Pay EcoCash or Card", "group": "City & service pages"},
  {"path": "/lodges-accommodation-in-bulawayo", "title": "Lodges & Accommodation in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/lodges-accommodation-in-chitungwiza", "title": "Lodges & Accommodation in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/lodges-accommodation-in-harare", "title": "Lodges & Accommodation in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/lodges-accommodation-in-mutare", "title": "Lodges & Accommodation in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/lodges-accommodation-zimbabwe", "title": "Lodges & Accommodation in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/painters-in-bulawayo", "title": "Painters in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/painters-in-chitungwiza", "title": "Painters in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/painters-in-harare", "title": "Painters in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/painters-in-mutare", "title": "Painters in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/painters-zimbabwe", "title": "Painters in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/plumbers-in-bulawayo", "title": "Plumbers in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/plumbers-in-chitungwiza", "title": "Plumbers in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/plumbers-in-harare", "title": "Plumbers in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/plumbers-in-mutare", "title": "Plumbers in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/plumbers-zimbabwe", "title": "Plumbers in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/schools-in-bulawayo", "title": "Schools in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/schools-in-chitungwiza", "title": "Schools in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/schools-in-harare", "title": "Schools in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/schools-in-mutare", "title": "Schools in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/schools-zimbabwe", "title": "Schools in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/security-cctv-in-bulawayo", "title": "Security & CCTV in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/security-cctv-in-chitungwiza", "title": "Security & CCTV in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/security-cctv-in-harare", "title": "Security & CCTV in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/security-cctv-in-mutare", "title": "Security & CCTV in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/security-cctv-zimbabwe", "title": "Security & CCTV in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/solar-installers-in-bulawayo", "title": "Solar Installers in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/solar-installers-in-chitungwiza", "title": "Solar Installers in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/solar-installers-in-harare", "title": "Solar Installers in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/solar-installers-in-mutare", "title": "Solar Installers in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/solar-installers-zimbabwe", "title": "Solar Installers in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/tilers-in-bulawayo", "title": "Tilers in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/tilers-in-chitungwiza", "title": "Tilers in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/tilers-in-harare", "title": "Tilers in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/tilers-in-mutare", "title": "Tilers in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/tilers-zimbabwe", "title": "Tilers in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/welders-in-bulawayo", "title": "Welders & Metal Fabrication in Bulawayo, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/welders-in-chitungwiza", "title": "Welders & Metal Fabrication in Chitungwiza, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/welders-in-harare", "title": "Welders & Metal Fabrication in Harare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/welders-in-mutare", "title": "Welders & Metal Fabrication in Mutare, Zimbabwe | Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/welders-zimbabwe", "title": "Welders & Metal Fabrication in Zimbabwe | Get Quotes on WhatsApp", "group": "City & service pages"},
  {"path": "/", "title": "ZimQuote - Buy & Sell Near You on WhatsApp in Zimbabwe", "group": "Other"},
  {"path": "/blog", "title": "Auto Spares & Brake Services Blog - Zimbabwe", "group": "Other"},
  {"path": "/find-services", "title": "Find Services & Suppliers Across Zimbabwe on WhatsApp", "group": "Other"},
  {"path": "/list-your-business", "title": "List Your Plumbing or Trade Business Free in Zimbabwe — Get Job Requests", "group": "Other"},
  {"path": "/send-groceries-to-zimbabwe", "title": "Send Groceries to Zimbabwe from Abroad - Delivered in Harare with Photo Proof", "group": "Other"},
  {"path": "/tools", "title": "Free Zimbabwe Tools & Calculators - Fuel, Duty, School Fees, Solar", "group": "Other"},
  {"path": "/request-a-quote", "title": "Request a quote for anything in Zimbabwe", "group": "Other"},
  {"path": "/tools/house-plan-cost-estimator-zimbabwe", "title": "House plan cost estimator (Zimbabwe 2026)", "group": "Tools"},
  {"path": "/tools/brick-calculator-zimbabwe", "title": "Brick & block calculator", "group": "Tools"},
  {"path": "/tools/concrete-calculator-zimbabwe", "title": "Concrete calculator - cement, sand & stone", "group": "Tools"},
  {"path": "/construction-equipment-hire-zimbabwe", "title": "Construction & plant equipment hire", "group": "Tools"},
  {"path": "/steel-prices-zimbabwe", "title": "Steel & hardware quote builder", "group": "Tools"},
  {"path": "/glass-aluminium-windows-doors-zimbabwe", "title": "Glass & aluminium - windows, doors & showers", "group": "Tools"},
  {"path": "/tools/borehole-drilling-cost-calculator-zimbabwe", "title": "Borehole drilling cost calculator", "group": "Tools"},
  {"path": "/tools/transformer-size-calculator-zimbabwe", "title": "Transformer size calculator (kVA)", "group": "Tools"},
  {"path": "/mining-equipment-zimbabwe", "title": "Mining equipment - buy or hire", "group": "Tools"},
  {"path": "/tools/small-scale-gold-mining-cost-calculator-zimbabwe", "title": "Small-scale gold mining cost planner", "group": "Tools"},
  {"path": "/exploration-drilling-zimbabwe", "title": "Exploration drilling - get contractors to quote", "group": "Tools"},
  {"path": "/zimquote-for-mining-companies", "title": "ZimQuote for mining companies", "group": "Other"},
  {"path": "/tools/farm-input-cost-calculator-zimbabwe", "title": "Farm input cost calculator", "group": "Tools"},
  {"path": "/farming-equipment-irrigation-zimbabwe", "title": "Farm equipment & irrigation", "group": "Tools"},
  {"path": "/tools/stand-development-cost-calculator-zimbabwe", "title": "Stand development cost calculator", "group": "Tools"},
  {"path": "/tools/delivery-cost-calculator-zimbabwe", "title": "Delivery cost calculator - biker prices", "group": "Tools"},
  {"path": "/whatsapp-delivery-zimbabwe", "title": "Same-day delivery on WhatsApp", "group": "Tools"},
  {"path": "/become-a-delivery-rider-zimbabwe", "title": "Earn with your motorbike", "group": "Tools"},
  {"path": "/private-tutors-zimbabwe", "title": "Find a private tutor", "group": "Tools"},
  {"path": "/blog/cost-to-build-a-house-in-zimbabwe", "title": "How much does it cost to build a house in Zimbabwe in 2026?", "group": "Blog"},
  {"path": "/blog/delivery-problems-in-zimbabwe", "title": "Delivery in Zimbabwe: the 6 biggest problems - and how to fix them", "group": "Blog"},
  {"path": "/blog/how-to-choose-a-private-tutor-zimbabwe", "title": "How to choose a private tutor in Zimbabwe", "group": "Blog"},
  {"path": "/blog/small-scale-mining-equipment-guide-zimbabwe", "title": "Small-scale mining equipment: what to buy first", "group": "Blog"}
];

// What the fixed box shows today (so "start from what's on the page" is one tap).
const FIXED_DEFAULT = {
  heading: "🚗 Trusted car & vehicle services on ZimQuote",
  sub: "Tap a business to chat on WhatsApp",
  listCardTitle: "🔧 Garage, spares or auto service?",
  listCardText: "Get customers from these free tools — list your business and appear here like the others.",
  items: [
    { slug: "auto-brakes", name: "Auto Brakes", badge: "⭐ Recommended", top: true, meta: "Brakes · Clutch · Machining · Workington, Harare" },
    { slug: "parts-connection-zimbabwe", name: "Parts Connection Zimbabwe", badge: "Featured", top: true, meta: "Tractor & vehicle spare parts · Workington, Harare" },
    { slug: "terraquip-tractor-spares", name: "Terraquip Tractor Spares", badge: "Pro", top: false, meta: "Tractor spares (MF, Ford, Fiat, Landini…) · Harare" },
  ],
};
const BADGES = ["", "⭐ Recommended", "Featured", "Pro", "✓ Verified", "⭐ Top rated", "Trusted", "New"];

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const isId = v => mongoose.Types.ObjectId.isValid(String(v || "")) && String(v).length === 24;
const rxEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Accepts https links, or WhatsApp text like "ZQ:S:auto-brakes" / "find plumber Harare".
function linkFrom(v) {
  const s = str(v, 500);
  if (!s) return "";
  if (/^(javascript|data|vbscript|file):/i.test(s)) return "";
  if (/^https:\/\//i.test(s)) return safeLink(s);
  if (/^http:\/\//i.test(s)) return safeLink("https://" + s.slice(7));
  if (/^wa\.me\//i.test(s)) return safeLink("https://" + s);
  return waLink(s.slice(0, 300));
}

async function fixedItems() {
  const sups = await SupplierProfile.find({ zqSlug: { $in: FIXED_DEFAULT.items.map(i => i.slug) } }).select("_id zqSlug").lean();
  const bySlug = new Map(sups.map(s => [s.zqSlug, s]));
  return FIXED_DEFAULT.items.map(i => {
    const s = bySlug.get(i.slug);
    return s ? { kind: "supplier", supplier: s._id, slug: i.slug, name: i.name, meta: i.meta, badge: i.badge, top: i.top }
             : { kind: "custom", name: i.name, meta: i.meta, badge: i.badge, top: i.top, link: waLink("ZQ:S:" + i.slug) };
  });
}

export function registerPageSellersAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge }) {
  const e = esc;
  const pform = express.urlencoded({ extended: false, limit: "1mb" });
  const go = (res, url, kind, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`);
  const flash = req => (req.query.success ? `<div class="zqp-flash ok">✅ ${e(req.query.success)}</div>` : "") +
                       (req.query.error ? `<div class="zqp-flash bad">❌ ${e(req.query.error)}</div>` : "");
  const pageInfo = path => SITE_PAGES.find(p => p.path === path) || null;
  const editUrl = path => `/zq-admin/page-sellers/edit?path=${encodeURIComponent(path)}`;

  const css = `<style>
.zqp{--ln:#e2e8f0;--mu:#64748b}
.zqp .card2{background:#fff;border:1px solid var(--ln);border-radius:12px;padding:16px 18px;margin:0 0 16px}
.zqp h3{margin:0 0 6px;font-size:1.05rem}.zqp .mu{color:var(--mu)}.zqp .sm{font-size:.85rem}
.zqp label{display:block;font-weight:600;font-size:.88rem;margin:10px 0 4px}
.zqp input:not([type=checkbox]):not([type=radio]),.zqp select,.zqp textarea{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;box-sizing:border-box;background:#fff}
.zqp .chk{display:flex;gap:8px;align-items:center;font-weight:normal;margin:6px 0}
.zqp .two{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
.zqp .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.zqp .acts form{margin:0}
.zqp table{width:100%;border-collapse:collapse;background:#fff}
.zqp th,.zqp td{padding:9px 10px;border-bottom:1px solid var(--ln);text-align:left;vertical-align:top;font-size:.88rem}
.zqp th{background:#f8fafc;color:var(--mu);font-weight:600}
.zqp code{background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:.8rem}
.zqp-flash{padding:11px 14px;border-radius:8px;margin-bottom:14px}.zqp-flash.ok{background:#dcfce7;color:#166534}.zqp-flash.bad{background:#fee2e2;color:#991b1b}
.zqp .it{border:1px solid var(--ln);border-radius:10px;padding:10px 12px;margin:8px 0;background:#fcfdfe}
.zqp .it.top{border-color:#f5c842;background:#fffdf5}
.zqp .it .hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.zqp .it .hd b{flex:1;min-width:160px}
.zqp .it .row{display:grid;grid-template-columns:170px 1fr 1fr;gap:8px;margin-top:8px}
.zqp .mini{padding:4px 9px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:.8rem}
.zqp .res{border:1px solid var(--ln);border-radius:8px;max-height:280px;overflow:auto;margin-top:6px;background:#fff}
.zqp .res div{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f5f9;align-items:center}
.zqp .pv{max-width:640px}
.zqp .pv .g{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.zqp .pv .t{border:1px solid #e6ebe9;border-radius:10px;padding:10px;background:#fff}
.zqp .pv .t.top{border:1.5px solid #f5c842;background:#fffdf5}
.zqp .pv .bd{background:#eef7f4;color:#0b5245;border-radius:999px;padding:1px 8px;font-size:.66rem;font-weight:700}
.zqp .pv .c{margin-top:6px;font-size:.78rem;font-weight:700;color:#fff;background:#128C7E;border-radius:7px;padding:6px;text-align:center}
@media(max-width:700px){.zqp .two,.zqp .it .row,.zqp .pv .g{grid-template-columns:1fr}}
</style>`;
  const wrap = h => `${css}<div class="zqp">${h}</div>`;
  const tabs = active => `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
<a class="btn btn-sm ${active === "list" ? "btn-blue" : "btn-gray"}" href="/zq-admin/page-sellers">🧩 All pages</a>
<a class="btn btn-sm ${active === "bulk" ? "btn-blue" : "btn-gray"}" href="/zq-admin/page-sellers/bulk">➕ Add one seller to many pages</a>
<a class="btn btn-sm btn-gray" href="${SITE}" target="_blank" rel="noopener">🌐 Open zimqoute.co.zw</a></div>`;

  // ── List of pages ───────────────────────────────────────────────────────────
  router.get("/page-sellers", requireSupplierAdmin, async (req, res) => {
    try {
      const docs = await PageSellers.find({}).select("path title status items pinLive updatedAt").lean();
      const byPath = new Map(docs.map(d => [d.path, d]));
      const pages = [...SITE_PAGES];
      docs.forEach(d => { if (!pageInfo(d.path)) pages.push({ path: d.path, title: d.title || d.path, group: "Added by you" }); });
      const groups = ["Blog", "Tools", "City & service pages", "Other", "Added by you"];
      const builtIn = p => [p.fixed ? "Fixed seller box" : "", p.live ? "Live list (city picker)" : ""].filter(Boolean).join(" + ") || '<span class="mu">— (box is added when you pick sellers)</span>';
      const state = d => !d ? badge("Built-in", "gray")
        : d.status === "hidden" ? badge("Hidden", "red")
        : badge(`Your picks: ${(d.items || []).length}${d.pinLive ? " · on live list" : ""}`, "green");
      const rows = g => pages.filter(p => p.group === g).map(p => {
        const d = byPath.get(p.path);
        return `<tr data-q="${e((p.title + " " + p.path).toLowerCase())}"><td><b>${e(p.title)}</b><br><code>${e(p.path)}</code></td>
<td class="sm">${builtIn(p)}</td><td>${state(d)}</td>
<td style="white-space:nowrap"><a class="btn btn-sm btn-blue" href="${editUrl(p.path)}">Edit</a>
<a class="btn btn-sm btn-gray" href="${SITE}${p.path === "/" ? "/" : p.path + "/"}" target="_blank" rel="noopener">View ↗</a></td></tr>`;
      }).join("");
      const fixedLeft = SITE_PAGES.filter(p => p.fixed && !byPath.has(p.path)).length;

      const html = `${tabs("list")}${flash(req)}
<div class="card2"><h3>🧩 Sellers on each website page</h3>
<p class="mu sm">Pick which businesses show on each blog post, tool and city page of zimqoute.co.zw. Pages you haven't touched keep showing what's built into them (<b>Built-in</b>). Changes show on the site within about a minute.</p>
<div class="acts"><input id="q" placeholder="Search pages…" style="max-width:320px">
<form method="post" action="/zq-admin/page-sellers/add" style="display:flex;gap:6px"><input name="path" placeholder="Another page, e.g. /blog/new-post" style="width:260px" required><button class="btn btn-sm btn-green">Add page</button></form>
${fixedLeft ? `<form method="post" action="/zq-admin/page-sellers/import-fixed" onsubmit="return confirm('Copy the current fixed sellers (Auto Brakes, Parts Connection, Terraquip) into ${fixedLeft} page(s) so you can edit them here? The website looks the same until you change something.')"><button class="btn btn-sm btn-gray">📥 Copy current fixed sellers into ${fixedLeft} page(s)</button></form>` : ""}
</div></div>
${groups.map(g => { const r = rows(g); return r ? `<div class="card2" style="padding:0;overflow:auto"><h3 style="padding:14px 16px 6px">${e(g)}</h3>
<table><thead><tr><th>Page</th><th>Built into the page</th><th>Now showing</th><th></th></tr></thead><tbody>${r}</tbody></table></div>` : ""; }).join("")}
<script>document.getElementById("q").addEventListener("input",function(){var v=this.value.toLowerCase().trim();document.querySelectorAll("tr[data-q]").forEach(function(r){r.style.display=!v||r.dataset.q.indexOf(v)>=0?"":"none";});});</script>`;
      res.send(layout("Page Sellers", wrap(html)));
    } catch (err) {
      console.error("[page-sellers list]", err);
      res.status(500).send(layout("Page Sellers", wrap(`<div class="zqp-flash bad">Could not load pages: ${e(err.message)}</div>`)));
    }
  });

  router.post("/page-sellers/add", requireSupplierAdmin, pform, (req, res) => {
    const path = normPath(req.body.path);
    if (path === "/" && !String(req.body.path || "").trim()) return go(res, "/zq-admin/page-sellers", "error", "Type the page address.");
    res.redirect(editUrl(path));
  });

  router.post("/page-sellers/import-fixed", requireSupplierAdmin, async (req, res) => {
    try {
      const items = await fixedItems();
      let n = 0;
      for (const p of SITE_PAGES.filter(p => p.fixed)) {
        const exists = await PageSellers.exists({ path: p.path });
        if (exists) continue;
        await PageSellers.create({ path: p.path, title: p.title, status: "managed",
          heading: FIXED_DEFAULT.heading, sub: FIXED_DEFAULT.sub, showListCard: true,
          listCardTitle: FIXED_DEFAULT.listCardTitle, listCardText: FIXED_DEFAULT.listCardText,
          items, updatedBy: req.session?.supplierAdminUser || "admin" });
        n++;
      }
      clearPageSellersCache();
      go(res, "/zq-admin/page-sellers", "success", `Copied the fixed sellers into ${n} page(s). Edit any page to change them.`);
    } catch (err) { go(res, "/zq-admin/page-sellers", "error", err.message); }
  });

  // ── Seller search (JSON, used by the editor) ───────────────────────────────
  router.get("/page-sellers/find", requireSupplierAdmin, async (req, res) => {
    try {
      const q = str(req.query.q, 60);
      if (q.length < 2) return res.json({ results: [] });
      const rx = new RegExp(rxEsc(q), "i");
      const list = await SupplierProfile.find({ $or: [{ businessName: rx }, { zqSlug: rx }, { "location.city": rx }, { "location.area": rx }, { categories: rx }] })
        .select("businessName zqSlug location tier active profileType").sort({ active: -1, tierRank: -1 }).limit(25).lean();
      res.json({ results: list.map(s => ({ id: String(s._id), name: s.businessName || "(no name)", slug: s.zqSlug || "",
        place: [s.location?.area, s.location?.city].filter(Boolean).join(", "), tier: s.tier || "", active: s.active !== false, type: s.profileType || "" })) });
    } catch (err) { res.json({ results: [], error: err.message }); }
  });

  // ── Edit one page ──────────────────────────────────────────────────────────
  router.get("/page-sellers/edit", requireSupplierAdmin, async (req, res) => {
    try {
      const path = normPath(req.query.path);
      const info = pageInfo(path) || { path, title: path, group: "Added by you" };
      const doc = await PageSellers.findOne({ path }).lean();
      const fresh = !doc;
      let d = doc;
      if (!d) d = info.fixed
        ? { status: "managed", heading: FIXED_DEFAULT.heading, sub: FIXED_DEFAULT.sub, showListCard: true, listCardTitle: FIXED_DEFAULT.listCardTitle, listCardText: FIXED_DEFAULT.listCardText, items: await fixedItems(), pinLive: false, liveMode: "pin" }
        : { status: "managed", heading: "", sub: "Tap a business to chat on WhatsApp", showListCard: true, listCardTitle: "", listCardText: "", items: [], pinLive: !!info.live, liveMode: "pin" };

      // Load supplier details for the editor rows.
      const ids = (d.items || []).filter(i => i.kind === "supplier" && i.supplier).map(i => i.supplier);
      const sups = ids.length ? await SupplierProfile.find({ _id: { $in: ids } }).select("businessName zqSlug location active tier").lean() : [];
      const byId = new Map(sups.map(s => [String(s._id), s]));
      const items = (d.items || []).map(i => {
        if (i.kind === "custom") return { kind: "custom", name: i.name || "", meta: i.meta || "", link: i.link || "", badge: i.badge || "", top: !!i.top, cities: i.cities || "" };
        const s = byId.get(String(i.supplier));
        return { kind: "supplier", id: String(i.supplier), label: s ? s.businessName : "(deleted seller)", slug: s?.zqSlug || i.slug || "",
          place: s ? [s.location?.area, s.location?.city].filter(Boolean).join(", ") : "", active: s ? s.active !== false : false, missing: !s,
          name: i.name || "", meta: i.meta || "", badge: i.badge || "", top: !!i.top, cities: i.cities || "" };
      });
      const data = { items, cta: d.ctaSupplier ? String(d.ctaSupplier) : "", live: !!info.live, badges: BADGES };
      const json = JSON.stringify(data).replace(/</g, "\\u003c");

      const html = `${tabs("")}${flash(req)}
<div class="card2"><h3>${e(info.title)}</h3>
<div class="sm mu"><code>${e(path)}</code> · <a href="${SITE}${path === "/" ? "/" : path + "/"}" target="_blank" rel="noopener">View page ↗</a>
${fresh ? ` · ${badge(info.fixed ? "Built-in sellers shown below — save to manage them here" : "Not managed yet", "gray")}` : doc.status === "hidden" ? ` · ${badge("Hidden on site", "red")}` : ` · ${badge("Managed here", "green")}`}</div></div>

<form method="post" action="/zq-admin/page-sellers/save" id="pf">
<input type="hidden" name="path" value="${e(path)}"><input type="hidden" name="title" value="${e(info.title)}">
<input type="hidden" name="items" id="itemsField">

<div class="card2"><h3>Sellers box</h3>
<label class="chk"><input type="radio" name="status" value="managed" ${d.status !== "hidden" ? "checked" : ""}> Show the sellers I pick below</label>
<label class="chk"><input type="radio" name="status" value="hidden" ${d.status === "hidden" ? "checked" : ""}> Hide the sellers box on this page</label>
<div class="two">
<div><label>Heading</label><input name="heading" maxlength="120" value="${e(d.heading || "")}" placeholder="e.g. 🚗 Trusted car & vehicle services on ZimQuote"></div>
<div><label>Small line under the heading</label><input name="sub" maxlength="160" value="${e(d.sub || "")}" placeholder="Tap a business to chat on WhatsApp"></div>
</div>
<label class="chk"><input type="checkbox" name="showListCard" value="1" ${d.showListCard !== false ? "checked" : ""}> Show the “List my business free” card under the sellers</label>
<div class="two">
<div><label>Card title</label><input name="listCardTitle" maxlength="120" value="${e(d.listCardTitle || "")}" placeholder="🔧 Garage, spares or auto service?"></div>
<div><label>Card text</label><input name="listCardText" maxlength="240" value="${e(d.listCardText || "")}" placeholder="List your business and appear here like the others."></div>
</div></div>

<div class="card2"><h3>Sellers on this page <span class="mu sm" id="cnt"></span></h3>
<p class="mu sm">Order here = order on the page. Gold = highlighted tile. Sellers that are not active are skipped on the site automatically until they're active again.</p>
<div id="list"></div>
<div class="two" style="margin-top:12px">
<div><label>➕ Add a seller from ZimQuote</label><input id="fq" placeholder="Type a business name, slug, city or category…" autocomplete="off"><div class="res" id="fr" style="display:none"></div></div>
<div><label>➕ Or add your own card (any link)</label>
<input id="cn" placeholder="Name, e.g. Auto Brakes Bulawayo" maxlength="80" style="margin-bottom:6px">
<input id="cm" placeholder="Small line, e.g. Brakes · Clutch · Bulawayo" maxlength="120" style="margin-bottom:6px">
<input id="cl" placeholder="Link: https://… or WhatsApp text like ZQ:S:auto-brakes" maxlength="400" style="margin-bottom:6px">
<button type="button" class="btn btn-sm btn-gray" id="cadd">Add card</button></div>
</div></div>

<div class="card2"><h3>Main buttons on the page</h3>
<p class="mu sm">Blog posts and tools also have big “Chat on WhatsApp” buttons (top, middle and the round floating button) that open one seller. Choose who they open, or leave them as they are.</p>
<select name="ctaSupplier" id="cta"></select></div>

${info.live || d.pinLive ? `<div class="card2"><h3>Live provider list (city picker)</h3>
<p class="mu sm">This page also lists providers live by city. Your sellers can sit at the top of that list.</p>
<label class="chk"><input type="checkbox" name="pinLive" value="1" ${d.pinLive ? "checked" : ""}> Put my sellers at the top of the live list</label>
<label>How</label><select name="liveMode"><option value="pin" ${d.liveMode !== "only" ? "selected" : ""}>My sellers first, then the live results</option><option value="only" ${d.liveMode === "only" ? "selected" : ""}>Only my sellers</option></select>
<p class="mu sm">Tip: on the live list you can limit a seller to some cities (the “Cities” box on each seller). Blank = every city.</p></div>` : ""}

<div class="card2"><h3>Preview</h3><div class="pv" id="pv"></div></div>

<div class="acts"><button class="btn btn-green">💾 Save page</button><a class="btn btn-gray" href="/zq-admin/page-sellers">Back</a></div>
</form>
${doc ? `<form method="post" action="/zq-admin/page-sellers/reset" style="margin-top:12px" onsubmit="return confirm('Stop managing this page? It goes back to what is built into the page.')">
<input type="hidden" name="path" value="${e(path)}"><button class="btn btn-sm btn-gray">↩️ Go back to the built-in sellers</button></form>` : ""}

<script>
(function(){
var D=${json};var items=D.items;
function h(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
var list=document.getElementById("list"),cta=document.getElementById("cta"),pv=document.getElementById("pv");
function badgeSel(v,i){var o=D.badges.map(function(b){return '<option value="'+h(b)+'"'+(b===v?" selected":"")+'>'+(b||"No badge")+'</option>';}).join("");
  if(v&&D.badges.indexOf(v)<0)o+='<option selected value="'+h(v)+'">'+h(v)+'</option>';return '<select data-i="'+i+'" data-f="badge">'+o+'<option value="__own">Type my own…</option></select>';}
function draw(){
  list.innerHTML=items.length?items.map(function(it,i){
    var title=it.kind==="custom"?("🔗 "+h(it.name||"Card")):("🏪 "+h(it.label)+(it.slug?' <code>'+h(it.slug)+'</code>':' <span class="mu sm">(smart link made on save)</span>'));
    var warn=it.kind==="supplier"&&(it.missing?' <span style="color:#b91c1c" class="sm">deleted — remove it</span>':(!it.active?' <span style="color:#b45309" class="sm">not active — hidden on site</span>':''));
    return '<div class="it'+(it.top?" top":"")+'"><div class="hd"><b>'+(i+1)+'. '+title+warn+(it.place?' <span class="mu sm">· '+h(it.place)+'</span>':'')+'</b>'+
      '<label class="chk sm" style="margin:0"><input type="checkbox" data-i="'+i+'" data-f="top"'+(it.top?" checked":"")+'> Gold</label>'+
      '<button type="button" class="mini" data-up="'+i+'">▲</button><button type="button" class="mini" data-dn="'+i+'">▼</button><button type="button" class="mini" data-rm="'+i+'">✕ Remove</button></div>'+
      '<div class="row">'+badgeSel(it.badge,i)+
      '<input data-i="'+i+'" data-f="name" maxlength="80" placeholder="'+(it.kind==="custom"?"Name":"Name on page (blank = "+h(it.label)+")")+'" value="'+h(it.name)+'">'+
      '<input data-i="'+i+'" data-f="meta" maxlength="120" placeholder="Small line (blank = area, city)" value="'+h(it.meta)+'"></div>'+
      (it.kind==="custom"?'<div class="row" style="grid-template-columns:1fr"><input data-i="'+i+'" data-f="link" maxlength="400" placeholder="Link" value="'+h(it.link)+'"></div>':'')+
      (D.live?'<div class="row" style="grid-template-columns:1fr"><input data-i="'+i+'" data-f="cities" maxlength="120" placeholder="Cities on the live list (blank = all), e.g. Harare, Bulawayo" value="'+h(it.cities)+'"></div>':'')+
      '</div>';}).join(""):'<p class="mu">No sellers yet. Add some below.</p>';
  document.getElementById("cnt").textContent=items.length?"("+items.length+")":"";
  var cur=cta.value||D.cta;
  cta.innerHTML='<option value="">Leave the buttons as they are</option>'+items.filter(function(it){return it.kind==="supplier"&&it.id;}).map(function(it){return '<option value="'+it.id+'"'+(it.id===cur?" selected":"")+'>Open '+h(it.label)+'</option>';}).join("");
  preview();
}
function preview(){
  var f=document.getElementById("pf"),E=function(n){return f.querySelector('[name="'+n+'"]');},st=f.querySelector('[name="status"]:checked');
  if(st&&st.value==="hidden"){pv.innerHTML='<p class="mu">The sellers box is hidden on this page.</p>';return;}
  var head=E("heading").value||"(page's own heading)",sub=E("sub").value;
  pv.innerHTML='<b>'+h(head)+'</b><div class="mu sm" style="margin-bottom:8px">'+h(sub)+'</div><div class="g">'+items.map(function(it){
    var nm=it.name||(it.kind==="custom"?"Card":it.label),meta=it.meta||it.place||"";
    return '<div class="t'+(it.top?" top":"")+'">'+(it.badge?'<span class="bd">'+h(it.badge)+'</span>':'')+'<div><b>'+h(nm)+'</b></div><div class="mu sm">'+h(meta)+'</div><div class="c">Chat on WhatsApp</div></div>';}).join("")+'</div>'+
    (E("showListCard").checked?'<div class="mu sm" style="margin-top:8px;border:1px dashed #0d6b5e;border-radius:8px;padding:8px"><b>'+h(E("listCardTitle").value||"(page's own card)")+'</b> — '+h(E("listCardText").value)+' <u>List my business free</u></div>':'');
}
list.addEventListener("input",function(ev){var t=ev.target,i=t.getAttribute("data-i"),f=t.getAttribute("data-f");if(i==null)return;
  if(f==="top"){items[i].top=t.checked;draw();return;}
  if(f==="badge"&&t.value==="__own"){var v=prompt("Badge text (short)","");items[i].badge=(v||"").slice(0,30);draw();return;}
  items[i][f]=t.value;preview();});
list.addEventListener("change",function(ev){var t=ev.target;if(t.getAttribute("data-f")==="badge"&&t.value!=="__own"){items[t.getAttribute("data-i")].badge=t.value;preview();}});
list.addEventListener("click",function(ev){var t=ev.target,i;
  if((i=t.getAttribute("data-up"))!=null&&i>0){items.splice(i-1,0,items.splice(i,1)[0]);draw();}
  else if((i=t.getAttribute("data-dn"))!=null&&i<items.length-1){items.splice(+i+1,0,items.splice(i,1)[0]);draw();}
  else if((i=t.getAttribute("data-rm"))!=null){items.splice(i,1);draw();}});
var fq=document.getElementById("fq"),fr=document.getElementById("fr"),tm;
fq.addEventListener("input",function(){clearTimeout(tm);var q=fq.value.trim();if(q.length<2){fr.style.display="none";return;}
  tm=setTimeout(function(){fetch("/zq-admin/page-sellers/find?q="+encodeURIComponent(q),{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(d){
    var r=d.results||[];fr.style.display="block";
    fr.innerHTML=r.length?r.map(function(s,k){return '<div><span><b>'+h(s.name)+'</b> <span class="mu sm">'+h(s.place)+(s.tier?" · "+h(s.tier):"")+(s.type?" · "+h(s.type):"")+(s.active?"":" · not active")+(s.slug?"":" · no smart link yet")+'</span></span><button type="button" class="mini" data-k="'+k+'">Add</button></div>';}).join(""):'<div class="mu">No sellers found.</div>';
    fr.onclick=function(ev){var k=ev.target.getAttribute("data-k");if(k==null)return;var s=r[k];
      if(items.some(function(it){return it.id===s.id;})){alert("Already on this page.");return;}
      items.push({kind:"supplier",id:s.id,label:s.name,slug:s.slug,place:s.place,active:s.active,name:"",meta:"",badge:"",top:false,cities:""});draw();};
  }).catch(function(){fr.style.display="block";fr.innerHTML='<div class="mu">Search failed — are you still logged in?</div>';});},250);});
document.getElementById("cadd").addEventListener("click",function(){var n=document.getElementById("cn"),m=document.getElementById("cm"),l=document.getElementById("cl");
  if(!n.value.trim()||!l.value.trim()){alert("Give the card a name and a link.");return;}
  items.push({kind:"custom",name:n.value.trim(),meta:m.value.trim(),link:l.value.trim(),badge:"",top:false,cities:""});n.value=m.value=l.value="";draw();});
document.getElementById("pf").addEventListener("input",function(ev){if(!list.contains(ev.target))preview();});
document.getElementById("pf").addEventListener("change",function(ev){if(!list.contains(ev.target))preview();});
document.getElementById("pf").addEventListener("submit",function(){document.getElementById("itemsField").value=JSON.stringify(items);});
draw();
})();
</script>`;
      res.send(layout(`Page Sellers: ${info.title}`, wrap(html)));
    } catch (err) {
      console.error("[page-sellers edit]", err);
      go(res, "/zq-admin/page-sellers", "error", err.message);
    }
  });

  router.post("/page-sellers/save", requireSupplierAdmin, pform, async (req, res) => {
    const path = normPath(req.body.path);
    try {
      let raw = [];
      try { raw = JSON.parse(req.body.items || "[]"); } catch (_) { return go(res, editUrl(path), "error", "Could not read the seller list. Try again."); }
      if (!Array.isArray(raw)) raw = [];
      const items = [];
      const notes = [];
      for (const r of raw.slice(0, 40)) {
        const base = { name: str(r.name, 80), meta: str(r.meta, 120), badge: str(r.badge, 30), top: !!r.top, cities: str(r.cities, 120) };
        if (r.kind === "custom") {
          const link = linkFrom(r.link);
          if (!base.name || !link) { notes.push(`skipped a card without a name or link`); continue; }
          items.push({ kind: "custom", ...base, link });
          continue;
        }
        if (!isId(r.id)) continue;
        const s = await SupplierProfile.findById(r.id).select("businessName zqSlug").lean();
        if (!s) { notes.push(`removed a deleted seller`); continue; }
        let slug = s.zqSlug || "";
        if (!slug) {
          try { slug = await assignSlugToSupplier(String(s._id)) || ""; } catch (err) { console.error("[page-sellers slug]", err.message); }
          if (!slug) notes.push(`${s.businessName} has no smart link yet, so it won't show until one is assigned (Assign Slugs)`);
        }
        items.push({ kind: "supplier", supplier: s._id, slug, ...base });
      }
      const ctaId = isId(req.body.ctaSupplier) && items.some(i => String(i.supplier) === String(req.body.ctaSupplier)) ? req.body.ctaSupplier : null;
      const update = {
        path, title: str(req.body.title, 160),
        status: req.body.status === "hidden" ? "hidden" : "managed",
        heading: str(req.body.heading, 120), sub: str(req.body.sub, 160),
        showListCard: req.body.showListCard === "1",
        listCardTitle: str(req.body.listCardTitle, 120), listCardText: str(req.body.listCardText, 240),
        pinLive: req.body.pinLive === "1", liveMode: req.body.liveMode === "only" ? "only" : "pin",
        ctaSupplier: ctaId, items,
        updatedBy: req.session?.supplierAdminUser || "admin",
      };
      await PageSellers.findOneAndUpdate({ path }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true });
      clearPageSellersCache();
      go(res, editUrl(path), "success", `Saved. ${items.length} seller(s) on this page — live on the site within a minute.${notes.length ? " Note: " + [...new Set(notes)].join("; ") + "." : ""}`);
    } catch (err) {
      console.error("[page-sellers save]", err);
      go(res, editUrl(path), "error", err.message);
    }
  });

  router.post("/page-sellers/reset", requireSupplierAdmin, pform, async (req, res) => {
    const path = normPath(req.body.path);
    try {
      await PageSellers.deleteOne({ path });
      clearPageSellersCache();
      go(res, "/zq-admin/page-sellers", "success", `${path} is back to its built-in sellers.`);
    } catch (err) { go(res, editUrl(path), "error", err.message); }
  });

  // ── One seller → many pages ────────────────────────────────────────────────
  router.get("/page-sellers/bulk", requireSupplierAdmin, async (req, res) => {
    const docs = await PageSellers.find({}).select("path title").lean().catch(() => []);
    const pages = [...SITE_PAGES];
    docs.forEach(d => { if (!pageInfo(d.path)) pages.push({ path: d.path, title: d.title || d.path, group: "Added by you" }); });
    const groups = ["Blog", "Tools", "City & service pages", "Other", "Added by you"];
    const html = `${tabs("bulk")}${flash(req)}
<form method="post" action="/zq-admin/page-sellers/bulk" id="bf"><input type="hidden" name="id" id="bid">
<div class="card2"><h3>1. Choose the seller</h3>
<input id="fq" placeholder="Type a business name, slug, city or category…" autocomplete="off"><div class="res" id="fr" style="display:none"></div>
<p id="picked" class="sm" style="margin-top:8px"></p>
<div class="two"><div><label>Badge</label><select name="badge">${BADGES.map(b => `<option value="${e(b)}">${e(b || "No badge")}</option>`).join("")}</select></div>
<div><label>Small line (blank = area, city)</label><input name="meta" maxlength="120"></div></div>
<label class="chk"><input type="checkbox" name="top" value="1"> Gold highlighted tile</label>
<label class="chk"><input type="checkbox" name="first" value="1" checked> Put it first on each page</label>
<label class="chk"><input type="checkbox" name="pinLive" value="1"> On tool pages with a live list, also show it at the top of that list</label></div>
<div class="card2"><h3>2. Tick the pages</h3><input id="pq" placeholder="Filter pages…" style="max-width:320px">
${groups.map(g => { const ps = pages.filter(p => p.group === g); return ps.length ? `<p style="margin-top:12px"><b>${e(g)}</b> <a href="#" class="sm" data-all="${e(g)}">tick all</a></p>` +
  ps.map(p => `<label class="chk pg" data-g="${e(g)}" data-q="${e((p.title + " " + p.path).toLowerCase())}"><input type="checkbox" name="paths" value="${e(p.path)}"> ${e(p.title)} <code>${e(p.path)}</code></label>`).join("") : ""; }).join("")}
</div>
<div class="acts"><button class="btn btn-green">➕ Add to ticked pages</button></div></form>
<p class="mu sm">Pages that were still “Built-in” keep their current sellers and get this one added. Pages that already have it are skipped.</p>
<script>(function(){
function h(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
var fq=document.getElementById("fq"),fr=document.getElementById("fr"),tm;
fq.addEventListener("input",function(){clearTimeout(tm);var q=fq.value.trim();if(q.length<2){fr.style.display="none";return;}
 tm=setTimeout(function(){fetch("/zq-admin/page-sellers/find?q="+encodeURIComponent(q),{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(d){var r=d.results||[];fr.style.display="block";
 fr.innerHTML=r.length?r.map(function(s,k){return '<div><span><b>'+h(s.name)+'</b> <span class="mu sm">'+h(s.place)+(s.active?"":" · not active")+'</span></span><button type="button" class="mini" data-k="'+k+'">Choose</button></div>';}).join(""):'<div class="mu">No sellers found.</div>';
 fr.onclick=function(ev){var k=ev.target.getAttribute("data-k");if(k==null)return;document.getElementById("bid").value=r[k].id;document.getElementById("picked").innerHTML="✅ Chosen: <b>"+h(r[k].name)+"</b>";fr.style.display="none";};});},250);});
document.getElementById("pq").addEventListener("input",function(){var v=this.value.toLowerCase().trim();document.querySelectorAll(".pg").forEach(function(r){r.style.display=!v||r.dataset.q.indexOf(v)>=0?"":"none";});});
document.querySelectorAll("[data-all]").forEach(function(a){a.addEventListener("click",function(ev){ev.preventDefault();var g=a.getAttribute("data-all");document.querySelectorAll('.pg').forEach(function(l){if(l.getAttribute("data-g")===g&&l.style.display!=="none")l.querySelector("input").checked=true;});});});
document.getElementById("bf").addEventListener("submit",function(ev){if(!document.getElementById("bid").value){ev.preventDefault();alert("Choose a seller first.");}});
})();</script>`;
    res.send(layout("Page Sellers: Bulk", wrap(html)));
  });

  router.post("/page-sellers/bulk", requireSupplierAdmin, pform, async (req, res) => {
    try {
      if (!isId(req.body.id)) return go(res, "/zq-admin/page-sellers/bulk", "error", "Choose a seller first.");
      const s = await SupplierProfile.findById(req.body.id).select("businessName zqSlug").lean();
      if (!s) return go(res, "/zq-admin/page-sellers/bulk", "error", "Seller not found.");
      let slug = s.zqSlug || "";
      if (!slug) { try { slug = await assignSlugToSupplier(String(s._id)) || ""; } catch (_) {} }
      const paths = [].concat(req.body.paths || []).map(normPath).filter(Boolean).slice(0, 200);
      if (!paths.length) return go(res, "/zq-admin/page-sellers/bulk", "error", "Tick at least one page.");
      const item = { kind: "supplier", supplier: s._id, slug, name: "", meta: str(req.body.meta, 120), badge: str(req.body.badge, 30), top: req.body.top === "1", cities: "" };
      let added = 0, skipped = 0;
      for (const path of [...new Set(paths)]) {
        const info = pageInfo(path) || { path, title: path };
        let doc = await PageSellers.findOne({ path });
        if (!doc) {
          const seed = info.fixed ? await fixedItems() : [];
          doc = new PageSellers({ path, title: info.title, status: "managed",
            heading: info.fixed ? FIXED_DEFAULT.heading : "", sub: FIXED_DEFAULT.sub, showListCard: true,
            listCardTitle: info.fixed ? FIXED_DEFAULT.listCardTitle : "", listCardText: info.fixed ? FIXED_DEFAULT.listCardText : "",
            items: seed });
        }
        if (doc.items.some(i => String(i.supplier) === String(s._id))) { skipped++; continue; }
        if (req.body.first === "1") doc.items.unshift(item); else doc.items.push(item);
        if (req.body.pinLive === "1" && info.live) doc.pinLive = true;
        doc.updatedBy = req.session?.supplierAdminUser || "admin";
        await doc.save();
        added++;
      }
      clearPageSellersCache();
      go(res, "/zq-admin/page-sellers", "success", `${s.businessName} added to ${added} page(s)${skipped ? `, ${skipped} already had it` : ""}.${slug ? "" : " It has no smart link yet, so it won't show until one is assigned."}`);
    } catch (err) {
      console.error("[page-sellers bulk]", err);
      go(res, "/zq-admin/page-sellers/bulk", "error", err.message);
    }
  });
}

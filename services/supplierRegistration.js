// services/supplierRegistration.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import { SUPPLIER_CITIES, SUPPLIER_CATEGORIES } from "./supplierPlans.js";

// ── Category-specific product/service examples ────────────────────────────
export const CATEGORY_PRODUCT_EXAMPLES = {
  // ── New categories ─────────────────────────────────────────────────────────
  industrial_equipment: ["generator 5kVA", "compressor", "lathe machine", "water pump industrial", "welding machine"],
  building_materials:  ["Portland cement 50kg", "river sand", "face brick", "IBR roofing sheet 3m", "steel bar Y12"],
  hardware_tools:      ["hammer", "nails 3 inch", "padlock 50mm", "angle grinder 115mm", "spirit level"],
  plumbing_supplies: [
  "110mm pvc pipe",
  "110mm pvc ug pipe",
  "110mm ac pvc pipe",
  "50mm waste pipe",
  "32mm p trap",
  "40mm p trap",
  "50mm p trap",
  "32mm bottle trap",
  "100mm floor drain",
  "110mm inspection eye",
  "110mm plain bend",
  "110mm h t bend",
  "110mm plain tee",
  "110mm access tee",
  "110mm y junction",
  "110-50 reducer tee",
  "110mm vent valve",
  "110mm boss connector",
  "50mm plain bend",
  "50mm ie bend",
  "50mm ic tee",
  "gulley p",
  "gulley heads",
  "15mm pipe clip",
  "20mm pipe clip",
  "15mm male connector",
  "15mm cap elbow",
  "22mm cap elbow",
  "3/4 cu elbow",
  "22mm cu pipe",
  "15mm cu pipe",
  "solvent cement",
  "soldering wire",
  "nasco flux",
  "gas canister",
  "masonry disk",
  "basin pedestal",
  "basin waste",
  "toilet lid",
  "shower rose and arm"
],
  electrical_supplies: ["electrical cable 2.5mm", "DB board 8-way", "circuit breaker 16A", "LED downlight 10W", "double plug socket"],
  solar_energy:        ["solar panel 400W", "inverter 3kVA", "battery 100Ah AGM", "solar geyser 200L", "charge controller 40A"],
  stationery:          ["pens (box)", "A4 paper ream", "notebooks", "printer toner", "stapler"],
  other_products:      ["product a", "product b", "product c"],
  // ── Existing categories (keep for backward compat) ─────────────────────────
  groceries:           ["cooking oil", "rice", "sugar", "mealie meal", "flour"],
  clothing:            ["t-shirts", "jeans", "sneakers", "school uniform", "work boots"],
  hardware:            ["cement", "roofing sheets", "steel bar"],
  agriculture:         ["maize seed", "fertilizer AN 50kg", "pesticide", "irrigation pipe", "water pump"],
  electronics:         ["phone charger", "earphones", "LED bulb", "inverter", "extension cord"],
  crossborder:         ["solar panel", "generator", "power bank"],
  cosmetics:           ["face cream", "hair relaxer", "body lotion", "perfume"],
  furniture:           ["sofa", "bed frame", "dining table", "wardrobe"],
  car_supplies:        ["car battery 45Ah", "engine oil 5L", "brake pads", "tyres", "shock absorber"],
  health:              ["paracetamol", "vitamins", "blood pressure monitor", "first aid kit"],
  other:               ["product a", "product b", "product c"]
};

export const CATEGORY_SERVICE_EXAMPLES = {
  // ── Trade & Artisan ────────────────────────────────────────────────────────
  carpentry:           ["door fitting", "built-in cupboards", "kitchen units", "window frames", "decking"],
  landscaping:         ["lawn mowing", "tree trimming", "garden design", "irrigation installation", "paving"],
  tiling_flooring:     ["floor tiling", "wall tiling", "wooden floors", "epoxy flooring", "carpet laying"],
  air_conditioning:    ["AC installation", "AC repair & service", "fridge repair", "cold room install"],
  glazing_aluminium:   ["aluminium windows", "glass replacement", "shower screens", "mirror installation"],
  // ── White Collar / Professional ────────────────────────────────────────────
  accounting:          ["bookkeeping", "tax returns (ZIMRA)", "payroll processing", "financial statements", "VAT registration"],
  legal:               ["contract drafting", "company registration", "property conveyancing", "notary services"],
  financial_advisory:  ["investment planning", "insurance advisory", "business valuation", "loan advisory"],
  hr_recruitment:      ["recruitment & headhunting", "HR consulting", "staff training", "labour relations"],
  marketing_digital:   ["social media management", "SEO & Google Ads", "website development", "branding & logo", "content creation"],
  architecture_design: ["architectural plans", "structural engineering", "interior design", "quantity surveying"],
  medical_health:      ["GP consultation", "dental services", "physiotherapy", "home nursing", "nutrition counselling"],
  real_estate:         ["property sales", "property management", "property valuations", "tenant finding"],
  engineering_services: ["structural design", "electrical installation design", "machine design", "project engineering", "site supervision"],
  events_management:   ["event planning", "wedding coordination", "MC services", "DJ hire", "tent & decor hire"],
  // ── Blue Collar / General ──────────────────────────────────────────────────
  other_services:      ["handyman", "pest control", "laundry & dry cleaning", "pool maintenance"],
  // ── Existing (kept for backward compat) ────────────────────────────────────
  plumbing:            ["burst pipe repair", "geyser installation", "blocked drain", "toilet fitting"],
  electrical:          ["house wiring", "DB board installation", "solar installation", "fault finding"],
  construction:        ["bricklaying", "plastering", "roofing", "tiling", "house renovations"],
  painting:            ["interior painting", "exterior painting", "roof painting", "texture coat"],
  welding:             ["gate fabrication", "burglar bars", "steel door", "carport"],
  cleaning:            ["office cleaning", "carpet cleaning", "deep clean", "window cleaning"],
  transport:           ["car hire", "delivery", "airport transfers", "furniture removal"],
  food_cooked:         ["catering", "wedding cake", "lunch boxes", "event catering"],
  printing:            ["business cards", "banners", "flyers", "branded t-shirts"],
  beauty:              ["hair braiding", "nails", "makeup", "massage"],
  photography:         ["wedding photos", "passport photos", "events coverage", "drone footage"],
  tutoring:            ["maths tutor", "O-Level prep", "A-Level tuition", "driving lessons"],
  // ── Hospitality & Tourism ───────────────────────────────────────────────────
  lodge:               ["Double room", "Twin room", "Family chalet", "Self-catering unit", "Bush chalet"],
  hotel:               ["Standard room", "Deluxe room", "Suite", "Family room", "Conference room"],
  guesthouse:          ["En-suite double", "Twin room with breakfast", "Self-catering unit"],
  safari_operator:     ["Game drive (morning)", "Game drive (afternoon)", "Night drive", "Walking safari", "Bush walk"],
  boat_hire:           ["Sunset cruise", "Fishing trip (half day)", "Houseboat hire", "Kayak hire", "Pontoon boat hire"],
  tour_guide:          ["Victoria Falls tour", "City tour Harare", "Great Zimbabwe tour", "Cultural village tour", "Bird watching tour"],
  self_catering:       ["2-bedroom chalet", "4-bed cottage", "Studio unit", "Family self-catering unit"],
  campsite:            ["Powered camping site", "Tent site (no power)", "Caravan site", "Group camping area"],
  travel_agency:       ["Safari package (5 days)", "Victoria Falls package", "Holiday package", "Airport transfer"],
  it_support:          ["laptop repair", "wifi setup", "CCTV installation", "phone repair"],
  security:            ["security guard", "alarm installation", "access control", "electric fence"],
  services:            ["plumbing", "welding", "painting"],
  other:               ["handyman", "deliveries", "odd jobs"]
};
function getCategoryExamples(categories = [], profileType = "product") {
  const map = profileType === "service" ? CATEGORY_SERVICE_EXAMPLES : CATEGORY_PRODUCT_EXAMPLES;
  // Try first matching category
  for (const cat of categories) {
    if (map[cat]) return map[cat];
  }
  // Fallback
  return profileType === "service"
    ? ["plumbing", "delivery", "catering"]
    : ["cooking oil", "rice", "sugar"];
}

function isSupplierRegistrationComplete(supplier) {
  if (!supplier) return false;

  return Boolean(
    supplier.businessName &&
    supplier.location?.city &&
    supplier.location?.area &&
    Array.isArray(supplier.categories) && supplier.categories.length > 0 &&
    Array.isArray(supplier.products) && supplier.products.length > 0 &&
    supplier.delivery &&
    typeof supplier.delivery.available === "boolean" &&
    typeof supplier.minOrder === "number"
  );
}

export async function startSupplierRegistration(from, biz) {
  const phone = from.replace(/\D+/g, "");

  // ── School check: if this phone already has a school profile, route there ──
  const SchoolProfile = (await import("../models/schoolProfile.js")).default;
  const existingSchool = await SchoolProfile.findOne({ phone });
  if (existingSchool) {
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, existingSchool);
  }

  const existing = await SupplierProfile.findOne({ phone });

  if (existing) {
    const { sendSupplierAccountMenu, sendSupplierUpgradeMenu } = await import("./metaMenus.js");

    if (existing.active) {
      return sendSupplierAccountMenu(from, existing);
    }

    if (isSupplierRegistrationComplete(existing)) {
      return sendSupplierUpgradeMenu(from, existing.tier);
    }

    // incomplete suppliers continue below
  }

  // ── No business object yet: do NOT touch biz here ─────────────────────────
  if (!biz) {
    const UserSession = (await import("../models/userSession.js")).default;

    await UserSession.findOneAndUpdate(
      { phone },
      {
        phone,
        supplierRegState: "supplier_reg_listing_type",
        supplierRegData: {}
      },
      { upsert: true }
    );

    return sendList(
      from,
`🏪 *List on ZimQuote*

What would you like to list?`,
      [
        { id: "reg_type_product", title: "📦 I Sell Products" },
        { id: "reg_type_service", title: "🧰 I Offer Services" },
        { id: "reg_type_school",  title: "🏫 I Run a School" }
      ]
    );
  }

  // ── Existing/new biz: keep registration data container on biz ────────────
  biz.sessionState = "supplier_reg_listing_type";
  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};

  const { saveBizSafe } = await import("./bizHelpers.js");
  await saveBizSafe(biz);

  return sendList(
    from,
`🏪 *List on ZimQuote*

What would you like to list?`,
    [
      { id: "reg_type_product",     title: "📦 I Sell Products"         },
      { id: "reg_type_service",     title: "🧰 I Offer Services"        },
      { id: "reg_type_hospitality", title: "🏨 Lodge / Hotel / Tourism" },
      { id: "reg_type_school",      title: "🏫 I Run a School"          }
    ]
  );
}

export async function handleSupplierRegistrationStates({
  state, from, text, biz, saveBiz
}) {
  const phone = from.replace(/\D+/g, "");

  // ── Guard: reg_type_* are button action IDs, never free text ─────────────────
  // If the engine calls this function with a reg_type_ action as the "text",
  // it means the user tapped a registration type button while their biz sessionState
  // is still a text-input state (e.g. supplier_reg_listing_type, supplier_reg_name).
  // Return false so execution falls through to the chatbotEngine action handlers.
  const _actionId = (text || "").trim().toLowerCase();
  if (
    _actionId === "reg_type_product" ||
    _actionId === "reg_type_service" ||
    _actionId === "reg_type_school" ||
    _actionId === "reg_type_hospitality"
  ) {
    return false; // ← let chatbotEngine handle it at the action handler
  }

  // ── Step 1: Business Name ──────────────────────────────
 // ── Step 0: Listing type chosen via button (product/service handled in chatbotEngine)
  // School name free-text entry after "reg_type_school" button
  // ── Hospitality-specific state routes ────────────────────────────────────────
  const HOSPITALITY_STATES = new Set([
    "supplier_reg_hospitality_subtype",
    "supplier_reg_hospitality_areas",
    "supplier_reg_hospitality_rooms",
    "supplier_reg_hospitality_activities",
    "supplier_reg_hospitality_rates",
    "supplier_reg_hospitality_rest_rates",
    "supplier_reg_hospitality_extra_services",
    "supplier_reg_hospitality_facilities",
    "supplier_reg_checkin",
  ]);
  // Hospitality states are handled in the full state chain below.

  if (state === "school_reg_name") {
    const name = text.trim();
    if (!name || name.length < 2) {
      await sendText(from, "❌ Please enter a valid school name:");
      return true;
    }
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.schoolName = name;
    biz.sessionData.supplierReg.profileType = "school";
    biz.sessionState = "school_reg_type";
    await saveBiz(biz);

    const { SCHOOL_TYPES } = await import("./schoolPlans.js");
    return sendList(from, `📗 *What type of school is ${name}?*`, [
      ...SCHOOL_TYPES.map(t => ({ id: `school_reg_type_${t.id}`, title: t.label }))
    ]);
  }

  // ── Step 1: Business Name (products/services) ──────────────────────────────
  if (state === "supplier_reg_name") {
    const name = text.trim();
    if (!name || name.length < 2) {
      await sendText(from, "❌ Please enter a valid business name:");
      return true;
    }
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.businessName = name;
    biz.sessionState = "supplier_reg_city";
    await saveBiz(biz);

    return sendList(from, "📍 Where are you based?\n\n_Not listed? Tap Other_", [
      ...SUPPLIER_CITIES.map(c => ({ id: `sup_city_${c.toLowerCase()}`, title: c })),
      { id: "sup_city_other", title: "📍 Other City" }
    ]);
  }

  // ── Step 2: Area ───────────────────────────────────────
if (state === "supplier_reg_area") {
    const area = text.trim();
    if (!area || area.length < 2) {
      await sendText(from, "❌ Please enter your area/suburb:");
      return true;
    }
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.area = area;
    biz.sessionState = "supplier_reg_address";
    await saveBiz(biz);

    return sendButtons(from, {
      text:
`📍 *Business Address (Optional)*

Enter your shop/business address, stand number, building name, or street address.

Examples:
_123 Samora Machel Ave_
_Stand 45, Mbare Musika_
_Joina City, Shop 12_

You can also skip this step.`,
      buttons: [
        { id: "sup_addr_skip", title: "⏭ Skip Address" }
      ]
    });
  }



 if (state === "supplier_reg_address") {
    const address = text.trim();

    if (!address || address.length < 2) {
      await sendText(from, "❌ Please enter a valid address, or tap Skip.");
      return true;
    }

    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.address = address;
    biz.sessionState = "supplier_reg_contact_details";
    await saveBiz(biz);

    return sendButtons(from, {
      text:
`📞 *Contact Details (Optional)*

Enter any extra contact details buyers should see.

Examples:
_0772123456 / 0712345678_
_Call or WhatsApp 0772123456_
_sales@mybusiness.co.zw_

You can also skip this step.`,
      buttons: [
        { id: "sup_contact_skip", title: "⏭ Skip Contact" }
      ]
    });
  }




  if (state === "supplier_reg_contact_details") {
    const contactDetails = text.trim();

    if (!contactDetails || contactDetails.length < 2) {
      await sendText(from, "❌ Please enter valid contact details, or tap Skip.");
      return true;
    }

    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.contactDetails = contactDetails;
    biz.sessionState = "supplier_reg_website";
    await saveBiz(biz);

    return sendButtons(from, {
      text:
`🌐 *Website (Optional)*

Enter your website, Facebook page, Instagram page, or business link buyers should see.

Examples:
_www.mybusiness.co.zw_
_facebook.com/mybusiness_
_instagram.com/mybusiness_

You can also skip this step.`,
      buttons: [
        { id: "sup_website_skip", title: "⏭ Skip Website" }
      ]
    });
  }



if (state === "supplier_reg_website") {
  const website = text.trim();

  if (!website || website.length < 2) {
    await sendText(from, "❌ Please enter a valid website/link, or tap Skip.");
    return true;
  }

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.website = website;

  const profileType = biz.sessionData.supplierReg.profileType || "product";

  if (profileType === "hospitality") {
    biz.sessionState = "supplier_reg_hospitality_subtype";
    await saveBiz(biz);

    return sendList(from,
      `🏨 *What type of hospitality business are you?*\n\n` +
      `_You can select the option that best describes you.\nIf you offer both a lodge AND safaris, pick the primary one — you can update later._`,
      [
        { id: "sup_hosp_type_lodge",           title: "🌿 Lodge / Bush Camp"         },
        { id: "sup_hosp_type_hotel",            title: "🏨 Hotel / Motel"             },
        { id: "sup_hosp_type_guesthouse",       title: "🏡 Guesthouse / B&B"          },
        { id: "sup_hosp_type_self_catering",    title: "🍳 Self-Catering / Chalet"    },
        { id: "sup_hosp_type_campsite",         title: "⛺ Campsite / Caravan Park"   },
        { id: "sup_hosp_type_safari_operator",  title: "🦁 Safari / Game Drive"       },
        { id: "sup_hosp_type_tour_guide",       title: "🗺 Tour Guide / City Tours"   },
        { id: "sup_hosp_type_boat_hire",        title: "⛵ Boat Hire / Cruises"       },
        { id: "sup_hosp_type_lodge__safari_operator", title: "🌿🦁 Lodge + Safaris"  }
      ]
    );
  }

  if (profileType === "service") {
    biz.sessionState = "supplier_reg_collar";
    await saveBiz(biz);

    return sendList(from, "🧑‍💼 *What type of services do you offer?*\n\nThis helps buyers find you faster.", [
      { id: "sup_collar_white_collar", title: "💼 Professional" },
      { id: "sup_collar_trade",        title: "🔧 Trade & Artisan" },
      { id: "sup_collar_blue_collar",  title: "🧹 General Services" }
    ]);
  }

  biz.sessionState = "supplier_reg_category";
  await saveBiz(biz);

  return sendList(from, "🗂 What product do you mainly offer?", [
    ...SUPPLIER_CATEGORIES
      .filter(c => Array.isArray(c.types) ? c.types.includes(profileType) : true)
      .slice(0, 9)
      .map(c => ({ id: `sup_cat_${c.id}`, title: c.label })),
    ...(
      SUPPLIER_CATEGORIES.filter(c => Array.isArray(c.types) ? c.types.includes(profileType) : true).length > 9
        ? [{ id: "sup_cat_more", title: "➕ More Categories" }]
        : []
    )
  ]);
}

  // ── Step 3: Products ───────────────────────────────────
if (state === "supplier_reg_products") {
  // ── Guard: if they already chose upload/skip via button, this state
  //    should not be reached as text input. Route them forward.
  const alreadySet = biz.sessionData?.supplierReg?.products?.[0] === "pending_upload";
  if (alreadySet) {
    const isService = biz.sessionData?.supplierReg?.profileType === "service";
    if (isService) {
      biz.sessionState = "supplier_reg_travel";
      await saveBiz(biz);
      return sendButtons(from, {
        text: "🚗 *Do you travel to clients?*",
        buttons: [
          { id: "sup_travel_yes", title: "✅ Yes I Travel" },
          { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
        ]
      });
    }
    biz.sessionState = "supplier_reg_delivery";
    await saveBiz(biz);
    return sendButtons(from, {
      text: "🚚 *Do you deliver?*",
      buttons: [
        { id: "sup_del_yes", title: "✅ Yes I Deliver" },
        { id: "sup_del_no",  title: "🏠 Collection Only" }
      ]
    });
  }

  // ... rest of existing code unchanged below

  
  const items = text.split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const isService = biz.sessionData?.supplierReg?.profileType === "service";

  if (!items.length) {
    await sendText(
      from,
      isService
        ? `❌ Please list at least one service, separated by commas.

*Example:*
*car hire, delivery, airport transfers*

Just type them and send 👇`
        : `❌ Please list at least one product, separated by commas.

*Example:*
*cooking oil, rice, sugar, flour, bread*

Just type them and send 👇`
    );
    return true;
  }

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.products = items.map(p => p.toLowerCase());
  biz.sessionState = "supplier_reg_prices";

if (isService) {
  biz.sessionData.supplierReg.rates = [];
  await saveBiz(biz);

  const savedProducts = biz.sessionData.supplierReg.products || [];
  const DISPLAY_MAX = 20;
  const displayProducts = savedProducts.slice(0, DISPLAY_MAX);
  const hiddenCount = savedProducts.length - DISPLAY_MAX;

  const numberedList = displayProducts.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const moreNote = hiddenCount > 0 ? `\n_...and ${hiddenCount} more services_` : "";

  const serviceExampleNums = savedProducts
    .slice(0, Math.min(3, savedProducts.length))
    .map((_, i) => [10, 25, 50][i] ?? 10)
    .join(", ");

  return sendButtons(from, {
    text:
`💰 *Set Your Rates (USD)*

You have *${savedProducts.length} service${savedProducts.length > 1 ? "s" : ""}*

${numberedList}${moreNote}

─────────────────
*Fastest way: update by item number*

*Single item:*
_1 x 20/job_

*Same rate for selected items:*
_1,3,5 x 20/job_

*Same rate for a range:*
_1-4 x 15/hr_

*Mixed updates:*
_1 x 20/job, 2 x 15/trip, 3 x 10/hr_

*Other options still work:*

*Update ALL in order:*
_${serviceExampleNums}_

*Update selected items by name:*
_${savedProducts.slice(0, 2).map(p => `${p}: 20/job`).join(", ")}_

*Common units:* /hr, /job, /trip, /day, /event

Type your rates and send, or tap Skip 👇`,
    buttons: [{ id: "sup_skip_prices", title: "⏭ Skip Rates" }]
  });
}

 biz.sessionData.supplierReg.prices = [];
await saveBiz(biz);

const savedProducts = biz.sessionData.supplierReg.products || [];
const DISPLAY_MAX = 20;
const displayProducts = savedProducts.slice(0, DISPLAY_MAX);
const hiddenCount = savedProducts.length - DISPLAY_MAX;

const numberedList = displayProducts.map((p, i) => `${i + 1}. ${p}`).join("\n");
const moreNote = hiddenCount > 0 ? `\n_...and ${hiddenCount} more products_` : "";

const exampleNums = savedProducts
  .slice(0, Math.min(4, savedProducts.length))
  .map((_, i) => [5.50, 8.00, 1.20, 15.00][i] ?? 5.50)
  .join(", ");

return sendButtons(from, {
  text:
`💰 *Set Your Prices (USD)*

You have *${savedProducts.length} product${savedProducts.length > 1 ? "s" : ""}*

${numberedList}${moreNote}

─────────────────
*Fastest way: update by item number*

*Single item:*
_1 x 5.50_

*Same price for selected items:*
_1,3,5 x 5.50_

*Same price for a range:*
_1-4 x 5.50_

*Mixed updates:*
_1 x 5.50, 2 x 8.00, 3 x 12.00_

*Other options still work:*

*Update ALL in order:*
_${exampleNums}_

*Update selected items by name:*
_${savedProducts.slice(0, 2).map(p => `${p}: 5.50`).join(", ")}_

Type your prices and send, or tap Skip 👇`,
  buttons: [{ id: "sup_skip_prices", title: "⏭ Skip Prices" }]
});
}
  // ── Step 3b: Prices ────────────────────────────────────────────────────────
// ── Step 3b: Prices ────────────────────────────────────────────────────────
if (state === "supplier_reg_prices") {
  const reg = biz.sessionData?.supplierReg || {};
  const products = (reg.products || []).filter(p => p !== "pending_upload");
  const isService = reg.profileType === "service";
  const rateLabel = isService ? "rates" : "prices";

  if (!products.length) {
    // No products yet - skip pricing
    if (isService) {
      biz.sessionState = "supplier_reg_travel";
      await saveBiz(biz);
      return sendButtons(from, {
        text: "🚗 *Do you travel to clients?*",
        buttons: [
          { id: "sup_travel_yes", title: "✅ Yes I Travel" },
          { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
        ]
      });
    }
    biz.sessionState = "supplier_reg_delivery";
    await saveBiz(biz);
    return sendButtons(from, {
      text: "🚚 *Do you deliver?*",
      buttons: [
        { id: "sup_del_yes", title: "✅ Yes I Deliver" },
        { id: "sup_del_no",  title: "🏠 Collection Only" }
      ]
    });
  }

  // ── CHECK: Did supplier type prices? ──────────────────────────────────────
  // text is the raw input. If it looks like prices (numbers or named), parse them.
  // If text is empty/whitespace, just show the form again.
  const rawInput = (text || "").trim();
  const lowerInput = rawInput.toLowerCase();

  // If empty or this is a button action being routed here, just show the form
 // If empty or this is a button action being routed here, just show the form
  if (!rawInput || rawInput.length < 1) {
    // Fall through to show the form below
  } else if (lowerInput === "skip" || lowerInput === "done") {
    // ── User typed "skip" or "done" → advance state immediately ──────────
    if (isService) {
      biz.sessionState = "supplier_reg_travel";
      await saveBiz(biz);
      return sendButtons(from, {
        text: "🚗 *Do you travel to clients?*",
        buttons: [
          { id: "sup_travel_yes", title: "✅ Yes I Travel" },
          { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
        ]
      });
    }
    biz.sessionState = "supplier_reg_delivery";
    await saveBiz(biz);
    return sendButtons(from, {
      text: "🚚 *Do you deliver?*",
      buttons: [
        { id: "sup_del_yes", title: "✅ Yes I Deliver" },
        { id: "sup_del_no",  title: "🏠 Collection Only" }
      ]
    });
   } else if (lowerInput !== "skip" && lowerInput !== "done") {
    // Supplier typed something that looks like prices - try to parse it
    const parts = rawInput.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?$/.test(s));
    const updated = [];
    const failed = [];

    // New quick syntax:
    // 1 x 5.50
    // 1,3,5 x 5.50
    // 1-4 x 5.50
    // 2 x 20/job
    const quickGroups = rawInput
      .split(/[;\n]+/)
      .map(s => s.trim())
      .filter(Boolean);

    let quickMatchedAny = false;

    for (const group of quickGroups) {
      const grouped = group.match(
        /^([\d,\-\s]+)\s*x\s*(\d+(?:\.\d+)?)(?:\s*\/\s*([a-zA-Z]+))?$/i
      );

      if (grouped) {
        quickMatchedAny = true;

        const selector = grouped[1].trim();
        const amount = Number(grouped[2]);
        const unit = (grouped[3] || (isService ? "job" : "each")).toLowerCase();

        const indexes = [];
        const selectorParts = selector.split(",").map(s => s.trim()).filter(Boolean);

        for (const token of selectorParts) {
          if (/^\d+$/.test(token)) {
            const idx = Number(token) - 1;
            if (idx >= 0 && idx < products.length) indexes.push(idx);
            continue;
          }

          const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
          if (rangeMatch) {
            const start = Number(rangeMatch[1]) - 1;
            const end = Number(rangeMatch[2]) - 1;
            for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
              if (i >= 0 && i < products.length) indexes.push(i);
            }
          }
        }

        const uniqueIndexes = [...new Set(indexes)].sort((a, b) => a - b);

        if (!uniqueIndexes.length) {
          failed.push(group);
          continue;
        }

        for (const idx of uniqueIndexes) {
          updated.push({
            product: products[idx].toLowerCase(),
            amount,
            unit,
            inStock: true
          });
        }

        continue;
      }

      const singles = group.split(",").map(s => s.trim()).filter(Boolean);
      for (const single of singles) {
        const matchQuick = single.match(
          /^(\d+)\s*x\s*(\d+(?:\.\d+)?)(?:\s*\/\s*([a-zA-Z]+))?$/i
        );

        if (!matchQuick) continue;

        quickMatchedAny = true;

        const idx = Number(matchQuick[1]) - 1;
        if (idx < 0 || idx >= products.length) {
          failed.push(single);
          continue;
        }

        updated.push({
          product: products[idx].toLowerCase(),
          amount: Number(matchQuick[2]),
          unit: (matchQuick[3] || (isService ? "job" : "each")).toLowerCase(),
          inStock: true
        });
      }
    }

    if (!quickMatchedAny && allNumbers) {
      // Strategy 1: plain numbers in order e.g. "5,10,7,9,8"
      if (parts.length !== products.length) {
        await sendText(from,
`❌ You have *${products.length} ${isService ? "service" : "product"}${products.length > 1 ? "s" : ""}* but sent *${parts.length} price${parts.length > 1 ? "s" : ""}*.

Send one price per ${isService ? "service" : "product"} in order:
${products.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Example: *${products.slice(0, 3).map((_, i) => ((i + 1) * 10)).join(", ")}*`
        );
        return true;
      }

      parts.forEach((numStr, i) => {
        updated.push({
          product: products[i].toLowerCase(),
          amount: parseFloat(numStr),
          unit: isService ? "job" : "each",
          inStock: true
        });
      });

    } else if (!quickMatchedAny) {
      // Strategy 2: named pricing e.g. "cement 5.50, sand 8" or "20/job, 50/hr"
      for (const line of parts) {
        const clean = line
          .replace(/^[-•*►▪✓]\s*/, "")
          .replace(/^\d+[.)]\s*/, "")
          .replace(/\$/g, "")
          .trim();

        if (!clean) continue;

        const rateOnlyMatch = clean.match(/^(\d+(?:\.\d+)?)\/([a-zA-Z]+)$/);
        if (rateOnlyMatch) {
          const posIdx = updated.length;
          if (posIdx < products.length) {
            updated.push({
              product: products[posIdx].toLowerCase(),
              amount: parseFloat(rateOnlyMatch[1]),
              unit: rateOnlyMatch[2].toLowerCase(),
              inStock: true
            });
          } else {
            failed.push(line);
          }
          continue;
        }

        const match =
          clean.match(/^(.+?)\s*[:]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/) ||
          clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);

        if (!match) { failed.push(line); continue; }

        const product = match[1].replace(/[$@\-:,]+$/, "").trim().toLowerCase();
        const amount = parseFloat(match[2]);
        const rawUnit = (match[3] || "").trim().toLowerCase();
        const unit = rawUnit
          ? rawUnit.replace(/^\//, "")
          : (isService ? "job" : "each");

        if (!product || isNaN(amount)) { failed.push(line); continue; }
        updated.push({ product, amount, unit, inStock: true });
      }
    }
    // If we parsed prices successfully, save and advance
    if (updated.length > 0) {
      biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};

      if (isService) {
        // Convert to rate format: { service, rate }
        biz.sessionData.supplierReg.rates = updated.map(u => ({
          service: u.product,
          rate: `${u.amount}/${u.unit}`
        }));
      } else {
        biz.sessionData.supplierReg.prices = updated;
      }

      const failNote = failed.length
        ? `\n\n⚠️ Skipped ${failed.length} line${failed.length > 1 ? "s" : ""} - you can update later.`
        : "";

      // Build preview lines
    // At this point, updated[] items always have shape { product, amount, unit }
      // regardless of isService - the conversion to { service, rate } happens below
      // when saving to reg.rates. So always read u.product for the preview.
      const previewLines = updated
        .map(u => `• ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`)
        .join("\n");
      // ── ADVANCE STATE immediately - no loop ────────────────────────────────
      if (isService) {
        // ── Teacher/tourism: inject extra detail step before travel ────────────
        const _cats      = biz.sessionData?.supplierReg?.categories || [];
        const _isTutor   = _cats.includes("tutoring");
        const _isTourism = _cats.includes("tourism");

        if (_isTutor) {
          biz.sessionState = "supplier_reg_teacher_details";
          await saveBiz(biz);
          const _msg = "✅ *" + updated.length + " rate" + (updated.length > 1 ? "s" : "") + " saved!*\n\n"
            + previewLines + failNote + "\n\n"
            + "📚 *What subjects do you teach and what grades?*\n\n"
            + "Type subjects first, then grades after a pipe \"|\"\n"
            + "_e.g. Maths, Physics, English | O-Level, A-Level_\n"
            + "_Or: Maths, Science | Grade 6, Grade 7_\n\n"
            + "Type *skip* to continue.";
          return sendText(from, _msg);
        }

        if (_isTourism) {
          biz.sessionState = "supplier_reg_tourism_details";
          await saveBiz(biz);
          const _msg = "✅ *" + updated.length + " rate" + (updated.length > 1 ? "s" : "") + " saved!*\n\n"
            + previewLines + failNote + "\n\n"
            + "🦁 *Tell us about your tourism business.*\n\n"
            + "Type your type, then areas after a pipe \"|\"\n"
            + "_e.g. Safari Lodge | Hwange, Victoria Falls_\n"
            + "_Or: City Tours | Harare, Bulawayo_\n\n"
            + "Type *skip* to continue.";
          return sendText(from, _msg);
        }

        biz.sessionState = "supplier_reg_travel";
        await saveBiz(biz);
        return sendButtons(from, {
          text:
`✅ *${updated.length} ${isService ? "rate" : "price"}${updated.length > 1 ? "s" : ""} saved!*

${previewLines}${failNote}

🚗 *Do you travel to clients?*`,
          buttons: [
            { id: "sup_travel_yes", title: "✅ Yes I Travel" },
            { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
          ]
        });
      }

      biz.sessionState = "supplier_reg_delivery";
      await saveBiz(biz);
      return sendButtons(from, {
        text:
`✅ *${updated.length} price${updated.length > 1 ? "s" : ""} saved!*

${previewLines}${failNote}

🚚 *Do you deliver?*`,
        buttons: [
          { id: "sup_del_yes", title: "✅ Yes I Deliver" },
          { id: "sup_del_no",  title: "🏠 Collection Only" }
        ]
      });
    }

    // Nothing parseable - fall through to show the form with an error hint
      if (failed.length > 0 || parts.length > 0) {
      await sendText(from,
`❌ Couldn't read your ${rateLabel}.

Try any of these:

${isService
  ? `*Single item:*\n_1 x 20/job_\n\n*Same rate for selected items:*\n_1,3,5 x 20/job_\n\n*Same rate for a range:*\n_1-4 x 15/hr_\n\n*Mixed updates:*\n_1 x 20/job, 2 x 15/trip_\n\n*Or all in order:*\n_${products.slice(0,3).map((_, i) => ((i+1)*10)).join(", ")}_\n\n*Or by name:*\n_${products.slice(0,2).map(p => `${p}: 10/job`).join(", ")}_`
  : `*Single item:*\n_1 x 5.50_\n\n*Same price for selected items:*\n_1,3,5 x 5.50_\n\n*Same price for a range:*\n_1-4 x 5.50_\n\n*Mixed updates:*\n_1 x 5.50, 2 x 8.00_\n\n*Or all in order:*\n_${products.slice(0,3).map((_, i) => ((i+1)*5+2)).join(", ")}_\n\n*Or by name:*\n_${products.slice(0,2).map(p => `${p}: 5.50`).join(", ")}_`
}

Type *skip* to add ${rateLabel} later.`
      );
    }
  }

  // ── Show the price entry form ─────────────────────────────────────────────
 // ── Show the price entry form ─────────────────────────────────────────────
  const existingPrices = reg.prices || [];
  const existingRates  = reg.rates  || [];

  // Truncate display to first 20 products to keep message safe
  // For large preset lists, show first 20 with a "... and N more" note
  const DISPLAY_MAX = 20;
  const displayProducts = products.slice(0, DISPLAY_MAX);
  const hiddenCount = products.length - DISPLAY_MAX;

  const numbered = displayProducts.map((p, i) => {
    if (isService) {
      const existing = existingRates.find(r => r.service?.toLowerCase() === p.toLowerCase());
      const rateStr = existing ? ` _(${existing.rate})_` : "";
      return `${i + 1}. ${p}${rateStr}`;
    } else {
      const existing = existingPrices.find(pr => pr.product?.toLowerCase() === p.toLowerCase());
      const priceStr = existing ? ` _($${Number(existing.amount).toFixed(2)}/${existing.unit})_` : "";
      return `${i + 1}. ${p}${priceStr}`;
    }
  }).join("\n");

  const moreNote = hiddenCount > 0
    ? `\n_...and ${hiddenCount} more products_`
    : "";

  const exampleNums = products.slice(0, Math.min(4, products.length))
    .map((_, i) => [5.50, 8.00, 1.20, 15.00][i].toFixed(2))
    .join(", ");

  const serviceExampleNums = products.slice(0, Math.min(3, products.length))
    .map((_, i) => [10, 25, 50][i])
    .join(", ");

  // ── Split into 2 messages: text list (no char limit issue) + skip button ──
  await sendText(from,
`💰 *Set Your ${isService ? "Rates" : "Prices"} (USD)*
You have *${products.length} ${isService ? "service" : "product"}${products.length > 1 ? "s" : ""}*

${numbered}${moreNote}

─────────────────
*Fastest way: update by item number*

${isService
  ? `*Single item:*\n_1 x 20/job_\n\n*Same rate for selected items:*\n_1,3,5 x 20/job_\n\n*Same rate for a range:*\n_1-4 x 15/hr_\n\n*Mixed updates:*\n_1 x 20/job, 2 x 15/trip_\n\n*Other options still work:*\n\n*Update ALL in order:*\n_${serviceExampleNums}_\n\n*Update selected items by name:*\n_${products.slice(0,2).map(p => `${p}: 20/job`).join(", ")}_`
  : `*Single item:*\n_1 x 5.50_\n\n*Same price for selected items:*\n_1,3,5 x 5.50_\n\n*Same price for a range:*\n_1-4 x 5.50_\n\n*Mixed updates:*\n_1 x 5.50, 2 x 8.00_\n\n*Other options still work:*\n\n*Update ALL in order:*\n_${exampleNums}_\n\n*Update selected items by name:*\n_${products.slice(0,2).map(p => `${p}: 5.50`).join(", ")}_`
}
─────────────────
Type your ${rateLabel} and send, or tap Skip 👇`
  );

  return sendButtons(from, {
    text: `⏭ Skip setting ${rateLabel} for now? You can add them later from your account.`,
    buttons: [
      { id: "sup_skip_prices", title: "⏭ Skip For Now" }
    ]
  });
}
  // ── Step 4: Minimum Order ──────────────────────────────

// ── Step: Teacher / Tutor details (subjects & grades) ───────────────────────
if (state === "supplier_reg_teacher_details") {
  const raw = (text || "").trim();
  if (raw.toLowerCase() !== "skip" && raw.length > 1) {
    const parts    = raw.split(/[|\n]+/);
    const subjects = (parts[0] || "").split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    const grades   = (parts[1] || "").split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    biz.sessionData.supplierReg.subjects      = subjects;
    biz.sessionData.supplierReg.gradesOffered = grades;
  }
  biz.sessionState = "supplier_reg_travel";
  await saveBiz(biz);
  return sendButtons(from, {
    text: "🚗 *Do you travel to students?*\n\n_Home tuition or online sessions?_",
    buttons: [
      { id: "sup_travel_yes", title: "✅ Yes I Travel" },
      { id: "sup_travel_no",  title: "🏠 Student Comes to Me" }
    ]
  });
}

// ─── HOSPITALITY / TOURISM REGISTRATION STATES ──────────────────────────────
// These handle the extended registration flow for lodges, hotels, safari operators, etc.

// Step: hospitality_subtype is handled via button (chatbotEngine routes sup_hosp_type_ buttons)
// The button sets tourismSubtype[] and advances to supplier_reg_hospitality_areas

// Step: Areas/destinations
if (state === "supplier_reg_hospitality_areas") {
  const raw = (text || "").trim();

  if (raw.toLowerCase() !== "skip" && raw.length > 1) {
    const areas = raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    biz.sessionData.supplierReg.tourismAreas = areas;
  }

  // Move to room types / services entry
  const subtype = (biz.sessionData.supplierReg.tourismSubtype || [])[0] || "";
  const isAccommodation = ["lodge","hotel","guesthouse","self_catering","campsite"].includes(subtype);

  if (isAccommodation) {
    biz.sessionState = "supplier_reg_hospitality_rooms";
    await saveBiz(biz);
    return sendText(from,
      `🛏 *What room or accommodation types do you offer?*\n\n` +
      `Type your types separated by commas.\n\n` +
      `Examples:\n` +
      `_Double room, Twin room, Family chalet, Presidential suite_\n` +
      `_Self-catering unit, Honeymoon chalet, Dormitory_\n` +
      `_Bush chalet, Tent (fully equipped), Caravan site_\n\n` +
      `_Type *skip* to add these later._`
    );
  }

  // For safari operators, tour guides, boat hire — go to services listing
  biz.sessionState = "supplier_reg_hospitality_activities";
  await saveBiz(biz);
  return sendText(from,
    `🦁 *What activities or services do you offer?*\n\n` +
    `Type your services separated by commas.\n\n` +
    `Examples:\n` +
    `_Game drive, Night drive, Bird watching, Bush walk_\n` +
    `_Sunset cruise, Fishing trip, Kayak hire, Houseboat hire_\n` +
    `_Victoria Falls tour, Cultural village tour, City tour_\n` +
    `_Airport transfer, Full-day safari package_\n\n` +
    `_Type *skip* to add these later._`
  );
}

// Step: Room types (accommodation providers)
if (state === "supplier_reg_hospitality_rooms") {
  const raw = (text || "").trim();

  if (raw.toLowerCase() !== "skip" && raw.length > 1) {
    const rooms = raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    // Store as products[] for catalogue display
    biz.sessionData.supplierReg.products = rooms;
    // Also build roomTypes[] with placeholders — nightly rates entered in next step
    biz.sessionData.supplierReg.roomTypes = rooms.map(name => ({
      name, capacity: 2, pricePerNight: 0, currency: "USD", description: ""
    }));
  }

  biz.sessionState = "supplier_reg_hospitality_rates";
  await saveBiz(biz);
  const rooms = biz.sessionData.supplierReg.products || [];
  if (!rooms.length) {
    biz.sessionState = "supplier_reg_hospitality_facilities";
    await saveBiz(biz);
    return _showHospFacilitiesPrompt(from, biz);
  }

  const numbered = rooms.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return sendButtons(from, {
    text:
      `💰 *Set your nightly rates (USD)*\n\n` +
      `${numbered}\n\n` +
      `─────────────────\n` +
      `Enter rates using item number x price:\n\n` +
      `*Single room:*\n_1 x 80_\n\n` +
      `*Multiple rooms:*\n_1 x 80, 2 x 120, 3 x 150_\n\n` +
      `*All the same rate:*\n_80_ _(applied to all)_\n\n` +
      `_All prices are per night per room._`,
    buttons: [{ id: "sup_skip_prices", title: "⏭ Skip For Now" }]
  });
}

// Step: Activities (non-accommodation hospitality providers)
if (state === "supplier_reg_hospitality_activities") {
  const raw = (text || "").trim();

  if (raw.toLowerCase() !== "skip" && raw.length > 1) {
    const activities = raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    biz.sessionData.supplierReg.products = activities;
    // Store as rates with per-person/per-trip defaults
    biz.sessionData.supplierReg.rates = activities.map(service => ({
      service, rate: ""
    }));
  }

  biz.sessionState = "supplier_reg_hospitality_rates";
  await saveBiz(biz);
  const activities = biz.sessionData.supplierReg.products || [];
  if (!activities.length) {
    biz.sessionState = "supplier_reg_hospitality_facilities";
    await saveBiz(biz);
    return _showHospFacilitiesPrompt(from, biz);
  }

  const numbered = activities.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return sendButtons(from, {
    text:
      `💰 *Set your rates (USD)*\n\n` +
      `${numbered}\n\n` +
      `─────────────────\n` +
      `Enter rates using item number x price/unit:\n\n` +
      `_1 x 80/person_\n` +
      `_2 x 150/trip_\n` +
      `_3 x 200/group_\n` +
      `_1 x 80/person, 2 x 150/trip_\n\n` +
      `_Accepted units: /person  /trip  /day  /hour  /group  /boat_`,
    buttons: [{ id: "sup_skip_prices", title: "⏭ Skip For Now" }]
  });
}

// Step: Hospitality rates — handles nightly rate input, then routes to rest rate question
if (state === "supplier_reg_hospitality_rates") {
  const raw = (text || "").trim();
  const isSkip = raw.toLowerCase() === "skip" || text === "sup_skip_prices";
  const rooms = biz.sessionData.supplierReg.products || [];
  const isAccom = (biz.sessionData.supplierReg.tourismSubtype || [])
    .some(s => ["lodge","hotel","guesthouse","self_catering","campsite"].includes(s));

  if (!isSkip && raw.length > 1 && rooms.length) {
    // Parse "1 x 80, 2 x 120, 3 x 150" or just "80" for single / all-same
    const pairMatches = [...raw.matchAll(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)/g)];
    if (pairMatches.length) {
      const roomTypes = biz.sessionData.supplierReg.roomTypes || rooms.map(n => ({ name: n, capacity: 2, pricePerNight: 0, currency: "USD" }));
      for (const m of pairMatches) {
        const idx = parseInt(m[1], 10) - 1;
        const price = parseFloat(m[2]);
        if (idx >= 0 && idx < roomTypes.length && price >= 0) roomTypes[idx].pricePerNight = price;
      }
      biz.sessionData.supplierReg.roomTypes = roomTypes;
    } else {
      const singlePrice = parseFloat(raw);
      if (!isNaN(singlePrice) && singlePrice >= 0) {
        const roomTypes = biz.sessionData.supplierReg.roomTypes || rooms.map(n => ({ name: n, capacity: 2, pricePerNight: 0, currency: "USD" }));
        roomTypes.forEach(rt => { rt.pricePerNight = singlePrice; });
        biz.sessionData.supplierReg.roomTypes = roomTypes;
      }
    }
  }

  // For activity/safari operators, rates go into rates[] — same parsing
  const isActivity = !isAccom;
  if (isActivity && !isSkip && raw.length > 1) {
    const activities = biz.sessionData.supplierReg.products || [];
    const pairMatches = [...raw.matchAll(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\/([a-zA-Z]+))?/g)];
    const ratesList = biz.sessionData.supplierReg.rates || activities.map(s => ({ service: s, rate: "" }));
    if (pairMatches.length) {
      for (const m of pairMatches) {
        const idx = parseInt(m[1], 10) - 1;
        const price = parseFloat(m[2]);
        const unit = m[3] || "person";
        if (idx >= 0 && idx < ratesList.length && price >= 0) ratesList[idx].rate = `$${price}/${unit}`;
      }
      biz.sessionData.supplierReg.rates = ratesList;
    }
  }

  await saveBiz(biz);

  // After nightly rates — ask about rest/day rates for accommodation providers
  if (isAccom) {
    biz.sessionState = "supplier_reg_hospitality_rest_rates";
    await saveBiz(biz);
    const roomList = (biz.sessionData.supplierReg.roomTypes || []).map((rt, i) => `${i + 1}. ${rt.name} — $${rt.pricePerNight || "?"}/night`).join("\n");
    return sendButtons(from, {
      text:
        `⏰ *Do you offer a rest / day-use rate?*\n\n` +
        `Current rooms:\n${roomList || "(none set)"}\n\n` +
        `A *rest rate* is a reduced charge for guests who need the room for a few hours only (no overnight stay). Common at town lodges.\n\n` +
        `If yes, enter the rate per room the same way:\n` +
        `_1 x 40, 2 x 55_ _(room number x rest price)_\n` +
        `_45_ _(same rate for all rooms)_`,
      buttons: [{ id: "sup_skip_rest_rates", title: "⏭ No rest rates" }]
    });
  }

  // Activity providers go straight to extra services
  biz.sessionState = "supplier_reg_hospitality_extra_services";
  await saveBiz(biz);
  return sendButtons(from, {
    text:
      `➕ *Any extra services guests can book separately?*\n\n` +
      `e.g. airport pickup, laundry, packed lunch, equipment hire\n\n` +
      `Type each one:\n_airport pickup $15/trip, laundry $3/load, packed lunch $8/person_\n\n` +
      `Or tap Skip.`,
    buttons: [{ id: "sup_skip_extra_services", title: "⏭ Skip" }]
  });
}

// Step: Rest / day-use rates
if (state === "supplier_reg_hospitality_rest_rates") {
  const raw = (text || "").trim();
  const isSkip = raw.toLowerCase() === "skip" || text === "sup_skip_rest_rates";

  if (!isSkip && raw.length > 1) {
    const roomTypes = biz.sessionData.supplierReg.roomTypes || [];
    const pairMatches = [...raw.matchAll(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)/g)];
    if (pairMatches.length) {
      for (const m of pairMatches) {
        const idx = parseInt(m[1], 10) - 1;
        const price = parseFloat(m[2]);
        if (idx >= 0 && idx < roomTypes.length && price >= 0) roomTypes[idx].restRate = price;
      }
    } else {
      const singlePrice = parseFloat(raw);
      if (!isNaN(singlePrice) && singlePrice >= 0) {
        roomTypes.forEach(rt => { rt.restRate = singlePrice; });
      }
    }
    biz.sessionData.supplierReg.roomTypes = roomTypes;
    await saveBiz(biz);
  }

  // Move to extra services
  biz.sessionState = "supplier_reg_hospitality_extra_services";
  await saveBiz(biz);
  return sendButtons(from, {
    text:
      `➕ *Any extra services guests can book?*\n\n` +
      `Things guests pay for separately from the room rate. Examples:\n\n` +
      `_conference room $50/half day_\n` +
      `_airport pickup $15/trip_\n` +
      `_swimming pool day access $5/person_\n` +
      `_laundry $3/load_\n` +
      `_braai area hire $20/day_\n` +
      `_breakfast $8/person_\n\n` +
      `Type each one separated by commas, or tap Skip.`,
    buttons: [{ id: "sup_skip_extra_services", title: "⏭ No extra services" }]
  });
}

// Step: Extra services
if (state === "supplier_reg_hospitality_extra_services") {
  const raw = (text || "").trim();
  const isSkip = raw.toLowerCase() === "skip" || text === "sup_skip_extra_services";

  if (!isSkip && raw.length > 1) {
    // Parse "conference room $50/half day, airport pickup $15/trip, laundry $3/load"
    const extraServices = [];
    const entries = raw.split(/,\s*(?=[a-zA-Z])/);
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Try to extract price: "name $price/unit" or "name price/unit" or "name $price"
      const priceMatch = trimmed.match(/^(.+?)\s*\$?(\d+(?:\.\d+)?)(?:\s*\/\s*([\w\s]+))?\s*$/);
      if (priceMatch) {
        extraServices.push({
          name:  priceMatch[1].trim(),
          price: parseFloat(priceMatch[2]) || 0,
          unit:  (priceMatch[3] || "service").trim()
        });
      } else {
        extraServices.push({ name: trimmed, price: 0, unit: "service" });
      }
    }
    biz.sessionData.supplierReg.extraServices = extraServices;
    await saveBiz(biz);
  }

  // Move to facilities
  biz.sessionState = "supplier_reg_hospitality_facilities";
  await saveBiz(biz);
  return _showHospFacilitiesPrompt(from, biz);
}

// Step: Hospitality rates (nightly or per-activity)
// Note: routing above handles both accommodation and activity rate input.

// Step: Facilities selection for hospitality suppliers
if (state === "supplier_reg_hospitality_facilities") {
  // Handled by sup_hosp_fac_toggle_ buttons — this state collects typed input as fallback
  const raw = (text || "").trim();
  const _DONE_WORDS = ["done", "next", "skip", "continue", "ok", "okay"];

  if (_DONE_WORDS.includes(raw.toLowerCase()) || text === "sup_hosp_facilities_done") {
    biz.sessionState = "supplier_reg_checkin";
    await saveBiz(biz);
    return sendText(from,
      `⏰ *Check-in and check-out times? (Optional)*\n\n` +
      `Type both separated by a slash.\n\n` +
      `Examples:\n` +
      `_2pm / 10am_\n` +
      `_14:00 / 10:00_\n` +
      `_Flexible check-in available_\n\n` +
      `_Type *skip* to set later._`
    );
  }

  // If they typed facility names as text
  if (raw.length > 2) {
    const facilityMap = {
      "wifi": "wifi", "wi-fi": "wifi", "internet": "wifi",
      "pool": "pool", "swimming pool": "pool",
      "hot shower": "hot_shower", "shower": "hot_shower",
      "breakfast": "breakfast", "b&b": "breakfast",
      "en suite": "en_suite", "en-suite": "en_suite", "ensuite": "en_suite",
      "generator": "generator", "solar": "generator",
      "dstv": "dstv", "tv": "dstv",
      "braai": "braai", "bbq": "braai", "barbeque": "braai",
      "aircon": "aircon", "air conditioning": "aircon",
      "game drives": "game_drives", "safari": "game_drives",
      "fishing": "fishing",
      "boat hire": "boat_hire", "boat": "boat_hire",
      "conference": "conference",
      "restaurant": "restaurant", "bar": "bar",
      "laundry": "laundry", "parking": "parking",
      "pets": "pets_allowed", "child friendly": "child_friendly"
    };
    const existing = biz.sessionData.supplierReg.facilities || [];
    const typed = raw.toLowerCase();
    const matched = [];
    for (const [key, code] of Object.entries(facilityMap)) {
      if (typed.includes(key) && !existing.includes(code)) matched.push(code);
    }
    if (matched.length) {
      biz.sessionData.supplierReg.facilities = [...existing, ...matched];
      await saveBiz(biz);
      return sendButtons(from, {
        text: `✅ Added: ${matched.map(f => f.replace("_", " ")).join(", ")}\n\nAdd more or tap Done:`,
        buttons: [{ id: "sup_hosp_facilities_done", title: "✅ Done" }]
      });
    }
  }

  return _showHospFacilitiesPrompt(from, biz);
}

// Step: Check-in / check-out times
if (state === "supplier_reg_checkin") {
  const raw = (text || "").trim();

  if (raw.toLowerCase() !== "skip" && raw.length > 2) {
    const parts = raw.split(/[/\\|]+/).map(s => s.trim()).filter(Boolean);
    biz.sessionData.supplierReg.checkInTime  = parts[0] || "";
    biz.sessionData.supplierReg.checkOutTime = parts[1] || "";
  }

  // Route to min order / confirm
  biz.sessionData.supplierReg.minOrder      = 0;
  biz.sessionData.supplierReg.travelAvailable = true; // hospitality providers always "come to"
  biz.sessionState = "supplier_reg_biz_currency";
  await saveBiz(biz);
  return sendButtons(from, {
    text: "💱 *Almost done! What currency does your business use?*",
    buttons: [
      { id: "sup_biz_cur_USD", title: "💵 USD ($)" },
      { id: "sup_biz_cur_ZWL", title: "🇿🇼 ZWL (Z$)" },
      { id: "sup_biz_cur_ZAR", title: "🇿🇦 ZAR (R)" }
    ]
  });
}

// ── Facilities prompt helper ───────────────────────────────────────────────
async function _showHospFacilitiesPrompt(from, biz) {
  const existing = biz.sessionData.supplierReg.facilities || [];
  const ALL_FACILITIES = [
    { code: "wifi",          label: "📶 WiFi"                },
    { code: "pool",          label: "🏊 Swimming pool"       },
    { code: "hot_shower",    label: "🚿 Hot shower"          },
    { code: "breakfast",     label: "🍳 Breakfast included"  },
    { code: "en_suite",      label: "🚪 En-suite bathrooms"  },
    { code: "generator",     label: "⚡ Generator/solar"     },
    { code: "dstv",          label: "📺 DSTV / TV"           },
    { code: "braai",         label: "🔥 Braai / BBQ"         },
    { code: "aircon",        label: "❄️ Air conditioning"    },
    { code: "game_drives",   label: "🦁 Game drives"         },
    { code: "fishing",       label: "🎣 Fishing"             },
    { code: "boat_hire",     label: "⛵ Boat hire"           },
    { code: "conference",    label: "🏢 Conference room"     },
    { code: "restaurant",    label: "🍽 Restaurant / bar"   },
    { code: "laundry",       label: "👕 Laundry"             },
    { code: "parking",       label: "🅿️ Parking"             },
    { code: "pets_allowed",  label: "🐕 Pets allowed"        },
    { code: "child_friendly",label: "👶 Child-friendly"      }
  ];

  const { sendList } = await import("./metaSender.js");

  const facilityRows = ALL_FACILITIES.map(f => ({
    id:          `sup_hosp_fac_toggle_${f.code}`,
    title:       existing.includes(f.code) ? `✅ ${f.label}` : f.label,
    description: existing.includes(f.code) ? "Tap to remove" : "Tap to add"
  }));

  facilityRows.push({ id: "sup_hosp_facilities_done", title: "✅ Done — save facilities" });

  const selected = existing.length
    ? `\n\n_Selected: ${existing.map(f => f.replace("_", " ")).join(", ")}_`
    : "";

  return sendList(from,
    `🏨 *What facilities do you offer?*${selected}\n\nTap to add or remove:`,
    facilityRows.slice(0, 10) // WhatsApp list limit
  );
}

// ── Step: Tourism / Hospitality details (legacy — kept for backward compat) ──
if (state === "supplier_reg_tourism_details") {
  const raw = (text || "").trim();
  if (raw.toLowerCase() !== "skip" && raw.length > 1) {
    const parts    = raw.split(/[|\n]+/);
    const typeRaw  = (parts[0] || "").trim();
    const areasRaw = parts[1] || "";
    biz.sessionData.supplierReg.tourismType  = typeRaw;
    biz.sessionData.supplierReg.tourismAreas = areasRaw.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }
  biz.sessionState = "supplier_reg_travel";
  await saveBiz(biz);
  return sendButtons(from, {
    text: "🚗 *Do you pick up clients / offer transfers?*",
    buttons: [
      { id: "sup_travel_yes", title: "✅ Yes We Do" },
      { id: "sup_travel_no",  title: "🏠 Clients Come to Us" }
    ]
  });
}

// ── Step: Business currency (injected between delivery/travel and confirm) ──
if (state === "supplier_reg_biz_currency") {
  // handled via button in chatbotEngine - this state is a passthrough guard
  return true;
}
// ── Step 5: EcoCash Number Entry ──────────────────────────────────────────
  if (state === "supplier_reg_enter_ecocash") {
    const raw = (text || "").trim();
    const waDigits = from.replace(/\D+/g, "");

    // Normalize: "same" uses their WhatsApp number
    let normalized = raw.toLowerCase() === "same" ? waDigits : raw.replace(/\D+/g, "");
    if (normalized.startsWith("263") && normalized.length === 12) normalized = "0" + normalized.slice(3);
    if (normalized.length === 9 && normalized.startsWith("7")) normalized = "0" + normalized;

    if (!normalized.startsWith("0") || normalized.length !== 10) {
      await sendText(from,
`❌ That number doesn't look right.

Please send your EcoCash number like this:
*0772123456*

Or type *same* to use this WhatsApp number (${waDigits}).`
      );
      return true;
    }

    const supplierPayment = biz.sessionData?.supplierPayment;
    if (!supplierPayment?.tier || !supplierPayment?.plan) {
      await sendText(from, "❌ Payment details missing. Please select a plan again.");
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBiz(biz);
      const { sendSuppliersMenu } = await import("./metaMenus.js");
      return sendSuppliersMenu(from);
    }

    const { SUPPLIER_PLANS } = await import("./supplierPlans.js");
    const planDetails = SUPPLIER_PLANS[supplierPayment.tier]?.[supplierPayment.plan];

    if (!planDetails) {
      await sendText(from, "❌ Invalid plan. Please select a plan again.");
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBiz(biz);
      const { sendSuppliersMenu } = await import("./metaMenus.js");
      return sendSuppliersMenu(from);
    }

    biz.sessionData.supplierPayment.ecocashPhone = normalized;
    biz.sessionState = "supplier_reg_payment_pending";
    await saveBiz(biz);

    // Initiate Paynow payment
    try {
      const paynow = (await import("./paynow.js")).default;
      const SupplierProfile = (await import("../models/supplierProfile.js")).default;
      const SupplierSubscriptionPayment = (await import("../models/supplierSubscriptionPayment.js")).default;
      const Business = (await import("../models/business.js")).default;
      const { sendDocument } = await import("./metaSender.js");
      const { generatePDF } = await import("../routes/twilio_biz.js");

      const reference = `SUP_${biz._id}_${Date.now()}`;
      const payment = paynow.createPayment(reference, "bmusasa99@gmail.com");
      payment.currency = planDetails.currency;
      payment.add(`ZimQuote Supplier ${supplierPayment.tier} (${supplierPayment.plan})`, planDetails.price);

      const response = await paynow.sendMobile(payment, normalized, "ecocash");

      if (!response.success || !response.pollUrl) {
  biz.sessionState = "supplier_reg_enter_ecocash";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    supplierPayment: {
      ...(biz.sessionData?.supplierPayment || {}),
      ecocashPhone: normalized
    }
  };
  await saveBiz(biz);

  await sendText(from,
`❌ EcoCash payment failed to start.

Make sure your number is correct and try again:
*0772123456*

Or type *same* to use this WhatsApp number.`
  );
  return true;
}

      // Save pending payment record
    // Save pending payment record
      const supplierId = biz.sessionData?.pendingSupplierId;
      await SupplierSubscriptionPayment.create({
        supplierId: supplierId || null,
        businessId: biz._id,
        tier: supplierPayment.tier,
        plan: supplierPayment.plan,
        amount: planDetails.price,
        currency: planDetails.currency,
        reference,
        pollUrl: response.pollUrl,
        ecocashPhone: normalized,
        supplierPhone: phone,          // ← ADD THIS LINE
        status: "pending"
      });

      biz.sessionData.supplierPayment.paynow = { reference, pollUrl: response.pollUrl };
      await saveBiz(biz);

      await sendText(from,
`💳 *Payment Request Sent!*

Plan: *${SUPPLIER_PLANS[supplierPayment.tier].name} (${supplierPayment.plan})*
Amount: *$${planDetails.price} ${planDetails.currency}*
EcoCash: *${normalized}*

👉 *Check your phone now* - approve the EcoCash payment prompt.

We will activate your listing automatically once payment is confirmed. ✅`
      );

      // Poll for payment
      const pollUrl = response.pollUrl;
      let attempts = 0;
      const MAX_ATTEMPTS = 18; // 3 minutes

      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const status = await paynow.pollTransaction(pollUrl);

          if (status.status && status.status.toLowerCase() === "paid") {
            clearInterval(pollInterval);

            const freshBiz = await Business.findById(biz._id);
            if (!freshBiz || freshBiz.sessionState !== "supplier_reg_payment_pending") return;

            const supplierId = freshBiz.sessionData?.pendingSupplierId ||
              freshBiz.sessionData?.supplierPayment?.supplierId;

            const supplier = supplierId
              ? await SupplierProfile.findById(supplierId)
              : await SupplierProfile.findOne({ phone });

            if (supplier) {
              const now = new Date();
              const expiresAt = new Date(now.getTime() + planDetails.durationDays * 24 * 60 * 60 * 1000);

   supplier.tier = supplierPayment.tier;
supplier.active = true;
supplier.subscriptionStatus = "active";
supplier.subscriptionStartedAt = now;
supplier.subscriptionEndsAt = expiresAt;

const capMap = { basic: 20, pro: 60, featured: 150 };
const cap = capMap[supplier.tier] || 20;
const uploaded = (supplier.products || []).filter(p => p && p !== "pending_upload");

if (!Array.isArray(supplier.listedProducts)) {
  supplier.listedProducts = [];
}

if (uploaded.length <= cap) {
  supplier.listedProducts = uploaded;
} else if (!supplier.listedProducts.length) {
  supplier.listedProducts = [];
}

await supplier.save();


// ── SYNC supplier products/services → Product model ──────────────────────
// ── SYNC supplier products/services → Product model ──────────────────────
try {
  const Product   = (await import("../models/product.js")).default;
  const Business  = (await import("../models/business.js")).default;
  const Branch    = (await import("../models/branch.js")).default;    // ← MOVED UP: in scope for entire try block
  const UserRole  = (await import("../models/userRole.js")).default;  // ← MOVED UP

  const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
  const bizPackage = TIER_TO_PACKAGE[supplierPayment.tier] || "bronze";

  // ── 1. Upgrade the linked Business package ────────────────────────────
  const linkedBiz = await Business.findById(supplier.businessId);
  if (linkedBiz) {
    linkedBiz.package = bizPackage;
    linkedBiz.subscriptionStatus = "active";
    linkedBiz.subscriptionStartedAt = now;
    linkedBiz.subscriptionEndsAt = expiresAt;
    linkedBiz.isSupplier = true;
    linkedBiz.supplierProfileId = supplier._id;
    if (!linkedBiz.name || linkedBiz.name.startsWith("pending_")) {
      linkedBiz.name = supplier.businessName;
    }
    await linkedBiz.save();
  }

  // ── 2. Ensure main branch exists ──────────────────────────────────────
  let mainBranchId;
  const existingBranch = await Branch.findOne({ businessId: supplier.businessId, isDefault: true });
  if (!existingBranch) {
    const mainBranch = await Branch.create({
      businessId: supplier.businessId,
      name: "Main Branch",
      isDefault: true
    });
    await UserRole.findOneAndUpdate(
      { businessId: supplier.businessId, role: "owner" },
      { branchId: mainBranch._id }
    );
    mainBranchId = mainBranch._id;
  } else {
    mainBranchId = existingBranch._id;
  }

  // Store on supplier for fast lookup later
  supplier.mainBranchId = mainBranchId;
  await supplier.save();

  // ── 3. Sync listed items → Product model ─────────────────────────────
  const itemsToSync = uploaded.slice(0, cap);
  for (const itemName of itemsToSync) {
    const priceEntry = (supplier.prices || []).find(
      p => p.product?.toLowerCase() === itemName.toLowerCase()
    );
    const rateEntry = (supplier.rates || []).find(
      r => r.service?.toLowerCase() === itemName.toLowerCase()
    );
    const unitPrice = priceEntry?.amount || 0;
    const description = rateEntry?.rate || null;

    await Product.findOneAndUpdate(
      { businessId: supplier.businessId, name: itemName },
      {
        $set: {                                    // ← $set not $setOnInsert: always update branchId
          businessId: supplier.businessId,
          branchId: mainBranchId,
          unitPrice,
          description,
          isActive: true
        }
      },
      { upsert: true }
    );
  }
} catch (syncErr) {
  console.error("[Supplier Payment] Product sync failed:", syncErr.message);
}

// ── END SYNC ─────────────────────────────────────────────────────────────

              // Update payment record
              await SupplierSubscriptionPayment.findOneAndUpdate(
                { reference },
                { status: "paid", paidAt: now, endsAt: expiresAt }
              );

              // Generate receipt PDF
              try {
                const receiptNumber = `SUP-${reference.slice(-8).toUpperCase()}`;
                const { filename } = await generatePDF({
                  type: "receipt",
                  number: receiptNumber,
                  date: now,
                  billingTo: supplier.businessName,
                  items: [{
                    item: `ZimQuote Supplier ${SUPPLIER_PLANS[supplierPayment.tier].name} Plan (${supplierPayment.plan})`,
                    qty: 1,
                    unit: planDetails.price,
                    total: planDetails.price
                  }],
                  bizMeta: {
                    name: "ZimQuote",
                    logoUrl: "",
                    address: "ZimQuote Supplier Platform",
                    _id: biz._id.toString(),
                    status: "paid"
                  }
                });

                const site = (process.env.SITE_URL || "").replace(/\/$/, "");
                const receiptUrl = `${site}/docs/generated/receipts/${filename}`;
                await sendDocument(from, { link: receiptUrl, filename });
              } catch (pdfErr) {
                console.error("[Supplier Payment] PDF generation failed:", pdfErr.message);
              }

                    if (uploaded.length > cap) {
                freshBiz.sessionState = "supplier_select_listed_products";
                freshBiz.sessionData = {
                  ...(freshBiz.sessionData || {}),
                  listedSelectionCap: cap
                };
                await freshBiz.save();

                await sendText(from,
`✅ *Payment Confirmed! You are now LIVE!*

Plan: *${SUPPLIER_PLANS[supplierPayment.tier].name}*
Expires: *${expiresAt.toDateString()}*

You uploaded *${uploaded.length}* items.
Your plan allows *${cap}* live items.

Reply with the numbers of the items you want listed now *(choose up to ${cap})*.
You can add more later from your account.

Example: *1,2,5*`
                );

                const DISPLAY_MAX = 100;
                const preview = uploaded.slice(0, DISPLAY_MAX)
                  .map((item, i) => `${i + 1}. ${item}`)
                  .join("\n");

                await sendText(
                  from,
                 `📋 Choose *up to ${cap}* items to go live now:\n\n${preview}\n\n_You can add more later anytime._${uploaded.length > DISPLAY_MAX ? `\n_...and ${uploaded.length - DISPLAY_MAX} more_` : ""}`
                );

                return true;
              }

              freshBiz.sessionState = "ready";
              freshBiz.sessionData = {};
              await freshBiz.save();

              const { sendSupplierAccountMenu } = await import("./metaMenus.js");
              await sendText(from,
`✅ *Payment Confirmed! You are now LIVE!*

Your listing is now *active*. Buyers in your area can find you when they search.

Plan: *${SUPPLIER_PLANS[supplierPayment.tier].name}*
Expires: *${expiresAt.toDateString()}*

✅ *${uploaded.length} item${uploaded.length === 1 ? "" : "s"} listed live now.*`
              );
              return sendSupplierAccountMenu(from, supplier);
            }
          }

          if (attempts >= MAX_ATTEMPTS) {
            clearInterval(pollInterval);
            const freshBiz = await Business.findById(biz._id);
            if (freshBiz?.sessionState === "supplier_reg_payment_pending") {
              freshBiz.sessionState = "ready";
              freshBiz.sessionData = {};
              await freshBiz.save();
            }
            await sendText(from,
`⏰ *Payment not confirmed yet.*

If you already paid, your listing will be activated shortly. If not, please try again by typing *menu* and selecting List My Business → your plan.

Need help? Contact support.`
            );
          }
        } catch (pollErr) {
          console.error("[Supplier Payment] Poll error:", pollErr.message);
        }
      }, 10000);

   } catch (err) {
  console.error("[Supplier Payment] Error:", err);
  biz.sessionState = "supplier_reg_enter_ecocash";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    supplierPayment: {
      ...(biz.sessionData?.supplierPayment || {}),
      ecocashPhone: normalized
    }
  };
  await saveBiz(biz);

  await sendText(from,
`❌ Something went wrong starting your payment.

Please enter your EcoCash number again:
*0772123456*

Or type *same* to use this WhatsApp number.`
  );
  return true;
}

    return true;
  }

  // ── Step 5b: Payment pending - waiting for confirmation ──────────────────
  if (state === "supplier_reg_payment_pending") {
    await sendText(from,
`⏳ *Waiting for your EcoCash payment...*

Please check your phone and approve the payment prompt.

If you already approved it, your listing will activate automatically within a minute.

_Type *cancel* to start over._`
    );
    return true;
  }




// ── Pricing preview: show supplier what was saved, ask to confirm ─────────


// ── After pricing confirmed: route to delivery/travel step ───────────────


  return false;
}
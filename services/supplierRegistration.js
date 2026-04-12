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
  plumbing_supplies:   ["PVC pipe 20mm", "gate valve 20mm", "water tank 1000L", "electric geyser 100L", "toilet suite"],
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
      { id: "reg_type_product", title: "📦 I Sell Products" },
      { id: "reg_type_service", title: "🧰 I Offer Services" },
      { id: "reg_type_school",  title: "🏫 I Run a School" }
    ]
  );
}

export async function handleSupplierRegistrationStates({
  state, from, text, biz, saveBiz
}) {
  const phone = from.replace(/\D+/g, "");

  // ── Step 1: Business Name ──────────────────────────────
 // ── Step 0: Listing type chosen via button (product/service handled in chatbotEngine)
  // School name free-text entry after "reg_type_school" button
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
        { id: "sup_contact_skip", title: "⏭ Skip Contact Details" }
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

  if (profileType === "service") {
    biz.sessionState = "supplier_reg_collar";
    await saveBiz(biz);

    return sendList(from, "🧑‍💼 *What type of services do you offer?*\n\nThis helps buyers find you faster.", [
      { id: "sup_collar_white_collar", title: "💼 Professional Services" },
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

      if (!response.success) {
        biz.sessionState = "supplier_reg_enter_ecocash";
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
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBiz(biz);
      await sendText(from, "❌ Something went wrong starting your payment. Please try again.");
      const { sendSuppliersMenu } = await import("./metaMenus.js");
      return sendSuppliersMenu(from);
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
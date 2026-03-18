// services/supplierRegistration.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import { SUPPLIER_CITIES, SUPPLIER_CATEGORIES } from "./supplierPlans.js";

// ── Category-specific product/service examples ────────────────────────────
export const CATEGORY_PRODUCT_EXAMPLES = {
  groceries:   ["cooking oil", "rice", "sugar"],
  clothing:    ["t-shirts", "jeans", "sneakers"],
  hardware:    ["cement", "roofing sheets", "steel bar"],
  agriculture: ["maize seed", "fertilizer", "pesticide"],
  electronics: ["phone charger", "earphones", "led bulb"],
  crossborder: ["solar panel", "generator", "power bank"],
  cosmetics:   ["face cream", "hair relaxer", "body lotion"],
  furniture:   ["sofa", "bed frame", "dining table"],
  car_supplies: ["car battery", "engine oil", "brake pads"],
  health:      ["paracetamol", "vitamins", "blood pressure monitor"],
  other:       ["product a", "product b", "product c"]
};

export const CATEGORY_SERVICE_EXAMPLES = {
  plumbing:      ["burst pipe repair", "toilet installation", "geyser fitting"],
  electrical:    ["wiring", "DB board", "light fitting"],
  construction:  ["bricklaying", "plastering", "roofing"],
  painting:      ["interior painting", "exterior painting", "texture coat"],
  welding:       ["gate fabrication", "burglar bars", "steel door"],
  cleaning:      ["office cleaning", "carpet cleaning", "deep clean"],
  transport:     ["car hire", "delivery", "airport transfers"],
  food_cooked:   ["catering", "wedding cake", "lunch boxes"],
  printing:      ["business cards", "banners", "flyers"],
  beauty:        ["hair braiding", "nails", "makeup"],
  photography:   ["wedding photos", "passport photos", "events coverage"],
  tutoring:      ["maths tutor", "O-Level prep", "primary school help"],
  it_support:    ["laptop repair", "wifi setup", "CCTV installation"],
  security:      ["security guard", "alarm installation", "access control"],
  services:      ["plumbing", "welding", "painting"],
  other:         ["handyman", "deliveries", "odd jobs"]
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

  if (!biz) {
    const UserSession = (await import("../models/userSession.js")).default;

    await UserSession.findOneAndUpdate(
      { phone },
      { phone, supplierRegState: "supplier_reg_name", supplierRegData: {} },
      { upsert: true }
    );

 return sendText(from,
`📦 *List Your Business*

Let's get you listed in 2 minutes 👍

What is your *business name*?

_At any time, type *cancel* to stop and go back to the main menu._`
    );
  }

  biz.sessionState = "supplier_reg_name";
  biz.sessionData = { supplierReg: {} };

  const { saveBizSafe } = await import("./bizHelpers.js");
  await saveBizSafe(biz);

 return sendText(from,
`📦 *List Your Business*

Let's get you listed in 2 minutes 👍

What is your *business name*?

_At any time, type *cancel* to stop and go back to the main menu._`
    );
}

export async function handleSupplierRegistrationStates({
  state, from, text, biz, saveBiz
}) {
  const phone = from.replace(/\D+/g, "");

  // ── Step 1: Business Name ──────────────────────────────
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

    return sendList(from, "📍 Where are you based?", [
      ...SUPPLIER_CITIES.map(c => ({ id: `sup_city_${c.toLowerCase()}`, title: c })),
      { id: "sup_city_other", title: "📍 Other (type yours)" }
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
    biz.sessionState = "supplier_reg_type";
    await saveBiz(biz);

    return sendButtons(from, {
      text: "📦 *What type of business are you?*\n\nThis helps buyers find the right kind of supplier.",
      buttons: [
        { id: "reg_type_product", title: "📦 I Sell Products" },
        { id: "reg_type_service", title: "🔧 I Offer Services" }
      ]
    });
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
    const numberedList = savedProducts.map((p, i) => `${i + 1}. ${p}`).join("\n");

    const rateExampleMap = {
      "car hire": "50/day", "delivery": "10/trip", "airport transfers": "25/trip",
      "plumbing": "15/hr", "burst pipe repair": "20/job", "toilet installation": "30/job",
      "electrical": "15/hr", "wiring": "20/hr", "light fitting": "10/job",
      "bricklaying": "8/hr", "plastering": "12/hr", "roofing": "50/job",
      "interior painting": "15/hr", "exterior painting": "20/hr",
      "gate fabrication": "80/job", "burglar bars": "60/job",
      "office cleaning": "20/job", "carpet cleaning": "15/job",
      "lawn mowing": "10/job", "tree trimming": "15/job",
      "catering": "50/event", "wedding cake": "80/job", "lunch boxes": "5/box",
      "business cards": "15/job", "banners": "20/job",
      "hair braiding": "10/job", "nails": "8/job", "makeup": "15/job",
      "wedding photos": "100/event", "passport photos": "5/job",
      "laptop repair": "20/job", "wifi setup": "15/job",
      "security guard": "10/hr", "alarm installation": "50/job",
      "maths tutor": "10/hr", "english lessons": "8/hr",
      "primary school help": "8/hr", "o-level prep": "12/hr",
    };

    const exampleLines = savedProducts.slice(0, 3).map(svc => {
      const key = Object.keys(rateExampleMap).find(k =>
        svc.toLowerCase().includes(k) || k.includes(svc.toLowerCase())
      );
      const rate = key ? rateExampleMap[key] : "10/hr";
      return `${svc}: ${rate}`;
    });

    const fastestExample = savedProducts.slice(0, 3).map(svc => {
      const key = Object.keys(rateExampleMap).find(k =>
        svc.toLowerCase().includes(k) || k.includes(svc.toLowerCase())
      );
      return key ? rateExampleMap[key] : "10/hr";
    }).join(", ");

    return sendButtons(from, {
      text:
`💰 *Set Your Rates*

${numberedList}

*Fastest - just rates in order:*
_${fastestExample}_

*Or name them:*
_${exampleLines.slice(0, 2).join(", ")}_

*Common units:* /hr, /job, /trip, /day, /event

Type *skip* to add rates later.`,
      buttons: [{ id: "sup_skip_prices", title: "⏭ Skip Rates" }]
    });
  }

  biz.sessionData.supplierReg.prices = [];
  await saveBiz(biz);

const savedServices = biz.sessionData.supplierReg.products || [];
const numberedServiceList = savedServices.map((s, i) => `${i + 1}. ${s}`).join("\n");

return sendButtons(from, {
  text:
`💰 *Set Your Rates*

${numberedServiceList}

*Fastest:* Reply with rates in order, comma-separated:
_20, 50, 30_  ← just the numbers

*Or with units:*
_20/hr, 50/trip, 30/job_

*Or name them:*
_plumbing 20/hr, delivery 50/trip_

Type *skip* to add rates later.`,
  buttons: [{ id: "sup_skip_prices", title: "⏭ Skip Rates" }]
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
  if (!rawInput || rawInput.length < 1) {
    // Fall through to show the form below
  } else if (lowerInput !== "skip" && lowerInput !== "done") {
    // Supplier typed something that looks like prices - try to parse it
    const parts = rawInput.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?$/.test(s));
    const updated = [];
    const failed = [];

    if (allNumbers) {
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

    } else {
      // Strategy 2: named pricing e.g. "cement 5.50, sand 8" or "20/job, 50/hr"
      for (const line of parts) {
        const clean = line
          .replace(/^[-•*►▪✓]\s*/, "")
          .replace(/^\d+[.)]\s*/, "")
          .replace(/\$/g, "")
          .trim();

        if (!clean) continue;

        // Strategy 2a: "NUMBER/UNIT" format e.g. "20/job", "50/hr" - assign positionally
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

        // Strategy 2b: "name: number" or "name number" format
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
      const previewLines = isService
        ? updated.map(u => `• ${u.service} - $${Number(u.amount).toFixed(2)}/${u.unit}`).join("\n")
        : updated.map(u => `• ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`).join("\n");

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

${isService
  ? `Enter rates like this:\n*${products.slice(0,3).map((_, i) => ((i+1)*10)).join(", ")}*  ← just numbers in order\n\nOr: *${products.slice(0,2).map(p => `${p}: 10/job`).join(", ")}*\n\nOr rate format: *20/job, 50/hr*`
  : `Enter prices like this:\n*${products.slice(0,3).map((_, i) => ((i+1)*5+2)).join(", ")}*  ← just numbers in order\n\nOr: *${products.slice(0,2).map(p => `${p}: 5.50`).join(", ")}*`
}

Type *skip* to add ${rateLabel} later.`
      );
    }
  }

  // ── Show the price entry form ─────────────────────────────────────────────
  const existingPrices = reg.prices || [];
  const existingRates  = reg.rates  || [];

  const numbered = products.map((p, i) => {
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

  const exampleNums = products.slice(0, Math.min(4, products.length))
    .map((_, i) => [5.50, 8.00, 1.20, 15.00][i].toFixed(2))
    .join(", ");

  const serviceExampleNums = products.slice(0, Math.min(3, products.length))
    .map((_, i) => [10, 25, 50][i])
    .join(", ");

  return sendButtons(from, {
    text:
`💰 *Set Your ${isService ? "Rates" : "Prices"} (USD)*

${numbered}

─────────────────
${isService
  ? `*Fastest - just numbers in order:*\n_${serviceExampleNums}_\n\n*Or with units:*\n_20/job, 50/hr, 15/trip_\n\n*Or name them:*\n_${products.slice(0,2).map(p => `${p}: 20/job`).join(", ")}_`
  : `*Option 1 - Fastest ✅*\nJust numbers in order:\n_${exampleNums}_\n\n*Option 2 - Name them:*\n_${products.slice(0,2).map(p => `${p}: 5.50`).join(", ")}_\n\n*Option 3 - With units:*\n_cement 5.50/bag, sand 8/load_`
}
─────────────────
_Enter your ${rateLabel} below or tap Skip_ 👇`,
    buttons: [
      { id: "sup_skip_prices", title: "⏭ Skip For Now" }
    ]
  });
}
  // ── Step 4: Minimum Order ──────────────────────────────


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
              supplier.subscriptionExpiresAt = expiresAt;
              await supplier.save();

              // Update payment record
              await SupplierSubscriptionPayment.findOneAndUpdate(
                { reference },
                { status: "paid", paidAt: now }
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

              freshBiz.sessionState = "ready";
              freshBiz.sessionData = {};
              await freshBiz.save();

              const { sendSupplierAccountMenu } = await import("./metaMenus.js");
              await sendText(from,
`✅ *Payment Confirmed! You are now LIVE!*

Your listing is now *active*. Buyers in your area can find you when they search.

Plan: *${SUPPLIER_PLANS[supplierPayment.tier].name}*
Expires: *${expiresAt.toDateString()}*

Start receiving orders! 🎉`
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


  async function _finishPricingStep(from, biz, saveBiz, count, isService) {
  if (isService) {
    biz.sessionState = "supplier_reg_travel";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `✅ Saved ${count} rate(s)!\n\n🚗 *Do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }
  biz.sessionState = "supplier_reg_delivery";
  await saveBiz(biz);
  return sendButtons(from, {
    text: `✅ Saved ${count} price(s)!\n\n🚚 *Do you deliver?*`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}

// ── Pricing preview: show supplier what was saved, ask to confirm ─────────
async function _showPricingPreview(from, biz, saveBiz, parsed, isService) {
  // Build readable preview
  const lines = isService
    ? parsed.map(r => `• ${r.service} - ${r.rate}`)
    : parsed.map(p => `• ${p.product} - $${Number(p.amount).toFixed(2)}/${p.unit}`);

  const preview = lines.join("\n");

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};

  // ── FIX: Advance state NOW so re-typing doesn't loop back here ───────────
  // State moves to travel/delivery. The confirm buttons (sup_travel_yes etc.)
  // are the natural next step. "✏️ Re-enter" resets to supplier_reg_prices.
  if (isService) {
    biz.sessionState = "supplier_reg_travel";
  } else {
    biz.sessionState = "supplier_reg_delivery";
  }
  await saveBiz(biz);

  return sendButtons(from, {
    text:
`✅ *${isService ? "Rates" : "Prices"} Saved!* (${parsed.length} item${parsed.length > 1 ? "s" : ""})

${preview}

_You can update these anytime from your account._

${isService ? "🚗 *Do you travel to clients?*" : "🚚 *Do you deliver?*"}`,
    buttons: isService
      ? [
          { id: "sup_travel_yes", title: "✅ Yes I Travel" },
          { id: "sup_travel_no",  title: "🏠 Client Comes to Me" },
          { id: "sup_prices_edit", title: "✏️ Re-enter Rates" }
        ]
      : [
          { id: "sup_del_yes", title: "✅ Yes I Deliver" },
          { id: "sup_del_no",  title: "🏠 Collection Only" },
          { id: "sup_prices_edit", title: "✏️ Re-enter Prices" }
        ]
  });
}

// ── After pricing confirmed: route to delivery/travel step ───────────────
async function _finishPricingStep(from, biz, saveBiz, count, isService) {
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  delete biz.sessionData.supplierReg.pricingConfirmPending;

  if (isService) {
    biz.sessionState = "supplier_reg_travel";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `✅ ${count} rate(s) saved!\n\n🚗 *Do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }
  biz.sessionState = "supplier_reg_delivery";
  await saveBiz(biz);
  return sendButtons(from, {
    text: `✅ ${count} price(s) saved!\n\n🚚 *Do you deliver?*`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}

  return false;
}
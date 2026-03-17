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
if (state === "supplier_reg_prices") {
  const reg = biz.sessionData.supplierReg || {};
  const raw = text.trim();
  const isService = reg.profileType === "service";
  const productList = reg.products || [];

  if (!raw) {
    await sendText(from, "❌ Please send your prices.");
    return true;
  }

  // ── STRATEGY 1: Pure number list - fastest, matches by position ──────────
  // Supplier just sends: 5.50, 8, 0.25, 12
  const parts = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
// Also accept "20/job", "15/hr", "50/day" as pure rate entries (number/unit)
const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?(?:\/\w+)?$/.test(s));

  if (allNumbers) {
    if (productList.length > 0 && parts.length !== productList.length) {
      const numbered = productList.map((p, i) => `${i + 1}. ${p}`).join("\n");
      await sendText(from,
`❌ You have *${productList.length} items* but sent *${parts.length} prices*.

Send one price per item in order:
${numbered}

*Example:* ${productList.slice(0, 3).map(() => (Math.floor(Math.random() * 15) + 1) + ".00").join(", ")}${productList.length > 3 ? ", ..." : ""}`
      );
      return true;
    }

  const matched = parts.map((numStr, i) => {
      const name = (productList[i] || `item ${i + 1}`).toLowerCase();
      const amount = parseFloat(numStr);
      // Preserve supplied unit if present (e.g. "20/job" → unit="job")
      const slashIdx = numStr.indexOf("/");
      const suppliedUnit = slashIdx >= 0 ? numStr.slice(slashIdx + 1).trim() : null;
      return isService
        ? { service: name, rate: `${amount}/${suppliedUnit || "job"}` }
        : { product: name, amount, unit: suppliedUnit || "each", inStock: true };
    });

    if (isService) {
      biz.sessionData.supplierReg.rates = matched;
    } else {
      biz.sessionData.supplierReg.prices = matched;
    }

    return await _showPricingPreview(from, biz, saveBiz, matched, isService);
  }

  // ── STRATEGY 2: Named pricing - "cement 5.50" or "cement: 5.50" ──────────
  // Also handles bullet paste from Excel/WhatsApp: "• Cement $5.50/bag"
  const parsed = [];
  const failed = [];

  for (const line of parts) {
    // Clean common paste artifacts: bullets, currency, trailing punctuation
    const clean = line
      .replace(/^[-•*►▪✓]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/\$/g, "")
      .trim();

    if (!clean) continue;

    // Try "name: amount unit" first, then "name amount unit"
    let match =
      clean.match(/^(.+?)\s*[:]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/) ||
      clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);

    if (!match) {
      // Last resort: extract last number in line as price
      const numMatch = clean.match(/^(.+?)\s+.*?(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);
      if (numMatch) match = numMatch;
    }

    if (!match) { failed.push(line); continue; }

    const name = match[1].replace(/[$@\-:,]+$/, "").trim().toLowerCase();
    const amount = parseFloat(match[2]);
    const rawUnit = (match[3] || "").trim().toLowerCase();
    const unit = rawUnit || (isService ? "job" : "each");

    if (!name || name.length < 1 || isNaN(amount) || amount < 0) {
      failed.push(line); continue;
    }

    if (isService) {
      parsed.push({ service: name, rate: `${amount}/${unit}` });
    } else {
      parsed.push({ product: name, amount, unit, inStock: true });
    }
  }

  if (!parsed.length) {
    const numbered = productList.map((p, i) => `${i + 1}. ${p}`).join("\n");
    await sendText(from,
`❌ Couldn't read your prices.

*Fastest - just numbers in order:*
${productList.slice(0, 4).map((_, i) => ((i + 1) * 3 + 2) + ".00").join(", ")}

*Or name them:*
${productList.slice(0, 2).map(p => `${p}: 5.00`).join(", ")}

Your items:
${numbered}`
    );
    return true;
  }

  if (failed.length) {
    await sendText(from, `⚠️ Skipped ${failed.length} line(s) I couldn't read: _${failed.slice(0, 2).join(", ")}_`);
  }

  if (isService) {
    biz.sessionData.supplierReg.rates = parsed;
  } else {
    biz.sessionData.supplierReg.prices = parsed;
  }

  return await _showPricingPreview(from, biz, saveBiz, parsed, isService);
}
  // ── Step 4: Minimum Order ──────────────────────────────
  if (state === "supplier_reg_minorder") {
    const amount = Number(text.trim());
    if (isNaN(amount) || amount < 0) {
      await sendText(from, "❌ Enter a valid amount or 0 for no minimum:");
      return true;
    }

    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.minOrder = amount;
    biz.sessionState = "supplier_reg_confirm";
    await saveBiz(biz);

    const reg = biz.sessionData.supplierReg;
 const isService = reg.profileType === "service";

    const deliveryText = isService
      ? `🚗 ${reg.travelAvailable ? "Travels to clients" : "Client comes to provider"}`
      : reg.delivery?.available
        ? `🚚 ${reg.delivery.range === "city_wide"
            ? "Delivers in city"
            : reg.delivery.range === "nationwide"
            ? "Delivers nationwide"
            : "Delivers nearby"}`
        : "🏠 Collection only";

const pricingText = isService
  ? `💰 Rates:\n${Array.isArray(reg.rates) && reg.rates.length
      ? reg.rates.map(r => `• ${r.service} ${r.rate}`).join("\n")
      : "Not specified"}`
  : `💵 Min order: ${amount > 0 ? `$${amount}` : "No minimum"}`;

    return sendButtons(from, {
      text: `✅ *Almost done! Confirm your listing:*\n\n` +
            `🏪 ${reg.businessName}\n` +
            `📍 ${reg.area}, ${reg.city}\n` +
          `${isService ? "🔧" : "📦"} ${
  reg.products?.[0] === "pending_upload"
    ? "_(Products to be uploaded)_"
    : (reg.products || []).join(", ")
}\n` +
            `${deliveryText}\n` +
            `${pricingText}\n\n` +
            `Is this correct?`,
      buttons: [
        { id: "sup_confirm_yes", title: "✅ Confirm" },
        { id: "sup_confirm_no", title: "❌ Start Over" }
      ]
    });
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

  // Store a flag so confirm handler knows what to do
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.pricingConfirmPending = true;
  await saveBiz(biz);

  return sendButtons(from, {
    text:
`✅ *Prices Preview* (${parsed.length} items)

${preview}

Is this correct?`,
    buttons: [
      { id: "sup_prices_confirm_yes", title: "✅ Looks Good" },
      { id: "sup_prices_edit",        title: "✏️ Re-enter Prices" },
      { id: "sup_skip_prices",        title: "⏭ Skip For Now" }
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
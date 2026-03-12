// services/supplierRegistration.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import { SUPPLIER_CITIES, SUPPLIER_CATEGORIES } from "./supplierPlans.js";

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
    biz.sessionState = "supplier_reg_category";
    await saveBiz(biz);

    return sendList(from, "🗂 What do you mainly sell?", [
      ...SUPPLIER_CATEGORIES.map(c => ({
        id: `sup_cat_${c.id}`, title: c.label
      }))
    ]);
  }

  // ── Step 3: Products ───────────────────────────────────
 // ── Step 3: Products ───────────────────────────────────────────────────────
  if (state === "supplier_reg_products") {
    const products = text.split(",")
      .map(p => p.trim().toLowerCase())
      .filter(p => p.length > 0);

  if (!products.length) {
      await sendText(from,
`❌ Please list at least one product, separated by commas.

*Example:*
*cooking oil, rice, sugar, flour, bread*

Just type them and send 👇`
      );
      return true;
    }

    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.products = products;
    biz.sessionData.supplierReg.prices = [];
    biz.sessionData.supplierReg.priceIndex = 0;
    biz.sessionState = "supplier_reg_prices";
    await saveBiz(biz);

  const first = products[0];
    return sendButtons(from, {
      text:
`💰 *Add Your Prices*

Buyers use prices to compare suppliers before ordering. Adding prices helps you get more orders!

What is your price for *${first}*?

*How to type it:*
Just send the amount followed by the unit.

*Examples:*
- *4.50 litre* — for cooking oil by litre
- *8.00 bag* — for a bag of rice
- *1.20 kg* — for sugar per kg
- *12.00 dozen* — for eggs per dozen
- *5.00 each* — for single items

_If you don't know yet, tap Skip below._`,
      buttons: [{ id: "sup_skip_prices", title: "⏭ Skip Pricing" }]
    });
  }

  // ── Step 3b: Prices ────────────────────────────────────────────────────────
  if (state === "supplier_reg_prices") {
    const reg = biz.sessionData.supplierReg;
    const products = reg.products || [];
    const idx = reg.priceIndex || 0;

    const raw = text.trim();
    // Parse "4.50 kg" or "4.50" or "4.50each"
    const match = raw.match(/^(\d+(\.\d+)?)\s*([a-zA-Z]*)$/);
   if (!match) {
      await sendText(from,
`❌ That format didn't work. Please try again.

*How to type it:*
Amount then unit, like this:

- *4.50 litre*
- *8 bag*
- *1.20 kg*
- *12 dozen*
- *5 each*

What is your price for *${products[idx]}*?`
      );
      return true;
    }

    const amount = parseFloat(match[1]);
    const unit = match[3] || "each";

    reg.prices = reg.prices || [];
    reg.prices.push({ product: products[idx], amount, unit, inStock: true });
    reg.priceIndex = idx + 1;

    if (reg.priceIndex < products.length) {
      const next = products[reg.priceIndex];
      await saveBiz(biz);
      return sendButtons(from, {
        text: `✅ $${amount}/${unit} saved!\n\nPrice for *${next}*?`,
        buttons: [
          { id: "sup_skip_prices", title: "⏭ Skip Rest" },
          { id: "sup_done_prices", title: "✅ Done Pricing" }
        ]
      });
    }

    // All products priced
    biz.sessionState = "supplier_reg_delivery";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `✅ All prices saved!\n\n🚚 Do you deliver?`,
      buttons: [
        { id: "sup_del_yes", title: "✅ Yes I Deliver" },
        { id: "sup_del_no", title: "🏠 Collection Only" }
      ]
    });
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
    const deliveryText = reg.delivery?.available
      ? `🚚 ${reg.delivery.range === "city_wide"
          ? "Delivers in city"
          : reg.delivery.range === "nationwide"
          ? "Delivers nationwide"
          : "Delivers nearby"}`
      : "🏠 Collection only";

    return sendButtons(from, {
      text: `✅ *Almost done! Confirm your listing:*\n\n` +
            `🏪 ${reg.businessName}\n` +
            `📍 ${reg.area}, ${reg.city}\n` +
            `📦 ${reg.products.join(", ")}\n` +
            `${deliveryText}\n` +
            `💵 Min order: ${amount > 0 ? `$${amount}` : "No minimum"}\n\n` +
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

👉 *Check your phone now* — approve the EcoCash payment prompt.

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

  // ── Step 5b: Payment pending — waiting for confirmation ──────────────────
  if (state === "supplier_reg_payment_pending") {
    await sendText(from,
`⏳ *Waiting for your EcoCash payment...*

Please check your phone and approve the payment prompt.

If you already approved it, your listing will activate automatically within a minute.

_Type *cancel* to start over._`
    );
    return true;
  }

  return false;
}
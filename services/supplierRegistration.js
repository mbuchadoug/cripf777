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

  return false;
}
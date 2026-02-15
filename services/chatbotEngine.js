import { ACTIONS } from "./actions.js";
import { startInvoiceFlow } from "./invoiceFlow.js";
import { startReceiptFlow } from "./receiptFlow.js";
import { continueTwilioFlow } from "./twilioStateBridge.js";
import { showUnpaidInvoices } from "./paymentAdapters.js";
import Invoice from "../models/invoice.js";
import Product from "../models/product.js";
import { startQuoteFlow } from "./quoteFlow.js";
import { sendList } from "./metaSender.js";
import { SUBSCRIPTION_PLANS } from "./subscriptionPlans.js";
import { PACKAGES } from "./packages.js";

import paynow from "./paynow.js";
import { sendDocument } from "./metaSender.js";
import {
  canUseFeature,
  requiredPackageForFeature,
  promptUpgrade
} from "./accessGuards.js";
import { generatePDF } from "../routes/twilio_biz.js";

import { sendPackagesMenu } from "./metaMenus.js";
import { startClientFlow } from "./clientFlow.js";
import { sendButtons } from "./metaSender.js";
   import Business from "../models/business.js";
  // import { sendPackagesMenu } from "./metaMenus.js";
//import { sendText } from "./metaSender.js";

import Branch from "../models/branch.js";
import UserRole from "../models/userRole.js";
import UserSession from "../models/userSession.js";
import {
  handleChooseSavedClient,
  handleNewClientFromInvoice,
  handleClientPicked
} from "./invoiceAdapters.js";

import {
  sendMainMenu,
  sendSalesMenu,
  sendClientsMenu,
  sendPaymentsMenu,
  sendBusinessMenu,
  sendSettingsMenu,
    sendReportsMenu,   // ✅ ADD THIS LINE
     sendUsersMenu,      // ✅ ADD
  sendBranchesMenu,    // ✅ ADD,
  sendProductsMenu 
} from "./metaMenus.js";

// helpers you already use elsewhere
import { getBizForPhone, saveBizSafe } from "./bizHelpers.js";
import { sendText } from "./metaSender.js";


import axios from "axios";

function normalizeEcocashNumber(input, fallbackWhatsApp) {
  const raw = (input || "").replace(/\D+/g, "");
  const fb = (fallbackWhatsApp || "").replace(/\D+/g, "");

  let phone =
    raw.toLowerCase?.() === "same"
      ? fb
      : raw;

  // If user typed "same" we may have non-digits already removed above, so handle properly:
  if ((input || "").trim().toLowerCase() === "same") {
    phone = fb;
  }

  // Now normalize Zimbabwe formats:
  // Accept: 0772..., +263772..., 263772...
  if (phone.startsWith("263") && phone.length === 12) {
    // Paynow EcoCash wants 07...
    return "0" + phone.slice(3);
  }

  if (phone.startsWith("0") && phone.length === 10) {
    return phone; // 0772xxxxxx
  }

  // Also accept 772xxxxxx (missing leading 0)
  if (phone.length === 9 && phone.startsWith("7")) {
    return "0" + phone;
  }

  return null;
}


async function forwardToTwilioWebhook({ from, text }) {
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");

  await axios.post(
    site + "/twilio/webhook",
    new URLSearchParams({
      From: "whatsapp:" + from.replace(/\D+/g, ""),
      Body: text
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );
}


async function showSalesDocs(from, type) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const docs = await Invoice.find({
    businessId: biz._id,
    type
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!docs.length) {
    await sendText(from, `No ${type}s found.`);
    return sendSalesMenu(from);
  }

  return sendList(
    from,
    `📄 Select ${type}`,
    docs.map(d => ({
      id: `doc_${d._id}`,
      title: `${d.number} — ${d.total} ${d.currency}`
    }))
  );
}

export async function handleIncomingMessage({ from, action }) {
    // =========================
  // 🔑 JOIN INVITATION (ABSOLUTE PRIORITY)
  // =========================
  const phone = from.replace(/\D+/g, "");
  const text =
    typeof action === "string" ? action.trim() : "";
  const al = text.toLowerCase();

  if (al === "join") {
    const invite = await UserRole.findOne({
      phone,
      pending: true
    }).populate("businessId branchId");

    if (!invite) {
      await sendText(
        from,
        "❌ No pending invitation found for this number."
      );
      return;
    }

    // ✅ ACTIVATE USER
    invite.pending = false;
    await invite.save();

    // ✅ SET ACTIVE BUSINESS
    await UserSession.findOneAndUpdate(
      { phone },
      { activeBusinessId: invite.businessId._id },
      { upsert: true }
    );

    await sendText(
      from,
`✅ Invitation accepted!

🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId?.name || "Main"}
🔑 Role: ${invite.role}

Reply *menu* to start.`
    );

    await sendMainMenu(from);
    return;
  }

  console.log("META INCOMING:", { from, action });

  // 🔑 ALWAYS LOAD BUSINESS FIRST
  const biz = await getBizForPhone(from);

  // =========================
  // 🟢 ONBOARDING GATE (META)
  // =========================
  if (!biz) {
    const text = (action || "").trim();

    if (/^create$/i.test(text)) {
      // 1️⃣ ACK META (CRITICAL)
      await sendText(from, "⏳ Creating your business, please wait...");

      // 2️⃣ DELEGATE TO TWILIO STATE MACHINE


const phone = from.replace(/\D+/g, "");

const existing = await Business.findOne({ ownerPhone: phone });
if (existing) {
  await sendText(from, "You already have a business. Reply *menu*.");
  return;
}

const now = new Date();

const biz = await Business.create({
  name: null,
  currency: "USD",
  provider: "whatsapp",
  package: "trial",
  subscriptionStatus: "active",
  trialStartedAt: now,
  trialEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
});

const branch = await Branch.create({
  businessId: biz._id,
  name: "Main Branch",
  isDefault: true
});

await UserRole.create({
  businessId: biz._id,
  branchId: branch._id,
  phone,
  role: "owner",
  pending: false
});

await UserSession.findOneAndUpdate(
  { phone },
  { activeBusinessId: biz._id },
  { upsert: true }
);

biz.sessionState = "awaiting_business_name";
await biz.save();

await sendText(from, "\nWhat is your business name?");
return;



      //return;
    }

    /*if (/^join$/i.test(text)) {
      await sendText(from, "⏳ Processing invitation...");
      await continueTwilioFlow({
        from,
        text: "JOIN"
      });
      return;
    }*/

return sendButtons(from, {
  text: "👋 Welcome!\n\nYou don’t have a business yet.",
  buttons: [
    { id: "create", title: "➕ Create business" }
  ]
});



  }



  const a = action || "";
  /*const al = a.toLowerCase();
const text = typeof action === "string" ? action.trim() : "";*/

  /* =========================
   NEW USER → BUSINESS ONBOARDING GATE
========================= */

/* =========================
   🚪 ONBOARDING (FIXED)
========================= */



// 📌 Main menu shortcut — ONLY when NOT onboardin



  /* =========================
     ENTRY
  ========================= */


    /* =========================
   JOIN INVITATION (META)
========================= */
if (al === "join") {
  const phone = from.replace(/\D+/g, "");

  const UserRole = (await import("../models/userRole.js")).default;
  const UserSession = (await import("../models/userSession.js")).default;

  const invite = await UserRole.findOne({
    phone,
    pending: true
  }).populate("businessId branchId");

  if (!invite) {
    return sendText(
      from,
      "❌ No pending invitation found for this number."
    );
  }

  // ✅ ACTIVATE USER
  invite.pending = false;
  await invite.save();

  // ✅ SET ACTIVE BUSINESS
  await UserSession.findOneAndUpdate(
    { phone },
    { activeBusinessId: invite.businessId._id },
    { upsert: true }
  );

  await sendText(
    from,
`✅ Invitation accepted!

🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId?.name || "Main"}
🔑 Role: ${invite.role}

Reply *menu* to start.`
  );

  return sendMainMenu(from);
}

    // 🔒 Prevent Meta from interrupting Twilio media flows



  /* =========================
     META LIST / BUTTON ACTIONS
     (MUST HARD RETURN)
  ========================= */

  if (al === "inv_use_client") {
    await handleChooseSavedClient(from);
    return;
  }


if (a.startsWith("payinv_")) {
  const invoiceId = a.replace("payinv_", "");

  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) {
    return sendText(from, "Invoice not found.");
  }

  biz.sessionState = "payment_amount";
  biz.sessionData = { invoiceId: invoice._id };
  await saveBizSafe(biz);

  return sendText(
    from,
`Invoice ${invoice.number}
Total: ${invoice.total} ${invoice.currency}
Paid: ${invoice.amountPaid} ${invoice.currency}
Balance: ${invoice.balance} ${invoice.currency}

Enter amount paid:`
  );
}




  // ===============================
// INVOICE CONFIRM ACTIONS (META)
// ===============================

// Generate PDF
// ===============================
// META → TWILIO CONFIRM DELEGATION
// ===============================




// ===============================
// INVOICE CONFIRM ACTIONS (META)
// ===============================



// ✅ Generate PDF → simulate "2"
if (a === "inv_generate_pdf") {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // build summary text
  const summary = biz.sessionData.items
    .map(
      (i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`
    )
    .join("\n");

  // 🔥 SEND SOMETHING BACK TO META
  await sendText(
    from,
    `📄 Generating invoice PDF...\n\n${summary}`
  );

  // now let Twilio logic generate + send PDF
  await continueTwilioFlow({
    from,
    text: "2"
  });

  return;
}

// ✅ Set Discount → simulate "4"
// ✅ Set Discount %
if (a === "inv_set_discount") {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "creating_invoice_set_discount";
  await saveBizSafe(biz);

  return sendText(from, "Enter discount percent (0–100):");
}

// ✅ Set VAT %
if (a === "inv_set_vat") {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "creating_invoice_set_vat";
  await saveBizSafe(biz);

  return sendText(from, "Enter VAT percent (0–100):");
}

if (a === "inv_item_catalogue") {
  const biz = await getBizForPhone(from);

  const products = await Product.find({
    businessId: biz._id,
    isActive: true
  }).limit(20);

  if (!products.length) {
    biz.sessionData.itemMode = "custom";
    await saveBizSafe(biz);
    return sendText(from, "No catalogue items yet. Send item description:");
  }

  biz.sessionState = "creating_invoice_pick_product";
  await saveBizSafe(biz);

  return sendList(
    from,
    "Select item",
    products.map(p => ({
      id: `prod_${p._id}`,
      title: `${p.name} (${p.unitPrice})`
    }))
  );
}


if (a === "inv_item_custom") {
  const biz = await getBizForPhone(from);
  biz.sessionData.itemMode = "custom";
  await saveBizSafe(biz);

  return sendText(from, "Send item description:");
}


  if (al === "inv_new_client") {
    await handleNewClientFromInvoice(from);
    return;
  }

  if (a === "inv_view_products") {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const products = await Product.find({
    businessId: biz._id,
    isActive: true
  }).lean();

  if (!products.length) {
    return sendText(from, "📦 No products found.");
  }

  let msg = "📦 Product catalogue:\n\n";

  products.forEach((p, i) => {
    msg += `${i + 1}) ${p.name} — ${p.unitPrice} ${biz.currency}\n`;
  });

  msg += `\nReply *menu* to cancel or choose *Pick from catalogue* to add items.`;

  return sendText(from, msg);
}


  // ===============================
// 📄 CLIENT STATEMENT (META)
// ===============================
if (a === ACTIONS.CLIENT_STATEMENT) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const Client = (await import("../models/client.js")).default;
  const clients = await Client.find({ businessId: biz._id }).lean();

  if (!clients.length) {
    await sendText(from, "No clients found.");
    return sendMainMenu(from);
  }

  biz.sessionState = "client_statement_choose_client";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendList(
    from,
    "📄 Select client for statement",
    clients.map(c => ({
      id: `stmt_client_${c._id}`,
      title: c.name || c.phone
    }))
  );
}

if (a === ACTIONS.ADD_PRODUCT) {
  const biz = await getBizForPhone(from);

  biz.sessionState = "product_add_name";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendText(from, "Enter product name:");
}


// ⚠️ Invoice client picker ONLY
if (al.startsWith("client_") && al !== ACTIONS.CLIENT_STATEMENT) {
  await handleClientPicked(from, al.replace("client_", ""));
  return;
}

if (a === ACTIONS.INV_ADD_ANOTHER_ITEM) {
  const biz = await getBizForPhone(from);

  biz.sessionState = "creating_invoice_add_items";
  biz.sessionData.itemMode = null;
  biz.sessionData.lastItem = null;
  biz.sessionData.expectingQty = false;
  biz.sessionData.lastItemSource = null;

  await saveBizSafe(biz);

  return sendButtons(from, {
    text: "How would you like to add an item?",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_view_products", title: "👀 View items" },
      { id: "inv_item_custom", title: "✍️ Custom item" }
    ]
  });
}



  if (a === ACTIONS.INV_ENTER_PRICES) {
    const biz = await getBizForPhone(from);
    biz.sessionState = "creating_invoice_enter_prices";
    biz.sessionData.priceIndex = 0;
    await saveBizSafe(biz);

    const item = biz.sessionData.items[0];
    return sendText(
      from,
      `Enter price for:\n${item.item} x${item.qty}`
    );
  }

  if (al === "inv_cancel") {
    const biz = await getBizForPhone(from);
    biz.sessionState = null;
    biz.sessionData = {};
    biz.markModified("sessionData");
    await biz.save();
    return sendMainMenu(from);
  }


  // ===============================
// PAYMENTS (META → TWILIO)
// ===============================



if (a === ACTIONS.RECORD_EXPENSE) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendList(
    from,
    "📂 Select Expense Category",
    [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]
  );
}


/* =========================
   REPORTS (META → TWILIO)
========================= */

// 📅 Daily Report
if (a === ACTIONS.DAILY_REPORT) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "report_daily";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return continueTwilioFlow({ from, text: "auto" });
}

// 📊 Weekly Report (Gold only)
if (a === ACTIONS.WEEKLY_REPORT) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "report_weekly";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return continueTwilioFlow({ from, text: "auto" });
}

// 📆 Monthly Report (Gold only)
if (a === ACTIONS.MONTHLY_REPORT) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "report_monthly";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return continueTwilioFlow({ from, text: "auto" });
}

// 🏢 Branch Summary Report (Gold only)
if (a === ACTIONS.BRANCH_REPORT) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "report_choose_branch";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return continueTwilioFlow({ from, text: "auto" });
}


  /* =========================
     TEXT → TWILIO FLOW
  ========================= */
if (biz?.sessionState === "product_add_name") {
  const name = text?.trim();

  if (!name || name.length < 2) {
    await sendText(from, "❌ Enter a valid product name:");
    return;
  }

  biz.sessionData.productName = name;
  biz.sessionState = "product_add_price";
  await saveBizSafe(biz);

  return sendText(from, "💰 Enter product price:");
}


if (biz?.sessionState === "product_add_price") {
  const price = Number(text);

  if (isNaN(price) || price <= 0) {
    await sendText(from, "❌ Enter a valid price (e.g. 50):");
    return;
  }

  const Product = (await import("../models/product.js")).default;

  await Product.create({
    businessId: biz._id,
    name: biz.sessionData.productName,
    unitPrice: price,
    isActive: true
  });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, "✅ Product saved successfully!");
  return sendMainMenu(from);
}

  /* =========================
   ONBOARDING — BUSINESS NAME
========================= */

// =========================
// 🏢 ONBOARDING: BUSINESS NAME
// =========================
if (biz && biz.sessionState === "awaiting_business_name") {
  const name = text;

  if (!name || name.length < 2) {
    await sendText(from, "❌ Please enter a valid business name:");
    return;
  }

  biz.name = name;
  biz.sessionState = "awaiting_currency";
  await saveBizSafe(biz);

  // Ask for currency (buttons)
 await sendButtons(from, {
  text: "💱 Select your business currency",
  buttons: [
    { id: "onb_currency_USD", title: "USD ($)" },
    { id: "onb_currency_ZWL", title: "ZWL (Z$)" },
    { id: "onb_currency_ZAR", title: "ZAR (R)" }
  ]
});


  return;
}


//const biz = await getBizForPhone(from);

// 🔑 In Meta Cloud, typed text ALSO arrives as `action`

// ✅ Meta action = known button/list IDs only
const isMetaAction =
  typeof action === "string" &&
  Object.values(ACTIONS).includes(action);


// Anything that is NOT a Meta action → Twilio state machine
//const biz = await getBizForPhone(from);

// 🔑 FORCE branch name input into Twilio flow


// default behaviour
// ⚠️ Do NOT send settings input to Twilio bridge
const settingsStates = [
  "settings_currency",
  "settings_terms",
  "settings_inv_prefix",
  "settings_qt_prefix",
  "settings_rcpt_prefix"
];

// ✅ SAFELY load business AFTER onboarding
 //biz = await getBizForPhone(from);

// ✅ Only pass text to Twilio if a business exists AND has a session

// =========================
// 💳 SUBSCRIPTION: ENTER ECOCASH NUMBER (TEXT INPUT)
// =========================
if (biz && biz.sessionState === "subscription_enter_ecocash" && !isMetaAction) {
  const waDigits = from.replace(/\D+/g, "");
  const ecocashPhone = normalizeEcocashNumber(text, waDigits);

  if (!ecocashPhone) {
    await sendText(
      from,
      "❌ Invalid EcoCash number.\n\nSend like: 0772123456\nOr type *same* to use this WhatsApp number."
    );
    return;
  }

  // Save chosen EcoCash number, then proceed to payment
  biz.sessionState = "subscription_payment_pending";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    ecocashPhone
  };
  await saveBizSafe(biz);

  // Kick off Paynow using the chosen EcoCash number
  // (We call the same logic that used to run immediately after pkg selection)
  const selected = biz.sessionData?.targetPackage;
  const plan = selected ? SUBSCRIPTION_PLANS[selected] : null;

  if (!plan) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ Package info missing. Please select a package again.");
    return sendMainMenu(from);
  }

  // Build Paynow reference tied to BUSINESS (this is what guarantees correct activation)
  const reference = `SUB_${biz._id}_${Date.now()}`;

  const payment = paynow.createPayment(
    reference,
    biz.ownerEmail || "bmusasa99@gmail.com"
  );

  payment.currency = plan.currency;
  payment.add(`${plan.name} Package`, plan.price);

  // ✅ Start EcoCash payment with the user's chosen number
  const response = await paynow.sendMobile(payment, ecocashPhone, "ecocash");

  console.log("PAYNOW RESPONSE:", response);

  if (!response.success) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ Failed to start EcoCash payment. Try again.");
    return sendMainMenu(from);
  }

  // Save tracking (so even if user pays from another number, we still upgrade THIS biz)
  biz.sessionData.paynow = {
    reference,
    pollUrl: response.pollUrl
  };
  await saveBizSafe(biz);

  // Poll (your existing logic, unchanged except it’s now after number capture)
  const pollUrl = response.pollUrl;
  let attempts = 0;
  const MAX_ATTEMPTS = 15;

  const pollInterval = setInterval(async () => {
    attempts++;
    try {
      const status = await paynow.pollTransaction(pollUrl);
      console.log("PAYNOW POLL STATUS:", status);

      if (status.status && status.status.toLowerCase() === "paid") {
        clearInterval(pollInterval);

        const freshBiz = await Business.findById(biz._id);

        if (
          freshBiz &&
          freshBiz.sessionState === "subscription_payment_pending" &&
          freshBiz.sessionData?.targetPackage
        ) {
          freshBiz.package = freshBiz.sessionData.targetPackage;
          freshBiz.subscriptionStatus = "active";
          freshBiz.sessionState = "ready";
          freshBiz.sessionData = {};
          await freshBiz.save();

          await sendText(
            from,
            `✅ Payment successful!\n\nYour package has been upgraded to *${freshBiz.package.toUpperCase()}* 🎉`
          );

          await sendMainMenu(from);
        }
      }

      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(pollInterval);
        console.warn("⏰ Paynow polling timed out");
      }
    } catch (err) {
      console.error("Paynow polling failed:", err);
    }
  }, 10000);

  // User instruction message
  await sendText(
    from,
    `💳 ${plan.name} Package (${plan.price} ${plan.currency})\nEcoCash number: ${ecocashPhone}\n\nPlease confirm the payment on your phone.`
  );

  return;
}


// ✅ Only pass text to Twilio AFTER onboarding
// 🚨 DO NOT forward menu / hi / start to Twilio
const escapeWords = ["menu", "hi", "hello", "start"];

if (
  !isMetaAction &&
  biz &&
  biz.sessionState &&
  !escapeWords.includes(al)
) {
  const handled = await continueTwilioFlow({
    from,
    text
  });
  if (handled) return;
}


if (escapeWords.includes(al)) {
  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);
  return sendMainMenu(from);
}





// =========================
// 💱 ONBOARDING: CURRENCY
// =========================
if (biz && biz.sessionState === "awaiting_currency" && a.startsWith("onb_currency_")) {
  const currency = a.replace("onb_currency_", "").toUpperCase();

  if (!["USD", "ZWL", "ZAR"].includes(currency)) {
    await sendText(from, "❌ Invalid currency selection.");
    return;
  }

  biz.currency = currency;
  biz.sessionState = "awaiting_logo";
  await saveBizSafe(biz);

await sendButtons(from, {
  text: "🖼 Would you like to add your business logo now?",
  buttons: [
    { id: "onb_logo_yes", title: "📷 Upload Logo" },
    { id: "onb_logo_skip", title: "Skip for now" }
  ]
});



  return;
}



// =========================
// 🖼 ONBOARDING: LOGO CHOICE
// =========================
if (biz && biz.sessionState === "awaiting_logo") {
  // User wants to upload logo
  if (a === "onb_logo_yes") {
    biz.sessionState = "awaiting_logo_upload";
    await saveBizSafe(biz);

    await sendText(
      from,
      "📷 Please send your logo image (PNG or JPG).\nYou can also type *skip* to continue without a logo."
    );
    return;
  }

  // User skips logo
  if (a === "onb_logo_skip") {
    biz.sessionState = "ready";
    await saveBizSafe(biz);

    await sendText(
      from,
      "✅ Setup complete!\n\nYour business is ready to use 🚀"
    );

    return sendMainMenu(from);
  }
}

// =========================
// 🖼 ONBOARDING: LOGO UPLOAD (META IMAGE OR SKIP)
// =========================
if (biz && biz.sessionState === "awaiting_logo_upload") {
  // User types skip
  if (text && text.toLowerCase() === "skip") {
    biz.sessionState = "ready";
    await saveBizSafe(biz);

    await sendText(from, "✅ Setup complete! Logo skipped.");
    return sendMainMenu(from);
  }

  /**
   * IMPORTANT:
   * At this point, the actual image handling
   * happens in meta_webhook.js
   *
   * That file should already:
   *  - download the image
   *  - save biz.logoUrl
   */

  if (biz.logoUrl) {
    biz.sessionState = "ready";
    await saveBizSafe(biz);

    await sendText(from, "✅ Logo uploaded successfully!");
    return sendMainMenu(from);
  }

  // If neither skip nor image yet, wait silently
  return;
}



if (a.startsWith("invite_branch_")) {
  const branchId = a.replace("invite_branch_", "");

  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "invite_user_phone";
  biz.sessionData.branchId = branchId;
  await saveBizSafe(biz);

  return sendText(from, "Enter WhatsApp number of the user to invite:");
}


// ===============================
// ASSIGN USER → PICK USER (META)
// ===============================
if (a.startsWith("assign_user_")) {
  const userId = a.replace("assign_user_", "");

  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const Branch = (await import("../models/branch.js")).default;
  const branches = await Branch.find({ businessId: biz._id }).lean();

  if (!branches.length) {
    await sendText(from, "No branches found.");
    return sendMainMenu(from);
  }

  biz.sessionData.userId = userId;
  biz.sessionState = "assign_branch_pick_branch";
  await saveBizSafe(biz);

  return sendList(
    from,
    "Select branch",
    branches.map(b => ({
      id: `assign_branch_${b._id}`,
      title: b.name
    }))
  );
}


// ===============================
// FINAL STEP: SAVE USER → BRANCH
// ===============================

// ===============================
// FINAL STEP: SAVE USER → BRANCH
// ===============================
if (a.startsWith("assign_branch_")) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // ensure we are in the correct state
  if (biz.sessionState !== "assign_branch_pick_branch") return;

  const branchId = a.replace("assign_branch_", "");

  const userId = biz.sessionData.userId;
  if (!userId) {
    await sendText(from, "⚠️ No user selected.");
    return sendMainMenu(from);
  }

  const UserRole = (await import("../models/userRole.js")).default;
  await UserRole.findByIdAndUpdate(userId, { branchId });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, "✅ User successfully assigned to branch.");
  return sendMainMenu(from);
}

/* =========================
   SETTINGS (META) — STEP 4
   MUST BE BEFORE SWITCH
========================= */

if (a === ACTIONS.SETTINGS_INV_PREFIX) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "settings_inv_prefix";
  await saveBizSafe(biz);

  return sendText(
    from,
    `Current invoice prefix: ${biz.invoicePrefix || "INV"}\n\nReply with new prefix:`
  );
}

if (a === ACTIONS.SETTINGS_QT_PREFIX) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "settings_qt_prefix";
  await saveBizSafe(biz);

  return sendText(
    from,
    `Current quote prefix: ${biz.quotePrefix || "QT"}\n\nReply with new prefix:`
  );
}

if (a === ACTIONS.SETTINGS_RCPT_PREFIX) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "settings_rcpt_prefix";
  await saveBizSafe(biz);

  return sendText(
    from,
    `Current receipt prefix: ${biz.receiptPrefix || "RCPT"}\n\nReply with new prefix:`
  );
}

if (a === ACTIONS.SETTINGS_CURRENCY) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "settings_currency";
  await saveBizSafe(biz);

  return sendText(
    from,
    `Current currency: ${biz.currency}\n\nReply with new currency (USD, ZWL, ZAR):`
  );
}


if (a === ACTIONS.SETTINGS_TERMS) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "settings_terms";
  await saveBizSafe(biz);

  return sendText(
    from,
    `Current payment terms: ${biz.paymentTermsDays || 0} days\n\nReply with number of days:`
  );
}


if (a === ACTIONS.SETTINGS_LOGO) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "awaiting_logo_upload";
  await saveBizSafe(biz);

  return sendText(
    from,
    "📷 Please send your business logo image (PNG or JPG).\nReply 0 to cancel."
  );
}


if (a === ACTIONS.SETTINGS_CLIENTS) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const Client = (await import("../models/client.js")).default;
  const clients = await Client.find({ businessId: biz._id }).lean();

  if (!clients.length) {
    return sendText(from, "No clients found.");
  }

  let msg = "👥 Clients:\n";
  clients.forEach((c, i) => {
    msg += `${i + 1}) ${c.name || c.phone}\n`;
  });

  await sendText(from, msg);
  return sendSettingsMenu(from);
}


if (a === ACTIONS.SETTINGS_BRANCHES) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  return sendBranchesMenu(from);
}


// ===============================
// 📄 CLIENT STATEMENT → PICKED
// ===============================
if (a.startsWith("stmt_client_")) {
  const clientId = a.replace("stmt_client_", "");

  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "client_statement_generate";
  biz.sessionData = { clientId };
  await saveBizSafe(biz);

  return continueTwilioFlow({ from, text: "generate" });
}

if (a.startsWith("prod_")) {
  const productId = a.replace("prod_", "");
  const biz = await getBizForPhone(from);

  const Product = (await import("../models/product.js")).default;
  const product = await Product.findById(productId);

  if (!product) {
    return sendText(from, "❌ Item not found.");
  }

  // Inject exactly how your invoice expects it
biz.sessionData.lastItem = {
  description: product.name,
  unit: product.unitPrice,
  source: "catalogue" // 🔥 THIS IS THE FIX
};


  biz.sessionData.expectingQty = true;
  biz.sessionState = "creating_invoice_add_items";

  await saveBizSafe(biz);

  return sendText(from, `Enter quantity for *${product.name}*:`);
}

// ===============================
// PACKAGE SELECTION
// ===============================
// ===============================
// PACKAGE SELECTION → PAYNOW
// ===============================
if (biz?.sessionState === "choose_package" && a.startsWith("pkg_")) {
  const selected = a.replace("pkg_", "");

  if (!["bronze", "silver", "gold"].includes(selected)) {
    return sendText(from, "❌ Invalid package selected.");
  }

  const plan = SUBSCRIPTION_PLANS[selected];
  if (!plan) {
    return sendText(from, "❌ Invalid package selected.");
  }

  // Save intent first
  biz.sessionState = "subscription_enter_ecocash";
  biz.sessionData = {
    targetPackage: selected,
    amount: plan.price
  };
  await saveBizSafe(biz);

  // Ask user for EcoCash number (EcoCash only notice included)
   const pkg = PACKAGES[selected];

  const MAP = {
    invoice: "Invoices",
    quote: "Quotations",
    receipt: "Receipts",
    clients: "Clients",
    payments: "Payments",
    reports_daily: "Daily reports",
    reports_weekly: "Weekly reports",
    reports_monthly: "Monthly reports",
    branches: "Branches management",
    users: "User management"
  };

  const featureLines = (pkg?.features || []).map(f => `• ${MAP[f] || f}`);

  return sendText(
    from,
`✅ Selected: *${plan.name}* (${plan.price} ${plan.currency})

📦 Package limits:
• Users: ${pkg?.users}
• Branches: ${pkg?.branches}
• Docs per month: ${pkg?.monthlyDocs}

✨ Features:
${featureLines.join("\n")}

💳 *Payment method: EcoCash only*

Please enter the EcoCash number you want to pay with:
Example: 0772123456

Or type *same* to use this WhatsApp number.`
  );

}



// ===============================
// 📄 SALES DOC → PICK DOCUMENT
// ===============================
if (
  a.startsWith("doc_") &&
  a !== ACTIONS.VIEW_DOC &&
  a !== ACTIONS.DELETE_DOC
) {


  const docId = a.replace("doc_", "");
  const biz = await getBizForPhone(from);

  const doc = await Invoice.findById(docId);
  if (!doc) {
    await sendText(from, "Document not found.");
    return sendSalesMenu(from);
  }

  biz.sessionState = "sales_doc_action";
  biz.sessionData = { docId };
  await saveBizSafe(biz);

  return sendButtons(from, {
    text: `📄 ${doc.number}\nStatus: ${doc.status}`,
    buttons: [
  { id: ACTIONS.VIEW_DOC, title: "📄 View PDF" },
  { id: ACTIONS.DELETE_DOC, title: "🗑 Delete" },
  { id: ACTIONS.BACK, title: "⬅ Back" }
]
  });
}






// ===============================
// 📄 SALES DOC → VIEW PDF (META)
// ===============================
// ===============================
// 📄 SALES DOC → VIEW (RE-GENERATE PDF)
// ===============================
if (a === ACTIONS.VIEW_DOC) {
  const biz = await getBizForPhone(from);
  if (!biz?.sessionData?.docId) {
    await sendText(from, "❌ No document selected.");
    return sendSalesMenu(from);
  }

  const doc = await Invoice.findById(biz.sessionData.docId).lean();
  if (!doc) {
    await sendText(from, "❌ Document not found.");
    return sendSalesMenu(from);
  }

  // 🔎 Load client
  const Client = (await import("../models/client.js")).default;
  const client = await Client.findById(doc.clientId).lean();

  if (!client) {
    await sendText(from, "❌ Client not found.");
    return sendSalesMenu(from);
  }

  // 🔄 RE-GENERATE PDF (same as creation)
  const { filename } = await generatePDF({
    type: doc.type,
    number: doc.number,
    date: doc.createdAt || new Date(),
    billingTo: client.name || client.phone,
    items: doc.items,
    bizMeta: {
      name: biz.name,
      logoUrl: biz.logoUrl,
      address: biz.address || "",
      discountPercent: doc.discountPercent || 0,
      vatPercent: doc.vatPercent || 0,
      applyVat: doc.type === "receipt" ? false : true,
      _id: biz._id.toString(),
      status: doc.status
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const folder =
    doc.type === "invoice"
      ? "invoices"
      : doc.type === "quote"
      ? "quotes"
      : "receipts";

  const url = `${site}/docs/generated/${folder}/${filename}`;

  // 📤 Send immediately
  await sendDocument(from, { link: url, filename });

  // ✅ Reset session
  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return; // ⛔ IMPORTANT: stop here
}




// ===============================
// 🗑 SALES DOC → DELETE (META)
// ===============================
if (a === ACTIONS.DELETE_DOC) {
  const biz = await getBizForPhone(from);
  if (!biz?.sessionData?.docId) {
    await sendText(from, "❌ No document selected.");
    return sendSalesMenu(from);
  }

  const doc = await Invoice.findById(biz.sessionData.docId);
  if (!doc) {
    await sendText(from, "❌ Document not found.");
    return sendSalesMenu(from);
  }

  if (doc.status === "paid") {
    await sendText(from, "❌ Paid documents cannot be deleted.");
    return sendSalesMenu(from);
  }

  await Invoice.deleteOne({ _id: doc._id });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, "🗑 Document deleted successfully.");
  return sendSalesMenu(from);
}


  /* =========================
     MENUS
  ========================= */

  switch (a) {
    case ACTIONS.SALES_MENU:
      return sendSalesMenu(from);

    case ACTIONS.CLIENTS_MENU:
      return sendClientsMenu(from);

 case ACTIONS.PAYMENTS_MENU:
  return sendPaymentsMenu(from);

case ACTIONS.REPORTS_MENU: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  /*if (!canUseFeature(biz, "reports_daily")) {
    const needed = requiredPackageForFeature("reports_daily");
    return sendText(
      from,
      `🔒 Reports are not available on your current package.\n\nUpgrade to *${needed.toUpperCase()}* to unlock reports.`
    );
  }*/

    if (!canUseFeature(biz, "reports_daily")) {
  return promptUpgrade({
    biz,
    from,
    feature: "Reports"
  });
}


  biz.sessionState = "reports_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  const isGold = biz.package === "gold";
  return sendReportsMenu(from, isGold);
}


case ACTIONS.BUSINESS_PROFILE: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // 1️⃣ Send profile info
  await sendText(
    from,
`🏢 Business Profile

Name: ${biz.name}
Currency: ${biz.currency}
Package: ${biz.package}`
  );

  // 2️⃣ Automatically show main menu
  return sendMainMenu(from);
}



case ACTIONS.USERS_MENU:
  return sendUsersMenu(from);




case ACTIONS.INVITE_USER: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // ============================
  // 🔒 ROLE CHECK (MINIMAL)
  // ============================
  const UserRole = (await import("../models/userRole.js")).default;
  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  if (!caller || caller.role !== "owner") {
    return sendText(
      from,
      "🔒 Only the business owner can invite users."
    );
  }

  // ============================
  // 📦 PACKAGE FEATURE CHECK
  // ============================
  const { PACKAGES } = await import("./packages.js");

  const pkg = PACKAGES[biz.package] || PACKAGES.trial;

  /*if (!pkg.features.includes("users")) {
    return sendText(
      from,
      "🔒 User management is not available on your current package.\n\nUpgrade your package to invite users."
    );
  }*/

    if (!pkg.features.includes("users")) {
  return promptUpgrade({
    biz,
    from,
    feature: "User management"
  });
}


  // ============================
  // 👥 USER LIMIT CHECK
  // ============================
  const activeUsers = await UserRole.countDocuments({
    businessId: biz._id,
    pending: false
  });

  if (activeUsers >= pkg.users) {
    return sendText(
      from,
      `🚫 User limit reached (${pkg.users}).\n\nUpgrade your package to add more users.`
    );
  }

  // ============================
  // ✅ EXISTING LOGIC (UNCHANGED)
  // ============================

  // move into invite flow
  biz.sessionState = "invite_user_choose_branch";
  biz.sessionData = {};
  await saveBizSafe(biz);

  const Branch = (await import("../models/branch.js")).default;
  const branches = await Branch.find({ businessId: biz._id }).lean();

  if (!branches.length) {
    await sendText(from, "No branches found. Please add a branch first.");
    return sendBranchesMenu(from);
  }

  return sendList(
    from,
    "Select branch for new user",
    branches.map(b => ({
      id: `invite_branch_${b._id}`,
      title: b.name
    }))
  );
}



case ACTIONS.BRANCHES_MENU: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const UserRole = (await import("../models/userRole.js")).default;
  const { canAccessSection } = await import("./roleGuard.js");

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  if (!caller || !canAccessSection(caller.role, "branches")) {
    return sendText(
      from,
      "🔒 You do not have permission to access branches."
    );
  }

  return sendBranchesMenu(from);
}


case ACTIONS.ADD_BRANCH: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

 /* if (!canUseFeature(biz, "branches")) {
    return sendText(
      from,
      "🔒 Branches are not available on your current package.\nUpgrade to *GOLD* to unlock branches."
    );
  }*/
 if (!canUseFeature(biz, "branches")) {
  return promptUpgrade({
    biz,
    from,
    feature: "Branches"
  });
}


  const Branch = (await import("../models/branch.js")).default;
  const count = await Branch.countDocuments({ businessId: biz._id });

  const { branches } = (await import("./packages.js")).PACKAGES[biz.package];
  if (count >= branches) {
    return sendText(
      from,
      `🚫 Branch limit reached (${branches}).\nUpgrade your package to add more branches.`
    );
  }

  biz.sessionState = "branch_add_name";
  await saveBizSafe(biz);
  return sendText(from, "Enter new branch name:");
}


case ACTIONS.VIEW_BRANCHES: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const Branch = (await import("../models/branch.js")).default;
  const branches = await Branch.find({ businessId: biz._id }).lean();

  if (!branches.length) {
    await sendText(from, "No branches found.");
    return sendMainMenu(from);
  }

  let msg = "🏬 Branches:\n";
  branches.forEach((b, i) => {
    msg += `${i + 1}) ${b.name}\n`;
  });

  await sendText(from, msg);
  return sendMainMenu(from);
}


case ACTIONS.ASSIGN_BRANCH_USERS: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const UserRole = (await import("../models/userRole.js")).default;
  const users = await UserRole.find({
    businessId: biz._id,
    pending: false
  }).lean();

  if (!users.length) {
    await sendText(from, "No active users found.");
    return sendMainMenu(from);
  }

  biz.sessionState = "assign_branch_pick_user";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendList(
    from,
    "Select user",
    users.map(u => ({
      id: `assign_user_${u._id}`,
      title: u.phone
    }))
  );
}



case ACTIONS.VIEW_INVITES: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const pending = await (
    await import("../models/userRole.js")
  ).default.find({
    businessId: biz._id,
    pending: true
  }).populate("branchId");

  if (!pending.length) {
    return sendText(from, "✅ No pending invitations.");
  }

  let msg = "⏳ Pending Invites:\n";
  pending.forEach((u, i) => {
    msg += `${i + 1}) ${u.phone} | ${u.role} | ${u.branchId?.name || "N/A"}\n`;
  });

  return sendText(from, msg);
}

case ACTIONS.VIEW_USERS: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const users = await (
    await import("../models/userRole.js")
  ).default.find({
    businessId: biz._id,
    pending: false
  }).populate("branchId");

  if (!users.length) {
    return sendText(from, "No active users found.");
  }

  let msg = "👥 Active Users:\n";
  users.forEach((u, i) => {
    msg += `${i + 1}) ${u.phone} | ${u.role} | ${u.branchId?.name || "N/A"}\n`;
  });

  return sendText(from, msg);
}







case ACTIONS.PAYMENT_IN:
  await showUnpaidInvoices(from);
  return;




case ACTIONS.PAYMENT_OUT: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendList(
    from,
    "📂 Select Expense Category",
    [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]
  );
}


   case ACTIONS.BUSINESS_MENU: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const UserRole = (await import("../models/userRole.js")).default;
  const { canAccessSection } = await import("./roleGuard.js");

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  if (!caller || !canAccessSection(caller.role, "users")) {
    return sendText(
      from,
      "🔒 You do not have permission to access Business & Users."
    );
  }

  return sendBusinessMenu(from);
}

case ACTIONS.SETTINGS_MENU: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const UserRole = (await import("../models/userRole.js")).default;
  const { canAccessSection } = await import("./roleGuard.js");

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  if (!caller || !canAccessSection(caller.role, "settings")) {
    return sendText(
      from,
      "🔒 You do not have permission to access Settings."
    );
  }

  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendSettingsMenu(from);
}


case ACTIONS.UPGRADE_PACKAGE: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // 🔒 Only owner can upgrade
  const UserRole = (await import("../models/userRole.js")).default;
  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  if (!caller || caller.role !== "owner") {
    return sendText(from, "🔒 Only the business owner can change the package.");
  }

  biz.sessionState = "choose_package";
  await saveBizSafe(biz);

  return sendPackagesMenu(from, biz.package);
}


    
    case ACTIONS.BACK:
      return sendMainMenu(from);

   case ACTIONS.NEW_INVOICE: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  // 🔒 Trial limit check happens later
  return startInvoiceFlow(from);
}

case ACTIONS.NEW_QUOTE: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  if (biz.package === "trial") {
    return promptUpgrade({
      biz,
      from,
      feature: "Quotes"
    });
  }

  return startQuoteFlow(from);
}

case ACTIONS.NEW_RECEIPT: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  if (biz.package === "trial") {
    return promptUpgrade({
      biz,
      from,
      feature: "Receipts"
    });
  }

  return startReceiptFlow(from);
}



case ACTIONS.VIEW_INVOICES:
  return showSalesDocs(from, "invoice");

case ACTIONS.VIEW_QUOTES:
  return showSalesDocs(from, "quote");

case ACTIONS.VIEW_RECEIPTS:
  return showSalesDocs(from, "receipt");



    case ACTIONS.ADD_CLIENT:
      return startClientFlow(from);

      case ACTIONS.PRODUCTS_MENU:
  return sendProductsMenu(from);

case ACTIONS.ADD_PRODUCT: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  biz.sessionState = "product_add_name";
  biz.sessionData = {};
  await saveBizSafe(biz);

  return sendText(from, "📦 Enter product name:");
}

case ACTIONS.VIEW_PRODUCTS: {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const products = await Product.find({
    businessId: biz._id,
    isActive: true
  }).lean();

  if (!products.length) {
    await sendText(from, "📦 No products found.");
    return sendMainMenu(from);
  }

  let msg = "📦 Products:\n\n";

  products.forEach((p, i) => {
    msg += `${i + 1}) ${p.name} — ${p.unitPrice} ${biz.currency}\n`;
  });

  await sendText(from, msg);
  return sendMainMenu(from);
}

/*default: {
  const biz = await getBizForPhone(from);

  // 🔒 DO NOT INTERRUPT ACTIVE FLOWS
  if (biz?.sessionState && biz.sessionState !== "ready") {
    // Let Twilio or Meta state handlers continue
    return;
  }

  // ✅ Only show menu when idle
  return sendMainMenu(from);
}*/

default: {
  const biz = await getBizForPhone(from);

  // 🔒 DO NOT INTERRUPT ACTIVE FLOWS
  if (biz?.sessionState && biz.sessionState !== "ready") {
    return;
  }

  return sendMainMenu(from);
}



 

  }
}

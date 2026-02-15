import { ACTIONS } from "./actions.js";
import { sendList, sendText, sendButtons } from "./metaSender.js";

import { SUBSCRIPTION_PLANS } from "./subscriptionPlans.js";
import { PACKAGES } from "./packages.js";

import { canAccessSection } from "./roleGuard.js";
import UserRole from "../models/userRole.js";
 import { normalizePhone } from "./phone.js";


 async function filterMenuByRole({ from, biz, items }) {
  // ✅ Normalize phone safely
  let phone = normalizePhone(from);

  if (phone.startsWith("0")) {
    phone = "263" + phone.slice(1);
  }

  // 🛑 NO BUSINESS YET (onboarding / new user)
  if (!biz) {
    // show safe default (clerk-level)
    return items.filter(item =>
      !item.section || canAccessSection("clerk", item.section)
    );
  }

  const user = await UserRole.findOne({
    businessId: biz._id,
    phone,
    pending: false
  });

  // 👑 Owner sees everything
  if (user?.role === "owner") {
    return items;
  }

  // 🧾 User not found → fallback to clerk
  if (!user) {
    return items.filter(item =>
      !item.section || canAccessSection("clerk", item.section)
    );
  }

  // 🎯 Role-based filtering
  return items.filter(item => {
    if (!item.section) return true;
    return canAccessSection(user.role, item.section);
  });
}






/* =========================
   MAIN
========================= */
export async function sendMainMenu(to) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);

  const items = [
    { id: ACTIONS.SALES_MENU, title: "🧾 Sales", section: "sales" },
    { id: ACTIONS.CLIENTS_MENU, title: "👥 Clients", section: "clients" },
      { id: ACTIONS.PRODUCTS_MENU, title: "📦 Products" },
    { id: ACTIONS.PAYMENTS_MENU, title: "💰 Payments", section: "payments" },
    { id: ACTIONS.REPORTS_MENU, title: "📈 Reports", section: "reports" },
    { id: ACTIONS.BUSINESS_MENU, title: "🏢 Business & Users", section: "users" },
    { id: ACTIONS.SETTINGS_MENU, title: "⚙ Settings", section: "settings" },
      { id: ACTIONS.SUBSCRIPTION_MENU, title: "💳 Subscription" }, // ✅ NEW
    { id: ACTIONS.UPGRADE_PACKAGE, title: "⭐ Upgrade Package" } // owner-only check happens elsewhere
  ];

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "📊 Main Menu", filtered);
}


/* =========================
   SALES (FIXED ✅)
========================= */
export async function sendSalesMenu(to) {
    console.log("🔥 SALES MENU v2 LOADED");
  return sendList(to, "🧾 Sales", [
    { id: ACTIONS.NEW_INVOICE, title: "New Invoice" },
    { id: ACTIONS.NEW_QUOTE, title: "New Quotation" },
    { id: ACTIONS.NEW_RECEIPT, title: "New Receipt" },

    { id: ACTIONS.VIEW_INVOICES, title: "📄 View Invoices" },
    { id: ACTIONS.VIEW_QUOTES, title: "📄 View Quotations" },
    { id: ACTIONS.VIEW_RECEIPTS, title: "📄 View Receipts" },
    //{ id: ACTIONS.PRODUCTS_MENU, title: "📦 Products" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =========================
   CLIENTS
========================= */
export async function sendClientsMenu(to) {
  return sendList(to, "👥 Clients", [
    { id: ACTIONS.ADD_CLIENT, title: "➕ Add Client" },
    { id: ACTIONS.CLIENT_STATEMENT, title: "📄 Client Statement" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =========================
   PAYMENTS
========================= */
export async function sendPaymentsMenu(to) {
  return sendList(to, "💰 Payments", [
    { id: ACTIONS.PAYMENT_IN, title: "Record payment (IN)" },
    { id: ACTIONS.PAYMENT_OUT, title: "Record expense (OUT)" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}




/* =========================
   BUSINESS
========================= 
export async function sendBusinessMenu(to) {
  return sendList(to, "🏢 Business & Users", [
    { id: ACTIONS.BUSINESS_PROFILE, title: "Business Profile" },
    { id: ACTIONS.USERS, title: "Users" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}*/


export async function sendBusinessMenu(to) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);

  const items = [
    { id: ACTIONS.BUSINESS_PROFILE, title: "🏢 Business Profile", section: "users" },
    { id: ACTIONS.USERS_MENU, title: "👥 Users", section: "users" },
    { id: ACTIONS.BRANCHES_MENU, title: "🏬 Branches", section: "branches" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ];

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "🏢 Business & Users", filtered);
}



/* =========================
   SETTINGS
========================= */
export async function sendSettingsMenu(from) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(from);

  const items = [
    { id: ACTIONS.SETTINGS_CURRENCY, title: "💱 Currency", section: "settings" },
    { id: ACTIONS.SETTINGS_TERMS, title: "📅 Payment terms", section: "settings" },
    { id: ACTIONS.SETTINGS_INV_PREFIX, title: "🧾 Invoice prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_QT_PREFIX, title: "📄 Quote prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_RCPT_PREFIX, title: "🧾 Receipt prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_LOGO, title: "🖼️ Business logo", section: "settings" },
    { id: ACTIONS.SETTINGS_CLIENTS, title: "👥 View clients", section: "settings" },
    { id: ACTIONS.SETTINGS_BRANCHES, title: "🏬 Branches", section: "branches" }
  ];

  const filtered = await filterMenuByRole({ from, biz, items });
  return sendList(from, "⚙️ Settings", filtered);
}


export async function sendInvoiceConfirmMenu(to, summaryText) {
  return sendList(to, summaryText, [
    { id: "inv_add_item", title: "➕ Add another item" },
    { id: "inv_generate_pdf", title: "📄 Generate PDF" },
    { id: "inv_set_discount", title: "💸 Set discount %" },
    { id: "inv_set_vat", title: "🧾 Set VAT %" },
    { id: "inv_cancel", title: "❌ Cancel" }
  ]);
}



export async function sendReportsMenu(to, isGold = false) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);

  const items = [
    { id: ACTIONS.DAILY_REPORT, title: "📅 Daily Report", section: "reports" }
  ];

  if (isGold) {
    items.push(
      { id: ACTIONS.WEEKLY_REPORT, title: "📊 Weekly Report", section: "reports" },
      { id: ACTIONS.MONTHLY_REPORT, title: "📆 Monthly Report", section: "reports" },
      { id: ACTIONS.BRANCH_REPORT, title: "🏢 Branch Report", section: "reports" }
    );
  }

  items.push({ id: ACTIONS.BACK, title: "⬅ Back" });

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "📈 Reports", filtered);
}



export async function sendUsersMenu(to) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);

  const items = [
    { id: ACTIONS.INVITE_USER, title: "➕ Invite User", section: "users" },
    { id: ACTIONS.VIEW_INVITES, title: "📨 Pending Invites", section: "users" },
    { id: ACTIONS.VIEW_USERS, title: "👤 Active Users", section: "users" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ];

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "👥 Users", filtered);
}



export async function sendBranchesMenu(to) {
  return sendList(to, "🏬 Branches", [
    { id: ACTIONS.ADD_BRANCH, title: "➕ Add Branch" },
    { id: ACTIONS.VIEW_BRANCHES, title: "📋 View Branches" },
    { id: ACTIONS.ASSIGN_BRANCH_USERS, title: "👥 Assign Users" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}



export async function sendInviteUserMenu(to) {
  return sendList(to, "👤 Invite User", [
    { id: ACTIONS.BRANCH_VIEW, title: "📂 View branches" },
    { id: ACTIONS.BRANCH_ADD, title: "➕ Add branch" },
    { id: ACTIONS.BRANCH_ASSIGN_USER, title: "👥 Assign user to branch" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}


export async function sendPackagesMenu(to, currentPackage) {
  // Friendly labels for features (keep short: WhatsApp list descriptions are limited)
 const FEATURE_LABELS = {
  invoice: "Inv",
  quote: "Quote",
  receipt: "Rcpt",
  clients: "Clients",
  payments: "Pay",
  reports_daily: "Rpt(D)",
  reports_weekly: "Rpt(W)",
  reports_monthly: "Rpt(M)",
  branches: "Branches",
  users: "Users"
};


  function money(plan) {
    if (!plan) return "";
    const cur = (plan.currency || "").toUpperCase();
    const amt = plan.price ?? "";
    if (!cur || amt === "") return "";
    // display like "28 USD/mo" (simple + consistent)
    return `${amt} ${cur}/mo`;
  }

  function packageDesc(pkgKey) {
    const pkg = PACKAGES[pkgKey];
    if (!pkg) return "";

  const base = `U:${pkg.users} B:${pkg.branches} D:${pkg.monthlyDocs}/mo`;

const feats = (pkg.features || [])
  .map(f => FEATURE_LABELS[f] || f)
  .slice(0, 5) // show 5 short features
  .join(", ");

return feats ? `${base} | ${feats}` : base;

  }

  // Use your plans if available (fallback to blank if not)
  const bronzePlan = SUBSCRIPTION_PLANS?.bronze;
  const silverPlan = SUBSCRIPTION_PLANS?.silver;
  const goldPlan = SUBSCRIPTION_PLANS?.gold;

  const header =
`📦 Your current package: *${currentPackage.toUpperCase()}*

✅ *Payment method: EcoCash only*
Please select a package below. You’ll be asked to enter the EcoCash number to pay with.`;

  return sendList(to, header, [
    {
      id: "pkg_bronze",
      title: `🥉 Bronze - ${money(bronzePlan)}`,
      description: packageDesc("bronze")
    },
    {
      id: "pkg_silver",
      title: `🥈 Silver - ${money(silverPlan)}`,
      description: packageDesc("silver")
    },
    {
      id: "pkg_gold",
      title: `🥇 Gold - ${money(goldPlan)}`,
      description: packageDesc("gold")
    },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}


export async function sendProductsMenu(from) {
  return sendButtons(from, {
    text: "📦 Products Catalogue",
    buttons: [
      { id: ACTIONS.ADD_PRODUCT, title: "➕ Add product" },
      { id: ACTIONS.VIEW_PRODUCTS, title: "📋 View products" },
      { id: ACTIONS.BACK, title: "⬅ Back" }
    ]
  });
}


export async function sendSubscriptionMenu(to) {
  return sendList(to, "💳 Subscription", [
    { id: ACTIONS.BUSINESS_PROFILE, title: "📌 My plan & due date" },
    { id: ACTIONS.SUBSCRIPTION_PAYMENTS, title: "🧾 Payment history" },
    { id: ACTIONS.UPGRADE_PACKAGE, title: "⭐ Upgrade package" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

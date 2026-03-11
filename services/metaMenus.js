import { ACTIONS } from "./actions.js";
import { sendList, sendText, sendButtons } from "./metaSender.js";
import { SUBSCRIPTION_PLANS } from "./subscriptionPlans.js";
import { PACKAGES } from "./packages.js";
import { canAccessSection } from "./roleGuard.js";
import UserRole from "../models/userRole.js";
import { normalizePhone } from "./phone.js";

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

// ─── Role-based menu filter ───────────────────────────────────────────────────

async function filterMenuByRole({ from, biz, items }) {
  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);

  // No business yet (onboarding): show clerk-level defaults
  if (!biz) {
    return items.filter(item => !item.section || canAccessSection("clerk", item.section));
  }

  const user = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

  if (user?.role === "owner") return items;
  if (!user) return items.filter(item => !item.section || canAccessSection("clerk", item.section));

  return items.filter(item => {
    if (!item.section) return true;
    return canAccessSection(user.role, item.section);
  });
}

// ─── Branch picker helper ─────────────────────────────────────────────────────
// Used by many menus to let the owner pick a branch before a flow

export async function sendBranchPickerMenu(to, {
  title,
  actionPrefix,
  includeAll = false,
  allLabel = "🌍 All Branches"
}) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;

  const biz = await getBizForPhone(to);
  if (!biz) {
    const { sendMainMenu } = await import("./metaMenus.js");
    return sendMainMenu(to);
  }

 const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

// no more "Add a branch first" hard-fail

  const items = branches.map(b => ({
    id: `${actionPrefix}${b._id}`,
    title: `🏬 ${b.name}`
  }));

  if (includeAll) {
    items.unshift({ id: `${actionPrefix}all`, title: allLabel });
  }

  items.push({ id: ACTIONS.BACK, title: "⬅ Back" });

  return sendList(to, title, items);
}

/* =============================================================================
   MAIN MENU
============================================================================= */
export async function sendMainMenu(to) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);

  // ── Ghost business (pending_supplier_) = treat as no-biz user ────────────
  if (biz && biz.name.startsWith("pending_supplier_")) {
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const phone = to.replace(/\D+/g, "");
    const supplier = await SupplierProfile.findOne({ phone });
    if (supplier?.active) {
      return sendButtons(to, {
        text: "👋 *Welcome to ZimQuote!*\n\nWhat would you like to do?",
        buttons: [
          { id: "find_supplier", title: "🔍 Find Suppliers" },
          { id: "my_supplier_account", title: "🏪 My Account" },
          { id: "onboard_business", title: "🧾 Run My Business" }
        ]
      });
    }
    return sendButtons(to, {
      text: "👋 *Welcome to ZimQuote!*\n\nZimbabwe's business platform.\n\nWhat would you like to do?",
      buttons: [
        { id: "onboard_business", title: "🧾 Run My Business" },
        { id: "find_supplier", title: "🔍 Find Suppliers" },
        { id: "register_supplier", title: "📦 List My Business" }
      ]
    });
  }

  // ── No business: never show business owner menu ───────────────────────────
  if (!biz) {
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const phone = to.replace(/\D+/g, "");
    const supplier = await SupplierProfile.findOne({ phone });

    if (supplier?.active) {
      return sendButtons(to, {
        text: "👋 *Welcome to ZimQuote!*\n\nWhat would you like to do?",
        buttons: [
          { id: "find_supplier", title: "🔍 Find Suppliers" },
          { id: "my_supplier_account", title: "🏪 My Account" },
          { id: "onboard_business", title: "🧾 Run My Business" }
        ]
      });
    }

    return sendButtons(to, {
      text: "👋 *Welcome to ZimQuote!*\n\nZimbabwe's business platform.\n\nWhat would you like to do?",
      buttons: [
        { id: "onboard_business", title: "🧾 Run My Business" },
        { id: "find_supplier", title: "🔍 Find Suppliers" },
        { id: "register_supplier", title: "📦 List My Business" }
      ]
    });
  }

  const items = [
    { id: ACTIONS.SALES_MENU, title: "🧾 Sales", section: "sales" },
    { id: ACTIONS.CLIENTS_MENU, title: "👥 Clients", section: "clients" },
    { id: ACTIONS.PRODUCTS_MENU, title: "📦 Products & Services" },
    { id: ACTIONS.PAYMENTS_MENU, title: "💰 Payments", section: "payments" },
    { id: ACTIONS.REPORTS_MENU, title: "📈 Reports", section: "reports" },
    { id: ACTIONS.BUSINESS_MENU, title: "🏢 Business & Users", section: "users" },
    { id: ACTIONS.SETTINGS_MENU, title: "⚙ Settings", section: "settings" },
    { id: ACTIONS.SUBSCRIPTION_MENU, title: "💳 Subscription", section: "owner_only" },
    { id: ACTIONS.UPGRADE_PACKAGE, title: "⭐ Upgrade Package", section: "owner_only" },
    { id: ACTIONS.SUPPLIERS_MENU, title: "🏪 Suppliers" }
  ];

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "📊 Main Menu", filtered);
}
/* =============================================================================
   SALES MENU
============================================================================= */
export async function sendSalesMenu(to) {
  return sendList(to, "🧾 Sales", [
    { id: ACTIONS.NEW_INVOICE, title: "📄 New Invoice" },
    { id: ACTIONS.NEW_QUOTE, title: "📋 New Quotation" },
    { id: ACTIONS.NEW_RECEIPT, title: "🧾 New Receipt" },
    { id: ACTIONS.VIEW_INVOICES, title: "📄 View Invoices" },
    { id: ACTIONS.VIEW_QUOTES, title: "📄 View Quotations" },
    { id: ACTIONS.VIEW_RECEIPTS, title: "📄 View Receipts" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   CLIENTS MENU
============================================================================= */
export async function sendClientsMenu(to) {
  return sendList(to, "👥 Clients", [
    { id: ACTIONS.ADD_CLIENT, title: "➕ Add Client" },
    { id: ACTIONS.VIEW_CLIENTS, title: "📋 View Clients" },
    { id: ACTIONS.CLIENT_STATEMENT, title: "📄 Client Statement" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   PAYMENTS MENU
============================================================================= */
export async function sendPaymentsMenu(to) {
  return sendList(to, "💰 Payments", [
    { id: ACTIONS.PAYMENT_IN, title: "💵 Record payment (IN)" },
    { id: ACTIONS.PAYMENT_OUT, title: "💸 Record expense (OUT)" },
    { id: ACTIONS.BULK_EXPENSE_MODE, title: "📋 Bulk add expenses" },
    { id: ACTIONS.CASH_BALANCE_MENU, title: "💰 Cash Management" },
    { id: ACTIONS.VIEW_EXPENSE_RECEIPTS, title: "🧾 View expense receipts" },
    { id: ACTIONS.VIEW_PAYMENT_HISTORY, title: "📜 View payment history" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   CASH BALANCE MENU
============================================================================= */
export async function sendCashBalanceMenu(to) {
  return sendList(to, "💰 Cash Management", [
    { id: ACTIONS.VIEW_CASH_BALANCE, title: "💵 View cash balance" },
    { id: ACTIONS.SET_OPENING_BALANCE, title: "📝 Set opening balance" },
    { id: ACTIONS.RECORD_PAYOUT, title: "💸 Record payout/drawing" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BUSINESS MENU
============================================================================= */
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

/* =============================================================================
   SETTINGS MENU
============================================================================= */
export async function sendSettingsMenu(from) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(from);

  const items = [
    { id: ACTIONS.SETTINGS_CURRENCY, title: "💱 Currency", section: "settings" },
    { id: ACTIONS.SETTINGS_TERMS, title: "📅 Payment terms", section: "settings" },
    { id: ACTIONS.SETTINGS_INV_PREFIX, title: "🧾 Invoice prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_QT_PREFIX, title: "📄 Quote prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_RCPT_PREFIX, title: "🧾 Receipt prefix", section: "settings" },
    { id: ACTIONS.SETTINGS_LOGO, title: "🖼️ Business logo", section: "settings" },
    { id: ACTIONS.SETTINGS_ADDRESS, title: "📍 Business address", section: "settings" },
    { id: ACTIONS.SETTINGS_CLIENTS, title: "👥 View clients", section: "settings" },
    { id: ACTIONS.SETTINGS_BRANCHES, title: "🏬 Branches", section: "branches" }
  ];

  const filtered = await filterMenuByRole({ from, biz, items });
  return sendList(from, "⚙️ Settings", filtered);
}

/* =============================================================================
   INVOICE CONFIRM MENU
============================================================================= */
export async function sendInvoiceConfirmMenu(to, summaryText) {
  return sendList(to, summaryText, [
    { id: "inv_add_item", title: "➕ Add another item" },
    { id: "inv_generate_pdf", title: "📄Save & Generate PDF" },
    { id: "inv_set_discount", title: "💸 Set discount %" },
    { id: "inv_set_vat", title: "🧾 Set VAT %" },
    { id: "inv_cancel", title: "❌ Cancel" }
  ]);
}

/* =============================================================================
   REPORTS MENU — Owner sees two-tier, managers/clerks see their branch only
============================================================================= */
export async function sendReportsMenu(to, isGold = false) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);
  const phone = to.replace(/\D+/g, "");
  let normalized = phone.startsWith("0") ? "263" + phone.slice(1) : phone;

  const caller = biz ? await UserRole.findOne({ businessId: biz._id, phone: normalized, pending: false }) : null;

  // Clerk or manager: branch-scoped only
  if (caller?.role === "manager" || caller?.role === "clerk") {
    const items = [
      { id: ACTIONS.DAILY_REPORT, title: "📅 Daily Report" },
      ...(isGold ? [
        { id: ACTIONS.WEEKLY_REPORT, title: "📊 Weekly Report" },
        { id: ACTIONS.MONTHLY_REPORT, title: "📆 Monthly Report" }
      ] : []),
      { id: ACTIONS.BACK, title: "⬅ Back" }
    ];
    return sendList(to, "📈 Reports (Your Branch)", items);
  }

  // Owner: two-tier
  return sendList(to, "📈 Reports", [
    { id: "overall_reports", title: "📊 Overall Reports" },
    { id: "branch_reports", title: "🏢 Branch Reports" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

export async function sendOverallReportsMenu(to, isGold = false) {
  const items = [
    { id: ACTIONS.DAILY_REPORT, title: "📅 Daily Report" },
    ...(isGold ? [
      { id: ACTIONS.WEEKLY_REPORT, title: "📊 Weekly Report" },
      { id: ACTIONS.MONTHLY_REPORT, title: "📆 Monthly Report" }
    ] : []),
    { id: ACTIONS.BACK, title: "⬅ Back to Reports" }
  ];
  return sendList(to, "📊 Overall Reports (All Branches)", items);
}

export async function sendBranchReportsMenu(to, isGold = false) {
  const items = [
    { id: "branch_daily", title: "📅 Daily Report" },
    ...(isGold ? [
      { id: "branch_weekly", title: "📊 Weekly Report" },
      { id: "branch_monthly", title: "📆 Monthly Report" }
    ] : []),
    { id: ACTIONS.BACK, title: "⬅ Back to Reports" }
  ];
  return sendList(to, "🏢 Branch Reports", items);
}

/* =============================================================================
   USERS MENU
============================================================================= */
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

/* =============================================================================
   BRANCHES MENU
============================================================================= */
export async function sendBranchesMenu(to) {
  return sendList(to, "🏬 Branches", [
    { id: ACTIONS.ADD_BRANCH, title: "➕ Add Branch" },
    { id: ACTIONS.VIEW_BRANCHES, title: "📋 View Branches" },
    { id: ACTIONS.ASSIGN_BRANCH_USERS, title: "👥 Assign Users" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   PRODUCTS MENU
============================================================================= */
export async function sendProductsMenu(to) {
  return sendList(to, "📦 Products & Services", [
    { id: ACTIONS.ADD_PRODUCT, title: "➕ Add item" },
    { id: ACTIONS.VIEW_PRODUCTS, title: "📋 View items" },
    { id: ACTIONS.BULK_UPLOAD_MENU, title: "📋 Bulk paste list" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   SUBSCRIPTION MENU
============================================================================= */
export async function sendSubscriptionMenu(to) {
  return sendList(to, "💳 Subscription", [
    { id: ACTIONS.BUSINESS_PROFILE, title: "📌 My plan & due date" },
    { id: ACTIONS.SUBSCRIPTION_PAYMENTS, title: "🧾 Payment history" },
    { id: ACTIONS.UPGRADE_PACKAGE, title: "⭐ Upgrade package" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   PACKAGES MENU
============================================================================= */
export async function sendPackagesMenu(to, currentPackage) {
  const FEATURE_LABELS = {
    invoice: "Inv", quote: "Quote", receipt: "Rcpt",
    clients: "Clients", payments: "Pay",
    reports_daily: "Rpt(D)", reports_weekly: "Rpt(W)", reports_monthly: "Rpt(M)",
    branches: "Branches", users: "Users"
  };

  function money(plan) {
    if (!plan) return "";
    const cur = (plan.currency || "").toUpperCase();
    const amt = plan.price ?? "";
    if (!cur || amt === "") return "";
    return `${amt} ${cur}/mo`;
  }

  function packageDesc(pkgKey) {
    const pkg = PACKAGES[pkgKey];
    if (!pkg) return "";
    const base = `U:${pkg.users} B:${pkg.branches} D:${pkg.monthlyDocs}/mo`;
    const feats = (pkg.features || []).map(f => FEATURE_LABELS[f] || f).slice(0, 5).join(", ");
    return feats ? `${base} | ${feats}` : base;
  }

  const header = `📦 Your current package: *${currentPackage.toUpperCase()}*\n\n✅ *Payment method: EcoCash only*\nPlease select a package below.`;

  return sendList(to, header, [
    { id: "pkg_bronze", title: `🥉 Bronze - ${money(SUBSCRIPTION_PLANS?.bronze)}`, description: packageDesc("bronze") },
    { id: "pkg_silver", title: `🥈 Silver - ${money(SUBSCRIPTION_PLANS?.silver)}`, description: packageDesc("silver") },
    { id: "pkg_gold", title: `🥇 Gold - ${money(SUBSCRIPTION_PLANS?.gold)}`, description: packageDesc("gold") },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   INVITE USER MENU (legacy, kept for compatibility)
============================================================================= */
export async function sendInviteUserMenu(to) {
  return sendList(to, "👤 Invite User", [
    { id: ACTIONS.BRANCH_VIEW, title: "📂 View branches" },
    { id: ACTIONS.BRANCH_ADD, title: "➕ Add branch" },
    { id: ACTIONS.BRANCH_ASSIGN_USER, title: "👥 Assign user to branch" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   REPORT BRANCH PICKER
============================================================================= */
export async function sendReportBranchPicker(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;

  const biz = await getBizForPhone(to);
  if (!biz) { await sendText(to, "❌ No business found."); return sendMainMenu(to); }

  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  const items = [
    { id: "report_branch_all", title: "🌍 All branches" },
    ...branches.map(b => ({ id: `report_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ];

  return sendList(to, "🏢 Select a branch", items);
}

/* =============================================================================
   BRANCH SELECTORS: SALES DOCS (used by VIEW_INVOICES / VIEW_QUOTES / VIEW_RECEIPTS)
============================================================================= */
export async function sendBranchSelectorInvoices(to) {
  return _salesDocBranchSelector(to, "invoice", "📄 View Invoices");
}

export async function sendBranchSelectorQuotes(to) {
  return _salesDocBranchSelector(to, "quote", "📄 View Quotations");
}

export async function sendBranchSelectorReceipts(to) {
  return _salesDocBranchSelector(to, "receipt", "📄 View Receipts");
}

async function _salesDocBranchSelector(to, type, label) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);
  const prefix = type === "invoice" ? "view_invoices_branch_"
    : type === "quote" ? "view_quotes_branch_"
    : "view_receipts_branch_";

  return sendList(to, `${label} - Select Branch`, [
    { id: `view_all_${type}s`, title: "🌍 All Branches" },
    ...branches.map(b => ({ id: `${prefix}${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: PRODUCTS
============================================================================= */
export async function sendBranchSelectorProducts(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "📦 View Products - Select Branch", [
    { id: "view_all_products", title: "🌍 All Branches" },
    ...branches.map(b => ({ id: `view_products_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: ADD PRODUCT (Owner picks which branch to add a product to)
============================================================================= */
export async function sendBranchSelectorAddProduct(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
 const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "📦 Add Product - Select Branch", [
    ...branches.map(b => ({ id: `add_product_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: NEW INVOICE / QUOTE / RECEIPT (Owner picks branch for new doc)
============================================================================= */
export async function sendBranchSelectorNewDoc(to, docType) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
 const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  const label = docType === "invoice" ? "📄 New Invoice"
    : docType === "quote" ? "📋 New Quotation"
    : "🧾 New Receipt";

  return sendList(to, `${label} - Select Branch`, [
    ...branches.map(b => ({ id: `new_doc_branch_${docType}_${b._id}`, title: `🏬 ${b.name}` })),
    { id: "branch_add_inline", title: "➕ Add Branch" },
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: PAYMENT IN (owner picks branch before recording payment)
============================================================================= */
export async function sendBranchSelectorPaymentIn(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "💵 Record Payment - Select Branch", [
    ...branches.map(b => ({ id: `payment_in_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: PAYMENT OUT / EXPENSE (owner picks branch)
============================================================================= */
export async function sendBranchSelectorExpense(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
 const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "💸 Record Expense - Select Branch", [
    ...branches.map(b => ({ id: `expense_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: BULK EXPENSES
============================================================================= */
export async function sendBranchSelectorBulkExpense(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "📋 Bulk Expenses - Select Branch", [
    ...branches.map(b => ({ id: `bulk_expense_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: VIEW EXPENSE RECEIPTS
============================================================================= */
export async function sendBranchSelectorViewExpenses(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "🧾 Expense Receipts - Select Branch", [
    { id: "view_expense_receipts_branch_all", title: "🌍 All Branches" },
    ...branches.map(b => ({ id: `view_expense_receipts_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: VIEW PAYMENT HISTORY
============================================================================= */
export async function sendBranchSelectorPaymentHistory(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "📜 Payment History - Select Branch", [
    { id: "view_payment_history_branch_all", title: "🌍 All Branches" },
    ...branches.map(b => ({ id: `view_payment_history_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: ADD CLIENT (Owner picks branch to associate client)
============================================================================= */
export async function sendBranchSelectorAddClient(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "👥 Add Client - Select Branch", [
    ...branches.map(b => ({ id: `add_client_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   BRANCH SELECTOR: VIEW CLIENTS
============================================================================= */
export async function sendBranchSelectorViewClients(to) {
  const { getBizForPhone } = await import("./bizHelpers.js");
  const Branch = (await import("../models/branch.js")).default;
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
const { branches } = await ensureDefaultBranch(biz._id);

  return sendList(to, "📋 View Clients - Select Branch", [
    { id: "view_clients_branch_all", title: "🌍 All Branches" },
    ...branches.map(b => ({ id: `view_clients_branch_${b._id}`, title: `🏬 ${b.name}` })),
    { id: ACTIONS.BACK, title: "⬅ Back" }
  ]);
}

/* =============================================================================
   EXPENSE "ADD ANOTHER" MENU
============================================================================= */
export async function sendExpenseAddAnotherMenu(to) {
  return sendButtons(to, {
    text: "What would you like to do next?",
    buttons: [
      { id: "add_another_expense", title: "➕ Add Another" },
      { id: "expense_generate_receipt", title: "🧾Save & Get Receipt" },
      { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
    ]
  });
}
/* =============================================================================
   EXPENSE "ADD ANOTHER" MENU
============================================================================= */


/* =============================================================================
   PAYMENT OUT "ADD ANOTHER" MENU (if you have separate payment out flow)
============================================================================= */
export async function sendPaymentOutAddAnotherMenu(to) {
  return sendButtons(to, {
    text: "✅ *Payment Recorded!*\n\nWhat would you like to do next?",
    buttons: [
      { id: "add_another_payment_out", title: "➕ Add Another" },
      { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
    ]
  });
}




// Add to services/metaMenus.js

export async function sendSuppliersMenu(to) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const phone = to.replace(/\D+/g, "");
  const supplier = await SupplierProfile.findOne({ phone });

  const { getBizForPhone } = await import("./bizHelpers.js");
  const biz = await getBizForPhone(to);
  const hasRealBiz = biz && !biz.name.startsWith("pending_supplier_");

  if (supplier?.active) {
    const buttons = [
      { id: "find_supplier", title: "🔍 Find Suppliers" },
      { id: "my_supplier_account", title: "🏪 My Account" }
    ];

    if (hasRealBiz) {
      buttons.push({ id: "menu", title: "🏠 Main Menu" });
    }

    return sendButtons(to, {
      text: "🏪 *ZimQuote Suppliers*",
      buttons
    });
  }

  if (supplier && !supplier.active) {
    const complete = isSupplierRegistrationComplete(supplier);

    const buttons = [
      { id: "find_supplier", title: "🔍 Find Suppliers" },
      complete
        ? { id: "sup_upgrade_plan", title: "💳 Activate Listing" }
        : { id: "register_supplier", title: "⏳ Finish Setup" }
    ];

    if (complete) {
      buttons.push({ id: "my_supplier_account", title: "🏪 My Account" });
    }

    if (hasRealBiz) {
      buttons.push({ id: "menu", title: "🏠 Main Menu" });
    }

    return sendButtons(to, {
      text: complete
        ? "🏪 *ZimQuote Suppliers*\n\n⚠️ Your listing is ready but not active yet.\nComplete payment to go live."
        : "🏪 *ZimQuote Suppliers*\n\n⚠️ Your listing is not yet active.\nComplete registration to go live.",
      buttons
    });
  }

  const buttons = [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "register_supplier", title: "📦 List My Business" }
  ];

  if (hasRealBiz) {
    buttons.push({ id: "menu", title: "🏠 Main Menu" });
  }

  return sendButtons(to, {
    text: "🏪 *ZimQuote Suppliers*",
    buttons
  });
}

export async function sendSupplierUpgradeMenu(to, currentTier) {
  return sendList(to, `⭐ Upgrade Your Listing\nCurrent: ${(currentTier || "basic").toUpperCase()}`, [
    { id: "sup_plan_basic_monthly", title: "✅ Basic — $5/mo" },
    { id: "sup_plan_basic_annual", title: "✅ Basic — $50/yr (save $10)" },
    { id: "sup_plan_pro_monthly", title: "⭐ Pro — $12/mo" },
    { id: "sup_plan_pro_annual", title: "⭐ Pro — $120/yr (save $24)" },
    { id: "sup_plan_featured_monthly", title: "🔥 Featured — $25/mo" },
    { id: "back", title: "⬅ Back" }
  ]);
}




export async function sendSupplierAccountMenu(to, supplierDoc) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const phone = to.replace(/\D+/g, "");
  const supplier = supplierDoc || await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(to);

  const tierLabel = { basic: "Basic $5/mo", pro: "Pro $12/mo", featured: "Featured $25/mo" }[supplier.tier] || supplier.tier || "None";
  const statusIcon = supplier.active ? "🟢" : "🔴";
  const renewDate = supplier.subscriptionExpiresAt
    ? new Date(supplier.subscriptionExpiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : "—";

  const priceCount = supplier.prices?.length || 0;
  const productCount = supplier.products?.length || 0;
  const score = (supplier.credibilityScore || 0).toFixed(0);
  const badge = (supplier.credibilityScore || 0) >= 70 && (supplier.completedOrders || 0) >= 10 ? " 🏅" : "";

  return sendList(to, {
    text: `🏪 *${supplier.businessName}*${badge}\n` +
          `${statusIcon} ${supplier.active ? "Active" : "Inactive"} · 📦 ${supplier.tier ? tierLabel : "No Plan"}\n` +
          `📍 ${supplier.location?.area || ""}, ${supplier.location?.city || ""}\n` +
          `⭐ ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews) · Score: ${score}\n` +
          `🗓 Renews: ${renewDate}\n\n` +
          `Products: ${productCount} · Prices: ${priceCount}`,
    buttonLabel: "Manage Account",
    sections: [
      {
        title: "📋 My Listing",
        rows: [
          { id: "sup_edit_products", title: "✏️ Edit Products", description: `${productCount} products listed` },
          { id: "sup_update_prices", title: "💰 Update Prices", description: `${priceCount} prices set` },
          { id: "sup_edit_area", title: "📍 Edit Location", description: `${supplier.location?.area || "Not set"}, ${supplier.location?.city || ""}` },
          { id: "sup_toggle_delivery", title: "🚚 Toggle Delivery", description: supplier.delivery?.available ? "Currently: Delivering" : "Currently: Collection only" },
          { id: "sup_toggle_active", title: statusIcon + (supplier.active ? " Deactivate Listing" : " Activate Listing"), description: supplier.active ? "Hide from search results" : "Show in search results" }
        ]
      },
      {
        title: "📊 Orders & Stats",
        rows: [
          { id: "sup_my_orders", title: "📦 My Orders", description: `${supplier.completedOrders || 0} completed` },
          { id: "sup_my_earnings", title: "💵 Earnings Summary", description: "View order history" },
          { id: "sup_my_reviews", title: "⭐ My Reviews", description: `${supplier.reviewCount || 0} reviews` }
        ]
      },
      {
        title: "💳 Subscription",
        rows: [
          { id: "sup_upgrade_plan", title: "⬆️ Upgrade Plan", description: `Current: ${tierLabel}` },
          { id: "sup_renew_plan", title: "🔄 Renew Subscription", description: `Expires: ${renewDate}` }
        ]
      }
    ]
  });
}
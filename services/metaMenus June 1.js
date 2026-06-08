//metaMenus
import { ACTIONS } from "./actions.js";
import { sendList, sendText, sendButtons } from "./metaSender.js";
import { SUBSCRIPTION_PLANS } from "./subscriptionPlans.js";
import { PACKAGES } from "./packages.js";
import { canAccessSection } from "./roleGuard.js";
import UserRole from "../models/userRole.js";
import { normalizePhone } from "./phone.js";

function isSupplierRegistrationComplete(supplier) {
  if (!supplier) return false;

  const isService = supplier.profileType === "service";

  if (isService) {
    return Boolean(
      supplier.businessName &&
      supplier.location?.city &&
      supplier.location?.area &&
      Array.isArray(supplier.categories) && supplier.categories.length > 0 &&
      Array.isArray(supplier.products) && supplier.products.length > 0 &&
      typeof supplier.minOrder === "number"
    );
  }

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

  if (!biz) {
    // No biz in session - but still check if this phone has a role (e.g. supplier with stale session)
    const _fallbackUser = await UserRole.findOne({ phone, pending: false }).sort({ updatedAt: -1 }).lean();
    if (_fallbackUser) {
      const _fbRole = _fallbackUser.role;
      return items.filter(item => {
        if (!item.section) return true;
        if (item.section === "owner_only") return _fbRole === "owner";
        if (item.section === "biz_tools") return true;
        if (_fbRole === "owner") return true;
        return canAccessSection(_fbRole, item.section);
      });
    }
    // Truly no biz and no role: hide all sectioned items
    return items.filter(item => !item.section);
  }

  // Look up by biz._id first; fall back to phone-only (handles UserRole businessId mismatch)
  let user = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
  if (!user) {
    user = await UserRole.findOne({ phone, pending: false });
  }

  const role = user?.role || null;

  return items.filter(item => {
    if (!item.section) return true;

    // owner_only items: only owners see My Store / account management
    if (item.section === "owner_only") return role === "owner";

    // biz_tools: any assigned staff member sees Business Tools
    if (item.section === "biz_tools") return role !== null;

    // All other sections: use roleMatrix
    if (role === "owner") return true;
    if (!role) return canAccessSection("clerk", item.section);
    return canAccessSection(role, item.section);
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
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const SchoolProfile   = (await import("../models/schoolProfile.js")).default;
  const UserRole        = (await import("../models/userRole.js")).default;
  const phone = to.replace(/\D+/g, "");
  const supplier = await SupplierProfile.findOne({ phone });

  // ── Case 0: School admin ───────────────────────────────────────────────────
  const school = await SchoolProfile.findOne({ phone });
  if (school) {
    const { sendSchoolAccountMenu: _schoolMenu } = await import("./metaMenus.js");
    return _schoolMenu(to, school);
  }

  // ── Resolve staff role for this phone ─────────────────────────────────────
  // Check BEFORE branching so clerks/managers always reach Business Tools.
  // We look up by biz._id if biz is known, otherwise by phone alone.
  let staffRole = null;
  if (biz) {
    staffRole = await UserRole.findOne({ businessId: biz._id, phone, pending: false }).lean();
  }
  if (!staffRole) {
    staffRole = await UserRole.findOne({ phone, pending: false }).sort({ updatedAt: -1 }).lean();
  }
  const hasStaffRole = !!staffRole;
  const isOwnerRole  = staffRole?.role === "owner";

  // ── Case 1: Active supplier (paid) ───────────────────────────────────────
  if (supplier?.active) {
    // Ensure we have biz - supplier may have businessId even if session is stale
    let supplierBiz = biz;
    if (!supplierBiz && supplier.businessId) {
      supplierBiz = await (await import("../models/business.js")).default.findById(supplier.businessId);
      if (supplierBiz) {
        // Fix stale session
        await (await import("../models/userSession.js")).default.findOneAndUpdate(
          { phone },
          { $set: { phone, activeBusinessId: supplierBiz._id } },
          { upsert: true }
        );
      }
    }
    const items = [
      { id: "sup_request_sellers", title: "⚡ Request Sellers" },
      { id: "find_supplier",       title: "🔍 Browse & Shop" },
      { id: "my_orders",           title: "📋 My Orders (Buyer)" },
      { id: "find_school",         title: "🏫 Find a School" },
      { id: "my_supplier_account", title: "🏪 My Store",        section: "owner_only" },
      { id: "biz_tools_menu",      title: "📊 Business Tools",  section: "biz_tools" }
    ];
    const filtered = await filterMenuByRole({ from: to, biz: supplierBiz, items });
    const finalFiltered = (supplierBiz && supplierBiz.package === "trial" && !hasStaffRole)
      ? filtered.filter(i => i.id !== "biz_tools_menu")
      : filtered;
    return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", finalFiltered);
  }

  // ── Case 2: Supplier registered but not yet paid ──────────────────────────
  if (supplier && !supplier.active) {
    const items = [
      { id: "sup_request_sellers", title: "⚡ Request Sellers" },
      { id: "find_supplier",       title: "🔍 Browse & Shop" },
      { id: "my_orders",           title: "📋 My Orders" },
      { id: "find_school",         title: "🏫 Find a School" },
      { id: "my_supplier_account", title: "🏪 My Store" },
      { id: "sup_upgrade_plan",    title: "💳 Activate Listing" }
    ];
    // Even unactivated suppliers might be assigned as staff in a biz
    if (hasStaffRole) {
      items.unshift({ id: "biz_tools_menu", title: "📊 Business Tools", section: "biz_tools" });
    }
    const filtered = await filterMenuByRole({ from: to, biz, items });
    return sendList(to, "👋 *Welcome to ZimQuote!*\n\nYour listing is saved but not yet live.", filtered);
  }

  // ── Case 3: Has a staff role (clerk/manager/owner) - the key fix ──────────
  // A clerk or manager has a UserRole but NO SupplierProfile of their own.
  // They must see Business Tools regardless of whether biz.name is "pending_supplier_".
  // EXCEPTION: if the biz is still "pending_supplier_" registration in progress,
  // show "List My Business" so they can complete registration.
  if (hasStaffRole) {
    const staffBiz = biz || (staffRole.businessId
      ? await (await import("../models/business.js")).default.findById(staffRole.businessId)
      : null);

    // If their only biz is a pending supplier registration, treat as new user
    const isPendingRegistration = !staffBiz || staffBiz.name?.startsWith("pending_supplier_");
    if (isPendingRegistration) {
      return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", [
        { id: "register_supplier",   title: "🏪 List My Business" },
        { id: "sup_request_sellers", title: "⚡ Request Sellers" },
        { id: "find_supplier",       title: "🔍 Browse & Shop" },
        { id: "my_orders",           title: "📋 My Orders" },
        { id: "find_school",         title: "🏫 Find a School" }
      ]);
    }

    const items = [
      { id: "biz_tools_menu",      title: "📊 Business Tools" },
      { id: "sup_request_sellers", title: "⚡ Request Sellers" },
      { id: "find_supplier",       title: "🔍 Browse & Shop" },
      { id: "my_orders",           title: "📋 My Orders" },
      { id: "find_school",         title: "🏫 Find a School" }
    ];
    // Owners also see My Store
    if (isOwnerRole) {
      items.push({ id: "my_supplier_account", title: "🏪 My Store" });
    }
    return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", items);
  }

  // ── Case 4: Has a real biz (not pending) but no role and no supplier ──────
  if (biz && !biz.name?.startsWith("pending_supplier_")) {
    const items = [
      { id: "biz_tools_menu",      title: "📊 Business Tools", section: "biz_tools" },
      { id: "sup_request_sellers", title: "⚡ Request Sellers" },
      { id: "find_supplier",       title: "🔍 Browse & Shop" },
      { id: "my_orders",           title: "📋 My Orders" },
      { id: "find_school",         title: "🏫 Find a School" },
      { id: "my_supplier_account", title: "🏪 My Store", section: "owner_only" }
    ];
    const filtered = await filterMenuByRole({ from: to, biz, items });
    return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", filtered);
  }

  // ── Case 5: Brand new user - no biz, no supplier, no role ─────────────────
  return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", [
    { id: "register_supplier",   title: "🏪 List My Business" },
    { id: "sup_request_sellers", title: "⚡ Request Sellers" },
    { id: "find_supplier",       title: "🔍 Browse & Shop" },
    { id: "my_orders",           title: "📋 My Orders" },
    { id: "find_school",         title: "🏫 Find a School" }
  ]);
}


/* =============================================================================
   BUSINESS TOOLS MENU (for suppliers accessing invoicing features)
============================================================================= */
export async function sendBusinessToolsMenu(to, biz) {
  const pkg = biz?.package || "trial";
  const PAID = ["bronze", "silver", "gold", "enterprise"];
  const isPaid = PAID.includes(pkg);

  const items = [
    { id: ACTIONS.SALES_MENU,    title: "🧾 Sales" },
    { id: ACTIONS.PAYMENTS_MENU, title: "💰 Payments" },
    { id: ACTIONS.CLIENTS_MENU,  title: "👥 Clients" },
    { id: ACTIONS.PRODUCTS_MENU, title: "📦 Products & Services" },
    { id: ACTIONS.REPORTS_MENU,  title: "📈 Reports" },
    // Branches & Users - only show for silver+ (multi-branch packages)
    ...(isPaid && ["silver", "gold", "enterprise"].includes(pkg)
      ? [
          { id: ACTIONS.BRANCHES_MENU, title: "🏬 Branches", section: "branches" },
          { id: ACTIONS.USERS_MENU,    title: "👥 Users",    section: "users" }
        ]
      : []),
    { id: ACTIONS.SETTINGS_MENU,  title: "⚙ Settings" },
    { id: "my_supplier_account",  title: "🏪 My Business" },
    { id: ACTIONS.BACK,           title: "⬅ Back" }
  ];

  const filtered = await filterMenuByRole({ from: to, biz, items });
  return sendList(to, "📊 *Business Tools*", filtered);
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
   REPORTS MENU - Owner sees two-tier, managers/clerks see their branch only
============================================================================= */
export async function sendReportsMenu(to, isGold = false, isSilver = false) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(to);
  if (!biz) return sendMainMenu(to);

  const phone      = to.replace(/\D+/g, "");
  const normalized = phone.startsWith("0") ? "263" + phone.slice(1) : phone;

  // Look up caller by phone across all roles (not just current biz)
  // This handles the case where UserRole businessId might differ
  const caller = await UserRole.findOne({ phone: normalized, pending: false });

  const canSeeAdvanced = isGold || isSilver;

  // Clerk or manager: branch-scoped daily report only
  if (caller?.role === "manager" || caller?.role === "clerk") {
    const items = [
      { id: ACTIONS.DAILY_REPORT, title: "📅 Daily Report" },
      ...(canSeeAdvanced ? [
        { id: ACTIONS.WEEKLY_REPORT,  title: "📊 Weekly Report" },
        { id: ACTIONS.MONTHLY_REPORT, title: "📆 Monthly Report" }
      ] : []),
      { id: ACTIONS.BACK, title: "⬅ Back" }
    ];
    return sendList(to, "📈 Reports (Your Branch)", items);
  }

  // Owner: overall + branch breakdown
  return sendList(to, "📈 Reports", [
    { id: "overall_reports", title: "📊 Overall Reports" },
    { id: "branch_reports",  title: "🏢 Branch Reports"  },
    { id: ACTIONS.BACK,      title: "⬅ Back"             }
  ]);
}

export async function sendOverallReportsMenu(to, isGold = false, isSilver = false) {
  const canSeeAdvanced = isGold || isSilver;
  const items = [
    { id: ACTIONS.DAILY_REPORT, title: "📅 Daily Report" },
    ...(canSeeAdvanced ? [
      { id: ACTIONS.WEEKLY_REPORT,  title: "📊 Weekly Report"  },
      { id: ACTIONS.MONTHLY_REPORT, title: "📆 Monthly Report" }
    ] : []),
    { id: ACTIONS.BACK, title: "⬅ Back to Reports" }
  ];
  return sendList(to, "📊 Overall Reports (All Branches)", items);
}

export async function sendBranchReportsMenu(to, isGold = false, isSilver = false) {
  const canSeeAdvanced = isGold || isSilver;
  const items = [
    { id: "branch_daily", title: "📅 Daily Report" },
    ...(canSeeAdvanced ? [
      { id: "branch_weekly",  title: "📊 Weekly Report"  },
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
    { id: "prod_add_products",        title: "📦 Add Products"           },
    { id: "prod_add_services",        title: "🔧 Add Services"           },
    { id: ACTIONS.VIEW_PRODUCTS,      title: "📋 View Products & Services"},
    { id: "prod_update_prices",       title: "💰 Update Product Prices"  },
    { id: "prod_update_rates",        title: "💰 Update Service Rates"   },
    { id: ACTIONS.BULK_UPLOAD_MENU,   title: "📋 Bulk Paste List"        },
    { id: ACTIONS.BACK,               title: "⬅ Back"                   }
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
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
  const { branches } = await ensureDefaultBranch(biz._id);

  const prefix = type === "invoice" ? "view_invoices_branch_"
    : type === "quote" ? "view_quotes_branch_"
    : "view_receipts_branch_";

  // ── Auto-skip branch selector if there is only one branch ─────────────────
  if (branches.length === 1) {
    const { handleIncomingMessage } = await import("./chatbotEngine.js");
    return handleIncomingMessage({ from: to, action: `${prefix}${branches[0]._id}` });
  }

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
  const biz = await getBizForPhone(to);
  if (!biz) return sendMainMenu(to);
  const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
  const { branches } = await ensureDefaultBranch(biz._id);

  // ── Auto-skip branch selector if there is only one branch ─────────────────
  // Fires the new_doc_branch_{docType}_{branchId} action directly
  if (branches.length === 1) {
    const { handleIncomingMessage } = await import("./chatbotEngine.js");
    return handleIncomingMessage({ from: to, action: `new_doc_branch_${docType}_${branches[0]._id}` });
  }

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

// VERIFY this is what your active supplier block looks like:
const searchTip = "\n\n";

if (supplier?.active) {
return sendList(to, `🛒 *ZimQuote Marketplace*${searchTip}`, [

  { id: "sup_request_sellers", title: "⚡ Request Sellers" },
    { id: "find_supplier",       title: "🔍 Browse & Shop" },
  { id: "buyer_my_requests",   title: "📋 My Quote Requests" },
  { id: "my_orders",           title: "🛒 My Orders" },
  { id: "my_supplier_account", title: "🏪 My Store" },
  { id: hasRealBiz ? ACTIONS.MAIN_MENU : "onboard_business",
    title: hasRealBiz ? "🏠 Main Menu" : "🧾 Run My Business" }
]);
}

// FIND AND REPLACE the entire supplier && !supplier.active block:
if (supplier && !supplier.active) {
  const complete = isSupplierRegistrationComplete(supplier);
  return sendList(
    to,
    complete
      ? `🏪*ZimQuote Marketplace*${searchTip}\n\n⚠️ Your listing is *not yet active*.\nChoose a plan to go live and start receiving orders.`

      : `🏪 *ZimQuote Marketplace*${searchTip}\n\n⚠️ Your registration is incomplete.\nFinish setup to activate your listing.`,
    [
      { id: "find_supplier",       title: "🔍 Browse & Shop" },      { id: "my_supplier_account", title: "🏪 My Supplier Account" },
      complete
        ? { id: "sup_upgrade_plan",  title: "💳 Activate Listing" }
        : { id: "register_supplier", title: "⏳ Finish Registration" },
      { id: hasRealBiz ? ACTIONS.MAIN_MENU : "onboard_business",
        title: hasRealBiz ? "🏠 Main Menu" : "🧾 Run My Business" }
    ]
  );
}

return sendList(to, `🛒 *ZimQuote Marketplace*${searchTip}`, [
  { id: "find_supplier",     title: "🔍 Browse & Shop" },
  { id: "sup_request_sellers", title: "⚡ Request Sellers" },
  { id: "buyer_my_requests", title: "📋 My Quote Requests" },
  { id: "register_supplier", title: "🏪 List My Business" },
  { id: "my_orders",         title: "📋 My Orders" },
  { id: hasRealBiz ? ACTIONS.MAIN_MENU : "onboard_business", title: hasRealBiz ? "🏠 Main Menu" : "🧾 Run My Business" }
]);
}

export async function sendSupplierUpgradeMenu(to, currentTier) {
  return sendList(to, `⭐ Upgrade Your Listing\nCurrent: ${(currentTier || "basic").toUpperCase()}\n\nAll plans include unlimited uploads and unlimited orders.`, [
    { id: "sup_plan_basic_monthly", title: "✅ Basic - $5/mo", description: "Up to 20 live items" },
    { id: "sup_plan_basic_annual", title: "✅ Basic - $50/yr (save $10)", description: "Up to 20 live items" },
    { id: "sup_plan_pro_monthly", title: "⭐ Pro - $12/mo", description: "Up to 60 live items" },
    { id: "sup_plan_pro_annual", title: "⭐ Pro - $120/yr (save $24)", description: "Up to 60 live items" },
    { id: "sup_plan_featured_monthly", title: "🔥 Featured - $25/mo", description: "Up to 150 live items" },
    { id: "back", title: "⬅ Back" }
  ]);
}



export async function sendSupplierAccountMenu(to, supplierDoc) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const phone = to.replace(/\D+/g, "");

  // ── School-aware routing: if this phone belongs to a school, show school menu ─
  const SchoolProfile = (await import("../models/schoolProfile.js")).default;
  const school = await SchoolProfile.findOne({ phone });
  if (school) return sendSchoolAccountMenu(to, school);

  const supplier = supplierDoc || await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(to);

  const isService = supplier.profileType === "service";
  const tierLabel = { basic: "Basic $5/mo", pro: "Pro $12/mo", featured: "Featured $25/mo" }[supplier.tier] || supplier.tier || "None";
  const statusIcon = supplier.active ? "🟢" : "🔴";
 const renewDate = supplier.subscriptionEndsAt
  ? new Date(supplier.subscriptionEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
  : "-";

  const priceCount = supplier.prices?.length || supplier.rates?.length || 0;
  const productCount = (supplier.products || []).filter(p => p !== "pending_upload").length;
  const liveCount = (supplier.listedProducts || []).filter(Boolean).length;
  const score = (supplier.credibilityScore || 0).toFixed(0);
  const badge = (supplier.credibilityScore || 0) >= 70 && (supplier.completedOrders || 0) >= 10 ? " 🏅" : "";

  return sendList(
    to,
    `🏪 *${supplier.businessName}*${badge}\n` +
    `${statusIcon} ${supplier.active ? "Active" : "Inactive"} · 📦 ${supplier.tier ? tierLabel : "No Plan"}\n` +
    `📍 ${supplier.location?.area || ""}, ${supplier.location?.city || ""}\n` +
    `⭐ ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews) · Score: ${score}\n` +
    `🗓 Renews: ${renewDate}\n\n` +
    `${isService ? "Services" : "Products"}: ${supplier.products?.[0] === "pending_upload" ? "⏳ Upload pending" : productCount} · Live: ${liveCount} · ${isService ? "Rates" : "Prices"}: ${priceCount}\n` +
    `👀 Views this month: ${supplier.monthlyViews || 0} · 🛒 Orders this month: ${supplier.monthlyOrders || 0}`,
    [
     { id: "sup_get_my_link",   title: "📲 My Smart Link" },
       { id: "sup_edit_products", title: isService ? "✏️ Manage Services" : "✏️ Manage Products" },
       { id: "sup_manage_listed_products", title: "📋 Manage Listed Items" },
       { id: "sup_update_prices", title: isService ? "💰 Update Rates" : "💰 Update Prices" },
       { id: "sup_my_orders", title: "📦 My Orders" },
       { id: "sup_upgrade_plan", title: "⬆️ Upgrade Plan" },
       { id: "sup_more_options", title: "⚙️ More Options" },
       { id: "main_menu_back", title: "⬅ Main Menu" }

    ]
  );
}



export async function sendSupplierMoreOptionsMenu(to, supplierDoc) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const phone = to.replace(/\D+/g, "");
  const supplier = supplierDoc || await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(to);

  const statusIcon = supplier.active ? "🟢" : "🔴";

  return sendList(to, "⚙️ Seller Settings", [
    { id: "sup_edit_area", title: "📍 Edit Location" },
    { id: "sup_toggle_delivery", title: "🚚 Toggle Delivery" },
    { id: "sup_toggle_active", title: statusIcon + (supplier.active ? " Deactivate Listing" : " Activate Listing") },
    { id: "sup_my_earnings", title: "💵 Earnings Summary" },
    { id: "sup_my_reviews", title: "⭐ My Reviews" },
    { id: "sup_renew_plan", title: "🔄 Renew Subscription" },
    { id: "my_supplier_account", title: "⬅ Back" }
  ]);
}


// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL ACCOUNT MENU - shown to school admins instead of supplier menu
// ─────────────────────────────────────────────────────────────────────────────
export async function sendSchoolAccountMenu(to, schoolDoc) {
  const SchoolProfile = (await import("../models/schoolProfile.js")).default;
  const phone  = to.replace(/\D+/g, "");
  const school = schoolDoc || await SchoolProfile.findOne({ phone });

 if (!school) {
  // No school profile - send back to registration
  return sendList(to, "👋 *Welcome to ZimQuote!*\nZimbabwe's marketplace for products & services.", [
    { id: "register_supplier", title: "🏪 List My Business" },
    { id: "find_supplier",     title: "🔍 Browse & Shop" },
    { id: "find_school",       title: "🏫 Find a School" },
    { id: "my_orders",         title: "📋 My Orders" },
  ]);
}

  const statusIcon    = school.active   ? "🟢" : "🔴";
  const verifiedBadge = school.verified ? " ✅" : "";
  const tierLabel     = { basic: "Basic $15/mo", featured: "Featured $35/mo" }[school.tier] || "No Plan";
  const renewDate     = school.subscriptionEndsAt
    ? new Date(school.subscriptionEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "Not active";
  const admissionsLabel = school.admissionsOpen ? "🟢 Open" : "🔴 Closed";
  const facilityCount   = (school.facilities || []).length;
  const curriculumText  = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "Not set";

if (!school.active) {
  // Inactive school - prompt activation
  return sendList(to,
    `🏫 *${school.schoolName}*${verifiedBadge}\n` +
    `🔴 *Not yet live* - parents cannot find you yet.\n` +
    `📍 ${school.suburb || ""}, ${school.city}\n` +
    `📚 ${curriculumText}\n\n` +
    `_Choose a plan to activate your listing._`,
    [
      { id: "school_pay_plan",    title: "💳 Activate Listing" },
      { id: "school_my_profile",  title: "👁 View My Profile" },
      { id: "sup_request_sellers", title: "⚡ Request Sellers" },
      { id: "find_supplier",      title: "🔍 Browse & Shop" },
      { id: "find_school",        title: "🏫 Preview Schools" },
      { id: "main_menu_back",     title: "⬅ Main Menu" }
    ]
  );
}

 return sendList(
  to,
  `🏫 *${school.schoolName}*${verifiedBadge}\n` +
  `${statusIcon} Active · ${tierLabel}\n` +
  `📍 ${school.suburb || ""}, ${school.city}\n` +
  `📚 ${curriculumText}\n` +
  `📝 Admissions: ${admissionsLabel}\n` +
  `🏊 Facilities: ${facilityCount}\n` +
  `⭐ ${(school.rating || 0).toFixed(1)} (${school.reviewCount || 0} reviews)\n` +
  `🗓 Renews: ${renewDate}\n` +
  `👀 Views: ${school.monthlyViews || 0} · 📬 Inquiries: ${school.inquiries || 0}`,
  [
    { id: "school_my_profile",       title: "📋 My School Profile" },
    { id: "school_my_facilities",    title: "🏊 Manage Facilities" },
    { id: "school_my_fees",          title: "💵 Update Fees" },
    { id: "sup_request_sellers",     title: "⚡ Request Sellers" },
    { id: "find_supplier",           title: "🔍 Browse & Shop" },
    { id: "find_school",             title: "🏫 Find a School" },
    { id: "school_my_reviews",       title: "⭐ My Reviews" },
    { id: "school_my_inquiries",     title: "📬 Parent Inquiries" },
    { id: "school_more_options",     title: "⚙️ More Options" },
    { id: "main_menu_back",          title: "⬅ Main Menu" }
  ]
);
}

// ── School "More Options" menu ────────────────────────────────────────────────
export async function sendSchoolMoreOptionsMenu(to, schoolDoc) {
  const SchoolProfile = (await import("../models/schoolProfile.js")).default;
  const phone  = to.replace(/\D+/g, "");
  const school = schoolDoc || await SchoolProfile.findOne({ phone });
  if (!school) return sendSchoolAccountMenu(to, null);

 const docStatus = school.profilePdfUrl ? "✅ Brochure uploaded" : "📄 No brochure yet";
  const regStatus = school.registrationLink ? "✅ Form link set" : "📝 No form link yet";

  return sendList(to, "⚙️ *School Settings*", [
    { id: "school_toggle_admissions",  title: school.admissionsOpen ? "🔴 Close Admissions" : "🟢 Open Admissions" },
    { id: "school_upload_brochure",    title: `📄 Upload School Brochure (${docStatus})` },
    { id: "school_update_reg_link",    title: `🔗 Registration Form Link (${regStatus})` },
    { id: "school_update_email",       title: "📧 Update Email" },
    { id: "school_update_website",     title: "🌐 Update Website" },
    { id: "school_pay_plan",           title: "⬆️ Upgrade / Renew Plan" },
    { id: "school_account",            title: "⬅ Back" }
  ]);
}
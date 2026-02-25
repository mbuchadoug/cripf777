export const ACTIONS = {
  // MAIN
  MAIN_MENU: "menu",

  SALES_MENU: "sales_menu",
  CLIENTS_MENU: "clients_menu",
  PAYMENTS_MENU: "payments_menu",
  REPORTS_MENU: "reports_menu",
  BUSINESS_MENU: "business_menu",
  SETTINGS_MENU: "settings_menu",

  // SALES
  NEW_INVOICE: "new_invoice",
  NEW_QUOTE: "new_quote",
  NEW_RECEIPT: "new_receipt",


  // SALES – VIEW LISTS ✅ ADD THESE
VIEW_INVOICES: "view_invoices",
VIEW_QUOTES: "view_quotes",
VIEW_RECEIPTS: "view_receipts",
  // SALES – ITEM ACTIONS
VIEW_DOC: "view_doc",
DELETE_DOC: "delete_doc",

  // CLIENTS
  ADD_CLIENT: "add_client",
  VIEW_CLIENTS: "view_clients",
  CLIENT_STATEMENT: "client_statement",

  // PAYMENTS
  RECORD_PAYMENT: "record_payment",
  RECORD_EXPENSE: "record_expense",

PAYMENT_IN: "payment_in",
PAYMENT_OUT: "payment_out",

VIEW_EXPENSE_RECEIPTS: "view_expense_receipts",
  VIEW_PAYMENT_HISTORY: "view_payment_history",

  // ✅ CASH BALANCE MANAGEMENT (NEW)
  CASH_BALANCE_MENU: "cash_balance_menu",
  SET_OPENING_BALANCE: "set_opening_balance",
  RECORD_PAYOUT: "record_payout",
  VIEW_CASH_BALANCE: "view_cash_balance",

  INV_ADD_ANOTHER_ITEM: "inv_add_item",
  INV_ENTER_PRICES: "inv_enter_prices",
   INV_SKIP_CLIENT: "inv_skip_client", 
  INV_CANCEL: "inv_cancel",


  // EXPENSE FLOW
EXPENSE_CATEGORY: "expense_category",
EXPENSE_METHOD: "expense_method",
BULK_EXPENSE_MODE: "bulk_expense_mode",

// REPORTS
DAILY_REPORT: "daily_report",
WEEKLY_REPORT: "weekly_report",
MONTHLY_REPORT: "monthly_report",
BRANCH_REPORT: "branch_report",


// ✅ ADD THESE NEW ONES:
OVERALL_REPORTS: "overall_reports",
BRANCH_REPORTS: "branch_reports",
BRANCH_DAILY: "branch_daily",
BRANCH_WEEKLY: "branch_weekly",
BRANCH_MONTHLY: "branch_monthly",

// BUSINESS
BUSINESS_PROFILE: "business_profile",
USERS_MENU: "users_menu",

// USERS
INVITE_USER: "invite_user",
VIEW_USERS: "view_users",
VIEW_INVITES: "view_invites",

// BRANCHES
BRANCHES_MENU: "branches_menu",
ADD_BRANCH: "add_branch",
VIEW_BRANCHES: "view_branches",
ASSIGN_BRANCH_USERS: "assign_branch_users",

// ✅ BRANCH FLOW (GLOBAL)
BRANCH_PICKED: "branch_picked",          // optional if you want a generic handler
BRANCH_ADD_INLINE: "branch_add_inline",  // button inside branch picker
BRANCH_ADD_CANCEL: "branch_add_cancel",   // cancel adding branch and go back to picker

// SETTINGS
SETTINGS_CURRENCY: "settings_currency",
SETTINGS_TERMS: "settings_terms",
SETTINGS_ADDRESS: "settings_address",
SETTINGS_INV_PREFIX: "settings_inv_prefix",
SETTINGS_QT_PREFIX: "settings_qt_prefix",
SETTINGS_RCPT_PREFIX: "settings_rcpt_prefix",
SETTINGS_LOGO: "settings_logo",
SETTINGS_CLIENTS: "settings_clients",
SETTINGS_BRANCHES: "settings_branches",

// PACKAGES
UPGRADE_PACKAGE: "upgrade_package",
CHOOSE_PACKAGE: "choose_package",

SUBSCRIPTION_MENU: "subscription_menu",
SUBSCRIPTION_PAYMENTS: "subscription_payments",


INV_ITEM_CATALOGUE: "inv_item_catalogue",
INV_ITEM_CUSTOM: "inv_item_custom",

PRODUCTS_MENU: "products_menu",
  ADD_PRODUCT: "add_product",
  VIEW_PRODUCTS: "view_products",
  BULK_UPLOAD_PRODUCTS: "bulk_upload_products",

  // PRODUCTS & SERVICES (BULK UPLOAD)
  BULK_UPLOAD_MENU: "bulk_upload_menu",
  BULK_PASTE_MODE: "bulk_paste_mode",

  // ✅ BRANCH SELECTORS (OWNERS)
  SELECT_BRANCH_INVOICES: "select_branch_invoices",
  SELECT_BRANCH_QUOTES: "select_branch_quotes",
  SELECT_BRANCH_RECEIPTS: "select_branch_receipts",
  SELECT_BRANCH_PRODUCTS: "select_branch_products",

  // NAV
  BACK: "back"

};

// routes/financeNav.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared navbar for the whole finance area of the /zq-admin portal.
//
// One strip, rendered at the top of every finance page so sales, reports and
// RECURRING BILLING are all reachable from a single place:
//
//   💰 Finance   📊 Reports   🏠 Recurring Billing   📒 Recurring Ledger
//
// Used by:
//   • supplierFinancialAdmin.js  (clerk picker, clerk workspace, /all)   → active "finance"
//   • financeReports.js          (sales / recurring / combined ledgers)  → active "reports"
//
// It is a pure string builder with NO model imports, so importing it anywhere
// is free and can never create a circular dependency or load-order issue.
//
// The recurring links point at the EXISTING recurring admin already mounted in
// supplierAdmin.js at /zq-admin/suppliers/:id/recurring - nothing is duplicated.
//
// WHERE TO PUT THIS FILE: routes/financeNav.js
// ─────────────────────────────────────────────────────────────────────────────

const BASE = id => `/zq-admin/suppliers/${id}`;

// active is one of: "finance" | "reports" | "recurring" | "ledger"
export function financeNav(supplierId, active = "") {
  const id = String(supplierId);
  const item = (key, href, label) =>
    `<a href="${href}" class="fnav-item${active === key ? " on" : ""}">${label}</a>`;

  return `
  <style>
    .fnav{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:var(--white,#fff);
      border:1px solid var(--border,#e2e8f0);border-radius:12px;padding:8px 10px;margin:8px 0 18px}
    .fnav-item{padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;
      color:var(--text,#1e293b);white-space:nowrap;line-height:1}
    .fnav-item:hover{background:#f1f5f9}
    .fnav-item.on{background:#b45309;color:#fff}
    .fnav-sep{flex:1}
    .fnav-item.rec.on{background:#0369a1}
  </style>
  <nav class="fnav">
    ${item("finance",   `${BASE(id)}/finance`,             "💰 Finance")}
    ${item("reports",   `${BASE(id)}/finance-reports`,     "📊 Reports")}
    <span class="fnav-sep"></span>
    <a href="${BASE(id)}/recurring" class="fnav-item rec${active === "recurring" ? " on" : ""}">🏠 Recurring Billing</a>
    <a href="${BASE(id)}/recurring/ledger" class="fnav-item rec${active === "ledger" ? " on" : ""}">📒 Recurring Ledger</a>
  </nav>`;
}

// A compact "Recurring Billing" quick-access card for the finance hub. Surfaces
// the recurring OPTIONS & FUNCTIONS (new account, generate invoices, reminders,
// ledger) right inside the finance portal, reusing the existing recurring
// routes. `summary` is optional: { accounts, tenants, outstanding, currency }.
export function recurringQuickCard(supplierId, summary = {}) {
  const id  = String(supplierId);
  const cur = summary.currency || "USD";
  const sym = cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$";
  const money = n => `${sym}${Number(n || 0).toFixed(2)}`;
  const hasStats = summary.accounts != null;

  const stat = (val, lbl) =>
    `<div style="text-align:center"><div style="font-size:18px;font-weight:800">${val}</div>
     <div style="font-size:11px;color:var(--muted)">${lbl}</div></div>`;

  return `
  <div style="background:var(--white);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:22px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:20px">🏠</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:15px">Recurring Billing</div>
        <div style="font-size:12px;color:var(--muted)">Rent, school fees, policies &amp; any scheduled charge</div>
      </div>
    </div>

    ${hasStats ? `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:#f8fafc;
      border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px">
      ${stat(summary.accounts || 0, "Accounts")}
      ${stat(summary.tenants || 0, "Tenants")}
      ${stat(money(summary.outstanding || 0), "Owed now")}
    </div>` : ""}

    <div style="display:flex;flex-wrap:wrap;gap:8px">
      <a href="${BASE(id)}/recurring" class="btn" style="background:#0369a1;color:#fff">Open dashboard →</a>
      <a href="${BASE(id)}/recurring/new-account" class="btn btn-gray">➕ New account</a>
      <a href="${BASE(id)}/recurring/ledger" class="btn btn-gray">📒 Ledger</a>
      <a href="${BASE(id)}/finance-reports?view=recurring" class="btn btn-gray">📊 Recurring report</a>
      <form method="POST" action="${BASE(id)}/recurring/bulk-generate" style="display:inline"
        onsubmit="return confirm('Generate this period\\'s invoices for all active accounts?')">
        <button class="btn btn-gray">🧾 Generate invoices</button>
      </form>
      <form method="POST" action="${BASE(id)}/recurring/send-reminders" style="display:inline"
        onsubmit="return confirm('Send WhatsApp payment reminders to tenants who owe?')">
        <button class="btn btn-gray">🔔 Send reminders</button>
      </form>
    </div>
  </div>`;
}
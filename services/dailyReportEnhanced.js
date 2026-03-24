import { sendText }     from "./metaSender.js";
import { sendDocument }  from "./metaSender.js";
import { sendMainMenu }  from "./metaMenus.js";
import { generateReportPDF } from "./reportPDF.js";

// ─── Helpers (exported so weekly/monthly can reuse) ───────────────────────────
export const fmt = (n, cur) => {
  const sym = (cur === "ZWL") ? "ZWL " : (cur === "ZAR") ? "R" : "$";
  return `${sym}${Number(n || 0).toFixed(2)}`;
};
export const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;

export function dateLabel(d) {
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

// ─── Fetch all report data for a period ───────────────────────────────────────
export async function fetchReportData({ biz, start, end, branchId }) {
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;

  const baseQ = { businessId: biz._id, createdAt: { $gte: start, $lte: end } };
  const bQ    = branchId ? { ...baseQ, branchId } : baseQ;

  const [invoices, receipts, payments, expenses] = await Promise.all([
    Invoice.find({ ...bQ, type: "invoice" }).lean(),
    Invoice.find({ ...bQ, type: "receipt" }).lean(),
    InvoicePayment.find(bQ).lean(),
    Expense.find(bQ).lean()
  ]);

  return { invoices, receipts, payments, expenses };
}

// ─── Calculate totals ─────────────────────────────────────────────────────────
export function calcTotals({ invoices, receipts, payments, expenses }) {
  const invoicePayments = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales       = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const moneyIn         = invoicePayments + cashSales;
  const moneyOut        = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const profit          = moneyIn - moneyOut;
  const totalInvoiced   = invoices.reduce((s, i) => s + (i.total  || 0), 0);
  const outstanding     = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  return { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding };
}

// ─── Build plain WhatsApp text summary (always sent before the PDF) ───────────
export function buildWhatsAppSummary({ biz, label, periodLabel, data, totals, branchName }) {
  const { invoices, receipts, payments, expenses } = data;
  const { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding } = totals;
  const cur = biz.currency || "USD";

  const verdict = profit >= 0
    ? `✅ YOU MADE A PROFIT\n💰 Profit: ${fmt(profit, cur)}`
    : `❌ YOU MADE A LOSS\n📉 Loss:   ${fmt(Math.abs(profit), cur)}`;

  const collRate = pct(moneyIn, totalInvoiced + cashSales);
  const branch   = branchName ? `📍 ${branchName}\n` : "";

  // Expenses by category
  const bycat = {};
  for (const e of expenses) {
    const c = e.category || "Other";
    bycat[c] = (bycat[c] || 0) + (e.amount || 0);
  }
  const expLines = Object.entries(bycat).sort((a, b) => b[1] - a[1])
    .map(([c, a]) => `  ${c.padEnd(16)} ${fmt(a, cur)}`).join("\n");

  // Top 3 sellers
  const items = {};
  for (const doc of [...invoices, ...receipts]) {
    for (const it of (doc.items || [])) {
      const n = (it.item || it.name || "Unknown").slice(0, 30);
      if (!items[n]) items[n] = 0;
      items[n] += Number(it.total || 0);
    }
  }
  const topSellers = Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, v]) => `  ${n.padEnd(28)} ${fmt(v, cur)}`).join("\n");

  // Unpaid invoices (top 3)
  const unpaid = invoices.filter(i => (i.balance || 0) > 0)
    .sort((a, b) => (b.balance || 0) - (a.balance || 0)).slice(0, 3)
    .map(i => `  ${i.number} — ${fmt(i.balance, cur)}`).join("\n");

  return `📊 *${biz.name?.toUpperCase()}*  —  ${label}
${periodLabel}
${branch}
━━━━━━━━━━━━━━━━━━━━
${verdict}
━━━━━━━━━━━━━━━━━━━━

MONEY IN:           ${fmt(moneyIn, cur)}
  Invoice payments: ${fmt(invoicePayments, cur)}  (${payments.length})
  Cash sales:       ${fmt(cashSales, cur)}  (${receipts.length})

MONEY OUT:          ${fmt(moneyOut, cur)}
${expLines || "  Nothing spent"}

━━━━━━━━━━━━━━━━━━━━
INVOICES RAISED:    ${fmt(totalInvoiced, cur)}  (${invoices.length})
STILL OWED:         ${fmt(outstanding, cur)}
COLLECTION RATE:    ${collRate}%
${outstanding > 0 ? "\nTop unpaid:\n" + unpaid : ""}
━━━━━━━━━━━━━━━━━━━━
TOP SELLERS
${topSellers || "  No items sold"}
━━━━━━━━━━━━━━━━━━━━
${invoices.length} invoices · ${payments.length} payments · ${receipts.length} sales · ${expenses.length} expenses`;
}

// ─── Resolve caller and branch ────────────────────────────────────────────────
async function resolveCallerAndBranch(biz, from) {
  const UserRole = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");

  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);

  // Look up by phone only (handles UserRole businessId mismatch)
  const caller = await UserRole.findOne({ phone, pending: false });

  const sessionBranchId = biz.sessionData?.reportBranchId || null;
  if (sessionBranchId) {
    delete biz.sessionData.reportBranchId;
    await biz.save();
  }

  const branchId = sessionBranchId ||
    (caller?.role !== "owner" ? caller?.branchId : null);

  let branchName = null;
  if (branchId) {
    const Branch = (await import("../models/branch.js")).default;
    const br = await Branch.findById(branchId).lean();
    branchName = br?.name || null;
  }

  return { caller, branchId: branchId || null, branchName };
}

// ─── Send the report: WhatsApp text + HTML report PDF ─────────────────────────
async function sendReport({ biz, from, label, periodLabel, branchName, branchId, data, totals, prevTotals, weeks }) {
  const cur = biz.currency || "USD";

  // 1. Send WhatsApp text summary immediately
  const summary = buildWhatsAppSummary({ biz, label, periodLabel, data, totals, branchName });
  await sendText(from, summary);

  // 2. Generate and send professional HTML report
  try {
    const { filename, filepath } = await generateReportPDF({
      biz, reportType: label, periodLabel, branchName, data, totals, prevTotals, weeks
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");

    // Try to determine the correct public URL path
    // The file is saved relative to the project's public/docs/generated/reports/ folder
    const reportUrl = `${site}/docs/generated/reports/${filename}`;
    await sendDocument(from, { link: reportUrl, filename });
  } catch (pdfErr) {
    console.error("[REPORT HTML]", pdfErr.message);
  }
}

// ─── DAILY REPORT ─────────────────────────────────────────────────────────────
export async function runDailyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);

  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendReport({
    biz, from,
    label: "Daily Report",
    periodLabel: dateLabel(start),
    branchName, branchId, data, totals,
    prevTotals: null, weeks: null
  });

  await sendMainMenu(from);
  return true;
}
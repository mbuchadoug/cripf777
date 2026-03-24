import { sendText } from "./metaSender.js";
import { sendDocument } from "./metaSender.js";
import { sendButtons } from "./metaSender.js";
import { sendMainMenu } from "./metaMenus.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n, cur) => `$${Number(n || 0).toFixed(2)}`;
const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;
const sign = n => n >= 0 ? "+" : "";

function dateLabel(d) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

async function fetchReportData({ biz, start, end, branchId }) {
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

function calcTotals({ invoices, receipts, payments, expenses }) {
  const invoicePayments = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales       = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const moneyIn         = invoicePayments + cashSales;
  const moneyOut        = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const profit          = moneyIn - moneyOut;
  const totalInvoiced   = invoices.reduce((s, i) => s + (i.total  || 0), 0);
  const outstanding     = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  return { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding };
}

function buildExpenseSection(expenses, cur) {
  if (!expenses.length) return "  Nothing spent\n";
  const bycat = {};
  for (const e of expenses) {
    const cat = e.category || "Other";
    bycat[cat] = (bycat[cat] || 0) + (e.amount || 0);
  }
  return Object.entries(bycat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `  ${cat.padEnd(18)} ${fmt(amt, cur)}`)
    .join("\n") + "\n";
}

function buildProductSection(invoices, receipts, cur) {
  const totals = {};
  const countable = [...invoices, ...receipts];
  for (const doc of countable) {
    for (const item of (doc.items || [])) {
      const name = item.item || item.name || "Unknown";
      if (!totals[name]) totals[name] = { qty: 0, revenue: 0 };
      totals[name].qty     += Number(item.qty   || 1);
      totals[name].revenue += Number(item.total || 0);
    }
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
  if (!sorted.length) return "  No items sold\n";
  return sorted.map(([name, d]) =>
    `  ${name.slice(0, 22).padEnd(22)} × ${d.qty}  ${fmt(d.revenue, cur)}`
  ).join("\n") + "\n";
}

function buildOwedSection(invoices, cur, limit = 5) {
  const unpaid = invoices.filter(i => (i.balance || 0) > 0)
    .sort((a, b) => (b.balance || 0) - (a.balance || 0))
    .slice(0, limit);
  if (!unpaid.length) return "  All invoices fully paid ✅\n";
  return unpaid.map(i =>
    `  ${i.number} — ${fmt(i.balance, cur)}`
  ).join("\n") + "\n";
}

// ─── Build the clean WhatsApp message ────────────────────────────────────────
function buildReportMessage({ biz, label, periodLabel, data, totals, branchName }) {
  const { invoices, receipts, payments, expenses } = data;
  const { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding } = totals;
  const cur = biz.currency || "USD";

  const profitLine = profit >= 0
    ? `✅ YOU MADE A PROFIT\n💰 Profit: ${fmt(profit, cur)}`
    : `❌ YOU MADE A LOSS\n📉 Loss: ${fmt(Math.abs(profit), cur)}`;

  const collectionRate = pct(moneyIn, totalInvoiced + cashSales);

  const branchLine = branchName ? `\n📍 Branch: ${branchName}` : "";

  return `📊 ${biz.name?.toUpperCase()} — ${label}
${periodLabel}${branchLine}

━━━━━━━━━━━━━━━━━━━━
${profitLine}
━━━━━━━━━━━━━━━━━━━━

MONEY IN:            ${fmt(moneyIn, cur)}
  Paid invoices:     ${fmt(invoicePayments, cur)}  (${payments.length} payment${payments.length !== 1 ? "s" : ""})
  Cash sales:        ${fmt(cashSales, cur)}  (${receipts.length} sale${receipts.length !== 1 ? "s" : ""})

MONEY OUT:           ${fmt(moneyOut, cur)}
${buildExpenseSection(expenses, cur)}
━━━━━━━━━━━━━━━━━━━━

INVOICES RAISED:     ${fmt(totalInvoiced, cur)}  (${invoices.length})
STILL OWED TO YOU:   ${fmt(outstanding, cur)}
COLLECTION RATE:     ${collectionRate}%

${outstanding > 0 ? buildOwedSection(invoices, cur) : ""}━━━━━━━━━━━━━━━━━━━━

TOP SELLERS
${buildProductSection(invoices, receipts, cur)}━━━━━━━━━━━━━━━━━━━━
${invoices.length} invoices · ${payments.length} payments · ${receipts.length} sales · ${expenses.length} expenses`;
}

// ─── Build PDF items array from report data ───────────────────────────────────
function buildPDFItems(totals, expenses, cur) {
  const rows = [
    { item: "Money In — Invoice Payments", qty: 1, unit: totals.invoicePayments, total: totals.invoicePayments },
    { item: "Money In — Direct Cash Sales", qty: 1, unit: totals.cashSales, total: totals.cashSales },
  ];
  for (const e of expenses) {
    rows.push({ item: `Expense: ${e.category || "Other"} — ${e.description || ""}`, qty: 1, unit: e.amount, total: e.amount });
  }
  rows.push({ item: "─────────────────", qty: 0, unit: 0, total: 0 });
  rows.push({ item: "NET PROFIT / (LOSS)", qty: 1, unit: totals.profit, total: totals.profit });
  return rows;
}

// ─── DAILY REPORT ─────────────────────────────────────────────────────────────
export async function runDailyReportMetaEnhanced({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");
  const { generatePDF } = await import("../routes/twilio_biz.js");

  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);

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

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);

  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const cur    = biz.currency || "USD";

  const msg = buildReportMessage({
    biz, label: "Daily Report",
    periodLabel: dateLabel(start),
    data, totals, branchName
  });

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);

  // Generate PDF report
  try {
    const reportNum = `RPT-D-${Date.now()}`;
    const { filename } = await generatePDF({
      type: "receipt",
      number: reportNum,
      date: start,
      billingTo: `Daily Report — ${dateLabel(start)}${branchName ? ` (${branchName})` : ""}`,
      items: buildPDFItems(totals, data.expenses, cur),
      bizMeta: {
        name: biz.name, logoUrl: biz.logoUrl,
        address: biz.address || "",
        _id: biz._id.toString(), status: totals.profit >= 0 ? "profit" : "loss"
      }
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
  } catch (e) { console.error("[DAILY REPORT PDF]", e.message); }

  await sendMainMenu(from);
  return true;
}

// Export helpers for weekly/monthly to reuse
export { fetchReportData, calcTotals, buildReportMessage, buildPDFItems, fmt, pct };
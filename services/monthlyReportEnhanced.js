import { sendText } from "./metaSender.js";
import { sendDocument } from "./metaSender.js";
import { sendMainMenu } from "./metaMenus.js";
import {
  fetchReportData, calcTotals, buildReportMessage, buildPDFItems, fmt, pct
} from "./dailyReportEnhanced.js";

export async function runMonthlyReportMetaEnhanced({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");
  const { generatePDF } = await import("../routes/twilio_biz.js");

  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);
  const caller = await UserRole.findOne({ phone, pending: false });

  const sessionBranchId = biz.sessionData?.reportBranchId || null;
  if (sessionBranchId) { delete biz.sessionData.reportBranchId; await biz.save(); }

  const branchId = sessionBranchId || (caller?.role !== "owner" ? caller?.branchId : null);
  let branchName = null;
  if (branchId) {
    const Branch = (await import("../models/branch.js")).default;
    const br = await Branch.findById(branchId).lean();
    branchName = br?.name || null;
  }

  const now        = new Date();
  const start      = new Date(now.getFullYear(), now.getMonth(), 1);
  const end        = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Previous month
  const prevStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevEnd    = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const [data, prevData] = await Promise.all([
    fetchReportData({ biz, start, end, branchId }),
    fetchReportData({ biz, start: prevStart, end: prevEnd, branchId })
  ]);

  const totals     = calcTotals(data);
  const prevTotals = calcTotals(prevData);
  const cur        = biz.currency || "USD";

  // Week-by-week breakdown within the month
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;

  const weeks = [];
  let wStart = new Date(start);
  while (wStart <= end) {
    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 6);
    if (wEnd > end) wEnd.setTime(end.getTime());

    const wQ = { businessId: biz._id, createdAt: { $gte: wStart, $lte: wEnd }, ...(branchId ? { branchId } : {}) };
    const [wPay, wRcpt, wExp] = await Promise.all([
      InvoicePayment.aggregate([{ $match: wQ }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Invoice.aggregate([{ $match: { ...wQ, type: "receipt" } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
      Expense.aggregate([{ $match: wQ }, { $group: { _id: null, total: { $sum: "$amount" } } }])
    ]);

    const wIn  = (wPay[0]?.total || 0) + (wRcpt[0]?.total || 0);
    const wOut = wExp[0]?.total || 0;
    weeks.push({
      label: `${wStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
      in: wIn, out: wOut, profit: wIn - wOut
    });

    wStart = new Date(wEnd);
    wStart.setDate(wStart.getDate() + 1);
    wStart.setHours(0, 0, 0, 0);
  }

  const weekBreakdown = weeks.map((w, i) =>
    `  Wk${i + 1} ${w.label.padEnd(8)} In: ${fmt(w.in, cur).padEnd(10)} Out: ${fmt(w.out, cur).padEnd(10)} ${w.profit >= 0 ? "✅" : "❌"} ${fmt(w.profit, cur)}`
  ).join("\n");

  const growth = (curr, prev) => {
    if (prev === 0) return curr > 0 ? "▲ New" : "";
    const p = Math.round(((curr - prev) / prev) * 100);
    return p > 0 ? `▲ +${p}%` : p < 0 ? `▼ ${p}%` : "→ 0%";
  };

  const monthName = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const prevMonthName = prevStart.toLocaleDateString("en-GB", { month: "long" });

  const baseMsg = buildReportMessage({
    biz, label: "Monthly Report",
    periodLabel: monthName, data, totals, branchName
  });

  const extraSections =
`
━━━━━━━━━━━━━━━━━━━━
WEEK BY WEEK
${weekBreakdown}

━━━━━━━━━━━━━━━━━━━━
VS ${prevMonthName.toUpperCase()}
  Money In:   ${fmt(prevTotals.moneyIn, cur)} → ${fmt(totals.moneyIn, cur)}  ${growth(totals.moneyIn, prevTotals.moneyIn)}
  Money Out:  ${fmt(prevTotals.moneyOut, cur)} → ${fmt(totals.moneyOut, cur)}  ${growth(totals.moneyOut, prevTotals.moneyOut)}
  Profit:     ${fmt(prevTotals.profit, cur)} → ${fmt(totals.profit, cur)}  ${growth(totals.profit, prevTotals.profit)}
`;

  const msg = baseMsg + extraSections;

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);

  try {
    const reportNum = `RPT-M-${Date.now()}`;
    const { filename } = await generatePDF({
      type: "receipt", number: reportNum, date: start,
      billingTo: `Monthly Report — ${monthName}${branchName ? ` (${branchName})` : ""}`,
      items: [
        ...buildPDFItems(totals, data.expenses, cur),
        { item: "─────────────────", qty: 0, unit: 0, total: 0 },
        ...weeks.map((w, i) => ({ item: `Week ${i + 1} (${w.label})`, qty: 1, unit: w.in, total: w.profit }))
      ],
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", _id: biz._id.toString(), status: totals.profit >= 0 ? "profit" : "loss" }
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
  } catch (e) { console.error("[MONTHLY REPORT PDF]", e.message); }

  await sendMainMenu(from);
  return true;
}
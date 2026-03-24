import { sendText }    from "./metaSender.js";
import { sendDocument } from "./metaSender.js";
import { sendMainMenu } from "./metaMenus.js";
import {
  fetchReportData, calcTotals, buildWhatsAppSummary,
  resolveCallerAndBranch, sendReport, fmt
} from "./dailyReportEnhanced.js";

export async function runWeeklyReportMetaEnhanced({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");

  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);
  const caller = await UserRole.findOne({ phone, pending: false });

  const sessionBranchId = biz.sessionData?.reportBranchId || null;
  if (sessionBranchId) { delete biz.sessionData.reportBranchId; await biz.save(); }
  const branchId = sessionBranchId || (caller?.role !== "owner" ? caller?.branchId : null) || null;

  let branchName = null;
  if (branchId) {
    const Branch = (await import("../models/branch.js")).default;
    const br = await Branch.findById(branchId).lean();
    branchName = br?.name || null;
  }

  const end      = new Date(); end.setHours(23, 59, 59, 999);
  const start    = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
  const prevEnd  = new Date(start); prevEnd.setSeconds(prevEnd.getSeconds() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6); prevStart.setHours(0, 0, 0, 0);

  const [data, prevData] = await Promise.all([
    fetchReportData({ biz, start, end, branchId }),
    fetchReportData({ biz, start: prevStart, end: prevEnd, branchId })
  ]);

  const totals     = calcTotals(data);
  const prevTotals = calcTotals(prevData);
  const cur        = biz.currency || "USD";

  const periodLabel = `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

  // WhatsApp summary with comparison appended
  const growth = (curr, prev) => {
    if (prev === 0) return curr > 0 ? " ▲ New" : "";
    const p = Math.round(((curr - prev) / prev) * 100);
    return p > 0 ? ` ▲ +${p}%` : p < 0 ? ` ▼ ${p}%` : " → 0%";
  };

  const baseSummary = buildWhatsAppSummary({ biz, label: "Weekly Report", periodLabel, data, totals, branchName });
  const compSection = `
━━━━━━━━━━━━━━━━━━━━
VS LAST WEEK
  Money In:  ${fmt(prevTotals.moneyIn, cur)} → ${fmt(totals.moneyIn, cur)}${growth(totals.moneyIn, prevTotals.moneyIn)}
  Money Out: ${fmt(prevTotals.moneyOut, cur)} → ${fmt(totals.moneyOut, cur)}${growth(totals.moneyOut, prevTotals.moneyOut)}
  Profit:    ${fmt(prevTotals.profit, cur)} → ${fmt(totals.profit, cur)}${growth(totals.profit, prevTotals.profit)}`;

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendText(from, baseSummary + compSection);

  // Generate professional HTML report
  try {
    const { generateReportPDF } = await import("./reportPDF.js");
    const { filename } = await generateReportPDF({
      biz, reportType: "Weekly Report", periodLabel, branchName,
      data, totals, prevTotals, weeks: null
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/reports/${filename}`, filename });
  } catch (e) { console.error("[WEEKLY REPORT HTML]", e.message); }

  await sendMainMenu(from);
  return true;
}
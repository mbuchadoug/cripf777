/**
 * services/reportPDF.js
 * ─────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  services/reportPDF.js  (NEW FILE)
 * ─────────────────────────────────────────────────────────────
 *
 * Generates professional PDF reports using the same
 * Puppeteer → HTML → PDF pipeline already used for invoices.
 *
 * Exported functions:
 *   generateReportPDF({ biz, reportType, periodLabel, branchName,
 *                        data, totals, prevTotals, weeks,
 *                        ledgerRows, clerkData })
 *
 * reportType values:
 *   "Daily Report"       → P&L summary PDF
 *   "Weekly Report"      → P&L summary + day-by-day trend PDF
 *   "Monthly Report"     → P&L summary + week-by-week breakdown PDF
 *   "Detailed Ledger"    → running-balance ledger PDF  ← main new one
 *   "Clerk Statement"    → per-clerk custody statement PDF
 */

import fs   from "fs";
import path from "path";

// ── Puppeteer (same lazy-load pattern as twilio_biz.js) ──────────────────────
let _puppeteer = null;
async function getPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try { _puppeteer = (await import("puppeteer")).default || (await import("puppeteer")); return _puppeteer; } catch (_) {}
  try { _puppeteer = (await import("puppeteer-core")).default || (await import("puppeteer-core")); return _puppeteer; } catch (_) {}
  return null;
}

// ── Output directory ──────────────────────────────────────────────────────────
async function ensureReportDir() {
  const dir = path.join(process.cwd(), "public", "docs", "generated", "reports");
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// ── Shared HTML helpers ───────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(n, cur = "USD") {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
}

function dt(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function dateOnly(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ── Logo resolver (same logic as twilio_biz.js) ───────────────────────────────
async function resolveLogo(biz) {
  try {
    const localLogo = path.join(process.cwd(), "public", "img", `logo-${biz._id}.png`);
    if (fs.existsSync(localLogo)) {
      const data = await fs.promises.readFile(localLogo);
      return `data:image/png;base64,${data.toString("base64")}`;
    }
    if (biz.logoUrl) return biz.logoUrl;
  } catch (_) {}
  return null;
}

// ── Render HTML → PDF via Puppeteer ─────────────────────────────────────────
async function renderToPdf(html, filepath) {
  const puppeteer = await getPuppeteer();
  if (!puppeteer) throw new Error("Puppeteer not available");
  const opts = {
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(opts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.emulateMediaType("screen");
    await page.pdf({
      path: filepath,
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" }
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════
// SHARED CSS (used by all report PDFs)
// ═══════════════════════════════════════════════════════════════
function baseCSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
      font-size: 12px;
      color: #1f2937;
      background: #fff;
      padding: 28px 32px;
      line-height: 1.5;
    }
    /* ── Header ─────────────────────────────────────────── */
    .rpt-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #111827;
      padding-bottom: 16px;
      margin-bottom: 20px;
    }
    .rpt-logo { max-width: 120px; max-height: 56px; object-fit: contain; margin-bottom: 6px; }
    .rpt-biz-name { font-size: 18px; font-weight: 700; color: #111827; }
    .rpt-biz-addr { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .rpt-title-block { text-align: right; }
    .rpt-title { font-size: 20px; font-weight: 700; color: #111827; text-transform: uppercase; }
    .rpt-subtitle { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .rpt-badge {
      display: inline-block; margin-top: 6px;
      padding: 3px 10px; border-radius: 4px;
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      background: #f3f4f6; color: #374151; border: 1px solid #d1d5db;
    }
    /* ── Section headings ─────────────────────────────── */
    .section-title {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.6px; color: #6b7280;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 4px; margin: 18px 0 8px;
    }
    /* ── Tables ───────────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    th {
      background: #f9fafb;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.4px;
      color: #6b7280; padding: 7px 8px;
      text-align: left;
      border-bottom: 2px solid #e5e7eb;
    }
    th.r, td.r { text-align: right; }
    th.c, td.c { text-align: center; }
    td { padding: 7px 8px; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    tr.stripe td { background: #f9fafb; }
    tr.total-row td {
      font-weight: 700; font-size: 13px;
      border-top: 2px solid #e5e7eb;
      background: #f9fafb;
    }
    tr.grand-total td {
      font-weight: 700; font-size: 14px;
      color: #111827; background: #f3f4f6;
      border-top: 3px solid #111827;
    }
    /* ── Verdict box ──────────────────────────────────── */
    .verdict {
      padding: 12px 16px; border-radius: 6px;
      margin: 16px 0; font-size: 14px; font-weight: 600;
    }
    .verdict.profit { background: #f0fdf4; color: #15803d; border-left: 4px solid #16a34a; }
    .verdict.loss   { background: #fff1f2; color: #be123c; border-left: 4px solid #e11d48; }
    .verdict.even   { background: #f8fafc; color: #475569; border-left: 4px solid #94a3b8; }
    /* ── Two-col layout ───────────────────────────────── */
    .two-col { display: flex; gap: 24px; }
    .two-col > div { flex: 1; }
    /* ── Handover row ─────────────────────────────────── */
    tr.handover-row td {
      background: #eff6ff; color: #1e40af;
      font-weight: 600; font-size: 11px;
      border-top: 1px solid #bfdbfe;
      border-bottom: 1px solid #bfdbfe;
    }
    tr.handover-balanced td { background: #f0fdf4; color: #15803d; }
    tr.handover-short    td { background: #fff1f2; color: #be123c; }
    tr.handover-surplus  td { background: #fffbeb; color: #b45309; }
    /* ── Discrepancy highlight ────────────────────────── */
    .flag-ok      { color: #15803d; font-weight: 600; }
    .flag-short   { color: #be123c; font-weight: 700; }
    .flag-surplus { color: #b45309; font-weight: 700; }
    /* ── Footer ───────────────────────────────────────── */
    .rpt-footer {
      margin-top: 28px; padding-top: 12px;
      border-top: 1px solid #e5e7eb;
      font-size: 10px; color: #9ca3af;
      display: flex; justify-content: space-between;
    }
    /* ── Info boxes ───────────────────────────────────── */
    .info-box {
      background: #f9fafb; border: 1px solid #e5e7eb;
      border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;
    }
    .info-box .label { font-size: 10px; color: #6b7280; text-transform: uppercase; font-weight: 600; margin-bottom: 2px; }
    .info-box .value { font-size: 14px; font-weight: 700; color: #111827; }
    .info-box .sub   { font-size: 11px; color: #6b7280; margin-top: 2px; }
    /* ── KPI grid ─────────────────────────────────────── */
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 12px 0 18px; }
    .kpi { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
    .kpi .kpi-label { font-size: 10px; color: #6b7280; text-transform: uppercase; font-weight: 600; }
    .kpi .kpi-val   { font-size: 16px; font-weight: 700; color: #111827; margin-top: 4px; }
    .kpi .kpi-sub   { font-size: 10px; color: #6b7280; margin-top: 2px; }
    /* ── Overdue ──────────────────────────────────────── */
    .overdue-flag { color: #be123c; font-weight: 600; }
    /* ── Page break ───────────────────────────────────── */
    .page-break { page-break-before: always; }
  `;
}

function reportHeader({ bizName, logoSrc, address, title, subtitle, branch, generated }) {
  return `
  <div class="rpt-header">
    <div>
      ${logoSrc ? `<img src="${esc(logoSrc)}" class="rpt-logo" />` : ""}
      <div class="rpt-biz-name">${esc(bizName)}</div>
      ${address ? `<div class="rpt-biz-addr">${esc(address)}</div>` : ""}
      ${branch ? `<div class="rpt-biz-addr">📍 Branch: ${esc(branch)}</div>` : ""}
    </div>
    <div class="rpt-title-block">
      <div class="rpt-title">${esc(title)}</div>
      <div class="rpt-subtitle">${esc(subtitle)}</div>
      <div class="rpt-subtitle" style="margin-top:4px;font-size:10px;color:#9ca3af;">
        Generated: ${generated}
      </div>
    </div>
  </div>`;
}

function reportFooter(bizName, reportType) {
  return `
  <div class="rpt-footer">
    <span>${esc(bizName)} - ${esc(reportType)}</span>
    <span>Powered by ZimQuote · ${new Date().toLocaleDateString("en-GB")}</span>
  </div>`;
}


// ═══════════════════════════════════════════════════════════════
// HTML BUILDERS
// ═══════════════════════════════════════════════════════════════

// ── 1. Summary Report HTML (Daily / Weekly / Monthly) ───────────────────────
function buildSummaryHTML({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks, incomeStatement, logoSrc, cur }) {
  const { invoices, receipts, payments, expenses } = data;
  const is = incomeStatement;
  const { revenue, expenses: exp, drawings, profit, cashPosition, invoiceSummary, staffActivity, handoverLog } = is;

  const collRate = invoiceSummary.totalInvoiced > 0
    ? Math.round((revenue.invoicePaymentsReceived / invoiceSummary.totalInvoiced) * 100) : 0;

  const verdictClass = profit.netProfit > 0 ? "profit" : profit.netProfit < 0 ? "loss" : "even";
  const verdictText  = profit.netProfit > 0
    ? `✅ Net Profit: ${money(profit.netProfit, cur)}`
    : profit.netProfit < 0
      ? `❌ Net Loss: ${money(Math.abs(profit.netProfit), cur)}`
      : `⚖️ Break-Even`;

  // Expenses by category rows
  const expRows = Object.entries(exp.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map((([cat, amt], i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td>${esc(cat)}</td>
        <td class="r">${money(amt, cur)}</td>
      </tr>`)).join("") || `<tr><td colspan="2" style="color:#9ca3af">No expenses recorded</td></tr>`;

  // Drawings rows
  const drawRows = drawings.drawings.length
    ? drawings.drawings.map((d, i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td>${dt(d.createdAt)}</td>
        <td>${esc(d.reason || "Drawing")}</td>
        <td>${esc(d.recordedByName || "Unknown")}</td>
        <td>${esc(d.recordedByRole || "")}</td>
        <td class="r">${money(d.amount, cur)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:#9ca3af">No drawings recorded</td></tr>`;

  // Staff activity rows
  const staffRows = staffActivity.length
    ? staffActivity.map((s, i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td>${esc(s.name || "Unknown")}</td>
        <td>${esc(s.role || "")}</td>
        <td class="c">${s.invoiceCount}</td>
        <td class="c">${s.receiptCount}</td>
        <td class="c">${s.expenseCount}</td>
        <td class="r">${money(s.totalRevenue, cur)}</td>
        <td class="r">${money(s.totalExpenses, cur)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="color:#9ca3af">No staff activity</td></tr>`;

  // Handover rows
  const handoverRows = handoverLog.length
    ? handoverLog.map((h, i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td>${esc(h.date)} ${esc(h.time)}</td>
        <td>${esc(h.outgoing)} <span style="color:#6b7280">(${esc(h.outgoingRole)})</span></td>
        <td>${esc(h.incoming)} <span style="color:#6b7280">(${esc(h.incomingRole)})</span></td>
        <td class="r">${money(h.amountCounted, cur)}</td>
        <td>${esc(h.notes || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:#9ca3af">No handovers recorded</td></tr>`;

  // Week-by-week rows (monthly only)
  const weekRows = weeks?.length
    ? weeks.map((w, i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td>Week ${i + 1} - ${esc(w.label)}</td>
        <td class="r">${money(w.in, cur)}</td>
        <td class="r">${money(w.out, cur)}</td>
        <td class="r ${w.profit >= 0 ? "flag-ok" : "flag-short"}">${money(w.profit, cur)}</td>
      </tr>`).join("") : "";

  // vs previous period (weekly/monthly)
  const prevSection = prevTotals ? `
    <div class="section-title">Comparison - Previous Period</div>
    <table>
      <thead><tr>
        <th>Metric</th><th class="r">Previous</th><th class="r">Current</th><th class="r">Change</th>
      </tr></thead>
      <tbody>
        ${[
          ["Revenue", prevTotals.moneyIn, totals.moneyIn],
          ["Expenses", prevTotals.moneyOut, totals.moneyOut],
          ["Profit", prevTotals.profit, totals.profit]
        ].map(([label, prev, curr]) => {
          const diff = curr - prev;
          const pct2 = prev !== 0 ? Math.round((diff / Math.abs(prev)) * 100) : (curr > 0 ? 100 : 0);
          const cls  = diff >= 0 ? "flag-ok" : "flag-short";
          return `<tr>
            <td>${label}</td>
            <td class="r">${money(prev, cur)}</td>
            <td class="r">${money(curr, cur)}</td>
            <td class="r ${cls}">${diff >= 0 ? "▲" : "▼"} ${Math.abs(pct2)}%</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>${esc(reportType)} - ${esc(biz.name)}</title>
  <style>${baseCSS()}</style></head><body>

  ${reportHeader({
    bizName: biz.name, logoSrc, address: biz.address,
    title: reportType, subtitle: periodLabel,
    branch: branchName,
    generated: dt(new Date())
  })}

  <!-- KPI STRIP -->
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Gross Revenue</div>
      <div class="kpi-val">${money(revenue.grossRevenue, cur)}</div>
      <div class="kpi-sub">${invoiceSummary.payments} pmts · ${invoiceSummary.receipts} sales</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Expenses</div>
      <div class="kpi-val">${money(exp.totalExpenses, cur)}</div>
      <div class="kpi-sub">${expenses.length} transactions</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Net Profit</div>
      <div class="kpi-val" style="color:${profit.netProfit >= 0 ? "#15803d" : "#be123c"}">${money(profit.netProfit, cur)}</div>
      <div class="kpi-sub">After drawings</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Collection Rate</div>
      <div class="kpi-val">${collRate}%</div>
      <div class="kpi-sub">${money(invoiceSummary.totalOutstanding, cur)} outstanding</div>
    </div>
  </div>

  <div class="verdict ${verdictClass}">${verdictText}</div>

  <!-- INCOME STATEMENT -->
  <div class="section-title">Income Statement</div>
  <table>
    <thead><tr><th>Description</th><th class="r">Amount (${cur})</th></tr></thead>
    <tbody>
      <tr><td>Invoice Payments Received</td><td class="r">${money(revenue.invoicePaymentsReceived, cur)}</td></tr>
      <tr class="stripe"><td>Cash Sales (Receipts)</td><td class="r">${money(revenue.cashSales, cur)}</td></tr>
      <tr class="total-row"><td>GROSS REVENUE</td><td class="r">${money(revenue.grossRevenue, cur)}</td></tr>
      <tr><td style="color:#be123c">Operating Expenses</td><td class="r" style="color:#be123c">(${money(exp.totalExpenses, cur)})</td></tr>
      <tr class="total-row"><td>OPERATING PROFIT</td><td class="r">${money(profit.operatingProfit, cur)}</td></tr>
      <tr><td style="color:#be123c">Owner Drawings</td><td class="r" style="color:#be123c">(${money(drawings.totalDrawings, cur)})</td></tr>
      ${drawings.totalOtherPayouts > 0 ? `<tr><td style="color:#be123c">Other Payouts</td><td class="r" style="color:#be123c">(${money(drawings.totalOtherPayouts, cur)})</td></tr>` : ""}
      <tr class="grand-total"><td>NET PROFIT / (LOSS)</td><td class="r">${money(profit.netProfit, cur)}</td></tr>
    </tbody>
  </table>

  <!-- CASH POSITION -->
  <div class="section-title">Cash Position</div>
  <table>
    <tbody>
      <tr><td>Opening Balance</td><td class="r">${money(cashPosition.openingBalance, cur)}</td></tr>
      <tr class="stripe"><td>+ Cash In</td><td class="r">${money(cashPosition.cashIn, cur)}</td></tr>
      <tr><td>− Cash Out (expenses + drawings + payouts)</td><td class="r">(${money(cashPosition.cashOut, cur)})</td></tr>
      <tr class="grand-total"><td>CLOSING BALANCE</td><td class="r">${money(cashPosition.closingBalance, cur)}</td></tr>
    </tbody>
  </table>

  <div class="two-col">
    <div>
      <!-- EXPENSES BY CATEGORY -->
      <div class="section-title">Expenses by Category</div>
      <table>
        <thead><tr><th>Category</th><th class="r">Amount</th></tr></thead>
        <tbody>${expRows}
          <tr class="total-row"><td>Total Expenses</td><td class="r">${money(exp.totalExpenses, cur)}</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <!-- INVOICE SUMMARY -->
      <div class="section-title">Invoice Summary</div>
      <table>
        <tbody>
          <tr><td>Invoices Raised</td><td class="r">${money(invoiceSummary.totalInvoiced, cur)}</td></tr>
          <tr class="stripe"><td>Payments Collected</td><td class="r">${money(revenue.invoicePaymentsReceived, cur)}</td></tr>
          <tr><td>Still Outstanding</td><td class="r" style="color:#b45309">${money(invoiceSummary.totalOutstanding, cur)}</td></tr>
          <tr class="total-row"><td>Collection Rate</td><td class="r">${collRate}%</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- OWNER DRAWINGS -->
  <div class="section-title">Owner Drawings & Payouts</div>
  <table>
    <thead><tr><th>Date/Time</th><th>Description</th><th>Recorded By</th><th>Role</th><th class="r">Amount</th></tr></thead>
    <tbody>${drawRows}
      <tr class="total-row"><td colspan="4">Total Drawings</td><td class="r">${money(drawings.totalDrawings, cur)}</td></tr>
    </tbody>
  </table>

  <!-- STAFF ACTIVITY -->
  <div class="section-title">Staff Activity</div>
  <table>
    <thead><tr><th>Name</th><th>Role</th><th class="c">Invoices</th><th class="c">Receipts</th><th class="c">Expenses</th><th class="r">Revenue Recorded</th><th class="r">Expenses Recorded</th></tr></thead>
    <tbody>${staffRows}</tbody>
  </table>

  <!-- SHIFT HANDOVERS -->
  <div class="section-title">Shift Handovers</div>
  <table>
    <thead><tr><th>Date/Time</th><th>Outgoing</th><th>Incoming</th><th class="r">Cash Counted</th><th>Notes</th></tr></thead>
    <tbody>${handoverRows}</tbody>
  </table>

  ${weeks?.length ? `
  <!-- WEEK BY WEEK (MONTHLY) -->
  <div class="section-title">Week-by-Week Breakdown</div>
  <table>
    <thead><tr><th>Period</th><th class="r">Revenue</th><th class="r">Expenses</th><th class="r">Profit</th></tr></thead>
    <tbody>${weekRows}</tbody>
  </table>` : ""}

  ${prevSection}

  ${reportFooter(biz.name, reportType)}
  </body></html>`;
}


// ── 2. Detailed Ledger HTML ──────────────────────────────────────────────────
function buildLedgerHTML({ biz, periodLabel, branchName, ledgerRows, openingBalance, closingBalance, cur, logoSrc }) {
  const totalIn  = ledgerRows.reduce((s, r) => s + (r.credit || 0), 0);
  const totalOut = ledgerRows.reduce((s, r) => s + (r.debit  || 0), 0);

  const rows = ledgerRows.map((row, i) => {
    if (row.isHandover) {
      const diff   = (row.amountCounted || 0) - row.balance;
      const ok     = Math.abs(diff) < 0.01;
      const surp   = diff > 0.01;
      const cls    = ok ? "handover-balanced" : surp ? "handover-surplus" : "handover-short";
      const flag   = ok ? "✅ Balanced" : surp ? `⚠️ Surplus +${money(diff, cur)}` : `❌ Short ${money(diff, cur)}`;
      return `<tr class="handover-row ${cls}">
        <td colspan="2">🔄 SHIFT HANDOVER</td>
        <td colspan="2">${esc(row.description)}</td>
        <td>-</td>
        <td class="r">Counted: ${money(row.amountCounted, cur)}</td>
        <td></td>
        <td class="r">${money(row.balance, cur)}</td>
        <td colspan="1">${flag}</td>
      </tr>`;
    }
    const cls = i % 2 === 1 ? "stripe" : "";
    const typeColor = row.type === "EXPENSE" || row.type === "DRAWING" || row.type === "PAYOUT"
      ? "color:#be123c" : row.type === "INVOICE_PMT" || row.type === "CASH_SALE" ? "color:#15803d" : "";
    return `<tr class="${cls}">
      <td style="white-space:nowrap;font-size:11px">${dt(row.at)}</td>
      <td><span style="${typeColor};font-size:11px;font-weight:500">${esc(row.typeLabel || "")}</span></td>
      <td style="font-size:11px">${esc(row.description || "")}</td>
      <td style="font-size:11px">${esc(row.recorder || "")}</td>
      <td style="font-size:11px;color:#6b7280">${esc(row.role || "")}</td>
      <td class="r" style="color:#15803d;font-weight:500">${row.credit > 0 ? money(row.credit, cur) : ""}</td>
      <td class="r" style="color:#be123c;font-weight:500">${row.debit  > 0 ? money(row.debit,  cur) : ""}</td>
      <td class="r" style="font-weight:600">${money(row.balance, cur)}</td>
      <td style="font-size:10px;color:#9ca3af">${esc(row.ref || "")}</td>
    </tr>`;
  }).join("");

  const netChange = closingBalance - openingBalance;
  const netClass  = netChange >= 0 ? "flag-ok" : "flag-short";

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Detailed Ledger - ${esc(biz.name)}</title>
  <style>
    ${baseCSS()}
    body { font-size: 11px; padding: 20px 24px; }
    th, td { padding: 5px 7px; }
    th { font-size: 9px; }
    td { font-size: 11px; }
  </style></head><body>

  ${reportHeader({
    bizName: biz.name, logoSrc, address: biz.address,
    title: "Detailed Transaction Ledger", subtitle: periodLabel,
    branch: branchName, generated: dt(new Date())
  })}

  <!-- SUMMARY STRIP -->
  <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi">
      <div class="kpi-label">Opening Balance</div>
      <div class="kpi-val">${money(openingBalance, cur)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total In (+)</div>
      <div class="kpi-val" style="color:#15803d">${money(totalIn, cur)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Out (−)</div>
      <div class="kpi-val" style="color:#be123c">${money(totalOut, cur)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Closing Balance</div>
      <div class="kpi-val">${money(closingBalance, cur)}</div>
      <div class="kpi-sub ${netClass}">Net: ${netChange >= 0 ? "+" : ""}${money(netChange, cur)}</div>
    </div>
  </div>

  <!-- LEDGER TABLE -->
  <div class="section-title">Transaction Ledger - ${esc(periodLabel)}</div>
  <table>
    <thead>
      <tr>
        <th style="width:110px">Date / Time</th>
        <th style="width:110px">Type</th>
        <th>Description</th>
        <th style="width:100px">Recorded By</th>
        <th style="width:55px">Role</th>
        <th class="r" style="width:80px">IN (+)</th>
        <th class="r" style="width:80px">OUT (−)</th>
        <th class="r" style="width:85px">Balance</th>
        <th style="width:60px">Ref</th>
      </tr>
    </thead>
    <tbody>
      <tr style="background:#f0fdf4">
        <td colspan="7" style="color:#15803d;font-weight:600">OPENING BALANCE</td>
        <td class="r" style="font-weight:700;color:#15803d">${money(openingBalance, cur)}</td>
        <td></td>
      </tr>
      ${rows}
      <tr class="grand-total">
        <td colspan="5">CLOSING BALANCE</td>
        <td class="r" style="color:#15803d">${money(totalIn, cur)}</td>
        <td class="r" style="color:#be123c">(${money(totalOut, cur)})</td>
        <td class="r">${money(closingBalance, cur)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <div style="margin-top:12px;font-size:11px;color:#6b7280">
    ${ledgerRows.filter(r => !r.isHandover).length} transactions recorded
    · ${ledgerRows.filter(r => r.isHandover).length} shift handovers
    · ${ledgerRows.filter(r => r.type === "DRAWING").length} drawings
  </div>

  ${reportFooter(biz.name, "Detailed Ledger")}
  </body></html>`;
}


// ── 3. Clerk Statement HTML ──────────────────────────────────────────────────
function buildClerkStatementHTML({ biz, periodLabel, branchName, clerkData, logoSrc, cur }) {
  const {
    clerkName, clerkRole, openingCustody, openingSource,
    txRows, handoversIn, handoversOut,
    expectedClosing, handedOver, discrepancy, totalIn, totalOut
  } = clerkData;

  const txTableRows = txRows.length
    ? txRows.map((row, i) => `
      <tr class="${i % 2 === 1 ? "stripe" : ""}">
        <td style="white-space:nowrap;font-size:11px">${dt(row.at)}</td>
        <td style="font-size:11px;font-weight:500;${row.credit > 0 ? "color:#15803d" : "color:#be123c"}">${esc(row.typeLabel || "")}</td>
        <td style="font-size:11px">${esc(row.description || "")}</td>
        <td class="r" style="color:#15803d;font-weight:500">${row.credit > 0 ? money(row.credit, cur) : ""}</td>
        <td class="r" style="color:#be123c;font-weight:500">${row.debit  > 0 ? money(row.debit,  cur) : ""}</td>
        <td class="r" style="font-weight:700">${money(row.balance, cur)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:16px">No transactions recorded this period</td></tr>`;

  const handInRows = handoversIn.length
    ? handoversIn.map(h => `
      <tr>
        <td>${dt(h.handoverAt)}</td>
        <td>${esc(h.outgoingName || "Unknown")}</td>
        <td>${esc(h.outgoingRole || "")}</td>
        <td class="r" style="color:#15803d;font-weight:600">${money(h.amountCounted, cur)}</td>
        <td>${esc(h.notes || "")}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:#9ca3af">Opening balance used (no handover-in recorded)</td></tr>`;

  const handOutRows = handoversOut.length
    ? handoversOut.map(h => {
        const diff = h.amountCounted - expectedClosing;
        const ok   = Math.abs(diff) < 0.01;
        const cls  = ok ? "flag-ok" : diff > 0 ? "flag-surplus" : "flag-short";
        const flag = ok ? "✅ Balanced" : diff > 0 ? `⚠️ Surplus +${money(diff, cur)}` : `❌ Short ${money(Math.abs(diff), cur)}`;
        return `<tr>
          <td>${dt(h.handoverAt)}</td>
          <td>${esc(h.incomingName || "Unknown")}</td>
          <td>${esc(h.incomingRole || "")}</td>
          <td class="r">${money(h.amountCounted, cur)}</td>
          <td class="${cls}">${flag}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" style="color:#9ca3af">No handover-out recorded (shift may still be open)</td></tr>`;

  const reconcile = handedOver !== null
    ? (Math.abs(discrepancy) < 0.01
        ? `<div class="verdict profit">✅ BALANCED - Expected ${money(expectedClosing, cur)}, Counted ${money(handedOver, cur)}</div>`
        : discrepancy > 0
          ? `<div class="verdict" style="background:#fffbeb;color:#b45309;border-left:4px solid #d97706">⚠️ SURPLUS - Counted ${money(handedOver, cur)}, Expected ${money(expectedClosing, cur)}. Difference: +${money(discrepancy, cur)}</div>`
          : `<div class="verdict loss">❌ SHORT - Counted ${money(handedOver, cur)}, Expected ${money(expectedClosing, cur)}. Difference: ${money(discrepancy, cur)}</div>`)
    : `<div class="verdict even">⏳ Shift still open - Current balance in custody: ${money(expectedClosing, cur)}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Clerk Statement - ${esc(clerkName)}</title>
  <style>
    ${baseCSS()}
    body { font-size: 12px; }
  </style></head><body>

  ${reportHeader({
    bizName: biz.name, logoSrc, address: biz.address,
    title: "Clerk Statement",
    subtitle: `${esc(clerkName)} (${esc(clerkRole)}) · ${esc(periodLabel)}`,
    branch: branchName, generated: dt(new Date())
  })}

  <!-- CLERK KPIs -->
  <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi">
      <div class="kpi-label">Opening Custody</div>
      <div class="kpi-val">${money(openingCustody, cur)}</div>
      <div class="kpi-sub">${esc(openingSource)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Received</div>
      <div class="kpi-val" style="color:#15803d">+${money(totalIn, cur)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Paid Out</div>
      <div class="kpi-val" style="color:#be123c">−${money(totalOut, cur)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Expected Closing</div>
      <div class="kpi-val">${money(expectedClosing, cur)}</div>
    </div>
  </div>

  <!-- RECONCILIATION -->
  ${reconcile}

  <!-- CASH RECEIVED (handovers in) -->
  <div class="section-title">Cash Received at Start of Shift</div>
  <table>
    <thead><tr>
      <th>Date/Time</th><th>Received From</th><th>Their Role</th>
      <th class="r">Amount</th><th>Notes</th>
    </tr></thead>
    <tbody>${handInRows}</tbody>
  </table>

  <!-- TRANSACTIONS -->
  <div class="section-title">All Transactions Recorded by ${esc(clerkName)}</div>
  <table>
    <thead><tr>
      <th style="width:110px">Date/Time</th>
      <th style="width:120px">Type</th>
      <th>Description</th>
      <th class="r" style="width:90px">IN (+)</th>
      <th class="r" style="width:90px">OUT (−)</th>
      <th class="r" style="width:90px">Balance</th>
    </tr></thead>
    <tbody>
      <tr style="background:#f0fdf4">
        <td colspan="5" style="color:#15803d;font-weight:600">Opening Custody Balance</td>
        <td class="r" style="font-weight:700;color:#15803d">${money(openingCustody, cur)}</td>
      </tr>
      ${txTableRows}
      <tr class="grand-total">
        <td colspan="3">Totals / Closing Balance</td>
        <td class="r" style="color:#15803d">+${money(totalIn, cur)}</td>
        <td class="r" style="color:#be123c">−${money(totalOut, cur)}</td>
        <td class="r">${money(expectedClosing, cur)}</td>
      </tr>
    </tbody>
  </table>

  <!-- CASH HANDED OUT -->
  <div class="section-title">Cash Handed Out at End of Shift</div>
  <table>
    <thead><tr>
      <th>Date/Time</th><th>Handed To</th><th>Their Role</th>
      <th class="r">Amount Counted</th><th>Status</th>
    </tr></thead>
    <tbody>${handOutRows}</tbody>
  </table>

  ${reportFooter(biz.name, "Clerk Statement")}
  </body></html>`;
}


// ═══════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════
export async function generateReportPDF({
  biz,
  reportType,       // "Daily Report" | "Weekly Report" | "Monthly Report" | "Detailed Ledger" | "Clerk Statement"
  periodLabel,
  branchName,
  data,             // { invoices, receipts, payments, expenses }
  totals,           // calcTotals result
  prevTotals,       // optional
  weeks,            // optional - monthly week-by-week array
  incomeStatement,  // pre-built IS object (optional, built here if not provided)
  ledgerRows,       // for Detailed Ledger - pre-built ledger.rows
  openingBalance,   // for Detailed Ledger
  closingBalance,   // for Detailed Ledger
  clerkData,        // for Clerk Statement - buildClerkStatement result
}) {
  const dir      = await ensureReportDir();
  const slug     = reportType.toLowerCase().replace(/\s+/g, "-");
  const filename = `${slug}-${biz._id}-${Date.now()}.pdf`;
  const filepath = path.join(dir, filename);
  const logoSrc  = await resolveLogo(biz);
  const cur      = biz.currency || "USD";

  let html;

  if (reportType === "Detailed Ledger") {
    if (!ledgerRows) throw new Error("ledgerRows required for Detailed Ledger PDF");
    html = buildLedgerHTML({ biz, periodLabel, branchName, ledgerRows, openingBalance: openingBalance || 0, closingBalance: closingBalance || 0, cur, logoSrc });

  } else if (reportType === "Clerk Statement") {
    if (!clerkData) throw new Error("clerkData required for Clerk Statement PDF");
    html = buildClerkStatementHTML({ biz, periodLabel, branchName, clerkData, logoSrc, cur });

  } else {
    // Summary reports (Daily / Weekly / Monthly)
    // Build income statement if not already provided
    let is = incomeStatement;
    if (!is && data) {
      const { buildIncomeStatement } = await import("./reportHelpers.js");
      is = await buildIncomeStatement({ biz, data, branchId: null, start: new Date(0), end: new Date(), openingBalance: 0 });
    }
    html = buildSummaryHTML({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks, incomeStatement: is, logoSrc, cur });
  }

  await renderToPdf(html, filepath);

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/reports/${filename}`;

  return { filepath, filename, url };
}
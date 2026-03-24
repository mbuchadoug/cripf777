/**
 * reportPDF.js
 * Generates a professional, styled HTML Business Report
 * Saved to /docs/generated/reports/ and sent as a WhatsApp document
 *
 * Works independently of twilio_biz.js - no receipt template used.
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Where to save report files ───────────────────────────────────────────────
function getReportDir() {
  // Try common project paths
  const candidates = [
    path.join(__dirname, "../public/docs/generated/reports"),
    path.join(__dirname, "../../public/docs/generated/reports"),
    path.join(__dirname, "../docs/generated/reports"),
    path.join(__dirname, "docs/generated/reports"),
  ];
  for (const p of candidates) {
    try {
      fs.mkdirSync(p, { recursive: true });
      return p;
    } catch (_) {}
  }
  // Fallback to temp
  const fallback = "/tmp/reports";
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

// ─── Currency formatter ────────────────────────────────────────────────────────
function money(n, cur = "USD") {
  const symbol = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R" : "$";
  return `${symbol}${Number(n || 0).toFixed(2)}`;
}

function pct(a, b) {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

// ─── Build expense rows HTML ───────────────────────────────────────────────────
function buildExpenseRows(expenses, cur) {
  if (!expenses.length) return `<div class="empty-row">Nothing spent</div>`;
  const bycat = {};
  for (const e of expenses) {
    const cat = e.category || "Other";
    bycat[cat] = (bycat[cat] || 0) + (e.amount || 0);
  }
  return Object.entries(bycat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `
      <div class="data-row">
        <span class="row-label">${cat}</span>
        <span class="row-value neg">${money(amt, cur)}</span>
      </div>`)
    .join("");
}

// ─── Build top sellers HTML ────────────────────────────────────────────────────
function buildProductRows(invoices, receipts, cur) {
  const totals = {};
  for (const doc of [...invoices, ...receipts]) {
    for (const item of (doc.items || [])) {
      const name = (item.item || item.name || "Unknown").slice(0, 40);
      if (!totals[name]) totals[name] = { qty: 0, revenue: 0 };
      totals[name].qty     += Number(item.qty   || 1);
      totals[name].revenue += Number(item.total || 0);
    }
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8);
  if (!sorted.length) return `<div class="empty-row">No items sold</div>`;
  return sorted.map(([name, d], i) => `
    <div class="product-row">
      <span class="rank">${i + 1}</span>
      <span class="product-name">${name}</span>
      <span class="product-qty">×${d.qty}</span>
      <span class="product-rev">${money(d.revenue, cur)}</span>
    </div>`).join("");
}

// ─── Build owed rows HTML ──────────────────────────────────────────────────────
function buildOwedRows(invoices, cur) {
  const unpaid = invoices.filter(i => (i.balance || 0) > 0)
    .sort((a, b) => (b.balance || 0) - (a.balance || 0))
    .slice(0, 8);
  if (!unpaid.length) return `<div class="all-paid">✅ All invoices fully paid</div>`;
  return unpaid.map(inv => `
    <div class="owed-row">
      <span class="owed-num">${inv.number}</span>
      <span class="owed-client">${inv.clientName || ""}</span>
      <span class="owed-amt">${money(inv.balance, cur)}</span>
    </div>`).join("");
}

// ─── Build week breakdown rows (monthly report) ────────────────────────────────
function buildWeekRows(weeks, cur) {
  return weeks.map((w, i) => `
    <div class="week-row ${w.profit >= 0 ? "week-profit" : "week-loss"}">
      <span class="week-label">Week ${i + 1} - ${w.label}</span>
      <span class="week-in">In: ${money(w.in, cur)}</span>
      <span class="week-out">Out: ${money(w.out, cur)}</span>
      <span class="week-profit-val ${w.profit >= 0 ? "pos" : "neg"}">${w.profit >= 0 ? "+" : ""}${money(w.profit, cur)}</span>
    </div>`).join("");
}

// ─── Comparison row (weekly/monthly) ─────────────────────────────────────────
function compRow(label, prev, curr, cur) {
  const diff = curr - prev;
  const p    = prev > 0 ? Math.round((diff / prev) * 100) : (curr > 0 ? 100 : 0);
  const cls  = diff >= 0 ? "pos" : "neg";
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "→";
  return `
    <div class="comp-row">
      <span class="comp-label">${label}</span>
      <span class="comp-prev">${money(prev, cur)}</span>
      <span class="comp-arrow ${cls}">${arrow}</span>
      <span class="comp-curr">${money(curr, cur)}</span>
      <span class="comp-pct ${cls}">${diff >= 0 ? "+" : ""}${p}%</span>
    </div>`;
}

// ─── Full HTML template ────────────────────────────────────────────────────────
function buildHTML({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks }) {
  const { invoices, receipts, payments, expenses } = data;
  const { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding } = totals;
  const cur = biz.currency || "USD";

  const isProfit      = profit >= 0;
  const collRate      = pct(moneyIn, totalInvoiced + cashSales);
  const profitMargin  = pct(profit, moneyIn);
  const branchBadge   = branchName ? `<span class="branch-badge">📍 ${branchName}</span>` : "";
  const verdictClass  = isProfit ? "verdict-profit" : "verdict-loss";
  const verdictIcon   = isProfit ? "✅" : "❌";
  const verdictText   = isProfit
    ? `YOU MADE A PROFIT &nbsp;·&nbsp; ${money(profit, cur)}`
    : `YOU MADE A LOSS &nbsp;·&nbsp; ${money(Math.abs(profit), cur)}`;

  // Comparison section (weekly / monthly)
  let compSection = "";
  if (prevTotals) {
    const compTitle = reportType === "Weekly Report" ? "VS LAST WEEK" : `VS PREVIOUS ${reportType === "Monthly Report" ? "MONTH" : "PERIOD"}`;
    compSection = `
      <div class="section">
        <div class="section-title">${compTitle}</div>
        ${compRow("Money In",  prevTotals.moneyIn,  moneyIn,  cur)}
        ${compRow("Money Out", prevTotals.moneyOut, moneyOut, cur)}
        ${compRow("Profit",    prevTotals.profit,   profit,   cur)}
      </div>`;
  }

  // Week breakdown section (monthly only)
  let weekSection = "";
  if (weeks && weeks.length) {
    weekSection = `
      <div class="section">
        <div class="section-title">WEEK BY WEEK</div>
        ${buildWeekRows(weeks, cur)}
      </div>`;
  }

  const now = new Date().toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reportType} - ${biz.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #eef2f7;
      padding: 24px;
      color: #2d3748;
      font-size: 14px;
      line-height: 1.5;
    }

    .page {
      max-width: 820px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
    }

    /* ── HEADER ── */
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
      color: white;
      padding: 36px 40px 28px;
      position: relative;
    }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; }
    .biz-name { font-size: 26px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
    .report-label {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #a0c4ff;
    }
    .period { font-size: 15px; color: #90cdf4; margin-top: 10px; }
    .branch-badge {
      display: inline-block;
      background: rgba(104,211,145,0.2);
      color: #9ae6b4;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      margin-top: 10px;
      border: 1px solid rgba(104,211,145,0.3);
    }
    .watermark {
      position: absolute;
      right: 40px;
      bottom: 20px;
      font-size: 11px;
      color: rgba(255,255,255,0.2);
      letter-spacing: 2px;
    }

    /* ── VERDICT ── */
    .verdict-profit {
      padding: 18px 40px;
      font-size: 17px;
      font-weight: 700;
      background: #f0fff4;
      color: #22543d;
      border-left: 6px solid #38a169;
      border-bottom: 1px solid #c6f6d5;
    }
    .verdict-loss {
      padding: 18px 40px;
      font-size: 17px;
      font-weight: 700;
      background: #fff5f5;
      color: #742a2a;
      border-left: 6px solid #e53e3e;
      border-bottom: 1px solid #fed7d7;
    }

    /* ── SUMMARY CARDS ── */
    .cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0;
      border-bottom: 1px solid #e8edf2;
    }
    .card {
      padding: 20px 24px;
      border-right: 1px solid #e8edf2;
      text-align: center;
    }
    .card:last-child { border-right: none; }
    .card-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #a0aec0;
      margin-bottom: 8px;
    }
    .card-value { font-size: 20px; font-weight: 700; color: #1a202c; }
    .card-value.green { color: #276749; }
    .card-value.red   { color: #c53030; }
    .card-sub { font-size: 11px; color: #a0aec0; margin-top: 4px; }

    /* ── BODY ── */
    .body { padding: 0 40px 32px; }

    .section { margin-top: 28px; }
    .section-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #a0aec0;
      padding-bottom: 10px;
      border-bottom: 2px solid #edf2f7;
      margin-bottom: 12px;
      font-weight: 600;
    }

    /* ── DATA ROWS ── */
    .data-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid #f7fafc;
      font-size: 14px;
    }
    .data-row:last-child { border-bottom: none; }
    .row-label { color: #4a5568; }
    .row-sublabel { font-size: 12px; color: #a0aec0; margin-left: 8px; }
    .row-value { font-weight: 600; }
    .row-value.pos, .pos { color: #276749; }
    .row-value.neg, .neg { color: #c53030; }
    .row-indent { padding-left: 20px; background: #fafafa; }
    .row-total {
      display: flex;
      justify-content: space-between;
      padding: 12px 0 8px;
      border-top: 2px solid #e2e8f0;
      font-size: 16px;
      font-weight: 700;
      margin-top: 6px;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px;
      margin-top: 28px;
    }

    /* ── PRODUCTS ── */
    .product-row {
      display: flex;
      align-items: center;
      padding: 9px 10px;
      margin-bottom: 4px;
      background: #f8fafc;
      border-radius: 6px;
      font-size: 13px;
    }
    .rank {
      width: 22px;
      height: 22px;
      background: #e2e8f0;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 10px;
      color: #718096;
      flex-shrink: 0;
    }
    .product-name { flex: 1; color: #2d3748; }
    .product-qty  { color: #718096; font-size: 12px; margin-right: 12px; }
    .product-rev  { font-weight: 700; color: #2d6a4f; min-width: 70px; text-align: right; }

    /* ── OWED ── */
    .owed-row {
      display: flex;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid #fff5f5;
      font-size: 13px;
    }
    .owed-num    { color: #718096; min-width: 100px; }
    .owed-client { flex: 1; color: #4a5568; }
    .owed-amt    { font-weight: 700; color: #c53030; }
    .all-paid    { color: #276749; padding: 10px 0; font-size: 14px; }

    /* ── COMPARISON ── */
    .comp-row {
      display: flex;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid #f7fafc;
      font-size: 13px;
    }
    .comp-label { flex: 1; color: #4a5568; }
    .comp-prev  { min-width: 90px; text-align: right; color: #a0aec0; font-size: 12px; }
    .comp-arrow { width: 24px; text-align: center; font-size: 12px; }
    .comp-curr  { min-width: 90px; text-align: right; font-weight: 600; }
    .comp-pct   { min-width: 55px; text-align: right; font-size: 12px; font-weight: 700; }

    /* ── WEEK ROWS ── */
    .week-row {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      margin-bottom: 5px;
      border-radius: 6px;
      font-size: 13px;
      background: #f8fafc;
    }
    .week-label       { flex: 1; color: #4a5568; font-weight: 600; }
    .week-in          { min-width: 100px; text-align: right; color: #276749; font-size: 12px; }
    .week-out         { min-width: 100px; text-align: right; color: #c53030; font-size: 12px; }
    .week-profit-val  { min-width: 90px; text-align: right; font-weight: 700; }

    .empty-row { color: #a0aec0; font-style: italic; padding: 10px 0; font-size: 13px; }

    /* ── FOOTER ── */
    .footer {
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      padding: 16px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #a0aec0;
    }
    .footer-brand { font-weight: 700; color: #718096; letter-spacing: 1px; }

    @media print {
      body { background: white; padding: 0; }
      .page { box-shadow: none; border-radius: 0; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-top">
      <div class="biz-name">${biz.name || "Business"}</div>
      <div class="report-label">${reportType}</div>
    </div>
    <div class="period">${periodLabel}</div>
    ${branchBadge}
    <div class="watermark">ZIMQUOTE</div>
  </div>

  <!-- VERDICT -->
  <div class="${verdictClass}">${verdictIcon} &nbsp; ${verdictText}</div>

  <!-- SUMMARY CARDS -->
  <div class="cards">
    <div class="card">
      <div class="card-label">Money In</div>
      <div class="card-value green">${money(moneyIn, cur)}</div>
      <div class="card-sub">${payments.length + receipts.length} transactions</div>
    </div>
    <div class="card">
      <div class="card-label">Money Out</div>
      <div class="card-value red">${money(moneyOut, cur)}</div>
      <div class="card-sub">${expenses.length} expense${expenses.length !== 1 ? "s" : ""}</div>
    </div>
    <div class="card">
      <div class="card-label">Invoices Raised</div>
      <div class="card-value">${money(totalInvoiced, cur)}</div>
      <div class="card-sub">${invoices.length} invoice${invoices.length !== 1 ? "s" : ""}</div>
    </div>
    <div class="card">
      <div class="card-label">Still Owed</div>
      <div class="card-value ${outstanding > 0 ? "red" : "green"}">${money(outstanding, cur)}</div>
      <div class="card-sub">${collRate}% collection rate</div>
    </div>
  </div>

  <div class="body">

    <!-- MONEY IN / OUT -->
    <div class="section">
      <div class="section-title">Money Flow</div>

      <div class="data-row">
        <span class="row-label"> Invoice Payments Received</span>
        <span class="row-value pos">${money(invoicePayments, cur)} <span class="row-sublabel">(${payments.length})</span></span>
      </div>
      <div class="data-row">
        <span class="row-label"> Direct Cash Sales</span>
        <span class="row-value pos">${money(cashSales, cur)} <span class="row-sublabel">(${receipts.length})</span></span>
      </div>
      <div class="data-row row-indent">
        <span class="row-label" style="font-weight:600">Total Money In</span>
        <span class="row-value pos" style="font-size:15px">${money(moneyIn, cur)}</span>
      </div>

      <div style="margin-top:12px">
        ${buildExpenseRows(expenses, cur)}
      </div>
      <div class="data-row row-indent" style="margin-top:4px">
        <span class="row-label" style="font-weight:600">Total Money Out</span>
        <span class="row-value neg" style="font-size:15px">${money(moneyOut, cur)}</span>
      </div>

      <div class="row-total">
        <span>${isProfit ? "✅ NET PROFIT" : "❌ NET LOSS"}</span>
        <span class="${isProfit ? "pos" : "neg"}">${isProfit ? "+" : ""}${money(profit, cur)}</span>
      </div>
    </div>

    <!-- TWO COLUMN: TOP SELLERS + OWED -->
    <div class="two-col">
      <div>
        <div class="section-title">Top Sellers</div>
        ${buildProductRows(invoices, receipts, cur)}
      </div>
      <div>
        <div class="section-title">Still Owed to You</div>
        ${buildOwedRows(invoices, cur)}
      </div>
    </div>

    <!-- COMPARISON (weekly/monthly) -->
    ${compSection}

    <!-- WEEK BREAKDOWN (monthly only) -->
    ${weekSection}

  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div>${invoices.length} invoices · ${payments.length} payments · ${receipts.length} sales · ${expenses.length} expenses</div>
    <div>Generated ${now}</div>
    <div class="footer-brand">ZIMQUOTE</div>
  </div>

</div>
</body>
</html>`;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function generateReportPDF({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks }) {
  const html     = buildHTML({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks });
  const reportDir = getReportDir();
  const filename  = `report-${Date.now()}.html`;
  const filepath  = path.join(reportDir, filename);

  fs.writeFileSync(filepath, html, "utf8");

  return { filename, filepath };
}
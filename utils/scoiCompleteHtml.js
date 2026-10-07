// utils/scoiCompleteHtml.js
// Renders ANY SCOI audit object into clean, COMPLETE, world-class HTML — nothing
// is left out, nothing overlaps. Self-contained (scoped styles), works on the
// website and in the PDF, and handles any unique report structure.

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function humanize(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bUsd\b/gi, "USD").replace(/\bScoi\b/gi, "SCOI").replace(/\bPdf\b/gi, "PDF")
    .replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
const isMoneyKey = (k) => /USD|amount|price|value|contribution|worth|cost|capital|net.?worth/i.test(k);
function fmtVal(key, v) {
  if (typeof v === "number") {
    if (isMoneyKey(key) && Math.abs(v) >= 1000) return "$" + v.toLocaleString("en-US");
    return v.toLocaleString("en-US");
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return esc(v);
}

function renderValue(key, val, depth) {
  if (val === null || val === undefined || val === "") return `<span class="sc-empty">—</span>`;
  if (Array.isArray(val)) {
    if (val.every((x) => x === null || typeof x !== "object")) {
      return `<ul class="sc-list">${val.map((x) => `<li>${fmtVal(key, x)}</li>`).join("")}</ul>`;
    }
    return `<div class="sc-arr">${val.map((x, i) =>
      `<div class="sc-arr-item"><span class="sc-arr-idx">${i + 1}</span><div class="sc-arr-body">${renderObject(x, depth + 1)}</div></div>`).join("")}</div>`;
  }
  if (typeof val === "object") return renderObject(val, depth + 1);
  const s = String(val);
  if (s.length > 120) return `<p class="sc-text">${esc(s)}</p>`;
  return `<span class="sc-val">${fmtVal(key, val)}</span>`;
}

function renderObject(obj, depth = 0) {
  if (obj === null || typeof obj !== "object") return `<span class="sc-val">${esc(obj)}</span>`;
  const rows = Object.entries(obj).map(([k, v]) => {
    const isBlock = v && typeof v === "object";
    return `<div class="sc-row${isBlock ? " sc-row-block" : ""}">
      <div class="sc-key">${esc(humanize(k))}</div>
      <div class="sc-field">${renderValue(k, v, depth)}</div>
    </div>`;
  });
  return `<div class="sc-obj${depth > 0 ? " sc-nested" : ""}">${rows.join("")}</div>`;
}

export function scoiCompleteHtml(audit) {
  if (!audit || typeof audit !== "object") return "";
  const skip = new Set(["_id", "__v", "raw", "pdfUrl", "isPaid", "createdAt", "updatedAt", "framework", "auditClass"]);
  const entries = Object.entries(audit).filter(([k, v]) => !skip.has(k) && v !== undefined);
  const title = audit.title || (audit.subject && audit.subject.name) || "SCOI Report";
  const code = audit.reportCode || "";
  const author = audit.author || "Donald Mataranyika";
  const sections = entries.map(([k, v], i) =>
    `<section class="sc-section">
       <div class="sc-sec-head"><span class="sc-sec-num">${String(i + 1).padStart(2, "0")}</span><h2 class="sc-sec-title">${esc(humanize(k))}</h2></div>
       <div class="sc-sec-body">${renderValue(k, v, 0)}</div>
     </section>`
  ).join("");
  return `${STYLE}<div class="sc-complete">
    <header class="sc-cover">
      <div class="sc-eyebrow">CRIPFCnt SCOI Framework · Complete Intelligence Report</div>
      <h1 class="sc-cover-title">${esc(title)}</h1>
      ${audit.subject && audit.subject.name ? `<div class="sc-cover-sub">${esc(audit.subject.name)}</div>` : ""}
      ${code ? `<div class="sc-cover-code">${esc(code)}</div>` : ""}
      <div class="sc-cover-rule"></div>
      <div class="sc-cover-author">${esc(author)}</div>
    </header>${sections}
    <footer class="sc-foot">CRIPFCnt SCOI Framework · Confidential Intelligence Report · This document preserves the full submitted content.</footer>
  </div>`;
}

const STYLE = `<style>
.sc-complete{
  --navy:#0F1C2E;--navy2:#1E3A5F;--gold:#B8943F;--gold2:#C9A961;--cream:#FBFAF7;
  --ln:#E8E6E0;--g400:#9AA2AD;--g500:#6B7280;--g700:#374151;--g900:#14202E;
  --serif:'Crimson Pro',Georgia,'Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;
  font-family:var(--serif);color:var(--g900);background:var(--cream);
  max-width:880px;margin:0 auto;padding:0 clamp(16px,4vw,28px) 72px;
  -webkit-font-smoothing:antialiased;line-height:1.5;
}
.sc-complete *{box-sizing:border-box;min-width:0;}
.sc-complete p,.sc-complete li,.sc-complete .sc-val,.sc-complete .sc-key{overflow-wrap:anywhere;word-break:break-word;hyphens:auto;}
/* Cover */
.sc-cover{background:linear-gradient(140deg,var(--navy),var(--navy2));color:#fff;border-radius:18px;
  padding:clamp(32px,6vw,52px) clamp(24px,5vw,40px);margin:28px 0 32px;text-align:center;}
.sc-eyebrow{font-family:var(--sans);font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold2);margin-bottom:16px;font-weight:600;}
.sc-cover-title{font-size:clamp(1.7rem,5vw,2.5rem);line-height:1.12;font-weight:700;margin:0 0 8px;letter-spacing:-.01em;}
.sc-cover-sub{font-family:var(--sans);font-size:1.05rem;opacity:.9;font-weight:500;}
.sc-cover-code{font-family:var(--sans);font-size:.72rem;letter-spacing:.14em;opacity:.55;margin-top:12px;text-transform:uppercase;}
.sc-cover-rule{width:60px;height:3px;background:var(--gold);margin:22px auto 16px;border-radius:2px;}
.sc-cover-author{font-family:var(--sans);font-size:.82rem;opacity:.8;letter-spacing:.02em;}
/* Section */
.sc-section{background:#fff;border:1px solid var(--ln);border-radius:16px;
  padding:clamp(22px,3.5vw,32px);margin-bottom:20px;box-shadow:0 1px 2px rgba(15,28,46,.04);}
.sc-sec-head{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--ln);padding-bottom:14px;margin-bottom:20px;}
.sc-sec-num{font-family:var(--sans);font-weight:800;color:var(--gold);font-size:.9rem;letter-spacing:.06em;flex:0 0 auto;}
.sc-sec-title{font-size:clamp(1.15rem,2.6vw,1.45rem);font-weight:700;margin:0;color:var(--navy);letter-spacing:-.01em;line-height:1.2;}
.sc-sec-body{font-size:1.02rem;}
/* Key/value rows */
.sc-obj{display:flex;flex-direction:column;}
.sc-row{display:grid;grid-template-columns:minmax(0,210px) minmax(0,1fr);gap:8px 24px;
  padding:12px 0;border-bottom:1px solid #F3F2EE;align-items:start;}
.sc-row:first-child{padding-top:0;}
.sc-row:last-child{border-bottom:none;padding-bottom:0;}
.sc-row-block{grid-template-columns:1fr;gap:10px;}
.sc-key{font-family:var(--sans);font-size:.8rem;font-weight:600;color:var(--g500);line-height:1.4;padding-top:2px;}
.sc-row-block>.sc-key{color:var(--navy);font-size:.95rem;font-weight:700;letter-spacing:-.005em;}
.sc-field{font-size:1rem;line-height:1.55;}
.sc-val{font-weight:600;color:var(--g900);}
.sc-text{margin:0;line-height:1.65;color:var(--g700);}
.sc-empty{color:var(--g400);}
.sc-list{margin:2px 0 0;padding-left:22px;line-height:1.7;}
.sc-list li{margin-bottom:3px;}
/* Nested objects get a soft inset so hierarchy is obvious (no overlap) */
.sc-nested{border-left:2px solid var(--ln);padding-left:16px;margin-top:4px;}
/* Arrays of objects → clean numbered cards */
.sc-arr{display:flex;flex-direction:column;gap:12px;margin-top:4px;}
.sc-arr-item{display:flex;gap:14px;background:#FAFAF8;border:1px solid var(--ln);border-radius:12px;padding:16px 18px;}
.sc-arr-idx{font-family:var(--sans);font-weight:800;color:var(--gold);font-size:.82rem;flex:0 0 auto;padding-top:2px;}
.sc-arr-body{flex:1 1 auto;min-width:0;}
.sc-arr .sc-row{grid-template-columns:minmax(0,170px) minmax(0,1fr);padding:8px 0;}
.sc-foot{font-family:var(--sans);font-size:.72rem;color:var(--g500);text-align:center;margin-top:28px;padding-top:18px;border-top:1px solid var(--ln);line-height:1.6;}
@media(max-width:620px){
  .sc-row,.sc-arr .sc-row{grid-template-columns:1fr;gap:3px;}
  .sc-key{padding-top:0;}
}
@media print{
  .sc-complete{background:#fff;}
  .sc-section{page-break-inside:avoid;box-shadow:none;}
  .sc-cover{page-break-after:avoid;}
}
</style>`;

export default scoiCompleteHtml;
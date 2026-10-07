// utils/scoiCompleteHtml.js
// Renders ANY SCOI audit object into clean, COMPLETE HTML - nothing is left out.
// Self-contained (scoped styles), so it works both on the website and in the PDF,
// and handles unique report structures without a bespoke template per report.

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function humanize(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
const isMoneyKey = (k) => /USD|amount|price|value|contribution|worth|cost|capital/i.test(k);
function fmtVal(key, v) {
  if (typeof v === "number") {
    if (isMoneyKey(key) && Math.abs(v) >= 1000) return "$" + v.toLocaleString("en-US");
    return v.toLocaleString("en-US");
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return esc(v);
}

function renderValue(key, val) {
  if (val === null || val === undefined || val === "") return `<span class="sc-empty">-</span>`;
  if (Array.isArray(val)) {
    if (val.every((x) => x === null || typeof x !== "object")) {
      return `<ul class="sc-list">${val.map((x) => `<li>${fmtVal(key, x)}</li>`).join("")}</ul>`;
    }
    return `<div class="sc-arr">${val.map((x, i) =>
      `<div class="sc-arr-item"><span class="sc-arr-idx">${i + 1}</span><div class="sc-arr-body">${renderObject(x)}</div></div>`).join("")}</div>`;
  }
  if (typeof val === "object") return renderObject(val);
  const s = String(val);
  if (s.length > 140) return `<p class="sc-text">${esc(s)}</p>`;
  return `<span class="sc-val">${fmtVal(key, val)}</span>`;
}

function renderObject(obj) {
  if (obj === null || typeof obj !== "object") return `<span class="sc-val">${esc(obj)}</span>`;
  const rows = Object.entries(obj).map(([k, v]) => {
    const isBlock = v && typeof v === "object";
    return `<div class="sc-row${isBlock ? " sc-row-block" : ""}"><div class="sc-key">${esc(humanize(k))}</div><div class="sc-field">${renderValue(k, v)}</div></div>`;
  });
  return `<div class="sc-obj">${rows.join("")}</div>`;
}

export function scoiCompleteHtml(audit) {
  if (!audit || typeof audit !== "object") return "";
  const skip = new Set(["_id", "__v", "raw", "pdfUrl", "isPaid", "createdAt", "updatedAt", "framework", "auditClass"]);
  const entries = Object.entries(audit).filter(([k, v]) => !skip.has(k) && v !== undefined);
  const title = audit.title || (audit.subject && audit.subject.name) || "SCOI Report";
  const code = audit.reportCode || "";
  const sections = entries.map(([k, v], i) =>
    `<section class="sc-section"><div class="sc-sec-head"><span class="sc-sec-num">${String(i + 1).padStart(2, "0")}</span><h2 class="sc-sec-title">${esc(humanize(k))}</h2></div><div class="sc-sec-body">${renderValue(k, v)}</div></section>`
  ).join("");
  return `${STYLE}<div class="sc-complete">
    <header class="sc-cover">
      <div class="sc-eyebrow">CRIPFCnt SCOI Framework · Complete Intelligence Report</div>
      <h1 class="sc-cover-title">${esc(title)}</h1>
      ${audit.subject && audit.subject.name ? `<div class="sc-cover-sub">${esc(audit.subject.name)}</div>` : ""}
      ${code ? `<div class="sc-cover-code">${esc(code)}</div>` : ""}
    </header>${sections}
    <footer class="sc-foot">Donald Mataranyika · CRIPFCnt SCOI Framework · This report preserves the full submitted content.</footer>
  </div>`;
}

const STYLE = `<style>
.sc-complete{--navy:#0F1C2E;--gold:#B8943F;--cream:#FAFAF7;--g200:#E5E7EB;--g500:#6B7280;--g900:#111827;
  font-family:'Crimson Pro',Georgia,serif;color:var(--g900);background:var(--cream);max-width:860px;margin:0 auto;padding:0 20px 60px;}
.sc-cover{background:var(--navy);color:#fff;border-radius:16px;padding:40px 32px;margin:24px 0 28px;text-align:center;}
.sc-eyebrow{font-family:'Inter',sans-serif;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin-bottom:12px;}
.sc-cover-title{font-size:2rem;line-height:1.15;font-weight:700;margin:0 0 6px;}
.sc-cover-sub{font-family:'Inter',sans-serif;font-size:1rem;opacity:.85;}
.sc-cover-code{font-family:'Inter',sans-serif;font-size:.75rem;letter-spacing:.1em;opacity:.6;margin-top:10px;}
.sc-section{background:#fff;border:1px solid var(--g200);border-radius:14px;padding:22px 24px;margin-bottom:16px;}
.sc-sec-head{display:flex;align-items:baseline;gap:12px;border-bottom:2px solid var(--gold);padding-bottom:10px;margin-bottom:14px;}
.sc-sec-num{font-family:'Inter',sans-serif;font-weight:800;color:var(--gold);font-size:.95rem;}
.sc-sec-title{font-size:1.25rem;font-weight:700;margin:0;color:var(--navy);}
.sc-obj{display:flex;flex-direction:column;gap:2px;}
.sc-row{display:grid;grid-template-columns:230px 1fr;gap:16px;padding:8px 0;border-bottom:1px solid #F1F3F5;align-items:start;}
.sc-row:last-child{border-bottom:none;}
.sc-row-block{grid-template-columns:1fr;gap:6px;}
.sc-key{font-family:'Inter',sans-serif;font-size:.82rem;font-weight:600;color:var(--g500);text-transform:none;}
.sc-row-block>.sc-key{color:var(--navy);font-size:.9rem;font-weight:700;}
.sc-field{font-size:1rem;}
.sc-val{font-weight:600;}
.sc-text{margin:0;line-height:1.55;}
.sc-empty{color:#9CA3AF;}
.sc-list{margin:4px 0 0;padding-left:20px;line-height:1.5;}
.sc-arr{display:flex;flex-direction:column;gap:10px;margin-top:6px;}
.sc-arr-item{display:flex;gap:12px;background:#F8F9FA;border:1px solid var(--g200);border-radius:10px;padding:12px 14px;}
.sc-arr-idx{font-family:'Inter',sans-serif;font-weight:800;color:var(--gold);font-size:.8rem;min-width:20px;}
.sc-arr-body{flex:1;}
.sc-arr .sc-row{grid-template-columns:190px 1fr;}
.sc-foot{font-family:'Inter',sans-serif;font-size:.72rem;color:var(--g500);text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid var(--g200);}
@media(max-width:640px){.sc-row,.sc-arr .sc-row{grid-template-columns:1fr;gap:2px;}.sc-cover-title{font-size:1.5rem;}}
</style>`;

export default scoiCompleteHtml;
// routes/quoteDeskAdmin.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote Admin → 📝 QUOTE DESK  (web version of the WhatsApp desk)
//
// Registered from routes/supplierAdmin.js (same router, login and layout):
//   import { registerQuoteDeskAdminRoutes } from "./quoteDeskAdmin.js";
//   registerQuoteDeskAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat });
//
//   /zq-admin/quote-desk            inbox (tabs, search, stats, share link)
//   /zq-admin/quote-desk/new        log a phone-in / walk-in request
//   /zq-admin/quote-desk/:id        request: sellers (suggested - you choose),
//                                   quote builder → PDF → send, chat, connect
// ═════════════════════════════════════════════════════════════════════════════
import QuoteRequest from "../models/quoteRequest.js";
import SupplierProfile from "../models/supplierProfile.js";
import {
  suggestSellers, sendToSellers, buildAndSendQuote, messageCustomer, messageSeller,
  forwardSellerReply, shareContacts, setStatus, adminCreateRequest, parseQuoteLines,
  quoteRequestLink, qRef, displayPhone, normPhone, resendQuote,
  sendInvoice, recordPayment, recordCost, booksSummary, syncBooks
} from "../services/quoteDesk.js";

const isId = id => /^[a-f0-9]{24}$/i.test(String(id || ""));
const money = n => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const fmt = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare" }) : "-";
const ago = d => { if (!d) return "-"; const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const qr = (data, s = 160) => `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&data=${encodeURIComponent(data)}&qzone=2`;
const STATUS = {
  new: ["🆕 New", "red"], working: ["🛠 Working", "orange"], sent_to_sellers: ["🏪 With sellers", "blue"],
  quoted: ["🧾 Quoted", "purple"], accepted: ["✅ Accepted", "green"], won: ["🏆 Won", "green"],
  lost: ["➖ Lost", "gray"], closed: ["🔒 Closed", "gray"], cancelled: ["❌ Cancelled", "gray"]
};
const OPEN = ["new", "working", "sent_to_sellers", "quoted", "accepted"];

export function registerQuoteDeskAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat }) {
  const sb = s => badge((STATUS[s] || [s])[0], (STATUS[s] || [0, "gray"])[1]);
  const flash = req =>
    (req.query.success ? `<div style="background:#dcfce7;color:#166534;padding:12px 14px;border-radius:8px;margin-bottom:14px">✅ ${esc(req.query.success)}</div>` : "") +
    (req.query.error ? `<div class="alert red" style="margin-bottom:14px">❌ ${esc(req.query.error)}</div>` : "");
  const go = (res, url, k, m) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(m)}`);
  const nav = active => `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <a class="btn btn-sm ${active === "inbox" ? "btn-blue" : "btn-gray"}" href="/zq-admin/quote-desk">📝 Quote Desk</a>
    <a class="btn btn-sm ${active === "new" ? "btn-green" : "btn-gray"}" href="/zq-admin/quote-desk/new">➕ Log a request</a></div>`;

  // ═══════════════════════════════════════════════════════════════════════════
  // INBOX
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/quote-desk", requireSupplierAdmin, async (req, res) => {
    try {
      const { tab = "open", q = "" } = req.query;
      const f = {};
      if (tab === "open") f.status = { $in: OPEN };
      else if (tab === "done") f.status = { $in: ["won"] };
      else if (tab === "closed") f.status = { $in: ["lost", "closed", "cancelled"] };
      else if (tab !== "all") f.status = tab;
      if (q.trim()) {
        const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const ph = normPhone(q);
        f.$or = [{ ref: rx }, { text: rx }, { city: rx }, { area: rx }, { customerName: rx }, ...(ph.length >= 9 ? [{ customerPhone: ph }, { "sellers.phone": ph }] : [])];
      }
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
      const [list, nNew, nOpen, nToday, wonMonth] = await Promise.all([
        QuoteRequest.find(f).sort({ lastActivityAt: -1 }).limit(150).lean(),
        QuoteRequest.countDocuments({ status: "new" }),
        QuoteRequest.countDocuments({ status: { $in: OPEN } }),
        QuoteRequest.countDocuments({ createdAt: { $gte: day } }),
        QuoteRequest.find({ status: "won", closedAt: { $gte: month } }, { dealValue: 1, commission: 1 }).lean()
      ]);
      const dealSum = wonMonth.reduce((s, r) => s + (Number(r.dealValue) || 0), 0);
      const comSum = wonMonth.reduce((s, r) => s + (Number(r.commission) || 0), 0);
      const tabs = [["open", "Open"], ["new", "🆕 New"], ["sent_to_sellers", "With sellers"], ["quoted", "Quoted"], ["accepted", "Accepted"], ["done", "🏆 Won"], ["closed", "Lost / closed"], ["all", "All"]]
        .map(([v, l]) => `<a class="btn btn-sm ${tab === v ? "btn-blue" : "btn-gray"}" href="/zq-admin/quote-desk?tab=${v}">${l}</a>`).join(" ");
      const rows = list.map(r => {
        const replied = (r.sellers || []).filter(s => s.status === "replied").length;
        return `<tr${r.status === "new" ? ' style="background:#fff7ed"' : ""}>
          <td><a class="btn-link" href="/zq-admin/quote-desk/${r._id}"><strong>${esc(qRef(r))}</strong></a><br><small class="muted">${fmt(r.createdAt)}</small></td>
          <td>${esc(r.customerName || "")}<br><small>${esc(displayPhone(r.customerPhone))}</small></td>
          <td style="max-width:340px">${esc(String(r.text || "").slice(0, 140))}${(r.photos || []).length ? " 📷" : ""}</td>
          <td>${esc([r.area, r.city].filter(Boolean).join(", "))}</td>
          <td>${sb(r.status)}</td>
          <td>${(r.sellers || []).length} sent · <strong>${replied}</strong> replied</td>
          <td>${(r.quotes || []).length ? `${(r.quotes || []).length} · ${money(r.quotes[r.quotes.length - 1].total)}` : "-"}</td>
          <td><small>${ago(r.lastActivityAt)}</small></td></tr>`;
      }).join("");
      const link = quoteRequestLink();
      res.send(layout("Quote Desk", `
${nav("inbox")}${flash(req)}
<div class="stats-grid">
  ${stat(nNew, "🆕 New - need action", "red")}${stat(nOpen, "Open requests", "blue")}${stat(nToday, "Requests today", "teal")}
  ${stat(wonMonth.length, "Won this month", "green")}${stat(money(dealSum), "Deal value (month)", "green")}${stat(money(comSum), "Your commission (month)", "purple")}
</div>
<div class="panel"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
  <img src="${qr(link, 110)}" width="110" height="110" alt="QR">
  <div style="flex:1;min-width:240px"><strong>📲 Share "Request a Quote"</strong><br>
  <small class="muted">Opens WhatsApp with "Request a quote" typed - they press Send and describe what they need.</small><br>
  <input value="${esc(link)}" readonly style="width:100%;margin-top:6px;font-size:13px" onclick="this.select()"></div></div></div>
<div class="panel">
  <div class="panel-head"><div style="display:flex;gap:6px;flex-wrap:wrap">${tabs}</div>
    <form class="filter-form" method="GET"><input type="hidden" name="tab" value="${esc(tab)}"><input name="q" value="${esc(q)}" placeholder="Ref, phone, words, area"><button>Search</button></form></div>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Ref</th><th>Customer</th><th>Request</th><th>Where</th><th>Status</th><th>Sellers</th><th>Quotes</th><th>Activity</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">Nothing here.</td></tr>`}</tbody>
  </table></div>
</div>`));
    } catch (e) { res.send(layout("Quote Desk", `<div class="alert red">${esc(e.message)}</div>`)); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LOG A REQUEST (phone-in / walk-in)
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/quote-desk/new", requireSupplierAdmin, (req, res) => {
    res.send(layout("Quote Desk", `
${nav("new")}${flash(req)}
<div class="panel edit-form" style="max-width:720px"><h3>➕ Log a quote request</h3>
<p class="muted" style="margin-bottom:12px">For customers who call, walk in or message you directly. They'll get updates and the quotation on WhatsApp.</p>
<form method="POST" action="/zq-admin/quote-desk/new">
  <div class="form-grid">
    <div class="fg"><label>Customer WhatsApp *</label><input name="customerPhone" required placeholder="0772 123 456"></div>
    <div class="fg"><label>Customer name</label><input name="customerName" placeholder="Mr Moyo"></div>
  </div>
  <div class="fg full"><label>What do they need? *</label><textarea name="text" rows="4" required placeholder="20 bags cement 50kg, 3m³ river sand, delivered to Avondale"></textarea></div>
  <div class="fg"><label>City (blank = detect from the text)</label><input name="city" placeholder="Harare"></div>
  <label style="display:block;margin:10px 0"><input type="checkbox" name="notify" value="1" checked> Tell the customer on WhatsApp that we received it</label>
  <div class="form-actions"><button class="btn btn-green">Create request</button></div>
</form></div>`));
  });
  router.post("/quote-desk/new", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const doc = await adminCreateRequest({ customerPhone: b.customerPhone, customerName: String(b.customerName || "").trim(), text: b.text, city: String(b.city || "").trim(), notifyCustomer: b.notify === "1" });
      go(res, `/zq-admin/quote-desk/${doc._id}`, "success", `Created ${doc.ref}.`);
    } catch (e) { go(res, "/zq-admin/quote-desk/new", "error", e.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REQUEST DETAIL
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/quote-desk/:id", requireSupplierAdmin, async (req, res) => {
    if (!isId(req.params.id)) return res.redirect("/zq-admin/quote-desk");
    try {
      let r = await QuoteRequest.findById(req.params.id).lean();
      if (!r) return res.redirect("/zq-admin/quote-desk");
      if (r.books?.invoiceId || (r.books?.costs || []).length) r = (await syncBooks(r._id)) || r;
      const id = String(r._id);
      const sugg = OPEN.includes(r.status) ? await suggestSellers(r, 20).catch(() => []) : [];
      const sentIds = new Set((r.sellers || []).map(s => String(s.supplierId)));
      const winOk = r.customerLastMsgAt && Date.now() - new Date(r.customerLastMsgAt) < 23 * 3600e3;

      const suggRows = sugg.map(x => {
        const s = x.supplier;
        return `<tr><td><input type="checkbox" name="sid" value="${s._id}" ${sentIds.has(String(s._id)) ? "disabled" : ""}></td>
          <td><a class="btn-link" href="/zq-admin/suppliers/${s._id}" target="_blank">${esc(s.businessName || "Seller")}</a>${sentIds.has(String(s._id)) ? " <small class='muted'>(sent)</small>" : ""}</td>
          <td>${esc([s.location?.area, s.location?.city].filter(Boolean).join(", "))}</td>
          <td>${x.active ? badge("✅ Paid/trial", "green") : badge("💤 Unpaid", "orange")}</td>
          <td><small>${esc(s.profileType || "")}</small></td><td>${x.score}</td></tr>`;
      }).join("");

      const sellerRows = (r.sellers || []).map(s => {
        const sid = String(s.supplierId || "");
        const ok = isId(sid);
        return `<tr><td><strong>${esc(s.name)}</strong><br><small>${esc(displayPhone(s.phone))}</small>${s.wasActive ? "" : " " + badge("unpaid", "orange")}</td>
          <td>${badge(s.status, s.status === "replied" ? "green" : s.status === "declined" ? "gray" : "blue")}<br><small class="muted">${ago(s.replyAt || s.sentAt)}</small></td>
          <td style="max-width:330px">${s.replyText ? `<div style="white-space:pre-wrap">${esc(s.replyText)}</div>` : ""}${s.replyImage ? `<a href="${esc(s.replyImage)}" target="_blank"><img src="${esc(s.replyImage)}" style="max-width:120px;border-radius:6px;margin-top:4px"></a>` : ""}${!s.replyText && !s.replyImage ? "<span class='muted'>-</span>" : ""}
            ${s.replyText ? `<br><button type="button" class="btn btn-sm btn-gray" style="margin-top:6px" onclick="useReply(${JSON.stringify(s.replyText).replace(/"/g, "&quot;")},'${sid}')">⬇ Use in quote</button>` : ""}</td>
          <td><small>${s.customerPhoneShared ? "✅ has customer #" : "🔒 no customer #"}<br>${s.sellerPhoneShared ? "✅ customer has theirs" : "🔒 customer hasn't theirs"}</small></td>
          <td>${ok ? `
            ${s.replyText || s.replyImage ? `<form method="POST" action="/zq-admin/quote-desk/${id}/forward" style="margin-bottom:4px"><input type="hidden" name="sid" value="${sid}"><button class="btn btn-sm btn-blue">📤 Forward price</button></form>` : ""}
            <form method="POST" action="/zq-admin/quote-desk/${id}/share" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px"><input type="hidden" name="sid" value="${sid}">
              <button class="btn btn-sm btn-gray" name="mode" value="c" title="Seller gets customer's number">➡️ Give seller cust #</button>
              <button class="btn btn-sm btn-gray" name="mode" value="s" title="Customer gets seller's number">⬅️ Give cust seller #</button>
              <button class="btn btn-sm btn-green" name="mode" value="b">🔁 Both</button></form>
            <form method="POST" action="/zq-admin/quote-desk/${id}/seller-message" style="display:flex;gap:4px"><input type="hidden" name="sid" value="${sid}"><input name="text" placeholder="Message seller…" required style="flex:1"><button class="btn btn-sm btn-gray">Send</button></form>` : ""}</td></tr>`;
      }).join("");

      const quoteRows = (r.quotes || []).map((q, i) => `<tr><td><a class="btn-link" href="${esc(q.pdfUrl)}" target="_blank">📄 ${esc(q.number)}</a></td>
        <td>${q.kind === "seller" ? "🏪 " + esc(q.sellerName) : "🟢 ZimQuote"}</td><td><strong>${money(q.total)}</strong></td>
        <td><small>${q.sentAt ? fmt(q.sentAt) : "not sent"}${q.deliveryPending ? "<br>📬 queued (24h window)" : ""}</small></td>
        <td>${q.response ? badge(q.response, q.response === "accepted" ? "green" : "gray") : "<small class='muted'>no reply yet</small>"}</td>
        <td><form method="POST" action="/zq-admin/quote-desk/${id}/resend"><input type="hidden" name="qi" value="${i}"><button class="btn btn-sm btn-gray">${q.sentAt ? "Resend" : "Send"}</button></form></td></tr>`).join("");

      const thread = (r.messages || []).map(m => {
        const mine = m.from === "admin";
        const who = m.from === "customer" ? "👤 Customer" : m.from === "seller" ? `🏪 ${esc(m.name || "Seller")}` : m.from === "admin" ? "🛠 ZimQuote" : "⚙️";
        return `<div style="display:flex;justify-content:${mine ? "flex-end" : "flex-start"};margin:6px 0">
          <div style="max-width:78%;background:${mine ? "#dcfce7" : m.from === "seller" ? "#eff6ff" : "#f1f5f9"};padding:8px 12px;border-radius:12px">
          <div style="font-size:11px;color:#64748b">${who}${m.to && m.to !== "admin" ? ` → ${esc(m.to)}` : ""} · ${fmt(m.at)}</div>
          <div style="white-space:pre-wrap">${esc(m.text)}</div>${m.media ? (/\.pdf($|\?)/i.test(m.media) ? `<a class="btn-link" href="${esc(m.media)}" target="_blank">📄 PDF</a>` : `<a href="${esc(m.media)}" target="_blank"><img src="${esc(m.media)}" style="max-width:160px;border-radius:6px;margin-top:4px"></a>`) : ""}</div></div>`;
      }).join("");

      // ── Books panel (ZimQuote quotes are in the admin's own business books) ──
      const bk = booksSummary(r);
      const payRows = bk.payments.map(p => `<tr><td>${fmt(p.at)}</td><td>💵 ${money(p.amount)}</td><td>${esc(p.method)}</td><td>${p.pdfUrl ? `<a class="btn-link" href="${esc(p.pdfUrl)}" target="_blank">🧾 ${esc(p.number)}</a>` : esc(p.number)}</td></tr>`).join("")
        + bk.costList.map(c => `<tr><td>${fmt(c.at)}</td><td style="color:#b91c1c">📉 −${money(c.amount)}</td><td>${esc(c.method || "")}</td><td>${esc(c.note || "Cost of sale")}</td></tr>`).join("");
      const booksPanel = !bk.booked
        ? `<div class="panel"><h3>💰 Invoice &amp; payments</h3><p class="muted">Make a <strong>🟢 ZimQuote quote</strong> above and it's saved in your business books as a QT quotation - then you can send an invoice, record payments (receipts go to the customer) and record what you paid the seller. Seller quotes are the seller's own sale, so they're not booked.</p></div>`
        : `<div class="panel"><h3>💰 Invoice &amp; payments</h3>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
    ${stat(money(bk.quoteTotal), `📋 Quote ${esc(bk.quoteNumber)}`, "blue")}
    ${stat(bk.hasInvoice ? money(bk.total) : "-", bk.hasInvoice ? (bk.invoicePdfUrl ? `🧾 <a class="btn-link" href="${esc(bk.invoicePdfUrl)}" target="_blank">${esc(bk.invoiceNumber)}</a>` : `🧾 ${esc(bk.invoiceNumber)}`) : "🧾 Invoice not sent yet", "purple")}
    ${stat(money(bk.paid), bk.balance > 0 ? `💵 Paid · due ${money(bk.balance)}` : "💵 Paid ✅", "green")}
    ${stat(money(bk.costs), "📉 Paid to sellers", "orange")}
    ${stat(money(bk.profit), "📈 Profit (paid − costs)", "teal")}
  </div>
  <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
    <form method="POST" action="/zq-admin/quote-desk/${id}/invoice"><button class="btn btn-blue">🧾 ${bk.hasInvoice ? "Resend invoice" : "Send invoice"}</button></form>
    ${bk.balance > 0 || !bk.hasInvoice ? `<form method="POST" action="/zq-admin/quote-desk/${id}/pay" class="filter-form" style="flex-wrap:wrap">
      <input name="amount" type="number" step="0.01" min="0.01" required placeholder="Amount $" value="${bk.balance || ""}" style="width:110px">
      <select name="method"><option>Cash</option><option>EcoCash</option><option>Bank</option><option>Other</option></select>
      <label style="white-space:nowrap"><input type="checkbox" name="receipt" value="1" checked> Send receipt</label>
      <button class="btn btn-green">💵 Record payment</button></form>` : ""}
    <form method="POST" action="/zq-admin/quote-desk/${id}/cost" class="filter-form" style="flex-wrap:wrap">
      <input name="amount" type="number" step="0.01" min="0.01" required placeholder="Cost $" style="width:100px">
      <input name="note" placeholder="Paid to… (e.g. Avondale Hardware)" style="min-width:200px">
      <button class="btn btn-gray">📉 Record cost</button></form>
  </div>
  ${payRows ? `<table style="margin-top:12px"><thead><tr><th>When</th><th>Amount</th><th>Method</th><th>Receipt / note</th></tr></thead><tbody>${payRows}</tbody></table>` : ""}
  <p class="muted" style="font-size:12px;margin-top:8px">Saved in your business books - invoices, receipts and costs show in your normal reports. Fully paid → request marked 🏆 Won with commission = paid − costs.</p></div>`;

      const sellerOpts = (r.sellers || []).filter(s => isId(String(s.supplierId))).map(s => `<option value="${s.supplierId}">${esc(s.name)}${s.status === "replied" ? " (replied)" : ""}</option>`).join("");

      res.send(layout(`Quote: ${qRef(r)}`, `
${nav("")}${flash(req)}
<div class="panel">
  <div class="panel-head"><h3>${esc(qRef(r))} ${sb(r.status)}</h3><small class="muted">Created ${fmt(r.createdAt)} · ${esc(r.source)}</small></div>
  <dl class="detail-list">
    <dt>Customer</dt><dd>${esc(r.customerName || "")} <strong>${esc(displayPhone(r.customerPhone))}</strong> · <a class="btn-link" href="https://wa.me/${esc(r.customerPhone)}" target="_blank">WhatsApp</a> · <a class="btn-link" href="/zq-admin/quote-desk?tab=all&q=${encodeURIComponent(r.customerPhone)}">History</a>
      <br><small>${winOk ? "🟢 Inside the 24h window - messages deliver now" : "🟡 Outside the 24h window - messages are queued and a template nudge is sent"}</small></dd>
    <dt>Where</dt><dd>${esc([r.area, r.city].filter(Boolean).join(", ") || "-")}</dd>
    <dt>Request</dt><dd style="white-space:pre-wrap;font-size:15px">${esc(r.text)}</dd>
    ${(r.items || []).length ? `<dt>Items (auto)</dt><dd>${r.items.map(i => esc(`${i.name}${i.qty > 1 ? " × " + i.qty : ""}${i.unit ? " " + i.unit : ""}`)).join(" · ")}</dd>` : ""}
    ${(r.photos || []).length ? `<dt>Photos</dt><dd>${r.photos.map(p => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" style="width:110px;height:110px;object-fit:cover;border-radius:8px;margin-right:6px"></a>`).join("")}</dd>` : ""}
    ${r.dealValue != null ? `<dt>Deal</dt><dd>${money(r.dealValue)}${r.commission != null ? ` · commission ${money(r.commission)}` : ""}</dd>` : ""}
  </dl>
  <form method="POST" action="/zq-admin/quote-desk/${id}/status" class="filter-form" style="margin-top:10px;flex-wrap:wrap">
    <select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${v[0]}</option>`).join("")}</select>
    <input name="dealValue" placeholder="Deal value $" style="width:120px" value="${r.dealValue ?? ""}">
    <input name="commission" placeholder="Your commission $" style="width:150px" value="${r.commission ?? ""}">
    <button>Update status</button></form>
</div>

<div class="panel">
  <h3>🧾 Make a quotation (PDF → customer on WhatsApp)</h3>
  <form method="POST" action="/zq-admin/quote-desk/${id}/quote" class="edit-form">
    <div class="fg full"><label>Lines - one per line: <code>Item x qty @ price</code></label>
      <textarea name="lines" id="qlines" rows="6" placeholder="Cement 50kg x 20 @ 9.50&#10;River sand 3m3 x 1 @ 45&#10;Delivery @ 15" oninput="preview()"></textarea></div>
    <div class="fg full"><label>Notes / terms (optional)</label><input name="notes" placeholder="Delivery Friday · pay on delivery (cash / EcoCash)"></div>
    <div id="qprev" class="muted" style="margin:6px 0 12px;white-space:pre-wrap"></div>
    <div class="form-grid">
      <div class="fg"><label>Quote as</label><select name="kind" id="qkind" onchange="document.getElementById('sellerbox').style.display=this.value==='seller'?'grid':'none'">
        <option value="zimquote">🟢 ZimQuote quote</option><option value="seller">🏪 A seller's quote</option></select></div>
      <div id="sellerbox" style="display:none" class="form-grid">
        <div class="fg"><label>Seller</label><select name="sid" id="qsid"><option value="">- type name below -</option>${sellerOpts}</select></div>
        <div class="fg"><label>…or seller name</label><input name="sellerName" placeholder="Off-platform seller name"></div>
      </div>
    </div>
    <div class="form-actions"><button class="btn btn-green" name="send" value="1">📤 Create PDF &amp; send to customer</button>
      <button class="btn btn-gray" name="send" value="0">📄 Create PDF only</button></div>
  </form>
  ${quoteRows ? `<table style="margin-top:14px"><thead><tr><th>Quotation</th><th>As</th><th>Total</th><th>Sent</th><th>Customer</th><th></th></tr></thead><tbody>${quoteRows}</tbody></table>` : ""}
</div>

${booksPanel}

${(r.sellers || []).length ? `<div class="panel"><h3>🏪 Sellers on this request <span class="count">${r.sellers.length}</span></h3>
  <p class="muted" style="font-size:12px">Prices come to you, not the customer. You choose: forward, quote, or connect - and who gets whose number.</p>
  <div style="overflow-x:auto"><table><thead><tr><th>Seller</th><th>Status</th><th>Reply</th><th>Numbers</th><th>Actions</th></tr></thead><tbody>${sellerRows}</tbody></table></div></div>` : ""}

${OPEN.includes(r.status) ? `<div class="panel"><h3>🔎 Suggested sellers <small class="muted">(hints only - you decide)</small></h3>
  <form method="POST" action="/zq-admin/quote-desk/${id}/send-sellers">
  <div style="overflow-x:auto"><table><thead><tr><th></th><th>Seller</th><th>Where</th><th>Account</th><th>Type</th><th>Score</th></tr></thead>
  <tbody>${suggRows || `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">No suggestions - add sellers by phone below.</td></tr>`}</tbody></table></div>
  <div class="filter-form" style="margin-top:10px;flex-wrap:wrap">
    <input name="extra" placeholder="Add sellers by phone (comma-separated)" style="flex:1;min-width:240px">
    <input name="note" placeholder="Note to sellers (optional)" style="flex:1;min-width:200px">
    <label style="white-space:nowrap"><input type="checkbox" name="share" value="1"> Share customer's number</label>
    <button>📤 Send to selected</button></div>
  </form></div>` : ""}

<div class="panel"><h3>💬 Conversation</h3>
  <div style="max-height:520px;overflow-y:auto;padding:6px;border:1px solid #e2e8f0;border-radius:10px">${thread || "<p class='muted'>No messages yet.</p>"}</div>
  <form method="POST" action="/zq-admin/quote-desk/${id}/message" style="display:flex;gap:8px;margin-top:10px">
    <textarea name="text" rows="2" required placeholder="Message the customer on WhatsApp…" style="flex:1"></textarea><button class="btn btn-blue">Send</button></form></div>

<div class="panel"><h3>🗒 Admin note</h3>
  <form method="POST" action="/zq-admin/quote-desk/${id}/note"><textarea name="adminNote" rows="2" style="width:100%">${esc(r.adminNote || "")}</textarea><button class="btn btn-sm btn-gray">Save</button></form></div>

<script>
function parse(t){var out=[],tot=0;t.split(/\\n|;/).forEach(function(raw){raw=raw.replace(/^\\s*(\\d+[.)]|[-•*])\\s+/,"").trim();if(!raw||/^(notes?|terms?)\\s*[:\\-]/i.test(raw))return;var m,i,q=1,p,n=function(s){return Number(String(s).replace(",","."))};
if(m=raw.match(/^(.*?)\\s*[x×*]\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:@|at)\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)\\s*$/i)){i=m[1];q=n(m[2]);p=n(m[3]);}
else if(m=raw.match(/^(\\d+(?:[.,]\\d+)?)\\s*[x×*]?\\s+(.*?)\\s*(?:@|at)\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)\\s*$/i)){q=n(m[1]);i=m[2];p=n(m[3]);}
else if(m=raw.match(/^(.*?)\\s*(?:@|at|=|:|-{1,2})\\s*\\$?\\s*(\\d+(?:[.,]\\d+)?)\\s*$/i)){i=m[1];p=n(m[2]);}
if(i&&p>=0){var t2=Math.round(q*p*100)/100;tot+=t2;out.push("✔ "+i.trim()+" × "+q+" @ $"+p.toFixed(2)+" = $"+t2.toFixed(2));}else out.push("⚠ not read: "+raw);});
return out.length?out.join("\\n")+"\\nTotal: $"+(Math.round(tot*100)/100).toFixed(2):"";}
function preview(){document.getElementById("qprev").textContent=parse(document.getElementById("qlines").value);}
function useReply(t,sid){var el=document.getElementById("qlines");el.value=(el.value?el.value+"\\n":"")+"# from seller: "+t.replace(/\\n/g," ")+"\\n";
 if(sid){document.getElementById("qkind").value="seller";document.getElementById("sellerbox").style.display="grid";document.getElementById("qsid").value=sid;}
 el.focus();preview();window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-120,behavior:"smooth"});}
</script>`));
    } catch (e) { res.send(layout("Quote Desk", `<div class="alert red">${esc(e.message)}</div>`)); }
  });

  // ── Actions ───────────────────────────────────────────────────────────────
  const act = (path, fn) => router.post(`/quote-desk/:id/${path}`, requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/quote-desk/${req.params.id}`;
    try { if (!isId(req.params.id)) throw new Error("Bad id"); go(res, back, "success", (await fn(req)) || "Done."); }
    catch (e) { go(res, back, "error", e.message); }
  });

  act("send-sellers", async req => {
    const b = req.body || {};
    const ids = [].concat(b.sid || []).filter(isId);
    for (const ph of String(b.extra || "").split(/[,\s;]+/).filter(Boolean)) {
      const n = normPhone(ph);
      const sp = await SupplierProfile.findOne({ phone: { $in: [n, "+" + n, "0" + n.slice(3)] }, profileType: { $ne: "biker" } }, { _id: 1 }).lean();
      if (!sp) throw new Error(`No seller found with phone ${ph}`);
      ids.push(String(sp._id));
    }
    if (!ids.length) throw new Error("Tick at least one seller or add a phone number.");
    const done = await sendToSellers(req.params.id, ids, { shareCustomerPhone: b.share === "1", note: String(b.note || "").trim() });
    return `Sent to ${done.length} seller(s): ${done.join(", ")}`;
  });
  act("quote", async req => {
    const b = req.body || {};
    const raw = String(b.lines || "").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");   // "# from seller" helper lines are ignored
    const p = parseQuoteLines(raw);
    if (!p.lines.length) throw new Error("No priced lines found. Use: Item x qty @ price");
    const kind = b.kind === "seller" ? "seller" : "zimquote";
    if (kind === "seller" && !isId(b.sid) && !String(b.sellerName || "").trim()) throw new Error("Choose a seller or type the seller's name.");
    const r = await buildAndSendQuote(req.params.id, {
      lines: p.lines, notes: [String(b.notes || "").trim(), p.notes].filter(Boolean).join("\n"),
      kind, supplierId: isId(b.sid) ? b.sid : null, sellerNameOverride: String(b.sellerName || "").trim(), send: b.send === "1"
    });
    return b.send === "1"
      ? `Quotation ${r.quote.number} (${money(r.quote.total)}) ${r.delivered ? "sent to the customer" : "queued - customer is outside the 24h window (nudge sent)"}.${p.errors.length ? ` Skipped ${p.errors.length} unreadable line(s).` : ""}`
      : `PDF ${r.quote.number} created (${money(r.quote.total)}) - not sent.`;
  });
  act("resend", async req => {
    const r = await QuoteRequest.findById(req.params.id).lean();
    const qi = Number(req.body.qi);
    const q = r?.quotes?.[qi];
    if (!q) throw new Error("Quotation not found");
    const res = await resendQuote(String(r._id), qi);
    return res.delivered ? `Quotation ${q.number} sent to the customer.` : "Queued for when the customer replies (outside 24h window).";
  });
  act("message", async req => {
    const t = String(req.body.text || "").trim();
    if (!t) throw new Error("Type a message.");
    const r = await messageCustomer(req.params.id, t);
    return r.delivered ? "Sent to the customer." : "Queued - customer is outside the 24h window (nudge sent).";
  });
  act("seller-message", async req => {
    if (!isId(req.body.sid)) throw new Error("Bad seller");
    await messageSeller(req.params.id, req.body.sid, String(req.body.text || "").trim());
    return "Sent to the seller.";
  });
  act("forward", async req => {
    const r = await forwardSellerReply(req.params.id, req.body.sid);
    return r.delivered ? "Price forwarded to the customer." : "Queued for the customer (outside 24h window).";
  });
  act("share", async req => {
    const mode = ["c", "s", "b"].includes(req.body.mode) ? req.body.mode : "b";
    await shareContacts(req.params.id, req.body.sid, mode);
    return mode === "c" ? "Seller now has the customer's number." : mode === "s" ? "Customer now has the seller's number." : "Both now have each other's numbers.";
  });
  act("status", async req => {
    const s = String(req.body.status || "");
    if (!STATUS[s]) throw new Error("Unknown status");
    await setStatus(req.params.id, s, { dealValue: req.body.dealValue, commission: req.body.commission });
    return "Status updated.";
  });
  act("invoice", async req => {
    const r = await sendInvoice(req.params.id, { by: "web-admin" });
    return `Invoice ${r.invoice.number} (${money(r.invoice.total)}) ${r.delivered ? (r.already ? "resent" : "sent") + " to the customer" : "queued - customer is outside the 24h window (nudge sent)"}.`;
  });
  act("pay", async req => {
    const amount = Number(String(req.body.amount || "").replace(/[^\d.]/g, ""));
    const r = await recordPayment(req.params.id, { amount, method: req.body.method, by: "web-admin", sendReceipt: req.body.receipt === "1" });
    return `Payment ${money(r.applied)} saved · ${r.receiptNumber}` + (amount > r.applied ? ` (only ${money(r.applied)} was due)` : "") +
      (r.paidInFull ? " · fully paid - marked Won." : ` · balance ${money(r.invoice.balance)}.`);
  });
  act("cost", async req => {
    const amount = Number(String(req.body.amount || "").replace(/[^\d.]/g, ""));
    await recordCost(req.params.id, { amount, note: String(req.body.note || "").trim(), by: "web-admin" });
    return `Cost ${money(amount)} saved.`;
  });
  act("note", async req => {
    await QuoteRequest.updateOne({ _id: req.params.id }, { $set: { adminNote: String(req.body.adminNote || "").slice(0, 3000) } });
    return "Note saved.";
  });
}

export default registerQuoteDeskAdminRoutes;

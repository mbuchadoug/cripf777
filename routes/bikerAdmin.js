// routes/bikerAdmin.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote Admin → BIKERS & DELIVERIES
// Registered from routes/supplierAdmin.js (same router, same login, same layout):
//
//   import { registerBikerAdminRoutes } from "./bikerAdmin.js";
//   registerBikerAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat });
//
// Pages (all under /zq-admin):
//   /bikers                 list + live stats + filters
//   /bikers/new             register a rider (phone-in / walk-in)
//   /bikers/:id             rider profile: points, rating, earnings, jobs, actions
//   /biker-jobs             all deliveries + filters
//   /biker-jobs/new         manual delivery request (dispatch to riders OR assign one)
//   /biker-jobs/:id         delivery detail: timeline, prices, assign/cancel/complete/dispute
// ═════════════════════════════════════════════════════════════════════════════
import mongoose from "mongoose";
import SupplierProfile from "../models/supplierProfile.js";
import BikerJob from "../models/bikerJob.js";
import { SUPPLIER_CITIES } from "../services/supplierPlans.js";
import { metroGroup, detectCity } from "../services/bikerPlaces.js";
import {
  adminCreateJob, adminAssignJob, adminCancelJob, adminCompleteJob, adminRedispatchJob,
  adminResolveDispute, addRiderPoints, riderLevel, riderLink, adminMessage,
  invalidateRiderCache, normPhone, jobRef, RIDER_POINTS, bikerHubLink, bikerHubCaption,
  isRiderVerified, canTakeJobs, publicName, maskPhone, sendRiderActivityAlert, adminReviewKyc, BikerActivity
} from "../services/bikerDispatch.js";

const isId = id => mongoose.Types.ObjectId.isValid(String(id || "")) && /^[a-f0-9]{24}$/i.test(String(id));
const phoneVariants = p => { const n = normPhone(p); return [n, "+" + n, n.startsWith("263") ? "0" + n.slice(3) : n]; };
const cityRe = c => ({ $in: metroGroup(c).map(x => new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")) });
const fmtDate = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
const qrUrl = (data, size = 220) => `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}&qzone=2`;
const STATUS_COLOR = { open: "yellow", assigned: "blue", picked_up: "purple", delivered: "teal", completed: "green", cancelled: "gray", expired: "gray" };
const STATUS_LABEL = { open: "Open", assigned: "Assigned", picked_up: "Picked up", delivered: "Delivered", completed: "Completed", cancelled: "Cancelled", expired: "Expired" };
const cities = () => (SUPPLIER_CITIES && SUPPLIER_CITIES.length ? SUPPLIER_CITIES : ["Harare", "Bulawayo", "Mutare", "Gweru", "Masvingo", "Chitungwiza"]);

export function registerBikerAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat }) {
  const flash = req => {
    const ok = req.query.success ? `<div style="background:#dcfce7;color:#166534;padding:12px 14px;border-radius:8px;margin-bottom:14px">✅ ${esc(req.query.success)}</div>` : "";
    const er = req.query.error ? `<div class="alert red" style="margin-bottom:14px">❌ ${esc(req.query.error)}</div>` : "";
    return ok + er;
  };
  const go = (res, url, kind, msg) => {
    const [path, hash] = String(url).split("#");
    res.redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}${hash ? "#" + hash : ""}`);
  };
  const subNav = active => `
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
  <a class="btn btn-sm ${active === "bikers" ? "btn-blue" : "btn-gray"}" href="/zq-admin/bikers">🏍️ Riders</a>
  <a class="btn btn-sm ${active === "newbiker" ? "btn-blue" : "btn-gray"}" href="/zq-admin/bikers/new">➕ Register Rider</a>
  <a class="btn btn-sm ${active === "jobs" ? "btn-blue" : "btn-gray"}" href="/zq-admin/biker-jobs">📦 Deliveries</a>
  <a class="btn btn-sm ${active === "newjob" ? "btn-green" : "btn-gray"}" href="/zq-admin/biker-jobs/new">➕ New Delivery Request</a>
  <a class="btn btn-sm ${active === "kyc" ? "btn-blue" : "btn-gray"}" href="/zq-admin/bikers?status=kyc">🪪 ID checks</a>
  <a class="btn btn-sm ${active === "activity" ? "btn-blue" : "btn-gray"}" href="/zq-admin/bikers/activity">👁 Rider Activity</a>
  <a class="btn btn-sm ${active === "share" ? "btn-blue" : "btn-gray"}" href="/zq-admin/bikers/share">📲 Share Link</a>
</div>`;
  const statusBadge = s => badge(STATUS_LABEL[s] || s, STATUS_COLOR[s] || "gray");
  const kycBadge = r => isRiderVerified(r) ? badge("🪪 ID approved", "blue")
    : r.riderKyc?.status === "pending" ? badge("🪪 ID to check", "orange")
    : r.riderKyc?.status === "rejected" ? badge("🪪 ID rejected", "red")
    : badge("🪪 No ID", "gray");
  const riderStatus = r => [
    r.suspended ? badge("Suspended", "red") : r.active ? badge("Paid", "green") : badge("Not paid", "orange"),
    kycBadge(r),
    canTakeJobs(r) ? (r.riderActive !== false ? badge("🟢 Getting jobs", "teal") : badge("Offline", "gray")) : (r.active && !r.suspended ? badge("⛔ No jobs until ID approved", "red") : "")
  ].join(" ");
  const cityOptions = sel => cities().map(c => `<option ${String(sel || "").toLowerCase() === c.toLowerCase() ? "selected" : ""}>${esc(c)}</option>`).join("");

  // ═══════════════════════════════════════════════════════════════════════════
  // RIDERS LIST
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/bikers", requireSupplierAdmin, async (req, res) => {
    try {
      const { city = "", status = "", q = "" } = req.query;
      const filter = { profileType: "biker" };
      if (city) filter["location.city"] = cityRe(city);
      if (status === "active") Object.assign(filter, { active: true, suspended: { $ne: true } });
      if (status === "online") Object.assign(filter, { active: true, suspended: { $ne: true }, riderActive: { $ne: false } });
      if (status === "unpaid") filter.active = { $ne: true };
      if (status === "unverified") filter["bike.verifiedAt"] = { $in: [null] };
      if (status === "photo") Object.assign(filter, { "bike.photoUrl": { $nin: [null, ""] }, "bike.verifiedAt": { $in: [null] } });
      if (status === "suspended") filter.suspended = true;
      if (status === "kyc") Object.assign(filter, { "riderKyc.status": "pending", "bike.verifiedAt": { $in: [null] } });
      if (status === "paidunverified") Object.assign(filter, { active: true, suspended: { $ne: true }, "riderKyc.status": { $ne: "approved" }, "bike.verifiedAt": { $in: [null] } });
      if (q.trim()) {
        const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ businessName: rx }, { phone: rx }, { "bike.plate": rx }, { riderAreas: rx }];
      }
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const [kycWaiting, paidUnverified] = await Promise.all([
        SupplierProfile.countDocuments({ profileType: "biker", "riderKyc.status": "pending", "bike.verifiedAt": { $in: [null] } }).setOptions({ strictQuery: false }),
        SupplierProfile.countDocuments({ profileType: "biker", active: true, suspended: { $ne: true }, "riderKyc.status": { $ne: "approved" }, "bike.verifiedAt": { $in: [null] } }).setOptions({ strictQuery: false })
      ]);
      const [riders, total, active, online, verified, photoWaiting, open, live, doneToday, disputed] = await Promise.all([
        SupplierProfile.find(filter).setOptions({ strictQuery: false }).sort(status === "kyc" ? { "riderKyc.submittedAt": 1 } : { riderPoints: -1, createdAt: -1 }).limit(300).lean(),
        SupplierProfile.countDocuments({ profileType: "biker" }),
        SupplierProfile.countDocuments({ profileType: "biker", active: true }),
        SupplierProfile.countDocuments({ profileType: "biker", active: true, suspended: { $ne: true }, riderActive: { $ne: false } }).setOptions({ strictQuery: false }),
        SupplierProfile.countDocuments({ profileType: "biker", "bike.verifiedAt": { $nin: [null] } }).setOptions({ strictQuery: false }),
        SupplierProfile.countDocuments({ profileType: "biker", "bike.photoUrl": { $nin: [null, ""] }, "bike.verifiedAt": { $in: [null] } }).setOptions({ strictQuery: false }),
        BikerJob.countDocuments({ status: "open" }),
        BikerJob.countDocuments({ status: { $in: ["assigned", "picked_up", "delivered"] } }),
        BikerJob.countDocuments({ status: "completed", completedAt: { $gte: dayStart } }),
        BikerJob.countDocuments({ disputed: true })
      ]);
      const rows = riders.map(r => {
        const lvl = riderLevel(r.riderPoints);
        return `<tr>
          <td><a class="btn-link" href="/zq-admin/bikers/${r._id}${status === "kyc" ? "#kyc" : ""}">${esc(r.riderLegalName || String(r.businessName || "Rider").replace(/\s*\(Rider\)$/i, ""))}</a><br><small class="muted">"${esc(publicName(r))}" · 🏍️ ${esc(r.bike?.plate || "-")}</small></td>
          <td>${esc(r.phone)}</td>
          <td>${esc(r.location?.city || "-")}<br><small class="muted">${esc((r.riderAreas || []).join(", ") || "Whole city")}</small></td>
          <td>${riderStatus(r)}</td>
          <td>${lvl.emoji} ${r.riderPoints || 0}</td>
          <td>${r.rating ? "⭐ " + Number(r.rating).toFixed(1) : "-"}</td>
          <td>${r.completedTrips || 0}</td>
          <td>${r.riderCancels || 0}</td>
        </tr>`;
      }).join("");
      res.send(layout("Bikers", `
${subNav("bikers")}${flash(req)}
<div class="stats-grid">
  ${stat(total, "Riders", "blue")}${stat(active, "Active (paid)", "green")}${stat(online, "Online now", "teal")}
  ${stat(verified, "ID approved", "purple")}${stat(`<a href="/zq-admin/bikers?status=kyc" style="color:inherit">${kycWaiting}</a>`, "🪪 IDs to check", "orange")}
  ${stat(`<a href="/zq-admin/bikers?status=paidunverified" style="color:inherit">${paidUnverified}</a>`, "Paid, no jobs (ID)", "red")}
  ${stat(`<a href="/zq-admin/biker-jobs?status=open" style="color:inherit">${open}</a>`, "Open requests", "yellow")}
  ${stat(`<a href="/zq-admin/biker-jobs?status=live" style="color:inherit">${live}</a>`, "In progress", "blue")}
  ${stat(doneToday, "Completed today", "green")}
  ${stat(`<a href="/zq-admin/biker-jobs?status=disputed" style="color:inherit">${disputed}</a>`, "Disputes", "red")}
</div>
${paidUnverified ? `<div class="panel" style="border:1px solid #fecaca;background:#fff7f7">
  <strong>⛔ ${paidUnverified} paid rider(s) get no jobs until their ID is approved.</strong>
  <span class="muted">Riders only receive jobs when paid AND ID-approved.</span>
  <form method="POST" action="/zq-admin/bikers/kyc-nudge" style="display:inline;margin-left:8px"><button class="btn btn-sm btn-blue">📲 Ask them to send their ID</button></form>
  <a class="btn btn-sm btn-gray" href="/zq-admin/bikers?status=paidunverified">View</a>
</div>` : ""}
<div class="panel">
  <div class="panel-head"><h3>Riders <span class="count">${riders.length}</span></h3>
    <form class="filter-form" method="GET">
      <input name="q" value="${esc(q)}" placeholder="Name, phone, plate, area">
      <select name="city"><option value="">All cities</option>${cityOptions(city)}</select>
      <select name="status">
        ${[["", "All"], ["kyc", "🪪 IDs to check"], ["paidunverified", "Paid, ID not approved"], ["online", "Online now"], ["active", "Paid"], ["unpaid", "Not paid"], ["unverified", "Not verified"], ["suspended", "Suspended"]]
          .map(([v, l]) => `<option value="${v}" ${status === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button>Filter</button> <a class="btn-reset" href="/zq-admin/bikers">Reset</a>
    </form>
  </div>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Rider</th><th>Phone</th><th>City / Areas</th><th>Status</th><th>Points</th><th>Rating</th><th>Trips</th><th>Cancels</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No riders yet. <a class="btn-link" href="/zq-admin/bikers/new">Register one</a></td></tr>`}</tbody>
  </table></div>
</div>`));
    } catch (err) {
      res.send(layout("Bikers", `<div class="alert red">Error: ${esc(err.message)}</div>`));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHAREABLE WHATSAPP LINK  (one link: Request a Biker + Become a Rider)
  //  • Plain link:    https://wa.me/<BOT>?text=Bikers          (always works)
  //  • Official link: https://wa.me/message/XXXXXXXX           (generated by Meta,
  //                   shorter, prefilled "Bikers") - created via the Cloud API
  //                   endpoint POST /<PHONE_NUMBER_ID>/message_qrdls and saved in
  //                   the "zq_settings" collection so it is created only once.
  // ═══════════════════════════════════════════════════════════════════════════
  const SHARE_CITIES = ["", "Harare", "Bulawayo", "Mutare", "Gweru", "Chitungwiza"];
  const settings = () => mongoose.connection.collection("zq_settings");
  const linkKey = city => `bikerShortLink:${(city || "all").toLowerCase()}`;
  const prefillFor = city => (city ? `Bikers ${city}` : "Bikers");

  router.get("/bikers/share", requireSupplierAdmin, async (req, res) => {
    const saved = {};
    try {
      const docs = await settings().find({ _id: { $in: SHARE_CITIES.map(linkKey) } }).toArray();
      docs.forEach(d => { saved[d._id] = d; });
    } catch (_) {}
    const card = (city) => {
      const official = saved[linkKey(city)]?.url || "";
      const plain = bikerHubLink(city);
      const main = official || plain;
      const cap = bikerHubCaption(city, main);
      const id = "c" + (city || "all").toLowerCase();
      return `<div class="panel">
  <h3>${city ? "📍 " + esc(city) : "🇿🇼 Main link (all cities)"}</h3>
  <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
    <div style="text-align:center"><img src="${qrUrl(main, 200)}" width="200" height="200" alt="QR"><br>
      <a class="btn btn-sm btn-gray" href="${qrUrl(main, 600)}" target="_blank" download>⬇ QR (600px)</a></div>
    <div style="flex:1;min-width:260px">
      ${official ? `
      <label class="muted" style="font-size:12px">✅ Official WhatsApp short link</label>
      <div style="display:flex;gap:8px;margin:4px 0 12px"><input id="${id}o" value="${esc(official)}" readonly style="flex:1;font-size:15px;font-weight:700">
        <button class="btn btn-sm btn-blue" onclick="cp('${id}o')">📋 Copy</button>
        <a class="btn btn-sm btn-green" href="${esc(official)}" target="_blank">🔗 Test</a></div>` : `
      <form method="POST" action="/zq-admin/bikers/share/generate" style="margin-bottom:12px">
        <input type="hidden" name="city" value="${esc(city)}">
        <button class="btn btn-sm btn-green">✨ Create official short link (wa.me/message/…)</button>
      </form>`}
      <label class="muted" style="font-size:12px">${official ? "Plain WhatsApp link (also works)" : "WhatsApp link"}</label>
      <div style="display:flex;gap:8px;margin:4px 0 12px"><input id="${id}w" value="${esc(plain)}" readonly style="flex:1;font-size:13px">
        <button class="btn btn-sm btn-blue" onclick="cp('${id}w')">📋 Copy</button>
        <a class="btn btn-sm btn-gray" href="${esc(plain)}" target="_blank">🔗 Test</a></div>
      <label class="muted" style="font-size:12px">Caption for WhatsApp Status / groups / Facebook</label>
      <textarea id="${id}c" rows="7" readonly style="width:100%;font-size:12px;margin-top:4px">${esc(cap)}</textarea>
      <button class="btn btn-sm btn-blue" onclick="cp('${id}c')">📋 Copy caption</button>
    </div>
  </div>
</div>`;
    };
    res.send(layout("Bikers", `
${subNav("share")}${flash(req)}
<div class="panel"><p style="line-height:1.7">Tapping the link opens <strong>WhatsApp directly</strong> with <em>"Bikers"</em> typed - they press <strong>Send</strong> and get
<em>📦 Request a Biker</em> and <em>🏍️ Become a Rider</em> buttons. Registered riders get their Rider Menu. City links remember the city.</p></div>
${SHARE_CITIES.map(card).join("")}
<script>function cp(id){const el=document.getElementById(id);el.select();navigator.clipboard?navigator.clipboard.writeText(el.value):document.execCommand("copy");}</script>`));
  });

  router.post("/bikers/share/generate", requireSupplierAdmin, async (req, res) => {
    const back = "/zq-admin/bikers/share";
    try {
      const city = SHARE_CITIES.find(c => c.toLowerCase() === String(req.body.city || "").toLowerCase()) ?? "";
      const existing = await settings().findOne({ _id: linkKey(city) });
      if (existing?.url) return go(res, back, "success", `Already created: ${existing.url}`);
      const PNID  = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
      const TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
      if (!PNID || !TOKEN) throw new Error("WhatsApp phone number ID / access token missing in .env");
      const { default: axios } = await import("axios");
      const r = await axios.post(`https://graph.facebook.com/v24.0/${PNID}/message_qrdls`,
        { prefilled_message: prefillFor(city), generate_qr_image: "PNG" },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 });
      const url = r.data?.deep_link_url;
      if (!url) throw new Error("Meta did not return a link");
      await settings().updateOne({ _id: linkKey(city) },
        { $set: { url, code: r.data.code || "", prefill: prefillFor(city), createdAt: new Date() } }, { upsert: true });
      go(res, back, "success", `Created: ${url}`);
    } catch (err) {
      const m = err?.response?.data?.error?.message || err.message;
      go(res, back, "error", `Could not create the official link (${m}). The plain WhatsApp link still works.`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER RIDER
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/bikers/new", requireSupplierAdmin, (req, res) => {
    res.send(layout("Register Biker", `
${subNav("newbiker")}${flash(req)}
<div class="panel edit-form" style="max-width:760px">
  <h3>🏍️ Register a rider</h3>
  <p class="muted" style="margin-bottom:14px">For riders who sign up by phone or walk in. They can then use the Rider Menu on WhatsApp straight away (type <code>hi</code>).</p>
  <form method="POST" action="/zq-admin/bikers/new">
    <div class="form-grid">
      <div class="fg"><label>Full legal name (as on ID) *</label><input name="name" required placeholder="Tapiwa Moyo"></div>
      <div class="fg"><label>Rider name customers see</label><input name="displayName" maxlength="20" placeholder="blank = first name, or e.g. Speedy T"></div>
      <div class="fg"><label>WhatsApp number *</label><input name="phone" required placeholder="0772 123 456"></div>
      <div class="fg"><label>City *</label><select name="city" required>${cityOptions("Harare")}</select></div>
      <div class="fg"><label>Areas covered</label><input name="areas" placeholder="CBD, Avondale, Mbare (blank = whole city)"></div>
      <div class="fg"><label>Number plate *</label><input name="plate" required placeholder="AEX 1234" style="text-transform:uppercase"></div>
      <div class="fg"><label>Bike (make / model)</label><input name="bikeModel" placeholder="Honda Ace 125"></div>
      <div class="fg"><label>Photo URL (rider with bike)</label><input name="photoUrl" placeholder="https://..."></div>
      <div class="fg"><label>National ID photo URL</label><input name="idPhotoUrl" placeholder="https://... (admin only)"></div>
      <div class="fg"><label>National ID number (last 4 only)</label><input name="idLast4" maxlength="4" placeholder="e.g. 47K2"></div>
    </div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 14px">
      <label><input type="checkbox" name="licenceOnFile" value="true"> Licence seen</label>
      <label><input type="checkbox" name="idOnFile" value="true"> ID seen</label>
      <label><input type="checkbox" name="insurance" value="true"> Insured</label>
      <label><input type="checkbox" name="verified" value="true"> 🪪 ID checked in person (name, face &amp; plate match) - approve now</label>
    </div>
    <div class="form-grid">
      <div class="fg"><label>Activate now?</label>
        <select name="setActive"><option value="true">Yes - paid / approved</option><option value="false">No - rider pays on WhatsApp</option></select></div>
      <div class="fg"><label>Subscription length</label>
        <select name="durationDays"><option value="30">1 month ($5)</option><option value="365">1 year ($50)</option><option value="7">7-day trial</option><option value="90">3 months</option></select></div>
    </div>
    <div class="fg full"><label>Admin note</label><textarea name="adminNote" rows="2" placeholder="e.g. Paid cash at office, referred by Blessing"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-green">Register rider</button>
      <label style="align-self:center"><input type="checkbox" name="sendWelcome" value="true" checked> Send WhatsApp welcome</label>
    </div>
  </form>
</div>`));
  });

  router.post("/bikers/new", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || "").trim();
      const phone = normPhone(b.phone);
      if (name.length < 2) throw new Error("Rider name is required.");
      if (!phone || phone.length < 11) throw new Error("A valid WhatsApp number is required.");
      if (!String(b.plate || "").trim()) throw new Error("Number plate is required.");
      const city = String(b.city || "Harare").trim();
      const areas = String(b.areas || "").split(/[,\n;]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
      if (await SupplierProfile.findOne({ phone: { $in: phoneVariants(phone) }, profileType: "biker" }).lean()) {
        throw new Error(`A rider with ${phone} already exists.`);
      }
      const now = new Date();
      const days = Number(b.durationDays) || 30;
      const isActive = b.setActive === "true";

      const Business    = (await import("../models/business.js")).default;
      const UserRole    = (await import("../models/userRole.js")).default;
      const UserSession = (await import("../models/userSession.js")).default;
      const biz = await Business.create({
        name: `${name} (Rider)`, currency: "USD", package: "trial",
        subscriptionStatus: isActive ? "active" : "inactive",
        isSupplier: true, ownerPhone: phone, sessionState: "ready", sessionData: {}
      });
      await UserRole.findOneAndUpdate({ phone, businessId: biz._id },
        { $setOnInsert: { phone, businessId: biz._id, role: "owner", pending: false } }, { upsert: true });
      await UserSession.findOneAndUpdate({ phone }, { $set: { phone, activeBusinessId: biz._id } }, { upsert: true });

      let rider;
      try {
        rider = await SupplierProfile.create({
          phone, businessName: `${String(b.displayName || "").trim().slice(0, 20) || name.split(/\s+/)[0]} (Rider)`, businessId: biz._id, profileType: "biker",
          location: { city, area: areas[0] || city }, categories: ["transport"],
          revealVisitorPhone: true, canViewContacts: true, tier: "basic", tierRank: 1,
          subscriptionStatus: isActive ? "active" : "pending", subscriptionPlan: days >= 365 ? "annual" : "monthly",
          subscriptionStartedAt: now, subscriptionEndsAt: new Date(now.getTime() + days * 86400000),
          active: isActive, adminNote: `[Admin registered rider on ${now.toDateString()}] ${b.adminNote || ""}`.trim()
        });
      } catch (e) {
        await Business.deleteOne({ _id: biz._id }).catch(() => {});
        if (/duplicate key/i.test(e.message)) throw new Error("This phone already has another ZimQuote listing (seller/tutor). Use a different number.");
        throw e;
      }
      await SupplierProfile.updateOne({ _id: rider._id }, { $set: {
        riderAreas: areas, riderActive: true, riderPoints: 0, riderMissedPings: 0,
        riderLegalName: name, riderDisplayName: String(b.displayName || "").trim().slice(0, 20),
        riderKyc: {
          status: b.verified === "true" ? "approved" : (String(b.idPhotoUrl || "").trim() ? "pending" : "none"),
          idPhotoUrl: String(b.idPhotoUrl || "").trim(), selfieUrl: String(b.photoUrl || "").trim(),
          idLast4: String(b.idLast4 || "").trim().slice(0, 4), submittedAt: now,
          reviewedAt: b.verified === "true" ? now : null, reviewedBy: b.verified === "true" ? "admin (in person)" : "",
          nameMatch: b.verified === "true", faceMatch: b.verified === "true", plateMatch: b.verified === "true", rejectReason: ""
        },
        bike: {
          plate: String(b.plate).trim().toUpperCase(), model: String(b.bikeModel || "").trim(),
          licenceOnFile: b.licenceOnFile === "true", idOnFile: b.idOnFile === "true", insurance: b.insurance === "true",
          idLast4: String(b.idLast4 || "").trim().slice(0, 4), photoUrl: String(b.photoUrl || "").trim(),
          verifiedAt: b.verified === "true" ? now : null
        }
      } }, { strict: false });
      await Business.findByIdAndUpdate(biz._id, { supplierProfileId: rider._id });
      invalidateRiderCache(phone);

      if (b.sendWelcome === "true") {
        await adminMessage(phone,
          `🏍️ *Welcome to ZimQuote Riders, ${name.split(/\s+/)[0]}!*\n\n` +
          (isActive && b.verified === "true" ? `Your account is *active* and your ID is approved. You'll get delivery jobs here on WhatsApp.\n\n`
            : isActive ? `Your account is *active*. Type *hi* → *🪪 Verify my ID* - jobs start once your ID is approved.\n\n`
            : `Your profile is ready - type *hi* and tap *Activate* to start getting jobs.\n\n`) +
          `Type *hi* any time to open your Rider Menu.`).catch(() => {});
      }
      go(res, `/zq-admin/bikers/${rider._id}`, "success", "Rider registered.");
    } catch (err) {
      go(res, "/zq-admin/bikers/new", "error", err.message);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🪪 IDENTITY CHECK (approve / reject / reset) + nudge paid-but-unverified
  // ═══════════════════════════════════════════════════════════════════════════
  // ID / bike photos live in <project>/private/rider-kyc (NOT public). Only a
  // logged-in admin can open them, through this route.
  router.get("/bikers/kyc-file/:name", requireSupplierAdmin, async (req, res) => {
    // NOTE: links have NO .jpg/.png ending - nginx serves anything ending in an
    // image extension as a static file itself and never passes it to the app.
    const raw = String(req.params.name || "");
    const m = raw.match(/^(kyc_\d{6,15}_\d{10,14})(?:\.(jpg|png))?$/);
    if (!m) return res.status(404).send("Not found");
    const names = m[2] ? [raw] : [`${m[1]}.jpg`, `${m[1]}.png`];
    res.set("Cache-Control", "private, no-store");
    // 1) MongoDB copy (saved by the WhatsApp webhook)
    try {
      const doc = await mongoose.connection.collection("rider_kyc_files").findOne({ _id: { $in: names } });
      if (doc?.data) {
        const buf = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
        res.type(doc.mime || (String(doc._id).endsWith(".png") ? "png" : "jpeg"));
        return res.send(buf);
      }
    } catch (e) { console.warn("[RIDER KYC] DB read failed:", e.message); }
    // 2) Disk copy - check every folder the app may be running from
    const { fileURLToPath } = await import("url");
    const path = (await import("path")).default;
    const fs = (await import("fs")).default;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tried = [...new Set(names.flatMap(name => [
      path.join(here, "..", "private", "rider-kyc", name),
      path.join(process.cwd(), "private", "rider-kyc", name),
      path.join(here, "private", "rider-kyc", name)
    ]).map(p => path.resolve(p)))];
    const file = tried.find(p => fs.existsSync(p));
    if (file) return res.sendFile(file);
    console.warn("[RIDER KYC] photo not found:", raw, tried);
    res.status(404).type("text").send(`Photo not found on the server.\nLooked in:\n${tried.join("\n")}\n\nAsk the rider to resend it (Rider Menu → Verify my ID).`);
  });

  router.post("/bikers/kyc-nudge", requireSupplierAdmin, async (req, res) => {
    try {
      const list = await SupplierProfile.find({ profileType: "biker", active: true, suspended: { $ne: true },
        "riderKyc.status": { $nin: ["approved", "pending"] }, "bike.verifiedAt": { $in: [null] } }).setOptions({ strictQuery: false }).limit(300).lean();
      let sent = 0, failed = 0;
      for (const r of list) {
        const ok = await adminMessage(r.phone,
          `🪪 *ZimQuote Riders - ID check*\n\nTo keep every delivery safe, all riders now need an approved ID before they get jobs.\n\nType *hi* → *🪪 Verify my ID* and send 2 photos (your ID + you with your bike). Takes 1 minute - we approve the same day.`).catch(() => false);
        ok ? sent++ : failed++;
        await new Promise(x => setTimeout(x, 400));
      }
      go(res, "/zq-admin/bikers?status=paidunverified", "success", `Asked ${sent} rider(s)${failed ? `, ${failed} outside the 24h window (message them by phone or SMS)` : ""}.`);
    } catch (err) { go(res, "/zq-admin/bikers", "error", err.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 👁 RIDER ACTIVITY  - masked profile views & delivery leads (like sellers/schools)
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/bikers/activity", requireSupplierAdmin, async (req, res) => {
    try {
      const { city = "", who = "notready" } = req.query;
      const filter = { profileType: "biker", suspended: { $ne: true } };
      if (city) filter["location.city"] = cityRe(city);
      if (who === "unpaid") filter.active = { $ne: true };
      const all = await SupplierProfile.find(filter).setOptions({ strictQuery: false }).sort({ createdAt: -1 }).limit(500).lean();
      const riders = who === "notready" ? all.filter(r => !canTakeJobs(r)) : who === "ready" ? all.filter(canTakeJobs) : all;
      const hist = await BikerActivity.find({}).sort({ createdAt: -1 }).limit(60).lean().catch(() => []);
      const rows = riders.map(r => `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-bottom:1px solid #f1f5f9;font-size:13px;cursor:pointer">
        <input type="checkbox" name="ids" value="${r._id}" style="margin-top:3px">
        <span style="flex:1"><strong>${esc(r.riderLegalName || publicName(r))}</strong> <span class="muted">"${esc(publicName(r))}"</span><br>
        <span class="muted">${esc(r.location?.city || "")} · ${esc(r.phone)}</span></span>
        <span>${r.active ? badge("Paid", "green") : badge("Not paid", "orange")} ${kycBadge(r)}</span></label>`).join("");
      const histRows = hist.map(h => `<tr><td>${fmtDate(h.createdAt)}</td><td>${esc(h.riderName || "")}<br><small class="muted">${esc(h.riderPhone || "")}</small></td>
        <td>${h.kind === "job" ? "🔔 Lead" : "👀 View"}<br><small class="muted">${esc(h.source || "")}</small></td><td>${esc([h.route, h.note].filter(Boolean).join(" · "))}</td>
        <td>${h.contactShown ? "shown" : h.visitorPhone ? "masked" : "-"}</td><td>${h.riderReady ? badge("ready", "green") : badge("locked", "orange")}</td><td>${h.alertSent ? "✅" : "❌"}</td></tr>`).join("");
      res.send(layout("Bikers", `
${subNav("activity")}${flash(req)}
<div class="panel"><p style="line-height:1.7;max-width:820px">Send riders a <strong>👀 profile view</strong> or a <strong>🔔 delivery lead near you</strong> alert. Riders who are not paid or not ID-approved see a <strong>masked</strong> customer number (+263 77 2XX XXXX) and are told to activate / verify to unlock it - their next reply opens activation. Ready riders get the full alert. Real views are sent automatically when someone opens a rider's link.</p></div>
<form method="POST" action="/zq-admin/bikers/activity" class="two-col">
  <div class="panel edit-form">
    <h3>1 · The activity</h3>
    <div class="fg"><label>Type</label><select name="kind"><option value="view">👀 Profile view</option><option value="job">🔔 Delivery lead near you</option></select></div>
    <div class="fg"><label>Customer WhatsApp (optional)</label><input name="visitorPhone" placeholder="0772 123 456"></div>
    <div class="fg"><label>Customer number shown</label><select name="contactMode">
      <option value="auto" selected>🧩 Auto - full to ready riders, masked to the rest</option>
      <option value="mask">🕵️ Masked teaser for everyone</option><option value="hide">🔒 Hidden</option><option value="show">📞 Full number</option></select></div>
    <div class="fg"><label>Route (for leads)</label><input name="route" placeholder="CBD → Avondale"></div>
    <div class="fg"><label>Note</label><input name="note" maxlength="140" placeholder="e.g. documents, needs it within the hour"></div>
    <div class="fg"><label>Came via (views)</label><select name="via"><option>WhatsApp Status</option><option>Facebook</option><option>riders list</option><option>rider link</option><option>QR code</option></select></div>
    <div class="fg"><label>Skip riders alerted in the last</label><select name="skipDays"><option value="0">Off</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option></select></div>
    <div class="fg"><label>🧪 Test - send a preview to this number only</label><input name="testPhone" placeholder="your number (leave blank to send for real)"></div>
    <button class="btn btn-green">Send activity</button>
  </div>
  <div class="panel">
    <h3>2 · Which riders <span class="count">${riders.length}</span></h3>
    <div class="filter-form" style="margin-bottom:8px">
      <a class="btn btn-sm ${who === "notready" ? "btn-blue" : "btn-gray"}" href="?who=notready&city=${encodeURIComponent(city)}">🔒 Not ready (unpaid / no ID)</a>
      <a class="btn btn-sm ${who === "unpaid" ? "btn-blue" : "btn-gray"}" href="?who=unpaid&city=${encodeURIComponent(city)}">💳 Unpaid</a>
      <a class="btn btn-sm ${who === "ready" ? "btn-blue" : "btn-gray"}" href="?who=ready&city=${encodeURIComponent(city)}">✅ Ready</a>
      <a class="btn btn-sm ${who === "all" ? "btn-blue" : "btn-gray"}" href="?who=all&city=${encodeURIComponent(city)}">All</a>
    </div>
    <label style="font-size:13px"><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)"> Select all shown</label>
    <div style="max-height:420px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:6px;margin-top:6px">${rows || `<div class="muted" style="padding:12px">No riders match.</div>`}</div>
  </div>
</form>
<div class="panel"><h3>Recent rider activity <span class="count">${hist.length}</span></h3>
  <div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Rider</th><th>Type</th><th>Detail</th><th>Contact</th><th>Rider</th><th>Sent</th></tr></thead>
  <tbody>${histRows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:16px">Nothing yet.</td></tr>`}</tbody></table></div></div>`));
    } catch (err) { res.send(layout("Bikers", `<div class="alert red">Error: ${esc(err.message)}</div>`)); }
  });

  router.post("/bikers/activity", requireSupplierAdmin, async (req, res) => {
    const back = "/zq-admin/bikers/activity";
    try {
      const b = req.body || {};
      const ids = [].concat(b.ids || []).filter(isId).slice(0, 300);
      const kind = b.kind === "job" ? "job" : "view";
      const contactMode = ["auto", "mask", "hide", "show"].includes(b.contactMode) ? b.contactMode : "auto";
      const common = { kind, contactMode, via: String(b.via || ""), note: String(b.note || ""), route: String(b.route || ""),
        visitorPhone: normPhone(b.visitorPhone || ""), createdBy: req.session?.adminUser || "admin", source: "admin" };
      const testTo = normPhone(b.testPhone || "");
      if (testTo) {
        const r = ids.length ? await SupplierProfile.findById(ids[0]).lean()
          : { _id: null, phone: testTo, businessName: "Test Rider (Rider)", riderDisplayName: "Test Rider", active: false };
        const out = await sendRiderActivityAlert({ ...common, rider: r, dryRunTo: testTo });
        return go(res, back, out.ok ? "success" : "error", out.ok ? `Test sent to ${testTo} (as ${publicName(r)} would see it).` : `Test failed: ${out.error}`);
      }
      if (!ids.length) throw new Error("Tick at least one rider (or enter a test number).");
      let skip = new Set();
      const days = Number(b.skipDays) || 0;
      if (days > 0) {
        const recent = await BikerActivity.find({ createdAt: { $gte: new Date(Date.now() - days * 86400000) }, alertSent: true, source: "admin" }, { riderPhone: 1 }).lean().catch(() => []);
        skip = new Set(recent.map(x => x.riderPhone));
      }
      const riders = await SupplierProfile.find({ _id: { $in: ids }, profileType: "biker" }).lean();
      let sent = 0, failed = 0, skipped = 0, masked = 0;
      for (const r of riders) {
        if (skip.has(normPhone(r.phone))) { skipped++; continue; }
        const out = await sendRiderActivityAlert({ ...common, rider: r }).catch(e => ({ ok: false, error: e.message }));
        out.ok ? sent++ : failed++;
        if (out.masked) masked++;
        await new Promise(x => setTimeout(x, 1000));
      }
      go(res, back, "success", `Sent ${sent}${masked ? ` (${masked} masked)` : ""}${skipped ? `, ${skipped} skipped (recent)` : ""}${failed ? `, ${failed} failed` : ""}.`);
    } catch (err) { go(res, back, "error", err.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RIDER PROFILE
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/bikers/:id", requireSupplierAdmin, async (req, res) => {
    if (!isId(req.params.id)) return res.redirect("/zq-admin/bikers");
    try {
      const r = await SupplierProfile.findById(req.params.id).lean();
      if (!r || r.profileType !== "biker") return res.redirect("/zq-admin/bikers");
      const phone = normPhone(r.phone);
      const jobs = await BikerJob.find({ $or: [{ assignedRiderPhone: phone }, { "responses.riderPhone": phone }, { cancelledRiderPhones: phone }] })
        .sort({ createdAt: -1 }).limit(60).lean();
      const mine = jobs.filter(j => j.assignedRiderPhone === phone);
      const done = mine.filter(j => j.status === "completed");
      const usd = j => (/zig/i.test(j.agreedFare || "") ? 0 : Number(j.agreedFareAmount) || 0);
      const earnings = done.reduce((s, j) => s + usd(j), 0);
      const weekAgo = Date.now() - 7 * 86400000;
      const weekEarn = done.filter(j => new Date(j.completedAt).getTime() > weekAgo).reduce((s, j) => s + usd(j), 0);
      const offers = jobs.filter(j => (j.responses || []).some(x => x.riderPhone === phone)).length;
      const winRate = offers ? Math.round((mine.length / Math.max(offers, mine.length)) * 100) : 0;
      const lvl = riderLevel(r.riderPoints);
      const link = riderLink(r._id);
      const name = r.riderLegalName || String(r.businessName || "Rider").replace(/\s*\(Rider\)$/i, "");
      const k = r.riderKyc || {};
      const safeUrl = u => String(u || "").replace(/^(\/zq-admin\/bikers\/kyc-file\/kyc_\d+_\d+)\.(jpg|png)$/i, "$1");
      const img = (u0, label, u = safeUrl(u0)) => u ? `<a href="${esc(u)}" target="_blank" style="text-align:center;font-size:12px"><img src="${esc(u)}" alt="${label}" onerror="this.outerHTML='<div style=&quot;width:220px;height:150px;border-radius:10px;background:#fef2f2;color:#b91c1c;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;padding:8px&quot;>⚠️ Could not load - click to see why</div>'" style="width:220px;height:150px;object-fit:cover;border-radius:10px;border:1px solid #e2e8f0;display:block;margin-bottom:4px">${label}</a>`
        : `<div style="width:220px;height:150px;border-radius:10px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:12px;color:#64748b;text-align:center">${label}<br>not sent</div>`;
      const kycPanel = `<div class="panel" id="kyc" style="border:2px solid ${isRiderVerified(r) ? "#bfdbfe" : k.status === "pending" ? "#fdba74" : "#e2e8f0"}">
  <h3>🪪 Identity check ${kycBadge(r)}</h3>
  <p class="muted" style="margin-bottom:10px">Jobs are only sent to riders who are <strong>paid AND approved</strong> - paying never skips this check. The ID photo and legal name are never shown to customers; customers see <strong>"${esc(publicName(r))}"</strong> before booking, then the first name <strong>${esc(String(name).split(/\s+/)[0])}</strong> + plate <strong>${esc(r.bike?.plate || "-")}</strong> after booking.</p>
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px">${img(k.idPhotoUrl, "🪪 National ID")}${img(k.selfieUrl || r.bike?.photoUrl, "📸 Rider + bike")}</div>
  <div class="muted" style="margin-bottom:10px">Legal name typed by rider: <strong>${esc(r.riderLegalName || "-")}</strong> · Plate: <strong>${esc(r.bike?.plate || "-")}</strong>${k.submittedAt ? ` · sent ${fmtDate(k.submittedAt)}` : ""}${k.reviewedAt ? ` · reviewed ${fmtDate(k.reviewedAt)} by ${esc(k.reviewedBy || "admin")}` : ""}${k.idLast4 ? ` · ID ends …${esc(k.idLast4)}` : ""}${k.rejectReason ? `<br>Last rejection: ${esc(k.rejectReason)}` : ""}</div>
  <div style="display:flex;gap:18px;flex-wrap:wrap">
    <form method="POST" action="/zq-admin/bikers/${r._id}/kyc" style="flex:1;min-width:260px;background:#f0fdf4;padding:12px;border-radius:10px">
      <input type="hidden" name="action" value="approve">
      <label style="display:block"><input type="checkbox" name="name" value="1"> Name on ID = <strong>${esc(r.riderLegalName || name)}</strong></label>
      <label style="display:block"><input type="checkbox" name="face" value="1"> Face on ID = face in bike photo</label>
      <label style="display:block"><input type="checkbox" name="plate" value="1"> Plate <strong>${esc(r.bike?.plate || "-")}</strong> visible &amp; matches</label>
      <input name="idLast4" maxlength="4" placeholder="ID last 4 (optional)" style="margin:8px 0;width:160px">
      <button class="btn btn-sm btn-green">✅ Approve ID</button>
    </form>
    <form method="POST" action="/zq-admin/bikers/${r._id}/kyc" style="flex:1;min-width:260px;background:#fef2f2;padding:12px;border-radius:10px">
      <input type="hidden" name="action" value="reject">
      <select name="reason" style="width:100%;margin-bottom:8px">
        <option>ID photo not clear - please retake in good light</option>
        <option>Name on ID doesn't match the name you registered</option>
        <option>Face not clear in the bike photo</option>
        <option>Number plate not visible in the bike photo</option>
        <option>ID looks edited or expired</option>
      </select>
      <button class="btn btn-sm btn-red">⚠️ Reject &amp; ask for new photos</button>
    </form>
  </div>
  ${isRiderVerified(r) ? `<form method="POST" action="/zq-admin/bikers/${r._id}/kyc" style="margin-top:10px" onsubmit="return confirm('Remove approval? The rider stops getting jobs.')"><input type="hidden" name="action" value="reset"><button class="btn btn-sm btn-gray">Remove approval</button></form>` : ""}
</div>`;
      const tog = (what, label, cls) => `<form method="POST" action="/zq-admin/bikers/${r._id}/toggle" style="display:inline"><input type="hidden" name="what" value="${what}"><button class="btn btn-sm ${cls}">${label}</button></form>`;

      const jobRows = jobs.map(j => {
        const role = j.assignedRiderPhone === phone ? "Assigned" : (j.cancelledRiderPhones || []).includes(phone) ? "Dropped" : "Offered";
        const off = (j.responses || []).find(x => x.riderPhone === phone);
        return `<tr>
          <td><a class="btn-link" href="/zq-admin/biker-jobs/${j._id}">${esc(jobRef(j))}</a><br><small class="muted">${fmtDate(j.createdAt)}</small></td>
          <td>${esc(j.pickup)} → ${esc(j.dropoff)}<br><small class="muted">${esc(j.task)}</small></td>
          <td>${statusBadge(j.status)}</td><td>${esc(role)}</td>
          <td>${esc(j.assignedRiderPhone === phone ? j.agreedFare : off?.fare || "-")}</td>
          <td>${j.assignedRiderPhone === phone && j.customerRating ? "⭐ " + j.customerRating : "-"}</td>
          <td>${j.assignedRiderPhone === phone ? (j.pointsAwarded || 0) : "-"}</td>
        </tr>`;
      }).join("");

      res.send(layout(`Biker: ${name}`, `
${subNav("bikers")}${flash(req)}
<div class="panel">
  <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
    ${r.bike?.photoUrl ? `<a href="${esc(r.bike.photoUrl)}" target="_blank"><img src="${esc(r.bike.photoUrl)}" style="width:110px;height:110px;object-fit:cover;border-radius:12px;border:1px solid #e2e8f0"></a>` : `<div style="width:110px;height:110px;border-radius:12px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:42px">🏍️</div>`}
    <div style="flex:1;min-width:220px">
      <h2 style="margin:0 0 6px;font-size:20px">${esc(name)} <small class="muted" style="font-weight:400">· shown as "${esc(publicName(r))}"</small></h2>
      <div style="margin-bottom:8px">${riderStatus(r)}</div>
      <div class="muted" style="line-height:1.7">📞 ${esc(r.phone)} &nbsp;·&nbsp; 📍 ${esc(r.location?.city || "-")} · ${esc((r.riderAreas || []).join(", ") || "Whole city")}<br>
      🏍️ <strong>${esc(r.bike?.plate || "-")}</strong> ${esc(r.bike?.model || "")} &nbsp;·&nbsp; Docs: ${r.bike?.licenceOnFile ? "Licence ✅" : "Licence ✗"} · ${r.bike?.idOnFile ? "ID ✅" : "ID ✗"} · ${r.bike?.insurance ? "Insured ✅" : "Insurance ✗"}<br>
      💳 ${esc(r.subscriptionStatus || "-")} · ends ${fmtDate(r.subscriptionEndsAt)} &nbsp;·&nbsp; Last seen ${fmtDate(r.riderLastSeenAt)}</div>
    </div>
    <div style="text-align:center"><img src="${qrUrl(link, 120)}" width="120" height="120" alt="QR"><br><small class="muted">Rider link QR</small></div>
  </div>
  <div class="action-row">
    ${tog("active", r.active ? "⏸ Deactivate" : "✅ Activate", r.active ? "btn-gray" : "btn-green")}
    ${tog("online", r.riderActive !== false ? "⚪ Set offline" : "🟢 Set online", "btn-gray")}
    <a class="btn btn-sm ${isRiderVerified(r) ? "btn-gray" : "btn-blue"}" href="#kyc">🪪 ID check</a>
    ${tog("suspended", r.suspended ? "Unsuspend" : "⛔ Suspend", r.suspended ? "btn-green" : "btn-red")}
    <a class="btn btn-sm btn-gray" href="/zq-admin/biker-jobs?q=${encodeURIComponent(phone)}">📦 All jobs</a>
    <a class="btn btn-sm btn-gray" href="https://wa.me/${phone}" target="_blank">💬 WhatsApp</a>
  </div>
</div>

${kycPanel}

<div class="stats-grid">
  ${stat(`${lvl.emoji} ${r.riderPoints || 0}`, `${lvl.name}${lvl.next ? ` · ${lvl.toNext} to ${lvl.next.name}` : ""}`, "purple")}
  ${stat(r.rating ? Number(r.rating).toFixed(1) : "-", `Rating (${r.reviewCount || 0} reviews)`, "yellow")}
  ${stat(r.completedTrips || 0, "Completed trips", "green")}
  ${stat("$" + earnings.toFixed(2), "Earnings (USD, all time)", "teal")}
  ${stat("$" + weekEarn.toFixed(2), "Earnings last 7 days", "teal")}
  ${stat(offers, "Prices sent", "blue")}
  ${stat(winRate + "%", "Win rate", "blue")}
  ${stat(r.riderCancels || 0, "Cancels", "red")}
</div>

<div class="two-col">
  <div class="panel">
    <h3>✏️ Edit rider</h3>
    <form method="POST" action="/zq-admin/bikers/${r._id}/edit" class="edit-form">
      <div class="form-grid">
        <div class="fg"><label>Legal name (as on ID)</label><input name="name" value="${esc(name)}"></div>
        <div class="fg"><label>Rider name (customers see)</label><input name="displayName" value="${esc(r.riderDisplayName || "")}" maxlength="20" placeholder="${esc(String(name).split(/\s+/)[0])}"></div>
        <div class="fg"><label>City</label><select name="city">${cityOptions(r.location?.city)}</select></div>
        <div class="fg"><label>Areas</label><input name="areas" value="${esc((r.riderAreas || []).join(", "))}" placeholder="blank = whole city"></div>
        <div class="fg"><label>Plate</label><input name="plate" value="${esc(r.bike?.plate || "")}"></div>
        <div class="fg"><label>Bike model</label><input name="bikeModel" value="${esc(r.bike?.model || "")}"></div>
        <div class="fg"><label>Photo URL</label><input name="photoUrl" value="${esc(r.bike?.photoUrl || "")}"></div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px">
        <label><input type="checkbox" name="licenceOnFile" value="true" ${r.bike?.licenceOnFile ? "checked" : ""}> Licence</label>
        <label><input type="checkbox" name="idOnFile" value="true" ${r.bike?.idOnFile ? "checked" : ""}> ID</label>
        <label><input type="checkbox" name="insurance" value="true" ${r.bike?.insurance ? "checked" : ""}> Insured</label>
      </div>
      <div class="fg full"><label>Admin note</label><textarea name="adminNote" rows="2">${esc(r.adminNote || "")}</textarea></div>
      <button class="btn btn-blue btn-sm">Save</button>
    </form>
  </div>
  <div>
    <div class="panel">
      <h3>🏆 Adjust points</h3>
      <form method="POST" action="/zq-admin/bikers/${r._id}/points" class="filter-form">
        <input name="delta" type="number" placeholder="+20 or -10" required style="width:110px">
        <input name="reason" placeholder="Reason (sent to rider)" style="flex:1">
        <button>Apply</button>
      </form>
      <p class="muted" style="margin-top:8px;font-size:12px">Auto rules: delivery +${RIDER_POINTS.complete}, fast price +${RIDER_POINTS.fast}, 5★ +${RIDER_POINTS.rate5}, 4★ +${RIDER_POINTS.rate4}, ≤2★ ${RIDER_POINTS.rateLow}, rider cancel ${RIDER_POINTS.cancel}.</p>
    </div>
    <div class="panel">
      <h3>💳 Extend subscription</h3>
      <form method="POST" action="/zq-admin/bikers/${r._id}/extend" class="filter-form">
        <select name="days"><option value="30">+1 month</option><option value="90">+3 months</option><option value="365">+1 year</option><option value="7">+7 days</option></select>
        <button>Extend &amp; activate</button>
      </form>
    </div>
    <div class="panel">
      <h3>💬 Message rider</h3>
      <form method="POST" action="/zq-admin/bikers/${r._id}/message">
        <div class="fg full"><textarea name="text" rows="3" required placeholder="Works if the rider messaged the bot in the last 24h"></textarea></div>
        <button class="btn btn-sm btn-blue">Send WhatsApp</button>
      </form>
    </div>
    <div class="panel">
      <h3>🔗 Rider link</h3>
      <p style="word-break:break-all;font-size:12px"><code>${esc(link)}</code></p>
      <p class="muted" style="font-size:12px;margin-top:6px">Customers who open it book this rider first.</p>
    </div>
  </div>
</div>

<div class="panel">
  <h3>📦 Recent jobs <span class="count">${jobs.length}</span></h3>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Ref</th><th>Route</th><th>Status</th><th>Role</th><th>Fare</th><th>Rating</th><th>Pts</th></tr></thead>
    <tbody>${jobRows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">No jobs yet</td></tr>`}</tbody>
  </table></div>
</div>

<div class="panel" style="border:1px solid #fecaca">
  <h3 style="color:#dc2626">Danger zone</h3>
  <form method="POST" action="/zq-admin/bikers/${r._id}/delete" onsubmit="return confirm('Delete this rider profile permanently? Their job history stays.')">
    <button class="btn btn-sm btn-red">Delete rider</button>
  </form>
</div>`));
    } catch (err) {
      res.send(layout("Bikers", `<div class="alert red">Error: ${esc(err.message)}</div>`));
    }
  });

  router.post("/bikers/:id/kyc", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      if (!isId(req.params.id)) throw new Error("Bad id");
      const b = req.body || {};
      const out = await adminReviewKyc(req.params.id, {
        action: b.action, reason: b.reason, idLast4: b.idLast4,
        checks: { name: b.name === "1", face: b.face === "1", plate: b.plate === "1" },
        by: req.session?.adminUser || "admin"
      });
      go(res, back + "#kyc", "success", out === "approved" ? "ID approved - rider notified." : out === "rejected" ? "Rejected - rider asked for new photos." : "Approval removed.");
    } catch (err) { go(res, back + "#kyc", "error", err.message); }
  });

  router.post("/bikers/:id/edit", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      if (!isId(req.params.id)) throw new Error("Bad id");
      const b = req.body || {};
      const r = await SupplierProfile.findById(req.params.id).lean();
      if (!r) throw new Error("Rider not found");
      const areas = String(b.areas || "").split(/[,\n;]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
      await SupplierProfile.updateOne({ _id: r._id }, { $set: {
        businessName: `${String(b.displayName || "").trim() || String(b.name || "Rider").trim().split(/\s+/)[0]} (Rider)`,
        riderLegalName: String(b.name || "").trim(),
        riderDisplayName: String(b.displayName || "").trim().slice(0, 20),
        "location.city": String(b.city || r.location?.city || "Harare").trim(),
        "location.area": areas[0] || String(b.city || "").trim(),
        riderAreas: areas,
        "bike.plate": String(b.plate || "").trim().toUpperCase(),
        "bike.model": String(b.bikeModel || "").trim(),
        "bike.photoUrl": String(b.photoUrl || "").trim(),
        "bike.licenceOnFile": b.licenceOnFile === "true",
        "bike.idOnFile": b.idOnFile === "true",
        "bike.insurance": b.insurance === "true",
        adminNote: String(b.adminNote || "")
      } }, { strict: false });
      invalidateRiderCache(r.phone);
      go(res, back, "success", "Saved.");
    } catch (err) { go(res, back, "error", err.message); }
  });

  router.post("/bikers/:id/toggle", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      const r = isId(req.params.id) ? await SupplierProfile.findById(req.params.id).lean() : null;
      if (!r) throw new Error("Rider not found");
      const what = req.body.what;
      let set = {}, msg = "";
      if (what === "active") {
        set = { active: !r.active, subscriptionStatus: !r.active ? "active" : "inactive" };
        if (!r.active && (!r.subscriptionEndsAt || new Date(r.subscriptionEndsAt) < new Date())) set.subscriptionEndsAt = new Date(Date.now() + 30 * 86400000);
        msg = !r.active ? "✅ Your ZimQuote Rider account is now *active*. Type *hi* to open your Rider Menu." : "";
      } else if (what === "online") {
        set = { riderActive: r.riderActive === false, riderMissedPings: 0 };
      } else if (what === "verified") {
        return go(res, back + "#kyc", "error", "Use the 🪪 Identity check panel to approve (it checks name, face and plate).");
      } else if (what === "suspended") {
        set = { suspended: !r.suspended };
        msg = !r.suspended ? "⛔ Your ZimQuote Rider account has been suspended. Please contact ZimQuote support." : "✅ Your ZimQuote Rider account has been restored.";
      } else throw new Error("Unknown action");
      await SupplierProfile.updateOne({ _id: r._id }, { $set: set }, { strict: false });
      invalidateRiderCache(r.phone);
      if (msg) await adminMessage(r.phone, msg).catch(() => {});
      go(res, back, "success", "Updated.");
    } catch (err) { go(res, back, "error", err.message); }
  });

  router.post("/bikers/:id/points", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      const delta = parseInt(req.body.delta, 10);
      if (!isId(req.params.id) || !delta) throw new Error("Enter a non-zero number.");
      const r = await addRiderPoints(req.params.id, delta);
      if (!r) throw new Error("Rider not found");
      const reason = String(req.body.reason || "").trim();
      await adminMessage(r.phone, `🏆 ZimQuote ${delta > 0 ? "added" : "removed"} *${Math.abs(delta)} points*${reason ? ` - ${reason}` : ""}. Total: ${r.riderPoints}.`).catch(() => {});
      go(res, back, "success", `Points updated (now ${r.riderPoints}).`);
    } catch (err) { go(res, back, "error", err.message); }
  });

  router.post("/bikers/:id/extend", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      const r = isId(req.params.id) ? await SupplierProfile.findById(req.params.id).lean() : null;
      if (!r) throw new Error("Rider not found");
      const days = Number(req.body.days) || 30;
      const base = r.subscriptionEndsAt && new Date(r.subscriptionEndsAt) > new Date() ? new Date(r.subscriptionEndsAt) : new Date();
      await SupplierProfile.updateOne({ _id: r._id }, { $set: { active: true, subscriptionStatus: "active", subscriptionEndsAt: new Date(base.getTime() + days * 86400000) } });
      invalidateRiderCache(r.phone);
      go(res, back, "success", `Extended by ${days} days.`);
    } catch (err) { go(res, back, "error", err.message); }
  });

  router.post("/bikers/:id/message", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/bikers/${req.params.id}`;
    try {
      const r = isId(req.params.id) ? await SupplierProfile.findById(req.params.id).lean() : null;
      if (!r) throw new Error("Rider not found");
      const ok = await adminMessage(r.phone, String(req.body.text || "").trim());
      go(res, back, ok ? "success" : "error", ok ? "Message sent." : "Could not send (rider may be outside the 24h WhatsApp window).");
    } catch (err) { go(res, back, "error", err.message); }
  });

  router.post("/bikers/:id/delete", requireSupplierAdmin, async (req, res) => {
    try {
      const r = isId(req.params.id) ? await SupplierProfile.findById(req.params.id).lean() : null;
      if (!r || r.profileType !== "biker") throw new Error("Rider not found");
      const busy = await BikerJob.countDocuments({ assignedRiderPhone: normPhone(r.phone), status: { $in: ["assigned", "picked_up"] } });
      if (busy) throw new Error(`Rider has ${busy} active job(s). Cancel or complete them first.`);
      await SupplierProfile.deleteOne({ _id: r._id });
      invalidateRiderCache(r.phone);
      go(res, "/zq-admin/bikers", "success", "Rider deleted.");
    } catch (err) { go(res, `/zq-admin/bikers/${req.params.id}`, "error", err.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELIVERIES LIST
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/biker-jobs", requireSupplierAdmin, async (req, res) => {
    try {
      const { status = "", city = "", q = "", days = "7", page = "1" } = req.query;
      const filter = {};
      if (status === "live") filter.status = { $in: ["assigned", "picked_up", "delivered"] };
      else if (status === "disputed") filter.disputed = true;
      else if (status) filter.status = status;
      if (city) filter.city = cityRe(city);
      if (days !== "all") filter.createdAt = { $gte: new Date(Date.now() - (Number(days) || 7) * 86400000) };
      if (q.trim()) {
        const t = q.trim();
        const rx = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const ph = normPhone(t);
        filter.$or = [{ reference: rx }, { pickup: rx }, { dropoff: rx }, { task: rx }, { customerName: rx }, { assignedRiderName: rx },
          ...(ph.length >= 9 ? [{ customerPhone: ph }, { assignedRiderPhone: ph }, { "responses.riderPhone": ph }] : [])];
      }
      const per = 50, pg = Math.max(1, Number(page) || 1);
      const [jobs, count, agg] = await Promise.all([
        BikerJob.find(filter).sort({ createdAt: -1 }).skip((pg - 1) * per).limit(per).lean(),
        BikerJob.countDocuments(filter),
        BikerJob.aggregate([{ $match: { createdAt: filter.createdAt || { $exists: true } } }, { $group: { _id: "$status", n: { $sum: 1 } } }])
      ]);
      const by = Object.fromEntries(agg.map(a => [a._id, a.n]));
      const totalAll = agg.reduce((s, a) => s + a.n, 0);
      const fill = totalAll ? Math.round(((by.completed || 0) / totalAll) * 100) : 0;
      const qs = o => "?" + new URLSearchParams({ status, city, q, days, ...o }).toString();
      const rows = jobs.map(j => `<tr>
        <td><a class="btn-link" href="/zq-admin/biker-jobs/${j._id}">${esc(jobRef(j))}</a>${j.disputed ? " " + badge("Dispute", "red") : ""}<br><small class="muted">${fmtDate(j.createdAt)}${j.source === "admin" ? " · admin" : ""}</small></td>
        <td>${esc(j.customerName || "")} <small>${esc(j.customerPhone)}</small></td>
        <td>${esc(j.pickup)} → ${esc(j.dropoff)}<br><small class="muted">${esc(j.task)}</small></td>
        <td>${esc(j.city)}</td>
        <td>${statusBadge(j.status)}</td>
        <td>${j.assignedRiderName ? esc(j.assignedRiderName) : `<small class="muted">${(j.responses || []).length} price(s) · ${(j.notifiedRiderPhones || []).length} alerted</small>`}</td>
        <td>${esc(j.agreedFare || "-")}</td>
        <td>${j.customerRating ? "⭐ " + j.customerRating : "-"}</td>
      </tr>`).join("");
      const pages = Math.ceil(count / per);
      res.send(layout("Deliveries", `
${subNav("jobs")}${flash(req)}
<div class="stats-grid">
  ${stat(totalAll, `Requests (${days === "all" ? "all time" : days + " days"})`, "blue")}
  ${stat(by.open || 0, "Open", "yellow")}
  ${stat((by.assigned || 0) + (by.picked_up || 0) + (by.delivered || 0), "In progress", "purple")}
  ${stat(by.completed || 0, "Completed", "green")}
  ${stat(by.cancelled || 0, "Cancelled", "gray")}
  ${stat(by.expired || 0, "Expired (no rider)", "orange")}
  ${stat(fill + "%", "Fulfilment rate", "teal")}
</div>
<div class="panel">
  <div class="panel-head"><h3>Deliveries <span class="count">${count}</span></h3>
    <form class="filter-form" method="GET">
      <input name="q" value="${esc(q)}" placeholder="Ref, phone, place, name">
      <select name="status">${[["", "All statuses"], ["open", "Open"], ["live", "In progress"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["expired", "Expired"], ["disputed", "Disputes"]]
        .map(([v, l]) => `<option value="${v}" ${status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select name="city"><option value="">All cities</option>${cityOptions(city)}</select>
      <select name="days">${[["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([v, l]) => `<option value="${v}" ${days === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button>Filter</button> <a class="btn-reset" href="/zq-admin/biker-jobs">Reset</a>
    </form>
  </div>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Ref</th><th>Customer</th><th>Route</th><th>City</th><th>Status</th><th>Rider</th><th>Fare</th><th>Rating</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No deliveries match.</td></tr>`}</tbody>
  </table></div>
  ${pages > 1 ? `<div class="pagination">${Array.from({ length: Math.min(pages, 20) }, (_, i) => `<a class="${i + 1 === pg ? "active" : ""}" href="${qs({ page: i + 1 })}">${i + 1}</a>`).join("")}</div>` : ""}
</div>`));
    } catch (err) {
      res.send(layout("Deliveries", `<div class="alert red">Error: ${esc(err.message)}</div>`));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MANUAL DELIVERY REQUEST
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/biker-jobs/new", requireSupplierAdmin, async (req, res) => {
    const riders = await SupplierProfile.find({ profileType: "biker", active: true, suspended: { $ne: true } })
      .sort({ "location.city": 1, riderPoints: -1 }).limit(500).lean().catch(() => []);
    const allRiders = await SupplierProfile.find({ profileType: "biker", suspended: { $ne: true } })
      .sort({ "location.city": 1, riderPoints: -1 }).limit(800).lean().catch(() => []);
    const targetOpts = allRiders.map(r => `<option value="${r._id}">${canTakeJobs(r) ? "✅" : "🔒"} ${esc(r.riderLegalName || publicName(r))} · ${esc(r.location?.city || "")} · ${esc(r.bike?.plate || "")}${canTakeJobs(r) ? "" : r.active ? " (ID not approved)" : " (not paid)"}</option>`).join("");
    const riderOpts = riders.filter(canTakeJobs).map(r => `<option value="${r._id}">${esc(r.riderLegalName || publicName(r))} · ${esc(r.location?.city || "")} · ${esc(r.bike?.plate || "")}${r.riderActive === false ? " (offline)" : ""}</option>`).join("");
    res.send(layout("New Delivery", `
${subNav("newjob")}${flash(req)}
<div class="panel edit-form" style="max-width:760px">
  <h3>📦 New delivery request</h3>
  <p class="muted" style="margin-bottom:14px">For customers who call or walk in. The customer gets WhatsApp updates exactly like a normal request. Leave city blank to auto-detect from the places (e.g. Avondale → Harare).</p>
  <form method="POST" action="/zq-admin/biker-jobs/new">
    <div class="form-grid">
      <div class="fg"><label>Customer WhatsApp *</label><input name="customerPhone" required placeholder="0772 123 456"></div>
      <div class="fg"><label>Customer name</label><input name="customerName" placeholder="Mai Tino"></div>
    </div>
    <div class="fg full"><label>What needs doing? *</label><input name="task" required placeholder="Collect documents / Buy 2 loaves / Deliver cake"></div>
    <div class="form-grid">
      <div class="fg"><label>Pickup *</label><input name="pickup" required placeholder="Joina City, CBD"></div>
      <div class="fg"><label>Drop-off *</label><input name="dropoff" required placeholder="12 Main Rd, Borrowdale"></div>
      <div class="fg"><label>City</label><select name="city"><option value="">Auto-detect</option>${cityOptions("")}</select></div>
      <div class="fg"><label>When</label><input name="when" value="Now" placeholder="Now / Today 3pm"></div>
    </div>
    <div class="panel" style="background:#f8fafc;box-shadow:none;border:1px solid #e2e8f0">
      <label style="display:block;margin-bottom:8px"><input type="radio" name="mode" value="dispatch" checked onchange="document.getElementById('asg').style.display='none';document.getElementById('tgt').style.display='none'"> <strong>Send to riders</strong> - nearby riders send prices, customer chooses</label>
      <label style="display:block;margin-bottom:8px"><input type="radio" name="mode" value="targets" onchange="document.getElementById('asg').style.display='none';document.getElementById('tgt').style.display='block'"> <strong>Send to chosen riders</strong> - ready riders get the job; unpaid / unverified riders get a 🔒 masked lead and are asked to activate</label>
      <div id="tgt" style="display:none;margin:0 0 10px 22px">
        <select name="targetIds" multiple size="8" style="width:100%">${targetOpts}</select>
        <label style="display:block;margin-top:6px"><input type="checkbox" name="alsoDispatch" value="true" checked> Also alert other ready riders nearby</label>
        <small class="muted">Hold Ctrl / ⌘ to pick several.</small>
      </div>
      <label style="display:block"><input type="radio" name="mode" value="assign" onchange="document.getElementById('asg').style.display='grid';document.getElementById('tgt').style.display='none'"> <strong>Assign a rider directly</strong> - price already agreed</label>
      <div id="asg" class="form-grid" style="display:none;margin-top:12px">
        <div class="fg"><label>Rider</label><select name="riderId"><option value="">- choose -</option>${riderOpts}</select></div>
        <div class="fg"><label>Agreed fare</label><input name="fare" placeholder="$5 or ZiG 120"></div>
      </div>
    </div>
    <label style="display:block;margin:10px 0"><input type="checkbox" name="notifyCustomer" value="true" checked> Send the customer a WhatsApp confirmation</label>
    <div class="form-actions"><button class="btn btn-green">Create request</button></div>
  </form>
</div>`));
  });

  router.post("/biker-jobs/new", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.task || "").trim()) throw new Error("Describe what needs doing.");
      const assign = b.mode === "assign";
      if (b.mode === "targets" && ![].concat(b.targetIds || []).filter(isId).length) throw new Error("Pick at least one rider.");
      if (assign && !isId(b.riderId)) throw new Error("Choose a rider to assign.");
      const job = await adminCreateJob({
        customerPhone: b.customerPhone, customerName: String(b.customerName || "").trim(),
        task: String(b.task).trim(), pickup: String(b.pickup || "").trim(), dropoff: String(b.dropoff || "").trim(),
        city: String(b.city || "").trim(), when: String(b.when || "Now").trim() || "Now",
        assignRiderId: assign ? b.riderId : null, fare: assign ? String(b.fare || "").trim() : "",
        notifyCustomer: b.notifyCustomer === "true", adminName: req.session?.adminUser || "admin",
        targetRiderIds: b.mode === "targets" ? [].concat(b.targetIds || []).filter(isId) : [],
        alsoDispatch: b.alsoDispatch === "true"
      });
      const alerted = (job.notifiedRiderPhones || []).length;
      const t = job._targets || {};
      go(res, `/zq-admin/biker-jobs/${job._id}`, "success",
        assign ? "Created and assigned." :
        (alerted ? `Created - ${alerted} rider(s) alerted.` : "Created - no ready riders alerted yet; it stays open.") +
        (t.teased ? ` ${t.teased} locked rider(s) got a masked lead.` : "") + (t.failed ? ` ${t.failed} lead(s) failed.` : ""));
    } catch (err) { go(res, "/zq-admin/biker-jobs/new", "error", err.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELIVERY DETAIL
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/biker-jobs/:id", requireSupplierAdmin, async (req, res) => {
    if (!isId(req.params.id)) return res.redirect("/zq-admin/biker-jobs");
    try {
      const j = await BikerJob.findById(req.params.id).lean();
      if (!j) return res.redirect("/zq-admin/biker-jobs");
      const id = j._id;
      const riders = j.status === "open"
        ? await SupplierProfile.find({ profileType: "biker", active: true, suspended: { $ne: true }, "location.city": cityRe(j.city) }).sort({ riderPoints: -1 }).limit(200).lean().catch(() => [])
        : [];
      const offers = [...(j.responses || [])].sort((a, b) => (a.fareAmount ?? 9999) - (b.fareAmount ?? 9999));
      const offerRows = offers.map(o => `<tr>
        <td>${esc(o.riderName)}${o.verified ? " ✅" : ""}<br><small class="muted">${esc(o.riderPhone)} · ${esc(o.plate || "")}</small></td>
        <td><strong>${esc(o.fare)}</strong></td><td>${esc(o.eta || "-")}</td>
        <td>${o.rating ? "⭐ " + Number(o.rating).toFixed(1) : "new"} · ${o.trips || 0} trips · ${riderLevel(o.points).emoji}</td>
        <td>${fmtDate(o.respondedAt)}</td>
        <td>${j.status === "open" && o.riderId ? `<form method="POST" action="/zq-admin/biker-jobs/${id}/assign" style="display:inline"><input type="hidden" name="riderId" value="${o.riderId}"><button class="btn btn-sm btn-green">Assign</button></form>` : ""}</td>
      </tr>`).join("");
      const hist = (j.history || []).slice().reverse().map(h => `<tr><td>${fmtDate(h.at)}</td><td>${esc(h.by)}</td><td>${esc(h.event)}</td><td>${esc(h.note || "")}</td></tr>`).join("");
      const canCancel = ["open", "assigned", "picked_up"].includes(j.status);
      const canComplete = ["assigned", "picked_up", "delivered"].includes(j.status);

      res.send(layout(`Delivery: ${jobRef(j)}`, `
${subNav("jobs")}${flash(req)}
<div class="panel">
  <div class="panel-head"><h3>${esc(jobRef(j))} ${statusBadge(j.status)} ${j.disputed ? badge("⚠️ Dispute", "red") : ""}</h3>
    <small class="muted">Created ${fmtDate(j.createdAt)}${j.source === "admin" ? " by " + esc(j.createdByAdmin || "admin") : ""}</small></div>
  <dl class="detail-list">
    <dt>Task</dt><dd>${esc(j.task)}</dd>
    <dt>Route</dt><dd><strong>${esc(j.pickup)}</strong> → <strong>${esc(j.dropoff)}</strong> · ${esc(j.city)}</dd>
    <dt>When</dt><dd>${esc(j.when || "Now")}</dd>
    <dt>Customer</dt><dd>${esc(j.customerName || "")} ${esc(j.customerPhone)} · <a class="btn-link" href="https://wa.me/${esc(j.customerPhone)}" target="_blank">WhatsApp</a> · <a class="btn-link" href="/zq-admin/biker-jobs?q=${encodeURIComponent(j.customerPhone)}&days=all">History</a></dd>
    <dt>Rider</dt><dd>${j.assignedRiderPhone ? `${j.assignedRiderId ? `<a class="btn-link" href="/zq-admin/bikers/${j.assignedRiderId}">${esc(j.assignedRiderName)}</a>` : esc(j.assignedRiderName)} · ${esc(j.assignedRiderPhone)}` : `<span class="muted">Not assigned · ${(j.notifiedRiderPhones || []).length} alerted · ${(j.busyRiderPhones || []).length} busy</span>`}</dd>
    <dt>Fare</dt><dd>${esc(j.agreedFare || "-")}${j.agreedEta ? " · ⏱ " + esc(j.agreedEta) : ""}</dd>
    <dt>Times</dt><dd>Assigned ${fmtDate(j.assignedAt)} · Picked up ${fmtDate(j.pickedUpAt)} · Delivered ${fmtDate(j.deliveredAt)} · Completed ${fmtDate(j.completedAt)}${j.completedBy ? " (" + esc(j.completedBy) + ")" : ""}</dd>
    ${j.riderNote ? `<dt>Rider note</dt><dd>${esc(j.riderNote)}</dd>` : ""}
    ${j.customerRating ? `<dt>Rating</dt><dd>${"⭐".repeat(j.customerRating)} (${j.customerRating}/5)</dd>` : ""}
    ${j.customerNote ? `<dt>Customer note</dt><dd>${esc(j.customerNote)}</dd>` : ""}
    ${j.problemReport ? `<dt>Problem</dt><dd class="admin-note">${esc(j.problemReport)}</dd>` : ""}
    ${j.cancelReason ? `<dt>Cancelled</dt><dd>By ${esc(j.cancelledBy)} · ${esc(j.cancelReason)} · ${fmtDate(j.cancelledAt)}</dd>` : ""}
    ${(j.cancelledRiderPhones || []).length ? `<dt>Dropped by</dt><dd>${(j.cancelledRiderPhones || []).map(esc).join(", ")}</dd>` : ""}
    <dt>Points</dt><dd>${j.pointsAwarded || 0}</dd>
  </dl>
</div>

${j.disputed ? `<div class="panel" style="border:2px solid #fecaca">
  <h3>⚠️ Resolve dispute</h3>
  <form method="POST" action="/zq-admin/biker-jobs/${id}/resolve">
    <div class="fg full"><textarea name="note" rows="2" placeholder="What did you find? (saved on the job)"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-sm btn-green" name="outcome" value="rider_ok">Rider was fine → complete + points</button>
      <button class="btn btn-sm btn-red" name="outcome" value="rider_fault">Rider at fault → -15 points</button>
      <button class="btn btn-sm btn-gray" name="outcome" value="none">Close, no change</button>
    </div>
  </form>
</div>` : ""}

<div class="two-col">
  <div class="panel">
    <h3>Actions</h3>
    ${j.status === "open" ? `
    <form method="POST" action="/zq-admin/biker-jobs/${id}/assign" class="filter-form" style="margin-bottom:12px">
      <select name="riderId" required><option value="">Assign a rider…</option>${riders.map(r => `<option value="${r._id}">${esc(String(r.businessName || "").replace(/\s*\(Rider\)$/i, ""))} · ${esc(r.bike?.plate || "")}${r.riderActive === false ? " (offline)" : ""}</option>`).join("")}</select>
      <input name="fare" placeholder="Fare e.g. $5" style="width:110px">
      <button>Assign</button>
    </form>` : ""}
    ${["open", "expired"].includes(j.status) ? `<form method="POST" action="/zq-admin/biker-jobs/${id}/redispatch" style="margin-bottom:12px"><button class="btn btn-sm btn-blue">🔔 Alert more riders${j.status === "expired" ? " (re-open)" : ""}</button></form>` : ""}
    ${canComplete ? `<form method="POST" action="/zq-admin/biker-jobs/${id}/complete" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-green" name="points" value="yes">✅ Mark completed (+points)</button>
      <button class="btn btn-sm btn-gray" name="points" value="no">Complete without points</button></form>` : ""}
    ${canCancel ? `<form method="POST" action="/zq-admin/biker-jobs/${id}/cancel" class="filter-form">
      <input name="reason" placeholder="Reason (sent to customer & rider)" required style="flex:1">
      <button style="background:#ef4444">Cancel job</button></form>` : ""}
    ${!canCancel && !canComplete && j.status !== "open" && j.status !== "expired" ? `<p class="muted">No actions - this job is ${esc(STATUS_LABEL[j.status] || j.status)}.</p>` : ""}
  </div>
  <div class="panel">
    <h3>Admin note</h3>
    <form method="POST" action="/zq-admin/biker-jobs/${id}/note">
      <div class="fg full"><textarea name="adminNote" rows="3">${esc(j.adminNote || "")}</textarea></div>
      <button class="btn btn-sm btn-blue">Save note</button>
    </form>
  </div>
</div>

<div class="panel">
  <h3>💵 Prices from riders <span class="count">${offers.length}</span></h3>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Rider</th><th>Fare</th><th>ETA</th><th>Profile</th><th>Sent</th><th></th></tr></thead>
    <tbody>${offerRows || `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">No prices yet</td></tr>`}</tbody>
  </table></div>
</div>
<div class="panel">
  <h3>🕒 Timeline</h3>
  <table><thead><tr><th>When</th><th>By</th><th>Event</th><th>Note</th></tr></thead><tbody>${hist}</tbody></table>
</div>`));
    } catch (err) {
      res.send(layout("Deliveries", `<div class="alert red">Error: ${esc(err.message)}</div>`));
    }
  });

  const jobAction = (path, fn) => router.post(`/biker-jobs/:id/${path}`, requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/biker-jobs/${req.params.id}`;
    try {
      if (!isId(req.params.id)) throw new Error("Bad id");
      const msg = await fn(req);
      go(res, back, "success", msg || "Done.");
    } catch (err) { go(res, back, "error", err.message); }
  });
  jobAction("assign", async req => {
    if (!isId(req.body.riderId)) throw new Error("Choose a rider.");
    await adminAssignJob(req.params.id, req.body.riderId, String(req.body.fare || "").trim(), req.session?.adminUser || "admin");
    return "Rider assigned - both sides notified.";
  });
  jobAction("cancel", async req => { await adminCancelJob(req.params.id, String(req.body.reason || "Cancelled by ZimQuote").trim()); return "Cancelled - customer & rider notified."; });
  jobAction("complete", async req => { await adminCompleteJob(req.params.id, { awardPoints: req.body.points !== "no" }); return "Marked completed."; });
  jobAction("redispatch", async req => { const n = await adminRedispatchJob(req.params.id); return n ? `${n} more rider(s) alerted.` : "No other riders available right now."; });
  jobAction("resolve", async req => {
    const outcome = ["rider_ok", "rider_fault", "none"].includes(req.body.outcome) ? req.body.outcome : "none";
    await adminResolveDispute(req.params.id, { outcome, note: String(req.body.note || "").trim() });
    return "Dispute resolved.";
  });
  jobAction("note", async req => {
    await BikerJob.updateOne({ _id: req.params.id }, { $set: { adminNote: String(req.body.adminNote || "").slice(0, 2000) } });
    return "Note saved.";
  });
}

export default registerBikerAdminRoutes;

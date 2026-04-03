// routes/supplierAdmin.js
import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";
import SupplierSubscriptionPayment from "../models/supplierSubscriptionPayment.js";
import PhoneContact from "../models/phoneContact.js";   // ← ADD THIS LINE

import CategoryPreset from "../models/categoryPreset.js";
import { SUPPLIER_CATEGORIES } from "../services/supplierPlans.js";
import { TEMPLATES, getPresetCategories, setTemplateForCategory } from "../services/supplierProductTemplates.js";


const router = express.Router();

router.use(express.json());

const ADMIN_PASSWORD = process.env.SUPPLIER_ADMIN_PASSWORD || "zimquote_admin_2026";

// ── Login ──────────────────────────────────────────────────────────────────
router.get("/login", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>ZimQuote Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:white;padding:40px;border-radius:12px;width:360px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h2{margin-bottom:8px;color:#0f172a;font-size:22px}
p{color:#64748b;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;
      margin-bottom:16px;font-size:16px;outline:none}
input:focus{border-color:#2563eb}
button{width:100%;padding:12px;background:#2563eb;color:white;
       border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}
button:hover{background:#1d4ed8}
.error{color:#ef4444;margin-bottom:12px;font-size:14px;background:#fef2f2;
       padding:10px;border-radius:6px}
</style></head><body>
<div class="card">
  <h2>⚡ ZimQuote Admin</h2>
  <p>Supplier platform management</p>
  ${req.query.error ? '<div class="error">❌ Invalid password. Try again.</div>' : ""}
  <form method="POST" action="/zq-admin/login">
    <input type="password" name="password" placeholder="Enter admin password" autofocus autocomplete="off"/>
    <button type="submit">Login →</button>
  </form>
</div>
</body></html>`);
});

router.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isSupplierAdmin = true;
    res.redirect("/zq-admin");
  } else {
    res.redirect("/zq-admin/login?error=1");
  }
});

router.post("/logout", requireSupplierAdmin, (req, res) => {
  req.session.isSupplierAdmin = false;
  res.redirect("/zq-admin/login");
});

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const [
      totalSuppliers,
      activeSuppliers,
      pendingSuppliers,
      totalOrders,
      pendingOrders,
      acceptedOrders,
      completedOrders,
      recentSuppliers,
      recentOrders,
      revenue
    ] = await Promise.all([
      SupplierProfile.countDocuments(),
      SupplierProfile.countDocuments({ active: true }),
      SupplierProfile.countDocuments({ active: false }),
      SupplierOrder.countDocuments(),
      SupplierOrder.countDocuments({ status: "pending" }),
      SupplierOrder.countDocuments({ status: "accepted" }),
      SupplierOrder.countDocuments({ status: "completed" }),
      SupplierProfile.find().sort({ createdAt: -1 }).limit(5).lean(),
      SupplierOrder.find().sort({ createdAt: -1 }).limit(5)
        .populate("supplierId", "businessName").lean(),
      SupplierSubscriptionPayment.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const totalRevenue = revenue[0]?.total || 0;

    res.send(layout("Dashboard", `
      <div class="stats-grid">
        ${stat(totalSuppliers, "Total Suppliers", "")}
        ${stat(activeSuppliers, "Active Listings", "green")}
        ${stat(pendingSuppliers, "Inactive", "orange")}
        ${stat(totalOrders, "Total Orders", "blue")}
        ${stat(pendingOrders, "Pending Orders", "yellow")}
        ${stat(completedOrders, "Completed Orders", "teal")}
        ${stat("$" + totalRevenue.toFixed(2), "Subscription Revenue", "purple")}
      </div>

      <div class="two-col">
        <div class="panel">
          <h3>Recent Suppliers</h3>
          <table>
            <thead><tr><th>Business</th><th>Phone</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${recentSuppliers.map(s => `
              <tr>
                <td><strong>${esc(s.businessName)}</strong></td>
                <td>${esc(s.phone)}</td>
                <td>${badge(s.active ? "Active" : "Inactive", s.active ? "green" : "gray")}</td>
                <td><a href="/zq-admin/suppliers/${s._id}" class="btn-link">View →</a></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h3>Recent Orders</h3>
          <table>
            <thead><tr><th>Supplier</th><th>Buyer</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>
              ${recentOrders.map(o => `
              <tr>
                <td>${esc(o.supplierId?.businessName || "Unknown")}</td>
                <td>${esc(o.buyerPhone)}</td>
                <td>${badge(o.status, statusColor(o.status))}</td>
                <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Dashboard", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── Suppliers List ─────────────────────────────────────────────────────────
router.get("/suppliers", requireSupplierAdmin, async (req, res) => {
  try {
    const { search = "", status = "", tier = "", page = 1 } = req.query;
    const limit = 20;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { businessName: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { "location.city": { $regex: search, $options: "i" } }
      ];
    }
    if (status === "active") query.active = true;
    if (status === "inactive") query.active = false;
    if (tier) query.tier = tier;

    const [suppliers, total] = await Promise.all([
      SupplierProfile.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierProfile.countDocuments(query)
    ]);

    const pages = Math.ceil(total / limit);
    const qs = (p) => `?page=${p}&search=${encodeURIComponent(search)}&status=${status}&tier=${tier}`;

    res.send(layout("Suppliers", `
<div class="panel">
    <div class="panel-head">
          <h3>Suppliers <span class="count">${total}</span></h3>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <a href="/zq-admin/suppliers/new" class="btn btn-green btn-sm">➕ Register New</a>
            <form method="GET" class="filter-form">
              <input name="search" placeholder="Name, phone, city..." value="${esc(search)}" />
              <select name="status">
                <option value="">All Status</option>
                <option ${status === "active" ? "selected" : ""} value="active">Active</option>
                <option ${status === "inactive" ? "selected" : ""} value="inactive">Inactive</option>
              </select>
              <select name="tier">
                <option value="">All Tiers</option>
                <option ${tier === "basic" ? "selected" : ""} value="basic">Basic</option>
                <option ${tier === "pro" ? "selected" : ""} value="pro">Pro</option>
                <option ${tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
              <button type="submit">Filter</button>
              <a href="/zq-admin/suppliers" class="btn-reset">Clear</a>
            </form>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Business</th><th>Phone</th><th>City</th><th>Type</th>
              <th>Tier</th><th>Status</th><th>Orders</th><th>Rating</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${suppliers.map(s => `
            <tr>
              <td><strong>${esc(s.businessName)}</strong></td>
              <td>${esc(s.phone)}</td>
              <td>${esc(s.location?.city || "-")}</td>
              <td><span class="type-pill">${s.profileType || "product"}</span></td>
              <td>${badge(s.tier || "basic", tierColor(s.tier))}</td>
              <td>${badge(s.active ? "Active" : "Inactive", s.active ? "green" : "gray")}</td>
              <td>${s.completedOrders || 0}</td>
              <td>⭐ ${(s.rating || 0).toFixed(1)}</td>
              <td><a href="/zq-admin/suppliers/${s._id}" class="btn-link">Manage →</a></td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/suppliers${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Suppliers", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── Register New Supplier (Admin) ──────────────────────────────────────────
router.get("/suppliers/new", requireSupplierAdmin, async (req, res) => {
  const { SUPPLIER_CITIES, SUPPLIER_CATEGORIES, SERVICE_COLLAR_GROUPS } = await import("../services/supplierPlans.js");

  const productCats = SUPPLIER_CATEGORIES.filter(c => c.types?.includes("product"));
  const serviceCats = SUPPLIER_CATEGORIES.filter(c => c.types?.includes("service"));

  // Build category options grouped by collar for services
  const serviceOptgroups = Object.entries(SERVICE_COLLAR_GROUPS).map(([key, group]) => {
    const cats = serviceCats.filter(c => c.collar === key);
    const options = cats.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("");
    return `<optgroup label="${esc(group.label)}">${options}</optgroup>`;
  }).join("");

  const productOptions = productCats.map(c =>
    `<option value="${esc(c.id)}">${esc(c.label)}</option>`
  ).join("");

  const cityOptions = SUPPLIER_CITIES.map(city =>
    `<option value="${esc(city)}">${esc(city)}</option>`
  ).join("");

  const subcatMap = SUPPLIER_CATEGORIES
    .filter(c => c.subcats?.length)
    .reduce((acc, c) => {
      acc[c.id] = c.subcats.map(s => ({ id: s.id, label: s.label }));
      return acc;
    }, {});

  const error   = req.query.error   ? `<div class="alert red" style="margin-bottom:16px">❌ ${esc(req.query.error)}</div>` : "";
  const success = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";

  res.send(layout("Register Supplier", `
    <a href="/zq-admin/suppliers" class="back-link">← Back to Suppliers</a>
    ${error}${success}

    <div class="panel" style="max-width:860px">
      <div class="panel-head">
        <h3>➕ Register New Supplier / Service Provider</h3>
        <span style="font-size:12px;color:var(--muted)">Admin-created listing — bypasses WhatsApp flow</span>
      </div>

      <form method="POST" action="/zq-admin/suppliers/new" class="edit-form">

        <!-- ── SECTION 1: Business Info ─────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            1. Business Info
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Business Name <span style="color:red">*</span></label>
              <input name="businessName" placeholder="e.g. Ace Hardware Harare" required />
            </div>
            <div class="fg">
              <label>WhatsApp Phone <span style="color:red">*</span></label>
              <input name="phone" placeholder="e.g. 2637712345678" required
                     title="Include country code, no + sign. e.g. 2637712345678" />
            </div>
            <div class="fg">
              <label>City <span style="color:red">*</span></label>
              <select name="city" required>
                <option value="">Select city...</option>
                ${cityOptions}
                <option value="Other">Other</option>
              </select>
            </div>
                    <div class="fg">
              <label>Area / Suburb <span style="color:red">*</span></label>
              <input name="area" placeholder="e.g. Borrowdale, Avondale" required />
            </div>
            <div class="fg">
              <label>Address</label>
              <input name="address" placeholder="e.g. 123 Samora Machel Ave / Shop 12 / Stand 45" />
            </div>
          </div>
        </div>

        <!-- ── SECTION 2: Business Type & Category ──────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            2. Type & Category
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Profile Type <span style="color:red">*</span></label>
              <select name="profileType" id="profileTypeSelect" required onchange="toggleCategoryGroups()">
                <option value="product">📦 Product Supplier</option>
                <option value="service">🔧 Service Provider</option>
              </select>
            </div>
            <div class="fg">
              <label>Tier / Plan <span style="color:red">*</span></label>
              <select name="tier" required>
                <option value="basic">Basic — up to 20 items</option>
                <option value="pro">Pro — up to 60 items</option>
                <option value="featured">Featured — up to 150 items</option>
              </select>
            </div>
          </div>
          <div class="form-grid">
            <div class="fg" id="productCatWrap">
              <label>Product Category</label>
              <select name="productCategory" id="productCategorySelect" onchange="updateSubcats()">
                <option value="">Select category...</option>
                ${productOptions}
              </select>
            </div>
            <div class="fg" id="serviceCatWrap" style="display:none">
              <label>Service Category</label>
              <select name="serviceCategory" id="serviceCategorySelect" onchange="updateSubcats()">
                <option value="">Select category...</option>
                ${serviceOptgroups}
              </select>
            </div>
            <div class="fg" id="subcatWrap" style="display:none">
              <label>Specialisation / Sub-category</label>
              <select name="subcategory" id="subcategorySelect">
                <option value="">All / General</option>
              </select>
            </div>
          </div>
        </div>

        <!-- ── SECTION 3: Products / Services ───────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            3. Products / Services
          </p>
          <div class="fg full" style="margin-bottom:12px">
            <label id="productsLabel">Products (comma-separated)</label>
            <textarea name="products" id="productsTextarea" rows="4"
              placeholder="cooking oil, rice, sugar, mealie meal 10kg"></textarea>
            <span style="font-size:11px;color:var(--muted)">These become the supplier's searchable catalogue items.</span>
          </div>
          <div class="fg full" id="pricesWrap" style="margin-bottom:12px">
            <label>Prices (one per line: <code>product, amount, unit</code>)</label>
            <textarea name="prices" rows="4"
              placeholder="cooking oil, 4.50, litre&#10;rice, 8.00, 5kg bag&#10;sugar, 1.20, kg"></textarea>
            <span style="font-size:11px;color:var(--muted)">Optional — leave blank to let supplier set prices later.</span>
          </div>
          <div class="fg full" id="ratesWrap" style="display:none;margin-bottom:12px">
            <label>Service Rates (one per line: <code>service name, rate</code>)</label>
            <textarea name="rates" rows="4"
              placeholder="burst pipe repair, 30/job&#10;geyser installation, 80/job&#10;blocked drain, 25/hr"></textarea>
            <span style="font-size:11px;color:var(--muted)">Optional — format: <code>service name, amount/unit</code></span>
          </div>
        </div>

        <!-- ── SECTION 4: Delivery / Travel ─────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            4. Delivery / Travel
          </p>
          <div class="form-grid">
            <div class="fg" id="deliveryWrap">
              <label>Delivery Available?</label>
              <select name="deliveryAvailable">
                <option value="false">🏠 Collection Only</option>
                <option value="true">🚚 Yes, Delivers</option>
              </select>
            </div>
            <div class="fg" id="travelWrap" style="display:none">
              <label>Travel to Clients?</label>
              <select name="travelAvailable">
                <option value="true">🚗 Yes, Travels to Clients</option>
                <option value="false">📍 Clients Come to Provider</option>
              </select>
            </div>
            <div class="fg">
              <label>Min Order ($)</label>
              <input type="number" name="minOrder" value="0" min="0" step="0.5" />
            </div>
          </div>
        </div>

        <!-- ── SECTION 5: Subscription & Activation ─────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            5. Subscription & Activation
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Billing Cycle</label>
              <select name="billingCycle">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div class="fg">
              <label>Duration (days)</label>
              <input type="number" name="durationDays" value="30" min="1" max="365" />
            </div>
            <div class="fg">
              <label>Set Active Immediately?</label>
              <select name="setActive">
                <option value="true">✅ Yes — visible to buyers now</option>
                <option value="false">⏸ No — save as inactive</option>
              </select>
            </div>
            <div class="fg">
              <label>Currency</label>
              <select name="currency">
                <option value="USD">USD ($)</option>
                <option value="ZWL">ZWL (Z$)</option>
                <option value="ZAR">ZAR (R)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- ── SECTION 6: Admin Note ─────────────────────────────────── -->
        <div class="fg full" style="margin-bottom:20px">
          <label>Admin Note (internal only)</label>
          <textarea name="adminNote" rows="2"
            placeholder="e.g. Registered at trade fair, paid cash, free trial..."></textarea>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-green">✅ Register Supplier</button>
          <a href="/zq-admin/suppliers" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>

    <script>
    const SUBCATS = ${JSON.stringify(subcatMap)};

    function toggleCategoryGroups() {
      const isService = document.getElementById("profileTypeSelect").value === "service";
      document.getElementById("productCatWrap").style.display  = isService ? "none" : "";
      document.getElementById("serviceCatWrap").style.display  = isService ? ""     : "none";
      document.getElementById("deliveryWrap").style.display    = isService ? "none" : "";
      document.getElementById("travelWrap").style.display      = isService ? ""     : "none";
      document.getElementById("pricesWrap").style.display      = isService ? "none" : "";
      document.getElementById("ratesWrap").style.display       = isService ? ""     : "none";
      document.getElementById("productsLabel").textContent     = isService
        ? "Services (comma-separated)" : "Products (comma-separated)";
      document.getElementById("productsTextarea").placeholder  = isService
        ? "burst pipe repair, geyser installation, blocked drain"
        : "cooking oil, rice, sugar, mealie meal 10kg";
      document.getElementById("subcatWrap").style.display = "none";
      document.getElementById("subcategorySelect").innerHTML = '<option value="">All / General</option>';
    }

    function updateSubcats() {
      const isService = document.getElementById("profileTypeSelect").value === "service";
      const catId = isService
        ? document.getElementById("serviceCategorySelect").value
        : document.getElementById("productCategorySelect").value;
      const subs = SUBCATS[catId] || [];
      const subcatWrap   = document.getElementById("subcatWrap");
      const subcatSelect = document.getElementById("subcategorySelect");
      if (subs.length) {
        subcatSelect.innerHTML = '<option value="">All / General</option>' +
          subs.map(s => '<option value="' + s.id + '">' + s.label + '</option>').join("");
        subcatWrap.style.display = "";
      } else {
        subcatSelect.innerHTML = '<option value="">All / General</option>';
        subcatWrap.style.display = "none";
      }
    }
    </script>
  `));
});

router.post("/suppliers/new", requireSupplierAdmin, async (req, res) => {
  try {
    const {
      businessName, phone, city, area, address, profileType,
      tier, billingCycle, durationDays, setActive,
      productCategory, serviceCategory, subcategory,
      products, prices, rates,
      deliveryAvailable, travelAvailable, minOrder,
      currency, adminNote
    } = req.body;

    if (!businessName?.trim()) throw new Error("Business name is required.");
    if (!phone?.trim())        throw new Error("Phone number is required.");
    if (!city?.trim())         throw new Error("City is required.");
    if (!area?.trim())         throw new Error("Area/suburb is required.");

    const cleanPhone = phone.trim().replace(/\s+/g, "");

    const existing = await SupplierProfile.findOne({ phone: cleanPhone });
    if (existing) {
      return res.redirect(
        `/zq-admin/suppliers/new?error=${encodeURIComponent(
          "A supplier with phone " + cleanPhone + " already exists."
        )}`
      );
    }

    const productList = (products || "")
      .split(",")
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);

    const priceList = [];
    if (prices && profileType !== "service") {
      for (const line of (prices || "").split("\n")) {
        const parts  = line.split(",").map(s => s.trim());
        const name   = parts[0]?.toLowerCase();
        const amount = parseFloat(parts[1]);
        const unit   = parts[2] || "each";
        if (name && !isNaN(amount) && amount > 0) {
          priceList.push({ product: name, amount, unit, inStock: true, currency: "USD" });
        }
      }
    }

    const rateList = [];
    if (rates && profileType === "service") {
      for (const line of (rates || "").split("\n")) {
        const parts   = line.split(",").map(s => s.trim());
        const service = parts[0]?.toLowerCase();
        const rate    = parts[1]?.trim();
        if (service && rate) rateList.push({ service, rate });
      }
    }

    const category   = profileType === "service" ? serviceCategory : productCategory;
    const categories = category ? [category.trim()] : [];

    const now       = new Date();
    const days      = Number(durationDays) || 30;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const tierRank  = tier === "featured" ? 3 : tier === "pro" ? 2 : 1;

    // Tier → Business package mapping (mirrors supplierRegistration.js)
    const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
    const bizPackage = TIER_TO_PACKAGE[tier] || "bronze";
    const isActive   = setActive === "true";

    // ── Import models needed for full business account setup ──────────────
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    // ── 1. Create the Business record ─────────────────────────────────────
       const newBiz = await Business.create({
      name:                businessName.trim(),
      address:             address?.trim() || "",
      currency:            currency || "USD",
      package:             isActive ? bizPackage : "trial",
      subscriptionStatus:  isActive ? "active" : "inactive",
      subscriptionStartedAt: isActive ? now : undefined,
      subscriptionEndsAt:    isActive ? expiresAt : undefined,
      isSupplier:          true,
      ownerPhone:          cleanPhone,
      sessionState:        "ready",
      sessionData:         {}
    });

    // ── 2. Create UserRole (owner) ────────────────────────────────────────
    await UserRole.create({
      phone:      cleanPhone,
      role:       "owner",
      pending:    false,
      businessId: newBiz._id
    });

    // ── 3. Create main Branch ─────────────────────────────────────────────
    const mainBranch = await Branch.create({
      businessId: newBiz._id,
      name:       "Main Branch",
      isDefault:  true
    });

    // ── 4. Link branch to the owner's UserRole ────────────────────────────
    await UserRole.findOneAndUpdate(
      { phone: cleanPhone, businessId: newBiz._id },
      { branchId: mainBranch._id }
    );

    // ── 5. Set activeBusinessId in UserSession so WhatsApp login works ────
    await UserSession.findOneAndUpdate(
      { phone: cleanPhone },
      { phone: cleanPhone, activeBusinessId: newBiz._id },
      { upsert: true }
    );

    // ── 6. Create SupplierProfile linked to the Business ──────────────────
     const supplier = await SupplierProfile.create({
      businessName:          businessName.trim(),
      phone:                 cleanPhone,
      businessId:            newBiz._id,
      mainBranchId:          mainBranch._id,
      location:              { city: city.trim(), area: area.trim() },
      address:               address?.trim() || "",
      profileType:           profileType || "product",
      categories,
      subcategory:           subcategory || null,
      products:              productList,
      listedProducts:        productList,
      prices:                priceList,
      rates:                 rateList,
      tier:                  tier || "basic",
      tierRank,
      subscriptionStatus:    "active",
      subscriptionPlan:      billingCycle || "monthly",
      subscriptionStartedAt: now,
      subscriptionEndsAt:    expiresAt,
      active:                isActive,
      delivery: {
        available: profileType === "service" ? false : deliveryAvailable === "true"
      },
      travelAvailable:  profileType === "service" ? travelAvailable === "true" : false,
      minOrder:         Number(minOrder) || 0,
      rating:           0,
      reviewCount:      0,
      completedOrders:  0,
      monthlyOrders:    0,
      credibilityScore: 0,
      adminNote: adminNote?.trim()
        ? `[Admin registered on ${now.toDateString()}] ${adminNote.trim()}`
        : `[Admin registered on ${now.toDateString()}]`
    });

    // ── 7. Link SupplierProfile ID back onto the Business ─────────────────
    await Business.findByIdAndUpdate(newBiz._id, {
      supplierProfileId: supplier._id
    });

    // ── 8. Sync products/services into the Product model ──────────────────
    // (mirrors the sync in supplierRegistration.js so catalogue is ready)
    const capMap   = { basic: 20, pro: 60, featured: 150 };
    const cap      = capMap[tier] || 20;
    const toSync   = productList.slice(0, cap);
    for (const itemName of toSync) {
      const priceEntry = priceList.find(p => p.product === itemName);
      const rateEntry  = rateList.find(r => r.service === itemName);
      const unitPrice  = priceEntry?.amount || 0;
      const description = rateEntry?.rate || null;
      await Product.findOneAndUpdate(
        { businessId: newBiz._id, name: itemName },
        {
          $set: {
            businessId:  newBiz._id,
            branchId:    mainBranch._id,
            unitPrice,
            description,
            isActive:    true
          }
        },
        { upsert: true }
      );
    }

    // ── 9. Log a $0 subscription payment record ───────────────────────────
    await SupplierSubscriptionPayment.create({
      supplierPhone: cleanPhone,
      supplierId:    supplier._id,
      tier:          tier || "basic",
      plan:          billingCycle || "monthly",
      amount:        0,
      currency:      "USD",
      reference:     `ADMIN_REG_${supplier._id}_${Date.now()}`,
      status:        "paid",
      paidAt:        now,
      ecocashPhone:  "admin-registered"
    });

    res.redirect(
      `/zq-admin/suppliers/${supplier._id}?success=${encodeURIComponent("Supplier registered successfully! Business account and WhatsApp access created.")}`
    );
  } catch (err) {
    res.redirect(
      `/zq-admin/suppliers/new?error=${encodeURIComponent(err.message)}`
    );
  }
});

// ── Supplier Detail ────────────────────────────────────────────────────────
router.get("/suppliers/:id", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const [orders, payments] = await Promise.all([
      SupplierOrder.find({ supplierId: supplier._id }).sort({ createdAt: -1 }).limit(20).lean(),
      SupplierSubscriptionPayment.find({
        $or: [{ supplierId: supplier._id }, { supplierPhone: supplier.phone }]
      }).sort({ createdAt: -1 }).lean()
    ]);

    const totalRevenue = orders
      .filter(o => o.status === "completed")
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    res.send(layout(esc(supplier.businessName), `
      <a href="/zq-admin/suppliers" class="back-link">← Back to Suppliers</a>
      ${successMsg}

      <div class="two-col">
        <div class="panel">
          <div class="panel-head">
            <h3>Profile</h3>
            <a href="/zq-admin/suppliers/${supplier._id}/edit" class="btn-blue btn-sm">✏️ Edit</a>
          </div>
          <dl class="detail-list">
            <dt>Business Name</dt><dd><strong>${esc(supplier.businessName)}</strong></dd>
            <dt>Phone</dt><dd>${esc(supplier.phone)}</dd>
                       <dt>Location</dt><dd>${esc(supplier.location?.area || "")}, ${esc(supplier.location?.city || "")}</dd>
            <dt>Address</dt><dd>${esc(supplier.address || "-")}</dd>
            <dt>Type</dt><dd>${esc(supplier.profileType || "product")}</dd>
            <dt>Categories</dt><dd>${(supplier.categories || []).join(", ") || "-"}</dd>
            <dt>Tier</dt><dd>${badge(supplier.tier || "basic", tierColor(supplier.tier))}</dd>
            <dt>Status</dt><dd>${badge(supplier.active ? "Active" : "Inactive", supplier.active ? "green" : "gray")}</dd>
            <dt>Subscription</dt><dd>${badge(supplier.subscriptionStatus || "pending", supplier.subscriptionStatus === "active" ? "green" : "gray")}</dd>
            <dt>Expires</dt><dd>${supplier.subscriptionExpiresAt ? new Date(supplier.subscriptionExpiresAt).toDateString() : "N/A"}</dd>
            <dt>Rating</dt><dd>⭐ ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews)</dd>
            <dt>Credibility Score</dt><dd>${supplier.credibilityScore || 0}/100</dd>
            <dt>Completed Orders</dt><dd>${supplier.completedOrders || 0}</dd>
            <dt>Monthly Orders</dt><dd>${supplier.monthlyOrders || 0}</dd>
            <dt>Total Revenue</dt><dd><strong>$${totalRevenue.toFixed(2)}</strong></dd>
            <dt>Suspended</dt><dd>${supplier.suspended ? "⛔ Yes" : "✅ No"}</dd>
            <dt>Delivery</dt><dd>${supplier.delivery?.available ? "🚚 Yes" : "🏠 Collection only"}</dd>
            <dt>Min Order</dt><dd>$${supplier.minOrder || 0}</dd>
            <dt>Registered</dt><dd>${new Date(supplier.createdAt).toDateString()}</dd>
            ${supplier.adminNote ? `<dt>Admin Note</dt><dd class="admin-note">${esc(supplier.adminNote)}</dd>` : ""}
          </dl>
<div class="action-row">
  <form method="POST" action="/zq-admin/suppliers/${supplier._id}/toggle-active" style="display:inline">
    <button class="btn ${supplier.active ? "btn-orange" : "btn-green"}">
      ${supplier.active ? "⏸ Deactivate" : "✅ Activate"}
    </button>
  </form>

  <form method="POST" action="/zq-admin/suppliers/${supplier._id}/toggle-suspend" style="display:inline">
    <button class="btn ${supplier.suspended ? "btn-green" : "btn-red"}">
      ${supplier.suspended ? "🔓 Unsuspend" : "⛔ Suspend"}
    </button>
  </form>

  <a href="/zq-admin/suppliers/${supplier._id}/activate" class="btn btn-green">
    🎁 Manual Activation
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-blue">
    📦 Manage Products
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/live-items" class="btn btn-purple">
    📌 Manage Live Items
  </a>
</div>
        </div>

        <div>
          <div class="panel">
            <h3>
Products (${(supplier.products || []).length}) 
• Live (${(supplier.listedProducts || []).length})
</h3>
            <div class="tag-cloud">
              ${(supplier.products || []).length
                ? supplier.products.map(p => `<span class="tag">${esc(p)}</span>`).join("")
                : "<em class='muted'>No products listed</em>"}
            </div>
          </div>

          ${supplier.prices?.length ? `
          <div class="panel">
            <h3>Prices (${supplier.prices.length})</h3>
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Unit</th><th>Stock</th></tr></thead>
              <tbody>
                ${supplier.prices.map(p => `
                <tr>
                  <td>${esc(p.product)}</td>
                  <td>$${p.amount}</td>
                  <td>${esc(p.unit || "each")}</td>
                  <td>${p.inStock !== false ? "✅" : "❌"}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}

          ${supplier.rates?.length ? `
          <div class="panel">
            <h3>Service Rates (${supplier.rates.length})</h3>
            <table>
              <thead><tr><th>Service</th><th>Rate</th></tr></thead>
              <tbody>
                ${supplier.rates.map(r => `
                <tr><td>${esc(r.service)}</td><td>${esc(r.rate)}</td></tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}
        </div>
      </div>

      <div class="panel">
        <h3>Orders (${orders.length})</h3>
        ${orders.length ? `
        <table>
          <thead>
            <tr><th>Ref</th><th>Buyer</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${orders.map(o => `
            <tr>
              <td><code>#${String(o._id).slice(-6).toUpperCase()}</code></td>
              <td>${esc(o.buyerPhone)}</td>
              <td class="items-cell">${(o.items || []).map(i => `${esc(i.product)} x${i.quantity}`).join(", ")}</td>
              <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              <td>${badge(o.status, statusColor(o.status))}</td>
              <td>${new Date(o.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : "<em class='muted'>No orders yet</em>"}
      </div>

      <div class="panel">
        <h3>Subscription Payments</h3>
        ${payments.length ? `
        <table>
          <thead><tr><th>Plan</th><th>Amount</th><th>EcoCash</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${payments.map(p => `
            <tr>
              <td>${esc(p.tier)} / ${esc(p.plan)}</td>
              <td>$${p.amount}</td>
              <td>${esc(p.ecocashPhone || "-")}</td>
              <td>${badge(p.status, p.status === "paid" ? "green" : "gray")}</td>
              <td>${new Date(p.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : "<em class='muted'>No payments yet</em>"}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Edit Supplier ──────────────────────────────────────────────────────────
router.get("/suppliers/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const expiryVal = supplier.subscriptionExpiresAt
      ? new Date(supplier.subscriptionExpiresAt).toISOString().split("T")[0]
      : "";

    res.send(layout(`Edit: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      <div class="panel">
        <h3>Edit Supplier</h3>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/edit" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Business Name</label>
              <input name="businessName" value="${esc(supplier.businessName)}" required />
            </div>
            <div class="fg">
              <label>Phone</label>
              <input name="phone" value="${esc(supplier.phone)}" required />
            </div>
            <div class="fg">
              <label>City</label>
              <input name="city" value="${esc(supplier.location?.city || "")}" />
            </div>
                     <div class="fg">
              <label>Area / Suburb</label>
              <input name="area" value="${esc(supplier.location?.area || "")}" />
            </div>
            <div class="fg">
              <label>Address</label>
              <input name="address" value="${esc(supplier.address || "")}" />
            </div>
            <div class="fg">
              <label>Tier</label>
              <select name="tier">
                <option ${supplier.tier === "basic" ? "selected" : ""} value="basic">Basic</option>
                <option ${supplier.tier === "pro" ? "selected" : ""} value="pro">Pro</option>
                <option ${supplier.tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
            </div>
            <div class="fg">
              <label>Subscription Status</label>
              <select name="subscriptionStatus">
                <option ${supplier.subscriptionStatus === "pending" ? "selected" : ""} value="pending">Pending</option>
                <option ${supplier.subscriptionStatus === "active" ? "selected" : ""} value="active">Active</option>
                <option ${supplier.subscriptionStatus === "expired" ? "selected" : ""} value="expired">Expired</option>
              </select>
            </div>
            <div class="fg">
              <label>Subscription Expires</label>
              <input type="date" name="subscriptionExpiresAt" value="${expiryVal}" />
            </div>
            <div class="fg">
              <label>Active</label>
              <select name="active">
                <option ${supplier.active ? "selected" : ""} value="true">Yes</option>
                <option ${!supplier.active ? "selected" : ""} value="false">No</option>
              </select>
            </div>
            <div class="fg">
              <label>Min Order ($)</label>
              <input type="number" name="minOrder" value="${supplier.minOrder || 0}" min="0" />
            </div>
            <div class="fg">
              <label>Profile Type</label>
              <select name="profileType">
                <option ${supplier.profileType === "product" ? "selected" : ""} value="product">Product Supplier</option>
                <option ${supplier.profileType === "service" ? "selected" : ""} value="service">Service Provider</option>
              </select>
            </div>
            <div class="fg">
              <label>Credibility Score (0-100)</label>
              <input type="number" name="credibilityScore" value="${supplier.credibilityScore || 0}" min="0" max="100" />
            </div>
            <div class="fg">
              <label>Rating (0-5)</label>
              <input type="number" name="rating" value="${(supplier.rating || 0).toFixed(1)}" min="0" max="5" step="0.1" />
            </div>
          </div>

          <div class="fg full">
            <label>Products (comma-separated)</label>
            <textarea name="products" rows="3">${(supplier.products || []).join(", ")}</textarea>
          </div>
          <div class="fg full">
            <label>Categories (comma-separated)</label>
            <textarea name="categories" rows="2">${(supplier.categories || []).join(", ")}</textarea>
          </div>
          <div class="fg full">
            <label>Admin Note (internal only)</label>
            <textarea name="adminNote" rows="2" placeholder="Notes about this supplier...">${esc(supplier.adminNote || "")}</textarea>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-blue">💾 Save Changes</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
   const {
      businessName, phone, city, area, address, tier, subscriptionStatus,
      subscriptionExpiresAt, active, minOrder, profileType,
      products, categories, adminNote, credibilityScore, rating
    } = req.body;

    const update = {
       businessName: businessName?.trim(),
      phone: phone?.trim(),
      "location.city": city?.trim(),
      "location.area": area?.trim(),
      address: address?.trim() || "",
      tier,
      tierRank: tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
      subscriptionStatus,
      active: active === "true",
      minOrder: Number(minOrder) || 0,
      profileType,
      adminNote: adminNote?.trim() || "",
      credibilityScore: Number(credibilityScore) || 0,
      rating: Number(rating) || 0,
      products: products
        ? products.split(",").map(p => p.trim().toLowerCase()).filter(Boolean)
        : [],
      categories: categories
        ? categories.split(",").map(c => c.trim().toLowerCase()).filter(Boolean)
        : []
    };

    if (subscriptionExpiresAt) {
      update.subscriptionExpiresAt = new Date(subscriptionExpiresAt);
    }

    await SupplierProfile.findByIdAndUpdate(req.params.id, update, { new: true });
    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/edit?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Toggle actions ─────────────────────────────────────────────────────────
router.post("/suppliers/:id/toggle-active", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect(`/zq-admin/suppliers/${req.params.id}`);

    supplier.active = !supplier.active;
    await supplier.save();

    // When toggling ON: ensure Business + UserRole + Branch + UserSession exist
    if (supplier.active) {
      const Business    = (await import("../models/business.js")).default;
      const UserRole    = (await import("../models/userRole.js")).default;
      const Branch      = (await import("../models/branch.js")).default;
      const UserSession = (await import("../models/userSession.js")).default;
      const cleanPhone  = supplier.phone;

      const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
      const bizPackage = TIER_TO_PACKAGE[supplier.tier] || "bronze";

      // Find or create Business
      let bizRecord = supplier.businessId
        ? await Business.findById(supplier.businessId)
        : null;

      if (!bizRecord) {
        const existingRole = await UserRole.findOne({ phone: cleanPhone, role: "owner" });
        if (existingRole?.businessId) bizRecord = await Business.findById(existingRole.businessId);
      }

      if (!bizRecord) {
        bizRecord = await Business.create({
          name:               supplier.businessName,
          currency:           "USD",
          package:            bizPackage,
          subscriptionStatus: "active",
          isSupplier:         true,
          supplierProfileId:  supplier._id,
          ownerPhone:         cleanPhone,
          sessionState:       "ready",
          sessionData:        {}
        });
        await UserRole.create({
          phone: cleanPhone, role: "owner", pending: false, businessId: bizRecord._id
        });
      } else {
        if (bizRecord.name?.startsWith("pending_")) bizRecord.name = supplier.businessName;
        bizRecord.isSupplier        = true;
        bizRecord.supplierProfileId = supplier._id;
        bizRecord.package           = bizPackage;
        bizRecord.subscriptionStatus = "active";
        await bizRecord.save();
      }

      // Ensure Branch
      let mainBranchId;
      const existingBranch = await Branch.findOne({ businessId: bizRecord._id, isDefault: true });
      if (!existingBranch) {
        const b = await Branch.create({ businessId: bizRecord._id, name: "Main Branch", isDefault: true });
        await UserRole.findOneAndUpdate(
          { businessId: bizRecord._id, role: "owner" }, { branchId: b._id }
        );
        mainBranchId = b._id;
      } else {
        mainBranchId = existingBranch._id;
      }

      // Update SupplierProfile with businessId + mainBranchId
      await SupplierProfile.findByIdAndUpdate(req.params.id, {
        businessId: bizRecord._id, mainBranchId
      });

      // Set activeBusinessId in UserSession
      await UserSession.findOneAndUpdate(
        { phone: cleanPhone },
        { phone: cleanPhone, activeBusinessId: bizRecord._id },
        { upsert: true }
      );
    }

    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  }
});

router.post("/suppliers/:id/toggle-suspend", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id);
  if (supplier) {
    supplier.suspended = !supplier.suspended;
    if (supplier.suspended) supplier.active = false;
    await supplier.save();
  }
  res.redirect(`/zq-admin/suppliers/${req.params.id}`);
});


// ── Manual Activation ──────────────────────────────────────────────────────
router.get("/suppliers/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const { SUPPLIER_PLANS } = await import("../services/supplierPlans.js");

    res.send(layout(`Activate: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      <div class="panel">
        <h3>🎁 Manual Activation</h3>
        <p style="color:var(--muted);margin-bottom:20px;font-size:13px">
          Activate this supplier without requiring EcoCash payment. 
          Use for testing, free trials, or manual arrangements.
        </p>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/activate" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Tier / Plan</label>
              <select name="tier" required>
                <option value="">Select a plan...</option>
                <option value="basic">✅ Basic - $5/month</option>
                <option value="pro">⭐ Pro - $12/month</option>
                <option value="featured">🔥 Featured - $25/month</option>
              </select>
            </div>
            <div class="fg">
              <label>Billing Cycle</label>
              <select name="plan">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div class="fg">
              <label>Duration (days)</label>
              <input type="number" name="durationDays" value="30" min="1" max="365" />
            </div>
            <div class="fg">
              <label>Reason / Note</label>
              <input name="reason" placeholder="e.g. Free trial, paid cash..." />
            </div>
          </div>
          <div class="fg full" style="margin-bottom:16px">
            <label>Also set active?</label>
            <select name="setActive">
              <option value="true">Yes - make listing visible to buyers</option>
              <option value="false">No - activate subscription only</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-green">✅ Activate Now</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const { tier, plan, durationDays, reason, setActive } = req.body;
    const { SUPPLIER_PLANS } = await import("../services/supplierPlans.js");

    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const planDetails = SUPPLIER_PLANS[tier]?.[plan];
    const days = Number(durationDays) || planDetails?.durationDays || 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // Tier → Business package mapping (mirrors supplierRegistration.js)
    const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
    const bizPackage = TIER_TO_PACKAGE[tier] || "bronze";
    const isActive   = setActive === "true";

    // ── Import models ─────────────────────────────────────────────────────
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    const cleanPhone = supplier.phone;

    // ── 1. Find or create the Business record ─────────────────────────────
    let bizRecord = supplier.businessId
      ? await Business.findById(supplier.businessId)
      : null;

    if (!bizRecord) {
      // Check if a Business already exists for this phone (e.g. from WhatsApp)
      const existingRole = await UserRole.findOne({ phone: cleanPhone, role: "owner" });
      if (existingRole?.businessId) {
        bizRecord = await Business.findById(existingRole.businessId);
      }
    }

    if (!bizRecord) {
      // No Business at all — create one now
      bizRecord = await Business.create({
        name:               supplier.businessName,
        currency:           "USD",
        package:            isActive ? bizPackage : "trial",
        subscriptionStatus: isActive ? "active" : "inactive",
        subscriptionStartedAt: isActive ? now : undefined,
        subscriptionEndsAt:    isActive ? expiresAt : undefined,
        isSupplier:         true,
        supplierProfileId:  supplier._id,
        ownerPhone:         cleanPhone,
        sessionState:       "ready",
        sessionData:        {}
      });

      // Create UserRole for owner
      await UserRole.create({
        phone:      cleanPhone,
        role:       "owner",
        pending:    false,
        businessId: bizRecord._id
      });
    } else {
      // Update existing Business to reflect new plan
      bizRecord.name               = bizRecord.name?.startsWith("pending_") ? supplier.businessName : bizRecord.name;
      bizRecord.package            = isActive ? bizPackage : bizRecord.package;
      bizRecord.subscriptionStatus = isActive ? "active" : bizRecord.subscriptionStatus;
      bizRecord.isSupplier         = true;
      bizRecord.supplierProfileId  = supplier._id;
      if (isActive) {
        bizRecord.subscriptionStartedAt = now;
        bizRecord.subscriptionEndsAt    = expiresAt;
      }
      await bizRecord.save();
    }

    // ── 2. Ensure main Branch exists ──────────────────────────────────────
    let mainBranchId;
    const existingBranch = await Branch.findOne({ businessId: bizRecord._id, isDefault: true });
    if (!existingBranch) {
      const mainBranch = await Branch.create({
        businessId: bizRecord._id,
        name:       "Main Branch",
        isDefault:  true
      });
      await UserRole.findOneAndUpdate(
        { businessId: bizRecord._id, role: "owner" },
        { branchId: mainBranch._id }
      );
      mainBranchId = mainBranch._id;
    } else {
      mainBranchId = existingBranch._id;
    }

    // ── 3. Set activeBusinessId in UserSession so WhatsApp login works ────
    await UserSession.findOneAndUpdate(
      { phone: cleanPhone },
      { phone: cleanPhone, activeBusinessId: bizRecord._id },
      { upsert: true }
    );

    // ── 4. Update SupplierProfile with businessId + mainBranchId ─────────
    const supplierUpdate = {
      tier,
      tierRank:              tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
      subscriptionStatus:    "active",
      subscriptionStartedAt: now,
      subscriptionEndsAt:    expiresAt,
      subscriptionPlan:      plan,
      active:                isActive,
      businessId:            bizRecord._id,
      mainBranchId:          mainBranchId,
      adminNote: reason
        ? `[Admin activated ${tier}/${plan} on ${now.toDateString()}] ${reason}`
        : `[Admin activated ${tier}/${plan} on ${now.toDateString()}]`
    };
    await SupplierProfile.findByIdAndUpdate(req.params.id, supplierUpdate);

    // ── 5. Sync products into the Product model ───────────────────────────
    const capMap  = { basic: 20, pro: 60, featured: 150 };
    const cap     = capMap[tier] || 20;
    const toSync  = (supplier.listedProducts || supplier.products || []).slice(0, cap);
    for (const itemName of toSync) {
      const priceEntry  = (supplier.prices || []).find(p => p.product?.toLowerCase() === itemName.toLowerCase());
      const rateEntry   = (supplier.rates  || []).find(r => r.service?.toLowerCase() === itemName.toLowerCase());
      const unitPrice   = priceEntry?.amount || 0;
      const description = rateEntry?.rate || null;
      await Product.findOneAndUpdate(
        { businessId: bizRecord._id, name: itemName },
        {
          $set: {
            businessId:  bizRecord._id,
            branchId:    mainBranchId,
            unitPrice,
            description,
            isActive:    true
          }
        },
        { upsert: true }
      );
    }

    // ── 6. Log a payment record ───────────────────────────────────────────
    await SupplierSubscriptionPayment.create({
      supplierPhone: cleanPhone,
      supplierId:    req.params.id,
      tier,
      plan,
      amount:        0,
      currency:      "USD",
      reference:     `MANUAL_${req.params.id}_${Date.now()}`,
      status:        "paid",
      paidAt:        now,
      ecocashPhone:  "manual-admin"
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}?success=${encodeURIComponent("Supplier activated! Business account and WhatsApp access are ready.")}`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Manage Products ────────────────────────────────────────────────────────
router.get("/suppliers/:id/products", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const { SUPPLIER_PRODUCT_TEMPLATES } = await import("../services/supplierProductTemplates.js").catch(() => ({ SUPPLIER_PRODUCT_TEMPLATES: {} }));
    const templateKeys = Object.keys(SUPPLIER_PRODUCT_TEMPLATES || {});

    res.send(layout(`Products: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>

      <div class="two-col">

        <!-- Current products & prices -->
        <div>
          <div class="panel">
            <div class="panel-head">
              <h3>Current Products (${(supplier.products || []).length})</h3>
            </div>
            ${supplier.products?.length ? `
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/update-list">
              <div class="fg full" style="margin-bottom:12px">
                <label>Edit product list (comma-separated)</label>
                <textarea name="products" rows="5" style="font-size:13px">${(supplier.products || []).join(", ")}</textarea>
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save Product List</button>
            </form>` : `
            <p class="muted" style="margin-bottom:12px">No products yet.</p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/update-list">
              <div class="fg full" style="margin-bottom:12px">
                <label>Add products (comma-separated)</label>
                <textarea name="products" rows="4" placeholder="cooking oil, rice, sugar, flour"></textarea>
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save</button>
            </form>`}
          </div>

          <div class="panel">
            <div class="panel-head">
              <h3>Prices (${(supplier.prices || []).length})</h3>
              <a href="/zq-admin/suppliers/${supplier._id}/products/add-price" class="btn-link">+ Add Price</a>
            </div>
            ${supplier.prices?.length ? `
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Unit</th><th>Stock</th><th></th></tr></thead>
              <tbody>
                ${supplier.prices.map((p, i) => `
                <tr>
                  <td>${esc(p.product)}</td>
                  <td>$${p.amount}</td>
                  <td>${esc(p.unit || "each")}</td>
                  <td>${p.inStock !== false ? "✅" : "❌"}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/products/edit-price/${i}" class="btn-link" style="font-size:12px">Edit</a>
                    &nbsp;
                    <a href="/zq-admin/suppliers/${supplier._id}/products/delete-price/${i}" 
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this price?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted">No prices set yet.</p>`}
          </div>

          ${supplier.rates?.length || supplier.profileType === "service" ? `
          <div class="panel">
            <div class="panel-head">
              <h3>Service Rates (${(supplier.rates || []).length})</h3>
              <a href="/zq-admin/suppliers/${supplier._id}/products/add-rate" class="btn-link">+ Add Rate</a>
            </div>
            ${supplier.rates?.length ? `
            <table>
              <thead><tr><th>Service</th><th>Rate</th><th></th></tr></thead>
              <tbody>
                ${supplier.rates.map((r, i) => `
                <tr>
                  <td>${esc(r.service)}</td>
                  <td>${esc(r.rate)}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/products/delete-rate/${i}"
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this rate?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted">No rates set yet.</p>`}
          </div>` : ""}
        </div>

        <!-- Bulk add -->
        <div>
          <div class="panel">
            <h3>📋 Bulk Add Products</h3>
            <p style="color:var(--muted);font-size:12px;margin-bottom:14px">
              Paste products one per line or comma-separated. Format:<br>
              <code>product name, price, unit</code> or just <code>product name</code>
            </p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/bulk-add">
              <div class="fg full" style="margin-bottom:12px">
                <label>Products (one per line)</label>
                <textarea name="bulk" rows="10" placeholder="cooking oil, 4.50, litre&#10;rice, 8, bag&#10;sugar, 1.20, kg&#10;bread&#10;flour, 3, 5kg bag"></textarea>
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Add mode</label>
                <select name="mode">
                  <option value="append">Append to existing</option>
                  <option value="replace">Replace all products</option>
                </select>
              </div>
              <button type="submit" class="btn btn-blue">📥 Import Products</button>
            </form>
          </div>

          ${templateKeys.length ? `
          <div class="panel">
            <h3>📦 Load from Template</h3>
            <p style="color:var(--muted);font-size:12px;margin-bottom:14px">
              Load a preset product list for this supplier's category.
            </p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/load-template">
              <div class="fg" style="margin-bottom:12px">
                <label>Template</label>
                <select name="templateKey">
                  ${templateKeys.map(k => {
                    const t = SUPPLIER_PRODUCT_TEMPLATES[k];
                    return `<option value="${esc(k)}">${esc(t.label)} (${t.products.length} items)</option>`;
                  }).join("")}
                </select>
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Mode</label>
                <select name="mode">
                  <option value="append">Append to existing</option>
                  <option value="replace">Replace all</option>
                </select>
              </div>
              <button type="submit" class="btn btn-blue">📦 Load Template</button>
            </form>
          </div>` : ""}
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Update product list (text area) ───────────────────────────────────────
router.post("/suppliers/:id/products/update-list", requireSupplierAdmin, async (req, res) => {
  const { products } = req.body;
  const list = (products || "").split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
  await SupplierProfile.findByIdAndUpdate(req.params.id, { products: list });
  res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
});

// ── Bulk add products ──────────────────────────────────────────────────────
router.post("/suppliers/:id/products/bulk-add", requireSupplierAdmin, async (req, res) => {
  try {
    const { bulk, mode } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const lines = (bulk || "").split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
    const newProducts = [];
    const newPrices = [];

    for (const line of lines) {
      // Try to parse "product, price, unit" format
      const parts = line.split(",").map(p => p.trim());
      const name = parts[0]?.toLowerCase();
      if (!name) continue;

      newProducts.push(name);

      const price = parseFloat(parts[1]);
      const unit = parts[2] || "each";
      if (!isNaN(price) && price > 0) {
        newPrices.push({ product: name, amount: price, unit, inStock: true });
      }
    }

    if (mode === "replace") {
      supplier.products = newProducts;
      supplier.prices = newPrices.length ? newPrices : supplier.prices;
    } else {
      // Append - avoid duplicates
      const existingNames = new Set(supplier.products || []);
      for (const p of newProducts) {
        if (!existingNames.has(p)) supplier.products.push(p);
      }
      const existingPriceNames = new Set((supplier.prices || []).map(p => p.product));
      for (const p of newPrices) {
        if (!existingPriceNames.has(p.product)) supplier.prices.push(p);
      }
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Load template ──────────────────────────────────────────────────────────
router.post("/suppliers/:id/products/load-template", requireSupplierAdmin, async (req, res) => {
  try {
    const { templateKey, mode } = req.body;
    const { SUPPLIER_PRODUCT_TEMPLATES } = await import("../services/supplierProductTemplates.js");
    const template = SUPPLIER_PRODUCT_TEMPLATES[templateKey];
    if (!template) return res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);

    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (mode === "replace") {
      supplier.products = [...template.products];
    } else {
      const existing = new Set(supplier.products || []);
      for (const p of template.products) {
        if (!existing.has(p)) supplier.products.push(p);
      }
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Add price ──────────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/add-price", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  res.send(layout("Add Price", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Add Price</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/add-price" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Product Name</label>
          <input name="product" list="product-suggestions" placeholder="e.g. cooking oil" required />
          <datalist id="product-suggestions">
            ${(supplier.products || []).map(p => `<option value="${esc(p)}">`).join("")}
          </datalist>
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Price ($)</label>
          <input type="number" name="amount" step="0.01" min="0" placeholder="4.50" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Unit</label>
          <input name="unit" placeholder="each, kg, litre, bag..." value="each" />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>In Stock</label>
          <select name="inStock">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Add Price</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/add-price", requireSupplierAdmin, async (req, res) => {
  try {
    const { product, amount, unit, inStock } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const newPrice = {
      product: product.trim().toLowerCase(),
      amount: parseFloat(amount),
      unit: unit?.trim() || "each",
      inStock: inStock === "true",
      currency: "USD"
    };

    // Update existing or push new
    const idx = supplier.prices.findIndex(p => p.product === newPrice.product);
    if (idx >= 0) supplier.prices[idx] = newPrice;
    else supplier.prices.push(newPrice);

    // Also add to products list if not there
    if (!supplier.products.includes(newPrice.product)) {
      supplier.products.push(newPrice.product);
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Edit price ─────────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/edit-price/:idx", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const idx = parseInt(req.params.idx);
  const price = supplier.prices?.[idx];
  if (!price) return res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);

  res.send(layout("Edit Price", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Edit Price - ${esc(price.product)}</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/edit-price/${idx}" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Product Name</label>
          <input name="product" value="${esc(price.product)}" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Price ($)</label>
          <input type="number" name="amount" step="0.01" min="0" value="${price.amount}" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Unit</label>
          <input name="unit" value="${esc(price.unit || "each")}" />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>In Stock</label>
          <select name="inStock">
            <option ${price.inStock !== false ? "selected" : ""} value="true">Yes</option>
            <option ${price.inStock === false ? "selected" : ""} value="false">No</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Save</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/edit-price/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const idx = parseInt(req.params.idx);
    const { product, amount, unit, inStock } = req.body;

    if (idx >= 0 && idx < supplier.prices.length) {
      supplier.prices[idx].product = product.trim().toLowerCase();
      supplier.prices[idx].amount = parseFloat(amount);
      supplier.prices[idx].unit = unit?.trim() || "each";
      supplier.prices[idx].inStock = inStock === "true";
      supplier.prices[idx].currency = "USD";
      supplier.markModified("prices");  // ← THIS IS THE KEY FIX
      await supplier.save();
    }

    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Delete price ───────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/delete-price/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (supplier) {
      supplier.prices.splice(parseInt(req.params.idx), 1);
      supplier.markModified("prices");  // ← ADD THIS
      await supplier.save();
    }
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  }
});



// ── Add service rate ───────────────────────────────────────────────────────
router.get("/suppliers/:id/products/add-rate", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  res.send(layout("Add Rate", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Add Service Rate</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/add-rate" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Service Name</label>
          <input name="service" placeholder="e.g. plumbing, car hire" required />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>Rate</label>
          <input name="rate" placeholder="e.g. 20/job, 10/hr, 50/trip" required />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Add Rate</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/add-rate", requireSupplierAdmin, async (req, res) => {
  try {
    const { service, rate } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (!supplier.rates) supplier.rates = [];
    supplier.rates.push({
      service: service.trim().toLowerCase(),
      rate: rate.trim().toLowerCase()
    });

    // Also add to products list
    const svcName = service.trim().toLowerCase();
    if (!supplier.products.includes(svcName)) supplier.products.push(svcName);

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Delete service rate ────────────────────────────────────────────────────
router.get("/suppliers/:id/products/delete-rate/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (supplier?.rates) {
      supplier.rates.splice(parseInt(req.params.idx), 1);
      supplier.markModified("rates");  // ← ADD THIS
      await supplier.save();
    }
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  }
});
// ── Orders ─────────────────────────────────────────────────────────────────
router.get("/orders", requireSupplierAdmin, async (req, res) => {
  try {
    const { status = "", page = 1 } = req.query;
    const limit = 25;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (status) query.status = status;

    const [orders, total] = await Promise.all([
      SupplierOrder.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate("supplierId", "businessName phone").lean(),
      SupplierOrder.countDocuments(query)
    ]);

    const pages = Math.ceil(total / limit);

    res.send(layout("Orders", `
      <div class="panel">
        <div class="panel-head">
          <h3>Orders <span class="count">${total}</span></h3>
          <form method="GET" class="filter-form">
            <select name="status" onchange="this.form.submit()">
              <option value="">All Status</option>
              ${["pending","accepted","declined","completed","cancelled","disputed"].map(s =>
                `<option ${status === s ? "selected" : ""} value="${s}">${s}</option>`
              ).join("")}
            </select>
            ${status ? `<a href="/zq-admin/orders" class="btn-reset">Clear</a>` : ""}
          </form>
        </div>
        <table>
          <thead>
            <tr><th>Ref</th><th>Supplier</th><th>Buyer</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${orders.map(o => `
            <tr>
              <td><code>#${String(o._id).slice(-6).toUpperCase()}</code></td>
              <td>${esc(o.supplierId?.businessName || o.supplierPhone)}</td>
              <td>${esc(o.buyerPhone)}</td>
              <td class="items-cell">
                ${(o.items || []).slice(0, 2).map(i => `${esc(i.product)} x${i.quantity}`).join(", ")}
                ${o.items?.length > 2 ? `<em>+${o.items.length - 2} more</em>` : ""}
              </td>
              <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              <td>${badge(o.status, statusColor(o.status))}</td>
              <td>${new Date(o.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/orders?page=${p}&status=${status}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Orders", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Payments ───────────────────────────────────────────────────────────────
router.get("/payments", requireSupplierAdmin, async (req, res) => {
  try {
    const { status = "", page = 1 } = req.query;
    const limit = 30;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (status) query.status = status;

    const [payments, total, agg] = await Promise.all([
      SupplierSubscriptionPayment.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierSubscriptionPayment.countDocuments(query),
      SupplierSubscriptionPayment.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const totalPaid = agg[0]?.total || 0;
    const pages = Math.ceil(total / limit);

    res.send(layout("Payments", `
      <div class="panel">
        <div class="panel-head">
          <h3>Subscription Payments <span class="count">${total}</span></h3>
          <div style="display:flex;align-items:center;gap:12px">
            <strong style="color:#16a34a">Total Paid: $${totalPaid.toFixed(2)}</strong>
            <form method="GET" class="filter-form" style="margin:0">
              <select name="status" onchange="this.form.submit()">
                <option value="">All</option>
                <option ${status === "paid" ? "selected" : ""} value="paid">Paid</option>
                <option ${status === "pending" ? "selected" : ""} value="pending">Pending</option>
                <option ${status === "failed" ? "selected" : ""} value="failed">Failed</option>
              </select>
            </form>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Phone</th><th>Tier</th><th>Plan</th><th>Amount</th><th>EcoCash</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${payments.map(p => `
            <tr>
              <td>${esc(p.supplierPhone)}</td>
              <td>${esc(p.tier)}</td>
              <td>${esc(p.plan)}</td>
              <td>$${p.amount}</td>
              <td>${esc(p.ecocashPhone || "-")}</td>
              <td>${badge(p.status, p.status === "paid" ? "green" : p.status === "pending" ? "yellow" : "red")}</td>
              <td>${new Date(p.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/payments?page=${p}&status=${status}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Payments", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(text, color) {
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}

function stat(value, label, color) {
  return `<div class="stat-card ${color ? "stat-" + color : ""}">
    <div class="stat-val">${value}</div>
    <div class="stat-lbl">${label}</div>
  </div>`;
}

function statusColor(s) {
  const map = { pending: "yellow", accepted: "green", declined: "red",
                completed: "blue", cancelled: "gray", disputed: "orange" };
  return map[s] || "gray";
}

function tierColor(t) {
  const map = { basic: "gray", pro: "blue", featured: "orange" };
  return map[t] || "gray";
}

function layout(title, content) {
const nav = [
    { href: "/zq-admin",                label: "📊 Dashboard",        match: title === "Dashboard" },
    { href: "/zq-admin/suppliers",      label: "🏪 Suppliers",         match: title === "Suppliers" || title.includes("Edit") },
    { href: "/zq-admin/suppliers/new",  label: "➕ Register Supplier", match: title === "Register Supplier" },
    { href: "/zq-admin/orders",         label: "📦 Orders",            match: title === "Orders" },
    { href: "/zq-admin/payments",       label: "💳 Payments",          match: title === "Payments" },
    { href: "/zq-admin/contacts",       label: "👥 Contacts",          match: title === "Contacts" },
    { href: "/zq-admin/presets",        label: "🗂 Presets",           match: title === "Presets" },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ZimQuote Admin</title>
<style>
:root{
  --bg:#f1f5f9;--sidebar:#0f172a;--sidebar-hover:#1e293b;
  --white:#fff;--border:#e2e8f0;--text:#1e293b;--muted:#64748b;
  --blue:#2563eb;--green:#16a34a;--red:#dc2626;--orange:#ea580c;
  --yellow:#a16207;--purple:#7c3aed;--teal:#0d9488;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
/* Sidebar */
.sidebar{position:fixed;left:0;top:0;bottom:0;width:210px;background:var(--sidebar);
         display:flex;flex-direction:column;z-index:100}
.sidebar-brand{padding:20px;font-size:18px;font-weight:700;color:white;
               border-bottom:1px solid #1e293b;letter-spacing:-.3px}
.sidebar-brand span{color:#60a5fa}
.sidebar-nav{flex:1;padding:8px 0}
.sidebar-nav a{display:flex;align-items:center;gap:8px;padding:11px 20px;
               color:#94a3b8;text-decoration:none;font-size:13px;transition:all .15s}
.sidebar-nav a:hover,.sidebar-nav a.active{background:var(--sidebar-hover);color:white}
.sidebar-footer{padding:16px 20px;border-top:1px solid #1e293b}
.sidebar-footer form button{background:none;border:none;color:#94a3b8;
  cursor:pointer;font-size:13px;padding:0}
.sidebar-footer form button:hover{color:white}
/* Main */
.main{margin-left:210px;padding:24px;min-height:100vh}
.page-title{font-size:22px;font-weight:700;margin-bottom:20px;color:var(--text)}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--white);padding:18px;border-radius:10px;
           box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:3px solid #e2e8f0}
.stat-green{border-left-color:#22c55e}.stat-orange{border-left-color:#f97316}
.stat-blue{border-left-color:#3b82f6}.stat-yellow{border-left-color:#eab308}
.stat-purple{border-left-color:#a855f7}.stat-teal{border-left-color:#14b8a6}
.stat-val{font-size:26px;font-weight:700;line-height:1}
.stat-lbl{font-size:12px;color:var(--muted);margin-top:5px}
/* Panels */
.panel{background:var(--white);border-radius:10px;padding:20px;
       box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.panel h3{font-size:15px;font-weight:700;margin-bottom:14px}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.panel-head h3{margin:0}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
/* Tables */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 12px;background:#f8fafc;border-bottom:2px solid var(--border);
   color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafbfc}
.items-cell{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Badges */
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;
       font-size:11px;font-weight:700;text-transform:capitalize}
.badge-green{background:#dcfce7;color:#16a34a}
.badge-red{background:#fee2e2;color:#dc2626}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-blue{background:#dbeafe;color:#1d4ed8}
.badge-yellow{background:#fef9c3;color:#a16207}
.badge-orange{background:#ffedd5;color:#c2410c}
.badge-teal{background:#ccfbf1;color:#0f766e}
.count{background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:20px;font-size:12px;margin-left:6px}
/* Buttons */
.btn{display:inline-block;padding:9px 18px;border:none;border-radius:7px;font-size:13px;
     font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn-blue{background:var(--blue);color:white}
.btn-green{background:#22c55e;color:white}
.btn-red{background:#ef4444;color:white}
.btn-orange{background:#f97316;color:white}
.btn-gray{background:#e2e8f0;color:#475569}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-link{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}
.btn-link:hover{text-decoration:underline}
.btn-reset{color:var(--muted);text-decoration:none;font-size:13px}
/* Forms */
.filter-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filter-form input,.filter-form select{
  padding:7px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none}
.filter-form input:focus,.filter-form select:focus{border-color:var(--blue)}
.filter-form button{padding:7px 14px;background:var(--blue);color:white;
  border:none;border-radius:6px;cursor:pointer;font-size:13px}
.edit-form .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.fg{display:flex;flex-direction:column;gap:5px}
.fg.full{margin-bottom:12px}
.fg label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.fg input,.fg select,.fg textarea{
  padding:9px 11px;border:1px solid var(--border);border-radius:7px;font-size:13px;outline:none}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--blue)}
.fg textarea{resize:vertical}
.form-actions{display:flex;gap:10px;margin-top:16px}
/* Detail list */
.detail-list{display:grid;grid-template-columns:140px 1fr;gap:1px}
.detail-list dt{font-size:12px;font-weight:600;color:var(--muted);
  padding:8px 0;border-bottom:1px solid #f8fafc;text-transform:uppercase;letter-spacing:.3px}
.detail-list dd{padding:8px 0;border-bottom:1px solid #f8fafc;font-size:13px}
.admin-note{background:#fefce8;padding:6px 10px;border-radius:6px;font-style:italic;color:#854d0e}
/* Tags */
.tag-cloud{display:flex;flex-wrap:wrap;gap:6px}
.tag{background:#e0f2fe;color:#0369a1;padding:4px 10px;border-radius:20px;font-size:12px}
.type-pill{background:#f3e8ff;color:#7c3aed;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
/* Misc */
.action-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.back-link{display:inline-block;margin-bottom:16px;color:var(--blue);text-decoration:none;font-size:13px}
.back-link:hover{text-decoration:underline}
.alert.red{background:#fee2e2;color:#dc2626;padding:14px;border-radius:8px}
.muted{color:var(--muted)}
.pagination{display:flex;gap:4px;margin-top:14px;flex-wrap:wrap}
.pagination a{padding:5px 11px;border:1px solid var(--border);border-radius:6px;
  text-decoration:none;color:var(--muted);font-size:13px}
.pagination a.active{background:var(--blue);color:white;border-color:var(--blue)}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace}
@media(max-width:768px){
  .sidebar{display:none}
  .main{margin-left:0}
  .two-col,.edit-form .form-grid{grid-template-columns:1fr}
  .stats-grid{grid-template-columns:repeat(2,1fr)}
}
</style>
</head>
<body>
<nav class="sidebar">
  <div class="sidebar-brand">⚡ <span>Zim</span>Quote</div>
  <div class="sidebar-nav">
    ${nav.map(n => `<a href="${n.href}" ${n.match ? 'class="active"' : ""}>${n.label}</a>`).join("")}
  </div>
  <div class="sidebar-footer">
    <form method="POST" action="/zq-admin/logout">
      <button>🚪 Logout</button>
    </form>
  </div>
</nav>
<main class="main">
  <div class="page-title">${esc(title)}</div>
  ${content}
</main>
</body>
</html>`;
}





// ─── PRESET MANAGEMENT ROUTES ─────────────────────────────────────────────────

// ── GET /zq-admin/presets ────────────────────────────────────────────────────
router.get("/presets", requireSupplierAdmin, async (req, res) => {
  try {
    const dbPresets = await CategoryPreset.find().lean();
    const dbMap = Object.fromEntries(dbPresets.map(p => [p.catId, p]));
    const staticPresets = getPresetCategories();
    const staticMap = Object.fromEntries(staticPresets.map(p => [p.id, p]));

    const allCats = SUPPLIER_CATEGORIES.map(cat => {
      const db = dbMap[cat.id];
      const stat = staticMap[cat.id];
      return {
        id: cat.id,
        label: cat.label,
        types: cat.types,
        hasSubcats: !!(cat.subcats?.length),
        hasPreset: !!(db?.isActive) || !!(stat),
        source: db ? "database" : stat ? "static" : "none",
        productCount: db ? db.products.length : (stat?.productCount || 0),
        priceCount: db ? db.prices.length : (stat?.priceCount || 0),
        isActive: db ? db.isActive : !!(stat),
        adminNote: db?.adminNote || "",
        updatedAt: db?.updatedAt || null,
        updatedBy: db?.updatedBy || ""
      };
    });

    const productCats = allCats.filter(c => c.types?.includes("product"));
    const serviceCats = allCats.filter(c => c.types?.includes("service"));

    const productRows = productCats.map(cat => `
      <tr>
        <td><strong>${esc(cat.label)}</strong><br><small style="color:#888">${esc(cat.id)}</small></td>
        <td>${cat.hasSubcats ? "✅" : "-"}</td>
        <td>${cat.productCount > 0 ? cat.productCount + " items" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${cat.priceCount > 0 ? cat.priceCount + " prices" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${badge(cat.source === "database" ? "DB" : cat.source === "static" ? "Static" : "None",
               cat.source === "database" ? "blue" : cat.source === "static" ? "yellow" : "gray")}</td>
        <td>${cat.hasPreset
          ? badge(cat.isActive ? "✅ Active" : "⏸ Off", cat.isActive ? "green" : "gray")
          : "<em style='color:#aaa'>No preset</em>"}</td>
        <td><small>${cat.updatedAt ? new Date(cat.updatedAt).toLocaleDateString() : "-"}</small></td>
        <td>
          <a href="/zq-admin/presets/${esc(cat.id)}" class="btn-link">Edit →</a>
          ${cat.hasPreset ? `&nbsp;<button onclick="togglePreset('${esc(cat.id)}')" class="btn-sm btn-${cat.isActive ? "orange" : "green"}">${cat.isActive ? "Disable" : "Enable"}</button>` : ""}
        </td>
      </tr>`).join("");

    const serviceRows = serviceCats.map(cat => `
      <tr>
        <td><strong>${esc(cat.label)}</strong><br><small style="color:#888">${esc(cat.id)}</small></td>
        <td>${cat.hasSubcats ? "✅" : "-"}</td>
        <td>${cat.productCount > 0 ? cat.productCount + " services" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${cat.priceCount > 0 ? cat.priceCount + " rates" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${badge(cat.source === "database" ? "DB" : cat.source === "static" ? "Static" : "None",
               cat.source === "database" ? "blue" : cat.source === "static" ? "yellow" : "gray")}</td>
        <td>${cat.hasPreset
          ? badge(cat.isActive ? "✅ Active" : "⏸ Off", cat.isActive ? "green" : "gray")
          : "<em style='color:#aaa'>No preset</em>"}</td>
        <td><small>${cat.updatedAt ? new Date(cat.updatedAt).toLocaleDateString() : "-"}</small></td>
        <td>
          <a href="/zq-admin/presets/${esc(cat.id)}" class="btn-link">Edit →</a>
          ${cat.hasPreset ? `&nbsp;<button onclick="togglePreset('${esc(cat.id)}')" class="btn-sm btn-${cat.isActive ? "orange" : "green"}">${cat.isActive ? "Disable" : "Enable"}</button>` : ""}
        </td>
      </tr>`).join("");

    res.send(layout("Presets", `
      <div class="panel">
        <div class="panel-head">
          <h3>📦 Product Category Presets</h3>
          <span style="font-size:12px;color:var(--muted)">Green = shown to suppliers during registration</span>
        </div>
        <table>
          <thead><tr><th>Category</th><th>Sub-cats</th><th>Products</th><th>Prices</th><th>Source</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${productRows}</tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>🔧 Service Category Presets</h3>
        </div>
        <table>
          <thead><tr><th>Category</th><th>Sub-cats</th><th>Services</th><th>Rates</th><th>Source</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${serviceRows}</tbody>
        </table>
      </div>

      <script>
        async function togglePreset(catId) {
          const r = await fetch('/zq-admin/presets/' + catId + '/toggle', { method: 'PATCH' });
          const d = await r.json();
          if (d.success) location.reload();
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Presets", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── GET /zq-admin/presets/:catId ─────────────────────────────────────────────
router.get("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    const { catId } = req.params;
    const catDef = SUPPLIER_CATEGORIES.find(c => c.id === catId);
    if (!catDef) return res.redirect("/zq-admin/presets");

    let preset = await CategoryPreset.findOne({ catId }).lean();
    let source = "database";

    if (!preset) {
      const staticTemplate = TEMPLATES[catId];
      source = staticTemplate ? "static" : "none";
      preset = {
        catId,
        label: catDef.label,
        profileType: catDef.types[0],
        products: staticTemplate?.products || [],
        prices: staticTemplate?.prices || [],
        subcatMap: staticTemplate?.subcatMap
          ? Object.entries(staticTemplate.subcatMap).map(([lbl, prods]) => ({ label: lbl, products: prods }))
          : [],
        isActive: !!staticTemplate,
        adminNote: staticTemplate?.adminNote || ""
      };
    }

    const subcatDefs = catDef.subcats || [];
    const productListText = (preset.products || []).join("\n");
    const pricesJson = JSON.stringify(preset.prices || [], null, 2);

    const subcatSections = subcatDefs.map(sub => {
      const existing = (preset.subcatMap || []).find(s => s.label === sub.label);
      const existing_products = existing ? existing.products.join("\n") : "";
      return `
        <div class="fg full" style="margin-bottom:14px">
          <label>${esc(sub.label)}</label>
          <textarea name="subcat_${esc(sub.id)}" rows="3" style="font-size:12px"
            placeholder="Product names in this sub-cat, one per line">${esc(existing_products)}</textarea>
        </div>`;
    }).join("");

    res.send(layout(`Preset: ${esc(catDef.label)}`, `
      <a href="/zq-admin/presets" class="back-link">← Back to Presets</a>

      <div class="panel">
        <div class="panel-head">
          <h3>Edit Preset - ${esc(catDef.label)}</h3>
          <div style="font-size:12px;color:var(--muted)">
            ID: <code>${esc(catId)}</code> &nbsp;|&nbsp;
            Type: ${(catDef.types || []).join(", ")} &nbsp;|&nbsp;
            Source: ${badge(source.toUpperCase(), source === "database" ? "blue" : source === "static" ? "yellow" : "gray")}
          </div>
        </div>

        <div class="stats" style="display:flex;gap:12px;margin-bottom:20px">
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="stat-products">${preset.products?.length || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Products</div>
          </div>
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="stat-prices">${preset.prices?.length || 0}</div>
            <div style="font-size:12px;color:var(--muted)">With Prices</div>
          </div>
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700">${subcatDefs.length}</div>
            <div style="font-size:12px;color:var(--muted)">Sub-cats</div>
          </div>
        </div>

        <form id="presetForm">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <input type="checkbox" id="isActive" ${preset.isActive ? "checked" : ""}>
            <label for="isActive" style="margin:0;font-weight:600">Active - shown to suppliers during registration</label>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Admin Note (internal only)</label>
            <input type="text" id="adminNote" value="${esc(preset.adminNote || "")}"
              placeholder="e.g. Zimbabwe market prices Jan 2025"
              style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:100%">
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Products / Services (one per line)</label>
            <small style="color:var(--muted);display:block;margin-bottom:6px">Each line = one item shown to the supplier in the preview</small>
            <textarea id="productsArea" rows="20" style="font-family:monospace;font-size:12px;padding:10px;border:1px solid #ddd;border-radius:6px;width:100%">${esc(productListText)}</textarea>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Suggested Prices (JSON)</label>
            <small style="color:var(--muted);display:block;margin-bottom:6px">
              Format: <code>[{"product":"name","amount":5.50,"unit":"each"}, ...]</code>
              Product name must match exactly what's in the list above.
            </small>
            <textarea id="pricesJson" rows="12" style="font-family:monospace;font-size:11px;padding:10px;border:1px solid #ddd;border-radius:6px;width:100%">${esc(pricesJson)}</textarea>
          </div>

          ${subcatDefs.length ? `
          <div style="margin-bottom:14px">
            <label style="font-weight:bold;display:block;margin-bottom:8px">Sub-category Grouping</label>
            <small style="color:var(--muted);display:block;margin-bottom:10px">Assign products to sub-categories for admin display. Product names must match the list above.</small>
            ${subcatSections}
          </div>` : ""}

          <div id="save-status" style="display:none;padding:10px 16px;border-radius:6px;margin-bottom:12px;font-size:13px"></div>

          <div style="display:flex;gap:10px">
            <button type="button" onclick="savePreset()" class="btn btn-blue">💾 Save Preset</button>
            <a href="/zq-admin/presets" class="btn btn-gray">Cancel</a>
            <button type="button" onclick="deletePreset()" class="btn btn-red" style="margin-left:auto">🗑 Delete Preset</button>
          </div>
        </form>
      </div>

      <script>
        const SUBCAT_IDS = ${JSON.stringify(subcatDefs.map(s => s.id))};
        const SUBCAT_LABELS = ${JSON.stringify(subcatDefs.reduce((m, s) => { m[s.id] = s.label; return m; }, {}))};

        async function savePreset() {
          const status = document.getElementById('save-status');
          const products = document.getElementById('productsArea').value;
          let prices = [];
          try { prices = JSON.parse(document.getElementById('pricesJson').value); }
          catch(e) { showStatus('❌ Prices JSON is invalid: ' + e.message, false); return; }

          const subcatMap = [];
          SUBCAT_IDS.forEach(id => {
            const el = document.querySelector('[name="subcat_' + id + '"]');
            if (!el) return;
            const prods = el.value.split('\\n').map(s=>s.trim()).filter(Boolean);
            if (prods.length) subcatMap.push({ label: SUBCAT_LABELS[id], products: prods });
          });

          const payload = {
            products,
            prices,
            subcatMap,
            isActive: document.getElementById('isActive').checked,
            adminNote: document.getElementById('adminNote').value,
            profileType: '${esc(catDef.types[0])}'
          };

          try {
            const r = await fetch(window.location.pathname, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const d = await r.json();
            if (d.success) {
              showStatus('✅ Saved! ' + d.productCount + ' products, ' + d.priceCount + ' prices.', true);
              document.getElementById('stat-products').textContent = d.productCount;
              document.getElementById('stat-prices').textContent = d.priceCount;
            } else {
              showStatus('❌ Error: ' + d.error, false);
            }
          } catch(e) {
            showStatus('❌ Network error: ' + e.message, false);
          }
        }

        async function deletePreset() {
          if (!confirm('Delete this preset? Suppliers will no longer see "Use Preset List" for this category.')) return;
          const r = await fetch(window.location.pathname, { method: 'DELETE' });
          const d = await r.json();
          if (d.success) window.location.href = '/zq-admin/presets';
        }

        function showStatus(msg, ok) {
          const el = document.getElementById('save-status');
          el.style.display = 'block';
          el.style.background = ok ? '#d1fae5' : '#fee2e2';
          el.style.color = ok ? '#065f46' : '#991b1b';
          el.textContent = msg;
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Presets", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── POST /zq-admin/presets/:catId ────────────────────────────────────────────
router.post("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    const { catId } = req.params;
    const catDef = SUPPLIER_CATEGORIES.find(c => c.id === catId);
    if (!catDef) return res.status(404).json({ error: "Category not found" });

    // Products come as a newline-separated string
    const rawProducts = (req.body.products || "")
      .split(/\n/)
      .map(p => p.trim())
      .filter(Boolean);

    // Prices come as an already-parsed array (express.json() handles this)
    const prices = Array.isArray(req.body.prices) ? req.body.prices : [];

    // SubcatMap comes as array of {label, products[]}
    const subcatMap = Array.isArray(req.body.subcatMap) ? req.body.subcatMap : [];

    const updated = await CategoryPreset.findOneAndUpdate(
      { catId },
      {
        $set: {
          catId,
          label: catDef.label,
          profileType: req.body.profileType || catDef.types[0],
          products: rawProducts,
          prices,
          subcatMap,
          isActive: req.body.isActive === true || req.body.isActive === "true",
          adminNote: (req.body.adminNote || "").trim(),
          updatedBy: "admin",
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    // Update in-memory static templates immediately (no server restart needed)
    setTemplateForCategory(catId, {
      isAdminPreset: true,
      adminNote: updated.adminNote,
      products: updated.products,
      prices: updated.prices,
      subcatMap: updated.subcatMap?.length
        ? Object.fromEntries(updated.subcatMap.map(s => [s.label, s.products]))
        : null
    });

    res.json({ success: true, catId, productCount: rawProducts.length, priceCount: prices.length });
  } catch (err) {
    console.error("[Admin Preset Save]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /zq-admin/presets/:catId ──────────────────────────────────────────
router.delete("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    await CategoryPreset.deleteOne({ catId: req.params.catId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /zq-admin/presets/:catId/toggle ────────────────────────────────────
router.patch("/presets/:catId/toggle", requireSupplierAdmin, async (req, res) => {
  try {
    const preset = await CategoryPreset.findOne({ catId: req.params.catId });
    if (!preset) return res.status(404).json({ error: "Preset not found in DB. Save it first before toggling." });
    preset.isActive = !preset.isActive;
    await preset.save();
    res.json({ success: true, isActive: preset.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





router.get("/suppliers/:id/live-items", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  const uploaded = supplier.products || [];
  const live = supplier.listedProducts || [];

  res.send(layout("Manage Live Items", `
    <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back</a>

    <div class="panel">
      <h3>${supplier.businessName}</h3>

      <p><strong>Tier:</strong> ${supplier.tier || "basic"}</p>
      <p><strong>Live:</strong> ${live.length} / ${cap}</p>
      <p><strong>Uploaded:</strong> ${uploaded.length}</p>

      ${uploaded.length ? `
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/live-items">

        <p><strong>Select up to ${cap} items:</strong></p>

        <div style="max-height:400px;overflow:auto;border:1px solid #ddd;padding:10px;">
          ${uploaded.map((p, i) => `
            <label style="display:block;margin-bottom:6px;">
              <input type="checkbox" name="items" value="${p}"
                ${live.includes(p) ? "checked" : ""}>
              ${i + 1}. ${p}
            </label>
          `).join("")}
        </div>

        <button type="submit" class="btn btn-blue" style="margin-top:12px;">
          💾 Save Live Items
        </button>
      </form>
      ` : `<em>No uploaded items</em>`}
    </div>
  `));
});















// ── Contacts (Phone Numbers / Users) ──────────────────────────────────────
router.get("/contacts", requireSupplierAdmin, async (req, res) => {
  try {
    const { search = "", period = "", page = 1 } = req.query;
    const limit = 30;
    const skip  = (Number(page) - 1) * limit;

    // ── Date range for "period" filter ─────────────────────────────────────
    const now   = new Date();
    let dateFrom = null;
    if (period === "today") {
      dateFrom = new Date(now); dateFrom.setHours(0,0,0,0);
    } else if (period === "week") {
      dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 7);
    } else if (period === "month") {
      dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 30);
    }

    // ── Build query ─────────────────────────────────────────────────────────
    const query = {};
    if (search) {
      query.$or = [
        { phone:        { $regex: search, $options: "i" } },
        { firstMessage: { $regex: search, $options: "i" } },
        { channel:      { $regex: search, $options: "i" } }
      ];
    }
    if (dateFrom) query.createdAt = { $gte: dateFrom };

    // ── Stats (always unfiltered for accuracy) ──────────────────────────────
    const todayStart  = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart   = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart  = new Date(now); monthStart.setDate(now.getDate() - 30);

    const [
      total, todayCount, weekCount, monthCount,
      contacts
    ] = await Promise.all([
      PhoneContact.countDocuments(),
      PhoneContact.countDocuments({ createdAt: { $gte: todayStart } }),
      PhoneContact.countDocuments({ createdAt: { $gte: weekStart } }),
      PhoneContact.countDocuments({ createdAt: { $gte: monthStart } }),
      PhoneContact.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

    const filteredTotal = await PhoneContact.countDocuments(query);
    const pages = Math.ceil(filteredTotal / limit);
    const qs = (p) => `?page=${p}&search=${encodeURIComponent(search)}&period=${period}`;

    res.send(layout("Contacts", `

      <!-- ── Stats row ─────────────────────────────────────────────── -->
      <div class="stats-grid" style="margin-bottom:20px">
        ${stat(total,       "Total Contacts",     "")}
        ${stat(todayCount,  "New Today",          "green")}
        ${stat(weekCount,   "New This Week",      "blue")}
        ${stat(monthCount,  "New This Month",     "teal")}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Phone Contacts <span class="count">${filteredTotal}</span></h3>
          <form method="GET" class="filter-form">
            <input
              name="search"
              placeholder="Search phone or message..."
              value="${esc(search)}"
              style="min-width:200px"
            />
            <select name="period">
              <option value="">All Time</option>
              <option ${period === "today" ? "selected" : ""}  value="today">Today</option>
              <option ${period === "week"  ? "selected" : ""}  value="week">Last 7 Days</option>
              <option ${period === "month" ? "selected" : ""}  value="month">Last 30 Days</option>
            </select>
            <button type="submit">Filter</button>
            <a href="/zq-admin/contacts" class="btn-reset">Clear</a>
          </form>
        </div>

        <!-- ── Mobile-friendly table wrapper ────────────────────── -->
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Phone</th>
                <th>First Message</th>
                <th>Channel</th>
                <th>First Seen</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>
              ${contacts.length ? contacts.map((c, i) => `
              <tr>
                <td style="color:var(--muted);font-size:11px">${skip + i + 1}</td>
                <td>
                  <strong style="font-size:13px">${esc(c.phone)}</strong>
                </td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">
                  ${c.firstMessage ? esc(c.firstMessage).slice(0, 60) : "<em>—</em>"}
                </td>
                <td>
                  <span class="badge badge-blue" style="font-size:10px">${esc(c.channel || "whatsapp")}</span>
                </td>
                <td style="white-space:nowrap;font-size:12px">
                  ${new Date(c.firstSeen || c.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "2-digit",
                    hour: "2-digit", minute: "2-digit"
                  })}
                </td>
                <td style="white-space:nowrap;font-size:12px;color:var(--muted)">
                  ${new Date(c.updatedAt || c.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "2-digit"
                  })}
                </td>
              </tr>`).join("") : `
              <tr>
                <td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">
                  No contacts found.
                </td>
              </tr>`}
            </tbody>
          </table>
        </div>

        <!-- ── Pagination ─────────────────────────────────────────── -->
        ${pages > 1 ? `
        <div class="pagination">
          ${Number(page) > 1 ? `<a href="${qs(Number(page) - 1)}">← Prev</a>` : ""}
          ${Array.from({ length: Math.min(pages, 10) }, (_, i) => i + 1).map(p =>
            `<a href="${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
          ${Number(page) < pages ? `<a href="${qs(Number(page) + 1)}">Next →</a>` : ""}
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">
          Showing ${skip + 1}–${Math.min(skip + limit, filteredTotal)} of ${filteredTotal}
        </p>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Contacts", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

router.post("/suppliers/:id/live-items", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id);
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  let items = req.body.items || [];
  if (!Array.isArray(items)) items = [items];

  // clean + dedupe
  const cleaned = [...new Set(items.map(i => String(i).trim()).filter(Boolean))];

  if (cleaned.length > cap) {
    return res.send("❌ Cannot exceed plan limit (" + cap + ")");
  }

  supplier.listedProducts = cleaned;
  await supplier.save();

  res.redirect(`/zq-admin/suppliers/${supplier._id}/live-items`);
});

export default router;
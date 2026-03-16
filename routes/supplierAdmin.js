// routes/supplierAdmin.js
import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";
import SupplierSubscriptionPayment from "../models/supplierSubscriptionPayment.js";

const router = express.Router();

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

    res.send(layout(esc(supplier.businessName), `
      <a href="/zq-admin/suppliers" class="back-link">← Back to Suppliers</a>

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
</div>
        </div>

        <div>
          <div class="panel">
            <h3>Products (${(supplier.products || []).length})</h3>
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
      businessName, phone, city, area, tier, subscriptionStatus,
      subscriptionExpiresAt, active, minOrder, profileType,
      products, categories, adminNote, credibilityScore, rating
    } = req.body;

    const update = {
      businessName: businessName?.trim(),
      phone: phone?.trim(),
      "location.city": city?.trim(),
      "location.area": area?.trim(),
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
  const supplier = await SupplierProfile.findById(req.params.id);
  if (supplier) { supplier.active = !supplier.active; await supplier.save(); }
  res.redirect(`/zq-admin/suppliers/${req.params.id}`);
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
                <option value="basic">✅ Basic — $5/month</option>
                <option value="pro">⭐ Pro — $12/month</option>
                <option value="featured">🔥 Featured — $25/month</option>
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
              <option value="true">Yes — make listing visible to buyers</option>
              <option value="false">No — activate subscription only</option>
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

    const planDetails = SUPPLIER_PLANS[tier]?.[plan];
    const days = Number(durationDays) || planDetails?.durationDays || 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const update = {
      tier,
      tierRank: tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
      subscriptionStatus: "active",
      subscriptionStartedAt: now,
      subscriptionExpiresAt: expiresAt,
      subscriptionPlan: plan,
      active: setActive === "true",
      adminNote: reason
        ? `[Admin activated ${tier}/${plan} on ${now.toDateString()}] ${reason}`
        : `[Admin activated ${tier}/${plan} on ${now.toDateString()}]`
    };

    await SupplierProfile.findByIdAndUpdate(req.params.id, update);

    // Log a payment record so it shows in payment history
    await SupplierSubscriptionPayment.create({
      supplierPhone: (await SupplierProfile.findById(req.params.id).lean())?.phone || "",
      supplierId: req.params.id,
      tier,
      plan,
      amount: 0,
      currency: "USD",
      reference: `MANUAL_${req.params.id}_${Date.now()}`,
      status: "paid",
      paidAt: now,
      ecocashPhone: "manual-admin"
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
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
      // Append — avoid duplicates
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
      <h3>Edit Price — ${esc(price.product)}</h3>
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

    if (supplier.prices[idx]) {
      supplier.prices[idx] = {
        product: product.trim().toLowerCase(),
        amount: parseFloat(amount),
        unit: unit?.trim() || "each",
        inStock: inStock === "true",
        currency: "USD"
      };
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
    { href: "/zq-admin", label: "📊 Dashboard", match: title === "Dashboard" },
    { href: "/zq-admin/suppliers", label: "🏪 Suppliers", match: title === "Suppliers" || title.includes("Edit") },
    { href: "/zq-admin/orders", label: "📦 Orders", match: title === "Orders" },
    { href: "/zq-admin/payments", label: "💳 Payments", match: title === "Payments" },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ZimQuote Admin</title>
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

export default router;
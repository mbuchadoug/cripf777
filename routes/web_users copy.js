import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import UserRole from "../models/userRole.js";
import Branch from "../models/branch.js";
import Business from "../models/business.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";

const router = express.Router();

router.use(requireWebAuth);

// ─── Guard: only owners can manage users ─────────────────────────────────────
function ownerOnly(req, res, next) {
  if (req.webUser.role !== "owner") {
    return res.status(403).render("web/error", {
      layout: "web",
      title: "Access Denied",
      message: "Only business owners can manage users.",
      user: req.webUser
    });
  }
  next();
}

/**
 * GET /web/users
 * List all staff - show role, branch, status, last activity
 */
router.get("/users", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;

    const [users, branches] = await Promise.all([
      UserRole.find({ businessId }).populate("branchId", "name").lean(),
      Branch.find({ businessId }).lean()
    ]);

    // For each user, get last record they created
    const usersWithActivity = await Promise.all(
      users.map(async (u) => {
        const lastInvoice = await Invoice.findOne({ businessId, createdBy: u.phone })
          .sort({ createdAt: -1 })
          .select("createdAt number")
          .lean();
        return {
          ...u,
          branchName: u.branchId?.name || "-",
          lastActivity: lastInvoice?.createdAt || null,
          lastDoc: lastInvoice?.number || null
        };
      })
    );

    res.render("web/users/list", {
      layout: "web",
      title: "Team - ZimQuote",
      user: req.webUser,
      users: usersWithActivity,
      branches,
      pendingCount: users.filter(u => u.pending).length
    });

  } catch (error) {
    console.error("Users list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load users",
      user: req.webUser
    });
  }
});

/**
 * POST /web/users/invite
 * Invite a new user via WhatsApp - creates a pending UserRole
 * The user must respond on WhatsApp to complete onboarding,
 * but the owner pre-assigns role and branch here.
 */
router.post("/users/invite", ownerOnly, async (req, res) => {
  try {
    const { businessId, phone: ownerPhone } = req.webUser;
    let { phone, role = "clerk", branchId } = req.body;

    // Normalise phone
    phone = phone.replace(/\D+/g, "");
    if (phone.startsWith("0")) phone = "263" + phone.slice(1);

    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    if (!["clerk", "manager"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Use clerk or manager." });
    }

    // Block duplicate
    const existing = await UserRole.findOne({ businessId, phone });
    if (existing) {
      return res.status(409).json({ error: "User already exists or has a pending invite" });
    }

    await UserRole.create({
      businessId,
      phone,
      role,
      branchId: branchId || null,
      pending: true,           // ← they must confirm on WhatsApp
      invitedBy: ownerPhone
    });

    res.json({ success: true, message: `Invite created. Ask ${phone} to message your WhatsApp bot with JOIN to activate.` });

  } catch (error) {
    console.error("Invite user error:", error);
    res.status(500).json({ error: "Failed to send invite" });
  }
});

/**
 * PUT /web/users/:id/role
 * Change a user's role or branch assignment
 */
router.put("/users/:id/role", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;
    const { role, branchId } = req.body;

    if (role && !["clerk", "manager", "owner"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const user = await UserRole.findOne({ _id: req.params.id, businessId });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Cannot demote the only owner
    if (user.role === "owner" && role !== "owner") {
      const ownerCount = await UserRole.countDocuments({ businessId, role: "owner", pending: false });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: "Cannot remove the only owner" });
      }
    }

    if (role) user.role = role;
    if (branchId !== undefined) user.branchId = branchId || null;
    await user.save();

    res.json({ success: true });

  } catch (error) {
    console.error("Update role error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * PUT /web/users/:id/lock
 * Lock or unlock a user - locked users cannot log in or use the WhatsApp bot
 */
router.put("/users/:id/lock", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;
    const { locked } = req.body; // boolean

    const user = await UserRole.findOne({ _id: req.params.id, businessId });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Cannot lock yourself
    if (user.phone === req.webUser.phone) {
      return res.status(400).json({ error: "You cannot lock your own account" });
    }

    user.locked = !!locked;
    await user.save();

    res.json({ success: true, locked: user.locked });

  } catch (error) {
    console.error("Lock user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * DELETE /web/users/:id
 * Remove user from the business
 */
router.delete("/users/:id", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;

    const user = await UserRole.findOne({ _id: req.params.id, businessId });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.phone === req.webUser.phone) {
      return res.status(400).json({ error: "You cannot remove yourself" });
    }

    await UserRole.deleteOne({ _id: user._id });

    res.json({ success: true });

  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ error: "Failed to remove user" });
  }
});

/**
 * GET /web/users/:id/activity
 * View all records created by this user
 */
router.get("/users/:id/activity", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;

    const user = await UserRole.findOne({ _id: req.params.id, businessId })
      .populate("branchId", "name")
      .lean();

    if (!user) {
      return res.status(404).render("web/error", {
        layout: "web",
        title: "Not Found",
        message: "User not found",
        user: req.webUser
      });
    }

    const [invoices, expenses] = await Promise.all([
      Invoice.find({ businessId, createdBy: user.phone })
        .populate("clientId", "name phone")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Expense.find({ businessId, createdBy: user.phone })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);

    res.render("web/users/activity", {
      layout: "web",
      title: `${user.phone} Activity - ZimQuote`,
      user: req.webUser,
      member: { ...user, branchName: user.branchId?.name || "-" },
      invoices: invoices.map(i => ({
        ...i,
        clientName: i.clientId?.name || i.clientId?.phone || "Unknown"
      })),
      expenses
    });

  } catch (error) {
    console.error("User activity error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load activity",
      user: req.webUser
    });
  }
});

export default router;
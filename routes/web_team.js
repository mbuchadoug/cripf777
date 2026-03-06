import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Business from "../models/business.js";
import Branch from "../models/branch.js";
import UserRole from "../models/userRole.js";

const router = express.Router();

// ── GET /web/team ─────────────────────────────────────────────────────────────
router.get("/team", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;

    const [business, branches, users, pendingInvites] = await Promise.all([
      Business.findById(businessId).lean(),
      Branch.find({ businessId }).sort({ createdAt: 1 }).lean(),
      UserRole.find({ businessId, pending: false })
        .populate("branchId", "name")
        .lean(),
      UserRole.find({ businessId, pending: true })
        .populate("branchId", "name")
        .lean()
    ]);

    if (!business) return res.redirect("/web/dashboard");

    res.render("web/team", {
      layout: "web",
      pageTitle: "Team & Branches",
      pageKey: "team",
      user: req.webUser,
      business,
      branches,
      users,
      pendingInvites,
      saved:  req.query.saved  || null,
      error:  req.query.error  || null
    });
  } catch (err) {
    console.error("Team GET error:", err);
    res.redirect("/web/dashboard");
  }
});

// ── POST /web/team/branch/add ─────────────────────────────────────────────────
router.post("/team/branch/add", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const name = (req.body.name || "").trim();

    if (!name || name.length < 2) {
      return res.redirect("/web/team?error=branch_name_empty");
    }

    // Check for duplicate name
    const exists = await Branch.findOne({ businessId, name: new RegExp(`^${name}$`, "i") });
    if (exists) return res.redirect("/web/team?error=branch_exists");

    // First branch is always default
    const count = await Branch.countDocuments({ businessId });
    await Branch.create({
      businessId,
      name,
      isDefault: count === 0
    });

    res.redirect("/web/team?saved=branch_added");
  } catch (err) {
    console.error("Add branch error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/branch/delete ──────────────────────────────────────────────
router.post("/team/branch/delete", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const { branchId } = req.body;

    const branch = await Branch.findOne({ _id: branchId, businessId });
    if (!branch) return res.redirect("/web/team?error=not_found");

    // Block deletion if users are assigned
    const usersInBranch = await UserRole.countDocuments({ businessId, branchId, pending: false });
    if (usersInBranch > 0) {
      return res.redirect("/web/team?error=branch_has_users");
    }

    // Block deletion if it's the only branch
    const total = await Branch.countDocuments({ businessId });
    if (total <= 1) {
      return res.redirect("/web/team?error=last_branch");
    }

    await Branch.deleteOne({ _id: branchId, businessId });
    res.redirect("/web/team?saved=branch_deleted");
  } catch (err) {
    console.error("Delete branch error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/invite ─────────────────────────────────────────────────────
// Sends a "pending" UserRole — user activates it by messaging "JOIN" on WhatsApp
router.post("/team/invite", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    let { phone, role, branchId } = req.body;

    // ── Normalize phone ──────────────────────────────────────────────────────
    const raw = (phone || "").replace(/\D+/g, "");
    let normalized = raw;
    if (normalized.startsWith("0") && normalized.length === 10) {
      normalized = "263" + normalized.slice(1);
    }
    if (!normalized.startsWith("263") || normalized.length !== 12) {
      return res.redirect("/web/team?error=invalid_phone");
    }

    // ── Validate role ────────────────────────────────────────────────────────
    const allowedRoles = ["clerk", "manager"];
    if (!allowedRoles.includes(role)) {
      return res.redirect("/web/team?error=invalid_role");
    }

    // ── Validate branch ──────────────────────────────────────────────────────
    const branch = await Branch.findOne({ _id: branchId, businessId });
    if (!branch) return res.redirect("/web/team?error=invalid_branch");

    // ── Check if already active ──────────────────────────────────────────────
    const alreadyActive = await UserRole.findOne({ businessId, phone: normalized, pending: false });
    if (alreadyActive) return res.redirect("/web/team?error=user_exists");

    // ── Upsert pending invite ────────────────────────────────────────────────
    await UserRole.findOneAndUpdate(
      { businessId, phone: normalized },
      { businessId, phone: normalized, role, branchId: branch._id, pending: true },
      { upsert: true, new: true }
    );

    res.redirect("/web/team?saved=invited");
  } catch (err) {
    console.error("Invite user error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/user/assign-branch ────────────────────────────────────────
router.post("/team/user/assign-branch", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const { userId, branchId } = req.body;

    const branch = await Branch.findOne({ _id: branchId, businessId });
    if (!branch) return res.redirect("/web/team?error=invalid_branch");

    await UserRole.findOneAndUpdate(
      { _id: userId, businessId, pending: false },
      { branchId: branch._id }
    );

    res.redirect("/web/team?saved=assigned");
  } catch (err) {
    console.error("Assign branch error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/user/toggle-lock ──────────────────────────────────────────
router.post("/team/user/toggle-lock", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const { userId } = req.body;

    const user = await UserRole.findOne({ _id: userId, businessId, pending: false });
    if (!user) return res.redirect("/web/team?error=not_found");
    if (user.role === "owner") return res.redirect("/web/team?error=cannot_lock_owner");

    user.locked = !user.locked;
    await user.save();

    res.redirect(`/web/team?saved=${user.locked ? "locked" : "unlocked"}`);
  } catch (err) {
    console.error("Toggle lock error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/user/remove ────────────────────────────────────────────────
router.post("/team/user/remove", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const { userId } = req.body;

    const user = await UserRole.findOne({ _id: userId, businessId });
    if (!user) return res.redirect("/web/team?error=not_found");
    if (user.role === "owner") return res.redirect("/web/team?error=cannot_remove_owner");

    await UserRole.deleteOne({ _id: userId, businessId });
    res.redirect("/web/team?saved=removed");
  } catch (err) {
    console.error("Remove user error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

// ── POST /web/team/invite/cancel ─────────────────────────────────────────────
router.post("/team/invite/cancel", requireWebAuth, async (req, res) => {
  try {
    const businessId = req.webUser.businessId;
    const { inviteId } = req.body;

    await UserRole.deleteOne({ _id: inviteId, businessId, pending: true });
    res.redirect("/web/team?saved=invite_cancelled");
  } catch (err) {
    console.error("Cancel invite error:", err);
    res.redirect("/web/team?error=save_failed");
  }
});

export default router;
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import Payment from "../models/payment.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";

const router = Router();

// 🔐 Admin email guard
function ensureAdminEmails(req, res, next) {
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
  const email = String(req.user?.email || "").toLowerCase();
  if (!adminSet.has(email)) return res.status(403).send("Admins only");
  next();
}

// ── Plan definitions (mirror payments.js) ────────────────────────────────────
const PLANS = {
  silver:               { name: "Silver",               amount: 5,  maxChildren: 2,  durationDays: 30 },
  gold:                 { name: "Gold",                  amount: 10, maxChildren: 5,  durationDays: 30 },
  teacher_starter:      { name: "Teacher Starter",       amount: 9,  maxChildren: 15, durationDays: 30 },
  teacher_professional: { name: "Teacher Professional",  amount: 19, maxChildren: 40, durationDays: 30 }
};

// ----------------------------------
// GET /admin/finance
// ----------------------------------
router.get(
  "/admin/finance",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    const now = new Date();

    const allPaidPayments = await Payment.find({ status: "paid" }).lean();
    const totalRevenue    = allPaidPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalPayments   = allPaidPayments.length;

    const monthStart       = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthPayments = allPaidPayments.filter(p => new Date(p.paidAt) >= monthStart);
    const monthRevenue     = thisMonthPayments.reduce((s, p) => s + (p.amount || 0), 0);

    const silverPayments = allPaidPayments.filter(p => p.plan === "silver");
    const goldPayments   = allPaidPayments.filter(p => p.plan === "gold");
    const silverRevenue  = silverPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const goldRevenue    = goldPayments.reduce((s, p) => s + (p.amount || 0), 0);

    const allParents = await User.find({ role: "parent" }).lean();

    const activeSubscribers  = allParents.filter(u => u.subscriptionStatus === "paid" && u.subscriptionExpiresAt && new Date(u.subscriptionExpiresAt) > now);
    const expiredSubscribers = allParents.filter(u => u.subscriptionStatus === "paid" && u.subscriptionExpiresAt && new Date(u.subscriptionExpiresAt) <= now);
    const trialUsers         = allParents.filter(u => u.subscriptionStatus !== "paid");

    const activeSilver = activeSubscribers.filter(u => u.subscriptionPlan === "silver");
    const activeGold   = activeSubscribers.filter(u => u.subscriptionPlan === "gold");

    const sevenDays    = new Date(now);
    sevenDays.setDate(sevenDays.getDate() + 7);
    const expiringSoon = activeSubscribers.filter(u => new Date(u.subscriptionExpiresAt) <= sevenDays);

    const subscriberList = [];
    for (const parent of [...activeSubscribers, ...expiredSubscribers]) {
      const childCount   = await User.countDocuments({ parentUserId: parent._id, role: "student" });
      const lastPayment  = await Payment.findOne({ userId: parent._id, status: "paid" }).sort({ paidAt: -1 }).lean();
      const isActive     = parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now;
      const daysLeft     = isActive ? Math.ceil((new Date(parent.subscriptionExpiresAt) - now) / (1000 * 60 * 60 * 24)) : 0;

      subscriberList.push({
        _id:               parent._id,
        name:              [parent.firstName, parent.lastName].filter(Boolean).join(" ") || parent.displayName || parent.email || "Unknown",
        email:             parent.email || "-",
        plan:              parent.subscriptionPlan || "none",
        status:            isActive ? "active" : "expired",
        childCount,
        maxChildren:       parent.maxChildren || 0,
        expiresAt:         parent.subscriptionExpiresAt,
        daysLeft,
        lastPaymentDate:   lastPayment?.paidAt || null,
        lastPaymentAmount: lastPayment?.amount || 0
      });
    }
    subscriberList.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return a.daysLeft - b.daysLeft;
    });

    const recentPayments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("userId", "firstName lastName email displayName")
      .lean();

    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const mStart    = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd      = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const mPayments = allPaidPayments.filter(p => { const d = new Date(p.paidAt); return d >= mStart && d < mEnd; });
      monthlyRevenue.push({
        label:  mStart.toLocaleString("en-US", { month: "short", year: "numeric" }),
        amount: mPayments.reduce((s, p) => s + (p.amount || 0), 0),
        count:  mPayments.length
      });
    }

    // ── Trial users list for manual activation panel ──────────────────────────
    const trialList = trialUsers.map(u => ({
      _id:   u._id,
      name:  [u.firstName, u.lastName].filter(Boolean).join(" ") || u.displayName || u.email || "Unknown",
      email: u.email || "-"
    }));

    res.render("admin/finance", {
      user: req.user,
      stats: {
        totalRevenue, totalPayments,
        monthRevenue, monthPaymentCount: thisMonthPayments.length,
        silverRevenue, goldRevenue,
        silverPaymentCount: silverPayments.length,
        goldPaymentCount: goldPayments.length,
        totalParents: allParents.length,
        activeCount: activeSubscribers.length,
        expiredCount: expiredSubscribers.length,
        trialCount: trialUsers.length,
        activeSilverCount: activeSilver.length,
        activeGoldCount: activeGold.length,
        expiringSoonCount: expiringSoon.length
      },
      subscriberList,
      trialList,
      recentPayments,
      monthlyRevenue,
      plans: Object.entries(PLANS).map(([key, p]) => ({ key, name: p.name, amount: p.amount, durationDays: p.durationDays }))
    });
  }
);

// ----------------------------------
// POST /admin/finance/manual-activate
// Manually activate or extend any parent account
// ----------------------------------
router.post(
  "/admin/finance/manual-activate",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { userId, plan, durationDays, note } = req.body;

      if (!userId || !plan) {
        return res.status(400).json({ error: "userId and plan are required" });
      }

      const planConfig = PLANS[plan];
      if (!planConfig) {
        return res.status(400).json({ error: "Invalid plan" });
      }

      const days = parseInt(durationDays) || planConfig.durationDays;
      const now  = new Date();

      const parent = await User.findById(userId);
      if (!parent) return res.status(404).json({ error: "User not found" });

      // Calculate expiry - extend from today or from current expiry if still active
      let expiresAt;
      if (parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now) {
        expiresAt = new Date(parent.subscriptionExpiresAt);
        expiresAt.setDate(expiresAt.getDate() + days);
      } else {
        expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + days);
      }

      // Update user
      await User.findByIdAndUpdate(userId, {
        subscriptionStatus:    "paid",
        subscriptionPlan:      plan,
        maxChildren:           planConfig.maxChildren,
        subscriptionExpiresAt: expiresAt,
        paidAt:                now,
        consumerEnabled:       true
      });

      // Create a manual payment record for audit trail
      await Payment.create({
        userId:    parent._id,
        reference: `MANUAL-${Date.now()}-${String(parent._id).slice(-6)}`,
        amount:    0,
        plan,
        status:    "paid",
        paidAt:    now,
        meta: {
          method:      "manual_admin",
          activatedBy: req.user.email,
          note:        note || "Manual activation by admin",
          durationDays: days
        }
      });

      // Enable all children
      await User.updateMany(
        { parentUserId: parent._id, role: "student" },
        { $set: { consumerEnabled: true } }
      );

      // Assign paid quiz rules to all children
      const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
      if (org) {
        const children = await User.find({ parentUserId: parent._id, role: "student" });
        for (const child of children) {
          const rules = await QuizRule.find({
            org: org._id, grade: child.grade, quizType: "paid", enabled: true
          });
          for (const rule of rules) {
            await assignQuizFromRule({ rule, userId: child._id, orgId: org._id, force: true });
          }
        }
      }

      const parentName = [parent.firstName, parent.lastName].filter(Boolean).join(" ") || parent.email;
      console.log(`[manual-activate] ${planConfig.name} activated for ${parentName} (${parent.email}) by ${req.user.email} - expires ${expiresAt.toISOString()}`);

      return res.json({
        success:  true,
        message:  `${planConfig.name} activated for ${parentName} until ${expiresAt.toLocaleDateString()}`,
        expiresAt
      });

    } catch (err) {
      console.error("[manual-activate] error:", err);
      return res.status(500).json({ error: "Activation failed. See server logs." });
    }
  }
);

// ----------------------------------
// POST /admin/finance/manual-deactivate
// Deactivate a subscription immediately
// ----------------------------------
router.post(
  "/admin/finance/manual-deactivate",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { userId, note } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const parent = await User.findById(userId);
      if (!parent) return res.status(404).json({ error: "User not found" });

      await User.findByIdAndUpdate(userId, {
        subscriptionStatus:    "expired",
        subscriptionExpiresAt: new Date()
      });

      await Payment.create({
        userId:    parent._id,
        reference: `DEACTIVATE-${Date.now()}-${String(parent._id).slice(-6)}`,
        amount:    0,
        plan:      parent.subscriptionPlan || "none",
        status:    "cancelled",
        meta: {
          method:      "manual_admin_deactivate",
          activatedBy: req.user.email,
          note:        note || "Manual deactivation by admin"
        }
      });

      const parentName = [parent.firstName, parent.lastName].filter(Boolean).join(" ") || parent.email;
      console.log(`[manual-deactivate] ${parentName} deactivated by ${req.user.email}`);

      return res.json({ success: true, message: `${parentName} subscription deactivated.` });

    } catch (err) {
      console.error("[manual-deactivate] error:", err);
      return res.status(500).json({ error: "Deactivation failed." });
    }
  }
);

// ----------------------------------
// POST /admin/finance/extend
// Extend an existing active subscription by N days
// ----------------------------------
router.post(
  "/admin/finance/extend",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { userId, days, note } = req.body;
      if (!userId || !days) return res.status(400).json({ error: "userId and days are required" });

      const parent = await User.findById(userId);
      if (!parent) return res.status(404).json({ error: "User not found" });

      const now      = new Date();
      const base     = parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now
        ? new Date(parent.subscriptionExpiresAt)
        : now;
      const expiresAt = new Date(base);
      expiresAt.setDate(expiresAt.getDate() + parseInt(days));

      await User.findByIdAndUpdate(userId, { subscriptionExpiresAt: expiresAt });

      await Payment.create({
        userId:    parent._id,
        reference: `EXTEND-${Date.now()}-${String(parent._id).slice(-6)}`,
        amount:    0,
        plan:      parent.subscriptionPlan || "none",
        status:    "paid",
        paidAt:    now,
        meta: {
          method:      "manual_admin_extend",
          activatedBy: req.user.email,
          daysAdded:   parseInt(days),
          note:        note || `Extended by ${days} days by admin`
        }
      });

      const parentName = [parent.firstName, parent.lastName].filter(Boolean).join(" ") || parent.email;
      return res.json({
        success: true,
        message: `${parentName} extended by ${days} days - now expires ${expiresAt.toLocaleDateString()}`,
        expiresAt
      });

    } catch (err) {
      console.error("[extend] error:", err);
      return res.status(500).json({ error: "Extension failed." });
    }
  }
);

export default router;
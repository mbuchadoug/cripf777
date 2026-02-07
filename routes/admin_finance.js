import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import Payment from "../models/payment.js";

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
  if (!adminSet.has(email)) {
    return res.status(403).send("Admins only");
  }
  next();
}

// ----------------------------------
// GET /admin/finance
// ----------------------------------
router.get(
  "/admin/finance",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    const now = new Date();

    // ---- REVENUE STATS ----
    const allPaidPayments = await Payment.find({ status: "paid" }).lean();

    const totalRevenue = allPaidPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalPayments = allPaidPayments.length;

    // Revenue this month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthPayments = allPaidPayments.filter(p => new Date(p.paidAt) >= monthStart);
    const monthRevenue = thisMonthPayments.reduce((s, p) => s + (p.amount || 0), 0);

    // Revenue by plan
    const silverPayments = allPaidPayments.filter(p => p.plan === "silver");
    const goldPayments = allPaidPayments.filter(p => p.plan === "gold");
    const silverRevenue = silverPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const goldRevenue = goldPayments.reduce((s, p) => s + (p.amount || 0), 0);

    // ---- SUBSCRIBER STATS ----
    const allParents = await User.find({ role: "parent" }).lean();

    const activeSubscribers = allParents.filter(u =>
      u.subscriptionStatus === "paid" &&
      u.subscriptionExpiresAt &&
      new Date(u.subscriptionExpiresAt) > now
    );

    const expiredSubscribers = allParents.filter(u =>
      u.subscriptionStatus === "paid" &&
      u.subscriptionExpiresAt &&
      new Date(u.subscriptionExpiresAt) <= now
    );

    const trialUsers = allParents.filter(u => u.subscriptionStatus !== "paid");

    const activeSilver = activeSubscribers.filter(u => u.subscriptionPlan === "silver");
    const activeGold = activeSubscribers.filter(u => u.subscriptionPlan === "gold");

    // ---- EXPIRING SOON (next 7 days) ----
    const sevenDays = new Date(now);
    sevenDays.setDate(sevenDays.getDate() + 7);

    const expiringSoon = activeSubscribers.filter(u =>
      new Date(u.subscriptionExpiresAt) <= sevenDays
    );

    // ---- SUBSCRIBER LIST with child counts ----
    const subscriberList = [];

    for (const parent of [...activeSubscribers, ...expiredSubscribers]) {
      const childCount = await User.countDocuments({
        parentUserId: parent._id,
        role: "student"
      });

      const lastPayment = await Payment.findOne({
        userId: parent._id,
        status: "paid"
      }).sort({ paidAt: -1 }).lean();

      const isActive = parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now;
      const daysLeft = isActive
        ? Math.ceil((new Date(parent.subscriptionExpiresAt) - now) / (1000 * 60 * 60 * 24))
        : 0;

      subscriberList.push({
        _id: parent._id,
        name: [parent.firstName, parent.lastName].filter(Boolean).join(" ") || parent.displayName || parent.email || "Unknown",
        email: parent.email || "-",
        plan: parent.subscriptionPlan || "none",
        status: isActive ? "active" : "expired",
        childCount,
        maxChildren: parent.maxChildren || 0,
        expiresAt: parent.subscriptionExpiresAt,
        daysLeft,
        lastPaymentDate: lastPayment?.paidAt || null,
        lastPaymentAmount: lastPayment?.amount || 0
      });
    }

    // Sort: active first, then by days left ascending
    subscriberList.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return a.daysLeft - b.daysLeft;
    });

    // ---- RECENT PAYMENTS (last 20) ----
    const recentPayments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("userId", "firstName lastName email displayName")
      .lean();

    // ---- MONTHLY REVENUE CHART DATA (last 6 months) ----
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const mPayments = allPaidPayments.filter(p => {
        const d = new Date(p.paidAt);
        return d >= mStart && d < mEnd;
      });
      const mTotal = mPayments.reduce((s, p) => s + (p.amount || 0), 0);
      monthlyRevenue.push({
        label: mStart.toLocaleString("en-US", { month: "short", year: "numeric" }),
        amount: mTotal,
        count: mPayments.length
      });
    }

    res.render("admin/finance", {
      user: req.user,
      stats: {
        totalRevenue,
        totalPayments,
        monthRevenue,
        monthPaymentCount: thisMonthPayments.length,
        silverRevenue,
        goldRevenue,
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
      recentPayments,
      monthlyRevenue
    });
  }
);

export default router;
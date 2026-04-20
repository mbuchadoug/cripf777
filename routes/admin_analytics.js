// routes/admin_analytics.js
// ─────────────────────────────────────────────────────────────────────────────
// Analytics focused on what actually matters for a school/org LMS platform:
//   • Quiz activity, pass rates, completion rates
//   • Active users (real engagement, not page hits)
//   • Subscription/revenue health
//   • Platform performance (response time, errors)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import Attempt from "../models/attempt.js";
import Certificate from "../models/certificate.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import Analytics from "../models/analytics.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// ── Guard: platform admin only ────────────────────────────────────────────────
router.use(ensureAuth, (req, res, next) => {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!req.user?.email || !adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).send("Admins only");
  }
  next();
});

// ── Helper: date range from query param ──────────────────────────────────────
function getStartDate(range) {
  const now = new Date();
  switch (range) {
    case "24h": return new Date(now - 24 * 60 * 60 * 1000);
    case "7d":  return new Date(now - 7  * 24 * 60 * 60 * 1000);
    case "30d": return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case "90d": return new Date(now - 90 * 24 * 60 * 60 * 1000);
    default:    return new Date(0);
  }
}

// ── Helper: format number with commas ────────────────────────────────────────
function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

// ── Helper: percent string ────────────────────────────────────────────────────
function pct(num, denom) {
  if (!denom) return "0%";
  return Math.round((num / denom) * 100) + "%";
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin/analytics  –  Main overview dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get("/analytics", async (req, res) => {
  try {
    const range     = req.query.range || "30d";
    const startDate = getStartDate(range);
    const now       = new Date();

    // ── 1. USER STATS ──────────────────────────────────────────────────────
    const [
      totalUsers,
      newUsersInRange,
      activeUsersInRange,   // users who completed ≥1 attempt
      usersByRole
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startDate } }),
      Attempt.distinct("userId", { finishedAt: { $gte: startDate } })
        .then(ids => ids.length),
      User.aggregate([
        { $group: { _id: "$role", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    // ── 2. QUIZ / ATTEMPT STATS ─────────────────────────────────────────────
    const [
      totalAttempts,
      passedAttempts,
      uniqueLearners,
      avgScoreAgg,
      dailyAttemptsAgg,
      topQuizzesAgg,
      attemptsByOrgAgg
    ] = await Promise.all([
      Attempt.countDocuments({ finishedAt: { $gte: startDate } }),

      Attempt.countDocuments({ finishedAt: { $gte: startDate }, passed: true }),

      Attempt.distinct("userId", { finishedAt: { $gte: startDate } })
        .then(ids => ids.length),

      Attempt.aggregate([
        { $match: { finishedAt: { $gte: startDate }, percentage: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$percentage" } } }
      ]),

      // Daily attempts for chart (always last 30 days for consistency)
      Attempt.aggregate([
        {
          $match: {
            finishedAt: { $gte: new Date(now - 30 * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$finishedAt" } },
            attempts: { $sum: 1 },
            passed:   { $sum: { $cond: ["$passed", 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // Top 10 most-attempted quizzes
      Attempt.aggregate([
        { $match: { finishedAt: { $gte: startDate }, quizTitle: { $exists: true, $ne: null } } },
        {
          $group: {
            _id:        "$quizTitle",
            attempts:   { $sum: 1 },
            passed:     { $sum: { $cond: ["$passed", 1, 0] } },
            avgScore:   { $avg: "$percentage" }
          }
        },
        { $sort: { attempts: -1 } },
        { $limit: 10 }
      ]),

      // Attempts by organisation
      Attempt.aggregate([
        { $match: { finishedAt: { $gte: startDate }, organization: { $exists: true, $ne: null } } },
        { $group: { _id: "$organization", attempts: { $sum: 1 }, passed: { $sum: { $cond: ["$passed", 1, 0] } } } },
        { $sort: { attempts: -1 } },
        { $limit: 8 }
      ])
    ]);

    // Enrich org names
    const orgIds = attemptsByOrgAgg.map(o => o._id).filter(Boolean);
    const orgDocs = orgIds.length
      ? await Organization.find({ _id: { $in: orgIds } }).select("name slug").lean()
      : [];
    const orgMap = {};
    orgDocs.forEach(o => { orgMap[String(o._id)] = o; });

    const attemptsByOrg = attemptsByOrgAgg.map(o => ({
      name:     orgMap[String(o._id)]?.name || "Unknown Org",
      slug:     orgMap[String(o._id)]?.slug || "",
      attempts: o.attempts,
      passed:   o.passed,
      passRate: pct(o.passed, o.attempts)
    }));

    // ── 3. CERTIFICATE STATS ────────────────────────────────────────────────
    const [totalCerts, certsInRange] = await Promise.all([
      Certificate.countDocuments(),
      Certificate.countDocuments({ createdAt: { $gte: startDate } })
    ]);

    // ── 4. SUBSCRIPTION STATS ───────────────────────────────────────────────
    const [
      paidParents,
      paidEmployees,
      paidTeachers,
      trialParents
    ] = await Promise.all([
      User.countDocuments({ subscriptionStatus: "paid", subscriptionExpiresAt: { $gt: now } }),
      User.countDocuments({ employeeSubscriptionStatus: "paid", employeeSubscriptionExpiresAt: { $gt: now } }),
      User.countDocuments({ teacherSubscriptionStatus: "paid", teacherSubscriptionExpiresAt: { $gt: now } }),
      User.countDocuments({ role: "parent", subscriptionStatus: "trial" })
    ]);

    // ── 5. PLATFORM PERFORMANCE ─────────────────────────────────────────────
    const [avgResponseTime, totalPageViews, errorRate] = await Promise.all([
      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate }, responseTime: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$responseTime" } } }
      ]).then(r => Math.round(r[0]?.avg || 0)),

      Analytics.countDocuments({ timestamp: { $gte: startDate }, method: "GET" }),

      Analytics.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            errors: { $sum: { $cond: [{ $gte: ["$statusCode", 400] }, 1, 0] } }
          }
        }
      ]).then(r => {
        if (!r[0] || !r[0].total) return 0;
        return Math.round((r[0].errors / r[0].total) * 100);
      })
    ]);

    // ── 6. SHAPE CHART DATA ─────────────────────────────────────────────────
    // Fill in missing days so the chart has no gaps
    const chartDays = 30;
    const dailyMap = {};
    dailyAttemptsAgg.forEach(d => { dailyMap[d._id] = d; });

    const dailyChart = [];
    for (let i = chartDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyChart.push({
        date:     key,
        label:    d.toLocaleDateString("en-ZW", { month: "short", day: "numeric" }),
        attempts: dailyMap[key]?.attempts || 0,
        passed:   dailyMap[key]?.passed   || 0
      });
    }

    // ── 7. SHAPE TOP QUIZZES ────────────────────────────────────────────────
    const topQuizzes = topQuizzesAgg.map(q => ({
      title:    q._id || "Untitled",
      attempts: q.attempts,
      passRate: pct(q.passed, q.attempts),
      avgScore: Math.round(q.avgScore || 0) + "%"
    }));

    // ── 8. RECENT SIGNUPS ───────────────────────────────────────────────────
    const recentSignups = await User.find({ createdAt: { $gte: startDate } })
      .select("firstName lastName email role createdAt organization")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // ── COMPUTED HEADLINE STATS ─────────────────────────────────────────────
    const passRate      = pct(passedAttempts, totalAttempts);
    const avgScore      = Math.round(avgScoreAgg[0]?.avg || 0);
    const activePaidSubs = paidParents + paidEmployees + paidTeachers;

    res.render("admin/analytics/dashboard", {
      user: req.user,
      range,
      // Headline KPIs
      stats: {
        totalUsers:      fmt(totalUsers),
        newUsers:        fmt(newUsersInRange),
        activeUsers:     fmt(activeUsersInRange),
        totalAttempts:   fmt(totalAttempts),
        passedAttempts:  fmt(passedAttempts),
        passRate,
        avgScore:        avgScore + "%",
        totalCerts:      fmt(totalCerts),
        certsInRange:    fmt(certsInRange),
        activePaidSubs:  fmt(activePaidSubs),
        trialParents:    fmt(trialParents),
        avgResponseTime: avgResponseTime + "ms",
        totalPageViews:  fmt(totalPageViews),
        errorRate:       errorRate + "%"
      },
      // Chart data (serialised as JSON for Chart.js)
      dailyChartJson:    JSON.stringify(dailyChart),
      usersByRoleJson:   JSON.stringify(usersByRole),
      // Tables
      topQuizzes,
      attemptsByOrg,
      recentSignups,
    });

  } catch (err) {
    console.error("[Analytics] Error:", err);
    res.status(500).send("Failed to load analytics");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin/analytics/realtime  –  Live activity feed
// ─────────────────────────────────────────────────────────────────────────────
router.get("/analytics/realtime", async (req, res) => {
  try {
    const last5Min  = new Date(Date.now() - 5  * 60 * 1000);
    const last1Hour = new Date(Date.now() - 60 * 60 * 1000);

    const [activeSessionCount, recentAttempts, recentSignups, recentPageViews] = await Promise.all([
      // Sessions active in last 5 min (page visits)
      Analytics.distinct("sessionId", { timestamp: { $gte: last5Min } })
        .then(s => s.length),

      // Quizzes completed in the last hour
      Attempt.find({ finishedAt: { $gte: last1Hour } })
        .sort({ finishedAt: -1 })
        .limit(20)
        .populate("userId", "firstName lastName email role")
        .lean(),

      // New signups in the last hour
      User.find({ createdAt: { $gte: last1Hour } })
        .select("firstName lastName email role createdAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      // Raw page hits in the last 5 min
      Analytics.find({ timestamp: { $gte: last5Min } })
        .sort({ timestamp: -1 })
        .limit(30)
        .populate("userId", "firstName lastName email")
        .lean()
    ]);

    res.render("admin/analytics/realtime", {
      user: req.user,
      activeSessionCount,
      recentAttempts,
      recentSignups,
      recentPageViews
    });

  } catch (err) {
    console.error("[Analytics Realtime] Error:", err);
    res.status(500).send("Failed to load realtime analytics");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin/analytics/export  –  CSV download
// ─────────────────────────────────────────────────────────────────────────────
router.get("/analytics/export", async (req, res) => {
  try {
    const range     = req.query.range || "30d";
    const startDate = getStartDate(range);

    const attempts = await Attempt.find({ finishedAt: { $gte: startDate } })
      .populate("userId", "firstName lastName email role")
      .sort({ finishedAt: -1 })
      .limit(10000)
      .lean();

    const rows = [
      "Date,User,Email,Role,Quiz,Score,Percentage,Passed,Duration(s)"
    ];

    for (const a of attempts) {
      const u    = a.userId;
      const name = u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "Unknown";
      rows.push([
        a.finishedAt ? new Date(a.finishedAt).toISOString() : "",
        name,
        u?.email || "",
        u?.role  || "",
        (a.quizTitle || "").replace(/,/g, " "),
        a.score || 0,
        (a.percentage || 0) + "%",
        a.passed ? "Yes" : "No",
        a.duration?.totalSeconds || ""
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="quiz-activity-${range}-${Date.now()}.csv"`);
    res.send(rows.join("\n"));

  } catch (err) {
    console.error("[Analytics Export] Error:", err);
    res.status(500).send("Export failed");
  }
});

export default router;
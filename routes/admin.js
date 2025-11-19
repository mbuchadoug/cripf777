// routes/admin.js
import { Router } from "express";
import User from "../models/user.js"; // adjust path if needed
import { ensureAuth } from "../middleware/authGuard.js";
import Visit from "../models/visit.js"; // top of file with other imports




const router = Router();

console.log("🔥 admin routes loaded");
// ADMIN_EMAILS should be a comma-separated list of admin emails
// inside routes/admin.js — replace module-level ADMIN_SET with a getter
function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function ensureAdmin(req, res, next) {
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = getAdminSet(); // compute now, when env is available
  if (!email || !ADMIN_SET.has(email)) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(403).send("<h3>Forbidden — admin only</h3>");
    }
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}


/**
 * GET /admin/users
 * Query params:
 *   q - search term (name or email)
 *   page - 1-based page number (default 1)
 *   perPage - results per page (default 50, max 200)
 *   format=csv - returns CSV
 */
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(200, Math.max(10, parseInt(req.query.perPage || "50", 10)));
    const format = (req.query.format || "").toLowerCase();

    // filter: users with googleId OR provider === 'google'
    const baseFilter = {
      $or: [{ googleId: { $exists: true, $ne: null } }, { provider: "google" }],
    };

    let filter = baseFilter;
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter = {
        $and: [
          baseFilter,
          {
            $or: [{ displayName: re }, { firstName: re }, { lastName: re }, { email: re }],
          },
        ],
      };
    }

    // CSV export (no extra deps)
    if (format === "csv") {
      const docs = await User.find(filter).sort({ createdAt: -1 }).lean();
      // build CSV rows
      const header = ["id", "googleId", "name", "email", "provider", "createdAt", "lastLogin", "locale"];
      const rows = [header.join(",")];
      for (const u of docs) {
        const name = (u.displayName || `${u.firstName || ""} ${u.lastName || ""}`).trim().replace(/"/g, '""');
        const email = (u.email || "").replace(/"/g, '""');
        const googleId = (u.googleId || "").replace(/"/g, '""');
        const provider = (u.provider || "").replace(/"/g, '""');
        const createdAt = u.createdAt ? u.createdAt.toISOString() : "";
        const lastLogin = u.lastLogin ? u.lastLogin.toISOString() : "";
        const locale = (u.locale || "").replace(/"/g, '""');

        // quote fields containing comma/newline/doublequote
        const safe = [u._id, googleId, name, email, provider, createdAt, lastLogin, locale].map((v) => {
          const s = String(v ?? "");
          if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        });
        rows.push(safe.join(","));
      }

      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="google_users_${Date.now()}.csv"`);
      return res.send(csv);
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();

    // compute prev/next for view
    const pages = Math.max(1, Math.ceil(total / perPage));
    const prev = page > 1 ? page - 1 : null;
    const next = page < pages ? page + 1 : null;

    res.render("admin/users", {
      title: "Admin · Google Users",
      users,
      q,
      page,
      perPage,
      total,
      pages,
      prev,
      next,
    });
  } catch (err) {
    console.error("[admin/users] error:", err);
    res.status(500).send("Failed to load users");
  }
});

/**
 * POST /admin/users/:id/delete
 * Permanently deletes a user by _id.
 * Safety:
 * - Prevents deleting currently logged-in admin (self-delete).
 * - Logs action server-side.
 */
router.post("/users/:id/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send("Missing user id");

    // Prevent admin from deleting themselves
    const currentUserId = req.user && req.user._id && String(req.user._id);
    if (currentUserId && currentUserId === String(id)) {
      // send friendly message on HTML requests, otherwise JSON
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("<h3>Cannot delete current admin user</h3>");
      }
      return res.status(400).json({ error: "Cannot delete current admin user" });
    }

    // find the user for logging before delete
    const userToDelete = await User.findById(id).lean();
    if (!userToDelete) {
      return res.status(404).send("User not found");
    }

    // perform deletion
    await User.deleteOne({ _id: id });

    console.log(`[admin] user deleted id=${id} email=${userToDelete.email} by admin=${req.user && req.user.email}`);

    // redirect back to users list preserving query params if present
    const referer = req.get("referer") || "/admin/users";
    return res.redirect(referer);
  } catch (err) {
    console.error("[admin/users/:id/delete] error:", err);
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete user");
    }
    return res.status(500).json({ error: "Failed to delete user" });
  }
});


router.get("/visits", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "day"); // day|month|year
    const days = parseInt(req.query.days || "30", 10);

    let groupId;
    let dateFormat;
    if (period === "month") {
      groupId = "$month";
      dateFormat = { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
    } else if (period === "year") {
      groupId = "$year";
      dateFormat = { $dateToString: { format: "%Y", date: "$createdAt" } };
    } else {
      // default day
      dateFormat = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    }

    // Use stored day/month/year fields for fast grouping (we have day/month/year in doc)
    const pipeline = [];
    if (period === "year") {
      pipeline.push({
        $group: {
          _id: "$year",
          hits: { $sum: "$hits" },
        },
      });
    } else if (period === "month") {
      pipeline.push({
        $group: {
          _id: "$month",
          hits: { $sum: "$hits" },
        },
      });
    } else {
      pipeline.push({
        $group: {
          _id: "$day",
          hits: { $sum: "$hits" },
        },
      });
      pipeline.push({ $sort: { _id: -1 } });
      pipeline.push({ $limit: days });
    }

    // run aggregation
    const stats = await Visit.aggregate(pipeline);

    // format results sorted ascending by date (so charts look right)
    stats.sort((a, b) => (a._id > b._id ? 1 : -1));

    // If HTML requested, render; else return JSON
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      res.render("admin/visits", {
        title: "Admin · Site visits",
        stats,
        period,
      });
    } else {
      res.json({ period, stats });
    }
  } catch (err) {
    console.error("[admin/visits] error:", err);
    res.status(500).send("Failed to fetch visits");
  }
});

export default router;

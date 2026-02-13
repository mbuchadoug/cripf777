// middleware/parentAccess.js
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";

const HOME_ORG_SLUG = "cripfcnt-home";

export async function canActAsParent(req, res, next) {
  try {
    if (!req.user?._id) {
      return res.status(401).send("Not logged in");
    }

    // ✅ Platform admins can always view parent dashboard
    const platformAdmin = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .includes(String(req.user.email || "").toLowerCase());

    if (platformAdmin || req.user.role === "super_admin") {
      return next();
    }

    // ✅ Must be enrolled in cripfcnt-home as parent/guardian
    const homeOrg = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
    if (!homeOrg) {
      return res.status(500).send("Home org not configured");
    }

    const membership = await OrgMembership.findOne({
      org: homeOrg._id,
      user: req.user._id
    }).lean();

    const role = String(membership?.role || "").toLowerCase();

    if (membership && (role === "parent" || role === "guardian")) {
      // Optional: expose it for views
      res.locals.parentMembership = membership;
      return next();
    }

    return res.status(403).send("Parent access denied (not enrolled in cripfcnt-home)");
  } catch (err) {
    console.error("[canActAsParent] error:", err);
    return res.status(500).send("Parent access check failed");
  }
}

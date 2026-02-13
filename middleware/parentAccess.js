// middleware/parentAccess.js
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import User from "../models/user.js";

const HOME_ORG_SLUG = "cripfcnt-home";

/**
 * Allow users to act as parent IF:
 *  - They are logged in
 *  - They are one of: parent/admin/employee/org_admin/super_admin
 * AND:
 *  - They are enrolled in cripfcnt-home
 *
 * ✅ If not enrolled, auto-enroll them on first visit (this is "if they wish").
 */
export async function canActAsParent(req, res, next) {
  try {
    if (!req.user) return res.status(401).send("Not logged in");

    const allowedRoles = ["parent", "admin", "employee", "org_admin", "super_admin"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).send("Parent access denied");
    }

    const homeOrg = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
    if (!homeOrg) {
      return res.status(500).send("Home organization not found");
    }

    const existing = await OrgMembership.findOne({
      org: homeOrg._id,
      user: req.user._id
    }).lean();

    // ✅ Already enrolled => ok
    if (existing) return next();

    // ✅ Not enrolled => auto-enroll on demand
    await OrgMembership.create({
      org: homeOrg._id,
      user: req.user._id,
      role: "parent",
      joinedAt: new Date()
    });

    // ✅ Enable consumer mode without changing system role
    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          consumerEnabled: true,
          // Only set accountType if empty (don’t overwrite)
          ...(req.user.accountType ? {} : { accountType: "parent" })
        }
      }
    );

    return next();
  } catch (err) {
    console.error("[canActAsParent] error:", err);
    return res.status(500).send("Parent access check failed");
  }
}

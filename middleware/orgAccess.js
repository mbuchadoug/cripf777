import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";

/**
 * Allow:
 * - Platform admin (ADMIN_EMAILS)
 * - OR org admin / manager of the requested org
 */
export async function allowPlatformAdminOrOrgManager(req, res, next) {
  try {
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    // ✅ Platform admin
    if (req.user?.email && adminEmails.includes(req.user.email.toLowerCase())) {
      return next();
    }

    // ❌ Must have org slug
    const slug = String(req.params.slug || "").trim();
    if (!slug) {
      return res.status(400).send("Organization not specified");
    }

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("Organization not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id
    }).lean();

    if (!membership) {
      return res.status(403).send("Not a member of this organization");
    }

    const role = String(membership.role || "").toLowerCase();
    if (["admin", "manager", "org_admin"].includes(role)) {
      return next();
    }

    return res.status(403).send("Admins only");
  } catch (err) {
    console.error("[allowPlatformAdminOrOrgManager]", err);
    return res.status(500).send("Server error");
  }
}

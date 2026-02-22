import jwt from "jsonwebtoken";
import WebSession from "../models/webSession.js";
import UserRole from "../models/userRole.js";
import Business from "../models/business.js";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";

/**
 * Require web authentication
 */
export async function requireWebAuth(req, res, next) {
  try {
    const token = req.cookies.web_token;
    
    if (!token) {
      return res.redirect("/web/login?error=auth_required");
    }
    
    // Verify JWT
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check session exists
    const session = await WebSession.findOne({ userId: decoded.userId });
    
    if (!session) {
      res.clearCookie("web_token");
      return res.redirect("/web/login?error=session_expired");
    }
    
    // Update last activity
    session.lastActivity = new Date();
    await session.save();
    
    // Get user and business
    const [user, business] = await Promise.all([
      UserRole.findById(decoded.userId).populate("branchId"),
      Business.findById(decoded.businessId)
    ]);
    
    if (!user || !business) {
      res.clearCookie("web_token");
      return res.redirect("/web/login?error=account_not_found");
    }
    
    // Attach to request
    req.webUser = {
      id: user._id,
      phone: user.phone,
      role: user.role,
      branchId: user.branchId?._id,
      branchName: user.branchId?.name,
      businessId: business._id,
      businessName: business.name,
      currency: business.currency,
      package: business.package,
      logoUrl: business.logoUrl
    };
    
    next();
  } catch (error) {
    console.error("Web auth error:", error);
    res.clearCookie("web_token");
    res.redirect("/web/login?error=invalid_token");
  }
}

/**
 * Check user role
 */
export function requireWebRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.webUser) {
      return res.redirect("/web/login");
    }
    
    if (!allowedRoles.includes(req.webUser.role)) {
      return res.status(403).render("web/error", {
        layout: "web",
        title: "Access Denied",
        message: "You don't have permission to access this page.",
        user: req.webUser
      });
    }
    
    next();
  };
}
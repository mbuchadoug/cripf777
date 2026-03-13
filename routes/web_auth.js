import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import OTPCode from "../models/otpCode.js";
import UserRole from "../models/userRole.js";
import Business from "../models/business.js";
import WebSession from "../models/webSession.js";

dotenv.config();
import twilio from "twilio";

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Too many OTP requests. Try again later."
});

const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials not configured.");
  }
  return twilio(accountSid, authToken);
}

/**
 * GET /web/login
 * ── layout: false ── the login.hbs is a complete standalone HTML page.
 *    Passing layout: "web" was injecting the sidebar. Never use layout here.
 */
router.get("/login", (req, res) => {
  if (req.cookies.web_token) {
    return res.redirect("/web/dashboard");
  }

  // ✅ layout: false - login page is self-contained HTML, no sidebar
  res.render("web/login", {
    layout: false,
    title: "Sign In - ZimQuote",
    error: req.query.error
  });
});

/**
 * GET /web/verify-otp
 * ── layout: false ── same reason, standalone auth page
 */
router.get("/verify-otp", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.redirect("/web/login");

  res.render("web/otp-verify", {
    layout: false,
    title: "Verify - ZimQuote",
    phone,
    error: req.query.error
  });
});

/**
 * POST /web/auth/request-otp
 */
router.post("/auth/request-otp", otpLimiter, async (req, res) => {
  try {
    let { phone } = req.body;

    if (!phone) return res.status(400).json({ error: "Phone number required" });

    phone = phone.replace(/\D+/g, "");
    if (phone.startsWith("0")) phone = "263" + phone.slice(1);

    if (!phone.startsWith("263") || phone.length !== 12) {
      return res.status(400).json({ error: "Invalid phone number format. Use 0772123456" });
    }

    const userRole = await UserRole.findOne({ phone, pending: false });

    if (!userRole) {
      return res.status(404).json({
        error: "Account not found",
        message: "Please create an account via WhatsApp first. Send 'menu' to our WhatsApp number."
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await OTPCode.deleteMany({ phone, verified: false });
    await OTPCode.create({
      phone,
      code,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });

    const message = `Your ZimQuote login code is: ${code}. Valid for 5 minutes. Do not share this code.`;

    try {
      const twilioClient = getTwilioClient();
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      if (!fromNumber) throw new Error("TWILIO_PHONE_NUMBER not configured in .env");

      await twilioClient.messages.create({
        from: fromNumber,
        to: `+${phone}`,
        body: message
      });
    } catch (twilioError) {
      console.error("❌ Twilio SMS error:", twilioError);
      await OTPCode.deleteMany({ phone, code });
      return res.status(500).json({
        error: "Failed to send OTP. Please try again.",
        details: process.env.NODE_ENV === "development" ? twilioError.message : undefined
      });
    }

    res.json({
      success: true,
      message: "OTP sent to your phone via SMS",
      phone: phone.slice(-4)
    });

  } catch (error) {
    console.error("Request OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

/**
 * POST /web/auth/verify-otp
 */
router.post("/auth/verify-otp", async (req, res) => {
  try {
    let { phone, code } = req.body;

    if (!phone || !code) return res.status(400).json({ error: "Phone and code required" });

    phone = phone.replace(/\D+/g, "");
    if (phone.startsWith("0")) phone = "263" + phone.slice(1);

    const otp = await OTPCode.findOne({
      phone,
      code,
      verified: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otp) {
      await OTPCode.updateMany({ phone, verified: false }, { $inc: { attempts: 1 } });
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    if (otp.attempts >= 3) {
      await OTPCode.deleteMany({ phone, verified: false });
      return res.status(429).json({ error: "Too many failed attempts. Request a new code." });
    }

    otp.verified = true;
    await otp.save();

    const userRole = await UserRole.findOne({ phone, pending: false });
    if (!userRole) return res.status(404).json({ error: "User not found" });

    const business = await Business.findById(userRole.businessId);
    if (!business) return res.status(404).json({ error: "Business not found" });

    const token = jwt.sign(
      {
        userId: userRole._id.toString(),
        businessId: business._id.toString(),
        phone: userRole.phone,
        role: userRole.role
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    await WebSession.create({
      userId: userRole._id,
      businessId: business._id,
      phone: userRole.phone,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"]
    });

    res.cookie("web_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "lax"
    });

    res.json({ success: true, redirectUrl: "/web/dashboard" });

  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

/**
 * GET /web/logout
 */
router.get("/logout", async (req, res) => {
  try {
    const token = req.cookies.web_token;
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      await WebSession.deleteMany({ userId: decoded.userId });
    }
    res.clearCookie("web_token");
    res.redirect("/web/login");
  } catch (error) {
    console.error("Logout error:", error);
    res.redirect("/web/login");
  }
});


/**
 * GET /web/admin-login
 * Super-admin impersonation login
 */
router.get("/admin-login", (req, res) => {
  const token = req.cookies.web_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.isSuperAdmin) return res.redirect("/web/dashboard");
    } catch (_) {}
  }
  res.render("web/admin-login", {
    layout: false,
    title: "Admin Access - ZimQuote",
    error: req.query.error
  });
});

/**
 * POST /web/admin-auth/impersonate
 * Super-admin signs in as any business by phone number
 */
router.post("/admin-auth/impersonate", async (req, res) => {
  try {
    const { phone: rawPhone, masterPassword } = req.body;

    // Verify master password
    const MASTER_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
    if (!MASTER_PASSWORD || masterPassword !== MASTER_PASSWORD) {
      return res.status(401).json({ error: "Invalid master password." });
    }

    // Normalize phone
    let phone = (rawPhone || "").replace(/\D+/g, "");
    if (phone.startsWith("0")) phone = "263" + phone.slice(1);
    if (!phone.startsWith("263") || phone.length !== 12) {
      return res.status(400).json({ error: "Invalid phone number format. Use 0772123456" });
    }

    // Find the business owner by phone
    const userRole = await UserRole.findOne({ phone, role: "owner", pending: false });
    if (!userRole) {
      return res.status(404).json({ error: "No business owner found for this number." });
    }

    const business = await Business.findById(userRole.businessId);
    if (!business) {
      return res.status(404).json({ error: "Business not found for this account." });
    }

    // Issue a JWT flagged as super-admin impersonation
    const token = jwt.sign(
      {
        userId: userRole._id.toString(),
        businessId: business._id.toString(),
        phone: userRole.phone,
        role: userRole.role,
        isSuperAdmin: true,           // ✅ flag for impersonation banner
        impersonating: phone          // ✅ track which business
      },
      JWT_SECRET,
      { expiresIn: "8h" }            // shorter session for security
    );

    res.cookie("web_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: "lax"
    });

    res.json({ success: true, redirectUrl: "/web/dashboard" });

  } catch (error) {
    console.error("Admin impersonate error:", error);
    res.status(500).json({ error: "Server error during impersonation." });
  }
});


/**
 * GET /web/admin-logout
 * Clears the super-admin impersonation session
 */
router.get("/admin-logout", (req, res) => {
  res.clearCookie("web_token");
  res.redirect("/web/admin-login");
});

export default router;
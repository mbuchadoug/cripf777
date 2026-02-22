import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import OTPCode from "../models/otpCode.js";
import UserRole from "../models/userRole.js";
import Business from "../models/business.js";
import WebSession from "../models/webSession.js";

dotenv.config();
// ✅ FIX: Import twilio function, initialize client INSIDE route handlers
import twilio from "twilio";

const router = express.Router();

// Rate limiter for OTP requests
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  message: "Too many OTP requests. Try again later."
});

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";

dotenv.config();

// ✅ HELPER FUNCTION: Get Twilio Client
function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials not configured. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env");
  }
  
  return twilio(accountSid, authToken);
}

/**
 * GET /web/login
 * Show login page
 */
router.get("/login", (req, res) => {
  // If already logged in, redirect to dashboard
  if (req.cookies.web_token) {
    return res.redirect("/web/dashboard");
  }
  
  res.render("web/login", {
    layout: "web",
    title: "Login - ZimQuote",
    error: req.query.error
  });
});

/**
 * POST /web/auth/request-otp
 * Send OTP to user's phone via SMS
 */
router.post("/auth/request-otp", otpLimiter, async (req, res) => {
  try {
    let { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }
    
    // Normalize phone
    phone = phone.replace(/\D+/g, "");
    if (phone.startsWith("0")) {
      phone = "263" + phone.slice(1);
    }
    
    if (!phone.startsWith("263") || phone.length !== 12) {
      return res.status(400).json({ error: "Invalid phone number format. Use 0772123456" });
    }
    
    // Check if user exists
    const userRole = await UserRole.findOne({
      phone,
      pending: false
    });
    
    if (!userRole) {
      return res.status(404).json({
        error: "Account not found",
        message: "Please create an account via WhatsApp first. Send 'menu' to our WhatsApp number."
      });
    }
    
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Delete old OTPs for this phone
    await OTPCode.deleteMany({ phone, verified: false });
    
    // Create new OTP (valid for 5 minutes)
    await OTPCode.create({
      phone,
      code,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    
    // ✅ SEND VIA SMS (NOT WhatsApp)
    const message = `Your ZimQuote login code is: ${code}. Valid for 5 minutes. Do not share this code.`;
    
    try {
      // ✅ Initialize Twilio client
      const twilioClient = getTwilioClient();
      
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      
      if (!fromNumber) {
        throw new Error("TWILIO_PHONE_NUMBER not configured in .env");
      }
      
      console.log("📤 Sending SMS OTP to:", phone);
      console.log("📞 From number:", fromNumber);
      
      // ✅ REGULAR SMS (no "whatsapp:" prefix)
      await twilioClient.messages.create({
        from: fromNumber,  // ← NO "whatsapp:" prefix
        to: `+${phone}`,   // ← Add + for international format
        body: message
      });
      
      console.log("✅ SMS sent successfully");
      
    } catch (twilioError) {
      console.error("❌ Twilio SMS error:", twilioError);
      await OTPCode.deleteMany({ phone, code }); // Clean up failed OTP
      return res.status(500).json({ 
        error: "Failed to send OTP. Please try again.",
        details: process.env.NODE_ENV === 'development' ? twilioError.message : undefined
      });
    }
    
    res.json({
      success: true,
      message: "OTP sent to your phone via SMS",
      phone: phone.slice(-4) // Show last 4 digits only
    });
    
  } catch (error) {
    console.error("Request OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

/**
 * GET /web/verify-otp
 * Show OTP verification page
 */
router.get("/verify-otp", (req, res) => {
  const { phone } = req.query;
  
  if (!phone) {
    return res.redirect("/web/login");
  }
  
  res.render("web/otp-verify", {
    layout: "web",
    title: "Verify OTP - ZimQuote",
    phone,
    error: req.query.error
  });
});

/**
 * POST /web/auth/verify-otp
 * Verify OTP and create session
 */
router.post("/auth/verify-otp", async (req, res) => {
  try {
    let { phone, code } = req.body;
    
    if (!phone || !code) {
      return res.status(400).json({ error: "Phone and code required" });
    }
    
    // Normalize phone
    phone = phone.replace(/\D+/g, "");
    if (phone.startsWith("0")) {
      phone = "263" + phone.slice(1);
    }
    
    // Find valid OTP
    const otp = await OTPCode.findOne({
      phone,
      code,
      verified: false,
      expiresAt: { $gt: new Date() }
    });
    
    if (!otp) {
      // Increment failed attempts
      await OTPCode.updateMany(
        { phone, verified: false },
        { $inc: { attempts: 1 } }
      );
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    
    // Check max attempts (prevent brute force)
    if (otp.attempts >= 3) {
      await OTPCode.deleteMany({ phone, verified: false });
      return res.status(429).json({ error: "Too many failed attempts. Request a new code." });
    }
    
    // Mark as verified
    otp.verified = true;
    await otp.save();
    
    // Get user and business
    const userRole = await UserRole.findOne({
      phone,
      pending: false
    });
    
    if (!userRole) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const business = await Business.findById(userRole.businessId);
    
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    
    // Generate JWT
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
    
    // Create web session
    await WebSession.create({
      userId: userRole._id,
      businessId: business._id,
      phone: userRole.phone,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"]
    });
    
    // Set HTTP-only cookie
    res.cookie("web_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: "lax"
    });
    
    res.json({
      success: true,
      redirectUrl: "/web/dashboard"
    });
    
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

/**
 * GET /web/logout
 * Logout user
 */
router.get("/logout", async (req, res) => {
  try {
    const token = req.cookies.web_token;
    
    if (token) {
      // Delete session
      const decoded = jwt.verify(token, JWT_SECRET);
      await WebSession.deleteMany({ userId: decoded.userId });
    }
    
    // Clear cookie
    res.clearCookie("web_token");
    
    res.redirect("/web/login");
  } catch (error) {
    console.error("Logout error:", error);
    res.redirect("/web/login");
  }
});

export default router;
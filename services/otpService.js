import OTPCode from "../models/otpCode.js";
import twilio from "twilio";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Generate and send OTP via WhatsApp
 */
export async function sendOTP(phone) {
  // Generate 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  
  // Delete old OTPs for this phone
  await OTPCode.deleteMany({ phone, verified: false });
  
  // Create new OTP (valid for 5 minutes)
  const otp = await OTPCode.create({
    phone,
    code,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000)
  });
  
  // Send via WhatsApp
  const message = `🔐 Your ZimQuote login code is: *${code}*\n\nValid for 5 minutes. Do not share this code.`;
  
  try {
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      body: message
    });
    
    return { success: true, expiresIn: 300 }; // 5 minutes
  } catch (error) {
    console.error("OTP send failed:", error);
    await OTPCode.deleteOne({ _id: otp._id });
    return { success: false, error: "Failed to send OTP" };
  }
}

/**
 * Verify OTP code
 */
export async function verifyOTP(phone, code) {
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
    return { success: false, error: "Invalid or expired code" };
  }
  
  // Mark as verified
  otp.verified = true;
  await otp.save();
  
  return { success: true };
}
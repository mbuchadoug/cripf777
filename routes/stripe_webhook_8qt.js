// routes/stripe_webhook_8qt.js
// Extends the existing stripe_webhook.js with 8QT certificate handling.
// In your main stripe_webhook.js, import and call handle8QTCertificate(session)
// inside the "checkout.session.completed" handler.

import EightQTAttempt from "../models/eightQTAttempt.js";
import EightQTCertPurchase from "../models/eightQTCertPurchase.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";
import EightQTArchetype from "../models/eightQTArchetype.js";
import User from "../models/user.js";
import nodemailer from "nodemailer";
import { generateEightQTCertPdf } from "../services/eightQTCertPdf.js";

/**
 * Handle 8QT certificate purchase webhook event.
 * Called from the main stripe_webhook.js when meta.type === "8qt_certificate"
 *
 * @param {Object} session - Stripe checkout.session object
 */
export async function handle8QTCertificate(session) {
  const meta = session.metadata || {};

  if (meta.type !== "8qt_certificate") return;

  const { attemptId, participantCode, userId, tier } = meta;

  if (!attemptId) {
    console.error("[8qt webhook] Missing attemptId in metadata");
    return;
  }

  // ── Idempotency guard ──────────────────────────────────────
  const existingPurchase = await EightQTCertPurchase.findOne({
    stripeSessionId: session.id
  });
  if (existingPurchase) {
    console.log(`[8qt webhook] Duplicate ignored: ${session.id}`);
    return;
  }

  // ── Record purchase ────────────────────────────────────────
  await EightQTCertPurchase.create({
    attemptId,
    userId: userId || null,
    participantCode: participantCode || null,
    stripeSessionId: session.id,
    amountPaid: session.amount_total || 0,
    currency: session.currency || "usd",
    tier: tier || "standard",
    status: "complete",
    paidAt: new Date()
  });

  console.log(`[8qt webhook] Purchase recorded for attempt ${attemptId}`);

  // ── Load attempt ───────────────────────────────────────────
  const attempt = await EightQTAttempt.findById(attemptId);
  if (!attempt) {
    console.error(`[8qt webhook] Attempt not found: ${attemptId}`);
    return;
  }

  // Update status
  attempt.certificateStatus = "paid";
  await attempt.save();

  // ── Generate PDF ───────────────────────────────────────────
  try {
    const template = await EightQTCertTemplate.findOne({ active: true }).lean();
    let archetype = null;
    if (attempt.archetypeId) {
      archetype = await EightQTArchetype.findById(attempt.archetypeId).lean();
    }

    const { url, verifyCode } = await generateEightQTCertPdf({
      attempt: attempt.toObject(),
      template,
      archetype
    });

    attempt.certificatePdfUrl = url;
    attempt.certificateVerifyCode = verifyCode;
    attempt.certificateStatus = "issued";
    attempt.certificateIssuedAt = new Date();
    await attempt.save();

    console.log(`[8qt webhook] ✅ Certificate generated: ${url}`);

    // ── Send email ─────────────────────────────────────────
    const recipientEmail = attempt.certificateEmail ||
      (userId ? (await User.findById(userId).lean())?.email : null);

    if (recipientEmail) {
      await sendCertificateEmail({
        to: recipientEmail,
        participantName: attempt.certificateName || attempt.participantName || "Participant",
        archetypeName: attempt.archetypeName || "CRIPFCnt Thinker",
        verifyCode,
        pdfUrl: url,
        tier
      });
      console.log(`[8qt webhook] ✅ Certificate email sent to ${recipientEmail}`);
    }

  } catch (err) {
    console.error("[8qt webhook] PDF/email error:", err.message);
    // Don't re-throw — webhook must return 200 to Stripe
    // The attempt is already marked "paid" so admin can manually re-trigger
  }
}

// ── Email helper ──────────────────────────────────────────────────

async function sendCertificateEmail({ to, participantName, archetypeName, verifyCode, pdfUrl, tier }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const siteUrl = process.env.SITE_URL || "https://cripfcnt.com";
  const verifyUrl = `${siteUrl}/8qt/verify/${verifyCode}`;
  const downloadUrl = pdfUrl.startsWith("http") ? pdfUrl : `${siteUrl}${pdfUrl}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{font-family:'Georgia',serif;background:#f8f9fa;margin:0;padding:20px}
  .container{max-width:600px;margin:0 auto;background:#fff;padding:40px;
    border:1px solid #e9ecef;border-radius:8px}
  h1{color:#1E3A5F;font-size:26px;margin-bottom:4px}
  .gold{color:#C9A961}
  .btn{display:inline-block;background:#1E3A5F;color:#fff;padding:14px 28px;
    border-radius:4px;text-decoration:none;font-family:'Inter',sans-serif;
    font-weight:600;font-size:15px;margin:12px 8px 12px 0}
  .btn-gold{background:#C9A961;color:#0F1C2E}
  p{color:#495057;line-height:1.7;font-size:15px}
  .verify{background:#f8f9fa;padding:16px;border-radius:4px;margin:20px 0;
    font-family:monospace;font-size:18px;letter-spacing:3px;color:#1E3A5F;
    text-align:center;font-weight:bold}
  .footer{margin-top:32px;padding-top:20px;border-top:1px solid #e9ecef;
    font-size:12px;color:#6c757d;font-family:sans-serif}
</style>
</head>
<body>
<div class="container">
  <h1>Your CRIPFCnt Certificate</h1>
  <p class="gold" style="font-size:18px;margin-top:4px">${archetypeName}</p>
  <p>Dear ${participantName},</p>
  <p>
    Your CRIPFCnt 8 Quotients Assessment certificate has been issued.
    This document maps your profile across the eight dimensions of Placement Intelligence
    as developed by Donald Mataranyika.
  </p>
  <a href="${downloadUrl}" class="btn btn-gold">Download Certificate (PDF)</a>
  <a href="${verifyUrl}" class="btn">Verify Online</a>

  <p style="margin-top:24px">Your unique verification code:</p>
  <div class="verify">${verifyCode}</div>
  <p>
    Anyone can verify the authenticity of your certificate at:<br>
    <a href="${verifyUrl}" style="color:#1E3A5F">${verifyUrl}</a>
  </p>
  <p>
    To revisit your full results, return to:<br>
    <a href="${siteUrl}/8qt" style="color:#1E3A5F">cripfcnt.com/8qt</a>
    and enter your participant code if you registered anonymously.
  </p>
  <div class="footer">
    CRIPFCnt &mdash; Recalibrating Intelligence &amp; Society<br>
    This certificate was issued for a completed 8 Quotients Assessment.
    It represents a mapping of orientation, not a graded academic result.
  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from: `"CRIPFCnt" <${process.env.SMTP_USER}>`,
    to,
    subject: `Your CRIPFCnt 8 Quotients Certificate — ${archetypeName}`,
    html
  });
}

// ── Integration snippet for stripe_webhook.js ─────────────────────
// In your existing stripe_webhook.js, inside the checkout.session.completed handler,
// add this after your existing type checks:
//
//   import { handle8QTCertificate } from "./stripe_webhook_8qt.js";
//
//   if (meta.type === "8qt_certificate") {
//     await handle8QTCertificate(session);
//   }

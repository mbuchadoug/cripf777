// routes/stripe_webhook_8qt.js
// Handles 8QT certificate generation using the existing CRIPFCnt green certificate template.
// Called from stripe_webhook.js when meta.type === "8qt_certificate"

import EightQTAttempt from "../models/eightQTAttempt.js";
import EightQTCertPurchase from "../models/eightQTCertPurchase.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";
import EightQTArchetype from "../models/eightQTArchetype.js";
import User from "../models/user.js";
import nodemailer from "nodemailer";
// ── Use the existing CRIPFCnt green certificate template ──────
import { generateEightQTCertPdf } from "../services/eightQTCertPdf.js";

/**
 * Main handler - called from stripe_webhook.js when meta.type === "8qt_certificate"
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
  }).lean();

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

  attempt.certificateStatus = "paid";
  await attempt.save();

  // ── Generate PDF using green CRIPFCnt template ─────────────
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

    // ── Send delivery email ─────────────────────────────────
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
      console.log(`[8qt webhook] ✅ Email sent to ${recipientEmail}`);
    }

  } catch (err) {
    console.error("[8qt webhook] PDF/email error:", err.message);
    // Don't re-throw - webhook must return 200 to Stripe
    // attempt remains "paid" so admin can regenerate via panel
  }
}

// ── Email delivery ─────────────────────────────────────────────

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

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{font-family:Georgia,serif;background:#f8f9fa;margin:0;padding:20px}
  .container{max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #e9ecef;border-radius:8px}
  h1{color:#0B4F45;font-size:26px;margin-bottom:4px}
  .green{color:#1DE9B6}
  .btn{display:inline-block;background:#0B4F45;color:#fff;padding:14px 28px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;font-size:15px;margin:12px 8px 12px 0}
  .btn-green{background:#1DE9B6;color:#0B4F45}
  p{color:#495057;line-height:1.7;font-size:15px}
  .verify{background:#f8f9fa;padding:16px;border-radius:4px;margin:20px 0;font-family:monospace;font-size:18px;letter-spacing:3px;color:#0B4F45;text-align:center;font-weight:bold}
  .footer{margin-top:32px;padding-top:20px;border-top:1px solid #e9ecef;font-size:12px;color:#6c757d;font-family:sans-serif}
</style>
</head>
<body>
<div class="container">
  <h1>Your CRIPFCnt Certificate</h1>
  <p class="green" style="font-size:18px;margin-top:4px">${archetypeName}</p>
  <p>Dear ${participantName},</p>
  <p>Your CRIPFCnt 8 Quotients Assessment certificate has been issued. Download it using the button below.</p>
  <a href="${downloadUrl}" class="btn btn-green">⬇ Download Certificate (PDF)</a>
  <a href="${verifyUrl}" class="btn">Verify Online</a>
  <p style="margin-top:24px">Your unique verification code:</p>
  <div class="verify">${verifyCode}</div>
  <p>Verify at: <a href="${verifyUrl}" style="color:#0B4F45">${verifyUrl}</a></p>
  <div class="footer">
    CRIPFCnt &mdash; Recalibrating Intelligence &amp; Society<br>
    This certificate represents a mapping of placement intelligence orientation.
  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from: `"CRIPFCnt" <${process.env.SMTP_USER}>`,
    to,
    subject: `Your CRIPFCnt 8 Quotients Certificate - ${archetypeName}`,
    html
  });
}
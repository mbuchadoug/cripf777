// services/mobileMailer.js
// One small mailer, reusing the SMTP_* env you already use in org_management.js.
// Nothing here is app-specific - the web can use it too.

import nodemailer from "nodemailer";

let cached = null;

function buildTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";

  if (!host || !user || !pass) {
    console.warn("[mailer] SMTP env incomplete (need SMTP_HOST, SMTP_USER, SMTP_PASS)");
    return null;
  }
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

function getTransporter() {
  if (cached) return cached;
  cached = buildTransporter();
  return cached;
}

const FROM =
  process.env.MAIL_FROM ||
  `CRIPFCnt <${process.env.SMTP_USER || "no-reply@cripfcnt.com"}>`;

/**
 * Send a 6-digit verification code. Returns true if it was sent.
 * If SMTP is not configured, returns false so the caller can decide what to do
 * (in dev we surface the code instead of failing).
 */
export async function sendVerificationCode(email, code, purpose = "verify your email") {
  const t = getTransporter();
  if (!t) return false;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:440px;margin:0 auto;background:#04231F;border-radius:16px;overflow:hidden">
    <div style="padding:26px 28px 14px">
      <div style="color:#1DE9B6;font-weight:700;font-size:18px;letter-spacing:1px">CRIP<span style="color:#fff">F</span>Cnt</div>
    </div>
    <div style="padding:8px 28px 30px;color:#F5F2EA">
      <p style="font-size:15px;line-height:1.6;color:#B9C7C2;margin:0 0 18px">
        Use this code to ${purpose} in the CRIPFCnt app. It expires in 10 minutes.
      </p>
      <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#1DE9B6;background:rgba(29,233,182,0.10);border:1px solid rgba(29,233,182,0.30);border-radius:12px;padding:18px;text-align:center">
        ${code}
      </div>
      <p style="font-size:12.5px;line-height:1.6;color:#7E908B;margin:20px 0 0">
        If you didn't request this, you can ignore this email.
      </p>
    </div>
  </div>`;

  await t.sendMail({
    from: FROM,
    to: email,
    subject: `${code} is your CRIPFCnt code`,
    text: `Your CRIPFCnt verification code is ${code}. It expires in 10 minutes.`,
    html
  });
  return true;
}

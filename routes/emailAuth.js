// routes/emailAuth.js
//
// Email-first web login for parents (and any account that has an email).
//
//   1. Enter email  -> we check it exists in our database
//   2a. If it has a password -> log in with the password
//   2b. Or "email me a code" -> 6-digit code -> logged in
//   3. First code login with no password -> set one for next time
//   4. Forgot password -> email -> code -> set a new password -> logged in
//
// Reuses the SAME verification model + mailer the mobile app uses
// (models/mobileVerification.js, services/mobileMailer.js), so a code is a code
// across web and mobile. Codes are hashed, expire in 10 min (TTL on the model),
// and are attempt-limited.
//
// Mount in server.js, right after the existing auth routes:
//     import emailAuthRoutes from "./routes/emailAuth.js";
//     app.use("/auth", emailAuthRoutes);
//
// Then the parent login page is:  https://cripfcnt.com/auth/login

import { Router } from "express";
import rateLimit from "express-rate-limit";
import User from "../models/user.js";
import MobileVerification from "../models/mobileVerification.js";
import { sendVerificationCode } from "../services/mobileMailer.js";

const router = Router();

const MAX_CODE_ATTEMPTS = 5;

/* Where a signed-in account should land, by role. */
function dashboardFor(user) {
  if (!user) return "/auth/login";
  if (user.role === "private_teacher") return "/teacher/dashboard";
  if (user.role === "student") return "/student/dashboard";
  if (["employee", "org_admin", "super_admin", "readonly_admin"].includes(user.role)) {
    return "/dashboard";
  }
  return "/parent/dashboard";
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/* Throttle code sends so the endpoint can't be used to spam inboxes. */
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many code requests. Try again in a few minutes." }
});

/* ──────────────────────────────────────────────────────────────
   PAGE: the parent login screen
   ────────────────────────────────────────────────────────────── */
router.get("/login", (req, res) => {
  if (req.user) return res.redirect(dashboardFor(req.user));
  res.render("auth/parent_login", { layout: false });
});

/* ──────────────────────────────────────────────────────────────
   STEP 1: does this email exist, and does it have a password?
   The product intentionally tells the user whether the email is known,
   so they get a clear "no account" message instead of a silent dead end.
   ────────────────────────────────────────────────────────────── */
router.post("/email/check", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });

    const user = await User.findOne({ email }).select("_id passwordHash role").lean();
    if (!user) return res.json({ exists: false });

    return res.json({ exists: true, hasPassword: !!user.passwordHash });
  } catch (err) {
    console.error("[emailAuth/check]", err);
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

/* ──────────────────────────────────────────────────────────────
   STEP 2b / 4: send a 6-digit code.
   purpose "signin"       -> passwordless login
   purpose "set_password" -> forgot / reset password
   ────────────────────────────────────────────────────────────── */
router.post("/email/request-code", codeLimiter, async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const purpose = req.body.purpose === "set_password" ? "set_password" : "signin";
    if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });

    const user = await User.findOne({ email }).select("_id").lean();
    if (!user) return res.status(404).json({ error: "No account uses that email." });

    const code = MobileVerification.generateCode();
    await MobileVerification.deleteMany({ email, purpose });
    await MobileVerification.create({
      email,
      codeHash: MobileVerification.hashCode(code),
      purpose
    });

    const sent = await sendVerificationCode(
      email,
      code,
      purpose === "set_password" ? "reset your password" : "sign in to your account"
    );

    // If SMTP isn't configured (dev), surface the code so testing isn't blocked.
    return res.json({ sent: true, ...(sent ? {} : { devCode: code }) });
  } catch (err) {
    console.error("[emailAuth/request-code]", err);
    return res.status(500).json({ error: "Could not send a code. Try again." });
  }
});

/* Shared: validate a code for a purpose. Returns { ok, user } or { error, status }. */
async function consumeCode({ email, code, purpose }) {
  const rec = await MobileVerification.findOne({ email, purpose, consumed: false }).sort({ createdAt: -1 });
  if (!rec) return { error: "That code has expired. Request a new one.", status: 400 };

  if (rec.attempts >= MAX_CODE_ATTEMPTS) {
    await rec.deleteOne();
    return { error: "Too many wrong attempts. Request a new code.", status: 429 };
  }

  if (rec.codeHash !== MobileVerification.hashCode(String(code).trim())) {
    rec.attempts += 1;
    await rec.save();
    return { error: "That code is not right.", status: 401 };
  }

  rec.consumed = true;
  await rec.save();

  const user = await User.findOne({ email });
  if (!user) return { error: "Account not found.", status: 404 };
  return { ok: true, user };
}

/* ──────────────────────────────────────────────────────────────
   STEP 2b: verify a sign-in code -> start the session
   ────────────────────────────────────────────────────────────── */
router.post("/email/verify-code", async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const result = await consumeCode({ email, code: req.body.code, purpose: "signin" });
    if (result.error) return res.status(result.status).json({ error: result.error });

    const user = result.user;
    user.lastLogin = new Date();
    await user.save();

    req.login(user, (err) => {
      if (err) return next(err);
      return res.json({
        ok: true,
        redirect: dashboardFor(user),
        needsPassword: !user.passwordHash // prompt them to set one for next time
      });
    });
  } catch (err) {
    console.error("[emailAuth/verify-code]", err);
    return res.status(500).json({ error: "Could not sign you in. Try again." });
  }
});

/* ──────────────────────────────────────────────────────────────
   STEP 2a: password login
   ────────────────────────────────────────────────────────────── */
router.post("/email/login-password", async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!isEmail(email) || !password) {
      return res.status(400).json({ error: "Enter your email and password." });
    }

    const user = await User.findOne({ email });
    // Same message whether the email is unknown or the password is wrong.
    if (!user || !user.passwordHash || !(await user.verifyPassword(password))) {
      return res.status(401).json({ error: "Wrong email or password." });
    }

    user.lastLogin = new Date();
    await user.save();

    req.login(user, (err) => {
      if (err) return next(err);
      return res.json({ ok: true, redirect: dashboardFor(user) });
    });
  } catch (err) {
    console.error("[emailAuth/login-password]", err);
    return res.status(500).json({ error: "Could not sign you in. Try again." });
  }
});

/* ──────────────────────────────────────────────────────────────
   STEP 3: set a password for next time (must be signed in)
   ────────────────────────────────────────────────────────────── */
router.post("/email/set-password", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Please sign in first." });
    const password = String(req.body.password || "");
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters." });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "Account not found." });

    await user.setPassword(password); // hashes + clears needsPasswordSetup
    await user.save();

    return res.json({ ok: true, redirect: dashboardFor(user) });
  } catch (err) {
    console.error("[emailAuth/set-password]", err);
    return res.status(500).json({ error: "Could not save your password. Try again." });
  }
});

/* ──────────────────────────────────────────────────────────────
   STEP 4: forgot password -> email + code + new password -> logged in
   ────────────────────────────────────────────────────────────── */
router.post("/email/reset-password", async (req, res, next) => {
  try {
    const email = normEmail(req.body.email);
    const password = String(req.body.password || "");
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters." });

    const result = await consumeCode({ email, code: req.body.code, purpose: "set_password" });
    if (result.error) return res.status(result.status).json({ error: result.error });

    const user = result.user;
    await user.setPassword(password);
    user.lastLogin = new Date();
    await user.save();

    req.login(user, (err) => {
      if (err) return next(err);
      return res.json({ ok: true, redirect: dashboardFor(user) });
    });
  } catch (err) {
    console.error("[emailAuth/reset-password]", err);
    return res.status(500).json({ error: "Could not reset your password. Try again." });
  }
});

export default router;
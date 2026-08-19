// routes/mobileApi.js
//
// The JSON surface the mobile app talks to. Purely additive - it does not touch
// any existing Handlebars route, session flow or Passport strategy. It REUSES
// the existing /auth/google flow rather than duplicating OAuth.
//
// Mount in server.js (see the diff notes in the README):
//    import mobileApiRouter, { mobileGoogleReturn } from "./routes/mobileApi.js";
//    app.use("/api/mobile", mobileApiRouter);
//    // and one line inside the existing /auth/google/callback handler
//
// Requires:  npm i jsonwebtoken
// Add to .env:
//    MOBILE_JWT_SECRET=<a long random string>
//    MOBILE_APP_SCHEME=cripfcnt      (optional, defaults to cripfcnt)

import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import mongoose from "mongoose";

import User from "../models/user.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import MobileAuthCode from "../models/mobileAuthCode.js";
import MobileVerification from "../models/mobileVerification.js";
import { sendVerificationCode } from "../services/mobileMailer.js";
import EightQTQuestion from "../models/eightQTQuestion.js";
import EightQTQuiz from "../models/eightQTQuiz.js";
import EightQTAttempt from "../models/eightQTAttempt.js";
import ExamInstance from "../models/examInstance.js";

const router = Router();

const SECRET = process.env.MOBILE_JWT_SECRET || "change-me-in-env";
const TOKEN_TTL = "180d"; // long-lived on purpose: the app is offline-first
const APP_SCHEME = process.env.MOBILE_APP_SCHEME || "cripfcnt";

/* ────────────────────── token helpers ────────────────────── */

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, SECRET, {
    expiresIn: TOKEN_TTL
  });
}

// A compact, app-safe view of a user. One place, so login/refresh/exchange
// never drift apart.
function publicUser(u) {
  return {
    _id: u._id,
    role: u.role,
    displayName: u.displayName,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    username: u.username,
    grade: u.grade,
    accountType: u.accountType,
    subscriptionStatus: u.subscriptionStatus,
    subscriptionPlan: u.subscriptionPlan,
    teacherSubscriptionPlan: u.teacherSubscriptionPlan,
    employeeSubscriptionPlan: u.employeeSubscriptionPlan,
    maxChildren: u.maxChildren,
    needsPasswordSetup: u.needsPasswordSetup
  };
}

export async function requireMobileAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const payload = jwt.verify(token, SECRET);
    const user = await User.findById(payload.sub).lean();
    if (!user) return res.status(401).json({ error: "Account not found" });

    req.mobileUser = user;
    return next();
  } catch {
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
}

async function optionalMobileAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, SECRET);
      req.mobileUser = await User.findById(payload.sub).lean();
    }
  } catch {
    req.mobileUser = null;
  }
  return next();
}

/* ══════════════════════════════════════════════════════════════════
   GOOGLE HANDSHAKE
   The app cannot do OAuth itself, so it borrows the browser + your
   existing /auth/google flow, and gets a one-time code back at the end.

   Flow:
     1. app opens:  /api/mobile/auth/google/start?intent=parent
     2. we stash intent + a marker in the session, then 302 to /auth/google
     3. your UNCHANGED passport flow runs (account, role, org enrolment)
     4. at the end of /auth/google/callback, mobileGoogleReturn() sees the
        marker, mints a one-time code, and 302s to  cripfcnt://auth?code=...
     5. the app catches that deep link and calls /api/mobile/auth/google/exchange
   ════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/mobile/auth/google/start?intent=parent|private_teacher|signin
 * The single entry point the app opens in a browser.
 */
router.get("/auth/google/start", (req, res) => {
  const intent = String(req.query.intent || "signin");

  if (req.session) {
    // Tells the callback this login came from the app.
    req.session.mobileFlow = true;
    // Drives role assignment in passport.js exactly like the web buttons do.
    if (intent === "parent") req.session.signupSource = "parent";
    else if (intent === "private_teacher") req.session.signupSource = "private_teacher";
    // "signin" leaves signupSource unset → existing role is preserved.

    return req.session.save(() => res.redirect("/auth/google"));
  }
  return res.redirect("/auth/google");
});

/**
 * Called from inside the existing /auth/google/callback, right before it would
 * redirect to a dashboard. Returns true if it handled a mobile redirect, so the
 * web flow is completely unaffected for browser users.
 *
 * In routes/auth.js, at the very top of the callback's try block:
 *
 *    import { mobileGoogleReturn } from "./mobileApi.js";
 *    ...
 *    if (req.session?.mobileFlow) {
 *      const handled = await mobileGoogleReturn(req, res);
 *      if (handled) return;
 *    }
 */
export async function mobileGoogleReturn(req, res) {
  try {
    if (!req.user) return false;

    // one-time code, opaque and short-lived (TTL index on the model)
    const code = crypto.randomBytes(32).toString("hex");
    await MobileAuthCode.create({ code, user: req.user._id });

    // clear the markers so a later browser login on the same session is normal
    try {
      delete req.session.mobileFlow;
      delete req.session.signupSource;
    } catch {}

    // Log the app out of the web session - the app uses its token, not a cookie.
    return req.logout(() => {
      res.redirect(`${APP_SCHEME}://auth?code=${code}`);
    });
  } catch (err) {
    console.error("[mobileGoogleReturn]", err);
    res.redirect(`${APP_SCHEME}://auth?error=server`);
    return true;
  }
}

/**
 * POST /api/mobile/auth/google/exchange  { code }
 * The app trades its one-time code for a real token + profile.
 */
router.post("/auth/google/exchange", async (req, res) => {
  try {
    const code = String(req.body?.code || "");
    if (!code) return res.status(400).json({ error: "Missing code" });

    const record = await MobileAuthCode.findOne({ code });
    if (!record || record.usedAt) {
      return res.status(401).json({ error: "This sign-in link has expired. Try again." });
    }

    // burn it immediately - single use
    record.usedAt = new Date();
    await record.save();

    const user = await User.findById(record.user);
    if (!user) return res.status(401).json({ error: "Account not found" });

    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error("[mobile google/exchange]", err);
    return res.status(500).json({ error: "Sign-in failed. Try again." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   REGISTER - username + password sign-up, no Google or email required.
   The user picks ONE role; we generate a username and issue a token.
   Same endpoint powers the app AND a web sign-up page.
   ════════════════════════════════════════════════════════════════════ */

// Roles a person may self-select at sign-up. Admin roles are never self-served.
const SELF_SIGNUP_ROLES = new Set(["parent", "private_teacher", "student"]);

// Enrol a freshly created user into the right org, mirroring passport.js so
// the app and web behave identically.
async function enrolNewUser(user) {
  try {
    const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
    if ((user.role === "parent" || user.role === "private_teacher") && homeOrg) {
      const exists = await OrgMembership.findOne({ org: homeOrg._id, user: user._id });
      if (!exists) {
        await OrgMembership.create({
          org: homeOrg._id,
          user: user._id,
          role: user.role === "private_teacher" ? "private_teacher" : "parent",
          joinedAt: new Date()
        });
      }
    }
    // Students belong to the home org too (a parent links them later via parentUserId).
    if (user.role === "student" && homeOrg) {
      const exists = await OrgMembership.findOne({ org: homeOrg._id, user: user._id });
      if (!exists) {
        await OrgMembership.create({
          org: homeOrg._id,
          user: user._id,
          role: "student",
          joinedAt: new Date()
        });
      }
    }
  } catch (err) {
    console.error("[mobile register] enrol failed (non-fatal):", err.message);
  }
}

// Actually create the account. Shared by the verified-email path and the
// no-email path so account creation lives in exactly one place.
async function createAccount({ role, firstName, lastName, password, email }) {
  const username = await User.createUniqueUsername(firstName, lastName);
  const user = new User({
    role,
    firstName,
    lastName,
    displayName: [firstName, lastName].filter(Boolean).join(" ") || username,
    username,
    email: email || undefined,
    provider: "password",
    consumerEnabled: role === "parent" || role === "private_teacher",
    accountType: role === "parent" ? "parent" : role === "student" ? "student_self" : undefined,
    lastLogin: new Date()
  });
  await user.setPassword(password);
  if (role === "private_teacher") {
    user.teacherSubscriptionStatus = "trial";
    user.teacherSubscriptionPlan = "none";
    user.aiQuizCredits = 0;
    user.needsProfileSetup = true;
  }
  await user.save();
  await enrolNewUser(user);
  return user;
}

function validateSignup({ role, firstName, password }) {
  if (!SELF_SIGNUP_ROLES.has(role)) return "Choose Parent, Private teacher or Student.";
  if (!firstName) return "Enter your first name.";
  if (String(password).length < 6) return "Use a password of at least 6 characters.";
  return null;
}

/**
 * POST /api/mobile/auth/register/start
 * Body: { role, firstName, lastName, password, email }
 *
 * If an email is given: we DON'T create the account yet. We stash the details,
 * email a 6-digit code, and wait for /register/verify. This proves the email is
 * real and lets them sign in with email+password on any device afterwards.
 *
 * If NO email is given: there is nothing to verify, so we create the account
 * immediately and return the token + generated username.
 */
router.post("/auth/register/start", async (req, res) => {
  try {
    const role = String(req.body?.role || "").trim();
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const password = String(req.body?.password || "");
    const email = String(req.body?.email || "").trim().toLowerCase();

    // ── Resend path: re-send a code for an in-flight signup. ──
    if (req.body?.resend && email) {
      const pendingRec = await MobileVerification.findOne({ email, purpose: "signup" });
      if (!pendingRec) {
        return res.status(410).json({ error: "Your sign-up session expired. Start again." });
      }
      const newCode = MobileVerification.generateCode();
      pendingRec.codeHash = MobileVerification.hashCode(newCode);
      pendingRec.attempts = 0;
      pendingRec.createdAt = new Date(); // resets the 10-min TTL window
      await pendingRec.save();
      const wasSent = await sendVerificationCode(email, newCode, "confirm your email");
      return res.json({ verified: false, needsCode: true, email, ...(wasSent ? {} : { devCode: newCode }) });
    }

    const problem = validateSignup({ role, firstName, password });
    if (problem) return res.status(400).json({ error: problem });

    // ── No email → create straight away, no verification needed. ──
    if (!email) {
      const user = await createAccount({ role, firstName, lastName, password, email: null });
      return res.json({
        verified: true,
        token: signToken(user),
        user: publicUser(user),
        username: user.username
      });
    }

    // ── Email given → it must be free, then send a code. ──
    const clash = await User.findOne({ email }).lean();
    if (clash) {
      return res.status(409).json({
        code: "EMAIL_TAKEN",
        error: "An account already uses that email. Try signing in instead."
      });
    }

    const code = MobileVerification.generateCode();

    // Replace any earlier pending code for this email.
    await MobileVerification.deleteMany({ email, purpose: "signup" });
    await MobileVerification.create({
      email,
      purpose: "signup",
      codeHash: MobileVerification.hashCode(code),
      pending: { role, firstName, lastName, password } // password used once, then discarded
    });

    const sent = await sendVerificationCode(email, code, "confirm your email");

    // In production the code only goes by email. If SMTP isn't configured we
    // return it so you're never blocked in testing - remove devCode for launch.
    return res.json({
      verified: false,
      needsCode: true,
      email,
      ...(sent ? {} : { devCode: code, devNote: "SMTP not configured; code returned for testing." })
    });
  } catch (err) {
    console.error("[mobile register/start]", err);
    return res.status(500).json({ error: "Could not start sign-up. Try again." });
  }
});

/**
 * POST /api/mobile/auth/register/verify
 * Body: { email, code }
 * Confirms the code, creates the account, returns token + username.
 */
router.post("/auth/register/verify", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    if (!email || !code) return res.status(400).json({ error: "Enter the 6-digit code." });

    const rec = await MobileVerification.findOne({ email, purpose: "signup", consumed: false });
    if (!rec) {
      return res.status(410).json({ error: "That code has expired. Start again." });
    }
    if (rec.attempts >= 5) {
      await MobileVerification.deleteOne({ _id: rec._id });
      return res.status(429).json({ error: "Too many tries. Start again." });
    }

    if (rec.codeHash !== MobileVerification.hashCode(code)) {
      rec.attempts += 1;
      await rec.save();
      return res.status(401).json({ error: "That code is not right." });
    }

    // Guard against a race where the email got taken meanwhile.
    const clash = await User.findOne({ email }).lean();
    if (clash) {
      await MobileVerification.deleteOne({ _id: rec._id });
      return res.status(409).json({ code: "EMAIL_TAKEN", error: "That email is now in use. Sign in instead." });
    }

    const p = rec.pending || {};
    const user = await createAccount({
      role: p.role,
      firstName: p.firstName,
      lastName: p.lastName,
      password: p.password,
      email
    });

    rec.consumed = true;
    await MobileVerification.deleteOne({ _id: rec._id });

    return res.json({
      verified: true,
      token: signToken(user),
      user: publicUser(user),
      username: user.username
    });
  } catch (err) {
    console.error("[mobile register/verify]", err);
    return res.status(500).json({ error: "Could not confirm the code. Try again." });
  }
});

/**
 * POST /api/mobile/auth/password/start
 * Body: { email }
 * For EXISTING accounts (e.g. Google users) that have no password yet - sends a
 * code so they can set one in-app and sign in with email+password afterwards.
 */
router.post("/auth/password/start", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Enter your email." });

    const user = await User.findOne({ email });
    // Always answer the same way so we don't reveal which emails exist.
    if (!user) {
      return res.json({ needsCode: true, email });
    }

    const code = MobileVerification.generateCode();
    await MobileVerification.deleteMany({ email, purpose: "set_password" });
    await MobileVerification.create({
      email,
      purpose: "set_password",
      codeHash: MobileVerification.hashCode(code)
    });

    const sent = await sendVerificationCode(email, code, "set your password");
    return res.json({
      needsCode: true,
      email,
      ...(sent ? {} : { devCode: code, devNote: "SMTP not configured; code returned for testing." })
    });
  } catch (err) {
    console.error("[mobile password/start]", err);
    return res.status(500).json({ error: "Could not start. Try again." });
  }
});

/**
 * POST /api/mobile/auth/password/verify
 * Body: { email, code, password }
 * Confirms the code and sets the new password, then signs them in.
 */
router.post("/auth/password/verify", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    if (!email || !code) return res.status(400).json({ error: "Enter the 6-digit code." });
    if (password.length < 6) return res.status(400).json({ error: "Use a password of at least 6 characters." });

    const rec = await MobileVerification.findOne({ email, purpose: "set_password", consumed: false });
    if (!rec) return res.status(410).json({ error: "That code has expired. Start again." });
    if (rec.attempts >= 5) {
      await MobileVerification.deleteOne({ _id: rec._id });
      return res.status(429).json({ error: "Too many tries. Start again." });
    }
    if (rec.codeHash !== MobileVerification.hashCode(code)) {
      rec.attempts += 1;
      await rec.save();
      return res.status(401).json({ error: "That code is not right." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      await MobileVerification.deleteOne({ _id: rec._id });
      return res.status(404).json({ error: "No account uses that email." });
    }

    await user.setPassword(password);
    user.lastLogin = new Date();
    await user.save();
    await MobileVerification.deleteOne({ _id: rec._id });

    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error("[mobile password/verify]", err);
    return res.status(500).json({ error: "Could not set your password. Try again." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   PASSWORD LOGIN
   For accounts that have set a password via your existing /auth/set-password.
   Matches the same identifiers as /auth/school.
   ════════════════════════════════════════════════════════════════════ */

router.post("/auth/login", async (req, res) => {
  try {
    const raw = String(req.body?.identifier || "").trim();
    const identifier = raw.toLowerCase();
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({ error: "Enter your details to continue." });
    }

    // email is stored lowercase; the ID fields are case-sensitive, so try both.
    const user = await User.findOne({
      $or: [
        { email: identifier },
        { username: identifier },
        { studentId: raw },
        { teacherId: raw },
        { adminId: raw }
      ]
    });

    if (!user) {
      return res.status(401).json({ error: "No account matches those details." });
    }

    if (!user.passwordHash) {
      // Account exists but has no password (e.g. created via Google). Offer to
      // set one by email code - only works if we can reach them by email.
      return res.status(409).json({
        code: "SET_PASSWORD",
        email: user.email || null,
        error: user.email
          ? "This account has no password yet. Set one to sign in here."
          : "This account uses Google. Continue with Google, or add an email on the website first."
      });
    }

    const ok = await user.verifyPassword(password);
    if (!ok) return res.status(401).json({ error: "That password is not right." });

    user.lastLogin = new Date();
    await user.save();

    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error("[mobile auth/login]", err);
    return res.status(500).json({ error: "Sign-in failed. Try again." });
  }
});

/** GET /api/mobile/auth/me - refresh the cached profile when online. */
router.get("/auth/me", requireMobileAuth, async (req, res) => {
  return res.json({ user: publicUser(req.mobileUser) });
});

/* ══════════════════════════════════════════════════════════════════
   SYNC - everything the device needs to work offline.
   Works with or without a token; anonymous callers get public 8QT only.
   ════════════════════════════════════════════════════════════════════ */

router.get("/sync", optionalMobileAuth, async (req, res) => {
  try {
    const lang = ["en", "sn"].includes(req.query.lang) ? req.query.lang : "en";
    const since = req.query.since ? new Date(req.query.since) : null;

    const questionFilter = { lang, active: true };
    if (since && !isNaN(since.getTime())) {
      questionFilter.updatedAt = { $gt: since };
    }

    const questions = await EightQTQuestion.find(questionFilter)
      .select("quotient lang text options active updatedAt")
      .lean();

    const quiz = await EightQTQuiz.findOne({ lang, isDefault: true, active: true })
      .select(
        "title slug lang mode size drawStrategy shuffleQuestions shuffleOptions description isDefault"
      )
      .lean();

    const payload = { questions, quiz, lang, serverTime: new Date().toISOString() };

    const user = req.mobileUser;
    if (user) {
      payload.ownerId = String(user._id);

      if (["parent", "private_teacher", "teacher"].includes(user.role)) {
        const children = await User.find({ parentUserId: user._id, role: "student" })
          .select("displayName firstName lastName grade role")
          .lean();

        const learners = [];
        for (const c of children) {
          const total = await ExamInstance.countDocuments({ userId: c._id });
          const done = await ExamInstance.countDocuments({ userId: c._id, status: "finished" });
          const active = await ExamInstance.findOne({
            userId: c._id,
            status: { $in: ["pending", "started"] }
          })
            .select("quizTitle title module")
            .lean();

          learners.push({
            _id: c._id,
            displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" "),
            firstName: c.firstName,
            lastName: c.lastName,
            grade: c.grade,
            role: c.role,
            progressPct: total > 0 ? Math.round((done / total) * 100) : 0,
            currentModule: active?.quizTitle || active?.title || active?.module || null
          });
        }
        payload.learners = learners;
      }

      if (["employee", "org_admin", "super_admin", "readonly_admin"].includes(user.role)) {
        const exams = await ExamInstance.find({ userId: user._id })
          .select("module title quizTitle status")
          .lean();

        const byModule = {};
        for (const e of exams) {
          const key = e.module || "general";
          if (!byModule[key]) byModule[key] = { total: 0, done: 0, title: e.quizTitle || e.title };
          byModule[key].total++;
          if (e.status === "finished") byModule[key].done++;
        }

        payload.modules = Object.keys(byModule).map((k, i) => ({
          _id: `mod-${k}`,
          code: k.slice(0, 3).toUpperCase(),
          title: byModule[k].title || k,
          summary: "",
          orderIndex: i,
          lessonCount: byModule[k].total,
          progressPct: byModule[k].total > 0 ? Math.round((byModule[k].done / byModule[k].total) * 100) : 0
        }));
      }
    }

    return res.json(payload);
  } catch (err) {
    console.error("[mobile sync]", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   8QT ATTEMPT INGESTION - idempotent on localId.
   ════════════════════════════════════════════════════════════════════ */

router.post("/8qt/attempts", optionalMobileAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.localId) return res.status(400).json({ error: "localId is required" });

    const existing = await EightQTAttempt.findOne({
      participantCode: `local:${b.localId}`
    }).lean();

    if (existing) {
      return res.json({ ok: true, attemptId: existing._id, duplicate: true });
    }

    const questionIds = (b.questionIds || []).filter((id) => mongoose.isValidObjectId(id));

    const answers = (b.answers || []).map((a) => ({
      questionId: mongoose.isValidObjectId(a.questionId) ? a.questionId : undefined,
      quotient: a.quotient,
      selectedIndex: a.selectedIndex,
      scores: a.scores || {}
    }));

    const doc = await EightQTAttempt.create({
      userId: req.mobileUser?._id || b.userId || null,
      participantCode: `local:${b.localId}`,
      participantName: b.participantName || "",
      status: "finished",
      quizTitle: b.quizTitle || "The 8 Quotients Test",
      questionIds,
      answers,
      quotientScores: b.quotientScores || [],
      quotientMax: b.quotientMax || null,
      dominantQuotient: b.dominantQuotient || null,
      developmentEdge: b.developmentEdge || null,
      archetypeName: b.archetypeName || null,
      startedAt: b.startedAt ? new Date(b.startedAt) : null,
      finishedAt: b.finishedAt ? new Date(b.finishedAt) : new Date(),
      attemptIp: req.ip,
      referrer: "mobile-app"
    });

    return res.json({ ok: true, attemptId: doc._id });
  } catch (err) {
    console.error("[mobile attempts]", err);
    return res.status(500).json({ error: "Could not save attempt" });
  }
});

router.post("/8qt/certificate-request", requireMobileAuth, async (req, res) => {
  try {
    const { attemptLocalId, name, email } = req.body || {};
    if (!attemptLocalId) return res.status(400).json({ error: "attemptLocalId is required" });

    const attempt = await EightQTAttempt.findOne({
      participantCode: `local:${attemptLocalId}`
    });
    if (!attempt) return res.status(404).json({ error: "Attempt not found. Sync it first." });

    attempt.certificateStatus = "requested";
    attempt.certificateRequestedAt = new Date();
    attempt.certificateName = name || req.mobileUser.displayName || "";
    attempt.certificateEmail = email || req.mobileUser.email || "";
    await attempt.save();

    return res.json({ ok: true, attemptId: attempt._id });
  } catch (err) {
    console.error("[mobile certificate-request]", err);
    return res.status(500).json({ error: "Could not record the request" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   DELETE ACCOUNT - App Store Guideline 5.1.1(v).
   An app that lets people create accounts must let them delete the account
   from inside the app. This is a HARD delete of the account and everything it
   owns - not a deactivation.

   For a parent / private teacher this also removes every managed learner
   profile they created and all of that learner's progress: those profiles have
   no existence independent of the account being deleted.

   The JWT is stateless, but it dies the moment the User document is gone -
   requireMobileAuth does User.findById and 401s once the account no longer
   exists, so there is nothing extra to revoke.
   ════════════════════════════════════════════════════════════════════ */

router.post("/auth/delete", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser; // lean doc from requireMobileAuth
    const myId = me._id;

    // Soft guard against an accidental call. The app only sends confirm:true
    // after the user confirms an explicit, irreversible "delete account" prompt.
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "Deletion was not confirmed." });
    }

    // Managed learners this account created (parent / teacher only). They are
    // removed together with their owner.
    const childIds = ["parent", "private_teacher", "teacher"].includes(me.role)
      ? (
          await User.find({ parentUserId: myId, role: "student" })
            .select("_id")
            .lean()
        ).map((c) => c._id)
      : [];

    const allUserIds = [myId, ...childIds];

    // 1) Every collection keyed by userId (owner + any managed learners).
    //    No Mongo transaction: single-node deployments have no replica set, so
    //    a session would throw. Deletes are ordered so the User docs go LAST -
    //    if anything fails midway the account still exists and can retry.
    await EightQTAttempt.deleteMany({ userId: { $in: allUserIds } });
    await ExamInstance.deleteMany({ userId: { $in: allUserIds } });
    await OrgMembership.deleteMany({ user: { $in: allUserIds } });
    await MobileAuthCode.deleteMany({ user: { $in: allUserIds } });

    // Attempt + Payment belong to the school router's model set. Import lazily
    // so this route has no hard dependency on them, and never fails if a model
    // path differs in a given deployment.
    try {
      const { default: Attempt } = await import("../models/attempt.js");
      await Attempt.deleteMany({ userId: { $in: allUserIds } });
    } catch (e) {
      console.warn("[mobile auth/delete] attempt cleanup skipped:", e.message);
    }
    try {
      const { default: Payment } = await import("../models/payment.js");
      await Payment.deleteMany({ userId: { $in: allUserIds } });
    } catch (e) {
      console.warn("[mobile auth/delete] payment cleanup skipped:", e.message);
    }

    // Best-effort: topic-mastery records if that model exists. Different
    // deployments key it differently, so try the common shapes and move on.
    try {
      const { default: TopicMastery } = await import("../models/topicMastery.js");
      if (TopicMastery) {
        await TopicMastery.deleteMany({
          $or: [{ userId: { $in: allUserIds } }, { student: { $in: allUserIds } }]
        });
      }
    } catch (e) {
      // model absent or different shape - non-fatal
    }

    // 2) Any pending email verification codes tied to this email.
    if (me.email) {
      await MobileVerification.deleteMany({ email: me.email }).catch(() => {});
    }

    // 3) Remove the user documents themselves - learners first, owner last.
    if (childIds.length) {
      await User.deleteMany({ _id: { $in: childIds } });
    }
    await User.deleteOne({ _id: myId });

    return res.json({ ok: true, deletedAccounts: allUserIds.length });
  } catch (err) {
    console.error("[mobile auth/delete]", err);
    return res.status(500).json({ error: "Could not delete the account. Try again." });
  }
});

export default router;s
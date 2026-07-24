// routes/mobileApi.js
//
// The JSON surface the mobile app talks to. Purely additive — it does not touch
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
import MobileAuthCode from "../models/mobileAuthCode.js";
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

    // Log the app out of the web session — the app uses its token, not a cookie.
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

    // burn it immediately — single use
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
      return res.status(409).json({
        code: "USE_GOOGLE",
        error: "This account uses Google sign-in. Tap “Continue with Google”."
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

/** GET /api/mobile/auth/me — refresh the cached profile when online. */
router.get("/auth/me", requireMobileAuth, async (req, res) => {
  return res.json({ user: publicUser(req.mobileUser) });
});

/* ══════════════════════════════════════════════════════════════════
   SYNC — everything the device needs to work offline.
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
   8QT ATTEMPT INGESTION — idempotent on localId.
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

export default router;
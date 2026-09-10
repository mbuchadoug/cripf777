// services/enrollmentService.js
// ─────────────────────────────────────────────────────────────────────────────
// Enrollment state machine + access checks + progress "stage" computation.
// Pure functions (unit-tested) are separated from DB helpers.
// ─────────────────────────────────────────────────────────────────────────────
import Enrollment from "../models/enrollment.js";
import Course from "../models/course.js";
import CourseProgress from "../models/courseProgress.js";

// ── PURE: given a course's units + a learner's per-quiz pass map, work out the
// stage they're on, level, completion %, and attempts. Units == stages.
// passedByQuiz: { quizIdStr: { passed:Bool, bestPercentage:Num, attempts:Num } }
export function computeStages(course, passedByQuiz = {}) {
  const units = course.units || [];
  const stages = units.map((u, i) => {
    const ids = (u.quizIds || []).map(String);
    const passed = ids.filter(id => passedByQuiz[id]?.passed).length;
    const attempts = ids.reduce((n, id) => n + (passedByQuiz[id]?.attempts || 0), 0);
    const complete = ids.length > 0 && passed === ids.length;
    return {
      index: i + 1, title: u.title, total: ids.length, passed, attempts, complete,
      pct: ids.length ? Math.round((passed / ids.length) * 100) : 0
    };
  });
  const totalStages = stages.length;
  const stagesComplete = stages.filter(s => s.complete).length;
  // current stage = first incomplete stage, or the last if all done
  let currentStage = stages.findIndex(s => !s.complete) + 1;
  if (currentStage === 0) currentStage = totalStages; // all complete
  const allIds = units.flatMap(u => (u.quizIds || []).map(String));
  const passedTotal = allIds.filter(id => passedByQuiz[id]?.passed).length;
  const totalQuizzes = allIds.length;
  const completionPct = totalQuizzes ? Math.round((passedTotal / totalQuizzes) * 100) : 0;
  return {
    stages, totalStages, stagesComplete,
    currentStage: totalStages ? currentStage : 0,
    passedTotal, totalQuizzes, completionPct,
    totalAttempts: stages.reduce((n, s) => n + s.attempts, 0)
  };
}

// ── PURE: decide what an enrollment request should do for a given course ─────
// Returns an intent the route acts on. No DB.
export function enrollmentIntent(course, existing) {
  if (existing && (existing.status === "active" || existing.status === "completed")) {
    return { action: "already_active" };
  }
  if (existing && existing.status === "suspended") {
    return { action: "blocked", reason: "suspended" };
  }
  const type = course.accessType || "free";
  if (type === "invite") return { action: "needs_admin", access: "invite" };
  if (type === "free") return { action: "activate", access: "free" };
  // paid
  return { action: "needs_payment", access: "paid", price: course.price || 0, currency: course.currency || "USD" };
}

// ── DB: get or create an enrollment and apply the intent ─────────────────────
export async function enroll({ userId, course, source = "self" }) {
  let e = await Enrollment.findOne({ user: userId, course: course._id });
  const intent = enrollmentIntent(course, e);

  if (!e) {
    e = new Enrollment({
      user: userId, course: course._id, org: course.org,
      access: course.accessType || "free", source
    });
  }

  if (intent.action === "activate") {
    e.status = "active"; e.activatedAt = new Date();
    e.payment.status = "none";
    await e.save();
    return { enrollment: e, intent };
  }
  if (intent.action === "needs_payment") {
    e.status = "pending"; e.access = "paid";
    e.payment.amount = course.price || 0; e.payment.currency = course.currency || "USD";
    e.payment.status = "pending";
    await e.save();
    return { enrollment: e, intent };
  }
  if (intent.action === "needs_admin") {
    e.status = "pending"; e.access = "invite";
    await e.save();
    return { enrollment: e, intent };
  }
  return { enrollment: e, intent }; // already_active / blocked
}

// ── DB: admin (or payment success) activates an enrollment ───────────────────
export async function activateEnrollment({ enrollmentId, adminId = null, provider = "manual", reference = null }) {
  const e = await Enrollment.findById(enrollmentId);
  if (!e) return null;
  e.status = "active";
  e.activatedAt = new Date();
  if (adminId) { e.activatedBy = adminId; e.source = "admin"; }
  if (provider) {
    e.payment.provider = provider;
    if (provider !== "manual") { e.payment.status = "paid"; e.payment.paidAt = new Date(); e.source = "payment"; }
    if (reference) e.payment.reference = reference;
  }
  await e.save();
  return e;
}

export async function activateByPaymentRef({ reference, provider }) {
  const e = await Enrollment.findOne({ "payment.reference": reference });
  if (!e) return null;
  if (e.status === "active" || e.status === "completed") return e; // idempotent
  e.status = "active"; e.activatedAt = new Date();
  e.payment.provider = provider; e.payment.status = "paid"; e.payment.paidAt = new Date();
  e.source = "payment";
  await e.save();
  return e;
}

export async function suspendEnrollment({ enrollmentId, adminId = null }) {
  const e = await Enrollment.findById(enrollmentId);
  if (!e) return null;
  e.status = "suspended"; e.suspendedAt = new Date(); if (adminId) e.activatedBy = adminId;
  await e.save();
  return e;
}

// ── DB: can this user access this course right now? ──────────────────────────
export async function canAccessCourse({ user, courseId }) {
  if (!user) return { ok: false, reason: "auth" };
  if (["org_admin", "super_admin"].includes(user.role)) return { ok: true, admin: true };
  const e = await Enrollment.findOne({ user: user._id, course: courseId }).lean();
  if (!e) return { ok: false, reason: "not_enrolled" };
  if (e.status === "active" || e.status === "completed") return { ok: true, enrollment: e };
  return { ok: false, reason: e.status, enrollment: e };
}

// ── DB: mark completed (called when a certificate is issued) ─────────────────
export async function markEnrollmentCompleted({ userId, courseId }) {
  const e = await Enrollment.findOne({ user: userId, course: courseId });
  if (!e || e.status === "completed") return e;
  e.status = "completed"; e.completedAt = new Date();
  await e.save();
  return e;
}
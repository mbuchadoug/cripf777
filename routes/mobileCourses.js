// routes/mobileCourses.js
// ─────────────────────────────────────────────────────────────────────────────
// The COURSE ENGINE for the mobile app, as JSON. Mounted at:
//     app.use("/api/mobile/pro/courses", mobileCoursesRouter);
//
// Same User document as the web + the existing /api/mobile/pro flow, so a person
// who enrols here sees identical progress on cripfcnt.com and vice-versa. Access
// is gated by ENROLLMENT (not persona), so any signed-in role can take courses.
//
// PLATFORM-COMPLIANT PAYMENTS (critical for App Store / Play Store review):
//   • Free courses  → enrol instantly on any platform.
//   • Paid courses on iOS → NO in-app purchase UI is offered. Apple forbids
//     selling digital content through outside payment inside the app, so the API
//     reports the course as "buy on the website" and the app must not show a pay
//     button. (Matches the app's existing iOS policy.)
//   • Paid courses on Android → external web checkout URL (opened in the browser)
//     plus EcoCash, behind a remote kill-switch in settings.payments.
// The app passes ?platform=ios|android; we default to the safe (iOS) behaviour.
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { requireMobileAuth } from "./mobileApi.js";
import Course from "../models/course.js";
import Enrollment from "../models/enrollment.js";
import CourseProgress from "../models/courseProgress.js";
import CourseCertificate from "../models/courseCertificate.js";
import ModuleCertificate from "../models/moduleCertificate.js";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import CourseEngineSettings from "../models/courseEngineSettings.js";

import { recomputeCourseProgress } from "../services/courseGrading.js";
import { enroll, enrollmentIntent, computeStages, canAccessCourse } from "../services/enrollmentService.js";
import { getKnowledgeMap } from "../services/knowledgeMap.js";
import { initCourseEcocash, pollCourseEcocash, createCourseCheckout } from "../services/coursePayments.js";
import { slugToLabel, pillarOf, ALL_PILLARS } from "../services/courseTaxonomy.js";

const router = Router();
router.use(express.json({ limit: "1mb" }));

const SITE_URL = process.env.SITE_URL || "https://cripfcnt.com";
const priceLabel = c => (c.accessType === "paid" && c.price) ? `${c.currency || "USD"} ${Number(c.price).toFixed(2)}` : (c.accessType === "invite" ? "Invite only" : "Free");
const platformOf = req => String(req.query.platform || req.body?.platform || "ios").toLowerCase() === "android" ? "android" : "ios";

// What can this platform do about paying for this course right now?
async function paymentCapability(platform, course) {
  if (course.accessType !== "paid") return { required: false };
  if (platform !== "android") {
    // iOS (and unknown) — never present a purchase path inside the app
    return { required: true, available: false, reason: "Paid courses are enrolled on our website. Visit cripfcnt.com to complete enrolment, then it appears here automatically." };
  }
  const s = await CourseEngineSettings.getSettings().catch(() => null);
  const pay = s?.payments || { ecocash: true, stripe: true, defaultMethod: "ecocash" };
  const methods = [];
  if (pay.ecocash) methods.push("ecocash");
  if (pay.stripe) methods.push("web");
  return {
    required: true, available: methods.length > 0, methods,
    defaultMethod: pay.defaultMethod || "ecocash",
    price: course.price || 0, currency: course.currency || "USD"
  };
}

// ── CATALOG ──────────────────────────────────────────────────────────────────
router.get("/", requireMobileAuth, async (req, res) => {
  try {
    const courses = await Course.find({ published: true }).lean();
    const enrs = await Enrollment.find({ user: req.mobileUser._id }).select("course status").lean();
    const stateByCourse = {}; for (const e of enrs) stateByCourse[String(e.course)] = e.status;

    const list = courses.map(c => ({
      slug: c.slug, title: c.title,
      area: c.areaLabel || slugToLabel(c.professionalArea),
      module: c.pillar || pillarOf(c.professionalArea) || "general",
      moduleLabel: slugToLabel(c.pillar || pillarOf(c.professionalArea) || "general"),
      level: slugToLabel(c.level || "foundation"),
      accessType: c.accessType, price: priceLabel(c),
      totalQuizzes: (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0),
      state: stateByCourse[String(c._id)] || "browse"
    }));

    // grouped by the 8 modules for a clean mobile layout
    const byModule = {};
    for (const c of list) (byModule[c.module] = byModule[c.module] || []).push(c);
    const modules = ALL_PILLARS.filter(p => byModule[p]?.length).map(p => ({
      module: p, label: slugToLabel(p), courses: byModule[p]
    }));

    res.json({ courses: list, modules });
  } catch (e) { console.error("[mobile courses]", e); res.status(500).json({ error: "Failed to load courses" }); }
});

// ── MY LEARNING ──────────────────────────────────────────────────────────────
router.get("/me/learning", requireMobileAuth, async (req, res) => {
  try {
    const enrs = await Enrollment.find({ user: req.mobileUser._id }).sort({ updatedAt: -1 }).lean();
    const ids = enrs.map(e => e.course);
    const [courses, progresses] = await Promise.all([
      Course.find({ _id: { $in: ids } }).lean(),
      CourseProgress.find({ user: req.mobileUser._id, course: { $in: ids } }).lean()
    ]);
    const cById = {}; for (const c of courses) cById[String(c._id)] = c;
    const pById = {}; for (const p of progresses) pById[String(p.course)] = p;
    const rows = enrs.map(e => {
      const c = cById[String(e.course)]; if (!c) return null;
      const p = pById[String(e.course)];
      const passedByQuiz = {}; for (const q of (p?.quizzes || [])) passedByQuiz[String(q.quizId)] = { passed: !!q.passed, attempts: q.attempts };
      const st = computeStages(c, passedByQuiz);
      return {
        slug: c.slug, title: c.title, area: c.areaLabel || slugToLabel(c.professionalArea),
        level: slugToLabel(c.level || "foundation"), status: e.status,
        stage: st.currentStage, stagesTotal: st.totalStages, completion: st.completionPct,
        attempts: st.totalAttempts, classification: p?.classification || null
      };
    }).filter(Boolean);
    res.json({ enrollments: rows });
  } catch (e) { console.error("[mobile my-learning]", e); res.status(500).json({ error: "Failed" }); }
});

// ── KNOWLEDGE MAP ────────────────────────────────────────────────────────────
router.get("/me/knowledge-map", requireMobileAuth, async (req, res) => {
  try {
    const map = await getKnowledgeMap(req.mobileUser._id);
    // radar geometry is for SVG on web; the app draws its own, so send raw values
    res.json({
      overall: map.overall,
      pillars: map.pillars.map(p => ({ module: p.pillar, label: p.label, value: p.value, status: p.status, coursesEnrolled: p.coursesEnrolled, coursesCompleted: p.coursesCompleted, coursesTotal: p.coursesTotal })),
      strengths: map.strengths, gaps: map.gaps, counts: map.counts, recommendation: map.recommendation
    });
  } catch (e) { console.error("[mobile km]", e); res.status(500).json({ error: "Failed" }); }
});

// ── COURSE DETAIL (locked / learning) ────────────────────────────────────────
router.get("/:slug", requireMobileAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Course not found" });
    const platform = platformOf(req);

    const base = {
      slug: course.slug, title: course.title,
      area: course.areaLabel || slugToLabel(course.professionalArea),
      module: slugToLabel(course.pillar || pillarOf(course.professionalArea) || "general"),
      level: slugToLabel(course.level || "foundation"),
      description: course.description || "",
      accessType: course.accessType, price: priceLabel(course),
      passMark: course.rules?.perQuizPassMark ?? 70, overallPassMark: course.rules?.overallPassMark ?? 70,
      totalQuizzes: (course.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0),
      stagesTotal: (course.units || []).length
    };

    const access = await canAccessCourse({ user: req.mobileUser, courseId: course._id });
    if (!access.ok) {
      const intent = enrollmentIntent(course, access.enrollment);
      const payment = await paymentCapability(platform, course);
      return res.json({ mode: "locked", course: base, intent: intent.action, pending: access.enrollment?.status === "pending", payment });
    }

    const result = await recomputeCourseProgress({ userId: req.mobileUser._id, courseId: course._id });
    const prog = result?.progress; const ev = result?.evaluation;
    const allIds = (course.units || []).flatMap(u => (u.quizIds || []).map(String));
    const passages = await Question.find({ _id: { $in: allIds } }).select("_id quizTitle text").lean();
    const titleById = {}; for (const p of passages) titleById[String(p._id)] = p.quizTitle || p.text || "Assessment";
    const bestById = {}; const passedByQuiz = {};
    for (const q of (prog?.quizzes || [])) { bestById[String(q.quizId)] = q; passedByQuiz[String(q.quizId)] = { passed: !!q.passed, attempts: q.attempts }; }
    const st = computeStages(course, passedByQuiz);

    const units = (course.units || []).map((u, i) => ({
      index: i + 1, title: u.title, complete: st.stages[i]?.complete || false,
      passed: st.stages[i]?.passed || 0, total: st.stages[i]?.total || 0,
      quizzes: (u.quizIds || []).map(qid => {
        const id = String(qid); const b = bestById[id] || {};
        return { quizId: id, title: titleById[id] || "Assessment", best: b.bestPercentage || 0, attempts: b.attempts || 0, passed: !!b.passed };
      })
    }));

    let certificateUrl = result?.certificate?.pdfUrl || null;
    if (certificateUrl && !/^https?:/.test(certificateUrl)) certificateUrl = SITE_URL + certificateUrl;

    res.json({
      mode: "learning", course: base,
      progress: { overall: ev?.overallPercentage || 0, passedCount: ev?.passedCount || 0, total: ev?.totalQuizzes || 0,
        complete: !!ev?.complete, classification: ev?.classification || null, breadthOk: !!ev?.breadthOk, depthOk: !!ev?.depthOk,
        currentStage: st.currentStage, stagesTotal: st.totalStages, completion: st.completionPct, attempts: st.totalAttempts },
      units, certificateUrl
    });
  } catch (e) { console.error("[mobile detail]", e); res.status(500).json({ error: "Failed" }); }
});

// ── ENROLL ───────────────────────────────────────────────────────────────────
router.post("/:slug/enroll", requireMobileAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Not found" });
    const platform = platformOf(req);

    // Block the iOS paid path entirely — never create a purchase expectation in-app
    if (course.accessType === "paid" && platform !== "android") {
      return res.json({ status: "web_only", message: "Enrol in this paid course on cripfcnt.com; it will appear here automatically.", url: `${SITE_URL}/courses/${course.slug}` });
    }
    if (!course.enrollmentOpen && course.accessType !== "invite") return res.status(403).json({ error: "Enrollment closed" });

    const { enrollment, intent } = await enroll({ userId: req.mobileUser._id, course, source: "self" });
    const payment = await paymentCapability(platform, course);
    res.json({ status: enrollment.status, intent: intent.action, payment });
  } catch (e) { console.error("[mobile enroll]", e); res.status(500).json({ error: "Enroll failed" }); }
});

// ── PAY (Android only) ───────────────────────────────────────────────────────
router.post("/:slug/pay/ecocash", requireMobileAuth, async (req, res) => {
  try {
    if (platformOf(req) !== "android") return res.status(403).json({ error: "Not available on this platform" });
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Not found" });
    const e = await Enrollment.findOne({ user: req.mobileUser._id, course: course._id });
    if (!e || e.status === "active") return res.status(400).json({ error: "No pending enrollment" });
    const r = await initCourseEcocash({ user: req.mobileUser, course, enrollment: e, phone: req.body.phone });
    res.status(r.success ? 200 : 400).json(r);
  } catch (e) { console.error("[mobile ecocash]", e); res.status(500).json({ error: "Payment error" }); }
});
router.get("/:slug/pay/poll/:ref", requireMobileAuth, async (req, res) => {
  try { res.json(await pollCourseEcocash({ reference: req.params.ref, userId: req.mobileUser._id })); }
  catch (e) { res.json({ status: "pending" }); }
});
router.get("/:slug/pay/checkout-url", requireMobileAuth, async (req, res) => {
  try {
    if (platformOf(req) !== "android") return res.json({ available: false });
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Not found" });
    let e = await Enrollment.findOne({ user: req.mobileUser._id, course: course._id });
    if (!e) { const r = await enroll({ userId: req.mobileUser._id, course, source: "self" }); e = r.enrollment; }
    if (e.status === "active") return res.json({ available: false, alreadyActive: true });
    const r = await createCourseCheckout({ user: req.mobileUser, course, enrollment: e });
    res.json({ available: !!r.url, url: r.url || null });
  } catch (e) { console.error("[mobile checkout]", e); res.status(500).json({ error: "Checkout failed" }); }
});

// ── START A QUIZ → returns examId for the app's quiz runner ──────────────────
router.post("/:slug/take/:quizId", requireMobileAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Course not found" });
    const access = await canAccessCourse({ user: req.mobileUser, courseId: course._id });
    if (!access.ok) return res.status(403).json({ error: "Enrol to take this assessment" });

    const quizId = String(req.params.quizId || "");
    if (!mongoose.isValidObjectId(quizId)) return res.status(400).json({ error: "Invalid quiz" });
    const inCourse = (course.units || []).some(u => (u.quizIds || []).some(q => String(q) === quizId));
    if (!inCourse) return res.status(404).json({ error: "Quiz not in this course" });

    const quiz = await Question.findById(quizId).lean();
    if (!quiz || quiz.type !== "comprehension") return res.status(404).json({ error: "Quiz not found" });

    const orgId = quiz.organization || course.org;
    if (!orgId) return res.status(500).json({ error: "Assessment not linked to an organization" });
    const org = await Organization.findById(orgId).select("slug").lean();

    let exam = await ExamInstance.findOne({ org: orgId, userId: req.mobileUser._id, "meta.catalogQuizId": new mongoose.Types.ObjectId(quizId) }).lean();
    if (!exam) {
      const childIds = Array.isArray(quiz.questionIds) ? quiz.questionIds.map(String) : [];
      const questionIds = [`parent:${String(quiz._id)}`, ...childIds];
      const choicesOrder = [[]];
      for (const cid of childIds) {
        let n = 0; try { const c = await Question.findById(cid).select("choices").lean(); n = Array.isArray(c?.choices) ? c.choices.length : 0; } catch (_) {}
        const idx = Array.from({ length: n }, (_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        choicesOrder.push(idx);
      }
      const created = await ExamInstance.create({
        examId: crypto.randomUUID(), assignmentId: `course-${String(req.mobileUser._id)}-${quizId}`,
        org: orgId, userId: req.mobileUser._id,
        module: quiz.module || "general", modules: Array.isArray(quiz.modules) && quiz.modules.length ? quiz.modules : [quiz.module || "general"],
        title: quiz.text || "Quiz", quizTitle: quiz.text || "Quiz", questionIds, choicesOrder,
        isOnboarding: false, targetRole: "professional", durationMinutes: 30,
        meta: { catalogQuizId: new mongoose.Types.ObjectId(quizId), topics: quiz.topics || [], series: quiz.series, courseId: String(course._id), isCourseAttempt: true, track: "professional" },
        createdAt: new Date()
      });
      exam = created.toObject();
    }
    res.json({ examId: exam.examId, org: org?.slug || null, quizTitle: exam.quizTitle || exam.title || "Quiz" });
  } catch (e) { console.error("[mobile take]", e); res.status(500).json({ error: "Failed to start" }); }
});

// ── CREDENTIALS ──────────────────────────────────────────────────────────────
router.get("/me/credentials", requireMobileAuth, async (req, res) => {
  try {
    const [courseCerts, moduleCerts] = await Promise.all([
      CourseCertificate.find({ user: req.mobileUser._id }).sort({ issuedAt: -1 }).lean(),
      ModuleCertificate.find({ user: req.mobileUser._id }).sort({ issuedAt: -1 }).lean()
    ]);
    const abs = u => u && !/^https?:/.test(u) ? SITE_URL + u : u;
    res.json({
      courseCerts: courseCerts.map(c => ({ title: c.courseTitle, area: c.moduleName, grade: c.classification, pct: c.overallPercentage, url: abs(c.pdfUrl), serial: c.serial })),
      moduleCerts: moduleCerts.map(c => ({ title: c.moduleName, grade: c.classification, pct: c.overallPercentage, url: abs(c.pdfUrl), serial: c.serial }))
    });
  } catch (e) { console.error("[mobile creds]", e); res.status(500).json({ error: "Failed" }); }
});

export default router;
// routes/courseEngine.js - full course engine: enrollment, signup, payments, progress, admin
import { Router } from "express";
import mongoose from "mongoose";
import { ensureAuth } from "../middleware/authGuard.js";

import Course from "../models/course.js";
import CourseProgress from "../models/courseProgress.js";
import CourseCertificate from "../models/courseCertificate.js";
import ModuleTrack from "../models/moduleTrack.js";
import ModuleCertificate from "../models/moduleCertificate.js";
import Enrollment from "../models/enrollment.js";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import User from "../models/user.js";

import { recomputeCourseProgress } from "../services/courseGrading.js";
import { PILLAR_CATEGORIES, ALL_PILLARS, slugToLabel, pillarOf } from "../services/courseTaxonomy.js";
import { enroll, enrollmentIntent, computeStages, canAccessCourse, activateEnrollment, suspendEnrollment } from "../services/enrollmentService.js";
import { initCourseEcocash, pollCourseEcocash, createCourseCheckout } from "../services/coursePayments.js";
import { getKnowledgeMap } from "../services/knowledgeMap.js";
import CourseEngineSettings from "../models/courseEngineSettings.js";
import { syncCoursesFromAssessments, refillCourse, getSettings } from "../services/courseProvisioning.js";

const router = Router();

function ensureAdminEmails(req, res, next) {
  const adminSet = new Set((process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean));
  if (!adminSet.has(String(req.user?.email || "").toLowerCase())) return res.status(403).send("Admins only");
  next();
}
const slugify = s => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const money = c => (c.accessType === "paid" && c.price) ? `${c.currency || "USD"} ${Number(c.price).toFixed(2)}` : (c.accessType === "invite" ? "Invite only" : "Free");
const emailRe = em => new RegExp(`^${String(em).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
const loginPromise = (req, user) => new Promise((resolve, reject) => req.login(user, e => e ? reject(e) : resolve()));

// ── SELF-SIGNUP / LOGIN ───────────────────────────────────────────────────
router.get("/learn/signup", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect(req.query.next || "/courses");
  res.render("courses/signup", { layout: false, next: req.query.next || "/courses", error: null });
});
router.post("/learn/signup", async (req, res) => {
  try {
    const { name, email, password, role, next } = req.body;
    const em = String(email || "").trim().toLowerCase();
    if (!em || !password || String(password).length < 6)
      return res.render("courses/signup", { layout: false, next: next || "/courses", error: "Enter an email and a password of at least 6 characters." });
    if (await User.findOne({ email: emailRe(em) }))
      return res.render("courses/signup", { layout: false, next: next || "/courses", error: "An account with that email already exists - please sign in." });
    const isStudent = role === "student";
    const primaryRole = isStudent ? "student" : "parent"; // "professional" is a mobile persona, not a primary-role enum value
    const persona = isStudent ? "student" : "professional";
    const parts = String(name || "").trim().split(/\s+/);
    const user = new User({ email: em, displayName: name || em.split("@")[0], firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "", role: primaryRole, mobileRoles: [persona], activeMobileRole: persona, provider: "local" });
    await user.setPassword(password);
    await user.save();
    await loginPromise(req, user);
    return res.redirect(next || "/courses");
  } catch (e) { console.error("[learn signup]", e); return res.render("courses/signup", { layout: false, next: "/courses", error: "Could not create the account. Try again." }); }
});
router.post("/learn/login", async (req, res) => {
  try {
    const { email, password, next } = req.body;
    const user = await User.findOne({ email: emailRe(String(email || "").trim()) });
    if (!user || !user.passwordHash || !(await user.verifyPassword(password)))
      return res.render("courses/signup", { layout: false, next: next || "/courses", error: "Incorrect email or password." });
    await loginPromise(req, user);
    return res.redirect(next || "/courses");
  } catch (e) { console.error("[learn login]", e); return res.render("courses/signup", { layout: false, next: "/courses", error: "Sign-in failed. Try again." }); }
});

// ── PUBLIC CATALOG ────────────────────────────────────────────────────────
router.get("/courses", async (req, res) => {
  try {
    const courses = await Course.find({ published: true }).lean();
    const authed = req.isAuthenticated && req.isAuthenticated();
    const enrByCourse = {};
    if (authed) { for (const e of await Enrollment.find({ user: req.user._id }).lean()) enrByCourse[String(e.course)] = e; }
    const view = courses.map(c => {
      const e = enrByCourse[String(c._id)];
      return { slug: c.slug, title: c.title, area: c.areaLabel || slugToLabel(c.professionalArea), level: slugToLabel(c.level || "foundation"),
        pillar: c.pillar || pillarOf(c.professionalArea) || "general",
        price: money(c), accessType: c.accessType, totalQuizzes: (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0), state: e ? e.status : "browse" };
    });
    // group by module (pillar) for the 8-module layout
    const groups = {};
    for (const c of view) { (groups[c.pillar] = groups[c.pillar] || []).push(c); }
    const modules = ALL_PILLARS.filter(p => groups[p]).map(p => ({ pillar: p, label: slugToLabel(p), courses: groups[p] }));
    res.render("courses/index", { layout: false, user: req.user || null, authed, courses: view, modules });
  } catch (e) { console.error("[catalog]", e); res.status(500).send("Error"); }
});

// ── Browse by MODULE (8 pillars) + one-click module enrolment ────────────────
router.get("/modules", async (req, res) => {
  try {
    const courses = await Course.find({ published: true }).lean();
    const authed = req.isAuthenticated && req.isAuthenticated();
    const byPillar = {};
    for (const c of courses) { const p = c.pillar || pillarOf(c.professionalArea) || "general"; (byPillar[p] = byPillar[p] || []).push(c); }
    const modules = ALL_PILLARS.filter(p => byPillar[p]?.length).map(p => ({
      pillar: p, label: slugToLabel(p), courseCount: byPillar[p].length,
      quizzes: byPillar[p].reduce((n, c) => n + (c.units || []).reduce((m, u) => m + (u.quizIds || []).length, 0), 0),
      courses: byPillar[p].map(c => ({ slug: c.slug, title: c.title }))
    }));
    res.render("courses/modules", { layout: false, user: req.user || null, authed, modules });
  } catch (e) { console.error("[modules]", e); res.status(500).send("Error"); }
});
router.post("/modules/:pillar/enroll", ensureAuth, async (req, res) => {
  try {
    const courses = await Course.find({ published: true, pillar: req.params.pillar }).lean();
    for (const c of courses) { try { await enroll({ userId: req.user._id, course: c, source: "self" }); } catch (_) {} }
    res.redirect("/me/learning");
  } catch (e) { console.error("[module enroll]", e); res.status(500).send("Error"); }
});

// ── DETAIL (locked / learning) ──────────────────────────────────────────────
router.get("/courses/:slug", async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).send("Course not found");
    const authed = req.isAuthenticated && req.isAuthenticated();
    const orgSlug = course.org ? (await Organization.findById(course.org).select("slug").lean())?.slug : null;
    const base = { layout: false, authed, user: req.user || null, course: {
      title: course.title, slug: course.slug, area: course.areaLabel || slugToLabel(course.professionalArea),
      level: slugToLabel(course.level || "foundation"), description: course.description || "",
      price: money(course), accessType: course.accessType, rawPrice: course.price, currency: course.currency,
      totalQuizzes: (course.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0),
      stagesTotal: (course.units || []).length, rules: course.rules } };

    const access = authed ? await canAccessCourse({ user: req.user, courseId: course._id }) : { ok: false, reason: "auth" };
    if (!access.ok) {
      const intent = enrollmentIntent(course, access.enrollment);
      const st = await getSettings(course.org || null).catch(() => null);
      const pay = st?.payments || { ecocash: true, stripe: true, defaultMethod: "ecocash" };
      return res.render("courses/detail", { ...base, mode: "locked",
        signupUrl: `/learn/signup?next=${encodeURIComponent("/courses/" + course.slug)}`,
        googleUrl: `/auth/google?returnTo=${encodeURIComponent("/courses/" + course.slug)}`,
        pay, ecoDefault: pay.defaultMethod === "ecocash",
        intent, pending: access.enrollment?.status === "pending" ? access.enrollment : null, reason: access.reason });
    }

    const result = await recomputeCourseProgress({ userId: req.user._id, courseId: course._id });
    const prog = result?.progress; const ev = result?.evaluation;
    const allIds = (course.units || []).flatMap(u => (u.quizIds || []).map(String));
    const passages = await Question.find({ _id: { $in: allIds } }).select("_id quizTitle text meta").lean();
    const titleById = {}; for (const p of passages) titleById[String(p._id)] = p.quizTitle || p.text || "Assessment";
    const bestById = {}; for (const q of (prog?.quizzes || [])) bestById[String(q.quizId)] = q;
    const passedByQuiz = {}; for (const q of (prog?.quizzes || [])) passedByQuiz[String(q.quizId)] = { passed: !!q.passed, bestPercentage: q.bestPercentage, attempts: q.attempts };
    const st = computeStages(course, passedByQuiz);
    const units = (course.units || []).map((u, i) => ({ index: i + 1, title: u.title, stage: st.stages[i],
      quizzes: (u.quizIds || []).map(qid => { const id = String(qid); const b = bestById[id] || {};
        return { id, title: titleById[id] || "Assessment", best: b.bestPercentage || 0, attempts: b.attempts || 0, passed: !!b.passed,
          takeUrl: orgSlug ? `/org/${orgSlug}/take-quiz?quizId=${id}` : "#" }; }) }));
    res.render("courses/detail", { ...base, mode: "learning", stagesInfo: st, units,
      progress: { overall: ev?.overallPercentage || 0, passedCount: ev?.passedCount || 0, total: ev?.totalQuizzes || 0,
        complete: !!ev?.complete, classification: ev?.classification || null, breadthOk: !!ev?.breadthOk, depthOk: !!ev?.depthOk },
      certificateUrl: result?.certificate?.pdfUrl || null });
  } catch (e) { console.error("[detail]", e); res.status(500).send("Error"); }
});

// ── ENROLL + PAY ─────────────────────────────────────────────────────────────
router.post("/courses/:slug/enroll", ensureAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).send("Not found");
    if (!course.enrollmentOpen && course.accessType !== "invite") return res.status(403).send("Enrollment closed");
    await enroll({ userId: req.user._id, course, source: "self" });
    return res.redirect(`/courses/${course.slug}`);
  } catch (e) { console.error("[enroll]", e); res.status(500).send("Enroll failed"); }
});
router.post("/courses/:slug/pay/ecocash", ensureAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).json({ error: "Not found" });
    const e = await Enrollment.findOne({ user: req.user._id, course: course._id });
    if (!e || e.status === "active") return res.status(400).json({ error: "No pending enrollment" });
    const r = await initCourseEcocash({ user: req.user, course, enrollment: e, phone: req.body.phone });
    return res.status(r.success ? 200 : 400).json(r);
  } catch (e) { console.error("[ecocash]", e); res.status(500).json({ error: "Payment error" }); }
});
router.get("/courses/:slug/pay/ecocash/poll/:ref", ensureAuth, async (req, res) => {
  try { return res.json(await pollCourseEcocash({ reference: req.params.ref, userId: req.user._id })); }
  catch (e) { return res.json({ status: "pending" }); }
});
router.post("/courses/:slug/pay/stripe", ensureAuth, async (req, res) => {
  try {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) return res.status(404).send("Not found");
    const e = await Enrollment.findOne({ user: req.user._id, course: course._id });
    if (!e || e.status === "active") return res.status(400).send("No pending enrollment");
    const r = await createCourseCheckout({ user: req.user, course, enrollment: e });
    if (r.url) return res.redirect(r.url);
    return res.status(400).send(r.error || "Checkout failed");
  } catch (e) { console.error("[stripe checkout]", e); res.status(500).send("Payment error"); }
});
router.get("/courses/:slug/certificate", ensureAuth, async (req, res) => {
  const course = await Course.findOne({ slug: req.params.slug }).lean();
  if (!course) return res.status(404).send("Not found");
  const prog = await CourseProgress.findOne({ user: req.user._id, course: course._id }).lean();
  if (!prog?.certificate) return res.status(404).send("No certificate yet");
  const cert = await CourseCertificate.findById(prog.certificate).lean();
  if (!cert?.pdfUrl) return res.status(404).send("Certificate not ready");
  return res.redirect(cert.pdfUrl);
});

// ── LEARNER DASHBOARD (/me) - knowledge map + at-a-glance ────────────────────
router.get("/me", ensureAuth, async (req, res) => {
  try {
    const map = await getKnowledgeMap(req.user._id);
    // in-progress + recent for the dashboard body
    const enrs = await Enrollment.find({ user: req.user._id, status: { $in: ["active", "completed"] } }).lean();
    const courseIds = enrs.map(e => e.course);
    const [courses, progresses] = await Promise.all([
      Course.find({ _id: { $in: courseIds } }).select("_id title slug professionalArea areaLabel level pillar units").lean(),
      CourseProgress.find({ user: req.user._id, course: { $in: courseIds } }).lean()
    ]);
    const cById = {}; for (const c of courses) cById[String(c._id)] = c;
    const pById = {}; for (const p of progresses) pById[String(p.course)] = p;
    const inProgress = enrs
      .filter(e => (pById[String(e.course)]?.status !== "completed"))
      .map(e => {
        const c = cById[String(e.course)]; if (!c) return null;
        const p = pById[String(e.course)];
        const total = (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0);
        return { slug: c.slug, title: c.title, area: c.areaLabel || slugToLabel(c.professionalArea),
          overall: p?.overallPercentage || 0, passed: p?.passedCount || 0, total };
      }).filter(Boolean)
      .sort((a, b) => b.overall - a.overall).slice(0, 4);

    res.render("courses/dashboard", {
      layout: false, user: req.user,
      name: req.user.displayName || req.user.firstName || (req.user.email || "").split("@")[0],
      map, inProgress
    });
  } catch (e) { console.error("[me dashboard]", e); res.status(500).send("Error"); }
});

// ── MY LEARNING + CREDENTIALS ────────────────────────────────────────────────
router.get("/me/learning", ensureAuth, async (req, res) => {
  try {
    const enrs = await Enrollment.find({ user: req.user._id }).sort({ updatedAt: -1 }).lean();
    const courseIds = enrs.map(e => e.course);
    const [courses, progresses] = await Promise.all([
      Course.find({ _id: { $in: courseIds } }).lean(),
      CourseProgress.find({ user: req.user._id, course: { $in: courseIds } }).lean()
    ]);
    const cById = {}; for (const c of courses) cById[String(c._id)] = c;
    const pById = {}; for (const p of progresses) pById[String(p.course)] = p;
    const rows = enrs.map(e => {
      const c = cById[String(e.course)]; if (!c) return null;
      const p = pById[String(e.course)];
      const passedByQuiz = {}; for (const q of (p?.quizzes || [])) passedByQuiz[String(q.quizId)] = { passed: !!q.passed, attempts: q.attempts };
      const st = computeStages(c, passedByQuiz);
      return { slug: c.slug, title: c.title, area: c.areaLabel || slugToLabel(c.professionalArea), level: slugToLabel(c.level || "foundation"),
        status: e.status, stage: st.currentStage, stagesTotal: st.totalStages, completion: st.completionPct, attempts: st.totalAttempts, classification: p?.classification || null };
    }).filter(Boolean);
    res.render("courses/my_learning", { layout: false, user: req.user, rows });
  } catch (e) { console.error("[my learning]", e); res.status(500).send("Error"); }
});
router.get("/me/credentials", ensureAuth, async (req, res) => {
  const [courseCerts, moduleCerts] = await Promise.all([
    CourseCertificate.find({ user: req.user._id }).sort({ issuedAt: -1 }).lean(),
    ModuleCertificate.find({ user: req.user._id }).sort({ issuedAt: -1 }).lean()
  ]);
  res.render("courses/credentials", { layout: false, user: req.user,
    courseCerts: courseCerts.map(c => ({ title: c.courseTitle, area: c.moduleName, grade: c.classification, pct: c.overallPercentage, url: c.pdfUrl, serial: c.serial })),
    moduleCerts: moduleCerts.map(c => ({ title: c.moduleName, grade: c.classification, pct: c.overallPercentage, url: c.pdfUrl, serial: c.serial })) });
});

// ── VERIFY ────────────────────────────────────────────────────────────────
router.get("/verify/course/:code", async (req, res) => {
  const c = await CourseCertificate.findOne({ verifyCode: String(req.params.code || "").toUpperCase() }).lean();
  if (!c) return res.status(404).send("Credential not found or invalid.");
  res.send(`<pre>VALID CREDENTIAL - Certificate of Competence
Recipient : ${c.recipientName}
Course    : ${c.courseTitle}
Area      : ${c.moduleName}
Grade     : ${c.classification} (${c.overallPercentage}%)
Serial    : ${c.serial}
Issued    : ${new Date(c.issuedAt).toDateString()}</pre>`);
});
router.get("/verify/module/:code", async (req, res) => {
  const c = await ModuleCertificate.findOne({ verifyCode: String(req.params.code || "").toUpperCase() }).lean();
  if (!c) return res.status(404).send("Credential not found or invalid.");
  res.send(`<pre>VALID CREDENTIAL - Certificate of Mastery
Recipient : ${c.recipientName}
Module    : ${c.moduleName}
Grade     : ${c.classification} (${c.overallPercentage}%)
Serial    : ${c.serial}
Issued    : ${new Date(c.issuedAt).toDateString()}</pre>`);
});

// ── Module enrolment: enrol in every published course in a pillar at once ────
router.post("/courses/module/:pillar/enroll", ensureAuth, async (req, res) => {
  try {
    const pillar = req.params.pillar;
    const courses = await Course.find({ published: true, $or: [{ pillar }, { professionalArea: { $in: PILLAR_CATEGORIES[pillar] || [] } }] }).lean();
    for (const c of courses) { try { await enroll({ userId: req.user._id, course: c, source: "self" }); } catch (e) { /* keep going */ } }
    res.redirect("/me/learning");
  } catch (e) { console.error("[module enroll]", e); res.status(500).send("Enroll failed"); }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN - Course Engine control center (auto-provisioning)
// ════════════════════════════════════════════════════════════════════════════
router.get("/admin/course-engine", ensureAuth, ensureAdminEmails, async (req, res) => {
  const orgId = req.user?.organization || null;
  const settings = await getSettings(orgId);
  const courses = await Course.find(orgId ? { org: orgId } : {}).sort({ pillar: 1, title: 1 }).lean();
  const match = { type: "comprehension", "meta.isOutOfScope": { $ne: true } };
  if (orgId) match.organization = orgId;
  const poolAgg = await Question.aggregate([{ $match: match }, { $group: { _id: "$category", n: { $sum: 1 } } }]);
  const poolByCat = {}; for (const r of poolAgg) poolByCat[r._id] = r.n;
  const byPillar = {};
  for (const c of courses) {
    const p = c.pillar || pillarOf(c.professionalArea) || "general";
    (byPillar[p] = byPillar[p] || []).push({ id: String(c._id), title: c.title, area: c.professionalArea,
      selected: (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0), pool: poolByCat[c.professionalArea] || 0,
      target: c.quizTarget, customized: c.customized, published: c.published, access: c.accessType });
  }
  const modules = ALL_PILLARS.map(p => {
    const ms = (settings.moduleSettings || []).find(m => m.pillar === p) || {};
    return { pillar: p, label: slugToLabel(p), quizzesPerCourse: ms.quizzesPerCourse ?? "", minCoursesToComplete: ms.minCoursesToComplete ?? "", enabled: ms.enabled !== false, courses: byPillar[p] || [] };
  });
  res.render("admin/course_engine", { layout: false, user: req.user,
    settings: { defaultQuizzesPerCourse: settings.defaultQuizzesPerCourse, selectionStrategy: settings.selectionStrategy, defaultLevel: settings.defaultLevel, defaultAccessType: settings.defaultAccessType, defaultPrice: settings.defaultPrice, autoPublish: settings.autoPublish, payments: settings.payments || { ecocash: true, stripe: true, defaultMethod: "ecocash", currency: "USD" } },
    modules, synced: req.query.synced || null, courseCount: courses.length });
});
router.post("/admin/course-engine/settings", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const orgId = req.user?.organization || null;
    const settings = await getSettings(orgId); const b = req.body;
    settings.defaultQuizzesPerCourse = Number(b.defaultQuizzesPerCourse) || 12;
    settings.selectionStrategy = ["balanced", "first", "random"].includes(b.selectionStrategy) ? b.selectionStrategy : "balanced";
    settings.defaultLevel = ["foundation", "intermediate", "advanced"].includes(b.defaultLevel) ? b.defaultLevel : "foundation";
    settings.defaultAccessType = ["free", "paid", "invite"].includes(b.defaultAccessType) ? b.defaultAccessType : "free";
    settings.defaultPrice = Number(b.defaultPrice) || 0;
    settings.autoPublish = b.autoPublish === "on" || b.autoPublish === "true";
    settings.payments = {
      ecocash: b.pay_ecocash === "on" || b.pay_ecocash === "true",
      stripe: b.pay_stripe === "on" || b.pay_stripe === "true",
      defaultMethod: ["ecocash", "stripe"].includes(b.pay_default) ? b.pay_default : "ecocash",
      currency: b.pay_currency || "USD"
    };
    const pillars = [].concat(b.m_pillar || []); const qpc = [].concat(b.m_quizzesPerCourse || []); const minc = [].concat(b.m_minCourses || []);
    const enabled = new Set([].concat(b.m_enabled || []));
    settings.moduleSettings = pillars.map((p, i) => ({ pillar: p, quizzesPerCourse: qpc[i] === "" || qpc[i] == null ? null : Number(qpc[i]), minCoursesToComplete: minc[i] === "" || minc[i] == null ? null : Number(minc[i]), enabled: enabled.has(p) }));
    await settings.save();
    res.redirect("/admin/course-engine");
  } catch (e) { console.error("[ce settings]", e); res.status(500).send("Failed: " + e.message); }
});
router.post("/admin/course-engine/sync", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const orgId = req.user?.organization || null;
    const force = req.body.force === "on" || req.body.force === "true";
    const s = await syncCoursesFromAssessments({ orgId, force, createdBy: req.user._id });
    res.redirect(`/admin/course-engine?synced=${encodeURIComponent(`${s.created} created, ${s.updated} updated, ${s.skipped} skipped`)}`);
  } catch (e) { console.error("[ce sync]", e); res.status(500).send("Sync failed: " + e.message); }
});
router.post("/admin/courses/:id/quiz-target", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const t = req.body.target === "" || req.body.target == null ? null : Number(req.body.target);
    await refillCourse({ courseId: req.params.id, target: t, orgId: req.user?.organization || null });
    res.redirect("/admin/course-engine");
  } catch (e) { console.error("[quiz target]", e); res.status(500).send("Failed: " + e.message); }
});
// Lock/unlock a course from auto-resync (customized=true means "hand-curated, leave alone")
router.post("/admin/courses/:id/lock", ensureAuth, ensureAdminEmails, async (req, res) => {
  const c = await Course.findById(req.params.id);
  if (!c) return res.status(404).send("Not found");
  c.customized = !c.customized; await c.save();
  res.redirect("/admin/course-engine");
});
// Publish/unpublish from the control center
router.post("/admin/course-engine/:id/publish", ensureAuth, ensureAdminEmails, async (req, res) => {
  const c = await Course.findById(req.params.id);
  if (!c) return res.status(404).send("Not found");
  c.published = !c.published; await c.save();
  res.redirect("/admin/course-engine");
});

// ── ADMIN: courses ──────────────────────────────────────────────────────────
router.get("/admin/courses", ensureAuth, ensureAdminEmails, async (req, res) => {
  const courses = await Course.find({}).sort({ updatedAt: -1 }).lean();
  const counts = await Enrollment.aggregate([{ $group: { _id: "$course", n: { $sum: 1 } } }]);
  const enrByCourse = {}; for (const c of counts) enrByCourse[String(c._id)] = c.n;
  res.render("admin/courses_list", { layout: false, user: req.user,
    courses: courses.map(c => ({ id: String(c._id), title: c.title, slug: c.slug, area: c.areaLabel || slugToLabel(c.professionalArea),
      published: c.published, access: c.accessType, price: money(c), enrolled: enrByCourse[String(c._id)] || 0,
      totalQuizzes: (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0), units: (c.units || []).length })) });
});
async function renderBuilder(req, res, course) {
  const area = course?.professionalArea || req.query.area || "structural-responsibility";
  const orgId = req.user?.organization || null;
  const passages = await Question.find({ ...(orgId ? { organization: orgId } : {}), type: "comprehension", category: area, "meta.isOutOfScope": { $ne: true } })
    .select("_id quizTitle text series meta questionIds").lean();
  const selected = new Set(); for (const u of (course?.units || [])) for (const q of (u.quizIds || [])) selected.add(String(q));
  const bySeries = {};
  for (const p of passages) { const key = p.series || "general";
    (bySeries[key] = bySeries[key] || { seriesSlug: key, seriesLabel: slugToLabel(key), quizzes: [] });
    bySeries[key].quizzes.push({ id: String(p._id), title: p.quizTitle || p.text || "Assessment", band: p.meta?.difficultyBand || "-", qCount: (p.questionIds || []).length, checked: selected.has(String(p._id)) }); }
  res.render("admin/course_form", { layout: false, user: req.user, isEdit: !!course, area, areaLabel: slugToLabel(area),
    areas: Object.values(PILLAR_CATEGORIES).flat().sort().map(c => ({ slug: c, label: slugToLabel(c) })), series: Object.values(bySeries),
    course: course ? { id: String(course._id), title: course.title, slug: course.slug, description: course.description, level: course.level, rules: course.rules, weighting: course.weighting, accessType: course.accessType, price: course.price, currency: course.currency, enrollmentOpen: course.enrollmentOpen }
      : { title: "", slug: "", description: "", level: "foundation", weighting: "equal", accessType: "free", price: 0, currency: "USD", enrollmentOpen: true, rules: { perQuizPassMark: 70, minQuizzesToPass: "", overallPassMark: 70, maxAttempts: 3, cooldownHours: 24 } } });
}
router.get("/admin/courses/new", ensureAuth, ensureAdminEmails, (req, res) => renderBuilder(req, res, null));
router.get("/admin/courses/:id/edit", ensureAuth, ensureAdminEmails, async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) return res.status(404).send("Not found");
  return renderBuilder(req, res, course);
});
router.post("/admin/courses", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const b = req.body;
    const quizIds = (Array.isArray(b.quizIds) ? b.quizIds : [b.quizIds]).filter(Boolean).filter(id => mongoose.isValidObjectId(id));
    const picked = await Question.find({ _id: { $in: quizIds } }).select("_id series").lean();
    const unitMap = {};
    for (const p of picked) { const key = p.series || "general"; (unitMap[key] = unitMap[key] || { title: slugToLabel(key), seriesSlug: key, quizIds: [] }).quizIds.push(p._id); }
    const doc = {
      professionalArea: b.area, areaLabel: slugToLabel(b.area), title: b.title || slugToLabel(b.area),
      slug: b.slug ? slugify(b.slug) : slugify(b.title || b.area), description: b.description || "",
      level: ["foundation", "intermediate", "advanced"].includes(b.level) ? b.level : "foundation",
      org: req.user?.organization || null, role: "professional", units: Object.values(unitMap),
      rules: { perQuizPassMark: Number(b.perQuizPassMark) || 70, minQuizzesToPass: b.minQuizzesToPass === "" || b.minQuizzesToPass == null ? null : Number(b.minQuizzesToPass),
        minPerUnit: b.minPerUnit ? Number(b.minPerUnit) : null, overallPassMark: Number(b.overallPassMark) || 70,
        maxAttempts: Number(b.maxAttempts) || 3, cooldownHours: Number(b.cooldownHours) || 24, scoreModel: b.scoreModel === "latest" ? "latest" : "best",
        gradeBands: [{ label: "Pass", min: Number(b.bandPass) || 70 }, { label: "Merit", min: Number(b.bandMerit) || 80 }, { label: "Distinction", min: Number(b.bandDistinction) || 90 }] },
      weighting: b.weighting === "by_difficulty" ? "by_difficulty" : "equal",
      accessType: ["free", "paid", "invite"].includes(b.accessType) ? b.accessType : "free",
      price: Number(b.price) || 0, currency: b.currency || "USD",
      pillar: pillarOf(b.area) || null, customized: true, autoManaged: false,
      enrollmentOpen: b.enrollmentOpen === "on" || b.enrollmentOpen === "true", published: b.published === "on" || b.published === "true", createdBy: req.user._id };
    if (b.id && mongoose.isValidObjectId(b.id)) await Course.findByIdAndUpdate(b.id, doc); else await Course.create(doc);
    res.redirect("/admin/courses");
  } catch (e) { console.error("[course save]", e); res.status(500).send("Failed to save: " + e.message); }
});
router.post("/admin/courses/:id/publish", ensureAuth, ensureAdminEmails, async (req, res) => {
  const c = await Course.findById(req.params.id); if (!c) return res.status(404).send("Not found");
  c.published = !c.published; await c.save(); res.redirect("/admin/courses");
});
router.post("/admin/courses/:id/delete", ensureAuth, ensureAdminEmails, async (req, res) => { await Course.deleteOne({ _id: req.params.id }); res.redirect("/admin/courses"); });

// ── ADMIN: enrollments ──────────────────────────────────────────────────────
router.get("/admin/enrollments", ensureAuth, ensureAdminEmails, async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.course && mongoose.isValidObjectId(req.query.course)) filter.course = req.query.course;
  const enrs = await Enrollment.find(filter).sort({ updatedAt: -1 }).limit(300).populate("user", "displayName email").populate("course", "title slug").lean();
  const courses = await Course.find({}).select("_id title").lean();
  res.render("admin/enrollments", { layout: false, user: req.user, courses: courses.map(c => ({ id: String(c._id), title: c.title })),
    filterStatus: req.query.status || "", filterCourse: req.query.course || "",
    rows: enrs.map(e => ({ id: String(e._id), who: e.user?.displayName || e.user?.email || "-", email: e.user?.email || "", course: e.course?.title || "-",
      status: e.status, access: e.access, source: e.source, pay: e.payment?.status || "none", ref: e.payment?.reference || "", when: new Date(e.updatedAt).toLocaleDateString() })) });
});
router.post("/admin/enrollments/manual", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const user = await User.findOne({ email: emailRe(String(req.body.email || "").trim()) });
    const course = await Course.findById(req.body.courseId).lean();
    if (!user) return res.status(400).send("No user with that email. They must sign up first.");
    if (!course) return res.status(400).send("Course not found");
    let e = await Enrollment.findOne({ user: user._id, course: course._id });
    if (!e) e = new Enrollment({ user: user._id, course: course._id, org: course.org, access: course.accessType, source: "admin" });
    e.status = "active"; e.activatedAt = new Date(); e.activatedBy = req.user._id; e.source = "admin";
    await e.save();
    res.redirect("/admin/enrollments");
  } catch (e) { console.error("[manual enroll]", e); res.status(500).send("Failed: " + e.message); }
});
router.post("/admin/enrollments/:id/activate", ensureAuth, ensureAdminEmails, async (req, res) => {
  await activateEnrollment({ enrollmentId: req.params.id, adminId: req.user._id, provider: "manual" }); res.redirect("/admin/enrollments");
});
router.post("/admin/enrollments/:id/suspend", ensureAuth, ensureAdminEmails, async (req, res) => {
  await suspendEnrollment({ enrollmentId: req.params.id, adminId: req.user._id }); res.redirect(req.body.back || "/admin/enrollments");
});
// Reverse a course assignment entirely (remove access)
router.post("/admin/enrollments/:id/remove", ensureAuth, ensureAdminEmails, async (req, res) => {
  await Enrollment.deleteOne({ _id: req.params.id }); res.redirect(req.body.back || "/admin/enrollments");
});

// ── ADMIN: learner tracker (progress + knowledge map + assign/reverse) ───────
router.get("/admin/learners", ensureAuth, ensureAdminEmails, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q ? { $or: [{ email: emailRe(q) }, { displayName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }] } : {};
  const users = await User.find(filter).select("_id displayName email role").sort({ createdAt: -1 }).limit(200).lean();
  const ids = users.map(u => u._id);
  const agg = await Enrollment.aggregate([
    { $match: { user: { $in: ids } } },
    { $group: { _id: "$user", enrolled: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } } } }
  ]);
  const byUser = {}; for (const a of agg) byUser[String(a._id)] = a;
  res.render("admin/learners", {
    layout: false, user: req.user, q,
    rows: users.map(u => ({ id: String(u._id), name: u.displayName || "-", email: u.email || "", role: u.role,
      enrolled: byUser[String(u._id)]?.enrolled || 0, completed: byUser[String(u._id)]?.completed || 0 }))
  });
});
router.get("/admin/learners/:id", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const learner = await User.findById(req.params.id).select("_id displayName email role mobileRoles").lean();
    if (!learner) return res.status(404).send("Learner not found");
    const map = await getKnowledgeMap(learner._id);
    const enrs = await Enrollment.find({ user: learner._id }).populate("course", "title slug pillar professionalArea").sort({ updatedAt: -1 }).lean();
    const progresses = await CourseProgress.find({ user: learner._id }).lean();
    const pByCourse = {}; for (const p of progresses) pByCourse[String(p.course)] = p;
    const enrollments = enrs.map(e => {
      const pr = e.course ? pByCourse[String(e.course._id)] : null;
      return { id: String(e._id), course: e.course?.title || "-", slug: e.course?.slug || "",
        pillar: e.course?.pillar || (e.course ? pillarOf(e.course.professionalArea) : "") || "",
        status: e.status, access: e.access, source: e.source,
        overall: pr?.overallPercentage || 0, classification: pr?.classification || null,
        completed: pr?.status === "completed" };
    });
    const allCourses = await Course.find({ published: true }).select("_id title pillar").sort({ pillar: 1, title: 1 }).lean();
    res.render("admin/learner_detail", {
      layout: false, user: req.user,
      learner: { id: String(learner._id), name: learner.displayName || "-", email: learner.email, role: learner.role },
      map, enrollments,
      pillars: ALL_PILLARS.map(p => ({ slug: p, label: slugToLabel(p) })),
      allCourses: allCourses.map(c => ({ id: String(c._id), title: c.title, pillar: c.pillar }))
    });
  } catch (e) { console.error("[learner detail]", e); res.status(500).send("Error"); }
});
// Assign a single course to a learner (admin, instant active)
router.post("/admin/learners/:id/assign", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const course = await Course.findById(req.body.courseId).lean();
    if (!course) return res.status(400).send("Course not found");
    let e = await Enrollment.findOne({ user: req.params.id, course: course._id });
    if (!e) e = new Enrollment({ user: req.params.id, course: course._id, org: course.org, access: course.accessType, source: "admin" });
    e.status = "active"; e.activatedAt = new Date(); e.activatedBy = req.user._id; e.source = "admin";
    await e.save();
    res.redirect(`/admin/learners/${req.params.id}`);
  } catch (e) { console.error("[assign]", e); res.status(500).send("Failed: " + e.message); }
});
// Assign / reverse a whole module (all its published courses)
router.post("/admin/learners/:id/module-assign", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const courses = await Course.find({ published: true, pillar: req.body.pillar }).lean();
    for (const c of courses) {
      let e = await Enrollment.findOne({ user: req.params.id, course: c._id });
      if (!e) e = new Enrollment({ user: req.params.id, course: c._id, org: c.org, access: c.accessType, source: "admin" });
      e.status = "active"; e.activatedAt = new Date(); e.activatedBy = req.user._id; e.source = "admin";
      await e.save();
    }
    res.redirect(`/admin/learners/${req.params.id}`);
  } catch (e) { console.error("[module-assign]", e); res.status(500).send("Failed: " + e.message); }
});
router.post("/admin/learners/:id/module-unassign", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const courses = await Course.find({ pillar: req.body.pillar }).select("_id").lean();
    await Enrollment.deleteMany({ user: req.params.id, course: { $in: courses.map(c => c._id) } });
    res.redirect(`/admin/learners/${req.params.id}`);
  } catch (e) { console.error("[module-unassign]", e); res.status(500).send("Failed: " + e.message); }
});

// ── ADMIN: module capstones ─────────────────────────────────────────────────
router.get("/admin/module-tracks", ensureAuth, ensureAdminEmails, async (req, res) => {
  const tracks = await ModuleTrack.find({}).lean();
  const courses = await Course.find({}).select("_id title professionalArea").lean();
  res.render("admin/module_tracks", { layout: false, user: req.user, pillars: ALL_PILLARS.map(p => ({ slug: p, label: slugToLabel(p) })),
    tracks: tracks.map(t => ({ id: String(t._id), pillar: t.pillar, title: t.title, courses: (t.courseIds || []).length, published: t.published })),
    courses: courses.map(c => ({ id: String(c._id), title: c.title, pillar: pillarOf(c.professionalArea) })) });
});
router.post("/admin/module-tracks", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const b = req.body;
    const courseIds = (Array.isArray(b.courseIds) ? b.courseIds : [b.courseIds]).filter(Boolean).filter(id => mongoose.isValidObjectId(id));
    const doc = { pillar: b.pillar, title: b.title || `${slugToLabel(b.pillar)} - Module Mastery`, slug: slugify(b.slug || b.title || (b.pillar + "-mastery")), description: b.description || "",
      org: req.user?.organization || null, role: "professional", courseIds,
      rules: { minCoursesToComplete: b.minCoursesToComplete ? Number(b.minCoursesToComplete) : null, gradeBands: [{ label: "Pass", min: Number(b.bandPass) || 70 }, { label: "Merit", min: Number(b.bandMerit) || 80 }, { label: "Mastery", min: Number(b.bandMastery) || 90 }] },
      published: b.published === "on" || b.published === "true", createdBy: req.user._id };
    if (b.id && mongoose.isValidObjectId(b.id)) await ModuleTrack.findByIdAndUpdate(b.id, doc); else await ModuleTrack.create(doc);
    res.redirect("/admin/module-tracks");
  } catch (e) { console.error("[module track save]", e); res.status(500).send("Failed: " + e.message); }
});

export default router;
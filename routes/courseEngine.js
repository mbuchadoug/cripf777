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
        price: money(c), accessType: c.accessType, totalQuizzes: (c.units || []).reduce((n, u) => n + (u.quizIds || []).length, 0), state: e ? e.status : "browse" };
    });
    res.render("courses/index", { layout: false, user: req.user || null, authed, courses: view });
  } catch (e) { console.error("[catalog]", e); res.status(500).send("Error"); }
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
      return res.render("courses/detail", { ...base, mode: "locked",
        signupUrl: `/learn/signup?next=${encodeURIComponent("/courses/" + course.slug)}`,
        googleUrl: `/auth/google?returnTo=${encodeURIComponent("/courses/" + course.slug)}`,
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
  await suspendEnrollment({ enrollmentId: req.params.id, adminId: req.user._id }); res.redirect("/admin/enrollments");
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
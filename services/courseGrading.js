// services/courseGrading.js
// ─────────────────────────────────────────────────────────────────────────────
// The brain of the course engine. Two layers:
//   (1) PURE functions (no DB) - fully unit-testable: attribution, gate
//       evaluation, classification. These encode the world-class standard.
//   (2) DB functions - read existing Attempt records, roll up progress, and
//       issue certificates. Pull-based: safe to call on every course-page view.
//
// ATTRIBUTION: an Attempt is matched to a course quiz (a comprehension passage)
// by overlap between the attempt's served question ids and the passage's child
// question ids. Needs no changes to how quizzes are taken.
//
// GATES (both must pass to complete a course):
//   • BREADTH  - pass at least `minQuizzesToPass` of the selected quizzes
//                individually (and optionally `minPerUnit` within each unit)
//   • DEPTH    - weighted overall average ≥ `overallPassMark`
// Grade = highest band whose `min` the overall meets.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import mongoose from "mongoose";

import Course from "../models/course.js";
import CourseProgress from "../models/courseProgress.js";
import CourseCertificate from "../models/courseCertificate.js";
import ModuleTrack from "../models/moduleTrack.js";
import ModuleCertificate from "../models/moduleCertificate.js";
import Question from "../models/question.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";

import { slugToLabel } from "./courseTaxonomy.js";
import { generateCourseCertPdf } from "./courseCertPdf.js";
import { markEnrollmentCompleted } from "./enrollmentService.js";

// ── PURE: classification ─────────────────────────────────────────────────────
export function classify(overall, bands) {
  const list = (bands && bands.length ? bands : [
    { label: "Pass", min: 70 }, { label: "Merit", min: 80 }, { label: "Distinction", min: 90 }
  ]).slice().sort((a, b) => b.min - a.min);
  for (const b of list) if (overall >= b.min) return b.label;
  return list[list.length - 1].label; // passed the course rules; give lowest band
}

// ── PURE: attribute attempts to quizzes by question-id overlap ───────────────
// attempts: [{ questionIds:[...], percentage, finishedAt|updatedAt }]
// quizChildSets: Map<quizIdStr, Set<childIdStr>>
// → { quizIdStr: { percentage, attempts, lastAt } } (best attempt per quiz)
export function pickBestPerQuiz(attempts, quizChildSets) {
  const best = {};
  for (const a of attempts || []) {
    const ids = (a.questionIds || []).map(String);
    if (!ids.length) continue;
    let bestQuiz = null, bestOv = 0;
    for (const [qid, set] of quizChildSets) {
      let ov = 0;
      for (const id of ids) if (set.has(id)) ov++;
      if (ov > bestOv) { bestOv = ov; bestQuiz = qid; }
    }
    if (!bestQuiz || bestOv / ids.length < 0.5) continue; // not confidently this quiz
    const rec = best[bestQuiz] || { percentage: 0, attempts: 0, lastAt: null };
    rec.attempts += 1;
    const pct = Number(a.percentage) || 0;
    if (pct > rec.percentage) rec.percentage = pct;
    const at = a.finishedAt || a.updatedAt || null;
    if (at && (!rec.lastAt || new Date(at) > new Date(rec.lastAt))) rec.lastAt = at;
    best[bestQuiz] = rec;
  }
  return best;
}

// ── PURE: evaluate a course against a learner's best-per-quiz map ────────────
export function evaluateCourse(course, best, difficultyByQuiz = {}) {
  const rules = course.rules || {};
  const perQuizPass = rules.perQuizPassMark ?? 70;

  const allQuizIds = [];
  const unitOf = {};
  for (const u of (course.units || [])) {
    for (const q of (u.quizIds || [])) {
      const s = String(q);
      allQuizIds.push(s);
      unitOf[s] = u.title || "Unit";
    }
  }

  const perQuiz = allQuizIds.map(qid => {
    const r = best[qid] || { percentage: 0, attempts: 0, lastAt: null };
    return {
      quizId: qid,
      bestPercentage: Math.round(r.percentage || 0),
      attempts: r.attempts || 0,
      passed: (r.percentage || 0) >= perQuizPass,
      lastAttemptAt: r.lastAt || null,
      unit: unitOf[qid]
    };
  });

  const passed = perQuiz.filter(p => p.passed);
  const passedCount = passed.length;

  // weighted overall
  const weightFor = qid => course.weighting === "by_difficulty"
    ? (Number(difficultyByQuiz[qid]) || 3) : 1;
  let wsum = 0, wtot = 0;
  for (const p of perQuiz) { const w = weightFor(p.quizId); wsum += p.bestPercentage * w; wtot += w; }
  const overall = wtot ? Math.round(wsum / wtot) : 0;

  // breadth gate
  const need = rules.minQuizzesToPass != null ? rules.minQuizzesToPass : allQuizIds.length;
  const breadthOk = passedCount >= need;

  // per-unit gate (optional)
  let perUnitOk = true;
  if (rules.minPerUnit != null) {
    const byUnit = {};
    for (const p of perQuiz) {
      byUnit[p.unit] = byUnit[p.unit] || { total: 0, passed: 0 };
      byUnit[p.unit].total++;
      if (p.passed) byUnit[p.unit].passed++;
    }
    perUnitOk = Object.values(byUnit).every(u => u.passed >= rules.minPerUnit);
  }

  const depthOk = overall >= (rules.overallPassMark ?? 70);
  const complete = allQuizIds.length > 0 && breadthOk && perUnitOk && depthOk;

  return {
    perQuiz,
    passedCount,
    totalQuizzes: allQuizIds.length,
    overallPercentage: overall,
    breadthOk, perUnitOk, depthOk, complete,
    classification: complete ? classify(overall, rules.gradeBands) : null,
    unitsPassed: [...new Set(passed.map(p => p.unit))]
  };
}

// ── helpers for serials / verify codes ───────────────────────────────────────
function newVerifyCode() { return crypto.randomBytes(6).toString("hex").toUpperCase(); }
function newSerial(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}
function recipientName(user) {
  return user?.displayName ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username || user?.email || "Recipient";
}

// ── DB: recompute one learner's progress in one course, issue cert if earned ─
export async function recomputeCourseProgress({ userId, courseId }) {
  const course = await Course.findById(courseId).lean();
  if (!course) return null;

  const quizIds = [];
  for (const u of (course.units || [])) for (const q of (u.quizIds || [])) quizIds.push(String(q));
  if (!quizIds.length) return null;

  // Build child-id sets + per-quiz difficulty from the passage docs
  const passages = await Question.find({ _id: { $in: quizIds } })
    .select("_id questionIds quizTitle text meta").lean();
  const quizChildSets = new Map();
  const difficultyByQuiz = {};
  const titleByQuiz = {};
  for (const p of passages) {
    quizChildSets.set(String(p._id), new Set((p.questionIds || []).map(String)));
    difficultyByQuiz[String(p._id)] = p.meta?.aiDifficulty || 3;
    titleByQuiz[String(p._id)] = p.quizTitle || p.text || "Assessment";
  }

  // Learner's finished attempts (small set per user)
  const attempts = await Attempt.find({
    userId, status: { $in: ["finished", "in_progress"] }
  }).select("questionIds percentage finishedAt updatedAt status").lean();
  const finished = attempts.filter(a => a.status === "finished" || (a.percentage || 0) > 0);

  const best = pickBestPerQuiz(finished, quizChildSets);
  const ev = evaluateCourse(course, best, difficultyByQuiz);

  // Upsert progress
  const quizzes = ev.perQuiz.map(p => ({
    quizId: new mongoose.Types.ObjectId(p.quizId),
    bestPercentage: p.bestPercentage,
    attempts: p.attempts,
    passed: p.passed,
    lastAttemptAt: p.lastAttemptAt
  }));

  let progress = await CourseProgress.findOne({ user: userId, course: courseId });
  if (!progress) {
    progress = new CourseProgress({ user: userId, course: courseId, org: course.org, role: course.role });
  }
  progress.quizzes = quizzes;
  progress.passedCount = ev.passedCount;
  progress.overallPercentage = ev.overallPercentage;
  progress.unitsPassed = ev.unitsPassed;

  let certificate = progress.certificate ? await CourseCertificate.findById(progress.certificate) : null;

  if (ev.complete && progress.status !== "completed") {
    progress.status = "completed";
    progress.classification = ev.classification;
    progress.completedAt = new Date();
  }

  // Issue certificate once, when complete and not already issued
  if (ev.complete && !certificate) {
    const user = await User.findById(userId).lean();
    const org = course.org ? await Organization.findById(course.org).lean() : null;
    const passedQuizzes = ev.perQuiz.filter(p => p.passed);
    const verifyCode = newVerifyCode();

    const certDoc = {
      recipientName: recipientName(user),
      orgName: org?.name || "CRIPFCnt",
      courseTitle: course.title,
      moduleName: course.areaLabel || slugToLabel(course.professionalArea),
      level: slugToLabel(course.level || "foundation"),
      classification: ev.classification,
      overallPercentage: ev.overallPercentage,
      assessmentsPassed: ev.passedCount,
      assessmentsTotal: ev.totalQuizzes,
      totalQuestions: [...quizChildSets.values()].reduce((n, s) => n + s.size, 0),
      assessments: ev.perQuiz.map(p => ({ title: titleByQuiz[p.quizId] || "Assessment", percentage: p.bestPercentage })),
      verifyCode
    };

    let pdf = { url: null, verifyCode };
    try { pdf = await generateCourseCertPdf({ cert: certDoc, template: { tier: "area" } }); }
    catch (e) { console.error("[course cert pdf]", e.message); }

    certificate = await CourseCertificate.create({
      user: userId, org: course.org, course: courseId, role: course.role,
      ...certDoc, verifyCode: pdf.verifyCode || verifyCode,
      serial: newSerial("CRIP-C"), pdfUrl: pdf.url
    });
    progress.certificate = certificate._id;
  }

  await progress.save();

  // A completed course completes the enrollment too
  if (ev.complete) {
    await markEnrollmentCompleted({ userId, courseId }).catch(() => null);
  }

  // Cascade: a newly completed course may complete a module capstone
  let moduleResult = null;
  if (ev.complete) {
    moduleResult = await checkModuleCapstone({ userId, pillar: null, orgId: course.org, triggerCourseArea: course.professionalArea }).catch(() => null);
  }

  return { progress, evaluation: ev, certificate, moduleResult };
}

// ── DB: check + issue the module/pillar capstone ─────────────────────────────
export async function checkModuleCapstone({ userId, pillar, orgId, triggerCourseArea = null }) {
  // Resolve the track: by explicit pillar, or by the pillar of the course area
  let track;
  if (pillar) {
    track = await ModuleTrack.findOne({ pillar, org: orgId, published: true }).lean();
  } else if (triggerCourseArea) {
    const { pillarOf } = await import("./courseTaxonomy.js");
    const p = pillarOf(triggerCourseArea);
    if (!p) return null;
    track = await ModuleTrack.findOne({ pillar: p, org: orgId, published: true }).lean();
  }
  if (!track) return null;

  const memberIds = (track.courseIds || []).map(String);
  if (!memberIds.length) return null;

  const progresses = await CourseProgress.find({
    user: userId, course: { $in: memberIds }, status: "completed"
  }).select("course overallPercentage classification").lean();

  const completed = progresses.length;
  const need = track.rules?.minCoursesToComplete != null ? track.rules.minCoursesToComplete : memberIds.length;
  if (completed < need) return { earned: false, completed, need };

  // Already issued?
  const existing = await ModuleCertificate.findOne({ user: userId, track: track._id }).lean();
  if (existing) return { earned: true, already: true, certificate: existing };

  const overall = Math.round(progresses.reduce((n, p) => n + (p.overallPercentage || 0), 0) / progresses.length);
  const classification = classify(overall, track.rules?.gradeBands);

  const memberCourses = await Course.find({ _id: { $in: memberIds } }).select("_id title").lean();
  const titleById = {}; for (const c of memberCourses) titleById[String(c._id)] = c.title;

  const user = await User.findById(userId).lean();
  const org = orgId ? await Organization.findById(orgId).lean() : null;
  const verifyCode = newVerifyCode();

  const certData = {
    recipientName: recipientName(user),
    orgName: org?.name || "CRIPFCnt",
    courseTitle: track.title,
    moduleName: slugToLabel(track.pillar),
    level: "Module",
    classification,
    overallPercentage: overall,
    assessmentsPassed: completed,
    assessmentsTotal: memberIds.length,
    totalQuestions: 0,
    assessments: progresses.map(p => ({ title: titleById[String(p.course)] || "Course", percentage: p.overallPercentage || 0 })),
    verifyCode
  };

  let pdf = { url: null, verifyCode };
  try { pdf = await generateCourseCertPdf({ cert: certData, template: { tier: "module" } }); }
  catch (e) { console.error("[module cert pdf]", e.message); }

  const certificate = await ModuleCertificate.create({
    user: userId, org: orgId, track: track._id, pillar: track.pillar, role: track.role,
    recipientName: certData.recipientName, orgName: certData.orgName, moduleName: certData.moduleName,
    classification, overallPercentage: overall,
    coursesCompleted: completed, coursesTotal: memberIds.length,
    items: certData.assessments,
    verifyCode: pdf.verifyCode || verifyCode, serial: newSerial("CRIP-M"), pdfUrl: pdf.url
  });

  return { earned: true, certificate };
}
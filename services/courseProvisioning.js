// services/courseProvisioning.js
// ─────────────────────────────────────────────────────────────────────────────
// Turns your live assessment bank into a course catalog automatically:
//   • one COURSE per professional area (category)  → title = area label
//   • each course assigned to its MODULE (pillar) via the taxonomy
//   • a default set of quizzes auto-selected (count from settings, admin-tunable)
//   • units built by SERIES (matches the dashboard grouping)
//   • one MODULE TRACK (capstone) per pillar, bundling that pillar's courses
//
// Idempotent + safe to re-run. Courses an admin has hand-edited (customized=true)
// are left alone unless a force resync is requested.
// ─────────────────────────────────────────────────────────────────────────────
import Question from "../models/question.js";
import Course from "../models/course.js";
import ModuleTrack from "../models/moduleTrack.js";
import CourseEngineSettings from "../models/courseEngineSettings.js";
import { pillarOf, slugToLabel, ALL_PILLARS } from "./courseTaxonomy.js";

const slugify = s => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const bandRank = { easy: 1, foundation: 1, medium: 2, intermediate: 2, hard: 3, advanced: 3 };
function difficultyOf(p) {
  if (typeof p?.meta?.aiDifficulty === "number") return p.meta.aiDifficulty;
  const b = String(p?.meta?.difficultyBand || "").toLowerCase();
  return bandRank[b] || 2;
}

// ── PURE: choose up to `target` passages from an area, per strategy ──────────
// passages: [{ _id, series, meta }]. Returns an ordered array of passages.
export function selectQuizzes(passages, target, strategy = "balanced") {
  const list = [...(passages || [])];
  if (target != null && target <= 0) return [];                      // explicit none
  if (target == null || target >= list.length) return list;          // take all

  if (strategy === "first") return list.slice(0, target);
  if (strategy === "random") {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list.slice(0, target);
  }

  // balanced: spread across series (round-robin), easier passages first within a series
  const bySeries = {};
  for (const p of list) { const k = p.series || "general"; (bySeries[k] = bySeries[k] || []).push(p); }
  for (const k of Object.keys(bySeries)) bySeries[k].sort((a, b) => difficultyOf(a) - difficultyOf(b));
  // order series by size (largest first) so big series aren't starved
  const queues = Object.values(bySeries).sort((a, b) => b.length - a.length);
  const picked = [];
  let progress = true;
  while (picked.length < target && progress) {
    progress = false;
    for (const q of queues) { if (q.length) { picked.push(q.shift()); progress = true; if (picked.length >= target) break; } }
  }
  return picked;
}

// ── PURE: group selected passages into units by series ───────────────────────
export function buildUnits(selected) {
  const bySeries = {};
  for (const p of selected) {
    const key = p.series || "general";
    (bySeries[key] = bySeries[key] || { title: slugToLabel(key), seriesSlug: key, quizIds: [] }).quizIds.push(p._id);
  }
  return Object.values(bySeries);
}

// ── settings (org doc, else global, else defaults) ───────────────────────────
export async function getSettings(orgId = null) {
  let s = orgId ? await CourseEngineSettings.findOne({ org: orgId }) : null;
  if (!s) s = await CourseEngineSettings.findOne({ org: null });
  if (!s) {
    s = await CourseEngineSettings.create({
      org: orgId || null,
      moduleSettings: ALL_PILLARS.map(p => ({ pillar: p, quizzesPerCourse: null, minCoursesToComplete: null, enabled: true }))
    });
  }
  return s;
}

function targetForCategory(category, existingCourse, settings) {
  if (existingCourse?.quizTarget != null) return existingCourse.quizTarget;       // per-course override
  const pillar = pillarOf(category);
  const mod = (settings.moduleSettings || []).find(m => m.pillar === pillar);
  if (mod?.quizzesPerCourse != null) return mod.quizzesPerCourse;                 // per-module override
  return settings.defaultQuizzesPerCourse || 12;                                  // global default
}

// ── DB: (re)generate courses from the assessment bank ────────────────────────
export async function syncCoursesFromAssessments({ orgId = null, force = false, createdBy = null } = {}) {
  const settings = await getSettings(orgId);
  const match = { type: "comprehension", "meta.isOutOfScope": { $ne: true } };
  if (orgId) match.organization = orgId;

  const categories = (await Question.distinct("category", match))
    .filter(c => c && c !== "out-of-scope" && pillarOf(c)); // only mapped areas

  const summary = { created: 0, updated: 0, skipped: 0, courses: [] };

  for (const category of categories) {
    const passages = await Question.find({ ...match, category })
      .select("_id series meta").lean();
    if (!passages.length) continue;

    const pillar = pillarOf(category);
    const slug = slugify(category);
    let course = await Course.findOne({ professionalArea: category, ...(orgId ? { org: orgId } : { org: null }) });

    // Respect admin customization unless forced
    if (course && course.customized && !force) {
      summary.skipped++; summary.courses.push({ area: category, action: "skipped (customized)" }); continue;
    }

    const target = targetForCategory(category, course, settings);
    const selected = selectQuizzes(passages, target, settings.selectionStrategy);
    const units = buildUnits(selected);

    if (!course) {
      course = new Course({
        professionalArea: category, areaLabel: slugToLabel(category),
        title: slugToLabel(category), slug, pillar,
        description: `Professional competence in ${slugToLabel(category)}.`,
        level: settings.defaultLevel, org: orgId || null, role: "professional",
        units,
        rules: { perQuizPassMark: 70, minQuizzesToPass: null, minPerUnit: null, overallPassMark: 70, maxAttempts: 3, cooldownHours: 24, scoreModel: "best",
          gradeBands: [{ label: "Pass", min: 70 }, { label: "Merit", min: 80 }, { label: "Distinction", min: 90 }] },
        weighting: "equal",
        accessType: settings.defaultAccessType, price: settings.defaultPrice, currency: "USD", enrollmentOpen: true,
        autoManaged: true, customized: false, published: !!settings.autoPublish, createdBy
      });
      await course.save();
      summary.created++; summary.courses.push({ area: category, action: "created", quizzes: selected.length, pillar });
    } else {
      course.pillar = pillar; course.areaLabel = slugToLabel(category);
      course.units = units;
      if (settings.autoPublish && !course.published) course.published = true;
      await course.save();
      summary.updated++; summary.courses.push({ area: category, action: "updated", quizzes: selected.length, pillar });
    }
  }

  const tracks = await syncModuleTracks({ orgId, settings, createdBy });
  summary.tracks = tracks;
  return summary;
}

// ── DB: (re)generate one module capstone per pillar that has courses ─────────
export async function syncModuleTracks({ orgId = null, settings = null, createdBy = null } = {}) {
  settings = settings || await getSettings(orgId);
  const courses = await Course.find({ ...(orgId ? { org: orgId } : { org: null }) }).select("_id pillar professionalArea").lean();
  const byPillar = {};
  for (const c of courses) { const p = c.pillar || pillarOf(c.professionalArea); if (!p) continue; (byPillar[p] = byPillar[p] || []).push(c._id); }

  const out = { created: 0, updated: 0 };
  for (const [pillar, courseIds] of Object.entries(byPillar)) {
    const mod = (settings.moduleSettings || []).find(m => m.pillar === pillar);
    if (mod && mod.enabled === false) continue;
    const title = `${slugToLabel(pillar)} - Module Mastery`;
    let track = await ModuleTrack.findOne({ pillar, ...(orgId ? { org: orgId } : { org: null }) });
    const rules = { minCoursesToComplete: mod?.minCoursesToComplete ?? null,
      gradeBands: [{ label: "Pass", min: 70 }, { label: "Merit", min: 80 }, { label: "Mastery", min: 90 }] };
    if (!track) {
      await ModuleTrack.create({ pillar, title, slug: slugify(pillar + "-mastery"), description: `Mastery across the ${slugToLabel(pillar)} module.`,
        org: orgId || null, role: "professional", courseIds, rules, published: !!settings.autoPublish, createdBy });
      out.created++;
    } else {
      track.courseIds = courseIds; track.title = track.title || title;
      if (mod?.minCoursesToComplete !== undefined) track.rules.minCoursesToComplete = mod.minCoursesToComplete ?? null;
      if (settings.autoPublish && !track.published) track.published = true;
      await track.save();
      out.updated++;
    }
  }
  return out;
}

// ── DB: re-select quizzes for ONE course to a specific count ─────────────────
export async function refillCourse({ courseId, target = null, orgId = null }) {
  const course = await Course.findById(courseId);
  if (!course) return null;
  const settings = await getSettings(orgId);
  const match = { type: "comprehension", category: course.professionalArea, "meta.isOutOfScope": { $ne: true } };
  if (course.org) match.organization = course.org;
  const passages = await Question.find(match).select("_id series meta").lean();
  const t = target != null ? target : targetForCategory(course.professionalArea, course, settings);
  course.quizTarget = t;
  course.units = buildUnits(selectQuizzes(passages, t, settings.selectionStrategy));
  course.customized = false; // this is a deliberate auto-fill
  await course.save();
  return { course, quizzes: course.units.reduce((n, u) => n + u.quizIds.length, 0) };
}
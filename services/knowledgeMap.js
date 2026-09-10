// services/knowledgeMap.js
// ─────────────────────────────────────────────────────────────────────────────
// Turns a learner's enrollments + course progress into a "knowledge map":
//   • a mastery value (0–100) for each of the 8 CRIPFCnt modules/pillars
//   • per-pillar course counts (total / enrolled / completed) and a status
//   • overall mastery, strengths, gaps, and a single "what to do next" pick
//   • ready-to-draw radar geometry (server-side SVG, no client libs, prints)
//
// Pure functions (computeMap, radarGeometry) are unit-tested; getKnowledgeMap
// is the DB entry point used by the learner dashboard and the admin tracker.
// ─────────────────────────────────────────────────────────────────────────────
import Course from "../models/course.js";
import Enrollment from "../models/enrollment.js";
import CourseProgress from "../models/courseProgress.js";
import { ALL_PILLARS, slugToLabel, pillarOf } from "./courseTaxonomy.js";

const avg = a => a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0;

// ── PURE: build the map from plain arrays ────────────────────────────────────
// courses:     [{ _id, pillar, professionalArea, title, slug }]
// enrollments: [{ course, status }]                 (status: pending|active|completed|suspended)
// progresses:  [{ course, overallPercentage, status, classification }]
export function computeMap({ courses = [], enrollments = [], progresses = [] }) {
  const enrByCourse = {}; for (const e of enrollments) enrByCourse[String(e.course)] = e;
  const progByCourse = {}; for (const p of progresses) progByCourse[String(p.course)] = p;

  const byPillar = {};
  for (const c of courses) {
    const p = c.pillar || pillarOf(c.professionalArea) || "general";
    (byPillar[p] = byPillar[p] || []).push(c);
  }

  const pillars = ALL_PILLARS.map(pillar => {
    const list = byPillar[pillar] || [];
    const enrolled = list.filter(c => {
      const e = enrByCourse[String(c._id)];
      return e && (e.status === "active" || e.status === "completed");
    });
    const completed = enrolled.filter(c => {
      const e = enrByCourse[String(c._id)];
      const pr = progByCourse[String(c._id)];
      return e?.status === "completed" || pr?.status === "completed";
    });
    const vals = enrolled.map(c => Number(progByCourse[String(c._id)]?.overallPercentage) || 0);
    const value = Math.round(avg(vals));
    const status = completed.length ? "mastered" : enrolled.length ? "in_progress" : (list.length ? "available" : "empty");
    return {
      pillar, label: slugToLabel(pillar), value,
      coursesTotal: list.length, coursesEnrolled: enrolled.length, coursesCompleted: completed.length,
      status
    };
  });

  const active = pillars.filter(p => p.coursesTotal > 0);
  const overall = Math.round(avg(active.filter(p => p.coursesEnrolled > 0).map(p => p.value)));

  const strengths = pillars.filter(p => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 2).map(p => p.label);
  const gaps = active.filter(p => p.status !== "mastered").sort((a, b) => a.value - b.value).slice(0, 2).map(p => p.label);

  const counts = {
    enrolled: enrollments.filter(e => e.status === "active" || e.status === "completed").length,
    completed: progresses.filter(p => p.status === "completed").length,
    total: courses.length
  };

  // recommendation: furthest-along unfinished course, else an unstarted course in the weakest pillar
  let recommendation = null;
  const inProgress = courses
    .map(c => ({ c, pr: progByCourse[String(c._id)], e: enrByCourse[String(c._id)] }))
    .filter(x => x.e && x.e.status === "active" && (x.pr?.status !== "completed"))
    .sort((a, b) => (b.pr?.overallPercentage || 0) - (a.pr?.overallPercentage || 0));
  if (inProgress.length) {
    const x = inProgress[0];
    recommendation = { title: x.c.title, slug: x.c.slug, reason: "Closest to completion", pct: x.pr?.overallPercentage || 0 };
  } else {
    const weakest = active.filter(p => p.status !== "mastered").sort((a, b) => a.value - b.value)[0];
    const cand = weakest ? (byPillar[weakest.pillar] || []).find(c => {
      const e = enrByCourse[String(c._id)]; return !e || e.status === "pending";
    }) : null;
    if (cand) recommendation = { title: cand.title, slug: cand.slug, reason: `Strengthen your ${weakest.label}`, pct: 0 };
  }

  return { pillars, overall, strengths, gaps, counts, recommendation };
}

// ── PURE: radar geometry for N axes (server-rendered SVG) ────────────────────
export function radarGeometry(pillars, size = 260) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 34;
  const n = pillars.length || 1;
  const angleFor = i => (-90 + (360 / n) * i) * Math.PI / 180;

  const valuePoints = pillars.map((p, i) => {
    const r = R * (Math.max(0, Math.min(100, p.value)) / 100);
    const a = angleFor(i);
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

  const axes = pillars.map((p, i) => {
    const a = angleFor(i);
    const ex = cx + R * Math.cos(a), ey = cy + R * Math.sin(a);
    const lx = cx + (R + 16) * Math.cos(a), ly = cy + (R + 16) * Math.sin(a);
    return {
      x2: ex.toFixed(1), y2: ey.toFixed(1),
      lx: lx.toFixed(1), ly: ly.toFixed(1),
      anchor: Math.abs(Math.cos(a)) < 0.35 ? "middle" : (Math.cos(a) > 0 ? "start" : "end"),
      label: p.label, value: p.value
    };
  });

  const rings = [0.25, 0.5, 0.75, 1].map(f =>
    pillars.map((_, i) => {
      const a = angleFor(i);
      return `${(cx + R * f * Math.cos(a)).toFixed(1)},${(cy + R * f * Math.sin(a)).toFixed(1)}`;
    }).join(" ")
  );

  return { size, cx, cy, R, valuePoints, axes, rings };
}

// ── DB: assemble the map for one user ────────────────────────────────────────
export async function getKnowledgeMap(userId) {
  const [courses, enrollments, progresses] = await Promise.all([
    Course.find({ published: true }).select("_id pillar professionalArea title slug").lean(),
    Enrollment.find({ user: userId }).select("course status").lean(),
    CourseProgress.find({ user: userId }).select("course overallPercentage status classification").lean()
  ]);
  const map = computeMap({ courses, enrollments, progresses });
  map.radar = radarGeometry(map.pillars);
  return map;
}
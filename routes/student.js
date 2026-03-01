import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import OrgMembership from "../models/orgMembership.js";
import Organization from "../models/organization.js";
import { buildStudentDashboardData } from "../services/studentDashboardData.js";
import { getStudentKnowledgeMap } from "../services/topicMasteryTracker.js";

const router = Router();
const HOME_ORG_SLUG = "cripfcnt-home";

// routes/student.js
router.get("/student/dashboard", ensureAuth, async (req, res) => {
  if (req.user.role !== "student") return res.status(403).send("Not allowed");

  // ✅ prefer the org attached to the student user (same as parent flow)
  let org = null;

  if (req.user.organization) {
    org = await Organization.findById(req.user.organization).lean();
  }

  // fallback: membership org
  if (!org) {
    const membership = await OrgMembership
      .findOne({ user: req.user._id })
      .populate("org")
      .lean();
    if (!membership?.org) return res.status(403).send("No organization assigned");
    org = membership.org;
  }

  const data = await buildStudentDashboardData({ userId: req.user._id, org });
if (!data.quizzesBySubject || Object.keys(data.quizzesBySubject).length === 0) {
  console.warn("[StudentDashboard] No subject grouping found for student", req.user._id);
}

  return res.render("parent/child_quizzes", {
    user: req.user,
    child: req.user,
    org,
    ...data,
    parentIsPaid: true,
    isStudentView: true
  });
});


router.get("/student/knowledge-map", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "student") return res.status(403).send("Not allowed");

    // resolve org (same as your dashboard)
    let org = null;

    if (req.user.organization) {
      org = await Organization.findById(req.user.organization).lean();
    }

    if (!org) {
      const membership = await OrgMembership.findOne({ user: req.user._id }).populate("org").lean();
      if (!membership?.org) return res.status(403).send("No organization assigned");
      org = membership.org;
    }

    if (!org || org.slug !== HOME_ORG_SLUG) {
      return res.status(404).send("Knowledge map only available for home school students");
    }

    if (!req.user.grade) {
      return res.render("parent/knowledge_map", {
        user: req.user,
        child: req.user,
        error: "Grade not set. Please contact your teacher.",
        backUrl: "/student/dashboard",
        isStudentView: true
      });
    }

    const subjects = ["math", "english", "science", "responsibility"];

    const knowledgeMaps = {};
    for (const subject of subjects) {
      try {
        const map = await getStudentKnowledgeMap(req.user._id, subject, req.user.grade);
        if (map?.stats?.totalTopics > 0) knowledgeMaps[subject] = map;
      } catch (err) {
        console.error(`[StudentKnowledgeMap] Error getting ${subject}:`, err);
      }
    }

    return res.render("parent/knowledge_map", {
      user: req.user,
      child: req.user,
      knowledgeMaps,
      subjects,
      backUrl: "/student/dashboard",
      isStudentView: true
    });
  } catch (e) {
    console.error("[student knowledge-map]", e);
    return res.status(500).send("Failed to load knowledge map");
  }
});


export default router;

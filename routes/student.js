import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import OrgMembership from "../models/orgMembership.js";
import Organization from "../models/organization.js";
import { buildStudentDashboardData } from "../services/studentDashboardData.js";
import { getStudentKnowledgeMap } from "../services/topicMasteryTracker.js";

const router = Router();
const HOME_ORG_SLUG = "cripfcnt-home";

router.get("/student/dashboard", ensureAuth, async (req, res) => {
  if (req.user.role !== "student") return res.status(403).send("Not allowed");

  const membership = await OrgMembership
    .findOne({ user: req.user._id })
    .populate("org")
    .lean();

  if (!membership?.org?.slug) return res.status(403).send("No organization assigned");

  const org = membership.org;

  // ✅ MUST produce quizzesBySubject + practiceQuizzesBySubject etc.
  const data = await buildStudentDashboardData({ userId: req.user._id, org });

  let knowledgeMap = null;
  if (org.slug === HOME_ORG_SLUG && req.user.grade) {
    try {
      knowledgeMap = await getStudentKnowledgeMap(req.user._id, "math", req.user.grade);
    } catch (err) {
      console.error("[StudentDashboard] knowledge map error:", err);
    }
  }

  return res.render("parent/child_quizzes", {
    user: req.user,
    child: req.user,
    org,
    ...data,
    knowledgeMap,
    parentIsPaid: true,
    isStudentView: true
  });
});


export default router;

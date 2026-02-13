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

  return res.render("parent/child_quizzes", {
    user: req.user,
    child: req.user,
    org,
    ...data,
    parentIsPaid: true,
    isStudentView: true
  });
});



export default router;

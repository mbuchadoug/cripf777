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


/**
 * GET /student/materials
 * View learning materials assigned to student
 */
router.get("/student/materials", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "student") return res.status(403).send("Not allowed");

    const LearningMaterial = (await import("../models/learningMaterial.js")).default;
    
    const materials = await LearningMaterial.find({
      assignedTo: req.user._id,
      status: "active"
    })
    .sort({ createdAt: -1 })
    .populate("teacherId", "firstName lastName")
    .lean();

    // Group by subject
    const bySubject = {};
    for (const mat of materials) {
      const subj = mat.subject || 'general';
      if (!bySubject[subj]) bySubject[subj] = [];
      
      // Add metadata
      mat.fileSizeMB = mat.fileSize ? (mat.fileSize / 1024 / 1024).toFixed(2) : 0;
      
      // Get file type icon
      if (mat.fileType) {
        if (mat.fileType.startsWith('video/')) mat.icon = '🎥';
        else if (mat.fileType.startsWith('audio/')) mat.icon = '🎵';
        else if (mat.fileType.startsWith('image/')) mat.icon = '🖼️';
        else if (mat.fileType.includes('pdf')) mat.icon = '📄';
        else if (mat.fileType.includes('word')) mat.icon = '📝';
        else if (mat.fileType.includes('powerpoint') || mat.fileType.includes('presentation')) mat.icon = '📊';
        else mat.icon = '📎';
      } else {
        mat.icon = '📝'; // Text content
      }
      
      bySubject[subj].push(mat);
    }

    return res.render("student/materials", {
      user: req.user,
      child: req.user,
      materialsBySubject: bySubject,
      totalMaterials: materials.length
    });

  } catch (error) {
    console.error("[Student Materials Error]", error);
    return res.status(500).send("Failed to load materials");
  }
});

/**
 * GET /student/material/:id/view
 * View a specific learning material
 */
router.get("/student/material/:id/view", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "student") return res.status(403).send("Not allowed");

    const LearningMaterial = (await import("../models/learningMaterial.js")).default;
    
    const material = await LearningMaterial.findOne({
      _id: req.params.id,
      assignedTo: req.user._id,
      status: "active"
    })
    .populate("teacherId", "firstName lastName")
    .lean();

    if (!material) {
      return res.status(404).send("Material not found or not assigned to you");
    }

    // Increment view count
    await LearningMaterial.updateOne(
      { _id: material._id },
      { 
        $inc: { viewCount: 1 },
        $set: { lastViewedAt: new Date() }
      }
    );

    return res.render("student/material_view", {
      user: req.user,
      child: req.user,
      material
    });

  } catch (error) {
    console.error("[Student Material View Error]", error);
    return res.status(500).send("Failed to load material");
  }
});

/**
 * GET /student/live-classes
 * View assigned live classes
 */
router.get("/student/live-classes", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "student") return res.status(403).send("Not allowed");

    const LiveClass = (await import("../models/liveClass.js")).default;
    
    const now = new Date();

    // Upcoming classes where student is expected
    const upcoming = await LiveClass.find({
      expectedStudents: req.user._id,
      status: { $in: ['scheduled', 'live'] },
      scheduledStart: { $gte: now }
    })
    .sort({ scheduledStart: 1 })
    .populate("teacherId", "firstName lastName")
    .lean();

    // Currently live
    const live = await LiveClass.find({
      expectedStudents: req.user._id,
      status: 'live'
    })
    .populate("teacherId", "firstName lastName")
    .lean();

    // Past classes
    const past = await LiveClass.find({
      "attendees.studentId": req.user._id,
      status: 'ended'
    })
    .sort({ scheduledStart: -1 })
    .limit(10)
    .populate("teacherId", "firstName lastName")
    .lean();

    return res.render("student/live_classes", {
      user: req.user,
      child: req.user,
      upcoming,
      live,
      past
    });

  } catch (error) {
    console.error("[Student Live Classes Error]", error);
    return res.status(500).send("Failed to load live classes");
  }
});

/**
 * GET /student/live-class/:id/join
 * Join a live class
 */
router.get("/student/live-class/:id/join", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "student") return res.status(403).send("Not allowed");

    const LiveClass = (await import("../models/liveClass.js")).default;
    
    const liveClass = await LiveClass.findOne({
      _id: req.params.id,
      expectedStudents: req.user._id
    })
    .populate("teacherId", "firstName lastName")
    .lean();

    if (!liveClass) {
      return res.status(404).send("Live class not found or you're not invited");
    }

    if (liveClass.status !== 'live') {
      return res.status(400).send("This class is not currently live");
    }

    return res.render("student/live_class_room", {
      user: req.user,
      child: req.user,
      liveClass
    });

  } catch (error) {
    console.error("[Student Join Live Class Error]", error);
    return res.status(500).send("Failed to join live class");
  }
});

export default router;

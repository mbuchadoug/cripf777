// routes/privateTeacher.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import AIQuiz from "../models/aiQuiz.js";
import { generateAIQuiz, assignAIQuizToStudents } from "../services/aiQuizGenerator.js";

import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import crypto from "crypto";
import multer from "multer";
import Attempt from "../models/attempt.js";

const upload = multer({ storage: multer.memoryStorage() });





const router = Router();

// ✅ Middleware: Ensure private teacher
function ensurePrivateTeacher(req, res, next) {
  if (req.user.role !== "private_teacher") {
    return res.status(403).send("Private teachers only");
  }
  next();
}

/**
 * GET /teacher/dashboard
 * Main dashboard for private teachers
 */
router.get(
  "/dashboard",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id);

    // Redirect to setup if not configured
    if (teacher.needsProfileSetup || !teacher.schoolLevelsEnabled?.length) {
      return res.redirect("/teacher/setup");
    }

    // Reset credits if needed
    teacher.resetAIQuizCredits();
    await teacher.save();

    const students = await User.find({
      parentUserId: teacher._id,
      role: "student"
    }).lean();

    const aiQuizzes = await AIQuiz.find({
      teacherId: teacher._id,
      status: "active"
    }).sort({ createdAt: -1 }).lean();

    const ExamInstance = (await import("../models/examInstance.js")).default;
    const Attempt = (await import("../models/attempt.js")).default;

    // Get assignment counts
    for (const quiz of aiQuizzes) {
      quiz.assignedCount = await ExamInstance.countDocuments({
        "meta.aiQuizId": quiz._id
      });
    }

    // ✅ Compute subscription status
    const now = new Date();
    const subExpires = teacher.teacherSubscriptionExpiresAt
      ? new Date(teacher.teacherSubscriptionExpiresAt)
      : null;
    const isExpired = subExpires && now >= subExpires;
    const daysRemaining = subExpires && !isExpired
      ? Math.ceil((subExpires - now) / (1000 * 60 * 60 * 24))
      : 0;
    const isPaid = teacher.teacherSubscriptionStatus === "paid" && !isExpired;

    // ✅ Student performance data
    const studentPerformance = [];
    for (const student of students) {
      const attempts = await Attempt.find({
        userId: student._id,
        status: "finished"
      }).select("percentage passed module").lean();

      const avgScore = attempts.length
        ? Math.round(attempts.reduce((s, a) => s + (a.percentage || 0), 0) / attempts.length)
        : null;
      const passRate = attempts.length
        ? Math.round((attempts.filter(a => a.passed).length / attempts.length) * 100)
        : null;

      studentPerformance.push({
        _id: student._id,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        quizCount: attempts.length,
        avgScore,
        passRate
      });
    }

    // Sort: best and worst performers
    const withScores = studentPerformance.filter(s => s.avgScore !== null);
    const topPerformers = [...withScores].sort((a, b) => b.avgScore - a.avgScore).slice(0, 5);
    const lowPerformers = [...withScores].sort((a, b) => a.avgScore - b.avgScore).slice(0, 5);

    // ✅ Load system quizzes based on school levels
    const Question = (await import("../models/question.js")).default;
    const Organization = (await import("../models/organization.js")).default;
    const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();

    let systemQuizzes = [];
    if (homeOrg) {
      const levelFilter = teacher.schoolLevelsEnabled || [];
      const gradeRanges = [];
      if (levelFilter.includes("junior")) gradeRanges.push({ $gte: 1, $lte: 7 });
      if (levelFilter.includes("high")) gradeRanges.push({ $gte: 8, $lte: 13 });

      // Build grade query
      let gradeQuery = {};
      if (gradeRanges.length === 1) {
        gradeQuery = { grade: gradeRanges[0] };
      } else if (gradeRanges.length === 2) {
        gradeQuery = { $or: gradeRanges.map(r => ({ grade: r })) };
      }

      const QuizRule = (await import("../models/quizRule.js")).default;
      systemQuizzes = await QuizRule.find({
        org: homeOrg._id,
        enabled: true,
        ...gradeQuery
      }).select("quizTitle subject grade module quizType questionCount durationMinutes").lean();
    }

    res.render("teacher/dashboard", {
      user: teacher,
      students,
      aiQuizzes,
      studentLimit: teacher.getTeacherChildLimit(),
      planLabel: teacher.getTeacherPlanLabel(),
      aiCredits: teacher.aiQuizCredits || 0,
      canAddStudent: isPaid && students.length < teacher.getTeacherChildLimit(),
      isPaid,
      isExpired,
      daysRemaining,
      expiresAt: subExpires ? subExpires.toISOString().slice(0, 10) : null,
      canGenerateAI: isPaid && (teacher.aiQuizCredits || 0) > 0,
      topPerformers,
      lowPerformers,
      systemQuizzes,
      schoolLevels: teacher.schoolLevelsEnabled || []
    });
  }
);

/**
 * POST /teacher/generate-quiz
 * Generate AI quiz
 */
router.post(
  "/generate-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { subject, grade, topic, difficulty, questionCount } = req.body;

      if (!subject || !grade || !topic || !difficulty) {
        return res.status(400).json({
          error: "Missing required fields"
        });
      }

      const aiQuiz = await generateAIQuiz({
        teacherId: req.user._id,
        subject,
        grade: Number(grade),
        topic,
        difficulty,
        questionCount: Number(questionCount) || 10
      });

      return res.json({
        success: true,
        quiz: aiQuiz
      });

    } catch (error) {
      console.error("[Generate Quiz Error]", error);
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/**
 * POST /teacher/assign-quiz
 * Assign AI quiz to students
 */
router.post(
  "/assign-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { quizId, studentIds } = req.body;

      if (!quizId || !Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({
          error: "Quiz ID and student IDs required"
        });
      }

      const assignments = await assignAIQuizToStudents({
        aiQuizId: quizId,
        studentIds,
        teacherId: req.user._id
      });

      return res.json({
        success: true,
        assigned: assignments.length,
        skipped: studentIds.length - assignments.length
      });

    } catch (error) {
      console.error("[Assign Quiz Error]", error);
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/**
 * GET /teacher/quizzes
 * List all AI-generated quizzes
 */
router.get(
  "/quizzes",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quizzes = await AIQuiz.find({
      teacherId: req.user._id,
      status: "active"
    }).sort({ createdAt: -1 }).lean();

    res.render("teacher/quizzes", {
      user: req.user,
      quizzes
    });
  }
);

/**
 * GET /teacher/quiz/:id
 * View single AI quiz with details
 */
router.get(
  "/quiz/:id",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quiz = await AIQuiz.findOne({
      _id: req.params.id,
      teacherId: req.user._id
    }).lean();

    if (!quiz) {
      return res.status(404).send("Quiz not found");
    }

    const ExamInstance = (await import("../models/examInstance.js")).default;
    
    const assignments = await ExamInstance.find({
      "meta.aiQuizId": quiz._id
    }).populate("userId", "firstName lastName").lean();

    res.render("teacher/quiz_detail", {
      user: req.user,
      quiz,
      assignments
    });
  }
);



// Add this temporary route to routes/privateTeacher.js (remove after use)
router.get(
  "/reset-credits",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id);
    
    teacher.teacherSubscriptionPlan = "starter";
    teacher.aiQuizCredits = 20;
    teacher.aiQuizCreditsResetAt = new Date();
    await teacher.save();
    
    res.json({
      success: true,
      credits: teacher.aiQuizCredits,
      plan: teacher.teacherSubscriptionPlan
    });
  }
);




/**
 * GET /teacher/quiz/:id/preview
 * Preview AI quiz before assigning
 */
router.get(
  "/quiz/:id/preview",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quiz = await AIQuiz.findOne({
      _id: req.params.id,
      teacherId: req.user._id
    }).lean();

    if (!quiz) {
      return res.status(404).send("Quiz not found");
    }

    res.render("teacher/quiz_preview", {
      user: req.user,
      quiz
    });
  }
);

/**
 * GET /teacher/pricing
 * Teacher pricing plans
 */
router.get(
  "/pricing",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id);
    res.render("teacher/pricing", {
      user: teacher,
      currentPlan: teacher.teacherSubscriptionPlan || "trial",
      currentCredits: teacher.aiQuizCredits || 0
    });
  }
);

/**
 * GET /teacher/student/:studentId/progress
 * View student progress (redirect to parent route)
 */
router.get(
  "/student/:studentId/progress",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const student = await User.findOne({
      _id: req.params.studentId,
      parentUserId: req.user._id,
      role: "student"
    });

    if (!student) {
      return res.status(404).send("Student not found");
    }

    return res.redirect(`/parent/children/${req.params.studentId}/quizzes`);
  }
);

/**
 * GET /teacher/student/:studentId/knowledge-map
 * View student knowledge map
 */
router.get(
  "/student/:studentId/knowledge-map",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const student = await User.findOne({
      _id: req.params.studentId,
      parentUserId: req.user._id,
      role: "student"
    });

    if (!student) {
      return res.status(404).send("Student not found");
    }

    return res.redirect(`/parent/children/${req.params.studentId}/knowledge-map`);
  }
);




/**
 * GET /teacher/upload-quiz
 * Show quiz upload form
 */
router.get(
  "/upload-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    res.render("teacher/upload_quiz", { user: req.user });
  }
);

/**
 * POST /teacher/upload-quiz
 * Upload quiz JSON (same format as admin import)
 */
router.post(
  "/upload-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  upload.single("quizFile"),
  async (req, res) => {
    try {
      const { subject, grade, quizTitle, durationMinutes } = req.body;
      
      if (!subject || !grade || !quizTitle) {
        return res.status(400).json({ error: "Subject, grade, and title required" });
      }

      let questions = [];
      
      // Parse from file upload
      if (req.file) {
        const raw = req.file.buffer.toString("utf8");
        questions = JSON.parse(raw);
      } 
      // Parse from textarea
      else if (req.body.questionsJson) {
        questions = JSON.parse(req.body.questionsJson);
      }

      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "No valid questions found" });
      }

      // Get home org
      const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
      if (!org) return res.status(500).json({ error: "Home org not found" });

      // Validate and normalize questions
      const validQuestions = questions.map((q, idx) => {
        if (!q.text || !Array.isArray(q.choices) || q.choices.length < 2) {
          throw new Error(`Question ${idx + 1}: missing text or choices`);
        }
        
        const correctIndex = typeof q.correctIndex === "number" 
          ? q.correctIndex 
          : (typeof q.answerIndex === "number" ? q.answerIndex : 0);

      return {
  text: q.text.trim(),

  // ✅ YOUR schema expects embedded objects with label + text
  choices: q.choices.map((choiceText, i) => ({
    label: String.fromCharCode(65 + i), // A, B, C, D
    text: String(choiceText).trim()
  })),

  correctIndex: q.correctIndex,
  explanation: q.explanation || null,

  tags: [],
  difficulty: 2, // must be number 1–5 (your schema requires Number)

  subject: subject.toLowerCase(),
  grade: Number(grade),
  module: subject.toLowerCase(),

  organization: org._id,
  teacherId: req.user._id,

  // ✅ IMPORTANT: your enum only allows these:
  type: "question",

  meta: {
    uploadedBy: req.user._id,
    isTeacherUpload: true,
    source: "plain_text"
  }
};

      });

      // Insert questions into DB
      const insertedQuestions = await Question.insertMany(validQuestions);

      // Create a parent question to group them
      const parentQuestion = await Question.create({
        text: quizTitle,
        type: "comprehension",
        passage: `${quizTitle} - ${subject} Grade ${grade}`,
        questionIds: insertedQuestions.map(q => q._id),
        organization: org._id,
        module: subject.toLowerCase(),
        subject: subject.toLowerCase(),
        grade: Number(grade),
        teacherId: req.user._id,
        meta: { isTeacherUpload: true }
      });

      // Also save as AIQuiz for teacher's quiz list
      const aiQuiz = await AIQuiz.create({
        teacherId: req.user._id,
        title: quizTitle,
        subject: subject.toLowerCase(),
        grade: Number(grade),
        topic: quizTitle,
        difficulty: (AIQuiz.schema?.path("difficulty")?.enumValues || [])[0] || "medium",
        questionCount: insertedQuestions.length,
        questions: insertedQuestions.map(q => ({
          text: q.text,
          choices: q.choices,
          correctIndex: q.correctIndex,
          explanation: q.explanation || ""
        })),
        durationMinutes: Number(durationMinutes) || 30,
        aiProvider: "manual_upload",
        status: "active",
        meta: {
          parentQuestionId: parentQuestion._id,
          isManualUpload: true
        }
      });

      return res.json({
        success: true,
        quizId: aiQuiz._id,
        questionCount: insertedQuestions.length
      });

    } catch (error) {
      console.error("[Upload Quiz Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);



/**
 * POST /teacher/upload-quiz-text
 * Upload quiz in plain text format (admin-like)
 */
router.post(
  "/upload-quiz-text",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const plainText = String(req.body?.plainText || "").trim();
      if (!plainText) {
        return res.status(400).json({ error: "Plain text is required" });
      }

      const parsed = parsePlainTextQuiz(plainText);
      const { quizTitle, subject, grade, durationMinutes, passage, questions } = parsed;

      if (!quizTitle || !subject || !grade) {
        return res.status(400).json({ error: "TITLE, SUBJECT, and GRADE are required" });
      }
      if (!questions.length) {
        return res.status(400).json({ error: "No questions found. Use Q1) ... A) ... ANSWER: B" });
      }

      // Get home org
      const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
      if (!org) return res.status(500).json({ error: "Home org not found" });

      // Insert MCQ questions
           const validQuestions = questions.map((q, idx) => {
        if (!q.text || !Array.isArray(q.choices) || q.choices.length < 2) {
          throw new Error(`Question ${idx + 1}: missing text or choices`);
        }
        if (typeof q.correctIndex !== "number" || q.correctIndex < 0 || q.correctIndex >= q.choices.length) {
          throw new Error(`Question ${idx + 1}: invalid ANSWER`);
        }

        // ✅ determine allowed Question.type enum at runtime (so we never guess)
        const allowedTypes = (Question.schema?.path("type")?.enumValues || []);
        const VALID_TYPE = allowedTypes.includes("mcq")
          ? "mcq"
          : (allowedTypes[0] || undefined);

        if (!VALID_TYPE) {
          throw new Error("Question schema has no valid enum values for `type`");
        }

        return {
          text: q.text.trim(),

          // ✅ embedded choices (your schema expects objects, not strings)
          choices: q.choices.map(t => ({ text: String(t).trim() })),

          correctIndex: q.correctIndex,
          explanation: q.explanation || null,
          tags: [],
          
          // ✅ difficulty must be a Number in YOUR schema
          difficulty: 2,

          subject: subject.toLowerCase(),
          grade: Number(grade),
          module: subject.toLowerCase(),
          organization: org._id,
          teacherId: req.user._id,

          // ✅ type must match enum
          type: VALID_TYPE,

          meta: { uploadedBy: req.user._id, isTeacherUpload: true, source: "plain_text" }
        };
      });

      const insertedQuestions = await Question.insertMany(validQuestions);

      // Create comprehension parent (stores passage/instructions)
      const parentQuestion = await Question.create({
        text: quizTitle,
        type: "comprehension",
        passage: passage || `${quizTitle} - ${subject} Grade ${grade}`,
        questionIds: insertedQuestions.map(q => q._id),
        organization: org._id,
        module: subject.toLowerCase(),
        subject: subject.toLowerCase(),
        grade: Number(grade),
        teacherId: req.user._id,
        meta: { isTeacherUpload: true, source: "plain_text" }
      });

      // Also save as AIQuiz for teacher list (same as JSON upload behavior)
      const aiQuiz = await AIQuiz.create({
        teacherId: req.user._id,
        title: quizTitle,
        subject: subject.toLowerCase(),
        grade: Number(grade),
        topic: quizTitle,
     difficulty: (AIQuiz.schema?.path("difficulty")?.enumValues || [])[0] || "medium",

        questionCount: insertedQuestions.length,
        questions: insertedQuestions.map(q => ({
          text: q.text,
          choices: q.choices,
          correctIndex: q.correctIndex,
          explanation: q.explanation || ""
        })),
        durationMinutes: Number(durationMinutes) || 30,
        aiProvider: "plain_text_upload",
        status: "active",
        meta: { parentQuestionId: parentQuestion._id, isManualUpload: true, source: "plain_text" }
      });

      return res.json({
        success: true,
        quizId: aiQuiz._id,
        questionCount: insertedQuestions.length
      });

    } catch (error) {
      console.error("[Upload Plain Text Quiz Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /teacher/bulk-assign
 * Assign multiple quizzes to multiple students with duration
 */
router.post(
  "/bulk-assign",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { quizIds, studentIds, durationMinutes } = req.body;

      if (!Array.isArray(quizIds) || !quizIds.length) {
        return res.status(400).json({ error: "Select at least one quiz" });
      }
      if (!Array.isArray(studentIds) || !studentIds.length) {
        return res.status(400).json({ error: "Select at least one student" });
      }

      const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
      if (!org) return res.status(500).json({ error: "Home org not found" });

      let totalAssigned = 0;
      let totalSkipped = 0;

      for (const quizId of quizIds) {
        const aiQuiz = await AIQuiz.findOne({
          _id: quizId,
          teacherId: req.user._id
        }).lean();

        if (!aiQuiz) continue;

        for (const studentId of studentIds) {
          // Check if already assigned
          const existing = await ExamInstance.findOne({
            userId: studentId,
            "meta.aiQuizId": quizId
          }).lean();

          if (existing) {
            totalSkipped++;
            continue;
          }

          const student = await User.findById(studentId).select("organization").lean();

          const examId = crypto.randomUUID();
          await ExamInstance.create({
            examId,
            userId: studentId,
            org: student?.organization || org._id,
            title: aiQuiz.title,
            quizTitle: aiQuiz.title,
            module: aiQuiz.subject,
            subject: aiQuiz.subject,
            grade: aiQuiz.grade,
            targetRole: "student",
            status: "pending",
            durationMinutes: Number(durationMinutes) || aiQuiz.durationMinutes || (aiQuiz.questionCount * 2),
            questionIds: aiQuiz.questions.map((_, idx) => `ai:${quizId}:${idx}`),
            choicesOrder: aiQuiz.questions.map(q =>
              Array.from({ length: q.choices.length }, (_, i) => i)
            ),
            meta: {
              aiQuizId: quizId,
              isAIGenerated: true,
              teacherId: req.user._id,
              difficulty: aiQuiz.difficulty
            }
          });

          // Track assignment
          await AIQuiz.updateOne(
            { _id: quizId },
            { $push: { assignedTo: { studentId, assignedAt: new Date() } } }
          );

          totalAssigned++;
        }
      }

      return res.json({
        success: true,
        assigned: totalAssigned,
        skipped: totalSkipped
      });

    } catch (error) {
      console.error("[Bulk Assign Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /teacher/upload-material
 * Upload learning material for students
 */
router.post(
  "/upload-material",
  ensureAuth,
  ensurePrivateTeacher,
  upload.single("materialFile"),
  async (req, res) => {
    try {
      const { title, subject, grade, description, studentIds } = req.body;
      
      if (!title || !subject || !grade) {
        return res.status(400).json({ error: "Title, subject, and grade required" });
      }

      const LearningMaterial = (await import("../models/learningMaterial.js")).default;
      
      let fileUrl = null;
      let fileType = null;

      if (req.file) {
        const fs = (await import("fs")).default;
        const path = (await import("path")).default;
        
        const uploadsDir = path.join(process.cwd(), "public", "uploads", "materials");
        await fs.promises.mkdir(uploadsDir, { recursive: true });
        
        const filename = `material-${Date.now()}-${req.file.originalname}`;
        const filepath = path.join(uploadsDir, filename);
        await fs.promises.writeFile(filepath, req.file.buffer);
        
        fileUrl = `/uploads/materials/${filename}`;
        fileType = req.file.mimetype;
      }

      // Parse content from textarea if provided
      const content = req.body.content || null;

      const material = await LearningMaterial.create({
        teacherId: req.user._id,
        title,
        subject: subject.toLowerCase(),
        grade: Number(grade),
        description: description || "",
        content,
        fileUrl,
        fileType,
        assignedTo: Array.isArray(studentIds) ? studentIds : (studentIds ? [studentIds] : []),
        status: "active"
      });

      return res.json({ success: true, materialId: material._id });

    } catch (error) {
      console.error("[Upload Material Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /teacher/materials
 * List all learning materials
 */
router.get(
  "/materials",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const LearningMaterial = (await import("../models/learningMaterial.js")).default;
    
    const materials = await LearningMaterial.find({
      teacherId: req.user._id,
      status: "active"
    }).sort({ createdAt: -1 }).lean();

    const students = await User.find({
      parentUserId: req.user._id,
      role: "student"
    }).lean();

    res.render("teacher/materials", {
      user: req.user,
      materials,
      students
    });
  }
);

/**
 * GET /teacher/quiz/:id/assignments
 * View who has been assigned a quiz and their results
 */
router.get(
  "/quiz/:id/assignments",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quiz = await AIQuiz.findOne({
      _id: req.params.id,
      teacherId: req.user._id
    }).lean();

    if (!quiz) return res.status(404).send("Quiz not found");

    const ExamInst = (await import("../models/examInstance.js")).default;
    
    const assignments = await ExamInst.find({
      "meta.aiQuizId": quiz._id
    }).lean();

    // Get student details and attempt results
    const enriched = [];
    for (const assign of assignments) {
      const student = await User.findById(assign.userId)
        .select("firstName lastName grade")
        .lean();
      
      const attempt = await Attempt.findOne({
        examId: assign.examId,
        userId: assign.userId,
        status: "finished"
      }).lean();

      enriched.push({
        ...assign,
        student,
        attempt,
        completed: !!attempt,
        score: attempt?.percentage || null
      });
    }

    res.render("teacher/quiz_assignments", {
      user: req.user,
      quiz,
      assignments: enriched
    });
  }
);





/**
 * POST /teacher/generate-report
 * Generate AI assessment report
 */
router.post(
  "/generate-report",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { studentIds, subject, dateFrom, dateTo, teacherNotes } = req.body;
      
      if (!Array.isArray(studentIds) || !studentIds.length) {
        return res.status(400).json({ error: "Select at least one student" });
      }

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      // Build data for each student
      const studentReports = [];
      
      for (const studentId of studentIds) {
        const student = await User.findOne({
          _id: studentId,
          parentUserId: req.user._id,
          role: "student"
        }).select("firstName lastName grade").lean();

        if (!student) continue;

        // Build query for attempts
        const attemptQuery = {
          userId: studentId,
          status: "finished"
        };

        if (subject && subject !== "all") {
          attemptQuery.module = subject.toLowerCase();
        }

        if (dateFrom || dateTo) {
          attemptQuery.finishedAt = {};
          if (dateFrom) attemptQuery.finishedAt.$gte = new Date(dateFrom);
          if (dateTo) attemptQuery.finishedAt.$lte = new Date(dateTo + "T23:59:59Z");
        }

        const attempts = await Attempt.find(attemptQuery)
          .sort({ finishedAt: 1 })
          .lean();

        // Group by subject
        const bySubject = {};
        for (const a of attempts) {
          const subj = a.module || "general";
          if (!bySubject[subj]) bySubject[subj] = [];
          bySubject[subj].push({
            title: a.quizTitle || "Quiz",
            score: a.score,
            maxScore: a.maxScore,
            percentage: a.percentage || Math.round((a.score / Math.max(1, a.maxScore)) * 100),
            passed: a.passed,
            date: a.finishedAt,
            duration: a.duration
          });
        }

        studentReports.push({
          name: `${student.firstName} ${student.lastName || ""}`.trim(),
          grade: student.grade,
          totalQuizzes: attempts.length,
          avgScore: attempts.length
            ? Math.round(attempts.reduce((s, a) => s + (a.percentage || 0), 0) / attempts.length)
            : 0,
          passRate: attempts.length
            ? Math.round((attempts.filter(a => a.passed).length / attempts.length) * 100)
            : 0,
          bySubject
        });
      }

      if (!studentReports.length) {
        return res.status(400).json({ error: "No student data found" });
      }

      // Build AI prompt
      const prompt = `You are an experienced educational assessment specialist. Generate a detailed, professional student assessment report based on the following data.

TEACHER NOTES/INSTRUCTIONS: ${teacherNotes || "None provided"}

STUDENT DATA:
${JSON.stringify(studentReports, null, 2)}

DATE RANGE: ${dateFrom || "All time"} to ${dateTo || "Present"}
SUBJECT FILTER: ${subject || "All subjects"}

Generate a comprehensive report in the following JSON structure:
{
  "reportTitle": "Student Assessment Report",
  "generatedDate": "${new Date().toISOString().slice(0, 10)}",
  "summary": "Executive summary paragraph",
  "students": [
    {
      "name": "Student Name",
      "grade": 1,
      "overallAssessment": "Detailed paragraph about overall performance",
      "strengths": ["strength 1", "strength 2"],
      "areasForImprovement": ["area 1", "area 2"],
      "subjectAnalysis": [
        {
          "subject": "math",
          "performance": "Detailed analysis",
          "grade": "A/B/C/D/E",
          "trend": "improving/stable/declining",
          "recommendations": "Specific recommendations"
        }
      ],
      "recommendations": "Personalized next steps paragraph"
    }
  ],
  "classOverview": "Overall class analysis if multiple students",
  "teacherRecommendations": "Professional recommendations for the teacher"
}

Return ONLY valid JSON, no markdown or extra text.`;

      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
      });

      const content = message.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        throw new Error("Failed to parse AI report");
      }

      const reportData = JSON.parse(jsonMatch[0]);

      // Generate PDF
      const pdfBuffer = await generateReportPdf(reportData, req.user);

      // Save report
      const fs = (await import("fs")).default;
      const path = (await import("path")).default;
      
      const reportsDir = path.join(process.cwd(), "public", "docs", "reports");
      await fs.promises.mkdir(reportsDir, { recursive: true });
      
      const filename = `report-${Date.now().toString(36)}.pdf`;
      const filepath = path.join(reportsDir, filename);
      await fs.promises.writeFile(filepath, pdfBuffer);

      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      const reportUrl = `${site}/docs/reports/${filename}`;

      return res.json({
        success: true,
        reportUrl,
        reportData
      });

    } catch (error) {
      console.error("[Generate Report Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Helper: Generate report PDF using Puppeteer
 */
async function generateReportPdf(reportData, teacher) {
  const html = buildReportHtml(reportData, teacher);
  
  let puppeteer = null;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    try { puppeteer = (await import("puppeteer-core")).default; } catch { puppeteer = null; }
  }

  if (puppeteer) {
    const launchOpts = { args: ["--no-sandbox", "--disable-setuid-sandbox"] };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
      await page.emulateMediaType("screen");
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" }
      });
      return pdf;
    } finally {
      await browser.close();
    }
  }

  throw new Error("PDF generation requires Puppeteer");
}

function buildReportHtml(data, teacher) {
  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  
  const studentsHtml = (data.students || []).map(s => `
    <div class="student-section">
      <div class="student-header">
        <h2>${esc(s.name)}</h2>
        <span class="grade-badge">Grade ${s.grade}</span>
      </div>
      
      <div class="assessment-text">${esc(s.overallAssessment)}</div>
      
      <div class="two-col">
        <div class="col strengths">
          <h4>Strengths</h4>
          <ul>${(s.strengths || []).map(st => `<li>${esc(st)}</li>`).join("")}</ul>
        </div>
        <div class="col improvements">
          <h4>Areas for Improvement</h4>
          <ul>${(s.areasForImprovement || []).map(a => `<li>${esc(a)}</li>`).join("")}</ul>
        </div>
      </div>
      
      ${(s.subjectAnalysis || []).map(sub => `
        <div class="subject-analysis">
          <div class="subject-row">
            <span class="subject-name">${esc(sub.subject)}</span>
            <span class="subject-grade grade-${(sub.grade || "C").toLowerCase()}">${esc(sub.grade)}</span>
            <span class="trend trend-${sub.trend}">${sub.trend === "improving" ? "↗" : sub.trend === "declining" ? "↘" : "→"} ${esc(sub.trend)}</span>
          </div>
          <p>${esc(sub.performance)}</p>
          <p class="rec"><strong>Recommendation:</strong> ${esc(sub.recommendations)}</p>
        </div>
      `).join("")}
      
      <div class="recommendations-box">
        <h4>Next Steps</h4>
        <p>${esc(s.recommendations)}</p>
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Assessment Report</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a2e; font-size: 11pt; line-height: 1.6; }
  
  .page { padding: 40px 50px; }
  
  .report-header {
    background: linear-gradient(135deg, #1a1a2e, #16213e);
    color: white; padding: 40px 50px; margin: -40px -50px 30px;
  }
  .report-header h1 { font-size: 26pt; font-weight: 800; margin-bottom: 6px; }
  .report-header .meta { opacity: 0.8; font-size: 10pt; }
  .report-header .teacher { margin-top: 8px; font-size: 10pt; opacity: 0.7; }
  
  .summary-box {
    background: #f0f4ff; border-left: 4px solid #3b82f6;
    padding: 16px 20px; border-radius: 0 8px 8px 0; margin-bottom: 30px;
  }
  .summary-box h3 { color: #1e40af; margin-bottom: 8px; font-size: 12pt; }
  
  .student-section {
    page-break-inside: avoid; border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 24px; margin-bottom: 24px;
  }
  .student-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
  .student-header h2 { font-size: 16pt; color: #1a1a2e; }
  .grade-badge { background: #3b82f6; color: white; padding: 4px 12px; border-radius: 20px; font-size: 9pt; font-weight: 700; }
  
  .assessment-text { margin-bottom: 16px; color: #374151; }
  
  .two-col { display: flex; gap: 20px; margin-bottom: 16px; }
  .col { flex: 1; padding: 14px; border-radius: 8px; }
  .strengths { background: #f0fdf4; border: 1px solid #86efac; }
  .improvements { background: #fef3c7; border: 1px solid #fcd34d; }
  .col h4 { font-size: 10pt; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .strengths h4 { color: #166534; }
  .improvements h4 { color: #92400e; }
  .col ul { padding-left: 18px; font-size: 10pt; }
  .col li { margin-bottom: 4px; }
  
  .subject-analysis {
    background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 14px; margin-bottom: 12px;
  }
  .subject-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .subject-name { font-weight: 700; text-transform: capitalize; font-size: 11pt; }
  .subject-grade { font-weight: 800; padding: 2px 10px; border-radius: 4px; font-size: 10pt; }
  .grade-a { background: #dcfce7; color: #166534; }
  .grade-b { background: #dbeafe; color: #1e40af; }
  .grade-c { background: #fef3c7; color: #92400e; }
  .grade-d { background: #fee2e2; color: #991b1b; }
  .grade-e { background: #fecaca; color: #7f1d1d; }
  .trend { font-size: 9pt; padding: 2px 8px; border-radius: 4px; }
  .trend-improving { background: #dcfce7; color: #166534; }
  .trend-stable { background: #e0e7ff; color: #3730a3; }
  .trend-declining { background: #fee2e2; color: #991b1b; }
  .rec { font-size: 10pt; color: #6b7280; margin-top: 6px; }
  
  .recommendations-box {
    background: linear-gradient(135deg, #eff6ff, #f0f4ff);
    border: 1px solid #93c5fd; border-radius: 8px; padding: 16px; margin-top: 16px;
  }
  .recommendations-box h4 { color: #1e40af; margin-bottom: 8px; }
  
  .footer { margin-top: 30px; text-align: center; color: #9ca3af; font-size: 9pt; border-top: 1px solid #e5e7eb; padding-top: 16px; }
</style>
</head>
<body>
<div class="page">
  <div class="report-header">
    <h1>${esc(data.reportTitle || "Student Assessment Report")}</h1>
    <div class="meta">Generated: ${esc(data.generatedDate)} | CRIPFCnt Education Platform</div>
    <div class="teacher">Prepared by: ${esc(teacher.firstName)} ${esc(teacher.lastName || "")}</div>
  </div>
  
  <div class="summary-box">
    <h3>Executive Summary</h3>
    <p>${esc(data.summary)}</p>
  </div>
  
  ${studentsHtml}
  
  ${data.classOverview ? `
    <div class="summary-box" style="border-left-color: #8b5cf6; background: #f5f3ff;">
      <h3 style="color: #6d28d9;">Class Overview</h3>
      <p>${esc(data.classOverview)}</p>
    </div>
  ` : ""}
  
  ${data.teacherRecommendations ? `
    <div class="recommendations-box">
      <h4>Professional Recommendations</h4>
      <p>${esc(data.teacherRecommendations)}</p>
    </div>
  ` : ""}
  
  <div class="footer">
    <p>This report was generated  by CRIPFCnt Education Platform.</p>
    <p>For questions, contact your educational administrator.</p>
  </div>
</div>
</body>
</html>`;
}




/**
 * GET /teacher/setup
 * Profile setup for new teachers
 */
router.get(
  "/setup",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id).lean();
    
    // If already set up, redirect to dashboard
    if (teacher.schoolLevelsEnabled?.length && !teacher.needsProfileSetup) {
      return res.redirect("/teacher/dashboard");
    }

    res.render("teacher/setup", { user: teacher });
  }
);

/**
 * POST /teacher/setup
 * Save teacher profile
 */
router.post(
  "/setup",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const { schoolLevels } = req.body;

    // schoolLevels comes as string or array from checkboxes
    const levels = Array.isArray(schoolLevels) ? schoolLevels : [schoolLevels].filter(Boolean);
    const valid = levels.filter(l => ["junior", "high"].includes(l));

    if (!valid.length) {
      return res.status(400).send("Please select at least one school level");
    }

    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          schoolLevelsEnabled: valid,
          needsProfileSetup: false
        }
      }
    );





    return res.redirect("/teacher/dashboard");
  }
);












/**
 * GET /teacher/library-quiz/:ruleId/preview
 * Preview a system (library) quiz
 */
/**
 * GET /teacher/library-quiz/:ruleId/preview
 * Preview a system (library) quiz
 */
router.get(
  "/library-quiz/:ruleId/preview",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const QuizRule = (await import("../models/quizRule.js")).default;
      const mongoose = (await import("mongoose")).default;
      const rule = await QuizRule.findById(req.params.ruleId).lean();
      if (!rule) return res.status(404).send("Quiz not found");

      let allQuestions = [];

      // QuizRule stores a SINGLE parent question ID in quizQuestionId
      const parentId = rule.quizQuestionId;

      if (parentId && mongoose.isValidObjectId(String(parentId))) {
        const parentDoc = await Question.findById(parentId).lean();

        if (parentDoc) {
          if (parentDoc.type === "comprehension" && Array.isArray(parentDoc.questionIds) && parentDoc.questionIds.length) {
            // It's a comprehension parent — load its children
            allQuestions = await Question.find({
              _id: { $in: parentDoc.questionIds }
            }).lean();

            // Preserve parent's ordering
            const childById = {};
            for (const c of allQuestions) childById[String(c._id)] = c;
            allQuestions = parentDoc.questionIds
              .map(cid => childById[String(cid)])
              .filter(Boolean);
          } else if (parentDoc.choices && parentDoc.choices.length) {
            // It's a standalone MCQ question
            allQuestions = [parentDoc];
          }
        }
      }

      // Fallback: also check rule.questionIds if it exists (some rules may use it)
      if (!allQuestions.length && Array.isArray(rule.questionIds) && rule.questionIds.length) {
        const rawIds = rule.questionIds;
        const parentIds = [];
        const plainIds = [];

        for (const token of rawIds) {
          const str = String(token);
          if (str.startsWith("parent:")) {
            const pid = str.split(":")[1];
            if (mongoose.isValidObjectId(pid)) parentIds.push(pid);
          } else if (mongoose.isValidObjectId(str)) {
            plainIds.push(str);
          }
        }

        const allIds = [...parentIds, ...plainIds];
        if (allIds.length) {
          const docs = await Question.find({ _id: { $in: allIds } }).lean();
          const byId = {};
          for (const d of docs) byId[String(d._id)] = d;

          const childIds = new Set();
          for (const pid of parentIds) {
            const pd = byId[pid];
            if (pd?.questionIds) {
              for (const cid of pd.questionIds) childIds.add(String(cid));
            }
          }
          for (const pid of plainIds) {
            const doc = byId[pid];
            if (doc?.type === "comprehension" && doc.questionIds) {
              for (const cid of doc.questionIds) childIds.add(String(cid));
            }
          }

          if (childIds.size) {
            const children = await Question.find({ _id: { $in: Array.from(childIds) } }).lean();
            const childById = {};
            for (const c of children) childById[String(c._id)] = c;

            for (const pid of [...parentIds, ...plainIds]) {
              const pd = byId[pid];
              if (pd?.questionIds) {
                for (const cid of pd.questionIds) {
                  const child = childById[String(cid)];
                  if (child && !allQuestions.find(q => String(q._id) === String(child._id))) {
                    allQuestions.push(child);
                  }
                }
              }
            }
          }

          if (!allQuestions.length) {
            for (const pid of plainIds) {
              const doc = byId[pid];
              if (doc && doc.type !== "comprehension") allQuestions.push(doc);
            }
          }
        }
      }

      // Last resort: query by org+subject+grade
      if (!allQuestions.length) {
        const matchQuery = {
          organization: rule.org,
          type: { $ne: "comprehension" }
        };
        if (rule.subject) matchQuery.subject = rule.subject;
        if (rule.grade) matchQuery.grade = rule.grade;
        if (rule.module) matchQuery.module = rule.module;

        allQuestions = await Question.find(matchQuery)
          .limit(rule.questionCount || 20)
          .lean();
      }

      res.render("teacher/library_quiz_preview", {
        user: req.user,
        rule,
        questions: allQuestions
      });
    } catch (err) {
      console.error("[Library Preview Error]", err);
      return res.status(500).send("Failed to load preview");
    }
  }
);

/**
 * POST /teacher/assign-library-quiz
 * Assign a system (library) quiz to students
 */
router.post(
  "/assign-library-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { ruleId, studentIds, durationMinutes } = req.body;

      if (!ruleId || !Array.isArray(studentIds) || !studentIds.length) {
        return res.status(400).json({ error: "Rule ID and student IDs required" });
      }

      const QuizRule = (await import("../models/quizRule.js")).default;
      const { assignQuizFromRule } = await import("../services/quizAssignment.js");
      
      const rule = await QuizRule.findById(ruleId).lean();
      if (!rule) return res.status(404).json({ error: "Quiz rule not found" });

      let assigned = 0;
      let skipped = 0;

      for (const studentId of studentIds) {
        // Verify student belongs to teacher
        const student = await User.findOne({
          _id: studentId,
          parentUserId: req.user._id,
          role: "student"
        }).lean();

        if (!student) { skipped++; continue; }

        // Check if already assigned
        const existing = await ExamInstance.findOne({
          userId: studentId,
          ruleId: rule._id,
          status: { $ne: "finished" }
        }).lean();

        if (existing) { skipped++; continue; }

        await assignQuizFromRule({
          rule,
          userId: studentId,
          orgId: student.organization || rule.org,
          force: true,
          overrideDuration: durationMinutes ? Number(durationMinutes) : undefined
        });

        assigned++;
      }

      return res.json({ success: true, assigned, skipped });
    } catch (error) {
      console.error("[Assign Library Quiz Error]", error);
      return res.status(500).json({ error: error.message });
    }
  }
);





/* ==============================
   ✅ Plain Text Quiz Parser
============================== */
function parsePlainTextQuiz(input) {
  const text = String(input || "").replace(/\r\n/g, "\n").trim();

  // Header fields
  const header = {};
  const lines = text.split("\n");

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const m = line.match(/^(TITLE|SUBJECT|GRADE|DURATION)\s*:\s*(.+)$/i);
    if (m) header[m[1].toUpperCase()] = m[2].trim();
  }

  // Optional PASSAGE block
  let passage = "";
  const hasPassage = /^\s*PASSAGE\s*:\s*$/im.test(text) && /^\s*ENDPASSAGE\s*$/im.test(text);
  if (hasPassage) {
    const startIdx = text.toLowerCase().indexOf("passage:");
    const endIdx = text.toLowerCase().indexOf("endpassage");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      passage = text.slice(startIdx, endIdx).split("\n").slice(1).join("\n").trim();
    }
  }

  // Split questions by "Qn)"
  const blocks = text.split(/\n(?=\s*Q\d+\)\s*)/g);

  const questions = [];

  for (const block of blocks) {
    const b = block.trim();
    if (!/^Q\d+\)\s*/i.test(b)) continue;

    const firstLineEnd = b.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? b : b.slice(0, firstLineEnd);
    const qText = firstLine.replace(/^Q\d+\)\s*/i, "").trim();
    if (!qText) throw new Error("A question is missing text after Qn)");

    // Choices like A) ....
    const choiceMatches = [...b.matchAll(/^\s*([A-Z])\)\s*(.+)\s*$/gmi)];
    const choices = choiceMatches.map(m => m[2].trim());
    if (!choices.length) throw new Error(`Question "${qText.slice(0, 60)}..." has no choices (A) B) ...)`);

    // ANSWER: B
    const ansMatch = b.match(/^\s*ANSWER\s*:\s*([A-Z]|\d+)\s*$/im);
    if (!ansMatch) throw new Error(`Missing ANSWER for question "${qText.slice(0, 60)}..."`);

    const token = ansMatch[1].trim();
    let correctIndex = 0;

    if (/^\d+$/.test(token)) {
      correctIndex = Math.max(0, Number(token) - 1);
    } else {
      const letter = token.toUpperCase();
      correctIndex = letter.charCodeAt(0) - "A".charCodeAt(0);
    }

    if (correctIndex < 0 || correctIndex >= choices.length) {
      throw new Error(`ANSWER out of range for question "${qText.slice(0, 60)}..."`);
    }

    // Optional EXPLANATION
    const expMatch = b.match(/^\s*EXPLANATION\s*:\s*(.+)\s*$/im);
    const explanation = expMatch ? expMatch[1].trim() : "";

    questions.push({ text: qText, choices, correctIndex, explanation });
  }

  const quizTitle = header.TITLE || "";
  const subject = (header.SUBJECT || "").toLowerCase();
  const grade = Number(header.GRADE || 0) || null;
  const durationMinutes = Number(header.DURATION || 30) || 30;

  return { quizTitle, subject, grade, durationMinutes, passage, questions };
}

export default router;
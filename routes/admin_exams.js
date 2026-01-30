import { Router } from "express";
import mongoose from "mongoose";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";

const router = Router();

/**
 * 🔧 FIX EXISTING EXAM TITLES + QUIZ TITLES
 * GET /admin/exams/fix-titles
 */
router.get("/exams/fix-titles", async (req, res) => {
  try {
    const exams = await ExamInstance.find({
      questionIds: { $elemMatch: { $regex: /^parent:/ } }
    });

    let updated = [];
    let skipped = [];

    for (const exam of exams) {
      const parentToken = exam.questionIds.find(
        q => typeof q === "string" && q.startsWith("parent:")
      );

      if (!parentToken) {
        skipped.push({ examId: exam.examId, reason: "no parent token" });
        continue;
      }

      const parentId = parentToken.split(":")[1];
      if (!mongoose.isValidObjectId(parentId)) {
        skipped.push({ examId: exam.examId, reason: "invalid parent id" });
        continue;
      }

      const parentQuestion = await Question.findById(parentId)
        .select("text")
        .lean();

      if (!parentQuestion?.text) {
        skipped.push({ examId: exam.examId, reason: "parent text missing" });
        continue;
      }

      const realTitle = parentQuestion.text.trim();

      // 🔑 FORCE BOTH FIELDS (even if quizTitle never existed)
      await ExamInstance.updateOne(
        { _id: exam._id },
        {
          $set: {
            title: realTitle,
            quizTitle: realTitle
          }
        },
        { strict: false }
      );

      updated.push({
        examId: exam.examId,
        title: realTitle,
        quizTitle: realTitle
      });
    }

    return res.json({
      success: true,
      scanned: exams.length,
      updatedCount: updated.length,
      skippedCount: skipped.length,
      updated,
      skipped
    });
  } catch (err) {
    console.error("[fix-exam-titles]", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fix exam titles"
    });
  }
});

export default router;

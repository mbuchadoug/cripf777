import express from "express";
import Certificate from "../models/certificate.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import { ensureAuth } from "../middleware/authGuard.js";
import path from "path";
import Attempt from "../models/attempt.js"; // ADD THIS
import { allowPlatformAdminOrOrgManager } from "../middleware/orgAccess.js";
import mongoose from "mongoose";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";


import fs from "fs";
import { generateCertificatePdf } from "../routes/lms_api.js"; // 👈 export it (next step)



const router = express.Router();

/**
 * View all certificates
 */
router.get("/admin/certificates", ensureAuth, async (req, res) => {
  
 const certsRaw = await Certificate.find()
  .sort({ issuedAt: -1 })
  .populate("userId", "name email")
  .populate("orgId", "name slug")
  .lean();

// attach duration from Attempt
const examIds = certsRaw.map(c => c.examId).filter(Boolean);
const attempts = await Attempt.find(
  { examId: { $in: examIds } },
  { examId: 1, duration: 1 }
).lean();

const attemptByExamId = {};
for (const a of attempts) {
  attemptByExamId[a.examId] = a;
}

function formatDuration(d) {
  if (!d || typeof d.totalSeconds !== "number") return "-";

  const h = String(d.hours).padStart(2, "0");
  const m = String(d.minutes).padStart(2, "0");
  const s = String(d.seconds).padStart(2, "0");

  return `${h}:${m}:${s}`;
}

const certs = certsRaw.map(c => {
  const attempt = attemptByExamId[c.examId];
  return {
    ...c,
    durationFormatted: formatDuration(attempt?.duration)
  };
});


 res.render("admin/certificates", {
  title: "Certificates",
  certs,
  user: req.user,
  isAdmin: true
});

});

/**
 * Download certificate as JSON (simple + safe)
 */
router.get("/admin/certificates/:id/download", ensureAuth, async (req, res) => {
  const cert = await Certificate.findById(req.params.id)
    //.populate("userId", "name email")
    .populate("userId", "displayName firstName lastName email")
    .populate("orgId", "name slug")
    .lean();

  if (!cert) return res.status(404).send("Certificate not found");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${cert.serial}.json`
  );
  res.json(cert);
});


/**
 * Download certificate as PDF (ADMIN)
 */
router.get(
  "/admin/certificates/:id/download/pdf",
  ensureAuth,
  async (req, res) => {
    const cert = await Certificate.findById(req.params.id)
      //.populate("userId", "name email")
      .populate("userId", "displayName firstName lastName email")
      .populate("orgId", "name slug")
      .lean();

    if (!cert) return res.status(404).send("Certificate not found");

    /*const recipientName =
      cert.userId?.name || cert.userId?.email || "Learner";*/

const recipientName =
  cert.userId?.displayName ||
  [cert.userId?.firstName, cert.userId?.lastName]
    .filter(Boolean)
    .join(" ") ||
  cert.userId?.email ||
  "Learner";



    const orgName = cert.orgId?.name || "Organization";

    // 🔁 REGENERATE PDF FROM DB DATA
    const result = await generateCertificatePdf({
      name: recipientName,
      orgName,
      moduleName: cert.moduleName,
      quizTitle: cert.quizTitle,
      score: cert.score,
      percentage: cert.percentage,
      date: cert.issuedAt,
      req,
    });

    if (!result || !result.filepath) {
      return res.status(500).send("Failed to generate certificate PDF");
    }

    res.download(
      result.filepath,
      `${cert.serial}.pdf`,
      (err) => {
        if (err) {
          console.error("PDF download error:", err);
        }

        // 🧹 Optional cleanup (recommended)
        fs.unlink(result.filepath, () => {});
      }
    );
  }
);




router.get(
  "/admin/orgs/:slug/certificates",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const certsRaw = await Certificate.find({ orgId: org._id })
        .sort({ issuedAt: -1 })
        .populate("userId", "displayName firstName lastName email")
        .lean();

      res.render("admin/certificates", {
        title: `Certificates – ${org.name}`,
        certs: certsRaw,
        user: req.user,
        isAdmin: true,
        org
      });
    } catch (err) {
      console.error("[org certificates] error:", err);
      res.status(500).send("failed");
    }
  }
);


/**
 * 🔧 ADMIN MAINTENANCE
 * Fix ONLY bad certificate titles
 *
 * GET /admin/certificates/fix-titles
 */
router.get(
  "/admin/certificates/fix-titles",
  ensureAuth,
  async (req, res) => {
    // 🔐 hard safety
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).send("Forbidden");
    }

    // 🎯 ONLY these titles are considered broken
    const BAD_TITLES = new Set([
      "Comprehension Quiz",
      "Responsibility Quiz",
      "responsibility",
      "consciousness"
    ]);

    const certs = await Certificate.find({}).lean();

    let updated = 0;
    let skipped = 0;

    for (const cert of certs) {
      const currentTitle =
        (cert.quizTitle || "").trim() ||
        (cert.courseTitle || "").trim();

      // ⛔ Skip anything that is NOT explicitly bad
      if (!BAD_TITLES.has(currentTitle)) {
        skipped++;
        continue;
      }

      if (!cert.examId) {
        skipped++;
        continue;
      }

      const exam = await ExamInstance.findOne({ examId: cert.examId }).lean();
      if (!exam) {
        skipped++;
        continue;
      }

      let resolvedTitle =
        exam.quizTitle ||
        exam.title ||
        null;

      // 🔑 SOURCE OF TRUTH → parent comprehension question
      try {
        const parentToken = (exam.questionIds || []).find(
          q => typeof q === "string" && q.startsWith("parent:")
        );

        if (parentToken) {
          const parentId = parentToken.split(":")[1];

          if (mongoose.isValidObjectId(parentId)) {
            const parent = await Question.findById(parentId)
              .select("text")
              .lean();

            if (parent?.text) {
              resolvedTitle = parent.text.trim();
            }
          }
        }
      } catch (e) {
        console.warn("[cert fix] failed", cert._id, e.message);
      }

      if (!resolvedTitle) {
        skipped++;
        continue;
      }

      // ✅ Update BOTH fields (critical)
      await Certificate.updateOne(
        { _id: cert._id },
        {
          $set: {
            quizTitle: resolvedTitle,
            courseTitle: resolvedTitle
          }
        }
      );

      updated++;
    }

    return res.json({
      success: true,
      updated,
      skipped,
      fixedTitles: Array.from(BAD_TITLES)
    });
  }
);


export default router;

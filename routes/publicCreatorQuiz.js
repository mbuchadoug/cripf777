import { Router } from "express";
import crypto from "crypto";

import CreatorCampaign from "../models/creatorCampaign.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

import AIQuiz from "../models/aiQuiz.js";
import Question from "../models/question.js";
import Organization from "../models/organization.js";

const router = Router();

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

async function loadCampaignOr404(slug) {
  const campaign = await CreatorCampaign.findOne({ slug }).lean();
  if (!campaign) return null;
  if (campaign.status !== "active") return null;

  const now = Date.now();
  if (campaign.startsAt && now < new Date(campaign.startsAt).getTime()) return null;
  if (campaign.endsAt && now > new Date(campaign.endsAt).getTime()) return null;

  return campaign;
}

function normalizeChoices(rawChoices) {
  if (!Array.isArray(rawChoices)) return [];

  // already object list
  if (rawChoices.length && typeof rawChoices[0] === "object" && rawChoices[0] !== null) {
    return rawChoices.map((c, i) => ({
      label: c.label || String.fromCharCode(65 + i),
      text: c.text != null ? String(c.text) : ""
    }));
  }

  // string array
  return rawChoices.map((t, i) => ({
    label: String.fromCharCode(65 + i),
    text: String(t)
  }));
}

async function getCampaignQuizPayload(campaign) {
  // 1) AIQuiz
  if (campaign.aiQuizId) {
    const quiz = await AIQuiz.findById(campaign.aiQuizId).lean();
    if (!quiz) return null;

    return {
      title: quiz.title || campaign.title,
      passage: quiz.passage || null,
      questions: (quiz.questions || []).map((q, idx) => ({
        idToken: `ai:${quiz._id}:${idx}`,
        text: q.text || "",
        choices: normalizeChoices(q.choices || []),
        correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : null,
        explanation: q.explanation || ""
      }))
    };
  }

  // 2) Parent comprehension question (or single question)
  if (campaign.parentQuestionId) {
    const parent = await Question.findById(campaign.parentQuestionId).lean();
    if (!parent) return null;

    let questions = [];
    if (parent.type === "comprehension" && Array.isArray(parent.questionIds) && parent.questionIds.length) {
      const raw = await Question.find({ _id: { $in: parent.questionIds } }).lean();
      const byId = {};
      for (const q of raw) byId[String(q._id)] = q;
      questions = parent.questionIds.map((id) => byId[String(id)]).filter(Boolean);
    } else if (Array.isArray(parent.choices) && parent.choices.length) {
      questions = [parent];
    }

    return {
      title: parent.text || campaign.title,
      passage: parent.passage || null,
      questions: questions.map((q) => ({
        idToken: String(q._id),
        text: q.text || "",
        choices: normalizeChoices(q.choices || []),
        correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : null,
        explanation: q.explanation || ""
      }))
    };
  }

  // 3) QuizRule (library quiz)
  if (campaign.quizRuleId) {
    const QuizRule = (await import("../models/quizRule.js")).default;
    const mongoose = (await import("mongoose")).default;

    const rule = await QuizRule.findById(campaign.quizRuleId).lean();
    if (!rule) return null;

    const parentId = rule.quizQuestionId;
    if (!parentId || !mongoose.isValidObjectId(String(parentId))) return null;

    const parent = await Question.findById(parentId).lean();
    if (!parent) return null;

    let questions = [];
    if (parent.type === "comprehension" && Array.isArray(parent.questionIds) && parent.questionIds.length) {
      const raw = await Question.find({ _id: { $in: parent.questionIds } }).lean();
      const byId = {};
      for (const q of raw) byId[String(q._id)] = q;
      questions = parent.questionIds.map((id) => byId[String(id)]).filter(Boolean);
    } else if (Array.isArray(parent.choices) && parent.choices.length) {
      questions = [parent];
    }

    return {
      title: rule.quizTitle || parent.text || campaign.title,
      passage: parent.passage || null,
      questions: questions.map((q) => ({
        idToken: String(q._id),
        text: q.text || "",
        choices: normalizeChoices(q.choices || []),
        correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : null,
        explanation: q.explanation || ""
      }))
    };
  }

  return null;
}

// Landing page
router.get("/c/:slug", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  const payload = await getCampaignQuizPayload(campaign);
  if (!payload) return res.status(404).send("Quiz not found for this campaign");

  res.render("public/creator_landing", {
    campaign,
    quizTitle: payload.title,
    questionCount: payload.questions.length
  });
});

// Start page: participant info form
router.get("/c/:slug/start", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  res.render("public/creator_start", { campaign });
});

// Start POST: create ExamInstance, redirect to exam
router.post("/c/:slug/start", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  const name = String(req.body?.name || "").trim();
  const grade = req.body?.grade ? Number(req.body.grade) : null;
  const phone = String(req.body?.phone || "").trim();
  const school = String(req.body?.school || "").trim();

  if (campaign.settings?.requireName && !name) return res.status(400).send("Name is required");
  if (campaign.settings?.requireGrade && (!grade || grade < 1 || grade > 13)) {
    return res.status(400).send("Valid grade is required");
  }
  if (campaign.settings?.requirePhone && !phone) return res.status(400).send("Phone is required");

  const payload = await getCampaignQuizPayload(campaign);
  if (!payload) return res.status(404).send("Quiz not found for this campaign");

  const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
  const examId = crypto.randomUUID();

  const questionIds = payload.questions.map((q) => q.idToken);
  const choicesOrder = payload.questions.map((q) => Array.from({ length: q.choices.length }, (_, i) => i));

  await ExamInstance.create({
    examId,
    isPublic: true,
    userId: null,
    org: homeOrg?._id || null,
    title: payload.title,
    quizTitle: payload.title,
    module: "public",
    targetRole: "student",
    status: "pending",
   // durationMinutes: payload.questions.length * 2,
   durationMinutes: Number(campaign.settings?.durationMinutes) || (payload.questions.length * 2),
    questionIds,
    choicesOrder,
    meta: {
      campaignId: campaign._id,
      creatorId: campaign.creatorId,
      participant: { name, grade, phone, school },
      source: req.query?.ref ? String(req.query.ref) : "tiktok",
      shareId: req.query?.v ? String(req.query.v) : null
    }
  });

  return res.redirect(`/c/${campaign.slug}/exam/${examId}`);
});

// Exam page
router.get("/c/:slug/exam/:examId", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  const exam = await ExamInstance.findOne({ examId: req.params.examId, isPublic: true }).lean();

  const totalDurationSeconds =
  (Number(exam.durationMinutes) || 0) * 60;

const startedAt = exam.createdAt ? new Date(exam.createdAt) : new Date();
const now = new Date();
const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
const remainingSeconds = Math.max(0, totalDurationSeconds - elapsedSeconds);

  if (!exam) return res.status(404).send("Exam not found");
  if (String(exam.meta?.campaignId || "") !== String(campaign._id)) {
    return res.status(403).send("Exam does not belong to this campaign");
  }

  const payload = await getCampaignQuizPayload(campaign);
  if (!payload) return res.status(404).send("Quiz not found for this campaign");

  const byToken = {};
  for (const q of payload.questions) byToken[q.idToken] = q;

  const questions = (exam.questionIds || []).map((t) => byToken[String(t)]).filter(Boolean);

  res.render("public/creator_exam", {
    campaign,
    exam,
    totalDurationSeconds,
remainingSeconds,
    quizTitle: payload.title,
    passage: payload.passage,
    questions,
    participant: exam.meta?.participant || {}
  });
});

// Submit -> Attempt -> Result
router.post("/c/:slug/exam/:examId/submit", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  const exam = await ExamInstance.findOne({ examId: req.params.examId, isPublic: true }).lean();
  if (!exam) return res.status(404).send("Exam not found");
  if (String(exam.meta?.campaignId || "") !== String(campaign._id)) {
    return res.status(403).send("Exam does not belong to this campaign");
  }

  const payload = await getCampaignQuizPayload(campaign);
  if (!payload) return res.status(404).send("Quiz not found for this campaign");

  const startedAt = exam.createdAt ? new Date(exam.createdAt) : new Date();
  const finishedAt = new Date();
  const totalSeconds = Math.max(1, Math.floor((finishedAt - startedAt) / 1000));

  const byToken = {};
  for (const q of payload.questions) byToken[q.idToken] = q;

  const answers = [];
  let score = 0;
  const maxScore = payload.questions.length;

  for (const token of (exam.questionIds || [])) {
    const q = byToken[String(token)];
    if (!q) continue;

    const safeToken = String(token).replace(/[^a-zA-Z0-9:_-]/g, "");
    const key = `a_${safeToken}`;
    const chosen = req.body?.[key];
    const shownIndex = chosen != null ? Number(chosen) : null;

    // no shuffle in public UI; shownIndex == choiceIndex
    const choiceIndex = shownIndex;
    const correctIndex = typeof q.correctIndex === "number" ? q.correctIndex : null;
    const correct = correctIndex != null && choiceIndex != null && choiceIndex === correctIndex;

    if (correct) score++;

    const selectedText =
      choiceIndex != null && q.choices?.[choiceIndex]
        ? String(q.choices[choiceIndex].text || "")
        : "";

    answers.push({
      questionId: String(token),
      choiceIndex,
      shownIndex,
      selectedText,
      correctIndex,
      correct
    });
  }

  const percentage = Math.round((score / Math.max(1, maxScore)) * 100);

  const attempt = await Attempt.create({
    examId: exam.examId,
    userId: null,
    organization: exam.org || null,
    module: "public",
    quizTitle: exam.quizTitle || exam.title || campaign.title,
    questionIds: exam.questionIds || [],
    answers,
    score,
    maxScore,
    percentage,
    passed: percentage >= 50,
    status: "finished",
    startedAt,
    finishedAt,
    duration: {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      totalSeconds
    },

    isPublic: true,
    creator: campaign.creatorId,
    campaignId: campaign._id,
    shareId: exam.meta?.shareId || null,
    source: exam.meta?.source || "tiktok",
    publicParticipant: exam.meta?.participant || {},
    attemptIp: getClientIp(req)
  });

  await ExamInstance.updateOne({ _id: exam._id }, { $set: { status: "finished" } });

  return res.redirect(`/c/${campaign.slug}/result/${attempt._id}`);
});

// Result page (+ leaderboard + optional answers)
router.get("/c/:slug/result/:attemptId", async (req, res) => {
  const campaign = await loadCampaignOr404(req.params.slug);
  if (!campaign) return res.status(404).send("Campaign not found or inactive");

  const attempt = await Attempt.findById(req.params.attemptId).lean();
  if (!attempt || !attempt.isPublic) return res.status(404).send("Result not found");
  if (String(attempt.campaignId || "") !== String(campaign._id)) return res.status(403).send("Forbidden");

  const payload = await getCampaignQuizPayload(campaign);
  if (!payload) return res.status(404).send("Quiz not found");

  function fmtDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  let leaderboard = [];
  if (campaign.settings?.showLeaderboard) {
    const raw = await Attempt.find({
      isPublic: true,
      campaignId: campaign._id,
      status: "finished"
    })
      .sort({ percentage: -1, "duration.totalSeconds": 1, createdAt: 1 })
      .limit(20)
      .select("percentage publicParticipant duration createdAt")
      .lean();

    leaderboard = raw.map(r => ({
      ...r,
      durationLabel: fmtDuration(r.duration?.totalSeconds),
      dateLabel: r.createdAt
        ? new Date(r.createdAt).toISOString().slice(0, 19).replace("T", " ")
        : ""
    }));
  }

  const showAnswers = !!campaign.settings?.showAnswersAfterSubmit;

  const byToken = {};
  for (const q of payload.questions) byToken[q.idToken] = q;

  const review = (attempt.answers || []).map((a) => {
    const q = byToken[String(a.questionId)];
    return {
      questionId: a.questionId,
      text: q?.text || "",
      choices: q?.choices || [],
      correctIndex: q?.correctIndex,
      explanation: showAnswers ? (q?.explanation || "") : "",
      selected: a.choiceIndex,
      correct: !!a.correct
    };
  });

  res.render("public/creator_result", {
    campaign,
    attempt,
    participant: attempt.publicParticipant || {},
    leaderboard,
    showAnswers,
    review
  });
});

export default router;

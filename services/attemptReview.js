// services/attemptReview.js
import AIQuiz from "../models/aiQuiz.js";
import Question from "../models/question.js";

export async function buildAttemptReview({ attempt, exam }) {
  if (!attempt || !exam) return { quizTitle: attempt?.quizTitle || exam?.quizTitle || exam?.title || "Quiz", review: [] };

  // --------------------------------------------
  // 1) Build a lookup of questions in ORIGINAL order
  // --------------------------------------------
  let questions = [];

  // A) AI Quiz (most common in your private teacher flow)
  if (exam.meta?.aiQuizId) {
    const quiz = await AIQuiz.findById(exam.meta.aiQuizId).lean();
    if (quiz?.questions?.length) {
      questions = quiz.questions.map((q, idx) => ({
        idToken: `ai:${quiz._id}:${idx}`,
        text: q.text || "",
        choices: Array.isArray(q.choices) ? q.choices.map((c, i) => ({
          label: c.label || String.fromCharCode(65 + i),
          text: c.text != null ? String(c.text) : ""
        })) : [],
        correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : null,
        explanation: q.explanation || ""
      }));
    }
  }

  // B) Library / Question bank (ExamInstance.questionIds are ObjectIds or tokens)
  if (!questions.length && Array.isArray(exam.questionIds) && exam.questionIds.length) {
    // If they look like Mongo ObjectIds, fetch from Question collection
    const ids = exam.questionIds
      .map(String)
      .filter(x => /^[a-fA-F0-9]{24}$/.test(x));

    if (ids.length) {
      const raw = await Question.find({ _id: { $in: ids } }).lean();
      const byId = {};
      for (const q of raw) byId[String(q._id)] = q;

      // Preserve ExamInstance order
      questions = exam.questionIds
        .map(id => byId[String(id)])
        .filter(Boolean)
        .map(q => ({
          idToken: String(q._id),
          text: q.text || "",
          choices: Array.isArray(q.choices) ? q.choices.map((c, i) => ({
            label: c.label || String.fromCharCode(65 + i),
            text: c.text != null ? String(c.text) : ""
          })) : [],
          correctIndex: typeof q.correctIndex === "number" ? q.correctIndex : null,
          explanation: q.explanation || ""
        }));
    }
  }

  // --------------------------------------------
  // 2) Map Attempt answers into a PROFESSIONAL review structure
  // --------------------------------------------
  const byToken = {};
  for (const q of questions) byToken[String(q.idToken)] = q;

  // choicesOrder[i] is an array mapping SHOWN index -> ORIGINAL index
  const choicesOrder = Array.isArray(exam.choicesOrder) ? exam.choicesOrder : [];

  const safeLabel = (i) => (typeof i === "number" && i >= 0 ? String.fromCharCode(65 + i) : "");

  const review = (attempt.answers || []).map((a, idx) => {
    const token = String(a.questionId);
    const q = byToken[token];

    const originalChoices = q?.choices || [];
    const order = Array.isArray(choicesOrder[idx]) ? choicesOrder[idx] : null;

    // Build the "shown" choices list (what student saw)
    const shownChoices = order
      ? order.map((origIdx, shownIdx) => {
          const c = originalChoices[origIdx] || {};
          return { shownIdx, origIdx, label: c.label || safeLabel(shownIdx), text: c.text || "" };
        })
      : originalChoices.map((c, shownIdx) => ({ shownIdx, origIdx: shownIdx, label: c.label || safeLabel(shownIdx), text: c.text || "" }));

    // Attempt may store both:
    // - shownIndex (index user clicked in UI)
    // - choiceIndex (original index)
    const chosenShown = (typeof a.shownIndex === "number") ? a.shownIndex : null;
    const chosenOrig =
      (typeof a.choiceIndex === "number") ? a.choiceIndex
      : (chosenShown != null && order ? order[chosenShown] : chosenShown);

    // Correct index: prefer attempt.correctIndex, else question.correctIndex
    const correctOrig =
      (typeof a.correctIndex === "number") ? a.correctIndex
      : (typeof q?.correctIndex === "number") ? q.correctIndex
      : null;

    const chosenChoice = (chosenOrig != null) ? originalChoices[chosenOrig] : null;
    const correctChoice = (correctOrig != null) ? originalChoices[correctOrig] : null;

    const correct =
      typeof a.correct === "boolean"
        ? a.correct
        : (correctOrig != null && chosenOrig != null && correctOrig === chosenOrig);

    // “Solution” block even without explanation
    const hasExplanation = !!(q?.explanation && String(q.explanation).trim());
    const solutionText = hasExplanation
      ? String(q.explanation).trim()
      : (correctChoice
          ? `Correct answer is ${correctChoice.label || safeLabel(correctOrig)}: ${String(correctChoice.text || "").trim()}`
          : `Correct answer not available for this question.`);

    return {
      number: idx + 1,
      questionText: q?.text || "(Question text missing)",
      shownChoices, // what the student saw
      selected: chosenChoice
        ? { label: chosenChoice.label || safeLabel(chosenOrig), text: String(chosenChoice.text || "") }
        : { label: "", text: "" },
      correctAnswer: correctChoice
        ? { label: correctChoice.label || safeLabel(correctOrig), text: String(correctChoice.text || "") }
        : { label: "", text: "" },
      correct,
      solutionText
    };
  });

  return {
    quizTitle: attempt.quizTitle || exam.quizTitle || exam.title || "Quiz",
    review
  };
}
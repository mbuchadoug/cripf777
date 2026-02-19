import mongoose from "mongoose";

const CreatorCampaignSchema = new mongoose.Schema(
  {
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true }, // used as /c/:slug

    // Quiz source: set exactly ONE of these
    aiQuizId: { type: mongoose.Schema.Types.ObjectId, ref: "AIQuiz", default: null, index: true },
    quizRuleId: { type: mongoose.Schema.Types.ObjectId, ref: "QuizRule", default: null, index: true },
    parentQuestionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", default: null, index: true },

    status: { type: String, enum: ["active", "paused", "ended"], default: "active", index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    settings: {
      requireName: { type: Boolean, default: true },
      requireGrade: { type: Boolean, default: true },
      requirePhone: { type: Boolean, default: false },
      showAnswersAfterSubmit: { type: Boolean, default: true },
      showLeaderboard: { type: Boolean, default: true }
    }
  },
  { timestamps: true }
);

export default mongoose.models.CreatorCampaign || mongoose.model("CreatorCampaign", CreatorCampaignSchema);

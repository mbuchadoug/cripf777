import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const UserSchema = new mongoose.Schema({
  googleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },

  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    default: null
  },

  role: {
    type: String,
    enum: [
      "student",
      "teacher",
      "employee",
      "org_admin",
      "super_admin",
          "private_teacher",  // ✅ ADD THIS
      "parent"
    ],
    default: "parent"
  },

  displayName: String,
  firstName: String,
  lastName: String,

  email: { type: String, index: true },
  photo: String,
  locale: String,
  provider: String,

 studentId: { type: String, index: true, unique: true, sparse: true },

  teacherId: {
    type: String,
    index: true,
    sparse: true
  },
  adminId: {
    type: String,
    index: true,
    sparse: true
  },

  grade: { type: Number, index: true },

  passwordHash: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },

  searchCountDay: { type: String, index: true, default: null },
  searchCount: { type: Number, default: 0 },

  auditCredits: { type: Number, default: 1 },
  accountType: {
    type: String,
    enum: ["parent", "guardian", "student_self"],
  default: undefined,   // ✅ not null
    index: true
  },

  schoolLevelsEnabled: [{
    type: String,
    enum: ["junior", "high"]
  }],

  // ==============================
  // 💳 SUBSCRIPTION & PLAN
  // ==============================
  subscriptionStatus: {
    type: String,
    enum: ["trial", "paid"],
    default: "trial",
    index: true
  },

  subscriptionPlan: {
    type: String,
    enum: ["none", "silver", "gold"],
    default: "none",
    index: true
  },

  maxChildren: {
    type: Number,
    default: 0 // trial = 0 paid children cap (they get trial quizzes only)
  },

  subscriptionExpiresAt: {
    type: Date,
    default: null,
    index: true
  },

  trialCounters: {
   maths: { type: Number, default: 0 },
    english: { type: Number, default: 0 },
    science: { type: Number, default: 0 },
    geography: { type: Number, default: 0 },
    biology: { type: Number, default: 0 },
    environmentalstudies: { type: Number, default: 0 },
    history: { type: Number, default: 0 },
    generalknowledge: { type: Number, default: 0 },
  },

  consumerEnabled: {
    type: Boolean,
    default: false,
    index: true
  },

  parentUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    index: true
  },

  // After line ~100 (after trialCounters)

// ==============================
// 💼 EMPLOYEE SUBSCRIPTION (cripfcnt-school)
// ==============================
employeeSubscriptionStatus: {
  type: String,
  enum: ["trial", "paid"],
  default: "trial",
  index: true
},

employeeSubscriptionPlan: {
  type: String,
  enum: ["none", "full_access"],
  default: "none",
  index: true
},

employeeSubscriptionExpiresAt: {
  type: Date,
  default: null,
  index: true
},

employeePaidAt: {
  type: Date,
  default: null
},

employeeTrialQuizzesCompleted: {
  type: Number,
  default: 0
},

// ==============================
// 👨‍🏫 PRIVATE TEACHER SUBSCRIPTION
// ==============================
teacherSubscriptionStatus: {
  type: String,
  enum: ["trial", "paid"],
  default: "trial",
  index: true
},

teacherSubscriptionPlan: {
  type: String,
  enum: ["none", "starter", "professional"],
  default: "none",
  index: true
},

teacherSubscriptionExpiresAt: {
  type: Date,
  default: null,
  index: true
},

teacherPaidAt: {
  type: Date,
  default: null
},

// AI quiz credits (monthly reset)
aiQuizCredits: {
  type: Number,
  default: 0
},

aiQuizCreditsResetAt: {
  type: Date,
  default: null
},

// Profile setup flag for new teachers
needsProfileSetup: {
  type: Boolean,
  default: false
},

  paidAt: { type: Date, default: null }
}, { strict: true });


// ==============================
// 🔐 PASSWORD HELPERS
// ==============================

UserSchema.methods.setPassword = async function (plainPassword) {
  const saltRounds = 10;
  this.passwordHash = await bcrypt.hash(String(plainPassword), saltRounds);
};

UserSchema.methods.verifyPassword = async function (plainPassword) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plainPassword), this.passwordHash);
};

// After line ~170 (after getPlanLabel)

// ==============================
// 💼 EMPLOYEE PLAN HELPERS
// ==============================

UserSchema.methods.isEmployeeSubscriptionActive = function () {
  if (this.employeeSubscriptionStatus !== "paid") return false;
  if (!this.employeeSubscriptionExpiresAt) return false;
  return new Date() < this.employeeSubscriptionExpiresAt;
};

UserSchema.methods.canAccessPaidEmployeeQuizzes = function () {
  return this.employeeSubscriptionStatus === "paid" && 
         this.isEmployeeSubscriptionActive();
};

UserSchema.methods.canUpgradeEmployeeAccount = function () {
  // Must complete all trial quizzes to upgrade
  return this.employeeTrialQuizzesCompleted >= 3 && 
         this.employeeSubscriptionStatus === "trial";
};


// ==============================
// 👨‍🏫 PRIVATE TEACHER HELPERS
// ==============================

UserSchema.methods.isTeacherSubscriptionActive = function () {
  if (this.teacherSubscriptionStatus !== "paid") return false;
  if (!this.teacherSubscriptionExpiresAt) return false;
  return new Date() < this.teacherSubscriptionExpiresAt;
};

UserSchema.methods.getTeacherChildLimit = function () {
  if (!this.isTeacherSubscriptionActive()) return 0;
  if (this.teacherSubscriptionPlan === "starter") return 15;
  if (this.teacherSubscriptionPlan === "professional") return 40;
  return 0;
};

UserSchema.methods.getTeacherPlanLabel = function () {
  if (this.teacherSubscriptionPlan === "professional") return "Professional (40 students)";
  if (this.teacherSubscriptionPlan === "starter") return "Starter (15 students)";
  return "Trial";
};

UserSchema.methods.hasAIQuizCredits = function () {
  return this.aiQuizCredits > 0;
};

UserSchema.methods.resetAIQuizCredits = function () {
  const now = new Date();
  const lastReset = this.aiQuizCreditsResetAt || new Date(0);
  
  // Reset monthly (30 days)
  if (now - lastReset > 30 * 24 * 60 * 60 * 1000) {
    if (this.teacherSubscriptionPlan === "starter") {
      this.aiQuizCredits = 20; // 20 AI quizzes/month
    } else if (this.teacherSubscriptionPlan === "professional") {
      this.aiQuizCredits = 50; // 50 AI quizzes/month
    }
    this.aiQuizCreditsResetAt = now;
  }
};
// ==============================
// 💳 PLAN HELPERS
// ==============================

UserSchema.methods.isSubscriptionActive = function () {
  if (this.subscriptionStatus !== "paid") return false;
  if (!this.subscriptionExpiresAt) return false;
  return new Date() < this.subscriptionExpiresAt;
};

UserSchema.methods.getPlanLabel = function () {
  if (this.subscriptionPlan === "gold") return "Gold";
  if (this.subscriptionPlan === "silver") return "Silver";
  return "Free Trial";
};


// ==============================
// MODEL EXPORT
// ==============================

const User = mongoose.models.User || mongoose.model("User", UserSchema);
export default User;
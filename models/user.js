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
    science: { type: Number, default: 0 }
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
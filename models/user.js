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
      "private_teacher",
      "parent",
      "readonly_admin"   // ← NEW: can view all, edit only quiz classification
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

  // ─────────────────────────────────────────────
  // 🔑 USERNAME  (unique login handle for school users)
  //    Auto-generated on first save for school members.
  //    Format: first 3 chars of firstName + last name + 4-digit number
  //    e.g. "johsmith1042" - always lowercase
  //    Google-signup users also get one assigned automatically.
  // ─────────────────────────────────────────────
  username: {
    type: String,
    unique: true,
    sparse: true,   // allows null/undefined for non-school users
    lowercase: true,
    trim: true,
    index: true
  },

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

  // Flag: user signed up via Google but has NOT yet set a password.
  // When true the "Set up your password" prompt is shown on the dashboard.
  needsPasswordSetup: {
    type: Boolean,
    default: false
  },

  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },

  searchCountDay: { type: String, index: true, default: null },
  searchCount: { type: Number, default: 0 },

  auditCredits: { type: Number, default: 1 },
  accountType: {
    type: String,
    enum: ["parent", "guardian", "student_self"],
    default: undefined,
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
    default: 0
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
    businessstudies: { type: Number, default: 0 },
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

  aiQuizCredits: {
    type: Number,
    default: 0
  },

  aiQuizCreditsResetAt: {
    type: Date,
    default: null
  },

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
  this.needsPasswordSetup = false; // password is now set
};

UserSchema.methods.verifyPassword = async function (plainPassword) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plainPassword), this.passwordHash);
};

UserSchema.methods.hasPassword = function () {
  return !!this.passwordHash;
};

// ==============================
// 🔑 USERNAME GENERATION
// ==============================

/**
 * Generate a candidate username from name fields.
 * Pattern: first3(firstName) + lastName + random4digits, all lowercase.
 */
UserSchema.statics.generateUsernameCandidate = function (firstName, lastName) {
  const f = (firstName || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3).padEnd(3, "x");
  const l = (lastName  || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(2, "x");
  const n = String(Math.floor(1000 + Math.random() * 9000));
  return f + l + n;
};

/**
 * Generate a unique username (retries on collision).
 */
UserSchema.statics.createUniqueUsername = async function (firstName, lastName) {
  for (let i = 0; i < 10; i++) {
    const candidate = this.generateUsernameCandidate(firstName, lastName);
    const existing = await this.findOne({ username: candidate }).lean();
    if (!existing) return candidate;
  }
  // Last resort: timestamp suffix
  const base = (firstName || "user").toLowerCase().slice(0, 4);
  return base + Date.now().toString().slice(-6);
};

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
  if (now - lastReset > 30 * 24 * 60 * 60 * 1000) {
    if (this.teacherSubscriptionPlan === "starter") {
      this.aiQuizCredits = 20;
    } else if (this.teacherSubscriptionPlan === "professional") {
      this.aiQuizCredits = 50;
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
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

  // ── Multi-role (mobile) ──────────────────────────────────────────────
  // Personas this user may use in the app beyond their primary role. Granted
  // by an admin or by paying for that persona. The primary role is always
  // available; this just ADDS extra personas (parent + professional, etc.).
  mobileRoles: [{ type: String, enum: ["parent", "professional", "teacher", "student"] }],
  // The persona currently selected in the app (null = use primary role).
  activeMobileRole: { type: String, enum: ["parent", "professional", "teacher", "student", null], default: null },

  paidAt: { type: Date, default: null },

  // ── 3-DAY FREE TRIAL (parent / teacher / student) ──────────────────────────
  // When the trial ends. Set on first signup. While now < trialEndsAt the account
  // gets a capped taste of the product; after it, free users hit the upgrade wall.
  trialEndsAt: { type: Date, default: null, index: true },

  // ── FREE/TRIAL QUIZ CAP (per calendar month) ───────────────────────────────
  // Counts quizzes taken this month so free accounts can be capped. monthlyQuizPeriod
  // is a "YYYY-MM" marker; it resets the count when the month rolls over.
  monthlyQuizCount: { type: Number, default: 0 },
  monthlyQuizPeriod: { type: String, default: null }
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

UserSchema.methods.monthlyAICreditAllowance = function () {
  // Paid plans first; otherwise a small trial allowance while the trial is live.
  if (this.teacherSubscriptionPlan === "professional") return 50;
  if (this.teacherSubscriptionPlan === "starter") return 20;
  if (this.isTrialActive && this.isTrialActive()) return 5; // teacher trial
  return 0;
};

UserSchema.methods.resetAIQuizCredits = function () {
  const now = new Date();
  const lastReset = this.aiQuizCreditsResetAt || new Date(0);
  if (now - lastReset > 30 * 24 * 60 * 60 * 1000) {
    const allowance = this.monthlyAICreditAllowance();
    // Only (re)grant when there's an allowance - never strand a plan at 0,
    // and never wipe credits that were granted manually this period.
    if (allowance > 0) {
      this.aiQuizCredits = allowance;
      this.aiQuizCreditsResetAt = now;
    }
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
// 🎁 FREE TRIAL + QUIZ CAP HELPERS
// ==============================

// Start a 3-day trial if one hasn't been set yet (safe to call on every login).
UserSchema.methods.ensureTrialStarted = function (days = 3) {
  if (!this.trialEndsAt && this.subscriptionStatus !== "paid" &&
      this.teacherSubscriptionStatus !== "paid" && this.employeeSubscriptionStatus !== "paid") {
    this.trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return true;
  }
  return false;
};

UserSchema.methods.isTrialActive = function () {
  return !!this.trialEndsAt && new Date() < new Date(this.trialEndsAt);
};

// True if the account has ANY active paid plan (parent, teacher, or employee).
UserSchema.methods.isAnyPlanPaid = function () {
  return this.isSubscriptionActive() ||
         (typeof this.isTeacherSubscriptionActive === "function" && this.isTeacherSubscriptionActive()) ||
         (typeof this.isEmployeeSubscriptionActive === "function" && this.isEmployeeSubscriptionActive());
};

// How many children a free/trial parent may add (paid plans use maxChildren).
UserSchema.methods.getChildLimit = function () {
  if (this.isSubscriptionActive()) return this.maxChildren || 2;
  return 2; // free + trial parents: up to 2
};

// Monthly quiz cap for free/trial users. Paid users are uncapped (null).
UserSchema.methods.monthlyQuizCap = function () {
  if (this.isAnyPlanPaid()) return null;        // paid = unlimited
  if (this.isTrialActive()) return 20;          // trial taste
  return 10;                                    // free (trial ended) - a taste, then upgrade
};

// Returns { allowed, remaining, cap }. Call BEFORE starting a quiz for a free user.
UserSchema.methods.checkQuizQuota = function () {
  const cap = this.monthlyQuizCap();
  if (cap == null) return { allowed: true, remaining: null, cap: null };
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const used = this.monthlyQuizPeriod === period ? (this.monthlyQuizCount || 0) : 0;
  return { allowed: used < cap, remaining: Math.max(0, cap - used), cap };
};

// Record one quiz taken this month (rolls over automatically).
UserSchema.methods.recordQuizTaken = function () {
  const period = new Date().toISOString().slice(0, 7);
  if (this.monthlyQuizPeriod !== period) { this.monthlyQuizPeriod = period; this.monthlyQuizCount = 0; }
  this.monthlyQuizCount = (this.monthlyQuizCount || 0) + 1;
};

// ==============================
// MODEL EXPORT
// ==============================

const User = mongoose.models.User || mongoose.model("User", UserSchema);
export default User;
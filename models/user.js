const UserSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, index: true },

  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    default: null
  },

  role: {
    type: String,
    enum: ["student", "teacher", "employee", "org_admin", "super_admin"]
  },

  // ✅ SCHOOL FIELDS
  studentId: { type: String, index: true },
  grade: { type: Number, index: true },

  displayName: String,
  firstName: String,
  lastName: String,
  email: { type: String, index: true },

  photo: String,
  locale: String,
  provider: String,

  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },

  searchCountDay: { type: String, index: true, default: null },
  searchCount: { type: Number, default: 0 },

  auditCredits: { type: Number, default: 0 },
  paidAt: { type: Date, default: null }
}, { strict: true });

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
    enum: ["student", "teacher", "employee", "org_admin", "super_admin"]
  },

  displayName: String,
  firstName: String,
  lastName: String,

  email: { type: String, index: true },
  photo: String,
  locale: String,
  provider: String,

  studentId: { type: String, index: true },
  teacherId: {
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

  auditCredits: { type: Number, default: 0 },
  paidAt: { type: Date, default: null }
}, { strict: true });


// ==============================
// 🔐 PASSWORD HELPERS (CORRECT PLACE)
// ==============================

UserSchema.methods.setPassword = async function (plainPassword) {
  const saltRounds = 10;
  this.passwordHash = await bcrypt.hash(String(plainPassword), saltRounds);
};

UserSchema.methods.verifyPassword = async function (plainPassword) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plainPassword), this.passwordHash);
};


// ==============================
// MODEL EXPORT
// ==============================

const User = mongoose.models.User || mongoose.model("User", UserSchema);
export default User;

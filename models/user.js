// models/User.js
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
googleId: {
  type: String,
  unique: true,
  sparse: true,   // ⭐ THIS IS CRITICAL
  index: true
},

  // in existing UserSchema add fields:
organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
//role: { type: String, enum: ["employee","org_admin","super_admin"], default: "employee", index: true },
role: {
  type: String,
  enum: ["student", "teacher", "employee", "org_admin", "super_admin"]
}
,
  displayName: String,
  firstName: String,
  lastName: String,
  email: { type: String, index: true },
  photo: String,
  locale: String,
  provider: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },

    studentId: { type: String, index: true },
  grade: { type: Number, index: true },

  // NEW: daily search credit tracking
  // 'searchCountDay' stores a YYYY-MM-DD string for the day the counter applies to.
  // 'searchCount' stores how many searches used on that day.
  searchCountDay: { type: String, index: true, default: null },
  searchCount: { type: Number, default: 0 },
  // add to UserSchema
auditCredits: { type: Number, default: 0 },
paidAt: { type: Date, default: null },
}, { strict: true });

const User = mongoose.models.User || mongoose.model("User", UserSchema);
export default User;

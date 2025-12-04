// models/orgMembership.js
import mongoose from "mongoose";

const OrgMembershipSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  role: { type: String, enum: ["employee", "manager", "admin"], default: "employee", index: true },
  joinedAt: { type: Date, default: Date.now }
}, { timestamps: true });

OrgMembershipSchema.index({ org: 1, user: 1 }, { unique: true });

export default mongoose.models.OrgMembership || mongoose.model("OrgMembership", OrgMembershipSchema);

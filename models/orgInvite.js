import mongoose from "mongoose";
const OrgInviteSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
  email: String,
  token: String,
  role: { type: String, default: "employee" },
  createdAt: { type: Date, default: Date.now },
  used: { type: Boolean, default: false },
});
export default mongoose.models.OrgInvite || mongoose.model("OrgInvite", OrgInviteSchema);

import mongoose from "mongoose";

const UserRoleSchema = new mongoose.Schema({
 businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",   // 👈 MUST MATCH MODEL NAME
      required: true
    },
  branchId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Branch",
  required: function () {
    return this.role !== "owner";
  }
}
,
  phone: { type: String, index: true },
  pending: { type: Boolean, default: true },
  role: {
    type: String,
    enum: ["owner", "admin", "manager", "clerk"],
    default: "owner"
  }
}, { timestamps: true });

export default mongoose.model("UserRole", UserRoleSchema);

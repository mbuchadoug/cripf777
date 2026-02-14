import mongoose from "mongoose";

const BranchSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, index: true },
  name: { type: String, default: "Main Branch" },
  isDefault: { type: Boolean, default: true },
  location: String
}, { timestamps: true });

export default mongoose.model("Branch", BranchSchema);

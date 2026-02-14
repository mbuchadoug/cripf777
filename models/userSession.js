import mongoose from "mongoose";

const UserSessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    activeBusinessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business" }
  },
  { timestamps: true }
);

export default mongoose.model("UserSession", UserSessionSchema);

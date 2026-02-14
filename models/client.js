import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", index: true },
  name: String,
  phone: String,
  email: String,
  notes: String,
}, { timestamps: true });

export default mongoose.models.Client || mongoose.model("Client", ClientSchema);

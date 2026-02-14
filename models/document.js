import mongoose from "mongoose";

const LineSchema = new mongoose.Schema({
  description: String,
  qty: Number,
  unitPrice: Number
}, { _id: false });

const DocSchema = new mongoose.Schema({
  type: { type: String, enum: ["invoice","quote","receipt"], required: true },
  number: { type: String, required: true, unique: true },
  customer: { name: String, email: String, phone: String, id: String },
  date: { type: Date, default: Date.now },
  dueDate: Date,
  items: [LineSchema],
  subtotal: Number,
  taxRate: Number,
  tax: Number,
  total: Number,
  notes: String,
  createdBy: String, // providerId (admin phone)
  attachments: [String], // optional
}, { timestamps: true });

export default mongoose.model("Document", DocSchema);

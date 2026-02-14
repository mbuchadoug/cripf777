import mongoose from "mongoose";

const ExpenseSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
  amount: { type: Number, required: true },
  description: { type: String },
  category: { type: String },
  method: { type: String },
  createdBy: { type: String }
}, { timestamps: true });

const Expense = mongoose.model("Expense", ExpenseSchema);

export default Expense;

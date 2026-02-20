import mongoose from "mongoose";

const InvoicePaymentSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true
  },

clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true,
    index: true
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    index: true
  },

  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Invoice",
    required: true,
    index: true
  },

  amount: { type: Number, required: true },

  method: {
    type: String,
    enum: ["Cash", "Bank", "EcoCash", "Other"],
    required: true
  },

  receiptNumber: { type: String, default: null },

  createdBy: { type: String, default: null }, // WhatsApp number etc.

  createdAt: { type: Date, default: Date.now, index: true }
});

// IMPORTANT: force a unique model name + collection name
const InvoicePayment =
  mongoose.models.InvoicePayment ||
  mongoose.model("InvoicePayment", InvoicePaymentSchema, "invoice_payments");

export default InvoicePayment;

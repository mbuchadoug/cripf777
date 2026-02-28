import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  reference: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  amount: {
    type: Number,
    required: true
  },

type: {
  type: String,
  enum: ["subscription", "battle_entry"],
  default: "subscription",
  index: true
},

battleId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Battle",
  default: null,
  index: true
},

meta: {
  type: Object,
  default: {}
},

plan: {
  type: String,
  enum: ["silver", "gold", "teacher_starter", "teacher_professional", null],
  default: null,
  index: true
},
  pollUrl: {
    type: String,
    default: null
  },

  status: {
    type: String,
    enum: ["pending", "paid", "failed", "cancelled"],
    default: "pending",
    index: true
  },

  paidAt: {
    type: Date,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Payment = mongoose.models.Payment || mongoose.model("Payment", PaymentSchema);
export default Payment;
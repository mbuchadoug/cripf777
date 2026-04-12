const schoolSubscriptionPaymentSchema = new mongoose.Schema({
  phone:       { type: String, required: true, index: true },
  schoolId:    { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile" },
  tier:        { type: String, required: true },
  plan:        { type: String, required: true },

  // 🔹 FINAL AMOUNT PAID (after discount)
  amount:      { type: Number, required: true },

  currency:    { type: String, default: "USD" },
  reference:   { type: String, required: true, unique: true },
  status:      { type: String, enum: ["pending","paid","failed"], default: "pending" },
  paidAt:      { type: Date, default: null },
  endsAt:      { type: Date, default: null },

  // 🔥 ADD THESE FIELDS (DO NOT REMOVE ANYTHING ABOVE)

  originalAmount:  { type: Number, default: 0 },   // before discount
  discountPercent: { type: Number, default: 0 },
  discountAmount:  { type: Number, default: 0 },

  paymentMethod:   { type: String, default: "cash" },

  receiptUrl:      { type: String },   // link to PDF
  receiptFilename: { type: String }

}, { timestamps: true });
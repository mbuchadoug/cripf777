// models/quoteRequest.js
// ═════════════════════════════════════════════════════════════════════════════
// "Request a Quote" - admin-facilitated (concierge) quote requests.
//
// A customer describes what they need in ONE message. ZimQuote (the admin)
// decides what happens next:
//   • make a ZimQuote quotation (PDF) and send it, and/or
//   • send the request to sellers the admin picks (suggestions are only hints),
//   • relay messages between customer and sellers,
//   • choose who gets whose phone number.
//
// strict:false so new fields never get silently dropped.
// ═════════════════════════════════════════════════════════════════════════════
import mongoose from "mongoose";

const ItemSchema = new mongoose.Schema({
  name:  { type: String, default: "" },
  qty:   { type: Number, default: 1 },
  unit:  { type: String, default: "" },
  notes: { type: String, default: "" }
}, { _id: false });

const SellerSchema = new mongoose.Schema({
  supplierId:  { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", default: null },
  phone:       { type: String, default: "" },
  name:        { type: String, default: "" },
  wasActive:   { type: Boolean, default: false },   // paid/trial at the time it was sent
  sentAt:      { type: Date, default: Date.now },
  status:      { type: String, default: "sent" },  // sent | replied | declined
  replyText:   { type: String, default: "" },
  replyImage:  { type: String, default: "" },
  replyAt:     { type: Date, default: null },
  customerPhoneShared: { type: Boolean, default: false },  // seller was given the customer's number
  sellerPhoneShared:   { type: Boolean, default: false }   // customer was given this seller's number
}, { _id: false });

const QuoteLineSchema = new mongoose.Schema({
  item:  { type: String, default: "" },
  qty:   { type: Number, default: 1 },
  unit:  { type: Number, default: 0 },   // unit price
  total: { type: Number, default: 0 }
}, { _id: false });

const QuoteSchema = new mongoose.Schema({
  number:     { type: String, default: "" },          // QR-7F3A2-1
  kind:       { type: String, default: "zimquote" },  // zimquote | seller
  supplierId: { type: mongoose.Schema.Types.ObjectId, default: null },
  sellerName: { type: String, default: "" },
  lines:      { type: [QuoteLineSchema], default: [] },
  notes:      { type: String, default: "" },
  total:      { type: Number, default: 0 },
  currency:   { type: String, default: "USD" },
  pdfUrl:     { type: String, default: "" },
  filename:   { type: String, default: "" },
  createdAt:  { type: Date, default: Date.now },
  sentAt:     { type: Date, default: null },
  deliveryPending: { type: Boolean, default: false },  // customer outside 24h window - deliver on next message
  response:   { type: String, default: "" },           // accepted | declined
  respondedAt:{ type: Date, default: null },
  // Books link: ZimQuote quotes are also saved as a real quotation (QT-…) in
  // the admin's own business books, so they can become an invoice + receipts.
  bookId:     { type: mongoose.Schema.Types.ObjectId, default: null },  // Invoice (type "quote")
  bookBizId:  { type: mongoose.Schema.Types.ObjectId, default: null }   // Business it was booked in
});

const BookEntrySchema = new mongoose.Schema({
  at:      { type: Date, default: Date.now },
  amount:  { type: Number, default: 0 },
  method:  { type: String, default: "" },
  number:  { type: String, default: "" },   // receipt number (payments)
  note:    { type: String, default: "" },
  pdfUrl:  { type: String, default: "" },
  refId:   { type: mongoose.Schema.Types.ObjectId, default: null }   // InvoicePayment / Expense id
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  at:    { type: Date, default: Date.now },
  from:  { type: String, default: "" },   // customer | admin | seller | system
  to:    { type: String, default: "" },   // customer | admin | seller
  phone: { type: String, default: "" },   // the seller's phone when from/to = seller
  name:  { type: String, default: "" },
  text:  { type: String, default: "" },
  media: { type: String, default: "" }
}, { _id: false });

const QuoteRequestSchema = new mongoose.Schema({
  ref:            { type: String, index: true },
  source:         { type: String, default: "whatsapp" },   // whatsapp | admin | link
  customerPhone:  { type: String, index: true },
  customerName:   { type: String, default: "" },
  text:           { type: String, default: "" },           // the customer's own words
  items:          { type: [ItemSchema], default: [] },
  city:           { type: String, default: "" },
  area:           { type: String, default: "" },
  photos:         { type: [String], default: [] },
  status: {
    type: String,
    enum: ["new", "working", "sent_to_sellers", "quoted", "accepted", "won", "lost", "closed", "cancelled"],
    default: "new",
    index: true
  },
  sellers:        { type: [SellerSchema], default: [] },
  quotes:         { type: [QuoteSchema], default: [] },
  messages:       { type: [MessageSchema], default: [] },
  adminNote:      { type: String, default: "" },
  dealValue:      { type: Number, default: null },
  commission:     { type: Number, default: null },
  // Accounting (admin's own business books)
  books: {
    bizId:         { type: mongoose.Schema.Types.ObjectId, default: null },
    invoiceId:     { type: mongoose.Schema.Types.ObjectId, default: null },
    invoiceNumber: { type: String, default: "" },
    invoicePdfUrl: { type: String, default: "" },
    invoiceTotal:  { type: Number, default: 0 },
    payments:      { type: [BookEntrySchema], default: [] },
    costs:         { type: [BookEntrySchema], default: [] },
    paid:          { type: Number, default: 0 },
    costTotal:     { type: Number, default: 0 }
  },
  customerLastMsgAt: { type: Date, default: Date.now },  // for the 24h WhatsApp window
  lastActivityAt: { type: Date, default: Date.now, index: true },
  closedAt:       { type: Date, default: null }
}, { timestamps: true, strict: false });

QuoteRequestSchema.index({ status: 1, lastActivityAt: -1 });
QuoteRequestSchema.index({ customerPhone: 1, createdAt: -1 });
QuoteRequestSchema.index({ "sellers.phone": 1 });

export default mongoose.models.QuoteRequest || mongoose.model("QuoteRequest", QuoteRequestSchema);

// models/mailAccount.js
// ZimQuote Mail: one connected email inbox that is delivered to WhatsApp.
import mongoose from "mongoose";

const PaymentSchema = new mongoose.Schema({
  reference:    String,
  plan:         String,
  amount:       Number,
  currency:     { type: String, default: "USD" },
  ecocashPhone: String,
  pollUrl:      String,
  status:       { type: String, default: "pending" }, // pending | paid | failed
  paidAt:       Date,
  createdAt:    { type: Date, default: Date.now }
}, { _id: false });

const MailAccountSchema = new mongoose.Schema({
  ownerPhone:   { type: String, required: true, index: true },   // 2637...
  email:        { type: String, required: true, lowercase: true, trim: true },
  displayName:  { type: String, default: "" },                   // used in replies: "Acme Ltd"

  // How mail reaches us
  //   forward: the customer forwards mail to <slug>@MAIL_INBOUND_DOMAIN
  //   imap:    we read the inbox with their mail login (cPanel, Zoho, Gmail app password)
  mode:         { type: String, enum: ["forward", "imap"], default: "forward" },
  slug:         { type: String, required: true, unique: true }, // forwarding address local part
  provider:     { type: String, default: "other" },             // google | microsoft | zoho | cpanel | other

  imap: {
    host: String, port: Number, secure: Boolean,
    user: String,
    passEnc: String,            // AES-256-GCM, see services/mailInbox.js
    lastUid: { type: Number, default: 0 },
    uidValidity: { type: String, default: "" },
    lastError: String, lastCheckedAt: Date,
    insecureTls: { type: Boolean, default: false }   // host's certificate doesn't match (common on shared cPanel)
  },
  smtp: { host: String, port: Number, secure: Boolean, insecureTls: { type: Boolean, default: false } },
  businessName: { type: String, default: "" },
  setupBy:      { type: String, default: "whatsapp" },          // whatsapp | web | admin
  phoneVerified:{ type: Boolean, default: true },                // web sign-ups: false until they confirm on WhatsApp
  linkCode:     { type: String, index: true },                   // ZQ:MAIL:<code> confirms the WhatsApp number
  webToken:     { type: String, index: true },                   // /mail/s/<token> status page
  helpRequestedAt: Date,

  // Who gets the WhatsApp alerts (owner is always included)
  alertPhones:  { type: [String], default: [] },
  alertMode:    { type: String, enum: ["all", "important"], default: "all" },
  signature:    { type: String, default: "" },

  // Setup state
  status:       { type: String, enum: ["setup", "live", "paused", "error"], default: "setup" },
  firstMailAt:  Date,
  lastMailAt:   Date,
  mailCount:    { type: Number, default: 0 },
  replyCount:   { type: Number, default: 0 },
  connectToken: String, connectTokenExp: Date,

  // Billing (annual)
  plan:         { type: String, default: "trial" },              // trial | starter | business
  paidUntil:    Date,
  trialEndsAt:  Date,
  payments:     { type: [PaymentSchema], default: [] },
  lastReminderAt: Date
}, { timestamps: true });

MailAccountSchema.index({ ownerPhone: 1, email: 1 }, { unique: true });

export default mongoose.models.MailAccount || mongoose.model("MailAccount", MailAccountSchema);

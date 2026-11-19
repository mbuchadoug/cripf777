// models/mailMessage.js
// One email received for a ZimQuote Mail account (text only; attachments in mail_attachments).
import mongoose from "mongoose";

const MailMessageSchema = new mongoose.Schema({
  accountId:   { type: mongoose.Schema.Types.ObjectId, ref: "MailAccount", index: true },
  ref:         { type: String, index: true },        // short code shown on WhatsApp, e.g. M7K2
  messageId:   String,                               // RFC Message-ID (threading + de-dupe)
  inReplyTo:   String,
  references:  String,
  fromName:    String,
  fromEmail:   String,
  replyTo:     String,
  to:          String,
  cc:          String,
  subject:     String,
  text:        String,                               // plain text, trimmed
  summary:     String,
  category:    String,                               // order | quote | payment | tender | support | personal | newsletter | other
  important:   { type: Boolean, default: false },
  muted:       { type: Boolean, default: false },    // newsletters / bulk mail: no alert
  attachments: [{ id: String, filename: String, contentType: String, size: Number }],
  skippedAttachments: [{ filename: String, size: Number }],       // too large to keep - open in the email app
  status:      { type: String, enum: ["new", "replied", "done"], default: "new" },
  alertedAt:   Date,
  replies: [{
    text: String, by: String, sentAt: Date, via: String, ok: Boolean, error: String, files: [String]
  }],
  receivedAt:  { type: Date, default: Date.now }
}, { timestamps: true });

MailMessageSchema.index({ accountId: 1, messageId: 1 });

export default mongoose.models.MailMessage || mongoose.model("MailMessage", MailMessageSchema);

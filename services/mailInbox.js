// services/mailInbox.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote MAIL - "your business email on WhatsApp"
// ─────────────────────────────────────────────────────────────────────────────
// A customer connects any email address (Gmail, Outlook, cPanel/local hosting,
// Zoho...). Every new email arrives on their WhatsApp with a short summary and
// buttons:  ↩️ Reply · 📄 Full email · ✅ Done.  They type a reply on WhatsApp
// (or pick a quick answer, or let ZimQuote polish it) and we send it as an email.
//
// TWO WAYS TO CONNECT (picked automatically from the address):
//   forward  The customer forwards mail to  <slug>@MAIL_INBOUND_DOMAIN.
//            Works for every provider. Gmail asks to confirm forwarding: we catch
//            Gmail's confirmation email and send the code to their WhatsApp.
//            Replies go out from our sending address with Reply-To = their email.
//   imap     The customer types their email password on a secure web page
//            (never on WhatsApp). Best for cPanel / local hosting / Zoho / Gmail
//            app passwords. Replies go out from THEIR own address via THEIR server.
//
// WhatsApp side: handleMailMessage() is called by chatbotEngine.js (top-level hook)
// and owns "mail_*" taps, the words "mail" / "ZQ:MAIL", and typed text while a
// mail flow is open (state in UserSession.tempData.mailState / mailData).
//
// .env
//   MAIL_INBOUND_DOMAIN   mail.zimquote.co.zw   (MX of this domain → our server)
//   MAIL_INBOUND_SECRET   long random string    (webhook /mail/inbound)
//   MAIL_SECRET_KEY       long random string    (encrypts saved mail passwords)
//   MAIL_OUT_HOST / MAIL_OUT_PORT / MAIL_OUT_USER / MAIL_OUT_PASS / MAIL_OUT_FROM
//                         SMTP used for replies of "forward" accounts
//   MAIL_PRICE_USD        60    (per inbox, per year)
//   MAIL_TRIAL_DAYS       1
//   MAIL_ALERT_TEMPLATE   zq_mail_alert  (approved UTILITY template, see DEPLOY.md)
// ═════════════════════════════════════════════════════════════════════════════

import crypto from "crypto";
import dns from "dns/promises";
import mongoose from "mongoose";
import axios from "axios";
import MailAccount from "../models/mailAccount.js";
import MailMessage from "../models/mailMessage.js";
import UserSession from "../models/userSession.js";
import { sendText, sendButtons, sendList, sendDocument } from "./metaSender.js";

// ─── Config ──────────────────────────────────────────────────────────────────
export const MAIL_CONFIG = {
  get INBOUND_DOMAIN() { return (process.env.MAIL_INBOUND_DOMAIN || "mail.zimquote.co.zw").toLowerCase(); },
  get SITE() { return (process.env.SITE_URL || "https://cripfcnt.com").replace(/\/$/, ""); },
  get PRICE() { return MAIL_PLANS.starter.price; },          // cheapest plan, used in short texts
  get TRIAL_DAYS() { const v = Number(process.env.MAIL_TRIAL_DAYS); return Number.isFinite(v) && v > 0 ? v : 1; },
  get TEMPLATE() { return process.env.MAIL_ALERT_TEMPLATE || "zq_mail_alert"; },
  // ONE ordinary mailbox (e.g. zqmail@zimqoute.co.zw on your cPanel) that customers forward to.
  // No MX changes or port 25 needed: we read it over IMAP like any other inbox.
  get COLLECTOR() {
    const e = process.env;
    if (!e.MAIL_COLLECTOR_USER || !e.MAIL_COLLECTOR_PASS) return null;
    return {
      host: e.MAIL_COLLECTOR_HOST || `mail.${String(e.MAIL_COLLECTOR_USER).split("@")[1]}`,
      port: Number(e.MAIL_COLLECTOR_PORT || 993),
      user: e.MAIL_COLLECTOR_USER, pass: e.MAIL_COLLECTOR_PASS,
      address: (e.MAIL_COLLECTOR_ADDRESS || e.MAIL_COLLECTOR_USER).toLowerCase(),
      plus: String(e.MAIL_COLLECTOR_PLUS || "") === "1",
      keep: String(e.MAIL_COLLECTOR_KEEP || "") === "1"
    };
  },
  TEAM_MAX: 3,              // extra WhatsApp numbers per inbox
  INBOX_MAX: 5,             // inboxes per WhatsApp number
  STATE_TTL_MIN: 60,
  MAX_TEXT: 8000,
  MAX_ATT_BYTES: 8 * 1024 * 1024,
  POLL_MS: 90 * 1000
};

const QUICK_ANSWERS = {
  q1: { title: "👍 Received, thanks", text: "Thank you for your email. We have received it and will get back to you shortly." },
  q2: { title: "📞 I'll call you", text: "Thank you for your email. I will call you shortly to discuss." },
  q3: { title: "💰 Quote coming", text: "Thank you for your enquiry. We are preparing a quotation and will send it to you shortly." }
};

// ─── Small helpers ───────────────────────────────────────────────────────────
const normPhone = (raw = "") => {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
};
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const oneLine = s => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());
const refOf = id => String(id).slice(-4).toUpperCase();
const daysFromNow = d => new Date(Date.now() + d * 86400000);
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Harare" }) : "-";
const fmtWhen = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare" }) : "-";
export const trialLabel = () => MAIL_CONFIG.TRIAL_DAYS === 1 ? "1 day free" : `${MAIL_CONFIG.TRIAL_DAYS} days free`;
const randSlug = () => crypto.randomBytes(5).toString("hex");           // 10 chars
export const forwardAddress = acc => {
  const c = MAIL_CONFIG.COLLECTOR;
  if (c) { const [l, d] = c.address.split("@"); return c.plus ? `${l}+${acc.slug}@${d}` : c.address; }
  return `${acc.slug}@${MAIL_CONFIG.INBOUND_DOMAIN}`;
};
// SMTP for replies of forwarding customers + test emails. Falls back to the collector mailbox's login.
export function platformSmtp() {
  const e = process.env, c = MAIL_CONFIG.COLLECTOR;
  const host = e.MAIL_OUT_HOST || (c ? (e.MAIL_COLLECTOR_SMTP_HOST || c.host) : "");
  if (!host) return null;
  const port = Number(e.MAIL_OUT_PORT || (c && !e.MAIL_OUT_HOST ? 465 : 587));
  const user = e.MAIL_OUT_USER || (!e.MAIL_OUT_HOST && c ? c.user : "");
  const pass = e.MAIL_OUT_PASS || (!e.MAIL_OUT_HOST && c ? c.pass : "");
  return {
    opts: { host, port, secure: port === 465, auth: user ? { user, pass } : undefined, tls: { rejectUnauthorized: String(e.MAIL_OUT_STRICT_TLS || "") === "1" }, connectionTimeout: 20000 },
    from: (e.MAIL_OUT_FROM || user || "").toLowerCase()
  };
}
export const guideUrl = acc => `${MAIL_CONFIG.SITE}/mail/guide/${acc.slug}`;

export function isActive(acc) {
  const now = Date.now();
  return (acc.paidUntil && new Date(acc.paidUntil).getTime() > now) ||
         (acc.trialEndsAt && new Date(acc.trialEndsAt).getTime() > now);
}
function planLine(acc) {
  const now = Date.now();
  if (acc.paidUntil && new Date(acc.paidUntil).getTime() > now) return `✅ Paid until ${fmtDate(acc.paidUntil)}`;
  if (acc.trialEndsAt && new Date(acc.trialEndsAt).getTime() > now) return `🎁 Free trial until ${fmtWhen(acc.trialEndsAt)}`;
  return `⛔ Expired - plans from $${MAIL_CONFIG.PRICE}/year`;
}

// ─── Encryption for saved mail passwords (AES-256-GCM) ───────────────────────
function _key() {
  const s = process.env.SESSION_SECRET;
  const k = process.env.MAIL_SECRET_KEY || (s && s !== "change_this_secret_for_dev_only" ? `zq-mail:${s}` : "");
  if (!k || k.length < 16) return null;
  return crypto.createHash("sha256").update(k).digest();
}
export function canStorePasswords() { return !!_key(); }
export function encryptSecret(plain) {
  const key = _key(); if (!key) throw new Error("MAIL_SECRET_KEY is not set");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}
export function decryptSecret(enc) {
  const key = _key(); if (!key || !enc) return "";
  const [iv, tag, data] = String(enc).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
// Signed links for attachments (no login needed, can't be guessed)
export function attToken(id) {
  const k = process.env.MAIL_SECRET_KEY || process.env.SESSION_SECRET || "zq-mail";
  return crypto.createHmac("sha256", k).update(String(id)).digest("hex").slice(0, 24);
}

// ─── Provider detection ──────────────────────────────────────────────────────
const KNOWN = {
  "gmail.com": "google", "googlemail.com": "google",
  "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft",
  "yahoo.com": "yahoo", "ymail.com": "yahoo",
  "zoho.com": "zoho", "zohomail.com": "zoho",
  "icloud.com": "apple", "me.com": "apple"
};
export async function detectProvider(email) {
  const domain = String(email).split("@")[1]?.toLowerCase() || "";
  if (KNOWN[domain]) return { provider: KNOWN[domain], domain, mx: "" };
  let mx = "";
  try {
    const recs = await dns.resolveMx(domain);
    recs.sort((a, b) => a.priority - b.priority);
    mx = (recs[0]?.exchange || "").toLowerCase();
  } catch (_) { /* no MX - leave blank */ }
  let provider = "cpanel";
  if (/google|googlemail/.test(mx)) provider = "google";
  else if (/outlook\.com|protection\.outlook|office365/.test(mx)) provider = "microsoft";
  else if (/zoho/.test(mx)) provider = "zoho";
  else if (/yahoo/.test(mx)) provider = "yahoo";
  else if (!mx) provider = "other";
  return { provider, domain, mx };
}
// Best guesses for IMAP/SMTP servers. The connect page lets the customer edit them.
export function guessServers(email, provider, mx = "") {
  const domain = String(email).split("@")[1] || "";
  switch (provider) {
    case "google": return { imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true } };
    case "zoho":   return { imap: { host: "imap.zoho.com", port: 993, secure: true }, smtp: { host: "smtp.zoho.com", port: 465, secure: true } };
    case "yahoo":  return { imap: { host: "imap.mail.yahoo.com", port: 993, secure: true }, smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true } };
    case "apple":  return { imap: { host: "imap.mail.me.com", port: 993, secure: true }, smtp: { host: "smtp.mail.me.com", port: 587, secure: false } };
    case "microsoft": return { imap: { host: "outlook.office365.com", port: 993, secure: true }, smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false } };
    default:       return { imap: { host: `mail.${domain}`, port: 993, secure: true }, smtp: { host: `mail.${domain}`, port: 465, secure: true }, alt: [mx, `imap.${domain}`].filter(Boolean) };
  }
}

// ─── Session state (UserSession.tempData.mailState / mailData) ───────────────
async function getSess(phone) {
  const s = await UserSession.findOne({ phone }).lean().catch(() => null);
  const td = s?.tempData || {};
  let state = td.mailState || "";
  const at = td.mailStateAt ? new Date(td.mailStateAt).getTime() : 0;
  if (state && at && Date.now() - at > MAIL_CONFIG.STATE_TTL_MIN * 60000) { state = ""; await clearState(phone); }
  return { state, data: { ...(td.mailData || {}) } };
}
async function setState(phone, state, data = {}) {
  await UserSession.updateOne({ phone },
    { $set: { "tempData.mailState": state, "tempData.mailData": data, "tempData.mailStateAt": new Date() } },
    { upsert: true }).catch(e => console.error("[MAIL STATE]", e.message));
}
async function clearState(phone) {
  await UserSession.updateOne({ phone },
    { $unset: { "tempData.mailState": "", "tempData.mailData": "", "tempData.mailStateAt": "" } }).catch(() => {});
}

// ─── 24-hour window tracking (only for people who use Mail) ──────────────────
// Free-form WhatsApp messages only arrive within 24h of the person's last message.
// Outside that window we must use the approved template.
const _mailPhones = { set: new Set(), at: 0 };
async function mailPhones() {
  if (Date.now() - _mailPhones.at < 5 * 60000) return _mailPhones.set;
  const accs = await MailAccount.find({}, { ownerPhone: 1, alertPhones: 1 }).lean().catch(() => []);
  const s = new Set();
  for (const a of accs) { s.add(a.ownerPhone); (a.alertPhones || []).forEach(p => s.add(p)); }
  _mailPhones.set = s; _mailPhones.at = Date.now();
  return s;
}
const seenCol = () => mongoose.connection.collection("mail_wa_seen");
async function markSeen(phone) {
  try { if ((await mailPhones()).has(phone)) await seenCol().updateOne({ _id: phone }, { $set: { at: new Date() } }, { upsert: true }); } catch (_) {}
}
async function inWindow(phone) {
  try { const r = await seenCol().findOne({ _id: phone }); return !!(r && Date.now() - new Date(r.at).getTime() < 23 * 3600000); }
  catch (_) { return false; }
}

// ─── WhatsApp template (3 quick-reply buttons with per-email payloads) ───────
async function sendMailTemplate(to, vars, msgId) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const btn = (i, payload) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] });
  await axios.post(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp", to: normPhone(to), type: "template",
    template: {
      name: MAIL_CONFIG.TEMPLATE, language: { code: "en" },
      components: [
        { type: "body", parameters: vars.map(v => ({ type: "text", text: clip(oneLine(v), 300) || "-" })) },
        btn(0, `mail_reply_${msgId}`), btn(1, `mail_open_${msgId}`), btn(2, `mail_done_${msgId}`)
      ]
    }
  }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
}

// ═════════════════════════════════════════════════════════════════════════════
// INBOUND: raw email → MailMessage → WhatsApp alert
// ═════════════════════════════════════════════════════════════════════════════
const attCol = () => mongoose.connection.collection("mail_attachments");

function stripQuoted(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{5,200}wrote:\s*$/i.test(l.trim())) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l.trim())) break;
    if (/^From:\s.+/i.test(l.trim()) && i > 0 && /^(Sent|Date|To|Subject):/i.test((lines[i + 1] || "").trim())) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function guessCategory(subject, text) {
  const s = `${subject} ${text}`.toLowerCase();
  if (/\b(purchase order|p\.?o\.? ?#?\d|order no|we would like to order|please supply)\b/.test(s)) return "order";
  if (/\b(quotation|quote|rfq|request for quot|price list|pricing)\b/.test(s)) return "quote";
  if (/\b(invoice|payment|proof of payment|pop|remittance|statement|overdue|receipt)\b/.test(s)) return "payment";
  if (/\b(tender|bid|eoi|expression of interest|procurement|praz)\b/.test(s)) return "tender";
  if (/\b(complain|not working|faulty|broken|urgent|asap)\b/.test(s)) return "support";
  return "other";
}

async function aiSummary({ fromName, subject, text }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text) return null;
  try {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: process.env.MAIL_AI_MODEL || "gpt-4o-mini",
      temperature: 0.2, max_tokens: 160,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You summarise business emails for a busy Zimbabwean business owner reading on WhatsApp. Reply as JSON: {\"summary\": one or two short plain sentences with the key ask, amounts, quantities and dates, max 220 characters; \"category\": one of order, quote, payment, tender, support, personal, newsletter, other; \"important\": true if it needs action soon or involves money, an order, a quote or a tender}." },
        { role: "user", content: `From: ${fromName}\nSubject: ${subject}\n\n${String(text).slice(0, 4000)}` }
      ]
    }, { headers: { Authorization: `Bearer ${key}` }, timeout: 12000 });
    const j = JSON.parse(r.data?.choices?.[0]?.message?.content || "{}");
    return { summary: clip(j.summary, 240), category: j.category || "other", important: !!j.important };
  } catch (e) { console.warn("[MAIL AI]", e.message); return null; }
}

// Gmail sends this to the forwarding address before forwarding starts.
function gmailForwardConfirm(parsed) {
  const from = (parsed.from?.value?.[0]?.address || "").toLowerCase();
  if (!/forwarding-noreply@google\.com/.test(from)) return null;
  const all = `${parsed.subject || ""}\n${parsed.text || ""}`;
  const code = (all.match(/#?(\d{6,12})\)?/) || [])[1] || "";
  const link = (String(parsed.text || "").match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>"]+/) || [])[0] || "";
  return { code, link };
}

/**
 * Process one raw RFC-822 email.
 * @param {Buffer|string} raw
 * @param {object} opts  { rcpt: envelope recipient (forward mode) } OR { account } (imap mode)
 */
const _addrs = v => {
  const out = [];
  const walk = x => { if (!x) return; if (Array.isArray(x)) return x.forEach(walk); if (x.value) return walk(x.value); if (x.address) out.push(String(x.address).toLowerCase()); if (x.group) walk(x.group); if (typeof x === "string") (x.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).forEach(a => out.push(a.toLowerCase())); };
  walk(v); return out;
};

/** Which customer inboxes is this forwarded email for? (collector mailbox) */
async function resolveCollectorAccounts(parsed) {
  const h = parsed.headers;
  const envelope = [..._addrs(h.get("delivered-to")), ..._addrs(h.get("x-original-to")), ..._addrs(h.get("envelope-to")), ..._addrs(h.get("x-forwarded-to")), ..._addrs(h.get("x-forwarded-for"))];
  // 1. plus-address tag: zqmail+<slug>@...
  for (const a of [...envelope, ..._addrs(parsed.to), ..._addrs(parsed.cc)]) {
    const m = a.match(/^[^+@]+\+([a-f0-9]{10})@/);
    if (m) { const acc = await MailAccount.findOne({ slug: m[1] }); if (acc) return [acc]; }
  }
  // 2. Gmail's forwarding confirmation names the address in the subject
  const conf = String(parsed.subject || "").match(/Receive Mail from\s+([^\s]+@[^\s]+)/i);
  if (conf) return MailAccount.find({ email: conf[1].toLowerCase() });
  // 3. the customer's own address in the envelope / To / Cc headers
  const col = MAIL_CONFIG.COLLECTOR?.address;
  const cands = [...new Set([...envelope, ..._addrs(parsed.to), ..._addrs(parsed.cc)])].filter(a => a !== col);
  if (!cands.length) return [];
  const accs = await MailAccount.find({ email: { $in: cands }, mode: "forward" });
  // prefer envelope matches (Bcc / aliases) when there are several
  const env = accs.filter(a => envelope.includes(a.email));
  return env.length ? env : accs;
}

export async function ingestRaw(raw, { rcpt = "", account = null, collector = false } = {}) {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(raw);

  if (account) return ingestParsed(parsed, account);
  if (collector) {
    const accs = await resolveCollectorAccounts(parsed);
    if (!accs.length) return { skipped: "no matching inbox" };
    const results = [];
    for (const acc of accs) results.push(await ingestParsed(parsed, acc));
    return results.length === 1 ? results[0] : { ok: true, results };
  }
  const rc = String(rcpt || "").toLowerCase().trim();
  const [local, dom] = rc.split("@");
  if (!local || dom !== MAIL_CONFIG.INBOUND_DOMAIN) return { skipped: "unknown recipient" };
  const acc = await MailAccount.findOne({ slug: local.split("+")[0] });
  if (!acc) return { skipped: "no account" };
  return ingestParsed(parsed, acc);
}

async function ingestParsed(parsed, acc) {

  // 2. Gmail forwarding confirmation → send the code to WhatsApp
  const g = gmailForwardConfirm(parsed);
  if (g) {
    await notifyOwner(acc,
      `🔐 *Gmail needs one more step*\n\nGmail sent a confirmation code for *${acc.email}*:\n\n*${g.code || "(see link)"}*\n\n` +
      `In Gmail → Settings → *Forwarding and POP/IMAP*, paste the code and tap *Verify*. Then choose *Forward a copy of incoming mail* and *Save Changes*.` +
      (g.link ? `\n\nOr open this link to confirm:\n${g.link}` : ""),
      [{ id: `mail_guide_${acc._id}`, title: "📖 Show me how" }]);
    return { confirm: true };
  }

  // 3. Loop / junk protection
  if (parsed.headers.get("x-zimquote-mail")) return { skipped: "own message" };
  const fromAddr = (parsed.from?.value?.[0]?.address || "").toLowerCase();
  const isTest = !!parsed.headers.get("x-zimquote-test");
  const ownFrom = platformSmtp()?.from || "";
  if (!isTest && fromAddr && ownFrom && fromAddr === ownFrom) return { skipped: "own sender" };
  const messageId = parsed.messageId || `<zq-${crypto.randomBytes(8).toString("hex")}@local>`;
  if (await MailMessage.exists({ accountId: acc._id, messageId })) return { skipped: "duplicate" };

  const precedence = String(parsed.headers.get("precedence") || "").toLowerCase();
  const autoSub = String(parsed.headers.get("auto-submitted") || "").toLowerCase();
  const listHdr = parsed.headers.get("list") || {};          // mailparser groups List-* headers here
  const bulk = !!(parsed.headers.get("list-unsubscribe") || listHdr.unsubscribe || listHdr.id) || /bulk|list|junk/.test(precedence);
  const autoReply = !!autoSub && autoSub !== "no";

  // 4. Text + attachments
  const text = stripQuoted(parsed.text || "").slice(0, MAIL_CONFIG.MAX_TEXT);
  const subject = oneLine(parsed.subject || "(no subject)");
  const fromName = oneLine(parsed.from?.value?.[0]?.name || fromAddr || "Unknown sender");
  const attachments = [], skippedAttachments = [];
  for (const a of (parsed.attachments || []).slice(0, 12)) {
    if (!a?.content) continue;
    const size = a.size || a.content.length;
    if (a.related && /^image\//.test(a.contentType || "") && size < 40000) continue;   // logos in signatures
    const filename = a.filename || (/^image\//.test(a.contentType || "") ? "image" : "attachment");
    if (size > maxInBytes()) { skippedAttachments.push({ filename, size }); continue; }
    const id = crypto.randomBytes(10).toString("hex");
    try {
      await saveAttachment(id, { accountId: acc._id, filename, contentType: a.contentType || "application/octet-stream", data: a.content });
      attachments.push({ id, filename, contentType: a.contentType, size });
    } catch (e) { console.warn("[MAIL ATT]", e.message); skippedAttachments.push({ filename, size }); }
  }

  // 5. Summary + category
  let ai = null;
  if (!bulk && !autoReply) ai = await aiSummary({ fromName, subject, text });
  const category = bulk ? "newsletter" : (ai?.category || guessCategory(subject, text));
  const important = !bulk && (ai ? ai.important : ["order", "quote", "payment", "tender", "support"].includes(category));
  const summary = ai?.summary || clip(text, 220) || "(no text - see attachments)";

  const msg = await MailMessage.create({
    accountId: acc._id, messageId,
    inReplyTo: parsed.inReplyTo || "", references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references || ""),
    fromName, fromEmail: fromAddr,
    replyTo: (parsed.replyTo?.value?.[0]?.address || "").toLowerCase(),
    to: parsed.to?.text || "", cc: parsed.cc?.text || "",
    subject, text, summary, category, important,
    muted: bulk || autoReply, attachments, skippedAttachments,
    receivedAt: parsed.date || new Date()
  });
  msg.ref = refOf(msg._id); await msg.save();

  const firstEver = !acc.firstMailAt;
  await MailAccount.updateOne({ _id: acc._id }, {
    $set: { lastMailAt: new Date(), ...(firstEver ? { firstMailAt: new Date() } : {}), ...(acc.status === "setup" ? { status: "live" } : {}) },
    $inc: { mailCount: 1 }
  });
  if (firstEver) {
    await sendConnectedMessage(acc, "Your emails will now arrive here on WhatsApp. Tap *↩️ Reply* on any email to answer it from here.").catch(() => {});
  }

  // 6. Alert
  if (!msg.muted && (acc.alertMode === "all" || important) && acc.status !== "paused") {
    await alertNewMail(acc, msg).catch(e => console.error("[MAIL ALERT]", e.message));
  }
  return { ok: true, id: String(msg._id) };
}

async function notifyOwner(acc, text, buttons = null) {
  if (buttons?.length) return sendButtons(acc.ownerPhone, { text, buttons }).catch(() => sendText(acc.ownerPhone, text));
  return sendText(acc.ownerPhone, text);
}

const CAT_ICON = { order: "🛒", quote: "💬", payment: "💵", tender: "📑", support: "🛠️", personal: "👤", newsletter: "📰", other: "📧" };

export async function alertNewMail(acc, msg) {
  if (acc.phoneVerified === false) return;      // web sign-up not yet confirmed on WhatsApp
  const phones = [...new Set([acc.ownerPhone, ...(acc.alertPhones || [])])].filter(Boolean).map(normPhone);

  if (!isActive(acc)) {     // expired: tease, so they renew
    for (const p of phones.slice(0, 1)) {
      await sendButtons(p, {
        text: `📧 *New email for ${acc.email}*\nFrom: *${clip(msg.fromName, 60)}*\n\n⛔ Your ZimQuote Mail plan has ended, so we can't show it.\nPlans from *$${MAIL_CONFIG.PRICE}/year* - choose one to read and reply on WhatsApp.`,
        buttons: [{ id: `mail_pay_${acc._id}`, title: "💳 Renew now" }]
      }).catch(() => {});
    }
    return;
  }

  // Monthly alert allowance for the plan (keeps WhatsApp costs inside what the plan pays)
  const month = new Date().toISOString().slice(0, 7);
  const used = acc.alertMonth === month ? (acc.alertsThisMonth || 0) : 0;
  const cap = planLimits(acc).alerts;
  if (used >= cap && (!msg.important || used >= Math.round(cap * 1.5))) {
    if (acc.capNotifiedMonth !== month) {
      await MailAccount.updateOne({ _id: acc._id }, { $set: { capNotifiedMonth: month } });
      await sendButtons(acc.ownerPhone, {
        text: `📧 *${acc.email}* has used this month's ${cap} WhatsApp email alerts.

You'll still get alerts for important emails (orders, quotes, payments). All emails are saved in 📬 Inbox. Upgrade for more alerts.`,
        buttons: [{ id: `mail_pay_${acc._id}`, title: "💳 Upgrade" }, { id: `mail_inbox_${acc._id}_0`, title: "📬 Inbox" }]
      }).catch(() => {});
    }
    return;
  }
  await MailAccount.updateOne({ _id: acc._id }, acc.alertMonth === month ? { $inc: { alertsThisMonth: 1 } } : { $set: { alertMonth: month, alertsThisMonth: 1 } });

  const icon = CAT_ICON[msg.category] || "📧";
  const att = (msg.attachments?.length ? `\n📎 ${msg.attachments.length} attachment${msg.attachments.length > 1 ? "s" : ""}: ${clip(msg.attachments.map(x => x.filename).join(", "), 120)}` : "") +
    (msg.skippedAttachments?.length ? `\n⚠️ ${msg.skippedAttachments.length} file${msg.skippedAttachments.length > 1 ? "s" : ""} too large for WhatsApp - open in your email app` : "");
  const text =
    `${icon} *New email${msg.important ? " - needs action" : ""}*\n` +
    `📥 ${acc.email}\n` +
    `From: *${clip(msg.fromName, 60)}*${msg.fromEmail && msg.fromEmail !== msg.fromName ? ` (${msg.fromEmail})` : ""}\n` +
    `Subject: ${clip(msg.subject, 120)}\n\n` +
    `📝 ${msg.summary}${att}\n\nRef: ${msg.ref}`;
  const buttons = [
    { id: `mail_reply_${msg._id}`, title: "↩️ Reply" },
    { id: `mail_open_${msg._id}`, title: "📄 Full email" },
    { id: `mail_done_${msg._id}`, title: "✅ Done" }
  ];

  for (const p of phones) {
    let sent = false;
    if (await inWindow(p)) {
      try { await sendButtons(p, { text, buttons }); sent = true; } catch (_) {}
    }
    if (!sent) {
      try {
        await sendMailTemplate(p, [acc.email, `${msg.fromName}${msg.fromEmail ? ` (${msg.fromEmail})` : ""}`, msg.subject, msg.summary], msg._id);
        sent = true;
      } catch (e) {
        console.warn(`[MAIL ALERT] template failed for ${p}: ${e?.response?.data?.error?.message || e.message}`);
        try { await sendButtons(p, { text, buttons }); sent = true; } catch (_) {}
      }
    }
  }
  await MailMessage.updateOne({ _id: msg._id }, { $set: { alertedAt: new Date() } });
}

// ═════════════════════════════════════════════════════════════════════════════
// OUTBOUND: send a reply
// ═════════════════════════════════════════════════════════════════════════════
function htmlEscape(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function buildReply(acc, msg, body) {
  const to = msg.replyTo || msg.fromEmail;
  const subject = /^re:/i.test(msg.subject || "") ? msg.subject : `Re: ${msg.subject || ""}`;
  const sig = acc.signature ? `\n\n${acc.signature}` : "";
  const waNumber = normPhone(acc.ownerPhone);
  const waLink = `https://wa.me/${waNumber}`;
  const quoted = String(msg.text || "").split("\n").slice(0, 30).map(l => `> ${l}`).join("\n");
  const when = new Date(msg.receivedAt || Date.now()).toUTCString();
  const textPart = `${body}${sig}\n\nChat with us on WhatsApp: ${waLink}\n\nOn ${when}, ${msg.fromName} <${msg.fromEmail}> wrote:\n${quoted}`;
  const htmlPart =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2933">` +
    `${htmlEscape(body).replace(/\n/g, "<br>")}${sig ? "<br><br>" + htmlEscape(acc.signature).replace(/\n/g, "<br>") : ""}` +
    `<p style="margin:18px 0"><a href="${waLink}" style="display:inline-block;background:#1fa855;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:bold">💬 Reply on WhatsApp</a></p>` +
    `<div style="color:#6b7280;border-left:3px solid #d1d5db;padding-left:10px;margin-top:16px">On ${htmlEscape(when)}, ${htmlEscape(msg.fromName)} &lt;${htmlEscape(msg.fromEmail)}&gt; wrote:<br>${htmlEscape(String(msg.text || "").slice(0, 3000)).replace(/\n/g, "<br>")}</div></div>`;
  const refs = [msg.references, msg.messageId].filter(Boolean).join(" ").trim();
  return { to, subject, text: textPart, html: htmlPart, inReplyTo: msg.messageId, references: refs };
}

async function transportFor(acc) {
  const nodemailer = (await import("nodemailer")).default;
  const cred = acc.mode === "pop3" ? acc.pop : acc.imap;
  if ((acc.mode === "imap" || acc.mode === "pop3") && acc.smtp?.host && cred?.passEnc) {
    return {
      t: nodemailer.createTransport({ host: acc.smtp.host, port: acc.smtp.port || 465, secure: acc.smtp.secure !== false, auth: { user: cred.user || acc.email, pass: decryptSecret(cred.passEnc) }, ...(acc.smtp.insecureTls ? { tls: { rejectUnauthorized: false } } : {}) }),
      from: acc.displayName ? `"${acc.displayName.replace(/"/g, "")}" <${acc.email}>` : acc.email,
      via: "own"
    };
  }
  const ps = platformSmtp();
  if (!ps) throw new Error("Sending is not set up yet: add MAIL_COLLECTOR_USER / MAIL_COLLECTOR_PASS (or MAIL_OUT_HOST) to .env");
  const name = (acc.displayName || acc.email).replace(/"/g, "");
  return {
    t: nodemailer.createTransport(ps.opts),
    from: `"${name} via ZimQuote" <${ps.from}>`,
    replyTo: acc.email,
    via: "zimquote"
  };
}

export async function sendReply(acc, msg, body, byPhone, files = []) {
  const r = buildReply(acc, msg, body);
  if (!r.to || !isEmail(r.to)) throw new Error("This email has no reply address");
  const { t, from, replyTo, via } = await transportFor(acc);
  const MailComposer = (await import("nodemailer/lib/mail-composer/index.js")).default;
  const attachments = [];
  for (const f of (files || [])) {
    const got = await readAttachment(f.id);
    if (!got) throw new Error(`The file ${f.filename} is no longer available. Send it again.`);
    attachments.push({ filename: f.filename || got.doc.filename, content: got.data, contentType: f.contentType || got.doc.contentType });
  }
  const mailOpts = {
    from, to: r.to, subject: r.subject, text: r.text, html: r.html,
    inReplyTo: r.inReplyTo, references: r.references,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
    headers: { "X-ZimQuote-Mail": "reply" }
  };
  const raw = await new MailComposer(mailOpts).compile().build();
  try {
    await t.sendMail({ envelope: { from: from.match(/<([^>]+)>/)?.[1] || from, to: [r.to] }, raw });
  } catch (e) {
    await MailMessage.updateOne({ _id: msg._id }, { $push: { replies: { text: body, by: byPhone, sentAt: new Date(), via, ok: false, error: e.message } } });
    throw e;
  }
  await MailMessage.updateOne({ _id: msg._id }, { $set: { status: "replied" }, $push: { replies: { text: body, by: byPhone, sentAt: new Date(), via, ok: true, files: (files || []).map(f => f.filename) } } });
  await MailAccount.updateOne({ _id: acc._id }, { $inc: { replyCount: 1 } });
  // Put a copy in their Sent folder (Gmail already does this itself)
  if (via === "own" && acc.mode === "imap" && acc.provider !== "google") appendToSent(acc, raw).catch(e => console.warn("[MAIL SENT COPY]", e.message));
  return { to: r.to, via };
}

async function appendToSent(acc, raw) {
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({ host: acc.imap.host, port: acc.imap.port || 993, secure: acc.imap.secure !== false, auth: { user: acc.imap.user || acc.email, pass: decryptSecret(acc.imap.passEnc) }, logger: false, ...(acc.imap.insecureTls ? { tls: { rejectUnauthorized: false } } : {}) });
  await c.connect();
  try {
    const boxes = await c.list();
    const sent = boxes.find(b => b.specialUse === "\\Sent") || boxes.find(b => /^(inbox\.)?sent( items| messages)?$/i.test(b.path));
    if (sent) await c.append(sent.path, raw, ["\\Seen"]);
  } finally { await c.logout().catch(() => {}); }
}

async function polish(text, msg, acc) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: process.env.MAIL_AI_MODEL || "gpt-4o-mini", temperature: 0.3, max_tokens: 400,
      messages: [
        { role: "system", content: "Rewrite the business owner's short WhatsApp note as a clear, polite, professional email reply. Keep every fact, price, quantity and date exactly as given. Do not invent anything. No subject line, no signature, no placeholders. British English. Keep it short." },
        { role: "user", content: `Email we are replying to (from ${msg.fromName}):\n${String(msg.text || "").slice(0, 1500)}\n\nOwner's note:\n${text}` }
      ]
    }, { headers: { Authorization: `Bearer ${key}` }, timeout: 15000 });
    return String(r.data?.choices?.[0]?.message?.content || "").trim() || null;
  } catch (e) { console.warn("[MAIL POLISH]", e.message); return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// IMAP POLLER (accounts connected with a password)
// ═════════════════════════════════════════════════════════════════════════════
const _imapBusy = new Set();

export async function testImap({ host, port, secure, user, pass, insecureTls = false }) {
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, socketTimeout: 20000, connectionTimeout: 15000, ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}) });
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  let uidNext = 1, uidValidity = "";
  try { uidNext = c.mailbox.uidNext || 1; uidValidity = String(c.mailbox.uidValidity || ""); }
  finally { lock.release(); await c.logout().catch(() => {}); }
  return { uidNext, uidValidity };
}
export async function testSmtp({ host, port, secure, user, pass, insecureTls = false }) {
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout: 15000, ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}) });
  await t.verify();
}

export async function pollImapAccount(acc) {
  const id = String(acc._id);
  if (_imapBusy.has(id)) return;
  _imapBusy.add(id);
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({ host: acc.imap.host, port: acc.imap.port || 993, secure: acc.imap.secure !== false, auth: { user: acc.imap.user || acc.email, pass: decryptSecret(acc.imap.passEnc) }, logger: false, socketTimeout: 30000, ...(acc.imap.insecureTls ? { tls: { rejectUnauthorized: false } } : {}) });
  try {
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      const uv = String(c.mailbox.uidValidity || "");
      let last = acc.imap.lastUid || 0;
      if (!acc.imap.uidValidity || uv !== acc.imap.uidValidity) {      // first run, or the mailbox was rebuilt
        last = Math.max(0, (c.mailbox.uidNext || 1) - 1);       // start from "now", never flood old mail
        await MailAccount.updateOne({ _id: acc._id }, { $set: { "imap.lastUid": last, "imap.uidValidity": uv } });
      } else {
        let maxUid = last, n = 0;
        for await (const m of c.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= last) continue;
          maxUid = Math.max(maxUid, m.uid);
          if (++n > 25) break;
          try { await ingestRaw(m.source, { account: acc }); } catch (e) { console.error("[MAIL IMAP INGEST]", e.message); }
        }
        await MailAccount.updateOne({ _id: acc._id }, { $set: { "imap.lastUid": maxUid, "imap.lastCheckedAt": new Date(), "imap.lastError": "", ...(acc.status === "error" ? { status: "live" } : {}) } });
      }
    } finally { lock.release(); }
  } catch (e) {
    const msg = e?.responseText || e.message || "connection failed";
    const wasOk = acc.status !== "error";
    await MailAccount.updateOne({ _id: acc._id }, { $set: { "imap.lastError": msg, "imap.lastCheckedAt": new Date(), ...(e.authenticationFailed ? { status: "error" } : {}) } });
    if (e.authenticationFailed && wasOk) {
      await notifyOwner(acc, `⚠️ *We can't open ${acc.email}*\n\nThe email password was refused (maybe it was changed). Tap below to connect again.`,
        [{ id: `mail_reconnect_${acc._id}`, title: "🔑 Reconnect" }]).catch(() => {});
    }
  } finally {
    await c.logout().catch(() => {});
    _imapBusy.delete(id);
  }
}

let _pollerStarted = false;
export function startMailPoller() {
  if (_pollerStarted) return; _pollerStarted = true;
  const tick = async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const accs = await MailAccount.find({ mode: { $in: ["imap", "pop3"] }, status: { $in: ["live", "error"] } }).lean();
      const due = accs.filter(isActive);
      for (let i = 0; i < due.length; i += 4) await Promise.allSettled(due.slice(i, i + 4).map(a => a.mode === "pop3" ? pollPopAccount(a) : pollImapAccount(a)));
      await pollCollector();
    } catch (e) { console.error("[MAIL POLLER]", e.message); }
  };
  setInterval(tick, MAIL_CONFIG.COLLECTOR ? 45000 : MAIL_CONFIG.POLL_MS);
  setTimeout(tick, 20000);
  setInterval(sendPlanReminders, 6 * 3600000);
  console.log(`[MAIL] poller started${MAIL_CONFIG.COLLECTOR ? ` - forwarding mailbox ${MAIL_CONFIG.COLLECTOR.address}` : ""}`);
}

async function sendPlanReminders() {
  try {
    const now = new Date(), since = new Date(Date.now() - 20 * 3600000);
    const accs = await MailAccount.find({
      $or: [{ paidUntil: { $gt: now, $lt: daysFromNow(7) } }, { paidUntil: null, trialEndsAt: { $gt: new Date(Date.now() - 86400000), $lt: new Date(Date.now() + 6 * 3600000) } }],
      $and: [{ $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: since } }] }]
    }).setOptions({ strictQuery: false }).lean();
    for (const a of accs) {
      const end = a.paidUntil || a.trialEndsAt;
      const ended = new Date(end) < now;
      await sendButtons(a.ownerPhone, {
        text: `📧 *ZimQuote Mail - ${a.email}*\n\n${ended ? "Your free trial has ended." : `Your ${a.paidUntil ? "plan" : "free trial"} ends *${a.paidUntil ? fmtDate(end) : fmtWhen(end)}*.`}\n\n${await pricingText(a)}`,
        buttons: [{ id: `mail_pay_${a._id}`, title: "💳 Choose a plan" }]
      }).catch(() => {});
      await MailAccount.updateOne({ _id: a._id }, { $set: { lastReminderAt: new Date() } });
    }
  } catch (e) { console.error("[MAIL REMIND]", e.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// PLANS + PAYMENTS (EcoCash via Paynow, annual only)
// ─────────────────────────────────────────────────────────────────────────────
// Costs we carry per inbox: WhatsApp utility templates for alerts sent outside the
// 24h window (Meta charges per message), AI summaries (~$0.0003/email) and storage.
// Each plan caps WhatsApp alerts per month so a busy inbox can't cost more than it pays.
// Over the cap, only important emails (orders, quotes, payments, tenders) are alerted;
// everything is still saved and readable in 📬 Latest emails.
// ═════════════════════════════════════════════════════════════════════════════
const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const MAIL_PLANS = {
  get starter()  { return { key: "starter",  name: "Starter",  price: envNum("MAIL_PRICE_STARTER", envNum("MAIL_PRICE_USD", 60)),  team: 1, alerts: 300,  blurb: "300 alerts a month · 1 staff number" }; },
  get business() { return { key: "business", name: "Business", price: envNum("MAIL_PRICE_BUSINESS", 120), team: 3, alerts: 1000, blurb: "1,000 alerts a month · 3 staff numbers" }; },
  get pro()      { return { key: "pro",      name: "Pro",      price: envNum("MAIL_PRICE_PRO", 240),      team: 5, alerts: 3000, blurb: "3,000 alerts a month · 5 staff numbers" }; }
};
const PLAN_KEYS = ["starter", "business", "pro"];
export const SUPPLIER_DISCOUNT = () => Math.min(0.9, Math.max(0, Number(process.env.MAIL_SUPPLIER_DISCOUNT ?? 0.25)));

/** Current limits for an inbox (trial = Business limits). */
export function planLimits(acc) {
  const paid = acc.paidUntil && new Date(acc.paidUntil).getTime() > Date.now();
  if (paid && MAIL_PLANS[acc.plan]) return MAIL_PLANS[acc.plan];
  if (paid) return MAIL_PLANS.starter;
  return { ...MAIL_PLANS.business, key: "trial", name: "Free trial", price: 0 };
}
/** Price for this owner (listed ZimQuote suppliers get a discount). */
export async function priceFor(acc, planKey) {
  const base = MAIL_PLANS[planKey]?.price || MAIL_PLANS.starter.price;
  let supplier = false;
  try {
    const SP = (await import("../models/supplierProfile.js")).default;
    supplier = !!(await SP.exists({ phone: acc.ownerPhone, active: true }));
  } catch (_) {}
  const price = supplier ? Math.round(base * (1 - SUPPLIER_DISCOUNT())) : base;
  return { price, base, supplier };
}

async function startPayment(from, acc, ecocash, planKey = "starter") {
  const plan = MAIL_PLANS[planKey] || MAIL_PLANS.starter;
  const { price } = await priceFor(acc, plan.key);
  const paynow = (await import("./paynow.js")).default;
  const reference = `MAIL_${acc._id}_${Date.now()}`;
  const payment = paynow.createPayment(reference, process.env.PAYNOW_AUTH_EMAIL || "bmusasa99@gmail.com");
  payment.currency = "USD";
  payment.add(`ZimQuote Mail ${plan.name} - ${acc.email} (1 year)`, price);
  const response = await paynow.sendMobile(payment, ecocash, "ecocash");
  if (!response?.success || !response.pollUrl) throw new Error(response?.error || "EcoCash did not start. Check the number and try again.");
  await MailAccount.updateOne({ _id: acc._id }, { $push: { payments: { reference, plan: plan.key, amount: price, ecocashPhone: ecocash, pollUrl: response.pollUrl, status: "pending" } } });
  await sendText(from, `💳 *Payment request sent*\n\nPlan: *${plan.name}* (1 year)\nAmount: *$${price} USD*\nEcoCash: *${ecocash}*\n\n👉 Check your phone and approve the EcoCash prompt. We'll confirm here.`);

  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    try {
      const st = await paynow.pollTransaction(response.pollUrl);
      const s = String(st?.status || "").toLowerCase();
      if (s === "paid") {
        clearInterval(iv);
        await activatePaid(acc._id, reference, from, 365, plan.key);
      } else if (["cancelled", "failed"].includes(s) || tries >= 24) {
        clearInterval(iv);
        await MailAccount.updateOne({ _id: acc._id, "payments.reference": reference }, { $set: { "payments.$.status": "failed" } });
        await sendButtons(from, { text: "❌ The EcoCash payment was not completed.", buttons: [{ id: `mail_pay_${acc._id}`, title: "🔁 Try again" }] }).catch(() => {});
      }
    } catch (e) { if (tries >= 24) clearInterval(iv); }
  }, 10000);
}

export async function activatePaid(accountId, reference = "", notifyPhone = null, days = 365, planKey = "") {
  const acc = await MailAccount.findById(accountId);
  if (!acc) return null;
  const now = new Date();
  const paidUntil = acc.paidUntil ? new Date(acc.paidUntil) : null;
  const trialEnd = acc.trialEndsAt ? new Date(acc.trialEndsAt) : null;
  const base = paidUntil && paidUntil > now ? paidUntil : (trialEnd && trialEnd > now ? trialEnd : now);
  acc.paidUntil = new Date(base.getTime() + days * 86400000);
  if (planKey && MAIL_PLANS[planKey]) acc.plan = planKey;
  else if (!PLAN_KEYS.includes(acc.plan)) acc.plan = "starter";
  if (reference) {
    const p = (acc.payments || []).find(x => x.reference === reference);
    if (p) { p.status = "paid"; p.paidAt = new Date(); }
  }
  if (acc.status === "paused") acc.status = acc.firstMailAt ? "live" : "setup";
  await acc.save();
  const to = notifyPhone || acc.ownerPhone;
  if (notifyPhone !== false) await sendButtons(to, {
    text: `✅ *ZimQuote Mail is active*\n\n📧 ${acc.email}\nPlan: *${MAIL_PLANS[acc.plan]?.name || "Starter"}*\nActive until *${fmtDate(acc.paidUntil)}*.`,
    buttons: [{ id: "mail_menu", title: "📧 My Mail" }]
  }).catch(() => {});
  return acc;
}

/** Admin: switch an inbox off now (keeps it, stops alerts). */
export async function deactivateAccount(id) {
  const acc = await MailAccount.findById(id);
  if (!acc) throw new Error("Inbox not found");
  acc.paidUntil = null; acc.trialEndsAt = new Date(Date.now() - 60000);
  await acc.save();
  return acc;
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP FLOW
// ═════════════════════════════════════════════════════════════════════════════
const ENTRY_WORDS = /^(mail|my mail|email|emails|my email|inbox|zimquote mail|business email)$/i;
const PAGE = 7;                      // emails per inbox page (list max 10 rows incl. navigation)
const SUPPORT_PHONE = () => process.env.MAIL_SUPPORT_PHONE || "+263 78 990 1058";

async function accountsOf(phone) {
  return MailAccount.find({ $or: [{ ownerPhone: phone }, { alertPhones: phone }] }).sort({ createdAt: 1 });
}
function canUse(phone, acc) {
  return !!acc && (acc.ownerPhone === phone || (acc.alertPhones || []).includes(phone));
}
async function loadMsg(phone, id) {
  if (!mongoose.isValidObjectId(id)) return {};
  const msg = await MailMessage.findById(id);
  if (!msg) return {};
  const acc = await MailAccount.findById(msg.accountId);
  if (!canUse(phone, acc)) return {};
  return { msg, acc };
}
async function loadAcc(phone, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const acc = await MailAccount.findById(id);
  return canUse(phone, acc) ? acc : null;
}
// The Request-a-Quote flow keeps its own typing state; leave it when the user comes to Mail.
async function leaveOtherFlows(phone) {
  await UserSession.updateOne({ phone }, { $unset: {
    "tempData.buyerRequestState": "", "tempData.buyerRequestMode": "", "tempData.pendingBuyerRequest": ""
  } }).catch(() => {});
}

/**
 * Send a WhatsApp list; if WhatsApp rejects it, fall back to a numbered text menu
 * the user can answer with a number (so the menu never "just fails").
 */
async function safeList(phone, text, rows) {
  rows = rows.slice(0, 10).map(r => ({ id: r.id, title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) }));
  try { return await sendList(phone, clip(text, 1000), rows); }
  catch (e) {
    console.error("[MAIL LIST]", e?.response?.data?.error?.message || e.message);
    await setState(phone, "pick", { ids: rows.map(r => r.id) });
    return sendText(phone, `${text}\n\n${rows.map((r, i) => `*${i + 1}.* ${r.title}`).join("\n")}\n\n_Reply with a number._`);
  }
}
async function safeButtons(phone, text, buttons) {
  buttons = buttons.slice(0, 3).map(b => ({ id: b.id, title: clip(b.title, 20) }));
  if (text.length > 1000) { await sendText(phone, text.slice(0, 3900)); text = "👇 Choose:"; }
  try { return await sendButtons(phone, { text, buttons }); }
  catch (e) {
    console.error("[MAIL BUTTONS]", e?.response?.data?.error?.message || e.message);
    await setState(phone, "pick", { ids: buttons.map(b => b.id) });
    return sendText(phone, `${text}\n\n${buttons.map((b, i) => `*${i + 1}.* ${b.title}`).join("\n")}\n\n_Reply with a number._`);
  }
}

function statusWord(a) {
  if (a.status === "paused") return "⏸ Paused";
  if (a.status === "error") return "⚠️ Needs reconnecting";
  if (a.status === "setup") return "🛠 Not connected yet";
  return "🟢 Live";
}
const howWord = a => a.mode === "imap" ? "email login (IMAP)" : a.mode === "pop3" ? "email login (POP3)" : "forwarding";

async function sendIntro(from) {
  const s = MAIL_PLANS.starter;
  return safeButtons(from,
    `📧 *ZimQuote Mail - your business email on WhatsApp*\n\n` +
    `✅ New emails arrive here with a short summary\n` +
    `↩️ Reply from WhatsApp - we send it as a proper email\n` +
    `✨ Type a quick note, tap Polish for a professional reply\n` +
    `👥 Your staff can get the alerts too\n\n` +
    `Works with company email (.co.zw, .com, .org…), Gmail, Yahoo, Outlook and more.\n\n` +
    `🎁 *Try it ${trialLabel()}*, then:\n${await pricingText(null, { short: true })}`,
    [{ id: "mail_setup", title: "📧 Connect my email" }, { id: "mail_help", title: "🙋 Set it up for me" }, { id: "main_menu_back", title: "🏠 Main Menu" }]);
}

export async function sendMailMenu(from) {
  await leaveOtherFlows(from);
  const accs = await accountsOf(from);
  if (!accs.length) return sendIntro(from);
  if (accs.length === 1) return sendAccountMenu(from, accs[0]);
  const rows = accs.slice(0, 8).map((a, i) => ({ id: `mail_acc_${a._id}`, title: `${i + 1}. ${a.email}`, description: `${statusWord(a)} · ${planLine(a)}` }));
  if (accs.filter(a => a.ownerPhone === from).length < MAIL_CONFIG.INBOX_MAX) rows.push({ id: "mail_setup", title: "➕ Add another email", description: "Connect one more inbox" });
  rows.push({ id: "main_menu_back", title: "🏠 Main Menu", description: "Back to ZimQuote" });
  return safeList(from, "📧 *ZimQuote Mail*\n\nChoose an inbox:", rows);
}

async function sendAccountMenu(from, acc) {
  const isOwner = acc.ownerPhone === from;
  const open = await MailMessage.countDocuments({ accountId: acc._id, status: "new", muted: false }).catch(() => 0);
  const lim = planLimits(acc);
  const text =
    `📧 *${acc.email}*\n${statusWord(acc)} · ${planLine(acc)}\n` +
    `📬 ${acc.mailCount || 0} emails · 🔵 ${open} open · ↩️ ${acc.replyCount || 0} replies\n` +
    `Plan: ${lim.name} · Connected by ${howWord(acc)}`;
  const rows = [{ id: `mail_inbox_${acc._id}_0`, title: `📬 Inbox (${open} open)`, description: "Read and reply to your emails" }];
  if (acc.status !== "live") rows.push({ id: `mail_guide_${acc._id}`, title: "🛠 Connect / fix", description: "Simple steps to connect this email" });
  if (isOwner) {
    rows.push(
      { id: `mail_alerts_${acc._id}`, title: acc.alertMode === "all" ? "🔔 Alerts: every email" : "🔔 Alerts: important", description: "Tap to switch: every email / important only" },
      { id: `mail_team_${acc._id}`, title: "👥 Staff alerts", description: `Staff WhatsApp numbers (${(acc.alertPhones || []).length}/${lim.team})` },
      { id: `mail_sig_${acc._id}`, title: "✍️ Signature", description: acc.signature ? acc.signature : "Added under your replies" },
      { id: `mail_name_${acc._id}`, title: "🏷 Sender name", description: acc.displayName || "Name people see on your replies" },
      { id: `mail_pay_${acc._id}`, title: "💳 Plan & payment", description: planLine(acc).replace(/^\S+\s/, "") },
      { id: `mail_pause_${acc._id}`, title: acc.status === "paused" ? "▶️ Resume alerts" : "⏸ Pause alerts", description: "Stop or restart WhatsApp alerts" }
    );
  }
  rows.push({ id: "mail_setup", title: "➕ Add another email", description: "Connect one more inbox" });
  rows.push({ id: "main_menu_back", title: "🏠 Main Menu", description: "Back to ZimQuote" });
  return safeList(from, text, rows.slice(0, 10));
}

async function sendInbox(from, acc, page = 0) {
  page = Math.max(0, Number(page) || 0);
  const total = await MailMessage.countDocuments({ accountId: acc._id, muted: false });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (page >= pages) page = pages - 1;
  const msgs = await MailMessage.find({ accountId: acc._id, muted: false }).sort({ receivedAt: -1 }).skip(page * PAGE).limit(PAGE).lean();
  if (!msgs.length) {
    return safeButtons(from, `📭 No emails yet for *${acc.email}*.${acc.status !== "live" ? "\n\nThis email isn't connected yet. Tap *Connect* for simple steps." : "\n\nNew emails will appear here."}`,
      [acc.status !== "live" ? { id: `mail_guide_${acc._id}`, title: "🛠 Connect" } : { id: `mail_acc_${acc._id}`, title: "⬅ Back" }, { id: "mail_menu", title: "📧 My Mail" }]);
  }
  const start = page * PAGE;
  const rows = msgs.map((m, i) => ({
    id: `mail_open_${m._id}`,
    title: `${start + i + 1}. ${m.status === "new" ? "🔵" : m.status === "replied" ? "↩️" : "✅"} ${m.fromName || m.fromEmail}`,
    description: `${m.subject || "(no subject)"} - ${m.summary || ""}`
  }));
  if (page + 1 < pages) rows.push({ id: `mail_inbox_${acc._id}_${page + 1}`, title: "➡️ Older emails", description: `Page ${page + 2} of ${pages}` });
  if (page > 0) rows.push({ id: `mail_inbox_${acc._id}_${page - 1}`, title: "⬅️ Newer emails", description: `Page ${page} of ${pages}` });
  rows.push({ id: `mail_acc_${acc._id}`, title: "⚙️ Inbox menu", description: acc.email });
  await setState(from, "inbox", { accId: String(acc._id), page, ids: msgs.map(m => String(m._id)), start });
  const muted = await MailMessage.countDocuments({ accountId: acc._id, muted: true, receivedAt: { $gt: new Date(Date.now() - 7 * 86400000) } }).catch(() => 0);
  return safeList(from,
    `📬 *${acc.email}*\nEmails ${start + 1}-${start + msgs.length} of ${total} · page ${page + 1}/${pages}\n🔵 open · ↩️ replied · ✅ done${muted ? `\n📰 ${muted} newsletters this week kept quiet` : ""}\n\n_Tap "View" or type the email's number (e.g. *${start + 1}*)._`,
    rows);
}

async function sendFullEmail(from, msg, acc) {
  const head = `📄 *${clip(msg.subject, 150)}*\nFrom: ${msg.fromName} <${msg.fromEmail}>\nTo: ${clip(msg.to || acc.email, 150)}${msg.cc ? `\nCc: ${clip(msg.cc, 150)}` : ""}\nDate: ${new Date(msg.receivedAt).toLocaleString("en-GB", { timeZone: "Africa/Harare" })}\n\n`;
  const body = msg.text || "(no text)";
  const LIM = 3600;
  if ((head + body).length <= LIM) await sendText(from, head + body);
  else {
    await sendText(from, head + body.slice(0, LIM - head.length));
    const rest = body.slice(LIM - head.length);
    await sendText(from, rest.length > LIM ? rest.slice(0, LIM - 40) + "\n\n…(email shortened)" : rest);
  }
  for (const a of (msg.attachments || []).slice(0, 8)) {
    const link = `${MAIL_CONFIG.SITE}/mail/att/${a.id}?t=${attToken(a.id)}`;
    await sendDocument(from, { link, filename: a.filename || "attachment" }).catch(() => sendText(from, `📎 ${a.filename}: ${link}`));
  }
  if ((msg.attachments || []).length > 8) await sendText(from, `📎 ${msg.attachments.length - 8} more attachment(s) - open this email in your email app to see them.`);
  if (msg.skippedAttachments?.length) await sendText(from, `⚠️ Too large for WhatsApp (over ${Math.round(maxInBytes() / 1048576)} MB):\n${msg.skippedAttachments.map(x => `• ${x.filename} (${fmtSize(x.size)})`).join("\n")}\nOpen this email in your email app to get them.`);
  return safeButtons(from, `Ref ${msg.ref} · ${msg.status === "replied" ? "↩️ replied" : msg.status === "done" ? "✅ done" : "🔵 open"}`,
    [{ id: `mail_reply_${msg._id}`, title: "↩️ Reply" }, { id: `mail_done_${msg._id}`, title: "✅ Done" }, { id: `mail_inbox_${acc._id}_0`, title: "📬 Inbox" }]);
}

async function startReply(from, msg) {
  await setState(from, "reply", { msgId: String(msg._id) });
  const to = msg.replyTo || msg.fromEmail;
  return safeList(from,
    `↩️ *Reply to ${clip(msg.fromName, 50)}*\n${to}\nRe: ${clip(msg.subject, 80)}\n\n✍️ *Type your reply now.* A short note is fine - you can tap ✨ Polish before sending.\n📎 To attach a quote, invoice or photo, just send the file here.\n\nOr pick a ready answer:`,
    [
      ...Object.entries(QUICK_ANSWERS).map(([k, q]) => ({ id: `mail_quick_${k}_${msg._id}`, title: q.title, description: q.text })),
      { id: "mail_cancel", title: "❌ Cancel", description: "Don't reply now" }
    ]);
}

async function showPreview(from, msg, text, { polished = false, original = "", files } = {}) {
  if (files === undefined) { const cur = await getSess(from); files = cur.data?.msgId === String(msg._id) ? (cur.data.files || []) : []; }
  await setState(from, "confirm", { msgId: String(msg._id), text, original: original || text, polished, files });
  const to = msg.replyTo || msg.fromEmail;
  const buttons = [{ id: `mail_send_${msg._id}`, title: "✅ Send" }];
  buttons.push(polished ? { id: `mail_mine_${msg._id}`, title: "↩️ Use my words" } : { id: `mail_polish_${msg._id}`, title: "✨ Polish it" });
  buttons.push({ id: "mail_cancel", title: "❌ Cancel" });
  const head = `📤 *Send this email?*\nTo: ${to}\nSubject: Re: ${clip(String(msg.subject || "").replace(/^re:\s*/i, ""), 80)}\n\n`;
  const fl = files.length ? `\n\n📎 *Attached (${fmtSize(files.reduce((t, f) => t + (f.size || 0), 0))}):*\n${files.map(f => `• ${f.filename} (${fmtSize(f.size)})`).join("\n")}` : "";
  const tail = `${fl}${polished ? "\n\n✨ _Polished by ZimQuote_" : ""}\n\n_To change it, type a new reply. To attach a file (PDF, Word, Excel, photo), just send it here._`;
  if ((head + text + tail).length <= 1000) return safeButtons(from, head + text + tail, buttons);
  await sendText(from, head + String(text).slice(0, 3800));
  return safeButtons(from, `☝️ That's your full reply.${tail}`, buttons);
}

async function setupAsk(from) {
  await leaveOtherFlows(from);
  await setState(from, "setup_email", {});
  return sendText(from, `📧 *Connect your email - step 1 of 2*\n\nType the email address you want on WhatsApp.\n\n_Examples:_\n• sales@yourcompany.co.zw\n• info@yourshop.com\n• yourname@gmail.com\n\nType *cancel* to stop.`);
}

export async function createAccount(from, email, { businessName = "", setupBy = "whatsapp", phoneVerified = true } = {}) {
  email = email.toLowerCase().trim();
  from = normPhone(from);
  const existing = await MailAccount.findOne({ ownerPhone: from, email });
  if (existing) return existing;
  const count = await MailAccount.countDocuments({ ownerPhone: from });
  if (count >= MAIL_CONFIG.INBOX_MAX) throw new Error(`You can connect up to ${MAIL_CONFIG.INBOX_MAX} inboxes.`);
  const { provider } = await detectProvider(email);
  let slug = "";
  for (let i = 0; i < 5; i++) { slug = randSlug(); if (!(await MailAccount.exists({ slug }))) break; }
  const acc = await MailAccount.create({
    ownerPhone: from, email, provider, slug, mode: "forward", status: "setup",
    businessName, displayName: businessName, setupBy, phoneVerified,
    linkCode: phoneVerified ? undefined : crypto.randomBytes(3).toString("hex").toUpperCase(),
    webToken: crypto.randomBytes(12).toString("hex"),
    trialEndsAt: daysFromNow(MAIL_CONFIG.TRIAL_DAYS)
  });
  _mailPhones.at = 0;
  return acc;
}

const PROVIDER_NAME = { google: "Gmail", microsoft: "Outlook / Hotmail", yahoo: "Yahoo", zoho: "Zoho", apple: "iCloud", cpanel: "company email", other: "company email" };

async function freshConnectLink(acc) {
  if (!canStorePasswords()) return "";
  const token = crypto.randomBytes(16).toString("hex");
  await MailAccount.updateOne({ _id: acc._id }, { $set: { connectToken: token, connectTokenExp: daysFromNow(2) } });
  return `${MAIL_CONFIG.SITE}/mail/connect/${token}`;
}

/** Step 2: choose how to connect (the simplest option first for this provider). */
export async function sendSetupGuide(from, acc) {
  const p = acc.provider;
  const pw = canStorePasswords();
  const name = PROVIDER_NAME[p] || "company email";
  let text = `📧 *Connect ${acc.email} - step 2 of 2*\n\nWe detected: *${name}*.\nChoose how to connect:\n\n`;
  let buttons;
  if (p === "microsoft") {
    text += `↪️ *Forward emails* - 2 minutes in Outlook settings (works for Hotmail/Outlook)\n🙋 *Set it up for me* - our team does it with you`;
    buttons = [{ id: `mail_how_fwd_${acc._id}`, title: "↪️ Forward emails" }, { id: "mail_help", title: "🙋 Set it up for me" }];
  } else if (p === "google") {
    text += `↪️ *Forward emails* - easiest for Gmail\n🔑 *App password* - for advanced users\n🙋 *Set it up for me* - our team does it with you`;
    buttons = [{ id: `mail_how_fwd_${acc._id}`, title: "↪️ Forward emails" }, ...(pw ? [{ id: `mail_how_pw_${acc._id}`, title: "🔑 App password" }] : []), { id: "mail_help", title: "🙋 Set it up for me" }];
  } else if (["yahoo", "zoho", "apple"].includes(p)) {
    text += `🔑 *App password* - quick and reliable\n↪️ *Forward emails* - no password needed\n🙋 *Set it up for me* - our team does it with you`;
    buttons = [...(pw ? [{ id: `mail_how_pw_${acc._id}`, title: "🔑 App password" }] : []), { id: `mail_how_fwd_${acc._id}`, title: "↪️ Forward emails" }, { id: "mail_help", title: "🙋 Set it up for me" }];
  } else {
    text += `🔑 *Use my email password* - easiest (1 minute)\n↪️ *Forward emails* - via cPanel, no password shared\n🙋 *Set it up for me* - our team does it with you`;
    buttons = [...(pw ? [{ id: `mail_how_pw_${acc._id}`, title: "🔑 Use my password" }] : []), { id: `mail_how_fwd_${acc._id}`, title: "↪️ Forward emails" }, { id: "mail_help", title: "🙋 Set it up for me" }];
  }
  return safeButtons(from, text, buttons);
}

async function sendPasswordSteps(from, acc) {
  const link = await freshConnectLink(acc);
  if (!link) return sendForwardSteps(from, acc);
  const app = ["google", "yahoo", "apple"].includes(acc.provider);
  const appHow = acc.provider === "google" ? "Google Account → Security → 2-Step Verification → *App passwords*"
    : acc.provider === "yahoo" ? "Yahoo Account Security → *Generate app password*"
    : acc.provider === "apple" ? "appleid.apple.com → Sign-In and Security → *App-Specific Passwords*" : "";
  await sendText(from,
    `🔑 *Connect with your ${app ? "app " : "email "}password*\n\n` +
    (app ? `1️⃣ Create an app password: ${appHow}\n2️⃣ Open this secure page:\n${link}\n3️⃣ Paste the app password and tap *Connect my email*\n\n`
         : `1️⃣ Open this secure page:\n${link}\n2️⃣ Type the password you use to log in to ${acc.email}\n3️⃣ Tap *Connect my email*\n\n`) +
    `We find your mail server automatically (IMAP or POP3). Replies then go out from *${acc.email}*.\n\n` +
    `🔒 Never send your password here on WhatsApp. The link works for 2 days.`);
  return safeButtons(from, `When it says *Connected*, send a test email to ${acc.email} from any other email. It pops up here.`,
    [{ id: `mail_how_fwd_${acc._id}`, title: "↪️ Forward instead" }, { id: "mail_help", title: "🙋 Set it up for me" }, { id: "mail_menu", title: "📧 My Mail" }]);
}

async function sendForwardSteps(from, acc) {
  const fwd = forwardAddress(acc);
  const [local, domain] = acc.email.split("@");
  let steps;
  if (acc.provider === "google") {
    steps = `↪️ *Forward Gmail to ZimQuote*\n\n1️⃣ Open Gmail in a browser → ⚙️ *Settings* → *See all settings*\n2️⃣ Tab *Forwarding and POP/IMAP* → *Add a forwarding address*\n3️⃣ Paste: *${fwd}*\n4️⃣ Gmail sends a code - *we'll send it to you here*. Type it in Gmail → *Verify*\n5️⃣ Choose *Forward a copy* → *Save Changes*`;
  } else if (acc.provider === "microsoft") {
    steps = `↪️ *Forward Outlook / Hotmail to ZimQuote*\n\n1️⃣ Open outlook.com → ⚙️ *Settings* → *Mail* → *Forwarding*\n2️⃣ Tick *Enable forwarding*\n3️⃣ Paste: *${fwd}*\n4️⃣ Tick *Keep a copy of forwarded messages* → *Save*`;
  } else if (acc.provider === "yahoo") {
    steps = `↪️ *Forward Yahoo Mail*\n\nYahoo only allows forwarding on paid plans. The *App password* option is easier for Yahoo.`;
  } else {
    steps = `↪️ *Forward ${acc.email} to ZimQuote (cPanel)*\n\n1️⃣ Log in to cPanel (often *${domain}/cpanel*)\n2️⃣ *Email* → *Forwarders* → *Add Forwarder*\n3️⃣ *Address to Forward:* type only *${local}*\n4️⃣ *Domain:* ${domain}\n5️⃣ *Forward to Email Address:* paste *${fwd}*\n6️⃣ Tap *Add Forwarder*\n\n_Not cPanel? Look for "Forwarding" in your email settings and forward to the address above._`;
  }
  await sendText(from, steps + `\n\n📖 Pictures: ${guideUrl(acc)}`);
  return safeButtons(from, `When done, send a test email to ${acc.email} from any other email. It pops up here within a minute.`,
    [{ id: `mail_fwd_${acc._id}`, title: "📋 Copy address" }, { id: "mail_help", title: "🙋 Set it up for me" }, { id: "mail_menu", title: "📧 My Mail" }]);
}

async function sendPlans(from, acc) {
  const lim = planLimits(acc);
  const rows = [];
  let supplier = false;
  for (const k of PLAN_KEYS) {
    const pl = MAIL_PLANS[k];
    const pr = await priceFor(acc, k);
    supplier = pr.supplier;
    rows.push({ id: `mail_plan_${k}_${acc._id}`, title: `${pl.name} $${pr.price}/yr`, description: pl.blurb + (pr.supplier ? ` (was $${pr.base})` : "") });
  }
  rows.push({ id: `mail_acc_${acc._id}`, title: "⬅ Back", description: acc.email });
  return safeList(from,
    `💳 *ZimQuote Mail plans* - ${acc.email}\n${planLine(acc)}\nNow: ${lim.name}\n\nAll plans: 1 inbox, AI summaries, ✨ Polish, replies from WhatsApp. Paid once a year by EcoCash - no monthly fees.${supplier ? "\n\n🏪 You're a listed ZimQuote seller: *" + Math.round(SUPPLIER_DISCOUNT() * 100) + "% off*." : ""}`,
    rows);
}

/**
 * Called from chatbotEngine.js for every inbound message (top-level hook).
 * @returns {Promise<boolean>} true when the message was handled here
 */
export async function handleMailMessage({ from, text = "", rawText = "", action = "", biz = null }) {
  const phone = normPhone(from);
  const a = String(action || "").toLowerCase();
  const typed = String(rawText || text || "").trim();
  markSeen(phone);

  try {
    // ── Deep links: always win, whatever else the user was doing ─────────
    if (!a && /^zq:mail$/i.test(typed)) { await clearState(phone); await sendMailMenu(phone); return true; }
    const lk = !a && typed.match(/^zq:mail:([a-z0-9]{6})$/i);
    if (lk) { await clearState(phone); await linkWebSignup(phone, lk[1].toUpperCase()); return true; }

    // ── Button / list taps ────────────────────────────────────────────────
    if (a.startsWith("mail_")) return await handleTap(phone, a);

    // ── Entry words ───────────────────────────────────────────────────────
    const s = await getSess(phone);
    if (!s.state) {
      const bizBusy = biz && biz.sessionState && !["ready", "main_menu", ""].includes(biz.sessionState);
      if (!a && !bizBusy && ENTRY_WORDS.test(typed)) { await clearState(phone); await sendMailMenu(phone); return true; }
      return false;
    }

    // ── Typed text inside a mail flow ─────────────────────────────────────
    if (a) { await clearState(phone); return false; }   // they tapped something else: leave the mail flow
    if (!typed) return false;
    if (/^(cancel|stop|exit)$/i.test(typed)) { await clearState(phone); await safeButtons(phone, "👍 Cancelled.", [{ id: "mail_menu", title: "📧 My Mail" }]); return true; }
    if (/^(menu|main menu|home|hi|hello|hie|hey)$/i.test(typed)) { await clearState(phone); return false; }
    if (ENTRY_WORDS.test(typed) && !["reply", "confirm", "sig", "name"].includes(s.state)) { await clearState(phone); await sendMailMenu(phone); return true; }

    switch (s.state) {
      case "pick": {                                  // numbered fallback menu
        const n = parseInt(typed, 10);
        const id = (s.data.ids || [])[n - 1];
        if (!id) { await sendText(phone, `Reply with a number from 1 to ${(s.data.ids || []).length}, or *cancel*.`); return true; }
        await clearState(phone);
        if (id === "main_menu_back") { try { (await import("./metaMenus.js")).sendMainMenu(phone); } catch (_) {} return true; }
        return handleTap(phone, id);
      }
      case "inbox": {                                 // typed number / next / back while browsing
        const acc = await loadAcc(phone, s.data.accId);
        if (!acc) { await clearState(phone); return false; }
        if (/^(more|next|older|n)$/i.test(typed)) { await sendInbox(phone, acc, (s.data.page || 0) + 1); return true; }
        if (/^(back|newer|prev|previous|p)$/i.test(typed)) { await sendInbox(phone, acc, Math.max(0, (s.data.page || 0) - 1)); return true; }
        const n = parseInt(typed, 10);
        if (Number.isFinite(n) && String(n) === typed) {
          const idx = n - 1 - (s.data.start || 0);
          let id = (s.data.ids || [])[idx];
          if (!id) {                                  // a number from another page
            const m = await MailMessage.find({ accountId: acc._id, muted: false }).sort({ receivedAt: -1 }).skip(Math.max(0, n - 1)).limit(1).lean();
            id = m[0] ? String(m[0]._id) : "";
          }
          if (!id) { await sendText(phone, `There's no email number ${n}. Type a number from the list, *more* for older emails, or *menu*.`); return true; }
          const { msg } = await loadMsg(phone, id);
          if (!msg) return notFound(phone);
          await sendFullEmail(phone, msg, acc);
          return true;
        }
        await clearState(phone);
        return false;                                 // something else: let the bot handle it
      }
      case "setup_email": {
        const email = typed.replace(/^mailto:/i, "").toLowerCase();
        if (!isEmail(email)) { await sendText(phone, "❌ That doesn't look like an email address.\nTry again, e.g. *sales@yourcompany.co.zw*, or type *cancel*."); return true; }
        const col = MAIL_CONFIG.COLLECTOR?.address;
        if (email.endsWith("@" + MAIL_CONFIG.INBOUND_DOMAIN) || email === col) { await sendText(phone, "That's a ZimQuote address. Type *your own* email address."); return true; }
        await clearState(phone);
        let acc;
        try { acc = await createAccount(phone, email); }
        catch (e) { await sendText(phone, `❌ ${e.message}`); return true; }
        if (!acc.displayName) {
          let nm = biz?.name && !String(biz.name).startsWith("pending_supplier_") ? biz.name : "";
          if (!nm) { try { const SP = (await import("../models/supplierProfile.js")).default; nm = (await SP.findOne({ phone }).lean())?.businessName || ""; } catch (_) {} }
          if (nm) { acc.displayName = nm; acc.businessName = acc.businessName || nm; await acc.save(); }
        }
        await sendText(phone, `✅ *${email}* added.\n🎁 Free trial until *${fmtWhen(acc.trialEndsAt)}*.\n\n${await pricingText(acc)}`);
        await sendSetupGuide(phone, acc);
        return true;
      }
      case "reply": {
        const { msg } = await loadMsg(phone, s.data.msgId);
        if (!msg) { await clearState(phone); return notFound(phone); }
        if (typed.length < 2) { await sendText(phone, "Type your reply, or *cancel*."); return true; }
        await showPreview(phone, msg, typed);
        return true;
      }
      case "confirm": {                               // they typed a new version instead of tapping Send
        const { msg } = await loadMsg(phone, s.data.msgId);
        if (!msg) { await clearState(phone); return notFound(phone); }
        await showPreview(phone, msg, typed);
        return true;
      }
      case "team_add": {
        const acc = await MailAccount.findById(s.data.accId);
        if (!acc || acc.ownerPhone !== phone) { await clearState(phone); return notFound(phone); }
        const p = normPhone(typed);
        if (!/^\d{11,15}$/.test(p)) { await sendText(phone, "❌ Type a WhatsApp number like *0772123456*, or *cancel*."); return true; }
        const max = planLimits(acc).team;
        if ((acc.alertPhones || []).length >= max) { await clearState(phone); await safeButtons(phone, `Your plan allows ${max} staff number${max > 1 ? "s" : ""}. Remove one, or upgrade your plan.`, [{ id: `mail_pay_${acc._id}`, title: "💳 Plans" }, { id: `mail_team_${acc._id}`, title: "👥 Staff alerts" }]); return true; }
        if (p !== acc.ownerPhone && !(acc.alertPhones || []).includes(p)) { acc.alertPhones = [...(acc.alertPhones || []), p]; await acc.save(); _mailPhones.at = 0; }
        await clearState(phone);
        await safeButtons(phone, `✅ +${p} will now get email alerts for ${acc.email} and can reply.\n\n_Ask them to send "hi" to this WhatsApp number once, so alerts can reach them._`, [{ id: `mail_team_${acc._id}`, title: "👥 Staff alerts" }, { id: `mail_acc_${acc._id}`, title: "📧 My Mail" }]);
        return true;
      }
      case "sig": case "name": {
        const acc = await MailAccount.findById(s.data.accId);
        if (!acc || acc.ownerPhone !== phone) { await clearState(phone); return notFound(phone); }
        const val = /^none$/i.test(typed) ? "" : typed.slice(0, s.state === "sig" ? 500 : 80);
        if (s.state === "sig") acc.signature = val; else acc.displayName = val;
        await acc.save(); await clearState(phone);
        await safeButtons(phone, `✅ Saved.${val ? `\n\n${val}` : ""}`, [{ id: `mail_acc_${acc._id}`, title: "📧 My Mail" }]);
        return true;
      }
      case "pay": {
        const acc = await MailAccount.findById(s.data.accId);
        if (!acc) { await clearState(phone); return notFound(phone); }
        let n = typed.replace(/\D+/g, "");
        if (n.startsWith("263")) n = "0" + n.slice(3);
        if (/^same$/i.test(typed)) n = "0" + phone.slice(3);
        if (!/^07\d{8}$/.test(n)) { await sendText(phone, "❌ Type an EcoCash number like *0772123456*, or *cancel*."); return true; }
        await clearState(phone);
        try { await startPayment(phone, acc, n, s.data.plan); }
        catch (e) { await safeButtons(phone, `❌ ${clip(e.message, 160)}`, [{ id: `mail_pay_${acc._id}`, title: "🔁 Try again" }]); }
        return true;
      }
    }
    await clearState(phone);
    return false;
  } catch (err) {
    console.error("[MAIL]", err);
    try { await clearState(phone); await safeButtons(phone, "❌ Sorry, something went wrong. Please try again.", [{ id: "mail_menu", title: "📧 My Mail" }, { id: "main_menu_back", title: "🏠 Main Menu" }]); } catch (_) {}
    return true;
  }
}

/** All mail_* button and list taps. */
async function handleTap(phone, a) {
  if (a === "mail_menu") { await clearState(phone); await sendMailMenu(phone); return true; }
  if (a === "mail_setup") { await setupAsk(phone); return true; }
  if (a === "mail_help") { await requestHelp(phone); return true; }
  if (a === "mail_cancel") { await clearState(phone); await safeButtons(phone, "👍 Cancelled.", [{ id: "mail_menu", title: "📧 My Mail" }]); return true; }

  let m;
  if ((m = a.match(/^mail_quick_(q\d)_([a-f0-9]{24})$/))) {
    const { msg } = await loadMsg(phone, m[2]); if (!msg) return notFound(phone);
    await showPreview(phone, msg, QUICK_ANSWERS[m[1]]?.text || ""); return true;
  }
  if ((m = a.match(/^mail_inbox_([a-f0-9]{24})(?:_(\d+))?$/))) {
    const acc = await loadAcc(phone, m[1]); if (!acc) return notFound(phone);
    await sendInbox(phone, acc, Number(m[2] || 0)); return true;
  }
  if ((m = a.match(/^mail_how_(pw|fwd)_([a-f0-9]{24})$/))) {
    const acc = await loadAcc(phone, m[2]); if (!acc) return notFound(phone);
    if (m[1] === "pw") await sendPasswordSteps(phone, acc); else await sendForwardSteps(phone, acc);
    return true;
  }
  if ((m = a.match(/^mail_plan_(starter|business|pro)_([a-f0-9]{24})$/))) {
    const acc = await loadAcc(phone, m[2]); if (!acc) return notFound(phone);
    if (acc.ownerPhone !== phone) { await sendText(phone, "Only the owner of this inbox can pay for it."); return true; }
    const pl = MAIL_PLANS[m[1]]; const pr = await priceFor(acc, m[1]);
    await setState(phone, "pay", { accId: String(acc._id), plan: m[1] });
    await safeButtons(phone, `💳 *${pl.name} - $${pr.price} for 1 year*\n${pl.blurb}\n📧 ${acc.email}\n\nType the *EcoCash number* to pay from, or tap *Use this number*.`,
      [{ id: `mail_paysame_${m[1]}_${acc._id}`, title: "📱 Use this number" }, { id: `mail_pay_${acc._id}`, title: "⬅ Plans" }]);
    return true;
  }
  if ((m = a.match(/^mail_paysame_(starter|business|pro)_([a-f0-9]{24})$/))) {
    const acc = await loadAcc(phone, m[2]); if (!acc) return notFound(phone);
    await clearState(phone);
    try { await startPayment(phone, acc, "0" + phone.slice(3), m[1]); }
    catch (e) { await safeButtons(phone, `❌ ${clip(e.message, 160)}`, [{ id: `mail_pay_${acc._id}`, title: "🔁 Try again" }]); }
    return true;
  }
  if ((m = a.match(/^mail_(reply|open|done|send|polish|mine)_([a-f0-9]{24})$/))) {
    const [, verb, id] = m;
    const { msg, acc } = await loadMsg(phone, id);
    if (!msg) return notFound(phone);
    if (!isActive(acc) && verb !== "done") {
      await safeButtons(phone, `⛔ ZimQuote Mail for *${acc.email}* has ended.\nRenew from *$${MAIL_PLANS.starter.price} a year* to read and reply.`, [{ id: `mail_pay_${acc._id}`, title: "💳 Renew now" }]);
      return true;
    }
    if (verb === "reply") { await startReply(phone, msg); return true; }
    if (verb === "open") { await sendFullEmail(phone, msg, acc); return true; }
    if (verb === "done") {
      await MailMessage.updateOne({ _id: msg._id }, { $set: { status: "done" } });
      await safeButtons(phone, `✅ Marked done: ${clip(msg.subject, 80)}`, [{ id: `mail_inbox_${acc._id}_0`, title: "📬 Inbox" }]);
      return true;
    }
    const s = await getSess(phone);
    const draft = s.state === "confirm" && s.data.msgId === id ? s.data : null;
    if (!draft) { await startReply(phone, msg); return true; }
    if (verb === "polish") {
      await sendText(phone, "✨ Polishing your reply…");
      const p = await polish(draft.original || draft.text, msg, acc);
      if (!p) { await sendText(phone, "Sorry, polishing isn't available right now. You can send your own words."); await showPreview(phone, msg, draft.text); return true; }
      await showPreview(phone, msg, p, { polished: true, original: draft.original || draft.text }); return true;
    }
    if (verb === "mine") { await showPreview(phone, msg, draft.original || draft.text); return true; }
    if (verb === "send") {
      await clearState(phone);
      try {
        const r = await sendReply(acc, msg, draft.text, phone, draft.files || []);
        await safeButtons(phone, `✅ *Email sent* to ${r.to}${(draft.files || []).length ? ` with ${draft.files.length} attachment${draft.files.length > 1 ? "s" : ""}` : ""}${r.via === "zimquote" ? `\n_Sent via ZimQuote; their replies go to ${acc.email}._` : ""}`,
          [{ id: `mail_inbox_${acc._id}_0`, title: "📬 Inbox" }, { id: "mail_menu", title: "📧 My Mail" }]);
      } catch (e) {
        await safeButtons(phone, `❌ The email could not be sent.\n${clip(e.message, 200)}\n\nTap below to try again.`, [{ id: `mail_reply_${msg._id}`, title: "🔁 Try again" }]);
      }
      return true;
    }
  }

  if ((m = a.match(/^mail_(acc|guide|fwd|alerts|team|sig|name|pay|pause|reconnect|teamdel)_([a-f0-9]{24})(?:_(\d+))?$/))) {
    const [, verb, id, extra] = m;
    const acc = await loadAcc(phone, id);
    if (!acc) return notFound(phone);
    const owner = acc.ownerPhone === phone;
    switch (verb) {
      case "acc": await clearState(phone); await sendAccountMenu(phone, acc); return true;
      case "guide": await sendSetupGuide(phone, acc); return true;
      case "fwd": await sendText(phone, forwardAddress(acc)); return true;
    }
    if (!owner) { await sendText(phone, "Only the owner of this inbox can change its settings."); return true; }
    switch (verb) {
      case "alerts":
        acc.alertMode = acc.alertMode === "all" ? "important" : "all"; await acc.save();
        await safeButtons(phone, acc.alertMode === "all" ? "🔔 You'll get an alert for *every* email (newsletters stay quiet)." : "🔔 You'll only get alerts for *important* emails: orders, quotes, payments, tenders and complaints. Everything else is in 📬 Inbox.", [{ id: `mail_acc_${acc._id}`, title: "📧 My Mail" }]);
        return true;
      case "team": {
        const max = planLimits(acc).team;
        const list = (acc.alertPhones || []).map((p, i) => `${i + 1}. +${p}`).join("\n") || "No staff numbers yet.";
        await setState(phone, "team_add", { accId: id });
        const btns = (acc.alertPhones || []).slice(0, 2).map((p, i) => ({ id: `mail_teamdel_${id}_${i}`, title: `🗑 Remove …${p.slice(-4)}` }));
        btns.push({ id: `mail_acc_${id}`, title: "⬅ Back" });
        await safeButtons(phone, `👥 *Staff alerts - ${acc.email}*\n\n${list}\n\nTo add someone, *type their WhatsApp number* (e.g. 0772123456). Your plan allows ${max}.`, btns);
        return true;
      }
      case "teamdel": {
        const i = Number(extra);
        acc.alertPhones = (acc.alertPhones || []).filter((_, k) => k !== i); await acc.save(); _mailPhones.at = 0;
        await clearState(phone);
        await safeButtons(phone, "🗑 Removed.", [{ id: `mail_team_${id}`, title: "👥 Staff alerts" }]);
        return true;
      }
      case "sig": await setState(phone, "sig", { accId: id }); await sendText(phone, `✍️ Type the signature to add under your replies, e.g.\n\nTidings Moyo\nSales Manager, Acme (Pvt) Ltd\n+263 77 123 4567\n\nType *none* to remove it.`); return true;
      case "name": await setState(phone, "name", { accId: id }); await sendText(phone, `🏷 Type the name people should see when you reply, e.g. *Acme Hardware*.`); return true;
      case "pause":
        acc.status = acc.status === "paused" ? (acc.firstMailAt || acc.mode !== "forward" ? "live" : "setup") : "paused"; await acc.save();
        await safeButtons(phone, acc.status === "paused" ? "⏸ Alerts paused. Emails are still saved." : "▶️ Alerts are back on.", [{ id: `mail_acc_${id}`, title: "📧 My Mail" }]);
        return true;
      case "pay": await clearState(phone); await sendPlans(phone, acc); return true;
      case "reconnect": await sendPasswordSteps(phone, acc); return true;
    }
  }
  await sendMailMenu(phone);
  return true;
}

async function notFound(phone) {
  await safeButtons(phone, "That email or inbox was not found.", [{ id: "mail_menu", title: "📧 My Mail" }]).catch(() => {});
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTO-DISCOVERY + CONNECT (used by the web portal, admin "set up for client"
// and the /mail/connect page). Built for .co.zw company email on shared hosting.
// ═════════════════════════════════════════════════════════════════════════════
function _parseAutoconfig(xml, email) {
  const [local, domain] = String(email).split("@");
  const fill = s => String(s || "").replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain).trim();
  const block = (type, kind) => {
    const re = new RegExp(`<${kind}Server[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${kind}Server>`, "gi");
    const out = []; let m;
    while ((m = re.exec(xml))) {
      const b = m[1];
      const host = fill((b.match(/<hostname>([^<]+)<\/hostname>/i) || [])[1]);
      const port = Number((b.match(/<port>(\d+)<\/port>/i) || [])[1]) || 0;
      const sock = ((b.match(/<socketType>([^<]+)<\/socketType>/i) || [])[1] || "").toUpperCase();
      if (host) out.push({ host, port, secure: sock === "SSL" });
    }
    return out;
  };
  return { imap: block("imap", "incoming"), smtp: block("smtp", "outgoing") };
}

/** Best server candidates for an address: known providers, autoconfig (cPanel publishes it), SRV, MX, mail.<domain>. */
export async function discoverServers(email, provider = "") {
  const domain = String(email).split("@")[1]?.toLowerCase() || "";
  if (!provider) provider = (await detectProvider(email)).provider;
  const g = guessServers(email, provider);
  const imap = [], smtp = [];
  const add = (arr, s) => { if (s?.host && !arr.some(x => x.host === s.host && x.port === s.port)) arr.push(s); };

  if (["google", "zoho", "yahoo", "apple", "microsoft"].includes(provider)) { add(imap, g.imap); add(smtp, g.smtp); return { provider, imap, smtp }; }

  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`
  ];
  for (const u of urls) {
    try {
      const r = await axios.get(u, { timeout: 5000, responseType: "text", validateStatus: s => s === 200 });
      const p = _parseAutoconfig(String(r.data || ""), email);
      p.imap.forEach(s => add(imap, { host: s.host, port: s.port || 993, secure: s.secure || s.port === 993 }));
      p.smtp.forEach(s => add(smtp, { host: s.host, port: s.port || 465, secure: s.secure || s.port === 465 }));
      if (imap.length) break;
    } catch (_) { /* not published - fine */ }
  }
  try { (await dns.resolveSrv(`_imaps._tcp.${domain}`)).forEach(r => add(imap, { host: r.name, port: r.port || 993, secure: true })); } catch (_) {}
  try { (await dns.resolveSrv(`_submission._tcp.${domain}`)).forEach(r => add(smtp, { host: r.name, port: r.port || 587, secure: r.port === 465 })); } catch (_) {}
  add(imap, g.imap); add(smtp, g.smtp);
  for (const h of (g.alt || [])) { add(imap, { host: h, port: 993, secure: true }); add(smtp, { host: h, port: 465, secure: true }); }
  return { provider, imap: imap.slice(0, 6), smtp: smtp.slice(0, 6) };
}

const _tlsHostFromError = e => {
  const c = e?.cert || e?.cause?.cert;
  const alt = String(c?.subjectaltname || "").split(",").map(s => s.trim().replace(/^DNS:/, "")).find(h => h && !h.startsWith("*"));
  return alt || c?.subject?.CN || "";
};
const _isTlsNameErr = e => /ERR_TLS_CERT_ALTNAME_INVALID|altnames|Hostname\/IP does not match|self[- ]signed|unable to verify|CERT_HAS_EXPIRED/i.test(`${e?.code} ${e?.message} ${e?.cause?.code || ""}`);

/**
 * Try every likely server until one accepts the login.
 * Handles the common shared-hosting case where mail.<domain> serves the host's own certificate.
 * @returns {{ imap: {host,port,secure,insecureTls,info}, smtp: {host,port,secure,insecureTls}|null }}
 */
/** Try server candidates in order; handles shared-hosting certificate mismatches. */
async function _tryCandidates(cands, test, { user, pass, securePorts = [993, 995], plainPorts = [143, 110] }) {
  let ok = null, lastErr = null, firstErr = null, authFailed = false;
  for (const c of cands) {
    const attempts = [{ ...c, insecureTls: false }];
    if (![...securePorts, ...plainPorts].includes(Number(c.port))) attempts.push({ ...c, secure: !c.secure, insecureTls: false });
    for (let i = 0; i < attempts.length && !ok; i++) {
      const at = attempts[i];
      try { const { _retried, ...opts } = at; ok = { ...opts, info: await test({ ...opts, user, pass }) }; }
      catch (e) {
        lastErr = e; firstErr = firstErr || e;
        if (e.authenticationFailed) { authFailed = true; break; }
        if (_isTlsNameErr(e) && !at.insecureTls && !at._retried) {
          at._retried = true;
          const certHost = _tlsHostFromError(e);
          if (certHost && certHost !== at.host) attempts.push({ ...at, host: certHost, insecureTls: false, _retried: true });
          attempts.push({ ...at, insecureTls: true, _retried: true });
        }
      }
    }
    if (ok || authFailed) break;
  }
  return { ok, lastErr, firstErr, authFailed };
}

function _popCandidates(email, provider, imapList) {
  const domain = String(email).split("@")[1] || "";
  const known = { google: "pop.gmail.com", yahoo: "pop.mail.yahoo.com", microsoft: "outlook.office365.com", zoho: "pop.zoho.com" };
  const out = [];
  const add = (host, port = 995) => { if (host && !out.some(x => x.host === host && x.port === port)) out.push({ host, port, secure: port === 995 }); };
  if (known[provider]) add(known[provider]);
  for (const s of imapList || []) add(String(s.host).replace(/^imap\./, "pop."));
  add(`mail.${domain}`); add(`pop.${domain}`); add(`pop3.${domain}`);
  add(`mail.${domain}`, 110);
  return out.slice(0, 7);
}

/**
 * Find a working login. protocol: "auto" (IMAP first, then POP3) | "imap" | "pop3".
 * @returns {{ imap?, pop?, smtp, provider, protocol }}
 */
export async function findWorkingMail({ email, user, pass, provider = "", protocol = "auto", imapHost = "", imapPort = 0, smtpHost = "", smtpPort = 0 }) {
  user = user || email;
  const missing = await missingPackages();
  if (missing.length) throw new Error(`The server is missing ${missing.join(", ")}. On the server run: npm install --save ${missing.join(" ")}  then restart the app.`);
  if (!pass) throw new Error("Type the email password.");
  protocol = ["imap", "pop3"].includes(protocol) ? protocol : "auto";
  const d = await discoverServers(email, provider);

  let inbound = null, res = null;
  if (protocol !== "pop3") {
    const cands = [];
    if (imapHost) cands.push({ host: imapHost, port: Number(imapPort) || 993, secure: (Number(imapPort) || 993) === 993 });
    d.imap.forEach(s => { if (!cands.some(x => x.host === s.host && x.port === s.port)) cands.push(s); });
    res = await _tryCandidates(cands, testImap, { user, pass });
    if (res.ok) inbound = { proto: "imap", ...res.ok };
  }
  if (!inbound && protocol !== "imap" && !(res && res.authFailed)) {
    const cands = [];
    if (imapHost && protocol === "pop3") cands.push({ host: imapHost, port: Number(imapPort) || 995, secure: (Number(imapPort) || 995) === 995 });
    _popCandidates(email, d.provider, d.imap).forEach(s => { if (!cands.some(x => x.host === s.host && x.port === s.port)) cands.push(s); });
    const r2 = await _tryCandidates(cands, testPop, { user, pass });
    if (r2.ok) inbound = { proto: "pop3", ...r2.ok };
    else if (!res || r2.authFailed) res = r2;
    else if (protocol === "pop3") res = r2;
  }
  if (!inbound) {
    const shown = imapHost ? res?.firstErr : res?.lastErr;
    const err = new Error(res?.authFailed ? "The email address or password is wrong. (Gmail, Yahoo and iCloud need an app password.)" : `We couldn't reach your mail server (${shown?.code || shown?.message || "no answer"}). Check the server name, or tap “Set it up for me”.`);
    err.authFailed = !!res?.authFailed;
    throw err;
  }
  const imapOk = inbound;

  const smtpCands = [];
  if (smtpHost) smtpCands.push({ host: smtpHost, port: Number(smtpPort) || 465 });
  d.smtp.forEach(s => smtpCands.push({ host: s.host, port: s.port }));
  smtpCands.push({ host: imapOk.host, port: 465 }, { host: imapOk.host, port: 587 });
  const seen = new Set();
  let smtpOk = null;
  for (const c of smtpCands) {
    const k = `${c.host}:${c.port}`; if (seen.has(k)) continue; seen.add(k);
    for (const insecureTls of [false, true]) {
      if (insecureTls && !imapOk.insecureTls) continue;      // only relax TLS if the same host needed it for IMAP
      try { await testSmtp({ host: c.host, port: c.port, secure: c.port === 465, user, pass, insecureTls }); smtpOk = { host: c.host, port: c.port, secure: c.port === 465, insecureTls }; break; }
      catch (_) {}
    }
    if (smtpOk) break;
    if (seen.size >= 6) break;
  }
  return { ...(imapOk.proto === "pop3" ? { pop: imapOk } : { imap: imapOk }), smtp: smtpOk, provider: d.provider, protocol: imapOk.proto };
}

export async function testPop({ host, port, secure, user, pass, insecureTls = false }) {
  const Pop3Command = (await import("node-pop3")).default;
  const pop = new Pop3Command({ user, password: pass, host, port, tls: !!secure, timeout: 20000, servername: host, tlsOptions: insecureTls ? { rejectUnauthorized: false } : {} });
  try {
    const list = await pop.UIDL();
    return { uids: (list || []).map(x => String(x[1])) };
  } catch (e) {
    if (/^(PASS|USER|APOP|AUTH)/i.test(String(e.command || "")) || /auth|password|login failed|invalid credentials/i.test(e.message || "")) e.authenticationFailed = true;
    throw e;
  } finally { await pop.QUIT().catch(() => {}); }
}

const _popBusy = new Set();
export async function pollPopAccount(acc) {
  const id = String(acc._id);
  if (_popBusy.has(id)) return;
  _popBusy.add(id);
  const Pop3Command = (await import("node-pop3")).default;
  const p = acc.pop || {};
  const pop = new Pop3Command({ user: p.user || acc.email, password: decryptSecret(p.passEnc), host: p.host, port: p.port || 995, tls: p.secure !== false, timeout: 30000, servername: p.host, tlsOptions: p.insecureTls ? { rejectUnauthorized: false } : {} });
  try {
    const list = (await pop.UIDL()) || [];
    const seen = new Set(p.seen || []);
    if (!p.initialized) {
      await MailAccount.updateOne({ _id: acc._id }, { $set: { "pop.seen": list.map(x => String(x[1])).slice(-5000), "pop.initialized": true, "pop.lastCheckedAt": new Date(), "pop.lastError": "" } });
      return;
    }
    const fresh = list.filter(x => !seen.has(String(x[1]))).slice(0, 25);
    for (const [num, uid] of fresh) {
      try { const raw = await pop.RETR(num); await ingestRaw(raw, { account: acc }); }
      catch (e) { console.error("[MAIL POP INGEST]", e.message); }
      seen.add(String(uid));
    }
    const onServer = new Set(list.map(x => String(x[1])));
    await MailAccount.updateOne({ _id: acc._id }, { $set: { "pop.seen": [...seen].filter(u => onServer.has(u)).slice(-5000), "pop.lastCheckedAt": new Date(), "pop.lastError": "", ...(acc.status === "error" ? { status: "live" } : {}) } });
  } catch (e) {
    const auth = /^(PASS|USER)/i.test(String(e.command || ""));
    await MailAccount.updateOne({ _id: acc._id }, { $set: { "pop.lastError": e.message || "failed", "pop.lastCheckedAt": new Date(), ...(auth ? { status: "error" } : {}) } });
    if (auth && acc.status !== "error") {
      await notifyOwner(acc, `⚠️ *We can't open ${acc.email}*\n\nThe email password was refused (maybe it was changed). Tap below to connect again.`,
        [{ id: `mail_reconnect_${acc._id}`, title: "🔑 Reconnect" }]).catch(() => {});
    }
  } finally {
    await pop.QUIT().catch(() => {});
    _popBusy.delete(id);
  }
}

/** Save a working login on the account and switch it to "email login" mode. */
export async function connectWithPassword(acc, { pass, user = "", protocol = "auto", imapHost = "", imapPort = 0, smtpHost = "", smtpPort = 0 }) {
  const r = await findWorkingMail({ email: acc.email, user: user || acc.email, pass, provider: acc.provider, protocol, imapHost, imapPort, smtpHost, smtpPort });
  if (r.pop) {
    acc.mode = "pop3";
    acc.pop = {
      host: r.pop.host, port: r.pop.port, secure: r.pop.secure, insecureTls: !!r.pop.insecureTls,
      user: user || acc.email, passEnc: encryptSecret(pass),
      seen: (r.pop.info.uids || []).slice(-5000), initialized: true, lastError: "", lastCheckedAt: new Date()
    };
    acc.imap = {};
  } else {
    acc.mode = "imap";
    acc.imap = {
      host: r.imap.host, port: r.imap.port, secure: r.imap.secure, insecureTls: !!r.imap.insecureTls,
      user: user || acc.email, passEnc: encryptSecret(pass),
      lastUid: Math.max(0, (r.imap.info.uidNext || 1) - 1), uidValidity: r.imap.info.uidValidity,
      lastError: "", lastCheckedAt: new Date()
    };
    acc.pop = {};
  }
  if (r.smtp) acc.smtp = r.smtp;
  acc.status = "live";
  acc.connectToken = ""; acc.connectTokenExp = null;
  await acc.save();
  return r;
}

// ─── Web sign-up → confirm the WhatsApp number with "ZQ:MAIL:<code>" ─────────
export const linkWaUrl = acc => `https://wa.me/${(process.env.ZQ_BOT_NUMBER || "263771143904").replace(/\D/g, "")}?text=${encodeURIComponent(`ZQ:MAIL:${acc.linkCode}`)}`;

async function linkWebSignup(phone, code) {
  const acc = await MailAccount.findOne({ linkCode: code });
  if (!acc) { await sendButtons(phone, { text: "That ZimQuote Mail code wasn't found or was already used.", buttons: [{ id: "mail_menu", title: "📧 My Mail" }] }); return; }
  if (acc.ownerPhone !== phone && await MailAccount.exists({ ownerPhone: phone, email: acc.email })) {
    await MailAccount.deleteOne({ _id: acc._id });
    await sendMailMenu(phone); return;
  }
  acc.ownerPhone = phone; acc.phoneVerified = true; acc.linkCode = undefined;
  await acc.save(); _mailPhones.at = 0;
  await sendText(phone, `✅ *WhatsApp confirmed for ${acc.email}*\n\nNew emails will arrive here.${acc.status === "live" ? "" : " Finish the last step on the web page, or use the steps below."}`);
  if (acc.status !== "live") await sendSetupGuide(phone, acc);
  else await sendAccountMenu(phone, acc);
}

// ─── "Set it up for me" → alert the ZimQuote team ────────────────────────────
export async function notifyMailAdmin(text) {
  const admin = normPhone(process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || "");
  if (!admin) return;
  await sendText(admin, text).catch(() => {});
}
async function requestHelp(phone) {
  const accs = await MailAccount.find({ ownerPhone: phone });
  const now = new Date();
  for (const a of accs) await MailAccount.updateOne({ _id: a._id }, { $set: { helpRequestedAt: now } });
  await notifyMailAdmin(
    `🙋 *ZimQuote Mail: set-up help requested*\n\nWhatsApp: +${phone}\n` +
    (accs.length ? accs.map(a => `📧 ${a.email} (${a.provider}, ${a.status})`).join("\n") : "No email added yet") +
    `\n\nCall them: https://wa.me/${phone}\nAdmin: ${MAIL_CONFIG.SITE}/zq-admin/mail/new?phone=${phone}`
  );
  await sendButtons(phone, {
    text: `🙋 *No problem - our team will set it up for you.*\n\nWe'll call or WhatsApp you shortly from ${process.env.MAIL_SUPPORT_PHONE || "+263 78 990 1058"}.\n\nHave ready:\n• your email address\n• your email password (or the person who manages your email)\n\nIt takes about 5 minutes.`,
    buttons: [{ id: "mail_menu", title: "📧 My Mail" }]
  });
}

// ─── Admin: set up an inbox for a client ─────────────────────────────────────
/**
 * @returns {{ acc, connected: boolean, message: string }}
 */
export async function setupForClient({ phone, email, businessName = "", password = "", protocol = "auto", imapHost = "", imapPort = 0, smtpHost = "", smtpPort = 0, alertMode = "all", trialDays = 0, planKey = "", paidDays = 0 }) {
  phone = normPhone(phone);
  if (!/^\d{11,15}$/.test(phone)) throw new Error("Enter the client's WhatsApp number, e.g. 0772123456");
  if (!isEmail(email)) throw new Error("Enter a valid email address");
  const acc = await createAccount(phone, email, { businessName, setupBy: "admin", phoneVerified: true });
  if (alertMode) acc.alertMode = alertMode;
  if (businessName && !acc.displayName) acc.displayName = businessName;
  if (trialDays > 0) acc.trialEndsAt = daysFromNow(trialDays);
  await acc.save();
  let connected = false, message = "";
  if (password) {
    if (!canStorePasswords()) message = "MAIL_SECRET_KEY is not set, so passwords can't be saved. Use forwarding.";
    else {
      try { const r = await connectWithPassword(acc, { pass: password, protocol, imapHost, imapPort, smtpHost, smtpPort }); connected = true; const ib = r.imap || r.pop; message = `Connected by ${r.protocol === "pop3" ? "POP3" : "IMAP"} via ${ib.host}:${ib.port}${ib.insecureTls ? " (host certificate mismatch, allowed)" : ""}${r.smtp ? `, replies via ${r.smtp.host}:${r.smtp.port}` : ", replies via ZimQuote (no SMTP)"}.`; }
      catch (e) { message = e.message; }
    }
  }
  return { acc, connected, message };
}

/** WhatsApp welcome for a client set up by the ZimQuote team. */
export async function sendClientWelcome(acc) {
  const text =
    `📧 *ZimQuote Mail is ready for ${acc.email}*\n\n` +
    `Our team set it up for you. New emails will arrive here on WhatsApp with a short summary.\n\n` +
    `Tap *↩️ Reply* on any email to answer it from WhatsApp - we send it as a proper email.\n\n` +
    (isActive(acc) && acc.paidUntil ? `✅ Active until ${fmtDate(acc.paidUntil)}.` : `🎁 Free trial until ${fmtWhen(acc.trialEndsAt)}.\n\n${await pricingText(acc)}`);
  try { await sendButtons(acc.ownerPhone, { text: text.length > 1000 ? text.slice(0, 999) + "…" : text, buttons: [{ id: "mail_menu", title: "📧 My Mail" }, ...(acc.paidUntil ? [] : [{ id: `mail_pay_${acc._id}`, title: "💳 Choose a plan" }])] }); return true; }
  catch (_) { return false; }
}

/** Send a test email TO the customer's address (proves forwarding / login works end to end). */
export async function sendTestEmail(acc) {
  const ps = platformSmtp();
  if (!ps) throw new Error("Sending isn't set up: add MAIL_COLLECTOR_USER and MAIL_COLLECTOR_PASS (a mailbox on your cPanel) to .env and restart");
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport(ps.opts);
  await t.sendMail({
    from: `"ZimQuote Mail" <${ps.from}>`,
    to: acc.email,
    subject: "ZimQuote Mail test - you can reply to this",
    text: `Hello${acc.businessName ? " " + acc.businessName : ""},\n\nThis is a test from ZimQuote Mail. If this email appears on your WhatsApp, everything is working.\n\nTry tapping Reply on WhatsApp to answer it.\n\nZimQuote`,
    headers: { "X-ZimQuote-Test": "1" }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// COLLECTOR MAILBOX (forwarding without MX/port-25 work)
// ═════════════════════════════════════════════════════════════════════════════
let _collectorBusy = false;
export const collectorStatus = { lastRunAt: null, lastOkAt: null, lastError: "", processed: 0, insecureTls: false };

export async function pollCollector() {
  const c = MAIL_CONFIG.COLLECTOR;
  if (!c || _collectorBusy) return;
  _collectorBusy = true;
  collectorStatus.lastRunAt = new Date();
  const { ImapFlow } = await import("imapflow");
  const stateCol = mongoose.connection.collection("mail_state");
  const open = async insecure => {
    const cl = new ImapFlow({ host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 30000, ...(insecure ? { tls: { rejectUnauthorized: false } } : {}) });
    await cl.connect(); return cl;
  };
  let cl = null;
  try {
    try { cl = await open(collectorStatus.insecureTls); }
    catch (e) { if (!collectorStatus.insecureTls && _isTlsNameErr(e)) { collectorStatus.insecureTls = true; cl = await open(true); } else throw e; }
    const lock = await cl.getMailboxLock("INBOX");
    try {
      const uv = String(cl.mailbox.uidValidity || "");
      const st = (await stateCol.findOne({ _id: "collector" })) || {};
      let last = st.uidValidity === uv ? Number(st.lastUid || 0) : 0;
      const done = [];
      if (st.uidValidity !== uv) {
        // First run: don't replay old mail older than 1 day
        last = 0;
        const since = new Date(Date.now() - 86400000);
        const recent = await cl.search({ since }, { uid: true }).catch(() => []);
        const old = Math.max(0, Math.min(...(recent.length ? recent : [cl.mailbox.uidNext || 1])) - 1);
        last = old;
      }
      let maxUid = last, n = 0;
      for await (const m of cl.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (m.uid <= last) continue;
        maxUid = Math.max(maxUid, m.uid);
        try { await ingestRaw(m.source, { collector: true }); done.push(m.uid); collectorStatus.processed++; }
        catch (e) { console.error("[MAIL COLLECTOR INGEST]", e.message); done.push(m.uid); }
        if (++n >= 40) break;
      }
      await stateCol.updateOne({ _id: "collector" }, { $set: { lastUid: maxUid, uidValidity: uv, at: new Date() } }, { upsert: true });
      if (done.length) {
        if (c.keep) await cl.messageFlagsAdd(done, ["\\Seen"], { uid: true }).catch(() => {});
        else await cl.messageDelete(done, { uid: true }).catch(() => {});       // stored in MongoDB already
      }
    } finally { lock.release(); }
    collectorStatus.lastOkAt = new Date(); collectorStatus.lastError = "";
  } catch (e) {
    collectorStatus.lastError = e?.responseText || e.message || "failed";
    console.error("[MAIL COLLECTOR]", collectorStatus.lastError);
  } finally {
    if (cl) await cl.logout().catch(() => {});
    _collectorBusy = false;
  }
}

/** Admin: update an inbox. */
export async function updateAccount(id, f = {}) {
  const acc = await MailAccount.findById(id);
  if (!acc) throw new Error("Inbox not found");
  if (f.email !== undefined) {
    const e = String(f.email).trim().toLowerCase();
    if (!isEmail(e)) throw new Error("Invalid email address");
    if (e !== acc.email) { acc.email = e; acc.provider = (await detectProvider(e)).provider; }
  }
  if (f.ownerPhone !== undefined) {
    const p = normPhone(f.ownerPhone);
    if (!/^\d{11,15}$/.test(p)) throw new Error("Invalid owner WhatsApp number");
    acc.ownerPhone = p; acc.phoneVerified = true; acc.linkCode = undefined;
  }
  if (f.alertPhones !== undefined) {
    acc.alertPhones = [...new Set(String(f.alertPhones).split(/[,;\r\n]+/).map(normPhone).filter(p => /^\d{11,15}$/.test(p) && p !== acc.ownerPhone))].slice(0, 5);
  }
  for (const k of ["businessName", "displayName", "signature"]) if (f[k] !== undefined) acc[k] = String(f[k]).slice(0, k === "signature" ? 500 : 80);
  if (f.alertMode) acc.alertMode = f.alertMode === "important" ? "important" : "all";
  if (f.status && ["setup", "live", "paused"].includes(f.status)) acc.status = f.status;
  if (f.trialEndsAt !== undefined) acc.trialEndsAt = f.trialEndsAt ? new Date(f.trialEndsAt + "T23:59:00+02:00") : null;
  if (f.paidUntil !== undefined) acc.paidUntil = f.paidUntil ? new Date(f.paidUntil + "T23:59:00+02:00") : null;
  if (f.plan && MAIL_PLANS[f.plan]) acc.plan = f.plan;
  if (f.useForwarding) { acc.mode = "forward"; acc.imap = {}; acc.pop = {}; acc.smtp = {}; if (acc.status === "error") acc.status = "setup"; }
  await acc.save(); _mailPhones.at = 0;
  return acc;
}

/** Admin: delete an inbox with all its emails and attachments. */
export async function deleteAccount(id) {
  const acc = await MailAccount.findById(id);
  if (!acc) throw new Error("Inbox not found");
  await MailMessage.deleteMany({ accountId: acc._id }).catch(() => {});
  await mongoose.connection.collection("mail_attachments").deleteMany({ accountId: acc._id }).catch(() => {});
  await MailAccount.deleteOne({ _id: acc._id });
  _mailPhones.at = 0;
  return acc;
}

// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM CHECK (admin page)
// ═════════════════════════════════════════════════════════════════════════════
export async function missingPackages() {
  const out = [];
  for (const p of ["mailparser", "imapflow", "nodemailer", "node-pop3"]) { try { await import(p); } catch (_) { out.push(p); } }
  return out;
}
export async function systemCheck() {
  const e = process.env;
  return {
    missing: await missingPackages(),
    secretKey: canStorePasswords(),
    secretFromSession: !e.MAIL_SECRET_KEY && canStorePasswords(),
    collector: MAIL_CONFIG.COLLECTOR ? { address: MAIL_CONFIG.COLLECTOR.address, host: MAIL_CONFIG.COLLECTOR.host, port: MAIL_CONFIG.COLLECTOR.port } : null,
    sending: !!platformSmtp(),
    ai: !!e.OPENAI_API_KEY,
    template: MAIL_CONFIG.TEMPLATE,
    adminPhone: !!(e.ZQ_ADMIN_PHONE || e.ADMIN_WHATSAPP_PHONE)
  };
}

// Ready-made server settings shown in the connect forms
export const MAIL_PRESETS = {
  auto:      { label: "Find automatically (recommended)", imap: "", imapPort: "", pop: "", popPort: "", smtp: "", smtpPort: "", note: "We try IMAP first, then POP3." },
  cpanel:    { label: "Company email (.co.zw / .com / .org - cPanel)", imap: "mail.{domain}", imapPort: 993, pop: "mail.{domain}", popPort: 995, smtp: "mail.{domain}", smtpPort: 465, note: "Use the normal email password. Most hosting supports IMAP; choose POP3 only if your host says so." },
  gmail:     { label: "Gmail / Google Workspace", imap: "imap.gmail.com", imapPort: 993, pop: "pop.gmail.com", popPort: 995, smtp: "smtp.gmail.com", smtpPort: 465, note: "Needs an App Password: Google Account → Security → 2-Step Verification → App passwords. Or use forwarding." },
  yahoo:     { label: "Yahoo Mail", imap: "imap.mail.yahoo.com", imapPort: 993, pop: "pop.mail.yahoo.com", popPort: 995, smtp: "smtp.mail.yahoo.com", smtpPort: 465, note: "Needs an App Password: Yahoo Account Security → Generate app password." },
  outlook:   { label: "Outlook / Hotmail / Live", imap: "outlook.office365.com", imapPort: 993, pop: "outlook.office365.com", popPort: 995, smtp: "smtp-mail.outlook.com", smtpPort: 587, note: "Microsoft blocks password logins for most Outlook/Hotmail accounts. If it fails, use forwarding instead (Settings → Mail → Forwarding)." },
  office365: { label: "Microsoft 365 (company)", imap: "outlook.office365.com", imapPort: 993, pop: "outlook.office365.com", popPort: 995, smtp: "smtp.office365.com", smtpPort: 587, note: "Often blocked by the company's admin. Forwarding usually works better." },
  zoho:      { label: "Zoho Mail", imap: "imap.zoho.com", imapPort: 993, pop: "pop.zoho.com", popPort: 995, smtp: "smtp.zoho.com", smtpPort: 465, note: "Turn on IMAP access in Zoho settings first." },
  icloud:    { label: "iCloud Mail", imap: "imap.mail.me.com", imapPort: 993, pop: "", popPort: "", smtp: "smtp.mail.me.com", smtpPort: 587, note: "Needs an app-specific password from appleid.apple.com." }
};
export function presetFor(provider) {
  return { google: "gmail", yahoo: "yahoo", microsoft: "outlook", zoho: "zoho", apple: "icloud", cpanel: "cpanel" }[provider] || "auto";
}

// ═════════════════════════════════════════════════════════════════════════════
// ATTACHMENTS: storage (chunked, so big files fit MongoDB's 16 MB limit) and
// files sent from WhatsApp while writing a reply
// ═════════════════════════════════════════════════════════════════════════════
const CHUNK = 8 * 1024 * 1024;
const maxInBytes  = () => envNum("MAIL_MAX_ATTACH_MB", 25) * 1048576;   // per received file
const maxOutBytes = () => envNum("MAIL_MAX_SEND_MB", 15) * 1048576;     // per sent email (many servers reject bigger)
const MAX_OUT_FILES = 5;
export function fmtSize(n) {
  n = Number(n) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
export async function saveAttachment(id, { accountId, filename, contentType, data, outgoing = false }) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const meta = { _id: id, accountId, filename, contentType: contentType || "application/octet-stream", size: buf.length, outgoing, createdAt: new Date() };
  if (buf.length <= CHUNK) return attCol().insertOne({ ...meta, data: buf });
  const n = Math.ceil(buf.length / CHUNK);
  for (let i = 0; i < n; i++) await attCol().insertOne({ _id: `${id}:${i}`, accountId, chunkOf: id, i, data: buf.subarray(i * CHUNK, (i + 1) * CHUNK) });
  return attCol().insertOne({ ...meta, chunks: n });
}
const _toBuf = d => Buffer.isBuffer(d) ? d : d?._bsontype === "Binary" ? Buffer.from(d.buffer) : Buffer.from(d || "");
export async function readAttachment(id) {
  const doc = await attCol().findOne({ _id: String(id) });
  if (!doc) return null;
  if (!doc.chunks) return { doc, data: _toBuf(doc.data) };
  const parts = [];
  for (let i = 0; i < doc.chunks; i++) {
    const c = await attCol().findOne({ _id: `${id}:${i}` });
    if (!c) return null;
    parts.push(_toBuf(c.data));
  }
  return { doc, data: Buffer.concat(parts) };
}

/** Is this person writing a reply (so a file they send should be attached)? */
export async function mailAwaitingFile(from) {
  try { const s = await getSess(normPhone(from)); return s.state === "reply" || s.state === "confirm"; }
  catch (_) { return false; }
}

/** A file (document or photo) sent on WhatsApp while writing a reply. */
export async function handleMailFile({ from, filename = "file", mime = "application/octet-stream", data, caption = "" }) {
  const phone = normPhone(from);
  const s = await getSess(phone);
  if (s.state !== "reply" && s.state !== "confirm") return false;
  const { msg, acc } = await loadMsg(phone, s.data.msgId);
  if (!msg) { await clearState(phone); await notFound(phone); return true; }
  const files = [...(s.data.files || [])];
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || "");
  const limit = maxOutBytes();
  if (files.length >= MAX_OUT_FILES) { await sendText(phone, `📎 You can attach up to ${MAX_OUT_FILES} files to one email.`); return true; }
  const total = files.reduce((t, f) => t + (f.size || 0), 0) + buf.length;
  if (buf.length > limit || total > limit) {
    await sendText(phone, `❌ *${filename}* (${fmtSize(buf.length)}) is too big. One email can carry up to ${fmtSize(limit)} in total - many email servers reject bigger emails.\n\nTip: send a smaller PDF, or share a link instead.`);
    return true;
  }
  const id = crypto.randomBytes(10).toString("hex");
  await saveAttachment(id, { accountId: acc._id, filename, contentType: mime, data: buf, outgoing: true });
  files.push({ id, filename, size: buf.length, contentType: mime });
  if (s.state === "confirm" || caption) {
    const text = caption && s.state !== "confirm" ? caption : (s.data.text || caption || "");
    await showPreview(phone, msg, text, { polished: s.state === "confirm" ? !!s.data.polished : false, original: s.state === "confirm" ? (s.data.original || text) : text, files });
  } else {
    await setState(phone, "reply", { ...s.data, files });
    await sendText(phone, `📎 *Attached:*\n${files.map(f => `• ${f.filename} (${fmtSize(f.size)})`).join("\n")}\n\nNow *type your message* (e.g. "Please find our quotation attached"), or send more files.`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// PRICING TEXT (shown when an email is added, connected, and before the trial ends)
// ═════════════════════════════════════════════════════════════════════════════
export async function pricingText(acc = null, { short = false } = {}) {
  const lines = [];
  let supplier = false;
  for (const k of PLAN_KEYS) {
    const pl = MAIL_PLANS[k];
    const pr = acc ? await priceFor(acc, k) : { price: pl.price, base: pl.price, supplier: false };
    supplier = supplier || pr.supplier;
    lines.push(`• *${pl.name} $${pr.price}/year*${pr.supplier ? ` ~$${pr.base}~` : ""}${short ? "" : ` - ${pl.blurb}`}`);
  }
  return `💳 *Plans (paid once a year, no monthly fees):*\n${lines.join("\n")}` +
    (supplier ? `\n🏪 Listed ZimQuote seller price (${Math.round(SUPPLIER_DISCOUNT() * 100)}% off).` : (short ? "" : `\n🏪 Listed ZimQuote sellers get ${Math.round(SUPPLIER_DISCOUNT() * 100)}% off.`));
}

/** "Connected!" message with the plans and a pay button (used by every connect path). */
export async function sendConnectedMessage(acc, detail) {
  const paid = acc.paidUntil && new Date(acc.paidUntil) > new Date();
  const text = `🎉 *${acc.email} is connected!*\n\n${detail}\n\n` +
    (paid ? `✅ Active until ${fmtDate(acc.paidUntil)}.` : `🎁 Free trial until *${fmtWhen(acc.trialEndsAt)}*.\n\n${await pricingText(acc)}`);
  return sendButtons(acc.ownerPhone, {
    text: text.length > 1000 ? text.slice(0, 999) + "…" : text,
    buttons: paid ? [{ id: "mail_menu", title: "📧 My Mail" }] : [{ id: `mail_pay_${acc._id}`, title: "💳 Choose a plan" }, { id: "mail_menu", title: "📧 My Mail" }]
  });
}

// routes/reseApi.js
//
// The Rese Rese app-facing API. Same idiom as your mobileApi.js: JWT auth,
// per-router body parsing (global parsers are off), GridFS for images, Paynow
// for the worker "corner fee". Mount:
//
//    import reseApiRouter from "./routes/reseApi.js";
//    app.use("/api/rese", reseApiRouter);
//
// ENV (reuse your ZimQuote WhatsApp values):
//   RESE_JWT_SECRET          (falls back to JWT_SECRET)
//   RESE_WA_TOKEN            WhatsApp Cloud API access token
//   RESE_WA_PHONE_ID         WhatsApp phone-number-id
//   RESE_WA_OTP_TEMPLATE     approved auth template name (optional)
//   RESE_WA_OTP_LANG         template language code (default "en")
//   RESE_DEV_OTP             "true" → also log/return the code (default "true")
//   RESE_WEEKLY_FEE          corner-fee amount (default 1)

import { Router } from "express";
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import crypto from "crypto";
import jwt from "jsonwebtoken";

import ReseUser from "../models/reseUser.js";
import ReseOtp from "../models/reseOtp.js";
import JobRequest from "../models/jobRequest.js";
import ReseSetting from "../models/reseSetting.js";
import ResePayment from "../models/resePayment.js";
import paynow from "../services/paynow.js";

const router = Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

const JWT_SECRET = process.env.RESE_JWT_SECRET || process.env.JWT_SECRET || "rese_dev_secret_change_me";
// Reuse the SAME WhatsApp credentials the ZimQuote chatbot already uses.
const WA_TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || process.env.RESE_WA_TOKEN || "";
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || process.env.RESE_WA_PHONE_ID || "";
const WA_TEMPLATE = process.env.RESE_WA_OTP_TEMPLATE || ""; // approved template, one {{1}} body variable
const WA_LANG = process.env.RESE_WA_OTP_LANG || "en";
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v24.0";
const DEV_OTP = String(process.env.RESE_DEV_OTP || "true").toLowerCase() === "true";
const WEEKLY_FEE = Number(process.env.RESE_WEEKLY_FEE || 1);

/* ── helpers ──────────────────────────────────────────────── */

function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (d.startsWith("0")) d = "263" + d.slice(1);
  if (d.length === 9) d = "263" + d;
  if (d.startsWith("263") && d.length === 12) return "+" + d;
  return null;
}
function to07(e164) {
  const d = String(e164 || "").replace(/[^\d]/g, "");
  return d.startsWith("263") ? "0" + d.slice(3) : d;
}
function signToken(u) {
  return jwt.sign({ sub: String(u._id), phone: u.phone }, JWT_SECRET, { expiresIn: "180d" });
}
async function requireReseAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: "auth" });
    const p = jwt.verify(tok, JWT_SECRET);
    const u = await ReseUser.findById(p.sub);
    if (!u) return res.status(401).json({ error: "auth" });
    req.reseUser = u;
    next();
  } catch {
    return res.status(401).json({ error: "auth" });
  }
}
function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "rese_uploads" });
}
function putFile(buffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(filename, { contentType });
    up.on("error", reject);
    up.on("finish", () => resolve(up.id));
    up.end(buffer);
  });
}
function publicUser(u) {
  return {
    id: String(u._id),
    phone: u.phone,
    name: u.name,
    lang: u.lang,
    isWorker: u.isWorker,
    isRequester: u.isRequester,
    lastMode: u.lastMode,
    worker: { skills: u.worker?.skills || [], suburbs: u.worker?.suburbs || [] },
    verification: u.verification?.status || "unverified",
    access: u.accessActive,
    hasAvatar: !!u.avatarFileId
  };
}

/* ── WhatsApp OTP send (falls back to plain text, then dev log) ── */

async function sendWhatsAppOtp(phoneE164, code) {
  if (!WA_TOKEN || !WA_PHONE_ID) return { sent: false, reason: "no-credentials" };
  const to = phoneE164.replace(/[^\d]/g, ""); // 2637...

  // 1) Approved template — delivers outside the 24h window (new users).
  if (WA_TEMPLATE) {
    try {
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: WA_TEMPLATE,
            language: { code: WA_LANG },
            components: [{ type: "body", parameters: [{ type: "text", text: String(code) }] }]
          }
        })
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return { sent: true, via: "template" };
      console.warn("[rese wa] template failed:", JSON.stringify(j?.error || j));
    } catch (e) {
      console.warn("[rese wa] template error:", e.message);
    }
  }

  // 2) Free-form text — works if the user messaged the number in the last 24h.
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: `Your Rese Rese code is ${code}. It expires in 10 minutes. Do not share it.` }
      })
    });
    if (r.ok) return { sent: true, via: "text" };
    const j = await r.json().catch(() => ({}));
    console.warn("[rese wa] text failed:", JSON.stringify(j?.error || j));
    return { sent: false, reason: j?.error?.message || "send-failed" };
  } catch (e) {
    console.warn("[rese wa] text error:", e.message);
    return { sent: false, reason: e.message };
  }
}

// SMS fallback — plug your Zimbabwe gateway here.
async function sendSmsOtp(/* phoneE164, code */) {
  return { sent: false, reason: "sms-not-configured" };
}

/* ── expo push ────────────────────────────────────────────── */

async function sendPush(tokens, title, body, data = {}) {
  const msgs = (tokens || []).filter(Boolean).map((to) => ({ to, title, body, data, sound: "default", channelId: "jobs" }));
  if (!msgs.length) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msgs)
    });
  } catch (e) {
    console.warn("[rese push]", e.message);
  }
}


// Send the OTP through the SAME ZimQuote chatbot senders (dynamic import so a
// bad path can never crash this route). Template first (works for new users),
// then free-form text (works inside the 24h window).
async function sendOtpViaChatbot(phoneE164, code) {
  const to = String(phoneE164).replace(/[^\d]/g, ""); // 2637...
  const tpl = process.env.RESE_WA_OTP_TEMPLATE || "";
  if (tpl) {
    try {
      const m = await import("../services/buyerRequestNotifications.js");
      if (m && typeof m._sendTemplate === "function") {
        await m._sendTemplate(to, tpl, [String(code)]);
        return { sent: true, via: "template" };
      }
    } catch (e) { console.warn("[rese otp] chatbot template failed:", e.message); }
  }
  try {
    const ms = await import("../services/metaSender.js");
    if (ms && typeof ms.sendText === "function") {
      await ms.sendText(to, `Your Rese Rese code is ${code}. It expires in 10 minutes. Do not share it.`);
      return { sent: true, via: "text" };
    }
  } catch (e) { console.warn("[rese otp] chatbot text failed:", e.message); }
  return { sent: false };
}

/* ══════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════ */

router.post("/auth/request-code", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Enter a valid phone number" });

    const code = ReseOtp.generateCode();
    try {
      await ReseOtp.create({ phone, codeHash: ReseOtp.hashCode(code) });
    } catch (e) {
      console.error("[rese otp] store failed:", e.message);
      return res.status(500).json({ error: "Could not start sign in. Try again." });
    }

    // 1) chatbot senders, 2) direct Graph API, both guarded — never throw here.
    let out = { sent: false };
    try { out = await sendOtpViaChatbot(phone, code); } catch (e) { console.warn("[rese otp] chatbot error:", e.message); }
    if (!out.sent) {
      try { out = await sendWhatsAppOtp(phone, code); } catch (e) { console.warn("[rese otp] direct error:", e.message); }
    }

    const resp = { ok: true, channel: out.sent ? (out.via || "whatsapp") : "none" };
    if (DEV_OTP) {
      console.log(`[rese otp] ${phone} -> ${code} (channel: ${resp.channel})`);
      resp.devCode = code;
    }
    return res.json(resp);
  } catch (err) {
    console.error("[rese request-code]", err);
    return res.status(500).json({ error: "Could not send the code. Try again." });
  }
});

router.post("/auth/verify", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || "").trim();
    if (!phone || !code) return res.status(400).json({ error: "Missing phone or code" });

    const otp = await ReseOtp.findOne({ phone }).sort({ createdAt: -1 });
    if (!otp) return res.status(400).json({ error: "Code expired. Please ask again." });
    if (otp.attempts >= 5) return res.status(429).json({ error: "Too many tries. Ask for a new code." });
    if (otp.codeHash !== ReseOtp.hashCode(code)) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).json({ error: "Wrong code." });
    }
    await ReseOtp.deleteMany({ phone });

    let user = await ReseUser.findOne({ phone });
    if (!user) user = await ReseUser.create({ phone, isRequester: true });
    user.lastActiveAt = new Date();
    await user.save();

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error("[rese verify]", err);
    res.status(500).json({ error: "Could not verify" });
  }
});

/* ══════════════════════════════════════════════════════════════
   PROFILE
   ══════════════════════════════════════════════════════════════ */

router.get("/me", requireReseAuth, (req, res) => res.json({ user: publicUser(req.reseUser) }));

router.put("/me", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const b = req.body || {};
  if (typeof b.name === "string") u.name = b.name.slice(0, 60);
  if (["sn", "nd", "en"].includes(b.lang)) u.lang = b.lang;
  if (["requester", "worker"].includes(b.mode)) {
    u.lastMode = b.mode;
    if (b.mode === "worker") u.isWorker = true;
  }
  if (Array.isArray(b.skills)) u.worker.skills = b.skills.slice(0, 12);
  if (Array.isArray(b.suburbs)) u.worker.suburbs = b.suburbs.slice(0, 20);
  await u.save();
  res.json({ user: publicUser(u) });
});

router.post("/me/avatar", requireReseAuth, upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No photo" });
  const id = await putFile(req.file.buffer, `avatar_${req.reseUser._id}.jpg`, req.file.mimetype || "image/jpeg");
  req.reseUser.avatarFileId = id;
  await req.reseUser.save();
  res.json({ ok: true });
});

// selfie + national ID → sets verification to "pending" for admin review
router.post(
  "/me/verify",
  requireReseAuth,
  upload.fields([{ name: "selfie", maxCount: 1 }, { name: "id", maxCount: 1 }]),
  async (req, res) => {
    const u = req.reseUser;
    u.isWorker = true;
    if (req.files?.selfie?.[0]) u.worker.selfieFileId = await putFile(req.files.selfie[0].buffer, `selfie_${u._id}.jpg`, "image/jpeg");
    if (req.files?.id?.[0]) u.worker.idFileId = await putFile(req.files.id[0].buffer, `id_${u._id}.jpg`, "image/jpeg");
    if (u.worker.selfieFileId && u.worker.idFileId) u.verification.status = "pending";
    await u.save();
    res.json({ ok: true, verification: u.verification.status });
  }
);

/* ══════════════════════════════════════════════════════════════
   JOBS  (offer → choose → contact, with contact gating)
   ══════════════════════════════════════════════════════════════ */

// shape a job for a given viewer; hide contact until matched
function jobForViewer(job, viewerPhone) {
  const iPosted = job.posterPhone === viewerPhone;
  const iAmChosen = job.workerPhone && job.workerPhone === viewerPhone;
  const base = {
    id: String(job._id),
    category: job.category,
    description: job.description,
    suburb: job.suburb,
    budget: job.budget,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    mine: iPosted,
    offersCount: (job.offers || []).length,
    iOffered: (job.offers || []).some((o) => o.workerPhone === viewerPhone)
  };
  if (iPosted) {
    base.offers = (job.offers || []).map((o) => ({ workerPhone: o.workerPhone, workerName: o.workerName, note: o.note, at: o.at }));
  }
  // contact only revealed to the matched pair
  if (iPosted && job.status !== "open") {
    base.contactName = job.workerName;
    base.contactPhone = job.workerPhone;
  }
  if (iAmChosen) {
    base.contactName = job.posterName;
    base.contactPhone = job.posterPhone;
  }
  return base;
}

router.post("/jobs", requireReseAuth, async (req, res) => {
  try {
    const u = req.reseUser;
    const b = req.body || {};
    if (!b.category || !b.suburb) return res.status(400).json({ error: "Missing details" });
    const setting = await ReseSetting.load();
    const hours = Number(b.durationHours) || setting.autoExpireHours || 3;

    const job = await JobRequest.create({
      poster: u._id,
      posterPhone: u.phone,
      posterName: u.name || "Someone",
      category: String(b.category),
      description: String(b.description || "").slice(0, 300),
      suburb: String(b.suburb),
      budget: String(b.budget || ""),
      status: "open",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + hours * 3600000),
      offers: []
    });

    // notify matching, available workers
    const workers = await ReseUser.find({
      isWorker: true,
      expoPushToken: { $ne: null },
      "access.status": { $ne: "suspended" },
      phone: { $ne: u.phone }
    }).lean();
    const targets = workers
      .filter((w) => {
        const skills = w.worker?.skills || [];
        const subs = w.worker?.suburbs || [];
        const skillOk = skills.length === 0 || skills.includes(job.category) || skills.includes("any") || job.category === "any";
        const areaOk = subs.length === 0 || subs.includes(job.suburb);
        return skillOk && areaOk;
      })
      .map((w) => w.expoPushToken);
    sendPush(targets, "New job near you", `${job.description || job.category} · ${job.suburb} · ${job.budget}`, { jobId: String(job._id) });

    res.json({ job: jobForViewer(job, u.phone) });
  } catch (err) {
    console.error("[rese jobs create]", err);
    res.status(500).json({ error: "Could not post job" });
  }
});

// worker feed: open jobs matching my skills/areas, not mine, not expired
router.get("/jobs/feed", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const skills = u.worker?.skills || [];
  const subs = u.worker?.suburbs || [];
  const jobs = await JobRequest.find({
    status: "open",
    posterPhone: { $ne: u.phone },
    removedByAdmin: { $ne: true },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).sort({ createdAt: -1 }).limit(100).lean();

  const filtered = jobs.filter((j) => {
    const skillOk = skills.length === 0 || skills.includes("any") || skills.includes(j.category) || j.category === "any";
    const areaOk = subs.length === 0 || subs.includes(j.suburb);
    return skillOk && areaOk;
  });
  res.json({ jobs: filtered.map((j) => jobForViewer(j, u.phone)) });
});

// my jobs: posted by me, or offered on / accepted by me
router.get("/jobs/mine", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const jobs = await JobRequest.find({
    $or: [{ posterPhone: u.phone }, { "offers.workerPhone": u.phone }, { workerPhone: u.phone }]
  }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ jobs: jobs.map((j) => jobForViewer(j, u.phone)) });
});

router.get("/jobs/:id", requireReseAuth, async (req, res) => {
  const job = await JobRequest.findById(req.params.id).lean();
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({ job: jobForViewer(job, req.reseUser.phone) });
});

router.post("/jobs/:id/offer", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const job = await JobRequest.findById(req.params.id);
  if (!job || job.status !== "open") return res.status(400).json({ error: "Job not open" });
  if (job.posterPhone === u.phone) return res.status(400).json({ error: "Your own job" });
  job.offers = job.offers || [];
  if (!job.offers.some((o) => o.workerPhone === u.phone)) {
    job.offers.push({ workerPhone: u.phone, workerName: u.name || "Worker", note: String(req.body?.note || "").slice(0, 120), at: new Date() });
    await job.save();
    const poster = await ReseUser.findOne({ phone: job.posterPhone }).lean();
    if (poster?.expoPushToken) sendPush([poster.expoPushToken], "Someone wants your job", `${u.name || "A worker"} offered on: ${job.description || job.category}`, { jobId: String(job._id) });
  }
  res.json({ job: jobForViewer(job, u.phone) });
});

router.post("/jobs/:id/choose", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const job = await JobRequest.findById(req.params.id);
  if (!job || job.posterPhone !== u.phone) return res.status(403).json({ error: "Not your job" });
  const offer = (job.offers || []).find((o) => o.workerPhone === String(req.body?.workerPhone));
  if (!offer) return res.status(400).json({ error: "No such offer" });
  job.status = "accepted";
  job.worker = null;
  job.workerPhone = offer.workerPhone;
  job.workerName = offer.workerName;
  job.acceptedAt = new Date();
  await job.save();
  const chosen = await ReseUser.findOne({ phone: offer.workerPhone }).lean();
  if (chosen?.expoPushToken) sendPush([chosen.expoPushToken], "You were chosen! 🎉", `${job.description || job.category} · ${job.suburb}. You can talk now.`, { jobId: String(job._id) });
  res.json({ job: jobForViewer(job, u.phone) });
});

router.post("/jobs/:id/done", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const job = await JobRequest.findById(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.posterPhone !== u.phone && job.workerPhone !== u.phone) return res.status(403).json({ error: "Not yours" });
  job.status = "done";
  job.completedAt = new Date();
  await job.save();
  if (job.workerPhone) await ReseUser.updateOne({ phone: job.workerPhone }, { $inc: { "worker.jobsDone": 1 } });
  res.json({ job: jobForViewer(job, u.phone) });
});

router.post("/jobs/:id/rate", requireReseAuth, async (req, res) => {
  const u = req.reseUser;
  const stars = Math.max(1, Math.min(5, Number(req.body?.stars) || 0));
  const job = await JobRequest.findById(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  // rating the OTHER party
  const targetPhone = job.posterPhone === u.phone ? job.workerPhone : job.posterPhone;
  if (targetPhone) {
    const target = await ReseUser.findOne({ phone: targetPhone });
    if (target) {
      const c = target.worker.ratingCount || 0;
      const avg = target.worker.ratingAvg || 0;
      target.worker.ratingAvg = (avg * c + stars) / (c + 1);
      target.worker.ratingCount = c + 1;
      await target.save();
    }
  }
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════
   PUSH
   ══════════════════════════════════════════════════════════════ */

router.post("/push/register", requireReseAuth, async (req, res) => {
  const token = String(req.body?.token || "");
  if (token) {
    req.reseUser.expoPushToken = token;
    await req.reseUser.save();
  }
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════
   PAYMENTS — worker "corner fee" via Paynow EcoCash
   ══════════════════════════════════════════════════════════════ */

router.post("/pay/init", requireReseAuth, async (req, res) => {
  try {
    const u = req.reseUser;
    const phone07 = to07(req.body?.phone || u.phone);
    if (!/^07[7-8]\d{7}$/.test(phone07)) return res.status(400).json({ error: "Enter a valid EcoCash number (07...)" });

    const reference = `RESE-${crypto.randomUUID()}`;
    const pr = paynow.createPayment(reference, `${phone07}@ecocash.local`);
    pr.add("Rese Rese weekly access", WEEKLY_FEE);
    const response = await paynow.sendMobile(pr, phone07, "ecocash");
    if (!response.success) return res.status(400).json({ error: response.error || "Could not send EcoCash prompt" });

    await ResePayment.create({ userId: u._id, phone: phone07, reference, amount: WEEKLY_FEE, days: 7, pollUrl: response.pollUrl, status: "pending" });
    res.json({ ok: true, reference, message: `Approve the EcoCash prompt on ${phone07}.` });
  } catch (err) {
    console.error("[rese pay init]", err);
    res.status(500).json({ error: "Payment error" });
  }
});

router.get("/pay/poll/:reference", requireReseAuth, async (req, res) => {
  try {
    const pay = await ResePayment.findOne({ reference: req.params.reference, userId: req.reseUser._id });
    if (!pay) return res.status(404).json({ error: "Not found" });
    if (pay.status === "paid") return res.json({ status: "paid" });

    if (pay.pollUrl) {
      const result = await paynow.pollTransaction(pay.pollUrl);
      const s = String(result.status || "").toLowerCase();
      if (s === "paid") {
        pay.status = "paid";
        await pay.save();
        const u = await ReseUser.findById(pay.userId);
        if (u) {
          const now = new Date();
          const base = u.access?.expiresAt && new Date(u.access.expiresAt) > now ? new Date(u.access.expiresAt) : now;
          u.access = u.access || {};
          u.access.status = "paid";
          u.access.expiresAt = new Date(base.getTime() + pay.days * 86400000);
          u.access.lastPaymentRef = pay.reference;
          await u.save();
        }
        return res.json({ status: "paid" });
      }
      if (s === "failed" || s === "cancelled") {
        pay.status = s;
        await pay.save();
        return res.json({ status: s });
      }
    }
    res.json({ status: "pending" });
  } catch (err) {
    console.error("[rese pay poll]", err);
    res.json({ status: "pending" });
  }
});

export default router;
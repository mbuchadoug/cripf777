// routes/mobileChat.js
// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp-style chat between connected people (teacher↔student, parent↔child),
// plus teacher reports. Text + media (image/audio/file) via GridFS. Reply,
// delete (for me / for everyone), read receipts. MVP uses REST + client polling;
// a websocket upgrade can slot in later without changing the data model.
//
// Mount in server.js (before /api/mobile):
//   import mobileChatRouter from "./routes/mobileChat.js";
//   app.use("/api/mobile/chat", mobileChatRouter);
// Media is served publicly at /chat-media/:filename (also registered here).
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { GridFSBucket } from "mongodb";
import { Readable } from "stream";
import path from "path";
import crypto from "crypto";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import StudentReport from "../models/studentReport.js";
import { requireMobileAuth } from "./mobileApi.js";
import { isLinked, linkedLearnerIds, guardiansOf } from "../services/learnerLinks.js";
import { sendPushToUsers } from "../services/push.js";

const router = Router();
router.use(express.json({ limit: "512kb" }));
const nameOf = (u) => u?.displayName || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.username || "Someone";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
function bucket() { return new GridFSBucket(mongoose.connection.db, { bucketName: "chatmedia" }); }

// Are two users allowed to chat? (direct guardian↔learner relationship)
async function areConnected(aId, bId) {
  if (String(aId) === String(bId)) return false;
  const [a, b] = await Promise.all([
    User.findById(aId).select("parentUserId").lean(),
    User.findById(bId).select("parentUserId").lean()
  ]);
  if (a?.parentUserId && String(a.parentUserId) === String(bId)) return true;
  if (b?.parentUserId && String(b.parentUserId) === String(aId)) return true;
  if (await isLinked(aId, bId) || await isLinked(bId, aId)) return true;
  const ex = await ExamInstance.findOne({
    $or: [{ userId: aId, "meta.teacherId": bId }, { userId: bId, "meta.teacherId": aId }]
  }).select("_id").lean();
  return !!ex;
}

// ── list my conversations (other person + last message + unread) ─────────────
router.get("/conversations", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const convos = await Conversation.find({ participants: me }).sort({ lastActivity: -1 }).limit(100).lean();
    const otherIds = convos.map((c) => (c.participants || []).find((p) => String(p) !== String(me))).filter(Boolean);
    const others = otherIds.length ? await User.find({ _id: { $in: otherIds } }).select("displayName firstName lastName username").lean() : [];
    const byId = {}; for (const u of others) byId[String(u._id)] = u;
    const rows = [];
    for (const c of convos) {
      const otherId = (c.participants || []).find((p) => String(p) !== String(me));
      const unread = await Message.countDocuments({ conversation: c._id, sender: { $ne: me }, readBy: { $ne: me }, deletedForAll: { $ne: true } });
      rows.push({
        id: String(c._id),
        withUser: otherId ? { id: String(otherId), name: nameOf(byId[String(otherId)]) } : null,
        lastMessage: c.lastMessage?.text || "",
        lastAt: c.lastActivity,
        unread
      });
    }
    res.json({ conversations: rows });
  } catch (e) { console.error("[chat conversations]", e); res.status(500).json({ error: "Failed" }); }
});

// ── start (or fetch) a 1:1 conversation with a connected user ────────────────
router.post("/conversations", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const otherId = String(req.body?.userId || "");
    if (!mongoose.isValidObjectId(otherId)) return res.status(400).json({ error: "Invalid user." });
    if (!(await areConnected(me, otherId))) return res.status(403).json({ error: "You can only message people connected to you." });
    let convo = await Conversation.findOne({ isGroup: false, participants: { $all: [me, otherId], $size: 2 } });
    if (!convo) convo = await Conversation.create({ participants: [me, otherId], isGroup: false, lastActivity: new Date() });
    res.json({ id: String(convo._id) });
  } catch (e) { console.error("[chat start]", e); res.status(500).json({ error: "Failed" }); }
});

// ── messages in a conversation (paginated, newest first) ─────────────────────
router.get("/conversations/:id/messages", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const convo = await Conversation.findOne({ _id: req.params.id, participants: me }).lean();
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const q = { conversation: convo._id, deletedFor: { $ne: me } };
    if (before && !isNaN(before)) q.createdAt = { $lt: before };
    const msgs = await Message.find(q).sort({ createdAt: -1 }).limit(40)
      .populate("replyTo", "text sender media").lean();
    res.json({
      messages: msgs.map((m) => ({
        id: String(m._id), sender: String(m.sender), mine: String(m.sender) === String(me),
        text: m.deletedForAll ? "" : m.text, deleted: !!m.deletedForAll,
        media: m.deletedForAll ? null : (m.media?.url ? m.media : null),
        replyTo: m.replyTo ? { id: String(m.replyTo._id), text: m.replyTo.text, media: m.replyTo.media?.url ? { kind: m.replyTo.media.kind } : null } : null,
        readBy: (m.readBy || []).map(String), at: m.createdAt
      }))
    });
  } catch (e) { console.error("[chat messages]", e); res.status(500).json({ error: "Failed" }); }
});

// ── send a message (text and/or media reference) ─────────────────────────────
router.post("/conversations/:id/messages", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const convo = await Conversation.findOne({ _id: req.params.id, participants: me });
    if (!convo) return res.status(404).json({ error: "Conversation not found." });
    const text = String(req.body?.text || "").trim();
    const media = req.body?.media && req.body.media.url ? req.body.media : null;
    const replyTo = mongoose.isValidObjectId(req.body?.replyTo) ? req.body.replyTo : null;
    if (!text && !media) return res.status(400).json({ error: "Nothing to send." });

    const msg = await Message.create({ conversation: convo._id, sender: me, text, media: media || undefined, replyTo, readBy: [me] });
    convo.lastMessage = { text: text || (media ? `[${media.kind || "file"}]` : ""), sender: me, at: new Date() };
    convo.lastActivity = new Date();
    await convo.save();

    // notify the other participant
    const otherId = (convo.participants || []).find((p) => String(p) !== String(me));
    if (otherId) sendPushToUsers([otherId], { title: nameOf(req.mobileUser), body: text || "Sent an attachment", data: { type: "chat", conversationId: String(convo._id) } });

    res.json({ ok: true, id: String(msg._id), at: msg.createdAt });
  } catch (e) { console.error("[chat send]", e); res.status(500).json({ error: "Failed" }); }
});

// ── delete a message (for me, or for everyone if I sent it) ──────────────────
router.post("/messages/:id/delete", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const forEveryone = req.body?.forEveryone === true;
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Message not found." });
    const convo = await Conversation.findOne({ _id: msg.conversation, participants: me }).select("_id").lean();
    if (!convo) return res.status(403).json({ error: "Not allowed." });
    if (forEveryone && String(msg.sender) === String(me)) { msg.deletedForAll = true; msg.text = ""; msg.media = undefined; }
    else if (!msg.deletedFor.map(String).includes(String(me))) msg.deletedFor.push(me);
    await msg.save();
    res.json({ ok: true });
  } catch (e) { console.error("[chat delete]", e); res.status(500).json({ error: "Failed" }); }
});

// ── mark a conversation read ─────────────────────────────────────────────────
router.post("/conversations/:id/read", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    await Message.updateMany({ conversation: req.params.id, sender: { $ne: me }, readBy: { $ne: me } }, { $addToSet: { readBy: me } });
    res.json({ ok: true });
  } catch (e) { console.error("[chat read]", e); res.status(500).json({ error: "Failed" }); }
});

// ── upload media (image / audio / file) → returns a url to attach ────────────
router.post("/media", requireMobileAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file." });
    const mime = req.file.mimetype || "application/octet-stream";
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file";
    const filename = `${crypto.randomUUID()}${path.extname(req.file.originalname || "") || ""}`;
    const up = bucket().openUploadStream(filename, { contentType: mime, metadata: { user: req.mobileUser._id, name: req.file.originalname } });
    Readable.from(req.file.buffer).pipe(up);
    up.on("error", () => res.status(500).json({ error: "Upload failed." }));
    up.on("finish", () => res.json({ ok: true, media: { kind, url: `/chat-media/${filename}`, name: req.file.originalname, size: req.file.size, mime } }));
  } catch (e) { console.error("[chat media]", e); res.status(500).json({ error: "Failed" }); }
});

// ── TEACHER REPORTS ──────────────────────────────────────────────────────────
router.post("/reports", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const isTeacher = ["private_teacher", "teacher"].includes(me.role) || me.activeMobileRole === "teacher" || (Array.isArray(me.mobileRoles) && me.mobileRoles.includes("teacher"));
    if (!isTeacher) return res.status(403).json({ error: "Only teachers can add reports." });
    const studentId = String(req.body?.studentId || "");
    if (!mongoose.isValidObjectId(studentId)) return res.status(400).json({ error: "Invalid student." });
    if (!(await areConnected(me._id, studentId))) return res.status(403).json({ error: "That learner isn't in your class." });
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "Write something." });
    const rep = await StudentReport.create({
      teacher: me._id, student: studentId, body,
      title: String(req.body?.title || "Progress note"),
      subject: req.body?.subject || null,
      rating: Number.isFinite(Number(req.body?.rating)) ? Number(req.body.rating) : null
    });
    sendPushToUsers([studentId], { title: "New report", body: `${nameOf(me)} left a note`, data: { type: "report" } });
    res.json({ ok: true, id: String(rep._id) });
  } catch (e) { console.error("[report add]", e); res.status(500).json({ error: "Failed" }); }
});

// student (or their parent) reads reports
router.get("/reports", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    let studentId = String(me._id);
    if (req.query.studentId) {
      const sid = String(req.query.studentId);
      if (!(await areConnected(me._id, sid))) return res.status(403).json({ error: "Not allowed." });
      studentId = sid;
    }
    const reports = await StudentReport.find({ student: studentId }).sort({ createdAt: -1 }).limit(50)
      .populate("teacher", "displayName firstName lastName").lean();
    res.json({ reports: reports.map((r) => ({ id: String(r._id), title: r.title, body: r.body, subject: r.subject, rating: r.rating, teacher: nameOf(r.teacher), at: r.createdAt })) });
  } catch (e) { console.error("[reports get]", e); res.status(500).json({ error: "Failed" }); }
});


// ── who I can start a chat with (everyone connected to me) ───────────────────
router.get("/contacts", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser._id;
    const set = new Set();
    // learners I created / who created me
    const created = await User.find({ parentUserId: me }).select("_id").lean();
    created.forEach((u) => set.add(String(u._id)));
    const meDoc = await User.findById(me).select("parentUserId").lean();
    if (meDoc?.parentUserId) set.add(String(meDoc.parentUserId));
    // explicit links both directions
    (await linkedLearnerIds(me)).forEach((id) => set.add(String(id)));
    (await guardiansOf(me)).forEach((l) => set.add(String(l.guardian)));
    // assignment-derived (teacher↔student)
    const asStudent = await ExamInstance.find({ userId: me, "meta.teacherId": { $ne: null } }).select("meta").lean();
    asStudent.forEach((e) => e.meta?.teacherId && set.add(String(e.meta.teacherId)));
    const asTeacher = await ExamInstance.find({ "meta.teacherId": me }).select("userId").lean();
    asTeacher.forEach((e) => set.add(String(e.userId)));
    set.delete(String(me));
    const ids = [...set];
    const people = ids.length ? await User.find({ _id: { $in: ids } }).select("displayName firstName lastName role").lean() : [];
    const contacts = people.map((p) => ({ id: String(p._id), name: nameOf(p), role: p.role === "student" ? "student" : (["private_teacher", "teacher"].includes(p.role) ? "teacher" : "parent") }));
    console.log(`[chat contacts] user=${me} → ${contacts.length} contacts`);
    res.json({ contacts });
  } catch (e) { console.error("[chat contacts]", e); res.status(500).json({ error: "Failed" }); }
});

// ── public media streaming (range-enabled for audio) ─────────────────────────
export function chatMediaHandler() {
  return async (req, res) => {
    try {
      const files = await bucket().find({ filename: req.params.filename }).toArray();
      if (!files.length) return res.status(404).send("Not found");
      const file = files[0]; const size = file.length; const mime = file.contentType || "application/octet-stream";
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024 - 1, size - 1);
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Type": mime });
        bucket().openDownloadStreamByName(req.params.filename, { start, end: end + 1 }).pipe(res);
      } else {
        res.writeHead(200, { "Content-Length": size, "Content-Type": mime, "Accept-Ranges": "bytes" });
        bucket().openDownloadStreamByName(req.params.filename).pipe(res);
      }
    } catch (e) { console.error("[chat-media]", e); res.status(500).send("Error"); }
  };
}

export default router;
// routes/mobileLink.js
// ─────────────────────────────────────────────────────────────────────────────
// Linking existing learners to teachers/parents by USERNAME — for students who
// already have the app + their own login. Additive; mounts at /api/mobile/link.
//
//   POST /add                {username, as:"teacher"|"parent"}  — add a learner I found by username
//   GET  /my-learners                                            — learners linked to me
//   POST /remove/:learnerId                                      — I (guardian) remove a learner
//   GET  /my-guardians                                           — (student) who is linked to me + how-to
//   POST /guardian/:guardianId/remove                            — (student) remove a guardian
//
// Mount in server.js (before /api/mobile):
//   import mobileLinkRouter from "./routes/mobileLink.js";
//   app.use("/api/mobile/link", mobileLinkRouter);
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import { requireMobileAuth } from "./mobileApi.js";
import { linkLearner, unlink, guardiansOf, linkedLearnerIds } from "../services/learnerLinks.js";

const router = Router();
router.use(express.json({ limit: "256kb" }));

const nameOf = (u) => u?.displayName || [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.username || "";

// Who may add a learner as a teacher / as a parent (persona-aware, like the web).
function canBeTeacher(u) {
  return ["private_teacher", "teacher", "employee", "org_admin", "super_admin"].includes(u.role) ||
    u.activeMobileRole === "teacher" || (Array.isArray(u.mobileRoles) && u.mobileRoles.includes("teacher"));
}
function canBeParent(u) {
  return ["parent", "guardian", "private_teacher", "employee", "org_admin", "super_admin"].includes(u.role) ||
    u.activeMobileRole === "parent" || (Array.isArray(u.mobileRoles) && u.mobileRoles.includes("parent"));
}

// ── Add an existing learner by their username ────────────────────────────────
router.post("/add", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const as = req.body?.as === "parent" ? "parent" : "teacher";
    if (as === "teacher" && !canBeTeacher(me)) return res.status(403).json({ error: "Switch to your Teacher profile to add a learner." });
    if (as === "parent" && !canBeParent(me)) return res.status(403).json({ error: "Only a parent can add their child." });

    const username = String(req.body?.username || "").trim().toLowerCase();
    if (!username) return res.status(400).json({ error: "Enter the learner's username." });

    const learner = await User.findOne({ username, role: "student" }).select("_id displayName firstName lastName username grade").lean();
    if (!learner) return res.status(404).json({ error: "No student found with that username. Ask them to check it in their profile." });
    if (String(learner._id) === String(me._id)) return res.status(400).json({ error: "That's your own username." });

    await linkLearner({ guardianId: me._id, learnerId: learner._id, role: as, addedByName: nameOf(me) });

    res.json({
      ok: true,
      learner: { id: String(learner._id), name: nameOf(learner), username: learner.username, grade: learner.grade ?? null },
      message: as === "teacher"
        ? `${nameOf(learner) || "The learner"} is now in your class. You can assign quizzes and see their progress.`
        : `You're now linked to ${nameOf(learner) || "your child"} and can follow their learning.`
    });
  } catch (e) { console.error("[link add]", e); res.status(500).json({ error: "Could not add the learner. Please try again." }); }
});

// ── Learners linked to me (guardian) ─────────────────────────────────────────
router.get("/my-learners", requireMobileAuth, async (req, res) => {
  try {
    const ids = await linkedLearnerIds(req.mobileUser._id);
    const learners = ids.length ? await User.find({ _id: { $in: ids } }).select("displayName firstName lastName username grade").lean() : [];
    res.json({ learners: learners.map((l) => ({ id: String(l._id), name: nameOf(l), username: l.username || "", grade: l.grade ?? null })) });
  } catch (e) { console.error("[my-learners]", e); res.status(500).json({ error: "Failed" }); }
});

// ── I (guardian) remove a learner ────────────────────────────────────────────
router.post("/remove/:learnerId", requireMobileAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.learnerId)) return res.status(400).json({ error: "Invalid learner." });
    await unlink({ guardianId: req.mobileUser._id, learnerId: req.params.learnerId });
    res.json({ ok: true });
  } catch (e) { console.error("[link remove]", e); res.status(500).json({ error: "Failed" }); }
});

// ── (Student) who is linked to me + instructions ─────────────────────────────
router.get("/my-guardians", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const links = await guardiansOf(me._id);
    const gids = links.map((l) => l.guardian);
    const roleById = {}; for (const l of links) roleById[String(l.guardian)] = l.role;
    const people = gids.length ? await User.find({ _id: { $in: gids } }).select("displayName firstName lastName").lean() : [];
    res.json({
      username: me.username || null,
      howTo: "Share your username with a teacher or parent so they can add you. You can remove anyone here at any time.",
      guardians: people.map((p) => ({ id: String(p._id), name: nameOf(p) || "Someone", role: roleById[String(p._id)] || "teacher" }))
    });
  } catch (e) { console.error("[my-guardians]", e); res.status(500).json({ error: "Failed" }); }
});

// ── (Student) remove a guardian ──────────────────────────────────────────────
router.post("/guardian/:guardianId/remove", requireMobileAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.guardianId)) return res.status(400).json({ error: "Invalid." });
    await unlink({ guardianId: req.params.guardianId, learnerId: req.mobileUser._id });
    res.json({ ok: true });
  } catch (e) { console.error("[guardian remove]", e); res.status(500).json({ error: "Failed" }); }
});

export default router;
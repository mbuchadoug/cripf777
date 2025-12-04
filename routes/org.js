// routes/org.js
import { Router } from "express";
import crypto from "crypto";
import Organization from "../models/organization.js";
import OrgInvite from "../models/orgInvite.js";
import OrgMembership from "../models/orgMembership.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// create org (org admin)
router.post("/org/create", ensureAuth, async (req, res) => {
  try {
    const { name, slug, description } = req.body || {};
    if (!name || !slug) return res.status(400).json({ error: "name and slug required" });
    const org = await Organization.create({ name, slug, description, createdAt: new Date() });
    // add creator as org admin membership
    await OrgMembership.create({ org: org._id, user: req.user._id, role: "admin", joinedAt: new Date() });
    return res.json({ ok: true, org });
  } catch (e) {
    console.error("[org/create] error:", e && e.stack);
    return res.status(500).json({ error: "failed to create org" });
  }
});

// generate invite token (admin only)
router.post("/org/:slug/invite", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const { email, role = "employee" } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });
    // check user is admin in org
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership || !["admin","manager"].includes(membership.role)) return res.status(403).json({ error: "not allowed" });
    const token = crypto.randomBytes(12).toString("hex");
    await OrgInvite.create({ orgId: org._id, email: email.toLowerCase(), token, role, createdAt: new Date() });
    // you should email the invite.token to the email (omitted here)
    return res.json({ ok: true, token });
  } catch (e) {
    console.error("[org/invite] error:", e && e.stack);
    return res.status(500).json({ error: "invite failed" });
  }
});

// join via invite (user must be logged in)
router.get("/org/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("missing token");
    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");
    // create membership
    await OrgMembership.findOneAndUpdate(
      { org: invite.orgId, user: req.user._id },
      { $set: { role: invite.role, joinedAt: new Date() } },
      { upsert: true }
    );
    await OrgInvite.updateOne({ _id: invite._id }, { $set: { used: true } });
    return res.redirect(`/org/${invite.orgId}/dashboard`);
  } catch (e) {
    console.error("[org/join] error:", e && e.stack);
    return res.status(500).send("join failed");
  }
});

// dashboard (simple)
router.get("/org/:slug/dashboard", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).send("not a member");
    // render org dashboard view (create views/org/dashboard.hbs)
    return res.render("org/dashboard", { user: req.user, org, membership });
  } catch (e) {
    console.error("[org/dashboard] error:", e && e.stack);
    return res.status(500).send("dashboard error");
  }
});



// routes/org.js (add)
router.get('/org/:slug/quiz', ensureAuth, async (req, res) => {
  const slug = req.params.slug;
  const org = await Organization.findOne({ slug }).lean();
  if (!org) return res.status(404).send('org not found');
  const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
  if (!membership) return res.status(403).send('not a member');
  // you can send module options from DB or default
  res.render('org/quiz', { org, user: req.user, modules: org.modules || [], defaultModule: 'general' });
});

export default router;

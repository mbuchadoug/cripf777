// routes/login.js
// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL LOGIN - Phase 2. ONE front door for every kind of user.
//
//   GET  /login    sign in   (email, phone, username, student/teacher/admin ID)
//   GET  /signup   create an account (Student, Parent, Private teacher, Professional)
//   GET  /forgot   forgot password / forgot username
//
// JSON API used by views/auth/login.hbs:
//   POST /login/api/identify        { identifier }              → who is this + how can they sign in
//   POST /login/api/password        { password }                → sign in with password
//   POST /login/api/code/send       { option, purpose }         → WhatsApp / email code
//   POST /login/api/code/verify     { code }                    → sign in (or choose account)
//   POST /login/api/choose          { id }                      → pick one of several verified accounts
//   POST /login/api/set-password    { password }    (signed in) → set / reset password
//   POST /login/api/phone/send      { phone }       (signed in) → add a WhatsApp number
//   POST /login/api/phone/verify    { code }        (signed in)
//   POST /signup/api/start          { persona, firstName, lastName, contact, password, grade? }
//   POST /signup/api/verify         { code }
//   POST /forgot/api/username/send  { contact }
//   POST /forgot/api/username/verify{ code }                    → list of accounts + children
//
// Everything goes through services/identity.js (shared with the mobile app).
// Codes are hashed + attempt-limited; nothing ever changes an account's role.
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import bcrypt from "bcryptjs";
import User from "../models/user.js";
import {
  findAllByIdentifier, accountsForContact, contactOptions, describeAccount, displayNameOf,
  issueCode, verifyCode, codeErrorMessage, CodeError, landingFor, hasPersona,
  normalizeEmail, normalizePhone, maskPhone, maskEmail, createAccount, SIGNUP_ROLES, gradeLabel, PERSONAS
} from "../services/identity.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();
const FLOW_TTL = 15 * 60 * 1000;
const MIN_PASSWORD = 6; // same as the app (validateSignup) - raise both together

const apiLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const pwLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
router.use(["/login/api", "/signup/api", "/forgot/api"], apiLimit);
router.use(["/login/api/password", "/login/api/code/verify", "/signup/api/verify", "/forgot/api/username/verify", "/login/api/phone/verify"], pwLimit);

// ── helpers ──────────────────────────────────────────────────────────────────
function safeNext(v) {
  if (!v || typeof v !== "string") return null;
  let d; try { d = decodeURIComponent(v).trim(); } catch { return null; }
  if (!d.startsWith("/") || d.startsWith("//") || d.length > 2048) return null;
  if (/^\/(auth|login|signup|forgot|logout)\b/.test(d)) return null;
  return d;
}
const safeAs = (v) => (PERSONAS.includes(String(v)) ? String(v) : null);

function flow(req) {
  const f = req.session?.loginFlow;
  if (!f || Date.now() - f.at > FLOW_TTL) return null;
  return f;
}
function setFlow(req, data) { req.session.loginFlow = { ...(flow(req) || {}), ...data, at: Date.now() }; }

const err = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function codeFailure(res, e) {
  if (e instanceof CodeError) {
    const s = e.code === "BAD_TARGET" ? 400 : e.code === "SEND_FAILED" ? 502 : 429;
    return err(res, s, e.message, e.retryAfter ? { retryAfter: e.retryAfter } : {});
  }
  console.error("[login] code error:", e);
  return err(res, 500, "We couldn't send a code. Please try again.");
}

/** Options from several matched accounts, de-duplicated (shared phone/email). */
function optionsFor(users) {
  const seen = new Map();
  for (const u of users) for (const o of contactOptions(u)) if (!seen.has(o.target)) seen.set(o.target, o);
  return [...seen.values()];
}

async function finishLogin(req, res, user, { via } = {}) {
  const f = flow(req) || {};
  user.lastLogin = new Date();
  await user.save();
  const fresh = await User.findById(user._id).lean();
  const asP = f.as && hasPersona(fresh, f.as) ? f.as : null;
  const redirect = f.next || await landingFor(fresh, asP);
  const isChild = fresh.role === "student" && !!fresh.parentUserId;
  const payload = {
    redirect,
    username: fresh.username || null,
    needsPassword: !fresh.passwordHash,
    mustSetPassword: f.purpose === "reset_password",
    offerPhone: !fresh.phone && !isChild && via !== "phone"
  };
  return new Promise((resolve) => {
    req.login(user, (e) => {
      if (e) { console.error("[login] req.login", e); resolve(err(res, 500, "Login failed")); return; }
      resolve(res.json(payload));
    });
  });
}

// ── pages ────────────────────────────────────────────────────────────────────
async function renderPage(req, res, mode) {
  const as = safeAs(req.query.as);
  const next = safeNext(req.query.next || req.query.returnTo);
  if (req.user && mode !== "forgot") return res.redirect(next || await landingFor(req.user, as));
  // Remember the context for the JSON steps.
  req.session.loginFlow = { as, next, at: Date.now() };
  const googleUrl = as === "parent" ? "/auth/parent?google=1"
    : as === "teacher" ? "/auth/teacher?google=1"
    : "/auth/google" + (next ? `?returnTo=${encodeURIComponent(next)}` : "");
  const grades = Array.from({ length: 14 }, (_, g) => ({ value: g, label: gradeLabel(g) }));
  return res.render("auth/login", {
    layout: false, mode, as: as || "", next: next || "", googleUrl, grades,
    what: req.query.what === "username" ? "username" : "password",
    asLabel: { student: "Student", parent: "Parent", teacher: "Teacher", professional: "Professional" }[as] || ""
  });
}
router.get("/login", (req, res) => renderPage(req, res, "login"));
router.get("/signup", (req, res) => renderPage(req, res, "signup"));
router.get("/forgot", (req, res) => renderPage(req, res, "forgot"));

// ── sign in ──────────────────────────────────────────────────────────────────
router.post("/login/api/identify", async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim();
    if (!identifier) return err(res, 400, "Enter your email, phone number or username.");
    const users = await findAllByIdentifier(identifier);
    if (!users.length) {
      return err(res, 404, "We couldn't find an account with those details.", { canSignup: true });
    }
    const options = optionsFor(users);
    const hasPassword = users.some((u) => !!u.passwordHash);
    const managed = users.every((u) => u.role === "student" && u.parentUserId) && !options.length;
    let helper = null;
    if (managed) {
      const p = await User.findById(users[0].parentUserId).select("displayName firstName lastName role").lean();
      helper = p ? `${displayNameOf(p)} (${p.role === "private_teacher" ? "your teacher" : "your parent"})` : "your parent or teacher";
    }
    setFlow(req, { ids: users.map((u) => String(u._id)), options, verifiedIds: null, purpose: "signin" });
    return res.json({
      name: users.length === 1 ? (users[0].firstName || displayNameOf(users[0])) : null,
      multiple: users.length > 1,
      hasPassword,
      options: options.map((o, i) => ({ index: i, channel: o.channel, label: o.label })),
      managed, helper,
      hasGoogle: users.some((u) => !!u.googleId)
    });
  } catch (e) { console.error("[login/identify]", e); return err(res, 500, "Something went wrong."); }
});

router.post("/login/api/password", async (req, res) => {
  try {
    const f = flow(req);
    if (!f?.ids?.length) return err(res, 440, "Your session timed out. Start again.");
    const password = String(req.body?.password || "");
    if (!password) return err(res, 400, "Enter your password.");
    const users = await User.find({ _id: { $in: f.ids } });
    for (const u of users) {
      if (u.passwordHash && await u.verifyPassword(password)) return finishLogin(req, res, u, { via: "password" });
    }
    if (!users.some((u) => u.passwordHash)) return err(res, 400, "This account has no password yet. Get a code instead.");
    return err(res, 401, "That password is not right.");
  } catch (e) { console.error("[login/password]", e); return err(res, 500, "Login failed."); }
});

router.post("/login/api/code/send", async (req, res) => {
  try {
    const f = flow(req);
    if (!f?.options?.length) return err(res, 440, "Your session timed out. Start again.");
    const o = f.options[Number(req.body?.option) || 0];
    if (!o) return err(res, 400, "Choose where to send the code.");
    const purpose = req.body?.purpose === "reset_password" ? "reset_password" : "signin";
    const out = await issueCode({ channel: o.channel, target: o.target, purpose });
    setFlow(req, { codeTarget: o.target, codeChannel: o.channel, purpose });
    return res.json({ ok: true, sentTo: o.label, ...(out.devCode ? { devCode: out.devCode } : {}) });
  } catch (e) { return codeFailure(res, e); }
});

router.post("/login/api/code/verify", async (req, res) => {
  try {
    const f = flow(req);
    if (!f?.codeTarget) return err(res, 440, "Your session timed out. Start again.");
    const r = await verifyCode({ channel: f.codeChannel, target: f.codeTarget, purpose: f.purpose || "signin", code: req.body?.code });
    if (!r.ok) return err(res, 400, codeErrorMessage(r));

    // Accounts from this sign-in that own the contact the code went to.
    const isEmail = f.codeChannel === "email";
    const users = (await User.find({ _id: { $in: f.ids } }))
      .filter((u) => isEmail ? String(u.email || "").toLowerCase() === f.codeTarget : u.phone === f.codeTarget);
    if (!users.length) return err(res, 400, "Your session timed out. Start again.");
    for (const u of users) {               // they proved they own it
      if (isEmail) u.emailVerified = true; else u.phoneVerified = true;
      await u.save();
    }
    if (users.length === 1) return finishLogin(req, res, users[0], { via: isEmail ? "email" : "phone" });
    setFlow(req, { verifiedIds: users.map((u) => String(u._id)) });
    return res.json({ chooseAccount: users.map(describeAccount) });
  } catch (e) { console.error("[login/code/verify]", e); return err(res, 500, "Could not check the code."); }
});

router.post("/login/api/choose", async (req, res) => {
  try {
    const f = flow(req);
    const id = String(req.body?.id || "");
    if (!f?.verifiedIds?.includes(id)) return err(res, 403, "Verify your phone or email first.");
    const user = await User.findById(id);
    if (!user) return err(res, 404, "Account not found.");
    return finishLogin(req, res, user, { via: f.codeChannel === "email" ? "email" : "phone" });
  } catch (e) { console.error("[login/choose]", e); return err(res, 500, "Login failed."); }
});

// ── signed-in follow-ups: password + WhatsApp number ─────────────────────────
function needUser(req, res, next) { return req.user ? next() : err(res, 401, "Please sign in first."); }

router.post("/login/api/set-password", needUser, async (req, res) => {
  try {
    const a = String(req.body?.password || "");
    if (a.length < MIN_PASSWORD) return err(res, 400, `Use at least ${MIN_PASSWORD} characters.`);
    const user = await User.findById(req.user._id);
    await user.setPassword(a); await user.save();
    return res.json({ ok: true });
  } catch (e) { console.error("[login/set-password]", e); return err(res, 500, "Could not save your password."); }
});

router.post("/login/api/phone/send", needUser, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return err(res, 400, "Enter a valid phone number, e.g. 0771 234 567 or +44 7700 900123.");
    const taken = await User.exists({ phone, _id: { $ne: req.user._id } });
    if (taken) return err(res, 409, "That number is already linked to another account.");
    const out = await issueCode({ channel: "whatsapp", target: phone, purpose: "verify_phone", userId: req.user._id });
    req.session.pendingPhone = { phone, at: Date.now() };
    return res.json({ ok: true, sentTo: `WhatsApp ${maskPhone(phone)}`, ...(out.devCode ? { devCode: out.devCode } : {}) });
  } catch (e) { return codeFailure(res, e); }
});

router.post("/login/api/phone/verify", needUser, async (req, res) => {
  try {
    const p = req.session?.pendingPhone;
    if (!p || Date.now() - p.at > FLOW_TTL) return err(res, 440, "Start again.");
    const r = await verifyCode({ channel: "whatsapp", target: p.phone, purpose: "verify_phone", code: req.body?.code });
    if (!r.ok) return err(res, 400, codeErrorMessage(r));
    const taken = await User.exists({ phone: p.phone, _id: { $ne: req.user._id } });
    if (taken) return err(res, 409, "That number is already linked to another account.");
    await User.updateOne({ _id: req.user._id }, { $set: { phone: p.phone, phoneVerified: true } });
    delete req.session.pendingPhone;
    return res.json({ ok: true });
  } catch (e) { console.error("[login/phone/verify]", e); return err(res, 500, "Could not save your number."); }
});

// ── sign up ──────────────────────────────────────────────────────────────────
router.post("/signup/api/start", async (req, res) => {
  try {
    const persona = String(req.body?.persona || "");
    const firstName = String(req.body?.firstName || "").trim().slice(0, 60);
    const lastName = String(req.body?.lastName || "").trim().slice(0, 60);
    const password = String(req.body?.password || "");
    const contact = String(req.body?.contact || "").trim();
    const gradeRaw = req.body?.grade;

    if (!SIGNUP_ROLES[persona]) return err(res, 400, "Choose Student, Parent, Private teacher or Professional.");
    if (!firstName) return err(res, 400, "Enter your first name.");
    if (password.length < MIN_PASSWORD) return err(res, 400, `Use a password of at least ${MIN_PASSWORD} characters.`);
    let grade = null;
    if (persona === "student") {
      grade = Number(gradeRaw);
      if (gradeRaw === "" || gradeRaw == null || !Number.isInteger(grade) || grade < 0 || grade > 13) return err(res, 400, "Choose your grade.");
    }
    const email = normalizeEmail(contact);
    const phone = email ? null : normalizePhone(contact);
    if (!email && !phone) return err(res, 400, "Enter a valid phone number or email address.");

    // One person, one account: an email or phone can only open ONE adult account.
    const clash = await User.findOne(email ? { email } : { phone }).select("_id").lean();
    if (clash) return err(res, 409, "There's already an account with that " + (email ? "email" : "number") + ". Sign in instead.", { signIn: true });

    const passwordHash = await bcrypt.hash(password, 10); // never keep the plain password
    const out = await issueCode({
      channel: email ? "email" : "whatsapp", target: email || phone, purpose: "signup",
      pending: { persona, firstName, lastName, passwordHash, grade }
    });
    req.session.signupFlow = { target: email || phone, channel: email ? "email" : "whatsapp", at: Date.now(), next: flow(req)?.next || null };
    return res.json({ ok: true, sentTo: email ? `Email ${maskEmail(email)}` : `WhatsApp ${maskPhone(phone)}`, ...(out.devCode ? { devCode: out.devCode } : {}) });
  } catch (e) { return codeFailure(res, e); }
});

router.post("/signup/api/verify", async (req, res) => {
  try {
    const s = req.session?.signupFlow;
    if (!s || Date.now() - s.at > FLOW_TTL) return err(res, 440, "Your sign-up timed out. Start again.");
    const r = await verifyCode({ channel: s.channel, target: s.target, purpose: "signup", code: req.body?.code });
    if (!r.ok) return err(res, 400, codeErrorMessage(r));
    const p = r.record.pending || {};
    const isEmail = s.channel === "email";
    const clash = await User.findOne(isEmail ? { email: s.target } : { phone: s.target }).select("_id").lean();
    if (clash) return err(res, 409, "That " + (isEmail ? "email" : "number") + " is now in use. Sign in instead.", { signIn: true });

    const user = await createAccount({
      persona: p.persona, firstName: p.firstName, lastName: p.lastName, passwordHash: p.passwordHash,
      grade: p.grade, ...(isEmail ? { email: s.target } : { phone: s.target }), verified: isEmail ? "email" : "phone"
    });
    delete req.session.signupFlow;
    setFlow(req, { next: s.next, purpose: "signup" });
    return finishLogin(req, res, user, { via: isEmail ? "email" : "phone" });
  } catch (e) { console.error("[signup/verify]", e); return err(res, 500, "Could not create your account. Try again."); }
});

// ── forgot username ──────────────────────────────────────────────────────────
// Prove you own the phone/email first, THEN we show the usernames on screen.
// (A WhatsApp authentication template can't carry usernames, and showing them
// only after verification keeps them private.)
router.post("/forgot/api/username/send", async (req, res) => {
  try {
    const contact = String(req.body?.contact || "").trim();
    const email = normalizeEmail(contact);
    const phone = email ? null : normalizePhone(contact);
    if (!email && !phone) return err(res, 400, "Enter the phone number or email on your account.");
    const { owners } = await accountsForContact(email || phone);
    if (!owners.length) return err(res, 404, "No account uses that " + (email ? "email." : "number."));
    const out = await issueCode({ channel: email ? "email" : "whatsapp", target: email || phone, purpose: "signin" });
    setFlow(req, { usernameTarget: email || phone, usernameChannel: email ? "email" : "whatsapp" });
    return res.json({ ok: true, sentTo: email ? `Email ${maskEmail(email)}` : `WhatsApp ${maskPhone(phone)}`, ...(out.devCode ? { devCode: out.devCode } : {}) });
  } catch (e) { return codeFailure(res, e); }
});

router.post("/forgot/api/username/verify", async (req, res) => {
  try {
    const f = flow(req);
    if (!f?.usernameTarget) return err(res, 440, "Your session timed out. Start again.");
    const r = await verifyCode({ channel: f.usernameChannel, target: f.usernameTarget, purpose: "signin", code: req.body?.code });
    if (!r.ok) return err(res, 400, codeErrorMessage(r));
    const { owners, children } = await accountsForContact(f.usernameTarget);
    for (const u of owners) { if (f.usernameChannel === "email") u.emailVerified = true; else u.phoneVerified = true; await u.save(); }
    const all = [...owners, ...children];
    setFlow(req, { verifiedIds: all.map((u) => String(u._id)), codeChannel: f.usernameChannel, purpose: "signin" });
    return res.json({
      accounts: owners.map(describeAccount),
      children: children.map((c) => ({ ...describeAccount(c), managedBy: displayNameOf(owners.find((o) => String(o._id) === String(c.parentUserId))) }))
    });
  } catch (e) { console.error("[forgot/username/verify]", e); return err(res, 500, "Could not check the code."); }
});

export default router;
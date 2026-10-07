// services/identity.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE identity service for the website AND the mobile app.
// Web routes (sessions) and mobile routes (JWT) both call these functions, so the
// two platforms can never drift apart again.
//
//   Identifiers ....... findByIdentifier, normalizePhone, normalizeEmail
//   Codes ............. issueCode, verifyCode   (WhatsApp / email; hashed, limited)
//   Contact options ... contactOptions, maskEmail, maskPhone
//   Roles (personas) .. personasFor, activePersona, hasPersona,
//                       enablePersona, setActivePersona
//   Landing ........... landingFor     (the ONE "where do I go after login" rule)
//   Admin ............. isPlatformAdmin (verified email required)
//
// Nothing here ever changes `user.role`. `role` only records how the account was
// first created; what a person can DO is their list of personas.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import MobileVerification from "../models/mobileVerification.js";
import { sendVerificationCode } from "./mobileMailer.js";

export const PERSONAS = ["student", "parent", "teacher", "professional"];
const HOME_SLUG = "cripfcnt-home";
const SCHOOL_SLUG = "cripfcnt-school";

// ── Identifiers ──────────────────────────────────────────────────────────────
export function normalizeEmail(v) {
  const e = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Normalise a phone number to E.164 ("+263775110288").
 * Accepts +263..., 00263..., 263..., and local formats:
 *   Zimbabwe 07XXXXXXXX (10 digits) / 7XXXXXXXX (9 digits) → +263
 *   UK       07XXXXXXXXX (11 digits)                       → +44
 * Returns null when it can't be a phone number.
 */
export function normalizePhone(v) {
  let s = String(v || "").trim();
  if (!s) return null;
  if (!/^[+\d][\d\s\-().]*$/.test(s)) return null;
  const plus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  if (!plus && d.startsWith("00")) d = d.slice(2);
  else if (!plus && d.startsWith("0")) {
    if (d.length === 10) d = "263" + d.slice(1);          // ZW 07XXXXXXXX
    else if (d.length === 11) d = "44" + d.slice(1);      // UK 07XXXXXXXXX
    else return null;
  } else if (!plus && d.length === 9 && /^7/.test(d)) d = "263" + d; // ZW 7XXXXXXXX
  if (d.length < 8 || d.length > 15) return null;
  return "+" + d;
}

/** WhatsApp Cloud API wants digits only, no "+". */
export const waId = (phone) => String(phone || "").replace(/\D/g, "");

/**
 * Find ONE account by anything a person might type: email, phone, username,
 * studentId, teacherId or adminId. Returns a full (non-lean) document so the
 * caller can verifyPassword()/save(), or null.
 */
export async function findByIdentifier(raw) {
  const input = String(raw || "").trim();
  if (!input) return null;
  const lower = input.toLowerCase();
  const or = [{ username: lower }, { studentId: input }, { teacherId: input }, { adminId: input }];
  const email = normalizeEmail(input);
  if (email) or.push({ email });
  const phone = !email ? normalizePhone(input) : null;
  if (phone) or.push({ phone });
  return User.findOne({ $or: or });
}

// ── Masking (show where a code will go without revealing it) ─────────────────
export function maskEmail(e) {
  const [u, d] = String(e || "").split("@");
  if (!u || !d) return "";
  return `${u[0]}${"•".repeat(Math.max(2, Math.min(5, u.length - 1)))}@${d}`;
}
export function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length < 7) return "";
  const cc = d.startsWith("263") ? "263" : d.startsWith("44") ? "44" : d.slice(0, d.length - 9);
  const rest = d.slice(cc.length);
  return `+${cc} ${rest.slice(0, 2)} ••• ${rest.slice(-3)}`;
}

/** Where can we send this account a code? [{channel, target, label}] */
export function contactOptions(user) {
  const out = [];
  if (user?.phone) out.push({ channel: "whatsapp", target: user.phone, label: `WhatsApp ${maskPhone(user.phone)}` });
  if (user?.email && normalizeEmail(user.email)) out.push({ channel: "email", target: user.email.toLowerCase(), label: `Email ${maskEmail(user.email)}` });
  return out;
}

// ── One-time codes ───────────────────────────────────────────────────────────
const COOLDOWN_MS = 60 * 1000;        // one code per target per minute
const WINDOW_MS = 60 * 60 * 1000;     // ...and at most MAX_PER_WINDOW per hour
const MAX_PER_WINDOW = 6;
const MAX_ATTEMPTS = 5;               // wrong tries before a code is burned
const sendLog = new Map();            // target → [timestamps]  (single PM2 process)

function codeReason(purpose) {
  return {
    signin: "sign in", reset_password: "reset your password", set_password: "set your password",
    signup: "confirm your account", verify_phone: "confirm your phone number", verify_email: "confirm your email"
  }[purpose] || "verify your account";
}

export class CodeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * Create + send a 6-digit code. Older unused codes for the same target+purpose
 * are invalidated, so only the newest one works.
 * @returns {{ delivered: boolean, channel, devCode?: string }}
 * @throws  CodeError("COOLDOWN" | "RATE_LIMITED" | "BAD_TARGET" | "SEND_FAILED")
 */
export async function issueCode({ channel, target, purpose, userId = null, pending = null }) {
  const ch = channel === "whatsapp" ? "whatsapp" : "email";
  const tgt = ch === "email" ? normalizeEmail(target) : normalizePhone(target);
  if (!tgt) throw new CodeError("BAD_TARGET", ch === "email" ? "Enter a valid email address." : "Enter a valid phone number.");

  const now = Date.now();
  const recent = (sendLog.get(tgt) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length && now - recent[recent.length - 1] < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - (now - recent[recent.length - 1])) / 1000);
    throw new CodeError("COOLDOWN", `Please wait ${retryAfter}s before asking for another code.`, { retryAfter });
  }
  if (recent.length >= MAX_PER_WINDOW) throw new CodeError("RATE_LIMITED", "Too many codes requested. Try again in an hour.");

  const code = MobileVerification.generateCode();
  await MobileVerification.deleteMany({ target: tgt, purpose, consumed: false });
  const rec = await MobileVerification.create({
    target: tgt, channel: ch, purpose, userId, pending,
    ...(ch === "email" ? { email: tgt } : {}),
    codeHash: MobileVerification.hashCode(code)
  });

  let delivered = false;
  try {
    if (ch === "whatsapp") {
      const { sendAuthCode } = await import("./cripfcntWhatsApp.js");
      await sendAuthCode(waId(tgt), code);
      delivered = true;
    } else {
      delivered = await sendVerificationCode(tgt, code, codeReason(purpose));
    }
  } catch (e) {
    console.error(`[identity] ${ch} code send failed:`, e.response?.data?.error?.message || e.message);
  }

  const devCode = process.env.AUTH_DEBUG_CODES === "1" && process.env.NODE_ENV !== "production" ? code : undefined;
  if (!delivered && !devCode) {
    await MobileVerification.deleteOne({ _id: rec._id }).catch(() => {});
    throw new CodeError("SEND_FAILED", ch === "whatsapp"
      ? "We couldn't send a WhatsApp code right now. Try email instead."
      : "We couldn't send the email right now. Please try again shortly.");
  }
  recent.push(now); sendLog.set(tgt, recent);
  return { delivered, channel: ch, ...(devCode ? { devCode } : {}) };
}

/**
 * Check a code. Wrong guesses count; after MAX_ATTEMPTS the code is burned.
 * @returns {{ ok: true, record } | { ok: false, reason: "expired"|"wrong"|"too_many", remaining? }}
 */
export async function verifyCode({ target, purpose, code, channel }) {
  const isEmail = channel === "email" || (!channel && String(target || "").includes("@"));
  const tgt = isEmail ? normalizeEmail(target) : normalizePhone(target);
  if (!tgt) return { ok: false, reason: "expired" };

  const rec = await MobileVerification.findOne({ target: tgt, purpose, consumed: false }).sort({ createdAt: -1 });
  if (!rec) return { ok: false, reason: "expired" };
  if (rec.attempts >= MAX_ATTEMPTS) { await rec.deleteOne(); return { ok: false, reason: "too_many" }; }

  const given = Buffer.from(MobileVerification.hashCode(String(code || "").trim()));
  const want = Buffer.from(rec.codeHash);
  const match = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!match) {
    rec.attempts += 1;
    if (rec.attempts >= MAX_ATTEMPTS) { await rec.deleteOne(); return { ok: false, reason: "too_many" }; }
    await rec.save();
    return { ok: false, reason: "wrong", remaining: MAX_ATTEMPTS - rec.attempts };
  }
  rec.consumed = true;
  await rec.save();
  return { ok: true, record: rec };
}

export function codeErrorMessage(r) {
  if (r.reason === "too_many") return "Too many wrong tries. Request a new code.";
  if (r.reason === "wrong") return `That code is not right. ${r.remaining} ${r.remaining === 1 ? "try" : "tries"} left.`;
  return "Your code has expired. Request a new one.";
}

// ── Personas (roles you can switch between) ──────────────────────────────────
// IDENTICAL rules to routes/mobileApi.js so web and app always agree.
export function personasFor(u) {
  if (!u) return [];
  const set = new Set();
  const r = u.role;
  if (r === "parent" || r === "guardian") set.add("parent");
  else if (r === "private_teacher" || r === "teacher") set.add("teacher");
  else if (r === "student") set.add("student");
  else set.add("professional"); // employee / *_admin
  if (u.subscriptionStatus === "paid" || (u.subscriptionPlan && u.subscriptionPlan !== "none")) set.add("parent");
  if (u.teacherSubscriptionStatus === "paid" || (u.teacherSubscriptionPlan && u.teacherSubscriptionPlan !== "none")) set.add("teacher");
  if (u.employeeSubscriptionStatus === "paid" || (u.employeeSubscriptionPlan && u.employeeSubscriptionPlan !== "none")) set.add("professional");
  for (const p of (u.mobileRoles || [])) if (p) set.add(p);
  return [...set];
}

export function primaryPersona(u) {
  return personasFor({ role: u?.role })[0] || "parent";
}

export function activePersona(u) {
  const list = personasFor(u);
  return u?.activeMobileRole && list.includes(u.activeMobileRole) ? u.activeMobileRole : primaryPersona(u);
}

export const hasPersona = (u, p) => personasFor(u).includes(p);

/**
 * Add a persona to an account (or just switch to it if it's already there).
 * Mirrors POST /api/mobile/roles/enable exactly. NEVER changes `role`.
 * Students can't add adult personas - a managed child stays a child.
 */
export async function enablePersona(userId, persona) {
  if (!PERSONAS.includes(persona)) throw new Error("Unknown account type");
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if ((user.role === "student" || user.parentUserId) && persona !== "student") {
    throw new Error("Student accounts can't add other account types.");
  }

  if (persona === "professional") {
    if (!user.employeeSubscriptionStatus) user.employeeSubscriptionStatus = "trial";
    if (!user.employeeSubscriptionPlan) user.employeeSubscriptionPlan = "none";
  } else if (persona === "parent") {
    user.consumerEnabled = true;
    if (!user.accountType) user.accountType = "parent";
  } else if (persona === "teacher") {
    user.consumerEnabled = true;
    if (!user.teacherSubscriptionStatus) user.teacherSubscriptionStatus = "trial";
    if (!user.teacherSubscriptionPlan) user.teacherSubscriptionPlan = "none";
  }
  const set = new Set(Array.isArray(user.mobileRoles) ? user.mobileRoles : []);
  if (persona !== primaryPersona(user)) set.add(persona);
  user.mobileRoles = [...set];
  user.activeMobileRole = persona;
  await user.save();

  // Best-effort org context, same as the app. Never blocks enabling the role.
  try {
    const slug = persona === "professional" || persona === "student" ? SCHOOL_SLUG : HOME_SLUG;
    const mRole = { professional: "employee", teacher: "private_teacher", student: "student", parent: "parent" }[persona];
    const org = await Organization.findOne({ slug }).lean();
    if (org) {
      await OrgMembership.updateOne(
        { org: org._id, user: user._id },
        { $setOnInsert: { org: org._id, user: user._id, role: mRole, joinedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (e) { console.warn("[identity] persona enrolment skipped:", e.message); }

  return user;
}

/** Switch to a persona the account already has. Returns false if it doesn't. */
export async function setActivePersona(userId, persona) {
  const user = await User.findById(userId);
  if (!user || !hasPersona(user, persona)) return false;
  user.activeMobileRole = persona;
  await user.save();
  return true;
}

// ── Landing: the ONE "where does this person go" rule ────────────────────────
export async function landingFor(user, persona) {
  if (!user) return "/";
  if (user.role === "student" || user.parentUserId) return "/student/dashboard";
  const p = persona && hasPersona(user, persona) ? persona : activePersona(user);

  if (p === "teacher") {
    const t = await User.findById(user._id).select("needsProfileSetup schoolLevelsEnabled").lean();
    return (t?.needsProfileSetup || !t?.schoolLevelsEnabled?.length) ? "/teacher/setup" : "/teacher/dashboard";
  }
  if (p === "parent") return "/parent/dashboard";
  if (p === "student") return "/student/dashboard";

  // professional / school staff → their organisation (never the home-learning org)
  const ms = await OrgMembership.find({ user: user._id }).populate("org", "slug").lean();
  const orgs = ms.map((m) => m.org?.slug).filter((s) => s && s !== HOME_SLUG);
  const slug = orgs.find((s) => s !== SCHOOL_SLUG) || (orgs.includes(SCHOOL_SLUG) ? SCHOOL_SLUG : null);
  if (slug) return `/org/${slug}/dashboard`;
  return `/org/${SCHOOL_SLUG}/dashboard`;
}

// ── Platform admin: listed in ADMIN_EMAILS *and* the email is proven ─────────
// (Google sign-ins count as proven.) Wired into the admin guards in Phase 2,
// before self-service sign-up goes live.
export function isPlatformAdmin(user) {
  const list = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(user?.email || "").toLowerCase();
  if (!email || !list.includes(email)) return false;
  return !!(user.emailVerified || user.googleId);
}
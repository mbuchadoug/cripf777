// ==============================
// 🔐 HOTSPOT AUTH
// Self-contained JWT auth so this module never touches your main login.
// The admin UI stores the token in localStorage and sends it as
//   Authorization: Bearer <token>
// ==============================

import jwt from "jsonwebtoken";
import HotspotAdmin from "../models/hotspotAdmin.js";

const SECRET = process.env.HOTSPOT_JWT_SECRET || "change-this-hotspot-secret";
const TTL = "12h";

export function signToken(admin) {
  return jwt.sign(
    { id: String(admin._id), role: admin.role, name: admin.displayName },
    SECRET,
    { expiresIn: TTL }
  );
}

function readToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

// Any logged-in admin.
export async function authRequired(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const payload = jwt.verify(token, SECRET);
    const admin = await HotspotAdmin.findById(payload.id);
    if (!admin || !admin.active) return res.status(401).json({ error: "Account inactive" });
    req.hsAdmin = admin;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired, sign in again" });
  }
}

// Owner-only actions (managing admins & plans).
export function ownerRequired(req, res, next) {
  if (req.hsAdmin?.role !== "owner") {
    return res.status(403).json({ error: "Only the owner can do that" });
  }
  next();
}
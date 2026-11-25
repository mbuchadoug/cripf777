// routes/cripfcnt_whatsapp.js
// ─────────────────────────────────────────────────────────────────────────────
// Webhook for the CRIPFCnt Resources Limited WhatsApp bot. Runs on the same
// server as the ZimQuote bot (/meta/whatsapp) but on its OWN path, with its own
// verify token, app secret and sender - the two bots never touch each other.
//
// Mount in server.js BEFORE the global express.json() middleware (next to the
// Stripe webhook), because signature checking needs the raw body:
//   import cripfcntWhatsAppRoutes from "./routes/cripfcnt_whatsapp.js";
//   app.use("/wa/cripfcnt", cripfcntWhatsAppRoutes);
//
// Meta callback URL:  https://cripfcnt.com/wa/cripfcnt/webhook
//
// .env:
//   CRIPFCNT_WA_VERIFY_TOKEN=   any long random string (same value in Meta)
//   CRIPFCNT_APP_SECRET=        App settings → Basic → App secret (CRIPFCnt app)
//   CRIPFCNT_SITE_URL=https://cripfcnt.com
//   (+ the sender vars in services/cripfcntWhatsApp.js)
//
// TEMPORARY - Fresh Kombucha Zimbabwe shares this number until it has its own
// line. Messages from registered Fresh Kombucha staff (or starting with "FK",
// e.g. a scanned pallet QR) are relayed to niyonsoft.org, which replies
// directly. Everyone else gets the normal CRIPFCnt menu.
//   FK_RELAY_URL=https://niyonsoft.org/fk/wa/relay
//   FK_RELAY_SECRET=   same long random string as on niyonsoft.org
// To switch off (new line live): delete FK_RELAY_URL and restart.
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import crypto from "crypto";
import { sendText, sendList, sendButtons, markRead } from "../services/cripfcntWhatsApp.js";

const router = express.Router();

// ── Fresh Kombucha relay (temporary shared number) ───────────────────────────
const fkNo = new Map();   // phone → time we learnt they are NOT FK staff
const fkYes = new Map();  // phone → time we learnt they ARE FK staff
const FK_TTL = 10 * 60 * 1000;
const fresh = (m, k) => { const t = m.get(k); return t && Date.now() - t < FK_TTL; };
function fkForced(msg) {
  const t = msg.type === "text" ? (msg.text?.body || "") : msg.type === "button" ? (msg.button?.text || "") : "";
  const id = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
  if (id && CRIPFCNT_IDS.has(id.toLowerCase())) return false;     // our own menu buttons stay here
  return /^\s*(fk|kombucha)\b/i.test(t) || /\b[PR]-[2-9A-Z]{5}\b/i.test(t);
}
// Returns true when niyonsoft.org took the message.
async function relayToFK(msg, name) {
  const url = process.env.FK_RELAY_URL, secret = process.env.FK_RELAY_SECRET;
  if (!url || !secret) return false;
  const id = (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "").toLowerCase();
  if (id && CRIPFCNT_IDS.has(id)) return false;
  const forced = fkForced(msg);
  if (!forced && fresh(fkNo, msg.from)) return false;
  const body = JSON.stringify({ message: msg, contactName: name });
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-FK-Signature": sig }, body, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (j.handled) { fkYes.set(msg.from, Date.now()); fkNo.delete(msg.from); return true; }
    if (r.ok) fkNo.set(msg.from, Date.now());
    return false;
  } catch (e) {
    console.warn("[CRIPFCnt WA] FK relay failed:", e.message);
    if (forced || fresh(fkYes, msg.from)) {          // a Fresh Kombucha user - don't show them the CRIPFCnt menu
      await sendText(msg.from, "⚠️ The Fresh Kombucha system is not reachable right now. Please try again in a few minutes.").catch(() => {});
      return true;
    }
    return false;
  } finally { clearTimeout(timer); }
}
const CRIPFCNT_IDS = new Set(["m_join", "m_login", "m_learn", "m_teach", "m_pro", "m_plans", "m_app", "m_human"]);
const SITE = () => (process.env.CRIPFCNT_SITE_URL || "https://cripfcnt.com").replace(/\/$/, "");

// ── 1) Verification handshake ────────────────────────────────────────────────
router.get("/webhook", (req, res) => {
  const ok = req.query["hub.mode"] === "subscribe" &&
             req.query["hub.verify_token"] === process.env.CRIPFCNT_WA_VERIFY_TOKEN;
  return ok ? res.status(200).send(req.query["hub.challenge"]) : res.sendStatus(403);
});

// ── Signature check (X-Hub-Signature-256 = HMAC-SHA256 of raw body) ───────────
function validSignature(raw, header) {
  const secret = process.env.CRIPFCNT_APP_SECRET;
  if (!secret) { console.warn("[CRIPFCnt WA] CRIPFCNT_APP_SECRET not set - skipping signature check"); return true; }
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Meta retries deliveries - ignore message IDs we've already handled (10 min).
const seen = new Map();
function alreadySeen(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// ── 2) Incoming events ───────────────────────────────────────────────────────
// Logging: one summary line per webhook call. Set CRIPFCNT_WA_DEBUG=1 in .env to
// also dump the raw payload (turn it off again once things work).
router.post("/webhook", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const sigOk = validSignature(raw, req.get("x-hub-signature-256"));
  console.log(`[CRIPFCnt WA] webhook POST ${raw.length}b bodyType=${Buffer.isBuffer(req.body) ? "raw" : typeof req.body} sig=${sigOk ? "ok" : "BAD"}`);
  if (!sigOk) return res.sendStatus(401);
  res.sendStatus(200); // always ACK fast; work happens after

  try {
    let body;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch (e) { console.warn("[CRIPFCnt WA] body is not JSON:", raw.toString("utf8").slice(0, 200)); return; }
    if (process.env.CRIPFCNT_WA_DEBUG === "1") console.log("[CRIPFCnt WA] payload", JSON.stringify(body).slice(0, 3000));

    const want = String(process.env.CRIPFCNT_WA_PHONE_NUMBER_ID || "").trim();

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const pid = String(value.metadata?.phone_number_id || "").trim();
        const msgs = value.messages || [];
        const statuses = value.statuses || [];
        console.log(`[CRIPFCnt WA] field=${change.field} pid=${pid || "-"} want=${want || "(unset)"} msgs=${msgs.length} statuses=${statuses.length}`);

        // Safety: only handle events for the CRIPFCnt number.
        if (want && pid && pid !== want) { console.warn("[CRIPFCnt WA] skipped: phone_number_id mismatch"); continue; }

        for (const msg of msgs) {
          if (!msg.id || alreadySeen(msg.id)) { console.log("[CRIPFCnt WA] duplicate ignored", msg.id); continue; }
          const name = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name || "";
          console.log(`[CRIPFCnt WA] in from=${msg.from} type=${msg.type} action="${actionOf(msg)}"`);
          if (await relayToFK(msg, name)) { console.log(`[CRIPFCnt WA] relayed to Fresh Kombucha: ${msg.from}`); continue; }
          handleMessage(msg, name)
            .then(() => console.log(`[CRIPFCnt WA] replied to ${msg.from}`))
            .catch((e) => console.error("[CRIPFCnt WA handle]", e.response?.data?.error ? JSON.stringify(e.response.data.error) : e.stack || e.message));
        }
        for (const st of statuses) {
          if (st.status === "failed") console.warn("[CRIPFCnt WA status failed]", st.recipient_id, JSON.stringify(st.errors || []));
        }
      }
    }
  } catch (e) {
    console.error("[CRIPFCnt WA] webhook processing error:", e.stack || e.message);
  }
});

// ── 3) Bot logic (v1: menu + links; account linking comes with central login) ─
function actionOf(msg) {
  if (msg.type === "text") return (msg.text?.body || "").trim().toLowerCase();
  if (msg.type === "interactive") return (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "").toLowerCase();
  if (msg.type === "button") return (msg.button?.payload || msg.button?.text || "").trim().toLowerCase();
  return "";
}

async function sendMainMenu(to, name) {
  const hello = name ? `Hi ${name.split(" ")[0]}! 👋` : "Hi! 👋";
  return sendList(to,
    `${hello} Welcome to *CRIPFCnt*: learning, assessments and certificates for students, parents, teachers and professionals.\n\nWhat would you like to do?`,
    "Open menu",
    [
      { id: "m_join", title: "Create an account", description: "Sign up as a student, parent, teacher or professional" },
      { id: "m_login", title: "Log in", description: "Open your account on the web or app" },
      { id: "m_learn", title: "Students & parents", description: "Quizzes, progress and knowledge maps" },
      { id: "m_teach", title: "Private teachers", description: "AI quizzes and class tracking" },
      { id: "m_pro", title: "Professionals", description: "Courses, assessments and certificates" },
      { id: "m_plans", title: "Plans & pricing", description: "See what each plan includes" },
      { id: "m_app", title: "Get the app", description: "Download CRIPFCnt for your phone" },
      { id: "m_human", title: "Talk to us", description: "Speak to the CRIPFCnt team" }
    ]);
}

async function handleMessage(msg, name) {
  const to = msg.from;
  markRead(msg.id);
  const a = actionOf(msg);

  switch (a) {
    case "m_join":
      return sendText(to, `Create your free CRIPFCnt account here:\n${SITE()}/auth/register\n\nOne account works on the website and the mobile app.`);
    case "m_login":
      return sendText(to, `Log in here:\n${SITE()}/auth/login`);
    case "m_learn":
      return sendButtons(to, "Students get grade-based quizzes and a knowledge map. Parents add their children and follow their results.", [
        { id: "m_join", title: "Sign up free" }, { id: "m_plans", title: "See plans" }, { id: "menu", title: "Main menu" }
      ]);
    case "m_teach":
      return sendButtons(to, "Private teachers generate AI quizzes, assign them to students and track class performance.", [
        { id: "m_join", title: "Sign up free" }, { id: "m_plans", title: "See plans" }, { id: "menu", title: "Main menu" }
      ]);
    case "m_pro":
      return sendButtons(to, "Professionals take courses and assessments and earn CRIPFCnt certificates.", [
        { id: "m_join", title: "Sign up free" }, { id: "m_plans", title: "See plans" }, { id: "menu", title: "Main menu" }
      ]);
    case "m_plans":
      return sendText(to, `See our plans and pricing:\n${SITE()}/pricing`);
    case "m_app":
      return sendText(to, `Get the CRIPFCnt app:\n${SITE()}/app`);
    case "m_human":
      return sendText(to, "Thanks! A member of the CRIPFCnt team will reply here shortly. Please tell us briefly what you need help with.");
    default:
      // Any greeting, unknown text, media, etc. → main menu
      return sendMainMenu(to, name);
  }
}

export default router;
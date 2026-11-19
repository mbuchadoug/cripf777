// routes/mailInbox.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote MAIL - web routes (mounted at /mail in server.js, BEFORE the body parsers)
//
// PUBLIC
//   GET  /mail                      self-service sign-up page (share this link)
//   POST /mail/start                create the inbox → status page
//   GET  /mail/s/:token             step-by-step status page (confirm WhatsApp → connect → test)
//   GET  /mail/s/:token/status      JSON for the page to refresh itself
//   POST /mail/s/:token/connect     connect with email password (auto-detects the server)
//   POST /mail/s/:token/help        "Set it up for me" → alerts the ZimQuote team
//   GET  /mail/guide/:slug          forwarding steps (Gmail / Outlook / cPanel)
//   GET  /mail/connect/:token       connect-with-password page (link sent on WhatsApp)
//   POST /mail/connect/:token
//   GET  /mail/att/:id?t=…          attachment download (signed link)
//   POST /mail/inbound?to=<rcpt>    raw email in (Cloudflare Email Worker / any relay)
//
// ADMIN (registered from routes/supplierAdmin.js, same login + layout)
//   /zq-admin/mail                  all inboxes
//   /zq-admin/mail/new              set up an inbox for a client (you type their email + password)
//   /zq-admin/mail/:id              one inbox: connect, test email, welcome, extend
// ═════════════════════════════════════════════════════════════════════════════
import express from "express";
import mongoose from "mongoose";
import MailAccount from "../models/mailAccount.js";
import MailMessage from "../models/mailMessage.js";
import {
  ingestRaw, forwardAddress, canStorePasswords, attToken, activatePaid, isActive, MAIL_CONFIG,
  createAccount, connectWithPassword, discoverServers, linkWaUrl, notifyMailAdmin,
  setupForClient, sendClientWelcome, sendTestEmail, sendSetupGuide,
  updateAccount, deleteAccount, pollCollector, collectorStatus
} from "../services/mailInbox.js";
import { sendButtons } from "../services/metaSender.js";

const router = express.Router();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SUPPORT = () => process.env.MAIL_SUPPORT_PHONE || "+263 78 990 1058";
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());
const normPhone = (raw = "") => { let p = String(raw).replace(/\D+/g, ""); if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1); return p; };
const form = express.urlencoded({ extended: false, limit: "50kb" });

// Small per-IP limit on sign-ups and password attempts
const _hits = new Map();
function limited(req, key, max) {
  const k = `${key}:${req.ip}`; const now = Date.now();
  const arr = (_hits.get(k) || []).filter(t => now - t < 3600000);
  arr.push(now); _hits.set(k, arr);
  return arr.length > max;
}

// ─── Inbound mail webhook ────────────────────────────────────────────────────
router.post("/inbound", express.raw({ type: "*/*", limit: "30mb" }), async (req, res) => {
  const secret = process.env.MAIL_INBOUND_SECRET;
  if (!secret || req.get("x-mail-secret") !== secret) return res.status(401).send("unauthorized");
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""));
    if (!raw.length) return res.status(400).send("empty");
    const r = await ingestRaw(raw, { rcpt: String(req.query.to || req.get("x-mail-to") || "") });
    res.json(r);
  } catch (e) {
    console.error("[MAIL INBOUND]", e.message);
    res.status(500).send("error");
  }
});

// ─── Page shell ──────────────────────────────────────────────────────────────
function page(title, body, { wide = false, head = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}
<style>
:root{--bg:#f3f6f4;--card:#fff;--fg:#14201a;--muted:#5b6b62;--line:#d9e2dc;--accent:#0f7a52;--accent2:#e8f4ee;--ink:#fff;--warn:#fff4e5;--wa:#1fa855}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#17201b;--fg:#e3ebe6;--muted:#93a39a;--line:#28352e;--accent:#3cc48b;--accent2:#173226;--ink:#06130d;--warn:#2b2414;--wa:#25c464}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:${wide ? 760 : 620}px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 8px;text-wrap:balance}h2{font-size:1.15rem;margin:0 0 10px}p{margin:0 0 12px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
ol{padding-left:22px;margin:0}li{margin:0 0 10px}
.addr{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--bg);border:1px dashed var(--accent);border-radius:10px;padding:12px;font:600 1rem ui-monospace,Menlo,monospace;word-break:break-all}
button,.btn{font:600 15px system-ui,sans-serif;background:var(--accent);color:var(--ink);border:0;border-radius:8px;padding:12px 18px;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}
.btn.wa{background:var(--wa);color:#fff;font-size:17px;padding:14px 22px}.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
label{display:block;font-weight:600;margin:12px 0 4px}input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
.row{display:grid;grid-template-columns:2fr 1fr;gap:10px}
.err{background:#fde8e8;color:#9b1c1c;border-radius:8px;padding:12px;margin:12px 0}.ok{background:#def7ec;color:#03543f;border-radius:8px;padding:12px;margin:12px 0}
.note{background:var(--warn);border-radius:8px;padding:12px;font-size:.93rem}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted)}
.steps{display:grid;gap:12px;margin:18px 0}.step{display:grid;grid-template-columns:34px 1fr;gap:12px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.step.done{background:var(--accent2)}.step.wait{opacity:.6}
.num{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;background:var(--line)}.step.done .num{background:var(--accent);color:var(--ink)}.step.now .num{background:var(--wa);color:#fff}
.feat{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.feat div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.bubble{background:#dcf8c6;color:#111;border-radius:10px;padding:10px 12px;font-size:.92rem;max-width:340px;box-shadow:0 1px 1px rgba(0,0,0,.12)}
@media (max-width:480px){.row{grid-template-columns:1fr}}
.brand{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--card);border-bottom:1px solid var(--line)}
.brand .logo{width:34px;height:34px;border-radius:9px;background:var(--accent);color:var(--ink);display:grid;place-items:center;font-weight:800;font-size:15px}
.brand b{font-size:1.05rem}.brand span{color:var(--muted);font-size:.9rem}
.fv{width:100%;border-collapse:collapse;margin:8px 0}.fv td{border:1px solid var(--line);padding:9px 10px;vertical-align:top}.fv td:first-child{width:42%;color:var(--muted);font-weight:600}
.fv code{font-size:1rem;font-weight:700;color:var(--fg);word-break:break-all}
</style></head><body><div class="brand"><div class="logo">ZQ</div><div><b>ZimQuote Mail</b><br><span>Your business email on WhatsApp</span></div></div><div class="wrap">${body}
<p class="muted" style="margin-top:28px;font-size:.85rem">ZimQuote Mail · help on WhatsApp: ${esc(SUPPORT())}</p></div>
<script>function cp(t,b){try{navigator.clipboard.writeText(t).then(()=>{b.textContent="Copied ✓"},()=>{})}catch(e){}}</script></body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SELF-SERVICE PORTAL
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", (req, res) => {
  const err = req.query.error ? `<div class="err">${esc(req.query.error)}</div>` : "";
  res.send(page("ZimQuote Mail", `
<h1>Your business email, on WhatsApp</h1>
<p class="muted">Every new email to your company address arrives on your WhatsApp with a short summary. Reply from WhatsApp and we send it as a proper email from your address.</p>
<div class="bubble">📧 <b>New email - needs action</b><br>From: <b>Jane Moyo</b> (Delta)<br>Subject: Purchase order 4471<br><br>📝 Wants 200 cases of water at $4.50, delivered Friday to Msasa.<br><br><span style="color:#0b7">↩️ Reply · 📄 Full email · ✅ Done</span></div>
<div class="feat">
<div><b>Works with .co.zw email</b><br><span class="muted">cPanel and local hosting, Gmail, Outlook and Microsoft 365.</span></div>
<div><b>Reply in seconds</b><br><span class="muted">Type a short note; tap ✨ Polish to turn it into a professional email.</span></div>
<div><b>Your staff too</b><br><span class="muted">Up to 3 more WhatsApp numbers get the alerts.</span></div>
<div><b>$${MAIL_CONFIG.PRICE} a year</b><br><span class="muted">${MAIL_CONFIG.TRIAL_DAYS} days free. Paid once a year by EcoCash.</span></div>
</div>
${err}
<form method="post" action="/mail/start" class="card">
<h2>Start free in 2 minutes</h2>
<label for="biz">Business name</label><input id="biz" name="biz" required placeholder="e.g. Acme Hardware">
<label for="email">Email address you want on WhatsApp</label><input id="email" name="email" type="email" required placeholder="e.g. sales@acme.co.zw" autocomplete="email">
<label for="phone">Your WhatsApp number</label><input id="phone" name="phone" inputmode="tel" required placeholder="e.g. 0772 123 456" autocomplete="tel">
<p style="margin-top:16px"><button type="submit" style="width:100%">Continue</button></p>
<p class="muted" style="font-size:.9rem;margin:0">Not good with settings? Fill this in and choose <b>"Set it up for me"</b> on the next page. Our team will do it with you.</p>
</form>`));
});

router.post("/start", form, async (req, res) => {
  try {
    if (limited(req, "start", 15)) return res.redirect("/mail?error=" + encodeURIComponent("Too many attempts. Please try again later."));
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = normPhone(req.body.phone);
    const biz = String(req.body.biz || "").trim().slice(0, 80);
    if (!isEmail(email)) return res.redirect("/mail?error=" + encodeURIComponent("Please type a valid email address."));
    if (!/^\d{11,15}$/.test(phone)) return res.redirect("/mail?error=" + encodeURIComponent("Please type your WhatsApp number, e.g. 0772 123 456."));
    if (email.endsWith("@" + MAIL_CONFIG.INBOUND_DOMAIN)) return res.redirect("/mail?error=" + encodeURIComponent("Please type your own email address."));
    const existing = await MailAccount.findOne({ ownerPhone: phone, email });
    if (existing && existing.phoneVerified !== false) {
      return res.send(page("Already connected", `<h1>${esc(email)} is already set up</h1><p>Type <b>mail</b> to ZimQuote on WhatsApp (+263 77 114 3904) to see your inbox and settings.</p><p><a class="btn wa" href="https://wa.me/263771143904?text=ZQ:MAIL">Open WhatsApp</a></p>`));
    }
    const acc = existing || await createAccount(phone, email, { businessName: biz, setupBy: "web", phoneVerified: false });
    if (!acc.webToken || (!acc.phoneVerified && !acc.linkCode)) {
      acc.webToken = acc.webToken || (await import("crypto")).randomBytes(12).toString("hex");
      if (!acc.phoneVerified) acc.linkCode = (await import("crypto")).randomBytes(3).toString("hex").toUpperCase();
      await acc.save();
    }
    res.redirect(`/mail/s/${acc.webToken}`);
  } catch (e) {
    res.redirect("/mail?error=" + encodeURIComponent(e.message || "Something went wrong"));
  }
});

const byWebToken = t => /^[a-f0-9]{24}$/.test(String(t || "")) ? MailAccount.findOne({ webToken: String(t) }) : Promise.resolve(null);
function stepOf(acc) {
  if (!acc.phoneVerified) return 1;
  if (!(acc.mode === "imap" && acc.status === "live") && !acc.firstMailAt) return 2;
  if (!acc.firstMailAt) return 3;
  return 4;
}

function connectBlock(acc, { error = "", values = {}, action }) {
  const isFwd = ["google", "microsoft"].includes(acc.provider);
  const fwd = forwardAddress(acc);
  const addr = `<div class="addr"><span>${esc(fwd)}</span><button type="button" onclick="cp('${esc(fwd)}',this)">Copy</button></div>`;
  const pwForm = canStorePasswords() ? `
<form method="post" action="${action}">
${error ? `<div class="err">${esc(error)}</div>` : ""}
<label for="pass">Password for ${esc(acc.email)}</label><input id="pass" name="pass" type="password" required ${isFwd ? "" : "autofocus"}>
${acc.provider === "google" ? `<p class="note">Gmail needs an <b>app password</b>: Google Account → Security → 2-Step Verification → App passwords.</p>` : ""}
<details ${error ? "open" : ""}><summary>Server settings (only if we can't find them)</summary>
<label for="user">Username</label><input id="user" name="user" value="${esc(values.user || acc.email)}">
<div class="row"><div><label for="imapHost">Incoming (IMAP) server</label><input id="imapHost" name="imapHost" value="${esc(values.imapHost || "")}" placeholder="found automatically"></div><div><label for="imapPort">Port</label><input id="imapPort" name="imapPort" value="${esc(values.imapPort || "")}" placeholder="993"></div></div>
<div class="row"><div><label for="smtpHost">Outgoing (SMTP) server</label><input id="smtpHost" name="smtpHost" value="${esc(values.smtpHost || "")}" placeholder="found automatically"></div><div><label for="smtpPort">Port</label><input id="smtpPort" name="smtpPort" value="${esc(values.smtpPort || "")}" placeholder="465"></div></div>
</details>
<p style="margin-top:14px"><button type="submit">Connect my email</button></p>
<p class="muted" style="font-size:.88rem">Your password is encrypted. It's only used to read new emails and send your replies from your own address.</p>
</form>` : "";
  const fwdSteps = acc.provider === "google"
    ? `<ol><li>Open Gmail on a computer → ⚙️ <b>Settings</b> → <b>See all settings</b> → <b>Forwarding and POP/IMAP</b>.</li><li><b>Add a forwarding address</b>:${addr}</li><li>We send Gmail's code to your WhatsApp. Type it in Gmail → <b>Verify</b>.</li><li>Choose <b>Forward a copy</b>, keep Gmail's copy → <b>Save Changes</b>.</li></ol>`
    : acc.provider === "microsoft"
      ? `<ol><li>outlook.com → ⚙️ <b>Settings</b> → <b>Mail</b> → <b>Forwarding</b>.</li><li>Tick <b>Enable forwarding</b> and paste:${addr}</li><li>Tick <b>Keep a copy</b> → <b>Save</b>.</li></ol>`
      : `<ol><li>Log in to <b>cPanel</b> (often <i>${esc(acc.email.split("@")[1])}/cpanel</i>) → <b>Email</b> → <b>Forwarders</b> → <b>Add Forwarder</b>.</li>
<li>Fill in the form exactly like this:
<table class="fv"><tr><td>Address to Forward</td><td><code>${esc(acc.email.split("@")[0])}</code><br><span class="muted" style="font-size:.85rem">only the part before the @</span></td></tr>
<tr><td>Domain</td><td><code>${esc(acc.email.split("@")[1])}</code></td></tr>
<tr><td>Destination</td><td>tick <b>Forward to Email Address</b></td></tr>
<tr><td>Box under it</td><td>${addr}</td></tr></table></li>
<li>Click <b>Add Forwarder</b>. Then send a test email to <b>${esc(acc.email)}</b>.</li></ol>`;
  const help = `<form method="post" action="/mail/s/${esc(acc.webToken)}/help" style="margin-top:14px"><button class="btn ghost" type="submit">🙋 Set it up for me</button> <span class="muted" style="font-size:.9rem">Our team calls you and does it.</span></form>`;
  return isFwd
    ? `<p><b>Forward your email</b> to your private ZimQuote address:</p>${fwdSteps}<details><summary>Or connect with an app password</summary>${pwForm}</details>${help}`
    : `${pwForm || `<p><b>Forward your email</b> to your private ZimQuote address:</p>${fwdSteps}`}${pwForm ? `<details><summary>Prefer forwarding instead of a password?</summary>${fwdSteps}</details>` : ""}${help}`;
}

function statusPage(acc, { error = "", values = {}, flash = "" } = {}) {
  const st = stepOf(acc);
  const cls = n => n < st ? "step done" : n === st ? "step now" : "step wait";
  const mark = n => n < st ? "✓" : String(n);
  const body = `
<h1>${st === 4 ? "✅ You're all set" : "Connect " + esc(acc.email)}</h1>
<p class="muted">${esc(acc.businessName || "")}${acc.businessName ? " · " : ""}WhatsApp +${esc(acc.ownerPhone)}</p>
${flash}
<div class="steps">
<div class="${cls(1)}"><div class="num">${mark(1)}</div><div><h2>Confirm your WhatsApp</h2>
${st === 1 ? `<p>Tap the button. WhatsApp opens with a code typed in. Just press <b>Send</b>.</p><p><a class="btn wa" href="${esc(linkWaUrl(acc))}">Open WhatsApp</a></p><p class="muted" style="font-size:.9rem">Using a computer? Send <b>ZQ:MAIL:${esc(acc.linkCode || "")}</b> to ZimQuote on WhatsApp (+263 77 114 3904).</p>` : `<p class="muted">Confirmed.</p>`}</div></div>
<div class="${cls(2)}"><div class="num">${mark(2)}</div><div><h2>Connect your email</h2>
${st === 2 ? connectBlock(acc, { error, values, action: `/mail/s/${esc(acc.webToken)}/connect` }) : st > 2 ? `<p class="muted">${acc.mode === "imap" ? "Connected with your email login. Replies go out from your own address." : "Forwarding is working."}</p>` : `<p class="muted">Next.</p>`}</div></div>
<div class="${cls(3)}"><div class="num">${mark(3)}</div><div><h2>Send a test email</h2>
${st === 3 ? `<p>From any other email (or ask a friend), send a short email to <b>${esc(acc.email)}</b>. It will pop up on your WhatsApp${acc.mode === "imap" ? " within 2 minutes" : " in seconds"}.</p><p class="muted">⏳ Waiting for your first email…</p>` : st > 3 ? `<p class="muted">Received - check your WhatsApp.</p>` : `<p class="muted">Last step.</p>`}</div></div>
</div>
${st === 4 ? `<div class="card"><p><b>Done!</b> Every new email now arrives on WhatsApp. Tap <b>↩️ Reply</b> to answer.</p><p class="muted">Type <b>mail</b> on WhatsApp any time to see your inbox, add staff numbers or change settings.</p></div>` : ""}
<script>
(function(){var s=${st};if(s>=4)return;setInterval(function(){fetch(location.pathname.replace(/\\/$/,"")+"/status",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j.step!==s&&!document.activeElement.matches("input"))location.reload()}).catch(function(){})},5000)})();
</script>`;
  return page("ZimQuote Mail setup", body);
}

router.get("/s/:token", async (req, res) => {
  const acc = await byWebToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Not found", `<h1>Link not found</h1><p><a class="btn" href="/mail">Start again</a></p>`));
  res.send(statusPage(acc, { flash: req.query.ok ? `<div class="ok">Connected! Now send a test email.</div>` : req.query.help ? `<div class="ok">🙋 Thanks - our team will contact you on WhatsApp +${esc(acc.ownerPhone)} shortly.</div>` : "" }));
});
router.get("/s/:token/status", async (req, res) => {
  const acc = await byWebToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).json({ error: "not found" });
  res.set("Cache-Control", "no-store").json({ step: stepOf(acc), status: acc.status, mails: acc.mailCount || 0 });
});
router.post("/s/:token/connect", form, async (req, res) => {
  const acc = await byWebToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Not found", "<h1>Link not found</h1>"));
  const b = req.body || {};
  const values = { user: b.user, imapHost: b.imapHost, imapPort: b.imapPort, smtpHost: b.smtpHost, smtpPort: b.smtpPort };
  if (limited(req, "pw", 20)) return res.send(statusPage(acc, { error: "Too many attempts. Please try again in an hour, or tap “Set it up for me”.", values }));
  try {
    const r = await connectWithPassword(acc, { pass: String(b.pass || ""), user: String(b.user || "").trim(), imapHost: String(b.imapHost || "").trim(), imapPort: b.imapPort, smtpHost: String(b.smtpHost || "").trim(), smtpPort: b.smtpPort });
    if (acc.phoneVerified) {
      await sendButtons(acc.ownerPhone, { text: `🎉 *${acc.email} is connected!*\n\nNew emails will arrive here within about 2 minutes.${r.smtp ? `\nReplies go out from *${acc.email}*.` : ""}\n\nSend a test email to check.`, buttons: [{ id: "mail_menu", title: "📧 My Mail" }] }).catch(() => {});
    }
    res.redirect(`/mail/s/${acc.webToken}?ok=1`);
  } catch (e) {
    res.send(statusPage(acc, { error: e.message, values }));
  }
});
router.post("/s/:token/help", form, async (req, res) => {
  const acc = await byWebToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Not found", "<h1>Link not found</h1>"));
  acc.helpRequestedAt = new Date(); await acc.save();
  await notifyMailAdmin(`🙋 *ZimQuote Mail: set-up help requested (web)*\n\n🏢 ${acc.businessName || "-"}\n📧 ${acc.email} (${acc.provider})\n📱 +${acc.ownerPhone}${acc.phoneVerified ? "" : " (not yet confirmed)"}\n\nCall: https://wa.me/${acc.ownerPhone}\nAdmin: ${MAIL_CONFIG.SITE}/zq-admin/mail/${acc._id}`);
  res.redirect(`/mail/s/${acc.webToken}?help=1`);
});

// ─── Forwarding guide (link sent on WhatsApp) ────────────────────────────────
router.get("/guide/:slug", async (req, res) => {
  const acc = await MailAccount.findOne({ slug: String(req.params.slug).toLowerCase() }).catch(() => null);
  if (!acc) return res.status(404).send(page("Not found", "<h1>Link not found</h1><p>Open ZimQuote on WhatsApp and type <b>mail</b>.</p>"));
  if (!acc.webToken) { acc.webToken = (await import("crypto")).randomBytes(12).toString("hex"); await acc.save(); }
  res.send(page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1><p class="muted">About 2 minutes. When you're done, send a test email to ${esc(acc.email)} from another address. It pops up on your WhatsApp.</p><div class="card">${connectBlock(acc, { action: `/mail/s/${acc.webToken}/connect` })}</div>`));
});

// ─── Connect-with-password page (link sent on WhatsApp) ──────────────────────
async function accByToken(token) {
  return MailAccount.findOne({ connectToken: String(token || ""), connectTokenExp: { $gt: new Date() } });
}
router.get("/connect/:token", async (req, res) => {
  const acc = await accByToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Link expired", "<h1>This link has expired</h1><p>Open ZimQuote on WhatsApp, type <b>mail</b> and choose <b>🔑 Use email login</b> to get a new link.</p>"));
  if (!acc.webToken) { acc.webToken = (await import("crypto")).randomBytes(12).toString("hex"); await acc.save(); }
  res.send(page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1><div class="card">${connectBlock(acc, { action: `/mail/connect/${esc(req.params.token)}` })}</div>`));
});
router.post("/connect/:token", form, async (req, res) => {
  const acc = await accByToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Link expired", "<h1>This link has expired</h1>"));
  const b = req.body || {};
  const values = { user: b.user, imapHost: b.imapHost, imapPort: b.imapPort, smtpHost: b.smtpHost, smtpPort: b.smtpPort };
  if (limited(req, "pw", 20)) return res.send(page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1><div class="card">${connectBlock(acc, { error: "Too many attempts. Try again later.", values, action: `/mail/connect/${esc(req.params.token)}` })}</div>`));
  try {
    const r = await connectWithPassword(acc, { pass: String(b.pass || ""), user: String(b.user || "").trim(), imapHost: String(b.imapHost || "").trim(), imapPort: b.imapPort, smtpHost: String(b.smtpHost || "").trim(), smtpPort: b.smtpPort });
    await sendButtons(acc.ownerPhone, {
      text: `🎉 *${acc.email} is connected!*\n\nNew emails will arrive here within about 2 minutes.` + (r.smtp ? `\nYour replies will be sent from *${acc.email}*.` : `\n⚠️ We couldn't connect your outgoing server, so replies will be sent via ZimQuote with your address as the reply-to.`) + `\n\nSend yourself a test email to check.`,
      buttons: [{ id: "mail_menu", title: "📧 My Mail" }]
    }).catch(() => {});
    res.send(page("Connected", `<h1>✅ Connected</h1><div class="ok"><b>${esc(acc.email)}</b> is now on your WhatsApp.</div><p>${r.smtp ? "Replies will go out from your own address." : "We couldn't reach your outgoing mail server. Replies will be sent via ZimQuote, and answers will still come back to you."}</p><p>You can close this page and go back to WhatsApp.</p>`));
  } catch (e) {
    res.send(page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1><div class="card">${connectBlock(acc, { error: e.message, values, action: `/mail/connect/${esc(req.params.token)}` })}</div>`));
  }
});

// ─── Attachments (signed link, extension-less path for nginx) ────────────────
router.get("/att/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{20}$/.test(id) || req.query.t !== attToken(id)) return res.status(404).send("Not found");
  const doc = await mongoose.connection.collection("mail_attachments").findOne({ _id: id }).catch(() => null);
  if (!doc) return res.status(404).send("Not found");
  const d = doc.data;
  const data = Buffer.isBuffer(d) ? d : d?._bsontype === "Binary" ? Buffer.from(d.buffer) : Buffer.from(d || "");
  res.set("Content-Type", doc.contentType || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${String(doc.filename || "attachment").replace(/["\r\n]/g, "")}"`);
  res.set("Cache-Control", "private, max-age=3600");
  res.send(data);
});

export default router;

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN  /zq-admin/mail
// ═════════════════════════════════════════════════════════════════════════════
export function registerMailAdminRoutes(router, { requireSupplierAdmin, layout, esc: e = esc, badge, stat }) {
  const fmt = d => d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Harare", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
  const day = d => d ? new Date(d).toLocaleDateString("en-CA", { timeZone: "Africa/Harare" }) : "";
  const flash = req => (req.query.success ? `<div class="zqm-flash ok">✅ ${e(req.query.success)}</div>` : "") + (req.query.error ? `<div class="zqm-flash bad">❌ ${e(req.query.error)}</div>` : "");
  const css = `<style>
.zqm{--ln:#e2e8f0;--mu:#64748b}
.zqm .card2{background:#fff;border:1px solid var(--ln);border-radius:12px;padding:18px 20px;margin:0 0 16px}
.zqm h3{margin:0 0 6px;font-size:1.1rem}.zqm .mu{color:var(--mu)}.zqm .sm{font-size:.88rem}
.zqm .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:4px 18px}
.zqm label{display:block;font-weight:600;font-size:.9rem;margin:12px 0 4px}
.zqm input:not([type=checkbox]),.zqm select,.zqm textarea{width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;box-sizing:border-box;background:#fff}
.zqm textarea{min-height:70px}.zqm .chk{display:flex;gap:8px;align-items:center;font-weight:normal}
.zqm .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.zqm .acts form{margin:0}
.zqm .kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;margin:10px 0}.zqm .kv div:nth-child(odd){color:var(--mu)}
.zqm code{background:#f1f5f9;padding:2px 6px;border-radius:6px}
.zqm-flash{padding:12px 14px;border-radius:8px;margin-bottom:14px}.zqm-flash.ok{background:#dcfce7;color:#166534}.zqm-flash.bad{background:#fee2e2;color:#991b1b}
.zqm .danger{border-color:#fecaca}.zqm .btn-red{background:#dc2626;color:#fff;border:0}
@media(max-width:600px){.zqm .kv{grid-template-columns:1fr}}
</style>`;
  const wrap = html => `${css}<div class="zqm">${html}</div>`;
  const sub = active => `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
<a class="btn btn-sm ${active === "list" ? "btn-blue" : "btn-gray"}" href="/zq-admin/mail">📧 Inboxes</a>
<a class="btn btn-sm ${active === "new" ? "btn-green" : "btn-gray"}" href="/zq-admin/mail/new">➕ Set up for a client</a>
<a class="btn btn-sm btn-gray" href="/zq-admin/mail?filter=help">🙋 Asked for help</a>
<a class="btn btn-sm btn-gray" href="/zq-admin/mail?filter=stuck">🛠 Stuck in setup</a>
<a class="btn btn-sm btn-gray" href="/mail" target="_blank">🌐 Public sign-up page</a></div>`;
  const statusBadge = a => a.status === "live" ? badge("🟢 Live", "green") : a.status === "setup" ? badge("🛠 Waiting for first email", "orange") : a.status === "error" ? badge("⚠️ Login failing", "red") : badge("⏸ Paused", "gray");
  const planBadge = a => { const now = Date.now(); return a.paidUntil && new Date(a.paidUntil) > now ? badge(`Paid → ${fmt(a.paidUntil).split(",")[0]}`, "green") : a.trialEndsAt && new Date(a.trialEndsAt) > now ? badge(`Trial → ${fmt(a.trialEndsAt).split(",")[0]}`, "blue") : badge("Expired", "red"); };
  const go = (res, url, kind, msg) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`);
  const pform = express.urlencoded({ extended: false });

  function receivingPanel() {
    const c = MAIL_CONFIG.COLLECTOR;
    if (!c) return `<div class="card2 danger"><h3>⚠️ Receiving forwarded email is not set up</h3>
<p>Forwarded emails have nowhere to go yet. The easiest fix uses <b>one normal mailbox on your cPanel</b>:</p>
<ol class="sm"><li>cPanel → <b>Email Accounts</b> → create <code>zqmail@zimqoute.co.zw</code> with a strong password.</li>
<li>Add to <code>.env</code> and restart:<br><code>MAIL_COLLECTOR_USER=zqmail@zimqoute.co.zw</code><br><code>MAIL_COLLECTOR_PASS=...</code><br><code>MAIL_COLLECTOR_HOST=mail.zimqoute.co.zw</code></li>
<li>Clients then forward to <code>zqmail@zimqoute.co.zw</code>. The same mailbox also sends test emails and replies.</li></ol></div>`;
    const s = collectorStatus;
    return `<div class="card2"><h3>📥 Forwarding mailbox: <code>${e(c.address)}</code></h3>
<p class="sm mu">Checked every 45s · last check ${fmt(s.lastRunAt)} · last OK ${fmt(s.lastOkAt)} · processed since restart: ${s.processed}${s.insecureTls ? " · host certificate mismatch allowed" : ""}</p>
${s.lastError ? `<div class="zqm-flash bad">Last error: ${e(s.lastError)}</div>` : ""}
<div class="acts"><form method="post" action="/zq-admin/mail/collector/check"><button class="btn btn-sm btn-blue">🔄 Check now</button></form></div></div>`;
  }

  router.post("/mail/collector/check", requireSupplierAdmin, async (req, res) => {
    await pollCollector();
    collectorStatus.lastError ? go(res, "/zq-admin/mail", "error", "Forwarding mailbox: " + collectorStatus.lastError) : go(res, "/zq-admin/mail", "success", "Forwarding mailbox checked.");
  });

  router.get("/mail", requireSupplierAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const f = String(req.query.filter || "");
      const filter = {};
      const rx = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      if (q) filter.$or = [{ email: rx(q) }, { businessName: rx(q) }, { ownerPhone: new RegExp(q.replace(/\D/g, "") || "^$") }];
      if (f === "help") filter.helpRequestedAt = { $ne: null };
      if (f === "stuck") Object.assign(filter, { status: "setup", createdAt: { $lt: new Date(Date.now() - 3600000) } });
      const accs = await MailAccount.find(filter).sort(f === "help" ? { helpRequestedAt: -1 } : { createdAt: -1 }).limit(300).lean();
      const all = await MailAccount.find({}, { status: 1, paidUntil: 1, trialEndsAt: 1, createdAt: 1, helpRequestedAt: 1 }).lean();
      const now = Date.now(), d1 = new Date(now - 86400000);
      const [mails24, replies24] = await Promise.all([
        MailMessage.countDocuments({ receivedAt: { $gte: d1 } }),
        MailMessage.countDocuments({ "replies.sentAt": { $gte: d1 } })
      ]);
      const paid = all.filter(a => a.paidUntil && new Date(a.paidUntil) > now).length;
      const stuck = all.filter(a => a.status === "setup" && new Date(a.createdAt).getTime() < now - 3600000).length;
      const help = all.filter(a => a.helpRequestedAt && a.status !== "live").length;
      const rows = accs.map(a => `<tr>
<td><a class="btn-link" href="/zq-admin/mail/${a._id}"><b>${e(a.email)}</b></a><br><small class="muted">${e(a.businessName || "")}${a.businessName ? " · " : ""}${e(a.provider)} · ${a.mode === "imap" ? "email login" : "forwarding"}</small>${a.helpRequestedAt && a.status !== "live" ? `<br>${badge("🙋 wants help", "orange")}` : ""}</td>
<td><a href="https://wa.me/${e(a.ownerPhone)}" target="_blank">+${e(a.ownerPhone)}</a>${a.phoneVerified === false ? `<br>${badge("not confirmed", "gray")}` : ""}</td>
<td>${statusBadge(a)}<br>${planBadge(a)}</td>
<td>${a.mailCount || 0} in · ${a.replyCount || 0} out<br><small class="muted">last ${fmt(a.lastMailAt)}</small></td>
<td style="white-space:nowrap"><a class="btn btn-sm btn-blue" href="/zq-admin/mail/${a._id}">Open</a> <a class="btn btn-sm btn-gray" href="/zq-admin/mail/${a._id}#edit">Edit</a></td></tr>`).join("");
      res.send(layout("ZimQuote Mail", wrap(`${flash(req)}${sub("list")}${receivingPanel()}
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">${stat(all.length, "Inboxes", "blue")}${stat(paid, "Paid", "green")}${stat(help, "Asked for help", "orange")}${stat(stuck, "Stuck in setup", "red")}${stat(mails24, "Emails 24h", "teal")}${stat(replies24, "Replies 24h", "teal")}</div>
<form method="get" style="margin-bottom:12px;display:flex;gap:8px"><input name="q" value="${e(q)}" placeholder="Search email, business or phone" style="flex:1"><button class="btn btn-blue">Search</button></form>
<p class="muted sm">Sign-up link to share: <code>${e(MAIL_CONFIG.SITE)}/mail</code> · WhatsApp: <code>https://wa.me/263771143904?text=ZQ:MAIL</code></p>
<div class="table-wrap"><table><thead><tr><th>Inbox</th><th>Owner</th><th>Status</th><th>Activity</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">Nothing here.</td></tr>`}</tbody></table></div>`)));
    } catch (err) { res.status(500).send(layout("ZimQuote Mail", `<div class="alert red">${e(err.message)}</div>`)); }
  });

  // ── Set up for a client ────────────────────────────────────────────────────
  router.get("/mail/new", requireSupplierAdmin, (req, res) => {
    res.send(layout("ZimQuote Mail - New", wrap(`${flash(req)}${sub("new")}
<div class="card2" style="max-width:760px">
<h3>Set up an inbox for a client</h3>
<p class="mu sm">On the phone with the client: type their email and password. We find their mail server (works with .co.zw cPanel hosting) and test the login. No password? Leave it blank, and you'll get the forwarding address to add in their cPanel.</p>
<form method="post" action="/zq-admin/mail/new" autocomplete="off">
<div class="grid">
<div><label for="m-phone">Client WhatsApp number</label><input id="m-phone" name="phone" required value="${e(req.query.phone || "")}" placeholder="0772123456"></div>
<div><label for="m-biz">Business name</label><input id="m-biz" name="biz" placeholder="Acme Hardware"></div>
<div><label for="m-email">Email address</label><input id="m-email" name="email" type="email" required placeholder="sales@acme.co.zw"></div>
<div><label for="m-pass">Email password (optional)</label><input id="m-pass" name="password" type="password" autocomplete="new-password"></div>
<div><label for="m-alert">Alerts</label><select id="m-alert" name="alertMode"><option value="all">Every email</option><option value="important">Important only</option></select></div>
<div><label for="m-trial">Free trial (days)</label><input id="m-trial" name="trial" type="number" min="0" max="365" value="${MAIL_CONFIG.TRIAL_DAYS}"></div>
</div>
<details style="margin-top:10px"><summary class="mu sm">Mail server (only if auto-detect fails)</summary><div class="grid">
<div><label for="m-ih">IMAP server</label><input id="m-ih" name="imapHost" placeholder="mail.acme.co.zw"></div>
<div><label for="m-sh">SMTP server</label><input id="m-sh" name="smtpHost" placeholder="mail.acme.co.zw"></div></div></details>
<label class="chk"><input type="checkbox" name="welcome" value="1" checked> Send the client a WhatsApp welcome</label>
<div class="acts"><button class="btn btn-green">Create inbox</button></div>
</form></div>`)));
  });
  router.post("/mail/new", requireSupplierAdmin, pform, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await setupForClient({ phone: b.phone, email: String(b.email || "").trim(), businessName: String(b.biz || "").trim(), password: String(b.password || ""), imapHost: String(b.imapHost || "").trim(), smtpHost: String(b.smtpHost || "").trim(), alertMode: b.alertMode === "important" ? "important" : "all", trialDays: Number(b.trial) || 0 });
      let welcome = "";
      if (b.welcome) welcome = (await sendClientWelcome(r.acc)) ? " Welcome sent." : " Welcome not delivered (client hasn't messaged the bot in 24h - use “Message client from my phone”).";
      const msg = r.connected ? `Created and connected. ${r.message}${welcome}` : `Created.${r.message ? " Login: " + r.message : ""} Forwarding address: ${forwardAddress(r.acc)}.${welcome}`;
      go(res, `/zq-admin/mail/${r.acc._id}`, r.connected || !b.password ? "success" : "error", msg);
    } catch (err) { go(res, `/zq-admin/mail/new?phone=${encodeURIComponent(req.body?.phone || "")}`, "error", err.message); }
  });

  // ── One inbox ──────────────────────────────────────────────────────────────
  router.get("/mail/:id", requireSupplierAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    const a = await MailAccount.findById(req.params.id).lean();
    if (!a) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    const msgs = await MailMessage.find({ accountId: a._id }).sort({ receivedAt: -1 }).limit(15).lean();
    const fwd = forwardAddress(a);
    const waText = encodeURIComponent(`Hi${a.businessName ? " " + a.businessName : ""}, this is ZimQuote. Your email ${a.email} is set up on WhatsApp. Please send "mail" to +263 77 114 3904 on WhatsApp to see your inbox.`);
    const disc = req.query.discover ? await discoverServers(a.email, a.provider).catch(() => null) : null;
    const how = a.mode === "imap"
      ? `email login · <code>${e(a.imap?.host || "")}</code>${a.imap?.insecureTls ? " (cert mismatch allowed)" : ""}${a.smtp?.host ? ` · replies via <code>${e(a.smtp.host)}:${a.smtp.port}</code>` : " · replies via ZimQuote"}`
      : `forwarding to <code>${e(fwd)}</code>`;
    res.send(layout("ZimQuote Mail - " + a.email, wrap(`${flash(req)}${sub("")}
${a.mode === "forward" && !MAIL_CONFIG.COLLECTOR ? receivingPanel() : ""}
<div class="card2">
<h3>${e(a.email)}</h3>
<p>${statusBadge(a)} ${planBadge(a)} ${a.helpRequestedAt && a.status !== "live" ? badge("🙋 wants help " + fmt(a.helpRequestedAt), "orange") : ""}</p>
<div class="kv">
<div>Business</div><div>${e(a.businessName || "-")}</div>
<div>Owner WhatsApp</div><div><a href="https://wa.me/${e(a.ownerPhone)}" target="_blank">+${e(a.ownerPhone)}</a>${a.phoneVerified === false ? " (not confirmed yet)" : ""}</div>
<div>Team</div><div>${(a.alertPhones || []).map(p => "+" + e(p)).join(", ") || "none"}</div>
<div>Provider</div><div>${e(a.provider)}</div>
<div>Connected by</div><div>${how}</div>
${a.mode === "imap" ? `<div>Forwarding address</div><div><code>${e(fwd)}</code> (not needed while the password is connected)</div>` : ""}
<div>Activity</div><div>${a.mailCount || 0} emails in · ${a.replyCount || 0} replies · last ${fmt(a.lastMailAt)}</div>
<div>Created</div><div>${fmt(a.createdAt)} via ${e(a.setupBy || "whatsapp")}</div>
<div>Client pages</div><div><a href="/mail/s/${e(a.webToken || "")}" target="_blank">status page</a> · <a href="/mail/guide/${e(a.slug)}" target="_blank">setup guide</a></div>
</div>
${a.imap?.lastError ? `<div class="zqm-flash bad">Last error: ${e(a.imap.lastError)}</div>` : ""}
<div class="acts">
<form method="post" action="/zq-admin/mail/${a._id}/test"><button class="btn btn-sm btn-blue">📨 Send test email</button></form>
<form method="post" action="/zq-admin/mail/${a._id}/welcome"><button class="btn btn-sm btn-gray">👋 WhatsApp welcome</button></form>
<a class="btn btn-sm btn-green" target="_blank" href="https://wa.me/${e(a.ownerPhone)}?text=${waText}">💬 Message client</a>
<form method="post" action="/zq-admin/mail/${a._id}/guide"><button class="btn btn-sm btn-gray">📖 Resend setup steps</button></form>
<form method="post" action="/zq-admin/mail/${a._id}/extend" onsubmit="return confirm('Mark as paid for 1 year?')"><button class="btn btn-sm btn-green">💵 +1 year paid</button></form>
<form method="post" action="/zq-admin/mail/${a._id}/trial"><button class="btn btn-sm btn-gray">+14 days trial</button></form>
${a.helpRequestedAt ? `<form method="post" action="/zq-admin/mail/${a._id}/clearhelp"><button class="btn btn-sm btn-gray">✔ Help done</button></form>` : ""}
</div></div>

<div class="card2" style="max-width:760px">
<h3>🔑 Connect with the client's password</h3>
<p class="mu sm">Best for .co.zw company email. No forwarder is needed, and replies go out from the client's own address, with a copy in their Sent folder.</p>
<form method="post" action="/zq-admin/mail/${a._id}/connect" autocomplete="off">
<div class="grid">
<div><label for="c-user">Username</label><input id="c-user" name="user" value="${e(a.imap?.user || a.email)}"></div>
<div><label for="c-pass">Password</label><input id="c-pass" name="password" type="password" required autocomplete="new-password"></div>
</div>
<details style="margin-top:10px"><summary class="mu sm">Mail server (optional)</summary><div class="grid">
<div><label for="c-ih">IMAP server</label><input id="c-ih" name="imapHost" value="${e(a.imap?.host || "")}"></div>
<div><label for="c-sh">SMTP server</label><input id="c-sh" name="smtpHost" value="${e(a.smtp?.host || "")}"></div></div></details>
<div class="acts"><button class="btn btn-green">Test &amp; connect</button><a class="btn btn-sm btn-gray" href="/zq-admin/mail/${a._id}?discover=1">🔍 Show detected servers</a></div></form>
${disc ? `<p class="mu sm" style="margin-top:10px">IMAP: ${disc.imap.map(s => `${e(s.host)}:${s.port}`).join(", ") || "-"}<br>SMTP: ${disc.smtp.map(s => `${e(s.host)}:${s.port}`).join(", ") || "-"}</p>` : ""}
</div>

<div class="card2" id="edit" style="max-width:760px">
<h3>✏️ Edit inbox</h3>
<form method="post" action="/zq-admin/mail/${a._id}/edit">
<div class="grid">
<div><label for="e-email">Email address</label><input id="e-email" name="email" type="email" value="${e(a.email)}" required></div>
<div><label for="e-biz">Business name</label><input id="e-biz" name="businessName" value="${e(a.businessName || "")}"></div>
<div><label for="e-owner">Owner WhatsApp</label><input id="e-owner" name="ownerPhone" value="${e(a.ownerPhone)}" required></div>
<div><label for="e-team">Team WhatsApp numbers (comma-separated, max ${MAIL_CONFIG.TEAM_MAX})</label><input id="e-team" name="alertPhones" value="${e((a.alertPhones || []).join(", "))}"></div>
<div><label for="e-name">Sender name on replies</label><input id="e-name" name="displayName" value="${e(a.displayName || "")}"></div>
<div><label for="e-alert">Alerts</label><select id="e-alert" name="alertMode"><option value="all" ${a.alertMode !== "important" ? "selected" : ""}>Every email</option><option value="important" ${a.alertMode === "important" ? "selected" : ""}>Important only</option></select></div>
<div><label for="e-status">Status</label><select id="e-status" name="status">${["setup", "live", "paused"].map(s => `<option value="${s}" ${a.status === s ? "selected" : ""}>${s === "setup" ? "Setup" : s === "live" ? "Live" : "Paused (no alerts)"}</option>`).join("")}${a.status === "error" ? `<option value="" selected>Login failing</option>` : ""}</select></div>
<div><label for="e-trial">Trial ends</label><input id="e-trial" name="trialEndsAt" type="date" value="${day(a.trialEndsAt)}"></div>
<div><label for="e-paid">Paid until</label><input id="e-paid" name="paidUntil" type="date" value="${day(a.paidUntil)}"></div>
</div>
<label for="e-sig">Signature on replies</label><textarea id="e-sig" name="signature">${e(a.signature || "")}</textarea>
${a.mode === "imap" ? `<label class="chk"><input type="checkbox" name="useForwarding" value="1"> Forget the saved password and switch to forwarding</label>` : ""}
<div class="acts"><button class="btn btn-green">Save changes</button></div>
</form></div>

<div class="card2 danger" style="max-width:760px">
<h3>🗑 Delete inbox</h3>
<p class="mu sm">This removes ${e(a.email)}, its ${a.mailCount || 0} saved emails and their attachments. The client stops getting alerts. Remember to remove the forwarder in their cPanel.</p>
<form method="post" action="/zq-admin/mail/${a._id}/delete" onsubmit="return prompt('Type DELETE to remove ${e(a.email)}')==='DELETE'"><button class="btn btn-sm btn-red">Delete inbox</button></form>
</div>

<div class="card2"><h3>Latest emails</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Subject</th><th>Status</th></tr></thead><tbody>
${msgs.map(m => `<tr><td>${fmt(m.receivedAt)}</td><td>${e(m.fromName)}<br><small class="muted">${e(m.fromEmail)}</small></td><td>${e(m.subject)}<br><small class="muted">${e(m.summary || "")}</small></td><td>${m.muted ? badge("quiet", "gray") : m.status === "replied" ? badge("replied", "green") : m.status === "done" ? badge("done", "gray") : badge("open", "blue")}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No emails yet.</td></tr>`}
</tbody></table></div></div>`)));
  });

  const one = async req => (mongoose.isValidObjectId(req.params.id) ? MailAccount.findById(req.params.id) : null);
  router.post("/mail/:id/edit", requireSupplierAdmin, pform, async (req, res) => {
    try {
      const b = req.body || {};
      const acc = await updateAccount(req.params.id, {
        email: b.email, businessName: b.businessName, ownerPhone: b.ownerPhone, alertPhones: b.alertPhones ?? "",
        displayName: b.displayName, signature: b.signature, alertMode: b.alertMode, status: b.status,
        trialEndsAt: b.trialEndsAt ?? "", paidUntil: b.paidUntil ?? "", useForwarding: !!b.useForwarding
      });
      go(res, `/zq-admin/mail/${acc._id}`, "success", "Saved.");
    } catch (err) { go(res, `/zq-admin/mail/${req.params.id}`, "error", err.message); }
  });
  router.post("/mail/:id/delete", requireSupplierAdmin, async (req, res) => {
    try { const acc = await deleteAccount(req.params.id); go(res, "/zq-admin/mail", "success", `${acc.email} deleted.`); }
    catch (err) { go(res, "/zq-admin/mail", "error", err.message); }
  });
  router.post("/mail/:id/connect", requireSupplierAdmin, pform, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    try {
      const r = await connectWithPassword(acc, { pass: String(req.body.password || ""), user: String(req.body.user || "").trim(), imapHost: String(req.body.imapHost || "").trim(), smtpHost: String(req.body.smtpHost || "").trim() });
      go(res, `/zq-admin/mail/${acc._id}`, "success", `Connected via ${r.imap.host}${r.smtp ? `; replies via ${r.smtp.host}:${r.smtp.port}` : "; no SMTP found, replies via ZimQuote"}. Send a test email to check.`);
    } catch (err) { go(res, `/zq-admin/mail/${acc._id}`, "error", err.message); }
  });
  router.post("/mail/:id/test", requireSupplierAdmin, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    try {
      await sendTestEmail(acc);
      go(res, `/zq-admin/mail/${acc._id}`, "success", `Test email sent to ${acc.email}. It should reach the client's WhatsApp within ${acc.mode === "imap" ? "2 minutes" : "a minute"}.`);
    } catch (err) { go(res, `/zq-admin/mail/${acc._id}`, "error", err.message); }
  });
  router.post("/mail/:id/welcome", requireSupplierAdmin, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    (await sendClientWelcome(acc)) ? go(res, `/zq-admin/mail/${acc._id}`, "success", "Welcome sent on WhatsApp.") : go(res, `/zq-admin/mail/${acc._id}`, "error", "Not delivered - the client hasn't messaged the bot in 24h. Use “Message client”.");
  });
  router.post("/mail/:id/extend", requireSupplierAdmin, async (req, res) => {
    const acc = await activatePaid(req.params.id, "", null, 365).catch(() => null);
    acc ? go(res, `/zq-admin/mail/${acc._id}`, "success", `Paid until ${fmt(acc.paidUntil)}`) : go(res, "/zq-admin/mail", "error", "Inbox not found");
  });
  router.post("/mail/:id/trial", requireSupplierAdmin, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    const base = acc.trialEndsAt && new Date(acc.trialEndsAt) > new Date() ? new Date(acc.trialEndsAt) : new Date();
    acc.trialEndsAt = new Date(base.getTime() + 14 * 86400000); await acc.save();
    go(res, `/zq-admin/mail/${acc._id}`, "success", `Trial until ${fmt(acc.trialEndsAt)}`);
  });
  router.post("/mail/:id/guide", requireSupplierAdmin, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    await sendSetupGuide(acc.ownerPhone, acc).catch(() => {});
    go(res, `/zq-admin/mail/${acc._id}`, "success", `Setup steps sent to +${acc.ownerPhone}`);
  });
  router.post("/mail/:id/clearhelp", requireSupplierAdmin, async (req, res) => {
    const acc = await one(req); if (!acc) return go(res, "/zq-admin/mail", "error", "Inbox not found");
    acc.helpRequestedAt = undefined; await acc.save();
    go(res, `/zq-admin/mail/${acc._id}`, "success", "Help request cleared");
  });
}

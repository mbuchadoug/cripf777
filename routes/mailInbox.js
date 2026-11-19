// routes/mailInbox.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote MAIL - web routes (mounted at /mail in server.js, BEFORE the body parsers)
//
//   POST /mail/inbound?to=<rcpt>    raw email in (Cloudflare Email Worker / any relay)
//                                   header  x-mail-secret: MAIL_INBOUND_SECRET
//   GET  /mail/guide/:slug          step-by-step setup page for the customer
//   GET  /mail/connect/:token       secure "connect with your email password" page
//   POST /mail/connect/:token
//   GET  /mail/att/:id?t=…          attachment download (signed link)
//
// Admin (registered from routes/supplierAdmin.js, same login + layout):
//   import { registerMailAdminRoutes } from "./mailInbox.js";
//   registerMailAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat });
//   → /zq-admin/mail
// ═════════════════════════════════════════════════════════════════════════════
import express from "express";
import mongoose from "mongoose";
import MailAccount from "../models/mailAccount.js";
import MailMessage from "../models/mailMessage.js";
import {
  ingestRaw, forwardAddress, guessServers, encryptSecret, canStorePasswords,
  testImap, testSmtp, attToken, activatePaid, isActive, MAIL_CONFIG, alertNewMail
} from "../services/mailInbox.js";
import { sendButtons } from "../services/metaSender.js";

const router = express.Router();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

// ─── Shared page shell ───────────────────────────────────────────────────────
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f4f6f5;--card:#fff;--fg:#17201c;--muted:#5d6b64;--line:#dbe2de;--accent:#0f7a52;--ink:#fff;--warn:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#101513;--card:#18201c;--fg:#e4ebe7;--muted:#93a39b;--line:#2a3530;--accent:#3cc48b;--ink:#06130d;--warn:#2b2414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:620px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.45rem;margin:0 0 6px}p{margin:0 0 12px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
ol{padding-left:22px;margin:0}li{margin:0 0 10px}
.addr{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--bg);border:1px dashed var(--accent);border-radius:10px;padding:12px;font:600 1.02rem ui-monospace,Menlo,monospace;word-break:break-all}
button,.btn{font:600 15px system-ui,sans-serif;background:var(--accent);color:var(--ink);border:0;border-radius:8px;padding:11px 16px;cursor:pointer;text-decoration:none;display:inline-block}
label{display:block;font-weight:600;margin:12px 0 4px}input,select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
.row{display:grid;grid-template-columns:2fr 1fr;gap:10px}.err{background:#fde8e8;color:#9b1c1c;border-radius:8px;padding:12px;margin:12px 0}
.ok{background:#def7ec;color:#03543f;border-radius:8px;padding:12px;margin:12px 0}.note{background:var(--warn);border-radius:8px;padding:12px;font-size:.93rem}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted)}
</style></head><body><div class="wrap">${body}
<p class="muted" style="margin-top:28px;font-size:.85rem">ZimQuote Mail · help: WhatsApp ${esc(process.env.MAIL_SUPPORT_PHONE || "+263 78 990 1058")}</p></div>
<script>function cp(t,b){navigator.clipboard&&navigator.clipboard.writeText(t).then(()=>{b.textContent="Copied ✓"},()=>{})}</script></body></html>`;
}

// ─── Setup guide ─────────────────────────────────────────────────────────────
router.get("/guide/:slug", async (req, res) => {
  const acc = await MailAccount.findOne({ slug: String(req.params.slug).toLowerCase() }).lean().catch(() => null);
  if (!acc) return res.status(404).send(page("Not found", "<h1>Link not found</h1><p>Open ZimQuote on WhatsApp and type <b>mail</b>.</p>"));
  const fwd = forwardAddress(acc);
  const addr = `<div class="addr"><span>${esc(fwd)}</span><button type="button" onclick="cp('${esc(fwd)}',this)">Copy</button></div>`;
  const steps = {
    google: `<h2>Gmail</h2><ol>
<li>Open <b>Gmail</b> in a browser (computer, or phone in "desktop site" mode).</li>
<li>Click ⚙️ <b>Settings</b> → <b>See all settings</b> → tab <b>Forwarding and POP/IMAP</b>.</li>
<li>Click <b>Add a forwarding address</b> and paste:${addr}</li>
<li>Gmail sends a confirmation code. <b>We send that code to your WhatsApp</b> within a minute. Type it in Gmail and click <b>Verify</b>.</li>
<li>Choose <b>Forward a copy of incoming mail to…</b> and <b>keep Gmail's copy in the Inbox</b>. Click <b>Save Changes</b>.</li></ol>`,
    microsoft: `<h2>Outlook, Hotmail or Microsoft 365</h2><ol>
<li>Open <b>outlook.com</b> or Outlook on the web and sign in.</li>
<li>⚙️ <b>Settings</b> → <b>Mail</b> → <b>Forwarding</b>.</li>
<li>Tick <b>Enable forwarding</b> and paste:${addr}</li>
<li>Tick <b>Keep a copy of forwarded messages</b>, then <b>Save</b>.</li></ol>
<p class="note">Company Microsoft 365: some companies block forwarding to outside addresses. If emails don't arrive, ask whoever manages your email to allow forwarding to the address above.</p>`,
    cpanel: `<h2>Company email (cPanel hosting)</h2>
${acc.connectToken && canStorePasswords() ? `<p><b>Easiest:</b> <a class="btn" href="/mail/connect/${esc(acc.connectToken)}">Connect with your email password</a></p><p class="muted">Or set up forwarding:</p>` : ""}
<ol><li>Log in to <b>cPanel</b> (usually <i>yourdomain.co.zw/cpanel</i>) or your host's email panel.</li>
<li>Open <b>Email</b> → <b>Forwarders</b> → <b>Add Forwarder</b>.</li>
<li>Address to forward: <b>${esc(acc.email.split("@")[0])}</b> · Domain: <b>${esc(acc.email.split("@")[1])}</b></li>
<li>Choose <b>Forward to Email Address</b> and paste:${addr}</li><li>Click <b>Add Forwarder</b>.</li></ol>`
  };
  const body = steps[acc.provider] || steps.cpanel;
  res.send(page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1><p class="muted">About 2 minutes. When you're done, send a test email to ${esc(acc.email)} from another address. It pops up on your WhatsApp.</p><div class="card">${body}</div>
<details><summary>Using a different provider?</summary><div class="card">${["google", "microsoft", "cpanel"].filter(k => k !== acc.provider).map(k => steps[k]).join("<hr>")}</div></details>`));
});

// ─── Connect with password (IMAP/SMTP) ───────────────────────────────────────
async function accByToken(token) {
  const acc = await MailAccount.findOne({ connectToken: String(token || ""), connectTokenExp: { $gt: new Date() } });
  return acc;
}
function connectForm(acc, { error = "", values = {} } = {}) {
  const g = guessServers(acc.email, acc.provider);
  const v = { imapHost: g.imap.host, imapPort: g.imap.port, smtpHost: g.smtp.host, smtpPort: g.smtp.port, user: acc.email, ...values };
  const gmailNote = acc.provider === "google" ? `<p class="note">Gmail needs an <b>app password</b>, not your normal password: Google Account → Security → 2-Step Verification (turn on) → <b>App passwords</b> → create one called "ZimQuote" and paste it below. Or use <a href="/mail/guide/${esc(acc.slug)}">forwarding</a> instead.</p>` : "";
  return page("Connect your email", `<h1>Connect ${esc(acc.email)}</h1>
<p class="muted">We check your login and connect you in a few seconds. Your password is encrypted. It's only used to read new emails and send your replies from your own address.</p>
${gmailNote}${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" class="card" autocomplete="off">
<label for="pass">Email password</label><input id="pass" name="pass" type="password" required autofocus>
<details ${error ? "open" : ""}><summary>Server settings (we filled these in for you)</summary>
<label for="user">Username</label><input id="user" name="user" value="${esc(v.user)}">
<div class="row"><div><label for="imapHost">Incoming (IMAP) server</label><input id="imapHost" name="imapHost" value="${esc(v.imapHost)}"></div><div><label for="imapPort">Port</label><input id="imapPort" name="imapPort" value="${esc(v.imapPort)}"></div></div>
<div class="row"><div><label for="smtpHost">Outgoing (SMTP) server</label><input id="smtpHost" name="smtpHost" value="${esc(v.smtpHost)}"></div><div><label for="smtpPort">Port</label><input id="smtpPort" name="smtpPort" value="${esc(v.smtpPort)}"></div></div>
</details>
<p style="margin-top:16px"><button type="submit">Connect my email</button></p></form>
<p class="muted">Prefer not to share a password? <a href="/mail/guide/${esc(acc.slug)}">Forward your email instead</a>.</p>`);
}

router.get("/connect/:token", async (req, res) => {
  const acc = await accByToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Link expired", "<h1>This link has expired</h1><p>Open ZimQuote on WhatsApp, type <b>mail</b> and choose <b>🔑 Use email login</b> to get a new link.</p>"));
  if (!canStorePasswords()) return res.send(page("Not available", "<h1>Not available yet</h1><p>Please use forwarding for now.</p>"));
  res.send(connectForm(acc));
});

router.post("/connect/:token", express.urlencoded({ extended: false }), async (req, res) => {
  const acc = await accByToken(req.params.token).catch(() => null);
  if (!acc) return res.status(404).send(page("Link expired", "<h1>This link has expired</h1>"));
  const b = req.body || {};
  const pass = String(b.pass || "");
  const user = String(b.user || acc.email).trim();
  const g = guessServers(acc.email, acc.provider);
  const imapHosts = [...new Set([String(b.imapHost || g.imap.host).trim(), ...(g.alt || [])].filter(Boolean))];
  const imapPort = Number(b.imapPort) || 993;
  const smtpHost = String(b.smtpHost || g.smtp.host).trim();
  const smtpPort = Number(b.smtpPort) || 465;
  const values = { user, imapHost: imapHosts[0], imapPort, smtpHost, smtpPort };
  if (!pass) return res.send(connectForm(acc, { error: "Type your email password.", values }));

  // 1. Incoming mail
  let imapOk = null, imapErr = "";
  for (const host of imapHosts) {
    try { imapOk = { host, info: await testImap({ host, port: imapPort, secure: imapPort === 993, user, pass }) }; break; }
    catch (e) { imapErr = e.authenticationFailed ? "The email or password is wrong." : `Could not reach ${host}: ${e.code || e.message}`; if (e.authenticationFailed) break; }
  }
  if (!imapOk) return res.send(connectForm(acc, { error: imapErr || "Could not connect.", values }));

  // 2. Outgoing mail (try SSL 465, then STARTTLS 587, on the smtp host and the working imap host)
  let smtpOk = null;
  const tries = [[smtpHost, smtpPort], [smtpHost, smtpPort === 465 ? 587 : 465], [imapOk.host, 465], [imapOk.host, 587]];
  for (const [host, port] of tries) {
    try { await testSmtp({ host, port, secure: port === 465, user, pass }); smtpOk = { host, port, secure: port === 465 }; break; }
    catch (_) {}
  }

  acc.mode = "imap";
  acc.imap = { host: imapOk.host, port: imapPort, secure: imapPort === 993, user, passEnc: encryptSecret(pass), lastUid: Math.max(0, (imapOk.info.uidNext || 1) - 1), uidValidity: imapOk.info.uidValidity, lastError: "", lastCheckedAt: new Date() };
  if (smtpOk) acc.smtp = smtpOk;
  acc.status = "live";
  acc.connectToken = ""; acc.connectTokenExp = null;
  await acc.save();

  await sendButtons(acc.ownerPhone, {
    text: `🎉 *${acc.email} is connected!*\n\nNew emails will arrive here within about 2 minutes.` + (smtpOk ? `\nYour replies will be sent from *${acc.email}*.` : `\n⚠️ We couldn't connect your outgoing server, so replies will be sent via ZimQuote with your address as the reply-to.`) + `\n\nSend yourself a test email to check.`,
    buttons: [{ id: "mail_menu", title: "📧 My Mail" }]
  }).catch(() => {});

  res.send(page("Connected", `<h1>✅ Connected</h1><div class="ok"><b>${esc(acc.email)}</b> is now on your WhatsApp.</div><p>${smtpOk ? "Replies will go out from your own address." : "We couldn't reach your outgoing mail server. Replies will be sent via ZimQuote, and answers will still come back to you."}</p><p>You can close this page and go back to WhatsApp.</p>`));
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
  const flash = req => (req.query.success ? `<div style="background:#dcfce7;color:#166534;padding:12px 14px;border-radius:8px;margin-bottom:14px">✅ ${e(req.query.success)}</div>` : "") + (req.query.error ? `<div class="alert red" style="margin-bottom:14px">❌ ${e(req.query.error)}</div>` : "");

  router.get("/mail", requireSupplierAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const filter = q ? { $or: [{ email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { ownerPhone: new RegExp(q.replace(/\D/g, "") || "^$") }] } : {};
      const accs = await MailAccount.find(filter).sort({ createdAt: -1 }).limit(300).lean();
      const now = Date.now(), day = new Date(now - 86400000);
      const [mails24, replies24] = await Promise.all([
        MailMessage.countDocuments({ receivedAt: { $gte: day } }),
        MailMessage.countDocuments({ "replies.sentAt": { $gte: day } })
      ]);
      const paid = accs.filter(a => a.paidUntil && new Date(a.paidUntil) > now).length;
      const trial = accs.filter(a => !(a.paidUntil && new Date(a.paidUntil) > now) && a.trialEndsAt && new Date(a.trialEndsAt) > now).length;
      const stuck = accs.filter(a => a.status === "setup" && new Date(a.createdAt).getTime() < now - 86400000).length;
      const rows = accs.map(a => {
        const st = a.status === "live" ? badge("🟢 Live", "green") : a.status === "setup" ? badge("🛠 Setup", "orange") : a.status === "error" ? badge("⚠️ Error", "red") : badge("⏸ Paused", "gray");
        const pl = a.paidUntil && new Date(a.paidUntil) > now ? badge(`Paid → ${fmt(a.paidUntil).split(",")[0]}`, "green") : a.trialEndsAt && new Date(a.trialEndsAt) > now ? badge(`Trial → ${fmt(a.trialEndsAt).split(",")[0]}`, "blue") : badge("Expired", "red");
        return `<tr>
<td><b>${e(a.email)}</b><br><small class="muted">${e(a.provider)} · ${a.mode === "imap" ? "email login" : "forwarding"}${a.imap?.lastError ? ` · ⚠️ ${e(String(a.imap.lastError).slice(0, 60))}` : ""}</small></td>
<td><a href="https://wa.me/${e(a.ownerPhone)}" target="_blank">+${e(a.ownerPhone)}</a>${(a.alertPhones || []).length ? `<br><small class="muted">+${(a.alertPhones || []).length} team</small>` : ""}</td>
<td>${st}<br>${pl}</td>
<td>${a.mailCount || 0} in · ${a.replyCount || 0} out<br><small class="muted">last ${fmt(a.lastMailAt)}</small></td>
<td style="white-space:nowrap">
<form method="post" action="/zq-admin/mail/${a._id}/extend" style="display:inline"><button class="btn btn-sm btn-green">+1 year</button></form>
<form method="post" action="/zq-admin/mail/${a._id}/trial" style="display:inline"><button class="btn btn-sm btn-gray">+14 days</button></form>
<form method="post" action="/zq-admin/mail/${a._id}/guide" style="display:inline"><button class="btn btn-sm btn-blue">Resend setup</button></form>
<br><small class="muted">fwd: ${e(forwardAddress(a))}</small></td></tr>`;
      }).join("");
      res.send(layout("ZimQuote Mail", `${flash(req)}
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">${stat(accs.length, "Inboxes", "blue")}${stat(paid, "Paid", "green")}${stat(trial, "On trial", "orange")}${stat(stuck, "Stuck in setup >1 day", "red")}${stat(mails24, "Emails 24h", "teal")}${stat(replies24, "Replies 24h", "teal")}</div>
<form method="get" style="margin-bottom:12px;display:flex;gap:8px"><input name="q" value="${e(q)}" placeholder="Search email or phone" style="flex:1"><button class="btn btn-blue">Search</button></form>
<p class="muted">Customers start on WhatsApp by typing <b>mail</b> (share link: <code>https://wa.me/263771143904?text=ZQ:MAIL</code>). "Stuck in setup" = call them and help them forward their email.</p>
<div class="table-wrap"><table><thead><tr><th>Inbox</th><th>Owner</th><th>Status</th><th>Activity</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No inboxes yet.</td></tr>`}</tbody></table></div>`));
    } catch (err) { res.status(500).send(layout("ZimQuote Mail", `<div class="alert red">${e(err.message)}</div>`)); }
  });

  const go = (res, kind, msg) => res.redirect(`/zq-admin/mail?${kind}=${encodeURIComponent(msg)}`);
  router.post("/mail/:id/extend", requireSupplierAdmin, async (req, res) => {
    const acc = await activatePaid(req.params.id, "", null, 365).catch(() => null);
    acc ? go(res, "success", `${acc.email} paid until ${fmt(acc.paidUntil)}`) : go(res, "error", "Inbox not found");
  });
  router.post("/mail/:id/trial", requireSupplierAdmin, async (req, res) => {
    const acc = await MailAccount.findById(req.params.id);
    if (!acc) return go(res, "error", "Inbox not found");
    const base = acc.trialEndsAt && acc.trialEndsAt > new Date() ? acc.trialEndsAt : new Date();
    acc.trialEndsAt = new Date(base.getTime() + 14 * 86400000); await acc.save();
    go(res, "success", `${acc.email} trial until ${fmt(acc.trialEndsAt)}`);
  });
  router.post("/mail/:id/guide", requireSupplierAdmin, async (req, res) => {
    const acc = await MailAccount.findById(req.params.id);
    if (!acc) return go(res, "error", "Inbox not found");
    const { sendSetupGuide } = await import("../services/mailInbox.js");
    await sendSetupGuide(acc.ownerPhone, acc).catch(() => {});
    go(res, "success", `Setup steps sent to +${acc.ownerPhone}`);
  });
}

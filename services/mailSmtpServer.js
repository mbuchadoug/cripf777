// services/mailSmtpServer.js
// ─────────────────────────────────────────────────────────────────────────────
// Optional built-in mail receiver for ZimQuote Mail (forwarding mode).
// Accepts email for *@MAIL_INBOUND_DOMAIN only and hands it to ingestRaw().
//
// Turn on with  MAIL_SMTP_LISTEN_PORT=2525  in .env and point port 25 at it:
//   sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
// DNS:  MX  mail.zimquote.co.zw  →  <your server hostname>  (priority 10)
// TLS (recommended): MAIL_SMTP_TLS_KEY=/etc/letsencrypt/live/mail.zimquote.co.zw/privkey.pem
//                    MAIL_SMTP_TLS_CERT=/etc/letsencrypt/live/mail.zimquote.co.zw/fullchain.pem
// If you'd rather not receive mail on the VPS, leave this off and use the
// Cloudflare Email Worker → POST /mail/inbound instead (see DEPLOY.md).
// ─────────────────────────────────────────────────────────────────────────────
import { ingestRaw, MAIL_CONFIG } from "./mailInbox.js";

export async function startMailSmtpServer() {
  const port = Number(process.env.MAIL_SMTP_LISTEN_PORT || 0);
  if (!port) return null;
  let SMTPServer;
  try { ({ SMTPServer } = await import("smtp-server")); }
  catch (_) { console.error("[MAIL SMTP] npm install smtp-server  (needed for MAIL_SMTP_LISTEN_PORT)"); return null; }

  // Optional TLS (Let's Encrypt cert for MAIL_INBOUND_DOMAIN) so senders can use STARTTLS with a valid cert
  let tls = {};
  try {
    if (process.env.MAIL_SMTP_TLS_KEY && process.env.MAIL_SMTP_TLS_CERT) {
      const fs = await import("fs");
      tls = { key: fs.readFileSync(process.env.MAIL_SMTP_TLS_KEY), cert: fs.readFileSync(process.env.MAIL_SMTP_TLS_CERT) };
    }
  } catch (e) { console.warn("[MAIL SMTP] TLS files not readable:", e.message); }

  const server = new SMTPServer({
    ...tls,
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: 30 * 1024 * 1024,
    banner: "ZimQuote Mail",
    logger: false,
    onRcptTo(address, session, cb) {
      const dom = String(address.address || "").toLowerCase().split("@")[1];
      if (dom !== MAIL_CONFIG.INBOUND_DOMAIN) return cb(new Error("550 Relay denied"));
      cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", async () => {
        const raw = Buffer.concat(chunks);
        if (stream.sizeExceeded) return cb(new Error("552 Message too big"));
        for (const r of session.envelope.rcptTo || []) {
          try { await ingestRaw(raw, { rcpt: r.address }); }
          catch (e) { console.error("[MAIL SMTP INGEST]", e.message); }
        }
        cb();
      });
    }
  });
  server.on("error", e => console.error("[MAIL SMTP]", e.message));
  server.listen(port, "0.0.0.0", () => console.log(`[MAIL SMTP] receiving for @${MAIL_CONFIG.INBOUND_DOMAIN} on port ${port}`));
  return server;
}

# ZimQuote Mail: business email on WhatsApp

Customers type **mail** on the ZimQuote WhatsApp, or open this link:
`https://wa.me/263771143904?text=ZQ:MAIL`.
They type their email address, follow the steps for their provider (about 2 minutes), and every new email then arrives on WhatsApp with three buttons: **↩️ Reply · 📄 Full email · ✅ Done**.

Pricing: **14 days free, then $60/year per inbox**, paid by EcoCash inside WhatsApp. You can change both in `.env`.

## 1. Upload

| File | New or changed | What it does |
|---|---|---|
| `models/mailAccount.js` | new | One connected inbox: owner, team numbers, plan |
| `models/mailMessage.js` | new | Received emails and the replies sent |
| `services/mailInbox.js` | new | Everything else: receiving, summaries, WhatsApp flow, replies, EcoCash, IMAP checking |
| `services/mailSmtpServer.js` | new | Optional: receives forwarded mail directly on your VPS |
| `routes/mailInbox.js` | new | `/mail/...` pages (setup guide, connect with password, attachments, inbound webhook) and the admin page |
| `services/chatbotEngine.js` | changed (4 small edits) | import, `mail_` taps, one top-level hook after Quote Desk, `rawText` parameter |
| `routes/meta_webhook.js` | changed (3 lines) | passes the original typed text (with capitals) so email replies aren't all lowercase |
| `server.js` | changed (6 lines) | mounts `/mail` before the body parsers and starts the inbox checker after MongoDB connects |

Nothing else changes. Install the new packages:

```
npm install mailparser imapflow nodemailer smtp-server
```

## 2. Admin page (2 lines in `routes/supplierAdmin.js`)

Next to the bikers lines:

```js
import { registerMailAdminRoutes } from "./mailInbox.js";
registerMailAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge, stat });
```

This gives you **/zq-admin/mail**: every inbox, its plan, whether it's stuck in setup, and buttons for **+1 year** (cash or bank payments), **+14 days**, and **Resend setup**.

## 3. `.env`

```
MAIL_INBOUND_DOMAIN=mail.zimquote.co.zw
MAIL_INBOUND_SECRET=<long random string>
MAIL_SECRET_KEY=<long random string, never change it once set>
MAIL_SUPPORT_PHONE=+263 78 990 1058
MAIL_PRICE_USD=60
MAIL_TRIAL_DAYS=14
MAIL_ALERT_TEMPLATE=zq_mail_alert

# SMTP used to send replies for customers who connected by forwarding
MAIL_OUT_HOST=mail.zimquote.co.zw      # or your cPanel mail server / Brevo / Zoho
MAIL_OUT_PORT=465
MAIL_OUT_USER=replies@zimquote.co.zw
MAIL_OUT_PASS=...
MAIL_OUT_FROM=replies@zimquote.co.zw
```

`OPENAI_API_KEY` is already in your `.env`. It's used for the short summaries and the **✨ Polish it** button (gpt-4o-mini, a fraction of a cent per email). Without it, the summary is the first lines of the email and Polish is hidden.

For `MAIL_SECRET_KEY`, run `openssl rand -hex 32`. It encrypts saved email passwords. If it's missing, the "connect with password" option is switched off and only forwarding is offered.

## 4. Receiving forwarded mail (choose ONE)

### Option A: on your VPS (no third party)
1. DNS for zimquote.co.zw: add `MX  mail  10  <your VPS hostname>` and an `A` record for that hostname.
2. In `.env`, set `MAIL_SMTP_LISTEN_PORT=2525`.
3. Point port 25 at it:
   `sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525`
   Also open port 25 in the VPS firewall. Some hosts block port 25, so ask yours.
4. Recommended: run `certbot certonly --standalone -d mail.zimquote.co.zw`, then set:
   ```
   MAIL_SMTP_TLS_KEY=/etc/letsencrypt/live/mail.zimquote.co.zw/privkey.pem
   MAIL_SMTP_TLS_CERT=/etc/letsencrypt/live/mail.zimquote.co.zw/fullchain.pem
   ```

### Option B: Cloudflare Email Routing (free, if zimquote.co.zw's DNS is on Cloudflare)
Enable Email Routing for `mail.zimquote.co.zw`. Then add a catch-all rule → **Send to a Worker** with:

```js
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    await fetch(`https://cripfcnt.com/mail/inbound?to=${encodeURIComponent(message.to)}`, {
      method: "POST",
      headers: { "x-mail-secret": env.MAIL_INBOUND_SECRET, "content-type": "message/rfc822" },
      body: raw
    });
  }
};
```

## 5. WhatsApp template (submit in Meta Business Manager)

Without this template, alerts only reach people who have messaged the bot in the last 24 hours.

- **Name:** `zq_mail_alert`
- **Category:** UTILITY
- **Language:** English

**Body:**
```
You have a new email in {{1}}.
From: {{2}}
Subject: {{3}}
Summary: {{4}}
Tap a button below to reply on WhatsApp, read the full email, or mark it done.
```

**Buttons (Quick reply):** `Reply` · `Full email` · `Done`

Sample values: `{{1}}` sales@acme.co.zw, `{{2}}` Jane Moyo (jane@delta.co.zw), `{{3}}` Purchase order 4471, `{{4}}` 200 cases of water at $4.50, delivery Friday.

Until the template is approved, the code falls back to normal buttons automatically.

## 6. Test (5 minutes)

1. On WhatsApp, type **mail** → **Connect my email** → type a Gmail address you own.
2. Follow the Gmail steps. The Gmail confirmation code should arrive on WhatsApp.
3. From another address, email the Gmail account. The alert should arrive.
4. Tap **Reply**, type a short note, tap **✨ Polish it**, then **✅ Send**. Check that the reply arrived and is threaded.
5. Company address on cPanel: you get a secure `/mail/connect/...` link. Enter the password. Replies then come from the customer's own address and are saved in their Sent folder.

## How each provider connects

| Address | Default way | Notes |
|---|---|---|
| Gmail / Google Workspace | Forwarding | Gmail's confirmation code is caught and sent to WhatsApp. App password possible on the connect page. |
| Outlook / Hotmail / Microsoft 365 | Forwarding | Some company Microsoft 365 setups block outside forwarding; their admin must allow it. |
| cPanel / local hosting (`@company.co.zw`) | Email password on a secure page (IMAP) | Server is pre-filled as `mail.<domain>`. Replies go from their own address and a copy goes to Sent. Forwarding is offered as an alternative. |
| Zoho, Yahoo, iCloud | Password (app password) or forwarding | Servers are pre-filled. |

# ZimQuote Mail v2: fix + set-up for clients + self-service web page

## What's fixed
**"ZQ:MAIL" opened "Request Sellers".** Your business was in another flow, so the mail module stepped aside. Now `ZQ:MAIL` always opens ZimQuote Mail, whatever the user was doing. Plain words like "mail" still give way to an open flow, so nobody's typing gets hijacked.

**New inboxes could miss their first email** when the inbox was empty at connect time. This is fixed too.

## Upload (5 files)

| File | Change |
|---|---|
| `services/mailInbox.js` | Deep link fix; finds the server automatically for .co.zw; handles the shared-hosting certificate problem; "🙋 Set it up for me"; web sign-up confirmation; set-up for clients; test emails |
| `routes/mailInbox.js` | Public sign-up page `/mail`, step-by-step status page, admin pages |
| `models/mailAccount.js` | Adds business name, set-up source, WhatsApp confirmation and help-request fields (all optional) |
| `routes/supplierAdmin.js` | Your latest file plus 2 lines (admin pages) and a **MAIL** section in the side menu |
| `routes/meta_webhook.js` | Same as last package (keeps capitals in typed replies). Skip it if you already uploaded it |

`chatbotEngine.js` doesn't change: the version you're running already has the mail hook. There are no new npm packages and no new `.env` settings.

## Set up email FOR a client (most Zimbabwean businesses)
**Admin → MAIL → ➕ Set up client email**

1. On the phone with the client, type their WhatsApp number, business name, email address and email password.
2. Click **Create inbox**. ZimQuote finds the mail server by itself:
   - It reads cPanel's autoconfig, then SRV and MX records, then tries `mail.<domain>`.
   - It logs in to check the password.
   - If the host's certificate doesn't match (very common on shared .co.zw hosting), it handles that automatically.
3. On the inbox page, click **📨 Send test email**. The client should see it on WhatsApp within 2 minutes.
4. Click **👋 WhatsApp welcome**. If the client hasn't messaged the bot in the last 24 hours, use **💬 Message client from my phone** instead.

No password? Leave it blank. The inbox page shows the client's private forwarding address. Add it in their cPanel (**Email → Forwarders**) or Gmail, then send a test email.

**🙋 Asked for help** lists everyone who tapped "Set it up for me", on WhatsApp or on the web page. You also get a WhatsApp alert with their number and a link to the right page.

## Self-service web page
Share **`https://cripfcnt.com/mail`**, or `zimquote.co.zw/mail` if nginx forwards `/mail` to the app.

1. The customer types their business name, email and WhatsApp number.
2. **Confirm WhatsApp:** one big green button opens WhatsApp with `ZQ:MAIL:AB12CD` typed in, and they press Send. This proves the number is theirs. It also opens the 24-hour window, so set-up messages arrive without a template. If they send it from a different WhatsApp than the one they typed, that number becomes the owner. Emails are held back until this step is done.
3. **Connect:**
   - Company email (.co.zw): they type their email password, and the server is found automatically.
   - Gmail / Outlook: forwarding steps with a Copy button.
   - Everyone: a **"🙋 Set it up for me"** button.
4. **Test email:** the page updates itself every 5 seconds and shows **✅ You're all set** when the first email arrives.

If someone signs up with an email that's already connected, the page doesn't reveal it. It tells them to type **mail** on WhatsApp.

## nginx (only if you want zimquote.co.zw/mail)
```
location /mail { proxy_pass http://127.0.0.1:9000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
```

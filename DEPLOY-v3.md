# ZimQuote Mail v3: receiving fixed, admin edit/delete, cleaner pages

Upload 2 files: `services/mailInbox.js` and `routes/mailInbox.js`. Nothing else changes.

## Why the test email didn't arrive
1. **Nothing received the forwarded mail.** The old forwarding address `…@mail.zimquote.co.zw` needs a DNS MX record plus a mail server on port 25. Neither was set up.
2. **`MAIL_OUT_HOST is not set`.** There was no mailbox to send the test email from.

## The fix: one normal mailbox on your cPanel does both jobs
1. In cPanel, open **Email Accounts** → **Create**. Make `zqmail@zimqoute.co.zw` with a strong password.
2. Add to `.env`:
   ```
   MAIL_COLLECTOR_USER=zqmail@zimqoute.co.zw
   MAIL_COLLECTOR_PASS=<that password>
   MAIL_COLLECTOR_HOST=mail.zimqoute.co.zw
   MAIL_SECRET_KEY=<run: openssl rand -hex 32>
   ```
3. Restart the app.
4. **Change your existing forwarder.** In cPanel → **Forwarders**, delete the old one (`info → 3d05d41c34@mail.zimquote.co.zw`). Add a new one:
   - Address to Forward: **info**
   - Destination: **Forward to Email Address** → **zqmail@zimqoute.co.zw**
5. In Admin → MAIL → your inbox, click **📨 Send test email**. It should appear on WhatsApp within about a minute.

How it works: ZimQuote checks `zqmail@` every 45 seconds. It works out whose email each message is from the original To / Envelope-to address, sends it to that client's WhatsApp, then deletes it from `zqmail@` (it's already saved in MongoDB). Set `MAIL_COLLECTOR_KEEP=1` to keep copies instead. The same mailbox also sends test emails and replies for clients who forward. `MAIL_OUT_*` is now optional.

All clients forward to the same `zqmail@zimqoute.co.zw`, so it's easy to explain on the phone. The admin **Inboxes** page shows whether the mailbox is being read, its last error, and a **🔄 Check now** button.

The **🔑 password option** is now on (`MAIL_SECRET_KEY`). For .co.zw clients it's still the quickest: it needs no forwarder at all.

## Admin: edit and delete
- **✏️ Edit inbox** on each inbox page: email, business name, owner WhatsApp, team numbers, sender name, alerts, status (pause), trial end, paid-until date, signature, and "switch back to forwarding".
- **🗑 Delete inbox:** type DELETE to confirm. This removes the inbox, its emails and its attachments.
- The forms are laid out in tidy columns.

## Client pages
- All pages have a ZimQuote Mail header.
- The cPanel forwarding steps are a **field → value table** that matches cPanel's form exactly. Customers can't put the address in the wrong box again.

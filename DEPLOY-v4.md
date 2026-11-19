# ZimQuote Mail v4: provider presets + system check

Upload 2 files: `services/mailInbox.js` and `routes/mailInbox.js`.

## Fix the error you saw (do this first)
`ERR_MODULE_NOT_FOUND` = the mail packages aren't installed on the server. In the app folder:
```
npm install mailparser imapflow nodemailer smtp-server
pm2 restart all --update-env      # or however you restart the app
```
`--update-env` matters: without it, pm2 keeps the old `.env` values. That's why the page still says "Receiving forwarded email is not set up".

Admin → MAIL now opens with a **System check** that lists exactly what's missing: packages, the forwarding mailbox, sending, the password key, AI and the admin phone.

## Provider presets
The **Email provider** list appears on: admin **Connect with the client's password**, **Set up for a client**, and the customer's own connect page. Picking a provider fills in the servers and ports and shows a note:

| Provider | IMAP | SMTP | Note |
|---|---|---|---|
| Company .co.zw (cPanel) | mail.<domain>:993 | mail.<domain>:465 | normal password |
| Gmail / Workspace | imap.gmail.com:993 | smtp.gmail.com:465 | needs an **App Password** |
| Yahoo | imap.mail.yahoo.com:993 | smtp.mail.yahoo.com:465 | needs an **App Password** |
| Outlook / Hotmail / Live | outlook.office365.com:993 | smtp-mail.outlook.com:587 | Microsoft blocks most password logins → use **forwarding** |
| Microsoft 365 (company) | outlook.office365.com:993 | smtp.office365.com:587 | often blocked → forwarding |
| Zoho | imap.zoho.com:993 | smtp.zoho.com:465 | enable IMAP in Zoho |
| iCloud | imap.mail.me.com:993 | smtp.mail.me.com:587 | app-specific password |

"Find automatically" is still the default.

## Your own inbox (info@zimqoute.co.zw)
Your Outlook screenshots show the same servers the system detects: `mail.zimqoute.co.zw`, IMAP 993 SSL, SMTP 465 SSL. After the npm install and restart, open the inbox in admin, keep the provider on **Company email**, type the password and click **Test & connect**. Then click **📨 Send test email**.

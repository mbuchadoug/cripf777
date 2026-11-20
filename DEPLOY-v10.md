# ZimQuote Mail v10: Cc / Bcc / Reply all, New email, alerts never lost

## Upload (2 files) and restart
- services/mailInbox.js
- routes/mailInbox.js
No new packages. chatbotEngine.js does not change.

## Emails outside the 24-hour window (the important part)
WhatsApp only lets a business message someone who hasn't written in 24 hours with an
APPROVED template. Profile-view alerts work because their template is approved.
Email alerts need this one approved too:

WhatsApp Manager → Message templates → Create
- Category: Utility
- Name: zq_mail_alert
- Language: English
- Body:
    You have a new email in {{1}}.
    From: {{2}}
    Subject: {{3}}
    Summary: {{4}}
    Tap a button below to reply on WhatsApp, read the full email, or mark it done.
- Buttons, Quick reply: Reply · Full email · Done
- Samples: {{1}} sales@acme.co.zw · {{2}} Jane Moyo (jane@delta.co.zw) · {{3}} Order 77 · {{4}} Wants 50 cases by Friday

Optional .env, so Admin → MAIL → System check shows Meta's approval status:
    WHATSAPP_BUSINESS_ACCOUNT_ID=<your WABA id>
Then: pm2 restart all --update-env

Until it's approved, nothing is lost: alerts that can't be delivered are kept and
sent the moment the person next messages the bot ("N new emails arrived while you were away").
If the template was made as English (US), that works too.

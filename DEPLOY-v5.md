# ZimQuote Mail v5: Mail menu, inbox pages, POP3, plans, suppliers

Upload 4 files:
- `services/mailInbox.js`
- `routes/mailInbox.js`
- `models/mailAccount.js`
- `services/metaMenus.js`

`chatbotEngine.js` and `server.js` don't change.

Then run, from `/var/www/cripf777`:
```
npm install --save node-pop3
pm2 restart cripfcnt --update-env
```

## What's new
**📧 Business Email in the menus.** It appears in:
- the main menu (business home, sellers, new users)
- the seller's 🏪 My Store menu

**Simpler WhatsApp flow.**
- **Step 1:** type your email.
- **Step 2:** pick how to connect. The easiest option for that provider is shown first:
  - company email (.co.zw / .com / .org) → 🔑 *Use my password*
  - Gmail and Outlook → ↪️ *Forward emails*
  - Yahoo and iCloud → 🔑 *App password*
- **🙋 Set it up for me** is always offered.

**Inbox in pages, with numbers.**
- Seven emails per page: `1. 🔵 Jane - …`.
- **➡️ Older / ⬅️ Newer** buttons.
- Type a number (e.g. `9`) to open that email, or **more** for the next page.

**POP3 support.** For older company mail servers. IMAP is tried first, then POP3. You can also force POP3 with **Incoming mail type** on the web and admin forms. Mail is read without deleting anything from the server.

**Never "just fails".**
- If WhatsApp rejects a menu, the same options come as a numbered text menu.
- Opening Mail clears a stuck "Request a Quote" typing state. That stuck state is why "hi" got the *"Please use the full product name"* reply.

**Plans (annual only).** Prices can be changed in `.env` with `MAIL_PRICE_STARTER`, `MAIL_PRICE_BUSINESS` and `MAIL_PRICE_PRO`.

| Plan | Price/year | WhatsApp alerts per month | Staff numbers |
|---|---|---|---|
| Starter | $60 | 300 | 1 |
| Business | $120 | 1,000 | 3 |
| Pro | $240 | 3,000 | 5 |

- **Listed ZimQuote sellers:** 25% off automatically (`MAIL_SUPPLIER_DISCOUNT=0.25`).
- **Free trial:** 14 days with Business limits.
- **Over the monthly allowance:** only important emails (orders, quotes, payments, tenders) are alerted. The owner gets one message with an Upgrade button. Every email is still saved in 📬 Inbox.

**Admin.**
- **Suppliers:** Set up client email → **Connect a listed supplier's email**. Search, then **Set up email** pre-fills their number and business name.
- **Set-up form:** "Already paid? Activate a plan".
- **Inbox page:**
  - **Activate 1 year** with a plan choice
  - **⛔ Deactivate**
  - a plan selector under Edit
  - this month's alert usage
  - POP3 / IMAP shown
- **Delete** works as before.

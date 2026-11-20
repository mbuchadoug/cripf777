# ZimQuote Mail v8: inboxes belong to registered businesses

## Upload (3 files)
| File | Where |
|---|---|
| `services/mailInbox.js` | services/ |
| `routes/mailInbox.js` | routes/ |
| `models/mailAccount.js` | models/ |

No new packages, no .env changes. `chatbotEngine.js` and `supplierAdmin.js` don't change. Restart: `pm2 restart all`.

## What's new
- **Register first.** Only businesses registered on ZimQuote can connect an email (listed sellers and their contact numbers, Business-tools owners/managers/staff, schools). Others get a "Register your business first" message with a Register button, on WhatsApp and on the web page.
- **One business, many emails.** sales@, accounts@, info@... each can go to different WhatsApp numbers. The business owner sees and manages all of them in My Mail.
- **Many numbers per email.** In the inbox menu, 👥 WhatsApp numbers: add or remove numbers, and the owner can stop getting the emails while staff keep getting them.
- **Admin.** "ZimQuote business" field when setting up an email (name, phone or picked from supplier search), "Other WhatsApp numbers" and "Owner also gets these emails". Inbox list shows the business; click it to see all its emails and connect another.

## Existing inboxes
Nothing stops. Each one is linked to its owner's business the next time the owner opens it. Inboxes whose owner has no registered business keep working; link them in Admin → Edit → ZimQuote business.

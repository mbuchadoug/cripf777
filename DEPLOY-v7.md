# ZimQuote Mail v7: 1-day free trial + prices shown up front

## Upload (2 files)
| File | Change |
|---|---|
| `services/mailInbox.js` | Trial is now 1 day. Plans and prices show in the intro, when an email is added, when it connects, and in the admin welcome message, with a 💳 Choose a plan button. Trial reminder comes ~6 hours before it ends (paid plans: 7 days before). |
| `routes/mailInbox.js` | Web sign-up page says "Try it 1 day free". The status page shows when the trial ends and the 3 plans. Admin buttons are now **+1 day trial** and **+7 days trial**. |

No new packages. Restart: `pm2 restart all`.

## Check your .env
If `.env` has `MAIL_TRIAL_DAYS=14`, delete that line (or set it to `1`), or the old 14 days stays.
Inboxes that were already on a 14-day trial keep their end date. Change it under Admin → MAIL → inbox → Edit if you want.
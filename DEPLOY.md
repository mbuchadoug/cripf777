# ZimQuote: interest groups for targeted broadcasts

Built on the exact supplierAdmin.js / chatbotEngine.js you uploaded (your current server files).
The current Broadcast Hub works as before; this adds a 4th audience option and an Audiences page.

## Files (/var/www/cripf777)
NEW      services/audienceSegments.js   groups people by interest, Claude classification, opt-outs
NEW      routes/audienceAdmin.js        /zq-admin/audiences + the Broadcast Hub panel
REPLACE  routes/supplierAdmin.js        +🎯 Interest groups in Broadcast Hub Step 1, 🎯 Audiences in the sidebar,
                                        opted-out numbers dropped from every broadcast mode
REPLACE  services/chatbotEngine.js      replies to UNSUBSCRIBE / SUBSCRIBE

    pm2 restart cripfcnt --update-env

No new packages. Groups build automatically 3 minutes after start and every 6 hours
(or press 🔄 Rebuild on /zq-admin/audiences).

.env (optional)
    ANTHROPIC_API_KEY=...         already set for search - enables "🤖 Classify with Claude"
    ZQ_AI_MODEL=claude-haiku-5-5  same model setting as the search
    ZQ_AUDIENCE_AUTOBUILD=off     only if you want manual rebuilds

## Use it
1. /zq-admin/audiences → 🔄 Rebuild now (first time) → check the group sizes.
2. Press 🤖 Classify with Claude so the searches the rules couldn't place get sorted
   (300 most common per run). Fix any by hand in "Searches nobody could place yet".
3. Press 📣 Broadcast on a group (or Broadcast Hub → Step 1 → 🎯 Interest groups),
   tick groups, choose "last 90 days", "2+ times", city, buyers only → live count.
4. Pick the template (Step 2) and send - either "Send" or the 🚀 Batch Sender (batch size,
   auto/manual batches, pause/resume/abort, skip people who already got this template).

Tip: end marketing templates with "Reply UNSUBSCRIBE to stop these messages." It protects your
WhatsApp number's quality rating - people who unsubscribe are never messaged again.

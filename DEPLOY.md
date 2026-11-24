# ZimQuote - Find, Buy & Hire + smarter search + Pay Now

Copy into /var/www/cripf777:
  services/chatbotEngine.js, metaMenus.js, supplierSearch.js, sellerChat.js, buyerRequests.js
  services/searchBrain.js, findMenu.js, sellerPay.js        (NEW)
  models/supplierProfile.js                                   (adds `payments` block)
Then: pm2 restart all

## .env (all optional - everything works without them)
ANTHROPIC_API_KEY=sk-ant-...     # turns on Claude search understanding + zero-result rescue
ZQ_AI_MODEL=claude-haiku-5-5     # small, fast, cheap model
ZQ_AI_DAILY_CAP=3000             # max AI calls per day
ZQ_AI_SEARCH=off                 # kill switch
ZQ_SECRET=<long random string>   # encrypts sellers' Paynow keys in the database

## Paynow
Needs the `paynow` npm package (already used for subscriptions). If missing: npm i paynow
Sellers connect their OWN Paynow integration: My Store -> More Options -> Accept EcoCash.

## Optional Meta template (UTILITY) - seller payment alert outside 24h
Name: seller_payment_received
  Payment received on ZimQuote.
  Business: {{1}}
  Amount: {{2}}
  From: {{3}}
  Reference: {{4}}
  This is an automated payment alert from ZimQuote.
Until approved, sellers get the alert as a normal WhatsApp message (24h window).

## Quick tests
1. "find electrician harare"  -> electricians first, cable shops after
2. "hi" -> Find, Buy & Hire -> reply 1 -> reply 1  (no "Which city?")
3. "cement" (no city) -> results straight away (last city, else all Zimbabwe)
4. Seller: More Options -> Accept EcoCash -> paste ID + key; buyer orders -> Pay Now

## v3 - search audit (read-only)
  node scripts/searchAudit.mjs                         # default queries, Harare
  node scripts/searchAudit.mjs "electrician,plumber" bulawayo
Writes search-audit-<date>.txt in the project folder. Changes nothing in the database.

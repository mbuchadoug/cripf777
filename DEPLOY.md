# ZimQuote v4 - Categories, Classify Sellers, Search Tester

Copy into /var/www/cripf777 (same folders as in this zip), then:
  pm2 restart cripfcnt --update-env

NEW
  routes/categoryAdmin.js       /zq-admin/categories, /zq-admin/categorize, /zq-admin/search-tester
  models/searchCategory.js      your categories + extra keywords for built-in ones
  services/categoryRegistry.js  merges built-in + your categories (60 s cache)
CHANGED
  routes/supplierAdmin.js       3 lines: import, register, sidebar links
  models/supplierProfile.js     + searchTags, classifiedAt, classifiedBy
  services/supplierSearch.js    uses tags + category keywords; tolerant city match
  services/searchBrain.js       admin keywords in query understanding; Claude "Suggest"
  services/findMenu.js          your categories appear in Find, Buy & Hire groups
  scripts/searchAudit.mjs       knows your categories + tags
UNCHANGED since v3 (included so the zip is complete)
  chatbotEngine.js, metaMenus.js, sellerChat.js, buyerRequests.js, sellerPay.js

Suggested first hour:
  1. /zq-admin/categorize → "Fix city/suburb spelling"
  2. /zq-admin/categories → map every "unknown category id" (top red box)
  3. /zq-admin/categorize?status=live → Classify / ✨ Suggest for each live seller
  4. /zq-admin/search-tester → electrician / plumber / cement in Harare
  5. node scripts/searchAudit.mjs → "fixable" should drop to 0

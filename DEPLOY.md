# ZimQuote v5 - Sections → Categories, category-first search, fast reclassify

Copy all folders into /var/www/cripf777, then:  pm2 restart cripfcnt --update-env
(v5 contains everything from v4; no database migration needed - old custom
categories keep working and land in the "Other" section until you move them.)

Changed since v4:
  services/categoryRegistry.js  sections + default placement/keywords for all built-in categories
  services/searchBrain.js       category & section keywords → buyer intent ("named" = category-first)
  services/supplierSearch.js    category-first ranking, wider candidate pool (200)
  services/findMenu.js          Find, Buy & Hire menu = your sections & categories, live
  routes/categoryAdmin.js       new Categories page, inline classify, bulk ALL-matching, auto-assign
  models/searchCategory.js      kind (section/category), section, order

First 30 minutes:
  1. /zq-admin/categories  - rename built-ins to buyer words (e.g. "⚡ Electrical Services" → "⚡ Electricians"),
                             add keywords where you see "no keywords", add your own sections/categories.
  2. /zq-admin/categorize  - "Auto-assign by words": electric → Electricians, plumb → Plumbers, weld → Welders…
  3. Filter "No category" → add categories inline (or ✨ for ticked sellers).
  4. /zq-admin/search-tester - electrician / plumbers / trades / cement.

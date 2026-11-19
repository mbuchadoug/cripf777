# ZimQuote: Corporate plan ($200/year)

Upload these 6 files. Nothing else changes.

| File | Change |
|---|---|
| services/supplierPlans.js | New `corporate` plan: $200, annual only (365 days) |
| models/supplierProfile.js | `tier` can now be `corporate` (built on the bikers-security version) |
| services/supplierRegistration.js | Corporate after payment: up to 500 live items, Business package `gold`, shown first in search and matching |
| services/chatbotEngine.js | "🏢 Corporate $200/yr" added to the 3 plan lists; 6 item limits; 🏢 badge on profile |
| services/metaMenus.js | Corporate added to the Upgrade menu and the account label |
| services/supplierSearch.js | 🏢 badge in search results |

Button id: `sup_plan_corporate_annual`. It uses the existing payment flow (EcoCash/Paynow).

Test: as a seller, open Upgrade, pick 🏢 Corporate. It should ask for $200 USD (annual).

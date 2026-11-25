// services/navContext.js
// ─── Per-message context for the WhatsApp engine ─────────────────────────────
// Every incoming message runs inside one AsyncLocalStorage context (set in
// chatbotEngine.handleIncomingMessage). It lets any module know:
//   • nested  - this handleIncomingMessage call is an internal dispatch
//               (the engine calling itself), not something the user sent
//   • replay  - the user pressed "back" and we are re-showing an earlier
//               screen; "someone viewed your profile" alerts must NOT go out
//               again (they cost a template message and confuse the seller)
// Kept in its own tiny file (no imports) so notification modules can use it
// without import cycles.
import { AsyncLocalStorage } from "node:async_hooks";

export const navStore = new AsyncLocalStorage();

/** True while a "back" replay is re-showing an earlier screen. */
export function isNavReplay() {
  try { return !!navStore.getStore()?.replay; } catch (_) { return false; }
}

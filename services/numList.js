// services/numList.js
// ─── Which numbered list did the user see LAST? ──────────────────────────────
//
// ZimQuote sends several kinds of numbered lists, each with its own "reply with
// a number" handler:
//   seller → sellerSearchList (search results)        tempData.sellerPick
//   school → schoolSearch (school results)            tempData.schoolResultIds
//   group  → groupSmartLink (ZQ:GROUP/SGROUP/TGROUP)   tempData.grpListIds
//   find   → findMenu (Find, Buy & Hire sections)     tempData.zqFind
//   tutor  → tutorSearch (tutor results)              tempData.tutorSearch.resultIds
//   inst   → institutionSearch (college results)
//
// Each list stays saved after it is sent, so an OLD list could answer a number
// meant for a NEWER one (e.g. school results on screen, but "5" answered by a
// seller search from earlier: "Your last search found 3 sellers…").
//
// Fix: every list records itself here when it is sent:
//     tempData.numList = { k: "<kind>", at: <ms> }
// and every number handler steps aside when a DIFFERENT kind of list is the
// latest one. Sessions without the marker behave exactly as before.
// Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const FRESH_MS = 24 * 60 * 60 * 1000;   // older markers are ignored

/** Record that a numbered list of `kind` was just sent to `from`. */
export async function markNumList(from, kind) {
  try {
    const phone = String(from || "").replace(/\D+/g, "");
    if (!phone || !kind) return;
    const UserSession = (await import("../models/userSession.js")).default;
    await UserSession.updateOne(
      { phone },
      { $set: { "tempData.numList": { k: String(kind), at: Date.now() } } },
      { upsert: true }
    );
  } catch (e) { console.warn("[NUMLIST MARK]", e.message); }
}

/** Kind of the latest numbered list in this session's tempData, or null. */
export function latestNumList(td) {
  const n = td?.numList;
  if (!n || !n.k || !n.at) return null;
  if (Date.now() - Number(n.at) > FRESH_MS) return null;
  return String(n.k);
}

/**
 * True when a DIFFERENT kind of list was sent more recently than `kind`, so the
 * `kind` handler must not take this number. No marker → false (old behaviour).
 */
export function newerListThan(td, kind) {
  const k = latestNumList(td);
  return !!k && k !== kind;
}

/** Same check straight from the database (for modules that don't hold tempData). */
export async function newerListThanFor(from, kind) {
  try {
    const phone = String(from || "").replace(/\D+/g, "");
    const UserSession = (await import("../models/userSession.js")).default;
    const s = await UserSession.findOne({ phone }, { "tempData.numList": 1 }).lean();
    return newerListThan(s?.tempData, kind);
  } catch (_) { return false; }
}

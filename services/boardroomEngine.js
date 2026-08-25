// services/boardroomEngine.js
// ─── WhatsApp handler for ZQ:BR:* deep links ─────────────────────────────────
//
// Closes the loop: buttons in the Boardroom OS web front open WhatsApp with a
// ZQ:BR:* payload; the engine's top-level intercept calls this handler.
//
// DECOUPLED BY DESIGN: `sendText` / `sendButtons` are INJECTED by the caller so
// this file never imports engine internals (avoids circular deps and keeps the
// engine's proven module graph untouched). Returns true if it handled the text,
// false to let the engine fall through — same contract as handleGroupSmartLink.
//
// Member connect is intentionally NOT handled here — it stays as ZQ:SUPPLIER:<id>
// so it lands on the existing, tracked supplier card + quote flow.

import { Boardroom, BoardroomOpportunity, BoardroomEvent } from "./boardroomBridge.js";

const digits = (v) => String(v || "").replace(/\D/g, "");

export async function handleBoardroomDeepLink({ from, text = "", sendText /*, sendButtons */ }) {
  const t = String(text).trim();
  if (!/^ZQ:BR:/i.test(t)) return false;

  // ── ZQ:BR:OPP:<id> — express interest in an opportunity ────────────────────
  let m = t.match(/^ZQ:BR:OPP:([a-f0-9]{24})$/i);
  if (m) {
    const opp = await BoardroomOpportunity.findById(m[1]).lean();
    if (!opp || !opp.active) return false;
    await BoardroomOpportunity.findByIdAndUpdate(m[1], { $inc: { interestCount: 1 } });
    const board = await Boardroom.findOne({ slug: opp.boardroomSlug }).lean();
    const owner = board?.ownerName || "the organiser";
    const ownerWa = digits(board?.ownerPhone);
    await sendText(
      from,
      [
        `📌 *${opp.title}*`,
        opp.org ? `🏢 ${opp.org}` : "",
        opp.deadline ? `⏳ Closes ${opp.deadline}` : "",
        "",
        opp.detail || "",
        "",
        `✅ Your interest is noted. ${owner} will follow up with you right here on WhatsApp.`,
        ownerWa ? `Prefer to reach out directly? wa.me/${ownerWa}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  }

  // ── ZQ:BR:EVT:<id> — reserve a seat / start ticket purchase ────────────────
  m = t.match(/^ZQ:BR:EVT:([a-f0-9]{24})$/i);
  if (m) {
    const evt = await BoardroomEvent.findById(m[1]).lean();
    if (!evt || !evt.active) return false;
    await BoardroomEvent.findByIdAndUpdate(m[1], { $inc: { rsvpCount: 1 } });
    const board = await Boardroom.findOne({ slug: evt.boardroomSlug }).lean();
    const ownerWa = digits(board?.ownerPhone);
    await sendText(
      from,
      [
        `🎟 *${evt.title}*`,
        evt.series ? `🎤 ${evt.series}` : "",
        evt.dateText ? `📅 ${evt.dateText}` : "",
        evt.venue ? `📍 ${evt.venue}` : "",
        evt.priceText ? `💵 ${evt.priceText}` : "",
        "",
        `To confirm your seat: pay via EcoCash / InnBucks, then send your proof of payment here and we'll add you to the list.`,
        ownerWa ? `Questions? wa.me/${ownerWa}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  }

  // ── ZQ:BR:<slug> — open the Boardroom directory on WhatsApp ────────────────
  m = t.match(/^ZQ:BR:([a-z0-9_-]{1,60})$/i);
  if (m) {
    const board = await Boardroom.findOne({ slug: m[1].toLowerCase(), active: true }).lean();
    if (!board) return false;
    await sendText(
      from,
      [
        `👋 Welcome to *${board.name}*`,
        board.tagline ? `_${board.tagline}_` : "",
        "",
        `Tell me what you need — for example "accountant", "office cleaning", or "PR" — and I'll show you members who can help.`,
        board.ownerName ? `\nCurated by ${board.ownerName}.` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  }

  return false;
}
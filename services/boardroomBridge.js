// services/boardroomBridge.js
// ─── The Boardroom OS ↔ ZimQuote bridge ──────────────────────────────────────
//
// The Boardroom is NOT a new app or a new chatbot vertical. It is a *branded
// view* over an existing ZimQuote supplier group, plus two net-new verticals
// (Opportunities, Events). This module is deliberately DECOUPLED from the
// chatbot engine - it only touches models + pure serializers, so it can be
// imported by both the web JSON API and the WhatsApp handler with no risk to
// the running engine.
//
// REUSE (no engine change needed):
//   • Directory      → existing SupplierProfile documents
//   • Member connect → existing ZQ:SUPPLIER:<id> deep link + card + quote flow
//   • Analytics      → existing trackLinkEvent() (views, conversions, per-source)
//
// ADD (net-new):
//   • Boardroom config doc  (brand, owner, member list, ecosystem pillars)
//   • BoardroomOpportunity  (Tender / Job / Collaboration / Funding / Service)
//   • BoardroomEvent        (masterclasses, breakfasts - EcoCash / InnBucks)
//
// Deep-link payload families (plain text, handled top-level like ZQ:GROUP):
//   ZQ:BR:<slug>     → open a Boardroom (directory intro on WhatsApp)
//   ZQ:BR:OPP:<id>   → express interest in an opportunity
//   ZQ:BR:EVT:<id>   → reserve a seat / start ticket purchase
//   (member connect stays as ZQ:SUPPLIER:<id> - proven, tracked, unchanged)

import mongoose from "mongoose";
import SupplierProfile from "../models/supplierProfile.js";
import { buildDeepLink } from "./supplierSmartLink.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL = `https://wa.me/${BOT_NUMBER}`;
const waLink = (payload) => `${BOT_WA_URL}?text=${encodeURIComponent(payload)}`;

// ─── Models ─────────────────────────────────────────────────────────────────
// Guarded with mongoose.models.* so hot-reload / repeated imports never throw
// "OverwriteModelError" - matches the ZimQuote codebase convention.

const boardroomSchema = new mongoose.Schema(
  {
    slug:       { type: String, unique: true, index: true }, // "the-boardroom"
    name:       String,                                      // "The Boardroom"
    ownerName:  String,                                      // "Kim Sibanda"
    ownerPhone: String,                                      // Kim's WhatsApp (digits)
    brandColor: { type: String, default: "#CB4A1E" },
    tagline:    String,
    groupSlug:  String,                                      // optional: existing ZQ:GROUP source
    memberSupplierIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile" }],
    pillars:    [{ label: String, note: String }],           // ecosystem strip
    active:     { type: Boolean, default: true },
    createdAt:  { type: Date, default: Date.now },
  },
  { collection: "boardrooms" }
);

const opportunitySchema = new mongoose.Schema(
  {
    boardroomSlug: { type: String, index: true },
    type:  { type: String, enum: ["Tender", "Job", "Collaboration", "Funding", "Service"], default: "Collaboration" },
    title: String,
    org:   String,
    detail: String,
    deadline: String,          // free text ("5 Sep 2026" / "Rolling")
    postedByPhone: String,
    boosted: { type: Boolean, default: false },
    active:  { type: Boolean, default: true },
    interestCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "boardroom_opportunities" }
);

const eventSchema = new mongoose.Schema(
  {
    boardroomSlug: { type: String, index: true },
    series:   String,          // "On The MIC" / "The Boardroom"
    title:    String,
    dateText: String,          // "Sat 6 Sep 2026 · 09:00"
    venue:    String,
    priceText: String,         // "$25 · EcoCash / InnBucks"
    priceUsd: Number,
    capacity: Number,
    rsvpCount: { type: Number, default: 0 },
    active:   { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "boardroom_events" }
);

export const Boardroom =
  mongoose.models.Boardroom || mongoose.model("Boardroom", boardroomSchema);
export const BoardroomOpportunity =
  mongoose.models.BoardroomOpportunity || mongoose.model("BoardroomOpportunity", opportunitySchema);
export const BoardroomEvent =
  mongoose.models.BoardroomEvent || mongoose.model("BoardroomEvent", eventSchema);

// ─── Payload + URL builders ──────────────────────────────────────────────────

export const brOppPayload   = (oppId)   => `ZQ:BR:OPP:${oppId}`;
export const brEventPayload = (eventId) => `ZQ:BR:EVT:${eventId}`;
export const brOpenPayload  = (slug)    => `ZQ:BR:${slug}`;

// Member connect deliberately reuses the proven supplier deep link so it lands
// on the existing card + quote flow and is tracked by trackLinkEvent().
export const brMemberUrl = (supplierId) => buildDeepLink(String(supplierId));
export const brOppUrl    = (oppId)   => waLink(brOppPayload(oppId));
export const brEventUrl  = (eventId) => waLink(brEventPayload(eventId));
export const brOpenUrl   = (slug)    => waLink(brOpenPayload(slug));

// ─── Serializers (web JSON shape) ─────────────────────────────────────────────

const CATEGORY_LABELS = {
  cleaning: "Facilities", plumbing: "Facilities", electrical: "Facilities",
  accounting: "Finance", legal: "Legal", marketing: "Marketing & Media",
  media: "Marketing & Media", solar: "Manufacturing", logistics: "Logistics",
  catering: "Hospitality", tech: "Tech", software: "Tech",
};

export function serializeMember(s) {
  const rateTeaser  = (s.rates || []).slice(0, 3).map((r) => r.service).join(" · ");
  const priceTeaser = (s.prices || [])
    .filter((p) => p.inStock !== false)
    .slice(0, 3)
    .map((p) => p.product)
    .join(" · ");
  const cat = (s.categories || [])[0] || "general";
  return {
    id: String(s._id),
    name: s.businessName,
    sector: CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1),
    location:
      [s.location?.area, s.location?.city].filter(Boolean).join(", ") ||
      s.location?.city ||
      "Zimbabwe",
    offers:
      rateTeaser ||
      priceTeaser ||
      (s.listedProducts || []).slice(0, 3).join(" · ") ||
      "",
    verified: !!s.verified,
    tier: s.tier || "free",
    featured: s.tier === "pro" || s.tier === "premium" || s.topSupplierBadge === true,
    connectUrl: brMemberUrl(s._id),
    connectPayload: `ZQ:SUPPLIER:${String(s._id)}`,
    views: s.zqLinkViews || 0,
  };
}

export async function resolveBoardroomMembers(boardroom) {
  if (!boardroom || !boardroom.memberSupplierIds || !boardroom.memberSupplierIds.length) {
    return [];
  }
  const suppliers = await SupplierProfile.find({
    _id: { $in: boardroom.memberSupplierIds },
    active: true,
    suspended: { $ne: true },
  }).lean();

  return suppliers
    .map(serializeMember)
    .sort((a, b) => Number(b.featured) - Number(a.featured) || b.views - a.views);
}

export function serializeOpportunity(o) {
  return {
    id: String(o._id),
    type: o.type,
    title: o.title,
    org: o.org,
    detail: o.detail,
    deadline: o.deadline,
    boosted: !!o.boosted,
    interestUrl: brOppUrl(o._id),
    interestPayload: brOppPayload(o._id),
  };
}

export function serializeEvent(e) {
  return {
    id: String(e._id),
    series: e.series,
    title: e.title,
    date: e.dateText,
    venue: e.venue,
    price: e.priceText,
    reserveUrl: brEventUrl(e._id),
    reservePayload: brEventPayload(e._id),
  };
}
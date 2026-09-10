// services/coursePayments.js
// ─────────────────────────────────────────────────────────────────────────────
// Self-contained course-enrollment payments. Deliberately does NOT go through
// routes/payments.js::processSuccessfulPayment (that path applies subscription
// logic). Payment state lives on the Enrollment doc; success flips it to active.
//
//   EcoCash (Paynow) : USSD push → frontend polls → activate
//   Stripe (card)    : Checkout redirect → webhook → activate
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import Stripe from "stripe";
import paynow from "./paynow.js";
import Enrollment from "../models/enrollment.js";
import { activateByPaymentRef } from "./enrollmentService.js";

const SITE_URL = process.env.SITE_URL || "https://cripfcnt.com";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function normalizeZwPhone(phone) {
  return String(phone || "").replace(/\s|-/g, "").replace(/^\+263/, "0").replace(/^263/, "0");
}

// ── EcoCash: send the USSD push ──────────────────────────────────────────────
export async function initCourseEcocash({ user, course, enrollment, phone }) {
  const normalized = normalizeZwPhone(phone);
  if (!/^07[7-8]\d{7}$/.test(normalized)) {
    return { success: false, error: "Enter a valid EcoCash number (e.g. 0771234567)" };
  }
  const reference = `CRS-${crypto.randomUUID()}`;
  const pr = paynow.createPayment(reference, user.email || `${normalized}@ecocash.local`);
  pr.add(`${course.title} - course enrollment`, course.price || 0);

  const response = await paynow.sendMobile(pr, normalized, "ecocash");
  if (!response.success) return { success: false, error: response.error || "Failed to send EcoCash prompt." };

  enrollment.payment.provider = "ecocash";
  enrollment.payment.reference = reference;
  enrollment.payment.pollUrl = response.pollUrl;
  enrollment.payment.amount = course.price || 0;
  enrollment.payment.currency = course.currency || "USD";
  enrollment.payment.status = "pending";
  await enrollment.save();

  return { success: true, reference, message: `Check ${normalized} and approve the EcoCash prompt.` };
}

// ── EcoCash: poll + activate on success ──────────────────────────────────────
export async function pollCourseEcocash({ reference, userId }) {
  const e = await Enrollment.findOne({ "payment.reference": reference, user: userId });
  if (!e) return { status: "not_found" };
  if (e.status === "active" || e.status === "completed") return { status: "paid" };
  if (!e.payment.pollUrl) return { status: "pending" };

  const result = await paynow.pollTransaction(e.payment.pollUrl);
  const s = String(result.status || "").toLowerCase();
  if (s === "paid") {
    await activateByPaymentRef({ reference, provider: "ecocash" });
    return { status: "paid" };
  }
  if (s === "failed" || s === "cancelled") {
    e.payment.status = "failed"; await e.save();
    return { status: s };
  }
  return { status: "pending" };
}

// ── Stripe: create a Checkout session ────────────────────────────────────────
export async function createCourseCheckout({ user, course, enrollment }) {
  if (!stripe) return { error: "Card payments not configured" };
  const reference = `CRS-${crypto.randomUUID()}`;
  enrollment.payment.provider = "stripe";
  enrollment.payment.reference = reference;
  enrollment.payment.amount = course.price || 0;
  enrollment.payment.currency = course.currency || "USD";
  enrollment.payment.status = "pending";
  await enrollment.save();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: (course.currency || "USD").toLowerCase(),
        product_data: { name: `${course.title} - course enrollment` },
        unit_amount: Math.round((course.price || 0) * 100)
      },
      quantity: 1
    }],
    metadata: { type: "course_enrollment", enrollmentId: String(enrollment._id), reference },
    success_url: `${SITE_URL}/courses/${course.slug}?paid=1`,
    cancel_url: `${SITE_URL}/courses/${course.slug}?cancelled=1`,
    customer_email: user.email || undefined
  });
  return { url: session.url, reference };
}

// ── Stripe: webhook handler (call this from stripe_webhook.js) ───────────────
export async function handleCourseEnrollmentStripe(session) {
  const meta = session.metadata || {};
  if (meta.type !== "course_enrollment") return;
  if (meta.reference) {
    await activateByPaymentRef({ reference: meta.reference, provider: "stripe" });
  } else if (meta.enrollmentId) {
    const e = await Enrollment.findById(meta.enrollmentId);
    if (e && e.status !== "active" && e.status !== "completed") {
      e.status = "active"; e.activatedAt = new Date();
      e.payment.provider = "stripe"; e.payment.status = "paid"; e.payment.paidAt = new Date(); e.source = "payment";
      await e.save();
    }
  }
}
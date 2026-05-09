import axios from "axios";
import { sendText } from "./metaSender.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

function normPhone(raw = "") {
  let p = String(raw || "").replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

function makeSearchReference() {
  return `SR-${Date.now().toString().slice(-6)}`;
}

export function buildSearchContinueLink(reference) {
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(`ZQ:SEARCH:${reference}`)}`;
}

export async function sendBuyerSearchHelpTemplate({ phone, searchText, suppliers = [], adminNote = "" }) {
  const to = normPhone(phone);

  const reference = makeSearchReference();
  const searchDetails = String(searchText || "your request").slice(0, 80);
  const continueLink = buildSearchContinueLink(reference);

  const PID =
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    process.env.META_PHONE_NUMBER_ID ||
    process.env.PHONE_NUMBER_ID;

  const TOKEN =
    process.env.META_ACCESS_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN;

  try {
    await axios.post(
      `https://graph.facebook.com/v24.0/${PID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "buyer_request_results_ready",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: reference },
                { type: "text", text: searchDetails },
                { type: "text", text: continueLink }
              ]
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return {
      ok: true,
      reference,
      continueLink
    };
  } catch (err) {
    console.warn("[BUYER REQUEST RESULTS TEMPLATE FAILED]", err?.response?.data || err.message);

    await sendText(
      to,
      `Hi 👋🏾

Your recent ZimQuote request has been processed.

Request reference: ${reference}

Request details: ${searchDetails}

To view the available results and continue on WhatsApp, open:
${continueLink}

Thank you for using ZimQuote.`
    ).catch(() => {});

    return {
      ok: false,
      reference,
      continueLink,
      error: err.message
    };
  }
}
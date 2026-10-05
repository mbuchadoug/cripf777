// services/cripfcntWhatsApp.js
// ─────────────────────────────────────────────────────────────────────────────
// Sender for the CRIPFCnt Resources Limited WhatsApp number ONLY.
// Deliberately separate from services/metaSender.js (ZimQuote) so the two bots
// never share a token or phone number ID - a reply can never go out from the
// wrong business's number.
//
// .env:
//   CRIPFCNT_WA_TOKEN=            permanent system-user token (CRIPFCnt portfolio)
//   CRIPFCNT_WA_PHONE_NUMBER_ID=  from WhatsApp → API Setup (NOT the phone number)
//   CRIPFCNT_WA_GRAPH_VERSION=v24.0   (optional)
//   CRIPFCNT_WA_AUTH_TEMPLATE=cripfcnt_login_code   (optional, once approved)
// ─────────────────────────────────────────────────────────────────────────────
import axios from "axios";

const GRAPH = () => `https://graph.facebook.com/${process.env.CRIPFCNT_WA_GRAPH_VERSION || "v24.0"}`;

function cfg() {
  const token = process.env.CRIPFCNT_WA_TOKEN;
  const phoneId = process.env.CRIPFCNT_WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error("CRIPFCnt WhatsApp is not configured (CRIPFCNT_WA_TOKEN / CRIPFCNT_WA_PHONE_NUMBER_ID).");
  return { token, phoneId };
}

async function post(payload) {
  const { token, phoneId } = cfg();
  try {
    const r = await axios.post(
      `${GRAPH()}/${phoneId}/messages`,
      { messaging_product: "whatsapp", ...payload },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return r.data;
  } catch (e) {
    const err = e.response?.data?.error;
    console.error("[CRIPFCnt WA send]", err ? `${err.code} ${err.message}` : e.message);
    throw e;
  }
}

export const sendText = (to, body) =>
  post({ to, type: "text", text: { body, preview_url: true } });

// Up to 3 reply buttons. buttons: [{ id, title }]
export const sendButtons = (to, body, buttons) =>
  post({
    to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: String(b.title).slice(0, 20) } })) }
    }
  });

// List menu, up to 10 rows. rows: [{ id, title, description? }]
export const sendList = (to, body, buttonText, rows, sectionTitle = "Menu") =>
  post({
    to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: String(buttonText).slice(0, 20),
        sections: [{
          title: sectionTitle.slice(0, 24),
          rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: String(r.title).slice(0, 24), description: String(r.description || "").slice(0, 72) }))
        }]
      }
    }
  });

// Blue ticks - best effort, never throws.
export const markRead = (messageId) =>
  post({ status: "read", message_id: messageId }).catch(() => {});

// Login / sign-up code via the approved Authentication template (copy-code button).
// Works outside the 24-hour window, so it can be used by the web + mobile login.
export const sendAuthCode = (to, code) =>
  post({
    to, type: "template",
    template: {
      name: process.env.CRIPFCNT_WA_AUTH_TEMPLATE || "cripfcnt_login_code",
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: String(code) }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(code) }] }
      ]
    }
  });
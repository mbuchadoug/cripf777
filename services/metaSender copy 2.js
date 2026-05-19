import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API = `https://graph.facebook.com/v24.0/${process.env.PHONE_NUMBER_ID}/messages`;

const headers = {
  Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
  "Content-Type": "application/json"
};

/* =========================
   BASIC TEXT
========================= */
export async function sendText(to, text) {
  return axios.post(
    API,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    { headers }
  );
}

/* =========================
   BUTTONS
========================= */
/*export async function sendButtons(to, bodyText, buttons) {
  return axios.post(
    API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map(b => ({
            type: "reply",
            reply: {
              id: b.id,
              title: b.title
            }
          }))
        }
      }
    },
    { headers }
  );
}*/

export async function sendButtons(to, payloadOrText, maybeButtons) {
  let payload;

  // ✅ backward compatibility
  if (typeof payloadOrText === "string") {
    payload = {
      text: payloadOrText,
      buttons: Array.isArray(maybeButtons) ? maybeButtons : []
    };
  } else {
    payload = payloadOrText;
  }

  if (!Array.isArray(payload.buttons)) {
    throw new Error("sendButtons: buttons must be an array");
  }

  return axios.post(
    API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: payload.text },
        action: {
          buttons: payload.buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title }
          }))
        }
      }
    },
    { headers }
  );
}



/* =========================
   LIST (THIS WAS MISSING 🔥)
========================= */
/*export async function sendList(to, bodyText, buttonText, sections) {
  return axios.post(
    API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonText,
          sections
        }
      }
    },
    { headers }
  );
}*/


// services/metaSender.js

export async function sendList(to, titleOrConfig, items) {
  let bodyText, buttonLabel, sections;

  if (typeof titleOrConfig === "object" && titleOrConfig !== null) {
    // Sectioned call: sendList(to, { text, buttonLabel, sections })
    bodyText    = titleOrConfig.text        || "Options";
    buttonLabel = titleOrConfig.buttonLabel || "Select";
    sections    = (titleOrConfig.sections || []).map(s => ({
      title: String(s.title || "Options").slice(0, 24),
      rows: (s.rows || []).map(r => ({
        id: r.id,
        title: String(r.title || "").slice(0, 24),
        ...(r.description ? { description: String(r.description).slice(0, 72) } : {})
      }))
    }));
  } else {
    // Flat call: sendList(to, "Title string", [...rows])
    bodyText    = titleOrConfig;
    buttonLabel = "Select";
    sections    = [
      {
        title: "Options",
        rows: (items || []).map(i => ({
          id: i.id,
          title: String(i.title || "").slice(0, 24),
          ...(i.description ? { description: String(i.description).slice(0, 72) } : {})
        }))
      }
    ];
  }

  return axios.post(
    API,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections
        }
      }
    },
    { headers }
  );
}


export async function sendDocument(to, document) {
  return axios.post(API, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document
  }, { headers });
}

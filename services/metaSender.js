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

export async function sendList(to, title, items) {
  return axios.post(API, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: title },
      action: {
        button: "Select",
        sections: [
          {
            title: "Options",
            rows: items.map(i => ({
              id: i.id,
              title: i.title
            }))
          }
        ]
      }
    }
  }, { headers });
}

export async function sendDocument(to, document) {
  return axios.post(API, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document
  }, { headers });
}

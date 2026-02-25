import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v24.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Env required:
 *  - META_ACCESS_TOKEN
 *  - META_PHONE_NUMBER_ID
 *  - META_BIZ_SETUP_FLOW_ID
 * Optional:
 *  - META_BIZ_SETUP_FLOW_SCREEN (default "BUSINESS_SETUP")
 */
export async function sendBusinessSetupFlow(to) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const flowId = process.env.META_BIZ_SETUP_FLOW_ID;
  const screen = process.env.META_BIZ_SETUP_FLOW_SCREEN || "BUSINESS_SETUP";

  if (!token || !phoneNumberId || !flowId) {
    throw new Error(
      "Missing META_ACCESS_TOKEN / META_PHONE_NUMBER_ID / META_BIZ_SETUP_FLOW_ID env vars"
    );
  }

  const normalizedTo = to.replace(/\D+/g, "");

  return axios.post(
    `${GRAPH}/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "🏢 Business Setup" },
        body: { text: "Please fill in these details to set up your business." },
        footer: { text: "Zimqoute" },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: flowId,
            flow_cta: "Start setup",
            flow_action: "navigate",
            flow_action_payload: { screen }
          }
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );
}
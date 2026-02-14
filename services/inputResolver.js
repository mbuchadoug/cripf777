export function normalizeInput({ text, interactive }) {
  if (interactive?.button_reply?.id) {
    return interactive.button_reply.id;
  }

  if (interactive?.list_reply?.id) {
    return interactive.list_reply.id;
  }

  return text?.trim().toLowerCase() || "";
}

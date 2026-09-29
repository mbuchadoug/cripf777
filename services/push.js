// services/push.js — send notifications via Expo Push (delivers over FCM on Android, APNs on iOS).
// No Firebase SDK needed on the server — Expo's HTTPS endpoint handles both platforms.
import PushToken from "../models/pushToken.js";

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";

export async function sendPushToUsers(userIds, { title, body, data = {} }) {
  try {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).map(String).filter(Boolean);
    if (!ids.length) return { sent: 0 };
    const rows = await PushToken.find({ user: { $in: ids }, active: true }).select("token").lean();
    const messages = rows
      .map((r) => r.token)
      .filter((t) => typeof t === "string" && t.startsWith("ExponentPushToken"))
      .map((to) => ({ to, sound: "default", title, body, data }));
    if (!messages.length) return { sent: 0 };

    let sent = 0;
    for (let i = 0; i < messages.length; i += 100) {           // Expo accepts up to 100/request
      const batch = messages.slice(i, i + 100);
      try {
        const r = await fetch(EXPO_PUSH, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(batch)
        });
        if (r.ok) sent += batch.length;
      } catch (_) {}
    }
    return { sent };
  } catch (e) { console.error("[push] send failed", e.message); return { sent: 0 }; }
}
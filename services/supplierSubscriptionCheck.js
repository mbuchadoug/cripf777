// services/supplierSubscriptionCheck.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendButtons } from "./metaSender.js";

export async function checkSupplierSubscriptions() {
  const now = new Date();

  // Find expired active suppliers
  const expired = await SupplierProfile.find({
    subscriptionStatus: "active",
    subscriptionEndsAt: { $lt: now }
  });

  for (const supplier of expired) {
    // Deactivate listing
    await SupplierProfile.findByIdAndUpdate(supplier._id, {
      active: false,
      subscriptionStatus: "expired"
    });

    // Notify supplier
    await sendButtons(supplier.phone, {
      text: `⚠️ *Listing Expired*\n\n` +
            `Your ZimQuote supplier listing\n` +
            `has expired and is no longer visible.\n\n` +
            `Renew to get back in front of buyers.`,
      buttons: [
        { id: "supplier_upgrade", title: "🔄 Renew Now" },
        { id: "menu", title: "🏠 Main Menu" }
      ]
    });
  }

  // Send 3-day renewal reminders
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const expiringSoon = await SupplierProfile.find({
    subscriptionStatus: "active",
    subscriptionEndsAt: { $lt: threeDaysFromNow, $gt: now }
  });

  for (const supplier of expiringSoon) {
    await sendButtons(supplier.phone, {
      text: `🔔 *Listing expiring soon!*\n\n` +
            `Your listing expires in 3 days.\n` +
            `Renew now to stay visible to buyers.`,
      buttons: [
        { id: "supplier_upgrade", title: "🔄 Renew Now" },
        { id: "menu", title: "🏠 Main Menu" }
      ]
    });
  }
}
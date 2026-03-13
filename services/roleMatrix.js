export const ROLE_MATRIX = {
  owner: {
    // Owner sees everything, including owner_only items
    allow: ["*"]
  },

  admin: {
    allow: [
      "sales",
      "clients",
      "payments",
      "reports",
      "branches",
      "users",
      "settings"
      // ✅ owner_only intentionally excluded
    ]
  },

  manager: {
    allow: [
      "sales",
      "clients",
      "payments",
      "reports",
      "settings"
      // ✅ owner_only intentionally excluded - no subscription/upgrade
    ]
  },

  clerk: {
    allow: [
      "sales",
      "clients",
      "payments",
      "reports"
      // ✅ owner_only intentionally excluded - no subscription/upgrade
    ]
  }
};
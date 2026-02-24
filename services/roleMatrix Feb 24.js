export const ROLE_MATRIX = {
  owner: {
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
    ]
  },

  manager: {
    allow: [
      "sales",
      "clients",
      "payments",
      "reports",
      "settings"
    ]
  },

  clerk: {
    allow: [
      "sales",
      "clients",
      "payments",
      "reports"
    ]
  }
};

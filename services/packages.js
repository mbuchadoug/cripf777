export const PACKAGES = {
  trial: {
    users: 1,
    branches: 1,

    // 🔒 HARD CAP
    monthlyDocs: 10,

    features: [
      "invoice" // ✅ ONLY invoices
      // ❌ remove quote, receipt, payments, reports, users, branches
    ]
  },

  bronze: {
    users: 2,
    branches: 1,
    monthlyDocs: 50,
    features: [
      "invoice",
      "quote",
      "receipt",
      "clients",
      "payments"
    ]
  },

  silver: {
    users: 5,
    branches: 3,
    monthlyDocs: 200,
    features: [
      "invoice",
      "quote",
      "receipt",
      "clients",
      "payments",
      "reports_daily"
    ]
  },

  gold: {
    users: 10,
    branches: 10,
    monthlyDocs: 1000,
    features: [
      "invoice",
      "quote",
      "receipt",
      "clients",
      "payments",
      "reports_daily",
      "reports_weekly",
      "reports_monthly",
      "branches",
      "users"
    ]
  }
};

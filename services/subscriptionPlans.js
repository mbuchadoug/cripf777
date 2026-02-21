export const SUBSCRIPTION_PLANS = {
  bronze: {
    key: "bronze",
    name: "Bronze",
    price: 1,          // USD
    currency: "USD",   // ✅ MUST MATCH MERCHANT
    durationDays: 30
  },
  silver: {
    key: "silver",
    name: "Silver",
    price: 5,
    currency: "USD",
    durationDays: 30
  },
  gold: {
    key: "gold",
    name: "Gold",
    price: 0.05,
    currency: "USD",
    durationDays: 30
  }
};

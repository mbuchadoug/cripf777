export const PACKAGE_FEATURES = {
  trial: {
    invoice: true,
    receipt: false,
    quote: false,
    reports_daily: true,
    reports_advanced: false,
    invite_user: false,
    upload_logo: false
  },

  bronze: {
    invoice: true,
    receipt: true,
    quote: true,
    reports_daily: true,
    reports_advanced: false,
    invite_user: false,
    upload_logo: false
  },

  silver: {
    invoice: true,
    receipt: true,
    quote: true,
    reports_daily: true,
    reports_advanced: false,
    invite_user: true,
    upload_logo: true
  },

  gold: {
    invoice: true,
    receipt: true,
    quote: true,
    reports_daily: true,
    reports_advanced: true,
    invite_user: true,
    upload_logo: true
  }
};

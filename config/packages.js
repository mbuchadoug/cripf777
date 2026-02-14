const PACKAGES = {
   trial: {
    label: "Trial",
    users: 1,
    branches: 1,
    documentsPerMonth: 3,
    features: {
      logo: false,
      reports: [],
      inviteUsers: false,
      branchReports: false
    }
  },
  bronze: {
    label: "Bronze",
    documentsPerMonth: 20,
    users: 1
  },
  silver: {
    label: "Silver",
    documentsPerMonth: 60,
    users: 3
  },
  gold: {
    label: "Gold",
    documentsPerMonth: 200,
    users: 10
  },
  enterprise: {
    label: "Enterprise",
    documentsPerMonth: 999999,
    users: 999
  }
};

export default PACKAGES;

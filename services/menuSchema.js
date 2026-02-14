export const MENU_SCHEMA = {
  owner: [
    {
      section: "🧾 Documents",
      items: [
        { id: "invoice:new", label: "New Invoice" },
        { id: "receipt:new", label: "New Receipt", feature: "receipt" },
        { id: "quote:new", label: "New Quotation" }
      ]
    },
    {
      section: "💰 Money",
      items: [
        { id: "payment:new", label: "Record Payment (IN)" },
        { id: "expense:new", label: "Record Expense (OUT)" }
      ]
    },
    {
      section: "📊 Reports",
      items: [
        { id: "reports", label: "Reports & Statements" }
      ]
    },
    {
      section: "⚙️ Business",
      items: [
        { id: "clients", label: "Clients" },
        { id: "branches", label: "Branches" },
        { id: "users", label: "Users", feature: "invite_user" },
        { id: "settings", label: "Settings" },
        { id: "upgrade", label: "🚀 Upgrade Plan" }
      ]
    }
  ],

  manager: [
    {
      section: "🧾 Documents",
      items: [
        { id: "invoice:new", label: "New Invoice" },
        { id: "receipt:new", label: "New Receipt", feature: "receipt" },
        { id: "quote:new", label: "New Quotation" }
      ]
    },
    {
      section: "💰 Money",
      items: [
        { id: "payment:new", label: "Record Payment (IN)" },
        { id: "expense:new", label: "Record Expense (OUT)" }
      ]
    },
    {
      section: "📊 Reports",
      items: [
        { id: "reports", label: "Reports & Statements" }
      ]
    }
  ],

  clerk: [
    {
      section: "🧾 Documents",
      items: [
        { id: "invoice:new", label: "New Invoice" }
      ]
    },
    {
      section: "💰 Money",
      items: [
        { id: "payment:new", label: "Record Payment (IN)" },
        { id: "expense:new", label: "Record Expense (OUT)" }
      ]
    },
    {
      section: "📊 Reports",
      items: [
        { id: "reports:daily", label: "Daily Summary" }
      ]
    }
  ]
};

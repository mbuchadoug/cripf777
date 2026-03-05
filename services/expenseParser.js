// services/expenseParser.js
/**
 * Natural Language Expense Parser
 * Converts casual text into structured expense data
 */

/**
 * Predefined expense categories with keywords
 */
const CATEGORY_KEYWORDS = {
  Food: ['lunch', 'dinner', 'breakfast', 'food', 'meal', 'snack', 'drinks', 'tea', 'coffee', 'cake'],
  Travel: ['transport', 'fuel', 'petrol', 'diesel', 'taxi', 'bus', 'kombi', 'travel', 'trip'],
  Office: ['stationery', 'paper', 'pens', 'pencils', 'folders', 'files', 'printing', 'copies'],
  Utilities: ['electricity', 'water', 'internet', 'wifi', 'airtime', 'data', 'phone'],
  Maintenance: ['repairs', 'fixing', 'maintenance', 'cleaning', 'paint'],
  Supplies: ['stock', 'supplies', 'materials', 'goods', 'inventory'],
  Salaries: ['salary', 'wages', 'pay', 'payment', 'staff'],
  Rent: ['rent', 'rental', 'lease'],
  Marketing: ['advertising', 'ads', 'marketing', 'promo', 'flyers'],
  Other: []
};

/**
 * Extract amount from text
 * Handles: "50", "$50", "50.00", "50 dollars", "fifty dollars"
 */
function extractAmount(text) {
  // Remove currency symbols and normalize
  const cleaned = text.replace(/[$€£ZWL\s]/gi, '');
  
  // Try to find number patterns
  const patterns = [
    /(\d+(?:\.\d{1,2})?)/,  // 50 or 50.00
    /(\d+)\s*(?:dollars?|zwl|usd)/i  // 50 dollars
  ];
  
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const amount = parseFloat(match[1]);
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }
  
  return null;
}

/**
 * Detect category from description
 */
function detectCategory(description) {
  const lowerDesc = description.toLowerCase();
  
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === 'Other') continue;
    
    for (const keyword of keywords) {
      if (lowerDesc.includes(keyword)) {
        return category;
      }
    }
  }
  
  return 'Other';
}

/**
 * Extract description from text (removes amount and connectors)
 */
function extractDescription(text, amount) {
  let desc = text;
  
  // Remove the amount
  if (amount) {
    desc = desc.replace(new RegExp(`\\$?${amount}(?:\\.00)?`), '');
  }
  
  // Remove common connectors
  desc = desc.replace(/\b(for|to|on|at|spent|bought|paid)\b/gi, '');
  
  // Clean up
  desc = desc.trim().replace(/\s+/g, ' ');
  
  // Capitalize first letter
  if (desc.length > 0) {
    desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  }
  
  return desc || 'Expense';
}

/**
 * Main parser: converts natural text to expense object
 * 
 * Examples:
 * "50 for lunch" → {amount: 50, description: "Lunch", category: "Food"}
 * "30 transport" → {amount: 30, description: "Transport", category: "Travel"}
 * "25 stationery items" → {amount: 25, description: "Stationery items", category: "Office"}
 */
/**
 * Parse single expense from format: "description amount"
 * Examples: "lunch 10", "fuel 50", "office supplies 25"
 */
export function parseSingleExpense(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  
  const trimmed = text.trim();
  if (!trimmed) return null;
  
  // Match pattern: "description number" or "number description"
  // Examples: "lunch 10", "10 lunch", "office supplies 25"
  
  // Try: description followed by number
  let match = trimmed.match(/^(.+?)\s+(\d+(?:\.\d{1,2})?)$/);
  
  if (match) {
    const description = match[1].trim();
    const amount = parseFloat(match[2]);
    
    if (description && amount > 0) {
      const category = detectCategory(description);
      return {
        amount,
        description: capitalizeFirst(description),
        category,
        success: true
      };
    }
  }
  
  // Try: number followed by description
  match = trimmed.match(/^(\d+(?:\.\d{1,2})?)\s+(.+)$/);
  
  if (match) {
    const amount = parseFloat(match[1]);
    const description = match[2].trim();
    
    if (description && amount > 0) {
      const category = detectCategory(description);
      return {
        amount,
        description: capitalizeFirst(description),
        category,
        success: true
      };
    }
  }
  
  return null;
}

/**
 * Parse multiple expenses from comma-separated format
 * Example: "lunch 10, cables 5, transport 20"
 */
export function parseBulkExpenseText(text) {
  if (!text || typeof text !== 'string') {
    return { error: "Invalid input", expenses: [] };
  }
  
  const trimmed = text.trim();
  
  // Split by comma
  const items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  
  if (items.length === 0) {
    return { error: "No expenses found", expenses: [] };
  }
  
  const expenses = [];
  const failed = [];
  
  for (const item of items) {
    const parsed = parseSingleExpense(item);
    if (parsed) {
      expenses.push(parsed);
    } else {
      failed.push(item);
    }
  }
  
  if (expenses.length === 0) {
    return { 
      error: "Couldn't parse any expenses. Use format: lunch 10, fuel 20", 
      expenses: [] 
    };
  }
  
  return {
    expenses,
    failed: failed.length > 0 ? failed : null,
    success: true
  };
}

/**
 * Capitalize first letter of string
 */
function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format expense for display
 */
export function formatExpense(expense, index = null) {
  const prefix = index ? `[${index}] ` : '';
  const emoji = getCategoryEmoji(expense.category);
  return `${prefix}${emoji} $${expense.amount.toFixed(2)} - ${expense.description} (${expense.category})`;
}

/**
 * Get emoji for category
 */
function getCategoryEmoji(category) {
  const emojis = {
    Food: '🍽️',
    Travel: '🚗',
    Office: '📝',
    Utilities: '💡',
    Maintenance: '🔧',
    Supplies: '📦',
    Salaries: '💰',
    Rent: '🏠',
    Marketing: '📢',
    Other: '💵'
  };
  return emojis[category] || '💵';
}

/**
 * Format bulk expense summary
 */
export function formatBulkSummary(expenses) {
  const total = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  
  // Group by category
  const byCategory = {};
  expenses.forEach(exp => {
    const cat = exp.category || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + exp.amount;
  });
  
  let summary = `📊 *Summary - ${expenses.length} expenses totaling $${total.toFixed(2)}*\n\n`;
  
  // Show breakdown by category
  for (const [cat, amount] of Object.entries(byCategory)) {
    const emoji = getCategoryEmoji(cat);
    summary += `${emoji} ${cat}: $${amount.toFixed(2)}\n`;
  }
  
  return summary;
}

/**
 * Validate parsed expense
 */
export function validateExpense(expense) {
  if (!expense.amount || expense.amount <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }
  
  if (!expense.description || expense.description.length < 2) {
    return { valid: false, error: "Description too short" };
  }
  
  return { valid: true };
}
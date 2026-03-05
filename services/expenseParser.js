// services/expenseParser.js
/**
 * Natural Language Expense Parser
 * Converts comma-separated text into structured expense data
 */

/**
 * Predefined expense categories with keywords
 */
const CATEGORY_KEYWORDS = {
  Food: ['lunch', 'dinner', 'breakfast', 'food', 'meal', 'snack', 'drinks', 'tea', 'coffee', 'cake', 'rice', 'bread'],
  Travel: ['transport', 'fuel', 'petrol', 'diesel', 'taxi', 'bus', 'kombi', 'travel', 'trip'],
  Office: ['stationery', 'paper', 'pens', 'pencils', 'folders', 'files', 'printing', 'copies'],
  Utilities: ['electricity', 'water', 'internet', 'wifi', 'airtime', 'data', 'phone'],
  Maintenance: ['repairs', 'fixing', 'maintenance', 'cleaning', 'paint'],
  Supplies: ['stock', 'supplies', 'materials', 'goods', 'inventory', 'cables', 'ram', 'equipment'],
  Salaries: ['salary', 'wages', 'pay', 'payment', 'staff'],
  Rent: ['rent', 'rental', 'lease'],
  Marketing: ['advertising', 'ads', 'marketing', 'promo', 'flyers'],
  Other: []
};

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
 * Capitalize first letter of string
 */
function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

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
 * Get emoji for category
 */
export function getCategoryEmoji(category) {
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
 * Format expense for display
 */
export function formatExpense(expense, index = null) {
  const prefix = index ? `[${index}] ` : '';
  const emoji = getCategoryEmoji(expense.category);
  return `${prefix}${emoji} $${expense.amount.toFixed(2)} - ${expense.description} (${expense.category})`;
}

/**
 * Format bulk expense summary
 */
export function formatBulkSummary(expenses, currency = '$') {
  const total = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  
  // Group by category
  const byCategory = {};
  expenses.forEach(exp => {
    const cat = exp.category || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + exp.amount;
  });
  
  let summary = `📊 *Summary - ${expenses.length} expenses totaling ${currency}${total.toFixed(2)}*\n\n`;
  
  // Show breakdown by category
  for (const [cat, amount] of Object.entries(byCategory)) {
    const emoji = getCategoryEmoji(cat);
    summary += `${emoji} ${cat}: ${currency}${amount.toFixed(2)}\n`;
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

/**
 * Format multiple expenses for display
 */
export function formatExpenseList(expenses, startIndex = 1, currency = '$') {
  let output = '';
  expenses.forEach((exp, idx) => {
    const emoji = getCategoryEmoji(exp.category);
    const num = startIndex + idx;
    output += `[${num}] ${emoji} ${currency}${exp.amount.toFixed(2)} - ${exp.description} (${exp.category})\n`;
  });
  return output;
}

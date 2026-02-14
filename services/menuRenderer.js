export function renderMenuText(menu) {
  let index = 1;
  let map = {};

  let text = "📋 Main Menu\n\n";

  for (const section of menu) {
    text += `${section.section}\n`;
    for (const item of section.items) {
      const label = item.locked ? `🔒 ${item.label}` : item.label;
      text += `${index}) ${label}\n`;
      map[index] = item;
      index++;
    }
    text += "\n";
  }

  text += "0) Menu";

  return { text, map };
}

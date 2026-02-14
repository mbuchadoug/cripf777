import { PACKAGE_FEATURES } from "../config/packageFeatures.js";

export function filterMenuByPackage(menu, biz) {
  const pkg = biz?.package || "trial";

  return menu.map(section => ({
    ...section,
    items: section.items.map(item => {
      if (!item.feature) return item;

      const allowed = PACKAGE_FEATURES[pkg]?.[item.feature];
      return {
        ...item,
        locked: !allowed
      };
    })
  }));
}

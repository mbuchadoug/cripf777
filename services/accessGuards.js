import { PACKAGES } from "./packages.js";
import { sendText } from "./metaSender.js";
import { sendPackagesMenu } from "./metaMenus.js";


export function canUseFeature(biz, feature) {
  const pkg = PACKAGES[biz.package] || PACKAGES.trial;
  return pkg.features.includes(feature);
}

export async function promptUpgrade({ biz, from, feature }) {
  biz.sessionState = "choose_package";
  biz.sessionData = {};
  await biz.save();

  await sendText(
    from,
    `🔒 *${feature}* is not available on your current package.\n\nPlease upgrade to continue.`
  );

  await sendPackagesMenu(from, biz.package);
}


export function requiredPackageForFeature(feature) {
  for (const [pkg, cfg] of Object.entries(PACKAGES)) {
    if (cfg.features.includes(feature)) {
      return pkg;
    }
  }
  return null;
}

export function hasRole(userRole, allowedRoles) {
  return allowedRoles.includes(userRole);
}

import { ROLE_MATRIX } from "./roleMatrix.js";


export function canAccessSection(role, section) {
  const config = ROLE_MATRIX[role];
  if (!config) return false;

  if (config.allow.includes("*")) return true;

  return config.allow.includes(section);
}

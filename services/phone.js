export function normalizePhone(input = "") {
  let phone = String(input).replace(/\D+/g, "");

  if (phone.startsWith("0")) {
    phone = "263" + phone.slice(1);
  }

  if (phone.startsWith("263") && phone.length === 12) {
    return phone;
  }

  return phone;
}

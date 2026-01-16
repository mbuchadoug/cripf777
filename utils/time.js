export function formatZimDateTime(date) {
  if (!date) return "-";

  return new Intl.DateTimeFormat("en-ZW", {
    timeZone: "Africa/Harare",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(date));
}

export function formatZimDate(date) {
  if (!date) return "-";

  return new Intl.DateTimeFormat("en-ZW", {
    timeZone: "Africa/Harare",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(date));
}

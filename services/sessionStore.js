// services/sessionStore.js
const sessions = new Map();

export function getSession(key) {
  if (!sessions.has(key)) {
    sessions.set(key, {});
  }
  return sessions.get(key);
}

export function setSession(key, value) {
  sessions.set(key, value);
}

export function clearSession(key) {
  sessions.delete(key);
}

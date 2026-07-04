// Tiny JSON-file store: seen products, sent log, suppression list.
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const EMPTY = { seen: {}, sent: [], suppress: [] };

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return structuredClone(EMPTY);
  return { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
}

export function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function markSeen(state, key) {
  state.seen[key] = new Date().toISOString();
}

export function alreadySeen(state, key) {
  return Boolean(state.seen[key]);
}

export function alreadyEmailed(state, email) {
  const lower = email.toLowerCase();
  return (
    state.suppress.includes(lower) ||
    state.sent.some((s) => s.email.toLowerCase() === lower)
  );
}

export function sentToday(state) {
  const today = new Date().toISOString().slice(0, 10);
  return state.sent.filter((s) => s.date.startsWith(today)).length;
}

export function logSent(state, entry) {
  state.sent.push({ ...entry, date: new Date().toISOString() });
}

export function suppress(state, email) {
  const lower = email.toLowerCase();
  if (!state.suppress.includes(lower)) state.suppress.push(lower);
}

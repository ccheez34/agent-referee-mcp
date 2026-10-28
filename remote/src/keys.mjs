/** Agent Referee's receipt-signing key (key ID 375ba8b346776e2f), pinned like the local MCP server's. */
export const REFEREE_KEY = "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";

/** The pinned key plus any extra ones set in EXTRA_PUBLIC_KEYS (comma-separated; for staging and tests). */
export function publicKeys(env) {
  const extra = String(env.EXTRA_PUBLIC_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [REFEREE_KEY, ...extra.filter((k) => k !== REFEREE_KEY)];
}

// Wires config, local storage and the tools into an MCP server.
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentReferee } from "agent-referee-client";
import { createMcpServer, runStdio } from "./protocol.mjs";
import { createTools, defaultPayingFetch } from "./tools.mjs";
import { Budget, ReceiptStore, toMicro } from "./store.mjs";

export const VERSION = "0.5.0";

/** Agent Referee's receipt-signing key (key ID 375ba8b346776e2f), pinned so a faked key page can't fool a check. */
export const REFEREE_KEY = "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";

export const INSTRUCTIONS =
  "Agent Referee is a neutral third party for AI agents. Use tiebreak when you and an agent from a different owner are stuck and neither should decide alone; agree on a key and settings with the other agent first. Use sealed_review when someone else needs an independent, signed check of your own output (a few free reviews a day, then paid from the owner's wallet if one is set up). Use verify_receipt to check a receipt someone hands you. Use demo_match to try it for free. Results come with Ed25519-signed receipts: keep them.";

/** Read settings from environment variables. Throws on values that would be unsafe to guess. */
export function loadConfig(env = process.env) {
  const limitRaw = env.AGENT_REFEREE_DAILY_LIMIT_USD ?? "1.00";
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 0 || limit > 1000) throw new Error(`AGENT_REFEREE_DAILY_LIMIT_USD must be a dollar amount from 0 to 1000 (got "${limitRaw}").`);
  const extraKeys = (env.AGENT_REFEREE_PUBLIC_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const save = (env.AGENT_REFEREE_SAVE_RECEIPTS ?? "true").toLowerCase();
  if (!["true", "false", "1", "0", "yes", "no"].includes(save)) throw new Error('AGENT_REFEREE_SAVE_RECEIPTS must be "true" or "false".');
  const url = env.AGENT_REFEREE_URL?.trim() || undefined;
  if (url && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new Error("AGENT_REFEREE_URL must be an https:// address.");
  // Team allowance (the operator's own sessions): a member name, and the shared token unless the network adds it.
  const teamMember = env.AGENT_REFEREE_TEAM_MEMBER?.trim() || undefined;
  const teamToken = env.AGENT_REFEREE_TEAM_TOKEN?.trim() || undefined;
  if (teamToken && !teamMember) throw new Error("AGENT_REFEREE_TEAM_TOKEN is set but AGENT_REFEREE_TEAM_MEMBER isn't: set the member name too.");
  if (teamMember && !/^[A-Za-z0-9._-]{1,32}$/.test(teamMember)) throw new Error("AGENT_REFEREE_TEAM_MEMBER must be 1 to 32 letters, digits, dots, dashes or underscores.");
  const acceptTerms = env.AGENT_REFEREE_ACCEPT_TERMS?.trim() || undefined;
  if (acceptTerms && !/^v\d{4}-\d{2}-\d{2}$/.test(acceptTerms)) throw new Error('AGENT_REFEREE_ACCEPT_TERMS must be the Terms version the owner accepted, like "v2026-11-01".');
  if (teamToken && !/^[\x21-\x7e]{32,512}$/.test(teamToken)) throw new Error("AGENT_REFEREE_TEAM_TOKEN must be 32 or more printable characters with no spaces.");
  return {
    url,
    team: teamMember ? { member: teamMember, token: teamToken } : undefined,
    acceptTerms,
    privateKey: env.AGENT_REFEREE_PRIVATE_KEY?.trim() || undefined,
    dailyLimitMicro: toMicro(limit),
    publicKeys: [REFEREE_KEY, ...extraKeys.filter((k) => k !== REFEREE_KEY)],
    dataDir: env.AGENT_REFEREE_DATA_DIR?.trim() || join(homedir(), ".agent-referee"),
    saveReceipts: ["true", "1", "yes"].includes(save),
  };
}

/** Everything the server needs, with the outside world injectable for tests. */
export function buildTools(config, { makeClient = (o) => new AgentReferee(o), makePayingFetch = defaultPayingFetch, now, baseFetch } = {}) {
  const budget = new Budget({ dir: config.dataDir, dailyLimitMicro: config.dailyLimitMicro, now });
  const receipts = new ReceiptStore({ dir: config.dataDir, enabled: config.saveReceipts });
  return createTools({ config, makeClient, makePayingFetch, budget, receipts, baseFetch });
}

export const SERVER_INFO = { name: "agent-referee", title: "Agent Referee", version: VERSION };

export function createServer({ config, write, log, deps } = {}) {
  return createMcpServer({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: buildTools(config, deps), write, log });
}

/** Start on stdio. */
export async function main(env = process.env) {
  // stdout belongs to the protocol: anything a dependency prints goes to stderr instead.
  console.log = console.info = console.debug = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    process.stderr.write(`[agent-referee-mcp] ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `[agent-referee-mcp] ${VERSION} ready. Paid reviews: ${config.privateKey ? `on, daily cap $${(config.dailyLimitMicro / 1e6).toFixed(2)}` : `off (no AGENT_REFEREE_PRIVATE_KEY)${config.team ? "" : "; free reviews only"}`}. ${config.team ? `Team allowance: on, as member ${config.team.member} (${config.team.token ? "token from AGENT_REFEREE_TEAM_TOKEN" : "no token set here: the network must add x-team-token"}); sealed_review uses it instead of the wallet. ` : ""}Receipts: ${config.saveReceipts ? join(config.dataDir, "receipts") : "not saved"}.\n`,
  );
  await runStdio({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: buildTools(config) });
}

// Wires config, local storage and the tools into an MCP server.
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentReferee } from "agent-referee-client";
import { createMcpServer, runStdio } from "./protocol.mjs";
import { createTools, defaultPayingFetch } from "./tools.mjs";
import { Budget, ReceiptStore, toMicro } from "./store.mjs";

export const VERSION = "0.6.0";

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
  const proof = (env.AGENT_REFEREE_PROOF ?? "off").trim().toLowerCase();
  if (!["on", "off"].includes(proof)) throw new Error('AGENT_REFEREE_PROOF must be "on" or "off" (default off).');
  if (proof === "on" && !teamMember) throw new Error("AGENT_REFEREE_PROOF is on, but proof receipts are for team members: set AGENT_REFEREE_TEAM_MEMBER too.");
  if (teamToken && !/^[\x21-\x7e]{32,512}$/.test(teamToken)) throw new Error("AGENT_REFEREE_TEAM_TOKEN must be 32 or more printable characters with no spaces.");
  // judge_match (judge matches between the owner's own sessions, paid from the team allowance): off unless the owner
  // switches it on. It needs the team allowance; it holds no wallet and keeps no cap of its own (the allowance's
  // limits apply on the service). The old wallet settings are refused, so a stale entry is noticed, not ignored.
  const judgeSwitch = (env.AGENT_REFEREE_JUDGE ?? "off").trim().toLowerCase();
  if (!["on", "off"].includes(judgeSwitch)) throw new Error('AGENT_REFEREE_JUDGE must be "on" or "off".');
  let judge;
  if (judgeSwitch === "on") {
    if (!teamMember) throw new Error("AGENT_REFEREE_JUDGE=on needs the team allowance (AGENT_REFEREE_TEAM_MEMBER): judge matches are paid from it, never from a wallet.");
    for (const old of ["AGENT_REFEREE_JUDGE_DAILY_LIMIT_USD", "AGENT_REFEREE_JUDGE_TIMEZONE"]) if (env[old] !== undefined) throw new Error(`${old} isn't used any more: judge matches are paid from the team allowance, whose limits the service enforces. Remove it from the entry.`);
    const ex = (env.AGENT_REFEREE_JUDGE_EXCLUDE ?? "anthropic").trim().toLowerCase();
    const exclude = ex === "none" ? [] : ex.split(",").map((s) => s.trim()).filter(Boolean);
    if (!exclude.length && ex !== "none") throw new Error('AGENT_REFEREE_JUDGE_EXCLUDE must list AI companies (e.g. "anthropic") or be "none".');
    if (exclude.some((c) => !/^[a-z0-9-]{1,40}$/.test(c))) throw new Error('AGENT_REFEREE_JUDGE_EXCLUDE must be company names like "anthropic,deepseek", or "none".');
    judge = { exclude };
  }
  return {
    url,
    judge,
    team: teamMember ? { member: teamMember, token: teamToken } : undefined,
    proof: proof === "on",
    privateKey: env.AGENT_REFEREE_PRIVATE_KEY?.trim() || undefined,
    dailyLimitMicro: toMicro(limit),
    publicKeys: [REFEREE_KEY, ...extraKeys.filter((k) => k !== REFEREE_KEY)],
    dataDir: env.AGENT_REFEREE_DATA_DIR?.trim() || join(homedir(), ".agent-referee"),
    saveReceipts: ["true", "1", "yes"].includes(save),
  };
}

/** Everything the server needs, with the outside world injectable for tests. */
export function buildTools(config, { makeClient = (o) => new AgentReferee(o), makePayingFetch = defaultPayingFetch, now, baseFetch, judgePollMs } = {}) {
  const budget = new Budget({ dir: config.dataDir, dailyLimitMicro: config.dailyLimitMicro, now });
  const receipts = new ReceiptStore({ dir: config.dataDir, enabled: config.saveReceipts });
  return createTools({ config, makeClient, makePayingFetch, budget, receipts, baseFetch, judgePollMs });
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
    `[agent-referee-mcp] ${VERSION} ready. Paid reviews: ${config.privateKey ? `on, daily cap $${(config.dailyLimitMicro / 1e6).toFixed(2)}` : `off (no AGENT_REFEREE_PRIVATE_KEY)${config.team ? "" : "; free reviews only"}`}. ${config.team ? `Team allowance: on, as member ${config.team.member} (${config.team.token ? "token from AGENT_REFEREE_TEAM_TOKEN" : "no token set here: the network must add x-team-token"}); sealed_review uses it instead of the wallet. ` : ""}${config.judge ? `Judge matches: on, paid from the team allowance (rule 9 disputes and owner-approved matches only). ` : ""}Receipts: ${config.saveReceipts ? join(config.dataDir, "receipts") : "not saved"}.\n`,
  );
  await runStdio({ info: SERVER_INFO, instructions: INSTRUCTIONS, tools: buildTools(config) });
}

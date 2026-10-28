// Have Claude's own work checked independently: one sealed review-3 ($0.20) of the final reviewer retry logic.
// The task is the spec the code was written to (not instructions to the reviewers), and three reviewers from three
// AI companies check the code against it. Runs through this MCP server exactly as an agent would call it.
//
//   node scripts\review-my-work.mjs --wallet-file C:\Users\Admin\Downloads\client-test\test-wallet.txt
//
// The key is read from the wallet file and handed to the server's environment only; it's never printed.
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";

const args = process.argv.slice(2);
const wfi = args.indexOf("--wallet-file");
if (wfi < 0) {
  console.log("Usage: node scripts\\review-my-work.mjs --wallet-file <path to the wallet file>");
  process.exit(1);
}
const key = await readWalletKey(args[wfi + 1]);

// The exact code that's live, read from the server repo next to this folder.
const src = await readFile(resolve("..", "agent-referee-server", "src", "review.ts"), "utf8");
const start = src.indexOf("/** All tries for one reviewer stay inside this");
const end = src.indexOf("/** How the verdicts combine");
if (start < 0 || end < 0) throw new Error("Couldn't find the retry code in ..\\agent-referee-server\\src\\review.ts");
const code = src.slice(start, end).trim();

const task = `Write the TypeScript retry logic for one AI reviewer call inside a paid web service. The service's payment authorization expires after 300 seconds, so a review must always finish or fail well inside that. callModel(...) (not shown) sends the request with the given abort signal; parseReview (not shown) throws on an unusable answer.

Requirements:
1. If the AI provider is busy (HTTP 429) or returns a server error (5xx, including 529 overloaded), wait and try again, up to 4 tries in total.
2. Wait 1-2 s, then 2-4 s, then 4-8 s between tries; if the provider sends a numeric retry-after header, wait that long instead, but at least 1 s and at most 10 s.
3. A call that times out, or that returns an unusable answer, is tried at most twice (these two cases share one counter).
4. Don't retry a plain 4xx error other than 429 (for example 400 bad request).
5. All tries for one reviewer, including the waits, end within about 240 seconds: each call's timeout is capped at the time left, and no new try starts with less than 15 seconds left.
6. If an answer was cut off at the provider's token limit, the error says so plainly; every final error names the model that failed.
7. Log each failed try with the timeout that was actually used.`;

// LIVE_TEST_URL / LIVE_TEST_KEY: only for dry-running this script against a local copy of the server.
const target = process.env.LIVE_TEST_URL ? { AGENT_REFEREE_URL: process.env.LIVE_TEST_URL, AGENT_REFEREE_PUBLIC_KEYS: process.env.LIVE_TEST_KEY } : {};
const env = { AGENT_REFEREE_DATA_DIR: resolve("review-my-work-data"), AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.20", ...target };
const s = spawnServer(env);
await s.init();
console.log("Sending Claude's retry fix to three independent reviewers ($0.20, charged only if the review completes)...\n");
const t0 = Date.now();
const r = await s.call("sealed_review", { tier: "review-3", task, output: code, title: "Claude's reviewer retry logic (final), checked independently" });
await s.close();

if (r.isError) {
  console.log("The review didn't go through:\n" + r.text);
  process.exit(1);
}
const d = r.structured;
const line = "-".repeat(78);
console.log(line);
console.log(`VERDICT: ${d.verdict.toUpperCase()}   (${Object.entries(d.tally).filter(([, n]) => n).map(([v, n]) => `${n} ${v}`).join(", ")})   in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(line);
for (const v of d.votes) {
  console.log(`\n${v.model}${v.model_reported && v.model_reported !== v.model ? `  (reported: ${v.model_reported})` : ""}`);
  console.log(`  verdict: ${v.verdict}   confidence: ${v.confidence}`);
  if (v.issues.length) for (const i of v.issues) console.log(`  - ${i}`);
  else console.log("  - no problems found");
  console.log(`  reasoning: ${v.reasoning}`);
}
console.log(`\n${line}`);
console.log(`Receipt check (signature, exact task and output, verdict recomputed): ${d.check.ok ? "OK" : "FAILED: " + d.check.problems.join(" ")}`);
console.log(`Paid: ${d.paid.amount} from ${d.paid.wallet}, transaction ${d.paid.transaction}`);
console.log(`Receipt saved: ${d.receipt_file}`);
console.log(`Review id: ${d.review_id}`);

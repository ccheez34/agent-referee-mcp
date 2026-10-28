// Heavy stress test of the MCP server against the real service. About $3.50 from the wallet.
// Run from the agent-referee-mcp folder after `npm install` and a passing live test:
//
//   node scripts\stress-test.mjs --wallet-file <path>            everything (about $3.50)
//   node scripts\stress-test.mjs --free                          free part only (12 demo matches)
//
// Part 1 (free):  8 demo matches and 4 two-agent tiebreaks, all at once, through 16 separate MCP servers.
// Part 2 (paid):  10 MCP servers at once, each firing 2 reviews and 1 review-3 at the same moment
//                 (20 x $0.05 + 10 x $0.20 = $3.00). Every receipt is checked.
// Part 3 (paid):  20 reviews fired at once into ONE server with a $0.50 daily cap. Exactly 10 must be paid
//                 ($0.50) and 10 refused before paying.
// The key is read from the wallet file and passed to the servers' environment only; it's never printed.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";

const args = process.argv.slice(2);
const freeOnly = args.includes("--free");
const wfi = args.indexOf("--wallet-file");
const REAL_KEY = process.env.LIVE_TEST_KEY || "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";
const target = process.env.LIVE_TEST_URL ? { AGENT_REFEREE_URL: process.env.LIVE_TEST_URL, AGENT_REFEREE_PUBLIC_KEYS: REAL_KEY } : {};
const runDir = resolve("stress-test-data", new Date().toISOString().replace(/[:.]/g, "-"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};
const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const allNoise = [];
async function closeAll(servers) {
  await Promise.all(servers.map((s) => s.close()));
  for (const s of servers) allNoise.push(...s.badLines);
}

async function walletKey() {
  if (wfi < 0) throw new Error("The paid parts need --wallet-file <path> (or use --free).");
  return readWalletKey(args[wfi + 1]);
}
const key = freeOnly ? null : await walletKey(); // fail fast, before spending anything

// ---------------- Part 1: free ----------------
console.log("== Part 1 (free): 8 demo matches + 4 two-agent tiebreaks, all at once ==");
{
  const env = { AGENT_REFEREE_DATA_DIR: join(runDir, "free"), ...target };
  const demoServers = Array.from({ length: 8 }, () => spawnServer(env));
  const pairs = Array.from({ length: 4 }, () => [spawnServer(env), spawnServer(env)]);
  const all = [...demoServers, ...pairs.flat()];
  await Promise.all(all.map((s) => s.init()));
  const tiers = ["weighted", "rps", "rps-bo3", "weighted"];
  const t0 = Date.now();
  const stamp = Date.now();
  const [demos, ties] = await Promise.all([
    Promise.all(demoServers.map((s, i) => s.call("demo_match", { tier: tiers[i % 4], title: `stress demo ${i + 1}` }))),
    Promise.all(
      pairs.map(([a, b], i) => {
        const settings = { key: `mcp-stress-${stamp}-${i}`, tier: tiers[i], seats: ["left", "right"], title: `stress tiebreak ${i + 1}` };
        return Promise.all([a.call("tiebreak", { ...settings, my_seat: "left" }), b.call("tiebreak", { ...settings, my_seat: "right" })]);
      }),
    ),
  ]);
  const t = secs(t0);
  const demoOk = demos.filter((d) => !d.isError && d.structured?.phase === "done" && Object.values(d.structured.checks).every((c) => c.ok) && d.structured.receipt?.public_key === REAL_KEY);
  check(`8 of 8 demo matches finished with every check passing (${t})`, demoOk.length === 8, demos.filter((d) => d.isError).map((d) => d.text.slice(0, 200)).join(" | "));
  const tieOk = ties.filter(([a, b]) => !a.isError && !b.isError && a.structured.match_id === b.structured.match_id && a.structured.winner === b.structured.winner && a.structured.you_won !== b.structured.you_won && a.structured.check.ok && b.structured.check.ok);
  check("4 of 4 tiebreak pairs: same match, same winner, one winner, both agents' checks pass", tieOk.length === 4, ties.flat().filter((r) => r.isError).map((r) => r.text.slice(0, 200)).join(" | "));
  const ids = new Set([...demos.map((d) => d.structured?.match_id), ...ties.map(([a]) => a.structured?.match_id)]);
  check("12 different matches (nothing crossed over)", ids.size === 12);
  await closeAll(all);
}

if (freeOnly) {
  console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (free part)`);
  process.exit(failures ? 1 : 0);
}

const task = "Convert 72 degrees Fahrenheit to Celsius, rounded to one decimal place. Give only the number.";
const outputs = ["22.2", "23.5", "22.22", "about 22 degrees", "-22.2"];
const allReceipts = [];

// ---------------- Part 2: paid load ----------------
console.log("\n== Part 2 (paid, $3.00): 10 MCP servers, 20 reviews + 10 review-3 fired at the same moment ==");
{
  const servers = Array.from({ length: 10 }, (_, i) => spawnServer({ AGENT_REFEREE_DATA_DIR: join(runDir, `load-${i + 1}`), AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.30", ...target }));
  await Promise.all(servers.map((s) => s.init()));
  const jobs = [];
  servers.forEach((s, i) => {
    for (const [j, tier] of ["review", "review", "review-3"].entries()) {
      const output = outputs[(i + j) % outputs.length];
      jobs.push({ tier, output, server: s, promise: s.call("sealed_review", { tier, task, output, title: `stress load ${i + 1}.${j + 1}` }) });
    }
  });
  const t0 = Date.now();
  const results = await Promise.all(jobs.map((j) => j.promise));
  const t = secs(t0);
  const ok = results.filter((r) => !r.isError && r.structured?.check?.ok === true);
  check(`30 of 30 reviews completed with receipts that check out (${t})`, ok.length === 30, results.filter((r) => r.isError).map((r) => r.text.slice(0, 250)).join("\n      "));
  const r3 = results.filter((r, i) => jobs[i].tier === "review-3" && !r.isError);
  check("every review-3 had three reviewers from three companies", r3.every((r) => new Set(r.structured.votes.map((v) => (v.model.includes("/") ? v.model.split("/")[0] : "anthropic"))).size === 3));
  const right = results.filter((r, i) => jobs[i].output === "22.2" && !r.isError);
  const wrong = results.filter((r, i) => ["23.5", "-22.2"].includes(jobs[i].output) && !r.isError);
  check(`the correct answer passed every time (${right.filter((r) => r.structured.verdict === "pass").length}/${right.length})`, right.length > 0 && right.every((r) => r.structured.verdict === "pass"), right.map((r) => r.structured.verdict).join(","));
  check(`clearly wrong answers never passed (${wrong.filter((r) => r.structured.verdict !== "pass").length}/${wrong.length})`, wrong.length > 0 && wrong.every((r) => r.structured.verdict !== "pass"), wrong.map((r) => r.structured.verdict).join(","));
  const ids = new Set(ok.map((r) => r.structured.review_id));
  // PayAI bundles payments that arrive together into one on-chain transaction (Multicall3), so hashes can repeat:
  // count payments, not hashes.
  const withTx = ok.filter((r) => /^0x[0-9a-f]{64}$/i.test(r.structured.paid?.transaction ?? ""));
  const txs = new Set(withTx.map((r) => r.structured.paid.transaction));
  check("30 different review ids", ids.size === ok.length);
  check(`every paid review reported its settlement transaction (${withTx.length}/${ok.length}, in ${txs.size} on-chain transactions)`, withTx.length === ok.length);
  const spend = await Promise.all(servers.map((s) => s.call("saved_receipts", {})));
  check("each server saved its 3 receipts and counted exactly $0.30", spend.every((s) => s.structured?.receipts?.length === 3 && /^\$0\.30 of \$0\.30/.test(s.structured?.spent_today ?? "")), spend.map((s) => s.structured?.spent_today).join(", "));
  for (const [i, r] of results.entries()) if (!r.isError) allReceipts.push({ part: "load", tier: jobs[i].tier, output: jobs[i].output, verdict: r.structured.verdict, review_id: r.structured.review_id, transaction: r.structured.paid?.transaction, receipt: r.structured.receipt });
  await closeAll(servers);
}

// ---------------- Part 3: the cap under a burst ----------------
console.log("\n== Part 3 (paid, $0.50): 20 reviews at once into one server with a $0.50 cap ==");
{
  const s = spawnServer({ AGENT_REFEREE_DATA_DIR: join(runDir, "cap"), AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.50", ...target });
  await s.init();
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.call("sealed_review", { task, output: "22.2", title: `stress cap ${i + 1}` })));
  const t = secs(t0);
  const paid = results.filter((r) => !r.isError);
  const refused = results.filter((r) => r.isError && /cap reached.*Nothing was charged/s.test(r.text));
  const other = results.filter((r) => r.isError && !/cap reached/.test(r.text));
  check(`exactly 10 paid and 10 refused by the cap (${paid.length} paid, ${refused.length} refused, ${t})`, paid.length === 10 && refused.length === 10, other.map((r) => r.text.slice(0, 250)).join("\n      "));
  check("the 10 paid ones all check out", paid.every((r) => r.structured?.check?.ok === true));
  const saved = await s.call("saved_receipts", {});
  check("the server counted exactly $0.50 and saved 10 receipts", /^\$0\.50 of \$0\.50/.test(saved.structured?.spent_today ?? "") && saved.structured?.receipts?.length === 10, `${saved.structured?.spent_today}, ${saved.structured?.receipts?.length} receipts`);
  const after = await s.call("sealed_review", { task, output: "22.2" });
  check("one more afterwards is still refused", after.isError && /cap reached/.test(after.text));
  check("the key never appears in any output", ![...results, after].some((r) => r.text.includes(key.slice(2, 20))) && !s.stderr.includes(key.slice(2, 20)));
  for (const r of paid) allReceipts.push({ part: "cap", tier: "review", output: "22.2", verdict: r.structured.verdict, review_id: r.structured.review_id, transaction: r.structured.paid?.transaction, receipt: r.structured.receipt });
  await closeAll([s]);
}

check("stdout carried only JSON-RPC on every server", allNoise.length === 0, allNoise.slice(0, 3).join(" | "));

// A summary file: every payment's transaction hash, to match against BaseScan.
await mkdir(runDir, { recursive: true });
const summaryFile = join(runDir, "summary.json");
await writeFile(summaryFile, JSON.stringify({ ran_at: new Date().toISOString(), paid_reviews: allReceipts.length, expected_usd: allReceipts.reduce((n, r) => n + (r.tier === "review-3" ? 0.2 : 0.05), 0).toFixed(2), reviews: allReceipts }, null, 2));
const total = allReceipts.reduce((n, r) => n + (r.tier === "review-3" ? 0.2 : 0.05), 0);
console.log(`\n${allReceipts.length} paid reviews, $${total.toFixed(2)} in all. Every transaction hash is in ${summaryFile}`);
console.log(`They settled in ${new Set(allReceipts.map((r) => r.transaction).filter(Boolean)).size} on-chain transactions (PayAI bundles payments that arrive together).`);
console.log("To match against BaseScan: count the fee wallet's USDC transfers (Token Transfers tab), not its transactions.");
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);

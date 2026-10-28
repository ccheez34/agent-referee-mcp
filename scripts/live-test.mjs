// Live test of the MCP server against the real service (https://agentreferee.ai's default address).
// Run from the agent-referee-mcp folder after `npm install`:
//
//   node scripts/live-test.mjs                                   free checks only (3 demo matches, no wallet)
//   node scripts/live-test.mjs --paid --wallet-file <path>       plus 2 paid reviews: $0.25 in all
//
// The wallet file is read only to find the 0x... private key; the key is passed to the server through its
// environment and never printed. Receipts from the paid part are saved in ./live-test-data (not published).
import { resolve, join } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";

const args = process.argv.slice(2);
const paid = args.includes("--paid");
const walletFileIdx = args.indexOf("--wallet-file");
const dataDir = resolve("live-test-data");
// LIVE_TEST_URL / LIVE_TEST_KEY: only for dry-running this script against a local copy of the server.
const REAL_KEY = process.env.LIVE_TEST_KEY || "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";
const target = process.env.LIVE_TEST_URL ? { AGENT_REFEREE_URL: process.env.LIVE_TEST_URL, AGENT_REFEREE_PUBLIC_KEYS: REAL_KEY } : {};

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};

async function walletKey() {
  if (walletFileIdx >= 0) return readWalletKey(args[walletFileIdx + 1]);
  if (process.env.AGENT_REFEREE_PRIVATE_KEY) return process.env.AGENT_REFEREE_PRIVATE_KEY;
  throw new Error("--paid needs --wallet-file <path> (or AGENT_REFEREE_PRIVATE_KEY set).");
}

const baseEnv = { AGENT_REFEREE_DATA_DIR: dataDir, ...target };

console.log("== Free: handshake, tools, demo matches, receipt checks ==");
const s = spawnServer(baseEnv);
const init = await s.init("2025-06-18");
check("server starts and answers initialize", init.result?.serverInfo?.name === "agent-referee", JSON.stringify(init));
const tools = (await s.request("tools/list")).result?.tools?.map((t) => t.name) ?? [];
check("lists the five tools", tools.join(",") === "demo_match,tiebreak,sealed_review,verify_receipt,saved_receipts", tools.join(","));

const demo1 = await s.call("demo_match", { title: "MCP live test" });
check("demo_match (weighted) finishes", !demo1.isError && demo1.structured?.phase === "done", demo1.text.slice(0, 400));
check("both seats' checks pass (signature against the pinned key, seeds, math)", demo1.structured && Object.values(demo1.structured.checks).every((c) => c.ok), JSON.stringify(demo1.structured?.checks));
check("receipt is signed with the real key and marked demo", demo1.structured?.receipt?.public_key === REAL_KEY && demo1.structured?.receipt?.payload?.demo === true);

const demo2 = await s.call("demo_match", { tier: "rps-bo3" });
check("demo_match (rps-bo3) finishes with checks passing", !demo2.isError && Object.values(demo2.structured?.checks ?? {}).every((c) => c.ok), demo2.text.slice(0, 400));

const v = await s.call("verify_receipt", { receipt: demo1.structured?.receipt });
check("verify_receipt: valid, demo, recomputed", v.structured?.ok === true && v.structured?.demo === true && v.structured?.recomputed === true, v.text.slice(0, 400));
const forged = structuredClone(demo1.structured?.receipt ?? {});
if (forged.payload) forged.payload.outcome.winner = forged.payload.parties.find((p) => p !== demo1.structured.winner);
const vf = await s.call("verify_receipt", { receipt: forged });
check("verify_receipt: a receipt with the winner flipped is rejected", vf.structured?.ok === false && vf.structured?.signature_valid === false);
const noWallet = await s.call("sealed_review", { task: "Add 2 and 2 and give only the number.", output: "4" });
// Uses one of today's free reviews from this address (the service pays): a real review, no wallet involved.
check(
  "sealed_review without a wallet runs a free review: checked receipt marked funding: free",
  !noWallet.isError && noWallet.structured?.check?.ok === true && noWallet.structured?.receipt?.payload?.funding === "free" && noWallet.structured?.paid === undefined,
  noWallet.text.slice(0, 400),
);
await s.close();
check("stdout carried only JSON-RPC", s.badLines.length === 0, s.badLines.slice(0, 3).join(" | "));

console.log("\n== Free: two agents, two MCP servers, one tiebreak ==");
const [a, b] = [spawnServer(baseEnv), spawnServer(baseEnv)];
await Promise.all([a.init(), b.init()]);
const settings = { key: `mcp-live-${Date.now()}`, seats: ["buyer", "seller"], weights: { buyer: 50, seller: 50 }, title: "MCP live tiebreak" };
const [ra, rb] = await Promise.all([a.call("tiebreak", { ...settings, my_seat: "buyer" }), new Promise((r) => setTimeout(r, 2000)).then(() => b.call("tiebreak", { ...settings, my_seat: "seller" }))]);
check("both agents finish", !ra.isError && !rb.isError, `${ra.text.slice(0, 300)} / ${rb.text.slice(0, 300)}`);
check("same match, same winner, exactly one winner", ra.structured?.match_id === rb.structured?.match_id && ra.structured?.winner === rb.structured?.winner && ra.structured?.you_won !== rb.structured?.you_won);
check("both agents' own checks pass", ra.structured?.check?.ok === true && rb.structured?.check?.ok === true, JSON.stringify([ra.structured?.check?.problems, rb.structured?.check?.problems]));
await Promise.all([a.close(), b.close()]);

if (!paid) {
  console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (free part). Add --paid --wallet-file <path> to also test sealed review ($0.25).`);
  process.exit(failures ? 1 : 0);
}

console.log("\n== Spending cap (free: refused before any payment) ==");
const key = await walletKey();
const capped = spawnServer({ ...baseEnv, AGENT_REFEREE_DATA_DIR: join(dataDir, "cap-check"), AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.10" });
await capped.init();
const refused = await capped.call("sealed_review", { tier: "review-3", task: "Add 2 and 2 and give only the number.", output: "4" });
check("a $0.20 review is refused under a $0.10 cap, nothing charged", refused.isError && /cap reached.*Nothing was charged/s.test(refused.text), refused.text.slice(0, 300));
check("the key never appears in any output", !refused.text.includes(key.slice(2, 20)) && !capped.stderr.includes(key.slice(2, 20)));
await capped.close();

console.log("\n== Paid: two sealed reviews ($0.05 + $0.20) ==");
const p = spawnServer({ ...baseEnv, AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.30" });
await p.init();
const task = "Convert 72 degrees Fahrenheit to Celsius, rounded to one decimal place. Give only the number.";
const r1 = await p.call("sealed_review", { task, output: "22.2", title: "MCP live test: correct answer" });
check("review ($0.05) of a correct answer: pass, receipt checks out", !r1.isError && r1.structured?.verdict === "pass" && r1.structured?.check?.ok === true, r1.text.slice(0, 600));
if (r1.isError) {
  console.log("\nStopping here: the first paid review didn't go through (see above), so the rest would fail the same way.");
  await p.close();
  process.exit(1);
}
check("payment reported with a transaction hash", /^0x[0-9a-f]{64}$/i.test(r1.structured?.paid?.transaction ?? ""), JSON.stringify(r1.structured?.paid));
const r2 = await p.call("sealed_review", { task, output: "23.5", tier: "review-3", title: "MCP live test: wrong answer" });
check("review-3 ($0.20) of a wrong answer: not a pass, receipt checks out", !r2.isError && r2.structured?.verdict !== "pass" && r2.structured?.check?.ok === true, r2.text.slice(0, 600));
check("three reviewers from three companies", new Set((r2.structured?.votes ?? []).map((x) => x.model.split("/")[0].replace(/^claude.*/, "anthropic"))).size === 3, JSON.stringify(r2.structured?.votes?.map((x) => x.model)));
const ok = await p.call("verify_receipt", { receipt: r1.structured?.receipt, task, output: "22.2" });
check("verify_receipt with the right task and output: valid", ok.structured?.ok === true, ok.text.slice(0, 300));
const bad = await p.call("verify_receipt", { receipt: r1.structured?.receipt, task, output: "22.3" });
check("verify_receipt with a different output: rejected", bad.structured?.ok === false);
const saved = await p.call("saved_receipts", {});
check("both receipts saved, spend counted", saved.structured?.receipts?.length >= 2 && /^\$0\.25/.test(saved.structured?.spent_today ?? ""), JSON.stringify(saved.structured?.spent_today));
const over = await p.call("sealed_review", { task, output: "22.2", tier: "review-3" });
check("a third review over the $0.30 cap is refused, nothing charged", over.isError && /cap reached/.test(over.text));
await p.close();
check("stdout carried only JSON-RPC", p.badLines.length === 0);

console.log(`\nReceipts saved in ${join(dataDir, "receipts")}`);
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);

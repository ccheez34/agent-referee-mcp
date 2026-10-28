// After the Oct 27 instruction change (review-v3, judge-v4): do the shorter answers still judge correctly?
// About $0.55 from the wallet. Run from the agent-referee-mcp folder:
//
//   node scripts\quality-check.mjs --wallet-file C:\Users\Admin\Downloads\client-test\test-wallet.txt
//
// 1. review   of a correct answer        -> must pass                                    ($0.05)
// 2. review   of a deliberately wrong one -> must not pass, and must name the mistake      ($0.05)
// 3. review-3 of the same wrong one      -> must not pass, all 3 reviewers name it        ($0.20)
// 4. judge match with a trap: the cheaper plan misses the deadline -> the judge must pick
//    the other side and say why. The wallet pays both seats ($0.10 each).                 ($0.20)
// Every receipt must check out and carry the new instruction versions.
// The key is read from the wallet file and passed on only; it's never printed.
import { resolve } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";
import { AgentReferee } from "agent-referee-client";

const args = process.argv.slice(2);
const wfi = args.indexOf("--wallet-file");
if (wfi < 0) {
  console.log("Usage: node scripts\\quality-check.mjs --wallet-file <path to the wallet file>");
  process.exit(1);
}
const key = await readWalletKey(args[wfi + 1]);
const REAL_KEY = process.env.LIVE_TEST_KEY || "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";
const target = process.env.LIVE_TEST_URL ? { AGENT_REFEREE_URL: process.env.LIVE_TEST_URL, AGENT_REFEREE_PUBLIC_KEYS: REAL_KEY } : {};

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && detail ? `\n      ${detail}` : ""}`);
  if (!cond) failures++;
};
const show = (v) => console.log(`      ${v.model}: ${v.verdict} (${v.confidence})${v.issues.length ? `\n        - ${v.issues.join("\n        - ")}` : ""}`);

// ---------- reviews, through the MCP server ----------
const task = "List the first five prime numbers in increasing order, separated by commas. Give only the list.";
const right = "2, 3, 5, 7, 11";
const wrong = "1, 2, 3, 5, 7"; // 1 isn't prime, and 11 is missing
const namesMistake = (v) => /\b1\b.*(not|isn.t).*prime|prime.*\b1\b|\b11\b|one is not/i.test([...v.issues, v.reasoning].join(" "));

const s = spawnServer({ AGENT_REFEREE_DATA_DIR: resolve("quality-check-data", new Date().toISOString().replace(/[:.]/g, "-")), AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: "0.30", ...target });
await s.init();
console.log("== Reviews ==");
const [r1, r2, r3] = await Promise.all([
  s.call("sealed_review", { tier: "review", task, output: right, title: "quality check: correct" }),
  s.call("sealed_review", { tier: "review", task, output: wrong, title: "quality check: wrong" }),
  s.call("sealed_review", { tier: "review-3", task, output: wrong, title: "quality check: wrong, three reviewers" }),
]);
await s.close();
for (const [label, r] of [["correct answer", r1], ["wrong answer", r2], ["wrong answer, review-3", r3]]) {
  if (r.isError) {
    check(`${label}: the review went through`, false, r.text.slice(0, 300));
    continue;
  }
  console.log(`  ${label}: ${r.structured.verdict}`);
  r.structured.votes.forEach(show);
}
if (!r1.isError) {
  check("correct answer passed", r1.structured.verdict === "pass");
  check("its receipt checks out and uses review-v3", r1.structured.check.ok && r1.structured.receipt.payload.reviewers.format_version === "agent-referee-review-v3", JSON.stringify(r1.structured.receipt.payload.reviewers));
}
if (!r2.isError) {
  check("wrong answer did NOT pass", r2.structured.verdict !== "pass");
  check("the reviewer named the actual mistake (1 isn't prime / 11 missing)", r2.structured.votes.every(namesMistake));
}
if (!r3.isError) {
  check("review-3: wrong answer did NOT pass", r3.structured.verdict !== "pass");
  check(`review-3: every reviewer named the mistake (${r3.structured.votes.filter(namesMistake).length}/3)`, r3.structured.votes.every(namesMistake));
  check("review-3: its receipt checks out", r3.structured.check.ok);
}

// ---------- a judge match with a trap, both seats paid by the wallet ----------
console.log("\n== Judge match ==");
let ref;
try {
  const { wrapFetchWithPayment, createSigner } = await import("x402-fetch");
  const signer = await createSigner("base", key);
  ref = new AgentReferee({ url: target.AGENT_REFEREE_URL, fetch: wrapFetchWithPayment(fetch, signer, 100_000n), publicKeys: [REAL_KEY] }); // never more than $0.10 a request
} catch (e) {
  check("payment library loads", false, String(e?.message ?? e));
}
if (ref) {
  const rules = "The client needs the work delivered within 3 days. The cheaper plan that meets the 3-day deadline wins. A plan that misses the deadline cannot win.";
  const positions = {
    alpha: "Plan A: $400, delivered in 2 days.",
    beta: "Plan B: $300, delivered in 5 days. It's the cheapest option by $100.",
  };
  try {
    const match = await ref.create({ tier: "judge", seats: ["alpha", "beta"], rules, title: "quality check: deadline trap", key: `quality-check-${Date.now()}` });
    const [a, b] = await Promise.all([ref.join(match.match_id, "alpha"), ref.join(match.match_id, "beta")]);
    const [ra, rb] = await Promise.all([a.submit(positions.alpha), b.submit(positions.beta)]);
    const res = ra.result ?? {};
    console.log(`  winner: ${res.winner}   confidence: ${res.confidence}`);
    console.log(`  rule applied: ${res.rule_applied}`);
    console.log(`  reasoning: ${res.reasoning}`);
    check("the judge picked alpha (beta is cheaper but misses the deadline)", res.winner === "alpha" && !res.mistrial, JSON.stringify(res));
    check("the reasoning names the deadline", /deadline|3 days|5 days|three days|five days/i.test(`${res.reasoning} ${res.rule_applied}`));
    check("both seats' checks pass", ra.check?.ok === true && rb.check?.ok === true, JSON.stringify([ra.check?.problems, rb.check?.problems]));
    check("the match uses judge-v4", ra.judge?.format_version === "agent-referee-judge-v4", JSON.stringify(ra.judge));
  } catch (e) {
    check("judge match completed", false, String(e?.message ?? e).slice(0, 300));
  }
}

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);

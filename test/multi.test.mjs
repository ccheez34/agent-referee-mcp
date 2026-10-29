// Multi-part reviews (review-3x2, review-3x3) in the MCP tools: verify_receipt checks review-multi-v1 receipts with
// the pieces, and sealed_review sends pieces (paid only) and refuses mistakes before any payment is set up.
// Vectors: test/fixtures/multi-review-vectors.json, copied from agent-referee-server (scripts/gen-multi-vectors.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTools, PRICES } from "../src/tools.mjs";
import { Budget, ReceiptStore } from "../src/store.mjs";
import { tempDir } from "./helpers.mjs";

const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-review-vectors.json", import.meta.url), "utf8"));
const valid = vx.cases.find((c) => c.id === "valid-3x2");
const KEY = "0x" + "11".repeat(32);

async function setup({ privateKey = KEY, review } = {}) {
  const dir = await tempDir();
  const calls = { review: [], pay: [] };
  const tools = createTools({
    config: { publicKeys: [vx.public_key], privateKey, dailyLimitMicro: 1_000_000, url: "https://example.invalid" },
    makeClient: () => ({
      review: async (opts) => {
        calls.review.push(opts);
        if (review) return review(opts);
        const p = valid.receipt.payload;
        return { review_id: p.review_id, tier: opts.tier, result: p.result, votes: p.votes, receipt: valid.receipt, check: { ok: true, problems: [], trusts: [] } };
      },
    }),
    makePayingFetch: async (_key, max) => {
      calls.pay.push(max);
      return { fetch: async () => { throw new Error("not used"); }, wallet: valid.receipt.payload.payer, lastSettlement: () => ({ transaction: "0xabc", network: "base" }) };
    },
    budget: new Budget({ dir, dailyLimitMicro: 1_000_000 }),
    receipts: new ReceiptStore({ dir }),
  });
  const byName = (n) => tools.find((t) => t.name === n).handler;
  return { calls, review: (a) => byName("sealed_review")(a, { progress: () => {} }), verify: byName("verify_receipt") };
}

test("verify_receipt: every server vector gives the expected result with the task and pieces", async () => {
  const { verify } = await setup();
  for (const c of vx.cases) {
    const r = await verify({ receipt: c.receipt, task: c.given.task, pieces: c.given.pieces });
    assert.equal(r.ok, c.expect.ok, `${c.id}: ${JSON.stringify(r.problems)}`);
    if (c.expect.ok) assert.equal(r.verdict, c.expect.verdict);
  }
});

test("verify_receipt: a multi-part receipt without pieces says pieces weren't checked; with output it fails", async () => {
  const { verify } = await setup();
  const noPieces = await verify({ receipt: valid.receipt, task: valid.given.task });
  assert.equal(noPieces.ok, true);
  assert.deepEqual(noPieces.not_checked.map((x) => x.split(" ")[0]), ["pieces"]);
  assert.match(noPieces.summary, /Not checked: pieces\./);
  const withOutput = await verify({ receipt: valid.receipt, task: valid.given.task, output: "x" });
  assert.equal(withOutput.ok, false);
});

test("sealed_review review-3x2: sends the pieces, pays at most its price, saves the receipt, explains how to share it", async () => {
  const { review, calls } = await setup();
  const r = await review({ tier: "review-3x2", task: valid.given.task, pieces: valid.given.pieces, title: "Handoff v5" });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(calls.pay, [PRICES["review-3x2"]]);
  assert.equal(PRICES["review-3x2"], 600_000);
  assert.equal(PRICES["review-3x3"], 700_000);
  assert.deepEqual(calls.review[0].pieces, valid.given.pieces);
  assert.equal("output" in calls.review[0], false);
  assert.ok(r.receipt_file);
  assert.match(r.how_to_share, /every piece/);
  assert.equal(r.paid.amount, "$0.60");
  assert.match(r.summary, /Verdict: pass \(2 pass, 1 needs_changes\)/);
});

test("sealed_review multi-part: mistakes are refused before any payment is set up", async () => {
  const { review, calls } = await setup();
  const t = valid.given.task;
  const two = valid.given.pieces;
  const bad = [
    [{ tier: "review-3x2", task: t, output: "x" }, /takes the work as pieces/],
    [{ tier: "review-3x2", task: t, pieces: [two[0], two[1], { text: "c" }] }, /exactly 2 pieces/],
    [{ tier: "review-3x3", task: t, pieces: two }, /exactly 3 pieces/],
    [{ tier: "review-3x2", task: t, pieces: [{ text: "   " }, two[1]] }, /piece 1\) is empty/],
    [{ tier: "review-3x2", task: t, pieces: [{ name: "a\nb", text: "x" }, two[1]] }, /no line breaks/],
    [{ tier: "review-3x2", task: t, pieces: [{ text: "x".repeat(12000) }, { text: "y".repeat(12001) }] }, /at most 12000 characters/],
    [{ tier: "review-3x2", task: t, pieces: two, free: true }, /paid only/],
    [{ tier: "review-3", task: t, output: "x", pieces: two }, /pieces are for review-3x2 and review-3x3/],
    [{ tier: "review-3", task: t }, /output is empty/],
    [{ tier: "review-3x2", task: t, pieces: two, panel: ["claude-sonnet-5-5"] }, /3 model ids from 3 different AI companies/],
    [{ tier: "review-3x2", task: t, pieces: two, panel: [["a/x", "b/y"]] }, /3 model ids from 3 different AI companies/],
    [{ tier: "review-3x2", task: t, pieces: two, panel: ["claude-sonnet-5-5", "anthropic/x", "claude-opus-5-5"] }, /3 model ids from 3 different AI companies/],
    [{ tier: "review-3x2", task: t, pieces: two, criteria: [{ name: "a\nb", weight: 1 }] }, /text on one line/],
    [{ tier: "review-3x2", task: t, pieces: two, criteria: [{ name: "   ", weight: 1 }] }, /text on one line/],
  ];
  for (const [args, re] of bad) await assert.rejects(review(args), re, JSON.stringify(args).slice(0, 80));
  assert.deepEqual(calls.pay, []);
  assert.deepEqual(calls.review, []);
});

test("sealed_review multi-part: good panels still go through", async () => {
  for (const panel of ["rotate", ["claude-sonnet-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"], [["claude-sonnet-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"]]]) {
    const { review, calls } = await setup(); // a fresh $1.00 daily cap each time
    await review({ tier: "review-3x2", task: valid.given.task, pieces: valid.given.pieces, panel });
    assert.deepEqual(calls.review[0].panel, panel);
  }
});

test("sealed_review multi-part without a wallet says it's paid only and charges nothing", async () => {
  const { review, calls } = await setup({ privateKey: null });
  await assert.rejects(review({ tier: "review-3x3", task: valid.given.task, pieces: [...valid.given.pieces, { text: "third" }] }), /paid only \(\$0\.70\), and no wallet is set up/);
  assert.deepEqual(calls.review, []);
});

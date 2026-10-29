// verify_receipt refuses receipts in a format the installed client doesn't know (judge-multi-v1 for now),
// even when they're validly signed, and still passes today's receipts. Uses a throwaway signing key.
// Fixtures are copied from agent-referee-client's test/fixtures/receipts.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson } from "agent-referee-client";
import { createTools } from "../src/tools.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
const b64 = (buf) => Buffer.from(buf).toString("base64");

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = b64(await crypto.subtle.exportKey("raw", keys.publicKey));
const sign = async (payload) => ({
  payload,
  algorithm: "Ed25519",
  public_key: publicKey,
  signature: b64(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(canonicalJson(payload)))),
});

const unused = () => { throw new Error("verify_receipt must not reach the network, pay or store anything"); };
const tools = createTools({ config: { publicKeys: [publicKey], dailyLimitMicro: 0 }, makeClient: unused, makePayingFetch: unused, budget: {}, receipts: {} });
const verify = tools.find((t) => t.name === "verify_receipt").handler;
const UPDATE = "Update the client (npm install agent-referee-client@latest).";
const formatMsg = (f) => `This receipt uses the ${f} format, which this version of agent-referee-client can't check, so nothing was confirmed. ${UPDATE}`;

test("control: today's receipts, signed by the pinned key, pass", async () => {
  const r = await verify({ receipt: await sign(fx.review_3), task: fx.review_3_task, output: fx.review_3_output });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.signature_valid, true);
  const j = await verify({ receipt: await sign(fx.judge_3) });
  assert.equal(j.ok, true, JSON.stringify(j.problems));
});

test("a validly signed review receipt with an unknown or misplaced receipt_format is refused", async () => {
  // Unknown formats get the update message. review-multi-v1 is known since 0.3.0 (client 0.9.0), but only on a
  // multi-part tier, and a single-piece receipt relabelled as one still fails (test/multi.test.mjs has the real ones).
  for (const fmt of ["judge-multi-v1", "review-multi-v9"]) {
    const r = await verify({ receipt: await sign({ ...fx.review_3, receipt_format: fmt }), task: fx.review_3_task, output: fx.review_3_output });
    assert.equal(r.signature_valid, true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [formatMsg(fmt)]);
    assert.match(r.summary, /^NOT valid/);
  }
  const old = await verify({ receipt: await sign({ ...fx.review_3, receipt_format: "review-multi-v1" }), task: fx.review_3_task, output: fx.review_3_output });
  assert.deepEqual(old.problems, ["A review-multi-v1 receipt must be for a multi-part tier (review-3x2 or review-3x3), not review-3."]);
  const { output_sha256, ...rest } = fx.review_3;
  const relabelled = await verify({ receipt: await sign({ ...rest, tier: "review-3x2", receipt_format: "review-multi-v1" }), task: fx.review_3_task });
  assert.equal(relabelled.ok, false);
});

test("a validly signed judge receipt with an unknown or misplaced receipt_format is refused", async () => {
  // judge-multi-v1 is known since 0.4.0 (client 0.10.0), but only on judge-3x2 and judge-3x3, and a judge-3 receipt
  // relabelled as one still fails (test/multi-judge.test.mjs has the real ones).
  const unknown = await verify({ receipt: JSON.stringify(await sign({ ...fx.judge_3, receipt_format: "judge-multi-v9" })) });
  assert.equal(unknown.signature_valid, true);
  assert.deepEqual(unknown.problems, [formatMsg("judge-multi-v9")]);
  const j3 = await verify({ receipt: await sign({ ...fx.judge_3, receipt_format: "judge-multi-v1" }) });
  assert.deepEqual(j3.problems, ["A judge-multi-v1 receipt must be for a multi-part judge tier (judge-3x2 or judge-3x3), not judge-3."]);
  const relabelled = await verify({ receipt: await sign({ ...fx.judge_3, tier: "judge-3x2", receipt_format: "judge-multi-v1" }) });
  assert.equal(relabelled.signature_valid, true);
  assert.equal(relabelled.ok, false);
});

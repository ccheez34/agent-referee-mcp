// verify_receipt refuses receipts in a format the installed client doesn't know (the coming multi-part tiers),
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

test("a validly signed review receipt with a receipt_format is refused with the update message", async () => {
  const { output_sha256, ...rest } = fx.review_3;
  for (const payload of [{ ...fx.review_3, receipt_format: "review-multi-v1" }, { ...rest, tier: "review-3x2", receipt_format: "review-multi-v1" }]) {
    const r = await verify({ receipt: await sign(payload), task: fx.review_3_task, output: fx.review_3_output });
    assert.equal(r.signature_valid, true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, [formatMsg("review-multi-v1")]);
    assert.match(r.summary, /^NOT valid/);
  }
});

test("a validly signed judge receipt with a receipt_format is refused, even as judge-3", async () => {
  for (const tier of ["judge-3", "judge-3x2"]) {
    const r = await verify({ receipt: JSON.stringify(await sign({ ...fx.judge_3, tier, receipt_format: "judge-multi-v1" })) });
    assert.equal(r.signature_valid, true);
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes(formatMsg("judge-multi-v1")), JSON.stringify(r.problems));
  }
});

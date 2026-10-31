// Judge spec §9: verify_receipt accepts judge receipts carrying the service's own advisory sentence and
// human_review: "required" (signed), and shows both. Uses the server's own multi-judge vectors (agent-referee-server
// test/fixtures/multi-judge-vectors.json, regenerated without Claude judges), pinned to their key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTools } from "../src/tools.mjs";

const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
const unused = () => { throw new Error("verify_receipt must not reach the network, pay or store anything"); };
const tools = createTools({ config: { publicKeys: [vx.public_key], dailyLimitMicro: 0 }, makeClient: unused, makePayingFetch: unused, budget: {}, receipts: {} });
const verify = tools.find((t) => t.name === "verify_receipt").handler;
const valid = vx.cases.filter((c) => c.expect.ok);

test("valid judge receipts with the advisory fields pass, and the tool shows both", async () => {
  assert.ok(valid.length >= 3);
  for (const c of valid) {
    const r = await verify({ receipt: c.receipt, pieces: c.given.pieces, acks: c.given.acks });
    assert.equal(r.signature_valid, true, c.id);
    assert.equal(r.ok, true, `${c.id}: ${JSON.stringify(r.problems)}`);
    assert.equal(r.advisory, c.receipt.payload.advisory, "the receipt's own words");
    assert.equal(r.human_review, "required");
    assert.ok(r.trusts.includes(c.receipt.payload.advisory));
    assert.equal(r.trusts.filter((t) => /person's review/.test(t)).length, 1, "the review line once");
    assert.match(r.summary, /a person should review it/);
  }
});

test("invalid vectors are still refused with the fields present", async () => {
  for (const c of vx.cases.filter((x) => !x.expect.ok)) {
    let r;
    try {
      r = await verify({ receipt: c.receipt, pieces: c.given?.pieces, acks: c.given?.acks });
    } catch {
      continue; // refused outright (for example an unknown format the installed client can't check)
    }
    assert.equal(r.ok, false, c.id);
  }
});

test("a receipt without the fields shows neither", async () => {
  const c = valid[0];
  const { advisory, human_review, ...older } = c.receipt.payload;
  const r = await verify({ receipt: { ...c.receipt, payload: older }, pieces: c.given.pieces });
  assert.equal(r.advisory, undefined);
  assert.equal(r.human_review, undefined);
  assert.doesNotMatch(r.summary, /person should review/);
});

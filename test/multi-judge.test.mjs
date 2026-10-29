// Multi-part judge receipts (judge-multi-v1; judge-3x2, judge-3x3) through verify_receipt, with the pieces by seat
// and the acks. Vectors: test/fixtures/multi-judge-vectors.json, copied from agent-referee-server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTools } from "../src/tools.mjs";

const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
const unused = () => { throw new Error("verify_receipt must not reach the network, pay or store anything"); };
const tools = createTools({ config: { publicKeys: [vx.public_key], dailyLimitMicro: 0 }, makeClient: unused, makePayingFetch: unused, budget: {}, receipts: {} });
const verify = tools.find((t) => t.name === "verify_receipt").handler;

test("verify_receipt: every judge vector gives the expected result with the pieces by seat and the acks", async () => {
  assert.equal(vx.cases.length, 20);
  for (const c of vx.cases) {
    const r = await verify({ receipt: c.receipt, pieces: c.given.pieces, ...(c.given.acks ? { acks: c.given.acks } : {}) });
    assert.equal(r.ok, c.expect.ok, `${c.id}: ${JSON.stringify(r.problems)}`);
    if (c.expect.ok) assert.equal(r.outcome.winner, c.expect.winner);
  }
});

test("verify_receipt: a judge receipt without pieces says they weren't checked; pieces as a list are refused", async () => {
  const c = vx.cases.find((x) => x.id === "valid-3x2");
  const r = await verify({ receipt: c.receipt });
  assert.equal(r.ok, true);
  assert.deepEqual(r.not_checked.map((x) => x.split(" ")[0]), ["pieces"]);
  await assert.rejects(verify({ receipt: c.receipt, pieces: [{ text: "x" }] }), /pieces are by seat/);
});

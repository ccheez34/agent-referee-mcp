// A review that takes longer than the caller can wait (a link that gives up after 60 seconds) is not lost: sealed_review
// returns status "running" and a job_id, the review carries on, its receipt is saved, and review_result returns it.
// A "pending" record is saved before anything is sent. Reported Oct 30 (5.0-D95): a review-3 through the PC link
// finished and was charged, but its answer never arrived and nothing was saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tempDir } from "./helpers.mjs";
import { createTools } from "../src/tools.mjs";
import { Budget, ReceiptStore } from "../src/store.mjs";
import { sha256Hex } from "agent-referee-client";

const TOKEN = "team-token-for-tests-" + "x".repeat(24);
const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-review-vectors.json", import.meta.url), "utf8"));
const valid = vx.cases.find((c) => c.id === "valid-3x2");

async function setup({ failPending = false, failPendingAfter, maxJobs, team = true } = {}) {
  const dir = await tempDir();
  const gate = {};
  gate.wait = new Promise((resolve, reject) => {
    gate.release = resolve;
    gate.fail = reject;
  });
  const calls = [];
  const receipts = new ReceiptStore({ dir });
  if (failPending || failPendingAfter !== undefined) {
    const save = receipts.save.bind(receipts);
    let pendingSaves = 0;
    receipts.save = async (kind, id, record) => {
      if (kind === "pending" && (failPending || ++pendingSaves > failPendingAfter)) throw new Error("EACCES: permission denied");
      return save(kind, id, record);
    };
  }
  const tools = createTools({
    config: { publicKeys: [vx.public_key], dailyLimitMicro: 1_000_000, url: "https://example.invalid", ...(team ? { team: { member: "T3", token: TOKEN } } : {}), ...(maxJobs ? { maxJobs } : {}) },
    makeClient: () => ({
      _call: async (method, path, body) => {
        calls.push({ path, body });
        await gate.wait; // the service is still reviewing
        const p = valid.receipt.payload;
        return { review_id: p.review_id, tier: "review-3x2", result: p.result, votes: p.votes, receipt: valid.receipt, team: { member: "T3", usable_now: "$7.40" } };
      },
      verifyReview: async () => ({ ok: true, problems: [], trusts: [] }),
    }),
    makePayingFetch: async () => assert.fail("no payment in team mode"),
    budget: new Budget({ dir, dailyLimitMicro: 1_000_000 }),
    receipts,
  });
  const tool = (name) => tools.find((t) => t.name === name).handler;
  return { gate, calls, receipts, review: tool("sealed_review"), result: tool("review_result"), saved: tool("saved_receipts") };
}

const args = { tier: "review-3x2", task: valid.given.task, pieces: valid.given.pieces, title: "slow one" };

test("a slow review returns running with a job_id, carries on, and review_result returns it with the receipt saved", async () => {
  const s = await setup();
  const said = [];
  const started = Date.now();
  const r = await s.review({ ...args, wait_seconds: 1 }, { progress: (m) => said.push(m) });
  assert.ok(Date.now() - started < 3000, "the call came back within wait_seconds");
  assert.equal(r.status, "running");
  assert.match(r.job_id, /^job_[a-z0-9]+_[0-9a-f]{10}$/);
  assert.match(r.summary, /review_result/);
  assert.equal(s.calls.length, 1, "sent once");

  // The pending record was saved before sending: the task and piece fingerprints, no text.
  const pending = await s.saved({ id: r.job_id });
  assert.equal(pending.kind, "pending");
  assert.equal(pending.status, "running");
  assert.equal(pending.task_sha256, await sha256Hex(args.task));
  assert.equal(pending.pieces_sha256.length, 2);
  assert.ok(!JSON.stringify(pending).includes(args.task), "no task text on disk in the pending record");

  // Still running: review_result says so without waiting.
  assert.equal((await s.result({ job_id: r.job_id, wait_seconds: 0 })).status, "running");

  const before = said.length;
  s.gate.release();
  const done = await s.result({ job_id: r.job_id, wait_seconds: 5 });
  assert.equal(done.status, "done");
  assert.equal(done.review_id, valid.receipt.payload.review_id);
  assert.ok(done.receipt?.signature, "the receipt comes back");
  assert.ok(done.receipt_file, "and is saved");
  assert.equal(said.length, before, "no progress messages after the starting call returned");

  const list = (await s.saved({})).receipts;
  assert.equal(list.filter((x) => x.kind === "review").length, 1);
  const after = await s.saved({ id: r.job_id });
  assert.equal(after.status, "done");
  assert.equal(after.review_id, done.review_id, "the pending record now points to the receipt");
  // Asking again returns the same result; nothing is sent again.
  assert.equal((await s.result({ job_id: r.job_id })).review_id, done.review_id);
  assert.equal(s.calls.length, 1);
});

test("a quick review still comes back in the same call", async () => {
  const s = await setup();
  s.gate.release();
  const r = await s.review(args, { progress: () => {} });
  assert.equal(r.status, "done");
  assert.ok(r.receipt?.signature);
});

test("a review that fails after the call returned reports the failure, and the pending record says so", async () => {
  const s = await setup();
  const r = await s.review({ ...args, wait_seconds: 0 }, { progress: () => {} });
  assert.equal(r.status, "running");
  while (!s.calls.length) await new Promise((t) => setTimeout(t, 5)); // the request is out
  s.gate.fail(new Error("socket hang up"));
  await assert.rejects(s.result({ job_id: r.job_id, wait_seconds: 5 }), /./);
  const pending = await s.saved({ id: r.job_id });
  assert.equal(pending.status, "failed");
  assert.match(pending.error, /./);
});

test("argument mistakes are refused at once, before any pending record or sending, even with wait_seconds 0", async () => {
  const s = await setup();
  const none = { progress: () => {} };
  await assert.rejects(s.review({ ...args, pieces: [args.pieces[0]] }, none), /exactly 2 pieces|minItems|at least/);
  // Checks that live in the tool's own code (not the schema), with no waiting at all (the review's finding, Oct 31):
  await assert.rejects(s.review({ ...args, task: "          short     ", wait_seconds: 0 }, none), /at least 10 characters/);
  await assert.rejects(s.review({ ...args, criteria: [{ name: "a", weight: 1 }, { name: "a ", weight: 2 }], wait_seconds: 0 }, none), /unique/);
  await assert.rejects(s.review({ ...args, free: true, wait_seconds: 0 }, none), /paid only/);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.saved({})).receipts.length, 0);
});

test("if the pending record can't be saved, nothing is sent or charged", async () => {
  const s = await setup({ failPending: true });
  s.gate.release();
  await assert.rejects(s.review(args, { progress: () => {} }), /Couldn't save the pending record before sending .*nothing was sent or charged/);
  assert.equal(s.calls.length, 0, "the review was never sent");
});

test("finished jobs beyond the newest maxJobs are dropped from memory; review_result then reads the saved record", async () => {
  const s = await setup({ maxJobs: 2 });
  s.gate.release();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await s.review({ ...args, title: `run ${i}` }, { progress: () => {} })).job_id);
  const oldest = await s.result({ job_id: ids[0] });
  assert.match(oldest.summary, /isn't in this server's memory/);
  assert.equal(oldest.status, "done", "the saved pending record says done");
  assert.equal(oldest.review_id, valid.receipt.payload.review_id);
  assert.equal((await s.result({ job_id: ids[2] })).status, "done", "the newest is still in memory");
});

test("a failed job whose pending record can't be updated reports both", async () => {
  const s = await setup({ failPendingAfter: 1 }); // the record before sending works; the update after the failure doesn't
  const r = await s.review({ ...args, wait_seconds: 0 }, { progress: () => {} });
  while (!s.calls.length) await new Promise((t) => setTimeout(t, 5));
  s.gate.fail(new Error("socket hang up"));
  await assert.rejects(s.result({ job_id: r.job_id, wait_seconds: 5 }), /Couldn't update the pending record/);
});

test("multi-part with no wallet and no team allowance is refused as paid only, not as a bad key (2nd review's finding checked)", async () => {
  const s = await setup({ team: false });
  await assert.rejects(s.review({ ...args, wait_seconds: 0 }, { progress: () => {} }), /paid only/);
  assert.equal(s.calls.length, 0);
});

test("review_result: an unknown or mistyped job says where to look", async () => {
  const s = await setup();
  await assert.rejects(s.result({ job_id: "job_abc_0123456789" }), /saved_receipts/);
  await assert.rejects(s.result({ job_id: "not-a-job" }), /saved_receipts/);
});

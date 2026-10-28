// The daily spending cap, receipt storage, config and argument checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Budget, ReceiptStore, toMicro, usd } from "../src/store.mjs";
import { loadConfig, REFEREE_KEY } from "../src/server.mjs";
import { validate } from "../src/validate.mjs";
import { tempDir } from "./helpers.mjs";

test("money is counted in whole micro-USDC and printed plainly", () => {
  assert.equal(toMicro("0.05"), 50_000);
  assert.equal(toMicro(0.1 + 0.2), 300_000, "no floating-point drift");
  assert.equal(usd(50_000), "$0.05");
  assert.equal(usd(15_000), "$0.015");
  assert.equal(usd(1_000_000), "$1.00");
});

test("the cap blocks a call that would go over it, and counts reservations so parallel calls can't overshoot", async () => {
  const b = new Budget({ dir: await tempDir(), dailyLimitMicro: 250_000 });
  const holds = await Promise.all([b.reserve(200_000), b.reserve(50_000)]);
  await assert.rejects(b.reserve(50_000), /Daily spending cap reached.*\$0\.25 in progress.*cap \$0\.25.*Nothing was charged/);
  await holds[1].release();
  await holds[0].commit();
  await holds[0].commit(); // a second commit is a no-op
  const s = await b.status();
  assert.equal(s.spent_micro, 200_000);
  assert.equal(s.paid_calls, 1);
  assert.equal(s.left_micro, 50_000);
  await (await b.reserve(50_000)).commit();
  await assert.rejects(b.reserve(1), /cap reached/);
});

test("spend is kept on disk, survives a restart, and resets at the start of each UTC day", async () => {
  const dir = await tempDir();
  let now = new Date("2026-10-27T23:59:00Z");
  const b1 = new Budget({ dir, dailyLimitMicro: 1_000_000, now: () => now });
  await (await b1.reserve(200_000)).commit();
  const saved = JSON.parse(await readFile(join(dir, "spend.json"), "utf8"));
  assert.deepEqual(saved, { day: "2026-10-27", spent_micro: 200_000, paid_calls: 1, pending: {} });
  const b2 = new Budget({ dir, dailyLimitMicro: 1_000_000, now: () => now });
  assert.equal((await b2.status()).spent_micro, 200_000, "a restarted server remembers today's spend");
  now = new Date("2026-10-28T00:00:01Z");
  assert.equal((await b2.status()).spent_micro, 0, "a new UTC day starts from zero");
});

test("several server processes share one cap: none can overshoot it, and no spend is lost", async () => {
  // The reviewer's scenario: separate processes (Claude Desktop, Claude Code, Cursor) using one data folder.
  const dir = await tempDir();
  const worker = `
    import { Budget } from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};
    const b = new Budget({ dir: process.argv[1], dailyLimitMicro: 100_000 });
    let granted = 0;
    await Promise.all([0, 1, 2].map(async () => {
      try { const h = await b.reserve(50_000); granted++; await new Promise((r) => setTimeout(r, 30)); await h.commit(); } catch {}
    }));
    console.log(granted);
  `;
  // The worker runs from a file, not `node -e`: on Windows a multi-line -e script with quotes in it doesn't
  // survive command-line quoting reliably.
  const workerFile = join(await tempDir(), "spend-worker.mjs");
  await writeFile(workerFile, worker.replace("process.argv[1]", "process.argv[2]").replace("console.log(granted);", 'console.log("GRANTED=" + granted);'));
  const run = () =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [workerFile, dir], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("error", reject);
      c.on("exit", (code) => {
        const m = /GRANTED=(\d+)/.exec(out);
        if (code === 0 && m) resolve(Number(m[1]));
        else reject(new Error(`worker exited ${code}; stdout: ${JSON.stringify(out.slice(0, 300))}; stderr: ${JSON.stringify(err.slice(0, 500))}`));
      });
    });
  const granted = (await Promise.all([run(), run(), run()])).reduce((a, b) => a + b, 0);
  assert.equal(granted, 2, `exactly $0.10 of reservations granted across 3 processes x 3 calls (got ${granted})`);
  const saved = JSON.parse(await readFile(join(dir, "spend.json"), "utf8"));
  assert.equal(saved.spent_micro, 100_000, "every granted call was recorded; nothing overwritten");
  assert.equal(saved.paid_calls, 2);
  assert.deepEqual(saved.pending, {});
});

test("a reservation left by a killed server counts as spent; a late answer for it isn't counted twice", async () => {
  const dir = await tempDir();
  let now = new Date("2026-10-27T12:00:00Z");
  const b = new Budget({ dir, dailyLimitMicro: 400_000, now: () => now });
  const hold = await b.reserve(200_000); // ...and then the server is "killed" before commit
  assert.equal((await b.status()).reserved_micro, 200_000, "the reservation is on disk, not just in memory");
  const other = new Budget({ dir, dailyLimitMicro: 400_000, now: () => now });
  await assert.rejects(other.reserve(250_000), /\$0\.20 in progress/, "another process sees it");
  now = new Date("2026-10-27T12:11:00Z"); // past the 10-minute stale limit
  const s = await other.status();
  assert.equal(s.spent_micro, 200_000, "a stale reservation counts as spent, to be safe");
  assert.equal(s.reserved_micro, 0);
  await (await other.reserve(50_000)).commit(); // saves the stale conversion
  await hold.commit(); // the "killed" call turns out to have been paid after all
  assert.equal((await b.status()).spent_micro, 250_000, "counted once, not twice");
  // ...and one that definitely failed after going stale is given back.
  const h2 = await b.reserve(50_000);
  now = new Date("2026-10-27T12:30:00Z");
  await (await b.reserve(1)).release(); // any write converts the stale one
  assert.equal((await b.status()).spent_micro, 300_000);
  await h2.release();
  assert.equal((await b.status()).spent_micro, 250_000, "a definite failure is given back");
});

test("an unreadable spend record pauses paid calls instead of silently resetting the day to zero", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "spend.json"), "{not json", "utf8");
  const b = new Budget({ dir, dailyLimitMicro: 1_000_000 });
  await assert.rejects(b.reserve(50_000), /can't be read.*paid calls are paused.*Nothing was charged/s);
  await writeFile(join(dir, "spend.json"), JSON.stringify({ day: "x" }), "utf8");
  await assert.rejects(b.reserve(50_000), /unexpected shape/);
});

test("a lock left by a crashed process is taken over", async () => {
  const dir = await tempDir();
  const b = new Budget({ dir, dailyLimitMicro: 1_000_000 });
  await writeFile(join(dir, "spend.lock"), "12345 old\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(join(dir, "spend.lock"), old, old);
  await (await b.reserve(50_000)).commit();
  assert.equal((await b.status()).spent_micro, 50_000);
});

test("a cap of 0 turns paid calls off", async () => {
  const b = new Budget({ dir: await tempDir(), dailyLimitMicro: 0 });
  await assert.rejects(b.reserve(50_000), /turned off/);
});

test("receipts are saved, listed newest first, fetched by id, and odd ids are refused", async () => {
  const store = new ReceiptStore({ dir: await tempDir() });
  const p1 = await store.save("review", "aaaa1111", { summary: "first", receipt: { payload: { x: 1 } } });
  await new Promise((r) => setTimeout(r, 5));
  await store.save("review", "bbbb2222", { summary: "second" });
  assert.ok(p1.endsWith(join("receipts", "review-aaaa1111.json")));
  const list = await store.list();
  assert.deepEqual(list.map((x) => x.id), ["bbbb2222", "aaaa1111"]);
  assert.equal((await store.get("aaaa1111")).receipt.payload.x, 1);
  assert.equal(await store.get("../etc/passwd"), null);
  await assert.rejects(store.save("review", "../../x", {}), /unexpected id/);
  const off = new ReceiptStore({ dir: await tempDir(), enabled: false });
  assert.equal(await off.save("review", "cccc", {}), null);
});

test("config: safe defaults, the official key always pinned, unsafe values refused", () => {
  const c = loadConfig({});
  assert.equal(c.dailyLimitMicro, 1_000_000);
  assert.deepEqual(c.publicKeys, [REFEREE_KEY]);
  assert.equal(c.privateKey, undefined);
  assert.equal(c.saveReceipts, true);
  assert.equal(c.url, undefined, "the client's default address is used");
  const c2 = loadConfig({ AGENT_REFEREE_PUBLIC_KEYS: "newkey=, " + REFEREE_KEY, AGENT_REFEREE_DAILY_LIMIT_USD: "2.5", AGENT_REFEREE_SAVE_RECEIPTS: "false" });
  assert.deepEqual(c2.publicKeys, [REFEREE_KEY, "newkey="], "extra keys add to the pinned key, never replace it");
  assert.equal(c2.dailyLimitMicro, 2_500_000);
  assert.equal(c2.saveReceipts, false);
  assert.throws(() => loadConfig({ AGENT_REFEREE_DAILY_LIMIT_USD: "-1" }), /0 to 1000/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_DAILY_LIMIT_USD: "lots" }), /0 to 1000/);
  assert.throws(() => loadConfig({ AGENT_REFEREE_URL: "http://evil.example" }), /https/);
  assert.equal(loadConfig({ AGENT_REFEREE_URL: "https://agentreferee.ai" }).url, "https://agentreferee.ai");
  assert.equal(loadConfig({ AGENT_REFEREE_URL: "http://127.0.0.1:8787" }).url, "http://127.0.0.1:8787");
});

test("argument checks: clear messages with paths", () => {
  const schema = {
    type: "object",
    required: ["task"],
    properties: {
      task: { type: "string", minLength: 3 },
      n: { type: "integer", minimum: 1 },
      list: { type: "array", items: { type: "object", required: ["w"], properties: { w: { type: "integer" } } } },
      map: { type: "object", propertyNames: { type: "string", pattern: "^[a-z]+$" }, additionalProperties: { type: "integer" } },
      choice: { anyOf: [{ type: "string", enum: ["rotate"] }, { type: "array", items: { type: "string" } }], description: "rotate or a list" },
    },
    additionalProperties: false,
  };
  assert.deepEqual(validate({ task: "abc" }, schema), []);
  const p = validate({ task: "a", n: 1.5, list: [{ w: "x" }], map: { A: 1 }, extra: 1, choice: 7 }, schema);
  assert.ok(p.includes("task must be at least 3 characters."));
  assert.ok(p.includes("n must be integer."));
  assert.ok(p.includes("list[0].w must be integer."), p.join(" | "));
  assert.ok(p.some((x) => x.startsWith("map.A (name)")));
  assert.ok(p.includes("extra isn't a known argument."));
  assert.ok(p.includes("choice: rotate or a list."));
  assert.deepEqual(validate({}, schema), ["task is required."]);
});

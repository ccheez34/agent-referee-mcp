// Phase 2b: a small, bounded real-money check of the LIVE service after the Phase 1 deploy.
// Waves of 10 -> 25 -> 50 -> 100 simultaneous sealed reviews ($0.05 each), 2 minutes apart, paid from the test wallet.
//
//   node scripts\ramp-test.mjs --wallet-file C:\Users\Admin\Downloads\client-test\test-wallet.txt
//
// Hard limits:
//   - Money: at most 185 reviews x $0.05 = $9.25 can ever be paid. All servers share one daily cap of $9.25, enforced
//     before any payment. Reviews refused as "busy" are never charged.
//   - Provider spend: only reviews that get a slot call the AI. Anthropic's own spend limit ($100) is the outer bound.
// Stops at once (before the next wave) on any of these:
//   - an answer that isn't a paid review or a "busy, nothing charged" refusal
//   - a paid review whose receipt doesn't check out
//   - /health not "ok" (degraded, paused or down), any provider pool throttled, capped or unreachable (throttled = the provider sent 429s),
//     or a /health warning that the provider is returning errors
// The key is read from the wallet file and passed to the servers' environment only; it's never printed.
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";

const args = process.argv.slice(2);
const wfi = args.indexOf("--wallet-file");
if (wfi < 0) {
  console.log("Usage: node scripts\\ramp-test.mjs --wallet-file <path to the wallet file>");
  process.exit(1);
}
const key = await readWalletKey(args[wfi + 1]);
const BASE = process.env.LIVE_TEST_URL || "https://agentreferee.ai";
const target = process.env.LIVE_TEST_URL ? { AGENT_REFEREE_URL: process.env.LIVE_TEST_URL, AGENT_REFEREE_PUBLIC_KEYS: process.env.LIVE_TEST_KEY } : {};
const WAVES = (args[args.indexOf("--waves") + 1] && args.includes("--waves") ? args[args.indexOf("--waves") + 1] : "10,25,50,100").split(",").map(Number);
const PAUSE_MS = Number(process.env.RAMP_PAUSE_MS || 120_000);
const SERVERS = 10; // separate MCP server processes, like separate agents, all sharing one spending cap
const dataDir = resolve("ramp-test-data", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(dataDir, { recursive: true });

const health = async () => {
  try {
    const h = await (await fetch(`${BASE}/health`)).json();
    return h;
  } catch (e) {
    return { status: "unreachable", reasons: [String(e?.message ?? e)] };
  }
};

const h0 = await health();
console.log(`Service: ${BASE}  /health: ${h0.status}${h0.reasons?.length ? " (" + h0.reasons.join(", ") + ")" : ""}`);
if (h0.status !== "ok") {
  console.log("Stopping before spending anything: /health must say \"ok\" (is the Phase 1 version deployed?).");
  process.exit(1);
}

const capUsd = (WAVES.reduce((a, b) => a + b, 0) * 0.05).toFixed(2);
const env = { AGENT_REFEREE_DATA_DIR: dataDir, AGENT_REFEREE_PRIVATE_KEY: key, AGENT_REFEREE_DAILY_LIMIT_USD: capUsd, ...target };
const servers = Array.from({ length: SERVERS }, () => spawnServer(env));
await Promise.all(servers.map((s) => s.init()));
console.log(`Waves: ${WAVES.join(" -> ")} simultaneous reviews, ${PAUSE_MS / 1000} s apart. Most this can pay: $${capUsd}.\n`);

const task = "Convert 72 degrees Fahrenheit to Celsius, rounded to one decimal place. Give only the number.";
const totals = { paid: 0, busy: 0, other: 0, usd: 0, txs: new Set() };
let stop = "";
for (const [w, n] of WAVES.entries()) {
  if (w > 0) {
    console.log(`  waiting ${PAUSE_MS / 1000} s before the next wave...`);
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  const t0 = Date.now();
  const res = await Promise.all(
    Array.from({ length: n }, (_, i) => servers[i % SERVERS].call("sealed_review", { tier: "review", task, output: "22.2", title: `ramp wave ${w + 1} #${i + 1}` })),
  );
  const paid = res.filter((r) => !r.isError && r.structured?.paid?.transaction);
  const badReceipt = paid.filter((r) => !r.structured.check?.ok);
  const busy = res.filter((r) => r.isError && /busy right now/i.test(r.text));
  const other = res.filter((r) => !paid.includes(r) && !busy.includes(r));
  for (const r of paid) totals.txs.add(r.structured.paid.transaction);
  totals.paid += paid.length;
  totals.busy += busy.length;
  totals.other += other.length;
  totals.usd += paid.length * 0.05;
  const h = await health();
  console.log(
    `Wave ${w + 1} (${n} at once, ${((Date.now() - t0) / 1000).toFixed(0)} s): ${paid.length} paid, ${busy.length} busy (uncharged), ${other.length} other.  /health: ${h.status}${h.reasons?.length ? " (" + h.reasons.join(", ") + ")" : ""}`,
  );
  for (const r of other.slice(0, 5)) console.log(`    other: ${r.text.slice(0, 220)}`);
  if (other.length) stop = "an answer that wasn't a paid review or a busy refusal";
  else if (badReceipt.length) stop = `${badReceipt.length} receipt(s) failed their check`;
  else if (h.status !== "ok") stop = `/health is "${h.status}"`;
  else if (Object.values(h.checks?.providers ?? {}).some((v) => v !== "ok" && v !== "full")) stop = `a provider pool isn't ok: ${JSON.stringify(h.checks.providers)} (a "throttled" pool means the AI provider answered 429: the slots are set too high)`;
  else if (h.warnings?.length) stop = `/health warns: ${h.warnings.join(", ")} (the AI provider is returning errors)`;
  if (stop) break;
}
await Promise.all(servers.map((s) => s.close()));

console.log(`\nTotal: ${totals.paid} paid ($${totals.usd.toFixed(2)}), ${totals.busy} busy, ${totals.other} other; ${totals.txs.size} distinct settlement transactions reported.`);
console.log("Check on BaseScan: USDC transfers of 0.05 from the test wallet to the fee wallet should add up to the paid count (PayAI batches several into one transaction).");
console.log(stop ? `\nSTOPPED: ${stop}. Nothing more was sent.` : "\nRESULT: all waves completed with only paid or busy answers.");
process.exit(stop ? 1 : 0);

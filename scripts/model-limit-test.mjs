// How long an input can one reviewer model handle inside its 100-second limit? Runs single-reviewer reviews
// ($0.05 each, charged only when the review completes) on growing slices of a real document, and stops at the
// first size that fails. A failure (timeout) is never charged.
//
//   node scripts\model-limit-test.mjs --wallet-file <path> --model deepseek/deepseek-v4-pro-0813 --file ..\research\server-free-code-v3.txt
//   Optional: --sizes 2000,4000,6000,8000,10000,12000   (characters of task + output, up to 16000; default as shown)
//
// The key is read from the wallet file, never printed. At most 6 paid reviews ($0.30), capped by this run's own
// data folder and spending cap.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnServer } from "../test/helpers.mjs";
import { readWalletKey } from "./wallet-key.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
if (!opt("--wallet-file") || !opt("--model") || !opt("--file")) {
  console.log("Usage: node scripts\\model-limit-test.mjs --wallet-file <path> --model <model id> --file <document> [--sizes 2000,4000,...]");
  process.exit(1);
}
const sizes = (opt("--sizes") || "2000,4000,6000,8000,10000,12000").split(",").map(Number).filter((n) => n >= 500 && n <= 16000);
if (sizes.length > 6) {
  console.log("At most 6 sizes per run (6 x $0.05).");
  process.exit(1);
}
const key = await readWalletKey(opt("--wallet-file"));
const doc = await readFile(resolve(opt("--file")), "utf8");
const model = opt("--model");
const task =
  "Review this excerpt of a TypeScript service for correctness bugs, concurrency problems and unclear error handling. It is an excerpt, so code it refers to may be missing; judge only what is shown.";

const s = spawnServer({
  AGENT_REFEREE_DATA_DIR: resolve("model-limit-data", new Date().toISOString().replace(/[:.]/g, "-")),
  AGENT_REFEREE_PRIVATE_KEY: key,
  AGENT_REFEREE_DAILY_LIMIT_USD: (0.05 * sizes.length).toFixed(2),
});
await s.init();
console.log(`Model: ${model}. Sizes (task + output characters): ${sizes.join(", ")}. Up to $${(0.05 * sizes.length).toFixed(2)}.\n`);
const results = [];
for (const size of sizes) {
  // Output holds up to 12,000 characters; above that, the rest goes into the task as context (task limit 4,000),
  // so sizes up to the service's 16,000 maximum can be tested.
  const outLen = Math.min(12000, size - task.length);
  const extra = Math.max(0, size - task.length - outLen);
  if (outLen + extra > doc.length || task.length + extra > 4000) {
    console.log(`${size}: the document (${doc.length} characters) is too short for this size, or it's over the service's limit; stopping.`);
    break;
  }
  const output = doc.slice(0, outLen);
  const fullTask = extra ? `${task}\n\nContext, the code that comes after the excerpt:\n${doc.slice(outLen, outLen + extra)}` : task;
  const t0 = Date.now();
  const r = await s.call("sealed_review", { tier: "review", task: fullTask, output, title: `Limit test ${model} ${size}`, panel: [model] });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.isError) {
    const why = (r.text.match(/"error":\s*"([^"]+)"/)?.[1] ?? r.text).slice(0, 200);
    console.log(`${String(size).padStart(6)} chars: FAILED in ${secs} s (not charged): ${why}`);
    results.push({ size, ok: false, secs });
    break;
  }
  console.log(`${String(size).padStart(6)} chars: ok in ${secs} s, verdict ${r.structured.verdict} ($0.05)`);
  results.push({ size, ok: true, secs });
}
await s.close();
const lastOk = results.filter((x) => x.ok).pop();
console.log(`\nLargest size that worked: ${lastOk ? `${lastOk.size} characters (${lastOk.secs} s)` : "none"}.`);

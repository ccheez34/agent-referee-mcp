#!/usr/bin/env node
// The Agent Referee gate. With no arguments: the MCP server (stdio). See gate/README.md.
// As a command, for hooks that can't call an MCP tool (2.0's 1126, point 6):
//   agent-referee-gate check <action> <target> [target_sha256] [--dry-run]
// Exit 0 only when allowed (an allowed check spends one use of the owner's approval, unless --dry-run);
// 1 when not allowed; 2 when the gate can't run (settings, policy). The reason goes to stderr; stdout gets one JSON line.
import { main, loadGateConfig, buildGateTools } from "../src/server.mjs";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === undefined) {
  main().catch((e) => {
    process.stderr.write(`[agent-referee-gate] fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
} else if (cmd === "check") {
  const dryRun = rest.includes("--dry-run");
  const [action, target, targetSha256] = rest.filter((a) => a !== "--dry-run");
  (async () => {
    let tools;
    try {
      if (!action || !target) throw new Error("usage: agent-referee-gate check <action> <target> [target_sha256] [--dry-run]");
      tools = await buildGateTools(await loadGateConfig(process.env));
    } catch (e) {
      process.stderr.write(`[agent-referee-gate] ${e.message}\n`);
      process.exit(2);
    }
    try {
      const r = await tools.find((t) => t.name === "check_action").handler({ action, target, ...(targetSha256 ? { target_sha256: targetSha256 } : {}), ...(dryRun ? { dry_run: true } : {}) });
      process.stdout.write(JSON.stringify({ allowed: r.allowed, owner_only: r.owner_only, approval_nonce: r.approval_nonce ?? null, uses_left: r.uses_left ?? null }) + "\n");
      process.stderr.write(`[agent-referee-gate] ${r.summary}\n`);
      process.exit(r.allowed ? 0 : 1);
    } catch (e) {
      process.stderr.write(`[agent-referee-gate] Not allowed: ${e.message}\n`);
      process.exit(1);
    }
  })();
} else {
  process.stderr.write(`[agent-referee-gate] Unknown command "${String(cmd).slice(0, 40)}". Use no arguments for the MCP server, or: check <action> <target> [target_sha256] [--dry-run]\n`);
  process.exit(2);
}

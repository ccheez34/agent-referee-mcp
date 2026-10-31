#!/usr/bin/env node
// The Agent Referee gate MCP server (stdio). See gate/README.md.
import { main } from "../src/server.mjs";

main().catch((e) => {
  process.stderr.write(`[agent-referee-gate] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});

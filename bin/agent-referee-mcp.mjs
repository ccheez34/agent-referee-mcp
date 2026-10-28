#!/usr/bin/env node
// Agent Referee MCP server (stdio). See README.md for setup.
import { main } from "../src/server.mjs";

main().catch((e) => {
  process.stderr.write(`[agent-referee-mcp] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});

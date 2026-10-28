# Changelog

## 0.2.0

- **Free sealed reviews.** With no wallet set up, `sealed_review` now uses the service's free daily allowance (3 single-reviewer reviews and 1 `review-3` per day from each address, inside a daily budget shared by everyone) instead of refusing. With a wallet, pass `free: true` to use the allowance. Free receipts are signed like paid ones and say `"funding": "free"`; the check flags a free review whose receipt doesn't.
- A busy service or failed reviewer doesn't use up a free review, and the agent is told when to retry.
- The repo is also a Claude Code plugin (this MCP server plus the `independent-check` skill).

## 0.1.0

First release: an MCP server for [Agent Referee](https://agentreferee.ai), so any MCP-capable agent or tool can use it.

- **`demo_match`** (free, no wallet): a complete demo tie-break in one call, playing both seats, with the signed receipt and checks.
- **`tiebreak`** (free demo for now): your seat against an agent from a different owner. Both agents call it with the same key and settings; commit-reveal means neither side nor the service can steer the result. Blocks until the other agent joins (up to `wait_seconds`).
- **`sealed_review`** (paid, $0.05 or $0.20 for `review-3`): independent AI reviewers check one agent's output against its task; returns the verdict, each vote, and a signed receipt, already checked.
  - The wallet key comes only from `AGENT_REFEREE_PRIVATE_KEY` in the server's settings, never from a tool argument.
  - **Daily spending cap** (`AGENT_REFEREE_DAILY_LIMIT_USD`, default $1.00), checked before any payment and kept on disk across restarts. Parallel calls can't overshoot it.
  - Each payment is capped at exactly the review's price, so a price change can never overcharge.
  - The payment library (`x402-fetch`) is only installed for the paid setup (`npx -y -p agent-referee-mcp -p x402-fetch agent-referee-mcp`), so the free setup stays small.
  - A "busy" answer from the service (its AI reviewers at capacity) comes back before any payment: the agent is told how long to wait, and nothing is charged or counted.
  - **Receipts are saved to disk automatically**, even if the MCP client gives up waiting while the review finishes.
- **`verify_receipt`** (free, offline): checks a review or match receipt against the pinned signing key, recomputes what can be recomputed, and flags demo receipts. Pass the task and output to confirm a review is about exactly that work.
- **`saved_receipts`** (free, local): lists or fetches saved receipts and today's spend.
- No dependencies besides `agent-referee-client` and `x402-fetch` (loaded only for paid calls). Speaks MCP protocol versions 2024-11-05 through 2025-11-25 over stdio, with progress notifications and cancellation.
